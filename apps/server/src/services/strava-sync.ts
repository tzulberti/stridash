/**
 * Strava activity sync: OAuth token refresh, incremental discovery, detail +
 * streams, gear attribution and the shared identity/series persistence.
 *
 * Discovery uses Strava's `after` watermark (first sync bounded by
 * STRIDASH_STRAVA_BACKFILL_DAYS). The list row supplies the scalars; the
 * detail endpoint adds calories/suffer score/gear and /streams supplies the
 * per-sample arrays. Any detail/stream/gear failure degrades that activity to
 * summary-only and marks the run PARTIAL instead of losing the ride.
 */

import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { decryptToken, encryptToken } from '../crypto.js';
import { safeErrorForLog } from '../redact.js';
import {
  refreshStravaToken,
  StravaClient,
  StravaError,
  type StravaActivityDetail,
  type StravaActivitySummary,
  type StravaOAuthConfig,
} from '../providers/strava/client.js';
import {
  detailScalars,
  mapStravaActivity,
  mapStravaGear,
  toStravaSeries,
  type StravaSeries,
} from '../providers/strava/normalize.js';
import { ingestActivity } from './activity-ingest.js';
import { upsertActivitySeries } from './activity-series.js';
import type { ActivityInput } from '../providers/igpsport/normalize.js';
import type { Env } from '../env.js';

interface ConnectionLike {
  id: string;
  userId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  status: string;
}

export type StravaSyncResult = {
  syncLogId: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  failedActivities: string[];
};

/** OAuth app config; missing env is a deployment error, not a user error. */
export function stravaConfig(env: Env, redirectUri: string): StravaOAuthConfig {
  if (!env.STRIDASH_STRAVA_CLIENT_ID || !env.STRIDASH_STRAVA_CLIENT_SECRET) {
    throw new StravaError(
      'CONNECTION',
      'Strava OAuth is not configured — set STRIDASH_STRAVA_CLIENT_ID and STRIDASH_STRAVA_CLIENT_SECRET',
    );
  }
  return {
    clientId: env.STRIDASH_STRAVA_CLIENT_ID,
    clientSecret: env.STRIDASH_STRAVA_CLIENT_SECRET,
    redirectUri,
  };
}

async function ensureClient(env: Env, connection: ConnectionLike): Promise<StravaClient> {
  if (connection.status === 'REVOKED') {
    throw new StravaError('CREDENTIALS', 'Connection revoked — reconnect the Strava account first');
  }
  const expMs = connection.tokenExpiresAt?.getTime() ?? 0;
  const storedAccess = connection.accessTokenEnc
    ? decryptToken(connection.accessTokenEnc, env)
    : '';
  if (storedAccess && Date.now() < expMs - 60_000) {
    return new StravaClient(storedAccess);
  }

  const refreshToken = connection.refreshTokenEnc
    ? decryptToken(connection.refreshTokenEnc, env)
    : '';
  if (!refreshToken) {
    throw new StravaError('CREDENTIALS', 'No stored Strava credentials — reconnect the account');
  }
  const config = stravaConfig(env, env.STRIDASH_STRAVA_REDIRECT_URI ?? '');
  const tokens = await refreshStravaToken(config, refreshToken);
  await prisma.connection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptToken(tokens.accessToken, env),
      refreshTokenEnc: encryptToken(tokens.refreshToken, env),
      tokenExpiresAt: tokens.expiresAt,
      status: 'ACTIVE',
    },
  });
  return new StravaClient(tokens.accessToken);
}

function activityCreateData(
  userId: string,
  input: ActivityInput,
  gearId: string | null,
  trainingLoad: number | null,
  notes: string | null,
  detail: StravaActivityDetail | null,
) {
  return {
    userId,
    headline: input.headline,
    workoutName: input.workoutName,
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
    caloriesKcal: input.caloriesKcal,
    trainingLoad,
    indoor: input.indoor,
    gearId,
    notes,
    raw: input.raw as unknown as Prisma.InputJsonValue,
    detailRaw: detail ? (detail as unknown as Prisma.InputJsonValue) : undefined,
  };
}

async function upsertStravaGear(
  connection: ConnectionLike,
  client: StravaClient,
  sourceGearId: string,
  cache: Map<string, string>,
): Promise<string | null> {
  const cached = cache.get(sourceGearId);
  if (cached) return cached;
  const raw = await client.getGear(sourceGearId);
  const input = mapStravaGear(connection.userId, raw);
  if (!input) return null;
  const existing = await prisma.gear.findFirst({
    where: { userId: connection.userId, provider: 'STRAVA', sourceGearId },
    select: { id: true },
  });
  const gear = existing
    ? await prisma.gear.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          kind: input.kind,
          brand: input.brand,
          model: input.model,
          usageType: input.usageType,
          raw: input.raw as never,
        },
      })
    : await prisma.gear.create({ data: { ...input, raw: input.raw as never } });
  cache.set(sourceGearId, gear.id);
  return gear.id;
}

