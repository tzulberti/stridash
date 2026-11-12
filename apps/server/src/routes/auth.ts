import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { issueTokens, refreshAccess } from '../auth.js';
import type { Env } from '../env.js';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Minimum 8 characters'),
});

const registerSchema = credentialsSchema.extend({
  displayName: z.string().min(1).max(80),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
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

export function authRoutes(env: Env): Hono {
  const routes = new Hono();

  routes.post('/register', async (c) => {
    const body = registerSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }

    try {
      const user = await prisma.user.create({
        data: {
          email: body.data.email.toLowerCase(),
          displayName: body.data.displayName,
          authIdentities: {
            create: { kind: 'PASSWORD', secretHash: hashPassword(body.data.password) },
          },
          // defaults (km, dark) — one row per user from birth
          preferences: { create: {} },
        },
      });

      const tokens = await issueTokens(user.id, env.STRIDASH_JWT_SECRET);
      return c.json({ user: { ...user, createdAt: user.createdAt.toISOString() }, ...tokens }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'Email already registered' }, 409);
      throw err;
    }
  });

  routes.post('/login', async (c) => {
    const body = credentialsSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);
    }

    const user = await prisma.user.findUnique({
      where: { email: body.data.email.toLowerCase() },
      include: { authIdentities: { where: { kind: 'PASSWORD' } } },
    });

    const identity = user?.authIdentities[0];
    if (!user || !identity || !verifyPassword(body.data.password, identity.secretHash)) {
      // Same response for unknown email and wrong password — no user enumeration.
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    const tokens = await issueTokens(user.id, env.STRIDASH_JWT_SECRET);
    return c.json({
      user: { ...user, createdAt: user.createdAt.toISOString() },
      ...tokens,
    });
  });

  routes.post('/refresh', async (c) => {
    const body = refreshSchema.safeParse(await c.req.json());
    if (!body.success)
      return c.json({ error: 'Invalid request', detail: body.error.flatten().fieldErrors }, 400);

    try {
      return c.json(await refreshAccess(body.data.refreshToken, env.STRIDASH_JWT_SECRET));
    } catch {
      return c.json({ error: 'Invalid refresh token' }, 401);
    }
  });

  return routes;
}
