/**
 * Garmin health measurements: weigh-ins/body composition and blood pressure.
 *
 * Runs alongside the activity/wellness sync but writes its own MEASUREMENTS
 * sync log. The range starts seven days before the newest stored reading for
 * that kind (idempotent upserts), or STRIDASH_GARMIN_HEALTH_BACKFILL_DAYS back
 * on the first run. A failure of one endpoint degrades the run to PARTIAL and
 * leaves the other series intact.
 */

import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { safeErrorForLog } from '../redact.js';
import { getBloodPressureRange, getWeightRange } from '../providers/garmin/api.js';
import {
  mapBloodPressureResponse,
  mapWeightResponse,
  type GarminMeasurementInput,
} from '../providers/garmin/health.js';
import { ensureGarminTokens, type GarminConnectionLike } from './garmin-tokens.js';
import type { Env } from '../env.js';

export type GarminMeasurementsResult = {
  syncLogId: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  weightPulled: number;
  weightUpserted: number;
  bloodPressurePulled: number;
  bloodPressureUpserted: number;
  failed: string[];
};

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rangeStart(latest: Date | null, now: Date, fallbackDays: number): string {
  if (latest) return isoDate(new Date(latest.getTime() - 7 * DAY_MS));
  return isoDate(new Date(now.getTime() - fallbackDays * DAY_MS));
}

async function latestMeasurement(
  userId: string,
  kind: 'WEIGH_IN' | 'BLOOD_PRESSURE',
): Promise<Date | null> {
  const row = await prisma.measurement.findFirst({
    where: { userId, provider: 'GARMIN', kind },
    orderBy: { measuredAt: 'desc' },
    select: { measuredAt: true },
  });
  return row?.measuredAt ?? null;
}

function measurementData(
  userId: string,
  connectionId: string,
  input: GarminMeasurementInput,
): Prisma.MeasurementUncheckedCreateInput {
  const { kind, measuredAt, raw, ...fields } = input;
  return {
    userId,
    connectionId,
    provider: 'GARMIN',
    kind,
    measuredAt,
    ...fields,
    raw: raw as Prisma.InputJsonValue,
  };
}

async function upsertMeasurements(
  userId: string,
  connectionId: string,
  inputs: GarminMeasurementInput[],
): Promise<number> {
  let count = 0;
  for (const input of inputs) {
    const data = measurementData(userId, connectionId, input);
    const { userId: _u, provider: _p, kind: _k, measuredAt: _m, ...update } = data;
    await prisma.measurement.upsert({
      where: {
        userId_provider_kind_measuredAt: {
          userId,
          provider: 'GARMIN',
          kind: input.kind,
          measuredAt: input.measuredAt,
        },
      },
      create: data,
      update: { ...update, connectionId },
    });
    count++;
  }
  return count;
}

export async function syncGarminMeasurements(
  env: Env,
  connection: GarminConnectionLike,
): Promise<GarminMeasurementsResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: 'MEASUREMENTS', status: 'OK' },
  });
  const result: GarminMeasurementsResult = {
    syncLogId: log.id,
    status: 'OK',
    weightPulled: 0,
    weightUpserted: 0,
    bloodPressurePulled: 0,
    bloodPressureUpserted: 0,
    failed: [],
  };

  try {
    const bearer = await ensureGarminTokens(env, connection);
    const now = new Date();
    const end = isoDate(now);
    const [lastWeight, lastBp] = await Promise.all([
      latestMeasurement(connection.userId, 'WEIGH_IN'),
      latestMeasurement(connection.userId, 'BLOOD_PRESSURE'),
    ]);

    try {
      const response = await getWeightRange(
        bearer,
        rangeStart(lastWeight, now, env.STRIDASH_GARMIN_HEALTH_BACKFILL_DAYS),
        end,
      );
      const rows = mapWeightResponse(response);
      result.weightPulled = response.dateWeightList?.length ?? rows.length;
      result.weightUpserted = await upsertMeasurements(connection.userId, connection.id, rows);
    } catch (err) {
      result.status = 'PARTIAL';
      result.failed.push('weight');
      console.error('[garmin] weight sync failed:', safeErrorForLog(err));
    }

    try {
      const response = await getBloodPressureRange(
        bearer,
        rangeStart(lastBp, now, env.STRIDASH_GARMIN_HEALTH_BACKFILL_DAYS),
        end,
      );
      const rows = mapBloodPressureResponse(response);
      result.bloodPressurePulled = rows.length;
      result.bloodPressureUpserted = await upsertMeasurements(
        connection.userId,
        connection.id,
        rows,
      );
    } catch (err) {
      result.status = 'PARTIAL';
      result.failed.push('bloodPressure');
      console.error('[garmin] blood-pressure sync failed:', safeErrorForLog(err));
    }
  } catch (err) {
    const detail = safeErrorForLog({ error: String(err) });
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: 'ERROR', errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error('[garmin] measurements sync failed:', detail);
    throw err;
  }

  const itemsCreated = result.weightUpserted + result.bloodPressureUpserted;
  await prisma.syncLog.update({
    where: { id: result.syncLogId },
    data: {
      status: result.status,
      itemsPulled: result.weightPulled + result.bloodPressurePulled,
      itemsCreated,
      errorDetail: (result.failed.length ? { failed: result.failed } : null) as never,
      finishedAt: new Date(),
    },
  });
  return result;
}
