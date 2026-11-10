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
| `GET /api/activities/{id}?fetchSnapshots=true` | detail; adds `fitnessData.fullDataUrl` when absent from the list row |
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

## Known gaps vs the other connectors

- **Stories/laps**: Zwift reports no lap segments (races aside, which have
  race-results endpoints not covered by this connector).
- **No HR-zone time / training load**: Zwift reports neither; both stay null
  (web trainingLoad / hr zone tables degrade gracefully).

## Known quirks

- **IDs exceed the safe integer range** (`> 2^53`) — always use the `id_str` /
  `activityId_str` string fields; the numeric `id`/`activityId`
  doubles lose precision silently on `JSON.parse` and produce 404s (this bit
  the first stream ingest — fixed via `activityId: string` plumbing).
- Plan the force-sync tap right after finishing a Zwift session — the stream
  URL is the same one the Zwift web site graphs, and has historically stayed
  fetchable for older activities, but treat sample availability empirically.
