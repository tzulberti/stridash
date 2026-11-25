import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IgpSportClient,
  IgpSportError,
  PATH_LOGIN,
  PATH_QUERY_ACTIVITY,
  peekJwtClaims,
} from '../src/providers/igpsport/client.js';
import { IGPSPORT_REGIONS, regionForKey } from '../src/providers/igpsport/regions.js';

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

describe('iGPSPORT regions', () => {
  it('resolves known regions and rejects unknown ones', () => {
    expect(regionForKey('intl')).toBe(IGPSPORT_REGIONS.intl);
    expect(regionForKey('cn')).toBe(IGPSPORT_REGIONS.cn);
    expect(regionForKey('xx')).toBeNull();
  });

  it('refuses the unsigned CN deployment with a clear error', () => {
    expect(() => new IgpSportClient(IGPSPORT_REGIONS.cn)).toThrow(IgpSportError);
  });
});

describe('iGPSPORT client', () => {
  it('logs in with the web app id and stores the access token', async () => {
    fetchMock.mockResolvedValue(
      json({ code: 0, data: { access_token: 'jwt-1', refresh_token: 'refresh-1' } }),
    );
    const client = new IgpSportClient(IGPSPORT_REGIONS.intl);

    await expect(client.login('rider@example.com', 'secret')).resolves.toMatchObject({
      access_token: 'jwt-1',
    });
    expect(client.currentToken()).toBe('jwt-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${IGPSPORT_REGIONS.intl.apiBase}${PATH_LOGIN}`);
    expect(init.headers.Authorization).toBe('');
    expect(JSON.parse(init.body)).toMatchObject({
      appId: 'igpsport-web',
      username: 'rider@example.com',
      password: 'secret',
    });
  });

  it('surfaces the provider login message when credentials fail', async () => {
    fetchMock.mockResolvedValue(json({ code: 401, message: 'bad password' }, 401));

    await expect(
      new IgpSportClient(IGPSPORT_REGIONS.intl).login('rider', 'wrong'),
    ).rejects.toMatchObject({
      name: 'IgpSportError',
      status: 401,
      detail: { providerMessage: 'bad password' },
    });
  });

  it('rejects invalid JSON and non-zero business envelopes', async () => {
    const client = new IgpSportClient(IGPSPORT_REGIONS.intl).withAccessToken('jwt-1');
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 502 }));
    await expect(client.listActivities()).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('Invalid JSON'),
    });

    fetchMock.mockResolvedValueOnce(json({ code: 42, message: 'quota' }));
    await expect(client.listActivities()).rejects.toMatchObject({
      status: 200,
      detail: { code: 42, message: 'quota' },
    });

    fetchMock.mockResolvedValueOnce(json({ data: [] }));
    await expect(client.listActivities()).rejects.toMatchObject({
      message: expect.stringContaining('Unexpected envelope'),
    });
  });

  it('returns list rows from both array and envelope shapes', async () => {
    const client = new IgpSportClient(IGPSPORT_REGIONS.intl).withAccessToken('jwt-1');
    fetchMock.mockResolvedValueOnce(json({ code: 0, data: [{ rideId: 1 }] }));
    await expect(client.listActivities(2, 5)).resolves.toEqual([{ rideId: 1 }]);
    expect(fetchMock.mock.calls[0][0]).toContain(
      `${PATH_QUERY_ACTIVITY}?pageNo=2&pageSize=5&reqType=0&sort=1`,
    );

    fetchMock.mockResolvedValueOnce(json({ code: 0, data: { rows: [{ rideId: 2 }] } }));
    await expect(client.listActivities()).resolves.toEqual([{ rideId: 2 }]);
  });

  it('normalizes the FIT download URL shapes', async () => {
    const client = new IgpSportClient(IGPSPORT_REGIONS.intl).withAccessToken('jwt-1');
    fetchMock.mockResolvedValueOnce(json({ code: 0, data: 'https://oss/fit-1' }));
    await expect(client.getFitDownloadUrl('1')).resolves.toBe('https://oss/fit-1');

    fetchMock.mockResolvedValueOnce(json({ code: 0, data: { url: 'https://oss/fit-2' } }));
    await expect(client.getFitDownloadUrl('2')).resolves.toBe('https://oss/fit-2');

    fetchMock.mockResolvedValueOnce(json({ code: 0, data: {} }));
    await expect(client.getFitDownloadUrl('3')).resolves.toBeNull();
  });

  it('validates FIT downloads (missing URL, HTTP error, wrong magic)', async () => {
    const client = new IgpSportClient(IGPSPORT_REGIONS.intl).withAccessToken('jwt-1');
    fetchMock.mockResolvedValueOnce(json({ code: 0, data: {} }));
    await expect(client.downloadFit('1')).rejects.toThrow('No FIT download URL');

    fetchMock.mockResolvedValueOnce(json({ code: 0, data: 'https://oss/fit' }));
    fetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(client.downloadFit('2')).rejects.toThrow('FIT download failed');

    fetchMock.mockResolvedValueOnce(json({ code: 0, data: 'https://oss/fit' }));
    fetchMock.mockResolvedValueOnce(new Response('not a fit file', { status: 200 }));
    await expect(client.downloadFit('3')).rejects.toThrow('is not a FIT file');
  });

  it('accepts a real FIT header', async () => {
    const fit = Buffer.alloc(16);
    fit.write('.FIT', 8, 'ascii');
    fetchMock.mockResolvedValueOnce(json({ code: 0, data: 'https://oss/fit' }));
    fetchMock.mockResolvedValueOnce(new Response(fit, { status: 200 }));

    await expect(new IgpSportClient(IGPSPORT_REGIONS.intl).downloadFit('4')).resolves.toEqual(fit);
  });
});

describe('peekJwtClaims', () => {
  it('reads memberid/exp and tolerates malformed tokens', () => {
    const payload = Buffer.from(JSON.stringify({ memberid: 'member-1', exp: 12345 })).toString(
      'base64url',
    );
    expect(peekJwtClaims(`x.${payload}.y`)).toEqual({ memberId: 'member-1', exp: 12345 });
    expect(peekJwtClaims('not-a-jwt')).toEqual({ memberId: '', exp: null });
  });
});
