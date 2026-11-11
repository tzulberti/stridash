/**
 * Garmin sync service: page the activity list, ingest each new activity via
 * its FIT download (scalars + series), deduped user-level on
 * (userId, startTime, type, distance) with per-connection provenance in
 * activity_sources. Every run writes a sync_logs row.
 */

import { prisma } from '../db.js';
import { encryptToken, decryptToken } from '../crypto.js';
import { Prisma } from '../generated/prisma/client.js';
import { GarminError, type DiTokens } from '../providers/garmin/sso.js';
import {
  maybeRefresh,
  listActivities,
  downloadFit,
  type GarminActivityRow,
} from '../providers/garmin/api.js';
import { fitToActivity, rowToActivity, type Series } from '../providers/garmin/normalize.js';
import { extractFitFromDownload } from '../providers/garmin/fitzip.js';
import { parseFitFile } from '../providers/igpsport/fit.js';
import type { FitRecord, FitSession } from '../providers/igpsport/normalize.js';
import type { ActivityInput } from '../providers/garmin/normalize.js';
import {
  ensureGarminTokens,
  type GarminConnectionLike as ConnectionLike,
} from './garmin-tokens.js';
import type { Env } from '../env.js';

export type GarminSyncResult = {
  syncLogId: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  failedActivities: string[];
};

export async function syncGarminConnection(
  env: Env,
  connection: ConnectionLike,
): Promise<GarminSyncResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: 'ACTIVITIES', status: 'OK' },
  });
  const result: GarminSyncResult = {
    syncLogId: log.id,
    status: 'OK',
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failedActivities: [],
  };

  try {
    const bearer = await ensureGarminTokens(env, connection);
    const known = await prisma.activitySource.findMany({
      where: { connectionId: connection.id },
      select: { sourceActivityId: true },
    });
    const knownIds = new Set(known.map((s) => s.sourceActivityId));

    // Garmin pages of 20; a years-deep account needs a few thousand rows of
    // headroom (each page costs ~1 list request; FIT downloads only happen for
    // fresh ids, so rerun sweeps re-paging the list are cheap thanks to dedup)
    const NEW_PAGE_SCAN_LIMIT = Number(process.env.GARMIN_SYNC_MAX_PAGES ?? 150);
    for (let page = 0; page < NEW_PAGE_SCAN_LIMIT; page++) {
      let rows: GarminActivityRow[];
      try {
        rows = await listActivities(bearer, page * 20, 20);
      } catch (err) {
        result.status = 'PARTIAL';
        result.failedActivities.push(`page:${page}`);
        console.error(`[garmin] list page ${page} failed:`, err);
        break;
      }
      if (!rows.length) break;

      for (const row of rows) {
        result.itemsPulled++;
        const id = String(row.activityId);
        if (knownIds.has(id)) continue;
        try {
          await ingestActivity(bearer, connection, row);
          result.itemsCreated++;
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedActivities.push(id);
          console.error(`[garmin] activity ${id} ingest failed:`, err);
        }
      }

      // Stale pages (already-ingested ids) are expected on reruns and deep
      // backfills — Garmin's list is newest-first, so pages long before the
      // account's oldest activity can be stale. Only an EMPTY page means done.
    }
  } catch (err) {
    const detail =
      err instanceof GarminError
        ? { error: err.message, providerDetail: err.detail }
        : { error: String(err) };
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: 'ERROR', errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error('[garmin] sync failed:', detail);
    throw err;
  }

  await prisma.syncLog.update({
    where: { id: result.syncLogId },
    data: {
      status: result.status,
      itemsPulled: result.itemsPulled,
      itemsCreated: result.itemsCreated,
      itemsUpdated: result.itemsUpdated,
      errorDetail: (result.failedActivities.length
        ? { failed: result.failedActivities }
        : null) as never,
      finishedAt: new Date(),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date() },
  });
  return result;
}

