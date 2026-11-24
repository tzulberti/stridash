# Risks & TODO

Static + dynamic review of the codebase at commit `f2a258d` (2026-11-18).
Everything below was observed in the code or reproduced against the real app
(testcontainers Postgres); nothing here is speculative unless marked.

**How the review was done**

- Read: `apps/server/src/**`, `apps/web/src/App.tsx`, `packages/types/src`,
  `apps/server/prisma/schema.prisma`, `docs/**`, CI workflow.
- Ran: `npm run typecheck` ✅, server unit tests 79 ✅, web tests 42 ✅,
  integration tests 50 ✅ (real migrations + Postgres).
- Probed four suspicions in a throwaway integration test (deleted): login
  response contents, NULL-distance duplicate insert, invalid-UUID handling,
  and refresh-after-account-deletion. Results are quoted per item.
- `npm audit --omit=dev` findings are noted under S8.

Legend: **P0** fix before exposing the server, **P1** next, **P2** hardening /
maintainability. Check the box when the fix (and its test) has landed.

| Priority | Items                 |
| -------- | --------------------- |
| P0       | S1, S2, S3, S4, D1    |
| P1       | S5, S6, S7, D2–D6     |
| P2       | S8–S10, D7–D9, C1–C10 |

> **Status 2026-11-18:** S1–S4 and D1 landed (with tests); **no P0 items remain**.
> D2's ingest half landed with D1 — its one-time merge/backfill of already-stored
> duplicates is still open. Note for S3: existing sessions holding the old JWT
> refresh tokens must log in once — those tokens are intentionally no longer
> accepted. Test-only follow-ups from the post-landing review are tracked as
> **T1–T22** at the end of this file.
>
> **Status 2026-11-20:** S5 login timing, S6 key management, S7 (queue/worker),
> S8 (audit gate + zod 4), S9 and S10 landed with tests. D2–D6 also landed with
> tests; **no P1 items remain**. S5 registration enumeration is **explicitly
> accepted** (documented and separately rate-limited); email verification is
> the trigger to close it fully. D2's operator merge script still needs to be
> run against deployments that already hold pre-fix duplicate activities.
>
> **Status 2026-11-22:** C8 landed — the production Docker image, static web
> serving, Compose stack, and Caddy TLS example are in place and smoke-tested.
> D7 also landed: the account export now streams a complete JSON object,
> including per-sample series, with bounded memory.
>
> **Status 2026-11-23:** C9 (Prisma Decimal detection), C4 (validated
> `DATABASE_URL` before Prisma starts), C3 (single `UserPreferences` type) and
> C5 (root TypeScript ESLint for server/web/types) landed with tests/config
> updates.
>
> **Status 2026-11-24:** D9 batched the Omron measurement upsert (one lookup +
> `createMany` per device page), C6 reconciled README/architecture/roadmap
> with the shipped clients, queue, export and lint setup, C2 moved the
> provider series upsert into one shared helper, and T10–T15 closed the auth
> and body-bound test gaps.

---

## P0 — security

### [x] S1. Login response leaks the password hash — **High**

**Where:** `apps/server/src/routes/auth.ts:69` (`include: { authIdentities }`),
`:79` (`{ ...user, ...tokens }`).

**Problem:** Prisma returns the full relation, so the JSON body contains
`user.authIdentities[0].secretHash` (`scrypt:16384:8:1:…`). Reproduced against
the real app. `register` is safe because it does not `include` relations.

**Fix:** explicit `select` for the login/register user payload
(`id, email, displayName, heightCm, dateOfBirth, sex, createdAt`); never map
`AuthIdentity` into a response. Add a regression assertion
(`JSON.stringify(body)` does not contain `secretHash`).

**Acceptance:** integration test fails on the current code, passes after the
`select`.

**Landed 2026-11-18:** `publicUserSelect` in `routes/auth.ts`; login strips the
relation before serializing; integration test asserts neither `secretHash` nor
`authIdentities` appears in the response.

### [x] S2. Auth has no rate limiting and hashes synchronously — **High**

**Where:** `apps/server/src/index.ts` (no middleware), `crypto.ts:27,37`
(`scryptSync`), `crypto.ts:48` (`deriveKey` runs `scryptSync` per call).

**Problem:** `scryptSync` blocks the single Node thread (~50–100 ms per
attempt). With no limiter, anyone can brute-force passwords at full speed and
stall the whole API with a few concurrent `/auth/login` requests. Registration
is open, so burner accounts are free.

**Fix:**

- `bodyLimit` middleware globally (see S4).
- Per-IP and per-account rate limit on `register`, `login`, `refresh`
  (in-process sliding window is fine for a self-hosted single node; note the
  reverse-proxy alternative in docs).
- Async `scrypt` (promisified `node:crypto.scrypt`) or argon2.
- Derive the AES key once at startup and cache it.

**Acceptance:** a burst of N logins gets 429 without blocking `GET /api/health`;
login latency does not serialize concurrent requests.

**Landed 2026-11-18:** async `scrypt` + memoized AES key derivation
(`crypto.ts`), `FixedWindowLimiter` (`rate-limit.ts`) with per-IP and per-email
buckets, config in `env.ts`/`.env.example`. Unit tests cover the limiter;
integration tests cover 429 + `Retry-After`.

### [x] S3. Refresh tokens: stateless, 30 days, no revocation, localStorage — **High**

**Where:** `apps/server/src/auth.ts:45-72` (issue/refresh), `auth.ts:71`
(dead `hashRefreshToken`), `apps/web/src/App.tsx:27,43-44` (storage),
`apps/web/index.html` (no CSP).

