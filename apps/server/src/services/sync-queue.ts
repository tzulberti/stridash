import { prisma } from '../db.js';
import { safeErrorForLog } from '../redact.js';
import { OmronConnectError } from '../providers/omron/client.js';
import { IgpSportError } from '../providers/igpsport/client.js';
import { GarminError } from '../providers/garmin/sso.js';
import { ZwiftError } from '../providers/zwift/client.js';
import { StravaError } from '../providers/strava/client.js';
import { syncGarminConnection } from './garmin-sync.js';
import { syncGarminWellness } from './garmin-wellness.js';
import { syncIgpSportConnection } from './igpsport-sync.js';
import { syncOmronConnection } from './omron-sync.js';
import { syncStravaConnection } from './strava-sync.js';
import { syncZwiftConnection } from './zwift-sync.js';
import type { Env } from '../env.js';

/** A manual sync older than this is assumed crashed and may be taken over. */
export const SYNC_STALE_MS = 15 * 60 * 1000;

type QueuedSync = {
  connectionId: string;
  /** The exact `sync_started_at` value this job claimed, so releasing the lock
   * cannot stomp on a newer stale-takeover winner. */
  claimedAt: Date;
};

/**
 * In-process sync queue.
 *
 * One job per connection at a time. The database lock (`sync_started_at`) is
 * still the source of truth across requests/processes; this map only keeps a
 * second worker in the same process from running the same connection twice
 * and gives shutdown something to drain. A multi-replica deployment remains
 * safe because the DB claim happens before anything is queued here.
 */
const pending = new Map<string, Promise<void>>();

/** Queue one already-claimed connection sync. Returns false when this process
 * is already running a job for the connection (e.g. a stale lock takeover hit
 * a worker that is still alive). */
export function enqueueConnectionSync(env: Env, job: QueuedSync): boolean {
  if (pending.has(job.connectionId)) return false;

  // Run after the current HTTP task so the route can return 202 first.
  const task = runJob(env, job)
    .catch((err) => console.error('[sync] queue worker crashed:', safeErrorForLog(err)))
    .finally(() => pending.delete(job.connectionId));
  pending.set(job.connectionId, task);
  return true;
}

/** Release only the claim this job owns; a stale-takeover winner has a newer
 * timestamp and must not be unlocked by the old run. */
export async function releaseSyncLock(connectionId: string, claimedAt: Date): Promise<void> {
  await prisma.connection
    .updateMany({
      where: { id: connectionId, syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    })
    .catch((err) => console.error('[sync] lock release failed:', safeErrorForLog(err)));
}

/** Clear locks (and mark unfinished log rows) left behind by a previous
 * process. Called once at startup, before accepting requests. */
export async function recoverStaleSyncLocks(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - SYNC_STALE_MS);
  const [connections, logs] = await Promise.all([
    prisma.connection.updateMany({
      where: { syncStartedAt: { lt: cutoff } },
      data: { syncStartedAt: null },
    }),
    prisma.syncLog.updateMany({
      where: { finishedAt: null, startedAt: { lt: cutoff } },
      data: {
        status: 'ERROR',
        finishedAt: new Date(now),
        errorDetail: { error: 'Sync interrupted by a server restart' } as never,
      },
    }),
  ]);
  if (logs.count > 0) {
    console.warn(`[sync] marked ${logs.count} interrupted sync log(s) as ERROR`);
  }
  return connections.count;
}

/** Wait for in-flight jobs on shutdown. Returns false if the timeout elapsed
 * first; the DB stale-lock takeover then handles anything left behind. */
export async function drainSyncQueue(timeoutMs = 30_000): Promise<boolean> {
  const jobs = [...pending.values()];
  if (jobs.length === 0) return true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const done = Promise.allSettled(jobs).then(() => true);
  const drained = await Promise.race([done, timeout]);
  if (timer) clearTimeout(timer);
  return drained;
}

async function runJob(env: Env, job: QueuedSync): Promise<void> {
  try {
    // Let the route flush its 202 before provider work (Garmin can take
    // minutes, so the response must not wait for us).
    await new Promise<void>((resolve) => setImmediate(resolve));

    const connection = await prisma.connection.findUnique({ where: { id: job.connectionId } });
    if (!connection || connection.status !== 'ACTIVE') return;

    if (connection.provider === 'GARMIN') {
      await syncGarminConnection(env, connection);
      // Sleep/daily metrics run below the activities so one tap syncs both;
      // a wellness failure doesn't invalidate the activities result.
      try {
        await syncGarminWellness(env, connection);
      } catch (err) {
        console.error('[garmin] wellness sync failed:', safeErrorForLog(err));
      }
      return;
    }
    if (connection.provider === 'ZWIFT') {
      await syncZwiftConnection(env, connection);
      return;
    }
    if (connection.provider === 'IGPSPORT') {
      await syncIgpSportConnection(env, connection);
      return;
    }
    if (connection.provider === 'STRAVA') {
      await syncStravaConnection(env, connection);
      return;
    }
    if (connection.provider === 'OMRON') {
      await syncOmronConnection(env, connection);
    }
  } catch (err) {
    await recordFailure(job.connectionId, err);
  } finally {
    await releaseSyncLock(job.connectionId, job.claimedAt);
  }
}

/** There is no HTTP response here: mark rejected credentials so the next
 * dashboard load shows a red "reconnect" pill, and log everything else for
 * operators. Unknown throws are bugs, so they must not flip the connection. */
async function recordFailure(connectionId: string, err: unknown): Promise<void> {
  if (
    err instanceof OmronConnectError ||
    err instanceof IgpSportError ||
    err instanceof ZwiftError ||
    err instanceof StravaError ||
    err instanceof GarminError
  ) {
    const httpStatus = err instanceof GarminError ? undefined : err.status;
    const credentialsRejected =
      (err instanceof GarminError && err.kind === 'CREDENTIALS') ||
      (err instanceof ZwiftError && err.kind === 'CREDENTIALS') ||
      (err instanceof StravaError && err.kind === 'CREDENTIALS') ||
      httpStatus === 401 ||
      httpStatus === 403;

    if (credentialsRejected) {
      await prisma.connection
        .updateMany({
          where: { id: connectionId, status: 'ACTIVE' },
          data: { status: 'ERROR' },
        })
        .catch((updateErr) =>
          console.error('[sync] failed to mark connection ERROR:', safeErrorForLog(updateErr)),
        );
    }
    console.error('[sync] provider sync failed:', safeErrorForLog(err));
    return;
  }

  console.error('[sync] unexpected sync failure:', safeErrorForLog(err));
}
