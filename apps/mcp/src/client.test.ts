import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv, createStridashClient, StridashApiError } from './client.js';

const config = { apiUrl: 'http://stridash.local', token: 'sdat_test' };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('configFromEnv', () => {
  it('requires URL and token and trims a trailing slash', () => {
    expect(
      configFromEnv({ STRIDASH_API_URL: 'http://x/', STRIDASH_API_TOKEN: ' sdat_x ' }),
    ).toEqual({
      apiUrl: 'http://x',
      token: 'sdat_x',
    });
    expect(() => configFromEnv({})).toThrow('STRIDASH_API_URL');
    expect(() => configFromEnv({ STRIDASH_API_URL: 'http://x' })).toThrow('STRIDASH_API_TOKEN');
  });
});

describe('Stridash client', () => {
  it('lists activities with auth + query', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ id: 'a1', headline: 'Ride' }], nextCursor: null }),
    );
    const client = createStridashClient(config);

    await expect(
      client.searchActivities({ limit: 10, from: '2026-11-01T00:00:00Z' }),
    ).resolves.toMatchObject({ items: [{ id: 'a1' }] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://stridash.local/api/activities?limit=10&from=2026-11-01T00%3A00%3A00Z');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sdat_test');
  });

  it('gets activity detail, gear and connections', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ id: 'a1' }] }))
      .mockResolvedValueOnce(json({ items: [{ id: 'g1' }] }))
      .mockResolvedValueOnce(json({ items: [{ id: 'c1' }] }));
    const client = createStridashClient(config);

    await expect(client.getActivity('a1')).resolves.toMatchObject({ items: [{ id: 'a1' }] });
    await expect(client.getGear()).resolves.toMatchObject({ items: [{ id: 'g1' }] });
    await expect(client.getConnections()).resolves.toMatchObject({ items: [{ id: 'c1' }] });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://stridash.local/api/activities/a1');
  });

  it('maps API errors and network failures', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Not found' }, 404));
    const client = createStridashClient(config);
    const err = await client.getActivity('missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StridashApiError);
    expect(err).toMatchObject({ status: 404, message: 'Not found' });

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(client.getGear()).rejects.toThrow('Stridash API unreachable: offline');
  });
});