**Problem:** "rotation" only mints a new pair; the old refresh token stays
valid for 30 days. `jti` is never stored. There is no `/auth/logout` and no
password change. Reproduced: after `DELETE /api/me`, `POST /auth/refresh`
returns **200** and keeps issuing tokens for the deleted user (endpoints then
404, but the credential should be dead). Tokens live in `localStorage`
("remember me"), so any XSS is a durable account takeover.

**Fix:**

- `refresh_tokens` table: `id, userId, tokenHash, expiresAt, revokedAt,
  replacedBy, createdAt, lastUsedAt`; rotate on every refresh and revoke the
  whole family on reuse (replay detection).
- `POST /auth/logout` (revoke current refresh token) and revoke-all.
- Verify the user still exists in `refreshAccess`.
- Add `DELETE /auth/sessions` for "log me out everywhere".
- Web: strict CSP (`default-src 'self'`, no inline script) and consider
  httpOnly cookies + CSRF token instead of `localStorage`.

**Acceptance:** reusing an old refresh token after rotation → 401 and revokes
the family; refresh after `DELETE /me` → 401; logout invalidates the token.

**Landed 2026-11-18:** `refresh_tokens` table + migration
(`20261118000000_refresh_tokens`), opaque `sdrt_…` tokens stored as SHA-256,
rotation with conditional update (concurrent-safe), replay revokes the family,
`POST /auth/logout`, FK cascade covers deleted accounts. Web `signOut` calls
logout with `keepalive`. **Note:** pre-existing refresh JWTs stop working —
users re-login once. CSP/httpOnly-cookie migration is still S10.

### [x] S4. Request bodies are unbounded — **Medium**

**Where:** all `await c.req.json()` calls (`routes/auth.ts`, `routes/data.ts`,
`routes/connections.ts`).

**Problem:** `@hono/node-server` does not cap body size, so a pre-auth
multi-hundred-MB POST is a cheap memory DoS. Provider identifier/password
schemas use `.min(1)` with no maximum.

**Fix:** `bodyLimit({ maxSize: 1 * 1024 * 1024 })` (smaller on auth), plus
`.max()` on all user-supplied provider fields and strings.

**Acceptance:** oversized body → 413 before parsing.

**Landed 2026-11-18:** global `bodyLimit` (1 MiB, `index.ts`) plus `.max()`
limits on credentials and provider identifiers/passwords. Integration test
posts a 2 MiB body and expects 413.

### [x] S5. User enumeration — **Low/Medium** (residual risk accepted)

**Where:** `apps/server/src/routes/auth.ts` (`/login` and `/register`).

**Problem:** identical messages (good) but the timing difference reveals
whether an email exists; registration confirms it outright.

**Fix:** compare against a dummy scrypt hash when no identity is found; make
register's response generic (or send a verification email — but that is a
product decision).

**Acceptance:** unknown/wrong-password timings are statistically similar.

**Landed 2026-11-19 (timing only):** login always runs one `verifyPassword`
against a warmed dummy scrypt hash when the email is unknown, so the two
failure paths do the same work. An integration test measures the medians and
guards against a missing scrypt (ratio stays far from 1 ms vs 40 ms). Register
still returns `409 Email already registered` — closing that requires the
product decision above (generic `2xx` + verification email, or a deliberate
acceptance of the enumeration).

**Decision 2026-11-20 — accepted, not silently “fixed”:** registration keeps
the explicit `409`. A generic `2xx` would not close the hole without email
verification: an attacker can immediately try the password they just supplied;
a fresh account logs in, while an existing account with a different password
does not. That still leaks existence, while making legitimate sign-ups
confusing. Mail delivery, verification tokens and a verified-login gate are a
product feature, not a safe emergency change.

**Compensating controls:**

- the shared per-IP auth bucket (`STRIDASH_AUTH_RATE_LIMIT`, 30/15 min), plus
  a narrower registration bucket (`STRIDASH_REGISTER_RATE_LIMIT`, 10/15 min);
- login timing equalization against a warmed dummy scrypt hash;
- one generic login error for unknown email and wrong password;
- scrypt password hashes, no email addresses in logs, and the existing body
  limits.

**Residual risk:** an attacker can learn whether one specific email has an
account — one bit per throttled probe. No credential, session or user data is
exposed. This is accepted for the current self-hosted, invite-scale product.

**Revisit trigger:** when verification email / password-reset infrastructure
exists, switch registration to a generic `202`, send a single-use link, and
gate login on verification; only then is the enumeration actually closed.

---

## P1 — remaining security

### [x] S6. Provider credentials & key management — **Medium**

**Where:** `apps/server/src/providers/igpsport/client.ts` (password stored as
`refreshTokenEnc`), `crypto.ts:47-48,52-60` (fixed KDF salt, `v1` ciphertext),
`apps/server/.env.example` / README (no TLS requirement stated).

**Problems / tasks:**

- [x] iGPSPORT account passwords are stored reversibly (required by the API);
      document the blast radius and prefer a separate encryption key for
      provider credentials.
- [x] Ciphertext has no key id → rotation needs a `v2:<keyId>:…` scheme and a
      re-encrypt migration.
- [x] Derive the key once at startup (see S2), with a random per-deployment
      salt instead of the fixed `'stridash-connections'`.
- [x] Document "TLS-terminating reverse proxy required"; add HSTS at the proxy.
      Mobile defaults to `http://localhost:3000` — warn in dev docs.

