/**
 * Garmin wellness sync: nightly sleep + daily wearer metrics.
 *
 * Endpoints (verified live with a DI bearer, 2026-11):
 *  - /sleep-service/stats/sleep/daily/{start}/{end}   ≤ 28 days/request
 *  - /usersummary-service/v2/dailysummaries           steps/floors/cal/HR/IM/stress/battery
 * The per-day /sleep-service/sleep/dailySleepData call (much richer: nap
 * seconds, awake counts, sleep stress, per-subscore feedback) is merged in
 * for the most recent 45 nights, so steady-state syncs stay detailed while
 * history backfills stay cheap (2 range requests per 28 days).
 */

import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import { getDailySummaries, getSleepDay, getSleepStatsRange } from '../providers/garmin/api.js';
import { ensureGarminTokens, type GarminConnectionLike } from './garmin-tokens.js';
import type { Env } from '../env.js';

const CHUNK_DAYS = 28;
/** nights also fetched with the full detail endpoint */
const DETAIL_RECENT_DAYS = 45;

export type GarminWellnessResult = {
  syncLogId: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  sleepPulled: number;
  sleepUpserted: number;
  daysPulled: number;
  daysUpserted: number;
  skipped: number;
  failedChunks: number;
};

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function addDaysStr(s: string, n: number): string {
  return iso(addDays(new Date(`${s}T00:00:00.000Z`), n));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export async function syncGarminWellness(
  env: Env,
  connection: GarminConnectionLike,
): Promise<GarminWellnessResult> {
  const result: GarminWellnessResult = {
    syncLogId: '',
    status: 'OK',
    sleepPulled: 0,
    sleepUpserted: 0,
    daysPulled: 0,
    daysUpserted: 0,
    skipped: 0,
    failedChunks: 0,
  };

  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: 'WELLNESS', status: 'OK' },
  });
  result.syncLogId = log.id;

  try {
    const bearer = await ensureGarminTokens(env, connection);

    // Backfill start: the oldest row we already have, else deep past for the
    // first run — Garmin simply answers zero rows past the device's history.
    const earliestSleep = await prisma.sleepSession.findFirst({
      where: { userId: connection.userId, provider: 'GARMIN' },
      orderBy: { dateKey: 'asc' },
      select: { dateKey: true },
    });
    const earliestDay = await prisma.dailyWellness.findFirst({
      where: { userId: connection.userId, provider: 'GARMIN' },
      orderBy: { dateKey: 'asc' },
      select: { dateKey: true },
    });
    const existingKeys = [earliestSleep?.dateKey, earliestDay?.dateKey]
      .filter((k): k is string => !!k)
      .sort();
    const startStr = existingKeys[0] ?? '2022-01-01';

    const today = iso(new Date()); // "today" in UTC; the wearer's local night
    // for the current morning is keyed by yesterday's calendarDate anyway,
    // and today's partial day costs one day at most
    const chunks: [string, string][] = [];
    for (let s = startStr; s <= today; s = addDaysStr(s, CHUNK_DAYS)) {
      const e = addDaysStr(s, CHUNK_DAYS - 1) > today ? today : addDaysStr(s, CHUNK_DAYS - 1);
      chunks.push([s, e]);
      if (e === today) break;
    }

    const sleepKeys = new Set<string>();
    const dayKeys = new Set<string>();

    for (const [cs, ce] of chunks) {
      // ── sleep stats for the chunk ──
      try {
        const rows = await getSleepStatsRange(bearer, cs, ce);
        result.sleepPulled += rows.length;
        await upsertSleepChunk(connection, rows, sleepKeys, result);
      } catch (err) {
        result.status = 'PARTIAL';
        result.failedChunks++;
        console.error(`[garmin] sleep range ${cs}→${ce} failed:`, err);
      }

      // ── daily summaries for the chunk ──
      try {
        const rows = await getDailySummaries(bearer, cs, ce);
        result.daysPulled += rows.length;
        await upsertDailyChunk(connection, rows, dayKeys, result);
      } catch (err) {
        result.status = 'PARTIAL';
        result.failedChunks++;
        console.error(`[garmin] summaries ${cs}→${ce} failed:`, err);
      }
    }

    // ── enrich the most recent nights with the full detail endpoint ──
    for (let d = addDaysStr(today, -DETAIL_RECENT_DAYS); d <= today; d = addDaysStr(d, 1)) {
      let detail: Record<string, unknown> | null;
      try {
        detail = await getSleepDay(bearer, d);
      } catch (err) {
        console.error(`[garmin] sleep detail ${d} failed:`, err);
        result.status = 'PARTIAL';
        result.failedChunks++;
        continue;
      }
      const patch = sleepDetailPatch(detail);
      if (patch.startAt === null || patch.startAt === undefined) {
        continue; // no sleep record for that night
      }
      try {
        await prisma.sleepSession.upsert({
          where: {
            userId_provider_dateKey: { userId: connection.userId, provider: 'GARMIN', dateKey: d },
          },
          create: {
            userId: connection.userId,
            connectionId: connection.id,
            provider: 'GARMIN',
            dateKey: d,
            ...patch,
          } as Prisma.SleepSessionUncheckedCreateInput,
          update: patch as Prisma.SleepSessionUncheckedUpdateInput,
        });
        result.sleepUpserted++;
      } catch (err) {
        console.error(`[garmin] sleep detail upsert ${d} failed:`, err);
        result.status = 'PARTIAL';
        result.failedChunks++;
      }
    }

    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: {
        status: result.status,
        itemsPulled: result.sleepPulled + result.daysPulled,
        itemsCreated: result.sleepUpserted + result.daysUpserted,
        errorDetail: (result.failedChunks ? { failedChunks: result.failedChunks } : null) as never,
        finishedAt: new Date(),
      },
    });
    return result;
  } catch (err) {
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: {
        status: 'ERROR',
        errorDetail: { error: String(err) } as never,
        finishedAt: new Date(),
      },
    });
    throw err;
  }
}

