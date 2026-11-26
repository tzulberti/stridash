/**
 * Garmin sync-service unit tests — mocked Prisma + provider API, real
 * normalize/ingest code, no network or database. Covers page scanning,
 * known-source skips, FIT fallback, failure classification, gear/device
 * backfill and the edit-detection pass.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, garminApi, parseFitFile, ensureGarminTokens, upsertDevice } = vi.hoisted(() => {
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(),
    syncLog: {
      create: vi.fn(async () => ({ id: 'log-1' })),
      update: vi.fn(async () => ({})),
    },
    connection: { update: vi.fn(async () => ({})) },
    activitySource: {
      findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
      findUnique: vi.fn(async () => null as Record<string, unknown> | null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    activity: {
      findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
      create: vi.fn(async () => ({ id: 'act-1' })),
      update: vi.fn(async () => ({})),
    },
    activityDataPoint: { upsert: vi.fn(async () => ({})) },
    gear: {
      findFirst: vi.fn(async () => null as Record<string, unknown> | null),
      create: vi.fn(async () => ({ id: 'gear-1' })),
      update: vi.fn(async () => ({})),
    },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
    fn(prisma),
  );

  return {
    prisma,
    garminApi: {
      listActivities: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
      downloadFit: vi.fn<(...a: unknown[]) => Promise<Buffer>>(),
      listGear: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
      listGearActivities: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
      listDevices: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
      getActivityDetail: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
    },
    parseFitFile: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
    ensureGarminTokens: vi.fn<(...a: unknown[]) => Promise<string>>(),
    upsertDevice: vi.fn<(...a: unknown[]) => Promise<string>>(),
  };
});

const {
  listActivities,
  downloadFit,
  listGear,
  listGearActivities,
  listDevices,
  getActivityDetail,
} = garminApi;

vi.mock('../src/db.js', () => ({ prisma }));

vi.mock('../src/providers/garmin/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/garmin/api.js')>();
  return { ...actual, ...garminApi };
});

vi.mock('../src/providers/garmin/fitzip.js', () => ({
  extractFitFromDownload: vi.fn((buf: Buffer) => buf),
}));

vi.mock('../src/providers/igpsport/fit.js', () => ({ parseFitFile }));

vi.mock('../src/services/devices.js', () => ({ upsertDevice }));

vi.mock('../src/services/garmin-tokens.js', () => ({ ensureGarminTokens }));

import { syncGarminConnection } from '../src/services/garmin-sync.js';
import { GarminError } from '../src/providers/garmin/sso.js';
import type { GarminActivityRow, GarminGearRow } from '../src/providers/garmin/api.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const env = {
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_JWT_SECRET: 'y'.repeat(32),
} as Parameters<typeof syncGarminConnection>[0];

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  accessTokenEnc: 'ENC:access',
  refreshTokenEnc: 'ENC:refresh',
  status: 'ACTIVE',
  config: {},
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  lastSyncedAt: null,
};

const records = [
  {
    timeMs: Date.UTC(2026, 10, 11, 6, 30),
    distanceM: 0,
    altitudeM: 100,
    speedMs: 2.5,
    hrBpm: 120,
    cadenceRpm: 80,
    powerW: 200,
  },
  {
    timeMs: Date.UTC(2026, 10, 11, 6, 30, 1),
    distanceM: 2.5,
    altitudeM: 101,
    speedMs: 2.6,
    hrBpm: 121,
    cadenceRpm: 81,
    powerW: 201,
  },
];

const fitSession = { avgHr: 120, maxHr: 125, totalCalories: 42 };
const fitDevice = {
  manufacturer: 'garmin',
  productCode: 4024,
  serialNumber: 'SN-1',
  softwareVersion: '1.0',
  hardwareVersion: '2.0',
  raw: { device: 'fit' },
};

function row(id: number, over: Partial<GarminActivityRow> = {}): GarminActivityRow {
  return {
    activityId: id,
    activityName: `Activity ${id}`,
    startTimeGMT: '2026-11-11 06:30:00',
    distance: 1000,
    duration: 600,
    activityType: { typeKey: 'running' },
    ...over,
  } as GarminActivityRow;
}

const detail = {
  lastUpdateDate: '2026-11-11T11:13:12.0',
  device: { deviceId: '42', manufacturer: 'GARMIN', deviceTypePk: 9001 },
  row: row(1),
};

const gearRow = {
  uuid: 'gear-1',
  gearType: 'BIKE',
  brand: 'Trek',
  model: 'Domane',
  status: 'ACTIVE',
  firstUseDate: '2026-01-01',
  usageType: null,
  maxUsageDistanceMeters: null,
} as GarminGearRow;

let scan = {
  known: [] as Array<Record<string, unknown>>,
  gear: [] as Array<Record<string, unknown>>,
  device: [] as Array<Record<string, unknown>>,
  edits: [] as Array<Record<string, unknown>>,
};

type FindArgs = {
  take?: number;
  where?: { activity?: { gearId?: unknown; deviceId?: unknown; startTime?: unknown } };
};

beforeEach(() => {
  vi.clearAllMocks();
  let nextActivity = 1;
  scan = { known: [], gear: [], device: [], edits: [] };

  prisma.syncLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.syncLog.update.mockResolvedValue({});
  prisma.connection.update.mockResolvedValue({});
  prisma.activitySource.findMany.mockImplementation(async (args: FindArgs) => {
    const activity = args?.where?.activity;
    if (activity && 'gearId' in activity) return scan.gear;
    if (activity && 'deviceId' in activity) return scan.device;
    if (activity && 'startTime' in activity) return scan.edits;
    return scan.known;
  });
  prisma.activitySource.findUnique.mockResolvedValue(null);
  prisma.activitySource.create.mockResolvedValue({});
  prisma.activitySource.update.mockResolvedValue({});
  prisma.activity.findMany.mockResolvedValue([]);
  prisma.activity.create.mockImplementation(async () => ({ id: `act-${nextActivity++}` }));
  prisma.activity.update.mockResolvedValue({});
  prisma.activityDataPoint.upsert.mockResolvedValue({});
  prisma.gear.findFirst.mockResolvedValue(null);
  prisma.gear.create.mockResolvedValue({ id: 'gear-1' });
  prisma.gear.update.mockResolvedValue({});

  listActivities.mockReset();
  downloadFit.mockReset();
  listGear.mockReset();
  listGearActivities.mockReset();
  listDevices.mockReset();
  getActivityDetail.mockReset();
  parseFitFile.mockReset();
  ensureGarminTokens.mockReset();
  upsertDevice.mockReset();

  listActivities.mockResolvedValue([]);
  downloadFit.mockResolvedValue(Buffer.from('fit'));
  listGear.mockResolvedValue([]);
  listGearActivities.mockResolvedValue([]);
  listDevices.mockResolvedValue([]);
  getActivityDetail.mockResolvedValue(detail);
  parseFitFile.mockResolvedValue({ records, session: fitSession, device: fitDevice });
  ensureGarminTokens.mockResolvedValue('bearer');
  upsertDevice.mockResolvedValue('dev-1');
});

// ─── Page scan / ingest ─────────────────────────────────────────────────────

describe('syncGarminConnection — page scan', () => {
  it('ingests fresh rows with FIT series and device attribution', async () => {
    listActivities.mockResolvedValueOnce([row(1), row(2)]).mockResolvedValueOnce([]);

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({
      status: 'OK',
      itemsPulled: 2,
      itemsCreated: 2,
      itemsUpdated: 0,
      failedActivities: [],
    });
    expect(listActivities).toHaveBeenNthCalledWith(1, 'bearer', 0, 20);
    expect(listActivities).toHaveBeenNthCalledWith(2, 'bearer', 20, 20);
    expect(downloadFit).toHaveBeenCalledTimes(2);
    expect(prisma.activity.create).toHaveBeenCalledTimes(2);
    expect(prisma.activityDataPoint.upsert).toHaveBeenCalledTimes(2);
    expect(upsertDevice).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ provider: 'GARMIN', sourceDeviceId: 'SN-1' }),
    );

    const created = (prisma.activity.create.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(created).toMatchObject({
      userId: 'user-1',
      headline: 'Activity 1',
      type: 'RUN',
      avgHr: 120,
      maxHr: 125,
      deviceId: 'dev-1',
    });

    const log = prisma.syncLog.update.mock.calls.at(-1)![0] as {
      data: { status: string; itemsPulled: number; itemsCreated: number };
    };
    expect(log.data).toMatchObject({ status: 'OK', itemsPulled: 2, itemsCreated: 2 });
    expect(prisma.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-1' },
        data: { lastSyncedAt: expect.any(Date) },
      }),
    );
  });

  it('skips known provider ids but still counts them as pulled', async () => {
    scan.known = [{ sourceActivityId: '1' }];
    listActivities.mockResolvedValueOnce([row(1), row(2)]).mockResolvedValueOnce([]);

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsPulled: 2, itemsCreated: 1 });
    expect(downloadFit).toHaveBeenCalledTimes(1);
    expect(downloadFit).toHaveBeenCalledWith('bearer', '2');
  });

  it('marks a failed list page PARTIAL and stops scanning', async () => {
    listActivities.mockRejectedValueOnce(new Error('list down'));

    const result = await syncGarminConnection(env, connection);

    expect(result.status).toBe('PARTIAL');
    expect(result.failedActivities).toEqual(['page:0']);
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('marks one failed ingest PARTIAL while the next row still lands', async () => {
    listActivities.mockResolvedValueOnce([row(1), row(2)]).mockResolvedValueOnce([]);
    prisma.activity.create.mockRejectedValueOnce(new Error('insert failed'));

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'PARTIAL', itemsCreated: 1 });
    expect(result.failedActivities).toEqual(['1']);
  });

  it('falls back to the list summary when FIT download/parse fails', async () => {
    listActivities.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([]);
    parseFitFile.mockRejectedValueOnce(new Error('bad fit'));

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsCreated: 1 });
    const created = (prisma.activity.create.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(created.headline).toBe('Activity 1');
    expect(created.raw).toMatchObject({ provider: 'GARMIN', approximateStartTime: true });
    expect(prisma.activityDataPoint.upsert).not.toHaveBeenCalled();
  });
});

// ─── Degraded optional metadata ─────────────────────────────────────────────

describe('syncGarminConnection — optional metadata failures', () => {
  it('gear failure degrades to PARTIAL without blocking activities', async () => {
    listActivities.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([]);
    listGear.mockRejectedValueOnce(new Error('gear down'));

    const result = await syncGarminConnection(env, connection);

    expect(result.status).toBe('PARTIAL');
    expect(result.failedActivities).toEqual(['gear:list']);
    expect(result.itemsCreated).toBe(1);
  });

  it('device-list failure degrades to PARTIAL but activities still sync', async () => {
    listActivities.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([]);
    listDevices.mockRejectedValueOnce(new Error('devices down'));

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'PARTIAL', itemsCreated: 1 });
    expect(result.failedActivities).toEqual(['devices:list']);
  });

  it('gear sync maps activities and backfills an unassigned row', async () => {
    listGear.mockResolvedValueOnce([gearRow]);
    listGearActivities.mockResolvedValueOnce([{ activityId: 1 }]);
    prisma.gear.create.mockResolvedValueOnce({ id: 'gear-1' });
    scan.gear = [{ activityId: 'act-1', sourceActivityId: '1' }];

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsUpdated: 1 });
    expect(prisma.activity.update).toHaveBeenCalledWith({
      where: { id: 'act-1' },
      data: { gearId: 'gear-1' },
    });
  });

  it('device backfill resolves the recorder and fills an empty device slot', async () => {
    listDevices.mockResolvedValueOnce([{ deviceId: 42, productDisplayName: 'Forerunner 955' }]);
    scan.device = [{ activityId: 'act-1', sourceActivityId: '1' }];
    upsertDevice.mockResolvedValueOnce('dev-9');

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsUpdated: 1 });
    expect(upsertDevice).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        provider: 'GARMIN',
        sourceDeviceId: '42',
        model: 'Forerunner 955',
      }),
    );
    expect(prisma.activity.update).toHaveBeenCalledWith({
      where: { id: 'act-1' },
      data: { deviceId: 'dev-9' },
    });
  });

  it('edit detection re-ingests only when the provider timestamp is newer', async () => {
    scan.edits = [
      {
        activityId: 'act-1',
        sourceActivityId: '1',
        sourceUpdatedAt: new Date('2026-11-09T00:00:00.000Z'),
      },
    ];
    getActivityDetail.mockResolvedValueOnce(detail);

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsUpdated: 1 });
    const update = (prisma.activity.update.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(update.headline).toBe('Activity 1');
    expect(prisma.activityDataPoint.upsert).toHaveBeenCalled();
    const sourceUpdate = (
      prisma.activitySource.update.mock.calls[0]![0] as {
        data: { sourceUpdatedAt: Date };
      }
    ).data;
    expect(sourceUpdate.sourceUpdatedAt).toEqual(new Date('2026-11-11T11:13:12.000Z'));
  });

  it('does not re-ingest when the provider timestamp is not newer', async () => {
    scan.edits = [
      {
        activityId: 'act-1',
        sourceActivityId: '1',
        sourceUpdatedAt: new Date('2026-11-12T00:00:00.000Z'),
      },
    ];

    const result = await syncGarminConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsUpdated: 0 });
    expect(prisma.activity.update).not.toHaveBeenCalled();
  });
});

// ─── Fatal errors ────────────────────────────────────────────────────────────

describe('syncGarminConnection — fatal errors', () => {
  it('marks the sync log ERROR and rethrows when tokens fail', async () => {
    ensureGarminTokens.mockRejectedValueOnce(new GarminError('CONNECTION', 'revoked'));

    await expect(syncGarminConnection(env, { ...connection, status: 'REVOKED' })).rejects.toThrow(
      'revoked',
    );
    const errorLog = prisma.syncLog.update.mock.calls[0]![0] as {
      data: { status: string; errorDetail: { error: string } };
    };
    expect(errorLog.data.status).toBe('ERROR');
    expect(errorLog.data.errorDetail.error).toContain('revoked');
    expect(prisma.connection.update).not.toHaveBeenCalled();
  });
});
