/**
 * Integration-test bootstrap (testcontainers). ... (see setup.ts) — the dev
 * database and docker-compose db are never touched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// the sync service is the network boundary — mocked so the route/DB/persistence
// contract is testable without provider credentials
const { syncIgpSportConnection, resyncIgpSportActivity } = vi.hoisted(() => ({
  syncIgpSportConnection: vi.fn(),
  resyncIgpSportActivity: vi.fn(),
}));
vi.mock('../../src/services/igpsport-sync.js', () => ({
  syncIgpSportConnection,
  resyncIgpSportActivity,
}));

import { createApp } from '../../src/index.js';
import { prisma } from '../../src/db.js';
import { encryptToken } from '../../src/crypto.js';
import { hashRefreshToken } from '../../src/auth.js';
import { ingestActivity } from '../../src/services/activity-ingest.js';
import { recoverStaleSyncLocks, SYNC_STALE_MS } from '../../src/services/sync-queue.js';
import { upsertStableConnection } from '../../src/services/connection-identity.js';
import { mergeDuplicateActivities } from '../../src/services/activity-merge.js';
import { IgpSportError } from '../../src/providers/igpsport/client.js';
import type { ActivityType } from '../../src/generated/prisma/client.js';
import type { Env } from '../../src/env.js';

const env: Env = {
  DATABASE_URL: process.env.DATABASE_URL!,
  STRIDASH_JWT_SECRET: 'integration-test-jwt-secret-0123456789',
  STRIDASH_ENC_KEY: 'integration-test-enc-key-0123456789abc',
  PORT: 0,
  STRIDASH_VERSION: 'test',
  // the suite drives auth a lot; the dedicated limiter test builds its own app
  STRIDASH_AUTH_RATE_LIMIT: 1000,
  STRIDASH_AUTH_RATE_WINDOW_MS: 60_000,
  STRIDASH_REGISTER_RATE_LIMIT: 1000,
  STRIDASH_SYNC_INTERVAL_MS: 0,
  STRIDASH_SYNC_BATCH_SIZE: 10,
  STRIDASH_STRAVA_BACKFILL_DAYS: 365,
  STRIDASH_GARMIN_HEALTH_BACKFILL_DAYS: 365,
  STRIDASH_LOGIN_RATE_LIMIT: 1000,
  STRIDASH_CONNECTION_RATE_LIMIT: 1000,
  STRIDASH_CONNECTION_RATE_WINDOW_MS: 60_000,
  STRIDASH_TRUST_PROXY: false,
};
const app = createApp(env);

type Json = Record<string, unknown>;
const json = (r: Response): Promise<Json> => r.json() as Promise<Json>;
const authed = (token: string, extra: Record<string, unknown> = {}): RequestInit => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  ...extra,
});

/** Poll a DB/API condition; queued sync work is intentionally asynchronous. */
async function waitFor(
  condition: () => Promise<boolean>,
  message = 'condition',
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

// ─── Users (registered through the real API so hashes/tokens are genuine) ────

let aliceToken = '';
let bobToken = '';

beforeAll(async () => {
  for (const [email, name] of [
    ['alice@test.stridash', 'Alice'],
    ['bob@test.stridash', 'Bob'],
  ] as const) {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'integration-pass-1', displayName: name }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    (email.startsWith('alice') ? (v) => (aliceToken = v) : (v) => (bobToken = v))(
      body.accessToken as string,
    );
  }
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Public surface ──────────────────────────────────────────────────────────

describe('health', () => {
  it('reports ok with a boot timestamp', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ok');
    expect(new Date(body.startedAt as string).getTime()).toBeGreaterThan(0);
  });

  it('serves the OpenAPI document', async () => {
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.openapi).toBe('3.1.0');
    expect((body.paths as Json)['/api/measurements']).toBeTruthy();
    expect((body.paths as Json)['/api/export/csv']).toBeTruthy();
  });
});

