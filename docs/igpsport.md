# iGPSPORT integration (private web-API, international deployment)

Stridash pulls rides **directly from iGPSPORT's cloud** — cycling-computer
activities land in `activities` + `activity_data_points` with full FIT-grade
streams, no Strava round-trip. Server-side only
(`apps/server/src/providers/igpsport/`, `apps/server/src/services/igpsport-sync.ts`).

## How the iGPSPORT cloud actually works

Protocol mapped from the official web client's traffic; references consulted
for protocol facts (not code): [igpsport-mcp][igpsport-mcp]. Deployment split:

| | International (`intl`) | China (`cn`) |
|---|---|---|
| API base | `https://prod.en.igpsport.com` | `https://prod.zh.igpsport.com` |
| Auth | plain Bearer JWT | Bearer JWT **+ per-request WASM signature** |
| Stridash | ✅ supported | ❌ rejected with a clear error |

Auth: `POST /service/auth/account/login`
`{"appId": "igpsport-web", "username", "password"}` →
`{access_token (JWT, carries `memberid` + `exp`), refresh_token?, expires_in}`.
The JWT is the long-lived identity; the web client re-logins on expiry
(there is no documented refresh-token grant), so Stridash stores the account
password **AES-256-GCM encrypted** in `connections.refresh_token_enc` and
re-authenticates transparently when the JWT nears expiry (see Security).

## Endpoints used

| Path | Purpose |
|---|---|
| `GET /service/web-gateway/web-analyze/activity/queryMyActivity?pageNo=N&pageSize=M&reqType=0&sort=1` | discovery pages (id, title, start time, distance, avg speed, ascent) |
| `GET …/activity/queryActivityDetail/{rideId}` | detail incl. `fitUrl` (intl) |
| `GET …/activity/getDownloadUrl/{rideId}` | presigned OSS URL for the FIT |
| (OSS direct GET) | the FIT binary (magic `.FIT` at byte 8 checked) |

Responses use the envelope `{code: 0, data}`; any other `code` is a business
error surfaced to the API caller with its provider message (e.g. undecoded
`1002 → "Password error"`).

## Why FIT is the source of truth

`queryMyActivity` rows carry **no HR/power/cadence**; those plus positions,
altitude, temperature only exist in the per-ride FIT. So each new ride is:
list row → FIT download → `fit-file-parser` decode → scalars derived from the
records (avg/max speed, HR, power, cadence, elevation high/low, ascent from
the list row when present) + `activity_data_points` series row
(`timeMs, latDeg, lngDeg, distanceM, altitudeM, speedMs, hrBpm, cadenceRpm,
powerW, temperatureC`). Summary and series can therefore never disagree.
If FIT download/parse fails, the row summary is stored with
`approximateStartTime: true` in `raw` (start time backfilled from the string
"YYYY-MM-DD HH:MM:SS" as UTC — corrected when a full re-sync gets the FIT).

`exerciseType` mapping: 0 → RIDE; anything unrecognized → OTHER (iGPSPORT's
fleet is bike computers; extend as devices report new types).

## Sync strategy

- Pages scanned newest-first; stops after two fully-known pages or 5 pages.
- New rides: dedup first at user level (`user_id, start_time, type,
  distance_m`) — a ride already stored by Garmin/Zwift only gets an
  `activity_sources` provenance row; otherwise full upsert inside one
  transaction (activity + source + streams).
- Per-ride failures degrade the sync log to `PARTIAL` (failed ride ids in
  `error_detail.failed`), not `ERROR`.
- `tests/igpsport-normalize.test.ts` covers JWT claims peeking, region
  gating, type mapping, and scalar/series derivation (19 tests total).

## Security notes

- The password is required because iGPSPORT offers no refresh-token grant
  to third-party clients; it is stored **AES-256-GCM encrypted** and never
  returned by any API. A non-secret `{igpsport: {region, username}}` blob
  lives in `connections.config`.
- CN accounts are rejected at connect time — their repo-observed request
  signing needs executing the web frontend's WASM signer; revisit only if a
  user actually needs it (JWT + replay of `edge_core` would be the path).
- Unofficial API: expect drift; error messages preserve the provider's own
  `code`/`message` to make breakage diagnosable.

[igpsport-mcp]: https://github.com/dengxuhui/igpsport-mcp — protocol reference only.
