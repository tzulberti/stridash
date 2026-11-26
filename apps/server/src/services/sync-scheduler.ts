/**
 * Background sync scheduler.
 *
 * The HTTP route only queues a sync after a user taps "sync now"; this module
 * keeps active connections fresh without a request. A DB claim
 * (`sync_started_at`) is still the cross-process mutex, so multiple replicas
 * can run the scheduler safely: exactly one wins each connection.
 *
 * The scheduler is deliberately conservative:
 *  - disabled with `STRIDASH_SYNC_INTERVAL_MS=0`;
 *  - claims at most `STRIDASH_SYNC_BATCH_SIZE` connections per tick;
 *  - picks the least-recently-synced first, so a backlog drains steadily.
 */

import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Env } from '../env.js';
import { safeErrorForLog } from '../redact.js';
import { enqueueConnectionSync, releaseSyncLock, SYNC_STALE_MS } from './sync-queue.js';

const SCHEDULED_PROVIDERS = ['GARMIN', 'IGPSPORT', 'OMRON', 'ZWIFT'] as const;

/** Poll at most once a minute; the due cutoff is the actual sync interval. */
const MAX_POLL_MS = 60_000;
/** Let the HTTP server bind before the first background pass. */
const INITIAL_DELAY_MS = 5_000;

export type SchedulerTickResult = {
  /** Connections the due query returned (before per-row claim races). */
  due: number;
  /** Connections actually claimed and handed to the in-process queue. */
  queued: number;
};

function dueWhere(cutoff: Date, staleCutoff: Date): Prisma.ConnectionWhereInput {
  return {
    status: 'ACTIVE',
    provider: { in: [...SCHEDULED_PROVIDERS] },
    OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
    AND: [
      {
        OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: staleCutoff } }],
      },
    ],
  };
}

/**
 * One scheduler pass. Exported separately from the timer so tests (and a
 * future admin endpoint) can run a deterministic tick.
 */
export async function runSyncSchedulerTick(
  env: Env,
  now = Date.now(),
): Promise<SchedulerTickResult> {
  if (env.STRIDASH_SYNC_INTERVAL_MS <= 0) return { due: 0, queued: 0 };

  const cutoff = new Date(now - env.STRIDASH_SYNC_INTERVAL_MS);
  const staleCutoff = new Date(now - SYNC_STALE_MS);
  const where = dueWhere(cutoff, staleCutoff);

  const due = await prisma.connection.findMany({
    where,
    orderBy: [{ lastSyncedAt: 'asc' }, { id: 'asc' }],
    take: env.STRIDASH_SYNC_BATCH_SIZE,
    select: { id: true },
  });

  let queued = 0;
  for (const connection of due) {
    const claimedAt = new Date(now);
    // Re-check every condition in the claim: another replica may have synced
    // or locked the row between the findMany and this update.
    const claim = await prisma.connection.updateMany({
      where: { ...where, id: connection.id },
      data: { syncStartedAt: claimedAt },
    });
    if (claim.count === 0) continue;

    if (!enqueueConnectionSync(env, { connectionId: connection.id, claimedAt })) {
      // A stale-takeover claim raced a worker that is still alive here.
      await releaseSyncLock(connection.id, claimedAt);
      continue;
    }
    queued += 1;
  }

  return { due: due.length, queued };
}

export type SyncScheduler = {
  /** Run one pass immediately (used by tests and manual admin tooling). */
  tick: () => Promise<SchedulerTickResult>;
  /** Stop timers and prevent any further ticks. Idempotent. */
  stop: () => void;
};

/**
 * Start the interval scheduler. Returns `null` when disabled, so callers can
 * log one predictable state without checking the interval themselves.
 */
export function startSyncScheduler(env: Env): SyncScheduler | null {
  const interval = env.STRIDASH_SYNC_INTERVAL_MS;
  if (interval <= 0) return null;

  let running = false;
  let stopped = false;

  const tick = async (): Promise<SchedulerTickResult> => {
    if (running || stopped) return { due: 0, queued: 0 };
    running = true;
    try {
      const result = await runSyncSchedulerTick(env);
      if (result.queued > 0) {
        console.log(`[sync] scheduler queued ${result.queued}/${result.due} due connection(s)`);
      }
      return result;
    } catch (err) {
      console.error('[sync] scheduler tick failed:', safeErrorForLog(err));
      return { due: 0, queued: 0 };
    } finally {
      running = false;
    }
  };

  const pollMs = Math.min(interval, MAX_POLL_MS);
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  const initial = setTimeout(() => void tick(), Math.min(INITIAL_DELAY_MS, pollMs));
  initial.unref?.();

  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearTimeout(initial);
    },
  };
}
