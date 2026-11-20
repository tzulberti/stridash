import { beforeEach, describe, expect, it } from 'vitest';
import { setLang, t } from './i18n/index.js';
import { summarizeSyncStatus, type SyncLogJson } from './sync-summary.js';

const now = Date.parse('2026-11-19T20:00:00.000Z');

function log(overrides: Partial<SyncLogJson> = {}): SyncLogJson {
  return {
    kind: 'ACTIVITIES',
    status: 'OK',
    itemsCreated: 0,
    itemsUpdated: 0,
    startedAt: new Date(now + 1_000).toISOString(),
    ...overrides,
  };
}

describe('summarizeSyncStatus', () => {
  beforeEach(() => setLang('en'));

  it('sums fresh activity and wellness rows', () => {
    const result = summarizeSyncStatus(
      {
        items: [
          log({ kind: 'WELLNESS', itemsCreated: 3 }),
          log({ itemsCreated: 2, itemsUpdated: 1 }),
        ],
      },
      now,
    );
    expect(result).toEqual({
      ok: true,
      text: t('sync.summary', {
        items: `${t('sync.new', { n: 5 })} · ${t('sync.updated', { n: 1 })}`,
      }),
    });
  });

  it('ignores history from before this tap', () => {
    const result = summarizeSyncStatus(
      { items: [log({ itemsCreated: 9, startedAt: new Date(now - 60_000).toISOString() })] },
      now,
    );
    expect(result).toEqual({ ok: true, text: t('sync.nothingNew') });
  });

  it('reports a failed primary sync', () => {
    const result = summarizeSyncStatus({ items: [log({ status: 'ERROR' })] }, now);
    expect(result).toEqual({ ok: false, text: t('conn.syncFailedCheck') });
  });

  it('keeps Garmin wellness failures non-fatal', () => {
    const result = summarizeSyncStatus(
      {
        items: [
          log({ kind: 'WELLNESS', status: 'ERROR', itemsCreated: 4 }),
          log({ itemsCreated: 2 }),
        ],
      },
      now,
    );
    expect(result).toEqual({
      ok: true,
      text: t('sync.summary', { items: t('sync.new', { n: 2 }) }),
    });
  });

  it('turns a credential-rejected connection into a reconnect message', () => {
    const result = summarizeSyncStatus({ connectionStatus: 'ERROR', items: [log()] }, now);
    expect(result).toEqual({
      ok: false,
      text: `${t('conn.syncFailed')}${t('conn.tokenRejected')}`,
    });
  });
});
