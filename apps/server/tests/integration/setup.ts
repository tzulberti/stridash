/**
 * Integration-test bootstrap. Runs before any tests/integration file loads:
 *
 *  1. derives a throwaway database URL (`stridash_test`) from the deployment
 *     DATABASE_URL (apps/server/.env) — same Postgres instance, isolated data
 *  2. drops + recreates it, then applies every migration with
 *     `prisma migrate deploy` (this is ALSO how the hand-written migrations
 *     get regression coverage on every test run)
 *  3. points process.env.DATABASE_URL at the test DB — db.ts reads the env at
 *     import time, so this must happen before any route module is imported
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

const serverRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// minimal .env parse — the app's own loadEnv runs inside the test process
function databaseUrlFromDotEnv(): string {
  const fromProcess = process.env.DATABASE_URL;
  if (fromProcess) return fromProcess;
  const line = readFileSync(path.join(serverRoot, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("No DATABASE_URL — set it or create apps/server/.env");
  return line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
}

const base = databaseUrlFromDotEnv();
export const testDatabaseUrl = base.replace(/\/[^/?]+(\?|$)/, "/stridash_test$1");

// 1 + 2: fresh throwaway database with every migration applied
{
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS stridash_test WITH (FORCE)");
  await admin.query("CREATE DATABASE stridash_test");
  await admin.end();

  const migrated = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    encoding: "utf8",
  });
  if (migrated.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${migrated.stdout}\n${migrated.stderr}`);
  }
}

// 3: everything imported from here on (db.ts singleton, routes) uses the test DB
process.env.DATABASE_URL = testDatabaseUrl;
