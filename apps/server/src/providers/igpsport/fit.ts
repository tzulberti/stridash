/**
 * FIT file decoding for iGPSPORT rides (KRD-era devices encode record fields
 * as FIT message fields). Uses the MIT-licensed `fit-file-parser` and maps
 * to our stream types.
 */

import type { FitRecord } from "./normalize.js";

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
  const parser = new FitParser({
    force: true, // tolerate invalid checksums (some iGPSPORT files glitch)
    speedUnit: "m/s",
    lengthUnit: "meter",
    temperatureUnit: "celsius",
    positionUnit: "deg",
  });

  return new Promise<FitRecord[]>((resolve, reject) => {
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
          altitudeM: typeof m.altitude === "number" ? m.altitude : undefined,
          speedMs: typeof m.speed === "number" ? m.speed : undefined,
          hrBpm: typeof m.heart_rate === "number" ? m.heart_rate : undefined,
          cadenceRpm: typeof m.cadence === "number" ? m.cadence : undefined,
          powerW: typeof m.power === "number" ? m.power : undefined,
          temperatureC: typeof m.temperature === "number" ? m.temperature : undefined,
        });
      }
      resolve(out);
    });
  });
}
