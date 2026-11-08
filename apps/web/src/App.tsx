/**
 * One dashboard for every stride.
 *
 * Data policy mirrors the server: the dashboard NEVER talks to providers —
 * it only reads the local Stridash API. Login (JWT) → measurements +
 * activities list + one-activity drill-down with GPS/HR/power series.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import type {
  Measurement,
  Activity,
} from "@stridash/types";

// ─── API client ──────────────────────────────────────────────────────────────

const TOKEN_KEY = "stridash.accessToken";

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null; query?: Record<string, string> } = {},
): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const res = await fetch(`/api${path}${qs}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as T & { error?: string; detail?: unknown };
  if (!res.ok) {
    const detail = typeof json?.detail === "string" ? ` — ${json.detail}` : "";
    throw new Error(`${json?.error ?? res.statusText}${detail}`);
  }
  return json;
}

// ─── Small SVG chart (no chart deps — keeps bundle light and honest) ─────────

type Point = { x: number; y: number };

function LineChart({
  points,
  color,
  height = 200,
  label,
  unit,
}: {
  points: Point[];
  color: string;
  height?: number;
  label?: string;
  unit?: string;
}) {
  if (points.length < 2) return <div className="empty">not enough data</div>;
  const W = 900;
  const H = height;
  const pad = 24;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const spanX = Math.max(1e-9, x1 - x0);
  const spanY = Math.max(1e-9, y1 - y0);
  const toXY = (p: Point): [number, number] => [
    pad + ((p.x - x0) / spanX) * (W - 2 * pad),
    H - pad - ((p.y - y0) / spanY) * (H - 2 * pad),
  ];
  const path = points.map((p, i) => {
    const [x, y] = toXY(p);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const minY = 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
      <text x={pad} y={16} className="chart-max">{Number(y1.toFixed(1))}{unit}</text>
      <text x={pad} y={H - 6} className="chart-min">{Number(Math.max(minY, y0) === 0 ? y0.toFixed(1) : y0.toFixed(1))}{unit}</text>
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} />
      {points.length <= 200 && points.map((p, i) => {
        const [x, y] = toXY(p);
        return <circle key={i} cx={x} cy={y} r={PointsRadius(points.length)} fill={color} />;
      })}
    </svg>
  );
}

function PointsRadius(n: number): number {
  if (n > 80) return 1.5;
  if (n > 30) return 2.5;
  return 3.5;
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

// ─── Activity detail (drill-down) ────────────────────────────────────────────

interface ActivitySeriesPoint {
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

function ActivityDetail({
  activity,
  token,
  onBack,
}: {
  activity: Activity;
  token: string;
  onBack: () => void;
}) {
  const [series, setSeries] = useState<ActivitySeriesPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ items: Array<Activity & { series: ActivitySeriesPoint[] }> }>(
      `/activities/${activity.id}`,
      { token },
    )
      .then((r) => { if (alive) setSeries(r.items[0]?.series ?? []); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [activity.id, token]);

  const charts = useMemo(() => {
    const out: Array<{ title: string; color: string; points: Point[]; unit: string }> = [];
    const s = series?.[0]?.series ?? {};
    const ts = s.timeMs ?? [];
    if (ts.length < 2) return out;
    const push = (key: string, title: string, color: string, unit: string) => {
      const vals = (s as Record<string, number[] | undefined>)[key];
      if (!vals?.length) return;
      // series stores only the samples where a channel exists — align by index
      out.push({ title, color, points: vals.map((v, i) => ({ x: i, y: v })), unit });
    };
    push("hrBpm", "Heart rate", "#e5484d", "");
    push("powerW", "Power", "#6e56cf", " W");
    push("speedMs", "Speed (m/s)", "#30a46c", "");
    push("cadenceRpm", "Cadence", "#0091ff", "");
    push("altitudeM", "Altitude", "#b8860b", "");
    push("respirationRate", "Respiration (br/min)", "#d6409f", "");
    push("staminaPct", "Stamina (%)", "#d29922", " %");
    push("stepLengthM", "Step length (m)", "#80a9a0", " m");
    push("verticalOscillationM", "Vertical oscillation (m)", "#9c6ade", " m");
    push("stanceTimePct", "Ground contact (% of stride)", "#bf7f26", " %");
    push("verticalRatioPct", "Vertical ratio (%)", "#bf7f26", " %");
    return out;
  }, [series]);

  return (
    <div>
      <button className="btn" onClick={onBack}>← back</button>
      <h2>{TYPE_EMOJI[activity.type] ?? "⌚"} {activity.headline}</h2>
      <div className="cards">
        <Card label="Start" value={fmtDate(activity.startTime)} />
        <Card label="Distance" value={fmtKm(activity.distanceM)} />
        <Card label="Duration" value={fmtMin(activity.durationS)} />
        <Card label="Moving" value={fmtMin(activity.movingTimeS)} />
        <Card label="Avg / max HR" value={has(activity.avgHr) || has(activity.maxHr) ? `${activity.avgHr ?? "—"} / ${activity.maxHr ?? "—"} bpm` : "—"} />
        <Card label="Avg / max power" value={has(activity.avgPowerW) || has(activity.maxPowerW) ? `${activity.avgPowerW ?? "—"} / ${activity.maxPowerW ?? "—"} W` : "—"} />
        <Card label="Calories" value={asStr(activity.caloriesKcal, " kcal")} />
        {activity.indoor ? <Card label="Mode" value="indoor" /> : null}
      </div>
      {error && <p className="error">{error}</p>}
      {series === null ? <p>loading series…</p> : (
        charts.length
          ? charts.map((c) => (
            <section key={c.title}>
              <h3>{c.title}</h3>
              <LineChart points={c.points} color={c.color} label={c.title} unit={c.unit} />
            </section>
          ))
          : !error ? <p className="empty">No time series stored for this activity.</p> : null
      )}
    </div>
  );
}

// ─── Main dashboard ──────────────────────────────────────────────────────────

interface ConnectionRow {
  id: string;
  provider: string;
  providerUserId: string;
  status: string;
  lastSyncedAt: string | null;
}

function Card({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value ?? "—"}</div>
    </div>
  );
}

const has = (v: unknown): boolean => v !== null && v !== undefined;
const asStr = (v: unknown, suffix = ""): string | null =>
  has(v) ? `${String(v)}${suffix}` : null;

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [detail, setDetail] = useState<Activity | null>(null);
  const [bodyMetric, setBodyMetric] = useState<"weightKg" | "bodyFatPct" | "visceralFatLevel" | "skeletalMusclePct">("weightKg");
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
    } catch (e) {
      setError(String(e));
      if (String(e).includes("401") || String(e).includes("Unauthorized")) {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ accessToken: string; refreshToken?: string }>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      localStorage.setItem(TOKEN_KEY, r.accessToken);
      setToken(r.accessToken);
    } catch (err) {
      setError(String(err));
    }
  }

  if (!token) {
    return (
      <main className="login-page">
        <form onSubmit={login} className="login-card">
          <h1>🦾 Stridash</h1>
          <p>One dashboard for every stride.</p>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="password" />
          <button className="btn" type="submit">Sign in</button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  const weighIns = useMemo(() => [...measurements].sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime()), [measurements]);
  const latest = measurements[0];

  return (
    <main>
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
        <button className="btn ghost" onClick={() => { localStorage.removeItem(TOKEN_KEY); setToken(null); }}>sign out</button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="cards">
        <Card label="Latest weight" value={asStr(latest?.weightKg, " kg") ?? "no weigh-in yet"} />
        <Card label="Body fat" value={asStr(latest?.bodyFatPct, "%")} />
        <Card label="Visceral fat" value={asStr(latest?.visceralFatLevel)} />
        <Card label="Muscle mass" value={asStr(latest?.skeletalMuscleMassKg, " kg")} />
        <Card label="Activities" value={activities.length} />
        <Card label="Weigh-ins" value={measurements.length} />
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
              {m}
            </button>
          ))}
        </div>
        <LineChart
          points={weighIns
            .filter((m) => has((m as unknown as Record<string, unknown>)[bodyMetric]))
            .map((m) => ({ x: new Date(m.measuredAt).getTime(), y: Number((m as unknown as Record<string, unknown>)[bodyMetric]) }))}
          color="#6e56cf"
          label={bodyMetric}
        />
      </section>

      <section>
        <h2>Activities</h2>
        {activities.length === 0 && <p className="empty">No activities synced yet.</p>}
        <table className="list">
          <thead>
            <tr>
              <th></th><th>when</th><th>type</th><th>distance</th><th>time</th><th>avg speed</th><th>HR</th><th>power</th><th></th>
            </tr>
          </thead>
          <tbody>
            {activities.map((a) => (
              <tr key={a.id}>
                <td>{TYPE_EMOJI[a.type] ?? "⌚"}</td>
                <td>{fmtDate(a.startTime)}</td>
                <td>{a.type}</td>
                <td>{fmtKm(a.distanceM)}</td>
                <td>{fmtMin(a.durationS)}</td>
                <td>{fmtSpeed(a.avgSpeedMs)}</td>
                <td>{a.avgHr ?? "—"}</td>
                <td>{a.avgPowerW ?? "—"}{has(a.avgPowerW) ? " W" : ""}</td>
                <td><a href="#" onClick={(e) => { e.preventDefault(); setDetail(a); }}>details</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detail && (
        <section className="detail">
          <ActivityDetail activity={detail} token={token} onBack={() => setDetail(null)} />
        </section>
      )}

      {loading && <p>Loading…</p>}
      <footer>Stridash · all data read from your own Stridash instance</footer>
    </main>
  );
}
