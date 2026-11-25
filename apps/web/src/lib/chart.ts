/**
 * Pure chart math/formatting shared by the dashboard charts and split table.
 * Kept out of App.tsx so the axis, zone and split rules can be tested without
 * a DOM.
 */
import { getLocale, metersPerUnit, unitLabel } from './format';

export type Point = { x: number; y: number };

// month names come from Intl in the active locale (en → Jan/Feb/…, ru →
// янв./февр./…) — cached per locale since the chart renders on every hover
const monthFmtCache = new Map<string, Intl.DateTimeFormat>();
export function monthShort(d: Date): string {
  const loc = getLocale();
  let f = monthFmtCache.get(loc);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, { month: 'short', timeZone: 'UTC' });
    monthFmtCache.set(loc, f);
  }
  return f.format(d);
}

export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${monthShort(d)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** elapsed since the activity start: 0:30 for sub-hour runs, 1:02:33 after */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (v: number): string => String(v).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export function fmtTick(ms: number, spanDays: number, x0: number): string {
  const d = new Date(ms);
  if (spanDays < 1.5) return fmtElapsed(ms - x0); // activity-length spans: elapsed since start
  if (spanDays >= 545) return `${monthShort(d)} ${d.getUTCFullYear()}`;
  if (spanDays >= 60) return `${monthShort(d)} '${String(d.getUTCFullYear() % 100)}`;
  return `${monthShort(d)} ${d.getUTCDate()}`;
}

/** readable number for tick marks + tooltips */
export function fmtVal(v: number): string {
  const a = Math.abs(v);
  return v.toLocaleString(undefined, { maximumFractionDigits: a < 10 ? 2 : a < 1000 ? 1 : 0 });
}

/** ~count "nice" ticks (1/2/5×10ⁿ steps) covering [min, max] */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let i = Math.ceil(min / step); i <= Math.floor(max / step); i++) ticks.push(i * step);
  return ticks;
}

/** display colors for HR intensity zones (1 grey, 2 blue, 3 green, 4 yellow,
 * 5+ red) */
export const ZONE_COLORS = [
  '#9aa4b2',
  '#3e8ef7',
  '#30a46c',
  '#d29922',
  '#e5484d',
  '#e5484d',
  '#e5484d',
  '#e5484d',
];

export function PointsRadius(n: number): number {
  if (n > 80) return 1.5;
  if (n > 30) return 2.5;
  return 3.5;
}

/** the two series colors of every compare chart: A (this activity) green,
 * B (the other) red — identity beats per-channel coloring when two lines
 * share one plot */
export const COMPARE_A = '#30a46c';
export const COMPARE_B = '#e5484d';

/** HR-zone bpm boundaries recovered from the series + the stored per-zone
 * minutes: FIT samples arrive ~time-uniform, so the bpm under which exactly
 * Σ(minutes of zones 1..k-1) of time sits is zone k's lower bound.
 * Returns the lower bounds of zones 2..n; Infinity for zones no sample ever
 * reaches (zero higher-zone minutes) so their color can't swallow lower ones. */
export function hrZoneThresholds(hrs: number[], zoneMinutes: number[] | null): number[] | null {
  if (!zoneMinutes?.length || hrs.length < 10) return null;
  const total = zoneMinutes.reduce((s, m) => s + m, 0);
  if (total <= 0) return null;
  const sorted = [...hrs].sort((a, b) => a - b);
  const n = sorted.length;
  const thresholds: number[] = [];
  let below = 0; // accumulated minutes of zones 1..k-1 (below the boundary)
  for (let k = 2; k <= zoneMinutes.length; k++) {
    below += zoneMinutes[k - 2] ?? 0;
    const r = Math.ceil((below / total) * n);
    thresholds.push(r >= n ? Infinity : (sorted[Math.min(r, n - 1)] ?? Infinity));
  }
  return thresholds.some((t) => Number.isFinite(t)) ? thresholds : null;
}

// ─── Per-km splits (activity page table) ─────────────────────────────────────

export interface KmSplit {
  /** 1-based window number; the short tail row is numbered -1 */
  km: number;
  label: string;
  distanceM: number;
  timeS: number;
  /** seconds per km inside this window */
  paceSec: number | null;
  /** fastest sample pace in the window (seconds per km), Garmin-style "best pace" */
  bestPaceSec: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  avgSpeedMs: number | null;
  avgPowerW: number | null;
  avgStepM: number | null;
  /** vertical oscillation, cm */
  avgVoCm: number | null;
  avgVertRatioPct: number | null;
  /** ground contact as % of stride cycle (we store the % form, not ms) */
  avgGctPct: number | null;
  /** meters climbed inside this window (needs the altitude stream) */
  elevM: number | null;
}

