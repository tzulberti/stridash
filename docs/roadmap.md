# Roadmap

Milestones are ordered so that each one is independently useful and
demoable. Status: ☐ planned · 🔨 in progress · ✅ done

## M1 — Monorepo skeleton ✅

- [x] npm workspaces layout (`apps/*`, `packages/*`)
- [x] Shared TypeScript config; Prettier configured; root ESLint covers
      server, web, shared types and mobile
- [x] `packages/types`: domain + API types from the [data model](data-model.md)
- [x] `apps/server`: Hono boilerplate, health endpoint, Prisma schema matching
      the data model, migrations, auth groundwork (register/login/refresh)
- [x] `apps/mobile`: Expo app boots on Android/iOS/web, renders API health
      from the local server
- [x] CI: format, lint, audit, typecheck, unit/web and integration tests on
      push/PR
- [x] Docker compose for local Postgres (port 5433)

## M2 — Strava integration 🔨 (server side built; live-account smoke test pending)

*(This is first integration-wise because it's an official API — the honest way
to prove the plumbing — and it silently delivers two other sources: Zwift and
iGPSPORT both push to Strava.)*

- [x] Strava OAuth connect flow (app → server redirect, token exchange)
- [x] Encrypted token storage + auto refresh
- [x] Incremental activity pull with watermarking and dedup upsert
- [x] Gear mapping from Strava
- [x] `sync_logs` entries + basic backfill support
      (`STRIDASH_STRAVA_BACKFILL_DAYS`, default 365)
- [ ] Live-account smoke test (needs a real Strava API application)

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
- [x] Physiology columns surfaced (2026-11): sweat loss, aerobic/anaerobic
      training effect + benefit messages, session VO2max, recovery time
      (minutes), normalized power — mapped from the Connect list row (which
      already carries them) and the FIT session, backfilled from stored raw
      payloads by migration `20261114030000_activity_physiology`; shown in
      the detail cards and the compare table — see `docs/garmin.md`
      "Physiology columns"
- [x] Live E2E against a real account (needs a real Garmin login to run)
- [x] Wellness ingest (2026-11): nightly sleep (stages, score, HRV, naps) +
      daily steps/floors/calories/HR/stress/body battery — see `docs/garmin.md`
- [x] Gear sync (2026-11): gear-service v2 → `gear` (type, usage counters,
      threshold, ACTIVE/RETIRED), per-activity gear attribution →
      `activities.gear_id` + bounded backfill pass, and Stridash-managed
      wear-item components (`gear_components`, replace-by-usage computed
      from linked activities) with `/api/gear` + a web gear page —
      see `docs/garmin.md` "Gear"
- [x] Weight / body composition ingest (Garmin Index or any scale synced to
      Garmin) — `services/garmin-measurements.ts`, grams→kg, 365-day first
      backfill / 7-day overlap, MEASUREMENTS sync log
- [x] Blood pressure ingest — same service, systolic/diastolic/pulse/notes
- [ ] Live-account smoke test for the weight/BP endpoints
- [x] Dedup merge of stored duplicates (2026-11-13 finding) — **ingest half
      landed 2026-11-18, merge pass 2026-11-20**: provider identity + tolerance
      matching (same type, start ±60 s, distance ±100 m) live in
      `services/activity-ingest.ts` under a per-user advisory lock, so new
      duplicates (including the "Zwift - Devedeset Lite" 21 s / 1.9 m case) no
      longer occur. `services/activity-merge.ts` collapses duplicates stored
      before the fix into one row carrying both `activity_sources` and both
      series; the operator runs `npm run data:merge-activities -w
      @stridash/server` (dry run) then `-- --apply`. Covers the
      Strava-originated case too. See [`data-model.md`](data-model.md)
      "Deduplication".
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
- [x] Clean up the ~88 duplicate weigh-ins the broken connection produced
      (2026-11 finding): migration `20261120150000_measurement_provider_identity`
      folds duplicates per `(user, provider, kind, measured_at)` keeping the
      most-populated then oldest row, and reconnect now updates the existing
      connection instead of creating a second identity. Operational follow-up:
      reconnect the KRD-703T and confirm the next sync.
