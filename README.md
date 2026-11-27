# Stridash

**One dashboard for every stride.** Stridash is an open-source, self-hosted fitness
aggregator that pulls all of your health and activity data — Garmin, Zwift, weight
scales (e.g. Omron), iGPSPORT bike computers — into a single place you control.

Instead of juggling four apps (and losing data between them), Stridash syncs from
each service's cloud into your own database and shows you unified trends:
activities, weight, body composition, blood pressure, and more.

| | |
|---|---|
| **Status** | Server integrations + web dashboard landed; M6 extras in progress — see the [Roadmap](docs/roadmap.md) |
| **Platforms** | Android · iOS (Expo) · Web dashboard (Vite + React) |
| **License** | AGPL-3.0-or-later — see [License notes](#license-notes) |

## How it works

```
 Garmin ─────────────┐
 Zwift ──► Strava ───┤          ┌──────────────────────────┐
 Omron scale ────────┼── sync ──►│  Stridash server (Node)  │
 iGPSPORT ──► Strava ┘           │  + PostgreSQL            │
                                 └────────────┬─────────────┘
                                              │ REST API
                                 ┌────────────┴─────────────┐
                                 │  Stridash clients        │
                                 │  Web dashboard · Expo    │
                                 │  Android · iOS           │
                                 └──────────────────────────┘
```

Key design principles:

- **Sync logic lives server-side**, never in the app. Third-party cloud APIs
  (Garmin, Omron) are unofficial and need token refresh jobs and credentials —
  those must not ship inside a mobile app.
- **Manual syncs are queued**, not request-bound: `POST /connections/:id/sync`
  returns `202` and clients poll `GET /connections/:id/syncs`; Garmin history
  scans can take minutes. When `STRIDASH_SYNC_INTERVAL_MS > 0` (default 15
  minutes) the server also queues due active connections automatically.
- **The app is stateless** relative integrations; it talks only to the Stridash
  API. That keeps web/Android/iOS at feature parity except for device-level
  things (e.g. Bluetooth scale pairing, mobile-only).
- **Web is dashboard-first.** No browser BLE dependencies; the full experience
  (including device pairing) lives on mobile.

## Stack

| Layer | Technology |
|---|---|
| Web dashboard | Vite + React + TypeScript |
| Mobile apps (Android / iOS) | Expo + React Native — TypeScript |
| Backend API | Node.js + Hono — TypeScript |
| Database | PostgreSQL + Prisma |
| Monorepo | npm workspaces |

```
stridash/
├── apps/
│   ├── mobile/        # Expo app (iOS, Android)
│   ├── web/           # Web dashboard (Vite + React)
│   └── server/        # Hono API + sync services + manual-sync queue
├── packages/
│   └── types/         # Shared API/domain types (single source of truth)
└── docs/
```

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md) for the full plan. Milestone summary:

1. ✅ **M1 – Monorepo skeleton** — workspaces, shared types, server boilerplate
2. 🔨 **M2 – Strava integration** — OAuth, encrypted tokens, incremental sync and gear are built; live-account smoke test pending
3. ▶ **M3 – Garmin Connect integration** — server-side activities, wellness, gear, sleep, weight/body composition and blood pressure built; live health-endpoint smoke test remains
4. ✅ **M4 – Omron scale integration** — weight + body composition time series (server side)
5. ▶ **M5 – App dashboard** — web dashboard, onboarding, manual entry, overview health, mobile UI and a responsive pass are live; the larger visual-design pass remains
6. ☐ **M6 – Extras** — CSV export, OpenAPI spec/types, push notifications and Strava webhooks are live; BLE scale support, other-provider polling and multi-user hardening remain
7. ✅ **M7 – MCP server** — stdio + stateless Streamable HTTP, read-only activity/measurement/wellness/gear tools and API-token auth

## Docs

- [Architecture](docs/architecture.md) — components, data flow and deployment shape
- [Data model](docs/data-model.md) — PostgreSQL/Prisma schema and dedup rules
- [Deployment](docs/deployment.md) — production Compose, TLS and key rotation
- [Strava](docs/strava.md) — OAuth setup, scopes and sync behaviour
- [Provider ToS risk](docs/provider-tos-risk.md) — per-provider terms/risk notes
- [OpenAPI](docs/openapi.json) — API spec (also served at `/api/openapi.json`)
- [API tokens](docs/api-tokens.md) — long-lived tokens for MCP/automation
- [MCP server](docs/mcp.md) — read-only LLM tools over stdio
- [Push notifications](docs/push-notifications.md) — Expo token registration
- [Risks & TODO](docs/risks-todo.md) — open security/correctness/maintainability work
- [Roadmap](docs/roadmap.md) — milestones and known feature gaps

## Development

Requirements: Node ≥ 20, Docker (for the local Postgres), npm ≥ 10.

```bash
npm install                         # install all workspace dependencies

npm run db:up                       # start local Postgres on port 5433
npm run db:migrate                  # apply Prisma migrations
npm run dev:server                  # API on http://localhost:3000

npm run dev:mobile                  # Expo app: Android / iOS
npm run dev:web                     # Vite dashboard on http://localhost:5173

npm run typecheck                   # typecheck all workspaces
npm run lint                        # ESLint: server, web, shared types, mobile
npm test                            # all tests: unit + integration + web
npm run test:ci                     # same, with the integration Postgres reused
npm run audit:ci                    # fail on high/critical production-dep CVEs
```

Tests run in three tiers: pure unit tests (provider mappings, sync
orchestration — mocked, milliseconds), route integration tests (the real
Hono app in-process against a throwaway Postgres started by
testcontainers, with every migration applied), and web helper tests.
`npm test` needs Docker for the integration tier; the dev database is
never touched. `npm run audit:ci` gates production dependencies on
high/critical advisories; `scripts/audit-allowlist.json` records the few
reviewed build-chain exceptions. `npm run test:ci` sets
`STRIDASH_TEST_REUSE=1`, which keeps the container between runs
(~5.6s → ~1s warm-up) — useful in GitHub Actions and for repeated local runs:

```yaml
- run: npm ci
- run: npm run test:ci
```

Server configuration lives in `apps/server/.env` (copy from
`.env.example`; secrets can be regenerated with `openssl rand -hex 32`).
**Production must sit behind a TLS-terminating reverse proxy** — see
[`docs/deployment.md`](docs/deployment.md) for the proxy example and key
rotation procedure. The Expo app targets the API via `EXPO_PUBLIC_API_URL` —
set it to your machine's LAN IP to test from a phone.

For a self-hosted production deployment, the included Compose stack builds one
API + web image and runs it behind Caddy with automatic HTTPS:

```bash
cp deploy/.env.example deploy/.env
# edit domain, Postgres password, JWT/encryption secrets
docker compose --env-file deploy/.env -f docker-compose.prod.yml up -d --build
```

The app applies migrations on startup and only Caddy publishes ports 80/443;
see [`docs/deployment.md`](docs/deployment.md) for backups, upgrades, and key
rotation.

## License notes

Stridash is licensed under **AGPL-3.0-or-later** (see `package.json`). The
Omron integration was written after observing the protocol that the official
Omron Connect app speaks, with [omramin](https://github.com/bugficks/omramin)
(GPLv2) consulted for **protocol facts only — no omramin code is used** (the
TypeScript implementation is independent, see [`docs/omron.md`](docs/omron.md)).
