/**
 * Omron protocol mapping tests — synthetic API v1 payloads based on the
 * documented bodyIndexList contract. No network access needed.
 */

import { describe, it, expect } from "vitest";
import { applyScale, weightToKg, Value as V, WeightUnit } from "../src/providers/omron/client.js";
import { normalizeSample } from "../src/providers/omron/normalize.js";
import { regionForCountry } from "../src/providers/omron/regions.js";

// ── conversion helpers ──────────────────────────────────────────────────────

describe("applyScale", () => {
  it("multiplies by 10^scale", () => {
    expect(applyScale(825, -1)).toBeCloseTo(82.5); // typical weight encoding
    expect(applyScale(264, 0)).toBe(264);
    expect(applyScale(2, 1)).toBe(20);
  });
});

describe("weightToKg", () => {
  it("converts imperial unit subtypes", () => {
    expect(weightToKg(182.4, WeightUnit.LB)).toBeCloseTo(182.4 * 0.45359237, 5);
    expect(weightToKg(14, WeightUnit.ST)).toBeCloseTo(14 * 6.35029318, 5);
    expect(weightToKg(82500, WeightUnit.G)).toBeCloseTo(82.5, 5);
    expect(weightToKg(82.5, WeightUnit.KG)).toBeCloseTo(82.5, 5);
  });
});

// ── region resolution ───────────────────────────────────────────────────────

describe("regionForCountry", () => {
  it("resolves Latin America (data-eu)", () => {
    const ar = regionForCountry("AR");
    expect(ar?.cloudUrl).toBe("https://data-eu.omronconnect.com/api");
  });
  it("resolves Japan", () => {
    expect(regionForCountry("jp")?.cloudUrl).toBe("https://data-jp.omronconnect.com/api");
  });
  it("rejects unsupported countries (US = ohiomron v2 stack)", () => {
    expect(regionForCountry("US")).toBeNull();
  });
});

// ── weigh-in normalization (full fidelity) ──────────────────────────────────

const CONNECTION = "conn-uuid";

/** Encode a bodyIndexList entry: [value, subtype, scale, measurementId]. */
function entry(value: number, scale = 0, subtype = 0, measurementId = 1) {
  return [value, subtype, scale, measurementId] as [number, number, number, number];
}

/** A synthetic complete KRD-703T-scale sample (all codes the scale delivers). */
function fullScaleSample() {
  return {
    measureDateTo: 1730880000000, // 2024-11-06T08:00:00Z
    timeZone: "America/Argentina/Buenos_Aires",
    bodyIndexList: {
      [V.WEIGHT]: [825, WeightUnit.KG, -1, 1], // 82.5 kg
      [V.BODY_FAT_PCT]: [215, 0, -1, 1], // 21.5 %
      [V.SKELETAL_MUSCLE_PCT]: [424, 0, -1, 1], // 42.4 %
      [V.BMI]: [246, 0, -1, 1], // 24.6
      [V.BASAL_METABOLISM]: [1680, 0, 0, 1], // 1680 kcal
      [V.METABOLIC_AGE]: [32, 0, 0, 1],
      [V.VISCERAL_FAT_LEVEL]: [7, 0, 0, 1],
    } as Record<string, [number, number, number, number]>,
  };
}

