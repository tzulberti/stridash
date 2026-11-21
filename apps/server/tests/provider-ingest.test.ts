/**
 * Provider ingest-helper tests: Garmin and iGPSPORT build the shared
 * activity-create payload and the onMatch attribution fill. The shared
 * ingest service is mocked so these stay focused on the provider-owned
 * callback code that moved in the D1 refactor.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ActivityIdentity,
  IngestHandlers,
  IngestResult,
} from '../src/services/activity-ingest.js';
import type { Series } from '../src/providers/garmin/normalize.js';
import type { ActivityInput as GarminActivityInput } from '../src/providers/garmin/normalize.js';
import type { ActivityInput as IgpSportActivityInput } from '../src/providers/igpsport/normalize.js';

const { ingestActivity } = vi.hoisted(() => ({
  ingestActivity:
    vi.fn<(identity: ActivityIdentity, handlers: IngestHandlers) => Promise<IngestResult>>(),
}));

vi.mock('../src/db.js', () => ({ prisma: {} }));
vi.mock('../src/services/activity-ingest.js', () => ({ ingestActivity }));

import { upsertActivity as upsertGarminActivity } from '../src/services/garmin-sync.js';
import { upsertActivity as upsertIgpSportActivity } from '../src/services/igpsport-sync.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const garminConnection = {
  id: 'garmin-conn',
  userId: 'user-1',
  accessTokenEnc: 'enc-token',
  refreshTokenEnc: 'enc-refresh',
  status: 'ACTIVE',
  config: null,
};

const igpSportConnection = {
  ...garminConnection,
  id: 'igpsport-conn',
  tokenExpiresAt: null,
  lastSyncedAt: null,
};

const startTime = new Date('2026-11-20T08:00:00.000Z');

function garminActivity(over: Partial<GarminActivityInput> = {}): GarminActivityInput {
  return {
    headline: 'Morning ride',
    type: 'RIDE',
    startTime,
    durationS: 3600,
    movingTimeS: 3500,
    distanceM: 30_000,
    avgSpeedMs: 8.33,
    maxSpeedMs: 12.5,
    totalAscentM: 420,
    totalDescentM: 410,
    elevationHighM: 900,
    elevationLowM: 480,
    avgHr: 142,
    maxHr: 176,
    avgPowerW: 210,
    maxPowerW: 560,
    avgCadence: 86,
    maxCadence: 112,
    trainingLoad: 88,
    caloriesKcal: 780,
    indoor: false,
    hrZonesMin: [5, 20, 30, 15, 5],
    sweatLossMl: 620,
    aerobicTe: 3.2,
    anaerobicTe: 1.1,
    aerobicTeMessage: 'AEROBIC_BASE',
    anaerobicTeMessage: 'MINOR_ANAEROBIC_BENEFIT_15',
    vo2max: 51.2,
    recoveryMinutes: 900,
    normalizedPowerW: 240,
    raw: { provider: 'GARMIN', sourceRow: { activityId: 42 } },
    ...over,
  };
}

function garminSeries(): Series {
  return {
    timeMs: [0, 1_000, 2_000],
    latDeg: [1, 2, 3],
    lngDeg: [4, 5, 6],
    distanceM: [0, 8, 16],
    altitudeM: [100, 101, 102],
    speedMs: [8, 8, 8],
    hrBpm: [120, 130, 140],
    cadenceRpm: [80, 82, 84],
    powerW: [150, 180, 210],
    temperatureC: [20, 20, 20],
    verticalOscillationM: [],
    stanceTimePct: [],
    verticalRatioPct: [],
    stepLengthM: [],
    respirationRate: [],
    staminaPct: [],
  };
}

function igpSportActivity(over: Partial<IgpSportActivityInput> = {}): IgpSportActivityInput {
  return {
    headline: 'iGPSPORT ride',
    workoutName: null,
    type: 'RIDE',
    startTime,
    durationS: 1800,
    movingTimeS: 1750,
    distanceM: 12_345,
    avgSpeedMs: 7.05,
    maxSpeedMs: 11.2,
    totalAscentM: 95,
    totalDescentM: 93,
    elevationHighM: 540,
    elevationLowM: 420,
    avgHr: 138,
    maxHr: 165,
    avgPowerW: 195,
    maxPowerW: 480,
    avgCadence: 82,
    maxCadence: 105,
    caloriesKcal: 410,
    indoor: false,
    sweatLossMl: 310,
    aerobicTe: 2.5,
    anaerobicTe: 0.7,
    vo2max: 49.8,
    recoveryMinutes: 600,
    normalizedPowerW: 225,
    raw: { provider: 'IGPSPORT', sourceRow: { rideId: 'ride-1' } },
    ...over,
  };
}

function fakeTx() {
  return {
    activity: {
      create: vi.fn(async () => ({ id: 'created-activity' })),
      update: vi.fn(async () => ({})),
    },
    activityDataPoint: { upsert: vi.fn(async () => ({})) },
  };
}

type Tx = ReturnType<typeof fakeTx>;

function captureHandlers(tx: Tx) {
  let handlers: IngestHandlers | undefined;
  ingestActivity.mockImplementationOnce(async (_identity, next) => {
    handlers = next;
    const created = await next.create(tx as never);
    return { activityId: created.id, created: true };
  });
  return () => {
    if (!handlers) throw new Error('ingestActivity handlers were not captured');
    return handlers;
  };
}

beforeEach(() => {
  ingestActivity.mockReset();
});

// ─── Garmin ──────────────────────────────────────────────────────────────────

describe('Garmin provider ingest', () => {
  it('builds the activity scalars, gear/device attribution, and series (T7)', async () => {
    const tx = fakeTx();
    const handlers = captureHandlers(tx);
    const activity = garminActivity();
    const series = garminSeries();

    await upsertGarminActivity(
      garminConnection,
      'garmin-42',
      activity,
      series,
      'gear-9',
      'device-7',
    );

    expect(ingestActivity).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        connectionId: 'garmin-conn',
        sourceActivityId: 'garmin-42',
        type: 'RIDE',
        startTime,
        distanceM: 30_000,
      },
      expect.objectContaining({ create: expect.any(Function), onMatch: expect.any(Function) }),
    );
    expect(handlers).toBeTypeOf('function');

    const data = tx.activity.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      userId: 'user-1',
      headline: 'Morning ride',
      type: 'RIDE',
      startTime,
      durationS: 3600,
      movingTimeS: 3500,
      distanceM: 30_000,
      avgSpeedMs: 8.33,
      maxSpeedMs: 12.5,
      totalAscentM: 420,
      totalDescentM: 410,
      elevationHighM: 900,
      elevationLowM: 480,
      avgHr: 142,
      maxHr: 176,
      avgPowerW: 210,
      maxPowerW: 560,
      avgCadence: 86,
      maxCadence: 112,
      trainingLoad: 88,
      caloriesKcal: 780,
      indoor: false,
      sweatLossMl: 620,
      normalizedPowerW: 240,
      gearId: 'gear-9',
      deviceId: 'device-7',
    });
    expect(data.raw).toEqual(activity.raw);
    expect(data.hrZonesMin).toEqual([5, 20, 30, 15, 5]);

    expect(tx.activityDataPoint.upsert).toHaveBeenCalledWith({
      where: { activityId_provider: { activityId: 'created-activity', provider: 'GARMIN' } },
      create: {
        activityId: 'created-activity',
        provider: 'GARMIN',
        sampleCount: 3,
        series,
      },
      update: { sampleCount: 3, series },
    });
  });

  it('onMatch fills only empty gear/device slots (T6)', async () => {
    const tx = fakeTx();
    const captured = captureHandlers(tx);
    await upsertGarminActivity(
      garminConnection,
      'garmin-42',
      garminActivity(),
      null,
      'gear-9',
      'device-7',
    );
    const handlers = captured();

    await handlers.onMatch?.(tx as never, {
      id: 'existing',
      gearId: null,
      deviceId: null,
    });
    expect(tx.activity.update).toHaveBeenCalledWith({
      where: { id: 'existing' },
      data: { gearId: 'gear-9', deviceId: 'device-7' },
    });

    tx.activity.update.mockClear();
    await handlers.onMatch?.(tx as never, {
      id: 'existing',
      gearId: 'user-gear',
      deviceId: 'other-device',
    });
    expect(tx.activity.update).not.toHaveBeenCalled();

    await handlers.onMatch?.(tx as never, {
      id: 'existing',
      gearId: 'user-gear',
      deviceId: null,
    });
    expect(tx.activity.update).toHaveBeenCalledWith({
      where: { id: 'existing' },
      data: { deviceId: 'device-7' },
    });
  });
});

// ─── iGPSPORT ────────────────────────────────────────────────────────────────

describe('iGPSPORT provider ingest', () => {
  it('builds the activity scalars, device attribution, and series (T7)', async () => {
    const tx = fakeTx();
    captureHandlers(tx);
    const activity = igpSportActivity();
    const series = { timeMs: [0, 500], hrBpm: [130, 135] };

    await upsertIgpSportActivity(igpSportConnection, 'ride-1', activity, series, 'device-igp');

    expect(ingestActivity).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        connectionId: 'igpsport-conn',
        sourceActivityId: 'ride-1',
        type: 'RIDE',
        startTime,
        distanceM: 12_345,
      },
      expect.objectContaining({ create: expect.any(Function), onMatch: expect.any(Function) }),
    );

    const data = tx.activity.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      userId: 'user-1',
      headline: 'iGPSPORT ride',
      workoutName: null,
      type: 'RIDE',
      startTime,
      durationS: 1800,
      movingTimeS: 1750,
      distanceM: 12_345,
      avgSpeedMs: 7.05,
      maxSpeedMs: 11.2,
      totalAscentM: 95,
      totalDescentM: 93,
      elevationHighM: 540,
      elevationLowM: 420,
      avgHr: 138,
      maxHr: 165,
      avgPowerW: 195,
      maxPowerW: 480,
      avgCadence: 82,
      maxCadence: 105,
      caloriesKcal: 410,
      indoor: false,
      sweatLossMl: 310,
      normalizedPowerW: 225,
      deviceId: 'device-igp',
    });
    expect(data.raw).toEqual(activity.raw);

    expect(tx.activityDataPoint.upsert).toHaveBeenCalledWith({
      where: { activityId_provider: { activityId: 'created-activity', provider: 'IGPSPORT' } },
      create: {
        activityId: 'created-activity',
        provider: 'IGPSPORT',
        sampleCount: 2,
        series,
      },
      update: { sampleCount: 2, series },
    });
  });

  it('onMatch fills only an empty device slot (T6)', async () => {
    const tx = fakeTx();
    const captured = captureHandlers(tx);
    await upsertIgpSportActivity(
      igpSportConnection,
      'ride-1',
      igpSportActivity(),
      null,
      'device-igp',
    );
    const handlers = captured();

    await handlers.onMatch?.(tx as never, {
      id: 'existing',
      gearId: null,
      deviceId: null,
    });
    expect(tx.activity.update).toHaveBeenCalledWith({
      where: { id: 'existing' },
      data: { deviceId: 'device-igp' },
    });

    tx.activity.update.mockClear();
    await handlers.onMatch?.(tx as never, {
      id: 'existing',
      gearId: null,
      deviceId: 'other-device',
    });
    expect(tx.activity.update).not.toHaveBeenCalled();
  });
});
