import type { ActivityType } from '../generated/prisma/client.js';

/** The fields the merge decision needs from one stored activity. */
export interface MergeActivity {
  id: string;
  userId: string;
  type: ActivityType;
  startTime: Date;
  distanceM: number | null;
  createdAt: Date;
  /** Connection rows that claim this activity. Empty rows are never merged. */
  sourceConnectionIds: string[];
}

export interface MergeGroup {
  canonical: MergeActivity;
  duplicates: MergeActivity[];
}

export const MATCH_WINDOW_MS = 60_000;
export const MATCH_DISTANCE_M = 100;

/** Same rule as ingestActivity: tolerance match, or exact start when a
 * distance is missing. */
export function activitiesMatch(a: MergeActivity, b: MergeActivity): boolean {
  if (a.userId !== b.userId || a.type !== b.type) return false;
  const dt = Math.abs(a.startTime.getTime() - b.startTime.getTime());
  if (dt > MATCH_WINDOW_MS) return false;
  if (a.distanceM == null || b.distanceM == null) return dt === 0;
  return Math.abs(a.distanceM - b.distanceM) <= MATCH_DISTANCE_M;
}

function disjoint(a: Set<string>, b: string[]): boolean {
  return b.every((connectionId) => !a.has(connectionId));
}

/**
 * Group stored activities that the ingest-time matcher would now collapse.
 * The canonical row is the earliest start (then earliest creation); a
 * candidate only merges when it matches that canonical row and its provider
 * connections do not overlap the group's — two activities from the same
 * provider connection are real distinct workouts, not duplicates.
 */
export function groupDuplicateActivities(activities: MergeActivity[]): MergeGroup[] {
  const sorted = [...activities].sort(
    (a, b) =>
      a.userId.localeCompare(b.userId) ||
      a.type.localeCompare(b.type) ||
      a.startTime.getTime() - b.startTime.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );

  const groups: MergeGroup[] = [];
  for (const activity of sorted) {
    if (activity.sourceConnectionIds.length === 0) continue;
    const group = groups.find((candidate) => {
      if (!activitiesMatch(candidate.canonical, activity)) return false;
      const connections = new Set(candidate.canonical.sourceConnectionIds);
      for (const duplicate of candidate.duplicates) {
        for (const id of duplicate.sourceConnectionIds) connections.add(id);
      }
      return disjoint(connections, activity.sourceConnectionIds);
    });

    if (group) group.duplicates.push(activity);
    else groups.push({ canonical: activity, duplicates: [] });
  }

  return groups.filter((group) => group.duplicates.length > 0);
}
