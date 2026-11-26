import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeStravaCode,
  refreshStravaToken,
  stravaAuthorizeUrl,
  StravaClient,
  StravaError,
  STRAVA_TOKEN_URL,
} from '../src/providers/strava/client.js';

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  redirectUri: 'https://stridash.example/api/strava/callback',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('stravaAuthorizeUrl', () => {
  it('builds the consent URL with scopes and state', () => {
    const url = new URL(stravaAuthorizeUrl(config, 'state-1'));
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('scope')).toBe('read,activity:read_all,profile:read_all');
    expect(url.searchParams.get('state')).toBe('state-1');
  });
});

describe('Strava token grants', () => {
  it('exchanges an authorization code and normalises expiry/scopes', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: 1_900_000_000,
        scope: 'read,activity:read_all',
        athlete: { id: 42, username: 'rider' },
      }),
    );

    const tokens = await exchangeStravaCode(config, 'code-1');

    expect(tokens).toMatchObject({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date(1_900_000_000_000),
      scopes: ['read', 'activity:read_all'],
      athlete: { id: 42 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(STRAVA_TOKEN_URL);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_secret')).toBe('secret-1');
  });

  it('refreshes a token and keeps the old refresh token when omitted', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'at2', expires_in: 3600 }));

    const tokens = await refreshStravaToken(config, 'old-refresh');

    expect(tokens).toMatchObject({ accessToken: 'at2', refreshToken: 'old-refresh' });
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1].body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
  });

  it('maps rejected credentials and rate limits', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(exchangeStravaCode(config, 'bad')).rejects.toMatchObject({
      name: 'StravaError',
      kind: 'CREDENTIALS',
      status: 400,
    });

    fetchMock.mockResolvedValueOnce(json({ error: 'rate limit' }, 429));
    const err = await refreshStravaToken(config, 'rt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaError);
    expect(err).toMatchObject({ kind: 'RATE_LIMIT', status: 429 });
  });

  it('rejects a non-JSON / missing access token response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 200 }));
    await expect(exchangeStravaCode(config, 'c')).rejects.toMatchObject({
      kind: 'CONNECTION',
      message: expect.stringContaining('no access_token'),
    });
  });
});

describe('StravaClient', () => {
  it('lists activities with page/after parameters and a bearer token', async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 1, type: 'Ride' }]));
    const client = new StravaClient('access-1');

    const rows = await client.listActivities({ after: 100, page: 2, perPage: 50 });

    expect(rows).toEqual([{ id: 1, type: 'Ride' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe('/api/v3/athlete/activities');
    expect(u.searchParams.get('after')).toBe('100');
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('per_page')).toBe('50');
    expect(init.headers.Authorization).toBe('Bearer access-1');
  });

  it('fetches activity detail, streams and gear', async () => {
    const client = new StravaClient('a');
    fetchMock
      .mockResolvedValueOnce(json({ id: 1, gear_id: 'b1' }))
      .mockResolvedValueOnce(json({ time: { data: [0, 1] } }))
      .mockResolvedValueOnce(json({ id: 'b1', name: 'Bike' }));

    await expect(client.getActivity(1)).resolves.toMatchObject({ gear_id: 'b1' });
    await expect(client.getActivityStreams(1, ['time'])).resolves.toMatchObject({
      time: { data: [0, 1] },
    });
    await expect(client.getGear('b1')).resolves.toMatchObject({ name: 'Bike' });

    expect(String(fetchMock.mock.calls[1]![0])).toContain('keys=time');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('key_by_type=true');
    expect(String(fetchMock.mock.calls[2]![0])).toContain('/gear/b1');
  });

  it('maps API statuses to credential/rate-limit errors', async () => {
    const client = new StravaClient('a');

    fetchMock.mockResolvedValueOnce(new Response('expired', { status: 401 }));
    await expect(client.listActivities()).rejects.toMatchObject({
      kind: 'CREDENTIALS',
      status: 401,
    });

    fetchMock.mockResolvedValueOnce(
      json({ message: 'Rate Limit Exceeded' }, 429, { 'retry-after': '60' }),
    );
    await expect(client.getActivity(1)).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
  });

  it('maps network failures to CONNECTION errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(new StravaClient('a').listActivities()).rejects.toMatchObject({
      kind: 'CONNECTION',
      message: expect.stringContaining('offline'),
    });
  });
});