async function ingestActivity(
  bearer: string,
  connection: ConnectionLike,
  row: GarminActivityRow,
): Promise<void> {
  const id = String(row.activityId);

  let records: FitRecord[] = [];
  let session: FitSession | null = null;
  try {
    const fit = await downloadFit(bearer, id);
    ({ records, session } = await parseFitFile(extractFitFromDownload(fit)));
  } catch (err) {
    // NOTE: surfaces in sync logs as PARTIAL for that id — never fatal
    console.error(`[garmin] FIT unavailable/failed for activity ${id} — using list summary`, err);
  }

  if (records.length === 0) {
    console.warn(`[garmin] activity ${id} ingested WITHOUT a series (FIT empty/unparsed)`);
  }

  const typeKey = (row.activityType?.typeKey ?? '').toLowerCase();
  const extraIndoor =
    /virtual|indoor|treadmill/.test(typeKey) ||
    (typeKey === 'cycling' && !records.some((r) => r.latDeg !== undefined));

  const parsed = records.length
    ? fitToActivity(row, records, { indoor: extraIndoor, session })
    : null;
  if (parsed) {
    await upsertActivity(connection, id, parsed.activity, parsed.series);
    return;
  }
  if (!row.startTimeGMT) {
    throw new GarminError(
      'CONNECTION',
      `Garmin activity ${id} has neither FIT data nor a start time`,
    );
  }
  await upsertActivity(connection, id, rowToActivity(row), null);
}

async function upsertActivity(
  connection: ConnectionLike,
  garminId: string,
  activity: ActivityInput,
  series: Series | null,
): Promise<void> {
  const dup = await prisma.activity.findFirst({
    where: {
      userId: connection.userId,
      startTime: activity.startTime,
      type: activity.type,
      distanceM: activity.distanceM ?? undefined,
    },
    select: { id: true },
  });

  if (dup) {
    await prisma.activitySource.upsert({
      where: { activityId_connectionId: { activityId: dup.id, connectionId: connection.id } },
      create: {
        activityId: dup.id,
        connectionId: connection.id,
        sourceActivityId: garminId,
        sourceUpdatedAt: new Date(),
      },
      update: { sourceActivityId: garminId, sourceUpdatedAt: new Date() },
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const created = await tx.activity.create({
      data: toActivityCreate(connection.userId, activity),
    });

    await tx.activitySource.upsert({
      where: { activityId_connectionId: { activityId: created.id, connectionId: connection.id } },
      create: {
        activityId: created.id,
        connectionId: connection.id,
        sourceActivityId: garminId,
        sourceUpdatedAt: new Date(),
      },
      update: { sourceActivityId: garminId },
    });

    if (series) {
      await tx.activityDataPoint.upsert({
        where: { activityId_provider: { activityId: created.id, provider: 'GARMIN' } },
        create: {
          activityId: created.id,
          provider: 'GARMIN',
          sampleCount: series.timeMs.length,
          series: series as unknown as Prisma.InputJsonValue,
        },
        update: {
          sampleCount: series.timeMs.length,
          series: series as unknown as Prisma.InputJsonValue,
        },
      });
    }
  });
}

function toActivityCreate(userId: string, input: ActivityInput) {
  return {
    userId,
    headline: input.headline,
    type: input.type,
    startTime: input.startTime,
    durationS: input.durationS,
    movingTimeS: input.movingTimeS,
    distanceM: input.distanceM ?? null,
    avgSpeedMs: input.avgSpeedMs ?? null,
    maxSpeedMs: input.maxSpeedMs ?? null,
    totalAscentM: input.totalAscentM ?? null,
    totalDescentM: input.totalDescentM ?? null,
    elevationHighM: input.elevationHighM ?? null,
    elevationLowM: input.elevationLowM ?? null,
    avgHr: input.avgHr,
    maxHr: input.maxHr,
    avgPowerW: input.avgPowerW,
    maxPowerW: input.maxPowerW,
    avgCadence: input.avgCadence,
    maxCadence: input.maxCadence,
    trainingLoad: input.trainingLoad ?? null,
    caloriesKcal: input.caloriesKcal,
    indoor: input.indoor,
    hrZonesMin: (input.hrZonesMin as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
    raw: input.raw as unknown as Prisma.InputJsonValue,
  };
}

// series-from-records builder lives in providers/garmin/normalize.js