**Landed 2026-11-19:** `v2:<keyId>:<salt>:<iv>:<tag>:<ct>` ciphertext embeds
the key id and KDF salt; `v1` rows still decrypt with `STRIDASH_ENC_KEY` and
the legacy salt. New writes prefer `STRIDASH_PROVIDER_ENC_KEY` (so once rows
are re-encrypted a leaked app key no longer exposes iGPSPORT passwords);
`STRIDASH_ENC_OLD_KEYS` supports rotation, and
`npm run crypto:reencrypt -w @stridash/server` re-writes rows
(with `--dry-run`). `docs/deployment.md` documents TLS, HSTS and the rotation
sequence. Crypto tests cover v1→v2 compatibility, provider/app key separation,
salt changes, retirement keys and tamper rejection.

### [x] S7. Sync endpoints can be abused / race — **Medium**

**Where:** `apps/server/src/routes/connections.ts:688` (`POST /:id/sync`),
`services/*-sync.ts` (`ensureClient`/`ensureGarminTokens`).

**Problems / tasks:**

- [x] Reject non-`ACTIVE` connections with 409 (currently a REVOKED/PENDING row
      starts a sync and fails with 502 after logging a sync row).
- [x] Per-connection lock (`sync_started_at` / advisory lock) → concurrent
      syncs currently race token rotation (Garmin/Zwift refresh tokens rotate)
      and can create duplicate rows.
- [x] Move sync out of the request path: a queue/worker with progress polling.
      Garmin can run for minutes (2–20 s WAF delays × pages) and Node's default
      `requestTimeout` is 300 s.
- [x] Throttle `POST /connections` retries — repeated bad provider logins can
      lock the user's Garmin/Zwift account.
- [x] `GET /:id/syncs` is fine, but expose a "sync in progress" status.

**Acceptance:** two parallel sync calls → one 202/409, one run; REVOKED → 409.

**Landed 2026-11-19 (queue):** `POST /:id/sync` still claims
`connections.sync_started_at` atomically (15-minute stale takeover), then
enqueues an in-process worker and answers **202** `{ status: 'queued',
inProgress: true, syncStartedAt }`. The worker re-checks `ACTIVE`, dispatches
the provider sync (Garmin activities + non-fatal wellness), marks rejected
credentials `ERROR`, and releases only the claim it owns. `GET /:id/syncs`
remains the polling endpoint and now also returns `connectionStatus`; the web
dashboard polls it until `inProgress` clears and derives the summary from the
new `sync_logs` rows. Startup clears stale locks and marks interrupted logs
`ERROR`; SIGINT/SIGTERM drain in-flight jobs for up to 30 s. Integration tests
cover 202 + eventual completion, one 202 + one 409 for parallel calls, lock
release, credential rejection, unknown failures, and stale-lock recovery.

**Earlier landing:** `connections.sync_started_at` is claimed atomically before
dispatch and non-`ACTIVE` rows answer 409 before any provider call.
`GET /:id/syncs` returns `inProgress` + `syncStartedAt`. Connection creation is
limited per user (`STRIDASH_CONNECTION_RATE_LIMIT`, default 10/15 min).
Integration tests cover REVOKED → 409 and the create-route 429.

### [x] S8. Dependency CVEs + no audit gate — **Medium** (limited reachability)

**Where:** `apps/server/package.json` (`zod@^3.24.1`, resolves 3.25.76),
`apps/mobile` (expo transitives), CI workflow.

**Problem:** `npm audit` flags zod **high** (CVE-2023-54404, memory exhaustion
on uncapped array schemas). Only `chartChannelsSchema` uses an array and it is
`.max(32)`, so it is not directly reachable today — but zod 3 is affected
wholesale, and the real exposure is S4. Expo pulls high-severity transitives.

**Tasks:**

- [x] Add `npm audit --omit=dev --audit-level=high` to CI (allow-list known
      Expo dev-chain noise explicitly).
- [x] Plan the zod 4 migration (`valibot`/`standard-schema` alternative is fine,
      but keep one validation lib).
- [x] Revisit mobile Expo major upgrade separately — **closed 2026-11-21**:
      the latest published Expo is 58.0.26 and it is already installed;
      `npx expo install --fix` aligned the SDK 58 package ranges (including
      `expo-web-browser` 58.1.0) and `npx expo install --check` reports up to
      date. `glob`/`minimatch` now report moderate only (below the gate); no
      newer Expo major exists to move to.

**Landed 2026-11-19:** `zod` is now 4.6.7 (one validation library; env,
auth, data and connection schemas unchanged and all tests pass).
`npm run audit:ci` runs `npm audit --omit=dev --json` and fails on
high/critical advisories unless `scripts/audit-allowlist.json` has a justified
entry; the known Expo CLI `glob`/`minimatch` findings are explicitly listed.
CI runs the gate before the static checks. `--omit=dev` now reports no
high/critical findings apart from the Prisma CLI chain below (moderate
Expo/hono entries remain below the gate). The mobile Expo SDK 58 package
alignment landed 2026-11-21; it was not a major-version move because 58.0.26 is
the latest published release.

**2026-11-20:** the registry later flagged Prisma’s CLI chain
(`effect` ← `@prisma/config` ← `prisma`) as **high** (Effect ReDoS). Prisma
7.10.1 pins `effect@3.20.0` and offers no compatible 7.x fix, and the running
API never imports that CLI/config path — so the three findings are explicitly
allow-listed until the Prisma 8 upgrade. `npm run audit:ci` still fails on any
new high/critical advisory outside the allow-list.

