import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  DEFAULT_API_URL,
  fetchHealth,
  getApiUrl,
  loadDashboard,
  login,
  syncConnection,
} from './api';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getApiUrl', () => {
  it('defaults to localhost', () => {
    vi.stubEnv('EXPO_PUBLIC_API_URL', '');
    expect(getApiUrl()).toBe(DEFAULT_API_URL);
  });

  it('uses a trimmed configured URL', () => {
    vi.stubEnv('EXPO_PUBLIC_API_URL', '  https://stridash.example.com  ');
    expect(getApiUrl()).toBe('https://stridash.example.com');
  });
});

describe('fetchHealth', () => {
  it('hits /api/health and returns the version payload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: '1.2.3' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchHealth('https://api.example.com')).resolves.toEqual({ version: '1.2.3' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/api/health');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );

    await expect(fetchHealth('https://api.example.com')).rejects.toThrow('HTTP 503');
  });
});

describe('apiRequest', () => {
  it('adds auth, query parameters and parses JSON', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ items: [{ id: 'a1' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await apiRequest<{ items: { id: string }[] }>('/activities', {
      token: 'tok',
      query: { limit: 20, cursor: undefined },
      baseUrl: 'https://api.example.com/',
    });

    expect(out.items[0]).toEqual({ id: 'a1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/activities?limit=20');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.method).toBe('GET');
  });

  it('serializes a JSON body and surfaces the server error/status', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'a@b.c', password: 'x' },
      baseUrl: 'https://api.example.com',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'Invalid email or password' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.c', password: 'x' });
  });

  it('maps network failures to an error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    await expect(apiRequest('/me', { baseUrl: 'https://api.example.com' })).rejects.toThrow(
      'network error: offline',
    );
  });
});

describe('mobile endpoints', () => {
  it('logs in with the credentials payload', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ accessToken: 'at', refreshToken: 'rt' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(login('alice@example.com', 'secret')).resolves.toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${DEFAULT_API_URL}/api/auth/login`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'alice@example.com',
      password: 'secret',
    });
  });

  it('loads the dashboard rows in parallel', async () => {
    const bodies: Record<string, unknown> = {
      '/api/me': { email: 'a@b.c', displayName: 'Alice', createdAt: '2026-01-01' },
      '/api/connections': { items: [{ id: 'c1', provider: 'GARMIN', status: 'ACTIVE' }] },
      '/api/measurements': { items: [{ id: 'm1', weightKg: 82.5 }] },
      '/api/activities': { items: [{ id: 'a1', headline: 'Ride' }] },
      '/api/sleeps': { items: [{ dateKey: '2026-11-26', totalSleepS: 28800 }] },
      '/api/wellness': { items: [{ dateKey: '2026-11-26', steps: 10000 }] },
    };
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      const key = Object.keys(bodies)
        .sort((a, b) => b.length - a.length)
        .find((k) => path.startsWith(k));
      return new Response(JSON.stringify(key ? bodies[key] : {}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await loadDashboard('tok', 'https://api.example.com');

    expect(data.me.displayName).toBe('Alice');
    expect(data.connections[0]?.provider).toBe('GARMIN');
    expect(data.measurements[0]?.weightKg).toBe(82.5);
    expect(data.activities[0]?.headline).toBe('Ride');
    expect(data.sleeps[0]?.totalSleepS).toBe(28_800);
    expect(data.wellness[0]?.steps).toBe(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as unknown as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    }
  });

  it('queues a connection sync', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ status: 'queued' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await syncConnection('c1', 'tok');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`${DEFAULT_API_URL}/api/connections/c1/sync`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});
