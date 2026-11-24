/**
 * Zwift connection sync — activities in, per-second streams alongside.
 *
 * Token strategy differs from iGPSPORT (no usable refresh grant there):
 * Zwift's Keycloak-style endpoint DOES have one, and it rotates the refresh
 * token on every use (`refreshTokenEnc` holds the latest grant, never data).
 * The access JWT is refreshed when the stored expiry nears; both new tokens
 * are persisted after each rotation.
 *
 * Streams arrive via detail.fitnessData.fullDataUrl (never the list rows);
 * they are fetched at ingest time, which also yields the summary scalars the
 * list rows lack (heart rate, max power/cadence). Rows left summary-only or
 * scalar-poor by an early failure/bug are upgraded by later syncs (bounded
 * per pass). Same fallback as iGPSPORT's FIT path otherwise.
 */

import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { decryptToken, encryptToken } from '../crypto.js';
import {
  ZwiftClient,
  ZwiftError,
  zwiftRefresh,
  type ZwiftActivity,
} from '../providers/zwift/client.js';
import {
  mapZwiftActivityRow,
  detailScalars,
  toZwiftSeries,
  type ZwiftSeries,
} from '../providers/zwift/normalize.js';
import { safeErrorForLog } from '../redact.js';
import { ingestActivity } from './activity-ingest.js';
import { upsertActivitySeries } from './activity-series.js';
import type { ActivityInput } from '../providers/igpsport/normalize.js';
import type { Env } from '../env.js';

export type ZwiftSyncResult = {
  syncLogId: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  failedActivities: string[];
};

interface ConnectionLike {
  id: string;
  userId: string;
  providerUserId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt?: Date | unknown;
  status: string;
}

/** Rehydrate or rotate the stored token pair and return a ready client. */
async function ensureClient(env: Env, connection: ConnectionLike): Promise<ZwiftClient> {
  if (connection.status === 'REVOKED') {
    throw new ZwiftError('CONNECTION', 'Connection revoked — reconnect the Zwift account first');
  }
  if (!connection.providerUserId) {
    throw new ZwiftError('CONNECTION', 'Connection has no Zwift athlete id — reconnect');
  }

  const expMs = (connection.tokenExpiresAt as Date | null | undefined)?.getTime() ?? 0;
  const client = new ZwiftClient(connection.providerUserId);

  const storedAccess = connection.accessTokenEnc
    ? decryptToken(connection.accessTokenEnc, env)
    : '';
  if (storedAccess && Date.now() < expMs - 60_000) {
    return client.withAccessToken(storedAccess); // fast path: still valid
  }

  // rotate: the refresh grant must use client_id "Zwift Game Client" (baked in)
  const refreshToken = connection.refreshTokenEnc
    ? decryptToken(connection.refreshTokenEnc, env)
    : '';
  if (!refreshToken) {
    throw new ZwiftError('CONNECTION', 'No stored Zwift credentials — reconnect the account');
  }
  const tokens = await zwiftRefreshWithPersist(env, connection, refreshToken);
  return client.withAccessToken(tokens.accessToken);
}

/** One refresh round-trip; persists the rotated pair before returning. */
async function zwiftRefreshWithPersist(env: Env, connection: ConnectionLike, refreshToken: string) {
  const tokens = await zwiftRefresh(refreshToken);
  await prisma.connection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptToken(tokens.accessToken, env),
      refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken, env) : undefined,
      tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      status: 'ACTIVE',
    },
  });
  return tokens;
}

/** Ingest one activity row (+ series + source registration). Dedup lives in
 * the shared activity-ingest service: provider-source identity first, then a
 * cross-provider tolerance match. */
