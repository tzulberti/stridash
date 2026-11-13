/**
 * One dashboard for every stride.
 *
 * Data policy mirrors the server: the dashboard NEVER talks to providers —
 * it only reads the local Stridash API. Login (JWT) → measurements +
 * activities list + one-activity drill-down with GPS/HR/power series.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { Measurement, Activity, MeResponse, Device } from '@stridash/types';

// ─── API client ──────────────────────────────────────────────────────────────

const TOKEN_KEY = 'stridash.accessToken';
const REFRESH_KEY = 'stridash.refreshToken';

/** "Remember me" puts both tokens in localStorage (survives the browser);
 * unchecked keeps them in sessionStorage (dies with the tab). */
const TOKEN_STORES = [localStorage, sessionStorage] as const;

function readToken(): string | null {
  for (const s of TOKEN_STORES) {
    const v = s.getItem(TOKEN_KEY);
    if (v) return v;
  }
  return null;
}

function saveTokens(accessToken: string, refreshToken: string, remember: boolean): void {
  for (const s of TOKEN_STORES) {
    s.removeItem(TOKEN_KEY);
    s.removeItem(REFRESH_KEY);
  }
  const store = remember ? localStorage : sessionStorage;
  store.setItem(TOKEN_KEY, accessToken);
  store.setItem(REFRESH_KEY, refreshToken);
}

function clearTokens(): void {
  for (const s of TOKEN_STORES) {
    s.removeItem(TOKEN_KEY);
    s.removeItem(REFRESH_KEY);
  }
}

/** Login decides the store; a refresh rotates in place in whichever store was
 * selected, so "remember" = tokens live in localStorage. */
let onTokenChanged: (t: string) => void = () => {};
function remembering(): boolean {
  return !!(localStorage.getItem(REFRESH_KEY) || localStorage.getItem(TOKEN_KEY));
}

