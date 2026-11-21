/**
 * iGPSPORT sync service: paginated discovery via queryMyActivity, then a
 * FIT download per new ride, ingesting `activities` (+ `activity_sources`,
 * + `activity_data_points` series) through the shared activity-ingest service
 * (provider identity + cross-provider tolerance matching). Every run writes a
 * sync_logs row.
 */

import { prisma } from '../db.js';
import { encryptToken, decryptToken } from '../crypto.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  IgpSportError,
  IgpSportClient,
  peekJwtClaims,
  type IgpSportActivityRow,
} from '../providers/igpsport/client.js';
import { regionForKey } from '../providers/igpsport/regions.js';
import {
  type ActivityInput,
  type FitRecord,
  type FitSession,
  fitToActivity,
} from '../providers/igpsport/normalize.js';
import { parseFitFile } from '../providers/igpsport/fit.js';
import { safeErrorForLog } from '../redact.js';
import { upsertDevice } from './devices.js';
import { ingestActivity } from './activity-ingest.js';
import type { Env } from '../env.js';

interface ConnectionLike {
  id: string;
  userId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  status: string;
  config: unknown;
}

export type IgpSportSyncResult = {
  syncLogId: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  failedRides: string[];
};

/** Read the { igpsport: { region } } config blob. */
function regionKeyOf(connection: ConnectionLike): string {
  const cfg = connection.config as { igpsport?: { region?: string } } | null;
  return cfg?.igpsport?.region ?? 'intl';
}

/** Activity scalars → Prisma create payload (jsonb + nulls handled). */
function toActivityCreate(userId: string, connectionId: string, input: ActivityInput) {
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
    trainingLoad: null, // provider hasn't delivered a TSS-like number for FIT runs
    sweatLossMl: input.sweatLossMl ?? null,
    aerobicTe: input.aerobicTe ?? null,
    anaerobicTe: input.anaerobicTe ?? null,
    aerobicTeMessage: input.aerobicTeMessage ?? null,
    anaerobicTeMessage: input.anaerobicTeMessage ?? null,
    vo2max: input.vo2max ?? null,
    recoveryMinutes: input.recoveryMinutes ?? null,
    normalizedPowerW: input.normalizedPowerW ?? null,
    caloriesKcal: input.caloriesKcal,
    indoor: input.indoor,
    raw: input.raw as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Ensure an authenticated client: reuse the stored access JWT if it has not
 * expired, otherwise re-login with the stored (AES-encrypted) account
 * password. Writes the fresh token pair + expiry back to the connection row.
 */
async function ensureClient(env: Env, connection: ConnectionLike): Promise<IgpSportClient> {
  if (connection.status === 'REVOKED') {
    throw new IgpSportError('Connection revoked — reconnect the iGPSPORT account first');
  }
  const region = regionForKey(regionKeyOf(connection))!;
  const client = new IgpSportClient(region);

  const username = await (async () => {
    const cfg = connection.config as { igpsport?: { username?: string } } | null;
    return cfg?.igpsport?.username ?? '';
  })();

  const expMs = connection.tokenExpiresAt?.getTime() ?? 0;
  const tokenFresh = connection.accessTokenEnc && Date.now() < expMs - 60_000;
  if (tokenFresh) {
    client.withAccessToken(decryptToken(connection.accessTokenEnc!, env));
    return client;
  }

  // (Re-)login. The account password is persisted encrypted in
  // refreshTokenEnc (the protocol has no refresh-token grant we can rely on).
  if (!connection.refreshTokenEnc) {
    throw new IgpSportError('No stored iGPSPORT credentials — reconnect the account');
  }
  const password = decryptToken(connection.refreshTokenEnc, env);
  const login = await client.login(username, password);
  const claims = peekJwtClaims(login.access_token);
  const expiresAt = claims.exp
    ? new Date(claims.exp * 1000)
    : new Date(Date.now() + (login.expires_in ?? 3600) * 1000);

  await prisma.connection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptToken(login.access_token, env),
      // keep the password blob as-is (refreshTokenEnc)
      tokenExpiresAt: expiresAt,
      status: 'ACTIVE',
    },
  });
  return client.withAccessToken(login.access_token);
}

/**
 * Run one iGPSPORT sync. Pages through the activity list starting at the
 * newest ride; stops at the first page whose rows are all already known.
 */
