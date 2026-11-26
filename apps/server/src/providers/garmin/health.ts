/**
 * Garmin health mapping — weigh-ins/body composition and blood pressure.
 *
 * Connect returns scale values in GRAMS despite the DTO names (confirmed by
 * community clients); `kg()` accepts either a gram or kg value so fixtures and
 * future API changes stay harmless. Dates prefer the real GMT timestamp, then
 * the epoch `date`; date-only rows are anchored at noon UTC (dedup key is the
 * provider + kind + measuredAt tuple).
 */

import type {
  GarminBloodPressureMeasurement,
  GarminBloodPressureResponse,
  GarminWeightResponse,
  GarminWeightRow,
} from './api.js';

export interface GarminMeasurementInput {
  kind: 'WEIGH_IN' | 'BLOOD_PRESSURE';
  measuredAt: Date;
  weightKg?: number | null;
  bodyFatPct?: number | null;
  bodyWaterPct?: number | null;
  muscleMassKg?: number | null;
  boneMassKg?: number | null;
  visceralFatLevel?: number | null;
  bmi?: number | null;
  metabolicAge?: number | null;
  restingMetabolismKcal?: number | null;
  systolicMmhg?: number | null;
  diastolicMmhg?: number | null;
  pulseBpm?: number | null;
  notes?: string | null;
  raw: Record<string, unknown>;
}

function kg(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1000 ? value / 1000 : value;
}

function pct(value: number | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : value;
}

function intOrNull(value: number | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value);
}

function dateFromEpoch(value: number | undefined): Date | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  // Connect sometimes returns seconds in older rows; milliseconds otherwise.
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnly(calendarDate: string | undefined): Date | null {
  if (!calendarDate) return null;
  const d = new Date(`${calendarDate}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timestampOf(value: number | string | undefined): Date | null {
  if (value == null) return null;
  if (typeof value === 'number') return dateFromEpoch(value);
  if (/^\d+$/.test(value)) return dateFromEpoch(Number(value));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mapWeightRow(row: GarminWeightRow): GarminMeasurementInput | null {
  const measuredAt =
    dateFromEpoch(row.timestampGMT) ?? dateFromEpoch(row.date) ?? dateOnly(row.calendarDate);
  if (!measuredAt) return null;
  const weightKg = kg(row.weight);
  if (weightKg == null) return null;
  return {
    kind: 'WEIGH_IN',
    measuredAt,
    weightKg,
    bodyFatPct: pct(row.bodyFat),
    bodyWaterPct: pct(row.bodyWater),
    muscleMassKg: kg(row.muscleMass),
    boneMassKg: kg(row.boneMass),
    visceralFatLevel: pct(row.visceralFat),
    bmi: pct(row.bmi),
    metabolicAge: intOrNull(row.metabolicAge),
    restingMetabolismKcal: intOrNull(row.basalMet),
    raw: { provider: 'GARMIN', weight: row },
  };
}

export function mapWeightResponse(response: GarminWeightResponse): GarminMeasurementInput[] {
  return (response.dateWeightList ?? [])
    .map(mapWeightRow)
    .filter((r): r is GarminMeasurementInput => r != null);
}

function mapBloodPressure(
  summaryDate: string | undefined,
  measurement: GarminBloodPressureMeasurement,
): GarminMeasurementInput | null {
  const measuredAt =
    timestampOf(measurement.measurementTimestampGMT) ??
    timestampOf(measurement.measurementTimestampLocal) ??
    timestampOf(measurement.measurementTime) ??
    dateOnly(summaryDate);
  if (!measuredAt) return null;
  const systolic = intOrNull(measurement.systolic);
  const diastolic = intOrNull(measurement.diastolic);
  if (systolic == null || diastolic == null) return null;
  return {
    kind: 'BLOOD_PRESSURE',
    measuredAt,
    systolicMmhg: systolic,
    diastolicMmhg: diastolic,
    pulseBpm: intOrNull(measurement.pulse),
    notes: measurement.notes?.trim() || null,
    raw: { provider: 'GARMIN', bloodPressure: measurement, calendarDate: summaryDate },
  };
}

export function mapBloodPressureResponse(
  response: GarminBloodPressureResponse,
): GarminMeasurementInput[] {
  const out: GarminMeasurementInput[] = [];
  for (const summary of response.measurementSummaries ?? []) {
    for (const measurement of summary.measurements ?? []) {
      const mapped = mapBloodPressure(summary.calendarDate, measurement);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}