// ─── sleep range rows → sleep_sessions ──────────────────────────────────────

interface SleepRangeRow {
  calendarDate?: string;
  values?: Record<string, unknown>;
}

async function upsertSleepChunk(
  connection: GarminConnectionLike,
  rows: SleepRangeRow[],
  seen: Set<string>,
  result: GarminWellnessResult,
): Promise<void> {
  for (const row of rows) {
    const dateKey = str(row.calendarDate);
    const v = (row.values ?? {}) as Record<string, unknown>;
    const startMs = num(v.gmtSleepStartTimeInMillis);
    if (!dateKey || !startMs) {
      result.skipped++;
      continue;
    }
    const data = {
      startAt: new Date(startMs),
      endAt:
        num(v.gmtSleepEndTimeInMillis) !== undefined
          ? new Date(num(v.gmtSleepEndTimeInMillis)!)
          : null,
      totalSleepS: num(v.totalSleepTimeInSeconds) ?? null,
      deepS: num(v.deepTime) ?? null,
      lightS: num(v.lightTime) ?? null,
      remS: num(v.remTime) ?? null,
      awakeS: num(v.awakeTime) ?? null,
      restingHr: num(v.restingHeartRate) ?? null,
      avgHr: num(v.avgHeartRate) ?? null,
      avgRespiration: num(v.respiration) ?? null,
      hrvStatus: str(v.hrvStatus) ?? null,
      hrvAvg: num(v.avgOvernightHrv) ?? null,
      bodyBatteryChange: num(v.bodyBatteryChange) ?? null,
      sleepNeedMin: num(v.sleepNeed) ?? null,
      sleepScore: num(v.sleepScore) ?? null,
      raw: { values: v } as Prisma.InputJsonValue,
    };
    const isUpdate = seen.has(dateKey);
    seen.add(dateKey);
    try {
      await prisma.sleepSession.upsert({
        where: {
          userId_provider_dateKey: { userId: connection.userId, provider: 'GARMIN', dateKey },
        },
        create: {
          userId: connection.userId,
          connectionId: connection.id,
          provider: 'GARMIN',
          dateKey,
          ...data,
        },
        update: data,
      });
      if (isUpdate) result.skipped++;
      else result.sleepUpserted++;
    } catch (err) {
      console.error(`[garmin] sleep row ${dateKey} upsert failed:`, err);
      result.status = 'PARTIAL';
      result.failedChunks++;
    }
  }
}

// ─── detailed nightly → patch (startAt === null ⇔ no sleep that night) ──────

/** Patch produced from the nightly detail payload; `startAt: null` means
 * "no syncable sleep that night — leave the row alone". */
type SleepDetailPatch = Partial<{
  startAt: Date | null;
  endAt: Date | null;
  totalSleepS: number | null;
  deepS: number | null;
  lightS: number | null;
  remS: number | null;
  awakeS: number | null;
  napS: number | null;
  awakeCount: number | null;
  avgSleepStress: number | null;
  avgHr: number | null;
  avgRespiration: number | null;
  sleepScore: number | null;
  bodyBatteryChange: number | null;
  sleepNeedMin: number | null;
  hrvStatus: string | null;
  hrvAvg: number | null;
  raw: Prisma.InputJsonValue;
}>;

interface DailySleepDto {
  sleepStartTimestampGMT?: number;
  sleepEndTimestampGMT?: number;
  sleepTimeSeconds?: number;
  deepSleepSeconds?: number;
  lightSleepSeconds?: number;
  remSleepSeconds?: number;
  awakeSleepSeconds?: number;
  napTimeSeconds?: number;
  awakeCount?: number;
  avgSleepStress?: number;
  avgHeartRate?: number;
  averageRespirationValue?: number;
  sleepScores?: { overall?: { value?: number } };
  sleepNeed?: { baseline?: number; actual?: number };
}

/** Map the `dailySleepDTO` payload (already unwrapped by getSleepDay) onto
 * row fields. `startAt: null` means "night had no syncable sleep". */
