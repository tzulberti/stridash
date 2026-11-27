/**
 * Strava OAuth routes.
 *
 * `GET /api/strava/authorize` (authenticated) returns the consent URL.
 * `GET /api/strava/callback` is public because Strava redirects the browser;
 * the signed `state` carries the user id and is checked before any token is
 * stored. The callback always redirects back to the dashboard.
 */

import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { requireUserId, UnauthorizedError } from '../auth.js';
import { encryptToken } from '../crypto.js';
import { prisma } from '../db.js';
import {
  exchangeStravaCode,
  stravaAuthorizeUrl,
  StravaError,
  type StravaOAuthConfig,
} from '../providers/strava/client.js';
import { upsertStableConnection } from '../services/connection-identity.js';
import { enqueueConnectionSync, releaseSyncLock, SYNC_STALE_MS } from '../services/sync-queue.js';
import { FixedWindowLimiter } from '../rate-limit.js';
import { safeErrorForLog } from '../redact.js';
import type { Env } from '../env.js';

const STATE_TTL_S = 10 * 60;

type StravaState = {
  sub: string;
  typ: 'strava_oauth';
  iat: number;
  exp: number;
};

export async function signStravaState(userId: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: userId, typ: 'strava_oauth', iat: now, exp: now + STATE_TTL_S },
    secret,
    'HS256',
  );
}

export async function verifyStravaState(state: string, secret: string): Promise<string | null> {
  try {
    const payload = (await verify(state, secret, 'HS256')) as unknown as StravaState;
    if (payload.typ !== 'strava_oauth' || typeof payload.sub !== 'string') return null;
    return payload.sub;
  } catch {
    return null;
  }
}

function publicBase(env: Env, requestUrl: string): string {
  return (env.STRIDASH_PUBLIC_URL ?? new URL(requestUrl).origin).replace(/\/$/, '');
}

function redirectUri(env: Env, requestUrl: string): string {
  return env.STRIDASH_STRAVA_REDIRECT_URI ?? `${publicBase(env, requestUrl)}/api/strava/callback`;
}

function oauthConfig(env: Env, requestUrl: string): StravaOAuthConfig | null {
  if (!env.STRIDASH_STRAVA_CLIENT_ID || !env.STRIDASH_STRAVA_CLIENT_SECRET) return null;
  return {
    clientId: env.STRIDASH_STRAVA_CLIENT_ID,
    clientSecret: env.STRIDASH_STRAVA_CLIENT_SECRET,
    redirectUri: redirectUri(env, requestUrl),
  };
}

function backToConnections(env: Env, requestUrl: string, status: string): string {
  return `${publicBase(env, requestUrl)}/connections?strava=${encodeURIComponent(status)}`;
}