export async function syncIgpSportConnection(
  env: Env,
  connection: ConnectionLike,
): Promise<IgpSportSyncResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: 'ACTIVITIES', status: 'OK' },
  });
  const result: IgpSportSyncResult = {
    syncLogId: log.id,
    status: 'OK',
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failedRides: [],
  };

  try {
    const client = await ensureClient(env, connection);
    const known = await prisma.activitySource.findMany({
      where: { connectionId: connection.id },
      select: { sourceActivityId: true },
    });
    const knownIds = new Set(known.map((s) => s.sourceActivityId));

    let stalePageStreak = 0;
    const NEW_PAGE_SCAN_LIMIT = 5; // keep first-syncs bounded
    for (let page = 1; page <= NEW_PAGE_SCAN_LIMIT; page++) {
      let rows: IgpSportActivityRow[];
      try {
        rows = await client.listActivities(page, 20);
      } catch (err) {
        // Partial failure: keep what we have, note the failure
        result.status = 'PARTIAL';
        result.failedRides.push(`page:${page}`);
        console.error(`[igpsport] list page ${page} failed:`, err);
        break;
      }
      if (!rows.length) break;

      let freshCount = 0;
      for (const row of rows) {
        result.itemsPulled++;
        if (knownIds.has(String(row.rideId))) continue;
        freshCount++;
        try {
          await ingestRide(client, connection, row);
          result.itemsCreated++;
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedRides.push(String(row.rideId));
          console.error(`[igpsport] ride ${row.rideId} ingest failed:`, err);
        }
      }

      if (freshCount === 0) {
        stalePageStreak++;
        if (stalePageStreak >= 2) break; // everything from here on is old
      } else {
        stalePageStreak = 0;
      }
    }

    // Self-healing device backfill: rides ingested before devices were
    // tracked have device_id null. iGPSPORT exposes no per-ride device
    // endpoint, so this re-downloads the FIT (bounded per pass — converges
    // over repeated syncs, same pattern as the Garmin pass).
    {
      const missing = await prisma.activitySource.findMany({
        where: { connectionId: connection.id, activity: { deviceId: null } },
        select: { activityId: true, sourceActivityId: true },
        take: 50,
        orderBy: { activity: { startTime: 'desc' } },
      });
      for (const s of missing) {
        try {
          const fitBuf = await client.downloadFit(s.sourceActivityId);
          const parsed = await parseFitFile(fitBuf);
          if (!parsed.device) continue; // FIT reports no recorder
          const deviceId = await upsertDevice(connection.userId, {
            provider: 'IGPSPORT',
            sourceDeviceId: parsed.device.serialNumber,
            manufacturer: parsed.device.manufacturer,
            productCode: parsed.device.productCode,
            softwareVersion: parsed.device.softwareVersion,
            hardwareVersion: parsed.device.hardwareVersion,
            raw: parsed.device.raw,
          });
          await prisma.activity.update({ where: { id: s.activityId }, data: { deviceId } });
          result.itemsUpdated++;
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedRides.push(`device:${s.sourceActivityId}`);
          console.error(`[igpsport] device backfill for ${s.sourceActivityId} failed:`, err);
        }
      }
    }
  } catch (err) {
    const detail = safeErrorForLog(
      err instanceof IgpSportError
        ? { error: err.message, providerDetail: err.detail }
        : { error: String(err) },
    );
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: 'ERROR', errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error('[igpsport] sync failed:', detail);
    throw err;
  }

  await prisma.syncLog.update({
    where: { id: result.syncLogId },
    data: {
      status: result.status,
      itemsPulled: result.itemsPulled,
      itemsCreated: result.itemsCreated,
      itemsUpdated: result.itemsUpdated,
      errorDetail: (result.failedRides.length ? { failed: result.failedRides } : null) as never,
      finishedAt: new Date(),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date() },
  });
  return result;
}

