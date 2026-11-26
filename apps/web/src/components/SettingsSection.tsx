import { useEffect, useState } from 'react';
import type { ChartChannelConfig, ChartProvider, MeResponse } from '@stridash/types';
import { api } from '../lib/api';
import { LANGUAGES, t, type Lang } from '../lib/i18n/index';
import type { Unit } from '../lib/format';
import { ChartConfigList } from './ChartConfigList';

const CHART_CONFIG_PROVIDERS: Array<{ provider: ChartProvider; name: string }> = [
  { provider: 'GARMIN', name: 'Garmin' },
  { provider: 'ZWIFT', name: 'Zwift' },
  { provider: 'IGPSPORT', name: 'iGPSPORT' },
  { provider: 'STRAVA', name: 'Strava' },
];

export function SettingsSection(props: {
  token: string;
  unit: Unit;
  onUnitChange: (u: Unit) => void;
  theme: 'dark' | 'light';
  onThemeChange: (t: 'dark' | 'light') => void;
  lang: Lang;
  onLangChange: (l: Lang) => void;
  chartChannels: Partial<Record<ChartProvider, ChartChannelConfig[]>>;
  onChartChannelsChange: (provider: ChartProvider, channels: ChartChannelConfig[]) => void;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const {
    token,
    unit,
    onUnitChange,
    theme,
    onThemeChange,
    lang,
    onLangChange,
    chartChannels,
    onChartChannelsChange,
    onDeleted,
    onBack,
  } = props;
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

  /** optimistic toggle/reorder first (App state + localStorage), then persist
   * the provider's whole list — the activity page renders from the
   * optimistic copy */
  function changeCharts(provider: ChartProvider, channels: ChartChannelConfig[]): void {
    onChartChannelsChange(provider, channels);
    api(`/preferences/charts/${provider}`, { method: 'PUT', token, body: { channels } }).catch(
      (err) => setError(String(err).replace(/^Error: /, '')),
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
        <h3>{t('settings.charts')}</h3>
        <p className="muted">{t('settings.chartsDesc')}</p>
        <div className="chart-cfg-groups">
          {CHART_CONFIG_PROVIDERS.map((p) => (
            <ChartConfigList
              key={p.provider}
              provider={p.provider}
              name={p.name}
              config={chartChannels?.[p.provider]}
              onChange={changeCharts}
            />
          ))}
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
