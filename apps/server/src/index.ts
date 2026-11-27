import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, type Env } from './env.js';
import { UnauthorizedError } from './auth.js';
import { safeErrorForLog } from './redact.js';
import { prisma } from './db.js';
import { authRoutes } from './routes/auth.js';
import { connectionRoutes } from './routes/connections.js';
import { stravaRoutes } from './routes/strava.js';
import { dataRoutes } from './routes/data.js';
import { drainSyncQueue, recoverStaleSyncLocks } from './services/sync-queue.js';
import { startSyncScheduler } from './services/sync-scheduler.js';
import { openapiDocument } from './openapi.js';

/** Nothing in the API accepts a body anywhere near this — it is a DoS guard. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The production image copies the Vite build here. In dev (and when the web
 * app is deployed separately) the directory is absent, so the API runs alone.
 */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));

/** Keep the static build's headers in sync with apps/web/src/lib/security-headers.ts. */
const WEB_SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
} as const;

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// App-level context typing
type AppContext = {
  Variables: { userId: string };
};
type TypedHono = Hono<AppContext>;

/**
 * The whole HTTP app — exported so integration tests can drive the real
 * routes in-process (app.request) against a test database. No listener
 * opened here; `main()` owns that.
 */
export function createApp(env: Env): TypedHono {
  const app = new Hono<AppContext>();
  const webDist = env.STRIDASH_WEB_DIST ? path.resolve(env.STRIDASH_WEB_DIST) : DEFAULT_WEB_DIST;
  const webIndex = path.join(webDist, 'index.html');

  // ─── Cross-cutting guards ──────────────────────────────────────────────────

  // Parse-before-auth bodies (login, register, provider credentials) are
  // unbounded otherwise: @hono/node-server reads whatever the client sends.
  // Registered before the routes so a huge body is rejected before any
  // handler (and before scrypt) touches it.
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'Payload too large' }, 413),
    }),
  );

  // ─── Public ────────────────────────────────────────────────────────────────

  const BOOTED_AT = new Date();

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok' as const,
      version: env.STRIDASH_VERSION,
      // boot time makes a stale process (serving old code) obvious
      startedAt: BOOTED_AT.toISOString(),
    }),
  );

  app.get('/api/openapi.json', (c) => c.json(openapiDocument(env.STRIDASH_VERSION)));

  app.route('/api/auth', authRoutes(env));
  app.route('/api/strava', stravaRoutes(env));

  // ─── Authenticated ─────────────────────────────────────────────────────────

  const api: TypedHono = new Hono();
  api.route('/connections', connectionRoutes(env));
  api.route('/', dataRoutes(env));

  app.route('/api', api);

  // ─── Web dashboard (single-image production deployment) ───────────────────

  if (existsSync(webIndex)) {
    app.use('*', async (c, next) => {
      await next();
      if (isApiPath(c.req.path)) return;
      for (const [name, value] of Object.entries(WEB_SECURITY_HEADERS)) c.header(name, value);
      // Vite fingerprints every asset filename. Missing assets must not be
      // cached as immutable just because their URL looks fingerprinted.
      const immutable = c.res.status === 200 && c.req.path.startsWith('/assets/');
      c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    });

    app.use('*', async (c, next) => {
      if (isApiPath(c.req.path)) return next();
      return serveStatic({ root: webDist })(c, next);
    });

    // SPA fallback: client-side routes all resolve to index.html. API paths
    // and missing fingerprinted assets deliberately fall through to Hono's
    // normal 404 instead of returning HTML with a JavaScript content type.
    app.get('*', async (c, next) => {
      if (isApiPath(c.req.path) || c.req.path.startsWith('/assets/')) return next();
      return serveStatic({ path: webIndex })(c, next);
    });
  }

  // ─── Errors ────────────────────────────────────────────────────────────────

  app.onError((err, c) => {
    if (err instanceof UnauthorizedError) return c.json({ error: 'Unauthorized' }, 401);
    console.error('[error]', safeErrorForLog(err));
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}

// ─── Dev entrypoint (not exercised under vitest — argv guard) ────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error('[startup]', safeErrorForLog(err));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const env = loadEnv();

  // A previous process may have died mid-sync. Clear its stale claims before
  // accepting new work so a connection isn't blocked for the full interval.
  const recovered = await recoverStaleSyncLocks();
  if (recovered > 0) {
    console.warn(`[sync] cleared ${recovered} stale sync lock(s) from a previous process`);
  }

  const scheduler = startSyncScheduler(env);
  if (scheduler) {
    console.log(
      `[sync] scheduler enabled: active connections older than ${Math.round(env.STRIDASH_SYNC_INTERVAL_MS / 1000)}s, batch ${env.STRIDASH_SYNC_BATCH_SIZE}`,
    );
  } else {
    console.log('[sync] scheduler disabled (manual sync only)');
  }

  const server = serve({ fetch: createApp(env).fetch, port: env.PORT }, (info) => {
    console.log(
      `Stridash server v${env.STRIDASH_VERSION} listening on http://localhost:${info.port}`,
    );
    console.log(`   health: http://localhost:${info.port}/api/health`);
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received — draining sync queue (up to 30s)…`);
    scheduler?.stop();
    server.close();

    const drained = await drainSyncQueue(30_000);
    if (!drained) {
      console.warn('[sync] shutdown timeout — in-flight sync left for stale-lock takeover');
    }
    await prisma.$disconnect().catch((err) => console.error('[db] disconnect failed:', err));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
