/**
 * Pure display + routing helpers for the dashboard. Extracted from App.tsx
 * so they can be unit-tested without mounting React (see lib/format.test.ts).
 * No state, no network — string/string in, string out.
 */

// ─── Number/date formatting ─────────────────────────────────────────────────

/** Distance/speed/pace unit — module-level so every formatter (and the raw
 * math in charts/splits) speaks the same unit, set from the Settings page. */
export type Unit = 'km' | 'mi';
const M_PER_UNIT: Record<Unit, number> = { km: 1000, mi: 1609.344 };
let unit: Unit = 'km';
export function getUnit(): Unit {
  return unit;
}
export function setUnit(u: Unit): void {
  unit = u;
}
/** meters per display unit — for callers doing raw math (split buckets, axis ticks) */
export function metersPerUnit(): number {
  return M_PER_UNIT[unit];
}
export function unitLabel(): string {
  return unit;
}

/** Display locale for date formatting — module-level like the unit, set from
 * the chosen UI language (see lib/i18n) so every fmt* call and chart tick
 * speaks one locale. */
let locale = 'en';
export function getLocale(): string {
  return locale;
}
export function setLocale(l: string): void {
  locale = l;
}

export function fmtKm(m: number | null | undefined): string {
  if (m == null) return '—';
  return `${(m / M_PER_UNIT[unit]).toFixed(2)} ${unit}`;
}
export function fmtMin(s: number | null | undefined): string {
  return s == null ? '—' : fmtSplitTime(s);
}
export function fmtSpeed(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return `${((ms * 3600) / M_PER_UNIT[unit]).toFixed(1)} ${unit === 'km' ? 'km/h' : 'mph'}`;
}
/** pace per display unit (minutes:seconds per km — or per mile) */
export function fmtPace(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const t = Math.round(sec);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, '0')} /${unit}`;
}
/** exact duration, h:mm:ss (or m:ss under an hour) — rounding happens ONCE
 * on the total so 59.6s rounds to 1:00, never to a bogus "0:60" */
export function fmtSplitTime(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const pad = (v: number): string => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
export function fmtDate(iso: string | undefined): string {
  return iso
    ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
}

/** Signed duration delta for the compare table: `+0:23` / `−1:05` / `+1:02:03`
 * (h:mm:ss beyond an hour), `null` when either side is unknown. */
export function fmtDeltaSecs(
  a: number | null | undefined,
  b: number | null | undefined,
): string | null {
  if (a == null || b == null) return null;
  const d = Math.round(b - a);
  if (d === 0) return '±0:00';
  return `${d > 0 ? '+' : '−'}${fmtSplitTime(Math.abs(d))}`;
}

/** Signed percent change from a to b: `+1.9%` / `−4.2%`, `null` when the base
 * is 0/unknown (a percent of nothing is noise). */
export function pctDelta(
  a: number | null | undefined,
  b: number | null | undefined,
): string | null {
  if (a == null || b == null || a === 0) return null;
  const p = ((b - a) / Math.abs(a)) * 100;
  if (!Number.isFinite(p)) return null;
  const sign = p > 0 ? '+' : p < 0 ? '−' : '±';
  return `${sign}${Math.abs(p).toFixed(1)}%`;
}

/** Signed integer difference for count-like metrics (elevation meters, bpm,
 * rpm) where absolute steps matter more than percent: `+6 m` / `−3` / `±0`,
 * `null` when either side is unknown. */
export function numDelta(
  a: number | null | undefined,
  b: number | null | undefined,
  suffix = '',
): string | null {
  if (a == null || b == null) return null;
  const d = Math.round(b - a);
  if (d === 0) return `±0${suffix}`;
  return `${d > 0 ? '+' : '−'}${Math.abs(d)}${suffix}`;
}

// ─── Feed constants ─────────────────────────────────────────────────────────

export const TYPE_EMOJI: Record<string, string> = {
  RUN: '🏃',
  RIDE: '🚴',
  VIRTUAL_RIDE: '🚴',
  WALK: '🚶',
  HIKE: '🥾',
  SWIM: '🏊',
  WORKOUT: '🏋️',
  OTHER: '⌚',
};

/** canonical feed-filter lists; the dropdowns only show values actually in range */
export const FEED_TYPES = [
  'RUN',
  'RIDE',
  'VIRTUAL_RIDE',
  'WALK',
  'HIKE',
  'SWIM',
  'WORKOUT',
  'OTHER',
] as const;
export const FEED_PROVIDERS = ['GARMIN', 'ZWIFT', 'IGPSPORT', 'STRAVA', 'OMRON'] as const;

// ─── URL-state helpers ──────────────────────────────────────────────────────

/** T is anchored by `fallback`; `v` passes only when it's a known member */
export function keyOf<T extends string>(
  allowed: readonly string[],
  v: string | null,
  fallback: T,
): T {
  return allowed.includes(v ?? '') ? (v as T) : fallback;
}

/** Whitelisted pick for deep-linked feed filters — "" (no filter) otherwise */
export function pick<T extends string>(allowed: readonly T[], v: string | null): T | '' {
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : '';
}

/** ISO date (`YYYY-MM-DD`) or undefined — rejects everything else */
export function isoDate(v: string | null): string | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

// ─── Client routing — /activity/<id>, /connections and /gear have their own pages ─

export type Route =
  | { name: 'dashboard' }
  | { name: 'activity'; id: string }
  | { name: 'connections' }
  | { name: 'gear' }
  | { name: 'settings' };

/** Parse a pathname; anything not matched below is the dashboard */
export function parseRoute(pathname: string): Route {
  if (/^\/connections\/?$/.test(pathname)) return { name: 'connections' };
  if (/^\/gear\/?$/.test(pathname)) return { name: 'gear' };
  if (/^\/settings\/?$/.test(pathname)) return { name: 'settings' };
  const m = /^\/activity\/([^/?#]+)/.exec(pathname);
  const id = m?.[1];
  return id ? { name: 'activity', id } : { name: 'dashboard' };
}