function sleepDetailPatch(detail: unknown): SleepDetailPatch {
  const dto = (detail ?? null) as DailySleepDto | null;
  if (!dto || typeof dto !== 'object') return { startAt: null };
  const startMs = num(dto.sleepStartTimestampGMT);
  if (!startMs) return { startAt: null };

  // Keep the response lean: the endpoint also returns large inspection
  // arrays (per-minute movement charts...) that we don't query.
  const raw = {
    sleepScores: dto.sleepScores,
    sleepNeed: dto.sleepNeed,
  } as Prisma.InputJsonValue;

  return {
    startAt: new Date(startMs),
    endAt:
      num(dto.sleepEndTimestampGMT) !== undefined ? new Date(num(dto.sleepEndTimestampGMT)!) : null,
    totalSleepS: num(dto.sleepTimeSeconds) ?? null,
    deepS: num(dto.deepSleepSeconds) ?? null,
    lightS: num(dto.lightSleepSeconds) ?? null,
    remS: num(dto.remSleepSeconds) ?? null,
    awakeS: num(dto.awakeSleepSeconds) ?? null,
    napS: num(dto.napTimeSeconds) ?? null,
    awakeCount: num(dto.awakeCount) ?? null,
    avgSleepStress: num(dto.avgSleepStress) ?? null,
    avgHr: num(dto.avgHeartRate) ?? null,
    avgRespiration: num(dto.averageRespirationValue) ?? null,
    sleepScore: num(dto.sleepScores?.overall?.value) ?? null,
    sleepNeedMin: num(dto.sleepNeed?.baseline) ?? null,
    raw,
  };
}

// ─── daily summaries → daily_wellness ────────────────────────────────────────

interface DailySummaryRow {
  calendarDate?: string;
  movement?: {
    steps?: { goal?: number; value?: number; distanceInMeters?: number };
    floorsAscended?: { goal?: number; value?: number };
    floorsDescended?: { value?: number };
  };
  calories?: { burnedResting?: number; burnedActive?: number; burnedTotal?: number };
  heartRate?: { minValue?: number; maxValue?: number; restingValue?: number };
  intensityMinutes?: { goal?: number; moderate?: number; vigorous?: number };
  wellnessChronology?: unknown;
  stress?: { avgLevel?: number; maxLevel?: number };
  bodyBattery?: {
    minValue?: number;
    maxValue?: number;
    latestValue?: number;
    chargedValue?: number;
    drainedValue?: number;
  };
}

async function upsertDailyChunk(
  connection: GarminConnectionLike,
  rows: DailySummaryRow[],
  seen: Set<string>,
  result: GarminWellnessResult,
): Promise<void> {
  for (const row of rows) {
    const dateKey = str(row.calendarDate);
    if (!dateKey) {
      result.skipped++;
      continue;
    }
    const data = {
      steps: num(row.movement?.steps?.value) ?? null,
      stepsGoal: num(row.movement?.steps?.goal) ?? null,
      distanceM: num(row.movement?.steps?.distanceInMeters) ?? null,
      floorsAsc: num(row.movement?.floorsAscended?.value) ?? null,
      floorsDesc: num(row.movement?.floorsDescended?.value) ?? null,
      activeCal: num(row.calories?.burnedActive) ?? null,
      restingCal: num(row.calories?.burnedResting) ?? null,
      totalCal: num(row.calories?.burnedTotal) ?? null,
      hrMin: num(row.heartRate?.minValue) ?? null,
      hrMax: num(row.heartRate?.maxValue) ?? null,
      restingHr: num(row.heartRate?.restingValue) ?? null,
      moderateMin: num(row.intensityMinutes?.moderate) ?? null,
      vigorousMin: num(row.intensityMinutes?.vigorous) ?? null,
      intensityGoal: num(row.intensityMinutes?.goal) ?? null,
      stressAvg: num(row.stress?.avgLevel) ?? null,
      stressMax: num(row.stress?.maxLevel) ?? null,
      batteryMin: num(row.bodyBattery?.minValue) ?? null,
      batteryMax: num(row.bodyBattery?.maxValue) ?? null,
      batteryLatest: num(row.bodyBattery?.latestValue) ?? null,
      raw: {
        chargedValue: num(row.bodyBattery?.chargedValue) ?? null,
        drainedValue: num(row.bodyBattery?.drainedValue) ?? null,
      } as Prisma.InputJsonValue,
    };
    const isUpdate = seen.has(dateKey);
    seen.add(dateKey);
    try {
      await prisma.dailyWellness.upsert({
        where: {
          userId_provider_dateKey: { userId: connection.userId, provider: 'GARMIN', dateKey },
        },
        create: {
          userId: connection.userId,
          connectionId: connection.id,
          provider: 'GARMIN',
          dateKey,
          ...data,
        },
        update: data,
      });
      if (isUpdate) result.skipped++;
      else result.daysUpserted++;
    } catch (err) {
      console.error(`[garmin] daily row ${dateKey} upsert failed:`, err);
      result.status = 'PARTIAL';
      result.failedChunks++;
    }
  }
}
