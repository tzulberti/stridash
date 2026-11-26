import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { Activity, ChartChannelConfig, ChartProvider, Device } from '@stridash/types';
import { api } from '../lib/api';
import { t, type MsgKey } from '../lib/i18n/index';
import {
  TYPE_EMOJI,
  fmtDate,
  fmtDeltaSecs,
  fmtKm,
  fmtMin,
  fmtPace,
  fmtSpeed,
  fmtSplitTime,
  numDelta,
  pctDelta,
  teMessageHuman,
  unitLabel,
} from '../lib/format';
import {
  buildKmSplits,
  COMPARE_A,
  COMPARE_B,
  hrZoneThresholds,
  ZONE_COLORS,
  type KmSplit,
  type Point,
} from '../lib/chart';
import { orderedChannels, PROVIDER_CHANNELS, SERIES_CHANNELS } from '../lib/chart-config';
import { Card } from './Card';
import { CompareChart } from './CompareChart';
import { LineChart } from './LineChart';

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

const has = (v: unknown): boolean => v !== null && v !== undefined;
const asStr = (v: unknown, suffix = ''): string | null => (has(v) ? `${String(v)}${suffix}` : null);

export function ActivityDetail({
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
