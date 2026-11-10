/**
 * Zwift activity/fitness mapping — pure functions, no network.
 *
 * Zwift's game-client API hands over cm-valued sample arrays (distance,
 * speed, altitude) plus ISO-8601 summaries; the Stridash series schema wants
 * meters and milliseconds ({timeMs, distanceM, speedMs, altitudeM, hrBpm,
 * cadenceRpm, powerW}).
 */

import type { ActivityInput, ActivityType } from "../igpsport/normalize.js";
import type { ZwiftActivity, ZwiftFitnessData } from "./client.js";

// ─── Sport mapping ───────────────────────────────────────────────────────────

/** Zwift is always indoor; CYCLING is a virtual ride by construction. */
export function mapZwiftType(sport?: string): ActivityType {
  switch ((sport ?? "").toUpperCase()) {
    case "CYCLING":
      return "VIRTUAL_RIDE";
    case "RUNNING":
      return "RUN";
    default:
      return "OTHER";
  }
}

// ─── Summary rows ────────────────────────────────────────────────────────────

export function mapZwiftActivityRow(act: ZwiftActivity): ActivityInput | null {
  const start = act.startDate ? new Date(act.startDate) : null;
  const end = act.endDate ? new Date(act.endDate) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const durationS = end && !Number.isNaN(end.getTime())
    ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000))
    : 0;
  const sport = act.sport ?? "";
  const headline = act.name?.trim() || `Zwift ${sport.toLowerCase() || "activity"}`;
  return {
    headline,
    // Zwift's workout-activity naming convention is "Zwift - <workout name>"
    // ("Half an Hour of Relaxation"); free rides / worlds get other headlines
    workoutName: headline.startsWith("Zwift - ") ? headline.slice("Zwift - ".length) || null : null,
    type: mapZwiftType(sport),
    startTime: start,
    durationS,
    movingTimeS: act.movingTimeInMs != null ? Math.round(act.movingTimeInMs / 1000) : null,
    distanceM: act.distanceInMeters ?? null,
    avgSpeedMs: act.avgSpeedInMetersPerSecond ?? null,
    maxSpeedMs: act.maxSpeedInMetersPerSecond ?? null,
    totalAscentM: act.totalElevationInMeters ?? null,
    totalDescentM: null,
    elevationHighM: null,
    elevationLowM: null,
    avgHr: act.avgHeartRate != null ? Math.round(act.avgHeartRate) : null,
    maxHr: act.maxHeartRate != null ? Math.round(act.maxHeartRate) : null,
    avgPowerW: act.avgWatts != null ? Math.round(act.avgWatts) : null,
    maxPowerW: act.maxWatts != null ? Math.round(act.maxWatts) : null,
    avgCadence: act.avgCadenceInRotationsPerMinute != null ? Math.round(act.avgCadenceInRotationsPerMinute) : null,
    maxCadence: act.maxCadenceInRotationsPerMinute != null ? Math.round(act.maxCadenceInRotationsPerMinute) : null,
    // Zwift's calorie figure is mechanical-work-like (≈1:1 with kJ); stored as
    // kcal which is the same order of magnitude
    caloriesKcal: act.calories != null ? Math.round(act.calories) : null,
    indoor: true,
    raw: { provider: "ZWIFT", sourceRow: act },
  };
}

// ─── Per-second streams ──────────────────────────────────────────────────────

export interface ZwiftSeries {
  timeMs: number[];
  distanceM: number[];
  speedMs: number[];
  altitudeM: number[];
  hrBpm: number[];
  cadenceRpm: number[];
  powerW: number[];
}

/** cm → m, seconds → ms, capped to the common sample length. Channels with
 * fewer samples than the time base simply stay shorter — consumers treat
 * out-of-range indices as "no value". */
export function toZwiftSeries(samples: ZwiftFitnessData): ZwiftSeries | null {
  const time = samples.timeInSec ?? [];
  const lengths = [
    time.length,
    samples.powerInWatts?.length ?? 0,
    samples.heartRate?.length ?? 0,
    samples.cadencePerMin?.length ?? 0,
    samples.distanceInCm?.length ?? 0,
    samples.speedInCmPerSec?.length ?? 0,
    samples.altitudeInCm?.length ?? 0,
  ];
  const n = Math.max(...lengths);
  if (n === 0) return null;
  if (n > 10_000_000) return null; // sanity cap on absurd payloads

  const cm = (arr: number[] | undefined): number[] =>
    (arr ?? []).map((v) => Math.round((v / 100) * 1000) / 1000);
  return {
    timeMs: time.length
      ? time.map((s) => s * 1000)
      : Array.from({ length: n }, (_, i) => i * 1000), // 1 Hz fallback when time is missing
    distanceM: cm(samples.distanceInCm),
    speedMs: cm(samples.speedInCmPerSec),
    altitudeM: cm(samples.altitudeInCm),
    hrBpm: samples.heartRate ?? [],
    cadenceRpm: samples.cadencePerMin ?? [],
    powerW: samples.powerInWatts ?? [],
  };
}
