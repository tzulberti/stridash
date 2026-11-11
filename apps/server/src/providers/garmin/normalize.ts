/**
 * Garmin → Stridash domain mapping.
 *
 * The activity list row supplies identity + headline; scalars come from the
 * FIT file when it decodes (same pattern as iGPSPORT — summary and series can
 * never disagree), falling back to the list row when the FIT is unavailable.
 */

import type { FitRecord, FitSession, ActivityType } from '../igpsport/normalize.js';
import type { GarminActivityRow, GarminGearRow } from './api.js';

/** Garmin activityTypes typeKey → our domain enum (strava-flavored). */
export function mapType(typeKey: string | undefined): ActivityType {
  const k = (typeKey ?? '').toLowerCase();
  switch (k) {
    case 'cycling':
      return 'RIDE';
    case 'virtual_ride':
    case 'indoor_cycling':
    case 'virtual_run':
      return 'VIRTUAL_RIDE';
    case 'running':
    case 'trail_running':
    case 'treadmill_running':
      return 'RUN';
    case 'walking':
    case 'treadmill':
    case 'indoor_walking':
      return 'WALK';
    case 'hiking':
      return 'HIKE';
    case 'lap_swimming':
    case 'open_water_swimming':
    case 'swimming':
      return 'SWIM';
    case 'strength_training':
    case 'gym':
    case 'indoor_cardio':
    case 'hiit':
    case 'workout':
      return 'WORKOUT';
    default:
      return 'OTHER';
  }
}

export interface Series {
  timeMs: number[];
  latDeg: number[];
  lngDeg: number[];
  distanceM: number[];
  altitudeM: number[];
  speedMs: number[];
  hrBpm: number[];
  cadenceRpm: number[];
  powerW: number[];
  temperatureC: number[];
  verticalOscillationM: number[];
  stanceTimePct: number[];
  verticalRatioPct: number[];
  stepLengthM: number[];
  respirationRate: number[];
  staminaPct: number[];
}

/** Series builder shared with the FIT parser — same per-channel push logic. */
export function seriesFromRecords(records: FitRecord[], session?: FitSession | null): Series {
  const series: Series = {
    timeMs: [],
    latDeg: [],
    lngDeg: [],
    distanceM: [],
    altitudeM: [],
    speedMs: [],
    hrBpm: [],
    cadenceRpm: [],
    powerW: [],
    temperatureC: [],
    verticalOscillationM: [],
    stanceTimePct: [],
    verticalRatioPct: [],
    stepLengthM: [],
    respirationRate: [],
    staminaPct: [],
  };
  for (const r of records) {
    series.timeMs.push(r.timeMs);
    if (r.latDeg !== undefined && r.lngDeg !== undefined) {
      series.latDeg.push(r.latDeg);
      series.lngDeg.push(r.lngDeg);
    }
    if (r.distanceM !== undefined) series.distanceM.push(r.distanceM);
    if (r.altitudeM !== undefined) series.altitudeM.push(r.altitudeM);
    if (r.speedMs !== undefined) series.speedMs.push(r.speedMs);
    if (r.hrBpm !== undefined) series.hrBpm.push(r.hrBpm);
    if (r.cadenceRpm !== undefined) series.cadenceRpm.push(r.cadenceRpm);
    if (r.powerW !== undefined) series.powerW.push(r.powerW);
    if (r.temperatureC !== undefined) series.temperatureC.push(r.temperatureC);
    if (r.verticalOscillationM !== undefined)
      series.verticalOscillationM.push(r.verticalOscillationM);
    if (r.stanceTimePct !== undefined) series.stanceTimePct.push(r.stanceTimePct);
    if (r.verticalRatioPct !== undefined) series.verticalRatioPct.push(r.verticalRatioPct);
    if (r.stepLengthM !== undefined) series.stepLengthM.push(r.stepLengthM);
    if (r.respirationRate !== undefined) series.respirationRate.push(r.respirationRate);
    if (r.staminaPct !== undefined) series.staminaPct.push(r.staminaPct);
  }
  // empty arrays at the chart's expense: a channel nobody sampled still sticks
  // around as [] — serialization cost is negligible and the dashboard's
  // "has-channel" test is arrays.length
  for (const [k, v] of Object.entries(series)) {
    if (k === 'timeMs') continue;
    if (!(v as number[]).length) delete (series as unknown as Record<string, unknown>)[k];
  }
  void session;
  return series;
}

