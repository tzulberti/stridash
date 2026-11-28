import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { api, setTokenListener, tryRefresh, type TokenListener } from './api';
import { readToken, saveTokens, storedRefreshToken } from './token-storage';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

function withStorage() {
  const local = memoryStorage();
  const session = memoryStorage();
  vi.stubGlobal('window', { localStorage: local, sessionStorage: session });
  return { local, session };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let listener: Mock<TokenListener>;

beforeEach(() => {
  listener = vi.fn<TokenListener>();
  setTokenListener(listener);
  withStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('sends the auth header, query and JSON body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api<{ ok: boolean }>('/activities', {
        token: 'token-1',
        method: 'POST',
        query: { limit: '5', cursor: 'abc def' },
        body: { note: 'hi' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith('/api/activities?limit=5&cursor=abc+def', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-1',
      },
      body: JSON.stringify({ note: 'hi' }),
    });
  });

  it('falls back to the stored token and omits Content-Type on GET', async () => {
    saveTokens('stored-access', 'refresh', true);
    const fetchMock = vi.fn<typeof fetch>(async () => json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/activities');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer stored-access' },
    });
  });

  it('throws the provider error and string detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Bad input', detail: 'nope' }, 400)),
    );
    await expect(api('/activities')).rejects.toThrow('Bad input — nope');
  });

  it('refreshes once on 401, replays with the new token, and updates the store', async () => {
    saveTokens('old-access', 'old-refresh', true);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'expired' }, 401))
      .mockResolvedValueOnce(json({ accessToken: 'new-access', refreshToken: 'new-refresh' }))
      .mockResolvedValueOnce(json({ items: [1] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api<{ items: number[] }>('/activities')).resolves.toEqual({ items: [1] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/refresh');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/activities');
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({
      headers: { Authorization: 'Bearer new-access' },
    });
    expect(listener).toHaveBeenCalledWith('new-access');
    expect(readToken()).toBe('new-access');
    expect(storedRefreshToken()).toBe('new-refresh');
  });

  it('does not refresh on auth endpoints', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'Invalid credentials' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toThrow(
      'Invalid credentials',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears tokens when the refresh token is dead', async () => {
    saveTokens('old-access', 'dead-refresh', true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ error: 'expired' }, 401))
        .mockResolvedValueOnce(json({ error: 'dead' }, 401)),
    );

    await expect(api('/activities')).rejects.toThrow('expired');
    expect(readToken()).toBeNull();
    expect(storedRefreshToken()).toBeNull();
  });

  it('keeps tokens on a transient refresh failure', async () => {
    saveTokens('old-access', 'live-refresh', true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ error: 'expired' }, 401))
        .mockResolvedValueOnce(json({ error: 'busy' }, 503)),
    );

    await expect(api('/activities')).rejects.toThrow('expired');
    expect(readToken()).toBe('old-access');
    expect(storedRefreshToken()).toBe('live-refresh');
  });
});

describe('tryRefresh', () => {
  it('shares one refresh between concurrent callers', async () => {
    saveTokens('old-access', 'refresh-1', true);
    const fetchMock = vi.fn(async () =>
      json({ accessToken: 'new-access', refreshToken: 'refresh-2' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(Promise.all([tryRefresh(), tryRefresh()])).resolves.toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns false without a stored refresh token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(tryRefresh()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
