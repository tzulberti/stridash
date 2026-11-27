import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { prisma, auth, identity, exchange, client, queue } = vi.hoisted(() => ({
  prisma: { connection: { updateMany: vi.fn(), findMany: vi.fn() } },
  auth: { requireUserId: vi.fn() },
  identity: { upsert: vi.fn() },
  exchange: vi.fn(),
  client: { authorizeUrl: vi.fn() },
  queue: { enqueue: vi.fn(), release: vi.fn() },
}));

vi.mock('../src/db.js', () => ({ prisma }));
vi.mock('../src/crypto.js', () => ({
  encryptToken: vi.fn((value: string) => `enc:${value}`),
  decryptToken: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));
vi.mock('../src/services/connection-identity.js', () => ({
  upsertStableConnection: identity.upsert,
}));
vi.mock('../src/services/sync-queue.js', () => ({
  enqueueConnectionSync: queue.enqueue,
  releaseSyncLock: queue.release,
  SYNC_STALE_MS: 15 * 60 * 1000,
}));
vi.mock('../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth.js')>();
  return { ...actual, requireUserId: auth.requireUserId };
});
vi.mock('../src/providers/strava/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/strava/client.js')>();
  return {
    ...actual,
    exchangeStravaCode: exchange,
    stravaAuthorizeUrl: client.authorizeUrl,
  };
});

import { signStravaState, stravaRoutes, verifyStravaState } from '../src/routes/strava.js';
import { StravaError } from '../src/providers/strava/client.js';
import { UnauthorizedError } from '../src/auth.js';
import type { Env } from '../src/env.js';

const secret = 'y'.repeat(32);
const env = {
  STRIDASH_JWT_SECRET: secret,
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_STRAVA_CLIENT_ID: 'client-1',
  STRIDASH_STRAVA_CLIENT_SECRET: 'secret-1',
  STRIDASH_PUBLIC_URL: 'https://stridash.example',
  STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN: 'hook-token',
} as unknown as Env;

const app = new Hono();
app.route('/strava', stravaRoutes(env));

const tokens = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: new Date('2027-01-01T00:00:00Z'),
  athlete: { id: 42, username: 'rider', firstname: 'A', lastname: 'B' },
  scopes: ['read', 'activity:read_all'],
};

beforeEach(() => {
  prisma.connection.updateMany.mockReset();
  prisma.connection.findMany.mockReset();
  prisma.connection.findMany.mockResolvedValue([]);
  queue.enqueue.mockReset();
  queue.release.mockReset();
  queue.enqueue.mockReturnValue(true);
  queue.release.mockResolvedValue(undefined);
  auth.requireUserId.mockReset();
  auth.requireUserId.mockResolvedValue('user-1');
  identity.upsert.mockReset();
  identity.upsert.mockImplementation(async (args: { providerUserId: string }) => ({
    id: 'conn-1',
    provider: 'STRAVA',
    providerUserId: args.providerUserId,
    status: 'ACTIVE',
  }));
  exchange.mockReset();
  exchange.mockResolvedValue(tokens);
  client.authorizeUrl.mockReset();
  client.authorizeUrl.mockReturnValue('https://www.strava.com/oauth/authorize?state=s');
  prisma.connection.updateMany.mockResolvedValue({ count: 0 });
});

describe('Strava OAuth state', () => {
  it('round-trips a signed state and rejects tampering', async () => {
    const state = await signStravaState('user-1', secret);
    expect(await verifyStravaState(state, secret)).toBe('user-1');
    expect(await verifyStravaState(`${state}x`, secret)).toBeNull();
    expect(await verifyStravaState('not-a-jwt', secret)).toBeNull();
  });
});

