import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { loadEnv, type Env } from './env.js';
import { UnauthorizedError } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { connectionRoutes } from './routes/connections.js';
import { dataRoutes } from './routes/data.js';

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
    console.error('[error]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}

// ─── Dev entrypoint (not exercised under vitest — argv guard) ────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  serve({ fetch: createApp(env).fetch, port: env.PORT }, (info) => {
    console.log(
      `Stridash server v${env.STRIDASH_VERSION} listening on http://localhost:${info.port}`,
    );
    console.log(`   health: http://localhost:${info.port}/api/health`);
  });
}
