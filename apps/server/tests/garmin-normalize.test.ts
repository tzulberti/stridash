/** Garmin list-row → activity mapping (FIT-free parts). */
import { describe, expect, it } from 'vitest';
import { mapType, rowToActivity, mapGearRow } from '../src/providers/garmin/normalize.js';
import type { GarminActivityRow, GarminGearRow } from '../src/providers/garmin/api.js';

const row = (over: Partial<GarminActivityRow> = {}): GarminActivityRow => ({
  activityId: 99887766,
  activityName: 'Morning Ride',
  startTimeGMT: '2026-10-01 07:00:00',
  distance: 40_000,
  duration: 5_400,
  movingDuration: 5_100,
  averageSpeed: 7.5,
  maxSpeed: 15,
  elevationGain: 300,
  elevationLoss: 310,
  activityType: { typeId: 2, typeKey: 'cycling' },
  ...over,
});

describe('mapType', () => {
  it('maps the common Garmin typeKeys', () => {
    expect(mapType('cycling')).toBe('RIDE');
    expect(mapType('virtual_ride')).toBe('VIRTUAL_RIDE');
    expect(mapType('running')).toBe('RUN');
    expect(mapType('hiking')).toBe('HIKE');
    expect(mapType('lap_swimming')).toBe('SWIM');
    expect(mapType('strength_training')).toBe('WORKOUT');
    expect(mapType('paddling')).toBe('OTHER');
  });
});

describe('rowToActivity', () => {
  it('maps the list summary with an approximate start time', () => {
    const a = rowToActivity(row());
    expect(a.headline).toBe('Morning Ride');
    expect(a.type).toBe('RIDE');
    expect(a.startTime.toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(a.distanceM).toBe(40_000);
    expect(a.durationS).toBe(5_400);
    expect(a.movingTimeS).toBe(5_100);
    expect(a.totalAscentM).toBe(300);
    expect(a.indoor).toBe(false);
    expect((a.raw as Record<string, unknown>).approximateStartTime).toBe(true);
  });

  it('maps the Connect-computed physiology from the list row (verified live)', () => {
    const a = rowToActivity(
      row({
        waterEstimated: 389,
        aerobicTrainingEffect: 3.6,
        anaerobicTrainingEffect: 1.2,
        aerobicTrainingEffectMessage: 'IMPROVING_LACTATE_THRESHOLD_12',
        anaerobicTrainingEffectMessage: 'MINOR_ANAEROBIC_BENEFIT_15',
        vO2MaxValue: 49,
        normPower: 400,
      }),
    );
    expect(a.sweatLossMl).toBe(389);
    expect(a.aerobicTe).toBeCloseTo(3.6, 5);
    expect(a.anaerobicTe).toBeCloseTo(1.2, 5);
    expect(a.aerobicTeMessage).toBe('IMPROVING_LACTATE_THRESHOLD_12');
    expect(a.anaerobicTeMessage).toBe('MINOR_ANAEROBIC_BENEFIT_15');
    expect(a.vo2max).toBe(49);
    expect(a.recoveryMinutes).toBeNull(); // FIT-session-only, absent without a session
    expect(a.normalizedPowerW).toBe(400);
  });

  it('leaves physiology null when the row carries none', () => {
    const a = rowToActivity(row());
    expect(a.sweatLossMl).toBeNull();
    expect(a.aerobicTe).toBeNull();
    expect(a.anaerobicTe).toBeNull();
    expect(a.vo2max).toBeNull();
    expect(a.normalizedPowerW).toBeNull();
  });

  it('keeps the raw source row', () => {
    const a = rowToActivity(row({ activityName: undefined }));
    expect(a.headline).toBe('Garmin activity');
    expect((a.raw as Record<string, unknown>).activityId).toBe(99887766);
  });
});

describe('mapGearRow', () => {
  const gearRow = (over: Partial<GarminGearRow> = {}): GarminGearRow => ({
    uuid: 'e496727e-dc6f-46c5-89c5-c429e9e35a61',
    gearType: 'SHOES',
    status: 'ACTIVE',
    brand: 'Kiprun Kipride Max',
    usageType: 'DISTANCE',
    maxUsageDistanceMeters: 643_738,
    firstUseDate: '2026-01-01',
    numActivitiesLinked: 29,
    ...over,
  });

  it('maps the v2 gear payload to an upsert input', () => {
    const g = mapGearRow('user-1', gearRow())!;
    expect(g.userId).toBe('user-1');
    expect(g.name).toBe('Kiprun Kipride Max');
    expect(g.kind).toBe('SHOES');
    expect(g.provider).toBe('GARMIN');
    expect(g.sourceGearId).toBe('e496727e-dc6f-46c5-89c5-c429e9e35a61');
    expect(g.firstUsedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(g.retiredAt).toBeNull();
    expect(g.usageType).toBe('DISTANCE');
    expect(g.thresholdM).toBe(643_738);
    expect((g.raw as Record<string, unknown>).provider).toBe('GARMIN');
  });

  it('maps a bike and derives OTHER for unknown gear types', () => {
    expect(mapGearRow('u', gearRow({ gearType: 'BIKE' }))!.kind).toBe('BIKE');
    expect(mapGearRow('u', gearRow({ gearType: 'SKIS' }))!.kind).toBe('OTHER');
  });

  it('marks RETIRED gear and falls back through the name fields', () => {
    const g = mapGearRow('u', gearRow({ status: 'RETIRED', brand: undefined, model: 'A-Flash' }))!;
    expect(g.retiredAt).toBeInstanceOf(Date);
    expect(g.name).toBe('A-Flash');
    expect(mapGearRow('u', gearRow({ brand: undefined, model: undefined }))!.name).toBe('SHOES');
  });

  it('rejects a row without a uuid', () => {
    expect(mapGearRow('u', gearRow({ uuid: undefined as never }))).toBeNull();
  });
});
