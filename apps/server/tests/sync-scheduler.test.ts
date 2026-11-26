/**
 * Background scheduler tests — mocked Prisma + in-process queue.
 *
 * The important contracts: due filtering/ordering, per-row claim re-checks,
 * stale-takeover release, disabled mode, and timer start/stop behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, queue } = vi.hoisted(() => {
  const prisma = {
    connection: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const queue = { enqueue: vi.fn(), release: vi.fn() };
  return { prisma, queue };
});

vi.mock('../src/db.js', () => ({ prisma }));
vi.mock('../src/services/sync-queue.js', () => ({
  enqueueConnectionSync: queue.enqueue,
  releaseSyncLock: queue.release,
  SYNC_STALE_MS: 15 * 60 * 1000,
}));

import { runSyncSchedulerTick, startSyncScheduler } from '../src/services/sync-scheduler.js';
import type { Env } from '../src/env.js';

const env = {
  STRIDASH_SYNC_INTERVAL_MS: 15 * 60 * 1000,
  STRIDASH_SYNC_BATCH_SIZE: 10,
} as unknown as Env;

const now = Date.UTC(2026, 10, 27, 12, 0, 0);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.connection.findMany.mockReset();
  prisma.connection.updateMany.mockReset();
  queue.enqueue.mockReset();
  queue.release.mockReset();

  prisma.connection.findMany.mockResolvedValue([]);
  prisma.connection.updateMany.mockResolvedValue({ count: 1 });
  queue.enqueue.mockReturnValue(true);
  queue.release.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── One tick ────────────────────────────────────────────────────────────────

describe('runSyncSchedulerTick', () => {
  it('claims due connections oldest-first and queues them', async () => {
    prisma.connection.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

    const result = await runSyncSchedulerTick(env, now);

    expect(result).toEqual({ due: 2, queued: 2 });
    const query = prisma.connection.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      orderBy: unknown[];
      take: number;
      select: unknown;
    };
    expect(query.where).toMatchObject({
      status: 'ACTIVE',
      provider: { in: ['GARMIN', 'IGPSPORT', 'OMRON', 'ZWIFT'] },
      OR: [
        { lastSyncedAt: null },
        { lastSyncedAt: { lt: new Date(now - env.STRIDASH_SYNC_INTERVAL_MS) } },
      ],
    });
    expect(query.orderBy).toEqual([{ lastSyncedAt: 'asc' }, { id: 'asc' }]);
    expect(query.take).toBe(10);
    expect(query.select).toEqual({ id: true });

    expect(prisma.connection.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.connection.updateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({ id: 'a', status: 'ACTIVE' }),
      data: { syncStartedAt: new Date(now) },
    });
    expect(queue.enqueue).toHaveBeenNthCalledWith(1, env, {
      connectionId: 'a',
      claimedAt: new Date(now),
    });
    expect(queue.enqueue).toHaveBeenNthCalledWith(2, env, {
      connectionId: 'b',
      claimedAt: new Date(now),
    });
  });

  it('is a no-op when the scheduler is disabled', async () => {
    const result = await runSyncSchedulerTick({ ...env, STRIDASH_SYNC_INTERVAL_MS: 0 } as Env, now);

    expect(result).toEqual({ due: 0, queued: 0 });
    expect(prisma.connection.findMany).not.toHaveBeenCalled();
    expect(prisma.connection.updateMany).not.toHaveBeenCalled();
  });

  it('skips rows another replica claimed after the due query', async () => {
    prisma.connection.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    prisma.connection.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await runSyncSchedulerTick(env, now);

    expect(result).toEqual({ due: 2, queued: 1 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(env, expect.objectContaining({ connectionId: 'b' }));
  });

  it('releases a claim when the in-process queue rejects a stale takeover', async () => {
    prisma.connection.findMany.mockResolvedValueOnce([{ id: 'a' }]);
    queue.enqueue.mockReturnValueOnce(false);

    const result = await runSyncSchedulerTick(env, now);

    expect(result).toEqual({ due: 1, queued: 0 });
    expect(queue.release).toHaveBeenCalledWith('a', new Date(now));
  });

  it('also takes over locks older than the stale threshold', async () => {
    await runSyncSchedulerTick(env, now);

    const query = prisma.connection.findMany.mock.calls[0]![0] as {
      where: { AND: Array<{ OR: Array<Record<string, unknown>> }> };
    };
    expect(query.where.AND[0]!.OR).toEqual([
      { syncStartedAt: null },
      { syncStartedAt: { lt: new Date(now - 15 * 60 * 1000) } },
    ]);
  });
});

// ─── Timer lifecycle ─────────────────────────────────────────────────────────

describe('startSyncScheduler', () => {
  it('returns null when disabled and does not touch the database', () => {
    expect(startSyncScheduler({ ...env, STRIDASH_SYNC_INTERVAL_MS: 0 } as Env)).toBeNull();
    expect(prisma.connection.findMany).not.toHaveBeenCalled();
  });

  it('runs an initial pass after boot and stops cleanly', async () => {
    vi.useFakeTimers();
    const scheduler = startSyncScheduler(env);
    expect(scheduler).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(prisma.connection.findMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.connection.findMany).toHaveBeenCalledTimes(2);

    scheduler!.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(prisma.connection.findMany).toHaveBeenCalledTimes(2);
  });

  it('does not overlap ticks and swallows tick errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: (rows: Array<{ id: string }>) => void;
    prisma.connection.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const scheduler = startSyncScheduler(env)!;

    const first = scheduler.tick();
    expect(await scheduler.tick()).toEqual({ due: 0, queued: 0 });
    release([]);
    expect(await first).toEqual({ due: 0, queued: 0 });

    prisma.connection.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await scheduler.tick()).toEqual({ due: 0, queued: 0 });
    expect(error).toHaveBeenCalled();
    scheduler.stop();
    error.mockRestore();
  });
});