describe("normalizeSample — WEIGH_IN", () => {
  it("maps the full body composition set incl. fields omramin drops", () => {
    const sample = fullScaleSample();
    // complete with the high-fidelity codes
    sample.bodyIndexList[V.IMPEDANCE] = entry(534, 0);
    sample.bodyIndexList[V.FAT_FREE_MASS] = entry(6410, -2); // 64.10 kg
    sample.bodyIndexList[V.BODY_FAT_MASS] = entry(184, -1); // 18.4 kg
    sample.bodyIndexList[V.SKELETAL_MUSCLE_MASS] = entry(347, -1); // 34.7 kg
    sample.bodyIndexList[V.SEG_MUSCLE_ARMS] = entry(438, -1); // 43.8 %
    sample.bodyIndexList[V.SEG_MUSCLE_TRUNK] = entry(421, -1);
    sample.bodyIndexList[V.SEG_MUSCLE_LEGS] = entry(465, -1);
    sample.bodyIndexList[V.SEG_SUBCUT_FAT] = entry(196, -1); // 19.6 %
    sample.bodyIndexList[V.SEG_SUBCUT_FAT_ARMS] = entry(152, -1);
    sample.bodyIndexList[V.SEG_SUBCUT_FAT_TRUNK] = entry(211, -1);
    sample.bodyIndexList[V.SEG_SUBCUT_FAT_LEGS] = entry(208, -1);

    const row = normalizeSample(
      sample,
      { deviceSerialID: "665544feff332211", deviceModel: "HBF-703T", category: "1" },
      CONNECTION,
    )!;

    expect(row.kind).toBe("WEIGH_IN");
    expect(row.connectionId).toBe(CONNECTION);
    expect(row.weightKg).toBeCloseTo(82.5, 5);
    expect(row.bodyFatPct).toBeCloseTo(21.5, 5);
    expect(row.skeletalMusclePct).toBeCloseTo(42.4, 5);
    expect(row.bmi).toBeCloseTo(24.6, 5);
    expect(row.restingMetabolismKcal).toBe(1680);
    expect(row.metabolicAge).toBe(32);
    expect(row.visceralFatLevel).toBe(7);
    // fields omramin discards:
    expect(row.impedanceOhm).toBe(534);
    expect(row.fatFreeMassKg).toBeCloseTo(64.10, 5);
    expect(row.fatMassKg).toBeCloseTo(18.4, 5);
    expect(row.skeletalMuscleMassKg).toBeCloseTo(34.7, 5);
    expect(row.subcutaneousFatPct).toBeCloseTo(19.6, 5);
    expect(row.segments?.arms?.musclePct).toBeCloseTo(43.8, 5);
    expect(row.segments?.trunk?.musclePct).toBeCloseTo(42.1, 5);
    expect(row.segments?.legs?.musclePct).toBeCloseTo(46.5, 5);
    expect(row.segments?.arms?.subcutaneousFatPct).toBeCloseTo(15.2, 5);
    expect(row.segments?.trunk?.subcutaneousFatPct).toBeCloseTo(21.1, 5);
    expect(row.segments?.legs?.subcutaneousFatPct).toBeCloseTo(20.8, 5);
    // raw keeps everything for backfill, incl. human-readable keys
    expect(row.raw.deviceModel).toBe("HBF-703T");
    expect(row.raw.timeZone).toBe("America/Argentina/Buenos_Aires");
    expect(row.raw.values).toMatchObject({ IMPEDANCE: { value: 534 } });
  });

  it("handles partial samples (scale without body-composition features)", () => {
    const row = normalizeSample(
      {
        measureDateTo: 1730880000000,
        timeZone: "UTC",
        bodyIndexList: { [V.WEIGHT]: entry(825, -1, WeightUnit.KG) },
      },
      { deviceSerialID: "x", deviceModel: "HBF-222T", category: "1" },
      CONNECTION,
    )!;
    expect(row.kind).toBe("WEIGH_IN");
    expect(row.weightKg).toBeCloseTo(82.5, 5);
    expect(row.impedanceOhm).toBeUndefined();
    expect(row.segments).toBeUndefined();
  });

  it("converts lb-encoded weights", () => {
    const row = normalizeSample(
      {
        measureDateTo: 1730880000000,
        timeZone: "UTC",
        bodyIndexList: { [V.WEIGHT]: entry(1824, -1, WeightUnit.LB) },
      },
      { deviceSerialID: "x", deviceModel: "HBF-703T", category: "1" },
      CONNECTION,
    )!;
    expect(row.weightKg).toBeCloseTo(182.4 * 0.45359237, 4);
  });

  it("returns null when there is no weight value", () => {
    const row = normalizeSample(
      { measureDateTo: 1, timeZone: "UTC", bodyIndexList: {} },
      { deviceSerialID: "x", deviceModel: "HBF-703T", category: "1" },
      CONNECTION,
    );
    expect(row).toBeNull();
  });
});

describe("normalizeSample — BLOOD_PRESSURE", () => {
  it("maps systolic/diastolic/pulse/MAP + flags", () => {
    const row = normalizeSample(
      {
        measureDateTo: 1730880000000,
        timeZone: "UTC",
        bodyIndexList: {
          [V.MMHG_MAX]: entry(118),
          [V.MMHG_MIN]: entry(75),
          [V.BPM]: entry(63),
          [V.MMHG_MAP]: entry(89),
          [V.ARRHYTHMIA_FLAG]: entry(1),
          [V.BODY_MOTION_FLAG]: entry(0),
        },
      },
      { deviceSerialID: "x", deviceModel: "HEM-7600T", category: "0" },
      CONNECTION,
    )!;
    expect(row.kind).toBe("BLOOD_PRESSURE");
    expect(row.systolicMmhg).toBe(118);
    expect(row.diastolicMmhg).toBe(75);
    expect(row.pulseBpm).toBe(63);
    expect(row.meanArterialPressure).toBe(89);
    expect(row.raw.flags).toContain("arrhythmia");
  });
});
