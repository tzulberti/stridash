import { useCallback, useEffect, useState } from 'react';
import type { Activity, Measurement } from '@stridash/types';
import { api } from '../lib/api';
import type { ConnectionRow } from '../components/ConnectionsSection';
import type { DailyWellnessRow, SleepRow } from '../components/DashboardView';

/**
 * Loads everything the dashboard/connections pages need. Pagination is
 * intentional: activities walk the 100-row cursor (max 50 pages) and the
 * date-keyed sleep/wellness feeds walk backwards 200 rows at a time.
 *
 * 401/Unauthorized clears the session via `onUnauthorized`; other failures
 * stay visible in `error` without unmounting the loaded data.
 */
export function useDashboardData(token: string | null, onUnauthorized: () => void) {
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [sleep, setSleep] = useState<SleepRow[]>([]);
  const [wellness, setWellness] = useState<DailyWellnessRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (tok: string) => {
      setLoading(true);
      setError(null);
      try {
        // measurements newest-first already; charts want oldest-first
        const [conns, meas] = await Promise.all([
          api<{ items: ConnectionRow[] }>('/connections', { token: tok }),
          api<{ items: Measurement[] }>('/measurements', { token: tok, body: undefined }),
        ]);
        setConnections(conns.items);
        setMeasurements(meas.items);

        // activities paginate server-side (max 100/page, cursor) — pull all
        // pages so the feed and the stat card cover the full history
        const acts: Activity[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const r = await api<{ items: Activity[]; nextCursor: string | null }>('/activities', {
            token: tok,
            query: { limit: '100', ...(cursor ? { cursor } : {}) },
          });
          acts.push(...r.items);
          if (!r.nextCursor) break;
          cursor = r.nextCursor;
        }
        setActivities(acts);

        // sleep + daily wellness: newest-first pages of 200, walk back with
        // the `to` date filter (rows keyed by calendar date)
        const fetchDateKeyedAll = async <T extends { dateKey: string }>(
          path: string,
        ): Promise<T[]> => {
          const out: T[] = [];
          let to: string | undefined;
          for (let page = 0; page < 30; page++) {
            const r = await api<{ items: T[] }>(path, {
              token: tok,
              query: { limit: '200', ...(to ? { to } : {}) },
            });
            if (r.items.length === 0) break;
            const last = r.items[r.items.length - 1];
            if (!last) break;
            out.push(...r.items);
            const oldest = new Date(`${last.dateKey}T00:00:00.000Z`);
            to = new Date(oldest.getTime() - 86_400_000).toISOString().slice(0, 10);
          }
          return out.reverse(); // charts want oldest-first
        };
        const [sRows, wRows] = await Promise.all([
          fetchDateKeyedAll<SleepRow>('/sleeps'),
          fetchDateKeyedAll<DailyWellnessRow>('/wellness'),
        ]);
        setSleep(sRows);
        setWellness(wRows);
      } catch (e) {
        setError(String(e));
        if (String(e).includes('401') || String(e).includes('Unauthorized')) {
          onUnauthorized();
        }
      } finally {
        setLoading(false);
      }
    },
    [onUnauthorized],
  );

  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);

  return {
    connections,
    measurements,
    activities,
    sleep,
    wellness,
    error,
    setError,
    loading,
    load,
  };
}
