/**
 * App authentication: short-lived stateless JWT access tokens + opaque,
 * rotating refresh tokens persisted (hashed) in the database.
 *
 * Why the split:
 *  - The access token is a 15-minute HS256 JWT — no DB round-trip per request.
 *  - The refresh token is a 32-byte random string stored as SHA-256; it can be
 *    revoked, rotated on every use, and a replayed token revokes its whole
 *    session family (theft detection). A DB leak only exposes hashes.
 *
 * Refresh tokens live for 30 days from creation; every rotation issues a new
 * 30-day token (sliding window) in the same family.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verify, sign } from 'hono/jwt';
import type { Context } from 'hono';
import { prisma } from './db.js';

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Prefix makes a refresh token recognizable in logs/support without decoding. */
const REFRESH_PREFIX = 'sdrt_';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function signAccessToken(userId: string, jwtSecret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: userId, typ: 'access', iat: now, exp: now + ACCESS_TTL_S },
    jwtSecret,
    'HS256',
  );
}

/** SHA-256 of the opaque token — the raw value never touches the database. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newRefreshToken(): string {
  return REFRESH_PREFIX + randomBytes(32).toString('base64url');
}

/** Insert one refresh token row and return the raw (never-persisted) value. */
async function createRefreshToken(userId: string, familyId: string): Promise<string> {
  const raw = newRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashRefreshToken(raw),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return raw;
}

/**
 * A new session (register/login): fresh family, access + refresh pair.
 */
export async function issueTokens(userId: string, jwtSecret: string): Promise<TokenPair> {
  const accessToken = await signAccessToken(userId, jwtSecret);
  const refreshToken = await createRefreshToken(userId, randomUUID());
  return { accessToken, refreshToken };
}

/**
 * Rotate a refresh token. Returns null when the token is unknown, expired,
 * revoked, or replayed (a replay also revokes the remaining family).
 */
export async function rotateRefreshToken(
  rawToken: string,
  jwtSecret: string,
): Promise<TokenPair | null> {
  if (!rawToken.startsWith(REFRESH_PREFIX)) return null; // e.g. an old JWT-based token

  const tokenHash = hashRefreshToken(rawToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row) return null;

  const now = new Date();

  if (row.revokedAt) {
    // Replay of a token that was already rotated/revoked: assume theft and
    // kill the whole family so the attacker (and the victim) must re-login.
    await revokeFamily(row.familyId).catch(() => undefined);
    return null;
  }

  if (row.expiresAt <= now) return null;

  const nextId = randomUUID();
  const nextRaw = newRefreshToken();

  const rotated = await prisma
    .$transaction(async (tx) => {
      // Conditional update: only one concurrent request can consume the token.
      const consumed = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, lastUsedAt: now, replacedBy: nextId },
      });
      if (consumed.count !== 1) return false;

      // Account might have been deleted between mint and refresh — the FK
      // would reject the insert anyway; answer 401 instead of a 500.
      const user = await tx.user.findUnique({ where: { id: row.userId }, select: { id: true } });
      if (!user) return false;

      await tx.refreshToken.create({
        data: {
          id: nextId,
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: hashRefreshToken(nextRaw),
          expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        },
      });
      return true;
    })
    .catch(() => false);

  if (!rotated) return null;

  return { accessToken: await signAccessToken(row.userId, jwtSecret), refreshToken: nextRaw };
}

/** Revoke every live token in a session family. */
export async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Logout: revoke the family that the presented token belongs to. Unknown or
 * malformed tokens are a no-op (idempotent, no oracle).
 */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  if (!rawToken.startsWith(REFRESH_PREFIX)) return;
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { familyId: true },
  });
  if (!row) return;
  await revokeFamily(row.familyId);
}

export async function requireUserId(c: Context, jwtSecret: string): Promise<string> {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new UnauthorizedError();

  let payload: Record<string, unknown>;
  try {
    payload = await verify(match[1]!, jwtSecret, 'HS256');
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
