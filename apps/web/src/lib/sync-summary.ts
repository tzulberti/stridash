import { t } from './i18n/index.js';

export type SyncLogJson = {
  kind?: string;
  status?: string;
  itemsCreated?: number;
  itemsUpdated?: number;
  startedAt?: string;
};

export type SyncStatusJson = {
  items?: SyncLogJson[];
  inProgress?: boolean;
  connectionStatus?: string;
  syncStartedAt?: string | null;
};

/** After the worker releases the lock, the sync log rows are the durable
 * record of what happened. Filter to rows started after this tap so an older
 * failure/history can't make a fresh successful sync look broken. */
export function summarizeSyncStatus(
  res: SyncStatusJson,
  requestedAt: number,
): { ok: boolean; text: string } {
  const recent = (res.items ?? []).filter((log) => {
    const at = log.startedAt ? Date.parse(log.startedAt) : NaN;
    return Number.isFinite(at) && at >= requestedAt - 2_000;
  });

  const primary = recent.find((log) => log.kind === 'ACTIVITIES' || log.kind === 'MEASUREMENTS');
  // Garmin's wellness pass is deliberately non-fatal: only the primary
  // activities/measurements log (or a credential-rejected connection) fails
  // the whole tap.
  if (res.connectionStatus === 'ERROR') {
    return { ok: false, text: `${t('conn.syncFailed')}${t('conn.tokenRejected')}` };
  }
  if (primary?.status === 'ERROR') return { ok: false, text: t('conn.syncFailedCheck') };

  const counted = recent.filter((log) => log.status !== 'ERROR');
  const created = counted.reduce((sum, log) => sum + (log.itemsCreated ?? 0), 0);
  const updated = counted.reduce((sum, log) => sum + (log.itemsUpdated ?? 0), 0);
  const parts: string[] = [];
  if (created) parts.push(t('sync.new', { n: created }));
  if (updated) parts.push(t('sync.updated', { n: updated }));
  return {
    ok: true,
    text: parts.length ? t('sync.summary', { items: parts.join(' · ') }) : t('sync.nothingNew'),
  };
}
