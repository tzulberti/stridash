import { prisma } from '../db.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  activitiesMatch,
  groupDuplicateActivities,
  type MergeActivity,
  type MergeGroup,
} from './activity-merge-groups.js';

/**
 * D2 one-time merge pass: collapse activities stored before the tolerance
 * matcher landed. New duplicates are prevented by `activity-ingest.ts`; this
 * service only touches existing rows and is designed to be run by an operator
 * with `--dry-run` first.
 *
 * For each group we keep the canonical (earliest) activity, move every
 * `activity_sources` row onto it, keep one series per provider (the richer
 * sample count wins), then delete the duplicate row. Scalar performance fields
 * stay as stored on the canonical row; gear/device links fill only when the
 * canonical row has none.
 */

export interface MergeReportGroup {
  canonicalId: string;
  duplicateIds: string[];
  type: string;
  startTime: string;
  distanceM: number | null;
}

export interface MergeReport {
  dryRun: boolean;
  scanned: number;
  groups: MergeReportGroup[];
  mergedActivities: number;
  movedSources: number;
  movedSeries: number;
  mergedSeries: number;
  droppedSeries: number;
  skippedGroups: number;
  skippedDuplicates: number;
}

export interface MergeOptions {
  dryRun?: boolean;
  /** Limit to one user; omit to scan every user with activities. */
  userId?: string;
}

function toMergeActivity(row: {
  id: string;
  userId: string;
  type: MergeActivity['type'];
  startTime: Date;
  distanceM: Prisma.Decimal | null;
  createdAt: Date;
  sources: Array<{ connectionId: string }>;
}): MergeActivity {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    startTime: row.startTime,
    distanceM: row.distanceM === null ? null : Number(row.distanceM),
    createdAt: row.createdAt,
    sourceConnectionIds: row.sources.map((source) => source.connectionId),
  };
}

function reportGroup(group: MergeGroup): MergeReportGroup {
  return {
    canonicalId: group.canonical.id,
    duplicateIds: group.duplicates.map((duplicate) => duplicate.id),
    type: group.canonical.type,
    startTime: group.canonical.startTime.toISOString(),
    distanceM: group.canonical.distanceM,
  };
}

export async function mergeDuplicateActivities(options: MergeOptions = {}): Promise<MergeReport> {
  const dryRun = options.dryRun ?? false;
  const userIds = options.userId
    ? [options.userId]
    : (
        await prisma.activity.findMany({
          distinct: ['userId'],
          select: { userId: true },
        })
      ).map((row) => row.userId);

  const report: MergeReport = {
    dryRun,
    scanned: 0,
    groups: [],
    mergedActivities: 0,
    movedSources: 0,
    movedSeries: 0,
    mergedSeries: 0,
    droppedSeries: 0,
    skippedGroups: 0,
    skippedDuplicates: 0,
  };

  for (const userId of userIds) {
    const rows = await prisma.activity.findMany({
      where: { userId },
      orderBy: [{ type: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        type: true,
        startTime: true,
        distanceM: true,
        createdAt: true,
        sources: { select: { connectionId: true } },
      },
    });
    report.scanned += rows.length;

    const groups = groupDuplicateActivities(rows.map(toMergeActivity));
    report.groups.push(...groups.map(reportGroup));
    if (dryRun) continue;

    for (const group of groups) {
      const merged = await mergeOneGroup(
        userId,
        group.canonical.id,
        group.duplicates.map((d) => d.id),
        report,
      );
      if (!merged) report.skippedGroups += 1;
    }
  }

  return report;
}

async function mergeOneGroup(
  userId: string,
  canonicalId: string,
  duplicateIds: string[],
  report: MergeReport,
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      // Serialize with ingest/other merge runs for this user.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`activity-merge:${userId}`}))`;

      const canonical = await tx.activity.findUnique({
        where: { id: canonicalId },
        select: {
          id: true,
          userId: true,
          type: true,
          startTime: true,
          distanceM: true,
          createdAt: true,
          gearId: true,
          deviceId: true,
          sources: { select: { connectionId: true } },
        },
      });
      if (!canonical) return false;

      const duplicates = await tx.activity.findMany({
        where: { id: { in: duplicateIds }, userId },
        orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          userId: true,
          type: true,
          startTime: true,
          distanceM: true,
          createdAt: true,
          gearId: true,
          deviceId: true,
          sources: { select: { connectionId: true } },
          dataPoints: {
            select: { id: true, provider: true, sampleCount: true, series: true, raw: true },
          },
        },
      });

      const canonicalMatch = toMergeActivity(canonical);
      const groupConnections = new Set(canonicalMatch.sourceConnectionIds);
      let gearId = canonical.gearId;
      let deviceId = canonical.deviceId;

      for (const duplicate of duplicates) {
        const candidate = toMergeActivity(duplicate);
        const incompatible =
          !activitiesMatch(canonicalMatch, candidate) ||
          candidate.sourceConnectionIds.some((connectionId) => groupConnections.has(connectionId));
        if (incompatible) {
          report.skippedDuplicates += 1;
          continue;
        }

        for (const point of duplicate.dataPoints) {
          const existing = await tx.activityDataPoint.findUnique({
            where: {
              activityId_provider: {
                activityId: canonical.id,
                provider: point.provider,
              },
            },
            select: { id: true, sampleCount: true },
          });

          if (!existing) {
            await tx.activityDataPoint.update({
              where: { id: point.id },
              data: { activityId: canonical.id },
            });
            report.movedSeries += 1;
          } else if (point.sampleCount > existing.sampleCount) {
            await tx.activityDataPoint.update({
              where: { id: existing.id },
              data: {
                sampleCount: point.sampleCount,
                series: point.series as Prisma.InputJsonValue,
                raw: point.raw === null ? Prisma.DbNull : (point.raw as Prisma.InputJsonValue),
              },
            });
            await tx.activityDataPoint.delete({ where: { id: point.id } });
            report.mergedSeries += 1;
          } else {
            await tx.activityDataPoint.delete({ where: { id: point.id } });
            report.droppedSeries += 1;
          }
        }

        const moved = await tx.activitySource.updateMany({
          where: { activityId: duplicate.id },
          data: { activityId: canonical.id },
        });
        report.movedSources += moved.count;
        for (const connectionId of candidate.sourceConnectionIds)
          groupConnections.add(connectionId);

        if (gearId === null && duplicate.gearId !== null) gearId = duplicate.gearId;
        if (deviceId === null && duplicate.deviceId !== null) deviceId = duplicate.deviceId;

        await tx.activity.delete({ where: { id: duplicate.id } });
        report.mergedActivities += 1;
      }

      if (gearId !== canonical.gearId || deviceId !== canonical.deviceId) {
        await tx.activity.update({
          where: { id: canonical.id },
          data: { gearId, deviceId },
        });
      }

      return true;
    },
    { timeout: 30_000 },
  );
}
