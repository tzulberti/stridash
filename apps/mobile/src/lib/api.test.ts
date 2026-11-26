import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_URL, fetchHealth, getApiUrl } from './api';

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
