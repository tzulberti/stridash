/**
 * iGPSPORT → Stridash domain mapping.
 *
 * The list API only offers distance / pace / ascent; the per-ride FIT file is
 * the authoritative source for every performance metric (this also fills the
 * `activity_data_points` streams): timestamps, GPS, distance, altitude,
 * speed, HR, cadence, power, temperature. Average/max scalars are derived
 * from the same records so summary and series can never disagree.
 */

import type { IgpSportActivityRow } from './client.js';

export type ActivityType =
  'RUN' | 'RIDE' | 'VIRTUAL_RIDE' | 'WALK' | 'HIKE' | 'SWIM' | 'WORKOUT' | 'OTHER';

/** FIT record message, post-decode (see parseFitSeries). */
export interface FitRecord {
  /** ms since epoch */
  timeMs: number;
  latDeg?: number;
  lngDeg?: number;
  distanceM?: number;
  altitudeM?: number;
  speedMs?: number;
  hrBpm?: number;
  cadenceRpm?: number;
  powerW?: number;
  temperatureC?: number;
  // ─ running dynamics + body metrics (Garmin rich files; iGPSPORT lacks them) ─
  /** vertical oscillation of the center of mass, meters (FIT "vertical_oscillation") */
  verticalOscillationM?: number;
  /** ground-contact time as % of stride cycle (FIT "stance_time_percent") */
  stanceTimePct?: number;
  /** vertical oscillation ÷ step length, % (FIT "vertical_ratio") */
  verticalRatioPct?: number;
  /** step length, meters */
  stepLengthM?: number;
  /** respiration rate, breaths/min (FIT "enhanced_respiration_rate") */
  respirationRate?: number;
  /** Garmin "stamina" — % of potential remaining, work-based */
  staminaPct?: number;
}

/** Session-level (one per file) summary metrics from the FIT session/user
 * messages + HR-zones "time in zone". Source-reported, so they may disagree
 * slightly with our derived averages. */
export interface FitSession {
  sport?: string;
  subSport?: string;
  totalCalories?: number;
  avgHr?: number;
  maxHr?: number;
  avgPowerW?: number;
  maxPowerW?: number;
  normalizedPowerW?: number;
  trainingLoadPeak?: number;
  totalTrainingEffect?: number;
  totalAnaerobicTrainingEffect?: number;
  primaryBenefit?: string;
  vo2Max?: number;
  recoveryTimeH?: number;
  avgRespirationRate?: number;
  maxRespirationRate?: number;
  /** source-reported HR-zone minutes, zone 1 first (FIT time_in_zone) */
  hrZonesMin?: number[];
}

/** exerciseType → ActivityType. 0 = cycling (mapping per protocol observation). */
export function exerciseTypeToActivity(type: number | undefined): ActivityType {
  switch (type) {
    case 0:
      return 'RIDE';
    // iGPSPORT head units are cycling devices; everything unrecognized stays OTHER
    default:
      return 'OTHER';
  }
}

/** Headline/title fallback from the list row. */
export function activityHeadline(row: IgpSportActivityRow): string {
  return String(row.title ?? row.name ?? 'iGPSPORT ride');
}

/**
 * A full synthetic Activity row as Stridash stores it, built from the FIT
 * records (falling back to list-row values for anything the FIT lacks).
 */
export interface ActivityInput {
  headline: string;
  /// virtual-platform workout identity (Zwift names workouts "Zwift - <name>")
  workoutName: string | null;
  type: ActivityType;
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
  caloriesKcal: number | null;
  indoor: boolean;
  raw: Record<string, unknown>;
}

