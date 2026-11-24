import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { upsertActivitySeries } from '../src/services/activity-series.js';

describe('upsertActivitySeries', () => {
  it('upserts one provider series with sampleCount from timeMs', async () => {
    const upsert = vi.fn(async () => ({}));
    const db = { activityDataPoint: { upsert } } as unknown as PrismaClient;
    const series = { timeMs: [0, 1_000], hrBpm: [120, 121] };

    await upsertActivitySeries('activity-1', 'ZWIFT', series, db);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      where: { activityId_provider: { activityId: 'activity-1', provider: 'ZWIFT' } },
      create: {
        activityId: 'activity-1',
        provider: 'ZWIFT',
        sampleCount: 2,
        series,
      },
      update: { sampleCount: 2, series },
    });
  });
});
