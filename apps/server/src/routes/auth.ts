import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { issueTokens, revokeRefreshToken, rotateRefreshToken } from '../auth.js';
import { clientKey, FixedWindowLimiter } from '../rate-limit.js';
import type { Env } from '../env.js';

/**
 * Fields safe to return to a client. Deliberately excludes `authIdentities`
 * (which carries the password hash) and every secret-ish column — a login
 * response must never become an offline-cracking oracle.
 */
const publicUserSelect = {
  id: true,
  email: true,
  displayName: true,
  heightCm: true,
  dateOfBirth: true,
  sex: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8, 'Minimum 8 characters').max(1024),
});

const registerSchema = credentialsSchema.extend({
  displayName: z.string().min(1).max(80),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});

/** DB error keys for the unique-constraint on users.email */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

function tooManyRequests(c: Context, retryAfterS: number): Response {
  c.header('Retry-After', String(retryAfterS));
  return c.json({ error: 'Too many requests — try again later' }, 429);
}

export function authRoutes(env: Env): Hono {
  const routes = new Hono();

  // Per-IP bucket for the whole auth surface (register/login/refresh/logout),
  // plus a narrower per-email bucket for password guessing. In-process state
  // is fine for the single-node self-hosted model; both are configurable.
  const ipLimiter = new FixedWindowLimiter(
    env.STRIDASH_AUTH_RATE_LIMIT,
    env.STRIDASH_AUTH_RATE_WINDOW_MS,
  );
  const loginLimiter = new FixedWindowLimiter(
    env.STRIDASH_LOGIN_RATE_LIMIT,
    env.STRIDASH_AUTH_RATE_WINDOW_MS,
  );

  routes.use('*', async (c, next) => {
    const result = ipLimiter.consume(clientKey(c, env.STRIDASH_TRUST_PROXY));
    if (!result.allowed) return tooManyRequests(c, result.retryAfterS);
    await next();
  });

  routes.post('/register', async (c) => {
    const body = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }

    try {
      const user = await prisma.user.create({
        data: {
          email: body.data.email.toLowerCase(),
          displayName: body.data.displayName,
          authIdentities: {
            create: { kind: 'PASSWORD', secretHash: await hashPassword(body.data.password) },
          },
          // defaults (km, dark) — one row per user from birth
          preferences: { create: {} },
        },
        select: publicUserSelect,
      });

      const tokens = await issueTokens(user.id, env.STRIDASH_JWT_SECRET);
      return c.json({ user: { ...user, createdAt: user.createdAt.toISOString() }, ...tokens }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'Email already registered' }, 409);
      throw err;
    }
  });

  routes.post('/login', async (c) => {
    const body = credentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }

    // Cap guesses against one account even when the attacker rotates IPs.
    const emailKey = `login:${body.data.email.toLowerCase()}`;
    const perEmail = loginLimiter.consume(emailKey);
    if (!perEmail.allowed) return tooManyRequests(c, perEmail.retryAfterS);

    const user = await prisma.user.findUnique({
      where: { email: body.data.email.toLowerCase() },
      select: {
        ...publicUserSelect,
        authIdentities: {
          where: { kind: 'PASSWORD' },
          select: { secretHash: true },
        },
      },
    });

    const identity = user?.authIdentities[0];
    if (!user || !identity || !(await verifyPassword(body.data.password, identity.secretHash))) {
      // Same response for unknown email and wrong password — no user enumeration.
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    loginLimiter.reset(emailKey);

    // Strip the relation before serializing: the password hash must not leave
    // the server (the old code spread the whole Prisma row here).
    const { authIdentities, ...account } = user;
    const tokens = await issueTokens(account.id, env.STRIDASH_JWT_SECRET);
    return c.json({
      user: { ...account, createdAt: account.createdAt.toISOString() },
      ...tokens,
    });
  });

  /** Rotate a refresh token (one-time use; replay revokes the family). */
  routes.post('/refresh', async (c) => {
    const body = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }

    const tokens = await rotateRefreshToken(body.data.refreshToken, env.STRIDASH_JWT_SECRET);
    if (!tokens) return c.json({ error: 'Invalid refresh token' }, 401);
    return c.json(tokens);
  });

  /** Logout: revoke the session family. Idempotent for unknown tokens. */
  routes.post('/logout', async (c) => {
    const body = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }
    await revokeRefreshToken(body.data.refreshToken);
    return c.json({ ok: true });
  });

  return routes;
}
