import { afterEach, describe, expect, it } from 'vitest';
import {
  buildKmSplits,
  fmtDay,
  fmtElapsed,
  fmtTick,
  fmtVal,
  hrZoneThresholds,
  kmBisect,
  monthShort,
  niceTicks,
  PointsRadius,
  windowElevGain,
  windowStat,
  type KmSplitsSeries,
} from './chart';
import { setLocale, setUnit } from './format';

afterEach(() => {
  setUnit('km');
  setLocale('en');
});

describe('chart labels', () => {
  it('formats elapsed activity time with and without hours', () => {
    expect(fmtElapsed(0)).toBe('0:00');
    expect(fmtElapsed(30_000)).toBe('0:30');
    expect(fmtElapsed(59_999)).toBe('0:59');
    expect(fmtElapsed(3_600_000)).toBe('1:00:00');
    expect(fmtElapsed(3_723_000)).toBe('1:02:03');
  });

  it('picks a tick format from the visible span', () => {
    setLocale('en-US');
    const start = Date.UTC(2026, 10, 11, 6, 30);
    expect(monthShort(new Date(start))).toBe('Nov');
    expect(fmtDay(start)).toBe('Nov 11, 2026');
    expect(fmtTick(start + 90_000, 0.5, start)).toBe('1:30');
    expect(fmtTick(start, 10, start)).toBe('Nov 11');
    expect(fmtTick(start, 70, start)).toBe("Nov '26");
    expect(fmtTick(start, 600, start)).toBe('Nov 2026');
  });

  it('rounds tooltip values by magnitude', () => {
    expect(fmtVal(1.234)).toBe('1.23');
    expect(fmtVal(123.45)).toBe('123.5');
    expect(fmtVal(1234.56)).toBe('1,235');
  });
});

describe('niceTicks', () => {
  it('uses 1/2/5 steps and includes the bounds', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.5, 1]);
  });

  it('handles a flat range', () => {
    expect(niceTicks(5, 5, 4)).toEqual([5]);
  });
});

describe('PointsRadius', () => {
  it('shrinks markers as the series gets denser', () => {
    expect(PointsRadius(10)).toBe(3.5);
    expect(PointsRadius(50)).toBe(2.5);
    expect(PointsRadius(100)).toBe(1.5);
  });
});

describe('hrZoneThresholds', () => {
  it('recovers bpm boundaries from the time distribution', () => {
    const hrs = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(hrZoneThresholds(hrs, [10, 10, 10, 10, 10])).toEqual([102, 104, 106, 108]);
  });

  it('returns null when there is not enough evidence', () => {
    const hrs = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(hrZoneThresholds(hrs, null)).toBeNull();
    expect(hrZoneThresholds(hrs, [0, 0, 0, 0, 0])).toBeNull();
    expect(hrZoneThresholds(hrs.slice(0, 5), [10, 10, 10, 10, 10])).toBeNull();
  });

  it('returns null when only zone 1 has time', () => {
    const hrs = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(hrZoneThresholds(hrs, [10, 0, 0, 0, 0])).toBeNull();
  });
});

describe('km helpers', () => {
  it('finds the first sample at or after a distance', () => {
    const dist = [0, 10, 20, 30];
    expect(kmBisect(dist, 0)).toBe(0);
    expect(kmBisect(dist, 20)).toBe(2);
    expect(kmBisect(dist, 25)).toBe(3);
    expect(kmBisect(dist, 31)).toBe(4);
  });

  it('averages/maxes a window while skipping dropouts', () => {
    expect(windowStat(undefined, 0, 3, 30, 'avg')).toBeNull();
    expect(windowStat([0, 40, 50, 60], 1, 4, 30, 'avg')).toBe(50);
    expect(windowStat([0, 40, 50, 60], 1, 4, 30, 'max')).toBe(60);
    expect(windowStat([0, 1, 2], 0, 3, 30, 'avg')).toBeNull();
  });

  it('sums only climbing metres inside the window', () => {
    const alt = [100, 110, 105, 120];
    expect(windowElevGain(alt, 0, 4)).toBe(25);
    expect(windowElevGain(alt, 2, 4)).toBe(15);
  });
});

describe('buildKmSplits', () => {
  const series: KmSplitsSeries = {
    distanceM: [0, 500, 1000, 1500, 2000, 2100],
    timeMs: [0, 180_000, 360_000, 540_000, 720_000, 780_000],
    speedMs: [3, 3.2, 2.8, 3, 3.1, 2.9],
    hrBpm: [120, 130, 140, 150, 160, 170],
    cadenceRpm: [80, 82, 84, 86, 88, 90],
    powerW: [200, 210, 220, 230, 240, 250],
    stepLengthM: [1.1, 1.12, 1.14, 1.16, 1.18, 1.2],
    verticalOscillationM: [0.08, 0.081, 0.082, 0.083, 0.084, 0.085],
    verticalRatioPct: [6, 6.1, 6.2, 6.3, 6.4, 6.5],
    stanceTimePct: [30, 31, 32, 33, 34, 35],
    altitudeM: [100, 110, 105, 120, 115, 130],
  };

  it('builds full-unit rows plus the finish tail', () => {
    const rows = buildKmSplits(series);
    expect(rows).toHaveLength(3);
    const [first, second, tail] = rows!;
    expect(first).toMatchObject({
      km: 1,
      label: '1',
      distanceM: 1000,
      timeS: 360,
      paceSec: 360,
      bestPaceSec: 312.5,
      avgHr: 125,
      maxHr: 130,
      avgCadence: 81,
      avgSpeedMs: 3.1,
      avgPowerW: 205,
      avgStepM: 1.11,
      avgVoCm: 8.05,
      avgVertRatioPct: 6.05,
      avgGctPct: 30.5,
      elevM: 10,
    });
    expect(second).toMatchObject({ km: 2, timeS: 360, avgHr: 145, elevM: 15 });
    expect(tail).toMatchObject({
      km: -1,
      label: 'last (0.10 km)',
      distanceM: 100,
      timeS: 60,
      paceSec: 600,
      avgHr: 165,
      elevM: 15,
    });
  });

  it('switches the unit and label for miles', () => {
    setUnit('mi');
    const rows = buildKmSplits({
      distanceM: [0, 804.672, 1609.344, 2414.016, 3218.688, 3300],
      timeMs: [0, 200_000, 400_000, 600_000, 800_000, 850_000],
    });
    expect(rows).toHaveLength(3);
    expect(rows![0]).toMatchObject({ km: 1, distanceM: 1609.344, timeS: 400, paceSec: 400 });
    expect(rows![2]!.label).toBe('last (0.05 mi)');
  });

  it('returns null without usable streams', () => {
    expect(buildKmSplits({})).toBeNull();
    expect(buildKmSplits({ distanceM: [0], timeMs: [0] })).toBeNull();
    expect(buildKmSplits({ distanceM: [0, 500], timeMs: [0, 100] })).toBeNull();
  });
});