function avg(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function max(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

/** derive cumulative ascent/descent (m) from the altitude series. */
function ascentDescent(altitudes: (number | undefined)[]): { ascent: number; descent: number } {
  let ascent = 0;
  let descent = 0;
  const pts = altitudes.filter((a): a is number => typeof a === 'number');
  for (let i = 1; i < pts.length; i++) {
    const delta = (pts[i] ?? 0) - (pts[i - 1] ?? 0);
    if (delta > 0) ascent += delta;
    else descent += -delta;
  }
  return { ascent, descent };
}

export interface FitParseResult {
  activity: ActivityInput;
  series: {
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
  };
}

/**
 * Build the activity scalar row + parallel stream arrays from FIT records
 * (any of which may be absent per device/ride) and the discovery row.
 */
export function fitToActivity(
  row: IgpSportActivityRow,
  records: FitRecord[],
  extras: { indoor: boolean },
): FitParseResult | null {
  if (!records.length) return null;

  const series: FitParseResult['series'] = {
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
  };
  for (const r of records) {
    series.timeMs.push(r.timeMs);
    const lat = r.latDeg;
    const lng = r.lngDeg;
    if (lat !== undefined && lng !== undefined) {
      series.latDeg.push(lat);
      series.lngDeg.push(lng);
    }
    if (r.distanceM !== undefined) series.distanceM.push(r.distanceM);
    if (r.altitudeM !== undefined) series.altitudeM.push(r.altitudeM);
    if (r.speedMs !== undefined) series.speedMs.push(r.speedMs);
    if (r.hrBpm !== undefined) series.hrBpm.push(r.hrBpm);
    if (r.cadenceRpm !== undefined) series.cadenceRpm.push(r.cadenceRpm);
    if (r.powerW !== undefined) series.powerW.push(r.powerW);
    if (r.temperatureC !== undefined) series.temperatureC.push(r.temperatureC);
  }

  const startTime = new Date(series.timeMs[0] ?? 0);
  const endTime = new Date(series.timeMs[series.timeMs.length - 1] ?? 0);
  const durationS = Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 1000));

  const speeds = series.speedMs.filter((v) => v >= 0);
  const hrs = series.hrBpm.filter((v) => v > 0);
  const powers = series.powerW.filter((v) => v >= 0);
  const cadences = series.cadenceRpm.filter((v) => v >= 0);
  const { ascent, descent } = ascentDescent(series.altitudeM);
  const avgHrVal = avg(hrs);
  const maxHrVal = max(hrs);
  const avgPowerVal = avg(powers);
  const maxPowerVal = max(powers);
  const avgCadenceVal = avg(cadences);
  const maxCadenceVal = max(cadences);

  const listAscent = typeof row.totalAscent === 'number' ? row.totalAscent : null;
  const listDescent = typeof row.totalDescent === 'number' ? row.totalDescent : null;

  const activity: ActivityInput = {
    headline: activityHeadline(row),
    workoutName: null,
    type: exerciseTypeToActivity(row.exerciseType),
    startTime,
    durationS:
      durationS ||
      (typeof row.totalMovingTime === 'number' ? row.totalMovingTime : 0) ||
      (typeof row.recordTime === 'number' ? row.recordTime : 0) ||
      0,
    movingTimeS: typeof row.totalMovingTime === 'number' ? row.totalMovingTime : null,
    distanceM:
      (series.distanceM.length > 0
        ? series.distanceM[series.distanceM.length - 1]
        : typeof row.rideDistance === 'number'
          ? row.rideDistance
          : null) ?? null,
    avgSpeedMs: avg(speeds) ?? (typeof row.avgSpeed === 'number' ? row.avgSpeed : null) ?? null,
    maxSpeedMs: max(speeds) ?? null,
    totalAscentM: listAscent ?? Math.max(0, Math.round(ascent * 10) / 10),
    totalDescentM: listDescent ?? Math.max(0, Math.round(descent * 10) / 10),
    elevationHighM: series.altitudeM.length ? Math.max(...series.altitudeM) : null,
    elevationLowM: series.altitudeM.length ? Math.min(...series.altitudeM) : null,
    avgHr: avgHrVal !== null ? Math.round(avgHrVal) : null,
    maxHr: maxHrVal !== null ? Math.round(maxHrVal) : null,
    avgPowerW: avgPowerVal !== null ? Math.round(avgPowerVal) : null,
    maxPowerW: maxPowerVal !== null ? Math.round(maxPowerVal) : null,
    avgCadence: avgCadenceVal !== null ? Math.round(avgCadenceVal) : null,
    maxCadence: maxCadenceVal !== null ? Math.round(maxCadenceVal) : null,
    caloriesKcal: null,
    indoor: extras.indoor,
    raw: {
      provider: 'IGPSPORT',
      sourceRow: row,
      sampleCount: records.length,
    },
  };

  // Trust the FIT start time; drop series entries before it (rare device clocks)
  if (activity.startTime.getTime() <= 0) return null;
  return { activity, series };
}