const connectionSelect = {
  id: true,
  provider: true,
  providerUserId: true,
  status: true,
  scopes: true,
  config: true,
  lastSyncedAt: true,
  syncStartedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function stravaRoutes(env: Env): Hono<{ Variables: { userId: string } }> {
  const routes = new Hono<{ Variables: { userId: string } }>();
  const webhookLimiter = new FixedWindowLimiter(30, 60_000);

  routes.get('/webhook', (c) => {
    const expected = env.STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN;
    if (!expected) return c.json({ error: 'Strava webhook is not configured' }, 503);
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');
    if (mode !== 'subscribe' || token !== expected || !challenge) {
      return c.json({ error: 'Invalid webhook verification' }, 403);
    }
    return c.json({ 'hub.challenge': challenge });
  });

  routes.post('/webhook', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      object_type?: string;
      aspect_type?: string;
      object_id?: number | string;
      owner_id?: number | string;
    } | null;
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    // Strava retries non-2xx; acknowledge event types we deliberately ignore.
    if (body.object_type !== 'activity' || body.owner_id == null) return c.json({ ok: true });
    if (body.aspect_type === 'delete') return c.json({ ok: true });

    const ownerId = String(body.owner_id);
    const perOwner = webhookLimiter.consume(`strava-webhook:${ownerId}`);
    if (!perOwner.allowed) {
      c.header('Retry-After', String(perOwner.retryAfterS));
      return c.json({ error: 'Too many webhook events — try again later' }, 429);
    }

    const connections = await prisma.connection.findMany({
      where: { provider: 'STRAVA', providerUserId: ownerId, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const connection of connections) {
      const claimedAt = new Date();
      const claim = await prisma.connection.updateMany({
        where: {
          id: connection.id,
          status: 'ACTIVE',
          OR: [
            { syncStartedAt: null },
            { syncStartedAt: { lt: new Date(claimedAt.getTime() - SYNC_STALE_MS) } },
          ],
        },
        data: { syncStartedAt: claimedAt },
      });
      if (claim.count === 0) continue;
      if (!enqueueConnectionSync(env, { connectionId: connection.id, claimedAt })) {
        await releaseSyncLock(connection.id, claimedAt);
      }
    }
    return c.json({ ok: true });
  });

  routes.get('/authorize', async (c) => {
    let userId: string;
    try {
      userId = await requireUserId(c, env.STRIDASH_JWT_SECRET);
    } catch (err) {
      if (err instanceof UnauthorizedError) return c.json({ error: 'Unauthorized' }, 401);
      throw err;
    }
    const config = oauthConfig(env, c.req.url);
    if (!config) {
      return c.json(
        {
          error: 'Strava OAuth is not configured',
          detail:
            'Set STRIDASH_STRAVA_CLIENT_ID and STRIDASH_STRAVA_CLIENT_SECRET (and the callback URL in the Strava app).',
        },
        503,
      );
    }
    const state = await signStravaState(userId, env.STRIDASH_JWT_SECRET);
    return c.json({ url: stravaAuthorizeUrl(config, state) });
  });

  routes.get('/callback', async (c) => {
    const requestUrl = c.req.url;
    const error = c.req.query('error');
    if (error) return c.redirect(backToConnections(env, requestUrl, 'denied'), 302);

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.redirect(backToConnections(env, requestUrl, 'error'), 302);

    const userId = await verifyStravaState(state, env.STRIDASH_JWT_SECRET);
    if (!userId) return c.redirect(backToConnections(env, requestUrl, 'error'), 302);

    const config = oauthConfig(env, requestUrl);
    if (!config) return c.redirect(backToConnections(env, requestUrl, 'unconfigured'), 302);

    let tokens;
    try {
      tokens = await exchangeStravaCode(config, code);
    } catch (err) {
      console.error('[strava] OAuth exchange failed:', safeErrorForLog(err));
      const status = err instanceof StravaError && err.kind === 'RATE_LIMIT' ? 'rate' : 'error';
      return c.redirect(backToConnections(env, requestUrl, status), 302);
    }

    const athleteId = tokens.athlete?.id;
    if (athleteId == null) {
      console.error('[strava] OAuth exchange returned no athlete id');
      return c.redirect(backToConnections(env, requestUrl, 'error'), 302);
    }
    const athleteIdStr = String(athleteId);
    const username = tokens.athlete?.username?.trim() || athleteIdStr;
    const configData = {
      strava: {
        athleteId: athleteIdStr,
        username,
        name: [tokens.athlete?.firstname, tokens.athlete?.lastname].filter(Boolean).join(' '),
      },
    };

    await upsertStableConnection({
      userId,
      provider: 'STRAVA',
      providerUserId: athleteIdStr,
      login: username,
      configKey: 'strava',
      loginField: 'athleteId',
      create: {
        status: 'ACTIVE',
        accessTokenEnc: encryptToken(tokens.accessToken, env),
        refreshTokenEnc: encryptToken(tokens.refreshToken, env),
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        config: configData as never,
      },
      update: {
        status: 'ACTIVE',
        accessTokenEnc: encryptToken(tokens.accessToken, env),
        refreshTokenEnc: encryptToken(tokens.refreshToken, env),
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        config: configData as never,
      },
      select: connectionSelect,
    });

    // Best-effort: a stale pending row for the same account is cleared too.
    await prisma.connection
      .updateMany({
        where: { userId, provider: 'STRAVA', status: 'PENDING' },
        data: { status: 'REVOKED' },
      })
      .catch(() => undefined);

    return c.redirect(backToConnections(env, requestUrl, 'connected'), 302);
  });

  return routes;
}
