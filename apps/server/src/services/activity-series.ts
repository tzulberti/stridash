/**
 * Shared persistence for an activity's per-sample series row.
 *
 * Each provider adapter produces its own channel layout, but the storage
 * contract is identical: one `activity_data_points` row per
 * (activity, provider), with `sample_count` derived from the time base and
 * the provider payload kept as jsonb. Keeping the upsert here prevents the
 * Garmin/iGPSPORT/Zwift copies from drifting (C2).
 */

import type { Prisma, PrismaClient, Provider } from '../generated/prisma/client.js';

export interface ActivitySeriesPayload {
  timeMs: readonly number[];
}

/**
 * Persist or replace one activity's provider series. Pass the surrounding
 * transaction when called during ingest, or the Prisma singleton for re-sync
 * paths that are not already inside one.
 */
export async function upsertActivitySeries(
  activityId: string,
  provider: Provider,
  series: ActivitySeriesPayload,
  db: Prisma.TransactionClient | PrismaClient,
): Promise<void> {
  const sampleCount = series.timeMs.length;
  const payload = series as unknown as Prisma.InputJsonValue;

  await db.activityDataPoint.upsert({
    where: { activityId_provider: { activityId, provider } },
    create: { activityId, provider, sampleCount, series: payload },
    update: { sampleCount, series: payload },
  });
}