- [ ] Register for the OMRON Connect Partner API (official OAuth2 + consent
      flow via [omron-connect-create.readme.io](https://omron-connect-create.readme.io);
      app registration, production approval) and retire the
      reverse-engineered app protocol it replaces
- [x] Mobile connection UI (M5 scope) — provider list, credential
      connect (Omron/iGPSPORT/Garmin/Zwift), Garmin MFA and Strava browser
      consent

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
      per-unit splits table (paired by unit index, Δ pace in seconds per unit,
      Δ elevation in meters) when both sides carry distance streams, and
      per-channel overlaid two-line charts (A green / B red; distance
      x-axis only when both series carry a distance stream) with hover
      tooltips reading both series; while a comparison is active the
      single-activity charts and the axis tabs hide (the overlaid charts
      replace them) and a "Remove comparison" button restores them
- [x] Onboarding: create user → connect providers → first sync (UI) —
      register form, provider connect page, sync-now queue
- [x] Connections screen with "sync now" buttons + `sync_logs` error surfacing —
      sync-now queue, status pills and the latest PARTIAL/ERROR log line per
      connection
- [x] Manual entry UI — weight/body-fat and blood-pressure quick-add on the
      dashboard (`POST /api/measurements`, provider MANUAL)
- [ ] Mobile (Expo) app UI — dashboards phone-sized (login/register,
      secure session, dashboard cards, recent activities, provider
      connect/MFA/Strava consent, sync and quick-add landed; visual redesign
      remains)
- [x] General overview dashboard: one aggregated home view beyond today's
      stat cards — training-load trend, steps/sleep/body-battery/weight
      trends, gear wear status and connection/sync health (2026-11 request)
- [ ] UI redesign pass over the web app — layout, navigation, visual design,
      responsive on small screens (2026-11 request; scope to be defined)
- [x] Edit detection beyond Garmin: Zwift's detail payload carries
      `lastSaveDate` — same poll-and-compare pattern as Garmin's
      `lastUpdateDate` pass ([`zwift.md`](zwift.md) "Edit detection");
      iGPSPORT has no per-ride edit signal (FIT re-download is the only
      option). Deletion detection (an activity removed at the provider) is
      still undetected for every provider.

**Progress 2026-11-27:** the mobile Expo app now has login/register, secure
token storage (`expo-secure-store`, localStorage on web), a phone-sized
dashboard (latest weight/body fat/sleep/steps/resting HR, activity and
connection counts), pull-to-refresh, recent activities, provider connection
forms (Omron/iGPSPORT/Garmin/Zwift + Garmin MFA + Strava browser consent),
sync-now and weigh-in/blood-pressure quick-add. The web app also got a
responsive pass (narrow header/cards, wrapping forms, horizontal table scroll,
phone breakpoints); the larger visual-design pass remains.

## M6 — Extras ☐

- [x] Manual entry: weight / BP quick-add from the app — web dashboard form +
      mobile dashboard quick-add (`POST /api/measurements`, provider MANUAL)
- [x] Full JSON account export — streamed, includes per-sample activity series
      (2026-11-22)
- [x] CSV export (user owns their data) — streaming
      `/api/export/csv?type=activities|measurements|sleep|wellness`
      plus Settings-page download buttons
- [ ] Direct BLE pairing to the Omron scale on mobile (bypass cloud)
- [x] Production Docker Compose: single API + web image, Postgres volume,
      Caddy TLS, migrations on startup
- [ ] Multi-user hardening, push notifications ("new ride synced")
- [x] OpenAPI 3.1 spec — `/api/openapi.json` served at runtime and
      `docs/openapi.json` generated by `npm run openapi:generate -w
      @stridash/server`; covers auth, connections, activities, measurements,
      wellness, gear, account and exports
- [x] Generated typed client contract — `packages/types/src/openapi.ts`
      generated with `npm run openapi:client`, exported from
      `@stridash/types` for web/mobile/MCP; runtime calls stay as thin
      fetch wrappers
- [ ] Garadget-style webhooks/poll for near-real-time sync where APIs allow
- [x] Write `docs/provider-tos-risk.md` — the per-provider terms-of-service
      risk profile audited 2026-11: **Zwift** §5.a explicitly prohibits
      unofficial API clients (reverse engineering, scraping, "applications
      that interact with our Platform without prior written authorization")
      and reserves shadow-ban/disregard-ride-data/termination at sole
      discretion — no official API exists, risk accepted for a read-only
      personal sync; **Garmin/iGPSPORT/Omron** all violate their terms via
      the unofficial paths but have official alternatives, tracked above
      (M3 / M2.1 / M4). Practical exposure is account-flagging, not legal:
      own-account, read-only, self-hosted.

## M7 — MCP server ✅

*(Expose Stridash to LLM clients over the Model Context Protocol (2026-11
request): an assistant connects with the user's own token and can answer
"how far did I run this month?", "what's my resting-HR trend?", "when do my
shoes retire?" from the synced data.)*

- [x] MCP server package (`apps/mcp`): stdio transport for local clients +
      stateless Streamable HTTP for remote clients (`MCP_TRANSPORT=http`)
- [x] Tool surface, read-only and single-user-scoped: activity search /
      detail / compare, weigh-ins + blood pressure, sleep + daily wellness,
      gear wear, connection & sync status
- [x] Auth: long-lived per-user API token (the browser JWT session doesn't
      fit MCP clients) — `POST/GET /api/tokens`, revoke via
      `DELETE /api/tokens/:id`, hashed at rest; see `docs/api-tokens.md`
- [x] MCP tools call the same REST API, so they inherit the same ownership,
      dedup and service-layer behaviour as the web/mobile clients
