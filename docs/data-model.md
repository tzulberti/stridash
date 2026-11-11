# Data model (base schema)

This is the foundational database design for Stridash. It is intentionally
provider-agnostic: every external service (Garmin, Strava, Omron, …) is modeled
as a "connection", and everything the services send us lands in normalized
domain tables (activities, measurements), not provider-specific tables.

Implemented with Prisma 7 on PostgreSQL 18 (M1). This file is the
column-level reference; [`db-diagram.md`](db-diagram.md) holds the
mermaid ER diagram of the same structure.

Conventions:

- **Primary keys are UUIDv7** (`@default(uuid(7))` on a native `uuid`
  column): time-ordered ids — key order equals creation order, without the
  random-UUID index fragmentation. PostgreSQL 18+ required end-to-end. Do
  not use random `uuid`/`autoincrement` PKs in new migrations.
- **One migration per table / alter**: new migrations must touch exactly one
  table (its enums and indexes included), never combine several tables or
  unrelated changes in one file.
Types typed in `packages/types` mirror this schema so the API and apps share it.

## Entity relationship overview

```
User ──< Connection ──< SyncLog
  │            │
  │            │ (each connection ingests into the domain tables below)
  │
  ├──< Activity                      (runs, rides, Zwift sessions, …)
  ├──< Measurement                   (weight, body composition, BP, …)
  ├──< Gear                          (bikes, shoes — linked to activities)
  └── AuthIdentity                   (local password / future OAuth login)
```

## Tables

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `email` | text unique | login + service OAuth callbacks |
| `display_name` | text | |
| `height_cm` | numeric | used to compute BMI on ingest |
| `date_of_birth` | date | optional; used by body-composition metrics |
| `sex` | enum | optional; some provider formulas need it |
| `created_at` / `updated_at` | timestamptz | |

### `connections`

One row per (user, external account). Provider-agnostic by design.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `user_id` | `uuid` (v7) FK → users | |
| `provider` | enum | `STRAVA` \| `GARMIN` \| `OMRON` \| `MANUAL` |
| `provider_user_id` | text | the ID at the provider (Strava athlete id, …) |
| `status` | enum | `PENDING` \| `ACTIVE` \| `ERROR` \| `REVOKED` |
| `access_token_enc` | text | encrypted at rest (AES-256-GCM, key from env) |
| `refresh_token_enc` | text | encrypted at rest |
| `token_expires_at` | timestamptz | |
| `scopes` | text[] | granted scopes, for audit |
| `last_synced_at` | timestamptz | incremental-sync watermark |
| `created_at` / `updated_at` | timestamptz | |

Unique on (`user_id`, `provider`, `provider_user_id`).

### `sync_logs`

Audit/observability for every background sync run (token refreshes, pull
requests, failures).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `connection_id` | `uuid` (v7) FK → connections | |
| `kind` | enum | `ACTIVITIES` \| `MEASUREMENTS` \| `TOKEN_REFRESH` |
| `status` | enum | `OK` \| `PARTIAL` \| `ERROR` |
| `items_pulled` | int | |
| `items_created` / `items_updated` | int | dedup accounting |
| `error_detail` | jsonb | |
| `started_at` / `finished_at` | timestamptz | |

### `activities`

Normalized activity/Workout. FIT-era fields kept flat; provider payloads that
don't map get parked in `raw` for later backfill.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `user_id` | `uuid` (v7) FK → users | |
| `headline` | text | activity title |
| `type` | enum | `RUN` \| `RIDE` \| `VIRTUAL_RIDE` \| `WALK` \| `SWIM` \| `WORKOUT` \| `OTHER` … |
| `start_time` | timestamptz | canonical dedup key (with `source`) |
| `duration_s` | int | elapsed time |
| `moving_time_s` | int nullable | |
| `distance_m` | numeric | |
| `avg_speed_ms` / `max_speed_ms` | numeric nullable | |
| `total_ascent_m` / `total_descent_m` | numeric nullable | cumulative climb/drop |
| `elevation_high_m` / `elevation_low_m` | numeric nullable | altitude range |
| `avg_hr` / `max_hr` | int nullable | heart rate |
| `hr_zones_min` | jsonb nullable | minutes per HR zone (index 0 = zone 1), source-reported when available |
| `avg_power_w` / `max_power_w` | int nullable | cycling power |
| `avg_cadence` / `max_cadence` | int nullable | rpm (or run step-cadence as delivered) |
| `calories_kcal` | int nullable | |
| `training_load` | int nullable | source-reported TSS-like load; semantics vary by provider — `raw` is the authority |
| `indoor` | bool | Zwift/trainer rides are flagged here |
| `gear_id` | `uuid` (v7) FK → gear nullable | |
| `notes` | text | edited in Stridash only (never pushed back) |
| `raw` | jsonb | original provider payload |
| `created_at` / `updated_at` | timestamptz | |