/** Try to mint a fresh pair from the stored refresh token (false once dead). */
let refreshInflight: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  refreshInflight ??= (async () => {
    const rt = sessionStorage.getItem(REFRESH_KEY) ?? localStorage.getItem(REFRESH_KEY);
    if (!rt) return false;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      const j = (await res.json()) as { accessToken: string; refreshToken: string };
      saveTokens(j.accessToken, j.refreshToken, remembering());
      onTokenChanged(j.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

async function api<T>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string | null;
    query?: Record<string, string>;
  } = {},
): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
  const call = (tok: string | null | undefined) =>
    fetch(`/api${path}${qs}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  const res = await (opts.token ? call(opts.token) : call(readToken()));
  const json = (await res.json().catch(() => null)) as T & { error?: string; detail?: unknown };
  // A 401 mid-dashboard usually means the 15-minute access token ran out —
  // refresh once and replay before surfacing an error.
  if (res.status === 401 && !path.startsWith('/auth/') && (await tryRefresh())) {
    const retry = await call(readToken());
    const json2 = (await retry.json().catch(() => null)) as T & {
      error?: string;
      detail?: unknown;
    };
    if (retry.ok) return json2;
    throw new Error(`${json2?.error ?? retry.statusText}`);
  }
  if (!res.ok) {
    const detail = typeof json?.detail === 'string' ? ` — ${json.detail}` : '';
    throw new Error(`${json?.error ?? res.statusText}${detail}`);
  }
  return json;
}

// ─── Force-sync result → one readable line ───────────────────────────────────

type SyncResponseJson = {
  result?: { itemsCreated?: number; itemsUpdated?: number };
  wellness?: { sleepUpserted?: number; daysUpserted?: number };
};

/** one line per connection sync: what was pulled/changed (Garmin adds the
 * wellness pass; empty responses read as "nothing new") */
function summarizeSync(res: SyncResponseJson): string {
  const r = res.result;
  const parts: string[] = [];
  if (r?.itemsCreated) parts.push(t('sync.new', { n: r.itemsCreated }));
  if (r?.itemsUpdated) parts.push(t('sync.updated', { n: r.itemsUpdated }));
  if (res.wellness?.sleepUpserted) parts.push(t('sync.sleep', { n: res.wellness.sleepUpserted }));
  if (res.wellness?.daysUpserted) parts.push(t('sync.daily', { n: res.wellness.daysUpserted }));
  return parts.length ? t('sync.summary', { items: parts.join(' · ') }) : t('sync.nothingNew');
}

// ─── Small SVG chart (no chart deps — keeps bundle light and honest) ─────────

type Point = { x: number; y: number };

// month names come from Intl in the active locale (en → Jan/Feb/…, ru →
// янв./февр./…) — cached per locale since the chart renders on every hover
const monthFmtCache = new Map<string, Intl.DateTimeFormat>();
function monthShort(d: Date): string {
  const loc = getLocale();
  let f = monthFmtCache.get(loc);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, { month: 'short', timeZone: 'UTC' });
    monthFmtCache.set(loc, f);
  }
  return f.format(d);
}

function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${monthShort(d)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** elapsed since the activity start: 0:30 for sub-hour runs, 1:02:33 after */
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (v: number): string => String(v).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function fmtTick(ms: number, spanDays: number, x0: number): string {
  const d = new Date(ms);
  if (spanDays < 1.5) return fmtElapsed(ms - x0); // activity-length spans: elapsed since start
  if (spanDays >= 545) return `${monthShort(d)} ${d.getUTCFullYear()}`;
  if (spanDays >= 60) return `${monthShort(d)} '${String(d.getUTCFullYear() % 100)}`;
  return `${monthShort(d)} ${d.getUTCDate()}`;
}

/** readable number for tick marks + tooltips */
function fmtVal(v: number): string {
  const a = Math.abs(v);
  return v.toLocaleString(undefined, { maximumFractionDigits: a < 10 ? 2 : a < 1000 ? 1 : 0 });
}

/** ~count "nice" ticks (1/2/5×10ⁿ steps) covering [min, max] */
function niceTicks(min: number, max: number, count: number): number[] {
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
const ZONE_COLORS = [
  '#9aa4b2',
  '#3e8ef7',
  '#30a46c',
  '#d29922',
  '#e5484d',
  '#e5484d',
  '#e5484d',
  '#e5484d',
];

function LineChart({
  points,
  color,
  height = 200,
  label,
  unit,
  zoneThresholds,
  xMode = 'time',
}: {
  points: Point[];
  color: string;
  height?: number;
  label?: string;
  unit?: string;
  /** lower bpm bound of zones 2..n (ascending, Infinity allowed) — when set
   * the line is drawn segment-by-segment in the zone colors */
  zoneThresholds?: number[] | null;
  /** which X axis: elapsed time ("time", default) or distance in meters */
  xMode?: 'time' | 'distance';
}) {
  // hover index — declared before the early return so hook counts stay stable
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="empty">{t('chart.noData')}</div>;

  const W = 900;
  const H = height;
  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 42; // room for the date ticks + "date" x-axis title
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs);
  const y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const spanX = Math.max(1e-9, x1 - x0);
  const spanY = Math.max(1e-9, y1 - y0);
  const spanDays = spanX / 86_400_000;
  const toXY = (p: Point): [number, number] => [
    padL + ((p.x - x0) / spanX) * plotW,
    padT + (1 - (p.y - y0) / spanY) * plotH,
  ];
  const path = points
    .map((p, i) => {
      const [x, y] = toXY(p);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const yTicks = niceTicks(y0, y1, 4);
  // distance mode ticks live in unit space (nice numbers), plotted back in meters
  const isDist = xMode === 'distance';
  const unitM = metersPerUnit();
  const xTickCount = Math.max(2, Math.round(plotW / 170));
  const xTickMarks = isDist
    ? niceTicks(x0 / unitM, x1 / unitM, Math.max(3, Math.round(plotW / 160))).map((d) => ({
        x: d * unitM,
        label: fmtVal(d),
      }))
    : Array.from({ length: xTickCount }, (_, i) => {
        const t = x0 + (spanX * i) / (xTickCount - 1);
        return { x: t, label: fmtTick(t, spanDays, x0) };
      });

  // nearest point by pixel distance along the time axis (viewBox units)
  const svgMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      const d = Math.abs(toXY(p)[0] - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  const hp = hover !== null ? points[hover] : undefined;
  const [hx, hy] = hp ? toXY(hp) : [0, 0];
  const tipW = 128;
  const tipH = 36;
  const tipX = hx + 10 + tipW > W - padR ? hx - tipW - 10 : hx + 10;
  const tipY = Math.min(Math.max(hy - tipH - 10, padT), H - padB - tipH);

  /** zone of a bpm value: 0-based (0 = Z1); only when thresholds are given */
  const zoneOf = zoneThresholds
    ? (y: number): number => {
        let k = 0;
        while (k < zoneThresholds.length && y >= (zoneThresholds[k] ?? Infinity)) k++;
        return k;
      }
    : null;
  const zoneColor = (z: number): string =>
    ZONE_COLORS[Math.min(z, ZONE_COLORS.length - 1)] ?? color;

  // zoned line: each sample-span drawn in the zone color of its midpoint,
  // batched into one path per zone
  const zonePaths = zoneOf
    ? (() => {
        const byZone = new Map<number, string[]>();
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1];
          const b = points[i];
          if (!a || !b) continue;
          const [ax, ay] = toXY(a);
          const [bx, by] = toXY(b);
          const z = zoneOf((a.y + b.y) / 2);
          const arr = byZone.get(z) ?? [];
          arr.push(`M${ax.toFixed(1)},${ay.toFixed(1)} L${bx.toFixed(1)},${by.toFixed(1)}`);
          byZone.set(z, arr);
        }
        return [...byZone.entries()]
          .map(([z, parts]) => ({ z, d: parts.join(' '), fill: zoneColor(z) }))
          .sort((p, q) => p.z - q.z);
      })()
    : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label={label}
      onMouseMove={svgMove}
      onMouseLeave={() => setHover(null)}
    >
      {/* horizontal grid + Y tick labels */}
      {yTicks.map((t) => {
        const y = padT + (1 - (t - y0) / spanY) * plotH;
        return (
          <g key={`y${t}`}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart-grid" />
            <text x={padL - 6} y={y + 3.5} textAnchor="end" className="chart-axis">
              {fmtVal(t)}
            </text>
          </g>
        );
      })}
      {/* X tick labels */}
      {xTickMarks.map((t) => (
        <text
          key={`x${t.x}`}
          x={padL + ((t.x - x0) / spanX) * plotW}
          y={H - padB + 16}
          textAnchor="middle"
          className="chart-axis"
        >
          {t.label}
        </text>
      ))}
      {/* axis titles */}
      {label && (
        <text
          transform={`rotate(-90 13 ${padT + plotH / 2})`}
          x={13}
          y={padT + plotH / 2}
          textAnchor="middle"
          className="chart-axis-title"
        >
          {label}
        </text>
      )}
      <text x={W - padR} y={H - 6} textAnchor="end" className="chart-axis-title">
        {isDist
          ? t('chart.axis.distance', { unit: unitLabel() })
          : spanDays < 1.5
            ? t('chart.axis.elapsed')
            : t('chart.axis.date')}
      </text>
      {zonePaths ? (
        zonePaths.map((zp) => (
          <path key={zp.z} d={zp.d} fill="none" stroke={zp.fill} strokeWidth={1.75} />
        ))
      ) : (
        <path d={path} fill="none" stroke={color} strokeWidth={1.75} />
      )}
      {points.length <= 200 &&
        points.map((p, i) => {
          const [x, y] = toXY(p);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={PointsRadius(points.length)}
              fill={zoneOf ? zoneColor(zoneOf(p.y)) : color}
            />
          );
        })}
      {/* hover: crosshair, highlighted point, tooltip with date + value */}
      {hp && (
        <g>
          <line x1={hx} x2={hx} y1={padT} y2={H - padB} className="chart-cross" />
          <circle
            cx={hx}
            cy={hy}
            r={PointsRadius(points.length) + 2.5}
            fill={zoneOf ? zoneColor(zoneOf(hp.y)) : color}
            stroke="#14171f"
            strokeWidth={1.5}
          />
          <g transform={`translate(${tipX},${tipY})`}>
            <rect width={tipW} height={tipH} rx={6} className="chart-tip" />
            <text x={8} y={14} className="chart-tip-date">
              {isDist ? fmtKm(hp.x) : spanDays < 1.5 ? fmtElapsed(hp.x - x0) : fmtDay(hp.x)}
            </text>
            <text x={8} y={28} className="chart-tip-val">
              {fmtVal(hp.y)}
              {unit}
              {zoneOf ? ` · Z${zoneOf(hp.y) + 1}` : ''}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

function PointsRadius(n: number): number {
  if (n > 80) return 1.5;
  if (n > 30) return 2.5;
  return 3.5;
}

/** the two series colors of every compare chart: A (this activity) green,
 * B (the other) red — identity beats per-channel coloring when two lines
 * share one plot */
const COMPARE_A = '#30a46c';
const COMPARE_B = '#e5484d';

/** Two-series overlay for the activity-compare section: shared axes across
 * both activities, two polylines (A/B), no hover — v1 stays read-only.
 * xMode mirrors LineChart (elapsed time, or meters when both sides carry a
 * distance stream). */
function CompareChart({
  a,
  b,
  label,
  xMode = 'time',
  height = 180,
}: {
  a: Point[];
  b: Point[];
  label?: string;
  /** which X axis: elapsed time (default) or distance in meters */
  xMode?: 'time' | 'distance';
  height?: number;
}) {
  if (a.length < 2 || b.length < 2) return <div className="empty">{t('chart.noData')}</div>;

  const W = 900;
  const H = height;
  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // combined domain so both lines live in one coordinate space
  const all = [...a, ...b];
  const x0 = Math.min(...all.map((p) => p.x)),
    x1 = Math.max(...all.map((p) => p.x));
  const y0 = Math.min(...all.map((p) => p.y)),
    y1 = Math.max(...all.map((p) => p.y));
  const spanX = Math.max(1e-9, x1 - x0);
  const spanY = Math.max(1e-9, y1 - y0);
  const spanDays = spanX / 86_400_000;
  const toXY = (p: Point): [number, number] => [
    padL + ((p.x - x0) / spanX) * plotW,
    padT + (1 - (p.y - y0) / spanY) * plotH,
  ];
  const pathOf = (pts: Point[]): string =>
    pts
      .map((p, i) => {
        const [x, y] = toXY(p);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const yTicks = niceTicks(y0, y1, 4);
  const isDist = xMode === 'distance';
  const unitM = metersPerUnit();
  const xTickCount = Math.max(2, Math.round(plotW / 170));
  const xTickMarks = isDist
    ? niceTicks(x0 / unitM, x1 / unitM, Math.max(3, Math.round(plotW / 160))).map((d) => ({
        x: d * unitM,
        label: fmtVal(d),
      }))
    : Array.from({ length: xTickCount }, (_, i) => {
        const t = x0 + (spanX * i) / (xTickCount - 1);
        return { x: t, label: fmtTick(t, spanDays, x0) };
      });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
      {yTicks.map((tv) => {
        const y = padT + (1 - (tv - y0) / spanY) * plotH;
        return (
          <g key={`y${tv}`}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart-grid" />
            <text x={padL - 6} y={y + 3.5} textAnchor="end" className="chart-axis">
              {fmtVal(tv)}
            </text>
          </g>
        );
      })}
      {xTickMarks.map((tk) => (
        <text
          key={`x${tk.x}`}
          x={padL + ((tk.x - x0) / spanX) * plotW}
          y={H - padB + 16}
          textAnchor="middle"
          className="chart-axis"
        >
          {tk.label}
        </text>
      ))}
      {label && (
        <text
          transform={`rotate(-90 13 ${padT + plotH / 2})`}
          x={13}
          y={padT + plotH / 2}
          textAnchor="middle"
          className="chart-axis-title"
        >
          {label}
        </text>
      )}
      <text x={W - padR} y={H - 6} textAnchor="end" className="chart-axis-title">
        {isDist ? t('chart.axis.distance', { unit: unitLabel() }) : t('chart.axis.elapsed')}
      </text>
      <path d={pathOf(a)} fill="none" stroke={COMPARE_A} strokeWidth={1.75} />
      <path d={pathOf(b)} fill="none" stroke={COMPARE_B} strokeWidth={1.75} />
    </svg>
  );
}

/** HR-zone bpm boundaries recovered from the series + the stored per-zone
 * minutes: FIT samples arrive ~time-uniform, so the bpm under which exactly
 * Σ(minutes of zones 1..k-1) of time sits is zone k's lower bound.
 * Returns the lower bounds of zones 2..n; Infinity for zones no sample ever
 * reaches (zero higher-zone minutes) so their color can't swallow lower ones. */
function hrZoneThresholds(hrs: number[], zoneMinutes: number[] | null): number[] | null {
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

interface KmSplit {
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
function kmBisect(dist: number[], d: number): number {
  let lo = 0;
  let hi = dist.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((dist[mid] ?? 0) < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type KmSplitsSeries = {
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
function buildKmSplits(s: KmSplitsSeries): KmSplit[] | null {
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
function windowStat(
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
function windowElevGain(alt: number[], i0: number, i1: number): number {
  let gain = 0;
  const lo = Math.max(1, i0);
  for (let j = lo; j < i1 && j < alt.length; j++) {
    const d = (alt[j] ?? 0) - (alt[j - 1] ?? 0);
    if (d > 0) gain += d;
  }
  return gain;
}

// (fmtPace / fmtSplitTime moved to lib/format.ts)

// ─── Shared bits — pure display helpers live in lib/format.ts ────────────────

import {
  fmtKm,
  fmtMin,
  fmtSpeed,
  fmtPace,
  fmtSplitTime,
  fmtDate,
  setUnit,
  metersPerUnit,
  unitLabel,
  setLocale,
  getLocale,
  fmtDeltaSecs,
  pctDelta,
  TYPE_EMOJI,
  FEED_TYPES,
  FEED_PROVIDERS,
  keyOf,
  pick,
  isoDate,
  parseRoute,
  type Route,
  type Unit,
} from './lib/format';
import { setLang, localeOf, LANGUAGES, t, type Lang, type MsgKey } from './lib/i18n/index';

// ─── Activity page (/activity/<id> — every scrap of info for one activity) ───

interface ActivitySeriesRow {
  provider: string;
  sampleCount: number;
  series: {
    timeMs?: number[];
    latDeg?: number[];
    lngDeg?: number[];
    distanceM?: number[];
    altitudeM?: number[];
    speedMs?: number[];
    hrBpm?: number[];
    cadenceRpm?: number[];
    powerW?: number[];
    verticalOscillationM?: number[];
    stanceTimePct?: number[];
    verticalRatioPct?: number[];
    stepLengthM?: number[];
    respirationRate?: number[];
    staminaPct?: number[];
    temperatureC?: number[];
  };
}

/** labeled stream charts for the activity page, in display order */
const SERIES_CHANNELS: Array<[string, MsgKey, string, string]> = [
  ['speedMs', 'series.speed', '#30a46c', ' m/s'],
  ['hrBpm', 'series.hr', '#e5484d', ' bpm'],
  ['powerW', 'series.power', '#6e56cf', ' W'],
  ['cadenceRpm', 'series.cadence', '#0091ff', ' rpm'],
  ['altitudeM', 'series.altitude', '#b8860b', ' m'],
  ['respirationRate', 'series.respiration', '#d6409f', ' br/min'],
  ['staminaPct', 'series.stamina', '#d29922', ' %'],
  ['stepLengthM', 'series.stepLength', '#80a9a0', ' m'],
  ['verticalOscillationM', 'series.vertOscillation', '#9c6ade', ' m'],
  ['stanceTimePct', 'series.groundContact', '#bf7f26', ' %'],
  ['verticalRatioPct', 'series.vertRatio', '#bf7f26', ' %'],
];

function ActivityDetail({
  id,
  token,
  preview,
  onBack,
}: {
  id: string;
  token: string;
  /** summary row known from the dashboard list — instant header on click; a
   * deep-linked URL has none and just starts with the fetch */
  preview: Activity | null;
  onBack: () => void;
}) {
  /** detail row = list activity + the recording device (from /activities/:id) */
  const [act, setAct] = useState<(Activity & { device?: Device | null }) | null>(preview);
  const [rows, setRows] = useState<ActivitySeriesRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** shared X axis for the stream charts: elapsed time (default) or distance */
  const [xAxis, setXAxis] = useState<'time' | 'distance'>(() =>
    new URLSearchParams(window.location.search).get('x') === 'distance' ? 'distance' : 'time',
  );

  // keep the choice in the URL so axis-shared activity links match the view
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (xAxis === 'distance') q.set('x', 'distance');
    else q.delete('x');
    const s = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}`);
  }, [xAxis]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    setAct(preview);
    api<{ items: Array<Activity & { device?: Device | null; series: ActivitySeriesRow[] }> }>(
      `/activities/${id}`,
      {
        token,
      },
    )
      .then((r) => {
        if (!alive) return;
        const item = r.items[0];
        if (!item) {
          setError(t('detail.notFound'));
          return;
        }
        setAct(item);
        setRows(item.series);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [id, token, preview]);

  // ─── Compare with a similar activity ───────────────────────────────────────

  /** lean picker row from GET /activities/:id/similar */
  interface SimilarRow {
    id: string;
    headline: string;
    type: string;
    startTime: string;
    durationS: number | null;
    movingTimeS: number | null;
    distanceM: number | null;
    avgSpeedMs: number | null;
  }

  const [similar, setSimilar] = useState<SimilarRow[] | null>(null);
  const [compareId, setCompareId] = useState('');
  const [compareAct, setCompareAct] = useState<(Activity & { series: ActivitySeriesRow[] }) | null>(
    null,
  );

  // candidates refresh with the activity; picking one resets the old compare
  useEffect(() => {
    let alive = true;
    setSimilar(null);
    setCompareId('');
    setCompareAct(null);
    api<{ items: SimilarRow[] }>(`/activities/${id}/similar`, { token })
      .then((r) => {
        if (alive) setSimilar(r.items);
      })
      .catch(() => {
        if (alive) setSimilar([]);
      });
    return () => {
      alive = false;
    };
  }, [id, token]);

  useEffect(() => {
    if (!compareId) {
      setCompareAct(null);
      return;
    }
    let alive = true;
    setCompareAct(null);
    api<{ items: Array<Activity & { series: ActivitySeriesRow[] }> }>(`/activities/${compareId}`, {
      token,
    })
      .then((r) => {
        if (alive) setCompareAct(r.items[0] ?? null);
      })
      .catch(() => {
        if (alive) setCompareAct(null);
      });
    return () => {
      alive = false;
    };
  }, [compareId, token]);

  /** side-by-side stat rows: only metrics at least one side reports */
  const compareRows = useMemo(() => {
    const b = compareAct;
    if (!act || !b) return [];
    type Row = { key: string; label: MsgKey; av: string; bv: string; delta: string | null };
    const out: Row[] = [];
    const push = (
      key: string,
      label: MsgKey,
      av: number | null | undefined,
      bv: number | null | undefined,
      fmt: (v: number) => string,
      deltaOf: (x: number | null, y: number | null) => string | null,
    ): void => {
      if (av == null && bv == null) return;
      out.push({
        key,
        label,
        av: av == null ? '—' : fmt(av),
        bv: bv == null ? '—' : fmt(bv),
        delta: deltaOf(av ?? null, bv ?? null),
      });
    };
    const bpm = (v: number): string => `${Math.round(v)}`;
    const watts = (v: number): string => `${Math.round(v)} W`;
    push('distance', 'detail.distanceC', act.distanceM, b.distanceM, fmtKm, pctDelta);
    push('duration', 'detail.duration', act.durationS, b.durationS, fmtMin, fmtDeltaSecs);
    push('moving', 'detail.moving', act.movingTimeS, b.movingTimeS, fmtMin, fmtDeltaSecs);
    push('avgSpeed', 'compare.avgSpeed', act.avgSpeedMs, b.avgSpeedMs, fmtSpeed, pctDelta);
    push('maxSpeed', 'compare.maxSpeed', act.maxSpeedMs, b.maxSpeedMs, fmtSpeed, pctDelta);
    push('avgHr', 'split.avgHr', act.avgHr, b.avgHr, bpm, pctDelta);
    push('maxHr', 'split.maxHr', act.maxHr, b.maxHr, bpm, pctDelta);
    push('avgPower', 'compare.avgPower', act.avgPowerW, b.avgPowerW, watts, pctDelta);
    push('maxPower', 'compare.maxPower', act.maxPowerW, b.maxPowerW, watts, pctDelta);
    push('calories', 'detail.calories', act.caloriesKcal, b.caloriesKcal, bpm, pctDelta);
    push('ascent', 'detail.ascent', act.totalAscentM, b.totalAscentM, bpm, pctDelta);
    return out;
  }, [act, compareAct]);
  /** overlaid charts for channels BOTH sides recorded; distance x-axis only
   * when both series carry a full distance stream (else elapsed time) */
  const compareCharts = useMemo(() => {
    const sa = rows?.[0]?.series;
    const sb = compareAct?.series?.[0]?.series;
    if (!sa || !sb)
      return {
        xMode: 'time' as const,
        charts: [] as Array<{
          key: string;
          titleKey: MsgKey;
          pointsA: Point[];
          pointsB: Point[];
        }>,
      };
    const aligned = (s: ActivitySeriesRow['series']): boolean =>
      (s.distanceM?.length ?? 0) >= 2 && s.distanceM?.length === s.timeMs?.length;
    const xMode = aligned(sa) && aligned(sb) ? ('distance' as const) : ('time' as const);
    const pts = (s: ActivitySeriesRow['series'], vals: number[]): Point[] =>
      vals.map((v, i) => ({
        x: (xMode === 'distance' ? s.distanceM?.[i] : s.timeMs?.[i]) ?? i,
        y: v,
      }));
    const charts: Array<{ key: string; titleKey: MsgKey; pointsA: Point[]; pointsB: Point[] }> = [];
    for (const [key, titleKey] of SERIES_CHANNELS) {
      const va = (sa as Record<string, number[] | undefined>)[key];
      const vb = (sb as Record<string, number[] | undefined>)[key];
      if (!va || !vb || va.length < 2 || vb.length < 2) continue;
      charts.push({ key, titleKey, pointsA: pts(sa, va), pointsB: pts(sb, vb) });
    }
    return { xMode, charts };
  }, [rows, compareAct]);

  // streams come back as labeled numeric arrays aligned with timeMs — plot
  // against the real sample clock so the axes show elapsed time; distance
  // mode plots them against the distance stream instead. The HR chart gets
  // zone coloring derived from the stored per-zone minutes
  const charts = useMemo(() => {
    const s = rows?.[0]?.series;
    const ts = s?.timeMs ?? [];
    if (!s || ts.length < 2) return [];
    const dist = s.distanceM ?? [];
    const byDistance = xAxis === 'distance' && dist.length === ts.length;
    const out: Array<{
      key: string;
      titleKey: MsgKey;
      color: string;
      points: Point[];
      unit: string;
      zones: number[] | null;
    }> = [];
    for (const [key, titleKey, color, unit] of SERIES_CHANNELS) {
      const vals = (s as Record<string, number[] | undefined>)[key];
      if (!vals?.length) continue;
      out.push({
        key,
        titleKey,
        color,
        unit,
        zones: key === 'hrBpm' ? hrZoneThresholds(vals, act?.hrZonesMin ?? null) : null,
        points: vals.map((v, i) => ({
          x: byDistance && dist[i] !== undefined ? dist[i] : (ts[i] ?? i),
          y: v,
        })),
      });
    }
    return out;
  }, [rows, act, xAxis]);

  const hasDistance = (rows?.[0]?.series.distanceM?.length ?? 0) >= 2;

  // per-unit split table (needs a distance stream ≥ 1 unit)
  const splits = useMemo(() => {
    const s = rows?.[0]?.series;
    if (!s) return null;
    return buildKmSplits(s);
  }, [rows]);

  // columns render only when some row actually has the metric, so each sport
  // gets the columns its data supports (Garmin-style laps)
  const splitCols = useMemo(() => {
    const rs = splits ?? [];
    const has = (pick: (r: KmSplit) => number | null): boolean => rs.some((r) => pick(r) != null);
    const cols: Array<{ key: string; head: string; cell: (r: KmSplit) => string | null }> = [
      { key: 'km', head: unitLabel(), cell: (r) => r.label },
      { key: 'time', head: t('split.time'), cell: (r) => fmtSplitTime(r.timeS) },
    ];
    if (has((r) => r.bestPaceSec))
      cols.push({ key: 'bp', head: t('split.best'), cell: (r) => fmtPace(r.bestPaceSec) });
    if (has((r) => r.paceSec))
      cols.push({ key: 'pace', head: t('split.pace'), cell: (r) => fmtPace(r.paceSec) });
    if (has((r) => r.avgHr))
      cols.push({
        key: 'hr',
        head: t('split.avgHr'),
        cell: (r) => (r.avgHr != null ? `${Math.round(r.avgHr)} bpm` : null),
      });
    if (has((r) => r.maxHr))
      cols.push({
        key: 'hrm',
        head: t('split.maxHr'),
        cell: (r) => (r.maxHr != null ? `${Math.round(r.maxHr)} bpm` : null),
      });
    if (has((r) => r.avgCadence))
      cols.push({
        key: 'cad',
        head: t('split.cadence'),
        cell: (r) => (r.avgCadence != null ? `${Math.round(r.avgCadence)}` : null),
      });
    if (has((r) => r.avgSpeedMs))
      cols.push({
        key: 'spd',
        head: t('split.speed'),
        cell: (r) => (r.avgSpeedMs != null ? fmtSpeed(r.avgSpeedMs) : null),
      });
    if (has((r) => r.avgPowerW))
      cols.push({
        key: 'pw',
        head: t('split.power'),
        cell: (r) => (r.avgPowerW != null ? `${Math.round(r.avgPowerW)} W` : null),
      });
    if (has((r) => r.avgStepM))
      cols.push({
        key: 'step',
        head: t('split.step'),
        cell: (r) => (r.avgStepM != null ? r.avgStepM.toFixed(2) : null),
      });
    if (has((r) => r.avgVoCm))
      cols.push({
        key: 'vo',
        head: t('split.vertOsc'),
        cell: (r) => (r.avgVoCm != null ? r.avgVoCm.toFixed(1) : null),
      });
    if (has((r) => r.avgVertRatioPct))
      cols.push({
        key: 'vr',
        head: t('split.vertRatio'),
        cell: (r) => (r.avgVertRatioPct != null ? r.avgVertRatioPct.toFixed(1) : null),
      });
    if (has((r) => r.avgGctPct))
      cols.push({
        key: 'gct',
        head: t('split.gct'),
        cell: (r) => (r.avgGctPct != null ? r.avgGctPct.toFixed(1) : null),
      });
    if (has((r) => r.elevM))
      cols.push({
        key: 'el',
        head: t('split.elev'),
        cell: (r) => (r.elevM != null ? `${Math.round(r.elevM)} m` : null),
      });
    return cols;
  }, [splits]);

  if (error) return <p className="error">{error}</p>;
  if (!act) return <p>{t('detail.loading')}</p>;

  return (
    <div>
      <button className="btn" onClick={onBack}>
        {t('nav.backDetail')}
      </button>
      <h2>
        {TYPE_EMOJI[act.type] ?? '⌚'} {act.headline}
      </h2>
      {act.workoutName && (
        <p className="conn-sub">{t('detail.workout', { name: act.workoutName })}</p>
      )}
      <div className="metric-tabs">
        <button
          className={`btn ghost ${xAxis === 'time' ? 'active' : ''}`}
          onClick={() => setXAxis('time')}
        >
          {t('detail.timeTab')}
        </button>
        <button
          className={`btn ghost ${xAxis === 'distance' ? 'active' : ''}`}
          disabled={!hasDistance}
          onClick={() => setXAxis('distance')}
        >
          {t('detail.distanceTab')}
        </button>
      </div>
      <div className="cards">
        <Card label={t('detail.start')} value={fmtDate(act.startTime)} />
        <Card label={t('detail.distanceC')} value={fmtKm(act.distanceM)} />
        <Card label={t('detail.duration')} value={fmtMin(act.durationS)} />
        <Card label={t('detail.moving')} value={fmtMin(act.movingTimeS)} />
        <Card
          label={t('detail.avgMaxHr')}
          value={
            has(act.avgHr) || has(act.maxHr) ? `${act.avgHr ?? '—'} / ${act.maxHr ?? '—'} bpm` : '—'
          }
        />
        <Card
          label={t('detail.avgMaxPower')}
          value={
            has(act.avgPowerW) || has(act.maxPowerW)
              ? `${act.avgPowerW ?? '—'} / ${act.maxPowerW ?? '—'} W`
              : '—'
          }
        />
        <Card
          label={t('detail.avgMaxSpeed')}
          value={
            has(act.avgSpeedMs) || has(act.maxSpeedMs)
              ? `${fmtSpeed(act.avgSpeedMs)} / ${fmtSpeed(act.maxSpeedMs)}`
              : '—'
          }
        />
        <Card
          label={t('detail.avgMaxCadence')}
          value={
            has(act.avgCadence) || has(act.maxCadence)
              ? `${act.avgCadence ?? '—'} / ${act.maxCadence ?? '—'} rpm`
              : '—'
          }
        />
        <Card
          label={t('detail.ascent')}
          value={
            has(act.totalAscentM) || has(act.totalDescentM)
              ? `${act.totalAscentM ?? '—'} / ${act.totalDescentM ?? '—'} m`
              : '—'
          }
        />
        <Card
          label={t('detail.elevHigh')}
          value={
            has(act.elevationHighM) || has(act.elevationLowM)
              ? `${act.elevationLowM ?? '—'} / ${act.elevationHighM ?? '—'} m`
              : '—'
          }
        />
        <Card label={t('detail.calories')} value={asStr(act.caloriesKcal, ' kcal')} />
        {act.trainingLoad != null ? (
          <Card label={t('detail.trainingLoad')} value={String(act.trainingLoad)} />
        ) : null}
        {act.indoor ? <Card label={t('detail.mode')} value={t('detail.indoorVal')} /> : null}
        {(() => {
          const d = act.device;
          if (!d) return null;
          const name =
            d.model ??
            (d.manufacturer ? d.manufacturer[0]!.toUpperCase() + d.manufacturer.slice(1) : null);
          if (!name) return null;
          return <Card label={t('detail.device')} value={name} />;
        })()}
      </div>
      {error && <p className="error">{error}</p>}

      {splits && splitCols.length > 2 ? (
        <section>
          <h3>{t('detail.splits', { unit: unitLabel() })}</h3>
          <div className="table-scroll">
            <table className="list splits">
              <thead>
                <tr>
                  {splitCols.map((c) => (
                    <th key={c.key}>{c.head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {splits.map((s) => (
                  <tr key={s.label}>
                    {splitCols.map((c) => (
                      <td key={c.key}>{c.cell(s) ?? null}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {similar !== null && similar.length === 0 ? (
        <p className="empty">{t('compare.none')}</p>
      ) : null}
      {similar !== null && similar.length > 0 ? (
        <section>
          <h3>{t('compare.title')}</h3>
          <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
            <option value="">{t('compare.pick')}</option>
            {similar.map((s) => (
              <option key={s.id} value={s.id}>
                {s.headline} · {fmtDate(s.startTime)} ·{' '}
                {s.distanceM != null ? fmtKm(s.distanceM) : fmtMin(s.durationS)}
              </option>
            ))}
          </select>
          {compareId && !compareAct ? <p>{t('detail.loading')}</p> : null}
          {compareAct ? (
            <>
              <div className="cmp-legend">
                <span className="cmp-item">
                  <span className="cmp-sw" style={{ background: COMPARE_A }} />
                  {act.headline} · {fmtDate(act.startTime)}
                </span>
                <span className="cmp-item">
                  <span className="cmp-sw" style={{ background: COMPARE_B }} />
                  {compareAct.headline} · {fmtDate(compareAct.startTime)}
                </span>
              </div>
              <div className="table-scroll">
                <table className="list">
                  <thead>
                    <tr>
                      <th>{t('compare.metric')}</th>
                      <th>{t('compare.this')}</th>
                      <th>{t('compare.other')}</th>
                      <th>Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareRows.map((r) => (
                      <tr key={r.key}>
                        <td>{t(r.label)}</td>
                        <td>{r.av}</td>
                        <td>{r.bv}</td>
                        <td>{r.delta ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {compareCharts.charts.map((c) => (
                <div key={c.key}>
                  <h4>{t(c.titleKey)}</h4>
                  <CompareChart
                    a={c.pointsA}
                    b={c.pointsB}
                    label={t(c.titleKey)}
                    xMode={compareCharts.xMode}
                  />
                </div>
              ))}
            </>
          ) : null}
        </section>
      ) : null}

      {rows === null && !error ? <p>{t('detail.loadingSeries')}</p> : null}
      {charts.map((c) => (
        <section key={c.key}>
          <h3>{t(c.titleKey)}</h3>
          <LineChart
            points={c.points}
            color={c.color}
            label={t(c.titleKey)}
            unit={c.unit}
            zoneThresholds={c.zones}
            xMode={xAxis === 'distance' && hasDistance ? 'distance' : 'time'}
          />
          {c.key === 'hrBpm' && c.zones ? (
            <div className="zone-legend">
              {Array.from({ length: c.zones.length + 1 }, (_, i) => (
                <span key={i} className="zone-item">
                  <span
                    className="zone-sw"
                    style={{ background: ZONE_COLORS[Math.min(i, ZONE_COLORS.length - 1)] }}
                  />
                  Z{i + 1}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ))}
      {rows !== null && charts.length === 0 && !error ? (
        <p className="empty">{t('detail.noSeries')}</p>
      ) : null}

      {act.hrZonesMin?.length ? (
        <section>
          <h3>{t('detail.zones')}</h3>
          <table className="list">
            <thead>
              <tr>
                <th>{t('zones.zone')}</th>
                <th>{t('zones.minutes')}</th>
              </tr>
            </thead>
            <tbody>
              {act.hrZonesMin.map((min, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>
                    {min} {t('detail.minShort')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {act.notes ? (
        <section>
          <h3>{t('detail.notes')}</h3>
          <p>{act.notes}</p>
        </section>
      ) : null}
    </div>
  );
}

// ─── Main dashboard ──────────────────────────────────────────────────────────

interface SleepRow {
  dateKey: string;
  startAt: string | null;
  endAt: string | null;
  totalSleepS: number | null;
  deepS: number | null;
  lightS: number | null;
  remS: number | null;
  awakeS: number | null;
  napS: number | null;
  awakeCount: number | null;
  avgSleepStress: number | null;
  avgHr: number | null;
  avgRespiration: number | null;
  restingHr: number | null;
  hrvStatus: string | null;
  hrvAvg: number | null;
  bodyBatteryChange: number | null;
  sleepNeedMin: number | null;
  sleepScore: number | null;
}

interface DailyWellnessRow {
  dateKey: string;
  steps: number | null;
  stepsGoal: number | null;
  distanceM: number | null;
  floorsAsc: number | null;
  floorsDesc: number | null;
  activeCal: number | null;
  restingCal: number | null;
  totalCal: number | null;
  hrMin: number | null;
  hrMax: number | null;
  restingHr: number | null;
  moderateMin: number | null;
  vigorousMin: number | null;
  intensityGoal: number | null;
  stressAvg: number | null;
  stressMax: number | null;
  batteryMin: number | null;
  batteryMax: number | null;
  batteryLatest: number | null;
}

interface ConnectionRow {
  id: string;
  provider: string;
  providerUserId: string;
  status: string;
  lastSyncedAt: string | null;
}

function Card({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value ?? '—'}</div>
    </div>
  );
}

// ─── Gear page (/gear — provider-synced gear + wear-item components) ─────────

type GearUsageJson = { distanceM: number; durationS: number; count: number };

type GearComponentJson = {
  id: string;
  name: string;
  kind: string;
  installedAt: string | null;
  retiredAt: string | null;
  thresholdM: number | null;
  notes: string | null;
  usage: GearUsageJson;
};

type GearJson = {
  id: string;
  name: string;
  kind: string;
  provider: string | null;
  sourceGearId: string | null;
  firstUsedAt: string | null;
  retiredAt: string | null;
  usageType: string | null;
  thresholdM: number | null;
  usage: GearUsageJson;
  components: GearComponentJson[];
};

const COMPONENT_KINDS = [
  'CHAIN',
  'CASSETTE',
  'CHAINRING',
  'BRAKE_PADS',
  'TIRES',
  'TUBES',
  'PEDALS',
  'BATTERY',
  'OTHER',
] as const;

/** COMPONENT_KINDS enum → translated label; unknown kinds (provider values
 * like "SHOES") fall back to lowercased-with-spaces */
const KIND_KEY: Record<string, MsgKey> = {
  CHAIN: 'kind.chain',
  CASSETTE: 'kind.cassette',
  CHAINRING: 'kind.chainring',
  BRAKE_PADS: 'kind.brakePads',
  TIRES: 'kind.tires',
  TUBES: 'kind.tubes',
  PEDALS: 'kind.pedals',
  BATTERY: 'kind.battery',
  OTHER: 'kind.other',
};
function kindLabel(k: string): string {
  const key = KIND_KEY[k];
  return key ? t(key) : k.toLowerCase().replaceAll('_', ' ');
}

const km = (m: number): string =>
  `${(m / metersPerUnit()).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${unitLabel()}`;

function usageLine(u: GearUsageJson): string {
  const parts = [km(u.distanceM), `${(u.durationS / 3600).toFixed(1)} h`];
  return parts.join(' · ');
}

function GearSection(props: { token: string; onBack: () => void }) {
  const { token, onBack } = props;
  const [gear, setGear] = useState<GearJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // add-component form state, keyed by gear id
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('CHAIN');
  const [installedAt, setInstalledAt] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await api<{ items: GearJson[] }>('/gear', { token });
      setGear(res.items);
      setError(null);
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
      setGear(null);
    }
  }, [token]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function addComponent(gearId: string): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api(`/gear/${gearId}/components`, {
        method: 'POST',
        token,
        body: {
          name: name.trim(),
          kind,
          ...(installedAt ? { installedAt } : {}),
        },
      });
      setName('');
      setInstalledAt('');
      setAddingFor(null);
      await reload();
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  }

  async function retireComponent(id: string): Promise<void> {
    await api(`/gear/components/${id}`, {
      method: 'PATCH',
      token,
      body: { retiredAt: new Date().toISOString().slice(0, 10) },
    });
    await reload();
  }

  async function deleteComponent(id: string): Promise<void> {
    await api(`/gear/components/${id}`, { method: 'DELETE', token });
    await reload();
  }

  return (
    <section className="connections-page">
      <button type="button" className="btn ghost small" onClick={onBack}>
        {t('nav.backDashboard')}
      </button>
      <h2>{t('gear.heading')}</h2>
      <p className="muted">{t('gear.intro')}</p>
      {error && <p className="error">{error}</p>}
      {gear === null && !error && <p>{t('common.loading')}</p>}
      {gear?.length === 0 && <p className="muted">{t('gear.none')}</p>}
      {gear?.map((g) => (
        <article key={g.id} className="card gear-card">
          <header>
            <strong>{g.name}</strong>{' '}
            <span className={`pill ${g.retiredAt ? 'revoked' : 'active'}`}>
              {g.kind.toLowerCase()}
              {g.retiredAt ? ` · ${t('gear.retired')}` : ''}
            </span>
            {g.provider && <span className="pill">{g.provider.toLowerCase()}</span>}
          </header>
          <p className="muted">
            {usageLine(g.usage)}
            {g.thresholdM ? ` · ${t('gear.limit', { value: km(g.thresholdM) })}` : ''}
            {g.firstUsedAt ? ` · ${t('gear.firstUsed', { date: g.firstUsedAt.slice(0, 10) })}` : ''}
          </p>
          {g.components.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{t('gear.th.component')}</th>
                  <th>{t('gear.th.usage')}</th>
                  <th>{t('gear.th.window')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {g.components.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.name} <span className="muted">({kindLabel(c.kind)})</span>
                    </td>
                    <td>
                      {usageLine(c.usage)}
                      {c.thresholdM ? ` / ${km(c.thresholdM)}` : ''}
                    </td>
                    <td className="muted">
                      {c.installedAt
                        ? t('gear.since', { date: c.installedAt.slice(0, 10) })
                        : t('gear.noInstall')}
                      {c.retiredAt
                        ? ` ${t('gear.retiredAt', { date: c.retiredAt.slice(0, 10) })}`
                        : ''}
                    </td>
                    <td>
                      {!c.retiredAt && (
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => retireComponent(c.id)}
                        >
                          {t('gear.retire')}
                        </button>
                      )}{' '}
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => deleteComponent(c.id)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {addingFor === g.id ? (
            <div className="add-component">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('gear.placeholder')}
                autoFocus
              />
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {COMPONENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={installedAt}
                onChange={(e) => setInstalledAt(e.target.value)}
                title={t('gear.installDate')}
              />
              <button
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() => addComponent(g.id)}
              >
                {t('gear.add')}
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  setAddingFor(null);
                  setName('');
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button type="button" className="btn ghost small" onClick={() => setAddingFor(g.id)}>
              {t('gear.addComponent')}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}

// ─── Settings page (/settings — units, theme, export, delete) ────────────────

function SettingsSection(props: {
  token: string;
  unit: Unit;
  onUnitChange: (u: Unit) => void;
  theme: 'dark' | 'light';
  onThemeChange: (t: 'dark' | 'light') => void;
  lang: Lang;
  onLangChange: (l: Lang) => void;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const { token, unit, onUnitChange, theme, onThemeChange, lang, onLangChange, onDeleted, onBack } =
    props;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // two-step delete: the button only arms once the user types DELETE
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');

  useEffect(() => {
    let alive = true;
    api<MeResponse>('/me', { token })
      .then((m) => {
        if (alive) setMe(m);
      })
      .catch((err) => {
        if (alive) setError(String(err).replace(/^Error: /, ''));
      });
    return () => {
      alive = false;
    };
  }, [token]);

  /** optimistic UI first (localStorage + state), then persist to
   * user_preferences via PATCH /api/me — server is the durable copy */
  function changeUnit(u: Unit): void {
    onUnitChange(u);
    api('/me', { method: 'PATCH', token, body: { units: u } }).catch((err) =>
      setError(String(err).replace(/^Error: /, '')),
    );
  }
  function changeTheme(t: 'dark' | 'light'): void {
    onThemeChange(t);
    api('/me', { method: 'PATCH', token, body: { theme: t } }).catch((err) =>
      setError(String(err).replace(/^Error: /, '')),
    );
  }
  function changeLanguage(l: Lang): void {
    onLangChange(l);
    api('/me', { method: 'PATCH', token, body: { language: l } }).catch((err) =>
      setError(String(err).replace(/^Error: /, '')),
    );
  }

  async function exportData(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // raw fetch: the response is a download, not a JSON envelope
      const res = await fetch('/api/export', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`export failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ??
        'stridash-export.json';
      a.click();
      URL.revokeObjectURL(url);
      setNote(t('settings.exported'));
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/me', { method: 'DELETE', token });
      onDeleted(); // tokens are dead — back to the login screen
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
      setBusy(false);
    }
  }

  return (
    <section className="connections-page">
      <button type="button" className="btn ghost small" onClick={onBack}>
        {t('nav.backDashboard')}
      </button>
      <h2>{t('settings.heading')}</h2>
      {error && <p className="error">{error}</p>}
      {note && !error && <p className="muted">{note}</p>}

      <article className="card settings-card">
        <h3>{t('settings.account')}</h3>
        {!me && !error && <p className="muted">{t('common.loading')}</p>}
        {me && (
          <table>
            <tbody>
              <tr>
                <th>{t('settings.email')}</th>
                <td>{me.email}</td>
              </tr>
              <tr>
                <th>{t('settings.displayName')}</th>
                <td>{me.displayName}</td>
              </tr>
              <tr>
                <th>{t('settings.memberSince')}</th>
                <td>{me.createdAt.slice(0, 10)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </article>

      <article className="card settings-card">
        <h3>{t('settings.units')}</h3>
        <div className="setting-row">
          <button
            type="button"
            className={`btn small ${unit === 'km' ? '' : 'ghost'}`}
            onClick={() => changeUnit('km')}
          >
            {t('settings.kilometers')}
          </button>
          <button
            type="button"
            className={`btn small ${unit === 'mi' ? '' : 'ghost'}`}
            onClick={() => changeUnit('mi')}
          >
            {t('settings.miles')}
          </button>
          <span className="muted">{t('settings.saved')}</span>
        </div>
      </article>

      <article className="card settings-card">
        <h3>{t('settings.theme')}</h3>
        <div className="setting-row">
          <button
            type="button"
            className={`btn small ${theme === 'dark' ? '' : 'ghost'}`}
            onClick={() => changeTheme('dark')}
          >
            {t('settings.dark')}
          </button>
          <button
            type="button"
            className={`btn small ${theme === 'light' ? '' : 'ghost'}`}
            onClick={() => changeTheme('light')}
          >
            {t('settings.light')}
          </button>
          <span className="muted">{t('settings.saved')}</span>
        </div>
      </article>

      <article className="card settings-card">
        <h3>{t('settings.language')}</h3>
        <div className="setting-row">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`btn small ${lang === l.code ? '' : 'ghost'}`}
              onClick={() => changeLanguage(l.code)}
            >
              {l.name}
            </button>
          ))}
          <span className="muted">{t('settings.saved')}</span>
        </div>
      </article>

      <article className="card settings-card">
        <h3>{t('settings.export')}</h3>
        <p className="muted">{t('settings.exportDesc')}</p>
        <button type="button" className="btn" disabled={busy} onClick={() => void exportData()}>
          {busy ? t('settings.preparing') : t('settings.download')}
        </button>
      </article>

      <article className="card settings-card danger-zone">
        <h3>{t('settings.danger')}</h3>
        <p className="muted">{t('settings.dangerDesc')}</p>
        {!confirmDelete ? (
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              setConfirmDelete(true);
              setDeleteTyped('');
            }}
          >
            {t('settings.deleteAccount')}
          </button>
        ) : (
          <div className="setting-row">
            <input
              value={deleteTyped}
              onChange={(e) => setDeleteTyped(e.target.value)}
              placeholder={t('settings.typeDelete')}
            />
            <button
              type="button"
              className="btn danger"
              disabled={deleteTyped !== 'DELETE' || busy}
              onClick={() => void deleteAccount()}
            >
              {busy ? t('settings.deleting') : t('settings.deletePermanently')}
            </button>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setConfirmDelete(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
      </article>
    </section>
  );
}

// ─── Connections page (/connections — manage + create provider links) ────────

const PROVIDER_LABEL: Record<string, string> = {
  OMRON: 'Omron',
  IGPSPORT: 'iGPSPORT',
  GARMIN: 'Garmin',
  ZWIFT: 'Zwift',
};
type ProviderKey = 'omron' | 'igpsport' | 'garmin' | 'zwift';

type ConnectResponseJson = {
  mfaRequired?: boolean;
  method?: string;
  connection?: { id: string };
};

function ConnectionsSection(props: {
  conn: ConnectionRow[];
  token: string;
  syncingId: string | null;
  syncConnection: (id: string) => Promise<{ ok: boolean; text: string }>;
  reload: () => void;
  onBack: () => void;
}) {
  const { conn, token, syncingId, syncConnection, reload, onBack } = props;
  // add-connection form
  const [provider, setProvider] = useState<ProviderKey>('omron');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState('AR');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  // garmin second factor: the connect call answers 202 when the code step is due
  const [mfa, setMfa] = useState<{ id: string; method: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  // delete confirmation + per-card sync result lines (ok flag kept separately
  // so the "sync failed — " prefix re-translates on a language switch)
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  async function runSync(id: string): Promise<void> {
    const out = await syncConnection(id);
    setSyncMsg((m) => ({ ...m, [id]: { ok: out.ok, text: out.text } }));
  }

  async function del(id: string): Promise<void> {
    try {
      await api(`/connections/${id}`, { method: 'DELETE', token });
      setConfirmDel(null);
      reload();
    } catch (err) {
      setConnectMsg(String(err).replace(/^Error: /, ''));
    }
  }

  async function connect(): Promise<void> {
    setConnectBusy(true);
    setConnectMsg(null);
    try {
      const body =
        provider === 'omron'
          ? { provider: 'OMRON', identifier, password, country }
          : provider === 'igpsport'
            ? { provider: 'IGPSPORT', username: identifier, password, region: 'intl' }
            : provider === 'zwift'
              ? { provider: 'ZWIFT', username: identifier, password }
              : { provider: 'GARMIN', email: identifier, password };
      const res = await api<ConnectResponseJson>('/connections', { method: 'POST', body, token });
      if (res.mfaRequired) {
        setMfa({ id: res.connection?.id ?? '', method: res.method ?? 'code' });
        setConnectMsg(t('conn.mfaNeeded', { method: res.method ?? t('conn.trustedDevice') }));
        reload(); // the pending connection shows up in the list
        return;
      }
      setIdentifier('');
      setPassword('');
      setMfa(null);
      setConnectMsg(
        t('conn.connected', { provider: PROVIDER_LABEL[provider.toUpperCase()] ?? provider }),
      );
      reload();
    } catch (err) {
      setConnectMsg(String(err).replace(/^Error: /, ''));
    } finally {
      setConnectBusy(false);
    }
  }

  async function verifyMfa(): Promise<void> {
    if (!mfa) return;
    setConnectBusy(true);
    setConnectMsg(null);
    try {
      await api(`/connections/${mfa.id}/mfa`, { method: 'POST', body: { code: mfaCode }, token });
      setMfa(null);
      setMfaCode('');
      setConnectMsg(t('conn.connected', { provider: 'Garmin' }));
      reload();
    } catch (err) {
      setConnectMsg(String(err).replace(/^Error: /, ''));
    } finally {
      setConnectBusy(false);
    }
  }

  const identifierLabel =
    provider === 'omron'
      ? t('conn.identifierOmron')
      : provider === 'igpsport'
        ? t('conn.identifierIgpsport')
        : provider === 'zwift'
          ? t('conn.identifierZwift')
          : t('conn.identifierGarmin');

  return (
    <section className="connections-page">
      <button type="button" className="btn ghost small" onClick={onBack}>
        {t('nav.backDashboard')}
      </button>

      <h2>{t('conn.heading')}</h2>
      <p className="page-hint">{t('conn.hint')}</p>

      <div className="conn-list">
        {conn.map((c) => {
          const busy = syncingId === c.id;
          return (
            <div
              key={c.id}
              className={`conn-card ${c.status.toLowerCase()} ${busy ? 'syncing' : ''}`}
            >
              <div className="conn-head">
                <span className="conn-provider">{PROVIDER_LABEL[c.provider] ?? c.provider}</span>
                <span className="conn-status">{c.status.toLowerCase()}</span>
                {busy && (
                  <span className="conn-spin">
                    <span className="spin">↻</span> {t('conn.syncing')}
                  </span>
                )}
              </div>
              <div className="conn-sub">{c.providerUserId || '—'}</div>
              <div className="conn-sub">
                {t('conn.lastSync', {
                  date: c.lastSyncedAt ? fmtDate(c.lastSyncedAt) : t('conn.never'),
                })}
              </div>
              {(() => {
                const msg = syncMsg[c.id];
                return msg ? (
                  <p className={msg.ok ? 'conn-msg' : 'conn-msg err'}>
                    {msg.ok ? '' : t('conn.syncFailed')}
                    {msg.text}
                  </p>
                ) : null;
              })()}
              {c.status === 'ERROR' && <p className="conn-msg err">{t('conn.tokenRejected')}</p>}
              {c.status === 'REVOKED' && <p className="conn-msg err">{t('conn.revoked')}</p>}
              <div className="conn-actions">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => void runSync(c.id)}
                  disabled={syncingId != null || c.status === 'PENDING' || c.status === 'REVOKED'}
                  title={c.status === 'PENDING' ? t('conn.pendingTitle') : t('conn.syncTitle')}
                >
                  ↻ {t('conn.syncNow')}
                </button>
                <button
                  type="button"
                  className="btn ghost small danger"
                  onClick={() => setConfirmDel(confirmDel === c.id ? null : c.id)}
                  disabled={busy}
                >
                  {t('conn.delete')}
                </button>
              </div>
              {confirmDel === c.id && (
                <div className="conn-confirm">
                  <span>{t('conn.confirmDelete')}</span>
                  <button
                    type="button"
                    className="btn ghost small danger"
                    onClick={() => void del(c.id)}
                  >
                    {t('conn.yesDelete')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setConfirmDel(null)}
                  >
                    {t('conn.keep')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {conn.length === 0 && <p className="conn-sub">{t('conn.noLinks')}</p>}
      </div>

      <h2>{t('conn.addHeading')}</h2>
      <form
        className="conn-form"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as ProviderKey);
            setMfa(null);
            setConnectMsg(null);
          }}
        >
          <option value="omron">{t('conn.providerOmron')}</option>
          <option value="igpsport">{t('conn.providerIgpsport')}</option>
          <option value="garmin">{t('conn.providerGarmin')}</option>
          <option value="zwift">{t('conn.providerZwift')}</option>
        </select>
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder={identifierLabel}
          autoComplete="off"
          required
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('conn.password')}
          autoComplete="off"
          required
        />
        {provider === 'omron' && (
          <label className="conn-field-hint">
            {t('conn.countryHint')}
            <input
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
              placeholder="AR"
              size={4}
              maxLength={2}
              required
            />
          </label>
        )}
        <button className="btn" type="submit" disabled={connectBusy}>
          {connectBusy ? t('conn.connecting') : t('conn.connect')}
        </button>
        {mfa && (
          <div className="mfa-row">
            <label>
              {t('conn.mfaCode', { method: mfa.method })}
              <input
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                inputMode="numeric"
                placeholder="123456"
              />
            </label>
            <button
              className="btn"
              type="button"
              onClick={async () => {
                await verifyMfa();
              }}
              disabled={connectBusy || !mfaCode.trim()}
            >
              {t('conn.verify')}
            </button>
          </div>
        )}
        {connectMsg && (
          <p
            className={
              /failed|rejected|invalid|error/i.test(connectMsg) ? 'conn-msg err' : 'conn-msg'
            }
          >
            {connectMsg}
          </p>
        )}
      </form>
    </section>
  );
}

// ─── Calendar date picker (no deps — a small month-grid popover) ─────────────

// month + weekday names come from Intl in the active locale (DP_WEEKDAYS
// starts at a known Monday so the Monday-first column order holds everywhere)
const DP_MONDAY = new Date(Date.UTC(2024, 0, 1)); // 2024-01-01 was a Monday
const dpMonthFmtCache = new Map<string, Intl.DateTimeFormat>();
const dpWdFmtCache = new Map<string, Intl.DateTimeFormat>();

function dpMonthName(view: Date): string {
  const loc = getLocale();
  let f = dpMonthFmtCache.get(loc);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, { month: 'long', timeZone: 'UTC' });
    dpMonthFmtCache.set(loc, f);
  }
  return f.format(view);
}

function dpWeekdays(): string[] {
  const loc = getLocale();
  let f = dpWdFmtCache.get(loc);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' });
    dpWdFmtCache.set(loc, f);
  }
  return Array.from({ length: 7 }, (_, i) =>
    f!.format(new Date(DP_MONDAY.getTime() + i * 86_400_000)),
  );
}

/** Midnight-UTC of the 1st of the month containing `d` (day keys are UTC; the
 * server data + presets use toISOString().slice(0,10) everywhere). */
function dpMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function dpIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function DatePicker({
  value,
  onChange,
  placeholder,
  min,
  max,
}: {
  value: string; // YYYY-MM-DD, "" = unset
  onChange: (iso: string) => void;
  placeholder: string;
  /** inclusive bounds as YYYY-MM-DD; days outside are not clickable */
  min?: string;
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() =>
    dpMonthStart(value ? new Date(`${value}T00:00:00Z`) : new Date()),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  // click outside (or Escape) closes the popover
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (): void => {
    if (!open) setView(dpMonthStart(value ? new Date(`${value}T00:00:00Z`) : new Date()));
    setOpen(!open);
  };

  // 6×7 grid covering the viewed month (Monday-first, matching DP_WEEKDAYS)
  const firstWeekday = (view.getUTCDay() + 6) % 7; // Sun=0 → Mon=0
  const gridStart = new Date(view.getTime() - firstWeekday * 86_400_000);
  const cells: Date[] = Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getTime() + i * 86_400_000),
  );
  const todayIso = dpIso(new Date());

  return (
    <div className="dp" ref={rootRef}>
      <button
        type="button"
        className={`dp-btn ${open ? 'open' : ''}`}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className={`dp-value ${value ? '' : 'dp-empty'}`}>{value || placeholder}</span>
        <span className="dp-icon">📅</span>
      </button>
      {open && (
        <div className="dp-pop" role="dialog" aria-label={placeholder}>
          <div className="dp-head">
            <button
              type="button"
              className="dp-nav"
              onClick={() => setView(dpMonthStart(new Date(view.getTime() - 15 * 86_400_000)))}
              aria-label={t('dp.prevMonth')}
            >
              ‹
            </button>
            <span className="dp-month">
              {dpMonthName(view)} {view.getUTCFullYear()}
            </span>
            <button
              type="button"
              className="dp-nav"
              onClick={() => setView(dpMonthStart(new Date(view.getTime() + 31 * 86_400_000)))}
              aria-label={t('dp.nextMonth')}
            >
              ›
            </button>
          </div>
          <div className="dp-grid">
            {dpWeekdays().map((w) => (
              <span key={w} className="dp-wd">
                {w}
              </span>
            ))}
            {cells.map((d) => {
              const iso = dpIso(d);
              const outOfMonth = d.getUTCMonth() !== view.getUTCMonth();
              const disabled = (min !== undefined && iso < min) || (max !== undefined && iso > max);
              const cls = [
                'dp-day',
                outOfMonth ? 'dp-out' : '',
                iso === value ? 'sel' : '',
                iso === todayIso ? 'today' : '',
                disabled ? 'disabled' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={iso}
                  type="button"
                  className={cls}
                  disabled={disabled}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                >
                  {d.getUTCDate()}
                </button>
              );
            })}
          </div>
          <div className="dp-foot">
            <button
              type="button"
              className="dp-clear"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              disabled={value === ''}
            >
              {t('dp.clear')}
            </button>
            <button
              type="button"
              className="dp-clear"
              onClick={() => {
                onChange(todayIso);
                setOpen(false);
              }}
            >
              {t('dp.today')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const has = (v: unknown): boolean => v !== null && v !== undefined;
const asStr = (v: unknown, suffix = ''): string | null => (has(v) ? `${String(v)}${suffix}` : null);

// ⟵ body-composition chart channel descriptors (labels are i18n KEYS —
// translated at render time so a language switch re-renders them)
const BODY_METRIC: Record<
  'weightKg' | 'bodyFatPct' | 'visceralFatLevel' | 'skeletalMusclePct',
  { label: MsgKey; unit: string }
> = {
  weightKg: { label: 'metric.weight', unit: ' kg' },
  bodyFatPct: { label: 'metric.bodyFat', unit: '%' },
  visceralFatLevel: { label: 'metric.visceralLevel', unit: '' },
  skeletalMusclePct: { label: 'metric.skeletalMuscle', unit: '%' },
};

// ⟵ sleep + daily-metric chart channel descriptors
const SLEEP_METRIC: Record<
  'hours' | 'score' | 'hrv' | 'sleepHr' | 'battery',
  { fn: (s: SleepRow) => number | null; color: string; unit: string; label: MsgKey }
> = {
  hours: {
    fn: (s) => (s.totalSleepS !== null ? s.totalSleepS / 3600 : null),
    color: '#3b5bd6',
    unit: ' h',
    label: 'metric.sleepDuration',
  },
  score: { fn: (s) => s.sleepScore, color: '#9c6ade', unit: '', label: 'metric.sleepScore' },
  hrv: { fn: (s) => s.hrvAvg, color: '#d6409f', unit: ' ms', label: 'metric.overnightHrv' },
  sleepHr: { fn: (s) => s.avgHr, color: '#e5484d', unit: ' bpm', label: 'metric.avgSleepHr' },
  battery: {
    fn: (s) => s.bodyBatteryChange,
    color: '#30a46c',
    unit: '',
    label: 'metric.batteryChange',
  },
};

const DAILY_METRIC: Record<
  'steps' | 'restingHr' | 'stressAvg' | 'battery' | 'activeCal' | 'floors',
  { fn: (w: DailyWellnessRow) => number | null; color: string; unit: string; label: MsgKey }
> = {
  steps: { fn: (w) => w.steps, color: '#6e56cf', unit: '', label: 'metric.steps' },
  restingHr: {
    fn: (w) => w.restingHr,
    color: '#e5484d',
    unit: ' bpm',
    label: 'metric.restingHeartRate',
  },
  stressAvg: { fn: (w) => w.stressAvg, color: '#d29922', unit: '', label: 'metric.avgStress' },
  battery: {
    fn: (w) => w.batteryLatest,
    color: '#30a46c',
    unit: '',
    label: 'metric.batteryLatest',
  },
  activeCal: {
    fn: (w) => w.activeCal,
    color: '#d6409f',
    unit: ' kcal',
    label: 'metric.activeCalories',
  },
  floors: {
    fn: (w) => (w.floorsAsc !== null ? w.floorsAsc : null),
    color: '#0091ff',
    unit: '',
    label: 'metric.floorsAscended',
  },
};

// ─── URL state (every filter keeps the link shareable) ───────────────────────

type BodyMetricKey = 'weightKg' | 'bodyFatPct' | 'visceralFatLevel' | 'skeletalMusclePct';
type SleepMetricKey = 'hours' | 'score' | 'hrv' | 'sleepHr' | 'battery';
type DailyMetricKey = 'steps' | 'restingHr' | 'stressAvg' | 'battery' | 'activeCal' | 'floors';

/** Filters the page boots with — parsed once from ?from&to&body&sleep&daily.
 * Missing/invalid params fall back to the 7-day window + default metrics. */
const BOOT_URL = (() => {
  const q = new URLSearchParams(window.location.search);
  return {
    fromDate:
      isoDate(q.get('from')) ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
    toDate: isoDate(q.get('to')) ?? new Date().toISOString().slice(0, 10),
    body: keyOf(Object.keys(BODY_METRIC), q.get('body'), 'weightKg'),
    sleep: keyOf(Object.keys(SLEEP_METRIC), q.get('sleep'), 'hours'),
    daily: keyOf(Object.keys(DAILY_METRIC), q.get('daily'), 'steps'),
    feedType: pick(FEED_TYPES, q.get('type')),
    feedProv: pick(FEED_PROVIDERS, q.get('prov')),
  };
})();

// (Route type + parseRoute moved to lib/format.ts)

export default function App() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [sleep, setSleep] = useState<SleepRow[]>([]);
  const [wellness, setWellness] = useState<DailyWellnessRow[]>([]);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  // hamburger dropdown in the header (Providers Sync / Gear / Settings / Sign out)
  const [menuOpen, setMenuOpen] = useState(false);
  // settings-owned preferences; the module-level formatter unit + locale are
  // kept in sync BEFORE the re-render so every fmt* call speaks the chosen
  // unit/language. localStorage gives the instant boot value; the server
  // (user_preferences, one typed column per setting) wins once /me answers —
  // account > device.
  const [unit, setUnitState] = useState<Unit>(() => {
    const stored = localStorage.getItem('stridash.units') === 'mi' ? 'mi' : 'km';
    setUnit(stored);
    return stored;
  });
  const [theme, setThemeState] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('stridash.theme') === 'light' ? 'light' : 'dark',
  );
  // UI language — same boot pattern: localStorage value first (unknown codes
  // fall back to English), account adoption overrides once /me answers
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = localStorage.getItem('stridash.language') as Lang | null;
    const boot = LANGUAGES.some((l) => l.code === stored) ? stored! : 'en';
    setLang(boot);
    setLocale(localeOf(boot));
    return boot;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  // keep <html lang> honest for screen readers + translation tools
  useEffect(() => {
    document.documentElement.lang = localeOf(lang);
  }, [lang]);
  // adopt the account's stored preferences after login (runs once per token;
  // every change made in Settings also PATCHes the server, so they agree)
  useEffect(() => {
    if (!token) return;
    api<MeResponse>('/me', { token })
      .then((m) => {
        if (m.preferences?.units) {
          setUnit(m.preferences.units);
          localStorage.setItem('stridash.units', m.preferences.units);
          setUnitState(m.preferences.units);
        }
        if (m.preferences?.theme) {
          localStorage.setItem('stridash.theme', m.preferences.theme);
          setThemeState(m.preferences.theme);
        }
        if (m.preferences?.language && LANGUAGES.some((l) => l.code === m.preferences?.language)) {
          const l = m.preferences.language;
          setLang(l); // module-level dictionaries + Intl locale for fmt* calls
          setLocale(localeOf(l));
          localStorage.setItem('stridash.language', l);
          setLangState(l);
        }
      })
      .catch(() => undefined); // prefs are cosmetic — never block the dashboard
  }, [token]);
  const [bodyMetric, setBodyMetric] = useState<BodyMetricKey>(BOOT_URL.body);
  const [sleepMetric, setSleepMetric] = useState<SleepMetricKey>(BOOT_URL.sleep);
  const [dailyMetric, setDailyMetric] = useState<DailyMetricKey>(BOOT_URL.daily);
  // activities feed filters (type + provider) — deep-linked like the range
  const [feedType, setFeedType] = useState<string>(BOOT_URL.feedType);
  const [feedProv, setFeedProv] = useState<string>(BOOT_URL.feedProv);
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const load = useCallback(async (tok: string) => {
    setLoading(true);
    setError(null);
    try {
      // measurements newest-first already; charts want oldest-first
      const [conns, meas] = await Promise.all([
        api<{ items: ConnectionRow[] }>('/connections', { token: tok }),
        api<{ items: Measurement[] }>('/measurements', { token: tok, body: undefined }),
      ]);
      setConnections(conns.items);
      setMeasurements(meas.items);

      // activities paginate server-side (max 100/page, cursor) — pull all
      // pages so the feed and the stat card cover the full history
      const acts: Activity[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = await api<{ items: Activity[]; nextCursor: string | null }>('/activities', {
          token: tok,
          query: { limit: '100', ...(cursor ? { cursor } : {}) },
        });
        acts.push(...r.items);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      setActivities(acts);

      // sleep + daily wellness: newest-first pages of 200, walk back with
      // the `to` date filter (rows keyed by calendar date)
      const fetchDateKeyedAll = async <T extends { dateKey: string }>(
        path: string,
      ): Promise<T[]> => {
        const out: T[] = [];
        let to: string | undefined;
        for (let page = 0; page < 30; page++) {
          const r = await api<{ items: T[] }>(path, {
            token: tok,
            query: { limit: '200', ...(to ? { to } : {}) },
          });
          if (r.items.length === 0) break;
          const last = r.items[r.items.length - 1];
          if (!last) break;
          out.push(...r.items);
          const oldest = new Date(`${last.dateKey}T00:00:00.000Z`);
          to = new Date(oldest.getTime() - 86_400_000).toISOString().slice(0, 10);
        }
        return out.reverse(); // charts want oldest-first
      };
      const [sRows, wRows] = await Promise.all([
        fetchDateKeyedAll<SleepRow>('/sleeps'),
        fetchDateKeyedAll<DailyWellnessRow>('/wellness'),
      ]);
      setSleep(sRows);
      setWellness(wRows);
    } catch (e) {
      setError(String(e));
      if (String(e).includes('401') || String(e).includes('Unauthorized')) {
        clearTokens();
        setToken(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    onTokenChanged = setToken;
  }, [token, load]);
  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);
  // browser back/forward between the dashboard and activity pages
  useEffect(() => {
    const onPop = () => {
      setRoute(parseRoute(window.location.pathname));
      setMenuOpen(false); // hamburger closes on navigation of any kind
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // hamburger menu: any click outside of it closes it
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const wrap = document.querySelector('.menu-wrap');
      if (wrap && !wrap.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [menuOpen]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ accessToken: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      saveTokens(r.accessToken, r.refreshToken, rememberMe);
      setToken(r.accessToken);
    } catch (err) {
      setError(String(err));
    }
  }

  // hooks MUST run unconditionally: this is above the login early-return or
  // the hook order changes between renders ("more hooks than before" crash)
  // default window + metrics come from the URL (shareable filter links)
  const [fromDate, setFromDate] = useState<string>(BOOT_URL.fromDate);
  const [toDate, setToDate] = useState<string>(BOOT_URL.toDate);

  const range = useMemo(
    () => ({
      from: fromDate ? new Date(`${fromDate}T00:00:00.000Z`).getTime() : null,
      to: toDate ? new Date(`${toDate}T23:59:59.999Z`).getTime() : null,
    }),
    [fromDate, toDate],
  );

  /** true when a timestamp (ms or ISO string) falls inside [from, to]; empty
   * bounds mean "no limit on that side". */
  const inRange = useCallback(
    (ts: number | string | null | undefined): boolean => {
      if (ts === null || ts === undefined) return false;
      const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
      if (!Number.isFinite(t)) return false;
      return (range.from === null || t >= range.from) && (range.to === null || t <= range.to);
    },
    [range],
  );

  /** preset chips: exact-match highlight (from = today − days, to = today);
   * null = "all", undefined = custom dates don't map to a preset */
  const activePreset = useMemo((): number | null | undefined => {
    if (!fromDate && !toDate) return null; // "all"
    const today = new Date().toISOString().slice(0, 10);
    if (toDate !== today) return undefined; // custom range
    for (const d of [7, 30, 90, 365]) {
      if (fromDate === new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)) return d;
    }
    return undefined;
  }, [fromDate, toDate]);

  function applyPreset(days: number | null): void {
    if (days === null) {
      setFromDate('');
      setToDate('');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    setToDate(today);
    setFromDate(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
  }

  function openActivity(id: string): void {
    window.history.pushState(null, '', `/activity/${id}`);
    setRoute({ name: 'activity', id });
  }
  // the query string is rewritten by the filter-sync effect once we're back
  function goHome(): void {
    window.history.pushState(null, '', '/');
    setRoute({ name: 'dashboard' });
  }
  function openConnections(): void {
    window.history.pushState(null, '', '/connections');
    setRoute({ name: 'connections' });
    setMenuOpen(false);
  }
  function openGear(): void {
    window.history.pushState(null, '', '/gear');
    setRoute({ name: 'gear' });
    setMenuOpen(false);
  }
  function openSettings(): void {
    window.history.pushState(null, '', '/settings');
    setRoute({ name: 'settings' });
    setMenuOpen(false);
  }

  /** force-sync one connection; one at a time so a slow Garmin history scan
   * doesn't hammer providers in parallel. Returns what happened so the
   * connections page can show it on the card that was tapped. */
  async function syncConnection(id: string): Promise<{ ok: boolean; text: string }> {
    if (!token || syncingId) return { ok: false, text: t('conn.anotherSync') };
    setSyncingId(id);
    try {
      const res = await api<SyncResponseJson>(`/connections/${id}/sync`, { method: 'POST', token });
      // pull the fresh rows + lastSyncedAt into the dashboard
      await load(token);
      return { ok: true, text: summarizeSync(res) };
    } catch (err) {
      // rejected credentials flip the connection to ERROR server-side —
      // reload so the card/pill shows red instead of a stale ACTIVE state
      await load(token).catch(() => undefined);
      const msg = err instanceof Error ? err.message.replace(/^Error: /, '') : String(err);
      return { ok: false, text: msg };
    } finally {
      setSyncingId(null);
    }
  }

  // every filter change rewrites the query string, so copying the URL shares
  // the exact dashboard view (range + selected chart metrics + feed filters).
  // Skipped on the activity route so deep links to /activity/<id> keep their path.
  useEffect(() => {
    if (route.name !== 'dashboard') return;
    const q = new URLSearchParams();
    if (fromDate) q.set('from', fromDate);
    if (toDate) q.set('to', toDate);
    if (bodyMetric !== 'weightKg') q.set('body', bodyMetric);
    if (sleepMetric !== 'hours') q.set('sleep', sleepMetric);
    if (dailyMetric !== 'steps') q.set('daily', dailyMetric);
    if (feedType) q.set('type', feedType);
    if (feedProv) q.set('prov', feedProv);
    const s = q.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`,
    );
  }, [route, fromDate, toDate, bodyMetric, sleepMetric, dailyMetric, feedType, feedProv]);

  const weighIns = useMemo(
    () =>
      [...measurements].sort(
        (a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime(),
      ),
    [measurements],
  );

  // everything on the page is driven by the filtered arrays
  const weighInsIn = useMemo(
    () => weighIns.filter((m) => inRange(m.measuredAt)),
    [weighIns, inRange],
  );
  const sleepIn = useMemo(
    () => sleep.filter((s) => inRange(`${s.dateKey}T00:00:00.000Z`)),
    [sleep, inRange],
  );
  const wellnessIn = useMemo(
    () => wellness.filter((w) => inRange(`${w.dateKey}T00:00:00.000Z`)),
    [wellness, inRange],
  );
  const activitiesIn = useMemo(
    () => activities.filter((a) => inRange(a.startTime)),
    [activities, inRange],
  );
  // the feed's own filters (type / provider) sit on top of the range filter and
  // affect the table only — the stat card keeps counting the whole range
  const activitiesFeed = useMemo(
    () =>
      activitiesIn.filter(
        (a) =>
          (!feedType || a.type === feedType) &&
          (!feedProv || (a.providers ?? []).includes(feedProv)),
      ),
    [activitiesIn, feedType, feedProv],
  );
  // dropdowns only offer values that exist in the current range
  const feedTypeOptions = useMemo(
    () => FEED_TYPES.filter((t) => activitiesIn.some((a) => a.type === t)),
    [activitiesIn],
  );
  const feedProvOptions = useMemo(
    () => FEED_PROVIDERS.filter((p) => activitiesIn.some((a) => (a.providers ?? []).includes(p))),
    [activitiesIn],
  );
  const measurementsIn = useMemo(
    () => measurements.filter((m) => inRange(m.measuredAt)),
    [measurements, inRange],
  );

  // newest row in range for the headline cards (arrays are oldest-first)
  const latest = weighInsIn[weighInsIn.length - 1];
  const lastSleep = useMemo(
    () => [...sleepIn].reverse().find((s) => s.totalSleepS !== null),
    [sleepIn],
  );
  const lastWellness = useMemo(() => [...wellnessIn].reverse(), [wellnessIn]);
  const latestWellness = lastWellness.find((w) => w.steps !== null);
  const latestRestingHr = lastWellness.find((w) => w.restingHr !== null);

  if (!token) {
    return (
      <main className="login-page">
        <form onSubmit={login} className="login-card">
          <h1>🦾 Stridash</h1>
          <p>{t('auth.tagline')}</p>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder={t('auth.email')}
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder={t('auth.password')}
          />
          <label className="remember-me">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <span>{t('auth.remember')}</span>
          </label>
          <button className="btn" type="submit">
            {t('auth.signIn')}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  const signOut = () => {
    clearTokens();
    setToken(null);
    setMenuOpen(false);
  };

  const header = (
    <header>
      <a
        className="brand"
        href="/"
        title={t('nav.brandTitle')}
        onClick={(e) => {
          e.preventDefault();
          goHome();
        }}
      >
        <h1>🦾 Stridash</h1>
      </a>
      <div className="menu-wrap">
        <button
          type="button"
          className="hamburger"
          aria-label={t('nav.menu')}
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation(); // the outside-click listener would re-close it
            setMenuOpen((v) => !v);
          }}
        >
          ☰
        </button>
        {menuOpen && (
          <nav className="menu">
            <a
              href="/connections"
              onClick={(e) => {
                e.preventDefault();
                openConnections();
              }}
            >
              {t('nav.providers')}
            </a>
            <a
              href="/gear"
              onClick={(e) => {
                e.preventDefault();
                openGear();
              }}
            >
              {t('nav.gear')}
            </a>
            <a
              href="/settings"
              onClick={(e) => {
                e.preventDefault();
                openSettings();
              }}
            >
              {t('nav.settings')}
            </a>
            <button type="button" className="danger" onClick={signOut}>
              {t('nav.signOut')}
            </button>
          </nav>
        )}
      </div>
    </header>
  );
  const footer = <footer>{t('footer.line')}</footer>;

  // the activity page is its own URL: /activity/<id>, shareable like the filters
  if (route.name === 'activity') {
    return (
      <main>
        {header}
        <ActivityDetail
          id={route.id}
          token={token ?? ''}
          preview={activities.find((a) => a.id === route.id) ?? null}
          onBack={goHome}
        />
        {loading && <p>{t('common.loading')}</p>}
        {footer}
      </main>
    );
  }

  // the gear page is its own URL: /gear
  if (route.name === 'gear') {
    return (
      <main>
        {header}
        <GearSection token={token ?? ''} onBack={goHome} />
        {footer}
      </main>
    );
  }

  // the settings page is its own URL: /settings
  if (route.name === 'settings') {
    return (
      <main>
        {header}
        <SettingsSection
          token={token}
          unit={unit}
          onUnitChange={(u) => {
            setUnit(u); // formatters read this on the re-render
            localStorage.setItem('stridash.units', u);
            setUnitState(u);
          }}
          theme={theme}
          onThemeChange={(t) => {
            localStorage.setItem('stridash.theme', t);
            setThemeState(t);
          }}
          lang={lang}
          onLangChange={(l) => {
            setLang(l); // module-level dictionaries read this on the re-render
            setLocale(localeOf(l));
            localStorage.setItem('stridash.language', l);
            setLangState(l);
          }}
          onDeleted={() => {
            clearTokens();
            setToken(null);
          }}
          onBack={goHome}
        />
        {footer}
      </main>
    );
  }

  // the connections page is its own URL: /connections
  if (route.name === 'connections') {
    return (
      <main>
        {header}
        {error && <p className="error">{error}</p>}
        <ConnectionsSection
          conn={connections}
          token={token}
          syncingId={syncingId}
          syncConnection={syncConnection}
          reload={() => {
            void load(token);
          }}
          onBack={goHome}
        />
        {loading && <p>{t('common.loading')}</p>}
        {footer}
      </main>
    );
  }

  return (
    <main>
      {header}

      {error && <p className="error">{error}</p>}

      <div className="range-bar">
        <span className="range-label">{t('dash.range')}</span>
        {[7, 30, 90, 365].map((d) => (
          <button
            key={d}
            className={`btn ghost small ${activePreset === d ? 'active' : ''}`}
            onClick={() => applyPreset(d)}
          >
            {d === 365 ? '1y' : `${d}d`}
          </button>
        ))}
        <button
          className={`btn ghost small ${activePreset === null ? 'active' : ''}`}
          onClick={() => applyPreset(null)}
        >
          {t('dash.all')}
        </button>
        <DatePicker
          value={fromDate}
          onChange={setFromDate}
          placeholder={t('dash.fromDate')}
          max={toDate || undefined}
        />
        <span className="range-sep">→</span>
        <DatePicker
          value={toDate}
          onChange={setToDate}
          placeholder={t('dash.toDate')}
          min={fromDate || undefined}
        />
        {(fromDate || toDate) && (
          <button className="btn ghost small" onClick={() => applyPreset(null)}>
            {t('dash.clear')}
          </button>
        )}
      </div>

      <div className="cards">
        <Card
          label={t('dash.latestWeight')}
          value={asStr(latest?.weightKg, ' kg') ?? t('dash.noWeighIn')}
        />
        <Card label={t('dash.bodyFat')} value={asStr(latest?.bodyFatPct, '%')} />
        <Card label={t('dash.visceralFat')} value={asStr(latest?.visceralFatLevel)} />
        <Card label={t('dash.muscleMass')} value={asStr(latest?.skeletalMuscleMassKg, ' kg')} />
        <Card
          label={t('dash.latestSleep')}
          value={
            lastSleep ? (
              <>
                {((lastSleep.totalSleepS ?? 0) / 3600).toFixed(1)} h
                {lastSleep.sleepScore !== null
                  ? ` · ${t('dash.score')} ${lastSleep.sleepScore}`
                  : ''}
              </>
            ) : (
              t('dash.noSleep')
            )
          }
        />
        <Card
          label={t('dash.latestSteps')}
          value={latestWellness ? latestWellness.steps?.toLocaleString() : t('dash.noSteps')}
        />
        <Card
          label={t('dash.restingHr')}
          value={latestRestingHr?.restingHr != null ? `${latestRestingHr.restingHr} bpm` : '—'}
        />
        <Card label={t('dash.activities')} value={activitiesIn.length} />
        <Card label={t('dash.weighIns')} value={measurementsIn.length} />
      </div>

      <section>
        <h2>{t('dash.bodyComp')}</h2>
        <div className="metric-tabs">
          {(['weightKg', 'bodyFatPct', 'visceralFatLevel', 'skeletalMusclePct'] as const).map(
            (m) => (
              <button
                key={m}
                className={`btn ghost ${bodyMetric === m ? 'active' : ''}`}
                onClick={() => setBodyMetric(m)}
              >
                {t(BODY_METRIC[m].label)}
              </button>
            ),
          )}
        </div>
        <LineChart
          points={weighInsIn
            .filter((m) => has((m as unknown as Record<string, unknown>)[bodyMetric]))
            .map((m) => ({
              x: new Date(m.measuredAt).getTime(),
              y: Number((m as unknown as Record<string, unknown>)[bodyMetric]),
            }))}
          color="#6e56cf"
          label={t(BODY_METRIC[bodyMetric].label)}
          unit={BODY_METRIC[bodyMetric].unit}
        />
      </section>

      <section>
        <h2>{t('dash.sleep')}</h2>
        <div className="metric-tabs">
          {(
            [
              ['hours', 'tab.sleepDuration'],
              ['score', 'tab.sleepScore'],
              ['hrv', 'tab.nightHrv'],
              ['sleepHr', 'tab.sleepHr'],
              ['battery', 'tab.batteryChange'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={`btn ghost ${sleepMetric === m ? 'active' : ''}`}
              onClick={() => setSleepMetric(m)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <LineChart
          points={sleepIn
            .filter((s) => has(SLEEP_METRIC[sleepMetric].fn(s)))
            .map((s) => ({
              x: new Date(`${s.dateKey}T00:00:00.000Z`).getTime(),
              y: SLEEP_METRIC[sleepMetric].fn(s)!,
            }))}
          color={SLEEP_METRIC[sleepMetric].color}
          unit={SLEEP_METRIC[sleepMetric].unit}
          label={t(SLEEP_METRIC[sleepMetric].label)}
        />
      </section>

      <section>
        <h2>{t('dash.daily')}</h2>
        <div className="metric-tabs">
          {(
            [
              ['steps', 'tab.steps'],
              ['restingHr', 'tab.restingHrShort'],
              ['stressAvg', 'tab.stress'],
              ['battery', 'tab.bodyBattery'],
              ['activeCal', 'tab.activeKcal'],
              ['floors', 'tab.floors'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={`btn ghost ${dailyMetric === m ? 'active' : ''}`}
              onClick={() => setDailyMetric(m)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <LineChart
          points={wellnessIn
            .filter((w) => has(DAILY_METRIC[dailyMetric].fn(w)))
            .map((w) => ({
              x: new Date(`${w.dateKey}T00:00:00.000Z`).getTime(),
              y: DAILY_METRIC[dailyMetric].fn(w)!,
            }))}
          color={DAILY_METRIC[dailyMetric].color}
          unit={DAILY_METRIC[dailyMetric].unit}
          label={t(DAILY_METRIC[dailyMetric].label)}
        />
      </section>

      <section>
        <h2>{t('dash.activities')}</h2>
        <div className="feed-filters">
          <select
            value={feedType}
            onChange={(e) => setFeedType(e.target.value)}
            aria-label={t('dash.ariaType')}
          >
            <option value="">{t('dash.allTypes')}</option>
            {feedTypeOptions.map((ty) => (
              <option key={ty} value={ty}>
                {TYPE_EMOJI[ty] ?? '⌚'} {ty.toLowerCase().replace('_', ' ')}
              </option>
            ))}
          </select>
          <select
            value={feedProv}
            onChange={(e) => setFeedProv(e.target.value)}
            aria-label={t('dash.ariaProv')}
          >
            <option value="">{t('dash.allProviders')}</option>
            {feedProvOptions.map((p) => (
              <option key={p} value={p}>
                {p.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        {activitiesFeed.length === 0 && (
          <p className="empty">{activitiesIn.length ? t('dash.noMatch') : t('dash.noneInRange')}</p>
        )}
        <table className="list">
          <thead>
            <tr>
              <th></th>
              <th>{t('feed.when')}</th>
              <th>{t('feed.type')}</th>
              <th>{t('feed.provider')}</th>
              <th>{t('feed.workout')}</th>
              <th>{t('feed.distance')}</th>
              <th>{t('feed.time')}</th>
              <th>{t('feed.avgSpeed')}</th>
              <th>{t('feed.hr')}</th>
              <th>{t('feed.power')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {activitiesFeed.map((a) => (
              <tr key={a.id}>
                <td>{TYPE_EMOJI[a.type] ?? '⌚'}</td>
                <td>{fmtDate(a.startTime)}</td>
                <td>{a.type}</td>
                <td>{(a.providers ?? []).map((p) => p.toLowerCase()).join(', ')}</td>
                <td>{a.workoutName ?? '—'}</td>
                <td>{fmtKm(a.distanceM)}</td>
                <td>{fmtMin(a.durationS)}</td>
                <td>{fmtSpeed(a.avgSpeedMs)}</td>
                <td>{a.avgHr ?? '—'}</td>
                <td>
                  {a.avgPowerW ?? '—'}
                  {has(a.avgPowerW) ? ' W' : ''}
                </td>
                <td>
                  <a
                    href={`/activity/${a.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      openActivity(a.id);
                    }}
                  >
                    {t('feed.details')}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {loading && <p>{t('common.loading')}</p>}
      <footer>{t('footer.line')}</footer>
    </main>
  );
}
