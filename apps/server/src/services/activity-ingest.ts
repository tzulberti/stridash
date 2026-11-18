/**
 * Shared activity ingest: the single place that decides whether an incoming
 * provider activity becomes a new `activities` row or attaches to an existing
 * one. Used by the Garmin, Zwift and iGPSPORT sync services.
 *
 * Identity rules (fixes D1/D2 matching):
 *  1. Provider-side identity wins: `activity_sources (connection_id,
 *     source_activity_id)` is unique, so re-ingesting the same provider
 *     activity always resolves to the row it was first stored as.
 *  2. Otherwise match the user's activities of the same type: start within
 *     60 s and distance within 100 m (provider clocks disagree — the real
 *     Garmin vs Zwift case was 21 s / 1.9 m). With no distance to compare,
 *     only an exact start time matches.
 *  3. Never fold a new activity into one this same connection already claims
 *     under a different provider id — those are two real activities.
 *
 * Every decision runs under a transaction-scoped Postgres advisory lock keyed
 * on the user, so two concurrent syncs cannot both miss the match and insert
 * (the old `findFirst` + `create` race). The lock is per user, not per app
 * instance: multiple server processes serialize too.
 *
 * Database notes:
 *  - `distance_m` is nullable, and Postgres treats NULLs as distinct in a
 *    regular unique constraint, which is why the old exact-key unique could
 *    not prevent duplicate null-distance workouts. Matching null distance by
 *    exact start + type closes that hole at ingest; a nullable-safe unique
 *    index is intentionally not added because existing duplicates would block
 *    the migration (the D2 merge pass collapses those first).
 */

import { prisma } from '../db.js';
import type { ActivityType, Prisma } from '../generated/prisma/client.js';

const MATCH_WINDOW_MS = 60_000;
const MATCH_DISTANCE_M = 100;

export interface ActivityIdentity {
  userId: string;
  connectionId: string;
  sourceActivityId: string;
  type: ActivityType;
  startTime: Date;
  /** Meters; null when the provider reports no distance (e.g. strength). */
  distanceM: number | null;
}

export interface MatchedActivity {
  id: string;
  gearId: string | null;
  deviceId: string | null;
}

export interface IngestHandlers {
  /**
   * Insert the activity row (and its provider series) inside the surrounding
   * transaction. Only called when no existing activity matches.
   */
  create: (tx: Prisma.TransactionClient) => Promise<{ id: string }>;
  /**
   * Called when an existing activity is found (provider identity or tolerant
   * match). Fill empty gear/device slots; never overwrite values another
   * provider or the user already set. Provenance is registered by this
   * service, not the handler.
   */
  onMatch?: (tx: Prisma.TransactionClient, existing: MatchedActivity) => Promise<void>;
}

export interface IngestResult {
  activityId: string;
  created: boolean;
}

export async function ingestActivity(
  identity: ActivityIdentity,
  handlers: IngestHandlers,
): Promise<IngestResult> {
  return prisma.$transaction(
    async (tx) => {
      // Serialize activity ingest per user (cross-process as well: advisory
      // locks live in Postgres). Released when the transaction commits.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identity.userId}))`;

      // 1. Provider identity — the same source activity is always the same row.
      const bySource = await tx.activitySource.findUnique({
        where: {
          connectionId_sourceActivityId: {
            connectionId: identity.connectionId,
            sourceActivityId: identity.sourceActivityId,
          },
        },
        select: {
          activityId: true,
          activity: { select: { gearId: true, deviceId: true } },
        },
      });

      if (bySource) {
        await tx.activitySource.update({
          where: {
            activityId_connectionId: {
              activityId: bySource.activityId,
              connectionId: identity.connectionId,
            },
          },
          data: { sourceUpdatedAt: new Date() },
        });
        await handlers.onMatch?.(tx, { id: bySource.activityId, ...bySource.activity });
        return { activityId: bySource.activityId, created: false };
      }

      // 2. Cross-provider tolerant match.
      const match = await findTolerantMatch(tx, identity);
      if (match) {
        await tx.activitySource.create({
          data: {
            activityId: match.id,
            connectionId: identity.connectionId,
            sourceActivityId: identity.sourceActivityId,
            sourceUpdatedAt: new Date(),
          },
        });
        await handlers.onMatch?.(tx, match);
        return { activityId: match.id, created: false };
      }

      // 3. New activity.
      const created = await handlers.create(tx);
      await tx.activitySource.create({
        data: {
          activityId: created.id,
          connectionId: identity.connectionId,
          sourceActivityId: identity.sourceActivityId,
          sourceUpdatedAt: new Date(),
        },
      });
      return { activityId: created.id, created: true };
    },
    { timeout: 15_000 },
  );
}

async function findTolerantMatch(
  tx: Prisma.TransactionClient,
  identity: ActivityIdentity,
): Promise<MatchedActivity | null> {
  const startMs = identity.startTime.getTime();

  const where: Prisma.ActivityWhereInput = {
    userId: identity.userId,
    type: identity.type,
    // do not collapse a second real activity recorded by the same provider
    sources: { none: { connectionId: identity.connectionId } },
  };

  if (identity.distanceM == null) {
    // Without a distance there is nothing to disambiguate beyond the start.
    where.startTime = identity.startTime;
  } else {
    where.startTime = {
      gte: new Date(startMs - MATCH_WINDOW_MS),
      lte: new Date(startMs + MATCH_WINDOW_MS),
    };
    where.OR = [
      {
        distanceM: {
          gte: identity.distanceM - MATCH_DISTANCE_M,
          lte: identity.distanceM + MATCH_DISTANCE_M,
        },
      },
      // an earlier row stored without a distance can be the same activity —
      // but only at the exact start, again to avoid false merges
      { distanceM: null, startTime: identity.startTime },
    ];
  }

  const candidates = await tx.activity.findMany({
    where,
    select: {
      id: true,
      startTime: true,
      distanceM: true,
      gearId: true,
      deviceId: true,
    },
    orderBy: { startTime: 'asc' },
    take: 20,
  });

  if (!candidates.length) return null;

  // Closest start wins (the 21 s Garmin/Zwift case); distance breaks ties.
  const best = candidates
    .map((candidate) => ({
      candidate,
      dt: Math.abs(candidate.startTime.getTime() - startMs),
      dd:
        candidate.distanceM == null || identity.distanceM == null
          ? 0
          : Math.abs(Number(candidate.distanceM) - identity.distanceM),
    }))
    .sort((a, b) => a.dt - b.dt || a.dd - b.dd)[0]!.candidate;

  return { id: best.id, gearId: best.gearId, deviceId: best.deviceId };
}