/** first sample index with distance ≥ d (distance stream is ~monotonic) */
export function kmBisect(dist: number[], d: number): number {
  let lo = 0;
  let hi = dist.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((dist[mid] ?? 0) < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type KmSplitsSeries = {
  distanceM?: number[];
  timeMs?: number[];
  hrBpm?: number[];
  cadenceRpm?: number[];
  speedMs?: number[];
  powerW?: number[];
  stepLengthM?: number[];
  verticalOscillationM?: number[];
  verticalRatioPct?: number[];
  stanceTimePct?: number[];
  altitudeM?: number[];
};

/** split table for one activity: one row per full unit (km or mi, per the
 * settings), every column an in-window aggregate of a stored stream
 * (Garmin-style laps) */
export function buildKmSplits(s: KmSplitsSeries): KmSplit[] | null {
  const unitM = metersPerUnit();
  const dist = s.distanceM;
  const ts = s.timeMs;
  if (!dist || !ts) return null;
  const n = Math.min(dist.length, ts.length);
  if (n < 2) return null;
  const base = dist[0] ?? 0;
  const total = (dist[n - 1] ?? 0) - base;
  if (total < unitM) return null;

  /** time recorded at distance d — linear interp between bracketing samples */
  const timeAt = (d: number): number => {
    const i = kmBisect(dist, d);
    const a = Math.min(Math.max(i, 1), n - 1);
    const d0 = dist[a - 1] ?? 0;
    const d1 = dist[a] ?? 0;
    if (d1 <= d0) return ts[a] ?? 0;
    const f = Math.min(1, Math.max(0, (d - d0) / (d1 - d0)));
    return (ts[a - 1] ?? 0) + f * ((ts[a] ?? 0) - (ts[a - 1] ?? 0));
  };

  const rows: KmSplit[] = [];
  const fullUnits = Math.floor(total / unitM);
  const push = (
    k: number,
    label: string,
    dStart: number,
    dEnd: number,
    i0: number,
    i1: number,
    headTimeS: number,
  ): void => {
    const distanceM = dEnd - dStart;
    const paceSec = distanceM > 0 ? headTimeS / (distanceM / unitM) : null;
    const bestSpeed = windowStat(s.speedMs, i0, i1, 0.01, 'max');
    const voM = windowStat(s.verticalOscillationM, i0, i1, 0.001, 'avg');
    rows.push({
      km: k,
      label,
      distanceM,
      timeS: headTimeS,
      paceSec,
      bestPaceSec: bestSpeed ? unitM / bestSpeed : null,
      avgHr: windowStat(s.hrBpm, i0, i1, 30, 'avg'),
      maxHr: windowStat(s.hrBpm, i0, i1, 30, 'max'),
      avgCadence: windowStat(s.cadenceRpm, i0, i1, 1, 'avg'),
      avgSpeedMs: windowStat(s.speedMs, i0, i1, 0, 'avg'),
      avgPowerW: windowStat(s.powerW, i0, i1, 1, 'avg'),
      avgStepM: windowStat(s.stepLengthM, i0, i1, 0.01, 'avg'),
      avgVoCm: voM == null ? null : voM * 100,
      avgVertRatioPct: windowStat(s.verticalRatioPct, i0, i1, 0.1, 'avg'),
      avgGctPct: windowStat(s.stanceTimePct, i0, i1, 1, 'avg'),
      elevM: s.altitudeM ? windowElevGain(s.altitudeM, i0, i1) : null,
    });
  };
  for (let k = 1; k <= fullUnits; k++) {
    const dStart = base + unitM * (k - 1);
    const dEnd = base + unitM * k;
    const i0 = kmBisect(dist, dStart);
    const i1 = Math.max(kmBisect(dist, dEnd), i0 + 1);
    // ts is in MILLISECONDS — convert to seconds for the table
    push(k, String(k), dStart, dEnd, i0, i1, Math.max(0, (timeAt(dEnd) - timeAt(dStart)) / 1000));
  }
  // a ≥50 m tail is worth a speed-up read of the finish line
  if (total - unitM * fullUnits >= 50) {
    const dStart = base + unitM * fullUnits;
    const i0 = kmBisect(dist, dStart);
    const dEnd = dist[n - 1] ?? dStart;
    push(
      -1,
      `last (${((dEnd - dStart) / unitM).toFixed(2)} ${unitLabel()})`,
      dStart,
      dEnd,
      i0,
      n,
      Math.max(0, ((ts[n - 1] ?? 0) - timeAt(dStart)) / 1000),
    );
  }
  return rows;
}

/** avg or max of arr[j] for j in [i0, i1), skipping values below the filter
 * (strap dropouts, standing-time zeros on the form channels) */
export function windowStat(
  arr: number[] | undefined,
  i0: number,
  i1: number,
  min: number,
  mode: 'avg' | 'max',
): number | null {
  if (!arr?.length) return null;
  let sum = 0;
  let count = 0;
  let best: number | null = null;
  for (let j = i0; j < i1 && j < arr.length; j++) {
    const v = arr[j];
    if (v === undefined || v < min) continue;
    sum += v;
    count++;
    if (best === null || v > best) best = v;
  }
  if (!count || best === null) return null;
  return mode === 'avg' ? sum / count : best;
}

/** meters climbed between samples j−1→j for j in [i0, i1) */
export function windowElevGain(alt: number[], i0: number, i1: number): number {
  let gain = 0;
  const lo = Math.max(1, i0);
  for (let j = lo; j < i1 && j < alt.length; j++) {
    const d = (alt[j] ?? 0) - (alt[j - 1] ?? 0);
    if (d > 0) gain += d;
  }
  return gain;
}
