# Roadmap

Milestones are ordered so that each one is independently useful and
demoable. Status: ☐ planned · 🔨 in progress · ✅ done

## M1 — Monorepo skeleton 🔨

- [ ] npm workspaces layout (`apps/*`, `packages/*`)
- [ ] Shared TypeScript config, ESLint, Prettier
- [ ] `packages/types`: domain + API types from the [data model](data-model.md)
- [ ] `apps/server`: Hono boilerplate, health endpoint, Prisma schema matching
      the data model, migrations, auth groundwork (register/login/refresh)
- [ ] `apps/mobile`: Expo app boots on Android/iOS/web, renders connected
      health from the local API
- [ ] CI: typecheck + lint + tests on PR
- [ ] Docker compose for local Postgres

## M2 — Strava integration ☐

*(This is first integration-wise because it's an official API — the honest way
to prove the plumbing — and it silently delivers two other sources: Zwift and
iGPSPORT both push to Strava.)*

- [ ] Strava OAuth connect flow (app → server redirect, token exchange)
- [ ] Encrypted token storage + auto refresh
- [ ] Incremental activity pull with watermarking and dedup upsert
- [ ] Gear mapping from Strava
- [ ] `sync_logs` entries + basic backfill support (`--days N` style)

## M3 — Garmin Connect integration ☐

*(Unofficial API — treat as the risky sibling of M2.)*

- [ ] Garmin auth (session-based, MFA aware, token caching)
- [ ] Activity FIT download → normalize to domain model
- [ ] Weight / body composition ingest (Garmin Index or any scale synced to
      Garmin)
- [ ] Blood pressure ingest
- [ ] E2E dedup testing against Strava-originated duplicates

## M4 — Omron scale integration ☐

Target scale: **Omron KRD-703T** via the OMRON Connect cloud API. Approach and
field mapping follow [omramin](https://github.com/bugficks/omramin) (GPLv2);
license implication documented in README.

- [ ] Omron auth + token refresh (region-dependent server endpoints)
- [ ] Weigh-in ingest — **full fidelity, not the standard 7 fields**: weight,
      BMI, body fat %, skeletal muscle % + mass, subcutaneous fat %, fat
      mass, fat-free mass, impedance, resting metabolism, metabolic age,
      visceral fat level, and the segmental arms/trunk/legs breakdown
      (via `raw` + `segments`, per the data model)
- [ ] BP monitor ingest (incl. mean arterial pressure + quality flags)
- [ ] Region config validated for the user's account country

## M5 — App dashboard ☐

- [ ] Onboarding: create user → connect providers → first sync
- [ ] Weight + body-composition trend charts (custom-built to avoid heavy deps;
      offline-capable, no chart library — keep it light on RN-web)
- [ ] Activity feed w/ type filter, indoor flag
- [ ] Connections screen: status per connection, "sync now", last-sync watermark
- [ ] Error surfacing from `sync_logs` in human language
- [ ] Web dashboard deploy (Expo web build)

## M6 — Extras ☐

- [ ] Manual entry: weight / BP quick-add from the app
- [ ] Data export (CSV / full JSON dump of your data — user owns it)
- [ ] Direct BLE pairing to the Omron scale on mobile (bypass cloud)
- [ ] Multi-user hardening, push notifications ("new ride synced")
- [ ] Garadget-style webhooks/poll for near-real-time sync where APIs allow
