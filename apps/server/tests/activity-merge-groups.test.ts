import { describe, expect, it } from 'vitest';
import {
  activitiesMatch,
  groupDuplicateActivities,
  type MergeActivity,
} from '../src/services/activity-merge-groups.js';

const base = new Date('2026-11-01T10:00:00Z');

function activity(
  id: string,
  startOffsetS: number,
  distanceM: number | null,
  connections: string[],
  overrides: Partial<MergeActivity> = {},
): MergeActivity {
  return {
    id,
    userId: 'user-1',
    type: 'RIDE',
    startTime: new Date(base.getTime() + startOffsetS * 1000),
    distanceM,
    createdAt: new Date(base.getTime() + startOffsetS * 1000),
    sourceConnectionIds: connections,
    ...overrides,
  };
}

describe('activity merge grouping', () => {
  it('matches the real 21 s / 1.9 m cross-provider case', () => {
    expect(
      activitiesMatch(activity('a', 0, 30_000, ['garmin']), activity('b', 21, 30_001.9, ['zwift'])),
    ).toBe(true);
  });

  it('rejects starts outside 60 s or distances outside 100 m', () => {
    expect(
      activitiesMatch(activity('a', 0, 30_000, ['garmin']), activity('b', 61, 30_000, ['zwift'])),
    ).toBe(false);
    expect(
      activitiesMatch(activity('a', 0, 30_000, ['garmin']), activity('b', 1, 30_100.1, ['zwift'])),
    ).toBe(false);
  });

  it('requires an exact start when either distance is null', () => {
    expect(
      activitiesMatch(activity('a', 0, null, ['garmin']), activity('b', 0, 30_000, ['zwift'])),
    ).toBe(true);
    expect(
      activitiesMatch(activity('a', 0, null, ['garmin']), activity('b', 1, 30_000, ['zwift'])),
    ).toBe(false);
    expect(
      activitiesMatch(activity('a', 0, null, ['garmin']), activity('b', 0, null, ['zwift'])),
    ).toBe(true);
  });

  it('never merges two activities claimed by the same provider connection', () => {
    const groups = groupDuplicateActivities([
      activity('a', 0, 30_000, ['garmin']),
      activity('b', 21, 30_001.9, ['garmin']),
    ]);
    expect(groups).toEqual([]);
  });

  it('keeps the earliest row as canonical and does not chain past it', () => {
    const groups = groupDuplicateActivities([
      activity('c', 110, 30_000, ['strava']),
      activity('b', 50, 30_000, ['zwift']),
      activity('a', 0, 30_000, ['garmin']),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.canonical.id).toBe('a');
    // C is 110 s from the canonical row, even though it is 60 s from B.
    expect(groups[0]!.duplicates.map((row) => row.id)).toEqual(['b']);
  });

  it('ignores activities with no provider source', () => {
    const groups = groupDuplicateActivities([
      activity('a', 0, 30_000, []),
      activity('b', 21, 30_001.9, ['zwift']),
    ]);
    expect(groups).toEqual([]);
  });
});