export interface ActivityInput {
  headline: string;
  type: ActivityType;
  /** Date-corrected start (FIT `timeMs[0]` beats the list row's GMT string). */
  startTime: Date;
  durationS: number;
  movingTimeS: number | null;
  distanceM: number | null;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  totalAscentM: number | null;
  totalDescentM: number | null;
  elevationHighM: number | null;
  elevationLowM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPowerW: number | null;
  maxPowerW: number | null;
  avgCadence: number | null;
  maxCadence: number | null;
  trainingLoad: number | null;
  caloriesKcal: number | null;
  indoor: boolean;
  /** source-reported HR-zone minutes (FIT time_in_zone) */
  hrZonesMin: number[] | null;
  raw: Record<string, unknown>;
}

/** Scale/avg/max scalar derivation from series (mirrors iGPSPORT fitToActivity). */
function scalarStats(series: Series) {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  const last = (xs: number[]) => (xs.length ? xs[xs.length - 1] : null);
  const first = (xs: number[]) => (xs.length ? xs[0] : null);

  const nonEmpty = (xs?: number[]) => xs ?? [];
  const speeds = nonEmpty(series.speedMs).filter((v) => v >= 0);
  const hrs = nonEmpty(series.hrBpm).filter((v) => v > 0);
  const powers = nonEmpty(series.powerW).filter((v) => v >= 0);
  const cadences = nonEmpty(series.cadenceRpm).filter((v) => v >= 0);
  const alts = nonEmpty(series.altitudeM).filter((v) => typeof v === 'number');
  let ascent: number | null = null;
  let descent: number | null = null;
  if (alts.length > 1) {
    ascent = 0;
    descent = 0;
    for (let i = 1; i < alts.length; i++) {
      const cur = alts[i];
      const prev = alts[i - 1];
      if (cur === undefined || prev === undefined) continue;
      const delta = cur - prev;
      if (delta > 0) ascent += delta;
      else descent -= delta;
    }
  }
  return {
    avgSpeed: avg(speeds),
    maxSpeed: max(speeds),
    avgHr: avg(hrs),
    maxHr: max(hrs),
    avgPower: avg(powers),
    maxPower: max(powers),
    avgCadence: avg(cadences),
    maxCadence: max(cadences),
    ascent,
    descent,
    low: alts.length ? Math.min(...alts) : null,
    high: alts.length ? Math.max(...alts) : null,
    distance: last(series.distanceM ?? []),
    startAlt: first(alts),
  };
}

/**
 * Build the full activity input from FIT records (authoritative) falling back
 * to the list row for anything the FIT lacks. Returns null when there are no
 * records AND the row is too thin to be useful.
 */
export function fitToActivity(
  row: GarminActivityRow,
  records: FitRecord[],
  extra: { indoor: boolean; session?: FitSession | null },
): { activity: ActivityInput; series: Series } | null {
  const series = seriesFromRecords(records, extra.session);
  if (!series.timeMs.length && !row.startTimeGMT) return null;

  const stats = scalarStats(series);
  const startTime = series.timeMs.length
    ? new Date(series.timeMs[0] ?? 0)
    : new Date(`${row.startTimeGMT?.replace(' ', 'T')}Z`);
  const endTime = series.timeMs.length
    ? new Date(series.timeMs[series.timeMs.length - 1] ?? 0)
    : startTime;
  const durationFromSeries = Math.max(
    0,
    Math.round((endTime.getTime() - startTime.getTime()) / 1000),
  );

  const type = mapType(row.activityType?.typeKey);
  const indoor = extra.indoor || (type === 'RIDE' && !series.latDeg?.length);

  const session = extra.session ?? null;

  const activity: ActivityInput = {
    headline: row.activityName ?? 'Garmin activity',
    type: indoor && type === 'RIDE' ? 'VIRTUAL_RIDE' : type,
    startTime,
    durationS: durationFromSeries || Math.round(row.duration ?? 0),
    movingTimeS: row.movingDuration ? Math.round(row.movingDuration) : null,
    distanceM: stats.distance ?? row.distance ?? null,
    avgSpeedMs: stats.avgSpeed ?? row.averageSpeed ?? null,
    maxSpeedMs: stats.maxSpeed ?? row.maxSpeed ?? null,
    totalAscentM: stats.ascent ?? row.elevationGain ?? null,
    totalDescentM: stats.descent ?? row.elevationLoss ?? null,
    elevationHighM: stats.high,
    elevationLowM: stats.low,
    avgHr: session?.avgHr ?? stats.avgHr ?? row.averageHR ?? null,
    maxHr: session?.maxHr ?? stats.maxHr ?? row.maxHR ?? null,
    avgPowerW: session?.avgPowerW ?? stats.avgPower ?? row.averagePower ?? null,
    maxPowerW: session?.maxPowerW ?? stats.maxPower ?? row.maxPower ?? null,
    avgCadence: stats.avgCadence,
    maxCadence: stats.maxCadence,
    trainingLoad: session?.trainingLoadPeak ?? null, // source-reported, ambiguous unit — see types
    caloriesKcal: session?.totalCalories ?? row.calories ?? null,
    hrZonesMin: session?.hrZonesMin ?? null,
    indoor,
    raw: {
      provider: 'GARMIN',
      activityId: row.activityId,
      typeKey: row.activityType?.typeKey,
      approximateStartTime: series.timeMs.length === 0,
      // per-session physiology/scoring straight from the FIT (VO2max, TE,
      // NP, recovery…): not columned anywhere, kept query-ready in jsonb
      session,
      listRow: row,
    },
  };
  return { activity, series };
}