### [x] S9. Small hardening items — **Low**

- [x] `verifyToken` returns true for 429/5xx (`providers/garmin/api.ts:50`) —
      a token that cannot sync gets stored. Treat only 2xx as valid.
- [x] Omron `gunzipSync` has no output cap
      (`providers/omron/client.ts:200`) — pass `maxOutputLength`.
- [x] Cookie jar (`providers/garmin/cookie-jar.ts`) does no public-suffix
      check; a `Domain=.com` cookie would match any `*.com` host. Restrict to
      the known Garmin hosts.
- [x] `redact.ts` redacts by key name only; also scrub `Bearer …`/JWT-shaped
      substrings from free-text error messages.
- [x] `onError` logs full error objects; ensure no request bodies/credentials
      can end up in them (add a logging test or a structured logger).

**Landed 2026-11-19:** `verifyToken` accepts only 2xx; Omron decompression is
capped at 20 MiB; the cookie jar accepts only `garmin.com`/`*.garmin.com`
domains (and filters restored lists); `redactText`/`safeErrorForLog` scrub
Bearer/JWT values from messages, stacks and nested details (used by
`onError`, resync, wellness and the four sync-failure writers); `verifyToken`,
cookie-jar, redaction and gzip-bomb unit tests added.

### [x] S10. Web hardening — **Low/Medium**

- [x] CSP + `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`
      (either in the static host or a small server that serves the build).
- [x] `apps/web/src/App.tsx:27` touches `localStorage` at module scope — move
      behind a guard so tests/SSR don't depend on `window`.
- [x] Add an explicit "log out" action that calls the new logout endpoint and
      clears both stores.

**Landed 2026-11-19 (storage + logout):** token helpers moved to
`apps/web/src/lib/token-storage.ts` with guarded `window`/storage access and
unit tests (no-window, throwing storage, remember-me, store switching,
clearing). The logout action already revoked the refresh family and cleared
both stores; it now uses the shared helper too.

**Landed 2026-11-19 (headers):** `security-headers.ts` defines the production
CSP (`script-src 'self'`, no `unsafe-eval`, `frame-ancestors`/`object-src`
none, same-origin `connect-src`) plus `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy`. The Vite build
emits them as `dist/_headers` for Netlify/Cloudflare Pages, with unit tests;
`docs/deployment.md` includes the equivalent nginx config. `style-src` keeps
`'unsafe-inline'` only for React's inline chart-colour attributes.

---

## P1 — data correctness

### [x] D1. NULL-distance dedupe hole — **High**

**Where:** `apps/server/prisma/schema.prisma:388`
(`@@unique([userId, startTime, type, distanceM])`);
`services/garmin-sync.ts:576-581`, `zwift-sync.ts:129-134`,
`igpsport-sync.ts:385-390` (`distanceM: … ?? undefined`).

**Problem:** Postgres treats NULLs as distinct, and the app omits the distance
filter when it is null. Reproduced: inserting the same null-distance workout
twice succeeds. Duplicates are real (see the roadmap "Dedup hardening" entry,
which overlaps this item — close both together).

**Fix:** decide the canonical identity. Suggested:

- `activity_sources` unique `(connectionId, sourceActivityId)` (provider-side
  identity is the real key).
- A nullable-safe match in SQL (`COALESCE(distance_m, -1)` in the unique, or a
  partial unique index) plus tolerance matching for cross-provider rows
  (same type, start within ~60 s, distance within ~100 m).
- Replace `findFirst` + `create` with an upsert/transaction so concurrent
  syncs cannot both insert.

**Acceptance:** tests for (a) null distance twice, (b) two syncs in parallel,
(c) the roadmap's 21 s/1.9 m cross-provider case.

**Landed 2026-11-18:** `services/activity-ingest.ts` now owns the decision for
all three sync services: (1) provider identity via the new unique
`activity_sources (connection_id, source_activity_id)`, (2) a per-user
transaction-scoped Postgres advisory lock so find-then-create is race-free
across concurrent syncs and processes, and (3) tolerance matching (same type,
start ±60 s, distance ±100 m; null distance requires the exact start). Provider
identity also stops two of the same connection's activities from ever folding
together. Integration tests cover null-distance duplicates, parallel ingests,
the real 21 s/1.9 m Garmin/Zwift case, and the non-merge guards. Existing stored
duplicates are handled by the D2 operator merge pass (see below); a
nullable-safe unique expression index on `activities` is deferred until that
pass has run on every deployment. Test-only follow-ups: **T1–T9** in “Test
coverage gaps” below.

### [x] D2. Cross-provider dedupe uses exact equality — **Medium**

**Where:** the three `upsertActivity` implementations listed in D1.

**Problem:** provider clocks disagree (roadmap: 21 s / 1.9 m), so the same ride
is stored twice. `startTime` equality is also brittle across timezone
normalization.

**Fix:** tolerance window (same type + same day, start ±60 s, distance ±100 m),
plus a merge step for existing duplicates (keep one `activity`, move
`activity_sources`).

**Landed 2026-11-20:** the ingest-time tolerance matching shipped with D1
(shared `services/activity-ingest.ts`). Existing duplicates are collapsed by
`services/activity-merge.ts`, which keeps the canonical (earliest) row, moves
every `activity_sources` row onto it, keeps the richer series per provider and
deletes the duplicate. `npm run data:merge-activities -w @stridash/server`
defaults to a dry run; `--apply` mutates. Unit tests cover the window/null
cases, same-connection exclusion and the no-chain rule; the integration test
runs the pass with both Garmin and Zwift sources/series.

