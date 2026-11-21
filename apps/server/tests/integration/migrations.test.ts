/**
 * Stepwise migration test for the provider-source identity migration.
 *
 * The normal integration setup applies every migration to an empty database,
 * so the dedupe branch in `20261118120000_activity_source_identity` never sees
 * pre-existing duplicate provenance rows. This test builds a throwaway
 * database on the same testcontainers server, applies only the migrations
 * before that one, seeds a duplicate, then applies the target migration.
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const serverRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const migrationsRoot = path.join(serverRoot, 'prisma', 'migrations');
const targetMigration = '20261118120000_activity_source_identity';

async function migrationNamesBeforeTarget(): Promise<string[]> {
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name < targetMigration)
    .map((entry) => entry.name)
    .sort();
}

async function applyMigration(client: pg.Client, name: string): Promise<void> {
  const sql = await readFile(path.join(migrationsRoot, name, 'migration.sql'), 'utf8');
  await client.query(sql);
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

describe('stepwise migrations', () => {
  it('keeps the oldest activity source and adds the unique index (T9)', async () => {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) throw new Error('DATABASE_URL is not set by the integration setup');

    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    const database = `stridash_migration_${randomUUID().replaceAll('-', '')}`;
    let client: pg.Client | undefined;

    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      client = new pg.Client({ connectionString: databaseUrl(baseUrl, database) });
      await client.connect();

      for (const migration of await migrationNamesBeforeTarget()) {
        await applyMigration(client, migration);
      }

      const userId = randomUUID();
      const connectionId = randomUUID();
      const oldestActivityId = randomUUID();
      const newerActivityId = randomUUID();
      const newestActivityId = randomUUID();
      const sourceActivityId = 'duplicate-provider-source';

      await client.query(
        `INSERT INTO "users" ("id", "email", "display_name", "updated_at")
         VALUES ($1, $2, 'Migration test', now())`,
        [userId, `${userId}@migration.test`],
      );
      await client.query(
        `INSERT INTO "connections"
           ("id", "user_id", "provider", "provider_user_id", "status", "updated_at")
         VALUES ($1, $2, 'GARMIN', 'garmin-migration-test', 'ACTIVE', now())`,
        [connectionId, userId],
      );
      await client.query(
        `INSERT INTO "activities"
           ("id", "user_id", "headline", "type", "start_time", "duration_s",
            "distance_m", "created_at", "updated_at")
         VALUES
           ($1, $4, 'Oldest', 'RIDE', '2026-11-20T08:00:00Z', 3600, 1000,
            '2026-11-20T08:00:00Z', now()),
           ($2, $4, 'Newer', 'RIDE', '2026-11-20T09:00:00Z', 3600, 1000,
            '2026-11-20T09:00:00Z', now()),
           ($3, $4, 'Newest', 'RIDE', '2026-11-20T10:00:00Z', 3600, 1000,
            '2026-11-20T10:00:00Z', now())`,
        [oldestActivityId, newerActivityId, newestActivityId, userId],
      );
      await client.query(
        `INSERT INTO "activity_sources"
           ("activity_id", "connection_id", "source_activity_id", "source_updated_at")
         VALUES
           ($1, $4, $5, now()),
           ($2, $4, $5, now()),
           ($3, $4, $5, now())`,
        [oldestActivityId, newerActivityId, newestActivityId, connectionId, sourceActivityId],
      );

      const seeded = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "activity_sources"
         WHERE "connection_id" = $1 AND "source_activity_id" = $2`,
        [connectionId, sourceActivityId],
      );
      expect(seeded.rows).toEqual([{ count: '3' }]);
      const priorIndexes = await client.query(
        `SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'activity_sources'
           AND indexname = 'activity_sources_connection_id_source_activity_id_key'`,
      );
      expect(priorIndexes.rows).toHaveLength(0);

      await applyMigration(client, targetMigration);

      const kept = await client.query<{ activity_id: string }>(
        `SELECT "activity_id" FROM "activity_sources"
         WHERE "connection_id" = $1 AND "source_activity_id" = $2`,
        [connectionId, sourceActivityId],
      );
      expect(kept.rows).toEqual([{ activity_id: oldestActivityId }]);

      const indexes = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'activity_sources'
           AND indexname = 'activity_sources_connection_id_source_activity_id_key'`,
      );
      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0]!.indexdef).toContain('UNIQUE INDEX');

      await expect(
        client.query(
          `INSERT INTO "activity_sources"
             ("activity_id", "connection_id", "source_activity_id", "source_updated_at")
           VALUES ($1, $2, $3, now())`,
          [newestActivityId, connectionId, sourceActivityId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    }
  });
});
