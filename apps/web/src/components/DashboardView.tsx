import type { ReactNode } from 'react';
import type { Activity, Measurement } from '@stridash/types';
import { t, type MsgKey } from '../lib/i18n/index';
import {
  TYPE_EMOJI,
  fmtDate,
  fmtKm,
  fmtMin,
  fmtSpeed,
  metersPerUnit,
  unitLabel,
} from '../lib/format';
import { Card } from './Card';
import { DatePicker } from './DatePicker';
import { LineChart } from './LineChart';
import { ManualEntry } from './ManualEntry';
import type { ConnectionRow } from './ConnectionsSection';

export interface SleepRow {
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

export interface DailyWellnessRow {
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

export interface GearSummary {
  id: string;
  name: string;
  kind: string;
  thresholdM: number | null;
  retiredAt: string | null;
  usage: { distanceM: number; durationS: number; count: number };
}

// ⟵ body-composition chart channel descriptors (labels are i18n KEYS —
// translated at render time so a language switch re-renders them)
export const BODY_METRIC: Record<
  'weightKg' | 'bodyFatPct' | 'visceralFatLevel' | 'skeletalMusclePct',
  { label: MsgKey; unit: string }
> = {
  weightKg: { label: 'metric.weight', unit: ' kg' },
  bodyFatPct: { label: 'metric.bodyFat', unit: '%' },
  visceralFatLevel: { label: 'metric.visceralLevel', unit: '' },
  skeletalMusclePct: { label: 'metric.skeletalMuscle', unit: '%' },
};

// ⟵ sleep + daily-metric chart channel descriptors
export const SLEEP_METRIC: Record<
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

export const DAILY_METRIC: Record<
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

export type BodyMetricKey = 'weightKg' | 'bodyFatPct' | 'visceralFatLevel' | 'skeletalMusclePct';
export type SleepMetricKey = 'hours' | 'score' | 'hrv' | 'sleepHr' | 'battery';
export type DailyMetricKey =
  'steps' | 'restingHr' | 'stressAvg' | 'battery' | 'activeCal' | 'floors';

const has = (v: unknown): boolean => v !== null && v !== undefined;
const asStr = (v: unknown, suffix = ''): string | null => (has(v) ? `${String(v)}${suffix}` : null);

export function DashboardView(props: {
  header: ReactNode;
  token: string;
  onMeasurementSaved: () => void;
  error: string | null;
  activePreset: number | null | undefined;
  applyPreset: (d: number | null) => void;
  fromDate: string;
  setFromDate: (v: string) => void;
  toDate: string;
  setToDate: (v: string) => void;
  latest: Measurement | undefined;
  lastSleep: SleepRow | undefined;
  latestWellness: DailyWellnessRow | undefined;
  latestRestingHr: DailyWellnessRow | undefined;
  activitiesIn: Activity[];
  measurementsIn: Measurement[];
  bodyMetric: BodyMetricKey;
  setBodyMetric: (m: BodyMetricKey) => void;
  sleepMetric: SleepMetricKey;
  setSleepMetric: (m: SleepMetricKey) => void;
  dailyMetric: DailyMetricKey;
  setDailyMetric: (m: DailyMetricKey) => void;
  weighInsIn: Measurement[];
  sleepIn: SleepRow[];
  wellnessIn: DailyWellnessRow[];
  feedType: string;
  setFeedType: (v: string) => void;
  feedProv: string;
  setFeedProv: (v: string) => void;
  feedTypeOptions: string[];
  feedProvOptions: string[];
  activitiesFeed: Activity[];
  openActivity: (id: string) => void;
  loading: boolean;
  connections: ConnectionRow[];
  gear: GearSummary[];
}) {
  const {
    header,
    token,
    onMeasurementSaved,
    error,
    activePreset,
    applyPreset,
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    latest,
    lastSleep,
    latestWellness,
    latestRestingHr,
    activitiesIn,
    measurementsIn,
    bodyMetric,
    setBodyMetric,
    sleepMetric,
    setSleepMetric,
    dailyMetric,
    setDailyMetric,
    weighInsIn,
    sleepIn,
    wellnessIn,
    feedType,
    setFeedType,
    feedProv,
    setFeedProv,
    feedTypeOptions,
    feedProvOptions,
    activitiesFeed,
    openActivity,
    loading,
    connections,
    gear,
  } = props;

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

      <ManualEntry token={token} onSaved={onMeasurementSaved} />

      <section>
        <h2>{t('detail.trainingLoad')}</h2>
        <LineChart
          points={activitiesIn
            .filter((a) => a.trainingLoad != null)
            .map((a) => ({ x: new Date(a.startTime).getTime(), y: a.trainingLoad! }))}
          color="#d29922"
        />
      </section>

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
        <h2>{t('gear.heading')}</h2>
        {gear.length === 0 ? (
          <p className="muted">{t('gear.none')}</p>
        ) : (
          gear.map((g) => {
            const pct =
              g.thresholdM && g.thresholdM > 0
                ? Math.round((g.usage.distanceM / g.thresholdM) * 100)
                : null;
            return (
              <div key={g.id} className={`card gear-card ${g.retiredAt ? 'revoked' : ''}`}>
                <strong>{g.name}</strong> <span className="pill">{g.kind.toLowerCase()}</span>
                <p className="muted">
                  {Math.round(g.usage.distanceM / metersPerUnit()).toLocaleString()} {unitLabel()}
                  {pct !== null ? ` · ${t('gear.limit', { value: `${pct}%` })}` : ''}
                  {g.retiredAt ? ` · ${t('gear.retired')}` : ''}
                </p>
              </div>
            );
          })
        )}
      </section>

      <section>
        <h2>{t('conn.heading')}</h2>
        {connections.length === 0 ? (
          <p className="muted">{t('conn.noLinks')}</p>
        ) : (
          connections.map((c) => (
            <div key={c.id} className={`conn-card ${c.status.toLowerCase()}`}>
              <div className="conn-head">
                <span className="conn-provider">{c.provider.toLowerCase()}</span>
                <span className="conn-status">{c.status.toLowerCase()}</span>
              </div>
              <div className="conn-sub">
                {t('conn.lastSync', {
                  date: c.lastSyncedAt ? fmtDate(c.lastSyncedAt) : t('conn.never'),
                })}
              </div>
            </div>
          ))
        )}
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
        <div className="table-scroll">
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
        </div>
      </section>

      {loading && <p>{t('common.loading')}</p>}
      <footer>{t('footer.line')}</footer>
    </main>
  );
}
