/**
 * One dashboard for every stride.
 *
 * Data policy mirrors the server: the dashboard NEVER talks to providers —
 * it only reads the local Stridash API. Login (JWT) → measurements +
 * activities list + one-activity drill-down with GPS/HR/power series.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import type { MeResponse, ChartChannelConfig, ChartProvider } from '@stridash/types';
import { clearTokens, readToken, saveTokens, storedRefreshToken } from './lib/token-storage';
import { summarizeSyncStatus, type SyncStatusJson } from './lib/sync-summary';
import { api, setTokenListener } from './lib/api';

// (fmtPace / fmtSplitTime moved to lib/format.ts)

// ─── Shared bits — pure display helpers live in lib/format.ts ────────────────

import { SettingsSection } from './components/SettingsSection';
import { AppHeader } from './components/AppHeader';
import { useDashboardData } from './hooks/useDashboardData';
import { ConnectionsSection } from './components/ConnectionsSection';
import { GearSection } from './components/GearSection';
import { ActivityDetail } from './components/ActivityDetail';
import {
  BODY_METRIC,
  DAILY_METRIC,
  DashboardView,
  SLEEP_METRIC,
  type BodyMetricKey,
  type DailyMetricKey,
  type SleepMetricKey,
} from './components/DashboardView';
import {
  setUnit,
  setLocale,
  FEED_TYPES,
  FEED_PROVIDERS,
  keyOf,
  pick,
  isoDate,
  parseRoute,
  type Route,
  type Unit,
} from './lib/format';
import { setLang, localeOf, LANGUAGES, t, type Lang } from './lib/i18n/index';

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
  const [displayName, setDisplayName] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  const onUnauthorized = useCallback(() => {
    clearTokens();
    setToken(null);
  }, []);
  const {
    connections,
    measurements,
    activities,
    sleep,
    wellness,
    gear,
    error,
    setError,
    loading,
    load,
  } = useDashboardData(token, onUnauthorized);

  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
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
  const [syncingId, setSyncingId] = useState<string | null>(null);

  useEffect(() => {
    setTokenListener(setToken);
  }, [token, load]);
  // browser back/forward between the dashboard and activity pages
  useEffect(() => {
    const onPop = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
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

  async function register(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ accessToken: string; refreshToken: string }>('/auth/register', {
        method: 'POST',
        body: { email, password, displayName: displayName.trim() },
      });
      saveTokens(r.accessToken, r.refreshToken, rememberMe);
      setToken(r.accessToken);
      openConnections(); // onboarding: connect a provider, then sync
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
  }
  function openGear(): void {
    window.history.pushState(null, '', '/gear');
    setRoute({ name: 'gear' });
  }
  function openSettings(): void {
    window.history.pushState(null, '', '/settings');
    setRoute({ name: 'settings' });
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
        <form
          onSubmit={authMode === 'register' ? (e) => void register(e) : (e) => void login(e)}
          className="login-card"
        >
          <h1>🦾 Stridash</h1>
          <p>{t('auth.tagline')}</p>
          {authMode === 'register' && (
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('auth.displayName')}
              autoComplete="name"
              required
              maxLength={80}
            />
          )}
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder={t('auth.email')}
            autoComplete="email"
            required
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder={t('auth.password')}
            autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
            required
            minLength={authMode === 'register' ? 8 : undefined}
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
            {authMode === 'register' ? t('auth.register') : t('auth.signIn')}
          </button>
          <button
            className="btn ghost small"
            type="button"
            onClick={() => {
              setAuthMode(authMode === 'register' ? 'login' : 'register');
              setError(null);
            }}
          >
            {authMode === 'register' ? t('auth.haveAccount') : t('auth.needAccount')}
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
  };

  const header = (
    <AppHeader
      current={route.name}
      goHome={goHome}
      openConnections={openConnections}
      openGear={openGear}
      openSettings={openSettings}
      signOut={signOut}
    />
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
    <DashboardView
      header={header}
      token={token}
      onMeasurementSaved={() => {
        void load(token);
      }}
      error={error}
      activePreset={activePreset}
      applyPreset={applyPreset}
      fromDate={fromDate}
      setFromDate={setFromDate}
      toDate={toDate}
      setToDate={setToDate}
      latest={latest}
      lastSleep={lastSleep}
      latestWellness={latestWellness}
      latestRestingHr={latestRestingHr}
      activitiesIn={activitiesIn}
      measurementsIn={measurementsIn}
      bodyMetric={bodyMetric}
      setBodyMetric={setBodyMetric}
      sleepMetric={sleepMetric}
      setSleepMetric={setSleepMetric}
      dailyMetric={dailyMetric}
      setDailyMetric={setDailyMetric}
      weighInsIn={weighInsIn}
      sleepIn={sleepIn}
      wellnessIn={wellnessIn}
      feedType={feedType}
      setFeedType={setFeedType}
      feedProv={feedProv}
      setFeedProv={setFeedProv}
      feedTypeOptions={feedTypeOptions}
      feedProvOptions={feedProvOptions}
      activitiesFeed={activitiesFeed}
      openActivity={openActivity}
      loading={loading}
      connections={connections}
      gear={gear}
    />
  );
}
