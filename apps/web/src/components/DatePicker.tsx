import { useEffect, useRef, useState } from 'react';
import { getLocale } from '../lib/format';
import { t } from '../lib/i18n/index';

const DP_MONDAY = new Date(Date.UTC(2024, 0, 1)); // 2024-01-01 was a Monday
const dpMonthFmtCache = new Map<string, Intl.DateTimeFormat>();
const dpWdFmtCache = new Map<string, Intl.DateTimeFormat>();

function dpMonthName(view: Date): string {
  const loc = getLocale();
  let f = dpMonthFmtCache.get(loc);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, { month: 'long', timeZone: 'UTC' });
    dpMonthFmtCache.set(loc, f);
  }
  return f.format(view);
}

function dpWeekdays(): string[] {
  const loc = getLocale();
  let f = dpWdFmtCache.get(loc);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' });
    dpWdFmtCache.set(loc, f);
  }
  return Array.from({ length: 7 }, (_, i) =>
    f!.format(new Date(DP_MONDAY.getTime() + i * 86_400_000)),
  );
}

/** Midnight-UTC of the 1st of the month containing `d` (day keys are UTC; the
 * server data + presets use toISOString().slice(0,10) everywhere). */
function dpMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function dpIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function DatePicker({
  value,
  onChange,
  placeholder,
  min,
  max,
}: {
  value: string; // YYYY-MM-DD, "" = unset
  onChange: (iso: string) => void;
  placeholder: string;
  /** inclusive bounds as YYYY-MM-DD; days outside are not clickable */
  min?: string;
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() =>
    dpMonthStart(value ? new Date(`${value}T00:00:00Z`) : new Date()),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  // click outside (or Escape) closes the popover
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (): void => {
    if (!open) setView(dpMonthStart(value ? new Date(`${value}T00:00:00Z`) : new Date()));
    setOpen(!open);
  };

  // 6×7 grid covering the viewed month (Monday-first, matching DP_WEEKDAYS)
  const firstWeekday = (view.getUTCDay() + 6) % 7; // Sun=0 → Mon=0
  const gridStart = new Date(view.getTime() - firstWeekday * 86_400_000);
  const cells: Date[] = Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getTime() + i * 86_400_000),
  );
  const todayIso = dpIso(new Date());

  return (
    <div className="dp" ref={rootRef}>
      <button
        type="button"
        className={`dp-btn ${open ? 'open' : ''}`}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className={`dp-value ${value ? '' : 'dp-empty'}`}>{value || placeholder}</span>
        <span className="dp-icon">📅</span>
      </button>
      {open && (
        <div className="dp-pop" role="dialog" aria-label={placeholder}>
          <div className="dp-head">
            <button
              type="button"
              className="dp-nav"
              onClick={() => setView(dpMonthStart(new Date(view.getTime() - 15 * 86_400_000)))}
              aria-label={t('dp.prevMonth')}
            >
              ‹
            </button>
            <span className="dp-month">
              {dpMonthName(view)} {view.getUTCFullYear()}
            </span>
            <button
              type="button"
              className="dp-nav"
              onClick={() => setView(dpMonthStart(new Date(view.getTime() + 31 * 86_400_000)))}
              aria-label={t('dp.nextMonth')}
            >
              ›
            </button>
          </div>
          <div className="dp-grid">
            {dpWeekdays().map((w) => (
              <span key={w} className="dp-wd">
                {w}
              </span>
            ))}
            {cells.map((d) => {
              const iso = dpIso(d);
              const outOfMonth = d.getUTCMonth() !== view.getUTCMonth();
              const disabled = (min !== undefined && iso < min) || (max !== undefined && iso > max);
              const cls = [
                'dp-day',
                outOfMonth ? 'dp-out' : '',
                iso === value ? 'sel' : '',
                iso === todayIso ? 'today' : '',
                disabled ? 'disabled' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={iso}
                  type="button"
                  className={cls}
                  disabled={disabled}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                >
                  {d.getUTCDate()}
                </button>
              );
            })}
          </div>
          <div className="dp-foot">
            <button
              type="button"
              className="dp-clear"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              disabled={value === ''}
            >
              {t('dp.clear')}
            </button>
            <button
              type="button"
              className="dp-clear"
              onClick={() => {
                onChange(todayIso);
                setOpen(false);
              }}
            >
              {t('dp.today')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
