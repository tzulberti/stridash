/**
 * Garmin activity-detail helpers behind edit detection. Verified live
 * 2026-11-12: the detail's metadataDTO.lastUpdateDate is the only
 * provider-side edit signal (list rows carry no update field and there is
 * no updated-since listing), and summaryDTO + activityTypeDTO can rebuild
 * the list row for a re-ingest.
 */
import { describe, expect, it } from 'vitest';
import { detailToRow, parseGarminTimestamp } from '../src/providers/garmin/api.js';

describe('parseGarminTimestamp', () => {
  it('parses GMT DTO timestamps with fractional seconds', () => {
    expect(parseGarminTimestamp('2026-11-11T11:13:12.0')?.toISOString()).toBe(
      '2026-11-11T11:13:12.000Z',
    );
    expect(parseGarminTimestamp('2026-01-05 12:34:56.123')?.toISOString()).toBe(
      '2026-01-05T12:34:56.123Z',
    );
    expect(parseGarminTimestamp('2026-11-11T11:13:12')?.toISOString()).toBe(
      '2026-11-11T11:13:12.000Z',
    );
  });

  it('rejects garbage, empty strings and rollover values', () => {
    expect(parseGarminTimestamp('')).toBeNull();
    expect(parseGarminTimestamp('not-a-date')).toBeNull();
    expect(parseGarminTimestamp('2026-11-11T99:13:12.0')).toBeNull();
    expect(parseGarminTimestamp('2026-13-11T11:13:12.0')).toBeNull();
  });
});

describe('detailToRow', () => {
  it('rebuilds the list-row shape from a detail payload (verified field names)', () => {
    const row = detailToRow({
      activityId: 25041484850,
      activityName: 'Singapore Running',
      activityTypeDTO: { typeId: 1, typeKey: 'running' },
      metadataDTO: {
        manufacturer: 'GARMIN',
        deviceMetaDataDTO: { deviceId: '3422639741', deviceTypePk: 37016 },
        lastUpdateDate: '2026-11-11T11:13:12.0',
      },
      summaryDTO: {
        startTimeGMT: '2026-11-11T10:49:26.0',
        distance: 5015.71,
        duration: 1401.678,
        movingDuration: 1400.088,
        averageSpeed: 3.578,
        maxSpeed: 4.497,
        elevationGain: 2,
        elevationLoss: 6,
        averageHR: 166,
        maxHR: 181,
        averagePower: 398,
        maxPower: 537,
        calories: 343,
        // physiology names differ from the list row: "trainingEffect" is the
        // aerobic TE, normalized power is "normalizedPower" (live-probed)
        waterEstimated: 389,
        trainingEffect: 3.5999999046325684,
        anaerobicTrainingEffect: 1.2000000476837158,
        aerobicTrainingEffectMessage: 'IMPROVING_LACTATE_THRESHOLD_12',
        anaerobicTrainingEffectMessage: 'MINOR_ANAEROBIC_BENEFIT_15',
        normalizedPower: 400,
      },
    });
    expect(row.activityId).toBe(25041484850);
    expect(row.activityName).toBe('Singapore Running');
    expect(row.startTimeGMT).toBe('2026-11-11T10:49:26.0');
    expect(row.distance).toBe(5015.71);
    expect(row.duration).toBe(1401.678);
    expect(row.movingDuration).toBe(1400.088);
    expect(row.averageSpeed).toBe(3.578);
    expect(row.maxSpeed).toBe(4.497);
    expect(row.elevationGain).toBe(2);
    expect(row.elevationLoss).toBe(6);
    expect(row.averageHR).toBe(166);
    expect(row.maxHR).toBe(181);
    expect(row.averagePower).toBe(398);
    expect(row.maxPower).toBe(537);
    expect(row.calories).toBe(343);
    expect(row.deviceId).toBeUndefined(); // numeric-string deviceIds are not numeric
    expect(row.activityType?.typeKey).toBe('running');
    expect(row.waterEstimated).toBe(389);
    expect(row.aerobicTrainingEffect).toBeCloseTo(3.6, 5);
    expect(row.anaerobicTrainingEffect).toBeCloseTo(1.2, 5);
    expect(row.aerobicTrainingEffectMessage).toBe('IMPROVING_LACTATE_THRESHOLD_12');
    expect(row.anaerobicTrainingEffectMessage).toBe('MINOR_ANAEROBIC_BENEFIT_15');
    expect(row.normPower).toBe(400);
    expect(row.vO2MaxValue).toBeUndefined(); // detail carries no session VO2max
  });

  it('tolerates a sparse detail payload (nulls stay undefined)', () => {
    const row = detailToRow({ activityId: 42, summaryDTO: {}, activityTypeDTO: null });
    expect(row.activityId).toBe(42);
    expect(row.distance).toBeUndefined();
    expect(row.activityType?.typeKey).toBeUndefined();
    expect(row.waterEstimated).toBeUndefined();
    expect(row.aerobicTrainingEffectMessage).toBeUndefined();
  });
});
