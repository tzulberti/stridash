# Stridash

**One dashboard for every stride.** Stridash is an open-source, self-hosted fitness
aggregator that pulls all of your health and activity data — Garmin, Zwift, weight
scales (e.g. Omron), iGPSPORT bike computers — into a single place you control.

Instead of juggling four apps (and losing data between them), Stridash syncs from
each service's cloud into your own database and shows you unified trends:
activities, weight, body composition, blood pressure, and more.

| | |
|---|---|
| **Status** | 🚧 Early development — see the [Roadmap](docs/roadmap.md) |
| **Platforms** | Android · iOS · Web (single codebase) |
| **License** | TBD — see [License notes](#license-notes) |

## How it works

```
 Garmin ─────────────┐
 Zwift ──► Strava ───┤          ┌──────────────────────────┐
 Omron scale ────────┼── sync ──►│  Stridash server (Node)  │
 iGPSPORT ──► Strava ┘           │  + PostgreSQL            │
                                 └────────────┬─────────────┘
                                              │ REST API
                                 ┌────────────┴─────────────┐
                                 │  Stridash app (Expo/RN)  │
                                 │  Android · iOS · Web     │
                                 └──────────────────────────┘
```

Key design principles:

- **Sync logic lives server-side**, never in the app. Third-party cloud APIs
  (Garmin, Omron) are unofficial and need token refresh jobs and credentials —
  those must not ship inside a mobile app.
- **The app is stateless** relative integrations; it talks only to the Stridash
  API. That keeps web/Android/iOS at feature parity except for device-level
  things (e.g. Bluetooth scale pairing, mobile-only).
- **Web is dashboard-first.** No browser BLE dependencies; the full experience
  (including device pairing) lives on mobile.

## Stack

| Layer | Technology |
|---|---|
| Apps (Android / iOS / Web) | Expo + React Native + `react-native-web` — TypeScript |
| Backend API | Node.js + Hono — TypeScript |
| Database | PostgreSQL + Prisma |
| Monorepo | npm workspaces |

```
stridash/
├── apps/
│   ├── mobile/        # Expo app (iOS, Android)
│   ├── web/           # Web dashboard (react-native-web)
│   └── server/        # Hono API + sync services + background jobs
├── packages/
│   └── types/         # Shared API/domain types (single source of truth)
└── docs/
```

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md) for the full plan. Milestone summary:

1. **M1 – Monorepo skeleton** — workspaces, shared types, server boilerplate
2. **M2 – Strava integration** — OAuth + activity sync (this also brings in Zwift and iGPSPORT rides)
3. **M3 – Garmin Connect integration** — activities, weight, body composition, blood pressure
4. **M4 – Omron scale integration** — weight + body composition time series (Omron Connect cloud API)
5. **M5 – App dashboard** — weight/body-composition trend charts, activity list, connections screen
6. **M6 – Extras** — direct BLE scale support on mobile, data export, multi-user hardening

## Development

> ⚠️ Not functional yet — the repo is in the skeleton phase. Sections below will
> be filled in as milestones land.

```bash
npm install            # install all workspace dependencies
npm run dev -w server  # run the API server
npm run dev -w mobile  # run the Expo app
```

## License notes

To be decided at the first tagged release. Constraint to keep in mind: parts of
the Omron sync logic are informed by [omramin](https://github.com/bugficks/omramin)
(GPLv2). If its code is incorporated rather than merely referenced, this project
must be distributed under a GPLv2-compatible license — **AGPL-3.0** is the likely
choice, given the self-hosted/server nature of the product.