describe('auth', () => {
  it('rejects short passwords with 400', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'short@test.stridash', password: 'tiny', displayName: 'S' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate registration with 409', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@test.stridash',
        password: 'integration-pass-1',
        displayName: 'Alice2',
      }),
    });
    expect(res.status).toBe(409);
  });

  it('answers identical 401s for unknown email and wrong password', async () => {
    const unknown = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.stridash', password: 'integration-pass-1' }),
    });
    const wrong = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@test.stridash', password: 'wrong-password-1' }),
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.text()).toBe(await wrong.text()); // no user enumeration
  });

  it('does comparable scrypt work for unknown emails and wrong passwords (S5)', async () => {
    const login = (email: string, password: string) =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    const time = async (email: string, password: string): Promise<number> => {
      const start = performance.now();
      const res = await login(email, password);
      expect(res.status).toBe(401);
      return performance.now() - start;
    };

    // warm the dummy hash + per-email limiter before measuring
    await time('nobody@test.stridash', 'integration-pass-1');
    await time('alice@test.stridash', 'wrong-password-1');

    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 5; i++) {
      unknown.push(await time('nobody@test.stridash', 'integration-pass-1'));
      wrong.push(await time('alice@test.stridash', 'wrong-password-1'));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const ratio = median(unknown) / median(wrong);

    // a missing scrypt on the unknown-email path would be ~1 ms vs ~40 ms
    expect(median(unknown)).toBeGreaterThan(10);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });

  it('logs in and refreshes', async () => {
    const login = await json(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@test.stridash', password: 'integration-pass-1' }),
      }),
    );
    expect(login.accessToken).toBeTruthy();

    const refresh = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(refresh.status).toBe(200);
    expect((await json(refresh)).accessToken).toBeTruthy();

    const bad = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'garbage' }),
    });
    expect(bad.status).toBe(401);
  });

  it('stores only the refresh-token hash (T12)', async () => {
    const login = await json(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@test.stridash', password: 'integration-pass-1' }),
      }),
    );
    const raw = login.refreshToken as string;
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'alice@test.stridash' },
      select: { id: true },
    });

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows.some((row) => row.tokenHash === hashRefreshToken(raw))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(raw);
  });

  it('rejects an expired refresh token without minting a replacement (T11a)', async () => {
    const login = await json(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@test.stridash', password: 'integration-pass-1' }),
      }),
    );
    const raw = login.refreshToken as string;
    const row = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(raw) },
    });
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: raw }),
    });
    expect(res.status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { familyId: row.familyId } })).toBe(1);
  });

  it('allows exactly one concurrent refresh of the same token (T11b)', async () => {
    const login = await json(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@test.stridash', password: 'integration-pass-1' }),
      }),
    );
    const raw = login.refreshToken as string;
    const attempt = () =>
      app.request('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: raw }),
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);
    expect([first.status, second.status].sort()).toEqual([200, 401]);

    // A concurrent loser must not be mistaken for a replay and revoke the
    // family the winner just rotated into.
    const winner = first.status === 200 ? first : second;
    const tokens = await json(winner);
    const follow = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    expect(follow.status).toBe(200);
  });

  it('never returns the password hash (S1)', async () => {
    const login = await json(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@test.stridash', password: 'integration-pass-1' }),
      }),
    );
    // the password hash used to ride along in user.authIdentities[0].secretHash
    expect(JSON.stringify(login)).not.toContain('secretHash');
    expect(JSON.stringify(login)).not.toContain('authIdentities');
    expect(login.user).toMatchObject({ email: 'alice@test.stridash' });
  });

  it('never returns the password hash on register (S1/T13)', async () => {
    const reg = await json(
      await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `register-leak-${randomUUID()}@test.stridash`,
          password: 'integration-pass-1',
          displayName: 'Register Leak',
        }),
      }),
    );

    expect(JSON.stringify(reg)).not.toContain('secretHash');
    expect(JSON.stringify(reg)).not.toContain('authIdentities');
    expect(reg.user).toMatchObject({ displayName: 'Register Leak' });
  });

  it('rotates refresh tokens and revokes the family on replay (S3)', async () => {
    const login = await json(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@test.stridash', password: 'integration-pass-1' }),
      }),
    );
    const firstToken = login.refreshToken as string;

    const rotatedRes = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: firstToken }),
    });
    expect(rotatedRes.status).toBe(200);
    const rotated = await json(rotatedRes);
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(firstToken);

    // replaying the consumed token is treated as theft…
    const replay = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: firstToken }),
    });
    expect(replay.status).toBe(401);

    // …and kills the rotated token too (whole family).
    const family = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rotated.refreshToken }),
    });
    expect(family.status).toBe(401);
  });

  it('logout revokes the refresh-token family (S3)', async () => {
    const login = await json(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'bob@test.stridash', password: 'integration-pass-1' }),
      }),
    );

    const logout = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(logout.status).toBe(200);

    const refresh = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(refresh.status).toBe(401);

    // Logout is idempotent and an unknown token is not an oracle.
    const again = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    expect(again.status).toBe(200);
    const unknown = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'sdrt_unknown-token' }),
    });
    expect(unknown.status).toBe(200);
  });

  it('rejects refresh tokens of a deleted account (S3)', async () => {
    const reg = await json(
      await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'deleted@test.stridash',
          password: 'deleted-pass-1',
          displayName: 'Deleted',
        }),
      }),
    );

    const del = await app.request('/api/me', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${reg.accessToken}` },
    });
    expect(del.status).toBe(200);

    const again = await app.request('/api/me', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${reg.accessToken}` },
    });
    expect(again.status).toBe(404);

    const refresh = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: reg.refreshToken }),
    });
    expect(refresh.status).toBe(401);
  });

  it('rate-limits repeated auth attempts (S2)', async () => {
    const limited = createApp({
      ...env,
      STRIDASH_AUTH_RATE_LIMIT: 2,
      STRIDASH_LOGIN_RATE_LIMIT: 100,
    });
    const attempt = () =>
      limited.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@test.stridash', password: 'wrong-pass-1' }),
      });

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('rate-limits repeated registration attempts (S5)', async () => {
    const limited = createApp({
      ...env,
      STRIDASH_AUTH_RATE_LIMIT: 100,
      STRIDASH_REGISTER_RATE_LIMIT: 2,
    });
    const suffix = Date.now();
    const attempt = (n: number) =>
      limited.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `probe-${suffix}-${n}@test.stridash`,
          password: 'integration-pass-1',
          displayName: `Probe ${n}`,
        }),
      });

    expect((await attempt(1)).status).toBe(201);
    expect((await attempt(2)).status).toBe(201);
    const blocked = await attempt(3);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('caps password guesses per email even across IPs (T10)', async () => {
    const limited = createApp({
      ...env,
      STRIDASH_AUTH_RATE_LIMIT: 1000,
      STRIDASH_LOGIN_RATE_LIMIT: 2,
      STRIDASH_TRUST_PROXY: true,
    });
    const email = `limiter-${randomUUID()}@test.stridash`;
    const attempt = (ip: string) =>
      limited.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email, password: 'wrong-pass-1' }),
      });

    expect((await attempt('203.0.113.1')).status).toBe(401);
    expect((await attempt('203.0.113.2')).status).toBe(401);
    const blocked = await attempt('203.0.113.3');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('rejects malformed ids and cursors with 400 (D5)', async () => {
    expect((await app.request('/api/activities/not-a-uuid', authed(aliceToken))).status).toBe(400);
    expect((await app.request('/api/activities?cursor=abc', authed(aliceToken))).status).toBe(400);
    expect(
      (await app.request('/api/activities/not-a-uuid/similar', authed(aliceToken))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/connections/not-a-uuid/sync',
          authed(aliceToken, { method: 'POST' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request('/api/connections/not-a-uuid/syncs', authed(aliceToken))).status,
    ).toBe(400);
  });

  it('rejects oversized request bodies (S4)', async () => {
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'huge@test.stridash',
        password: 'x'.repeat(2 * 1024 * 1024),
        displayName: 'Huge',
      }),
    });
    expect(res.status).toBe(413);
  });

  it('caps bodies and bounds on the wider surface (T15)', async () => {
    // The body cap runs before auth/routing, so even an unauthenticated API
    // request is rejected without parsing megabytes of JSON.
    const huge = await app.request('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'OMRON', identifier: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(huge.status).toBe(413);

    const register = (body: Record<string, unknown>) =>
      app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const valid = { password: 'integration-pass-1', displayName: 'Bounds' };
    expect((await register({ ...valid, email: `${'a'.repeat(250)}@x.test` })).status).toBe(400);
    expect(
      (
        await register({
          ...valid,
          email: `bounds-${randomUUID()}@test.stridash`,
          password: 'x'.repeat(1025),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await register({
          ...valid,
          email: `bounds-${randomUUID()}@test.stridash`,
          displayName: 'x'.repeat(81),
        })
      ).status,
    ).toBe(400);

    const provider = await app.request('/api/connections', {
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify({ provider: 'OMRON', identifier: 'x'.repeat(321), password: 'y' }),
    });
    expect(provider.status).toBe(400);
  });

  it('guards the authenticated surface', async () => {
    expect((await app.request('/api/activities')).status).toBe(401);
    expect((await app.request('/api/activities', authed('not-a-jwt'))).status).toBe(401);
    expect((await app.request('/api/activities', authed(aliceToken))).status).toBe(200);
  });
});

// ─── Activities: filtering, provenance, ownership ────────────────────────────

let garminConnId = '';
let zwiftConnId = '';
let runId = '';
let virtualId = '';

describe('activities list', () => {
  beforeAll(async () => {
    // Alice: a GARMIN run + a ZWIFT virtual ride; Bob has his own activity
    const garmin = await prisma.connection.create({
      data: {
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } }))
          .id,
        provider: 'GARMIN',
        providerUserId: 'garmin-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('garmin-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    garminConnId = garmin.id;
    const zwift = await prisma.connection.create({
      data: {
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } }))
          .id,
        provider: 'ZWIFT',
        providerUserId: 'athlete-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('zwift-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    zwiftConnId = zwift.id;

    const mk = (
      userId: string,
      headline: string,
      type: string,
      startTime: Date,
      distanceM: number,
      provider: string,
    ) =>
      prisma.activity.create({
        data: {
          userId,
          headline,
          type: type as never,
          startTime,
          durationS: 1800,
          distanceM,
          indoor: provider === 'ZWIFT',
          raw: { provider, sourceRow: {} },
          detailRaw: { provider, detail: true },
          notes: 'private note',
          hrZonesMin: [1, 2, 3],
        },
      });

    const aliceId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } })
    ).id;
    const run = await mk(
      aliceId,
      'Morning run',
      'RUN',
      new Date('2026-11-01T07:00:00Z'),
      5_100,
      'GARMIN',
    );
    runId = run.id;
    await prisma.activitySource.create({
      data: {
        activityId: run.id,
        connectionId: garminConnId,
        sourceActivityId: 'garmin-ext-1',
        sourceUpdatedAt: new Date(),
      },
    });
    const virtual = await mk(
      aliceId,
      'Zwift - Half an Hour of Relaxation',
      'VIRTUAL_RIDE',
      new Date('2026-11-05T18:00:00Z'),
      22_400,
      'ZWIFT',
    );
    virtualId = virtual.id;
    await prisma.activitySource.create({
      data: {
        activityId: virtual.id,
        connectionId: zwiftConnId,
        sourceActivityId: '9007199254740999',
        sourceUpdatedAt: new Date(),
      },
    });
    // Bob's own ride — must never leak into Alice's queries
    const bob = await prisma.user.findUniqueOrThrow({ where: { email: 'bob@test.stridash' } });
    await prisma.activity.create({
      data: {
        userId: bob.id,
        headline: 'Bob ride',
        type: 'RIDE',
        startTime: new Date('2026-11-02T10:00:00Z'),
        durationS: 600,
        distanceM: 3_000,
      },
    });
  }, 30_000);

  it('lists own activities newest-first with provider provenance', async () => {
    const res = await app.request('/api/activities', authed(aliceToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    const items = body.items as Json[];
    expect(items).toHaveLength(2);
    expect(items[0].headline).toBe('Zwift - Half an Hour of Relaxation');
    expect(items[0].workoutName).toBeNull(); // legacy seeded row — column not set
    expect(items[1].providers).toEqual(['GARMIN']);
    // D6: the feed omits raw/detail payloads, notes and HR-zone arrays
    for (const item of items) {
      expect(item).not.toHaveProperty('raw');
      expect(item).not.toHaveProperty('detailRaw');
      expect(item).not.toHaveProperty('notes');
      expect(item).not.toHaveProperty('hrZonesMin');
    }
    // tokens never appear anywhere in the payload
    expect(JSON.stringify(body)).not.toContain('garmin-access');
  });

  it('filters by ISO date range', async () => {
    const res = await app.request(
      '/api/activities?from=2026-11-04T00:00:00.000Z&to=2026-11-06T00:00:00.000Z',
      authed(aliceToken),
    );
    const items = (await json(res)).items as Json[];
    expect(items).toHaveLength(1);
    expect(items[0].providers).toEqual(['ZWIFT']);
  });

  it('paginates with the cursor', async () => {
    const page1 = await json(await app.request('/api/activities?limit=1', authed(aliceToken)));
    expect(page1.items as Json[]).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await json(
      await app.request(`/api/activities?limit=1&cursor=${page1.nextCursor}`, authed(aliceToken)),
    );
    const ids = [...(page1.items as Json[]), ...(page2.items as Json[])].map((i) => i.id);
    expect(ids).toContain(runId);
    expect(ids).toContain(virtualId);
  });

  it("404s another user's activity", async () => {
    const own = await json(await app.request(`/api/activities/${runId}`, authed(aliceToken)));
    expect(own.items).toHaveLength(1);
    const foreign = await app.request(`/api/activities/${runId}`, authed(bobToken));
    expect(foreign.status).toBe(404);
  });

  it('accepts a bad query with 400', async () => {
    const res = await app.request('/api/activities?from=not-a-date', authed(aliceToken));
    expect(res.status).toBe(400);
  });

  it('serves the physiology columns through the detail endpoint', async () => {
    // the ingest writes these from the Connect list row + FIT session; any
    // value set must round-trip the API unchanged (verified live 2026-11-14
    // against the backfill of the same numbers)
    await prisma.activity.update({
      where: { id: runId },
      data: {
        sweatLossMl: 389,
        aerobicTe: 3.6,
        anaerobicTe: 1.2,
        aerobicTeMessage: 'IMPROVING_LACTATE_THRESHOLD_12',
        anaerobicTeMessage: 'MINOR_ANAEROBIC_BENEFIT_15',
        vo2max: 49.36,
        recoveryMinutes: 1584,
        normalizedPowerW: 400,
      },
    });
    const body = await json(await app.request(`/api/activities/${runId}`, authed(aliceToken)));
    const a = (body.items as Json[])[0];
    expect(a.sweatLossMl).toBe(389);
    expect(a.aerobicTe).toBeCloseTo(3.6, 5);
    expect(a.anaerobicTe).toBeCloseTo(1.2, 5);
    expect(a.aerobicTeMessage).toBe('IMPROVING_LACTATE_THRESHOLD_12');
    expect(a.anaerobicTeMessage).toBe('MINOR_ANAEROBIC_BENEFIT_15');
    expect(a.vo2max).toBeCloseTo(49.36, 2);
    expect(a.recoveryMinutes).toBe(1584);
    expect(a.normalizedPowerW).toBe(400);
    // D6: the detail endpoint keeps the full row the feed omits
    expect(a.raw).toBeTruthy();
    expect(a.detailRaw).toBeTruthy();
    expect(a.notes).toBe('private note');
    expect(a.hrZonesMin).toEqual([1, 2, 3]);
  });
});

// ─── Activity re-sync (force one activity through its owning provider) ───────

let igpsConnId = '';
let igpsRideId = '';
let revokedRideId = '';
let orphanId = '';
let stravaId = '';