/** Download + parse one ride's FIT and upsert activity/streams/sources. */
async function ingestRide(
  client: IgpSportClient,
  connection: ConnectionLike,
  row: IgpSportActivityRow,
): Promise<void> {
  const rideId = String(row.rideId);

  let fitBuf: Buffer | null = null;
  try {
    fitBuf = await client.downloadFit(rideId);
  } catch (err) {
    console.error(`[igpsport] FIT unavailable for ride ${rideId} — using row summary`, err);
  }

  if (fitBuf) {
    let records: FitRecord[] = [];
    let deviceId: string | null = null;
    let fitSession: FitSession | null = null;
    try {
      const parsed = await parseFitFile(fitBuf);
      records = parsed.records;
      fitSession = parsed.session;
      // the FIT's single device_info message = the head unit that recorded
      // the ride; iGPSPORT offers no device registry, so no model name
      if (parsed.device) {
        try {
          deviceId = await upsertDevice(connection.userId, {
            provider: 'IGPSPORT',
            sourceDeviceId: parsed.device.serialNumber,
            manufacturer: parsed.device.manufacturer,
            productCode: parsed.device.productCode,
            softwareVersion: parsed.device.softwareVersion,
            hardwareVersion: parsed.device.hardwareVersion,
            raw: parsed.device.raw,
          });
        } catch (err) {
          // device attribution is metadata — never fail the ride ingest
          console.error(`[igpsport] device upsert failed for ride ${rideId}:`, err);
        }
      }
    } catch (err) {
      console.error(`[igpsport] FIT parse failed for ride ${rideId} — using row summary`, err);
    }
    if (records.length) {
      const rowIndoor = (row as Record<string, unknown>).indoor === 1;
      const parsed = fitToActivity(row, records, {
        indoor: rowIndoor,
        session: fitSession,
      });
      if (parsed)
        await upsertActivity(connection, rideId, parsed.activity, parsed.series, deviceId);
      return;
    }
  }

  // Fallback: row summary only (no FIT / parse failed). startTime is stored
  // as-is (string without offset) — dedup still works because the ride id is
  // registered in activity_sources first anyway.
  await upsertActivity(connection, rideId, rowSummaryActivity(row), null, null);
}

/** List/detail-row-only activity input (no FIT). The detail payload of a
 * single ride is a superset of the list row (verified live 2026-11-14), so
 * the force re-sync path feeds it through here too. */
function rowSummaryActivity(row: IgpSportActivityRow): ActivityInput {
  const startTime = row.startTime
    ? new Date(`${row.startTime.replace(' ', 'T')}Z`) // treat as UTC; corrected when FIT arrives
    : new Date(0);
  return {
    headline: row.title ?? row.name ?? 'iGPSPORT ride',
    workoutName: null,
    type: row.exerciseType === 0 ? 'RIDE' : 'OTHER',
    startTime,
    durationS: row.totalMovingTime ?? row.recordTime ?? 0,
    movingTimeS: row.totalMovingTime ?? null,
    distanceM: row.rideDistance ?? null,
    avgSpeedMs: row.avgSpeed ?? null,
    maxSpeedMs: row.maxSpeed ?? null,
    totalAscentM: row.totalAscent ?? null,
    totalDescentM: row.totalDescent ?? null,
    elevationHighM: row.maxAlt ?? null,
    elevationLowM: row.minAlt ?? null,
    avgHr: null,
    maxHr: null,
    avgPowerW: null,
    maxPowerW: null,
    avgCadence: null,
    maxCadence: null,
    caloriesKcal: null,
    indoor: false,
    raw: { provider: 'IGPSPORT', sourceRow: row, approximateStartTime: true },
  };
}

interface StreamArray {
  timeMs: number[];
  [key: string]: number[];
}

/**
 * Ingest one activity row (+ series + source registration).
 *
 * Dedup lives in the shared `ingestActivity` service: provider-source identity
 * first, then a tolerance match (same type, start ±60 s, distance ±100 m).
 */
