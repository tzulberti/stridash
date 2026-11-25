import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  zwiftSignIn,
  zwiftRefresh,
  ZwiftClient,
  ZwiftError,
  ZWIFT_API_BASE,
  ZWIFT_AUTH_URL,
} from '../src/providers/zwift/client.js';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Zwift auth client', () => {
  it('signs in with the game-client password grant', async () => {
    fetchMock.mockResolvedValue(
      json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    );

    await expect(zwiftSignIn('rider@example.com', 'secret')).resolves.toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 3600,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ZWIFT_AUTH_URL);
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body);
    expect(body.get('client_id')).toBe('Zwift Game Client');
    expect(body.get('grant_type')).toBe('password');
    expect(body.get('username')).toBe('rider@example.com');
    expect(body.get('password')).toBe('secret');
  });

  it('marks 400/401/403 auth responses as credential errors', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'invalid_grant', error_description: 'Invalid user credentials' }, 401),
    );

    const err = await zwiftSignIn('rider', 'bad').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZwiftError);
    expect(err).toMatchObject({
      kind: 'CREDENTIALS',
      status: 401,
      detail: { errorCode: 'invalid_grant', message: 'Invalid user credentials' },
    });
  });

  it('keeps 5xx and network failures as connection errors', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, 503));
    await expect(zwiftSignIn('rider', 'x')).rejects.toMatchObject({
      kind: 'CONNECTION',
      status: 503,
    });

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(zwiftSignIn('rider', 'x')).rejects.toMatchObject({
      kind: 'CONNECTION',
    });
  });

  it('rejects a 200 response without an access token', async () => {
    fetchMock.mockResolvedValue(json({ refresh_token: 'only-refresh' }));
    await expect(zwiftSignIn('rider', 'x')).rejects.toMatchObject({
      kind: 'CONNECTION',
      message: expect.stringContaining('no access token'),
    });
  });

  it('rotates the refresh token, or keeps the old one when omitted', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'a2', refresh_token: 'r2' }));
    await expect(zwiftRefresh('r1')).resolves.toMatchObject({ refreshToken: 'r2' });

    fetchMock.mockResolvedValueOnce(json({ access_token: 'a3' }));
    await expect(zwiftRefresh('r2')).resolves.toMatchObject({ refreshToken: 'r2' });
  });
});

describe('ZwiftClient', () => {
  it('sends game-client headers and a bearer token on profile reads', async () => {
    fetchMock.mockResolvedValue(json({ id: 42, firstName: 'Rider' }));
    const client = new ZwiftClient('42').withAccessToken('token-1');

    await expect(client.getMe()).resolves.toMatchObject({ id: 42 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ZWIFT_API_BASE}/api/profiles/me`);
    expect(init.headers).toMatchObject({
      Platform: 'OSX',
      Source: 'Game Client',
      Authorization: 'Bearer token-1',
    });
  });

  it('returns [] for a non-array activity list', async () => {
    fetchMock.mockResolvedValue(json({ not: 'an array' }));
    await expect(new ZwiftClient('42').listActivities(0, 20)).resolves.toEqual([]);
  });

  it('classifies API 401/403 as credentials and other failures as connection', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const credentialError = await new ZwiftClient('42')
      .getActivityDetail('9')
      .catch((e: unknown) => e);
    expect(credentialError).toMatchObject({
      kind: 'CREDENTIALS',
      status: 403,
      detail: 'forbidden',
    });

    fetchMock.mockResolvedValueOnce(new Response('down', { status: 502 }));
    await expect(new ZwiftClient('42').getActivityDetail('9')).rejects.toMatchObject({
      kind: 'CONNECTION',
      status: 502,
    });
  });

  it('resolves relative fitness-data URLs against the API base', async () => {
    fetchMock.mockResolvedValueOnce(json({ timeInSec: [0, 1], powerInWatts: [100, 110] }));
    const client = new ZwiftClient('42').withAccessToken('token-1');

    await expect(client.getFitnessData('/streams/a')).resolves.toMatchObject({
      powerInWatts: [100, 110],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${ZWIFT_API_BASE}/streams/a`);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(client.getFitnessData('/streams/a')).rejects.toMatchObject({
      kind: 'CONNECTION',
    });
  });
});
