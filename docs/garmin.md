# Garmin Connect (scraping-based)

Garmin does not offer a self-service public API for personal projects (the
official **Garmin Connect Developer Program** requires an approved
application; as of 2026-10 it reopened with Personal / Starter / Enterprise
tiers — Personal is the long-term goal for Stridash). Until approvals land,
Garmin sync uses the **SSO credential login** the Garmin Connect mobile and
web clients themselves use, exact strategy chain as
[`cyberjunky/python-garminconnect`](https://github.com/cyberjunky/python-garminconnect)'s
`client/sso.py`, ported to TypeScript.

Password only ever travels once over TLS to `sso.garmin.com` — the server
keeps the resulting OAuth tokens (never the password):

```
Stridash API ──→ sso.garmin.com            (sign-in, one of 3 strategies)
            ──→ diauth.garmin.com          (CAS ticket → DI OAuth2 tokens)
            ──→ connectapi.garmin.com      (Bearer-token REST API)
```

## Login strategy chain

A signed `POST /api/connections {provider:"GARMIN", email, password}` runs the
strategies in order and stops at the first success. Only credential errors
stop the chain immediately; rate limits / bot challenges / transport failures
fall through:

| # | Strategy | Notes |
|---|----------|-------|
| 1 | Mobile iOS (`/mobile/api/login`) | POSTs JSON creds like the iOS app, after loading the sign-in page (its `SESSION`/`__cf_bm` cookies make the POST work) |
| 2 | SSO embed widget (`/sso/signin` HTML form) | separate rate-limit bucket; carries a CSRF token; the ticket comes back in the success page |
| 3 | Portal web (`/portal/api/login`) | desktop browser flow |

Anti-WAF delays are part of the protocol and kept verbatim: mobile 2–5 s,
widget 3–8 s, portal 10–20 s between page load and credential POST. A full
connect call therefore takes seconds to ~1 minute — do not short-circuit them,
Cloudflare deflects tight GET→POST sequences with 427/429/403.

Differences from the Python reference (deliberate):

- **No curl_cffi TLS impersonation** — browser TLS-fingerprint spoofing is not
  realistically reachable from Node's TLS stack. The three rate-limit
  *buckets* are kept; the per-fingerprint rotation is not. Consequence:
  usernames/networks being actively throttled may see more 429s than the
  Python client until strategy 2 or 3 catches.
- **No JWT_WEB cookie fallback** for session establishment — the DI token
  exchange (below) must succeed. JWT_WEB required SSO/TGT cookie babysitting
  and is the first casualty whenever Garmin reworks auth.

### MFA (second factor)

If the account has MFA, connect answers

```
202 { mfaRequired: true, method: "email", connection }
```

and parks the pending SSO session (cookies + CSRF, AES-256-GCM encrypted in
the connection's refresh-token slot — these are session-level secrets).
Complete it with

```
POST /api/connections/:id/mfa { code: "123456" }
```

The code goes to the same endpoint family the apps use: widget flow →
`/sso/verifyMFA/loginEnterMfaCode`, JSON flows → `/{mobile,portal}/api/mfa/verifyCode`
(both paths are tried, they sit in different rate buckets). A wrong code does
**not** destroy the pending state — retry with a new code. The password is
never re-asked for MFA. `method` is the
`customerMfaInfo.mfaLastMethodUsed` / widget `mfaMethod` value (TOTP apps,
email, SMS are all supported; for email/SMS the server proactively requests
requests a code if Garmin did not send one during the sign-in POST, mirroring
the widget's "Request a new code" link).

## Session establishment

After a successful strategy reply contains a **CAS service ticket** (`ST-…`).
Stridash exchanges it on `diauth.garmin.com/di-oauth2-service/oauth/token`
(form-encoded, HTTP Basic with the DI client id) using grant type
`https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket`,
trying client ids `GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2`,
`…_2024Q4`, `…_DI`, `GARMIN_CONNECT_MOBILE_IOS_DI` — the same chain
python-garminconnect uses (2026: Garmin rotates the Android DI client id at
the top of the list).

Result: `access_token` (a JWT, typically ~1 h) + `refresh_token`. Both stored
AES-256-GCM encrypted (`access_token_enc` / `refresh_token_enc`); the client
id that worked is noted in `config.garmin.diClientId`. Every login is
verified against the API tier (`GET /userprofile-service/socialProfile`) —
garmin's DI endpoint can return tokens the connect API rejects 401
("token is not active", region dependent); that surfaces as
`502 { error: "Garmin token rejected by API tier" }` instead of a useless
connection row.

Refresh before expiry uses the DI refresh grant on the same token endpoint
(locks: refresh happens when the JWT is <15 min from expiry). If a refresh
is ever permanent-failed (upstream credential revoked server-side), the
connection errors visibly; reconnecting the account (email+password again
via connect) re-establishes it. Like garth, Stridash never re-puts the
password to refresh a session.

## Sync

`POST /api/connections/:id/sync` pages the list endpoint newest-first:

```
GET connectapi/activitylist-service/activities/search/activities?start=0&limit=20
```

per new activity, downloads the authoritative original file:

```
GET connectapi/download-service/files/activity/<id>   (FIT)
```

**Format caveat** (verified live, 2026-11): the download answers
`application/x-zip-compressed` — a *streamed* ZIP whose one member is
`<id>_ACTIVITY.fit`, with the local header's compressed-size field zeroed
(data descriptor). Stridash unwraps it in `providers/garmin/fitzip.ts`
(magic detection + a tiny one-member un-zipper on node zlib) before the same
MIT `fit-file-parser` used for iGPSPORT rides. Scalar averages
derive from the same records so summary and series can never disagree; when
the FIT is unavailable the list summary is stored with
`raw.approximateStartTime: true` and the sync continues as OK/PARTIAL with
the failed ids in `errorDetail.failed`.

Dedup is identical to the other providers: prefer the user-level key
(`userId, startTime, type, distance`) so the same ride from Garmin and
iGPSPORT/Zwift becomes one activity; provenance is registered in
`activity_sources` (unique per connection) and streams in
`activity_data_points` (`provider = "GARMIN"`).

Scope today: **activities** (+ GPS/HR/power/cadence/altitude/temperature
series). Weight/HRV/daily wellness endpoints exist for the Personal-API or
garmin connect scraping but are not wired into the measurement pipeline yet.

## API surface

| Endpoint | Notes |
|----------|-------|
| `POST /api/connections` | body `{provider:"GARMIN", email, password}` — runs the SSO strategy chain; **202 PENDING_MFA** or 201 connection. The account password is verified, used once, **not stored**. |
| `POST /api/connections/:id/mfa` | body `{code}` — completes a 202 pending second-factor login. |
| `POST /api/connections/:id/sync` | pages + ingests activities (first sync pulls up to 200; rerun for older history as pages fill). |
| `DELETE /api/connections/:id` | revoke: wipes tokens, stops syncing (data rows stay). |

## Operational reality check

- Garmin changed their auth flow in 2025 (deprecating matin/garth and a
  wave of 429s). Expect drift; errors deliberately surface Garmin's own
  responseStatus values (`MFA_REQUIRED`, `INVALID_USERNAME_PASSWORD`,
  `CAPTCHA_REQUIRED`, HTTP 427/429) verbatim.
- Login **rate limits are aggressive and per-fingerprint**, not per-IP.
  Repeated connect attempts hitting 429s should stop; the account may be
  temporarily blocked.
- When the Garmin application (Personal tier) is approved for Stridash
  deployments, this scraping path should be **replaced** by the official
  OAuth2 flow — the sync/ingest/normalize halves here are provider-agnostic
  and stay.

## Reference notes

The chain mirrors python-garminconnect (cyberjunky) 2026 `client/sso.py`.
Licensing: this file reproduces behavior/URLs/regexes **documented in prose**
and does not copy code from any GPL'd project — same policy as `docs/omron.md`.

## FIT fidelity (2026-11)

Garmin serves FITs as a streamed ZIP (`application/x-zip-compressed`,
`extractFitFromDownload` unwraps the `<id>_ACTIVITY.fit` member; local header
`compressedSize=0` due to data descriptors). Inside, the files use the
**`enhanced_*`** variants of speed/altitude (`enhanced_speed`,
`enhanced_altitude`, `enhanced_respiration_rate`) — the bare `speed`/`altitude`
fields are absent in modern files, so the parser rides either spelling.

Per-sample series channels stored in `activity_data_points.series`:

`timeMs, latDeg, lngDeg, distanceM, altitudeM, speedMs, hrBpm, cadenceRpm,
powerW, temperatureC` — plus running dynamics / body metrics (Garmin running
files; iGPSPORT head-unit files do not carry them):
`verticalOscillationM, stanceTimePct, verticalRatioPct, stepLengthM,
respirationRate, staminaPct`.

Unit gotchas: `fit-file-parser` rescales `distance`/`altitude` per
`lengthUnit`, but leaves `vertical_oscillation` and `step_length` in raw
**millimetres** — the parser divides by 1000.

Session-level summaries land in `activities.raw.session` (jsonb): sport,
VO2max, recovery time, aerobic/anaerobic training effect, normalized power,
`training_load_peak` (also mirrored into `training_load`), avg/max HR and
power, avg/max respiration, total calories. Source-reported HR-zone minutes
(FIT `time_in_zone`) go to the `hr_zones_min` column, zone 1 first.

## Wellness (sleep + daily metrics, 2026-11)

The DI (native API) bearer ALSO answers the wellness tier. Verified live:

- `/sleep-service/stats/sleep/daily/{start}/{end}` — nightly summaries,
  **28-day max per request**. Rows: stage minutes, score, resting/avg HR,
  respiration, HRV status/avg, body-battery change, sleep need.
- `/sleep-service/sleep/dailySleepData?date=YYYY-MM-DD&nonSleepBufferMinutes=60`
  — one day, full detail: nap seconds, awake counts, avg sleep stress,
  stage subscores. Only meaningful within recent history; responses for
  nights without a sleep record carry an all-null DTO (startTimestampGMT
  null) — treat as "no night".
- `/usersummary-service/v2/dailysummaries?startDate&endDate` — steps + goal +
  distance, floors, active/resting/total calories, HR min/max/resting,
  intensity minutes, stress avg/max, body battery min/max/latest in ONE
  call per range.
- The older `wellness-service/wellness/{dailySleepData|heartRates|...}`
  endpoints mostly 404 or need the web-session JWT; only `dailyStress`
  answered with the DI token (kept unused: dailysummaries covers it).

Sync: `services/garmin-wellness.ts` runs after every Garmin activity sync
(separate `WELLNESS` sync_logs row). Backfill starts at the oldest stored
dateKey (first run: 2022-01-01; Garmin answers 0 rows before the first
device sync). Recent 45 nights always get the rich dailySleepData pass.

## Gear (gear-service v2, verified live 2026-11)

Garmin is the only Stridash provider with a gear concept (Zwift and
iGPSPORT carry none in their payloads). Endpoints that answer with a DI
bearer:

- `GET /gear-service/gear/v2/list?start=0&limit=N` — the whole gear list.
  Each row: dashed `uuid`, `gearType` (`SHOES`/`BIKE`/…), `status`
  (`ACTIVE`/`RETIRED`), `brand` (the user's nickname — `name`/`model`
  may also appear), `usageType` (`DISTANCE`/`TIME`),
  `maxUsageDistanceMeters` (retirement threshold), `firstUseDate`,
  `distanceUsedMeters` / `durationUsedSeconds` / `numActivitiesLinked`,
  `countsByActivityType` on the detail call.
- `GET /gear-service/gear/v2/{uuid}` — one gear with
  `countsByActivityType`/images/collections.
- `GET /activitylist-service/activities/{gearUuid}/gear?start&limit` —
  which activities used the gear. **This is the per-activity mapping we
  use**; the per-activity variant `GET /gear-service/activity/v2/{id}`
  answers `[]` unreliably (empty even for gear-linked activities), and
  the legacy `filterGear?activityId=` 404s.
- `GET /gear-service/gear/stats/{uuid}` — totals (legacy, unused here —
  the v2 list already carries usage counters).
- `GET /gear-service/gear/user/{profilePk}/activityTypes` — default gear
  per activity type (empty unless the user set defaults in Connect).

Components (chains, brake pads, …) are NOT a Garmin concept — the
`gear_components` table is Stridash-managed, with usage computed from the
activities linked to the parent gear. Sync wiring lives in
`services/garmin-sync.ts` (`syncGear` + the bounded gear backfill pass);
mapping in `providers/garmin/normalize.ts` (`mapGearRow`).

## Devices (device-service + activity detail, verified live 2026-11-12)

Garmin reports the recording device two ways, and both agree:

- **FIT device message** (per activity): the decoded FIT's `device_infos`
  array carries 14+ messages on a typical run — the watch plus sensors
  (GPS chip, accelerometer, sensor hub, HR straps). The recorder is the
  message with `device_index: "creator"`: `manufacturer: "garmin"`,
  numeric `product` (4024 = Forerunner 955 Solar), `serial_number`
  (3422639741, numeric — always stringified), `software_version` (29.05).
- **Activity detail** `GET /activity-service/activity/{id}`:
  `metadataDTO.manufacturer` ("GARMIN") +
  `metadataDTO.deviceMetaDataDTO` = `{ deviceId: "3422639741",
  deviceTypePk: 37016, deviceVersionPk: 1016639 }`. The `deviceId` here
  IS the FIT serial — cheap JSON backfill path, no FIT re-download.
- **Device registration list** `GET
  /device-service/deviceregistration/devices` — the user's devices with
  `deviceId` (= FIT serial), `productDisplayName` ("Forerunner 955
  Solar", "HRM 600", "Index™ S2 Smart Scale"), `deviceTypePk`,
  `partNumber` (`006-B4024-00` — the FIT product code is embedded after
  the `B`), `serialNumber` (the human-readable serial). One call per sync
  builds the serial → model-name map used to fill `devices.model`.

Wiring: fresh ingests read the FIT creator message; the self-healing
backfill pass (50 activities per sync, newest first) uses the activity
detail endpoint and only links activities whose `device_id` is still
null. Zwift carries no device keys in its detail payloads; iGPSPORT FITs
carry one `device_infos` message (manufacturer "igpsport", product 301,
serial + sw/hw version, no model-name registry). Omron weigh-ins have no
per-measurement device.