**Deduplication** — the same ride legitimately arrives from two providers
(e.g. Zwift → Strava push plus direct Garmin). Uniqueness is enforced with a
composite index:

```
uniq (user_id, source, source_activity_id)            -- provider ids
uniq (user_id, start_time, type, distance_m)          -- heuristic fuzzy key
```

### `activity_sources`

Which connections produced an activity row (many-to-many). Lets us show
"Synced from Garmin + Strava" and decide which provider is authoritative for
which field.

| Column | Type | Notes |
|---|---|---|
| `activity_id` | `uuid` (v7) FK → activities | |
| `connection_id` | `uuid` (v7) FK → connections | |
| `source_activity_id` | text | id at the provider |
| `source_updated_at` | timestamptz | provider-side edit detection |
| PK | (`activity_id`, `connection_id`) | |

### `activity_data_points`

Per-sample performance series (the FIT/GPX "stream") for charts and deeper
analysis. One row per `(activity, provider)` — the same ride from Garmin and
Strava keeps both series; at query time the richest wins, the rest stay as
provenance. Streams live in `series` jsonb as *parallel numeric arrays*
(matching index across arrays = one sample):

| `series` key | Meaning |
|---|---|
| `timeMs` | sample clock (ms since epoch) — always present |
| `latDeg` / `lngDeg` | GPS track |
| `distanceM` | cumulative distance |
| `altitudeM` | barometer/GPS altitude |
| `speedMs` | instantaneous speed |
| `hrBpm` / `cadenceRpm` / `powerW` | heart rate, cadence, power |
| `temperatureC` | device temperature |

Providers that don't deliver a stream simply omit its array.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `activity_id` | `uuid` (v7) FK → activities | on delete cascade |
| `provider` | enum | which provider's series |
| `sample_count` | int | length of every array |
| `series` | jsonb | parallel numeric arrays (above) |
| `raw` | jsonb nullable | untouched original stream payload |
| `created_at` / `updated_at` | timestamptz | |
| PK | (`activity_id`, `provider`) unique | |

### `measurements`

