/**
 * Integration-test bootstrap (testcontainers). Runs before any
 * tests/integration file loads:
 *
 *  1. starts a throwaway Postgres (testcontainers, `postgres:18` — same
 *     major as docker-compose.yml). Docker required; the stopped container
 *     is reaped automatically (Ryuk) after the run.
 *  2. applies every migration with `prisma migrate deploy` against it —
 *     this is ALSO how the hand-written migrations get regression coverage
 *     on every test run.
 *  3. points process.env.DATABASE_URL at the container — db.ts reads the
 *     env at import time, so this must happen before any route module is
 *     imported. The dev database is never touched.
 *
 * The data population itself lives with the tests (api.test.ts seeds users
 * through the real API and connections/activities through prisma).
 */

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// 1: throwaway Postgres
const container = await new PostgreSqlContainer("postgres:18")
  .withDatabase("stridash_test")
  .withUsername("stridash")
  .withPassword("stridash")
  .start();

export const testDatabaseUrl = container.getConnectionUri();

// 2: real migrations, not a schema snapshot
const migrated = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: serverRoot,
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  encoding: "utf8",
});
if (migrated.status !== 0) {
  await container.stop();
  throw new Error(`prisma migrate deploy failed:\n${migrated.stdout}\n${migrated.stderr}`);
}

// 3: everything imported from here on (db.ts singleton, routes) uses the container
process.env.DATABASE_URL = testDatabaseUrl;
