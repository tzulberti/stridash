import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { bodyLimit } from 'hono/body-limit';
import { pathToFileURL } from 'node:url';
import { loadEnv, type Env } from './env.js';
import { UnauthorizedError } from './auth.js';
import { safeErrorForLog } from './redact.js';
import { prisma } from './db.js';
import { authRoutes } from './routes/auth.js';
import { connectionRoutes } from './routes/connections.js';
import { dataRoutes } from './routes/data.js';
import { drainSyncQueue, recoverStaleSyncLocks } from './services/sync-queue.js';

/** Nothing in the API accepts a body anywhere near this — it is a DoS guard. */
const MAX_BODY_BYTES = 1024 * 1024;

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

  app.route('/api/auth', authRoutes(env));

  // ─── Authenticated ─────────────────────────────────────────────────────────

  const api: TypedHono = new Hono();
  api.route('/connections', connectionRoutes(env));
  api.route('/', dataRoutes(env));

  app.route('/api', api);

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
