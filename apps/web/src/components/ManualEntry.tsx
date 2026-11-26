import { useState } from 'react';
import { api } from '../lib/api';
import { t } from '../lib/i18n/index';

type Kind = 'WEIGH_IN' | 'BLOOD_PRESSURE';

function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** Manual quick-add for a weigh-in/body composition or a blood-pressure
 * reading. Saves through `POST /api/measurements` (provider MANUAL) and asks
 * the dashboard to reload so the cards/charts update immediately. */
export function ManualEntry(props: { token: string; onSaved: () => void }) {
  const { token, onSaved } = props;
  const [kind, setKind] = useState<Kind>('WEIGH_IN');
  const [measuredAt, setMeasuredAt] = useState(localNow());
  const [weightKg, setWeightKg] = useState('');
  const [bodyFatPct, setBodyFatPct] = useState('');
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [pulse, setPulse] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function switchKind(k: Kind): void {
    setKind(k);
    setMsg(null);
    setError(null);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setError(null);
    try {
      const when = measuredAt ? new Date(measuredAt).toISOString() : new Date().toISOString();
      const body =
        kind === 'WEIGH_IN'
          ? {
              kind,
              measuredAt: when,
              weightKg: Number(weightKg),
              ...(bodyFatPct.trim() ? { bodyFatPct: Number(bodyFatPct) } : {}),
            }
          : {
              kind,
              measuredAt: when,
              systolicMmhg: Number(systolic),
              diastolicMmhg: Number(diastolic),
              ...(pulse.trim() ? { pulseBpm: Number(pulse) } : {}),
            };
      await api('/measurements', { method: 'POST', token, body });
      setMsg(t('manual.saved'));
      if (kind === 'WEIGH_IN') {
        setWeightKg('');
        setBodyFatPct('');
      } else {
        setSystolic('');
        setDiastolic('');
        setPulse('');
      }
      onSaved();
    } catch (err) {
      setError(String(err).replace(/^Error: /, ''));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>{t('manual.heading')}</h2>
      <div className="metric-tabs">
        <button
          type="button"
          className={`btn ghost ${kind === 'WEIGH_IN' ? 'active' : ''}`}
          onClick={() => switchKind('WEIGH_IN')}
        >
          {t('manual.weight')}
        </button>
        <button
          type="button"
          className={`btn ghost ${kind === 'BLOOD_PRESSURE' ? 'active' : ''}`}
          onClick={() => switchKind('BLOOD_PRESSURE')}
        >
          {t('manual.bloodPressure')}
        </button>
      </div>
      <form className="setting-row" onSubmit={(e) => void submit(e)}>
        <label>
          {t('feed.when')}
          <input
            type="datetime-local"
            value={measuredAt}
            onChange={(e) => setMeasuredAt(e.target.value)}
            required
          />
        </label>
        {kind === 'WEIGH_IN' ? (
          <>
            <label>
              {t('manual.weight')} (kg)
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min="20"
                max="500"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                required
              />
            </label>
            <label>
              {t('manual.bodyFat')} (%)
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min="0"
                max="80"
                value={bodyFatPct}
                onChange={(e) => setBodyFatPct(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              {t('manual.systolic')}
              <input
                type="number"
                inputMode="numeric"
                min="70"
                max="260"
                value={systolic}
                onChange={(e) => setSystolic(e.target.value)}
                required
              />
            </label>
            <label>
              {t('manual.diastolic')}
              <input
                type="number"
                inputMode="numeric"
                min="40"
                max="150"
                value={diastolic}
                onChange={(e) => setDiastolic(e.target.value)}
                required
              />
            </label>
            <label>
              {t('manual.pulse')}
              <input
                type="number"
                inputMode="numeric"
                min="20"
                max="250"
                value={pulse}
                onChange={(e) => setPulse(e.target.value)}
              />
            </label>
          </>
        )}
        <button type="submit" className="btn" disabled={saving}>
          {t('manual.save')}
        </button>
      </form>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
