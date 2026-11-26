import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { t } from '../lib/i18n/index';

export interface ConnectionRow {
  id: string;
  provider: string;
  providerUserId: string;
  status: string;
  lastSyncedAt: string | null;
}

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

export function ConnectionsSection(props: {
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
