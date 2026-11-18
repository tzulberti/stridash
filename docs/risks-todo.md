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

> **Status 2026-11-18:** S1–S4 landed (with tests); **D1 is the only P0 left**.
> Note for S3: existing sessions holding the old JWT refresh tokens must log in
> once — those tokens are intentionally no longer accepted.

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

### [ ] S5. User enumeration — **Low/Medium**

**Where:** `apps/server/src/routes/auth.ts:73` (unknown email skips scrypt),
`:56` (`409 Email already registered`).

**Problem:** identical messages (good) but the timing difference reveals
whether an email exists; registration confirms it outright.

**Fix:** compare against a dummy scrypt hash when no identity is found; make
register's response generic (or send a verification email — but that is a
product decision).

**Acceptance:** unknown/wrong-password timings are statistically similar.

---

## P1 — remaining security

### [ ] S6. Provider credentials & key management — **Medium**

**Where:** `apps/server/src/providers/igpsport/client.ts` (password stored as
`refreshTokenEnc`), `crypto.ts:47-48,52-60` (fixed KDF salt, `v1` ciphertext),
`apps/server/.env.example` / README (no TLS requirement stated).

**Problems / tasks:**

- [ ] iGPSPORT account passwords are stored reversibly (required by the API);
      document the blast radius and prefer a separate encryption key for
      provider credentials.
- [ ] Ciphertext has no key id → rotation needs a `v2:<keyId>:…` scheme and a
      re-encrypt migration.
- [ ] Derive the key once at startup (see S2), with a random per-deployment
      salt instead of the fixed `'stridash-connections'`.
- [ ] Document "TLS-terminating reverse proxy required"; add HSTS at the proxy.
      Mobile defaults to `http://localhost:3000` — warn in dev docs.

### [ ] S7. Sync endpoints can be abused / race — **Medium**

**Where:** `apps/server/src/routes/connections.ts:688` (`POST /:id/sync`),
`services/*-sync.ts` (`ensureClient`/`ensureGarminTokens`).

**Problems / tasks:**

- [ ] Reject non-`ACTIVE` connections with 409 (currently a REVOKED/PENDING row
      starts a sync and fails with 502 after logging a sync row).
- [ ] Per-connection lock (`sync_started_at` / advisory lock) → concurrent
      syncs currently race token rotation (Garmin/Zwift refresh tokens rotate)
      and can create duplicate rows.
- [ ] Move sync out of the request path: a queue/worker with progress polling.
      Garmin can run for minutes (2–20 s WAF delays × pages) and Node's default
      `requestTimeout` is 300 s.
- [ ] Throttle `POST /connections` retries — repeated bad provider logins can
      lock the user's Garmin/Zwift account.
- [ ] `GET /:id/syncs` is fine, but expose a "sync in progress" status.

**Acceptance:** two parallel sync calls → one 202/409, one run; REVOKED → 409.

### [ ] S8. Dependency CVEs + no audit gate — **Medium** (limited reachability)

**Where:** `apps/server/package.json` (`zod@^3.24.1`, resolves 3.25.76),
`apps/mobile` (expo transitives), CI workflow.

**Problem:** `npm audit` flags zod **high** (CVE-2023-54404, memory exhaustion
on uncapped array schemas). Only `chartChannelsSchema` uses an array and it is
`.max(32)`, so it is not directly reachable today — but zod 3 is affected
wholesale, and the real exposure is S4. Expo pulls high-severity transitives.

**Tasks:**

- [ ] Add `npm audit --omit=dev --audit-level=high` to CI (allow-list known
      Expo dev-chain noise explicitly).
- [ ] Plan the zod 4 migration (`valibot`/`standard-schema` alternative is fine,
      but keep one validation lib).
- [ ] Revisit mobile Expo major upgrade separately.

### [ ] S9. Small hardening items — **Low**

- [ ] `verifyToken` returns true for 429/5xx (`providers/garmin/api.ts:50`) —
      a token that cannot sync gets stored. Treat only 2xx as valid.
- [ ] Omron `gunzipSync` has no output cap
      (`providers/omron/client.ts:200`) — pass `maxOutputLength`.
- [ ] Cookie jar (`providers/garmin/cookie-jar.ts`) does no public-suffix
      check; a `Domain=.com` cookie would match any `*.com` host. Restrict to
      the known Garmin hosts.
- [ ] `redact.ts` redacts by key name only; also scrub `Bearer …`/JWT-shaped
      substrings from free-text error messages.
