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
              │  ├─ Scheduler (planned — see risks C7)      │
              │  └─ Prisma ──► PostgreSQL                   │
              └─────────────────────────────────────────────┘
```

## Components

### `apps/server` — Hono API + sync engine

The server is the only place that talks to third-party clouds. It has three
logical parts:

1. **REST API** (Hono). Serves auth, activities, measurements, connections,
   and sync triggers. Apps are dumb clients — they never hold provider
   credentials. A generated OpenAPI spec is planned but not wired yet (see
   `docs/risks-todo.md` C10).
2. **Sync engine.** One adapter per provider, each implementing a common
   interface:
   - `listNew(since: Date)` — incremental pull, keyed on the connection's
     `last_synced_at` watermark
   - `normalize(raw)` → domain `Activity` / `Measurement`
   - shared `services/activity-ingest.ts` owns identity: provider source id
     first, then a tolerance match (same type, start ±60 s, distance ±100 m)
   - `refreshToken()` where the provider uses OAuth (Strava)
   or handles session-scrape auth (Garmin, Omron — unofficial APIs).
3. **Scheduler.** `services/sync-scheduler.ts` runs when
   `STRIDASH_SYNC_INTERVAL_MS > 0` (default 15 minutes; `0` disables it).
   Each tick claims up to `STRIDASH_SYNC_BATCH_SIZE` active, due connections
   oldest-first and hands them to the same queue as manual syncs. The DB
   `sync_started_at` lock keeps replicas from double-running a connection, and
   stale claims are taken over after 15 minutes. Token refresh happens on use;
   retry/backoff and "new ride" notifications remain roadmap work. Every run
   writes a `SyncLog`.

Auth for the *app* itself: email+password issuing short-lived JWT access
tokens + rotating refresh tokens. Provider tokens are stored encrypted
(AES-256-GCM). `STRIDASH_ENC_KEY` is required and decrypts legacy `v1` rows;
new rows use the optional dedicated `STRIDASH_PROVIDER_ENC_KEY` with a
versioned `v2:<keyId>:<salt>:…` format so keys can be rotated and re-encrypted.
See [`docs/deployment.md`](deployment.md) for the rotation procedure and TLS
requirements.

### `apps/web` — Vite dashboard

The browser dashboard is a separate Vite + React + TypeScript app (not
`react-native-web`). It is dashboard-first: trends, activities, connections and
gear. No BLE; browser BLE doesn't exist on iOS Safari and cloud sync makes it
unnecessary on web.

### `apps/mobile` — Expo app

Android and iOS use Expo Router / React Native. The target is full feature
parity with web except device-level features, including future direct-BLE
scale pairing (`react-native-ble-plx`).

Both clients talk to the same REST API and share types from
`packages/types`; there is no generated OpenAPI client yet.

### `packages/types`

Hand-authored (later: Prisma-generated) TypeScript domain + API types,
imported by server and apps. The schema in
[`data-model.md`](data-model.md) is the source of truth until the Prisma
schema lands, after which Prisma generates it.

## Data flow example — a Zwift ride

1. A Zwift ride arrives through the direct Zwift adapter (unofficial API);
   the same ride may also arrive from Garmin or Strava.
2. Each server adapter pulls new activities past its connection watermark.
3. `normalize` maps them to a `VIRTUAL_RIDE` activity; the dedup keys in
   `data-model.md` collapse duplicate deliveries into one row with multiple
   `activity_sources`.
4. Clients show it in the unified feed; `raw` keeps the provider originals.

## Deployment story

- Self-hosters use `docker-compose.prod.yml`: one Node image for the API and
  the built web dashboard, Postgres with a named volume, and Caddy for
  automatic TLS. The app container runs migrations and then serves both
  `/api/*` and the SPA.
- The web build can also be hosted separately (Netlify/Cloudflare/nginx); the
  Expo app remains a separate target for store builds later.
- All third-party sync happens server-side, so a phone left off for two weeks
  loses nothing.

## Security notes

- Provider credentials + app refresh tokens: DB-encrypted, never logged
  (logging uses only IDs).
- Rate limiting on auth and connection-create endpoints; sync triggers are
  claimed and queued per connection (unofficial APIs punish bursty traffic).
- The Garmin and Omron syncs emulate users on web platforms; treat those
  codepaths as the most fragile part of the system. `sync_logs` +
  feature-detect tests guard us.