Single table for all point-in-time health readings, discriminated by `kind`.
Weight, body composition from the Omron KRD-703T, and blood pressure all live
here; metrics that don't apply are NULL rather than separate tables. This keeps
the app's chart code one-query simple and lets future metric kinds (sensor
values, etc.) land without migrations.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `user_id` | `uuid` (v7) FK → users | |
| `connection_id` | `uuid` (v7) FK → connections nullable | NULL = manual entry |
| `kind` | enum | `WEIGH_IN` \| `BLOOD_PRESSURE` |
| `measured_at` | timestamptz | canonical dedup key (with `connection`) |
| --- WEIGH_IN columns --- | | |
| `weight_kg` | numeric | |
| `body_fat_pct` | numeric nullable | Omron: body fat % |
| `muscle_mass_kg` | numeric nullable | from skeletal muscle % × weight |
| `skeletal_muscle_pct` | numeric nullable | raw Omron value |
| `bmi` | numeric nullable | |
| `visceral_fat_level` | numeric nullable | Omron visceral rating (one decimal, e.g. 702T family) |
| `resting_metabolism_kcal` | int nullable | basal metabolic rate |
| `metabolic_age` | int nullable | Omron "body age" |
| `subcutaneous_fat_pct` | numeric nullable | Omron code 281 |
| `fat_free_mass_kg` | numeric nullable | Omron code 268 (weight excl. fat) |
| `fat_mass_kg` | numeric nullable | Omron code 295 |
| `skeletal_muscle_mass_kg` | numeric nullable | Omron code 294 |
| `impedance_ohm` | numeric nullable | Omron code 267 — raw BIA reading |
| `body_water_pct` | numeric nullable | reserved (Garmin/Omron family doesn't send) |
| `bone_mass_kg` | numeric nullable | reserved |
| --- BLOOD_PRESSURE columns --- | | |
| `systolic_mmhg` | int nullable | |
| `diastolic_mmhg` | int nullable | |
| `pulse_bpm` | int nullable | |
| `mean_arterial_pressure` | numeric nullable | Omron code 16 (BP monitors) |
| | | |
| `notes` | text | e.g. Omron quality flags (movement, irregular HB) |
| `segments` | jsonb nullable | Segmental body composition — see below |
| `raw` | jsonb | Full provider payload, incl. fields not yet modeled |
| `created_at` / `updated_at` | timestamptz | |

**`segments` — segmental body composition.** The KRD-703T (HBF-702T generation)
reports skeletal-muscle % and subcutaneous fat % for arms, trunk, and legs
(Omron codes 275–288). Stored as a structured JSON blob so the app can chart
per-body-part trends without 12 sparse columns:

```jsonc
{
  "arms":  { "muscle_pct": 33.2, "subcutaneous_fat_pct": 8.1 },
  "trunk": { "muscle_pct": 41.5, "subcutaneous_fat_pct": 12.6 },
  "legs":  { "muscle_pct": 48.9, "subcutaneous_fat_pct": 21.3 }
}
```

Dedup index: `uniq (connection_id, kind, measured_at)` — matches omramin's
timestamp-based duplicate detection.

### `gear`

Bikes / shoes / equipment. Gear is provider-synced where the provider has
a gear concept — **Garmin does** (gear-service v2: uuid, type, usage
counters, ACTIVE/RETIRED, per-activity links; see `docs/garmin.md`) —
and Stridash-managed otherwise. `provider` + `source_gear_id` are the
dedup key for synced rows; manual gear has both null.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `user_id` | `uuid` (v7) FK → users | |
| `name` | text | display name (Garmin's `brand` field is the nickname) |
| `kind` | enum | `BIKE` \| `SHOES` \| `OTHER` (unknown v2 gearTypes → `OTHER`) |
| `brand` / `model` | text nullable | |
| `provider` | enum nullable | null = manual gear |
| `source_gear_id` | text nullable | provider's gear id (Garmin dashed uuid) |
| `first_used_at` | date nullable | provider-reported |
| `retired_at` | date nullable | null = in use; synced from Garmin status |
| `usage_type` | text nullable | `DISTANCE` \| `TIME` |
| `threshold_m` | decimal nullable | provider-reported retirement threshold (meters) |
| `raw` | jsonb nullable | provider payload as-received |
| `created_at` / `updated_at` | timestamptz | |

Dedup index: `uniq (user_id, provider, source_gear_id)` — Postgres treats
NULLs as distinct, so manual gear rows never collide.

#### Usage

Usage is **computed, never stored**: sum of `activities.distance_m` /
`activities.duration_s` over rows with `activities.gear_id` pointing at the
gear (the provider's per-activity gear links fill that column at ingest,
plus a bounded self-healing backfill for rows that predate gear sync).
`GET /api/gear` returns it alongside the gear row.

### `gear_components`

Wear items mounted on a piece of gear — chains, brake pads, tires, shoe
insoles. **No provider has a component concept** (Garmin tracks the bike,
not its chain); components are Stridash-managed and their usage is
computed from the parent gear's activities within the component's window.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `user_id` | `uuid` (v7) FK → users | |
| `gear_id` | `uuid` (v7) FK → gear (cascade) | |
| `name` | text | |
| `kind` | enum | `CHAIN` \| `CASSETTE` \| `CHAINRING` \| `BRAKE_PADS` \| `TIRES` \| `TUBES` \| `PEDALS` \| `BATTERY` \| `OTHER` |
| `installed_at` | date nullable | usage counts activities starting on/after; null = unknown install odometer → usage 0 |
| `retired_at` | date nullable | null = still mounted |
| `threshold_m` | decimal nullable | user's own replacement threshold (advisory) |
| `notes` | text nullable | |
| `created_at` / `updated_at` | timestamptz | |

Component CRUD: `POST /api/gear/:gearId/components`,
`PATCH /api/gear/components/:id` (retire by setting `retiredAt`),
`DELETE /api/gear/components/:id` — all user-scoped.

### `auth_identities`

Local credential (password hash) per user; structured so a future
"sign in with Google/Apple" can slot in as additional identity rows.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` (v7) PK | |
| `user_id` | `uuid` (v7) FK → users | |
| `kind` | enum | `PASSWORD` |
| `secret_hash` | text | argon2id |
| `updated_at` | timestamptz | |

## Modeling decisions worth remembering

1. **Provider-agnostic core.** New sources (Withings, Polar, wahoo…) are a new
   `Connection` + ingest adapter; zero domain-table changes.
2. **`measurements` is one wide table**, deliberately. Chart queries and
   "trends across kinds" dominate this app's access pattern; the occasional
   sparse column cost is worth it. Omron-device protocols carry far more than
   the average tool persists (omramin, for example, keeps only ~7 of the
   ~17 scale values the cloud returns — it drops impedance, fat-free mass,
   fat mass, muscle mass, and the segmental arms/trunk/legs breakdown).
   Stridash is built to keep all of it: promoted to columns where we can
   chart them today, captured in `raw` for anything else.
3. **Segmental results live in `segments` jsonb**, not columns. They only
   exist for some devices and are naturally a nested structure
   (body part × metric); flattening would cost 12 near-empty columns.
4. **Future health kinds** (steps, sleep, SpO₂, ECG/AFib — all present in the
   Omron cloud protocol; plus sensor data from other providers) land as new
   `kind` values with their own columns in the same table. No provider ever
   changes the shape of existing rows.
3. **Tokens are encrypted at rest** in `connections`, and never leave the
   server. App stores get zero credentials.
4. **Every sync is logged** in `sync_logs` — unofficial APIs break regularly,
   and logs are how we diagnose and backfill.
5. **`raw` jsonb columns** mean we never destroy provider data we don't yet
   model; migrate-forward instead of re-sync.
