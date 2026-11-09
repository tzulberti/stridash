/**
 * One dashboard for every stride.
 *
 * Data policy mirrors the server: the dashboard NEVER talks to providers —
 * it only reads the local Stridash API. Login (JWT) → measurements +
 * activities list + one-activity drill-down with GPS/HR/power series.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import type {
  Measurement,
  Activity,
} from "@stridash/types";

// ─── API client ──────────────────────────────────────────────────────────────

const TOKEN_KEY = "stridash.accessToken";
const REFRESH_KEY = "stridash.refreshToken";

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
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  opts: { method?: string; body?: unknown; token?: string | null; query?: Record<string, string> } = {},
): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const call = (tok: string | null | undefined) =>
    fetch(`/api${path}${qs}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  const res = await (opts.token ? call(opts.token) : call(readToken()));
  const json = (await res.json().catch(() => null)) as T & { error?: string; detail?: unknown };
  // A 401 mid-dashboard usually means the 15-minute access token ran out —
  // refresh once and replay before surfacing an error.
  if (res.status === 401 && !path.startsWith("/auth/") && (await tryRefresh())) {
    const retry = await call(readToken());
    const json2 = (await retry.json().catch(() => null)) as T & { error?: string; detail?: unknown };
    if (retry.ok) return json2;
    throw new Error(`${json2?.error ?? retry.statusText}`);
  }
  if (!res.ok) {
    const detail = typeof json?.detail === "string" ? ` — ${json.detail}` : "";
    throw new Error(`${json?.error ?? res.statusText}${detail}`);
  }
  return json;
}

// ─── Small SVG chart (no chart deps — keeps bundle light and honest) ─────────

type Point = { x: number; y: number };

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** elapsed since the activity start: 0:30 for sub-hour runs, 1:02:33 after */
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (v: number): string => String(v).padStart(2, "0");
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function fmtTick(ms: number, spanDays: number, x0: number): string {
  const d = new Date(ms);
  if (spanDays < 1.5) return fmtElapsed(ms - x0); // activity-length spans: elapsed since start
  if (spanDays >= 545) return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (spanDays >= 60) return `${MONTHS_SHORT[d.getUTCMonth()]} '${String(d.getUTCFullYear() % 100)}`;
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
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
const ZONE_COLORS = ["#9aa4b2", "#3e8ef7", "#30a46c", "#d29922", "#e5484d", "#e5484d", "#e5484d", "#e5484d"];

function LineChart({
  points,
  color,
  height = 200,
  label,
  unit,
  zoneThresholds,
  xMode = "time",
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
  xMode?: "time" | "distance";
}) {
  // hover index — declared before the early return so hook counts stay stable
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="empty">not enough data</div>;

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
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const spanX = Math.max(1e-9, x1 - x0);
  const spanY = Math.max(1e-9, y1 - y0);
  const spanDays = spanX / 86_400_000;
  const toXY = (p: Point): [number, number] => [
    padL + ((p.x - x0) / spanX) * plotW,
    padT + (1 - (p.y - y0) / spanY) * plotH,
  ];
  const path = points.map((p, i) => {
    const [x, y] = toXY(p);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const yTicks = niceTicks(y0, y1, 4);
  // distance mode ticks live in km space (nice numbers), plotted back in meters
  const isDist = xMode === "distance";
  const xTickCount = Math.max(2, Math.round(plotW / 170));
  const xTickMarks = isDist
    ? niceTicks(x0 / 1000, x1 / 1000, Math.max(3, Math.round(plotW / 160))).map((km) => ({ x: km * 1000, label: fmtVal(km) }))
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
  const zoneColor = (z: number): string => ZONE_COLORS[Math.min(z, ZONE_COLORS.length - 1)] ?? color;

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
          .map(([z, parts]) => ({ z, d: parts.join(" "), fill: zoneColor(z) }))
          .sort((p, q) => p.z - q.z);
      })()
    : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label} onMouseMove={svgMove} onMouseLeave={() => setHover(null)}>
      {/* horizontal grid + Y tick labels */}
      {yTicks.map((t) => {
        const y = padT + (1 - (t - y0) / spanY) * plotH;
        return (
          <g key={`y${t}`}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart-grid" />
            <text x={padL - 6} y={y + 3.5} textAnchor="end" className="chart-axis">{fmtVal(t)}</text>
          </g>
        );
      })}
      {/* X tick labels */}
      {xTickMarks.map((t) => (
        <text key={`x${t.x}`} x={padL + ((t.x - x0) / spanX) * plotW} y={H - padB + 16} textAnchor="middle" className="chart-axis">
          {t.label}
        </text>
      ))}
      {/* axis titles */}
      {label && (
        <text transform={`rotate(-90 13 ${padT + plotH / 2})`} x={13} y={padT + plotH / 2} textAnchor="middle" className="chart-axis-title">
          {label}
        </text>
      )}
      <text x={W - padR} y={H - 6} textAnchor="end" className="chart-axis-title">
        {isDist ? "distance (km)" : spanDays < 1.5 ? "elapsed" : "date"}
      </text>
      {zonePaths
        ? zonePaths.map((zp) => <path key={zp.z} d={zp.d} fill="none" stroke={zp.fill} strokeWidth={1.75} />)
        : <path d={path} fill="none" stroke={color} strokeWidth={1.75} />}
      {points.length <= 200 && points.map((p, i) => {
        const [x, y] = toXY(p);
        return <circle key={i} cx={x} cy={y} r={PointsRadius(points.length)} fill={zoneOf ? zoneColor(zoneOf(p.y)) : color} />;
      })}
      {/* hover: crosshair, highlighted point, tooltip with date + value */}
      {hp && (
        <g>
          <line x1={hx} x2={hx} y1={padT} y2={H - padB} className="chart-cross" />
          <circle cx={hx} cy={hy} r={PointsRadius(points.length) + 2.5} fill={zoneOf ? zoneColor(zoneOf(hp.y)) : color} stroke="#14171f" strokeWidth={1.5} />
          <g transform={`translate(${tipX},${tipY})`}>
            <rect width={tipW} height={tipH} rx={6} className="chart-tip" />
            <text x={8} y={14} className="chart-tip-date">{isDist ? fmtKm(hp.x) : spanDays < 1.5 ? fmtElapsed(hp.x - x0) : fmtDay(hp.x)}</text>
            <text x={8} y={28} className="chart-tip-val">{fmtVal(hp.y)}{unit}{zoneOf ? ` · Z${zoneOf(hp.y) + 1}` : ""}</text>
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

/** split table for one activity: one row per full km (plus the partial tail),
 * every column an in-window aggregate of a stored stream (Garmin-style laps) */
function buildKmSplits(s: KmSplitsSeries): KmSplit[] | null {
  const dist = s.distanceM;
  const ts = s.timeMs;
  if (!dist || !ts) return null;
  const n = Math.min(dist.length, ts.length);
  if (n < 2) return null;
  const base = dist[0] ?? 0;
  const total = (dist[n - 1] ?? 0) - base;
  if (total < 1000) return null;

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
  const fullKms = Math.floor(total / 1000);
  const push = (k: number, label: string, dStart: number, dEnd: number, i0: number, i1: number, headTimeS: number): void => {
    const distanceM = dEnd - dStart;
    const paceSec = distanceM > 0 ? headTimeS / (distanceM / 1000) : null;
    const bestSpeed = windowStat(s.speedMs, i0, i1, 0.01, "max");
    const voM = windowStat(s.verticalOscillationM, i0, i1, 0.001, "avg");
    rows.push({
      km: k,
      label,
      distanceM,
      timeS: headTimeS,
      paceSec,
      bestPaceSec: bestSpeed ? 1000 / bestSpeed : null,
      avgHr: windowStat(s.hrBpm, i0, i1, 30, "avg"),
      maxHr: windowStat(s.hrBpm, i0, i1, 30, "max"),
      avgCadence: windowStat(s.cadenceRpm, i0, i1, 1, "avg"),
      avgSpeedMs: windowStat(s.speedMs, i0, i1, 0, "avg"),
      avgPowerW: windowStat(s.powerW, i0, i1, 1, "avg"),
      avgStepM: windowStat(s.stepLengthM, i0, i1, 0.01, "avg"),
      avgVoCm: voM == null ? null : voM * 100,
      avgVertRatioPct: windowStat(s.verticalRatioPct, i0, i1, 0.1, "avg"),
      avgGctPct: windowStat(s.stanceTimePct, i0, i1, 1, "avg"),
      elevM: s.altitudeM ? windowElevGain(s.altitudeM, i0, i1) : null,
    });
  };
  for (let k = 1; k <= fullKms; k++) {
    const dStart = base + 1000 * (k - 1);
    const dEnd = base + 1000 * k;
    const i0 = kmBisect(dist, dStart);
    const i1 = Math.max(kmBisect(dist, dEnd), i0 + 1);
    // ts is in MILLISECONDS — convert to seconds for the table
    push(k, String(k), dStart, dEnd, i0, i1, Math.max(0, (timeAt(dEnd) - timeAt(dStart)) / 1000));
  }
  // a ≥50 m tail is worth a speed-up read of the finish line
  if (total - 1000 * fullKms >= 50) {
    const dStart = base + 1000 * fullKms;
    const i0 = kmBisect(dist, dStart);
    const dEnd = dist[n - 1] ?? dStart;
    push(-1, `last (${((dEnd - dStart) / 1000).toFixed(2)} km)`, dStart, dEnd, i0, n, Math.max(0, ((ts[n - 1] ?? 0) - timeAt(dStart)) / 1000));
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
  mode: "avg" | "max",
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
  return mode === "avg" ? sum / count : best;
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

function fmtPace(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const t = Math.round(sec);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, "0")} /km`;
}

function fmtSplitTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.round(s % 60);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function fmtKm(m: number | null | undefined): string {
  return m == null ? "—" : `${(m / 1000).toFixed(2)} km`;
}
function fmtMin(s: number | null | undefined): string {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtSpeed(ms: number | null | undefined): string {
  return ms == null ? "—" : `${((ms * 3600) / 1000).toFixed(1)} km/h`;
}
function fmtDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

const TYPE_EMOJI: Record<string, string> = {
  RUN: "🏃", RIDE: "🚴", VIRTUAL_RIDE: "🚴", WALK: "🚶",
  HIKE: "🥾", SWIM: "🏊", WORKOUT: "🏋️", OTHER: "⌚",
};

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
const SERIES_CHANNELS: Array<[string, string, string, string]> = [
  ["speedMs", "Speed", "#30a46c", " m/s"],
  ["hrBpm", "Heart rate", "#e5484d", " bpm"],
  ["powerW", "Power", "#6e56cf", " W"],
  ["cadenceRpm", "Cadence", "#0091ff", " rpm"],
  ["altitudeM", "Altitude", "#b8860b", " m"],
  ["respirationRate", "Respiration", "#d6409f", " br/min"],
  ["staminaPct", "Stamina", "#d29922", " %"],
  ["stepLengthM", "Step length", "#80a9a0", " m"],
  ["verticalOscillationM", "Vertical oscillation", "#9c6ade", " m"],
  ["stanceTimePct", "Ground contact %", "#bf7f26", " %"],
  ["verticalRatioPct", "Vertical ratio", "#bf7f26", " %"],
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
  const [act, setAct] = useState<Activity | null>(preview);
  const [rows, setRows] = useState<ActivitySeriesRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** shared X axis for the stream charts: elapsed time (default) or distance */
  const [xAxis, setXAxis] = useState<"time" | "distance">(() => new URLSearchParams(window.location.search).get("x") === "distance" ? "distance" : "time");

  // keep the choice in the URL so axis-shared activity links match the view
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (xAxis === "distance") q.set("x", "distance");
    else q.delete("x");
    const s = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
  }, [xAxis]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    setAct(preview);
    api<{ items: Array<Activity & { series: ActivitySeriesRow[] }> }>(
      `/activities/${id}`,
      { token },
    )
      .then((r) => {
        if (!alive) return;
        const item = r.items[0];
        if (!item) {
          setError("activity not found");
          return;
        }
        setAct(item);
        setRows(item.series);
      })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [id, token, preview]);

  // streams come back as labeled numeric arrays aligned with timeMs — plot
  // against the real sample clock so the axes show elapsed time; distance
  // mode plots them against the distance stream instead. The HR chart gets
  // zone coloring derived from the stored per-zone minutes
  const charts = useMemo(() => {
    const s = rows?.[0]?.series;
    const ts = s?.timeMs ?? [];
    if (!s || ts.length < 2) return [];
    const dist = s.distanceM ?? [];
    const byDistance = xAxis === "distance" && dist.length === ts.length;
    const out: Array<{ key: string; title: string; color: string; points: Point[]; unit: string; zones: number[] | null }> = [];
    for (const [key, title, color, unit] of SERIES_CHANNELS) {
      const vals = (s as Record<string, number[] | undefined>)[key];
      if (!vals?.length) continue;
      out.push({
        key,
        title,
        color,
        unit,
        zones: key === "hrBpm" ? hrZoneThresholds(vals, act?.hrZonesMin ?? null) : null,
        points: vals.map((v, i) => ({ x: byDistance && dist[i] !== undefined ? dist[i] : ts[i] ?? i, y: v })),
      });
    }
    return out;
  }, [rows, act, xAxis]);

  const hasDistance = (rows?.[0]?.series.distanceM?.length ?? 0) >= 2;

  // per-km split table (needs a distance stream ≥ 1 km)
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
      { key: "km", head: "km", cell: (r) => r.label },
      { key: "time", head: "time", cell: (r) => fmtSplitTime(r.timeS) },
    ];
    if (has((r) => r.bestPaceSec)) cols.push({ key: "bp", head: "best pace", cell: (r) => fmtPace(r.bestPaceSec) });
    if (has((r) => r.paceSec)) cols.push({ key: "pace", head: "pace", cell: (r) => fmtPace(r.paceSec) });
    if (has((r) => r.avgHr)) cols.push({ key: "hr", head: "avg HR", cell: (r) => (r.avgHr != null ? `${Math.round(r.avgHr)} bpm` : null) });
    if (has((r) => r.maxHr)) cols.push({ key: "hrm", head: "max HR", cell: (r) => (r.maxHr != null ? `${Math.round(r.maxHr)} bpm` : null) });
    if (has((r) => r.avgCadence)) cols.push({ key: "cad", head: "cadence", cell: (r) => (r.avgCadence != null ? `${Math.round(r.avgCadence)}` : null) });
    if (has((r) => r.avgSpeedMs)) cols.push({ key: "spd", head: "speed", cell: (r) => (r.avgSpeedMs != null ? `${(r.avgSpeedMs * 3.6).toFixed(1)} km/h` : null) });
    if (has((r) => r.avgPowerW)) cols.push({ key: "pw", head: "power", cell: (r) => (r.avgPowerW != null ? `${Math.round(r.avgPowerW)} W` : null) });
    if (has((r) => r.avgStepM)) cols.push({ key: "step", head: "step (m)", cell: (r) => (r.avgStepM != null ? r.avgStepM.toFixed(2) : null) });
    if (has((r) => r.avgVoCm)) cols.push({ key: "vo", head: "vert osc (cm)", cell: (r) => (r.avgVoCm != null ? r.avgVoCm.toFixed(1) : null) });
    if (has((r) => r.avgVertRatioPct)) cols.push({ key: "vr", head: "vert ratio (%)", cell: (r) => (r.avgVertRatioPct != null ? r.avgVertRatioPct.toFixed(1) : null) });
    if (has((r) => r.avgGctPct)) cols.push({ key: "gct", head: "GCT (%)", cell: (r) => (r.avgGctPct != null ? r.avgGctPct.toFixed(1) : null) });
    if (has((r) => r.elevM)) cols.push({ key: "el", head: "elev ▲", cell: (r) => (r.elevM != null ? `${Math.round(r.elevM)} m` : null) });
    return cols;
  }, [splits]);

  if (error) return <p className="error">{error}</p>;
  if (!act) return <p>loading…</p>;

  return (
    <div>
      <button className="btn" onClick={onBack}>← back to dashboard</button>
      <h2>{TYPE_EMOJI[act.type] ?? "⌚"} {act.headline}</h2>
      <div className="metric-tabs">
        <button className={`btn ghost ${xAxis === "time" ? "active" : ""}`} onClick={() => setXAxis("time")}>time</button>
        <button
          className={`btn ghost ${xAxis === "distance" ? "active" : ""}`}
          disabled={!hasDistance}
          onClick={() => setXAxis("distance")}
        >
          distance
        </button>
      </div>
      <div className="cards">
        <Card label="Start" value={fmtDate(act.startTime)} />
        <Card label="Distance" value={fmtKm(act.distanceM)} />
        <Card label="Duration" value={fmtMin(act.durationS)} />
        <Card label="Moving" value={fmtMin(act.movingTimeS)} />
        <Card label="Avg / max HR" value={has(act.avgHr) || has(act.maxHr) ? `${act.avgHr ?? "—"} / ${act.maxHr ?? "—"} bpm` : "—"} />
        <Card label="Avg / max power" value={has(act.avgPowerW) || has(act.maxPowerW) ? `${act.avgPowerW ?? "—"} / ${act.maxPowerW ?? "—"} W` : "—"} />
        <Card label="Avg / max speed" value={has(act.avgSpeedMs) || has(act.maxSpeedMs) ? `${fmtSpeed(act.avgSpeedMs)} / ${fmtSpeed(act.maxSpeedMs)}` : "—"} />
        <Card label="Avg / max cadence" value={has(act.avgCadence) || has(act.maxCadence) ? `${act.avgCadence ?? "—"} / ${act.maxCadence ?? "—"} rpm` : "—"} />
        <Card label="Ascent / descent" value={has(act.totalAscentM) || has(act.totalDescentM) ? `${act.totalAscentM ?? "—"} / ${act.totalDescentM ?? "—"} m` : "—"} />
        <Card label="Elev high / low" value={has(act.elevationHighM) || has(act.elevationLowM) ? `${act.elevationLowM ?? "—"} / ${act.elevationHighM ?? "—"} m` : "—"} />
        <Card label="Calories" value={asStr(act.caloriesKcal, " kcal")} />
        {act.trainingLoad != null ? <Card label="Training load" value={String(act.trainingLoad)} /> : null}
        {act.indoor ? <Card label="Mode" value="indoor" /> : null}
      </div>
      {error && <p className="error">{error}</p>}

      {splits && splitCols.length > 2 ? (
        <section>
          <h3>Per-kilometer splits</h3>
          <div className="table-scroll">
            <table className="list splits">
              <thead>
                <tr>{splitCols.map((c) => <th key={c.key}>{c.head}</th>)}</tr>
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

      {rows === null && !error ? <p>loading series…</p> : null}
      {charts.map((c) => (
        <section key={c.key}>
          <h3>{c.title}</h3>
          <LineChart points={c.points} color={c.color} label={c.title} unit={c.unit} zoneThresholds={c.zones} xMode={xAxis === "distance" && hasDistance ? "distance" : "time"} />
          {c.key === "hrBpm" && c.zones ? (
            <div className="zone-legend">
              {Array.from({ length: c.zones.length + 1 }, (_, i) => (
                <span key={i} className="zone-item">
                  <span className="zone-sw" style={{ background: ZONE_COLORS[Math.min(i, ZONE_COLORS.length - 1)] }} />
                  Z{i + 1}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ))}
      {rows !== null && charts.length === 0 && !error ? (
        <p className="empty">No time series stored for this activity.</p>
      ) : null}

      {act.hrZonesMin?.length ? (
        <section>
          <h3>Heart-rate zones</h3>
          <table className="list">
            <thead>
              <tr><th>zone</th><th>minutes</th></tr>
            </thead>
            <tbody>
              {act.hrZonesMin.map((min, i) => (
                <tr key={i}><td>{i + 1}</td><td>{min} min</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {act.notes ? <section><h3>Notes</h3><p>{act.notes}</p></section> : null}
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
      <div className="card-value">{value ?? "—"}</div>
    </div>
  );
}

// ─── Calendar date picker (no deps — a small month-grid popover) ─────────────

const DP_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DP_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

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
  const [view, setView] = useState<Date>(() => dpMonthStart(value ? new Date(`${value}T00:00:00Z`) : new Date()));
  const rootRef = useRef<HTMLDivElement>(null);

  // click outside (or Escape) closes the popover
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (): void => {
    if (!open) setView(dpMonthStart(value ? new Date(`${value}T00:00:00Z`) : new Date()));
    setOpen(!open);
  };

  // 6×7 grid covering the viewed month (Monday-first, matching DP_WEEKDAYS)
  const firstWeekday = (view.getUTCDay() + 6) % 7; // Sun=0 → Mon=0
  const gridStart = new Date(view.getTime() - firstWeekday * 86_400_000);
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getTime() + i * 86_400_000));
  const todayIso = dpIso(new Date());

  return (
    <div className="dp" ref={rootRef}>
      <button
        type="button"
        className={`dp-btn ${open ? "open" : ""}`}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className={`dp-value ${value ? "" : "dp-empty"}`}>{value || placeholder}</span>
        <span className="dp-icon">📅</span>
      </button>
      {open && (
        <div className="dp-pop" role="dialog" aria-label={placeholder}>
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => setView(dpMonthStart(new Date(view.getTime() - 15 * 86_400_000)))} aria-label="previous month">‹</button>
            <span className="dp-month">{DP_MONTHS[view.getUTCMonth()]} {view.getUTCFullYear()}</span>
            <button type="button" className="dp-nav" onClick={() => setView(dpMonthStart(new Date(view.getTime() + 31 * 86_400_000)))} aria-label="next month">›</button>
          </div>
          <div className="dp-grid">
            {DP_WEEKDAYS.map((w) => (
              <span key={w} className="dp-wd">{w}</span>
            ))}
            {cells.map((d) => {
              const iso = dpIso(d);
              const outOfMonth = d.getUTCMonth() !== view.getUTCMonth();
              const disabled = (min !== undefined && iso < min) || (max !== undefined && iso > max);
              const cls = [
                "dp-day",
                outOfMonth ? "dp-out" : "",
                iso === value ? "sel" : "",
                iso === todayIso ? "today" : "",
                disabled ? "disabled" : "",
              ].filter(Boolean).join(" ");
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
                onChange("");
                setOpen(false);
              }}
              disabled={value === ""}
            >
              clear
            </button>
            <button
              type="button"
              className="dp-clear"
              onClick={() => {
                onChange(todayIso);
                setOpen(false);
              }}
            >
              today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const has = (v: unknown): boolean => v !== null && v !== undefined;
const asStr = (v: unknown, suffix = ""): string | null =>
  has(v) ? `${String(v)}${suffix}` : null;

// ⟵ body-composition chart channel descriptors
const BODY_METRIC: Record<
  "weightKg" | "bodyFatPct" | "visceralFatLevel" | "skeletalMusclePct",
  { label: string; unit: string }
> = {
  weightKg: { label: "Weight", unit: " kg" },
  bodyFatPct: { label: "Body fat", unit: "%" },
  visceralFatLevel: { label: "Visceral fat level", unit: "" },
  skeletalMusclePct: { label: "Skeletal muscle", unit: "%" },
};

// ⟵ sleep + daily-metric chart channel descriptors
const SLEEP_METRIC: Record<
  "hours" | "score" | "hrv" | "sleepHr" | "battery",
  { fn: (s: SleepRow) => number | null; color: string; unit: string; label: string }
> = {
  hours: { fn: (s) => (s.totalSleepS !== null ? s.totalSleepS / 3600 : null), color: "#3b5bd6", unit: " h", label: "Sleep duration" },
  score: { fn: (s) => s.sleepScore, color: "#9c6ade", unit: "", label: "Sleep score" },
  hrv: { fn: (s) => s.hrvAvg, color: "#d6409f", unit: " ms", label: "Overnight HRV" },
  sleepHr: { fn: (s) => s.avgHr, color: "#e5484d", unit: " bpm", label: "Avg sleep HR" },
  battery: { fn: (s) => s.bodyBatteryChange, color: "#30a46c", unit: "", label: "Body battery change" },
};

const DAILY_METRIC: Record<
  "steps" | "restingHr" | "stressAvg" | "battery" | "activeCal" | "floors",
  { fn: (w: DailyWellnessRow) => number | null; color: string; unit: string; label: string }
> = {
  steps: { fn: (w) => w.steps, color: "#6e56cf", unit: "", label: "Steps" },
  restingHr: { fn: (w) => w.restingHr, color: "#e5484d", unit: " bpm", label: "Resting heart rate" },
  stressAvg: { fn: (w) => w.stressAvg, color: "#d29922", unit: "", label: "Average stress" },
  battery: { fn: (w) => w.batteryLatest, color: "#30a46c", unit: "", label: "Body battery (latest)" },
  activeCal: { fn: (w) => w.activeCal, color: "#d6409f", unit: " kcal", label: "Active calories" },
  floors: { fn: (w) => (w.floorsAsc !== null ? w.floorsAsc : null), color: "#0091ff", unit: "", label: "Floors ascended" },
};

// ─── URL state (every filter keeps the link shareable) ───────────────────────

type BodyMetricKey = "weightKg" | "bodyFatPct" | "visceralFatLevel" | "skeletalMusclePct";
type SleepMetricKey = "hours" | "score" | "hrv" | "sleepHr" | "battery";
type DailyMetricKey = "steps" | "restingHr" | "stressAvg" | "battery" | "activeCal" | "floors";

function keyOf<T extends string>(allowed: readonly string[], v: string | null, fallback: T): T {
  // T is anchored by `fallback`; `v` passes only when it's a known member
  return allowed.includes(v ?? "") ? (v as T) : fallback;
}

/** Filters the page boots with — parsed once from ?from&to&body&sleep&daily.
 * Missing/invalid params fall back to the 7-day window + default metrics. */
const BOOT_URL = (() => {
  const q = new URLSearchParams(window.location.search);
  const iso = (v: string | null): string | undefined => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  return {
    fromDate:
      iso(q.get("from")) ??
      new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
    toDate: iso(q.get("to")) ?? new Date().toISOString().slice(0, 10),
    body: keyOf(Object.keys(BODY_METRIC), q.get("body"), "weightKg"),
    sleep: keyOf(Object.keys(SLEEP_METRIC), q.get("sleep"), "hours"),
    daily: keyOf(Object.keys(DAILY_METRIC), q.get("daily"), "steps"),
  };
})();

// ─── Client routing — the activity page lives at /activity/<id> ──────────────

type Route = { name: "dashboard" } | { name: "activity"; id: string };

/** parse the current location; anything not /activity/<id> is the dashboard */
function parseRoute(): Route {
  const m = /^\/activity\/([^/?#]+)/.exec(window.location.pathname);
  const id = m?.[1];
  return id ? { name: "activity", id } : { name: "dashboard" };
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [sleep, setSleep] = useState<SleepRow[]>([]);
  const [wellness, setWellness] = useState<DailyWellnessRow[]>([]);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [bodyMetric, setBodyMetric] = useState<BodyMetricKey>(BOOT_URL.body);
  const [sleepMetric, setSleepMetric] = useState<SleepMetricKey>(BOOT_URL.sleep);
  const [dailyMetric, setDailyMetric] = useState<DailyMetricKey>(BOOT_URL.daily);
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (tok: string) => {
    setLoading(true);
    setError(null);
    try {
      // measurements newest-first already; charts want oldest-first
      const [conns, meas] = await Promise.all([
        api<{ items: ConnectionRow[] }>("/connections", { token: tok }),
        api<{ items: Measurement[] }>("/measurements", { token: tok, body: undefined }),
      ]);
      setConnections(conns.items);
      setMeasurements(meas.items);

      // activities paginate server-side (max 100/page, cursor) — pull all
      // pages so the feed and the stat card cover the full history
      const acts: Activity[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = await api<{ items: Activity[]; nextCursor: string | null }>("/activities", {
          token: tok,
          query: { limit: "100", ...(cursor ? { cursor } : {}) },
        });
        acts.push(...r.items);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      setActivities(acts);

      // sleep + daily wellness: newest-first pages of 200, walk back with
      // the `to` date filter (rows keyed by calendar date)
      const fetchDateKeyedAll = async <T extends { dateKey: string }>(path: string): Promise<T[]> => {
        const out: T[] = [];
        let to: string | undefined;
        for (let page = 0; page < 30; page++) {
          const r = await api<{ items: T[] }>(path, {
            token: tok,
            query: { limit: "200", ...(to ? { to } : {}) },
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
        fetchDateKeyedAll<SleepRow>("/sleeps"),
        fetchDateKeyedAll<DailyWellnessRow>("/wellness"),
      ]);
      setSleep(sRows);
      setWellness(wRows);
    } catch (e) {
      setError(String(e));
      if (String(e).includes("401") || String(e).includes("Unauthorized")) {
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
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ accessToken: string; refreshToken: string }>("/auth/login", {
        method: "POST",
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

  const range = useMemo(() => ({
    from: fromDate ? new Date(`${fromDate}T00:00:00.000Z`).getTime() : null,
    to: toDate ? new Date(`${toDate}T23:59:59.999Z`).getTime() : null,
  }), [fromDate, toDate]);

  /** true when a timestamp (ms or ISO string) falls inside [from, to]; empty
   * bounds mean "no limit on that side". */
  const inRange = useCallback((ts: number | string | null | undefined): boolean => {
    if (ts === null || ts === undefined) return false;
    const t = typeof ts === "number" ? ts : new Date(ts).getTime();
    if (!Number.isFinite(t)) return false;
    return (range.from === null || t >= range.from) && (range.to === null || t <= range.to);
  }, [range]);

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
      setFromDate("");
      setToDate("");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    setToDate(today);
    setFromDate(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
  }

  function openActivity(id: string): void {
    window.history.pushState(null, "", `/activity/${id}`);
    setRoute({ name: "activity", id });
  }
  // the query string is rewritten by the filter-sync effect once we're back
  function goHome(): void {
    window.history.pushState(null, "", "/");
    setRoute({ name: "dashboard" });
  }

  // every filter change rewrites the query string, so copying the URL shares
  // the exact dashboard view (range + selected chart metrics). Skipped on the
  // activity route so deep links to /activity/<id> keep their path.
  useEffect(() => {
    if (route.name !== "dashboard") return;
    const q = new URLSearchParams();
    if (fromDate) q.set("from", fromDate);
    if (toDate) q.set("to", toDate);
    if (bodyMetric !== "weightKg") q.set("body", bodyMetric);
    if (sleepMetric !== "hours") q.set("sleep", sleepMetric);
    if (dailyMetric !== "steps") q.set("daily", dailyMetric);
    const s = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${s ? `?${s}` : ""}${window.location.hash}`);
  }, [route, fromDate, toDate, bodyMetric, sleepMetric, dailyMetric]);

  const weighIns = useMemo(() => [...measurements].sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime()), [measurements]);

  // everything on the page is driven by the filtered arrays
  const weighInsIn = useMemo(() => weighIns.filter((m) => inRange(m.measuredAt)), [weighIns, inRange]);
  const sleepIn = useMemo(() => sleep.filter((s) => inRange(`${s.dateKey}T00:00:00.000Z`)), [sleep, inRange]);
  const wellnessIn = useMemo(() => wellness.filter((w) => inRange(`${w.dateKey}T00:00:00.000Z`)), [wellness, inRange]);
  const activitiesIn = useMemo(() => activities.filter((a) => inRange(a.startTime)), [activities, inRange]);
  const measurementsIn = useMemo(() => measurements.filter((m) => inRange(m.measuredAt)), [measurements, inRange]);

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
          <p>One dashboard for every stride.</p>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="password" />
          <label className="remember-me">
            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
            <span>remember me on this device</span>
          </label>
          <button className="btn" type="submit">Sign in</button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  const header = (
    <header>
      <h1>🦾 Stridash</h1>
      <div className="sources">
        {connections.map((c) => (
          <span key={c.id} className={`pill ${c.status.toLowerCase()}`}>
            {c.provider.toLowerCase()} · {c.status.toLowerCase()}{c.lastSyncedAt ? ` · ${fmtDate(c.lastSyncedAt)}` : ""}
          </span>
        ))}
        {connections.length === 0 && <span className="pill">no connections yet — connect a provider via the API/CLI</span>}
      </div>
      <button className="btn ghost" onClick={() => { clearTokens(); setToken(null); }}>sign out</button>
    </header>
  );
  const footer = <footer>Stridash · all data read from your own Stridash instance</footer>;

  // the activity page is its own URL: /activity/<id>, shareable like the filters
  if (route.name === "activity") {
    return (
      <main>
        {header}
        <ActivityDetail
          id={route.id}
          token={token ?? ""}
          preview={activities.find((a) => a.id === route.id) ?? null}
          onBack={goHome}
        />
        {loading && <p>Loading…</p>}
        {footer}
      </main>
    );
  }

  return (
    <main>
      {header}

      {error && <p className="error">{error}</p>}

      <div className="range-bar">
        <span className="range-label">range</span>
        {[7, 30, 90, 365].map((d) => (
          <button
            key={d}
            className={`btn ghost small ${activePreset === d ? "active" : ""}`}
            onClick={() => applyPreset(d)}
          >
            {d === 365 ? "1y" : `${d}d`}
          </button>
        ))}
        <button
          className={`btn ghost small ${activePreset === null ? "active" : ""}`}
          onClick={() => applyPreset(null)}
        >
          all
        </button>
        <DatePicker
          value={fromDate}
          onChange={setFromDate}
          placeholder="from date"
          max={toDate || undefined}
        />
        <span className="range-sep">→</span>
        <DatePicker
          value={toDate}
          onChange={setToDate}
          placeholder="to date"
          min={fromDate || undefined}
        />
        {(fromDate || toDate) && (
          <button className="btn ghost small" onClick={() => applyPreset(null)}>clear</button>
        )}
      </div>

      <div className="cards">
        <Card label="Latest weight" value={asStr(latest?.weightKg, " kg") ?? "no weigh-in yet"} />
        <Card label="Body fat" value={asStr(latest?.bodyFatPct, "%")} />
        <Card label="Visceral fat" value={asStr(latest?.visceralFatLevel)} />
        <Card label="Muscle mass" value={asStr(latest?.skeletalMuscleMassKg, " kg")} />
        <Card
          label="Latest sleep"
          value={
            lastSleep ? (
              <>
                {((lastSleep.totalSleepS ?? 0) / 3600).toFixed(1)} h
                {lastSleep.sleepScore !== null ? ` · score ${lastSleep.sleepScore}` : ""}
              </>
            ) : (
              "no sleep in range"
            )
          }
        />
        <Card
          label="Latest steps"
          value={latestWellness ? latestWellness.steps?.toLocaleString() : "no steps in range"}
        />
        <Card
          label="Resting HR"
          value={latestRestingHr?.restingHr != null ? `${latestRestingHr.restingHr} bpm` : "—"}
        />
        <Card label="Activities" value={activitiesIn.length} />
        <Card label="Weigh-ins" value={measurementsIn.length} />
      </div>

      <section>
        <h2>Body composition</h2>
        <div className="metric-tabs">
          {(["weightKg", "bodyFatPct", "visceralFatLevel", "skeletalMusclePct"] as const).map((m) => (
            <button
              key={m}
              className={`btn ghost ${bodyMetric === m ? "active" : ""}`}
              onClick={() => setBodyMetric(m)}
            >
              {BODY_METRIC[m].label}
            </button>
          ))}
        </div>
        <LineChart
          points={weighInsIn
            .filter((m) => has((m as unknown as Record<string, unknown>)[bodyMetric]))
            .map((m) => ({ x: new Date(m.measuredAt).getTime(), y: Number((m as unknown as Record<string, unknown>)[bodyMetric]) }))}
          color="#6e56cf"
          label={BODY_METRIC[bodyMetric].label}
          unit={BODY_METRIC[bodyMetric].unit}
        />
      </section>

      <section>
        <h2>Sleep</h2>
        <div className="metric-tabs">
          {(
            [
              ["hours", "Duration (h)"],
              ["score", "Score"],
              ["hrv", "Night HRV"],
              ["sleepHr", "Sleep HR"],
              ["battery", "Battery change"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={`btn ghost ${sleepMetric === m ? "active" : ""}`}
              onClick={() => setSleepMetric(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <LineChart
          points={sleepIn
            .filter((s) => has(SLEEP_METRIC[sleepMetric].fn(s)))
            .map((s) => ({ x: new Date(`${s.dateKey}T00:00:00.000Z`).getTime(), y: SLEEP_METRIC[sleepMetric].fn(s)! }))}
          color={SLEEP_METRIC[sleepMetric].color}
          unit={SLEEP_METRIC[sleepMetric].unit}
          label={SLEEP_METRIC[sleepMetric].label}
        />
      </section>

      <section>
        <h2>Daily metrics</h2>
        <div className="metric-tabs">
          {(
            [
              ["steps", "Steps"],
              ["restingHr", "Resting HR"],
              ["stressAvg", "Stress (avg)"],
              ["battery", "Body battery"],
              ["activeCal", "Active kcal"],
              ["floors", "Floors"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={`btn ghost ${dailyMetric === m ? "active" : ""}`}
              onClick={() => setDailyMetric(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <LineChart
          points={wellnessIn
            .filter((w) => has(DAILY_METRIC[dailyMetric].fn(w)))
            .map((w) => ({ x: new Date(`${w.dateKey}T00:00:00.000Z`).getTime(), y: DAILY_METRIC[dailyMetric].fn(w)! }))}
          color={DAILY_METRIC[dailyMetric].color}
          unit={DAILY_METRIC[dailyMetric].unit}
          label={DAILY_METRIC[dailyMetric].label}
        />
      </section>

      <section>
        <h2>Activities</h2>
        {activitiesIn.length === 0 && <p className="empty">No activities in range.</p>}
        <table className="list">
          <thead>
            <tr>
              <th></th><th>when</th><th>type</th><th>distance</th><th>time</th><th>avg speed</th><th>HR</th><th>power</th><th></th>
            </tr>
          </thead>
          <tbody>
            {activitiesIn.map((a) => (
              <tr key={a.id}>
                <td>{TYPE_EMOJI[a.type] ?? "⌚"}</td>
                <td>{fmtDate(a.startTime)}</td>
                <td>{a.type}</td>
                <td>{fmtKm(a.distanceM)}</td>
                <td>{fmtMin(a.durationS)}</td>
                <td>{fmtSpeed(a.avgSpeedMs)}</td>
                <td>{a.avgHr ?? "—"}</td>
                <td>{a.avgPowerW ?? "—"}{has(a.avgPowerW) ? " W" : ""}</td>
                <td><a href={`/activity/${a.id}`} onClick={(e) => { e.preventDefault(); openActivity(a.id); }}>details</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {loading && <p>Loading…</p>}
      <footer>Stridash · all data read from your own Stridash instance</footer>
    </main>
  );
}
