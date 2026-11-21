/**
 * D2 operator script: merge activities that were stored before the tolerance
 * matcher landed (same type, start ±60 s, distance ±100 m, never two rows from
 * the same provider connection).
 *
 * Dry run by default. Pass `--apply` only after reviewing the groups.
 *
 *   npm run data:merge-activities -w @stridash/server
 *   npm run data:merge-activities -w @stridash/server -- --user <uuid> --apply
 */
import { prisma } from '../db.js';
import { mergeDuplicateActivities } from '../services/activity-merge.js';

function usage(): never {
  console.error(
    'Usage: tsx src/scripts/merge-duplicate-activities.ts [--dry-run|--apply] [--user <uuid>]',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { dryRun: boolean; userId?: string } {
  let dryRun = true;
  let userId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') dryRun = false;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--user') {
      userId = argv[++i];
      if (!userId) usage();
    } else if (arg === '--help' || arg === '-h') usage();
    else usage();
  }
  return { dryRun, userId };
}

async function main(): Promise<void> {
  const { dryRun, userId } = parseArgs(process.argv.slice(2));
  const report = await mergeDuplicateActivities({ dryRun, userId });

  console.log(
    `[merge-activities] scanned ${report.scanned} activit${report.scanned === 1 ? 'y' : 'ies'}; ` +
      `${report.groups.length} duplicate group(s)${dryRun ? ' (dry run — no changes)' : ''}`,
  );
  for (const group of report.groups) {
    console.log(
      `  canonical ${group.canonicalId} ${group.type} ${group.startTime}` +
        `${group.distanceM === null ? '' : ` ${group.distanceM}m`}` +
        ` <- ${group.duplicateIds.join(', ')}`,
    );
  }
  if (!dryRun) {
    console.log(
      `[merge-activities] merged ${report.mergedActivities} activit${report.mergedActivities === 1 ? 'y' : 'ies'}; ` +
        `moved ${report.movedSources} source(s), ${report.movedSeries} series; ` +
        `kept ${report.mergedSeries} richer same-provider series, dropped ${report.droppedSeries}; ` +
        `${report.skippedGroups} group(s) and ${report.skippedDuplicates} duplicate(s) skipped because data changed during the run`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[merge-activities] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
