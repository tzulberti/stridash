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
- [ ] Apply for official OpenAPI access and swap the reverse-engineered JWT
      client over (OAuth2; email `global@igpsport.com` per
      [igpsport.com/support/app/openapi](https://www.igpsport.com/support/app/openapi) —
      Intervals.icu went this route). ToU §5.2 forbids reverse engineering,
      so the current client is a terms violation the official path removes.

## M3 — Garmin Connect integration ▶ (server side, scraping path built)

*(Unofficial SSO-scraping API — see `docs/garmin.md`. Long-term: replace with
the official **Garmin Personal API** — launched ~2026-10, personal use without
a business application: create a key on Garmin Connect Web, exchange it for a
24h bearer at `personalapitoken-service/personal-api/personal-api-key/token`,
no refresh token (re-exchange on expiry). The auth half is a swap-in.)*

- [x] Garmin auth: 3-strategy SSO chain (mobile iOS / embed widget / portal
      web), CAS ticket → DI OAuth2 token exchange, refresh grant, anti-WAF
      delays, token verification against the API tier
- [x] MFA-aware connect (202 PENDING_MFA + `POST /connections/:id/mfa {code}`)
- [x] Activity list paging + FIT download → normalize to domain model
- [x] Full-fidelity FIT ingest (2026-11): running dynamics channels
      (vertical oscillation, stance time, vertical ratio, step length),
      respiration + stamina, session physiology (VO2max, training effect,
      normalized power, training load, recovery) in `raw.session`,
      source-reported HR zones; verified live (200/200 activities,
      ~579k samples) — see `docs/garmin.md` FIT fidelity notes
- [x] Live E2E against a real account (needs a real Garmin login to run)
- [x] Wellness ingest (2026-11): nightly sleep (stages, score, HRV, naps) +
      daily steps/floors/calories/HR/stress/body battery — see `docs/garmin.md`
- [x] Gear sync (2026-11): gear-service v2 → `gear` (type, usage counters,
      threshold, ACTIVE/RETIRED), per-activity gear attribution →
      `activities.gear_id` + bounded backfill pass, and Stridash-managed
      wear-item components (`gear_components`, replace-by-usage computed
      from linked activities) with `/api/gear` + a web gear page —
      see `docs/garmin.md` "Gear"
- [ ] Weight / body composition ingest (Garmin Index or any scale synced to
      Garmin)
- [ ] Blood pressure ingest
- [ ] Dedup hardening + merge of stored duplicates (2026-11-13 finding):
      the cross-provider key is exact equality on
      `(start_time, type, distance_m)`, and provider clocks disagree —
      "Zwift - Devedeset Lite" stored twice (Garmin FIT start 10:40:51 /
      11537.84 m vs Zwift session start 10:40:30.082 / 11539.70 m — 21 s /
      1.9 m apart). Loosen ingest matching to a tolerance window (same
      type + day, start within ~60 s, distance within ~100 m) and merge
      existing duplicates into one row carrying both `activity_sources`
      (see [`data-model.md`](data-model.md) "Deduplication"); covers the
      Strava-originated duplicates case too.
- [ ] Migrate auth to the official Garmin Personal API (removes the
      unofficial-SSO gray zone: key → 24h token exchange, no refresh —
      re-exchange; same activity/health read surface. Key expiry
      30/90/180/365 days per the key chosen)

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
- [ ] Register for the OMRON Connect Partner API (official OAuth2 + consent
      flow via [omron-connect-create.readme.io](https://omron-connect-create.readme.io);
      app registration, production approval) and retire the
      reverse-engineered app protocol it replaces
- [ ] Mobile connection UI (M5 scope)

## M5 — App dashboard ▶ (web dashboard — first cut)

- [x] `apps/web` — Vite + React + TS dashboard (dev proxy `/api` → Hono on
      :3000; production served beside the API, same origin)
- [x] Login page (JWT, stored per browser session)
- [x] Stat cards: latest weight / body fat / visceral fat / muscle mass,
      activity + weigh-in counts
- [x] Body-composition trend chart (pure SVG, no chart deps): weight, fat %,
      visceral, muscle % — switchable metric tabs, all real weigh-ins
- [x] Activity feed table (type, distance, time, speed, HR, power) with
      drill-down: per-activity detail cards + HR / power / speed / cadence /
      altitude series charts (new `GET /api/activities/:id` endpoint)
- [x] Connections status pills (provider · status · last sync)
- [x] Activity comparison (2026-11-13): `GET /api/activities/:id/similar`
      suggests same-type activities within ±25% distance (±40% duration when
      the base has no distance), newest-first, 20 max; the activity page gains
      a Compare section — picker, side-by-side stat table with signed deltas,
      and per-channel overlaid two-line charts (A green / B red; distance
      x-axis only when both series carry a distance stream)
- [ ] Onboarding: create user → connect providers → first sync (UI)
- [ ] Connections screen with "sync now" buttons + `sync_logs` error surfacing
- [ ] Manual entry UI
- [ ] Mobile (Expo) app UI — dashboards phone-sized
- [x] Edit detection beyond Garmin: Zwift's detail payload carries
      `lastSaveDate` — same poll-and-compare pattern as Garmin's
      `lastUpdateDate` pass ([`zwift.md`](zwift.md) "Edit detection");
      iGPSPORT has no per-ride edit signal (FIT re-download is the only
      option). Deletion detection (an activity removed at the provider) is
      still undetected for every provider.

## M6 — Extras ☐

- [ ] Manual entry: weight / BP quick-add from the app
- [ ] Data export (CSV / full JSON dump of your data — user owns it)
- [ ] Direct BLE pairing to the Omron scale on mobile (bypass cloud)
- [ ] Multi-user hardening, push notifications ("new ride synced")
- [ ] Garadget-style webhooks/poll for near-real-time sync where APIs allow
- [ ] Write `docs/provider-tos-risk.md` — the per-provider terms-of-service
      risk profile audited 2026-11: **Zwift** §5.a explicitly prohibits
      unofficial API clients (reverse engineering, scraping, "applications
      that interact with our Platform without prior written authorization")
      and reserves shadow-ban/disregard-ride-data/termination at sole
      discretion — no official API exists, risk accepted for a read-only
      personal sync; **Garmin/iGPSPORT/Omron** all violate their terms via
      the unofficial paths but have official alternatives, tracked above
      (M3 / M2.1 / M4). Practical exposure is account-flagging, not legal:
      own-account, read-only, self-hosted.
