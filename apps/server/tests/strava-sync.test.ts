/**
 * Strava sync orchestration — mocked Prisma/client/token layer, real mapping
 * and ingest handlers. Covers watermark paging, detail/streams/gear fallback,
 * token rotation, known-source skips and PARTIAL vs ERROR.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, client, tokens, ingest, series } = vi.hoisted(() => {
  const prisma = {
    syncLog: {
      create: vi.fn(async () => ({ id: 'log-1' })),
      update: vi.fn(async () => ({})),
    },
    connection: { update: vi.fn(async () => ({})) },
    activitySource: { findMany: vi.fn(async () => [] as Array<Record<string, unknown>>) },
    gear: {
      findFirst: vi.fn(async () => null as Record<string, unknown> | null),
      create: vi.fn(async () => ({ id: 'gear-1' })),
      update: vi.fn(async () => ({ id: 'gear-1' })),
    },
  };
  const client = {
    token: '',
    listActivities: vi.fn(),
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    getGear: vi.fn(),
  };
  const tokens = { refresh: vi.fn() };
  const ingest = vi.fn();
  const series = vi.fn(async () => undefined);
  return { prisma, client, tokens, ingest, series };
});

vi.mock('../src/db.js', () => ({ prisma }));
vi.mock('../src/crypto.js', () => ({
  decryptToken: vi.fn((value: string) => value.replace('enc:', '')),
  encryptToken: vi.fn((value: string) => `enc:${value}`),
}));
vi.mock('../src/services/activity-ingest.js', () => ({ ingestActivity: ingest }));
vi.mock('../src/services/activity-series.js', () => ({ upsertActivitySeries: series }));
vi.mock('../src/providers/strava/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/strava/client.js')>();
  class MockStravaClient {
    constructor(token: string) {
      client.token = token;
    }
    listActivities = client.listActivities;
    getActivity = client.getActivity;
    getActivityStreams = client.getActivityStreams;
    getGear = client.getGear;
  }
  return {
    ...actual,
    StravaClient: MockStravaClient,
    refreshStravaToken: tokens.refresh,
  };
});

import { syncStravaConnection } from '../src/services/strava-sync.js';
import { StravaError } from '../src/providers/strava/client.js';
import type { Env } from '../src/env.js';

const env = {
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_STRAVA_CLIENT_ID: 'client-1',
  STRIDASH_STRAVA_CLIENT_SECRET: 'secret-1',
  STRIDASH_STRAVA_REDIRECT_URI: 'https://stridash.example/api/strava/callback',
  STRIDASH_STRAVA_BACKFILL_DAYS: 365,
} as unknown as Env;

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  accessTokenEnc: 'enc:access-1',
  refreshTokenEnc: 'enc:refresh-1',
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  lastSyncedAt: new Date('2026-11-20T00:00:00Z'),
  status: 'ACTIVE',
};

const summary = {
  id: 9001,
  name: 'Morning Ride',
  type: 'Ride',
  sport_type: 'Ride',
  start_date: '2026-11-20T08:00:00Z',
  elapsed_time: 3_600,
  moving_time: 3_500,
  distance: 30_000,
  average_speed: 8.33,
  max_speed: 12,
  total_elevation_gain: 300,
  average_heartrate: 140,
  max_heartrate: 175,
  average_watts: 200,
  max_watts: 400,
  average_cadence: 85,
  trainer: false,
  gear_id: 'b123',
};

const detail = {
  ...summary,
  calories: 700,
  suffer_score: 55,
  description: '  felt good  ',
};

const streams = {
  time: { data: [0, 1, 2] },
  distance: { data: [0, 5, 10] },
  heartrate: { data: [120, 130, 140] },
};

function mockIngest(created: boolean) {
  ingest.mockImplementation(async (_identity: unknown, handlers: any) => {
    const tx = {
      activity: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'a1', data })),
        update: vi.fn(async () => ({})),
      },
    };
    if (!created) {
      await handlers.onMatch?.(tx, { id: 'a1', gearId: null, deviceId: null });
      return { activityId: 'a1', created: false };
    }
    const createdRow = await handlers.create(tx);
    return { activityId: createdRow.id, created: true };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.syncLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.syncLog.update.mockResolvedValue({});
  prisma.connection.update.mockResolvedValue({});
  prisma.activitySource.findMany.mockResolvedValue([]);
  prisma.gear.findFirst.mockResolvedValue(null);
  prisma.gear.create.mockResolvedValue({ id: 'gear-1' });
  prisma.gear.update.mockResolvedValue({ id: 'gear-1' });

  client.token = '';
  client.listActivities.mockReset();
  client.getActivity.mockReset();
  client.getActivityStreams.mockReset();
  client.getGear.mockReset();
  client.listActivities.mockResolvedValue([]);
  client.getActivity.mockResolvedValue(detail);
  client.getActivityStreams.mockResolvedValue(streams);
  client.getGear.mockResolvedValue({
    id: 'b123',
    name: 'Race bike',
    brand_name: 'Canyon',
    frame_type: 2,
  });
  tokens.refresh.mockReset();
  tokens.refresh.mockResolvedValue({
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: new Date(Date.now() + 3_600_000),
    athlete: null,
    scopes: ['read'],
  });
  ingest.mockReset();
  series.mockReset();
  series.mockResolvedValue(undefined);
  mockIngest(true);
});

describe('syncStravaConnection', () => {
  it('ingests new activities with detail, streams and gear', async () => {
    client.listActivities.mockResolvedValueOnce([summary]);

    const result = await syncStravaConnection(env, connection);

    expect(result).toMatchObject({
      status: 'OK',
      itemsPulled: 1,
      itemsCreated: 1,
      itemsUpdated: 0,
      failedActivities: [],
    });
    expect(client.token).toBe('access-1');
    expect(client.listActivities).toHaveBeenCalledWith(
      expect.objectContaining({
        after: Math.floor(connection.lastSyncedAt.getTime() / 1000) - 86_400,
      }),
    );
    expect(client.getActivity).toHaveBeenCalledWith('9001');
    expect(client.getActivityStreams).toHaveBeenCalledWith('9001');
    expect(prisma.gear.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: 'STRAVA', sourceGearId: 'b123', kind: 'BIKE' }),
      }),
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ sourceActivityId: '9001', type: 'RIDE' }),
      expect.any(Object),
    );
    expect(series).toHaveBeenCalledWith(
      'a1',
      'STRAVA',
      expect.objectContaining({ timeMs: expect.any(Array) }),
      expect.any(Object),
    );

    const txCreate = (ingest.mock.calls[0]![1] as any).create;
    const tx = {
      activity: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'a1', data })),
      },
    };
    await txCreate(tx);
    const created = tx.activity.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({
      headline: 'Morning Ride',
      type: 'RIDE',
      gearId: 'gear-1',
      caloriesKcal: 700,
      trainingLoad: 55,
      notes: 'felt good',
      indoor: false,
    });

    expect(prisma.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastSyncedAt: expect.any(Date) } }),
    );
    expect(prisma.syncLog.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'OK', itemsPulled: 1, itemsCreated: 1 }),
      }),
    );
  });

  it('skips known source ids without fetching detail', async () => {
    prisma.activitySource.findMany.mockResolvedValueOnce([{ sourceActivityId: '9001' }]);
    client.listActivities.mockResolvedValueOnce([summary]);

    const result = await syncStravaConnection(env, connection);

    expect(result).toMatchObject({ status: 'OK', itemsPulled: 1, itemsCreated: 0 });
    expect(client.getActivity).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('counts a cross-provider tolerance match as updated', async () => {
    mockIngest(false);
    client.listActivities.mockResolvedValueOnce([summary]);

    const result = await syncStravaConnection(env, connection);

    expect(result).toMatchObject({ itemsCreated: 0, itemsUpdated: 1 });
    expect(series).toHaveBeenCalled();
  });

  it('degrades a failed list page to PARTIAL', async () => {
    client.listActivities.mockRejectedValueOnce(new Error('list down'));

    const result = await syncStravaConnection(env, connection);

    expect(result.status).toBe('PARTIAL');
    expect(result.failedActivities).toEqual(['page:1']);
  });

  it('keeps summary-only rows when detail/streams/gear fail', async () => {
    client.listActivities.mockResolvedValueOnce([summary]);
    client.getActivity.mockRejectedValueOnce(new Error('detail down'));
    client.getActivityStreams.mockRejectedValueOnce(new Error('streams down'));
    // no gear id on the summary path after a detail failure? keep gear_id
    client.getGear.mockRejectedValueOnce(new Error('gear down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await syncStravaConnection(env, connection);
    log.mockRestore();

    expect(result.status).toBe('PARTIAL');
    expect(result.failedActivities).toEqual(['detail:9001', 'streams:9001', 'gear:b123']);
    expect(result.itemsCreated).toBe(1);
    // summary row still has gear_id, so the gear failure is recorded
    expect(ingest).toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the rotated pair', async () => {
    client.listActivities.mockResolvedValueOnce([]);
    const stale = { ...connection, tokenExpiresAt: new Date(0) };

    await syncStravaConnection(env, stale);

    expect(tokens.refresh).toHaveBeenCalledWith(expect.any(Object), 'refresh-1');
    expect(client.token).toBe('access-2');
    expect(prisma.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accessTokenEnc: 'enc:access-2',
          refreshTokenEnc: 'enc:refresh-2',
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('marks the log ERROR and rethrows on revoked/missing credentials', async () => {
    await expect(
      syncStravaConnection(env, { ...connection, status: 'REVOKED' }),
    ).rejects.toBeInstanceOf(StravaError);
    expect(prisma.syncLog.update.mock.calls[0]![0]).toMatchObject({
      data: { status: 'ERROR' },
    });

    await expect(
      syncStravaConnection(env, { ...connection, accessTokenEnc: null, refreshTokenEnc: null }),
    ).rejects.toBeInstanceOf(StravaError);
  });
});
