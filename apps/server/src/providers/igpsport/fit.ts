/**
 * FIT file decoding for iGPSPORT rides (KRD-era devices encode record fields
 * as FIT message fields). Uses the MIT-licensed `fit-file-parser` and maps
 * to our stream types.
 */

import type { FitRecord, FitSession } from "./normalize.js";

// CJS module: load through interop
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type FitFileParserModule = new (opts: Record<string, unknown>) => {
  parse: (buf: Buffer, cb: (err: unknown, data: any) => void) => void;
};

// fit-file-parser ships CJS; with our ESM tsconfig (bundler resolution) the
// import resolves via its main field.
import FitParserModule from "fit-file-parser";
const FitParser = FitParserModule as unknown as FitFileParserModule;

/**
 * Decode a FIT binary into per-record samples.
 *
 * `fit-file-parser` converts semicircle lat/lng to degrees with
 * `positionUnit: "deg"`, and we ask for meters / m/s / celsius to match the
 * activity_data_points series units.
 */
export async function parseFitSeries(buf: Buffer): Promise<FitRecord[]> {
  return (await parseFitFile(buf)).records;
}

/** Full parse: per-sample records + session summaries + HR-zone minutes. */
export async function parseFitFile(
  buf: Buffer,
): Promise<{ records: FitRecord[]; session: FitSession | null }> {
  const parser = new FitParser({
    force: true, // tolerate invalid checksums (some iGPSPORT files glitch)
    speedUnit: "m/s",
    lengthUnit: "meter",
    temperatureUnit: "celsius",
    positionUnit: "deg",
  });

  return new Promise<{ records: FitRecord[]; session: FitSession | null }>((resolve, reject) => {
    parser.parse(buf, (err: unknown, data: any) => {
      if (err) {
        reject(new Error(`FIT parse failed: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      const fitRecords: any[] = data?.record_messages ?? data?.records ?? [];
      const out: FitRecord[] = [];
      for (const m of fitRecords) {
        const t = m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp);
        if (!Number.isFinite(t) || t <= 0) continue;
        out.push({
          timeMs: t,
          latDeg: typeof m.position_lat === "number" ? m.position_lat : undefined,
          lngDeg: typeof m.position_long === "number" ? m.position_long : undefined,
          distanceM: typeof m.distance === "number" ? m.distance : undefined,
          // Garmin emits the enhanced_* variants of speed/altitude; ride with
          // either spelling (older bare fields) so no channel silently drops
          speedMs: typeof m.enhanced_speed === "number" ? m.enhanced_speed
            : typeof m.speed === "number" ? m.speed : undefined,
          altitudeM: typeof m.enhanced_altitude === "number" ? m.enhanced_altitude
            : typeof m.altitude === "number" ? m.altitude : undefined,
          hrBpm: typeof m.heart_rate === "number" ? m.heart_rate : undefined,
          cadenceRpm: typeof m.cadence === "number" ? m.cadence : undefined,
          powerW: typeof m.power === "number" ? m.power : undefined,
          temperatureC: typeof m.temperature === "number" ? m.temperature : undefined,
          // running dynamics + body metrics (2026-11: verified present in
          // Garmin running FITs; iGPSPORT head-unit files do not carry these)
          verticalOscillationM: typeof m.vertical_oscillation === "number" ? m.vertical_oscillation / 1000 : undefined,
          stanceTimePct: typeof m.stance_time_percent === "number" ? m.stance_time_percent : undefined,
          verticalRatioPct: typeof m.vertical_ratio === "number" ? m.vertical_ratio : undefined,
          // parser leaves these in raw millimetres (scale fields aren't
          // rescaled by lengthUnit) — convert to metres for the series
          stepLengthM: typeof m.step_length === "number" ? m.step_length / 1000 : undefined,
          respirationRate: typeof m.enhanced_respiration_rate === "number"
            ? m.enhanced_respiration_rate
            : typeof m.respiration_rate === "number" ? m.respiration_rate : undefined,
          staminaPct: typeof m.stamina === "number" ? m.stamina : undefined,
        });
      }
      resolve({ records: out, session: extractSession(data) });
    });
  });
}

/** Session/user summaries + source-reported HR-zone minutes. */
function extractSession(data: any): FitSession | null {
  if (!data || typeof data !== "object") return null;
  const s = (data.sessions ?? [])[0];
  const am = (data.activity_metrics ?? [])[0];
  const um = (data.user_metrics ?? [])[0];
  const tiz = (data.time_in_zone ?? [])[0];
  if (!s && !am && !um && !tiz) return null;

  const session: FitSession = {
    sport: str(s?.sport),
    subSport: str(s?.sub_sport),
    totalCalories: num(s?.total_calories),
    avgHr: num(s?.avg_heart_rate),
    maxHr: num(s?.max_heart_rate),
    avgPowerW: num(s?.avg_power),
    maxPowerW: num(s?.max_power),
    normalizedPowerW: num(s?.normalized_power),
    trainingLoadPeak: num(s?.training_load_peak),
    totalTrainingEffect: num(s?.total_training_effect),
    totalAnaerobicTrainingEffect: num(s?.total_anaerobic_training_effect),
    primaryBenefit: str(s?.primary_benefit),
    avgRespirationRate: num(s?.enhanced_avg_respiration_rate),
    maxRespirationRate: num(s?.enhanced_max_respiration_rate),
    vo2Max: num(am?.vo2_max ?? um?.vo2_max),
    recoveryTimeH: num(am?.recovery_time),
    // source-reported minutes per HR zone, zone 1 first
    hrZonesMin: hrZones(tiz?.time_in_hr_zone),
  };
  // strip undefineds so the stored jsonb stays tight
  return Object.fromEntries(Object.entries(session).filter(([, v]) => v !== undefined)) as FitSession;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function hrZones(arr: unknown): number[] | undefined {
  if (!Array.isArray(arr) || !arr.length) return undefined;
  const out = arr.map((v) => num(v)).filter((v): v is number => v !== undefined);
  return out.length ? out : undefined;
}