- [ ] `onError` logs full error objects; ensure no request bodies/credentials
      can end up in them (add a logging test or a structured logger).

### [ ] S10. Web hardening — **Low/Medium**

- [ ] CSP + `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`
      (either in the static host or a small server that serves the build).
- [ ] `apps/web/src/App.tsx:27` touches `localStorage` at module scope — move
      behind a guard so tests/SSR don't depend on `window`.
- [ ] Add an explicit "log out" action that calls the new logout endpoint and
      clears both stores.

---

## P1 — data correctness

### [ ] D1. NULL-distance dedupe hole — **High**

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

### [ ] D2. Cross-provider dedupe uses exact equality — **Medium**

**Where:** the three `upsertActivity` implementations listed in D1.

**Problem:** provider clocks disagree (roadmap: 21 s / 1.9 m), so the same ride
is stored twice. `startTime` equality is also brittle across timezone
normalization.

**Fix:** tolerance window (same type + same day, start ±60 s, distance ±100 m),
plus a merge step for existing duplicates (keep one `activity`, move
`activity_sources`).

### [ ] D3. Measurement dedupe includes `connectionId` — **Medium**

**Where:** `schema.prisma:603` (`@@unique([connectionId, kind, measuredAt])`),
`services/omron-sync.ts:264`.

**Problem:** reconnecting Omron with a different `providerUserId` creates a
second connection → every weigh-in duplicates (the roadmap notes ~88 duplicate
weigh-ins from exactly this). Sleep/wellness correctly key on
`(userId, provider, dateKey)`.

**Fix:** migrate the key to `(userId, provider, kind, measuredAt)` and merge
existing duplicates; keep `connectionId` as provenance only.

### [ ] D4. Best-effort identity destabilizes the connection key — **Medium**

**Where:** `routes/connections.ts:203` (Omron), `:441` (Garmin), Zwift's
username fallback.

**Problem:** when the provider identity endpoint fails transiently, the
connection is keyed on email/username; a later success stores the display
name/athlete id, producing a **second connection row for the same account**
(and duplicate measurements/activities provenance).

**Fix:** never upsert on a best-effort identity. Look up by `(userId,
provider)` + stored config email/username and update that row, or mark the
connection PENDING until identity is resolved.

### [ ] D5. Invalid IDs → 500; double delete → 500; refresh after delete → 200 — **Medium**

**Where:** `routes/data.ts:277-292` (cursor), `:402` (`:id`),
`connections.ts:688` (`:id`), `data.ts:268` (`DELETE /me`),
`auth.ts:85` (refresh).

**Reproduced:** `GET /api/activities/not-a-uuid`, `?cursor=abc`, and
`POST /connections/abc/sync` all return 500. `DELETE /me` twice → 500.
Reproduced separately: refresh after deletion → 200 (also S3).

**Fix:** `z.string().uuid()` on all path/query ids, return 400/404; catch
Prisma `P2025` as 404; verify user existence in refresh.

### [ ] D6. Activity feed returns raw payloads — **Medium**

**Where:** `routes/data.ts:277` (`prisma.activity.findMany` with no `select`).

**Problem:** the list response includes `raw`, `detailRaw`, `notes`,
`hrZonesMin` for every row (verified key list). Zwift `detailRaw` is large —
50 rows can be megabytes per page and per refresh.

**Fix:** `select` the feed columns; keep the full row + series on
`/activities/:id`. Add an integration test asserting `raw`/`detailRaw` are
absent from the list.

---

## P2 — correctness & maintainability

### [ ] D7. Export is assembled fully in memory — **Low/Medium**

**Where:** `routes/data.ts:192-262`.

