# Roadmap

Milestones are ordered so that each one is independently useful and
demoable. Status: ☐ planned · 🔨 in progress · ✅ done

## M1 — Monorepo skeleton 🔨

- [x] npm workspaces layout (`apps/*`, `packages/*`)
- [x] Shared TypeScript config; Prettier configured (ESLint: `expo lint` runs in mobile; root-level ESLint still pending)
- [x] `packages/types`: domain + API types from the [data model](data-model.md)
- [x] `apps/server`: Hono boilerplate, health endpoint, Prisma schema matching
      the data model, migrations, auth groundwork (register/login/refresh)
- [x] `apps/mobile`: Expo app boots on Android/iOS/web, renders API health
      from the local server
- [x] CI: typecheck on push/PR (lint + tests to follow with first test suites)
- [x] Docker compose for local Postgres (port 5433)

## M2 — Strava integration ☐

*(This is first integration-wise because it's an official API — the honest way
to prove the plumbing — and it silently delivers two other sources: Zwift and
iGPSPORT both push to Strava.)*

- [ ] Strava OAuth connect flow (app → server redirect, token exchange)
- [ ] Encrypted token storage + auto refresh
- [ ] Incremental activity pull with watermarking and dedup upsert
- [ ] Gear mapping from Strava
- [ ] `sync_logs` entries + basic backfill support (`--days N` style)

## M2.1 — iGPSPORT direct integration ✅ (server side)

*(Pulled ahead: rides sync straight from the iGPSPORT cloud, no Strava in
the loop. International accounts use plain JWT auth; CN accounts need the
web client's WASM signer and are rejected for now. See
[`igpsport.md`](igpsport.md).)*

- [x] Login + encrypted token storage + silent re-auth on JWT expiry
- [x] Paginated activity discovery with "stop at known pages" watermarking
- [x] Per-ride FIT download → decode → full stream series into
      `activity_data_points` + scalars derived from records
- [x] User-level dedup against other providers (provenance in
      `activity_sources`)
- [x] `sync_logs` OK/PARTIAL/ERROR with per-ride failure detail
- [x] Protocol mapping unit tests (`apps/server/tests/igpsport-normalize.test.ts`)
- [ ] Real-account E2E verification (needs a live iGPSPORT account)
- [ ] CN-region support (requires executing the WASM request signer) — only
      if a CN user shows up

## M3 — Garmin Connect integration ▶ (server side, scraping path built)

*(Unofficial SSO-scraping API — see `docs/garmin.md`. Long-term: replace with
the official Garmin Connect Developer Program "Personal" tier OAuth once an
application is approved; the auth half is a swap-in.)*

- [x] Garmin auth: 3-strategy SSO chain (mobile iOS / embed widget / portal
      web), CAS ticket → DI OAuth2 token exchange, refresh grant, anti-WAF
      delays, token verification against the API tier
- [x] MFA-aware connect (202 PENDING_MFA + `POST /connections/:id/mfa {code}`)
- [x] Activity list paging + FIT download → normalize to domain model
- [ ] Live E2E against a real account (needs a real Garmin login to run)
- [ ] Weight / body composition ingest (Garmin Index or any scale synced to
      Garmin)
- [ ] Blood pressure ingest
- [ ] E2E dedup testing against Strava-originated duplicates

## M4 — Omron scale integration ✅ (server side)

Target scale: **Omron KRD-703T** via the OMRON Connect cloud API (protocol
mapped by observing the official app; [omramin][omramin] used as a reference
for protocol facts only — see [`omron.md`](omron.md) for the working notes).

- [x] Omron auth + token refresh (region-dependent server endpoints; API v1
      regional registry in `providers/omron/regions.ts`)
- [x] Weigh-in ingest — **full fidelity, not the standard 7 fields**: weight,
      BMI, body fat %, skeletal muscle % + mass, subcutaneous fat %, fat
      mass, fat-free mass, impedance, resting metabolism, metabolic age,
      visceral fat level, and the segmental arms/trunk/legs breakdown
      (via `raw` + `segments`, per the data model)
- [x] BP monitor ingest (incl. mean arterial pressure + quality flags)
- [x] Region config validated for the user's account country
- [x] Unit tests for the value-code mapping (`apps/server/tests/`)
- [ ] Real-account E2E verification (needs a live Omron account)
- [ ] Mobile connection UI (M5 scope)

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