async function upsertZwiftActivity(
  connection: ConnectionLike,
  externalId: string,
  activity: ActivityInput,
  series: ZwiftSeries | null,
  detail: ZwiftActivity | null,
): Promise<'created' | 'updated'> {
  const result = await ingestActivity(
    {
      userId: connection.userId,
      connectionId: connection.id,
      sourceActivityId: externalId,
      type: activity.type,
      startTime: activity.startTime,
      distanceM: activity.distanceM,
    },
    {
      create: async (tx) => {
        const created = await tx.activity.create({
          data: {
            userId: connection.userId,
            headline: activity.headline,
            workoutName: activity.workoutName,
            type: activity.type,
            startTime: activity.startTime,
            durationS: activity.durationS,
            movingTimeS: activity.movingTimeS,
            distanceM: activity.distanceM ?? null,
            avgSpeedMs: activity.avgSpeedMs ?? null,
            maxSpeedMs: activity.maxSpeedMs ?? null,
            totalAscentM: activity.totalAscentM ?? null,
            totalDescentM: activity.totalDescentM ?? null,
            elevationHighM: activity.elevationHighM ?? null,
            elevationLowM: activity.elevationLowM ?? null,
            avgHr: activity.avgHr,
            maxHr: activity.maxHr,
            avgPowerW: activity.avgPowerW,
            maxPowerW: activity.maxPowerW,
            avgCadence: activity.avgCadence,
            maxCadence: activity.maxCadence,
            trainingLoad: null, // Zwift does not report a TSS-like number
            caloriesKcal: activity.caloriesKcal,
            indoor: activity.indoor,
            raw: activity.raw as unknown as Prisma.InputJsonValue,
            // full detail-endpoint payload, as-received (see detail_raw column)
            detailRaw: detail ? (detail as unknown as Prisma.InputJsonValue) : undefined,
          },
          select: { id: true },
        });

        if (series) await upsertActivitySeries(created.id, 'ZWIFT', series, tx);
        return created;
      },
    },
  );

  return result.created ? 'created' : 'updated';
}

/** Re-ingest one provider-confirmed edit (also the force re-sync path). The
 * detail payload is already in hand: rebuild the scalars it carries (rename,
 * moving time, distance/speeds, HR/power/cadence, calories, ascent), refresh
 * detail_raw, re-fetch the series, and stamp source_updated_at with the
 * provider's own save time. Absent fields stay `undefined` (= no change in
 * Prisma) so a partial payload can never null out a stored value; `raw` keeps
 * the discovery-time list row (detail_raw is the fresh authority). Returns
 * false when the detail was unusable (stored row deliberately untouched). */
async function reingestEditedZwiftActivity(
  client: ZwiftClient,
  connection: ConnectionLike,
  activityId: string,
  externalId: string,
  detail: ZwiftActivity,
  lastSave: Date,
): Promise<boolean> {
  const row = mapZwiftActivityRow(detail);
  if (!row) return false; // unusable detail — keep the stored row untouched

  // the detail row names its ascent key differently from list rows and
  // carries fractional metres
  const totalAscentM =
    typeof detail.totalElevation === 'number' ? detail.totalElevation : undefined;

  await prisma.activity.update({
    where: { id: activityId },
    data: {
      headline: row.headline,
      workoutName: row.workoutName,
      ...(detail.endDate != null ? { durationS: row.durationS } : {}),
      ...(detail.movingTimeInMs != null ? { movingTimeS: row.movingTimeS } : {}),
      ...(detail.distanceInMeters != null ? { distanceM: row.distanceM } : {}),
      ...(detail.avgSpeedInMetersPerSecond != null ? { avgSpeedMs: row.avgSpeedMs } : {}),
      ...(detail.maxSpeedInMetersPerSecond != null ? { maxSpeedMs: row.maxSpeedMs } : {}),
      ...(detail.avgHeartRate != null ? { avgHr: row.avgHr } : {}),
      ...(detail.maxHeartRate != null ? { maxHr: row.maxHr } : {}),
      ...(detail.avgWatts != null ? { avgPowerW: row.avgPowerW } : {}),
      ...(detail.maxWatts != null ? { maxPowerW: row.maxPowerW } : {}),
      ...(detail.avgCadenceInRotationsPerMinute != null ? { avgCadence: row.avgCadence } : {}),
      ...(detail.maxCadenceInRotationsPerMinute != null ? { maxCadence: row.maxCadence } : {}),
      ...(detail.calories != null ? { caloriesKcal: row.caloriesKcal } : {}),
      ...(totalAscentM !== undefined ? { totalAscentM } : {}),
      detailRaw: detail as unknown as Prisma.InputJsonValue,
    },
  });

  // series rebuild is best-effort: the existing series survives a fetch
  // hiccup (the upgrade pass only heals rows with no series at all)
  try {
    const url = detail.fitnessData?.fullDataUrl;
    if (url) {
      const series = toZwiftSeries(await client.getFitnessData(url));
      if (series) await upsertActivitySeries(activityId, 'ZWIFT', series, prisma);
    }
  } catch (err) {
    console.error(`[zwift] edit series rebuild for ${externalId} failed:`, err);
  }

  await prisma.activitySource.update({
    where: { activityId_connectionId: { activityId, connectionId: connection.id } },
    data: { sourceUpdatedAt: lastSave },
  });
  return true;
}

