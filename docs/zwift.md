# Zwift connector

Zwift has **no public API or OAuth client registration** — this connector speaks
the same private protocol the Zwift game client uses (reverse-engineered by the
community). Endpoints and contracts are observed behavior, not promises; expect
them to change unannounced.

## Auth

Keycloak-style token endpoint shared with the game client:

```
POST https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password|refresh_token
client_id=Zwift Game Client     ← audience-bound; do not change
username / password (password grant)
refresh_token (refresh grant)
→ {access_token, refresh_token, expires_in}
```

- The password is verified **once** at connect time and never stored (same rule
  as Garmin SSO / Omron).
- The refresh grant is real and session-carrying: **Keycloak rotates the refresh
  token on every use**, so `refreshTokenEnc` always holds the latest grant.
  Losing it means a manual reconnect (the code answers `400 invalid_grant` /
  `401` with the credentials-rejected path).
- Bad credentials surface as `400 invalid_grant` (or 401) from the token
  endpoint — the client classifies these as `CREDENTIALS` errors.

## API access

Base URL `https://us-or-rly101.zwift.com`; ALL requests must carry the
game-client identity headers or Zwift rejects them as non-client traffic:

```
Platform: OSX
Source: Game Client
User-Agent: CNL/3.30.8 (macOS 13 Ventura; Darwin Kernel 22.4.0) zwift/1.0.110983 curl/7.78.0
Authorization: Bearer <access_token>
```

Ingested endpoints:

| Endpoint | Use |
|---|---|
| `GET /api/profiles/me` | athlete id (= `providerUserId`) at connect time |
| `GET /api/profiles/{athleteId}/activities?start={offset}&limit={n}` | activity list (summary fields, newest first) |
| `GET /api/activities/{id}?fetchSnapshots=true` | detail — the list row lacks `fitnessData`, heart-rate fields, and more; the whole payload is kept in `activities.detail_raw` |
| `GET {fitnessData.fullDataUrl}` | per-second sample arrays |

## Data mapping

Activity summary fields mount 1:1 onto the Stridash activity row
(`distanceInMeters`, `avgWatts`, `avgCadenceInRotationsPerMinute`,
`totalElevationInMeters`, …). `sport: CYCLING` → `VIRTUAL_RIDE`,
`RUNNING` → `RUN`, everything else → `OTHER`; all ingest rows are
`indoor = true`.

Per-second streams are **parallel arrays aligned by index**, with
`timeInSec` as the time base and cm-valued channels:

| Zwift field | Stridash series | conversion |
|---|---|---|
| `timeInSec` | `timeMs` | ×1000 |
| `distanceInCm` | `distanceM` | ÷100 |
| `speedInCmPerSec` | `speedMs` | ÷100 |
| `altitudeInCm` | `altitudeM` | ÷100 |
| `heartRate` | `hrBpm` | — |
| `cadencePerMin` | `cadenceRpm` | — |
| `powerInWatts` | `powerW` | — |

`latlng` is deliberately **not** ingested: those are Zwift world coordinates
(Watopia etc.), not real GPS — storing them under the same channel as real GPS
streams would invite nonsense on any geo feature.

## Edit detection

Zwift list rows carry no update timestamp, but the detail payload's
`lastSaveDate` is bumped on **every in-game save** — renames,
description/privacy edits, workout completion. Verified 2026-11-13:
`lastSaveDate` format is `2026-09-28T22:34:55.957+0000` (millisecond
precision, zero-offset). Same bounded poll-and-compare pattern as
[Garmin's](garmin.md) `lastUpdateDate` pass:

- Each sync polls the details of the **100 most recent activities whose
  `start_time` is within 45 days**, and compares `lastSaveDate` against
  `activity_sources.source_updated_at`.
- A detail without a parseable `lastSaveDate` is never re-ingested blind.
- An edited activity is re-ingested from the detail already in hand:
  headline/workout name, moving time, distance/speeds, HR/power/cadence,
  calories, ascent (the detail row names its ascent key `totalElevation` —
  fractional metres, unlike the list row's `totalElevationInMeters`),
  `detail_raw` refreshed, series rebuilt from the fresh `fitnessData` URL
  (best-effort — the existing series survives a fetch hiccup), and
  `source_updated_at` stamped with the provider's own save time.
- Absent detail fields update nothing (`undefined` = no change in Prisma), so
  a partial payload can never null out stored values. `raw` keeps the
  discovery-time list row; `detail_raw` is the fresh authority.
- **Zwift-owned rows only** (`raw.provider = 'ZWIFT'`): dedup rows pointing
  at another provider's activity never rewrite that owner's authoritative
  payload.
- Fresh ingest stamps `source_updated_at` with "now", so a just-synced
  activity no-ops (its `lastSaveDate` is already in the past) and the pass
  only fires on real later edits.

## Known gaps vs the other connectors

- **Stories/laps**: Zwift reports no lap segments (races aside, which have
  race-results endpoints not covered by this connector).
- **No HR-zone time / training load**: Zwift reports neither; both stay null
  (web trainingLoad / hr zone tables degrade gracefully).
- **No drafting metric** (verified 2026-11-13 across list rows, detail
  payloads and per-second fitness data): Zwift applies drafting as a
  physics modifier while riding and never records it. The only "draft" in
  any stored payload is an achievement badge ("MASTER DRAFTSMAN — You
  drafted another rider for 15 seconds"). A drafting proxy computed from
  speed + power (samples where power sits far below the C_dA-implied
  demand on flats) would be an estimate, not a recorded value.

## Known quirks

- **IDs exceed the safe integer range** (`> 2^53`) — always use the `id_str` /
  `activityId_str` string fields; the numeric `id`/`activityId`
  doubles lose precision silently on `JSON.parse` and produce 404s (this bit
  the first stream ingest — fixed via `activityId: string` plumbing).
- Plan the force-sync tap right after finishing a Zwift session — the stream
  URL is the same one the Zwift web site graphs, and has historically stayed
  fetchable for older activities, but treat sample availability empirically.
