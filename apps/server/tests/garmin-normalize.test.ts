/** Garmin list-row → activity mapping (FIT-free parts). */
import { describe, expect, it } from 'vitest';
import { mapType, rowToActivity } from '../src/providers/garmin/normalize.js';
import type { GarminActivityRow } from '../src/providers/garmin/api.js';

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

  it('keeps the raw source row', () => {
    const a = rowToActivity(row({ activityName: undefined }));
    expect(a.headline).toBe('Garmin activity');
    expect((a.raw as Record<string, unknown>).activityId).toBe(99887766);
  });
});
