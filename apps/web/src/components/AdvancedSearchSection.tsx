import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Activity, ActivityType } from '@stridash/types';
import { api } from '../lib/api';
import {
  FEED_TYPES,
  TYPE_EMOJI,
  fmtDate,
  fmtKm,
  fmtMin,
  fmtSpeed,
  metersPerUnit,
  unitLabel,
} from '../lib/format';
import { t } from '../lib/i18n/index';
import { DatePicker } from './DatePicker';

interface GearOption {
  id: string;
  name: string;
}

const FILTERS = ['date', 'types', 'gear', 'distance'] as const;
type FilterId = (typeof FILTERS)[number];

interface SearchFilters {
  from: string;
  to: string;
  types: ActivityType[];
  gearId: string;
  minDistance: string;
  maxDistance: string;
}

interface SearchState {
  filters: SearchFilters;
  active: FilterId[];
}

const EMPTY: SearchFilters = {
  from: '',
  to: '',
  types: [],
  gearId: '',
  minDistance: '',
  maxDistance: '',
};

const isFilter = (v: string): v is FilterId => (FILTERS as readonly string[]).includes(v);
const isType = (v: string): v is ActivityType => (FEED_TYPES as readonly string[]).includes(v);

function typeLabel(ty: ActivityType): string {
  return ty.toLowerCase().replaceAll('_', ' ');
}

