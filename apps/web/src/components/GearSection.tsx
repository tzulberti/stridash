import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { metersPerUnit, unitLabel } from '../lib/format';
import { t, type MsgKey } from '../lib/i18n/index';

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

export function GearSection(props: { token: string; onBack: () => void }) {
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
