/**
 * Integration-test bootstrap (testcontainers). Runs before any
 * tests/integration file loads:
 *
 *  1. starts a throwaway Postgres (testcontainers, `postgres:18` — same
 *     major as docker-compose.yml). Docker required.
 *  2. applies every migration with `prisma migrate deploy` against it —
 *     this is ALSO how the hand-written migrations get regression coverage
 *     on every test run.
 *  3. wipes all app tables (migrations table kept) — required for container
 *     REUSE: a reused container still holds the previous run's seed data,
 *     and tests assert against a clean-slate population.
 *  4. points process.env.DATABASE_URL at the container — db.ts reads the
 *     env at import time, so this must happen before any route module is
 *     imported. The dev database is never touched.
 *
 * Container REUSE: set STRIDASH_TEST_REUSE=1 to keep the container between
 * runs (skip re-boot + migrations, ~5.6s → ~1s). Reused containers are NOT
 * reaped by Ryuk — they persist until removed manually (`docker rm -f`), by
 * a reboot, or whenever create options change and the hash no longer
 * matches. Intended for CI runners (GitHub Actions) and repeated local
 * runs; keep it OFF when you want guaranteed-fresh containers.
 *
 * The data population itself lives with the tests (api.test.ts seeds users
 * through the real API and connections/activities through prisma).
 */

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const serverRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// 1: throwaway Postgres (reused across runs when STRIDASH_TEST_REUSE=1)
const container = await new PostgreSqlContainer('postgres:18')
  .withDatabase('stridash_test')
  .withUsername('stridash')
  .withPassword('stridash')
  .withReuse(process.env.STRIDASH_TEST_REUSE === '1')
  .start();

export const testDatabaseUrl = container.getConnectionUri();

// 2 + 3: real migrations, then a data wipe so every run starts clean
{
  const migrated = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    encoding: 'utf8',
  });
  if (migrated.status !== 0) {
    await container.stop();
    throw new Error(`prisma migrate deploy failed:\n${migrated.stdout}\n${migrated.stderr}`);
  }

  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  await client.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables
                WHERE schemaname = 'public' AND tablename <> '_prisma_migrations')
      LOOP
        EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
  await client.end();
}

// 4: everything imported from here on (db.ts singleton, routes) uses the container
process.env.DATABASE_URL = testDatabaseUrl;
