/** Long-lived per-user API tokens (`sdat_…`) for MCP/automation clients. */

import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db.js';

const TOKEN_PREFIX = 'sdat_';
const TOKEN_BYTES = 32;
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export interface ApiTokenMetadata {
  id: string;
  name: string;
  prefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export function hashApiToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function isApiToken(raw: string): boolean {
  return raw.startsWith(TOKEN_PREFIX);
}

export async function createApiToken(
  userId: string,
  name: string,
  expiresAt: Date | null,
): Promise<{ token: string; item: ApiTokenMetadata }> {
  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  const item = await prisma.apiToken.create({
    data: {
      userId,
      name,
      tokenHash: hashApiToken(token),
      prefix: token.slice(0, TOKEN_PREFIX.length + 4),
      expiresAt,
    },
    select: {
      id: true,
      name: true,
      prefix: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
  return { token, item };
}

/** Resolve an API token to its user; updates lastUsedAt at most every 5 min. */
export async function verifyApiToken(raw: string): Promise<string | null> {
  if (!isApiToken(raw)) return null;
  const row = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(raw) },
    select: { id: true, userId: true, expiresAt: true, lastUsedAt: true },
  });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  const now = new Date();
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await prisma.apiToken
      .updateMany({
        where: {
          id: row.id,
          OR: [
            { lastUsedAt: null },
            { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_THROTTLE_MS) } },
          ],
        },
        data: { lastUsedAt: now },
      })
      .catch(() => undefined);
  }
  return row.userId;
}

export async function listApiTokens(userId: string): Promise<ApiTokenMetadata[]> {
  const rows = await prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
  return rows;
}

export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  const result = await prisma.apiToken.deleteMany({ where: { id, userId } });
  return result.count > 0;
}