async function ingestSummary(
  client: StravaClient,
  connection: ConnectionLike,
  row: StravaActivitySummary,
  gearCache: Map<string, string>,
  result: StravaSyncResult,
): Promise<void> {
  const id = String(row.id);
  let detail: StravaActivityDetail | null = null;
  try {
    detail = await client.getActivity(id);
  } catch (err) {
    result.status = 'PARTIAL';
    result.failedActivities.push(`detail:${id}`);
    console.error(`[strava] detail for ${id} failed:`, safeErrorForLog(err));
  }

  const merged = detail ? { ...row, ...detail } : row;
  const input = mapStravaActivity(merged);
  if (!input) throw new StravaError('CONNECTION', `Strava activity ${id} has no start time`);
  if (detail) Object.assign(input, detailScalars(detail));

  let series: StravaSeries | null = null;
  try {
    series = toStravaSeries(await client.getActivityStreams(id), input.startTime);
  } catch (err) {
    result.status = 'PARTIAL';
    result.failedActivities.push(`streams:${id}`);
    console.error(`[strava] streams for ${id} failed:`, safeErrorForLog(err));
  }

  let gearId: string | null = null;
  const gearRef = detail?.gear_id ?? row.gear_id;
  if (gearRef) {
    try {
      gearId = await upsertStravaGear(connection, client, gearRef, gearCache);
    } catch (err) {
      result.status = 'PARTIAL';
      result.failedActivities.push(`gear:${gearRef}`);
      console.error(`[strava] gear ${gearRef} failed:`, safeErrorForLog(err));
    }
  }

  const trainingLoad =
    detail?.suffer_score != null ? Math.max(0, Math.round(detail.suffer_score)) : null;
  const notes = detail?.description?.trim() || null;

  const outcome = await ingestActivity(
    {
      userId: connection.userId,
      connectionId: connection.id,
      sourceActivityId: id,
      type: input.type,
      startTime: input.startTime,
      distanceM: input.distanceM,
    },
    {
      create: async (tx) => {
        const created = await tx.activity.create({
          data: activityCreateData(connection.userId, input, gearId, trainingLoad, notes, detail),
          select: { id: true },
        });
        if (series) await upsertActivitySeries(created.id, 'STRAVA', series, tx);
        return created;
      },
      onMatch: async (tx, existing) => {
        if (gearId && !existing.gearId) {
          await tx.activity.update({ where: { id: existing.id }, data: { gearId } });
        }
        if (series) await upsertActivitySeries(existing.id, 'STRAVA', series, tx);
      },
    },
  );
  if (outcome.created) result.itemsCreated++;
  else result.itemsUpdated++;
}

export async function syncStravaConnection(
  env: Env,
  connection: ConnectionLike,
): Promise<StravaSyncResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: 'ACTIVITIES', status: 'OK' },
  });
  const result: StravaSyncResult = {
    syncLogId: log.id,
    status: 'OK',
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failedActivities: [],
  };

  try {
    const client = await ensureClient(env, connection);
    const backfillMs = env.STRIDASH_STRAVA_BACKFILL_DAYS * 86_400_000;
    const after = connection.lastSyncedAt
      ? Math.floor(connection.lastSyncedAt.getTime() / 1000) - 86_400 // 1-day safety overlap
      : Math.floor((Date.now() - backfillMs) / 1000);

    const gearCache = new Map<string, string>();
    const known = await prisma.activitySource.findMany({
      where: { connectionId: connection.id },
      select: { sourceActivityId: true },
    });
    const knownIds = new Set(known.map((s) => s.sourceActivityId));

    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let rows: StravaActivitySummary[];
      try {
        rows = await client.listActivities({ after, page, perPage: PAGE_SIZE });
      } catch (err) {
        result.status = 'PARTIAL';
        result.failedActivities.push(`page:${page}`);
        console.error(`[strava] list page ${page} failed:`, safeErrorForLog(err));
        break;
      }
      if (rows.length === 0) break;
      result.itemsPulled += rows.length;

      for (const row of rows) {
        const id = String(row.id);
        if (knownIds.has(id)) continue;
        try {
          await ingestSummary(client, connection, row, gearCache, result);
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedActivities.push(id);
          console.error(`[strava] activity ${id} ingest failed:`, safeErrorForLog(err));
        }
      }

      if (rows.length < PAGE_SIZE) break;
    }
  } catch (err) {
    const detail = safeErrorForLog(
      err instanceof StravaError
        ? { error: err.message, status: err.status, providerDetail: err.detail }
        : { error: String(err) },
    );
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: 'ERROR', errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error('[strava] sync failed:', detail);
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
