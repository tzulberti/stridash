/**
 * Connection route unit tests — Hono app with mocked auth/db/providers.
 *
 * Focus: the provider-specific connect flows (Omron, iGPSPORT, Zwift, Garmin
 * SSO + MFA), response/error mapping, and the sync-route contract including a
 * PARTIAL history row. Integration tests already cover the real DB/lifecycle.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const { prisma, omron, igps, zwift, garmin, identity, queue } = vi.hoisted(() => {
  const prisma = {
    connection: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    syncLog: { findMany: vi.fn() },
  };
  const omron = { login: vi.fn(), getUser: vi.fn(), lastToken: '' };
  const igps = { login: vi.fn(), currentToken: vi.fn() };
  const zwift = { signIn: vi.fn(), getMe: vi.fn(), lastToken: '' };
  const garmin = {
    ssoLogin: vi.fn(),
    completeMfa: vi.fn(),
    exchange: vi.fn(),
    verify: vi.fn(),
    profile: vi.fn(),
  };
  const identity = { upsert: vi.fn() };
  const queue = { enqueue: vi.fn(), release: vi.fn() };
  return { prisma, omron, igps, zwift, garmin, identity, queue };
});

vi.mock('../src/auth.js', () => ({ requireUserId: vi.fn(async () => 'user-1') }));
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

vi.mock('../src/providers/omron/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/omron/client.js')>();
  class MockOmronConnectV1 {
    constructor(readonly region: unknown) {}
    login = omron.login;
    withAccessToken(token: string) {
      omron.lastToken = token;
      return { getUser: omron.getUser };
    }
  }
  return { ...actual, OmronConnectV1: MockOmronConnectV1 };
});

vi.mock('../src/providers/igpsport/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/igpsport/client.js')>();
  class MockIgpSportClient {
    login = igps.login;
    currentToken = igps.currentToken;
  }
  return { ...actual, IgpSportClient: MockIgpSportClient };
});

vi.mock('../src/providers/zwift/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/zwift/client.js')>();
  class MockZwiftClient {
    constructor(readonly athleteId: string) {}
    withAccessToken(token: string) {
      zwift.lastToken = token;
      return this;
    }
    getMe = zwift.getMe;
  }
  return { ...actual, ZwiftClient: MockZwiftClient, zwiftSignIn: zwift.signIn };
});

vi.mock('../src/providers/garmin/sso.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/garmin/sso.js')>();
  return {
    ...actual,
    garminSsoLogin: garmin.ssoLogin,
    completeMfa: garmin.completeMfa,
    exchangeServiceTicket: garmin.exchange,
    peekJwtExpMs: vi.fn(() => 1_900_000_000_000),
  };
});

vi.mock('../src/providers/garmin/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/garmin/api.js')>();
  return { ...actual, verifyToken: garmin.verify, getProfile: garmin.profile };
});

import { Hono } from 'hono';
import { connectionRoutes } from '../src/routes/connections.js';
import { OmronConnectError } from '../src/providers/omron/client.js';
import { IgpSportError } from '../src/providers/igpsport/client.js';
import { ZwiftError } from '../src/providers/zwift/client.js';
import { GarminError, type MfaContext } from '../src/providers/garmin/sso.js';
import type { Env } from '../src/env.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const env = {
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_JWT_SECRET: 'y'.repeat(32),
  STRIDASH_CONNECTION_RATE_LIMIT: 1_000,
  STRIDASH_CONNECTION_RATE_WINDOW_MS: 60_000,
} as unknown as Env;

const app = new Hono();
app.route('/connections', connectionRoutes(env));

type Json = Record<string, unknown>;

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

const jwt = (claims: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

const mfaContext: MfaContext = {
  flow: 'mobile',
  cookies: [],
  params: { customerGuid: 'guid' },
  method: 'email',
  serviceUrl: 'https://garmin.example/service',
  postHeaders: {},
};

const diTokens = {
  diToken: jwt({ exp: 1_900_000_000, client_id: 'client-1' }),
  diRefreshToken: 'di-refresh',
  diClientId: 'client-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  omron.login.mockReset();
  omron.getUser.mockReset();
  omron.lastToken = '';
  igps.login.mockReset();
  igps.currentToken.mockReset();
  zwift.signIn.mockReset();
  zwift.getMe.mockReset();
  zwift.lastToken = '';
  garmin.ssoLogin.mockReset();
  garmin.completeMfa.mockReset();
  garmin.exchange.mockReset();
  garmin.verify.mockReset();
  garmin.profile.mockReset();
  identity.upsert.mockReset();
  queue.enqueue.mockReset();
  queue.release.mockReset();

  prisma.connection.findMany.mockReset();
  prisma.connection.findFirst.mockReset();
  prisma.connection.findUnique.mockReset();
  prisma.connection.update.mockReset();
  prisma.connection.updateMany.mockReset();
  prisma.syncLog.findMany.mockReset();

  prisma.connection.findMany.mockResolvedValue([]);
  prisma.connection.findFirst.mockResolvedValue(null);
  prisma.connection.findUnique.mockResolvedValue(null);
  prisma.connection.update.mockResolvedValue({ id: 'conn-1', status: 'ACTIVE' });
  prisma.connection.updateMany.mockResolvedValue({ count: 1 });
  prisma.syncLog.findMany.mockResolvedValue([]);

  omron.login.mockResolvedValue({ accessToken: 'omron-access', refreshToken: 'omron-refresh' });
  omron.getUser.mockResolvedValue({ userID: 'omron-user' });
  igps.login.mockResolvedValue(undefined);
  igps.currentToken.mockReturnValue(jwt({ memberid: 'member-1', exp: 1_900_000_000 }));
  zwift.signIn.mockResolvedValue({
    accessToken: 'zwift-access',
    refreshToken: 'zwift-refresh',
    expiresIn: 3_600,
  });
  zwift.getMe.mockResolvedValue({ id: 42, firstName: 'Rider' });
  garmin.ssoLogin.mockResolvedValue({
    ticket: 'ticket-1',
    serviceUrl: 'https://garmin.example/service',
    cookies: [],
  });
  garmin.exchange.mockResolvedValue(diTokens);
  garmin.verify.mockResolvedValue(true);
  garmin.profile.mockResolvedValue({ userId: 'garmin-user' });
  garmin.completeMfa.mockResolvedValue({
    ticket: 'ticket-2',
    serviceUrl: 'https://garmin.example/service',
    cookies: [],
  });

  identity.upsert.mockImplementation(
    async (args: {
      provider: string;
      providerUserId: string;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => ({
      id: `conn-${args.provider.toLowerCase()}`,
      provider: args.provider,
      providerUserId: args.providerUserId,
      status: args.create.status ?? args.update.status ?? 'ACTIVE',
      config: args.create.config ?? args.update.config ?? null,
    }),
  );

  queue.enqueue.mockReturnValue(true);
  queue.release.mockResolvedValue(undefined);
});

// ─── Omron ───────────────────────────────────────────────────────────────────

describe('POST /connections — Omron', () => {
  it('logs in, resolves the provider identity and stores tokens/config', async () => {
    const res = await post('/connections', {
      provider: 'OMRON',
      identifier: 'scale@example.com',
      password: 'secret',
      country: 'sg',
    });

    expect(res.status).toBe(201);
    expect((await json(res)).providerUserId).toBe('omron-user');
    expect(omron.login).toHaveBeenCalledWith('scale@example.com', 'secret');
    expect(omron.lastToken).toBe('omron-access');

    const call = identity.upsert.mock.calls[0]![0] as {
      provider: string;
      providerUserId: string;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call).toMatchObject({
      userId: 'user-1',
      provider: 'OMRON',
      providerUserId: 'omron-user',
      login: 'scale@example.com',
      configKey: 'omron',
    });
    expect(call.create).toMatchObject({
      status: 'ACTIVE',
      accessTokenEnc: 'enc:omron-access',
      refreshTokenEnc: 'enc:omron-refresh',
      scopes: ['WEIGHT', 'BPM'],
      config: { omron: { country: 'SG', identifier: 'scale@example.com' } },
    });
  });

  it('falls back to the identifier when the identity endpoint fails', async () => {
    omron.getUser.mockRejectedValueOnce(new Error('profile down'));

    const res = await post('/connections', {
      provider: 'OMRON',
      identifier: 'scale@example.com',
      password: 'secret',
      country: 'AU',
    });

    expect(res.status).toBe(201);
    const call = identity.upsert.mock.calls[0]![0] as { providerUserId: string };
    expect(call.providerUserId).toBe('scale@example.com');
  });

  it('rejects unsupported countries before calling Omron', async () => {
    const res = await post('/connections', {
      provider: 'OMRON',
      identifier: 'scale@example.com',
      password: 'secret',
      country: 'US',
    });

    expect(res.status).toBe(400);
    expect(String((await json(res)).error)).toContain('Unsupported Omron region');
    expect(omron.login).not.toHaveBeenCalled();
  });

  it('maps Omron credential errors to 401', async () => {
    omron.login.mockRejectedValueOnce(new OmronConnectError('bad login', 401));

    const res = await post('/connections', {
      provider: 'OMRON',
      identifier: 'scale@example.com',
      password: 'wrong',
      country: 'SG',
    });

    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('Omron login failed');
  });
});

// ─── iGPSPORT ────────────────────────────────────────────────────────────────

describe('POST /connections — iGPSPORT', () => {
  it('persists the JWT identity and encrypted password fallback', async () => {
    const res = await post('/connections', {
      provider: 'IGPSPORT',
      username: 'rider@example.com',
      password: 'secret',
    });

    expect(res.status).toBe(201);
    expect((await json(res)).providerUserId).toBe('member-1');
    expect(igps.login).toHaveBeenCalledWith('rider@example.com', 'secret');
    const call = identity.upsert.mock.calls[0]![0] as {
      providerUserId: string;
      create: Record<string, unknown>;
    };
    expect(call.providerUserId).toBe('member-1');
    expect(call.create).toMatchObject({
      status: 'ACTIVE',
      accessTokenEnc: `enc:${igps.currentToken.mock.results[0]!.value}`,
      refreshTokenEnc: 'enc:secret',
      scopes: ['activities'],
      config: { igpsport: { region: 'intl', username: 'rider@example.com' } },
    });
  });

  it('falls back to the username when the JWT has no member claim', async () => {
    igps.currentToken.mockReturnValueOnce('not-a-jwt');

    const res = await post('/connections', {
      provider: 'IGPSPORT',
      username: 'rider@example.com',
      password: 'secret',
    });

    expect(res.status).toBe(201);
    const call = identity.upsert.mock.calls[0]![0] as { providerUserId: string };
    expect(call.providerUserId).toBe('rider@example.com');
  });

  it('rejects the CN region and maps login errors to 401', async () => {
    const cn = await post('/connections', {
      provider: 'IGPSPORT',
      username: 'rider@example.com',
      password: 'secret',
      region: 'cn',
    });
    expect(cn.status).toBe(400);
    expect(String((await json(cn)).error)).toContain('Unsupported iGPSPORT region');
    expect(igps.login).not.toHaveBeenCalled();

    igps.login.mockRejectedValueOnce(new IgpSportError('bad login', 401));
    const bad = await post('/connections', {
      provider: 'IGPSPORT',
      username: 'rider@example.com',
      password: 'wrong',
    });
    expect(bad.status).toBe(401);
    expect((await json(bad)).error).toBe('iGPSPORT login failed');
  });
});

// ─── Zwift ───────────────────────────────────────────────────────────────────

describe('POST /connections — Zwift', () => {
  it('stores the rotating refresh token and provider athlete id', async () => {
    const res = await post('/connections', {
      provider: 'ZWIFT',
      username: 'rider@example.com',
      password: 'secret',
    });

    expect(res.status).toBe(201);
    expect((await json(res)).providerUserId).toBe('42');
    expect(zwift.lastToken).toBe('zwift-access');
    const call = identity.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(call.create).toMatchObject({
      status: 'ACTIVE',
      accessTokenEnc: 'enc:zwift-access',
      refreshTokenEnc: 'enc:zwift-refresh',
      scopes: ['activities'],
      config: { zwift: { username: 'rider@example.com' } },
    });
  });

  it('falls back to the username when /me fails', async () => {
    zwift.getMe.mockRejectedValueOnce(new Error('profile down'));

    const res = await post('/connections', {
      provider: 'ZWIFT',
      username: 'rider@example.com',
      password: 'secret',
    });

    expect(res.status).toBe(201);
    const call = identity.upsert.mock.calls[0]![0] as { providerUserId: string };
    expect(call.providerUserId).toBe('rider@example.com');
  });

  it('maps credential failures to 401 and connection failures to 502', async () => {
    zwift.signIn.mockRejectedValueOnce(
      new ZwiftError('CREDENTIALS', 'invalid_grant', 401, { token: 'leak-me' }),
    );
    const credentials = await post('/connections', {
      provider: 'ZWIFT',
      username: 'rider@example.com',
      password: 'wrong',
    });
    expect(credentials.status).toBe(401);
    const body = await json(credentials);
    expect(String(body.error)).toContain('Zwift login failed');
    expect(body.kind).toBe('CREDENTIALS');
    expect(JSON.stringify(body)).not.toContain('leak-me');

    zwift.signIn.mockRejectedValueOnce(new ZwiftError('CONNECTION', 'upstream down'));
    const outage = await post('/connections', {
      provider: 'ZWIFT',
      username: 'rider@example.com',
      password: 'secret',
    });
    expect(outage.status).toBe(502);
  });
});

// ─── Garmin SSO + MFA ────────────────────────────────────────────────────────

describe('POST /connections — Garmin', () => {
  it('exchanges the ticket, verifies the DI token and stores the session', async () => {
    const res = await post('/connections', {
      provider: 'GARMIN',
      email: 'rider@example.com',
      password: 'secret',
    });

    expect(res.status).toBe(201);
    expect((await json(res)).providerUserId).toBe('garmin-user');
    expect(garmin.ssoLogin).toHaveBeenCalledWith('rider@example.com', 'secret');
    expect(garmin.verify).toHaveBeenCalledWith(diTokens.diToken);
    const call = identity.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(call.create).toMatchObject({
      status: 'ACTIVE',
      accessTokenEnc: `enc:${diTokens.diToken}`,
      refreshTokenEnc: 'enc:di-refresh',
      scopes: ['activities'],
      config: { garmin: { email: 'rider@example.com', diClientId: 'client-1' } },
    });
  });

  it('falls back to the email when the profile call fails', async () => {
    garmin.profile.mockRejectedValueOnce(new Error('profile down'));

    const res = await post('/connections', {
      provider: 'GARMIN',
      email: 'rider@example.com',
      password: 'secret',
    });

    expect(res.status).toBe(201);
    const call = identity.upsert.mock.calls[0]![0] as { providerUserId: string };
    expect(call.providerUserId).toBe('rider@example.com');
  });

  it('parks a pending MFA session and returns 202', async () => {
    garmin.ssoLogin.mockResolvedValueOnce(mfaContext);

    const res = await post('/connections', {
      provider: 'GARMIN',
      email: 'rider@example.com',
      password: 'secret',
    });

    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({ mfaRequired: true, method: 'email' });
    const call = identity.upsert.mock.calls[0]![0] as {
      providerUserId: string;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.providerUserId).toBe('rider@example.com');
    expect(call.create).toMatchObject({
      status: 'PENDING',
      refreshTokenEnc: `enc:${JSON.stringify(mfaContext)}`,
      config: { garmin: { email: 'rider@example.com', pendingMfaMethod: 'email' } },
    });
    expect(call.update).toMatchObject({ status: 'PENDING', accessTokenEnc: null });
  });

  it('maps Garmin login failures by kind', async () => {
    garmin.ssoLogin.mockRejectedValueOnce(new GarminError('CREDENTIALS', 'bad password'));
    expect(
      (
        await post('/connections', {
          provider: 'GARMIN',
          email: 'rider@example.com',
          password: 'wrong',
        })
      ).status,
    ).toBe(401);

    garmin.ssoLogin.mockRejectedValueOnce(new GarminError('RATE_LIMITED', 'slow down'));
    expect(
      (
        await post('/connections', {
          provider: 'GARMIN',
          email: 'rider@example.com',
          password: 'secret',
        })
      ).status,
    ).toBe(429);

    garmin.ssoLogin.mockRejectedValueOnce(new GarminError('FLOW', 'unexpected page'));
    expect(
      (
        await post('/connections', {
          provider: 'GARMIN',
          email: 'rider@example.com',
          password: 'secret',
        })
      ).status,
    ).toBe(502);
  });

  it('rejects a token exchange or API-tier verification failure', async () => {
    garmin.exchange.mockRejectedValueOnce(new GarminError('FLOW', 'exchange broke'));
    expect(
      (
        await post('/connections', {
          provider: 'GARMIN',
          email: 'rider@example.com',
          password: 'secret',
        })
      ).status,
    ).toBe(502);
    expect(identity.upsert).not.toHaveBeenCalled();

    garmin.verify.mockResolvedValueOnce(false);
    const rejected = await post('/connections', {
      provider: 'GARMIN',
      email: 'rider@example.com',
      password: 'secret',
    });
    expect(rejected.status).toBe(502);
    expect(String((await json(rejected)).error)).toContain('rejected by API tier');
    expect(identity.upsert).not.toHaveBeenCalled();
  });
});

describe('POST /connections/:id/mfa', () => {
  const id = randomUUID();

  function pendingConnection(refreshTokenEnc = `enc:${JSON.stringify(mfaContext)}`) {
    return {
      id,
      userId: 'user-1',
      provider: 'GARMIN',
      providerUserId: 'rider@example.com',
      status: 'PENDING',
      refreshTokenEnc,
      config: { garmin: { email: 'rider@example.com' } },
    };
  }

  it('completes the pending login and activates the connection', async () => {
    prisma.connection.findFirst.mockResolvedValueOnce(pendingConnection());
    prisma.connection.update.mockResolvedValueOnce({
      id,
      provider: 'GARMIN',
      providerUserId: 'garmin-user',
      status: 'ACTIVE',
    });

    const res = await post(`/connections/${id}/mfa`, { code: '123456' });

    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe('ACTIVE');
    expect(garmin.completeMfa).toHaveBeenCalledWith(mfaContext, '123456');
    const update = prisma.connection.update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ id });
    expect(update.data).toMatchObject({
      status: 'ACTIVE',
      providerUserId: 'garmin-user',
      accessTokenEnc: `enc:${diTokens.diToken}`,
      refreshTokenEnc: 'enc:di-refresh',
      config: { garmin: { email: 'garmin-user', diClientId: 'client-1' } },
    });
  });

  it('maps a wrong code to 401 and keeps the pending state', async () => {
    prisma.connection.findFirst.mockResolvedValueOnce(pendingConnection());
    garmin.completeMfa.mockRejectedValueOnce(new GarminError('CREDENTIALS', 'wrong code'));

    const res = await post(`/connections/${id}/mfa`, { code: '000000' });

    expect(res.status).toBe(401);
    expect(prisma.connection.update).not.toHaveBeenCalled();
  });

  it('returns 404/409/400 for missing, non-pending and malformed requests', async () => {
    expect((await post(`/connections/${randomUUID()}/mfa`, { code: '1' })).status).toBe(404);
    expect((await post('/connections/not-a-uuid/mfa', { code: '1' })).status).toBe(400);

    prisma.connection.findFirst.mockResolvedValueOnce({
      ...pendingConnection(),
      status: 'ACTIVE',
    });
    expect((await post(`/connections/${id}/mfa`, { code: '1' })).status).toBe(409);

    prisma.connection.findFirst.mockResolvedValueOnce(pendingConnection('not-json{'));
    expect((await post(`/connections/${id}/mfa`, { code: '1' })).status).toBe(409);

    expect((await post(`/connections/${id}/mfa`, {})).status).toBe(400);
  });

  it('surfaces a post-MFA token exchange or verification failure', async () => {
    prisma.connection.findFirst.mockResolvedValueOnce(pendingConnection());
    garmin.exchange.mockRejectedValueOnce(new GarminError('FLOW', 'exchange broke'));
    expect((await post(`/connections/${id}/mfa`, { code: '1' })).status).toBe(502);

    prisma.connection.findFirst.mockResolvedValueOnce(pendingConnection());
    garmin.verify.mockResolvedValueOnce(false);
    const rejected = await post(`/connections/${id}/mfa`, { code: '1' });
    expect(rejected.status).toBe(502);
    expect(String((await json(rejected)).error)).toContain('after MFA');
  });
});

// ─── Sync route + history ────────────────────────────────────────────────────

describe('POST /connections/:id/sync and history', () => {
  it('claims an active connection and queues the worker', async () => {
    const id = randomUUID();
    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      userId: 'user-1',
      provider: 'IGPSPORT',
      status: 'ACTIVE',
    });

    const res = await post(`/connections/${id}/sync`, {});

    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({ status: 'queued', inProgress: true });
    expect(prisma.connection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id, userId: 'user-1', status: 'ACTIVE' }),
        data: { syncStartedAt: expect.any(Date) },
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ connectionId: id, claimedAt: expect.any(Date) }),
    );
    expect(queue.release).not.toHaveBeenCalled();
  });

  it('returns 501 for providers without a sync path', async () => {
    prisma.connection.findFirst.mockResolvedValueOnce({
      id: randomUUID(),
      userId: 'user-1',
      provider: 'STRAVA',
      status: 'ACTIVE',
    });
    const res = await post(`/connections/${randomUUID()}/sync`, {});
    expect(res.status).toBe(501);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('handles claim races: gone, inactive, or already running', async () => {
    const id = randomUUID();
    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      userId: 'user-1',
      provider: 'ZWIFT',
      status: 'ACTIVE',
    });
    prisma.connection.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.connection.findFirst.mockResolvedValueOnce(null);
    expect((await post(`/connections/${id}/sync`, {})).status).toBe(404);

    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      userId: 'user-1',
      provider: 'ZWIFT',
      status: 'ACTIVE',
    });
    prisma.connection.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      status: 'REVOKED',
      syncStartedAt: null,
    });
    expect((await post(`/connections/${id}/sync`, {})).status).toBe(409);

    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      userId: 'user-1',
      provider: 'ZWIFT',
      status: 'ACTIVE',
    });
    prisma.connection.updateMany.mockResolvedValueOnce({ count: 0 });
    const startedAt = new Date();
    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      status: 'ACTIVE',
      syncStartedAt: startedAt,
    });
    const running = await post(`/connections/${id}/sync`, {});
    expect(running.status).toBe(409);
    expect((await json(running)).startedAt).toBe(startedAt.toISOString());
  });

  it('releases a stale-takeover claim when the in-process queue rejects it', async () => {
    const id = randomUUID();
    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      userId: 'user-1',
      provider: 'GARMIN',
      status: 'ACTIVE',
    });
    queue.enqueue.mockReturnValueOnce(false);

    const res = await post(`/connections/${id}/sync`, {});

    expect(res.status).toBe(409);
    expect(queue.release).toHaveBeenCalledWith(id, expect.any(Date));
  });

  it('exposes PARTIAL history rows and stale-lock state', async () => {
    const id = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);
    prisma.connection.findFirst.mockResolvedValueOnce({
      id,
      status: 'ACTIVE',
      syncStartedAt: startedAt,
    });
    prisma.syncLog.findMany.mockResolvedValueOnce([
      {
        id: 'log-1',
        kind: 'ACTIVITIES',
        status: 'PARTIAL',
        itemsPulled: 3,
        itemsCreated: 2,
        errorDetail: { failedRides: ['r1'] },
      },
    ]);

    const res = await app.request(`/connections/${id}/syncs`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.inProgress).toBe(true);
    expect(body.connectionStatus).toBe('ACTIVE');
    expect((body.items as Json[])[0]).toMatchObject({
      status: 'PARTIAL',
      itemsPulled: 3,
      itemsCreated: 2,
    });
  });
});
