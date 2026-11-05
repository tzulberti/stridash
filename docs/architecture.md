# Architecture

## High-level shape

```
              ┌─────────────────────────────────────────────┐
              │                 Monorepo (TS)               │
              │                                             │
 Garmin  ────►│  apps/server                                │
 Omron   ────►│  ├─ Hono REST API        apps/mobile        │
 Strava  ────►│  ├─ Sync engine          apps/web           │
 (Zwift/      │  │   ├─ Garmin adapter     │   │            │
  iGPSPORT)   │  │   ├─ Strava adapter     └───┴── REST ────►│
              │  │   └─ Omron adapter                        │
              │  ├─ Scheduler (cron jobs, token refresh)    │
              │  └─ Prisma ──► PostgreSQL                   │
              └─────────────────────────────────────────────┘
```

## Components

### `apps/server` — Hono API + sync engine

The server is the only place that talks to third-party clouds. It has three
logical parts:

1. **REST API** (Hono). Serves auth, activities, measurements, connections,
   and sync triggers. Apps are dumb clients — they never hold provider
   credentials. API doc via OpenAPI (Hono middleware generates the spec).
2. **Sync engine.** One adapter per provider, each implementing a common
   interface:
   - `listNew(since: Date)` — incremental pull, keyed on the connection's
     `last_synced_at` watermark
   - `normalize(raw)` → domain `Activity` / `Measurement`
   - `dedupeKey(item)` → canonical identity for upsert
   - `refreshToken()` where the provider uses OAuth (Strava)
   or handles session-scrape auth (Garmin, Omron — unofficial APIs).
3. **Scheduler.** Interval/cron jobs: sync all active connections on a
   staggered schedule, refresh expiring tokens, retry errored connections with
   backoff. Every run writes a `SyncLog`.

Auth for the *app* itself: email+password issuing short-lived JWT access
tokens + rotating refresh tokens. Provider tokens are stored encrypted
(AES-256-GCM; key in `STRIDASH_ENC_KEY` env var — documented secret hygiene).

### `apps/mobile` / `apps/web` — Expo app

One Expo project rendered on all targets:

- **Android / iOS:** native — full features, incl. future direct-BLE scale
  pairing (`react-native-ble-plx`).
- **Web (`react-native-web`):** dashboard-first — trends, activities,
  connection management. No BLE; browser BLE doesn't exist on iOS Safari and
  cloud sync makes it unnecessary on web.

Shared API layer and generated OpenAPI client keeps both targets in lockstep.

### `packages/types`

Hand-authored (later: Prisma-generated) TypeScript domain + API types,
imported by server and apps. The schema in
[`data-model.md`](data-model.md) is the source of truth until the Prisma
schema lands, after which Prisma generates it.

## Data flow example — a Zwift ride

1. Zwift auto-shares to Strava (Zwift's feature; we don't talk to Zwift
   directly — no official API).
2. Server's Strava adapter pulls new activities past the watermark.
3. `normalize` maps it to a `VIRTUAL_RIDE` activity; Garmin may deliver the
   same ride — the dedup keys in `data-model.md` collapse them into one row
   with two `activity_sources`.
4. Apps show it in the unified feed; `raw` keeps both originals.

## Deployment story (target)

- Single Docker image for `apps/server` + Postgres for self-hosters.
- Apps: web build served by the server (or any static host); Expo EAS for
  store builds later.
- All third-party sync happens server-side, so a phone left off for two weeks
  loses nothing.

## Security notes

- Provider credentials + app refresh tokens: DB-encrypted, never logged
  (logging uses only IDs).
- Rate limiting on auth and sync-trigger endpoints (unofficial APIs punish
  bursty traffic — staggering is per-connection).
- The Garmin and Omron syncs emulate users on web platforms; treat those
  codepaths as the most fragile part of the system. `sync_logs` +
  feature-detect tests guard us.