export async function upsertActivity(
  connection: ConnectionLike,
  rideId: string,
  activity: ActivityInput,
  series: StreamArray | null,
  deviceId: string | null = null,
): Promise<void> {
  await ingestActivity(
    {
      userId: connection.userId,
      connectionId: connection.id,
      sourceActivityId: rideId,
      type: activity.type,
      startTime: activity.startTime,
      distanceM: activity.distanceM,
    },
    {
      create: async (tx) => {
        const created = await tx.activity.create({
          data: { ...toActivityCreate(connection.userId, connection.id, activity), deviceId },
          select: { id: true },
        });

        if (series) {
          await tx.activityDataPoint.upsert({
            where: {
              activityId_provider: { activityId: created.id, provider: 'IGPSPORT' },
            },
            create: {
              activityId: created.id,
              provider: 'IGPSPORT',
              sampleCount: (series.timeMs as number[]).length,
              series: series as unknown as Prisma.InputJsonValue,
            },
            update: {
              sampleCount: (series.timeMs as number[]).length,
              series: series as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return created;
      },
      // register the recording device if nobody else claimed it
      onMatch: async (tx, existing) => {
        if (deviceId && !existing.deviceId) {
          await tx.activity.update({ where: { id: existing.id }, data: { deviceId } });
        }
      },
    },
  );
}

/**
 * In-place refresh of one stored ride (the force re-sync path): scalars +
 * series rebuilt, device slot filled when empty, source_updated_at stamped
 * "now" (list rows carry no edit timestamp to compare against). startTime is
 * deliberately NOT touched — it is a dedup key component.
 */
async function updateIgpSportActivity(
  connectionId: string,
  activityId: string,
  input: ActivityInput,
  series: StreamArray | null,
  deviceId: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.activity.update({
      where: { id: activityId },
      data: {
        headline: input.headline,
        workoutName: input.workoutName,
        type: input.type,
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
        trainingLoad: null, // provider hasn't delivered a TSS-like number for FIT runs
        sweatLossMl: input.sweatLossMl ?? null,
        aerobicTe: input.aerobicTe ?? null,
        anaerobicTe: input.anaerobicTe ?? null,
        aerobicTeMessage: input.aerobicTeMessage ?? null,
        anaerobicTeMessage: input.anaerobicTeMessage ?? null,
        vo2max: input.vo2max ?? null,
        recoveryMinutes: input.recoveryMinutes ?? null,
        normalizedPowerW: input.normalizedPowerW ?? null,
        caloriesKcal: input.caloriesKcal,
        indoor: input.indoor,
        raw: input.raw as unknown as Prisma.InputJsonValue,
        ...(deviceId ? { deviceId } : {}),
      },
    });

    await tx.activitySource.update({
      where: { activityId_connectionId: { activityId, connectionId } },
      data: { sourceUpdatedAt: new Date() },
    });

    if (series) {
      await tx.activityDataPoint.upsert({
        where: { activityId_provider: { activityId, provider: 'IGPSPORT' } },
        create: {
          activityId,
          provider: 'IGPSPORT',
          sampleCount: (series.timeMs as number[]).length,
          series: series as unknown as Prisma.InputJsonValue,
        },
        update: {
          sampleCount: (series.timeMs as number[]).length,
          series: series as unknown as Prisma.InputJsonValue,
        },
      });
    }
  });
}

/**
 * Force re-ingest of ONE ride from iGPSPORT (the web detail page's "re-sync"
 * action): the ride-detail endpoint (verified live 2026-11-14 — a superset
 * of the list row: title/times/distance/ascent/exerciseType) plus a fresh
 * FIT download rebuild scalars + series in place. Throws IgpSportError when
 * tokens fail or the ride is gone (deleted rows keep their local copy).
 */
export async function resyncIgpSportActivity(
  env: Env,
  connection: ConnectionLike,
  activityId: string,
  rideId: string,
): Promise<void> {
  const client = await ensureClient(env, connection);
  const detailRow = (await client.getActivityDetail(rideId)) as unknown as IgpSportActivityRow;
  if (detailRow == null || String(detailRow.rideId ?? '') !== rideId) {
    throw new IgpSportError(`iGPSPORT ride ${rideId} not found`);
  }

  const stored = await prisma.activity.findUnique({
    where: { id: activityId },
    select: { indoor: true, deviceId: true },
  });
  if (!stored) throw new IgpSportError(`activity ${activityId} vanished during re-sync`);

  let records: FitRecord[] = [];
  let session: FitSession | null = null;
  let deviceId: string | null = null;
  try {
    const fitBuf = await client.downloadFit(rideId);
    const parsed = await parseFitFile(fitBuf);
    records = parsed.records;
    session = parsed.session;
    if (parsed.device) {
      try {
        deviceId = await upsertDevice(connection.userId, {
          provider: 'IGPSPORT',
          sourceDeviceId: parsed.device.serialNumber,
          manufacturer: parsed.device.manufacturer,
          productCode: parsed.device.productCode,
          softwareVersion: parsed.device.softwareVersion,
          hardwareVersion: parsed.device.hardwareVersion,
          raw: parsed.device.raw,
        });
      } catch (err) {
        // device attribution is metadata — never fail the ride re-sync
        console.error(`[igpsport] device upsert failed for ride ${rideId}:`, err);
      }
    }
  } catch (err) {
    console.error(`[igpsport] FIT re-download failed for ride ${rideId} — using detail row`, err);
  }

  let input: ActivityInput;
  let series: StreamArray | null = null;
  if (records.length) {
    const parsedAct = fitToActivity(detailRow, records, {
      indoor: (detailRow as Record<string, unknown>).indoor === 1,
      session,
    });
    if (!parsedAct) throw new IgpSportError(`iGPSPORT ride ${rideId} has no usable start time`);
    input = parsedAct.activity;
    series = parsedAct.series as unknown as StreamArray;
  } else {
    input = rowSummaryActivity(detailRow);
  }
  // the detail row may not carry the indoor flag — never un-flag a stored
  // indoor ride during a re-sync
  input.indoor = input.indoor || stored.indoor;
  const deviceFill = deviceId && !stored.deviceId ? deviceId : null;
  await updateIgpSportActivity(connection.id, activityId, input, series, deviceFill);
}
