import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OmronConnectError,
  OmronConnectV1,
  type OmronDevice,
} from '../src/providers/omron/client.js';
import { OMRON_REGIONS, regionForCountry } from '../src/providers/omron/regions.js';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const region = OMRON_REGIONS[0]!;
const device: OmronDevice = {
  deviceModel: 'HBF-703T',
  deviceSerialID: 'serial-1',
  userNumberInDevice: 1,
  category: '1',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Omron region lookup', () => {
  it('matches countries case-insensitively and rejects unknown ones', () => {
    expect(regionForCountry(' au ')).toBe(region);
    expect(regionForCountry('jp')).toBe(OMRON_REGIONS[1]);
    expect(regionForCountry('ZZ')).toBeNull();
  });
});

describe('OmronConnectV1 auth', () => {
  it('logs in and keeps the returned token pair', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'a1', refresh_token: 'r1' }));
    const client = new OmronConnectV1(region);

    await expect(client.login('rider@example.com', 'secret')).resolves.toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${region.cloudUrl}/oauth2/token`);
    expect(JSON.parse(init.body)).toEqual({
      username: 'rider@example.com',
      password: 'secret',
    });
  });

  it('rejects a failed login with the provider detail', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 401));
    await expect(new OmronConnectV1(region).login('rider', 'bad')).rejects.toMatchObject({
      status: 401,
      detail: { error: 'invalid_grant' },
    });
  });

  it('refreshes and notifies the token sink', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'a2', refresh_token: 'r2' }));
    const onTokensRefreshed = vi.fn();
    const client = new OmronConnectV1(region, { onTokensRefreshed });

    await expect(client.refresh('r1')).resolves.toEqual({
      accessToken: 'a2',
      refreshToken: 'r2',
    });
    expect(onTokensRefreshed).toHaveBeenCalledWith({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it('rejects a refresh response without a token', async () => {
    fetchMock.mockResolvedValueOnce(json({ refresh_token: 'r2' }));
    await expect(new OmronConnectV1(region).refresh('r1')).rejects.toMatchObject({
      message: 'Omron token refresh failed',
    });
  });

  it('parses gzipped bodies even when the header lies', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(gzipSync(Buffer.from(JSON.stringify({ userID: 'u1' }))), { status: 200 }),
    );
    await expect(new OmronConnectV1(region).getUser()).resolves.toEqual({ userID: 'u1' });
  });

  it('reports invalid JSON with a bounded preview', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    const err = await new OmronConnectV1(region).getUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OmronConnectError);
    expect(err).toMatchObject({
      status: 200,
      detail: { preview: 'not-json' },
    });
  });
});

describe('OmronConnectV1 data', () => {
  it('paginates devices, skips device profile 0, and dedupes', async () => {
    const page = (key: number): Response =>
      json({
        returnedValue: {
          syncList: [
            {
              deviceCategoryList: [
                {
                  deviceCategory: '1',
                  deviceModelList: [
                    {
                      deviceModel: 'HBF-703T',
                      deviceSerialIDList: [
                        { deviceSerialID: 'serial-1', userNumberInDevice: 1 },
                        { deviceSerialID: 'device-only', userNumberInDevice: 0 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          nextPaginationKey: key,
        },
      });
    fetchMock.mockResolvedValueOnce(page(555)).mockResolvedValueOnce(page(0));

    const devices = await new OmronConnectV1(region).getDevices();
    expect(devices).toEqual([device]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('filters measurements to the requested serial and flattens samples', async () => {
    const body = {
      returnedValue: {
        deviceModelList: [
          {
            deviceSerialIDList: [
              { deviceSerialID: 'serial-1', measureList: [{ measureDateTo: 1 }] },
              { deviceSerialID: 'other', measureList: [{ measureDateTo: 2 }] },
            ],
          },
        ],
      },
    };
    fetchMock.mockImplementation(async () => json(body));
    const client = new OmronConnectV1(region).withAccessToken('a1');

    await expect(client.getMeasurements(device)).resolves.toEqual([
      { deviceSerialID: 'serial-1', measureList: [{ measureDateTo: 1 }] },
    ]);
    await expect(client.getMeasureSamples(device)).resolves.toEqual([{ measureDateTo: 1 }]);

    fetchMock.mockResolvedValueOnce(json({ returnedValue: { errorCode: 'nope' } }));
    await expect(client.getMeasurements(device)).resolves.toEqual([]);
  });

  it('surfaces non-2xx responses with the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'server down' }, 500));
    await expect(new OmronConnectV1(region).getUser()).rejects.toMatchObject({
      status: 500,
      detail: { message: 'server down' },
    });
  });
});
