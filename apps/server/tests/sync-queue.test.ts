/**
 * In-process sync queue tests — mocked Prisma and provider sync services.
 *
 * Covers worker dispatch for each provider, the Garmin activities+wellness
 * pairing, PARTIAL results, duplicate-job suppression, drain timeouts, lock
 * release and credential-error classification.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, syncs } = vi.hoisted(() => {
  const prisma = {
    connection: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    syncLog: { updateMany: vi.fn() },
  };
  const syncs = {
    garmin: vi.fn(),
    wellness: vi.fn(),
    zwift: vi.fn(),
    igpsport: vi.fn(),
    omron: vi.fn(),
  };
  return { prisma, syncs };
});

vi.mock('../src/db.js', () => ({ prisma }));
vi.mock('../src/services/garmin-sync.js', () => ({ syncGarminConnection: syncs.garmin }));
vi.mock('../src/services/garmin-wellness.js', () => ({ syncGarminWellness: syncs.wellness }));
vi.mock('../src/services/zwift-sync.js', () => ({ syncZwiftConnection: syncs.zwift }));
vi.mock('../src/services/igpsport-sync.js', () => ({ syncIgpSportConnection: syncs.igpsport }));
vi.mock('../src/services/omron-sync.js', () => ({ syncOmronConnection: syncs.omron }));

import {
  drainSyncQueue,
  enqueueConnectionSync,
  releaseSyncLock,
} from '../src/services/sync-queue.js';
import { GarminError } from '../src/providers/garmin/sso.js';
import { IgpSportError } from '../src/providers/igpsport/client.js';
import { OmronConnectError } from '../src/providers/omron/client.js';
import { ZwiftError } from '../src/providers/zwift/client.js';
import type { Env } from '../src/env.js';

const env = { STRIDASH_ENC_KEY: 'x'.repeat(32) } as unknown as Env;

const claimedAt = new Date('2026-11-26T10:00:00.000Z');

function connection(provider: string, status = 'ACTIVE') {
  return { id: `conn-${provider}-${Math.random()}`, provider, status, userId: 'user-1' };
}

function job(conn: { id: string }) {
  return { connectionId: conn.id, claimedAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.connection.findUnique.mockReset();
  prisma.connection.updateMany.mockReset();
  prisma.syncLog.updateMany.mockReset();
  syncs.garmin.mockReset();
  syncs.wellness.mockReset();
  syncs.zwift.mockReset();
  syncs.igpsport.mockReset();
  syncs.omron.mockReset();

  prisma.connection.updateMany.mockResolvedValue({ count: 1 });
  prisma.syncLog.updateMany.mockResolvedValue({ count: 0 });
  syncs.garmin.mockResolvedValue({ status: 'OK' });
  syncs.wellness.mockResolvedValue({ status: 'OK' });
  syncs.zwift.mockResolvedValue({ status: 'OK' });
  syncs.igpsport.mockResolvedValue({ status: 'OK' });
  syncs.omron.mockResolvedValue({ status: 'OK' });
});

// ─── Dispatch ────────────────────────────────────────────────────────────────

describe('enqueueConnectionSync — dispatch', () => {
  it.each([
    ['ZWIFT', syncs.zwift],
    ['IGPSPORT', syncs.igpsport],
    ['OMRON', syncs.omron],
  ])('runs the %s service and releases the lock', async (provider, service) => {
    const conn = connection(provider);
    prisma.connection.findUnique.mockResolvedValueOnce(conn);

    expect(enqueueConnectionSync(env, job(conn))).toBe(true);
    expect(await drainSyncQueue(1_000)).toBe(true);

    expect(service).toHaveBeenCalledWith(env, conn);
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: conn.id, syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    });
  });

  it('runs Garmin activities then wellness', async () => {
    const conn = connection('GARMIN');
    prisma.connection.findUnique.mockResolvedValueOnce(conn);

    enqueueConnectionSync(env, job(conn));
    await drainSyncQueue(1_000);

    expect(syncs.garmin).toHaveBeenCalledWith(env, conn);
    expect(syncs.wellness).toHaveBeenCalledWith(env, conn);
  });

  it('a wellness failure does not invalidate the activities run', async () => {
    const conn = connection('GARMIN');
    prisma.connection.findUnique.mockResolvedValueOnce(conn);
    syncs.wellness.mockRejectedValueOnce(new Error('wellness down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    enqueueConnectionSync(env, job(conn));
    await drainSyncQueue(1_000);
    error.mockRestore();

    expect(syncs.garmin).toHaveBeenCalledTimes(1);
    expect(
      prisma.connection.updateMany.mock.calls.some(
        (call) => (call[0] as { data?: { status?: string } }).data?.status === 'ERROR',
      ),
    ).toBe(false);
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: conn.id, syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    });
  });

  it('does nothing when the connection vanished or is no longer active', async () => {
    const missing = connection('IGPSPORT');
    prisma.connection.findUnique.mockResolvedValueOnce(null);
    enqueueConnectionSync(env, job(missing));
    await drainSyncQueue(1_000);

    const revoked = connection('IGPSPORT', 'REVOKED');
    prisma.connection.findUnique.mockResolvedValueOnce(revoked);
    enqueueConnectionSync(env, job(revoked));
    await drainSyncQueue(1_000);

    expect(syncs.igpsport).not.toHaveBeenCalled();
    expect(prisma.connection.updateMany).toHaveBeenCalledTimes(2); // locks released
  });

  it('dedupes a connection already running in this process', async () => {
    const conn = connection('IGPSPORT');
    prisma.connection.findUnique.mockResolvedValueOnce(conn);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    syncs.igpsport.mockImplementationOnce(async () => {
      await gate;
      return { status: 'OK' };
    });

    expect(enqueueConnectionSync(env, job(conn))).toBe(true);
    expect(enqueueConnectionSync(env, job(conn))).toBe(false);

    release();
    expect(await drainSyncQueue(1_000)).toBe(true);
    expect(syncs.igpsport).toHaveBeenCalledTimes(1);
    // once the job settles the connection can be queued again
    expect(enqueueConnectionSync(env, { connectionId: conn.id, claimedAt })).toBe(true);
    await drainSyncQueue(1_000);
  });

  it('drainSyncQueue returns false on timeout and true once the job settles', async () => {
    const conn = connection('OMRON');
    prisma.connection.findUnique.mockResolvedValueOnce(conn);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    syncs.omron.mockImplementationOnce(async () => {
      await gate;
      return { status: 'PARTIAL' };
    });

    enqueueConnectionSync(env, job(conn));
    expect(await drainSyncQueue(5)).toBe(false);

    release();
    expect(await drainSyncQueue(1_000)).toBe(true);
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: conn.id, syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    });
  });
});

// ─── Result + failure handling ───────────────────────────────────────────────

describe('enqueueConnectionSync — results and failures', () => {
  it('PARTIAL results release the lock without marking the connection ERROR', async () => {
    const conn = connection('IGPSPORT');
    prisma.connection.findUnique.mockResolvedValueOnce(conn);
    syncs.igpsport.mockResolvedValueOnce({ status: 'PARTIAL', failedRides: ['r1'] });

    enqueueConnectionSync(env, job(conn));
    await drainSyncQueue(1_000);

    expect(prisma.connection.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ERROR' } }),
    );
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: conn.id, syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    });
  });

  it.each([
    ['OMRON 401', new OmronConnectError('bad login', 401)],
    ['IGPSPORT 403', new IgpSportError('forbidden', 403)],
    ['ZWIFT credentials', new ZwiftError('CREDENTIALS', 'bad grant')],
    ['GARMIN credentials', new GarminError('CREDENTIALS', 'bad password')],
  ])('a %s failure marks the connection ERROR', async (_label, error) => {
    const conn = connection('OMRON');
    prisma.connection.findUnique.mockResolvedValueOnce(conn);
    syncs.omron.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    enqueueConnectionSync(env, job(conn));
    await drainSyncQueue(1_000);
    log.mockRestore();

    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: conn.id, status: 'ACTIVE' },
      data: { status: 'ERROR' },
    });
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: conn.id, syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    });
  });

  it.each([
    ['provider outage', new OmronConnectError('upstream 500', 500)],
    ['unexpected bug', new TypeError('boom')],
  ])('%s is logged but leaves the connection ACTIVE', async (_label, error) => {
    const conn = connection('OMRON');
    prisma.connection.findUnique.mockResolvedValueOnce(conn);
    syncs.omron.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    enqueueConnectionSync(env, job(conn));
    await drainSyncQueue(1_000);
    log.mockRestore();

    expect(prisma.connection.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ERROR' } }),
    );
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: conn.id, syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    });
  });

  it('releaseSyncLock scopes the update to the exact claim and swallows errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.connection.updateMany.mockRejectedValueOnce(new Error('db down'));

    await expect(releaseSyncLock('conn-1', claimedAt)).resolves.toBeUndefined();
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: { id: 'conn-1', syncStartedAt: claimedAt },
      data: { syncStartedAt: null },
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
