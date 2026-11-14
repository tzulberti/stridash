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
    expect(me.preferences).toEqual({ units: 'km', theme: 'dark', language: 'en' });
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
    expect(me.preferences).toEqual({ units: 'mi', theme: 'dark', language: 'en' });
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
    expect(me.preferences).toEqual({ units: 'mi', theme: 'dark', language: 'es' });
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