function parseDistance(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function distanceError(filters: SearchFilters): string | null {
  const min = parseDistance(filters.minDistance);
  const max = parseDistance(filters.maxDistance);
  if (filters.minDistance.trim() && min === null) return t('search.invalidDistance');
  if (filters.maxDistance.trim() && max === null) return t('search.invalidDistance');
  if (min !== null && max !== null && min > max) return t('search.invalidDistance');
  return null;
}

function metersParam(value: string): string | null {
  const n = parseDistance(value);
  return n === null ? null : String(Math.round(n * metersPerUnit()));
}

function readState(): SearchState {
  const q = new URLSearchParams(window.location.search);
  const types = (q.get('types') ?? '').split(',').filter(isType);
  const toDisplay = (meters: string | null): string => {
    if (!meters) return '';
    const n = Number(meters);
    return Number.isFinite(n) ? String(Number((n / metersPerUnit()).toFixed(2))) : '';
  };
  const show = q.get('show');
  const active = show === null ? [...FILTERS] : show.split(',').filter(isFilter);
  return {
    filters: {
      from: q.get('from') ?? '',
      to: q.get('to') ?? '',
      types,
      gearId: q.get('gearId') ?? '',
      minDistance: toDisplay(q.get('dminM')),
      maxDistance: toDisplay(q.get('dmaxM')),
    },
    active: active.length ? active : show === null ? [...FILTERS] : [],
  };
}

function queryOf(filters: SearchFilters): Record<string, string> {
  const query: Record<string, string> = { limit: '100' };
  if (filters.from) query.from = `${filters.from}T00:00:00.000Z`;
  if (filters.to) query.to = `${filters.to}T23:59:59.999Z`;
  if (filters.types.length) query.types = filters.types.join(',');
  if (filters.gearId) query.gearId = filters.gearId;
  const min = metersParam(filters.minDistance);
  const max = metersParam(filters.maxDistance);
  if (min !== null) query.distanceMinM = min;
  if (max !== null) query.distanceMaxM = max;
  return query;
}

function syncUrl(filters: SearchFilters, active: FilterId[]): void {
  const q = new URLSearchParams();
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  if (filters.types.length) q.set('types', filters.types.join(','));
  if (filters.gearId) q.set('gearId', filters.gearId);
  const min = metersParam(filters.minDistance);
  const max = metersParam(filters.maxDistance);
  if (min !== null) q.set('dminM', min);
  if (max !== null) q.set('dmaxM', max);
  if (active.length !== FILTERS.length) q.set('show', active.join(','));
  const s = q.toString();
  window.history.replaceState(null, '', `/search${s ? `?${s}` : ''}`);
}

const FILTER_LABEL: Record<FilterId, () => string> = {
  date: () => t('search.date'),
  types: () => t('feed.type'),
  gear: () => t('nav.gear'),
  distance: () => t('feed.distance'),
};

function FilterRow(props: { id: FilterId; onRemove: (id: FilterId) => void; children: ReactNode }) {
  const label = FILTER_LABEL[props.id]();
  return (
    <div className="filter-row">
      <div className="filter-row-head">
        <strong>{label}</strong>
        <button
          type="button"
          className="btn ghost small filter-remove"
          aria-label={`${t('search.removeFilter')} ${label}`}
          title={t('search.removeFilter')}
          onClick={() => props.onRemove(props.id)}
        >
          ×
        </button>
      </div>
      <div className="filter-row-body">{props.children}</div>
    </div>
  );
}

export function AdvancedSearchSection(props: {
  token: string;
  gear: GearOption[];
  openActivity: (id: string) => void;
  onBack: () => void;
}) {
  const { token, gear, openActivity, onBack } = props;
  const [initial] = useState(readState);
  const [filters, setFilters] = useState<SearchFilters>(initial.filters);
  const [active, setActive] = useState<FilterId[]>(initial.active);
  const [addFilter, setAddFilter] = useState<FilterId | ''>('');
  const [applied, setApplied] = useState<SearchFilters | null>(null);
  const [items, setItems] = useState<Activity[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const invalidDistance = distanceError(filters);
  const available = useMemo(() => FILTERS.filter((f) => !active.includes(f)), [active]);
  const countLabel = useMemo(
    () =>
      nextCursor
        ? t('search.resultCountMore', { n: items.length })
        : t('search.resultCount', { n: items.length }),
    [items.length, nextCursor],
  );

  const execute = useCallback(
    async (
      next: SearchFilters,
      cursor: string | null,
      activeFilters: FilterId[],
      updateUrl: boolean,
    ): Promise<void> => {
      if (distanceError(next)) {
        setError(distanceError(next));
        return;
      }
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api<{ items: Activity[]; nextCursor: string | null }>('/activities', {
          token,
          query: cursor ? { ...queryOf(next), cursor } : queryOf(next),
        });
        if (seq !== requestSeq.current) return;
        setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor);
        setApplied(next);
        setRan(true);
        if (!cursor && updateUrl) syncUrl(next, activeFilters);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(String(err).replace(/^Error: /, ''));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void execute(initial.filters, null, initial.active, false);
  }, [execute, initial]);

  function update<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]): void {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function toggleType(ty: ActivityType): void {
    update(
      'types',
      filters.types.includes(ty) ? filters.types.filter((x) => x !== ty) : [...filters.types, ty],
    );
  }

  function remove(id: FilterId): void {
    setActive((prev) => prev.filter((f) => f !== id));
    if (id === 'date') setFilters((prev) => ({ ...prev, from: '', to: '' }));
    if (id === 'types') setFilters((prev) => ({ ...prev, types: [] }));
    if (id === 'gear') setFilters((prev) => ({ ...prev, gearId: '' }));
    if (id === 'distance') setFilters((prev) => ({ ...prev, minDistance: '', maxDistance: '' }));
  }

  function add(): void {
    if (!addFilter) return;
    const id = addFilter;
    setActive((prev) => FILTERS.filter((f) => prev.includes(f) || f === id));
    setAddFilter('');
  }

  function run(): void {
    void execute(filters, null, active, true);
  }

  function clear(): void {
    setFilters(EMPTY);
    void execute(EMPTY, null, active, true);
  }

  return (
    <section className="connections-page advanced-search">
      <button type="button" className="btn ghost small" onClick={onBack}>
        {t('nav.backDashboard')}
      </button>
      <h2>{t('nav.search')}</h2>
      <p className="muted">{t('search.intro')}</p>

      <div className="card query-builder">
        <div className="query-builder-head">
          <h3>{t('search.builder')}</h3>
          <span className="muted">{t('search.hint')}</span>
        </div>

        {active.includes('date') && (
          <FilterRow id="date" onRemove={remove}>
            <DatePicker
              value={filters.from}
              onChange={(v) => update('from', v)}
              placeholder={t('dash.fromDate')}
              max={filters.to || undefined}
            />
            <span className="range-sep">→</span>
            <DatePicker
              value={filters.to}
              onChange={(v) => update('to', v)}
              placeholder={t('dash.toDate')}
              min={filters.from || undefined}
            />
          </FilterRow>
        )}

        {active.includes('types') && (
          <FilterRow id="types" onRemove={remove}>
            <div className="type-chips">
              <button
                type="button"
                className={`btn ghost small ${filters.types.length === 0 ? 'active' : ''}`}
                aria-pressed={filters.types.length === 0}
                onClick={() => update('types', [])}
              >
                {t('dash.allTypes')}
              </button>
              {FEED_TYPES.map((ty) => (
                <button
                  key={ty}
                  type="button"
                  className={`btn ghost small ${filters.types.includes(ty) ? 'active' : ''}`}
                  aria-pressed={filters.types.includes(ty)}
                  onClick={() => toggleType(ty)}
                >
                  {TYPE_EMOJI[ty] ?? '⌚'} {typeLabel(ty)}
                </button>
              ))}
            </div>
          </FilterRow>
        )}

        {active.includes('gear') && (
          <FilterRow id="gear" onRemove={remove}>
            <select
              value={filters.gearId}
              onChange={(e) => update('gearId', e.target.value)}
              aria-label={t('nav.gear')}
            >
              <option value="">{t('search.anyGear')}</option>
              {gear.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </FilterRow>
        )}

        {active.includes('distance') && (
          <FilterRow id="distance" onRemove={remove}>
            <div className="distance-range">
              <label>
                <span>{t('search.min')}</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={filters.minDistance}
                  onChange={(e) => update('minDistance', e.target.value)}
                  aria-label={`${t('search.min')} ${t('feed.distance')}`}
                />
              </label>
              <span className="unit-suffix">{unitLabel()}</span>
              <span className="range-sep">→</span>
              <label>
                <span>{t('search.max')}</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={filters.maxDistance}
                  onChange={(e) => update('maxDistance', e.target.value)}
                  aria-label={`${t('search.max')} ${t('feed.distance')}`}
                />
              </label>
              <span className="unit-suffix">{unitLabel()}</span>
            </div>
            {invalidDistance && <p className="error">{invalidDistance}</p>}
          </FilterRow>
        )}

        {available.length > 0 && (
          <div className="add-filter">
            <select
              value={addFilter}
              onChange={(e) => setAddFilter(e.target.value as FilterId | '')}
              aria-label={t('search.addFilter')}
            >
              <option value="">{t('search.addFilter')}…</option>
              {available.map((id) => (
                <option key={id} value={id}>
                  {FILTER_LABEL[id]()}
                </option>
              ))}
            </select>
            <button type="button" className="btn ghost small" onClick={add} disabled={!addFilter}>
              {t('search.addFilter')}
            </button>
          </div>
        )}

        <div className="search-actions">
          <button
            type="button"
            className="btn"
            onClick={run}
            disabled={loading || !!invalidDistance}
          >
            {t('search.run')}
          </button>
          <button type="button" className="btn ghost" onClick={clear} disabled={loading}>
            {t('search.clear')}
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {(ran || loading) && (
        <section>
          <div className="results-head">
            <h3>{t('search.results')}</h3>
            {ran && <span className="muted">{countLabel}</span>}
          </div>
          {loading && items.length === 0 && <p>{t('common.loading')}</p>}
          {ran && items.length === 0 && <p className="empty">{t('search.none')}</p>}
          {items.length > 0 && (
            <>
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
                    {items.map((a) => (
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
                          {a.avgPowerW != null ? ' W' : ''}
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
              {nextCursor && applied && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={loading}
                  onClick={() => void execute(applied, nextCursor, active, false)}
                >
                  {t('search.loadMore')}
                </button>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
