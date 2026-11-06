# Omron integration (API v1 — OmronConnect cloud)

Stridash pulls weigh-ins **and** blood-pressure readings directly from the
Omron Connect cloud — the same cloud the Omron Connect mobile app talks to —
and never relays them through Strava. All Omron code lives server-side
(`apps/server/src/providers/omron/`, `apps/server/src/services/omron-sync.ts`);
the apps only talk to the Stridash API.

## How Omron Connect actually works

There is **no public developer/OAuth program**. The protocol was mapped by
observing the official Omron Connect app ([omramin][omramin] is the main
public reference — protocol knowledge only, no code copied):

1. Regional app-servers expose a Kii-style "app-server-code" REST API at
   `https://data-<region>.omronconnect.com/api/apps/<appId>/server-code/…`,
   with an `(appId, appKey)` pair that the mobile app ships in its bundle.
   Stridash keeps the table in `src/providers/omron/regions.ts`.
2. Logging in is plain email + password at `{cloudUrl}/oauth2/token`
   (`{"username", "password"}`) → `{ access_token, refresh_token }`.
3. Devices: `POST /versions/current/synchronizeDeviceConfData`
   (`lastSyncDate` pagination).
4. Measurements: `POST /versions/current/measureData` per device serial +
   user profile slot. Each sample carries `measureDateTo` (unix ms), a
   `timeZone` (IANA name) and a **`bodyIndexList`**: value code →
   `[rawValue, unitSubtype, scaleExponent, measurementId]`.

## Value codes → Stridash columns (full fidelity)

`normalizeSample()` maps these; the `scale` exponent means `value × 10^scale`,
weight entries are converted to kg via their unit `subtype`
(8192 g, 8195 kg, 8208 lb, 8224 st):

| Code | Meaning | Column |
|---|---|---|
| 257 | weight | `weight_kg` |
| 259 | body fat % | `body_fat_pct` |
| 260 | basal metabolism (kcal) | `resting_metabolism_kcal` |
| 261 | skeletal muscle % | `skeletal_muscle_pct` |
| 262 / 292 | BMI | `bmi` |
| 263 | metabolic (biological) age | `metabolic_age` |
| 264 | visceral fat level | `visceral_fat_level` |
| 265 / 266 | visceral fat / skeletal muscle check flags | `raw` |
| 267 | **impedance (Ω)** | `impedance_ohm` |
| 268 | **FFMI (kg/m²** — fat-free mass *index*, unit 0; ≈ FFM/height²) | `raw.values.FAT_FREE_MASS` |
| 294 | **skeletal muscle mass (kg)** | `skeletal_muscle_mass_kg` |
| 295 | **body fat mass (kg)** | `fat_mass_kg` |
| 275 / 277 / 279 | segmental muscle % (arms / trunk / legs) | `segments.jsonb` |
| 281 / 283 / 285 / 287 | subcutaneous fat % (whole / arms / trunk / legs) | `subcutaneous_fat_pct` / `segments.jsonb` |
| 1 / 2 / 3 / 16 | systolic / diastolic / pulse / MAP | `systolic_mmhg` … |
| 6 / 7 / 8 / 9 | arrhythmia / body-motion / cuff / pulse-quiet flags | `raw.flags` |

Every raw value (including codes Stridash doesn't model yet) is preserved
under `measurements.raw.values` with a human-readable key, so columns can be
backfilled later without re-pulling from Omron.

> **Why not omramin's mapping?** omramin keeps ~7 values per weigh-in and
> drops impedance, fat-free mass, the masses (294/295) and the segmental
> breakdown. Stridash's whole point is full fidelity on KRD-703T-class
> scales, and it also stores both measurement kinds (BP monitors included).

## Region coverage (API v1 = full fidelity)

| Endpoint | Countries |
|---|---|
| `data-sg` | AU, BD, ID, MM, MY, NZ, PH, SG, TH, VN |
| `data-jp` | HK, JP, KR, TW |
| `data-in` | IN |
| `data-eu` | AR, BO, BR, CL, CO, CR, DO, EC, GT, HN, MX, NI, PA, PE, PY, SV, UY, VE |

**Not served (yet):** US/CA and EMEA accounts live on Omron's newer "OCM /
ohiomron" serving stack (API v2), which reports **lossy** scale data (no
impedance, no fat-free mass, no segmental values). Until we accept the
fidelity loss there, `connections.connect` rejects those countries with a
clear error list.

## API surface

| Route | Behavior |
|---|---|
| `POST /api/connections` | body `{provider:"OMRON", identifier, password, country}` — `identifier` is the account's email OR username (the protocol's login field is `username`); verifies the credentials live against Omron, **stores only encrypted tokens** (never the password), returns the connection |
| `POST /api/connections/:id/sync` | refreshes the token if needed, pulls all devices (BPM + scale) since the last sync (1 day overlap for corrections), upserts into `measurements` (dedup: `connection_id + kind + measured_at`), writes a `sync_logs` row |
| `GET /api/connections/:id/syncs` | last 50 sync logs |

Single-device failures degrade the sync log to `PARTIAL` instead of failing
the run; auth failures throw and mark the log `ERROR`.

## Security notes

- Passwords are sent once over TLS at connect time and **never stored** —
  refresh tokens (AES-256-GCM) drive subsequent syncs. If Omron revokes a
  token, the connection flips to `ERROR` and the user re-connects.
- `connection.config` holds only non-secret metadata (`{omron: {country}}`);
  tokens live only in the encrypted columns.
- The Omron account holder's implicit trust of Stridash is unavoidable for
  this integration class; a self-user can point receipts/logs at their own
  container to verify no credentials are logged.

[omramin]: https://github.com/bugficks/omramin — GPLv2; referenced for protocol
observation only.
