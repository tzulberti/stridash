/**
 * One dashboard for every stride.
 *
 * Data policy mirrors the server: the dashboard NEVER talks to providers —
 * it only reads the local Stridash API. Login (JWT) → measurements +
 * activities list + one-activity drill-down with GPS/HR/power series.
 */

import { useEffect, useMemo, useState, useCallback, Fragment } from 'react';
import type {
  Measurement,
  Activity,
  MeResponse,
  Device,
  ChartChannelConfig,
  ChartProvider,
} from '@stridash/types';
import { clearTokens, readToken, saveTokens, storedRefreshToken } from './lib/token-storage';
import { summarizeSyncStatus, type SyncStatusJson } from './lib/sync-summary';
import { api, setTokenListener } from './lib/api';
import {
  buildKmSplits,
  COMPARE_A,
  COMPARE_B,
  hrZoneThresholds,
  ZONE_COLORS,
  type KmSplit,
  type Point,
} from './lib/chart';

// (fmtPace / fmtSplitTime moved to lib/format.ts)

// ─── Shared bits — pure display helpers live in lib/format.ts ────────────────

import { DatePicker } from './components/DatePicker';
import { LineChart } from './components/LineChart';
import { CompareChart } from './components/CompareChart';
import { SettingsSection } from './components/SettingsSection';
import { ConnectionsSection, type ConnectionRow } from './components/ConnectionsSection';
import { orderedChannels, PROVIDER_CHANNELS, SERIES_CHANNELS } from './lib/chart-config';
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
  fmtDeltaSecs,
  pctDelta,
  numDelta,
  teMessageHuman,
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

