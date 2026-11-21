import { describe, expect, it, vi } from 'vitest';

const { update, maybeRefresh } = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
  maybeRefresh: vi.fn(),
}));

vi.mock('../src/db.js', () => ({ prisma: { connection: { update } } }));
vi.mock('../src/crypto.js', () => ({
  decryptToken: (value: string) => value,
  encryptToken: (value: string) => value,
}));
vi.mock('../src/providers/garmin/api.js', () => ({ maybeRefresh }));

import { ensureGarminTokens } from '../src/services/garmin-tokens.js';
import type { Env } from '../src/env.js';

const env = {} as Env;

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `header.${payload}.signature`;
}

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  accessTokenEnc: 'old-token',
  refreshTokenEnc: 'refresh-token',
  status: 'ACTIVE',
  config: { garmin: { diClientId: 'client-1' } },
};

describe('ensureGarminTokens', () => {
  it('persists the refreshed JWT expiry instead of leaving it null (D8)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const refreshed = jwt(exp);
    maybeRefresh.mockResolvedValueOnce({
      fresh: false,
      tokens: { diToken: refreshed, diRefreshToken: 'next-refresh', diClientId: 'client-1' },
    });

    await expect(ensureGarminTokens(env, connection)).resolves.toBe(refreshed);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
      data: {
        accessTokenEnc: refreshed,
        refreshTokenEnc: 'next-refresh',
        tokenExpiresAt: new Date(exp * 1000),
        status: 'ACTIVE',
      },
    });
  });

  it('leaves the expiry null when the refreshed token has no exp claim', async () => {
    maybeRefresh.mockResolvedValueOnce({
      fresh: false,
      tokens: { diToken: 'opaque-token', diRefreshToken: 'next-refresh', diClientId: 'client-1' },
    });

    await ensureGarminTokens(env, connection);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
      data: expect.objectContaining({ tokenExpiresAt: null }),
    });
  });
});
