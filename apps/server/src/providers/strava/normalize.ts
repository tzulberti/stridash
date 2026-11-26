/**
 * Strava → Stridash mapping (pure functions, no network).
 *
 * The list endpoint is the discovery source; the detail endpoint adds
 * description/calories/suffer score and gear_id, and /streams supplies the
 * per-sample arrays. Strava types are broader than Stridash's enum, so
 * unknown sports fall back to OTHER rather than dropping the activity.
 */

import type { ActivityInput, ActivityType } from '../igpsport/normalize.js';
import type {
  StravaActivityDetail,
  StravaActivitySummary,
  StravaGear,
  StravaStreams,
} from './client.js';

export interface StravaSeries {
  timeMs: number[];
  distanceM?: number[];
  latDeg?: number[];
  lngDeg?: number[];
  altitudeM?: number[];
  speedMs?: number[];
  hrBpm?: number[];
  cadenceRpm?: number[];
  powerW?: number[];
  temperatureC?: number[];
}

export interface StravaGearInput {
  userId: string;
  name: string;
  kind: 'BIKE' | 'SHOES' | 'OTHER';
  brand: string | null;
  model: string | null;
  provider: 'STRAVA';
  sourceGearId: string;
  firstUsedAt: Date | null;
  retiredAt: Date | null;
  usageType: string | null;
  thresholdM: number | null;
  raw: Record<string, unknown>;
}

const TYPE_MAP: Record<string, ActivityType> = {
  ride: 'RIDE',
  virtualride: 'VIRTUAL_RIDE',
  ebikeride: 'RIDE',
  mountainbikeride: 'RIDE',
  gravelride: 'RIDE',
  run: 'RUN',
  virtualrun: 'RUN',
  trailrun: 'RUN',
  walk: 'WALK',
  hike: 'HIKE',
  swim: 'SWIM',
  workout: 'WORKOUT',
  weighttraining: 'WORKOUT',
  crossfit: 'WORKOUT',
  yoga: 'WORKOUT',
};

export function mapStravaType(type: string | undefined): ActivityType {
  return TYPE_MAP[(type ?? '').toLowerCase()] ?? 'OTHER';
}

function roundOrNull(value: number | null | undefined): number | null {
  return value == null || Number.isNaN(value) ? null : Math.round(value);
}

/** List/detail row → shared ActivityInput. Detail-only fields are layered by
 * the caller (calories, suffer score, description). */
export function mapStravaActivity(
  row: StravaActivitySummary | StravaActivityDetail,
): ActivityInput | null {
  const start = row.start_date ? new Date(row.start_date) : null;
  if (!start || Number.isNaN(start.getTime())) return null;

  const type = mapStravaType(row.sport_type ?? row.type);
  const detail = row as StravaActivityDetail;
  const name = row.name?.trim();
  const indoor = Boolean(row.trainer) || type === 'VIRTUAL_RIDE';
  const avgPower = row.average_watts ?? row.weighted_average_watts ?? null;

  return {
    headline: name || `Strava ${(row.sport_type ?? row.type ?? 'activity').toLowerCase()}`,
    workoutName: null,
    type,
    startTime: start,
    durationS: Math.max(0, Math.round(row.elapsed_time ?? 0)),
    movingTimeS: row.moving_time != null ? Math.max(0, Math.round(row.moving_time)) : null,
    distanceM: row.distance ?? null,
    avgSpeedMs: row.average_speed ?? null,
    maxSpeedMs: row.max_speed ?? null,
    totalAscentM: row.total_elevation_gain ?? null,
    totalDescentM: null,
    elevationHighM: null,
    elevationLowM: null,
    avgHr: roundOrNull(row.average_heartrate),
    maxHr: roundOrNull(row.max_heartrate),
    avgPowerW: roundOrNull(avgPower),
    maxPowerW: roundOrNull(row.max_watts),
    avgCadence: roundOrNull(row.average_cadence),
    maxCadence: null,
    caloriesKcal: roundOrNull(detail.calories),
    indoor,
    raw: row as unknown as Record<string, unknown>,
  };
}

/** The Strava list row lacks these detail-only scalars; layer them over the
 * mapped input before ingest (undefined = leave the list value alone). */
export function detailScalars(detail: StravaActivityDetail): Partial<ActivityInput> {
  const patch: Partial<ActivityInput> = {};
  if (detail.calories != null) patch.caloriesKcal = Math.round(detail.calories);
  if (detail.average_cadence != null) patch.avgCadence = Math.round(detail.average_cadence);
  if (detail.max_watts != null) patch.maxPowerW = Math.round(detail.max_watts);
  return patch;
}

/** `key_by_type=true` streams → Stridash's array layout. time is seconds from
 * activity start; convert to absolute epoch ms so every provider matches. */
export function toStravaSeries(streams: StravaStreams, startTime: Date): StravaSeries | null {
  const time = streams.time?.data;
  if (!Array.isArray(time) || time.length === 0) return null;
  const startMs = startTime.getTime();
  const series: StravaSeries = { timeMs: time.map((s) => startMs + Math.round(s * 1000)) };

  if (Array.isArray(streams.distance?.data)) series.distanceM = streams.distance.data;
  if (Array.isArray(streams.altitude?.data)) series.altitudeM = streams.altitude.data;
  if (Array.isArray(streams.velocity_smooth?.data)) series.speedMs = streams.velocity_smooth.data;
  if (Array.isArray(streams.heartrate?.data)) series.hrBpm = streams.heartrate.data;
  if (Array.isArray(streams.cadence?.data)) series.cadenceRpm = streams.cadence.data;
  if (Array.isArray(streams.watts?.data)) series.powerW = streams.watts.data;
  if (Array.isArray(streams.temp?.data)) series.temperatureC = streams.temp.data;

  const latlng = streams.latlng?.data;
  if (Array.isArray(latlng) && latlng.length > 0) {
    series.latDeg = latlng.map((p) => p[0]);
    series.lngDeg = latlng.map((p) => p[1]);
  }
  return series;
}

/** Strava gear → Gear upsert input. Gear ids start with `b` (bike) or `g`
 * (shoes); frame_type is the extra bike signal. Usage is always distance. */
export function mapStravaGear(userId: string, gear: StravaGear): StravaGearInput | null {
  if (!gear.id) return null;
  const kind: StravaGearInput['kind'] = gear.id.startsWith('g')
    ? 'SHOES'
    : gear.id.startsWith('b') || gear.frame_type != null
      ? 'BIKE'
      : 'OTHER';
  const label = gear.name?.trim();
  return {
    userId,
    name: label || [gear.brand_name, gear.model_name].filter(Boolean).join(' ') || 'Strava gear',
    kind,
    brand: gear.brand_name ?? null,
    model: gear.model_name ?? null,
    provider: 'STRAVA',
    sourceGearId: gear.id,
    firstUsedAt: null,
    retiredAt: null,
    usageType: 'DISTANCE',
    thresholdM: null,
    raw: { provider: 'STRAVA', gear },
  };
}