describe('activity re-sync', () => {
  beforeEach(() => {
    // each test asserts call counts independently of the others
    resyncIgpSportActivity.mockClear();
  });

  beforeAll(async () => {
    const aliceId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } })
    ).id;

    // happy-path fixture: IGPSPORT-owned ride on an ACTIVE connection (the
    // provider service itself is mocked at the top of this file)
    const igps = await prisma.connection.create({
      data: {
        userId: aliceId,
        provider: 'IGPSPORT',
        providerUserId: 'resync-igps-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('resync-igps-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    igpsConnId = igps.id;
    const ride = await prisma.activity.create({
      data: {
        userId: aliceId,
        headline: 'Outdoor Cycling',
        type: 'RIDE',
        startTime: new Date('2026-11-06T08:00:00Z'),
        durationS: 4_949,
        distanceM: 36_502,
        raw: { provider: 'IGPSPORT', sourceRow: {} },
      },
    });
    igpsRideId = ride.id;
    await prisma.activitySource.create({
      data: {
        activityId: ride.id,
        connectionId: igps.id,
        sourceActivityId: '93430537',
        sourceUpdatedAt: new Date(),
      },
    });

    // ride whose only source sits on a REVOKED connection
    const revoked = await prisma.connection.create({
      data: {
        userId: aliceId,
        provider: 'IGPSPORT',
        providerUserId: 'resync-igps-2',
        status: 'REVOKED',
        accessTokenEnc: encryptToken('resync-igps-revoked', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    const stale = await prisma.activity.create({
      data: {
        userId: aliceId,
        headline: 'Old ride',
        type: 'RIDE',
        startTime: new Date('2026-11-07T08:00:00Z'),
        durationS: 600,
        distanceM: 10_000,
        raw: { provider: 'IGPSPORT', sourceRow: {} },
      },
    });
    revokedRideId = stale.id;
    await prisma.activitySource.create({
      data: {
        activityId: stale.id,
        connectionId: revoked.id,
        sourceActivityId: '111',
        sourceUpdatedAt: new Date(),
      },
    });

    // owned by a provider but no provenance row survives → nothing to sync
    const orphan = await prisma.activity.create({
      data: {
        userId: aliceId,
        headline: 'Sourceless row',
        type: 'RIDE',
        startTime: new Date('2026-11-08T08:00:00Z'),
        durationS: 600,
        distanceM: 10_000,
        raw: { provider: 'IGPSPORT', sourceRow: {} },
      },
    });
    orphanId = orphan.id;

    // STRAVA has no sync path yet (the connections route answers 501 too)
    const strava = await prisma.connection.create({
      data: {
        userId: aliceId,
        provider: 'STRAVA',
        providerUserId: 'strava-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('strava-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    const stravaRun = await prisma.activity.create({
      data: {
        userId: aliceId,
        headline: 'Strava run',
        type: 'RUN',
        startTime: new Date('2026-11-09T08:00:00Z'),
        durationS: 600,
        distanceM: 10_000,
        raw: { provider: 'STRAVA', sourceRow: {} },
      },
    });
    stravaId = stravaRun.id;
    await prisma.activitySource.create({
      data: {
        activityId: stravaRun.id,
        connectionId: strava.id,
        sourceActivityId: 'strava-ext-1',
        sourceUpdatedAt: new Date(),
      },
    });
  }, 30_000);

  it('re-syncs through the owning provider and reports per-provider outcome', async () => {
    resyncIgpSportActivity.mockResolvedValueOnce(undefined);
    const res = await app.request(`/api/activities/${igpsRideId}/resync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.results).toEqual([{ provider: 'IGPSPORT', status: 'ok' }]);
    expect(resyncIgpSportActivity).toHaveBeenCalledTimes(1);
    const [envArg, connArg, activityArg, sourceArg] = resyncIgpSportActivity.mock.calls[0];
    expect(envArg).toBe(env);
    expect(connArg).toMatchObject({ id: igpsConnId, provider: 'IGPSPORT', status: 'ACTIVE' });
    expect(activityArg).toBe(igpsRideId);
    expect(sourceArg).toBe('93430537');
  });

  it('answers 404 for another user’s activity', async () => {
    const res = await app.request(`/api/activities/${igpsRideId}/resync`, {
      method: 'POST',
      ...authed(bobToken, { method: 'POST' }),
    });
    expect(res.status).toBe(404);
    expect(resyncIgpSportActivity).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown activity', async () => {
    const res = await app.request('/api/activities/00000000-0000-0000-0000-000000000000/resync', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(404);
  });

  it('answers 409 when the only source connection is revoked', async () => {
    const res = await app.request(`/api/activities/${revokedRideId}/resync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain('IGPSPORT');
  });

  it('answers 409 when no provenance row survives', async () => {
    const res = await app.request(`/api/activities/${orphanId}/resync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(409);
  });

  it('answers 501 for providers without a sync path', async () => {
    const res = await app.request(`/api/activities/${stravaId}/resync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(501);
  });

  it('exposes delivering providers on the detail response', async () => {
    const body = await json(await app.request(`/api/activities/${runId}`, authed(aliceToken)));
    const a = (body.items as Json[])[0];
    expect(a.providers).toEqual(['GARMIN']);
  });
});

// ─── Activity merge pass (D2) ────────────────────────────────────────────────

describe('activity merge pass', () => {
  it('merges a tolerance-matched duplicate and keeps both sources/series (D2)', async () => {
    const user = await prisma.user.create({
      data: { email: `merge-${randomUUID()}@test.stridash`, displayName: 'Merge Test' },
    });
    const garmin = await prisma.connection.create({
      data: {
        userId: user.id,
        provider: 'GARMIN',
        providerUserId: `garmin-${randomUUID()}`,
        status: 'ACTIVE',
      },
    });
    const zwift = await prisma.connection.create({
      data: {
        userId: user.id,
        provider: 'ZWIFT',
        providerUserId: `zwift-${randomUUID()}`,
        status: 'ACTIVE',
      },
    });

    const canonical = await prisma.activity.create({
      data: {
        userId: user.id,
        headline: 'Morning ride',
        type: 'RIDE',
        startTime: new Date('2025-03-01T10:00:00Z'),
        durationS: 3600,
        distanceM: 30_000,
      },
    });
    const duplicate = await prisma.activity.create({
      data: {
        userId: user.id,
        headline: 'Morning ride',
        type: 'RIDE',
        startTime: new Date('2025-03-01T10:00:21Z'),
        durationS: 3600,
        distanceM: 30_001.9,
        gearId: null,
      },
    });
    await prisma.activitySource.createMany({
      data: [
        {
          activityId: canonical.id,
          connectionId: garmin.id,
          sourceActivityId: 'garmin-merge-1',
          sourceUpdatedAt: new Date(),
        },
        {
          activityId: duplicate.id,
          connectionId: zwift.id,
          sourceActivityId: 'zwift-merge-1',
          sourceUpdatedAt: new Date(),
        },
      ],
    });
    await prisma.activityDataPoint.create({
      data: {
        activityId: canonical.id,
        provider: 'GARMIN',
        sampleCount: 50,
        series: { timeMs: [0, 1000] },
      },
    });
    await prisma.activityDataPoint.create({
      data: {
        activityId: duplicate.id,
        provider: 'ZWIFT',
        sampleCount: 80,
        series: { timeMs: [0, 1000, 2000] },
      },
    });

    const dry = await mergeDuplicateActivities({ userId: user.id, dryRun: true });
    expect(dry.groups).toHaveLength(1);
    expect(await prisma.activity.count({ where: { userId: user.id } })).toBe(2);

    const applied = await mergeDuplicateActivities({ userId: user.id });
    expect(applied.mergedActivities).toBe(1);
    expect(applied.movedSources).toBe(1);
    expect(applied.movedSeries).toBe(1);

    const remaining = await prisma.activity.findMany({
      where: { userId: user.id },
      include: { sources: true, dataPoints: true },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(canonical.id);
    expect(remaining[0]!.sources).toHaveLength(2);
    expect(remaining[0]!.dataPoints.map((point) => point.provider).sort()).toEqual([
      'GARMIN',
      'ZWIFT',
    ]);
  });
});

// ─── Stable connection identity (D4) ─────────────────────────────────────────

describe('connection identity', () => {
  it('updates the fallback login row when the provider id resolves later (D4)', async () => {
    const alice = await prisma.user.findUniqueOrThrow({
      where: { email: 'alice@test.stridash' },
    });
    const email = `stable-${randomUUID()}@test.stridash`;
    const fallback = await prisma.connection.create({
      data: {
        userId: alice.id,
        provider: 'GARMIN',
        providerUserId: email,
        status: 'ACTIVE',
        config: { garmin: { email } },
      },
    });

    const updated = await upsertStableConnection({
      userId: alice.id,
      provider: 'GARMIN',
      providerUserId: 'athlete-123',
      login: email,
      configKey: 'garmin',
      loginField: 'email',
      create: { status: 'ACTIVE', config: { garmin: { email } } as never },
      update: { status: 'ACTIVE', config: { garmin: { email } } as never },
      select: { id: true, providerUserId: true, config: true, status: true },
    });

    expect(updated.id).toBe(fallback.id);
    expect(updated.providerUserId).toBe('athlete-123');

    const rows = await prisma.connection.findMany({
      where: { userId: alice.id, provider: 'GARMIN' },
      select: { id: true, config: true },
    });
    const sameLogin = rows.filter(
      (row) => (row.config as { garmin?: { email?: string } })?.garmin?.email === email,
    );
    expect(sameLogin).toHaveLength(1);
    expect(sameLogin[0]!.id).toBe(fallback.id);
  });
});

// ─── Measurement identity (D3) ───────────────────────────────────────────────

describe('measurement identity', () => {
  it('dedupes per user+provider+kind+time across Omron reconnects (D3)', async () => {
    const alice = await prisma.user.findUniqueOrThrow({
      where: { email: 'alice@test.stridash' },
    });
    const base = { userId: alice.id, provider: 'OMRON' as const, status: 'ACTIVE' as const };
    const firstConn = await prisma.connection.create({
      data: { ...base, providerUserId: `omron-old-${randomUUID()}` },
    });
    const secondConn = await prisma.connection.create({
      data: { ...base, providerUserId: `omron-new-${randomUUID()}` },
    });
    const measuredAt = new Date('2025-01-02T07:30:00Z');

    const first = await prisma.measurement.create({
      data: {
        userId: alice.id,
        connectionId: firstConn.id,
        provider: 'OMRON',
        kind: 'WEIGH_IN',
        measuredAt,
        weightKg: 70,
      },
    });

    // same physical reading via the reconnected account: same new key
    await expect(
      prisma.measurement.create({
        data: {
          userId: alice.id,
          connectionId: secondConn.id,
          provider: 'OMRON',
          kind: 'WEIGH_IN',
          measuredAt,
          weightKg: 70,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const found = await prisma.measurement.findUnique({
      where: {
        userId_provider_kind_measuredAt: {
          userId: alice.id,
          provider: 'OMRON',
          kind: 'WEIGH_IN',
          measuredAt,
        },
      },
    });
    expect(found?.id).toBe(first.id);
  });
});

// ─── Chart preferences (per-provider activity chart list) ────────────────────

describe('chart preferences', () => {
  it('stores an ordered per-provider list and serves it through /me', async () => {
    const channels = [
      { key: 'hrBpm', visible: true },
      { key: 'speedMs', visible: false },
      { key: 'powerW', visible: true },
    ];
    const put = await app.request('/api/preferences/charts/GARMIN', {
      method: 'PUT',
      ...authed(aliceToken, { method: 'PUT' }),
      body: JSON.stringify({ channels }),
    });
    expect(put.status).toBe(200);
    expect((await json(put)).chartChannels).toEqual({ GARMIN: channels });

    const me = await json(await app.request('/api/me', authed(aliceToken)));
    const prefs = me.preferences as Json;
    expect(prefs.chartChannels).toEqual({ GARMIN: channels });
  });

  it('replaces the list wholesale (reorder + toggle persist)', async () => {
    const first = await app.request('/api/preferences/charts/ZWIFT', {
      method: 'PUT',
      ...authed(aliceToken, { method: 'PUT' }),
      body: JSON.stringify({
        channels: [
          { key: 'powerW', visible: true },
          { key: 'hrBpm', visible: true },
          { key: 'speedMs', visible: true },
        ],
      }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/api/preferences/charts/ZWIFT', {
      method: 'PUT',
      ...authed(aliceToken, { method: 'PUT' }),
      body: JSON.stringify({
        channels: [
          { key: 'altitudeM', visible: false },
          { key: 'powerW', visible: true },
        ],
      }),
    });
    expect(second.status).toBe(200);
    const me = await json(await app.request('/api/me', authed(aliceToken)));
    expect((me.preferences as Json).chartChannels).toEqual({
      GARMIN: [
        { key: 'hrBpm', visible: true },
        { key: 'speedMs', visible: false },
        { key: 'powerW', visible: true },
      ],
      ZWIFT: [
        { key: 'altitudeM', visible: false },
        { key: 'powerW', visible: true },
      ],
    });
  });

  it('keeps users isolated', async () => {
    const bobChannels = [{ key: 'cadenceRpm', visible: false }];
    await app.request('/api/preferences/charts/GARMIN', {
      method: 'PUT',
      ...authed(bobToken, { method: 'PUT' }),
      body: JSON.stringify({ channels: bobChannels }),
    });
    const me = await json(await app.request('/api/me', authed(aliceToken)));
    expect((me.preferences as Json).chartChannels).toEqual({
      GARMIN: [
        { key: 'hrBpm', visible: true },
        { key: 'speedMs', visible: false },
        { key: 'powerW', visible: true },
      ],
      ZWIFT: [
        { key: 'altitudeM', visible: false },
        { key: 'powerW', visible: true },
      ],
    });
  });

  it('rejects unknown channels, duplicates and unknown providers', async () => {
    const bad = await app.request('/api/preferences/charts/GARMIN', {
      method: 'PUT',
      ...authed(aliceToken, { method: 'PUT' }),
      body: JSON.stringify({ channels: [{ key: 'wattsPerHeartbeat', visible: true }] }),
    });
    expect(bad.status).toBe(400);

    const dup = await app.request('/api/preferences/charts/GARMIN', {
      method: 'PUT',
      ...authed(aliceToken, { method: 'PUT' }),
      body: JSON.stringify({
        channels: [
          { key: 'hrBpm', visible: true },
          { key: 'hrBpm', visible: false },
        ],
      }),
    });
    expect(dup.status).toBe(400);

    const unknownProvider = await app.request('/api/preferences/charts/OMRON', {
      method: 'PUT',
      ...authed(aliceToken, { method: 'PUT' }),
      body: JSON.stringify({ channels: [{ key: 'hrBpm', visible: true }] }),
    });
    expect(unknownProvider.status).toBe(404);
  });
});

// ─── Connections: lifecycle + sync contract ──────────────────────────────────

describe('connections', () => {
  it('mounts the Strava OAuth routes', async () => {
    expect((await app.request('/api/strava/authorize')).status).toBe(401);
    const authorize = await app.request('/api/strava/authorize', authed(aliceToken));
    expect(authorize.status).toBe(503); // integration env has no Strava app creds

    const callback = await app.request('/api/strava/callback?code=c&state=bad');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('/connections?strava=error');
  });

  it('lists connections without ever leaking tokens', async () => {
    const res = await app.request('/api/connections', authed(aliceToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    const items = body.items as Json[];
    expect(items.map((c) => c.provider)).toEqual(expect.arrayContaining(['GARMIN', 'ZWIFT']));
    expect(JSON.stringify(body)).not.toContain('zwift-access');
    expect(JSON.stringify(body)).not.toContain('accessTokenEnc');
  });

  it('rejects unknown providers with 400', async () => {
    const res = await app.request('/api/connections', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify({ provider: 'PELOTON', username: 'x', password: 'y' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s sync attempts on unknown connections', async () => {
    const res = await app.request('/api/connections/00000000-0000-0000-0000-000000000000/sync', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(404);
  });

  it('scopes sync, status and delete to the owning user (T18)', async () => {
    expect(
      (
        await app.request(`/api/connections/${garminConnId}/sync`, {
          method: 'POST',
          ...authed(bobToken, { method: 'POST' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/connections/${garminConnId}/syncs`, authed(bobToken))).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/connections/${garminConnId}`, {
          method: 'DELETE',
          ...authed(bobToken, { method: 'DELETE' }),
        })
      ).status,
    ).toBe(404);

    const stillThere = await prisma.connection.findUniqueOrThrow({ where: { id: garminConnId } });
    expect(stillThere.status).toBe('ACTIVE');
  });

  it('rejects sync on a non-ACTIVE connection with 409 before calling the provider', async () => {
    const aliceId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } })
    ).id;
    const revoked = await prisma.connection.create({
      data: {
        userId: aliceId,
        provider: 'IGPSPORT',
        providerUserId: 'revoked-sync-1',
        status: 'REVOKED',
        accessTokenEnc: encryptToken('revoked-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });

    syncIgpSportConnection.mockClear();
    const res = await app.request(`/api/connections/${revoked.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(409);
    expect(String((await json(res)).error)).toContain('not active');
    expect(syncIgpSportConnection).not.toHaveBeenCalled();
  });

  it('queues one concurrent sync per connection and clears the lock', async () => {
    const aliceId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } })
    ).id;
    const igps = await prisma.connection.create({
      data: {
        userId: aliceId,
        provider: 'IGPSPORT',
        providerUserId: 'parallel-sync-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('parallel-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    syncIgpSportConnection.mockClear();
    syncIgpSportConnection.mockImplementationOnce(async (_env, connection) => {
      await gate;
      await prisma.syncLog.create({
        data: {
          connectionId: connection.id,
          kind: 'ACTIVITIES',
          status: 'OK',
          itemsCreated: 2,
          itemsUpdated: 1,
          finishedAt: new Date(),
        },
      });
      return { status: 'OK', itemsPulled: 2 };
    });

    const first = await app.request(`/api/connections/${igps.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(first.status).toBe(202);
    const firstBody = await json(first);
    expect(firstBody.status).toBe('queued');
    expect(firstBody.inProgress).toBe(true);

    // the worker may not have reached the mocked provider yet; the DB claim
    // is set before enqueue either way
    await waitFor(async () => {
      const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
      return row.syncStartedAt !== null;
    }, 'sync claim');

    const second = await app.request(`/api/connections/${igps.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(second.status).toBe(409);
    const secondBody = await json(second);
    expect(String(secondBody.error)).toContain('already in progress');

    const status = await json(
      await app.request(`/api/connections/${igps.id}/syncs`, authed(aliceToken)),
    );
    expect(status.inProgress).toBe(true);

    release();
    await waitFor(async () => {
      const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
      return row.syncStartedAt === null;
    }, 'sync lock release');

    const after = await json(
      await app.request(`/api/connections/${igps.id}/syncs`, authed(aliceToken)),
    );
    expect(after.inProgress).toBe(false);
    expect(after.connectionStatus).toBe('ACTIVE');
    const latest = (after.items as Json[])[0];
    expect(latest).toMatchObject({
      kind: 'ACTIVITIES',
      status: 'OK',
      itemsCreated: 2,
      itemsUpdated: 1,
    });
    expect(syncIgpSportConnection).toHaveBeenCalledTimes(1);
  });

  it('records a PARTIAL sync result in history and clears the lock', async () => {
    const igps = await prisma.connection.create({
      data: {
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } }))
          .id,
        provider: 'IGPSPORT',
        providerUserId: 'partial-sync-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('partial-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });

    syncIgpSportConnection.mockClear();
    syncIgpSportConnection.mockImplementationOnce(async (_env, connection) => {
      await prisma.syncLog.create({
        data: {
          connectionId: connection.id,
          kind: 'ACTIVITIES',
          status: 'PARTIAL',
          itemsPulled: 3,
          itemsCreated: 2,
          errorDetail: { failedRides: ['r1'] },
          finishedAt: new Date(),
        },
      });
      return { status: 'PARTIAL', itemsPulled: 3, itemsCreated: 2 };
    });

    const res = await app.request(`/api/connections/${igps.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(202);

    await waitFor(async () => {
      const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
      return row.syncStartedAt === null;
    }, 'PARTIAL sync lock release');

    const history = await json(
      await app.request(`/api/connections/${igps.id}/syncs`, authed(aliceToken)),
    );
    expect(history.inProgress).toBe(false);
    expect(history.connectionStatus).toBe('ACTIVE');
    expect((history.items as Json[])[0]).toMatchObject({
      status: 'PARTIAL',
      itemsPulled: 3,
      itemsCreated: 2,
      errorDetail: { failedRides: ['r1'] },
    });
  });

  it('throttles connection-create attempts per user', async () => {
    const limitedApp = createApp({
      ...env,
      STRIDASH_CONNECTION_RATE_LIMIT: 1,
      STRIDASH_CONNECTION_RATE_WINDOW_MS: 60_000,
    });
    const first = await limitedApp.request('/api/connections', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify({}), // invalid body also consumes the attempt
    });
    expect(first.status).toBe(400);

    const second = await limitedApp.request('/api/connections', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
  });

  it('a credential rejection marks the connection ERROR in the worker', async () => {
    // dedicated IGPSPORT connection so the dispatch hits the mocked service
    const igps = await prisma.connection.create({
      data: {
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } }))
          .id,
        provider: 'IGPSPORT',
        providerUserId: 'igps-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('igps-access', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    syncIgpSportConnection.mockRejectedValueOnce(new IgpSportError('bad credentials', 401));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request(`/api/connections/${igps.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(202);
    expect((await json(res)).status).toBe('queued');

    await waitFor(async () => {
      const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
      return row.status === 'ERROR' && row.syncStartedAt === null;
    }, 'credential failure to mark ERROR');
    errorLog.mockRestore();
    const status = await json(
      await app.request(`/api/connections/${igps.id}/syncs`, authed(aliceToken)),
    );
    expect(status.connectionStatus).toBe('ERROR');
    expect(status.inProgress).toBe(false);
  });

  it('an unknown sync failure is logged and leaves the connection ACTIVE', async () => {
    const igps = await prisma.connection.create({
      data: {
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } }))
          .id,
        provider: 'IGPSPORT',
        providerUserId: 'igps-2',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('igps-access-2', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    syncIgpSportConnection.mockRejectedValueOnce(new TypeError('programmer error'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request(`/api/connections/${igps.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(202);

    await waitFor(async () => {
      const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
      return row.syncStartedAt === null;
    }, 'unknown failure to release the lock');
    errorLog.mockRestore();
    // unknown failures must NOT mark the connection (that's a bug, not bad creds)
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('clears stale locks and marks interrupted sync logs at startup', async () => {
    const aliceId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } })
    ).id;
    const staleAt = new Date(Date.now() - SYNC_STALE_MS - 1_000);
    const stale = await prisma.connection.create({
      data: {
        userId: aliceId,
        provider: 'IGPSPORT',
        providerUserId: 'stale-sync-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('stale-access', env.STRIDASH_ENC_KEY),
        scopes: [],
        syncStartedAt: staleAt,
      },
    });
    const log = await prisma.syncLog.create({
      data: { connectionId: stale.id, kind: 'ACTIVITIES', status: 'OK', startedAt: staleAt },
    });

    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleared = await recoverStaleSyncLocks();
    warnLog.mockRestore();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const row = await prisma.connection.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.syncStartedAt).toBeNull();
    const interrupted = await prisma.syncLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(interrupted.status).toBe('ERROR');
    expect(interrupted.finishedAt).not.toBeNull();
  });

  it('soft-revokes on delete: tokens wiped, activities kept', async () => {
    const res = await app.request(`/api/connections/${zwiftConnId}`, {
      method: 'DELETE',
      ...authed(aliceToken, { method: 'DELETE' }),
    });
    expect(res.status).toBe(200);
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: zwiftConnId } });
    expect(row.status).toBe('REVOKED');
    expect(row.accessTokenEnc).toBeNull();
    expect(row.refreshTokenEnc).toBeNull();
    // the virtual ride stays — data is never pulled on revoke
    const kept = await prisma.activity.findUnique({ where: { id: virtualId } });
    expect(kept).not.toBeNull();
    const list = await json(await app.request('/api/connections', authed(aliceToken)));
    expect((list.items as Json[]).find((c) => c.id === zwiftConnId)?.status).toBe('REVOKED');
  });
});

// ─── Push tokens ─────────────────────────────────────────────────────────────

describe('push tokens', () => {
  it('registers, refreshes and removes an Expo push token', async () => {
    const body = { token: 'ExponentPushToken[test-1]', platform: 'ios' };
    const created = await app.request('/api/push-tokens', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject(body);

    // re-registering the same device refreshes lastSeenAt instead of failing
    const again = await app.request('/api/push-tokens', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify(body),
    });
    expect(again.status).toBe(201);

    const invalid = await app.request('/api/push-tokens', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify({ token: 'not-a-token', platform: 'ios' }),
    });
    expect(invalid.status).toBe(400);

    const removed = await app.request('/api/push-tokens', {
      method: 'DELETE',
      ...authed(aliceToken, { method: 'DELETE' }),
      body: JSON.stringify({ token: body.token }),
    });
    expect(removed.status).toBe(200);
  });
});

// ─── Manual measurements ─────────────────────────────────────────────────────

describe('manual measurements', () => {
  it('creates a weigh-in and returns it in the measurement feed', async () => {
    const measuredAt = '2040-01-01T07:30:00.000Z';
    const res = await app.request('/api/measurements', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify({
        kind: 'WEIGH_IN',
        measuredAt,
        weightKg: 82.5,
        bodyFatPct: 18.4,
        notes: 'after breakfast',
      }),
    });
    expect(res.status).toBe(201);
    const row = await json(res);
    expect(row).toMatchObject({
      provider: 'MANUAL',
      kind: 'WEIGH_IN',
      weightKg: 82.5,
      bodyFatPct: 18.4,
      notes: 'after breakfast',
    });

    const list = await json(
      await app.request(
        `/api/measurements?from=${encodeURIComponent(measuredAt)}&to=${encodeURIComponent(
          '2040-01-01T23:59:59.999Z',
        )}`,
        authed(aliceToken),
      ),
    );
    expect((list.items as Json[]).some((m) => m.id === row.id)).toBe(true);
  });

  it('creates a blood-pressure reading and rejects duplicates/invalid bodies', async () => {
    const measuredAt = '2040-01-02T08:00:00.000Z';
    const body = {
      kind: 'BLOOD_PRESSURE',
      measuredAt,
      systolicMmhg: 120,
      diastolicMmgh: 80,
    };
    // typo field is rejected
    expect(
      (
        await app.request('/api/measurements', {
          method: 'POST',
          ...authed(aliceToken, { method: 'POST' }),
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400);

    const valid = {
      kind: 'BLOOD_PRESSURE',
      measuredAt,
      systolicMmhg: 120,
      diastolicMmhg: 80,
      pulseBpm: 62,
    };
    const created = await app.request('/api/measurements', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify(valid),
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      provider: 'MANUAL',
      kind: 'BLOOD_PRESSURE',
      systolicMmhg: 120,
      diastolicMmhg: 80,
      pulseBpm: 62,
    });

    const duplicate = await app.request('/api/measurements', {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
      body: JSON.stringify(valid),
    });
    expect(duplicate.status).toBe(409);
  });
});

// ─── Gear (provider-synced gear + Stridash-managed components) ────────────────

describe('gear', () => {
  let shoesId = '';
  let bikeId = '';

  beforeAll(async () => {
    const alice = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } });
    // Alice owns a synced GARMIN shoe + a manual bike; her run wears the shoe
    const shoes = await prisma.gear.create({
      data: {
        userId: alice.id,
        name: 'Kiprun Kipride Max',
        kind: 'SHOES',
        provider: 'GARMIN',
        sourceGearId: 'e496727e-dc6f-46c5-89c5-c429e9e35a61',
        firstUsedAt: new Date('2026-01-01'),
        usageType: 'DISTANCE',
        thresholdM: 643_738,
        raw: { provider: 'GARMIN', v2: { uuid: 'e496727e-dc6f-46c5-89c5-c429e9e35a61' } },
      },
    });
    shoesId = shoes.id;
    const bike = await prisma.gear.create({
      data: { userId: alice.id, name: 'Giant Contend SL', kind: 'BIKE' },
    });
    bikeId = bike.id;

    await prisma.activity.update({ where: { id: runId }, data: { gearId: shoesId } });
  });

  it('lists gear with computed usage from linked activities', async () => {
    const res = await app.request('/api/gear', authed(aliceToken));
    expect(res.status).toBe(200);
    const body = await json(res);
    const items = body.items as Json[];
    expect(items).toHaveLength(2);
    const shoes = items.find((g) => g.id === shoesId)!;
    expect(shoes.provider).toBe('GARMIN');
    expect(shoes.thresholdM).toBe(643_738);
    expect((shoes.usage as Json).distanceM).toBe(5_100); // the run's distance
    expect((shoes.usage as Json).count).toBe(1);
    expect((items.find((g) => g.id === bikeId)!.usage as Json).count).toBe(0);
  });

  it('creates a component with an install date; usage stays windowed', async () => {
    const res = await app.request(`/api/gear/${bikeId}/components`, {
      method: 'POST',
      ...authed(aliceToken, {
        body: JSON.stringify({ name: 'Chain', kind: 'CHAIN', installedAt: '2026-11-10' }),
      }),
    });
    expect(res.status).toBe(201);
    const { item } = (await json(res)) as { item: Json };
    expect(item.kind).toBe('CHAIN');

    // listed on the gear with 0 usage: the run happened BEFORE the install
    const list = await json(await app.request('/api/gear', authed(aliceToken)));
    const bike = (list.items as Json[]).find((g) => g.id === bikeId)!;
    const comps = bike.components as Json[];
    expect(comps).toHaveLength(1);
    expect((comps[0].usage as Json).distanceM).toBe(0);
    expect(comps[0].installedAt).toBe('2026-11-10T00:00:00.000Z');
  });

  it('rejects an invalid component payload and a foreign gear id', async () => {
    const bad = await app.request(`/api/gear/${bikeId}/components`, {
      method: 'POST',
      ...authed(aliceToken, { body: JSON.stringify({ name: '' }) }),
    });
    expect(bad.status).toBe(400);

    const alice = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } });
    const bob = await prisma.user.findUniqueOrThrow({ where: { email: 'bob@test.stridash' } });
    const bobGear = await prisma.gear.create({
      data: { userId: bob.id, name: "Bob's bike", kind: 'BIKE' },
    });
    const foreign = await app.request(`/api/gear/${bobGear.id}/components`, {
      method: 'POST',
      ...authed(aliceToken, { body: JSON.stringify({ name: 'Chain' }) }),
    });
    expect(foreign.status).toBe(404);
    void alice;
  });

  it('patches (retires) and deletes a component; 404s are per-user', async () => {
    const created = (await json(
      await app.request(`/api/gear/${bikeId}/components`, {
        method: 'POST',
        ...authed(aliceToken, { body: JSON.stringify({ name: 'Brake pads', kind: 'BRAKE_PADS' }) }),
      }),
    )) as { item: Json };
    const id = created.item.id as string;

    const patched = await app.request(`/api/gear/components/${id}`, {
      method: 'PATCH',
      ...authed(aliceToken, { body: JSON.stringify({ retiredAt: '2026-11-11' }) }),
    });
    expect(patched.status).toBe(200);
    expect(((await json(patched)) as { item: Json }).item.retiredAt).toContain('2026-11-11');

    const gone = await app.request(`/api/gear/components/${id}`, {
      method: 'DELETE',
      ...authed(aliceToken, { method: 'DELETE' }),
    });
    expect(gone.status).toBe(200);

    const missing = await app.request(`/api/gear/components/${id}`, {
      method: 'PATCH',
      ...authed(bobToken, { body: JSON.stringify({ name: 'X' }) }),
    });
    expect(missing.status).toBe(404);
  });

  it('requires auth', async () => {
    const res = await app.request('/api/gear');
    expect(res.status).toBe(401);
  });
});

// ─── Account export + delete (Settings page: download my data / danger zone) ─

describe('account export + delete', () => {
  let email = '';
  let token = '';

  it('exports the full account as a JSON download without any tokens', async () => {
    email = `exporter-${Date.now()}@test.stridash`;
    const reg = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'exporter-pass-1', displayName: 'Exporter' }),
    });
    token = ((await json(reg)) as { accessToken: string }).accessToken;
    const alice = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } });

    // seed one of everything, including a connection (tokens must stay out)
    const conn = await prisma.connection.create({
      data: {
        userId: alice.id,
        provider: 'GARMIN',
        providerUserId: 'exp-1',
        status: 'ACTIVE',
        accessTokenEnc: encryptToken('secret-access', env.STRIDASH_ENC_KEY),
        refreshTokenEnc: encryptToken('secret-refresh', env.STRIDASH_ENC_KEY),
        scopes: [],
      },
    });
    const exportActivity = await prisma.activity.create({
      data: {
        userId: alice.id,
        headline: 'exportable run',
        type: 'RUN',
        startTime: new Date('2026-11-01T07:00:00Z'),
        durationS: 1800,
        sources: {
          create: {
            connectionId: conn.id,
            sourceActivityId: 'exp-1',
            sourceUpdatedAt: new Date('2026-11-01T07:00:00Z'),
          },
        },
      },
    });
    await prisma.activityDataPoint.create({
      data: {
        activityId: exportActivity.id,
        provider: 'GARMIN',
        sampleCount: 2,
        series: { timeMs: [0, 1000], hrBpm: [100, 110] },
        raw: { stream: 'raw-is-exported' },
      },
    });

    const res = await app.request('/api/export', authed(aliceToken));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-type')).toContain('application/json');
    const dump = (await json(res)) as Record<string, unknown>;
    expect(dump.format).toBe('stridash-export/2');
    expect((dump.account as Record<string, unknown>).email).toBe('alice@test.stridash');
    expect(dump.preferences).toEqual({ units: 'km', theme: 'dark', language: 'en' });
    expect(dump.chartChannels).toEqual(expect.any(Object));
    const acts = dump.activities as Array<Record<string, unknown>>;
    const exported = acts.find((a) => a.headline === 'exportable run')!;
    expect((exported.sources as Array<Record<string, unknown>>)[0].sourceActivityId).toBe('exp-1');
    const series = dump.activityDataPoints as Array<Record<string, unknown>>;
    const exportedSeries = series.find((s) => s.activityId === exportActivity.id)!;
    expect(exportedSeries.series).toEqual({ timeMs: [0, 1000], hrBpm: [100, 110] });
    expect((exportedSeries.raw as Record<string, unknown>).stream).toBe('raw-is-exported');
    const raw = JSON.stringify(dump);
    expect(raw).not.toContain('secret-access');
    expect(raw).not.toContain('secret-refresh');
    // the exporter's own account sees nothing of alice's
    const mine = await app.request('/api/export', authed(token));
    const mineDump = (await json(mine)) as {
      activities: unknown[];
      chartChannels: Record<string, unknown>;
    };
    expect(mineDump.activities).toHaveLength(0);
    expect(mineDump.chartChannels).toEqual({});
  });

  it('streams every page instead of truncating at one page', async () => {
    const alice = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } });
    const before = await prisma.measurement.count({ where: { userId: alice.id } });
    await prisma.measurement.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        userId: alice.id,
        provider: 'MANUAL' as const,
        kind: 'WEIGH_IN' as const,
        measuredAt: new Date(Date.UTC(2030, 0, 1, 0, i)),
        weightKg: (70 + i / 100).toFixed(2),
        notes: `export-page-${i}`,
      })),
    });

    const res = await app.request('/api/export', authed(aliceToken));
    expect(res.status).toBe(200);
    const dump = (await json(res)) as Record<string, unknown>;
    const measurements = dump.measurements as Array<Record<string, unknown>>;
    expect(measurements).toHaveLength(before + 205);
    expect(measurements.some((m) => m.notes === 'export-page-204')).toBe(true);
  });

  it('issues, lists and revokes long-lived API tokens', async () => {
    const created = await app.request('/api/tokens', {
      method: 'POST',
      ...authed(token, { method: 'POST' }),
      body: JSON.stringify({ name: 'MCP test', expiresInDays: 30 }),
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    const raw = String(body.token);
    expect(raw.startsWith('sdat_')).toBe(true);
    expect(body.prefix).toBe(raw.slice(0, 9));
    expect(JSON.stringify(body)).not.toContain('tokenHash');

    const me = await app.request('/api/me', {
      headers: { Authorization: `Bearer ${raw}` },
    });
    expect(me.status).toBe(200);
    expect((await json(me)).email).toBe(email);

    const list = await app.request('/api/tokens', authed(token));
    expect(list.status).toBe(200);
    const items = (await json(list)).items as Json[];
    expect(items.some((t) => t.id === body.id && t.name === 'MCP test')).toBe(true);
    expect(JSON.stringify(items)).not.toContain('tokenHash');

    const revoked = await app.request(`/api/tokens/${String(body.id)}`, {
      method: 'DELETE',
      ...authed(token, { method: 'DELETE' }),
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await app.request('/api/me', {
          headers: { Authorization: `Bearer ${raw}` },
        })
      ).status,
    ).toBe(401);
  });

  it('streams CSV exports with RFC escaping and validates the type', async () => {
    const created = await app.request('/api/measurements', {
      method: 'POST',
      ...authed(token, { method: 'POST' }),
      body: JSON.stringify({
        kind: 'WEIGH_IN',
        measuredAt: '2040-02-01T07:00:00.000Z',
        weightKg: 81.2,
        notes: 'a, "quoted" note',
      }),
    });
    expect(created.status).toBe(201);

    const csv = await app.request('/api/export/csv?type=measurements', authed(token));
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('stridash-measurements-');
    const text = await csv.text();
    expect(text.split('\r\n')[0]).toContain('measuredAt,provider,kind');
    expect(text).toContain('81.2');
    expect(text).toContain('"a, ""quoted"" note"');

    const activities = await app.request('/api/export/csv?type=activities', authed(token));
    expect(activities.status).toBe(200);
    expect((await activities.text()).split('\r\n')[0]).toContain('startTime,headline,type');

    expect((await app.request('/api/export/csv?type=nope', authed(token))).status).toBe(400);
    expect((await app.request('/api/export/csv', authed(token))).status).toBe(400);
  });

  it('hard-deletes the account and cascades everything; the token dies after', async () => {
    const res = await app.request('/api/me', authed(token, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();

    // the row is gone — the same token now reads an empty account (JWT is
    // stateless; refresh tokens died with the cascade, so the session ends)
    const me = await app.request('/api/me', authed(token));
    expect(me.status).toBe(404);
  });
});

// ─── Account preferences (user_preferences — one typed column per setting) ───

describe('account preferences', () => {
  let email = '';
  let token = '';

  beforeAll(async () => {
    email = `prefs-${Date.now()}@test.stridash`;
    const reg = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'preferences-1', displayName: 'Prefs' }),
    });
    token = ((await json(reg)) as { accessToken: string }).accessToken;
  });

  it('creates defaults (km, dark) at registration and reads them on /me', async () => {
    const res = await app.request('/api/me', authed(token));
    expect(res.status).toBe(200);
    const me = (await json(res)) as Record<string, unknown>;
    expect(me.preferences).toEqual({
      units: 'km',
      theme: 'dark',
      language: 'en',
      chartChannels: {},
    });
  });

  it('persists partial updates and returns the new pair', async () => {
    const res = await app.request('/api/me', {
      method: 'PATCH',
      ...authed(token, { body: JSON.stringify({ units: 'mi' }) }),
    });
    expect(res.status).toBe(200);
    expect(((await json(res)) as { preferences: unknown }).preferences).toEqual({
      units: 'mi',
      theme: 'dark',
      language: 'en',
    });
    // durable: a fresh /me still sees it (it is a real row now)
    const me = (await json(await app.request('/api/me', authed(token)))) as {
      preferences: unknown;
    };
    expect(me.preferences).toEqual({
      units: 'mi',
      theme: 'dark',
      language: 'en',
      chartChannels: {},
    });
  });

  it('persists the UI language like the other settings', async () => {
    const res = await app.request('/api/me', {
      method: 'PATCH',
      ...authed(token, { body: JSON.stringify({ language: 'es' }) }),
    });
    expect(res.status).toBe(200);
    expect(((await json(res)) as { preferences: { language: string } }).preferences.language).toBe(
      'es',
    );
    // durable across /me reads; units/theme stay untouched by the language PATCH
    const me = (await json(await app.request('/api/me', authed(token)))) as {
      preferences: { units: string; theme: string; language: string };
    };
    expect(me.preferences).toEqual({
      units: 'mi',
      theme: 'dark',
      language: 'es',
      chartChannels: {},
    });
  });

  it('rejects an unsupported language code', async () => {
    const res = await app.request('/api/me', {
      method: 'PATCH',
      ...authed(token, { body: JSON.stringify({ language: 'xx' }) }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown settings keys and empty updates', async () => {
    const bad = await app.request('/api/me', {
      method: 'PATCH',
      ...authed(token, { body: JSON.stringify({ timeZone: 'utc' }) }),
    });
    expect(bad.status).toBe(400);

    const empty = await app.request('/api/me', {
      method: 'PATCH',
      ...authed(token, { body: JSON.stringify({}) }),
    });
    expect(empty.status).toBe(400);
  });

  it('requires auth', async () => {
    expect((await app.request('/api/me', { method: 'PATCH' })).status).toBe(401);
  });
});

// ─── Devices (recording hardware on activities) ──────────────────────────────

describe('devices', () => {
  let email = '';
  let token = '';
  let userId = '';
  let activityId = '';

  beforeAll(async () => {
    email = `dev-${Date.now()}@test.stridash`;
    const reg = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'devices-pass-1', displayName: 'Dev' }),
    });
    token = ((await json(reg)) as { accessToken: string }).accessToken;
    userId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  });

  it('activity detail carries the recording device', async () => {
    const { upsertDevice } = await import('../../src/services/devices.js');
    const deviceId = await upsertDevice(userId, {
      provider: 'GARMIN',
      sourceDeviceId: '3422639741',
      manufacturer: 'garmin',
      model: 'Forerunner 955 Solar',
      productCode: 4024,
      softwareVersion: '29.05',
      raw: { product: 4024, device_index: 'creator' },
    });
    const activity = await prisma.activity.create({
      data: {
        userId,
        headline: 'Watch run',
        type: 'RUN',
        startTime: new Date('2026-11-10T07:00:00Z'),
        durationS: 1_800,
        raw: {},
        deviceId,
      },
    });
    activityId = activity.id;

    const res = await app.request(`/api/activities/${activity.id}`, authed(token));
    expect(res.status).toBe(200);
    const item = (await json(res)).items[0] as Record<string, unknown>;
    const device = item.device as Record<string, unknown> | null;
    expect(device).not.toBeNull();
    expect(device).toMatchObject({
      provider: 'GARMIN',
      sourceDeviceId: '3422639741',
      manufacturer: 'garmin',
      model: 'Forerunner 955 Solar',
      productCode: 4024,
      softwareVersion: '29.05',
    });
    // the raw FIT device message rides along (raw payload is the authority)
    expect((device!.raw as Record<string, unknown>).product).toBe(4024);
  });

  it('upsertDevice dedupes per (user, provider, serial) and fills gaps', async () => {
    const { upsertDevice } = await import('../../src/services/devices.js');
    const id1 = await upsertDevice(userId, {
      provider: 'IGPSPORT',
      sourceDeviceId: '72364288',
      manufacturer: 'igpsport',
      productCode: 301,
      softwareVersion: '1.31',
      raw: {},
    });
    const id2 = await upsertDevice(userId, {
      provider: 'IGPSPORT',
      sourceDeviceId: '72364288',
      softwareVersion: '1.40', // newer firmware observed later
      raw: { newer: true },
    });
    expect(id2).toBe(id1); // same serial → same row
    const row = await prisma.device.findUniqueOrThrow({
      where: {
        userId_provider_sourceDeviceId: {
          userId,
          provider: 'IGPSPORT',
          sourceDeviceId: '72364288',
        },
      },
    });
    expect(row.productCode).toBe(301); // not nulled by the second call
    expect(row.softwareVersion).toBe('1.40');
    expect((row.raw as Record<string, unknown>).newer).toBe(true);

    // a different user never sees another user's device
    const other = await prisma.user.findUniqueOrThrow({ where: { email: 'bob@test.stridash' } });
    const id3 = await upsertDevice(other.id, {
      provider: 'IGPSPORT',
      sourceDeviceId: '72364288',
      raw: {},
    });
    expect(id3).not.toBe(id1);
  });

  it('devices ride in the account export', async () => {
    const res = await app.request('/api/export', authed(token));
    expect(res.status).toBe(200);
    const dump = (await json(res)) as Record<string, unknown>;
    const devices = dump.devices as Array<Record<string, unknown>>;
    expect(devices.some((d) => d.sourceDeviceId === '3422639741')).toBe(true);
  });

  it('device links never leak across users', async () => {
    const res = await app.request(`/api/activities/${activityId}`, authed(bobToken));
    expect(res.status).toBe(404);
  });
});

// ─── Similar activities (compare picker) ─────────────────────────────────────

describe('similar activities (compare picker)', () => {
  let closeRunId = '';
  let farRunId = '';
  let workoutId = '';
  let yogaId = '';

  beforeAll(async () => {
    const aliceId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'alice@test.stridash' } })
    ).id;
    const mk = (
      headline: string,
      type: string,
      startTime: Date,
      distanceM: number | null,
      durationS: number,
    ) =>
      prisma.activity.create({
        data: {
          userId: aliceId,
          headline,
          type: type as never,
          startTime,
          durationS,
          distanceM,
          raw: { provider: 'GARMIN', sourceRow: {} },
        },
      });

    // in the base run's ±25% distance band (3825..6375 m)
    closeRunId = (await mk('Evening run', 'RUN', new Date('2026-11-08T18:00:00Z'), 5_300, 1_850))
      .id;
    // outside the band (8 000 m) and a different type entirely
    farRunId = (await mk('Long run', 'RUN', new Date('2026-11-10T07:00:00Z'), 8_000, 3_000)).id;
    // distance-less rows use the duration band (±40% of 1 800 s)
    workoutId = (
      await mk('Core strength', 'WORKOUT', new Date('2026-11-11T06:00:00Z'), null, 1_800)
    ).id;
    yogaId = (await mk('Yoga flow', 'WORKOUT', new Date('2026-11-12T06:00:00Z'), null, 1_600)).id;
  });

  it('returns same-type rows within the distance band, excluding the base', async () => {
    const res = await app.request(`/api/activities/${runId}/similar`, authed(aliceToken));
    expect(res.status).toBe(200);
    const items = ((await json(res)).items ?? []) as Json[];
    const ids = items.map((i) => i.id);
    expect(ids).toContain(closeRunId);
    expect(ids).not.toContain(runId); // self excluded
    expect(ids).not.toContain(farRunId); // 8 000 m > 5 100 × 1.25
    expect(ids).not.toContain(virtualId); // different type
    expect(ids).not.toContain(workoutId); // different type
    // lean picker rows: headline/date/distance/time, no raw payloads
    const close = items.find((i) => i.id === closeRunId) as Json;
    expect(close.distanceM).toBe(5_300);
    expect(close.headline).toBe('Evening run');
    expect(close.raw).toBeUndefined();
    expect(close.detailRaw).toBeUndefined();
  });

  it('falls back to duration bands when the base has no distance', async () => {
    const res = await app.request(`/api/activities/${workoutId}/similar`, authed(aliceToken));
    expect(res.status).toBe(200);
    const items = ((await json(res)).items ?? []) as Json[];
    // 1 600 s sits inside ±40% of 1 800 s; no RUN qualifies (type filter)
    expect(items.map((i) => i.id)).toEqual([yogaId]);
  });

  it('404s for an unknown activity', async () => {
    const res = await app.request(
      '/api/activities/00000000-0000-0000-0000-000000000000/similar',
      authed(aliceToken),
    );
    expect(res.status).toBe(404);
  });

  it('never leaks another user’s activities', async () => {
    const res = await app.request(`/api/activities/${runId}/similar`, authed(bobToken));
    expect(res.status).toBe(404);
  });
});

// ─── Activity ingest dedupe (D1) ─────────────────────────────────────────────

describe('activity ingest dedupe', () => {
  let userId = '';

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: 'dedupe@test.stridash', displayName: 'Dedupe' },
      select: { id: true },
    });
    userId = user.id;
  });

  type Conn = { id: string; userId: string };

  async function connectionFor(
    ownerId: string,
    provider: 'GARMIN' | 'ZWIFT' | 'IGPSPORT',
  ): Promise<Conn> {
    return prisma.connection.create({
      data: {
        userId: ownerId,
        provider,
        providerUserId: `${provider}:${randomUUID()}`,
        status: 'ACTIVE',
      },
      select: { id: true, userId: true },
    });
  }

  async function connection(provider: 'GARMIN' | 'ZWIFT' | 'IGPSPORT'): Promise<Conn> {
    return connectionFor(userId, provider);
  }

  function ingest(
    conn: Conn,
    sourceActivityId: string,
    opts: { type?: ActivityType; startTime?: Date; distanceM?: number | null } = {},
  ) {
    const type = opts.type ?? 'RIDE';
    const startTime = opts.startTime ?? new Date('2026-11-18T10:00:00.000Z');
    const distanceM = opts.distanceM === undefined ? 10_000 : opts.distanceM;

    return ingestActivity(
      {
        userId: conn.userId,
        connectionId: conn.id,
        sourceActivityId,
        type,
        startTime,
        distanceM,
      },
      {
        create: (tx) =>
          tx.activity.create({
            data: {
              userId: conn.userId,
              headline: `Dedupe ${sourceActivityId}`,
              type,
              startTime,
              durationS: 3600,
              distanceM,
              indoor: type === 'VIRTUAL_RIDE',
            },
            select: { id: true },
          }),
      },
    );
  }

  async function rowsFor(...connections: Conn[]) {
    return prisma.activity.findMany({
      where: {
        userId,
        sources: { some: { connectionId: { in: connections.map((c) => c.id) } } },
      },
      select: {
        id: true,
        sources: { select: { connectionId: true, sourceActivityId: true } },
      },
    });
  }

  it('stores one activity when the same null-distance workout arrives twice', async () => {
    const garmin = await connection('GARMIN');
    const zwift = await connection('ZWIFT');
    const startTime = new Date('2026-11-18T09:00:00.000Z');

    await ingest(garmin, 'g-null', { type: 'WORKOUT', startTime, distanceM: null });
    await ingest(zwift, 'z-null', { type: 'WORKOUT', startTime, distanceM: null });
    // re-ingesting the same provider source is idempotent too
    await ingest(garmin, 'g-null', { type: 'WORKOUT', startTime, distanceM: null });

    const rows = await rowsFor(garmin, zwift);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources).toHaveLength(2);
  });

  it('collapses the real 21 s / 1.9 m Garmin-vs-Zwift clock drift', async () => {
    const garmin = await connection('GARMIN');
    const zwift = await connection('ZWIFT');
    const zwiftStart = new Date('2026-11-13T10:40:30.082Z');

    await ingest(garmin, 'g-drift', {
      startTime: new Date(zwiftStart.getTime() + 21_000),
      distanceM: 11_537.84,
    });
    await ingest(zwift, 'z-drift', {
      startTime: zwiftStart,
      distanceM: 11_539.7,
    });

    const rows = await rowsFor(garmin, zwift);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources.map((s) => s.sourceActivityId).sort()).toEqual(['g-drift', 'z-drift']);
  });

  it('serializes parallel ingests so only one row is created', async () => {
    const garmin = await connection('GARMIN');
    const igpsport = await connection('IGPSPORT');
    const startTime = new Date('2026-11-18T11:00:00.000Z');

    const results = await Promise.all([
      ingest(garmin, 'parallel-g', { startTime }),
      ingest(igpsport, 'parallel-i', { startTime }),
    ]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await rowsFor(garmin, igpsport)).toHaveLength(1);
  });

  it('does not merge two distinct activities from the same connection', async () => {
    const conn = await connection('GARMIN');
    const startTime = new Date('2026-11-18T12:00:00.000Z');

    await ingest(conn, 'lap-1', { startTime });
    await ingest(conn, 'lap-2', { startTime: new Date(startTime.getTime() + 10_000) });

    expect(await rowsFor(conn)).toHaveLength(2);
  });

  it('does not merge distances more than 100 m apart', async () => {
    const garmin = await connection('GARMIN');
    const zwift = await connection('ZWIFT');
    const startTime = new Date('2026-11-18T13:00:00.000Z');

    await ingest(garmin, 'far-a', { startTime, distanceM: 10_000 });
    await ingest(zwift, 'far-b', { startTime, distanceM: 10_250 });

    expect(await rowsFor(garmin, zwift)).toHaveLength(2);
  });

  it('serializes parallel tolerance-matched ingests (T1)', async () => {
    const garmin = await connection('GARMIN');
    const zwift = await connection('ZWIFT');
    const startTime = new Date('2026-11-18T15:00:00.000Z');

    const results = await Promise.all([
      ingest(garmin, 'parallel-tol-g', { startTime, distanceM: 10_000 }),
      ingest(zwift, 'parallel-tol-z', {
        startTime: new Date(startTime.getTime() + 21_000),
        distanceM: 10_001.9,
      }),
    ]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await rowsFor(garmin, zwift);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources).toHaveLength(2);
  });

  it('serializes parallel NULL-distance ingests at the exact start (T1)', async () => {
    const garmin = await connection('GARMIN');
    const zwift = await connection('ZWIFT');
    const startTime = new Date('2026-11-18T15:10:00.000Z');

    const results = await Promise.all([
      ingest(garmin, 'parallel-null-g', { startTime, distanceM: null }),
      ingest(zwift, 'parallel-null-z', { startTime, distanceM: null }),
    ]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await rowsFor(garmin, zwift);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources).toHaveLength(2);
  });

  it('pins the 60 s and 100 m matching boundaries (T2)', async () => {
    const exactStart = new Date('2026-11-18T16:00:00.000Z');
    const exactGarmin = await connection('GARMIN');
    const exactZwift = await connection('ZWIFT');
    await ingest(exactGarmin, 'edge-exact-g', { startTime: exactStart, distanceM: 10_000 });
    await ingest(exactZwift, 'edge-exact-z', {
      startTime: new Date(exactStart.getTime() + 60_000),
      distanceM: 10_100,
    });
    const exactRows = await rowsFor(exactGarmin, exactZwift);
    expect(exactRows).toHaveLength(1);
    expect(exactRows[0]!.sources).toHaveLength(2);

    const overStart = new Date('2026-11-18T17:00:00.000Z');
    const overTimeGarmin = await connection('GARMIN');
    const overTimeZwift = await connection('ZWIFT');
    await ingest(overTimeGarmin, 'edge-over-time-g', { startTime: overStart, distanceM: 10_000 });
    await ingest(overTimeZwift, 'edge-over-time-z', {
      startTime: new Date(overStart.getTime() + 61_000),
      distanceM: 10_000,
    });
    expect(await rowsFor(overTimeGarmin, overTimeZwift)).toHaveLength(2);

    const overDistanceStart = new Date('2026-11-18T18:00:00.000Z');
    const overDistanceGarmin = await connection('GARMIN');
    const overDistanceZwift = await connection('ZWIFT');
    await ingest(overDistanceGarmin, 'edge-over-dist-g', {
      startTime: overDistanceStart,
      distanceM: 10_000,
    });
    await ingest(overDistanceZwift, 'edge-over-dist-z', {
      startTime: overDistanceStart,
      distanceM: 10_101,
    });
    expect(await rowsFor(overDistanceGarmin, overDistanceZwift)).toHaveLength(2);
  });

  it('does not merge across activity types (T3)', async () => {
    const garmin = await connection('GARMIN');
    const zwift = await connection('ZWIFT');
    const startTime = new Date('2026-11-18T19:00:00.000Z');

    await ingest(garmin, 'type-ride', { type: 'RIDE', startTime, distanceM: 10_000 });
    await ingest(zwift, 'type-workout', { type: 'WORKOUT', startTime, distanceM: 10_000 });

    expect(await rowsFor(garmin, zwift)).toHaveLength(2);
  });

  it('does not merge across users (T3)', async () => {
    const other = await prisma.user.create({
      data: { email: `dedupe-other-${randomUUID()}@test.stridash`, displayName: 'Other' },
      select: { id: true },
    });
    const otherConnection = await connectionFor(other.id, 'GARMIN');
    const startTime = new Date('2026-11-18T19:10:00.000Z');
    const before = await prisma.activity.count({ where: { userId } });

    await ingest(otherConnection, 'other-user-source', { startTime, distanceM: 10_000 });

    expect(await prisma.activity.count({ where: { userId: other.id } })).toBe(1);
    expect(await prisma.activity.count({ where: { userId } })).toBe(before);
  });

  it('matches NULL and non-NULL distances only at the exact start (T4)', async () => {
    const nullFirstStart = new Date('2026-11-18T20:00:00.000Z');
    const nullFirstGarmin = await connection('GARMIN');
    const nullFirstZwift = await connection('ZWIFT');
    await ingest(nullFirstGarmin, 'null-first-g', {
      startTime: nullFirstStart,
      distanceM: null,
    });
    await ingest(nullFirstZwift, 'null-first-z', {
      startTime: nullFirstStart,
      distanceM: 10_000,
    });
    const nullFirstRows = await rowsFor(nullFirstGarmin, nullFirstZwift);
    expect(nullFirstRows).toHaveLength(1);
    expect(nullFirstRows[0]!.sources).toHaveLength(2);

    const nonNullFirstStart = new Date('2026-11-18T20:10:00.000Z');
    const nonNullFirstGarmin = await connection('GARMIN');
    const nonNullFirstZwift = await connection('ZWIFT');
    await ingest(nonNullFirstGarmin, 'non-null-first-g', {
      startTime: nonNullFirstStart,
      distanceM: 10_000,
    });
    await ingest(nonNullFirstZwift, 'non-null-first-z', {
      startTime: nonNullFirstStart,
      distanceM: null,
    });
    const nonNullFirstRows = await rowsFor(nonNullFirstGarmin, nonNullFirstZwift);
    expect(nonNullFirstRows).toHaveLength(1);
    expect(nonNullFirstRows[0]!.sources).toHaveLength(2);

    const shiftedStart = new Date('2026-11-18T20:20:00.000Z');
    const shiftedGarmin = await connection('GARMIN');
    const shiftedZwift = await connection('ZWIFT');
    await ingest(shiftedGarmin, 'shifted-null-g', { startTime: shiftedStart, distanceM: null });
    await ingest(shiftedZwift, 'shifted-null-z', {
      startTime: new Date(shiftedStart.getTime() + 1_000),
      distanceM: 10_000,
    });
    expect(await rowsFor(shiftedGarmin, shiftedZwift)).toHaveLength(2);
  });

  it('picks the closest start, then closest distance, from multiple candidates (T5)', async () => {
    const zwift = await connection('ZWIFT');
    const startTime = new Date('2026-11-18T21:00:00.000Z');
    const near = await prisma.activity.create({
      data: {
        userId,
        headline: 'Near candidate',
        type: 'RIDE',
        startTime: new Date(startTime.getTime() + 5_000),
        durationS: 3600,
        distanceM: 10_000,
      },
      select: { id: true },
    });
    await prisma.activity.create({
      data: {
        userId,
        headline: 'Far candidate',
        type: 'RIDE',
        startTime: new Date(startTime.getTime() + 30_000),
        durationS: 3600,
        distanceM: 10_000,
      },
    });

    const closest = await ingest(zwift, 'closest-start-z', { startTime, distanceM: 10_000 });
    expect(closest.activityId).toBe(near.id);

    const tieStart = new Date('2026-11-18T21:20:00.000Z');
    const tieFarDistance = await prisma.activity.create({
      data: {
        userId,
        headline: 'Tie far distance',
        type: 'RIDE',
        startTime: tieStart,
        durationS: 3600,
        distanceM: 10_050,
      },
      select: { id: true },
    });
    await prisma.activity.create({
      data: {
        userId,
        headline: 'Tie near distance',
        type: 'RIDE',
        startTime: tieStart,
        durationS: 3600,
        distanceM: 10_000,
      },
    });
    const tieZwift = await connection('ZWIFT');
    const closestDistance = await ingest(tieZwift, 'closest-distance-z', {
      startTime: tieStart,
      distanceM: 10_049,
    });
    expect(closestDistance.activityId).toBe(tieFarDistance.id);
  });

  it('enforces provider-side activity source uniqueness (T8)', async () => {
    const garmin = await connection('GARMIN');
    const startTime = new Date('2026-11-18T22:00:00.000Z');
    await ingest(garmin, 'unique-source-id', { startTime, distanceM: 10_000 });
    const other = await prisma.activity.create({
      data: {
        userId,
        headline: 'Other activity',
        type: 'RIDE',
        startTime: new Date('2026-11-18T23:00:00.000Z'),
        durationS: 1800,
        distanceM: 5_000,
      },
      select: { id: true },
    });

    await expect(
      prisma.activitySource.create({
        data: {
          activityId: other.id,
          connectionId: garmin.id,
          sourceActivityId: 'unique-source-id',
          sourceUpdatedAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lets provider identity win over a shifted start time', async () => {
    const conn = await connection('GARMIN');
    const startTime = new Date('2026-11-18T14:00:00.000Z');

    await ingest(conn, 'same-source', { startTime });
    await ingest(conn, 'same-source', {
      startTime: new Date(startTime.getTime() + 30_000),
      distanceM: 10_050,
    });

    const rows = await rowsFor(conn);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sources).toHaveLength(1);
  });
});
