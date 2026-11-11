/**
 * Pure display + routing helpers for the dashboard. Extracted from App.tsx
 * so they can be unit-tested without mounting React (see lib/format.test.ts).
 * No state, no network — string/string in, string out.
 */

// ─── Number/date formatting ─────────────────────────────────────────────────

export function fmtKm(m: number | null | undefined): string {
  return m == null ? '—' : `${(m / 1000).toFixed(2)} km`;
}
export function fmtMin(s: number | null | undefined): string {
  if (s == null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
export function fmtSpeed(ms: number | null | undefined): string {
  return ms == null ? '—' : `${((ms * 3600) / 1000).toFixed(1)} km/h`;
}
/** minutes:seconds per km */
export function fmtPace(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const t = Math.round(sec);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, '0')} /km`;
}
/** h:mm:ss for split tables */
export function fmtSplitTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.round(s % 60);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
export function fmtDate(iso: string | undefined): string {
  return iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
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
  | { name: 'gear' };

/** Parse a pathname; anything not matched below is the dashboard */
export function parseRoute(pathname: string): Route {
  if (/^\/connections\/?$/.test(pathname)) return { name: 'connections' };
  if (/^\/gear\/?$/.test(pathname)) return { name: 'gear' };
  const m = /^\/activity\/([^/?#]+)/.exec(pathname);
  const id = m?.[1];
  return id ? { name: 'activity', id } : { name: 'dashboard' };
}
