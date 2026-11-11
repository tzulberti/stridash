/**
 * Zwift mapping tests — synthetic list rows + fitness arrays. No network.
 */

import { describe, it, expect } from 'vitest';
import {
  mapZwiftType,
  mapZwiftActivityRow,
  detailScalars,
  toZwiftSeries,
} from '../src/providers/zwift/normalize.js';
import type { ZwiftFitnessData } from '../src/providers/zwift/client.js';

describe('mapZwiftType', () => {
  it('maps supported sports', () => {
    expect(mapZwiftType('CYCLING')).toBe('VIRTUAL_RIDE');
    expect(mapZwiftType('RUNNING')).toBe('RUN');
    expect(mapZwiftType('WEIRD_THING')).toBe('OTHER');
    expect(mapZwiftType(undefined)).toBe('OTHER');
  });
});

describe('detailScalars', () => {
  it('extracts the summary scalars list rows lack', () => {
    expect(
      detailScalars({
        movingTimeInMs: 5_940_000,
        avgHeartRate: 142.6,
        maxHeartRate: 165,
        maxWatts: 610,
        maxCadenceInRotationsPerMinute: 91.5,
      }),
    ).toEqual({
      movingTimeS: 5940,
      avgHr: 143,
      maxHr: 165,
      maxPowerW: 610,
      maxCadence: 92,
    });
  });

  it('omits keys the payload lacks (Prisma skips undefined)', () => {
    expect(detailScalars({})).toEqual({});
  });

  it("treats a 0 bpm reading as 'no monitor', not data", () => {
    expect(detailScalars({ avgHeartRate: 0, maxHeartRate: 0 })).toEqual({});
  });
});

describe('mapZwiftActivityRow', () => {
  const row = {
    id: 42,
    id_str: '42',
    sport: 'CYCLING',
    name: 'Watopia lunch ride',
    startDate: '2026-11-08T18:00:00.000Z',
    endDate: '2026-11-08T19:00:00.000Z',
    distanceInMeters: 30_238.5,
    avgSpeedInMetersPerSecond: 8.396,
    maxSpeedInMetersPerSecond: 15.44,
    avgHeartRate: 142.4,
    maxHeartRate: 165,
    avgWatts: 198.6,
    maxWatts: 610,
    avgCadenceInRotationsPerMinute: 87.4,
    totalElevationInMeters: 312.5,
    calories: 453,
  };

  it('builds a full ActivityInput from the row', () => {
    const input = mapZwiftActivityRow(row);
    expect(input).toBeTruthy();
    expect(input!.type).toBe('VIRTUAL_RIDE');
    expect(input!.headline).toBe('Watopia lunch ride');
    expect(input!.startTime.toISOString()).toBe('2026-11-08T18:00:00.000Z');
    expect(input!.durationS).toBe(3600);
    expect(input!.distanceM).toBeCloseTo(30_238.5, 5);
    expect(input!.avgHr).toBe(142); // rounded int
    expect(input!.maxHr).toBe(165);
    expect(input!.avgPowerW).toBe(199);
    expect(input!.maxPowerW).toBe(610);
    expect(input!.avgCadence).toBe(87);
    expect(input!.totalAscentM).toBe(312.5);
    expect(input!.caloriesKcal).toBe(453);
    // free rides have no workout name
    expect(input!.workoutName).toBeNull();
    // Zwift is always indoor
    expect(input!.indoor).toBe(true);
    expect(input!.raw).toMatchObject({ provider: 'ZWIFT' });
  });

  it('falls back headline + type for empty rows', () => {
    const input = mapZwiftActivityRow({ sport: 'CYCLING', startDate: '2026-11-08T18:00:00.000Z' });
    expect(input).toBeTruthy();
    expect(input!.headline).toBe('Zwift cycling');
    expect(input!.durationS).toBe(0);
    expect(input!.workoutName).toBeNull();
  });

  it("extracts the workout name from the 'Zwift - <workout>' convention", () => {
    const input = mapZwiftActivityRow({
      sport: 'CYCLING',
      name: 'Zwift - Half an Hour of Relaxation',
      startDate: '2026-11-08T18:00:00.000Z',
    });
    expect(input).toBeTruthy();
    expect(input!.headline).toBe('Zwift - Half an Hour of Relaxation');
    expect(input!.workoutName).toBe('Half an Hour of Relaxation');
  });

  it("keeps a bare 'Zwift - ' prefix headline without an empty workout name", () => {
    const input = mapZwiftActivityRow({
      sport: 'CYCLING',
      name: 'Zwift - ',
      startDate: '2026-11-08T18:00:00.000Z',
    });
    expect(input).toBeTruthy();
    expect(input!.workoutName).toBeNull();
  });

  it('returns null without a usable start date', () => {
    expect(mapZwiftActivityRow({ sport: 'CYCLING', name: 'x' })).toBeNull();
  });
});

describe('toZwiftSeries', () => {
  it('converts cm → m and seconds → ms', () => {
    const samples: ZwiftFitnessData = {
      timeInSec: [0, 1, 2, 3],
      distanceInCm: [0, 12_345, 24_690, 37_035],
      speedInCmPerSec: [12_345, 12_345, 23_456, 11_000],
      altitudeInCm: [33_000, 33_050, 33_120, 33_100],
      heartRate: [120, 130, 140, 150],
      cadencePerMin: [85, 88, 90, 92],
      powerInWatts: [180, 195, 240, 210],
    };
    const series = toZwiftSeries(samples);
    expect(series).toBeTruthy();
    expect(series!.timeMs).toEqual([0, 1000, 2000, 3000]);
    // cm → m: 12_345 cm = 123.45 m … (rounded to 3 decimals)
    expect(series!.distanceM[1]).toBeCloseTo(123.45, 5);
    expect(series!.speedMs[2]).toBeCloseTo(234.56, 5); // 23_456 cm/s
    expect(series!.altitudeM[2]).toBeCloseTo(331.2, 5);
    expect(series!.hrBpm).toEqual([120, 130, 140, 150]);
    expect(series!.powerW).toEqual([180, 195, 240, 210]);
    expect(series!.cadenceRpm).toEqual([85, 88, 90, 92]);
  });

  it('falls back to 1 Hz time when timeInSec is missing', () => {
    const series = toZwiftSeries({ powerInWatts: [100, 200] });
    expect(series!.timeMs).toEqual([0, 1000]);
    expect(series!.powerW).toEqual([100, 200]);
    expect(series!.hrBpm).toEqual([]);
  });

  it('returns null for empty payloads', () => {
    expect(toZwiftSeries({})).toBeNull();
    expect(toZwiftSeries({ timeInSec: [] })).toBeNull();
  });

  it('channels may be shorter than the time base (aligned by index)', () => {
    const series = toZwiftSeries({ timeInSec: [0, 1, 2], heartRate: [100] });
    expect(series!.timeMs).toEqual([0, 1000, 2000]);
    // shorter channel stays shorter — index 2 reads as undefined upstream
    expect(series!.hrBpm).toEqual([100]);
  });
});