**Problem:** loads every activity (with raw JSON), measurement, sleep, wellness,
gear, device row, then `JSON.stringify`s. Fine for one year; OOM risk for
several. It also omits per-sample streams (documented, but M6 says "full
JSON dump").

**Fix:** stream NDJSON (one row per line, headers per entity) or paginate with
a resume token; decide whether streams are in scope.

### [ ] D8. `tokenExpiresAt` is not persisted after a Garmin refresh — **Low**

**Where:** `services/garmin-tokens.ts:51` (sets `null`; the comment says it is
refreshed "below right after", but nothing follows).

**Problem:** the column stays null; correctness is masked because
`maybeRefresh` re-parses the JWT. Misleading state and extra work.

**Fix:** set `new Date(peekJwtExpMs(next.diToken)!)` when persisting.

### [ ] D9. Sync loops are N+1; `activity_sources` lacks a connection index — **Low/Medium**

**Where:** `services/omron-sync.ts:264` (per-sample `findUnique` +
update/create), `schema.prisma:417-427` (no `@@index([connectionId])`).

**Problem:** every sync does a per-sample DB round-trip and a seq scan to build
the "known ids" set. Fine today, painful with years of data.

**Fix:** batch by unique key (`createMany` + one `findMany`), add the index
(and `@@index([connectionId, sourceActivityId])` if not covered by the D1
unique).

### [ ] C1. `apps/web/src/App.tsx` is ~4,000 lines — **Maintainability**

Routing, API client, every page, charts, and i18n wiring in one component.
Split into `routes/`, `components/`, `hooks/`, `lib/api.ts` **before** the
planned UI redesign.

### [ ] C2. Dedupe/upsert logic is copy-pasted three times — **Maintainability**

`garmin-sync.ts`, `igpsport-sync.ts`, `zwift-sync.ts` each carry their own
`upsertActivity`, series store, device backfill and edit-detection pass, with
small drifts. Extract a shared `services/activity-ingest.ts`; then D1/D2 are
one change, not three.

### [ ] C3. Duplicate `UserPreferences` declaration — **Trivial**

`packages/types/src/index.ts:43` and `:76`. TypeScript merges them, so it
compiles, but one is dead. Merge into one interface (include `chartChannels`).

### [ ] C4. `db.ts` bypasses validated env — **Low**

`apps/server/src/db.ts:12` reads `process.env.DATABASE_URL` directly, so an
invalid/missing URL fails at the first query instead of at startup. Import the
validated `env` (or a `loadEnv()` result) and fail fast.

### [ ] C5. Lint only covers mobile — **Low**

No root `eslint.config.*` exists, so the CI step named "ESLint" runs
`expo lint` only; server/web are unlinted. Add a root flat config (TS +
`@typescript-eslint`, no-floating-promises is worth it) and wire the
`lint` scripts for server/web.

### [ ] C6. Docs contradict the code — **Low**

- [ ] `docs/architecture.md`: claims a scheduler, rotating refresh tokens,
      rate limiting on auth/sync, generated OpenAPI, and a single RN-web app —
      none exist yet. Mark as target-state or implement.
- [ ] README status says "M1 in progress" while M2.1/M3/M4 are done; license
      says TBD while `package.json` says AGPL-3.0.
- [ ] Roadmap M6 lists data export as pending although `/api/export` exists
      (partial: no streams). Sync-now (M5) also exists.
- [ ] Add this file to the docs index/roadmap so it does not drift.

### [ ] C7. No background sync — **Feature gap (roadmap)**

`docs/architecture.md` promises a scheduler; today sync only runs on a button
press. This is the structural fix behind S7: a scheduler also enables token
refresh, retry/backoff and "new ride" notifications. Keep it out of the
request path.

### [ ] C8. No deployment artifact — **Ops**

Compose only runs Postgres. There is no server Dockerfile, no graceful
shutdown (`prisma.$disconnect`), no static serving for the web build, and no
reverse-proxy/TLS example. Needed before anyone can self-host.

### [ ] C9. `serializeRow` uses a `'toFixed' in v` heuristic — **Low**

`routes/data.ts:20-32` guesses Prisma `Decimal` by duck typing; any object with
`toFixed` becomes a number. Prefer `Prisma.Decimal.isDecimal(v)` or an explicit
column mapping.

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
5. **D1 + D2** (dedupe model, merge duplicates) — the riskiest; do it after
   C2 extraction so the change lands once.
6. **S6 + S7 + C7** (key management, sync lock/queue, scheduler).
7. **D3 + D4** (measurement key, connection identity) — migrations.
8. **D6 + D7** (feed select, streaming export).
9. **S8–S10, C1–C10** (hardening, lint, docs, deployment).

## Reproduction notes

```bash
npm run typecheck                       # all workspaces
npx vitest run --project unit           # apps/server, 79 tests
npm test -w @stridash/web               # 42 tests
npx vitest run --project integration    # apps/server, 50 tests (needs Docker)
npm audit --omit=dev                    # zod high + expo transitives
```

Probes that confirmed findings (recreate as real regression tests):

- login body contains `user.authIdentities[0].secretHash`
- `prisma.activity.create` twice with the same null-distance key succeeds
- `/api/activities/not-a-uuid` → 500; `?cursor=abc` → 500;
  `POST /api/connections/abc/sync` → 500
- `DELETE /api/me` then `POST /api/auth/refresh` → 200
- `GET /api/activities` items include `raw` and `detailRaw`
