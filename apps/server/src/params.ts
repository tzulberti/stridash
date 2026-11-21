import type { Context } from 'hono';
import { z } from 'zod';

const uuid = z.string().uuid();

/**
 * Read a UUID route parameter. Invalid values are a client error, not a
 * Prisma 500 — every `:id` route funnels through this before querying.
 */
export function uuidParam(c: Context, name = 'id'): string | null {
  const parsed = uuid.safeParse(c.req.param(name));
  return parsed.success ? parsed.data : null;
}
