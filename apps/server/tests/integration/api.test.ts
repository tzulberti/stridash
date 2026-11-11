/**
 * Integration-test bootstrap (testcontainers). ... (see setup.ts) — the dev
 * database and docker-compose db are never touched.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// the sync service is the network boundary — mocked so the route/DB/persistence
// contract is testable without provider credentials
const { syncIgpSportConnection } = vi.hoisted(() => ({ syncIgpSportConnection: vi.fn() }));
vi.mock('../../src/services/igpsport-sync.js', () => ({ syncIgpSportConnection }));

import { createApp } from '../../src/index.js';
import { prisma } from '../../src/db.js';
import { encryptToken } from '../../src/crypto.js';
import { IgpSportError } from '../../src/providers/igpsport/client.js';
import type { Env } from '../../src/env.js';

const env: Env = {
  DATABASE_URL: process.env.DATABASE_URL!,
  STRIDASH_JWT_SECRET: 'integration-test-jwt-secret-0123456789',
  STRIDASH_ENC_KEY: 'integration-test-enc-key-0123456789abc',
  PORT: 0,
  STRIDASH_VERSION: 'test',
};
const app = createApp(env);

type Json = Record<string, unknown>;
const json = (r: Response): Promise<Json> => r.json() as Promise<Json>;
const authed = (token: string, extra: Record<string, unknown> = {}): RequestInit => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  ...extra,
});

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
      connectionId: string,
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
      garminConnId,
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
      zwiftConnId,
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
});

// ─── Connections: lifecycle + sync contract ──────────────────────────────────

describe('connections', () => {
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

  it('a credential rejection answers 502 + reconnect message and marks ERROR', async () => {
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
    const res = await app.request(`/api/connections/${igps.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(String(body.error)).toContain('reconnect the account');
    expect(body.provider).toBe('igpsport');
    // the connection is now marked ERROR server-side
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
    expect(row.status).toBe('ERROR');
  });

  it('an unknown sync failure rethrows into the global 500 handler', async () => {
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
    const res = await app.request(`/api/connections/${igps.id}/sync`, {
      method: 'POST',
      ...authed(aliceToken, { method: 'POST' }),
    });
    expect(res.status).toBe(500);
    // unknown failures must NOT mark the connection (that's a bug, not bad creds)
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: igps.id } });
    expect(row.status).toBe('ACTIVE');
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

// ─── Gear (provider-synced gear + Stridash-managed components) ────────────────

describe('gear', () => {
  let shoesId = '';
  let bikeId = '';
  let runGearId = '';

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

    const run = await prisma.activity.findUniqueOrThrow({ where: { id: runId } });
    await prisma.activity.update({ where: { id: run.id }, data: { gearId: shoesId } });
    // silent: run distance 5100 m on 2026-11-01
    void run;
    runGearId = shoesId;
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
    await prisma.activity.create({
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

    const res = await app.request('/api/export', authed(aliceToken));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const dump = (await json(res)) as Record<string, unknown>;
    expect(dump.format).toBe('stridash-export/1');
    expect((dump.account as Record<string, unknown>).email).toBe('alice@test.stridash');
    const acts = dump.activities as Array<Record<string, unknown>>;
    const exported = acts.find((a) => a.headline === 'exportable run')!;
    expect((exported.sources as Array<Record<string, unknown>>)[0].sourceActivityId).toBe('exp-1');
    const raw = JSON.stringify(dump);
    expect(raw).not.toContain('secret-access');
    expect(raw).not.toContain('secret-refresh');
    // the exporter's own account sees nothing of alice's
    const mine = await app.request('/api/export', authed(token));
    expect(((await json(mine)) as { activities: unknown[] }).activities).toHaveLength(0);
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