### [x] D3. Measurement dedupe includes `connectionId` — **Medium**

**Where:** `schema.prisma:603` (`@@unique([connectionId, kind, measuredAt])`),
`services/omron-sync.ts:264`.

**Problem:** reconnecting Omron with a different `providerUserId` creates a
second connection → every weigh-in duplicates (the roadmap notes ~88 duplicate
weigh-ins from exactly this). Sleep/wellness correctly key on
`(userId, provider, dateKey)`.

**Fix:** migrate the key to `(userId, provider, kind, measuredAt)` and merge
existing duplicates; keep `connectionId` as provenance only.

**Landed 2026-11-20:** migration `20261120150000_measurement_provider_identity`
adds `provider`, backfills it from the connection (`MANUAL` when null), folds
pre-existing duplicates keeping the most-populated then oldest row, and swaps
the unique key. `services/omron-sync.ts` writes `provider = 'OMRON'` and
upserts on the new key. An integration test proves a reconnect-style duplicate
with a different `connectionId` is rejected by the new identity.

### [x] D4. Best-effort identity destabilizes the connection key — **Medium**

**Where:** `routes/connections.ts:203` (Omron), `:441` (Garmin), Zwift's
username fallback.

**Problem:** when the provider identity endpoint fails transiently, the
connection is keyed on email/username; a later success stores the display
name/athlete id, producing a **second connection row for the same account**
(and duplicate measurements/activities provenance).

**Fix:** never upsert on a best-effort identity. Look up by `(userId,
provider)` + stored config email/username and update that row, or mark the
connection PENDING until identity is resolved.

**Landed 2026-11-20:** `services/connection-identity.ts` looks up an existing
connection by resolved provider id or the login saved in `config`
(`omron.identifier`, `garmin.email`, `zwift.username`, `igpsport.username`) and
updates it in place under a `connection:<user>:<provider>` advisory lock. All
connect paths use it, and Garmin now prefers the numeric `userId` over the
mutable display name. An integration test updates a fallback login row when the
resolved id later changes.

### [x] D5. Invalid IDs → 500; double delete → 500; refresh after delete → 200 — **Medium**

**Where:** `routes/data.ts:277-292` (cursor), `:402` (`:id`),
`connections.ts:688` (`:id`), `data.ts:268` (`DELETE /me`),
`auth.ts:85` (refresh).

**Reproduced:** `GET /api/activities/not-a-uuid`, `?cursor=abc`, and
`POST /connections/abc/sync` all return 500. `DELETE /me` twice → 500.
Reproduced separately: refresh after deletion → 200 (also S3).

**Fix:** `z.string().uuid()` on all path/query ids, return 400/404; catch
Prisma `P2025` as 404; verify user existence in refresh.

**Landed 2026-11-20:** `params.ts` validates every `:id` used by activity and
connection routes; the list cursor is a UUID too. `DELETE /me` maps Prisma
`P2025` to 404, and refresh already verifies the user still exists (S3).
Integration tests cover malformed ids/cursors and the second delete.

### [x] D6. Activity feed returns raw payloads — **Medium**

**Where:** `routes/data.ts:277` (`prisma.activity.findMany` with no `select`).

**Problem:** the list response includes `raw`, `detailRaw`, `notes`,
`hrZonesMin` for every row (verified key list). Zwift `detailRaw` is large —
50 rows can be megabytes per page and per refresh.

**Fix:** `select` the feed columns; keep the full row + series on
`/activities/:id`. Add an integration test asserting `raw`/`detailRaw` are
absent from the list.

**Landed 2026-11-20:** the list uses an explicit feed projection (no `raw`,
`detailRaw`, `notes` or `hrZonesMin`); the detail endpoint still returns the
full row plus series. The shared `Activity` type marks feed-omitted fields
optional, and the integration seed sets heavy fields before asserting they are
absent.

---

## P2 — correctness & maintainability

### [x] D7. Export is assembled fully in memory — **Low/Medium**

**Where:** `services/account-export.ts` (previously `routes/data.ts`).