function ActivityDetail({
  id,
  token,
  preview,
  onBack,
  chartChannels,
}: {
  id: string;
  token: string;
  /** summary row known from the dashboard list — instant header on click; a
   * deep-linked URL has none and just starts with the fetch */
  preview: Activity | null;
  onBack: () => void;
  /** per-provider chart visibility/order from the user's Settings */
  chartChannels: Partial<Record<ChartProvider, ChartChannelConfig[]>>;
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

  // ─── Force re-sync from the owning provider ────────────────────────────────

  /** true when at least one delivering provider has a sync path (the server
   * still re-checks ownership/active status) */
  const canResync = (act?.providers ?? preview?.providers ?? []).some((p) =>
    ['GARMIN', 'ZWIFT', 'IGPSPORT'].includes(p),
  );
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const resyncActivity = useCallback(async (): Promise<void> => {
    if (resyncing) return;
    setResyncing(true);
    setResyncMsg(null);
    try {
      const r = await api<{ results: Array<{ provider: string; status: string; error?: string }> }>(
        `/activities/${id}/resync`,
        { method: 'POST', token },
      );
      const failed = r.results.filter((x) => x.status !== 'ok');
      if (failed.length) {
        setResyncMsg({
          ok: false,
          text: `${t('detail.resyncFail')}: ${failed
            .map((f) => `${f.provider}${f.error ? ` — ${f.error}` : ''}`)
            .join('; ')}`,
        });
      } else {
        setResyncMsg({
          ok: true,
          text: t('detail.resyncDone', { provider: r.results.map((x) => x.provider).join(', ') }),
        });
      }
      // rebuild the view from the freshly written row (scalars + series may
      // both have changed)
      const fresh = await api<{
        items: Array<Activity & { device?: Device | null; series: ActivitySeriesRow[] }>;
      }>(`/activities/${id}`, { token });
      const item = fresh.items[0];
      if (item) {
        setAct(item);
        setRows(item.series);
      }
    } catch (e) {
      setResyncMsg({ ok: false, text: String(e) });
    } finally {
      setResyncing(false);
    }
  }, [id, token, resyncing]);

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
    push('np', 'detail.np', act.normalizedPowerW, b.normalizedPowerW, watts, pctDelta);
    push(
      'sweat',
      'detail.sweat',
      act.sweatLossMl,
      b.sweatLossMl,
      (v) => `${Math.round(v)} mL`,
      pctDelta,
    );
    push(
      'aerobicTe',
      'detail.aerobicTe',
      act.aerobicTe,
      b.aerobicTe,
      (v) => v.toFixed(1),
      pctDelta,
    );
    push(
      'anaerobicTe',
      'detail.anaerobicTe',
      act.anaerobicTe,
      b.anaerobicTe,
      (v) => v.toFixed(1),
      pctDelta,
    );
    push('vo2max', 'detail.vo2max', act.vo2max, b.vo2max, (v) => v.toFixed(1), pctDelta);
    push(
      'recovery',
      'detail.recovery',
      act.recoveryMinutes,
      b.recoveryMinutes,
      (v) => `${(v / 60).toFixed(1)} h`,
      pctDelta,
    );
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
          unit: string;
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
    const charts: Array<{
      key: string;
      titleKey: MsgKey;
      pointsA: Point[];
      pointsB: Point[];
      unit: string;
    }> = [];
    for (const [key, titleKey, , unit] of orderedChannels(rows?.[0]?.provider, chartChannels)) {
      const va = (sa as Record<string, number[] | undefined>)[key];
      const vb = (sb as Record<string, number[] | undefined>)[key];
      if (!va || !vb || va.length < 2 || vb.length < 2) continue;
      charts.push({ key, titleKey, pointsA: pts(sa, va), pointsB: pts(sb, vb), unit });
    }
    return { xMode, charts };
  }, [rows, compareAct, chartChannels]);

  /** short identities for the compare tooltip lines; when both activities
   * share a headline (the same ride delivered by two providers) the name
   * alone can't tell them apart, so tag each with its series provider */
  const cmpNames = useMemo(() => {
    if (!compareAct) return null;
    const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
    const provA = rows?.[0]?.provider;
    const provB = compareAct.series?.[0]?.provider;
    const same = act?.headline === compareAct.headline;
    return {
      a: same
        ? `${trunc(act?.headline ?? '', 14)} (${provA ?? 'A'})`
        : trunc(act?.headline ?? '', 24),
      b: same
        ? `${trunc(compareAct.headline, 14)} (${provB ?? 'B'})`
        : trunc(compareAct.headline, 24),
      provA,
      provB,
      same,
    };
  }, [act, compareAct, rows]);

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
    for (const [key, titleKey, color, unit] of orderedChannels(
      rows?.[0]?.provider,
      chartChannels,
    )) {
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
  }, [rows, act, xAxis, chartChannels]);

  // provider-recordable channels this activity's series never carries —
  // surfaced under the charts so the missing sections explain themselves
  const missingChannels = (() => {
    if (compareId !== '' || rows === null) return [];
    const row = rows[0];
    if (!row) return [];
    const s = row.series;
    const capable = PROVIDER_CHANNELS[row.provider as ChartProvider];
    if (!s || !capable) return [];
    return capable
      .filter((key) => !(s as Record<string, number[] | undefined>)[key]?.length)
      .map((key) => SERIES_CHANNELS.find(([k]) => k === key)![1]);
  })();

  const hasDistance = (rows?.[0]?.series.distanceM?.length ?? 0) >= 2;

  // per-unit split table (needs a distance stream ≥ 1 unit)
  const splits = useMemo(() => {
    const s = rows?.[0]?.series;
    if (!s) return null;
    return buildKmSplits(s);
  }, [rows]);

  /** the compared activity's per-unit splits — same builder, same display
   * unit as the base activity's table */
  const compareSplits = useMemo(() => {
    const s = compareAct?.series?.[0]?.series;
    if (!s) return null;
    return buildKmSplits(s);
  }, [compareAct]);

  /** paired split rows: same unit index on both activities (1, 2, 3…, plus
   * the tail row only when both activities have one) */
  const compareSplitRows = useMemo(() => {
    if (!splits || !compareSplits) return [];
    const byKm = new Map(compareSplits.map((r) => [r.km, r]));
    return splits
      .filter((r) => byKm.has(r.km))
      .map((r) => ({ a: r, b: byKm.get(r.km) as KmSplit }));
  }, [splits, compareSplits]);

  /** compare-splits column groups: a metric shows up only when at least one
   * paired row has the value on BOTH sides — otherwise the A/B columns are
   * just dashes and the Δ column is noise */
  const compareSplitGroups = useMemo(() => {
    const paired = compareSplitRows;
    if (paired.length === 0) return [];
    const both = (pick: (r: KmSplit) => number | null): boolean =>
      paired.some(({ a, b }) => pick(a) != null && pick(b) != null);
    type Group = {
      key: string;
      labelKey: MsgKey;
      cell: (r: KmSplit) => string | null;
      delta: (a: KmSplit, b: KmSplit) => string | null;
    };
    const groups: Group[] = [];
    if (both((r) => r.paceSec))
      groups.push({
        key: 'pace',
        labelKey: 'split.pace',
        cell: (r) => fmtPace(r.paceSec),
        // signed seconds per unit — the tangible number for runners
        delta: (a, b) => fmtDeltaSecs(a.paceSec, b.paceSec),
      });
    if (both((r) => r.avgHr))
      groups.push({
        key: 'hr',
        labelKey: 'split.avgHr',
        cell: (r) => (r.avgHr != null ? `${Math.round(r.avgHr)} bpm` : null),
        delta: (a, b) => pctDelta(a.avgHr, b.avgHr),
      });
    if (both((r) => r.maxHr))
      groups.push({
        key: 'hrm',
        labelKey: 'split.maxHr',
        cell: (r) => (r.maxHr != null ? `${Math.round(r.maxHr)} bpm` : null),
        delta: (a, b) => pctDelta(a.maxHr, b.maxHr),
      });
    if (both((r) => r.avgPowerW))
      groups.push({
        key: 'pw',
        labelKey: 'split.power',
        cell: (r) => (r.avgPowerW != null ? `${Math.round(r.avgPowerW)} W` : null),
        delta: (a, b) => pctDelta(a.avgPowerW, b.avgPowerW),
      });
    if (both((r) => r.elevM))
      groups.push({
        key: 'el',
        labelKey: 'split.elev',
        cell: (r) => (r.elevM != null ? `${Math.round(r.elevM)} m` : null),
        // meters climbed — absolute steps, not percent
        delta: (a, b) => numDelta(a.elevM, b.elevM, ' m'),
      });
    return groups;
  }, [compareSplitRows]);

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
      {canResync ? (
        <div className="cmp-pick-row">
          <button
            type="button"
            className="btn ghost small"
            disabled={resyncing}
            onClick={() => void resyncActivity()}
          >
            {resyncing ? t('detail.resyncBusy') : t('detail.resync')}
          </button>
          {resyncMsg ? (
            <span className={resyncMsg.ok ? 'resync-msg' : 'resync-msg error'}>
              {resyncMsg.text}
            </span>
          ) : null}
        </div>
      ) : null}
      {compareId === '' ? (
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
      ) : null}
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
        {/* — physiology (Garmin-Computed; cards appear only when reported) — */}
        {act.sweatLossMl != null ? (
          <Card label={t('detail.sweat')} value={asStr(Math.round(act.sweatLossMl), ' mL')} />
        ) : null}
        {act.aerobicTe != null ? (
          <Card label={t('detail.aerobicTe')} value={act.aerobicTe.toFixed(1)} />
        ) : null}
        {act.anaerobicTe != null ? (
          <Card label={t('detail.anaerobicTe')} value={act.anaerobicTe.toFixed(1)} />
        ) : null}
        {teMessageHuman(act.aerobicTeMessage) ? (
          <Card label={t('detail.aerobicBenefit')} value={teMessageHuman(act.aerobicTeMessage)!} />
        ) : null}
        {teMessageHuman(act.anaerobicTeMessage) ? (
          <Card
            label={t('detail.anaerobicBenefit')}
            value={teMessageHuman(act.anaerobicTeMessage)!}
          />
        ) : null}
        {act.vo2max != null ? (
          <Card label={t('detail.vo2max')} value={act.vo2max.toFixed(1)} />
        ) : null}
        {act.recoveryMinutes != null ? (
          <Card label={t('detail.recovery')} value={`${(act.recoveryMinutes / 60).toFixed(1)} h`} />
        ) : null}
        {act.normalizedPowerW != null ? (
          <Card label={t('detail.np')} value={asStr(Math.round(act.normalizedPowerW), ' W')} />
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
          <div className="cmp-pick-row">
            <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
              <option value="">{t('compare.pick')}</option>
              {similar.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.headline} · {fmtDate(s.startTime)} ·{' '}
                  {s.distanceM != null ? fmtKm(s.distanceM) : fmtMin(s.durationS)}
                </option>
              ))}
            </select>
            {compareId ? (
              <button type="button" className="btn ghost small" onClick={() => setCompareId('')}>
                ✕ {t('compare.remove')}
              </button>
            ) : null}
          </div>
          {compareId && !compareAct ? <p>{t('detail.loading')}</p> : null}
          {compareAct ? (
            <>
              <div className="cmp-legend">
                <span className="cmp-item">
                  <span className="cmp-sw" style={{ background: COMPARE_A }} />
                  {act.headline} · {fmtDate(act.startTime)}
                  {cmpNames?.same && cmpNames.provA ? ` · ${cmpNames.provA}` : ''}
                </span>
                <span className="cmp-item">
                  <span className="cmp-sw" style={{ background: COMPARE_B }} />
                  {compareAct.headline} · {fmtDate(compareAct.startTime)}
                  {cmpNames?.same && cmpNames.provB ? ` · ${cmpNames.provB}` : ''}
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
              {compareSplitRows.length > 0 && compareSplitGroups.length > 0 ? (
                <>
                  <h4>{t('detail.splits', { unit: unitLabel() })}</h4>
                  <div className="table-scroll">
                    <table className="list">
                      <thead>
                        <tr>
                          <th rowSpan={2}>{unitLabel()}</th>
                          {compareSplitGroups.map((g) => (
                            <th key={g.key} colSpan={3}>
                              {t(g.labelKey)}
                            </th>
                          ))}
                        </tr>
                        <tr>
                          {compareSplitGroups.map((g) => (
                            <Fragment key={g.key}>
                              {/* column identities come from the legend
                                  swatches above, not text */}
                              <th
                                className="cmp-hsw"
                                title={t('compare.this')}
                                aria-label={t('compare.this')}
                              >
                                <span className="cmp-sw" style={{ background: COMPARE_A }} />
                              </th>
                              <th
                                className="cmp-hsw"
                                title={t('compare.other')}
                                aria-label={t('compare.other')}
                              >
                                <span className="cmp-sw" style={{ background: COMPARE_B }} />
                              </th>
                              <th>Δ</th>
                            </Fragment>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {compareSplitRows.map(({ a, b }) => (
                          <tr key={a.km}>
                            <td>{a.label}</td>
                            {compareSplitGroups.map((g) => (
                              <Fragment key={g.key}>
                                <td>{g.cell(a) ?? '—'}</td>
                                <td>{g.cell(b) ?? '—'}</td>
                                <td>{g.delta(a, b) ?? '—'}</td>
                              </Fragment>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
              {compareCharts.charts.map((c) => (
                <div key={c.key}>
                  <h4>{t(c.titleKey)}</h4>
                  <CompareChart
                    a={c.pointsA}
                    b={c.pointsB}
                    label={t(c.titleKey)}
                    unit={c.unit}
                    nameA={cmpNames?.a}
                    nameB={cmpNames?.b}
                    xMode={compareCharts.xMode}
                  />
                </div>
              ))}
            </>
          ) : null}
        </section>
      ) : null}

      {rows === null && !error ? <p>{t('detail.loadingSeries')}</p> : null}
      {/* while a comparison is active the overlaid charts above replace these
          single-activity ones — no duplicated heart-rate/speed walls */}
      {compareId === '' &&
        charts.map((c) => (
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
      {compareId === '' && rows !== null && charts.length === 0 && !error ? (
        <p className="empty">{t('detail.noSeries')}</p>
      ) : null}
      {compareId === '' && rows !== null && missingChannels.length > 0 ? (
        <p className="muted">
          {t('detail.noChannelData', { channels: missingChannels.join(', ') })}
        </p>
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
  // per-provider chart configuration — same boot pattern: localStorage first,
  // the account's stored copy wins once /me answers (empty = canonical order,
  // every channel visible)
  const [chartChannels, setChartChannelsState] = useState<
    Partial<Record<ChartProvider, ChartChannelConfig[]>>
  >(() => {
    try {
      const stored = localStorage.getItem('stridash.charts');
      return stored
        ? (JSON.parse(stored) as Partial<Record<ChartProvider, ChartChannelConfig[]>>)
        : {};
    } catch {
      return {};
    }
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
        if (m.preferences?.chartChannels) {
          localStorage.setItem('stridash.charts', JSON.stringify(m.preferences.chartChannels));
          setChartChannelsState(m.preferences.chartChannels);
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
    setTokenListener(setToken);
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
   * doesn't hammer providers in parallel. The server queues the job and
   * returns 202, so poll the sync history until the lock clears. */
  async function syncConnection(id: string): Promise<{ ok: boolean; text: string }> {
    if (!token || syncingId) return { ok: false, text: t('conn.anotherSync') };
    setSyncingId(id);
    const requestedAt = Date.now();
    try {
      const accepted = await api<{ syncStartedAt?: string | null }>(`/connections/${id}/sync`, {
        method: 'POST',
        token,
      });
      const serverStartedAt = accepted.syncStartedAt ? Date.parse(accepted.syncStartedAt) : NaN;
      const logBaseline = Number.isFinite(serverStartedAt) ? serverStartedAt : requestedAt;

      let status: SyncStatusJson | null = null;
      while (Date.now() - requestedAt < 15 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        status = await api<SyncStatusJson>(`/connections/${id}/syncs`, { token });
        if (!status.inProgress) break;
      }
      if (!status || status.inProgress) {
        await load(token).catch(() => undefined);
        return { ok: false, text: t('conn.syncTimeout') };
      }

      // pull the fresh rows + lastSyncedAt into the dashboard
      await load(token);
      return summarizeSyncStatus(status, logBaseline);
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
    // Revoke the refresh-token family server-side; the 15-minute access token
    // dies with the local copy. keepalive lets the request finish even if the
    // user navigates away immediately.
    const refreshToken = storedRefreshToken();
    if (refreshToken) {
      void fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        keepalive: true,
      }).catch(() => undefined);
    }
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
          chartChannels={chartChannels}
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
          chartChannels={chartChannels}
          onChartChannelsChange={(p, channels) => {
            const next = { ...chartChannels, [p]: channels };
            localStorage.setItem('stridash.charts', JSON.stringify(next));
            setChartChannelsState(next); // activity-page charts read this state
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
