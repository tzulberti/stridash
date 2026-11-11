/**
 * App authentication: stateless JWT pairs (access 15 min / refresh 30 d).
 *
 * M1 note: refresh tokens are long-lived stateless JWTs — simple to ship,
 * no revocation. Post-M1: store hashed refresh tokens server-side and rotate.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { verify, sign } from 'hono/jwt';
import type { Context } from 'hono';

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function issueTokens(userId: string, jwtSecret: string): Promise<TokenPair> {
  const now = Math.floor(Date.now() / 1000);
  // `jti` keeps refresh tokens unique even after rotation (prep for server-side revocation).
  const jti = randomBytes(12).toString('hex');
  const accessToken = await sign(
    { sub: userId, typ: 'access', iat: now, exp: now + ACCESS_TTL_S },
    jwtSecret,
    'HS256',
  );
  const refreshToken = await sign(
    { sub: userId, typ: 'refresh', jti, iat: now, exp: now + REFRESH_TTL_S },
    jwtSecret,
    'HS256',
  );
  return { accessToken, refreshToken };
}

export async function requireUserId(c: Context, jwtSecret: string): Promise<string> {
  let payload: Record<string, unknown>;
  try {
    payload = await verify(
      c.req.header('Authorization')?.replace('Bearer ', '') ?? '',
      jwtSecret,
      'HS256',
    );
  } catch {
    throw new UnauthorizedError();
  }
  const userId = payload.sub;
  if (typeof userId !== 'string' || payload.typ !== 'access') {
    throw new UnauthorizedError();
  }
  return userId;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export async function refreshAccess(refreshToken: string, jwtSecret: string): Promise<TokenPair> {
  const payload = await verify(refreshToken, jwtSecret, 'HS256');
  if (payload.typ !== 'refresh') throw new Error('Not a refresh token');
  const userId = payload.sub;
  if (typeof userId !== 'string') throw new Error('Invalid refresh token');
  return await issueTokens(userId, jwtSecret);
}

/** Kept for the future migration to stored/rotated refresh tokens. */
export function hashRefreshToken(token: string): string {
  return createHmac('sha256', 'stridash-refresh').update(token).digest('hex');
}
