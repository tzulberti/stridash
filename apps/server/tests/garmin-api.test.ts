import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '../src/providers/garmin/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStatus(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      status === 204 ? new Response(null, { status }) : new Response('{}', { status }),
    ),
  );
}

describe('verifyToken', () => {
  it.each([200, 201, 204])('accepts a %i response', async (status) => {
    stubStatus(status);
    await expect(verifyToken('token')).resolves.toBe(true);
  });

  it.each([301, 400, 401, 403, 429, 500, 503])('rejects a %i response', async (status) => {
    stubStatus(status);
    await expect(verifyToken('token')).resolves.toBe(false);
  });
});
