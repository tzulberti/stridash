/**
 * Omron bodyIndexList → Stridash `measurements` rows.
 *
 * Full-fidelity mapping: every protocol value code the scale (KRD-703T and
 * friends) or BP monitor delivers, including the ones omramin discards
 * (impedance 267, fat-free mass 268, skeletal muscle / fat-free / body-fat
 * masses 294/295/295, segmental arms–trunk–legs breakdowns 275–288).
 * Unknown codes are preserved verbatim under `raw` so future fields can be
 * backfilled without re-pulling.
 */

import { type OmronDevice, Value as V, applyScale, weightToKg } from "./client.js";

export type MeasurementKind = "WEIGH_IN" | "BLOOD_PRESSURE";

export interface Segments {
  arms?: { musclePct?: number; subcutaneousFatPct?: number };
  trunk?: { musclePct?: number; subcutaneousFatPct?: number };
  legs?: { musclePct?: number; subcutaneousFatPct?: number };
}

/** DB row shape (Prisma `Measurement` create/update payload). */
export interface MeasurementInput {
  kind: MeasurementKind;
  connectionId: string;
  measuredAt: Date;
  // WEIGH_IN
  weightKg?: number;
  bodyFatPct?: number;
  muscleMassKg?: number;
  skeletalMusclePct?: number;
  bmi?: number;
  visceralFatLevel?: number;
  restingMetabolismKcal?: number;
  metabolicAge?: number;
  subcutaneousFatPct?: number;
  fatFreeMassKg?: number;
  fatMassKg?: number;
  skeletalMuscleMassKg?: number;
  impedanceOhm?: number;
  bodyWaterPct?: number;
  boneMassKg?: number;
  // BLOOD_PRESSURE
  systolicMmhg?: number;
  diastolicMmhg?: number;
  pulseBpm?: number;
  meanArterialPressure?: number;
  // meta
  notes?: string;
  segments?: Segments;
  raw: Record<string, unknown>;
}

const dict = new Map<string, string>(
  Object.entries(V).map(([k, v]) => [v as string, k]),
);
/** Human-readable key for an unknown value code (e.g. "omron_2305"). */
function codeKey(code: string): string {
  return dict.get(code) ?? `omron_${code}`;
}

/** value code → readable key + scaled/converted number, or undefined if absent. */
function read(
  list: Record<string, [number, number, number, number]>,
  code: string,
  opts?: { weight?: boolean },
): number | undefined {
  const entry = list[code];
  if (!entry) return undefined;
  let value = applyScale(entry[0], entry[2]);
  if (opts?.weight) value = weightToKg(value, entry[1]);
  return value;
}

/**
 * Decode one raw Omron sample.
 *
 * @param deviceInfo — for provenance + BP-vs-scale discrimination
 */
export function normalizeSample(
  sample: {
    measureDateTo: number;
    timeZone: string;
    bodyIndexList: Record<string, [number, number, number, number]>;
    [key: string]: unknown;
  },
  deviceInfo: Pick<OmronDevice, "deviceSerialID" | "deviceModel" | "category">,
  connectionId: string,
): MeasurementInput | null {
  const list = sample.bodyIndexList ?? {};
  const measuredAt = new Date(sample.measureDateTo);

  const raw: Record<string, unknown> = {
    deviceSerialId: deviceInfo.deviceSerialID,
    deviceModel: deviceInfo.deviceModel,
    timeZone: sample.timeZone,
    values: Object.fromEntries(
      Object.entries(list).map(([code, entry]) => [
        codeKey(code),
        { value: applyScale(entry[0], entry[2]), unit: entry[1], scale: entry[2] },
      ]),
    ),
  };

  const isWeighIn =
    deviceInfo.category === "1" || (list[V.WEIGHT] !== undefined && list[V.MMHG_MAX] === undefined);
  if (isWeighIn) {
    const weightKg = read(list, V.WEIGHT, { weight: true });
    if (!weightKg) return null; // no weight datum — not a usable weigh-in

    // 703T-class scales deliver the segmental breakdown (arms/trunk/legs).
    const segMuscleArms = read(list, V.SEG_MUSCLE_ARMS);
    const segMuscleTrunk = read(list, V.SEG_MUSCLE_TRUNK);
    const segMuscleLegs = read(list, V.SEG_MUSCLE_LEGS);
    const segFatArms = read(list, V.SEG_SUBCUT_FAT_ARMS);
    const segFatTrunk = read(list, V.SEG_SUBCUT_FAT_TRUNK);
    const segFatLegs = read(list, V.SEG_SUBCUT_FAT_LEGS);
    const hasSegments =
      [segMuscleArms, segMuscleTrunk, segMuscleLegs, segFatArms, segFatTrunk, segFatLegs].some(
        (v) => v !== undefined,
      );

    return {
      kind: "WEIGH_IN",
      connectionId,
      measuredAt,
      weightKg,
      bodyFatPct: read(list, V.BODY_FAT_PCT),
      skeletalMusclePct: read(list, V.SKELETAL_MUSCLE_PCT),
      bmi: read(list, V.BLE_BMI) ?? read(list, V.BMI),
      visceralFatLevel: read(list, V.VISCERAL_FAT_LEVEL),
      restingMetabolismKcal: read(list, V.BASAL_METABOLISM),
      metabolicAge: read(list, V.METABOLIC_AGE),
      subcutaneousFatPct: read(list, V.SEG_SUBCUT_FAT),
      fatFreeMassKg: read(list, V.FAT_FREE_MASS),
      fatMassKg: read(list, V.BODY_FAT_MASS, { weight: false }),
      skeletalMuscleMassKg: read(list, V.SKELETAL_MUSCLE_MASS),
      impedanceOhm: read(list, V.IMPEDANCE),
      segments: hasSegments
        ? {
            arms: { musclePct: segMuscleArms, subcutaneousFatPct: segFatArms },
            trunk: { musclePct: segMuscleTrunk, subcutaneousFatPct: segFatTrunk },
            legs: { musclePct: segMuscleLegs, subcutaneousFatPct: segFatLegs },
          }
        : undefined,
      raw,
    };
  }

  // Blood pressure sample
  const systolic = read(list, V.MMHG_MAX);
  if (!systolic) return null; // no BP datum
  const cuffEntry = list[V.CUFF_WRAP_CHECK];
  const flags = [
    !!list[V.ARRHYTHMIA_FLAG] && list[V.ARRHYTHMIA_FLAG]![0] !== 0 && "arrhythmia",
    !!list[V.BODY_MOTION_FLAG] && list[V.BODY_MOTION_FLAG]![0] !== 0 && "bodyMotion",
    (!cuffEntry || cuffEntry[0] === 0) && "cuffWrapGuide",
  ].filter(Boolean) as string[];
  if (flags.length) raw.flags = flags;

  return {
    kind: "BLOOD_PRESSURE",
    connectionId,
    measuredAt,
    systolicMmhg: systolic,
    diastolicMmhg: read(list, V.MMHG_MIN),
    pulseBpm: read(list, V.BPM),
    meanArterialPressure: read(list, V.MMHG_MAP),
    raw,
  };
}