**Problem:** loads every activity (with raw JSON), measurement, sleep, wellness,
gear, device row, then `JSON.stringify`s. Fine for one year; OOM risk for
several. It also omits per-sample streams (documented, but M6 says "full
JSON dump").

**Fix:** stream NDJSON (one row per line, headers per entity) or paginate with
a resume token; decide whether streams are in scope.

**Landed 2026-11-22:** `/api/export` keeps the existing downloadable
single-JSON-object contract, but writes it through a Web `ReadableStream` and
cursor-paginates every array (200 entities, 100 activities, 10 series per
page). Peak memory is one page instead of the whole account. Format
`stridash-export/2` adds `activityDataPoints` (the per-sample series, flat and
keyed by `activityId`) plus account `preferences` and `chartChannels`; token
columns, password hashes and refresh tokens are never selected. Integration
tests assert the new payload and export 205 measurements to cross the page
boundary.

### [x] D8. `tokenExpiresAt` is not persisted after a Garmin refresh — **Low**

**Where:** `services/garmin-tokens.ts:51` (sets `null`; the comment says it is
refreshed "below right after", but nothing follows).

**Problem:** the column stays null; correctness is masked because
`maybeRefresh` re-parses the JWT. Misleading state and extra work.

**Fix:** set `new Date(peekJwtExpMs(next.diToken)!)` when persisting.

**Landed 2026-11-21:** `ensureGarminTokens` now persists
`peekJwtExpMs(next.diToken)` as `tokenExpiresAt` and still stores `null` when
the refreshed token has no `exp` claim. Unit tests cover both branches.

### [x] D9. Sync loops are N+1; `activity_sources` lacks a connection index — **Low/Medium**

**Where:** `services/omron-sync.ts` (per-sample `findUnique` + update/create),
`schema.prisma` (ActivitySource indexes).

**Problem:** every sync did a per-sample DB round-trip and a seq scan to build
the "known ids" set. Fine today, painful with years of data.

**Fix:** batch by unique key (`createMany` + one `findMany`), add the index
(and `@@index([connectionId, sourceActivityId])` if not covered by the D1
unique).

**Landed 2026-11-23:** `syncDevice` normalizes and deduplicates the device page
in memory, then does one `findMany` for the page's measure keys and one
`createMany({ skipDuplicates: true })` for new rows. Only rows that actually
exist in the 1-day overlap window take an individual update. A unit test
asserts one lookup, one createMany, and the duplicate-in-response case. The D1
unique index on `(connection_id, source_activity_id)` already has
`connection_id` as its leading column, so an extra connection index would be
redundant.

### [ ] C1. `apps/web/src/App.tsx` is ~4,000 lines — **Maintainability**

Routing, API client, every page, charts, and i18n wiring in one component.
Split into `routes/`, `components/`, `hooks/`, `lib/api.ts` **before** the
planned UI redesign.

### [ ] C2. Dedupe/upsert logic is copy-pasted three times — **Maintainability**

`garmin-sync.ts`, `igpsport-sync.ts`, `zwift-sync.ts` each carry their own
`upsertActivity`, series store, device backfill and edit-detection pass, with
small drifts. Extract a shared `services/activity-ingest.ts`; then D1/D2 are
one change, not three.

**Progress 2026-11-24:** identity/dedup already lives in
`services/activity-ingest.ts`, and the five copied series upserts now go
through `services/activity-series.ts` (with a unit test). Provider-specific
scalar mapping, device-fill and edit-detection passes remain separate; they
carry different payload fields and timestamps, so they should only be merged
when a shared shape is genuinely stable.

### [x] C3. Duplicate `UserPreferences` declaration — **Trivial**

`packages/types/src/index.ts` declared `UserPreferences` twice. TypeScript
merged them, so it compiled, but one was dead. Merge into one interface
(include `chartChannels`).

**Landed 2026-11-23:** the dead declaration is gone; the single interface
keeps `units`, `theme`, `language` and the required per-provider
`chartChannels` map. Workspace typecheck passes.

### [x] C4. `db.ts` bypasses validated env — **Low**

`apps/server/src/db.ts` read `process.env.DATABASE_URL` directly, so an
invalid/missing URL failed at the first query instead of at startup. Import the
validated `env` (or a `loadEnv()` result) and fail fast.

**Landed 2026-11-23:** `env.ts` exposes `loadDatabaseUrl()`, which validates
the `DATABASE_URL` slice before the Prisma singleton is constructed. It is
intentionally narrower than `loadEnv()` so DB-only command-line scripts do not
need unrelated auth/encryption secrets. Unit tests cover valid, missing and
non-postgres URLs.

### [x] C5. Lint only covers mobile — **Low**

No root `eslint.config.*` existed, so the CI step named "ESLint" ran
`expo lint` only; server/web were unlinted. Add a root flat config (TS +
`@typescript-eslint`, no-floating-promises is worth it) and wire the
`lint` scripts for server/web.

**Landed 2026-11-23:** `eslint.config.mjs` lints server, web and shared types
with `typescript-eslint`; `no-floating-promises` is an error and
`no-misused-promises` ignores React event attributes (where async handlers are
normal). Server/web/types have `lint` scripts, and `tsconfig.eslint.json`
files include tests/configs in the typed program. `npm run lint` passes with
only mobile's two pre-existing `import/no-duplicates` warnings.

### [x] C6. Docs contradict the code — **Low**

- [x] `docs/architecture.md` now marks the scheduler and generated OpenAPI as
      planned, describes the separate Vite web dashboard and Expo mobile app,
      and no longer claims `react-native-web` powers web.
- [x] README status reflects the shipped server integrations/web dashboard;
      the license is AGPL-3.0-or-later, matching `package.json`.
- [x] Roadmap M6 separates the completed streamed JSON dump from pending CSV
      export; sync-now (M5) also exists.
- [x] This file is linked from the README docs index.

**Landed 2026-11-24:** README, architecture and roadmap were reconciled with
the implemented clients, queue, export and lint setup; the remaining target
state (scheduler, OpenAPI) is explicitly labelled and tracked as C7/C10.

### [ ] C7. No background sync — **Feature gap (roadmap)**

`docs/architecture.md` promises a scheduler; today sync only runs on a button
press. This is the structural fix behind S7: a scheduler also enables token
refresh, retry/backoff and "new ride" notifications. Keep it out of the
request path.

### [x] C8. No deployment artifact — **Ops**

Compose only runs Postgres. There is no server Dockerfile, no graceful
shutdown (`prisma.$disconnect`), no static serving for the web build, and no
reverse-proxy/TLS example. Needed before anyone can self-host.

**Landed 2026-11-22:** `Dockerfile` builds a non-root Node image from the
server + types + web workspaces, copies the generated Prisma client and Vite
build, and serves both `/api/*` and the SPA with the web security headers.
`deploy/docker-entrypoint.sh` applies `prisma migrate deploy` before startup;
the API already drains the sync queue and calls `prisma.$disconnect()` on
SIGINT/SIGTERM. `docker-compose.prod.yml` adds Postgres without a host port,
the app on an internal network, and Caddy for automatic HTTPS/HSTS. A
`deploy/.env.example` and the deployment guide cover the required secrets and
upgrade path. Static serving has unit coverage; a Postgres-backed image smoke
run verified migrations, health, SPA/assets, and the SIGTERM drain.

### [x] C9. `serializeRow` uses a `'toFixed' in v` heuristic — **Low**

`serialize.ts` guesses Prisma `Decimal` by duck typing; any object with
`toFixed` becomes a number. Prefer `Prisma.Decimal.isDecimal(v)` or an explicit
column mapping.

**Landed 2026-11-23:** the shared serializer now uses
`Prisma.Decimal.isDecimal(v)` and `toNumber()`. Unit tests cover Decimal/Date
conversion and assert an unrelated object with a `toFixed` method is preserved
unchanged.

### [ ] C10. OpenAPI is advertised but absent — **Feature gap**

`docs/architecture.md` says Hono middleware generates the spec. Either add
`@hono/zod-openapi` (schemas already exist) or remove the claim; the mobile app
and future MCP server both benefit from a generated client.

---

## Explicitly not a finding (so nobody re-reviews it)

- Auth is not missing: both `connectionRoutes` and `dataRoutes` mount
  `use('*', requireUserId)`; mounting them under `/api` is fine.
- No SQL injection: no raw SQL anywhere; all Prisma.
- No IDOR found: activities, measurements, gear, components, exports and
  connections all filter by `userId` (resync re-reads connections by source id
  — add a defensive `userId` filter there, but it is not exploitable).
- Token columns are excluded from every connection response and from export;
  the existing integration test covers that.
- Per-login cookie jars: no cross-user Garmin session bleed.
- Provider hosts are constants; no user-supplied URLs → no SSRF.
- React escapes all rendered provider data; no `dangerouslySetInnerHTML`.

## Suggested merge order

1. **S1** (one-line data leak, one test) — ship immediately.
2. **S2 + S4** (async scrypt, limiter, body limit) — one small middleware PR.
3. **S3** (refresh-token table, rotation, logout) — needs a migration.
4. **D5** (UUID validation + error semantics) — mechanical, testable.
5. ~~**D1 + D2 ingest matching**~~ — landed 2026-11-18; the D2 operator merge
   script landed 2026-11-20 and still needs a dry run/apply on deployments.
6. **S6 + S7 + C7** (key management, sync lock/queue, scheduler).
7. **D3 + D4** (measurement key, connection identity) — migrations.
8. **D6 + D7** (feed select, streaming export).
9. **S8–S10, C1–C10** (hardening, lint, docs, deployment).

## Test coverage gaps

The acceptance tests pass, but branch inspection and a coverage run found the
gaps below. None imply current production behavior is wrong — each is a
regression trap the suite would not catch today. Check the box when the test
lands.

### Recent changes — ingest / dedupe

- [x] **T1. Parallel race that only the advisory lock can prevent.** The
      current parallel test uses the same start + distance, so the
      `(user_id, start_time, type, distance_m)` unique constraint would also
      stop a duplicate; a lost lock in the tolerance or NULL path would still
      pass. Add two cases: (a) two connections with starts ±21 s and distances
      ±1.9 m; (b) two connections, both `distance_m = NULL`, exact same start.
      Both must produce one activity and two sources.
      (`apps/server/tests/integration/api.test.ts`)
- [x] **T2. Tolerance boundaries.** Exactly 60 s and 100 m must match; 61 s
      and 101 m must not. Pin both dimensions independently so the constants
      cannot drift silently.
- [x] **T3. Type and user isolation.** Same start/distance but a different
      `type`, and the same key under a different user, must stay separate.
- [x] **T4. NULL ↔ non-NULL exact start.** An existing NULL-distance row plus
      a non-NULL provider at the exact start merges (and vice versa); NULL at
      a non-exact start must not. Covers the enrichment `OR` branch.
- [x] **T5. Closest candidate wins.** With two matching candidates inside the
      window, the closest start is chosen; equal starts fall through to the
      closest distance. Covers the sort/tie-break branch.
- [x] **T6. `onMatch` gear/device fill.** Drive the shared service with an
      `onMatch` handler (or a mocked Garmin/iGPSPORT sync) and assert it fills
      only empty slots and never overwrites a value another provider or the
      user already set. The Garmin/iGPSPORT callbacks moved in the refactor
      and currently have no test.
- [x] **T7. Garmin/iGPSPORT create payload + series.** Mocked sync-service
      tests asserting the created scalars and the `activity_data_points` row
      after the refactor. Zwift has orchestration tests; Garmin/iGPSPORT do
      not.
- [x] **T8. `activity_sources` unique constraint.** A direct duplicate insert
      of `(connection_id, source_activity_id)` raises `P2002`.
- [x] **T9. Migration cleanup of duplicate provenance rows.** On a seeded DB
      that already contains duplicate `(connection_id, source_activity_id)`
      rows, apply the migrations up to `20261118120000`, then apply the new
      migration and assert the oldest activity keeps the source and the unique
      index exists. Needs a dedicated stepwise-migration harness — the normal
      setup applies everything to an empty DB, so this branch never runs.

**Landed 2026-11-21:** T1–T5 and T8 now have integration coverage in
`activity ingest dedupe` (parallel tolerance/NULL races, both tolerance
boundaries, type + user isolation, NULL ↔ non-NULL enrichment, closest
candidate selection, and the provider-source `P2002`). T6/T7 drive the
exported Garmin/iGPSPORT ingest helpers with a fake transaction, asserting the
created scalars, gear/device attribution, series provider + sample count, and
that `onMatch` fills only empty gear/device slots. T9 uses a separate throwaway
database, applies the migrations before `20261118120000`, seeds three
duplicate provenance rows, then applies that migration and verifies the oldest
activity keeps the source, the unique index exists, and a duplicate insert
raises `23505`.

### Recent changes — auth

- [x] **T10. Per-email limiter bucket + proxy key.** Trip the per-email limit
      (not just per-IP) and assert 429 + `Retry-After`. Also unit-test
      `clientKey` with `STRIDASH_TRUST_PROXY` on/off
      (`X-Forwarded-For` honored only when true).
- [x] **T11. Refresh expiry and concurrent rotation.** (a) Set `expiresAt` in
      the past and assert 401 + no new token; (b) fire two refreshes with the
      same token concurrently and assert exactly one succeeds, the loser gets
      401, and the family is not spuriously revoked.
- [x] **T12. Refresh tokens are hashed at rest.** After login/refresh, the raw
      `sdrt_…` value must not appear in `refresh_tokens` — only its SHA-256
      hash.
- [x] **T13. Register response hash leak.** Repeat the S1 assertion on
      `/api/auth/register`, not only `/api/auth/login`.
- [x] **T14. Logout idempotency.** Logout with an unknown or already-revoked
      token returns 200 and does not create or revoke anything unexpected.
- [x] **T15. Body cap and field bounds on the wider surface.** A >1 MiB body
      on a non-auth route returns 413; over-max email / password /
      display-name / provider fields return 400.

**Landed 2026-11-24:** T10–T15 now have integration coverage for the per-email
bucket across different IPs (with trusted `X-Forwarded-For`), `clientKey`
on/off, expired refresh tokens, concurrent rotation without family revoke,
hashed-at-rest refresh tokens, register response leakage, idempotent logout,
and the non-auth 413 / field-bound 400 cases.

### Tooling

- [ ] **T16. Coverage reporting and gate.** Add `@vitest/coverage-v8` plus a
      `test:coverage` script for server and web, exclude generated Prisma and
      i18n data from the reported totals, record a baseline, and add a CI gate
      that fails on regression (not a fixed high threshold). No reporter or
      gate exists today.

### Whole-codebase (measured 2026-11-18)

Measured with `vitest run --coverage` over the server unit + integration suites
and the web suite. Hand-written server `src/` is 42.1% lines / 41.1% functions;
branch percentages are inflated by files whose functions never execute, and the
raw totals include generated Prisma and i18n data — treat the numbers as
directional.

- [ ] **T17. Sync-service orchestration (Garmin, iGPSPORT, Omron, wellness).**
      Mock provider HTTP clients and assert the full loop: list/pagination and
      watermark, known-source skip, FIT/detail fetch failure → `PARTIAL`,
      series persistence, gear/device fill, and `SyncLog` counts/status.
      Current: `igpsport-sync.ts` 0%, `garmin-sync.ts` 2.1%,
      `garmin-wellness.ts` 1.7%, `omron-sync.ts` 10.5%,
      `garmin-tokens.ts` 10.5%.
- [ ] **T18. Connection/sync routes.** Cover `routes/connections.ts` (26.1%):
      auth/ownership, connect/disconnect, each provider's sync trigger,
      provider error → `PARTIAL` vs `ERROR`, duplicate/concurrent sync handling
      (S7), unknown ids, and response shapes.
- [ ] **T19. Provider client error paths.** Garmin SSO (9.3%), cookie jar
      (18.4%), Garmin API (26.2%), Zwift (24.7%), iGPSPORT (29.5%), Omron
      (34.6%): token refresh/rotation, 401/429/5xx, timeouts, malformed
      payloads, cookie persistence, and region fallback. This is the network
      boundary and the least-covered executable code.
- [ ] **T20. Web UI/component tests.** `App.tsx` is 3,206 lines at 0%;
      `main.tsx` is also 0%. Add a DOM test harness (React Testing Library +
      jsdom/happy-dom), extract testable components/hooks from the monolith
      (see C1), and cover auth, activity list/detail, settings, and
      loading/error/empty states. The 51.5% web total is almost all i18n
      dictionaries.
- [ ] **T21. Mobile tests.** The mobile app has no test runner or test files.
      Add vitest (or jest) for pure helpers first — theme, formatting, API
      client — then React Native Testing Library for the key screens.
- [ ] **T22. Redaction/privacy tests.** `redact.ts` is 40.7%. Cover
      case-insensitive token keys, nested objects/arrays, the depth limit,
      short vs long values, non-string values, and assert tokens never reach a
      sync log or client error response.

## Reproduction notes

```bash
npm run typecheck                       # all workspaces
npx vitest run --project unit           # apps/server, 91 tests
npm test -w @stridash/web               # 42 tests
npx vitest run --project integration    # apps/server, 62 tests (needs Docker)
npm audit --omit=dev                    # Prisma CLI highs are allow-listed
```

Probes that confirmed findings (recreate as real regression tests):

- login body contains `user.authIdentities[0].secretHash`
- `prisma.activity.create` twice with the same null-distance key succeeds
- `/api/activities/not-a-uuid` → 500; `?cursor=abc` → 500;
  `POST /api/connections/abc/sync` → 500
- `DELETE /api/me` then `POST /api/auth/refresh` → 200
- `GET /api/activities` items include `raw` and `detailRaw`