/**
 * Force re-ingest of ONE activity from Zwift (the web detail page's
 * "re-sync" action): fresh detail payload (scalars + detail_raw + series
 * rebuild) and source_updated_at anchored to the provider's save time.
 * Throws ZwiftError when tokens fail or the activity is gone from Zwift
 * (deleted rows keep their local copy — nothing is removed).
 */
export async function resyncZwiftActivity(
  env: Env,
  connection: ConnectionLike,
  activityId: string,
  externalId: string,
): Promise<void> {
  const client = await ensureClient(env, connection);
  const detail = await client.getActivityDetail(externalId);
  const parsed = detail.lastSaveDate ? new Date(detail.lastSaveDate) : null;
  // no usable save time → stamp "now" so the edit pass never re-ingests blind
  const lastSave = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  const ok = await reingestEditedZwiftActivity(
    client,
    connection,
    activityId,
    externalId,
    detail,
    lastSave,
  );
  if (!ok) {
    throw new ZwiftError('CONNECTION', `Zwift activity ${externalId} has no usable detail payload`);
  }
}

/** Pages the newest activities first; stops when nothing new for 2 pages. */
export async function syncZwiftConnection(
  env: Env,
  connection: ConnectionLike,
): Promise<ZwiftSyncResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: 'ACTIVITIES', status: 'OK' },
  });
  const result: ZwiftSyncResult = {
    syncLogId: log.id,
    status: 'OK',
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failedActivities: [],
  };

  try {
    const client = await ensureClient(env, connection);
    const known = await prisma.activitySource.findMany({
      where: { connectionId: connection.id },
      select: { sourceActivityId: true },
    });
    const knownIds = new Set(known.map((s) => s.sourceActivityId));

    let stalePageStreak = 0;
    const PAGE_SCAN_LIMIT = 10;
    const PAGE_SIZE = 20;
    for (let page = 0; page < PAGE_SCAN_LIMIT; page++) {
      let rows: ZwiftActivity[] = [];
      try {
        rows = await client.listActivities(page * PAGE_SIZE, PAGE_SIZE);
      } catch (err) {
        result.status = 'PARTIAL';
        result.failedActivities.push(`page:${page}`);
        console.error(`[zwift] list page ${page} failed:`, err);
        break;
      }
      if (!rows.length) break;

      let freshCount = 0;
      for (const row of rows) {
        const externalId = String(row.id_str ?? row.id ?? '');
        if (!externalId) continue;
        result.itemsPulled++;
        if (knownIds.has(externalId)) continue;
        freshCount++;
        try {
          const activity = mapZwiftActivityRow(row);
          if (!activity)
            throw new ZwiftError('CONNECTION', `activity ${externalId} has no usable start date`);
          let series: ZwiftSeries | null = null;
          let detail: ZwiftActivity | null = null;
          try {
            // The list row lacks BOTH fitnessData (stream URL) and the
            // heart-rate fields — the detail payload is needed for both,
            // and it is stored whole in detail_raw. activityId MUST be the
            // exact-precision id_str: these ids exceed Number's safe range
            // and a rounded-off numeric id 404s.
            detail = await client.getActivityDetail(externalId);
            Object.assign(activity, detailScalars(detail));
            series = detail.fitnessData?.fullDataUrl
              ? toZwiftSeries(await client.getFitnessData(detail.fitnessData.fullDataUrl))
              : null;
          } catch (err) {
            // stream/detail hiccups must be visible in the sync result, not silent
            result.status = 'PARTIAL';
            result.failedActivities.push(externalId);
            console.error(`[zwift] ingest incomplete for ${externalId} — summary only`, err);
          }
          await upsertZwiftActivity(connection, externalId, activity, series, detail);
          result.itemsCreated++;
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedActivities.push(externalId);
          console.error(`[zwift] activity ${externalId} ingest failed:`, err);
        }
      }

      if (freshCount === 0) {
        stalePageStreak++;
        if (stalePageStreak >= 2) break; // everything further back is known
      } else {
        stalePageStreak = 0;
      }
    }

    // Upgrade pass: rows left incomplete by earlier ingest bugs get a second
    // chance — no ZWIFT series (stream hiccup / precision bug), summary
    // scalars from list rows that lack heart rate, or no stored detail
    // payload. Heals come from one detail call and are self-limiting: series
    // rows satisfy the `none` filter, the scalar heal writes moving_time_s
    // (the scalar-eligibility marker, null only on legacy rows), and the
    // detail heal writes detail_raw. Zwift-owned rows only, so dedup owners
    // from other providers keep their authoritative payload untouched.
    // Bounded per pass so one force-sync tap never hammers the API.
    const upgradeable = await prisma.activitySource.findMany({
      where: {
        connectionId: connection.id,
        OR: [
          { activity: { dataPoints: { none: { provider: 'ZWIFT' } } } },
          { activity: { movingTimeS: null } },
          {
            activity: {
              // never stored a detail payload yet
              detailRaw: { equals: Prisma.DbNull },
              raw: { path: ['provider'], equals: 'ZWIFT' },
            },
          },
        ],
      },
      select: {
        activityId: true,
        sourceActivityId: true,
        activity: {
          select: {
            movingTimeS: true,
            detailRaw: true,
            dataPoints: { where: { provider: 'ZWIFT' }, select: { id: true } },
          },
        },
      },
      orderBy: { sourceUpdatedAt: 'desc' },
      take: 50,
    });
    for (const s of upgradeable) {
      try {
        const detail = await client.getActivityDetail(s.sourceActivityId);
        let healed = false;
        if (s.activity.detailRaw == null) {
          await prisma.activity.update({
            where: { id: s.activityId },
            data: { detailRaw: detail as unknown as Prisma.InputJsonValue },
          });
          healed = true;
        }
        const scalars = detailScalars(detail);
        if (Object.keys(scalars).length && s.activity.movingTimeS === null) {
          // detail scalars are ints-or-absent — always valid update input
          await prisma.activity.update({
            where: { id: s.activityId },
            data: scalars as unknown as Prisma.ActivityUpdateInput,
          });
          healed = true;
        }
        if (!s.activity.dataPoints.length) {
          const url = detail.fitnessData?.fullDataUrl;
          if (url) {
            const series = toZwiftSeries(await client.getFitnessData(url));
            if (series) {
              await upsertActivitySeries(s.activityId, 'ZWIFT', series, prisma);
              healed = true;
            }
          }
        }
        if (healed) result.itemsUpdated++;
      } catch (err) {
        result.status = 'PARTIAL';
        result.failedActivities.push(s.sourceActivityId);
        console.error(`[zwift] streams upgrade failed for ${s.sourceActivityId}:`, err);
      }
    }

    // Edit detection: Zwift list rows carry no update timestamp either, but
    // the detail payload's lastSaveDate is bumped on every in-game save —
    // renames, description/privacy edits, workout completion. Same bounded
    // poll-and-compare pattern as Garmin's lastUpdateDate pass: details over
    // the 100 most recent activities in a 45-day window, compared against
    // source_updated_at; edits are re-ingested with the provider's save time
    // stamped onto source_updated_at. Fresh ingest stamps it with "now", so
    // a just-synced activity no-ops (its lastSaveDate is already in the past)
    // and the pass only fires on real later edits. Zwift-owned rows only —
    // dedup rows pointing at another provider's activity never rewrite that
    // owner's authoritative payload.
    {
      const windowStart = new Date(Date.now() - 45 * 86_400_000);
      const recent = await prisma.activitySource.findMany({
        where: {
          connectionId: connection.id,
          activity: {
            startTime: { gte: windowStart },
            raw: { path: ['provider'], equals: 'ZWIFT' },
          },
        },
        select: { activityId: true, sourceActivityId: true, sourceUpdatedAt: true },
        orderBy: { activity: { startTime: 'desc' } },
        take: 100,
      });
      for (const s of recent) {
        try {
          const detail = await client.getActivityDetail(s.sourceActivityId);
          const lastSave = detail.lastSaveDate ? new Date(detail.lastSaveDate) : null;
          if (!lastSave || Number.isNaN(lastSave.getTime())) continue; // never re-ingest blind
          if (s.sourceUpdatedAt && s.sourceUpdatedAt >= lastSave) continue; // unchanged
          await reingestEditedZwiftActivity(
            client,
            connection,
            s.activityId,
            s.sourceActivityId,
            detail,
            lastSave,
          );
          result.itemsUpdated++;
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedActivities.push(`edit:${s.sourceActivityId}`);
          console.error(`[zwift] edit detection for ${s.sourceActivityId} failed:`, err);
        }
      }
    }
  } catch (err) {
    const detail = safeErrorForLog(
      err instanceof ZwiftError
        ? {
            error: err.message,
            kind: err.kind,
            status: err.status,
            providerDetail: err.detail,
          }
        : { error: err instanceof Error ? err.message : String(err) },
    );
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: 'ERROR', errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error(`[zwift] sync ${connection.id} failed:`, detail);
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
        ? { failed: result.failedActivities.slice(0, 20) }
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