/** List-row-only fallback (FIT unavailable / failed to decode). */
export function rowToActivity(row: GarminActivityRow): ActivityInput {
  return {
    headline: row.activityName ?? 'Garmin activity',
    type: mapType(row.activityType?.typeKey),
    startTime: new Date(`${row.startTimeGMT?.replace(' ', 'T')}Z`),
    durationS: Math.round(row.duration ?? 0),
    movingTimeS: row.movingDuration ? Math.round(row.movingDuration) : null,
    distanceM: row.distance ?? null,
    avgSpeedMs: row.averageSpeed ?? null,
    maxSpeedMs: row.maxSpeed ?? null,
    totalAscentM: row.elevationGain ?? null,
    totalDescentM: row.elevationLoss ?? null,
    elevationHighM: null,
    elevationLowM: null,
    avgHr: row.averageHR ?? null,
    maxHr: row.maxHR ?? null,
    avgPowerW: row.averagePower ?? null,
    maxPowerW: row.maxPower ?? null,
    avgCadence: null,
    maxCadence: null,
    trainingLoad: null,
    caloriesKcal: row.calories ?? null,
    hrZonesMin: null,
    indoor: false,
    raw: {
      provider: 'GARMIN',
      activityId: row.activityId,
      typeKey: row.activityType?.typeKey,
      listRow: row,
      approximateStartTime: true,
    },
  };
}

// ─── Gear (gear-service v2) ─────────────────────────────────────────────────

export interface GearInput {
  userId: string;
  name: string;
  kind: 'BIKE' | 'SHOES' | 'OTHER';
  brand: string | null;
  model: string | null;
  provider: 'GARMIN';
  sourceGearId: string;
  firstUsedAt: Date | null;
  retiredAt: Date | null;
  usageType: string | null;
  thresholdM: number | null;
  raw: Record<string, unknown>;
}

/** gear-service v2 row → Gear upsert input. The v2 payload's display name
 * lives in `brand` (users nickname gear there); `name`/`model` may exist on
 * catalog-linked gear. Retired ⇔ status === 'RETIRED'. */
export function mapGearRow(userId: string, row: GarminGearRow): GearInput | null {
  if (!row.uuid) return null;
  const kind = row.gearType === 'SHOES' ? 'SHOES' : row.gearType === 'BIKE' ? 'BIKE' : 'OTHER';
  const retiredAt = row.status === 'RETIRED' ? new Date() : null;
  return {
    userId,
    name: row.brand ?? row.model ?? row.gearType ?? 'Garmin gear',
    kind,
    brand: row.brand ?? null,
    model: row.model ?? null,
    provider: 'GARMIN',
    sourceGearId: row.uuid,
    firstUsedAt: row.firstUseDate ? new Date(`${row.firstUseDate}T00:00:00Z`) : null,
    retiredAt,
    usageType: row.usageType ?? null,
    thresholdM: row.maxUsageDistanceMeters ?? null,
    raw: { provider: 'GARMIN', v2: row },
  };
}
