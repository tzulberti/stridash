/**
 * Garmin wellness sync tests — mocked Prisma + provider endpoints, no
 * network. Covers sleep/daily chunk upserts, detail enrichment, malformed
 * rows, PARTIAL degradation and the fatal token path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, getSleepStatsRange, getDailySummaries, getSleepDay, ensureGarminTokens } =
  vi.hoisted(() => {
    const prisma = {
      syncLog: {
        create: vi.fn(async () => ({ id: 'log-1' })),
        update: vi.fn(async () => ({})),
      },
      sleepSession: {
        findFirst: vi.fn(async () => null as Record<string, unknown> | null),
        upsert: vi.fn(async () => ({})),
      },
      dailyWellness: {
        findFirst: vi.fn(async () => null as Record<string, unknown> | null),
        upsert: vi.fn(async () => ({})),
      },
    };
    return {
      prisma,
      getSleepStatsRange: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
      getDailySummaries: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
      getSleepDay: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
      ensureGarminTokens: vi.fn<(...a: unknown[]) => Promise<string>>(),
    };
  });

vi.mock('../src/db.js', () => ({ prisma }));

vi.mock('../src/providers/garmin/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/garmin/api.js')>();
  return { ...actual, getSleepStatsRange, getDailySummaries, getSleepDay };
});

vi.mock('../src/services/garmin-tokens.js', () => ({ ensureGarminTokens }));

import { syncGarminWellness } from '../src/services/garmin-wellness.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const env = {
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_JWT_SECRET: 'y'.repeat(32),
} as Parameters<typeof syncGarminWellness>[0];

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  accessTokenEnc: 'ENC:access',
  refreshTokenEnc: null,
  status: 'ACTIVE',
  config: {},
};

const today = new Date().toISOString().slice(0, 10);
const sleepStart = Date.UTC(2026, 10, 25, 23, 0);
const sleepEnd = Date.UTC(2026, 10, 26, 7, 0);

const sleepRow = {
  calendarDate: today,
  values: {
    gmtSleepStartTimeInMillis: sleepStart,
    gmtSleepEndTimeInMillis: sleepEnd,
    totalSleepTimeInSeconds: 28_800,
    deepTime: 7_200,
    lightTime: 14_400,
    remTime: 7_200,
    awakeTime: 1_800,
    restingHeartRate: 50,
    avgHeartRate: 58,
    respiration: 14,
    sleepScore: 80,
  },
};

const dailyRow = {
  calendarDate: today,
  movement: {
    steps: { value: 10_000, goal: 8_000, distanceInMeters: 8_000 },
    floorsAscended: { value: 12, goal: 10 },
    floorsDescended: { value: 11 },
  },
  calories: { burnedResting: 1_500, burnedActive: 500, burnedTotal: 2_000 },
  heartRate: { minValue: 45, maxValue: 150, restingValue: 50 },
  intensityMinutes: { goal: 150, moderate: 20, vigorous: 10 },
  stress: { avgLevel: 30, maxLevel: 80 },
  bodyBattery: { minValue: 20, maxValue: 90, latestValue: 70, chargedValue: 40, drainedValue: 30 },
};

const sleepDetail = {
  sleepStartTimestampGMT: sleepStart,
  sleepEndTimestampGMT: sleepEnd,
  sleepTimeSeconds: 30_000,
  deepSleepSeconds: 7_500,
  lightSleepSeconds: 15_000,
  remSleepSeconds: 7_500,
  awakeSleepSeconds: 1_000,
  napTimeSeconds: 0,
  awakeCount: 2,
  avgSleepStress: 20,
  avgHeartRate: 57,
  averageRespirationValue: 13,
  sleepScores: { overall: { value: 82 } },
  sleepNeed: { baseline: 480, actual: 500 },
};

beforeEach(() => {
  vi.clearAllMocks();
  getSleepStatsRange.mockReset();
  getDailySummaries.mockReset();
  getSleepDay.mockReset();
  ensureGarminTokens.mockReset();

  prisma.syncLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.syncLog.update.mockResolvedValue({});
  prisma.sleepSession.findFirst.mockResolvedValue({ dateKey: today });
  prisma.sleepSession.upsert.mockResolvedValue({});
  prisma.dailyWellness.findFirst.mockResolvedValue({ dateKey: today });
  prisma.dailyWellness.upsert.mockResolvedValue({});

  ensureGarminTokens.mockResolvedValue('bearer');
  getSleepStatsRange.mockResolvedValue([sleepRow]);
  getDailySummaries.mockResolvedValue([dailyRow]);
  getSleepDay.mockImplementation(async (_bearer: unknown, d: unknown) =>
    d === today ? sleepDetail : null,
  );
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('syncGarminWellness', () => {
  it('upserts sleep + daily ranges and enriches the current night', async () => {
    const result = await syncGarminWellness(env, connection);

    expect(result).toMatchObject({
      status: 'OK',
      sleepPulled: 1,
      daysPulled: 1,
      sleepUpserted: 2, // range row + detail patch for today
      daysUpserted: 1,
      skipped: 0,
      failedChunks: 0,
    });
    expect(getSleepStatsRange).toHaveBeenCalledWith('bearer', today, today);
    expect(getDailySummaries).toHaveBeenCalledWith('bearer', today, today);
    expect(prisma.sleepSession.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.dailyWellness.upsert).toHaveBeenCalledTimes(1);

    const sleepCreate = (
      prisma.sleepSession.upsert.mock.calls[0]![0] as {
        create: Record<string, unknown>;
      }
    ).create;
    expect(sleepCreate).toMatchObject({
      userId: 'user-1',
      provider: 'GARMIN',
      dateKey: today,
      totalSleepS: 28_800,
      deepS: 7_200,
      restingHr: 50,
      sleepScore: 80,
    });

    const dailyCreate = (
      prisma.dailyWellness.upsert.mock.calls[0]![0] as {
        create: Record<string, unknown>;
      }
    ).create;
    expect(dailyCreate).toMatchObject({
      steps: 10_000,
      stepsGoal: 8_000,
      distanceM: 8_000,
      activeCal: 500,
      restingHr: 50,
      moderateMin: 20,
      vigorousMin: 10,
      stressAvg: 30,
      batteryLatest: 70,
    });

    const detailUpdate = (
      prisma.sleepSession.upsert.mock.calls[1]![0] as {
        update: Record<string, unknown>;
      }
    ).update;
    expect(detailUpdate).toMatchObject({
      totalSleepS: 30_000,
      napS: 0,
      awakeCount: 2,
      avgSleepStress: 20,
      sleepScore: 82,
      sleepNeedMin: 480,
    });

    const log = prisma.syncLog.update.mock.calls.at(-1)![0] as {
      data: { status: string; itemsPulled: number; itemsCreated: number };
    };
    expect(log.data).toMatchObject({ status: 'OK', itemsPulled: 2, itemsCreated: 3 });
  });

  it('splits a deep backfill into 28-day chunks', async () => {
    const start = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    prisma.sleepSession.findFirst.mockResolvedValue({ dateKey: start });
    prisma.dailyWellness.findFirst.mockResolvedValue(null);

    const result = await syncGarminWellness(env, connection);

    expect(result.status).toBe('OK');
    expect(getSleepStatsRange).toHaveBeenCalledTimes(3);
    expect(getSleepStatsRange.mock.calls[0]![1]).toBe(start);
    expect(getDailySummaries).toHaveBeenCalledTimes(3);
  });

  it('skips rows without a usable date or sleep start', async () => {
    getSleepStatsRange.mockResolvedValue([{ calendarDate: today, values: {} }, {}]);
    getDailySummaries.mockResolvedValue([{}]);
    getSleepDay.mockResolvedValue(null);

    const result = await syncGarminWellness(env, connection);

    expect(result).toMatchObject({
      status: 'OK',
      sleepPulled: 2,
      daysPulled: 1,
      sleepUpserted: 0,
      daysUpserted: 0,
      skipped: 3,
    });
    expect(prisma.sleepSession.upsert).not.toHaveBeenCalled();
    expect(prisma.dailyWellness.upsert).not.toHaveBeenCalled();
  });
});

// ─── Degraded / fatal paths ─────────────────────────────────────────────────

describe('syncGarminWellness — failures', () => {
  it('a failed sleep range degrades to PARTIAL while daily data lands', async () => {
    getSleepStatsRange.mockRejectedValueOnce(new Error('sleep down'));

    const result = await syncGarminWellness(env, connection);

    expect(result).toMatchObject({
      status: 'PARTIAL',
      sleepPulled: 0,
      daysPulled: 1,
      daysUpserted: 1,
      failedChunks: 1,
    });
    expect(prisma.syncLog.update.mock.calls.at(-1)![0]).toMatchObject({
      data: { status: 'PARTIAL', errorDetail: { failedChunks: 1 } },
    });
  });

  it('a failed daily summary degrades to PARTIAL while sleep lands', async () => {
    getDailySummaries.mockRejectedValueOnce(new Error('daily down'));

    const result = await syncGarminWellness(env, connection);

    expect(result).toMatchObject({
      status: 'PARTIAL',
      sleepPulled: 1,
      daysPulled: 0,
      sleepUpserted: 2,
      failedChunks: 1,
    });
  });

  it('a failed nightly detail degrades to PARTIAL', async () => {
    getSleepDay.mockRejectedValueOnce(new Error('detail down'));

    const result = await syncGarminWellness(env, connection);

    expect(result).toMatchObject({ status: 'PARTIAL', failedChunks: 1 });
    // the failed night is skipped, today still gets its detail patch
    expect(prisma.sleepSession.upsert).toHaveBeenCalledTimes(2);
  });

  it('marks the log ERROR and rethrows when tokens fail', async () => {
    ensureGarminTokens.mockRejectedValueOnce(new Error('revoked'));

    await expect(syncGarminWellness(env, connection)).rejects.toThrow('revoked');
    const errorLog = prisma.syncLog.update.mock.calls[0]![0] as {
      data: { status: string; errorDetail: { error: string } };
    };
    expect(errorLog.data.status).toBe('ERROR');
    expect(errorLog.data.errorDetail.error).toContain('revoked');
  });
});
