import { describe, expect, it } from 'vitest';
import {
  mapBloodPressureResponse,
  mapWeightResponse,
  mapWeightRow,
} from '../src/providers/garmin/health.js';

describe('mapWeightRow', () => {
  it('maps grams to kg and preserves body-composition fields', () => {
    const row = mapWeightRow({
      samplePk: 1,
      calendarDate: '2026-11-20',
      timestampGMT: Date.UTC(2026, 10, 20, 7, 30),
      weight: 82_500,
      bmi: 24.1,
      bodyFat: 18.4,
      bodyWater: 55.2,
      muscleMass: 36_400,
      boneMass: 3_200,
      visceralFat: 7,
      metabolicAge: 30,
      basalMet: 1_800,
      sourceType: 'INDEX_SCALE',
    });

    expect(row).toMatchObject({
      kind: 'WEIGH_IN',
      measuredAt: new Date(Date.UTC(2026, 10, 20, 7, 30)),
      weightKg: 82.5,
      bmi: 24.1,
      bodyFatPct: 18.4,
      bodyWaterPct: 55.2,
      muscleMassKg: 36.4,
      boneMassKg: 3.2,
      visceralFatLevel: 7,
      metabolicAge: 30,
      restingMetabolismKcal: 1_800,
    });
    expect(row?.raw).toMatchObject({ provider: 'GARMIN' });
  });

  it('accepts already-kg values and falls back to date-only rows', () => {
    expect(
      mapWeightRow({ calendarDate: '2026-11-20', weight: 82.5, date: 1_900_000_000_000 }),
    ).toMatchObject({ weightKg: 82.5, measuredAt: new Date(1_900_000_000_000) });

    expect(mapWeightRow({ calendarDate: '2026-11-20', weight: 82.5 })?.measuredAt).toEqual(
      new Date('2026-11-20T12:00:00.000Z'),
    );
  });

  it('drops rows without a timestamp, weight or valid date', () => {
    expect(mapWeightRow({ weight: 82.5 })).toBeNull();
    expect(mapWeightRow({ calendarDate: '2026-11-20' })).toBeNull();
    expect(mapWeightRow({ calendarDate: 'not-a-date', weight: 82.5 })).toBeNull();
  });

  it('maps a response list and ignores malformed entries', () => {
    const rows = mapWeightResponse({
      dateWeightList: [
        { calendarDate: '2026-11-20', weight: 82_500 },
        { calendarDate: '2026-11-21', weight: 82_100 },
        { calendarDate: '2026-11-22' },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.weightKg).toBe(82.5);
    expect(rows[1]?.weightKg).toBe(82.1);
  });
});

describe('mapBloodPressureResponse', () => {
  it('flattens measurement summaries and keeps pulse/notes', () => {
    const rows = mapBloodPressureResponse({
      measurementSummaries: [
        {
          calendarDate: '2026-11-20',
          measurements: [
            {
              version: 'v1',
              systolic: 120,
              diastolic: 80,
              pulse: 62,
              measurementTimestampGMT: Date.UTC(2026, 10, 20, 7, 0),
              notes: '  morning  ',
            },
            {
              version: 'v2',
              systolic: 118,
              diastolic: 79,
              measurementTimestampGMT: Date.UTC(2026, 10, 20, 18, 0),
            },
          ],
        },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'BLOOD_PRESSURE',
      systolicMmhg: 120,
      diastolicMmhg: 80,
      pulseBpm: 62,
      notes: 'morning',
      measuredAt: new Date(Date.UTC(2026, 10, 20, 7, 0)),
    });
    expect(rows[1]).toMatchObject({ systolicMmhg: 118, diastolicMmhg: 79, pulseBpm: null });
  });

  it('falls back to local/day timestamps and skips incomplete readings', () => {
    const rows = mapBloodPressureResponse({
      measurementSummaries: [
        {
          calendarDate: '2026-11-21',
          measurements: [
            {
              systolic: 130,
              diastolic: 85,
              measurementTimestampLocal: '2026-11-21T08:00:00Z',
            },
            { systolic: 130 },
            { diastolic: 85 },
            { systolic: 125, diastolic: 82 },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.measuredAt).toEqual(new Date('2026-11-21T08:00:00Z'));
    expect(rows[1]?.measuredAt).toEqual(new Date('2026-11-21T12:00:00.000Z'));
  });

  it('returns an empty list without summaries', () => {
    expect(mapBloodPressureResponse({})).toEqual([]);
  });
});
