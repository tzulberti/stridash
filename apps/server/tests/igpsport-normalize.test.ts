/**
 * iGPSPORT mapping tests — synthetic list rows + FIT-derived records. No
 * network access needed.
 */

import { describe, it, expect } from 'vitest';
import {
  exerciseTypeToActivity,
  fitToActivity,
  type FitRecord,
} from '../src/providers/igpsport/normalize.js';
import { peekJwtClaims } from '../src/providers/igpsport/client.js';
import { regionForKey } from '../src/providers/igpsport/regions.js';

describe('regions', () => {
  it('intl is the JWT (unsigned) deployment', () => {
    expect(regionForKey('intl')?.signing).toBe(false);
    expect(regionForKey('intl')?.apiBase).toBe('https://prod.en.igpsport.com');
  });
  it('cn exists in the registry but is rejected at the client', () => {
    expect(regionForKey('cn')?.signing).toBe(true);
  });
});

describe('peekJwtClaims', () => {
  it('extracts memberid + exp without verifying', () => {
    const payload = Buffer.from(JSON.stringify({ memberid: 12345, exp: 1730880000 })).toString(
      'base64url',
    );
    const jwt = `h.${payload}.s`;
    expect(peekJwtClaims(jwt)).toEqual({ memberId: '12345', exp: 1730880000 });
  });
  it('fails soft on garbage', () => {
    expect(peekJwtClaims('not-a-jwt')).toEqual({ memberId: '', exp: null });
  });
});

describe('exerciseTypeToActivity', () => {
  it('maps 0 to RIDE and unknowns to OTHER', () => {
    expect(exerciseTypeToActivity(0)).toBe('RIDE');
    expect(exerciseTypeToActivity(7)).toBe('OTHER');
    expect(exerciseTypeToActivity(undefined)).toBe('OTHER');
  });
});

/** Synthetic record set mimicking a short ride with power + HR. */
function syntheticRecords(): FitRecord[] {
  const base = 1730880000000; // 2024-11-06T08:00:00Z
  return [
    {
      timeMs: base,
      latDeg: -34.603,
      lngDeg: -58.381,
      distanceM: 0,
      altitudeM: 12,
      speedMs: 4.5,
      hrBpm: 110,
      cadenceRpm: 82,
      powerW: 180,
      temperatureC: 24,
    },
    {
      timeMs: base + 2000,
      latDeg: -34.6032,
      lngDeg: -58.3812,
      distanceM: 9,
      altitudeM: 14,
      speedMs: 4.5,
      hrBpm: 118,
      cadenceRpm: 84,
      powerW: 200,
      temperatureC: 24,
    },
    {
      timeMs: base + 4000,
      latDeg: -34.6034,
      lngDeg: -58.3814,
      distanceM: 18,
      altitudeM: 17,
      speedMs: 5.0,
      hrBpm: 124,
      cadenceRpm: 88,
      powerW: 220,
      temperatureC: 25,
    },
  ];
}

describe('fitToActivity', () => {
  it('derives scalars from records and keeps the full series', () => {
    const row = {
      rideId: '987654',
      title: 'Morning ride',
      exerciseType: 0,
      totalAscent: 4.5,
      totalMovingTime: 4,
      rideDistance: 18,
      avgSpeed: 4.63,
    };
    const res = fitToActivity(row, syntheticRecords(), { indoor: false })!;

    expect(res.activity.headline).toBe('Morning ride');
    expect(res.activity.type).toBe('RIDE');
    expect(res.activity.startTime.toISOString()).toBe('2024-11-06T08:00:00.000Z');
    expect(res.activity.durationS).toBe(4);
    expect(res.activity.distanceM).toBe(18); // last distance sample
    expect(res.activity.avgSpeedMs).toBeCloseTo((4.5 + 4.5 + 5.0) / 3, 5);
    expect(res.activity.maxSpeedMs).toBeCloseTo(5.0, 5);
    expect(res.activity.avgHr).toBe(Math.round((110 + 118 + 124) / 3));
    expect(res.activity.maxHr).toBe(124);
    expect(res.activity.avgPowerW).toBe(Math.round((180 + 200 + 220) / 3));
    expect(res.activity.maxPowerW).toBe(220);
    expect(res.activity.avgCadence).toBe(Math.round((82 + 84 + 88) / 3));
    expect(res.activity.maxCadence).toBe(88);
    expect(res.activity.elevationHighM).toBe(17);
    expect(res.activity.elevationLowM).toBe(12);
    // server-list ascent wins over derived when present
    expect(res.activity.totalAscentM).toBeCloseTo(4.5, 5);
    expect(res.activity.indoor).toBe(false);

    expect(res.series.timeMs).toHaveLength(3);
    expect(res.series.latDeg).toHaveLength(3);
    expect(res.series.powerW).toEqual([180, 200, 220]);
    expect(res.series.temperatureC).toEqual([24, 24, 25]);
  });

  it('marks indoor rides (Zwift/exported ERG files can be flagged upstream)', () => {
    const res = fitToActivity({ rideId: '1', exerciseType: 0 }, syntheticRecords(), {
      indoor: true,
    })!;
    expect(res.activity.indoor).toBe(true);
  });

  it('falls back to row values when FIT lacks fields', () => {
    const res = fitToActivity(
      {
        rideId: '1',
        title: 'T',
        exerciseType: 0,
        rideDistance: 42195,
        avgSpeed: 3.1,
        totalAscent: 152,
      },
      [{ timeMs: 1730880000000 }, { timeMs: 1730880010000 }],
      { indoor: false },
    )!;
    expect(res.activity.distanceM).toBe(42195);
    expect(res.activity.avgSpeedMs).toBeCloseTo(3.1, 5);
    expect(res.activity.avgPowerW).toBeNull();
    expect(res.activity.totalAscentM).toBe(152);
  });

  it('returns null without records', () => {
    expect(fitToActivity({ rideId: '1' }, [], { indoor: false })).toBeNull();
  });
});
