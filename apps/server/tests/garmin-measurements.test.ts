/** Garmin health sync: weigh-ins/body composition + blood pressure. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, api, tokens } = vi.hoisted(() => {
  const prisma = {
    syncLog: {
      create: vi.fn(async () => ({ id: 'log-1' })),
      update: vi.fn(async () => ({})),
    },
    measurement: {
      findFirst: vi.fn(),
      upsert: vi.fn(async () => ({})),
    },
  };
  const api = {
    getWeightRange: vi.fn(),
    getBloodPressureRange: vi.fn(),
  };
  const tokens = { ensure: vi.fn() };
  return { prisma, api, tokens };
});

vi.mock('../src/db.js', () => ({ prisma }));
vi.mock('../src/providers/garmin/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/garmin/api.js')>();
  return { ...actual, ...api };
});
vi.mock('../src/services/garmin-tokens.js', () => ({
  ensureGarminTokens: tokens.ensure,
}));

import { syncGarminMeasurements } from '../src/services/garmin-measurements.js';
import type { Env } from '../src/env.js';

const env = {
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_GARMIN_HEALTH_BACKFILL_DAYS: 365,
} as unknown as Env;

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  accessTokenEnc: 'enc:access',
  refreshTokenEnc: 'enc:refresh',
  status: 'ACTIVE',
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.syncLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.syncLog.update.mockResolvedValue({});
  prisma.measurement.findFirst.mockReset();
  prisma.measurement.findFirst.mockResolvedValue(null);
  prisma.measurement.upsert.mockReset();
  prisma.measurement.upsert.mockResolvedValue({});
  api.getWeightRange.mockReset();
  api.getBloodPressureRange.mockReset();
  api.getWeightRange.mockResolvedValue({
    dateWeightList: [
      { calendarDate: '2026-11-20', weight: 82_500, bodyFat: 18.4 },
      { calendarDate: '2026-11-21', weight: 82_100, bodyFat: 18.2 },
    ],
  });
  api.getBloodPressureRange.mockResolvedValue({
    measurementSummaries: [
      {
        calendarDate: '2026-11-20',
        measurements: [{ systolic: 120, diastolic: 80, pulse: 62 }],
      },
    ],
  });
  tokens.ensure.mockReset();
  tokens.ensure.mockResolvedValue('bearer');
});

describe('syncGarminMeasurements', () => {
  it('upserts weigh-ins and blood pressure with a MEASUREMENTS log', async () => {
    const result = await syncGarminMeasurements(env, connection);

    expect(result).toMatchObject({
      status: 'OK',
      weightPulled: 2,
      weightUpserted: 2,
      bloodPressurePulled: 1,
      bloodPressureUpserted: 1,
      failed: [],
    });
    expect(tokens.ensure).toHaveBeenCalledWith(env, connection);
    expect(prisma.measurement.upsert).toHaveBeenCalledTimes(3);
    const weight = prisma.measurement.upsert.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(weight.where).toEqual({
      userId_provider_kind_measuredAt: {
        userId: 'user-1',
        provider: 'GARMIN',
        kind: 'WEIGH_IN',
        measuredAt: new Date('2026-11-20T12:00:00.000Z'),
      },
    });
    expect(weight.create).toMatchObject({
      userId: 'user-1',
      connectionId: 'conn-1',
      provider: 'GARMIN',
      kind: 'WEIGH_IN',
      weightKg: 82.5,
      bodyFatPct: 18.4,
    });
    expect(weight.update).toMatchObject({ weightKg: 82.5, connectionId: 'conn-1' });
    expect(weight.update).not.toHaveProperty('measuredAt');

    expect(prisma.syncLog.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'OK',
          itemsPulled: 3,
          itemsCreated: 3,
        }),
      }),
    );
  });

  it('uses a 7-day overlap from the newest stored reading for each kind', async () => {
    prisma.measurement.findFirst
      .mockResolvedValueOnce({ measuredAt: new Date('2026-11-10T12:00:00Z') })
      .mockResolvedValueOnce({ measuredAt: new Date('2026-10-01T12:00:00Z') });

    await syncGarminMeasurements(env, connection);

    expect(api.getWeightRange).toHaveBeenCalledWith('bearer', '2026-11-03', expect.any(String));
    expect(api.getBloodPressureRange).toHaveBeenCalledWith(
      'bearer',
      '2026-09-24',
      expect.any(String),
    );
  });

  it('degrades one failed endpoint to PARTIAL while the other lands', async () => {
    api.getWeightRange.mockRejectedValueOnce(new Error('weight down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await syncGarminMeasurements(env, connection);
    log.mockRestore();

    expect(result).toMatchObject({
      status: 'PARTIAL',
      weightPulled: 0,
      weightUpserted: 0,
      bloodPressurePulled: 1,
      bloodPressureUpserted: 1,
      failed: ['weight'],
    });
    expect(prisma.syncLog.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PARTIAL', errorDetail: { failed: ['weight'] } }),
      }),
    );
  });

  it('marks the log ERROR and rethrows when token refresh fails', async () => {
    tokens.ensure.mockRejectedValueOnce(new Error('revoked'));

    await expect(syncGarminMeasurements(env, connection)).rejects.toThrow('revoked');
    expect(prisma.syncLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR' }) }),
    );
    expect(api.getWeightRange).not.toHaveBeenCalled();
  });
});