describe('GET /strava/authorize', () => {
  it('returns the Strava consent URL for an authenticated user', async () => {
    const res = await app.request('/strava/authorize', {
      headers: { Authorization: 'Bearer app-token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://www.strava.com/oauth/authorize?state=s' });
    expect(auth.requireUserId).toHaveBeenCalled();
    expect(client.authorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-1', clientSecret: 'secret-1' }),
      expect.any(String),
    );
  });

  it('returns 503 when the OAuth app is not configured', async () => {
    const bare = new Hono();
    bare.route(
      '/strava',
      stravaRoutes({ ...env, STRIDASH_STRAVA_CLIENT_ID: undefined } as unknown as Env),
    );
    const res = await bare.request('/strava/authorize', {
      headers: { Authorization: 'Bearer app-token' },
    });
    expect(res.status).toBe(503);
  });

  it('returns 401 without an app session', async () => {
    auth.requireUserId.mockRejectedValueOnce(new UnauthorizedError());
    const res = await app.request('/strava/authorize');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('GET /strava/callback', () => {
  it('exchanges the code, stores the connection and redirects', async () => {
    const state = await signStravaState('user-1', secret);
    const res = await app.request(`/strava/callback?code=code-1&state=${state}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://stridash.example/connections?strava=connected',
    );
    expect(exchange).toHaveBeenCalledWith(expect.any(Object), 'code-1');
    const call = identity.upsert.mock.calls[0]![0] as {
      userId: string;
      provider: string;
      providerUserId: string;
      create: Record<string, unknown>;
    };
    expect(call).toMatchObject({
      userId: 'user-1',
      provider: 'STRAVA',
      providerUserId: '42',
    });
    expect(call.create).toMatchObject({
      status: 'ACTIVE',
      accessTokenEnc: `enc:${tokens.accessToken}`,
      refreshTokenEnc: `enc:${tokens.refreshToken}`,
      tokenExpiresAt: tokens.expiresAt,
      scopes: ['read', 'activity:read_all'],
      config: { strava: { athleteId: '42', username: 'rider', name: 'A B' } },
    });
  });

  it('redirects OAuth denials and invalid state without exchanging', async () => {
    const denied = await app.request('/strava/callback?error=access_denied');
    expect(denied.headers.get('location')).toBe(
      'https://stridash.example/connections?strava=denied',
    );

    const badState = await app.request('/strava/callback?code=c&state=bad');
    expect(badState.headers.get('location')).toBe(
      'https://stridash.example/connections?strava=error',
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it('redirects exchange failures and missing athletes', async () => {
    const state = await signStravaState('user-1', secret);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    exchange.mockRejectedValueOnce(new StravaError('RATE_LIMIT', 'slow down'));
    const rate = await app.request(`/strava/callback?code=c&state=${state}`);
    expect(rate.headers.get('location')).toBe('https://stridash.example/connections?strava=rate');

    exchange.mockResolvedValueOnce({ ...tokens, athlete: null });
    const missing = await app.request(`/strava/callback?code=c&state=${state}`);
    expect(missing.headers.get('location')).toBe(
      'https://stridash.example/connections?strava=error',
    );
    errorLog.mockRestore();
  });
});

describe('Strava webhook', () => {
  it('answers the subscription challenge only with the configured token', async () => {
    const ok = await app.request(
      '/strava/webhook?hub.mode=subscribe&hub.verify_token=hook-token&hub.challenge=abc',
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ 'hub.challenge': 'abc' });

    const bad = await app.request(
      '/strava/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc',
    );
    expect(bad.status).toBe(403);
  });

  it('claims and queues an active connection for activity create/update', async () => {
    prisma.connection.findMany.mockResolvedValueOnce([{ id: 'c1' }]);
    prisma.connection.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await app.request('/strava/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        object_type: 'activity',
        aspect_type: 'create',
        object_id: 123,
        owner_id: 42,
      }),
    });

    expect(res.status).toBe(200);
    expect(prisma.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: 'STRAVA', providerUserId: '42', status: 'ACTIVE' },
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ connectionId: 'c1', claimedAt: expect.any(Date) }),
    );
  });

  it('ignores deletes/unknown owners and releases a rejected claim', async () => {
    await app.request('/strava/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object_type: 'activity', aspect_type: 'delete', owner_id: 42 }),
    });
    expect(prisma.connection.findMany).not.toHaveBeenCalled();

    const noOwner = await app.request('/strava/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object_type: 'activity', aspect_type: 'create' }),
    });
    expect(noOwner.status).toBe(200);

    prisma.connection.findMany.mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }]);
    prisma.connection.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    queue.enqueue.mockReturnValueOnce(false);
    const res = await app.request('/strava/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        object_type: 'activity',
        aspect_type: 'update',
        owner_id: 42,
      }),
    });
    expect(res.status).toBe(200);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.release).toHaveBeenCalledWith('c2', expect.any(Date));
  });
});
