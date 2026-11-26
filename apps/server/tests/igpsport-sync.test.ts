/**
 * iGPSPORT sync-service unit tests — mocked Prisma + client class, real
 * normalize/ingest code, no network or database. Covers page scanning,
 * known-source skips, stale-page stopping, FIT fallback, device backfill and
 * the login/degraded-error paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, client, parseFitFile, upsertDevice } = vi.hoisted(() => {
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
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
    fn(prisma),
  );

  return {
    prisma,
    client: {
      listActivities: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
      downloadFit: vi.fn<(...a: unknown[]) => Promise<Buffer>>(),
      getActivityDetail: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
      login: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
    },
    parseFitFile: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
    upsertDevice: vi.fn<(...a: unknown[]) => Promise<string>>(),
  };
});

vi.mock('../src/db.js', () => ({ prisma }));

vi.mock('../src/crypto.js', () => ({
  decryptToken: vi.fn((enc: string) => enc.replace('ENC:', '')),
  encryptToken: vi.fn((t: string) => `ENC:${t}`),
}));

vi.mock('../src/providers/igpsport/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/igpsport/client.js')>();
  class MockIgpSportClient {
    listActivities = client.listActivities;
    downloadFit = client.downloadFit;
    getActivityDetail = client.getActivityDetail;
    login = client.login;
    withAccessToken(): this {
      return this;
    }
  }
  return { ...actual, IgpSportClient: MockIgpSportClient };
});

vi.mock('../src/providers/igpsport/fit.js', () => ({ parseFitFile }));

vi.mock('../src/services/devices.js', () => ({ upsertDevice }));

import { syncIgpSportConnection } from '../src/services/igpsport-sync.js';
import { IgpSportError, type IgpSportActivityRow } from '../src/providers/igpsport/client.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const env = {
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_JWT_SECRET: 'y'.repeat(32),
} as Parameters<typeof syncIgpSportConnection>[0];

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  accessTokenEnc: 'ENC:access',
  refreshTokenEnc: 'ENC:password',
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  lastSyncedAt: null,
  status: 'ACTIVE',
  config: { igpsport: { region: 'intl', username: 'rider@example.com' } },
};

const records = [
  {
    timeMs: Date.UTC(2026, 10, 11, 6, 30),
    distanceM: 0,
    altitudeM: 100,
    speedMs: 7.5,
    hrBpm: 120,
    cadenceRpm: 80,
    powerW: 200,
  },
  {
    timeMs: Date.UTC(2026, 10, 11, 6, 30, 1),
    distanceM: 7.5,
    altitudeM: 101,
    speedMs: 7.6,
    hrBpm: 121,
    cadenceRpm: 81,
    powerW: 201,
  },
];

const session = { avgHr: 120, maxHr: 125 };
const fitDevice = {
  manufacturer: 'igpsport',
  productCode: 10,
  serialNumber: 'IGP-1',
  softwareVersion: '1.0',
  hardwareVersion: '2.0',
  raw: { device: 'fit' },
};

function row(
  rideId: string | number,
  over: Partial<IgpSportActivityRow> = {},
): IgpSportActivityRow {
  return {
    rideId,
    title: `Ride ${rideId}`,
    startTime: '2026-11-11 06:30:00',
    rideDistance: 1000,
    totalMovingTime: 600,
    exerciseType: 0,
    ...over,
  };
}

let scan = {
  known: [] as Array<Record<string, unknown>>,
  device: [] as Array<Record<string, unknown>>,
};

type FindArgs = {
  where?: { activity?: { deviceId?: unknown } };
};

beforeEach(() => {
  vi.clearAllMocks();
  let nextActivity = 1;
  scan = { known: [], device: [] };

  client.listActivities.mockReset();
  client.downloadFit.mockReset();
  client.getActivityDetail.mockReset();
  client.login.mockReset();
  parseFitFile.mockReset();
  upsertDevice.mockReset();

  prisma.syncLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.syncLog.update.mockResolvedValue({});
  prisma.connection.update.mockResolvedValue({});
  prisma.activitySource.findMany.mockImplementation(async (args: FindArgs) =>
    args?.where?.activity && 'deviceId' in args.where.activity ? scan.device : scan.known,
  );
  prisma.activitySource.findUnique.mockResolvedValue(null);
  prisma.activitySource.create.mockResolvedValue({});
  prisma.activitySource.update.mockResolvedValue({});
  prisma.activity.findMany.mockResolvedValue([]);
  prisma.activity.create.mockImplementation(async () => ({ id: `act-${nextActivity++}` }));
  prisma.activity.update.mockResolvedValue({});
  prisma.activityDataPoint.upsert.mockResolvedValue({});

  client.listActivities.mockResolvedValue([]);
  client.downloadFit.mockResolvedValue(Buffer.from('fit'));
  client.getActivityDetail.mockResolvedValue(row('1'));
  client.login.mockResolvedValue({ access_token: 'jwt', expires_in: 3600 });
  parseFitFile.mockResolvedValue({ records, session, device: fitDevice });
  upsertDevice.mockResolvedValue('dev-1');
});

// ─── Page scan / ingest ─────────────────────────────────────────────────────

describe('syncIgpSportConnection — page scan', () => {
  it('ingests fresh rides with FIT series and device attribution', async () => {
    client.listActivities.mockResolvedValueOnce([row('1'), row('2')]).mockResolvedValueOnce([]);

    const result = await syncIgpSportConnection(env, connection);

    expect(result).toMatchObject({
      status: 'OK',
      itemsPulled: 2,
      itemsCreated: 2,
      itemsUpdated: 0,
      failedRides: [],
    });
    expect(client.listActivities).toHaveBeenNthCalledWith(1, 1, 20);
    expect(client.listActivities).toHaveBeenNthCalledWith(2, 2, 20);
    expect(client.downloadFit).toHaveBeenCalledTimes(2);
    expect(prisma.activity.create).toHaveBeenCalledTimes(2);
    expect(prisma.activityDataPoint.upsert).toHaveBeenCalledTimes(2);
    expect(upsertDevice).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ provider: 'IGPSPORT', sourceDeviceId: 'IGP-1' }),
    );

    const created = (prisma.activity.create.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(created).toMatchObject({
      userId: 'user-1',
      headline: 'Ride 1',
      type: 'RIDE',
      avgHr: 121,
      maxHr: 121,
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

  it('skips known ids but counts them as pulled', async () => {
    scan.known = [{ sourceActivityId: '1' }];
    client.listActivities.mockResolvedValueOnce([row('1'), row('2')]).mockResolvedValueOnce([]);

    const result = await syncIgpSportConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsPulled: 2, itemsCreated: 1 });
    expect(client.downloadFit).toHaveBeenCalledTimes(1);
    expect(client.downloadFit).toHaveBeenCalledWith('2');
  });

  it('stops after two consecutive stale pages', async () => {
    scan.known = [{ sourceActivityId: '1' }];
    client.listActivities
      .mockResolvedValueOnce([row('1')])
      .mockResolvedValueOnce([row('1')])
      .mockResolvedValueOnce([row('2')]);

    const result = await syncIgpSportConnection(env, connection);

    expect(client.listActivities).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'OK', itemsPulled: 2, itemsCreated: 0 });
  });

  it('marks a failed list page PARTIAL and stops scanning', async () => {
    client.listActivities.mockRejectedValueOnce(new Error('list down'));

    const result = await syncIgpSportConnection(env, connection);

    expect(result.status).toBe('PARTIAL');
    expect(result.failedRides).toEqual(['page:1']);
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('marks one failed ingest PARTIAL while the next ride still lands', async () => {
    client.listActivities.mockResolvedValueOnce([row('1'), row('2')]).mockResolvedValueOnce([]);
    prisma.activity.create.mockRejectedValueOnce(new Error('insert failed'));

    const result = await syncIgpSportConnection(env, connection);

    expect(result).toMatchObject({ status: 'PARTIAL', itemsCreated: 1 });
    expect(result.failedRides).toEqual(['1']);
  });

  it('falls back to the row summary when FIT download/parse fails', async () => {
    client.listActivities.mockResolvedValueOnce([row('1')]).mockResolvedValueOnce([]);
    parseFitFile.mockRejectedValueOnce(new Error('bad fit'));

    const result = await syncIgpSportConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsCreated: 1 });
    const created = (prisma.activity.create.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(created.headline).toBe('Ride 1');
    expect(created.raw).toMatchObject({ provider: 'IGPSPORT', approximateStartTime: true });
    expect(prisma.activityDataPoint.upsert).not.toHaveBeenCalled();
  });
});

// ─── Login / degraded metadata ──────────────────────────────────────────────

describe('syncIgpSportConnection — login and backfill', () => {
  it('re-logins when the access token is stale and stores the new pair', async () => {
    const stale = { ...connection, accessTokenEnc: null, tokenExpiresAt: new Date(0) };
    client.listActivities.mockResolvedValueOnce([]);

    await syncIgpSportConnection(env, stale);

    expect(client.login).toHaveBeenCalledWith('rider@example.com', 'password');
    expect(prisma.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-1' },
        data: expect.objectContaining({
          accessTokenEnc: 'ENC:jwt',
          tokenExpiresAt: expect.any(Date),
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('device backfill downloads the FIT and fills an empty device slot', async () => {
    scan.device = [{ activityId: 'act-1', sourceActivityId: '1' }];
    upsertDevice.mockResolvedValueOnce('dev-9');

    const result = await syncIgpSportConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsUpdated: 1 });
    expect(prisma.activity.update).toHaveBeenCalledWith({
      where: { id: 'act-1' },
      data: { deviceId: 'dev-9' },
    });
  });

  it('a failed device backfill is PARTIAL, not fatal', async () => {
    scan.device = [{ activityId: 'act-1', sourceActivityId: '1' }];
    client.downloadFit.mockRejectedValueOnce(new Error('fit down'));

    const result = await syncIgpSportConnection(env, connection);

    expect(result.status).toBe('PARTIAL');
    expect(result.failedRides).toEqual(['device:1']);
  });

  it('a revoked connection marks the log ERROR before any API call', async () => {
    await expect(
      syncIgpSportConnection(env, { ...connection, status: 'REVOKED' }),
    ).rejects.toBeInstanceOf(IgpSportError);
    expect(client.listActivities).not.toHaveBeenCalled();
    const errorLog = prisma.syncLog.update.mock.calls[0]![0] as {
      data: { status: string };
    };
    expect(errorLog.data.status).toBe('ERROR');
  });

  it('a rejected login marks the log ERROR and rethrows', async () => {
    const stale = { ...connection, accessTokenEnc: null, tokenExpiresAt: new Date(0) };
    client.login.mockRejectedValueOnce(new IgpSportError('bad credentials'));

    await expect(syncIgpSportConnection(env, stale)).rejects.toThrow('bad credentials');
    const errorLog = prisma.syncLog.update.mock.calls[0]![0] as {
      data: { status: string; errorDetail: { error: string } };
    };
    expect(errorLog.data.status).toBe('ERROR');
    expect(errorLog.data.errorDetail.error).toContain('bad credentials');
  });
});
