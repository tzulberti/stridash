/**
 * Omron sync orchestration with mocked prisma + Omron client. The important
 * contract here is the batched measurement upsert: one findMany + one
 * createMany per device page instead of a findUnique/create per sample.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prisma, getDevices, getMeasureSamples } = vi.hoisted(() => {
  const prisma = {
    syncLog: {
      create: vi.fn(async () => ({ id: 'log-1' })),
      update: vi.fn(async () => ({})),
    },
    connection: { update: vi.fn(async () => ({})) },
    measurement: {
      findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
      createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
      update: vi.fn(async () => ({})),
    },
  };
  return { prisma, getDevices: vi.fn(), getMeasureSamples: vi.fn() };
});

vi.mock('../src/db.js', () => ({ prisma }));

vi.mock('../src/crypto.js', () => ({
  decryptToken: vi.fn((token: string) => token.replace('ENC:', '')),
  encryptToken: vi.fn((token: string) => `ENC:${token}`),
}));

vi.mock('../src/providers/omron/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/omron/client.js')>();
  class MockOmronConnectV1 {
    withAccessToken(): this {
      return this;
    }
    async refresh(): Promise<void> {}
    getDevices(limit: number): unknown {
      return getDevices(limit);
    }
    getMeasureSamples(device: unknown, fromMs: number): unknown {
      return getMeasureSamples(device, fromMs);
    }
  }
  return { ...actual, OmronConnectV1: MockOmronConnectV1 };
});

import { syncOmronConnection } from '../src/services/omron-sync.js';

const env = {
  STRIDASH_ENC_KEY: 'x'.repeat(32),
  STRIDASH_JWT_SECRET: 'y'.repeat(32),
} as Parameters<typeof syncOmronConnection>[0];

const connection = {
  id: 'conn-1',
  userId: 'user-1',
  accessTokenEnc: 'ENC:access',
  refreshTokenEnc: null,
  tokenExpiresAt: null,
  lastSyncedAt: null,
  status: 'ACTIVE',
  config: { omron: { country: 'jp' } },
};

const device = { deviceModel: 'HBF-702T', deviceSerialID: 'serial-1', category: '1' };

function sample(iso: string, weightKg: number) {
  return {
    measureDateTo: new Date(iso).getTime(),
    timeZone: 'Asia/Tokyo',
    // value 257 = weight, unit 8195 = kg, scale -3
    bodyIndexList: { '257': [weightKg * 1000, 8195, -3, 1] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDevices.mockResolvedValue([device]);
  prisma.measurement.findMany.mockResolvedValue([]);
});

describe('syncOmronConnection measurement batching', () => {
  it('does one lookup and one createMany, updating only existing samples', async () => {
    const existingAt = '2026-11-01T07:00:00.000Z';
    getMeasureSamples.mockResolvedValue([
      sample(existingAt, 70),
      sample('2026-11-02T07:00:00.000Z', 70.4),
      sample('2026-11-03T07:00:00.000Z', 70.8),
      // duplicate of the previous sample in the same response
      sample('2026-11-03T07:00:00.000Z', 70.8),
    ]);
    prisma.measurement.findMany.mockResolvedValue([
      { id: 'measurement-existing', kind: 'WEIGH_IN', measuredAt: new Date(existingAt) },
    ]);

    const result = await syncOmronConnection(env, connection);

    expect(result.itemsPulled).toBe(4);
    expect(result.itemsCreated).toBe(2);
    expect(result.itemsUpdated).toBe(1);
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.measurement.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.measurement.update).toHaveBeenCalledTimes(1);
    expect(prisma.measurement.update).toHaveBeenCalledWith({
      where: { id: 'measurement-existing' },
      data: expect.any(Object),
    });
    const createArgs = prisma.measurement.createMany.mock.calls[0]![0] as { data: unknown[] };
    expect(createArgs.data).toHaveLength(2);
  });
});
