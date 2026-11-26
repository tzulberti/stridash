import { describe, expect, it } from 'vitest';
import {
  detailScalars,
  mapStravaActivity,
  mapStravaGear,
  mapStravaType,
  toStravaSeries,
} from '../src/providers/strava/normalize.js';

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
  average_heartrate: 140.4,
  max_heartrate: 175,
  average_watts: 200.2,
  max_watts: 400,
  average_cadence: 85,
  trainer: false,
  gear_id: 'b123',
};

describe('mapStravaType', () => {
  it.each([
    ['Ride', 'RIDE'],
    ['VirtualRide', 'VIRTUAL_RIDE'],
    ['EBikeRide', 'RIDE'],
    ['Run', 'RUN'],
    ['TrailRun', 'RUN'],
    ['Walk', 'WALK'],
    ['Hike', 'HIKE'],
    ['Swim', 'SWIM'],
    ['WeightTraining', 'WORKOUT'],
    ['Rowing', 'OTHER'],
  ])('%s → %s', (input, expected) => {
    expect(mapStravaType(input)).toBe(expected);
  });
});

describe('mapStravaActivity', () => {
  it('maps summary scalars into the shared ActivityInput', () => {
    const input = mapStravaActivity(summary)!;

    expect(input).toMatchObject({
      headline: 'Morning Ride',
      type: 'RIDE',
      startTime: new Date('2026-11-20T08:00:00Z'),
      durationS: 3_600,
      movingTimeS: 3_500,
      distanceM: 30_000,
      avgSpeedMs: 8.33,
      maxSpeedMs: 12,
      totalAscentM: 300,
      avgHr: 140,
      maxHr: 175,
      avgPowerW: 200,
      maxPowerW: 400,
      avgCadence: 85,
      indoor: false,
      workoutName: null,
    });
    expect(input.raw).toMatchObject({ id: 9001 });
  });

  it('marks virtual rides/trainer sessions indoor and falls back on the name', () => {
    expect(mapStravaActivity({ ...summary, name: '', sport_type: 'VirtualRide' })).toMatchObject({
      type: 'VIRTUAL_RIDE',
      indoor: true,
      headline: 'Strava virtualride',
    });
    expect(mapStravaActivity({ ...summary, trainer: true })).toMatchObject({ indoor: true });
  });

  it('rejects rows without a usable start time', () => {
    expect(mapStravaActivity({ ...summary, start_date: undefined })).toBeNull();
    expect(mapStravaActivity({ ...summary, start_date: 'not-a-date' })).toBeNull();
  });

  it('layers detail-only calories, suffer score and cadence', () => {
    expect(
      detailScalars({ ...summary, calories: 700.4, suffer_score: 55.6, average_cadence: 86.2 }),
    ).toEqual({ caloriesKcal: 700, avgCadence: 86, maxPowerW: 400 });
  });
});

describe('toStravaSeries', () => {
  it('converts relative seconds to absolute epoch ms and copies aligned channels', () => {
    const series = toStravaSeries(
      {
        time: { data: [0, 1, 2] },
        distance: { data: [0, 5, 10] },
        altitude: { data: [100, 101, 102] },
        velocity_smooth: { data: [5, 6, 7] },
        heartrate: { data: [120, 130, 140] },
        cadence: { data: [80, 85, 90] },
        watts: { data: [180, 200, 220] },
        temp: { data: [20, 21, 22] },
        latlng: {
          data: [
            [-34.6, -58.4],
            [-34.61, -58.41],
            [-34.62, -58.42],
          ],
        },
      },
      new Date('2026-11-20T08:00:00Z'),
    );

    expect(series).toMatchObject({
      timeMs: [
        Date.UTC(2026, 10, 20, 8, 0, 0),
        Date.UTC(2026, 10, 20, 8, 0, 1),
        Date.UTC(2026, 10, 20, 8, 0, 2),
      ],
      distanceM: [0, 5, 10],
      altitudeM: [100, 101, 102],
      speedMs: [5, 6, 7],
      hrBpm: [120, 130, 140],
      cadenceRpm: [80, 85, 90],
      powerW: [180, 200, 220],
      temperatureC: [20, 21, 22],
      latDeg: [-34.6, -34.61, -34.62],
      lngDeg: [-58.4, -58.41, -58.42],
    });
  });

  it('returns null without a time stream', () => {
    expect(toStravaSeries({ heartrate: { data: [1] } }, new Date())).toBeNull();
    expect(toStravaSeries({ time: { data: [] } }, new Date())).toBeNull();
  });
});

describe('mapStravaGear', () => {
  it('maps bikes and shoes with their provider identity', () => {
    const bike = mapStravaGear('user-1', {
      id: 'b123',
      name: 'Race bike',
      brand_name: 'Canyon',
      model_name: 'Ultimate',
      frame_type: 2,
      distance: 1234,
    })!;
    expect(bike).toMatchObject({
      userId: 'user-1',
      name: 'Race bike',
      kind: 'BIKE',
      brand: 'Canyon',
      model: 'Ultimate',
      provider: 'STRAVA',
      sourceGearId: 'b123',
      usageType: 'DISTANCE',
    });

    expect(mapStravaGear('u', { id: 'g999', brand_name: 'Nike' })).toMatchObject({
      kind: 'SHOES',
      name: 'Nike',
    });
    expect(mapStravaGear('u', { id: 'g999' })?.name).toBe('Strava gear');
  });
});
