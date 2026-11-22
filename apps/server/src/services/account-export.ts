import { prisma } from '../db.js';
import { serializeRow } from '../serialize.js';

export const EXPORT_FORMAT = 'stridash-export/2';
const EXPORT_NOTE =
  'Per-sample activity series are included in activityDataPoints. Tokens and secrets are never exported.';

// Large enough to avoid a round-trip per row, small enough that one page of
// raw payloads or series JSON cannot dominate memory.
const PAGE_SIZE = 200;
const ACTIVITY_PAGE_SIZE = 100;
const SERIES_PAGE_SIZE = 10;

/**
 * Cursor-paginate a Prisma model by its uuid primary key. The caller keeps a
 * page (not the whole table) in memory; the export stream writes and drops it
 * before fetching the next page.
 */
async function* paginate<T extends { id: string }>(
  fetchPage: (take: number, cursor: string | undefined) => Promise<T[]>,
  pageSize: number,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await fetchPage(pageSize, cursor);
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < pageSize) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

/** Write rows as a comma-separated JSON array without materializing the array. */
async function* jsonArray<T>(
  rows: AsyncIterable<T>,
  map: (row: T) => unknown,
): AsyncGenerator<string> {
  let first = true;
  for await (const row of rows) {
    yield `${first ? '' : ','}${JSON.stringify(map(row))}`;
    first = false;
  }
}

/**
 * Stream a complete account export as one JSON object. Arrays are written one
 * row at a time via cursor pagination, so peak memory is bounded by a page
 * rather than by the account's whole history.
 *
 * Token columns, password hashes and refresh tokens are intentionally never
 * selected. Per-sample series are included as a flat `activityDataPoints`
 * array keyed by `activityId`, avoiding an N+1 query per activity.
 */
export async function* streamAccountExport(userId: string): AsyncGenerator<string> {
  const exportedAt = new Date();
  const [user, preferences, chartPrefs] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true, createdAt: true },
    }),
    prisma.userPreferences.findUnique({ where: { userId } }),
    prisma.chartChannelPref.findMany({
      where: { userId },
      orderBy: [{ provider: 'asc' }, { position: 'asc' }],
    }),
  ]);

  const chartChannels: Record<string, Array<{ key: string; visible: boolean }>> = {};
  for (const pref of chartPrefs) {
    (chartChannels[pref.provider] ??= []).push({ key: pref.channel, visible: pref.visible });
  }

  const header = {
    exportedAt: exportedAt.toISOString(),
    format: EXPORT_FORMAT,
    note: EXPORT_NOTE,
    account: user ? serializeRow(user) : null,
    preferences: {
      units: preferences?.units ?? 'km',
      theme: preferences?.theme ?? 'dark',
      language: preferences?.language ?? 'en',
    },
    chartChannels,
  };
  const headerJson = JSON.stringify(header);
  // Drop the closing brace so the array properties can follow it.
  yield headerJson.slice(0, -1);

  yield ',"connections":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.connection.findMany({
          where: { userId },
          // id is selected only to drive the cursor; it is stripped below to
          // keep the existing export shape. Token columns are never selected.
          select: {
            id: true,
            provider: true,
            providerUserId: true,
            status: true,
            createdAt: true,
            lastSyncedAt: true,
          },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      PAGE_SIZE,
    ),
    ({ id: _id, ...connection }) => connection,
  );

  yield '],"activities":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.activity.findMany({
          where: { userId },
          orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: {
            sources: {
              select: { connectionId: true, sourceActivityId: true, sourceUpdatedAt: true },
            },
          },
        }),
      ACTIVITY_PAGE_SIZE,
    ),
    (activity) => ({ ...serializeRow(activity), sources: activity.sources }),
  );

  yield '],"activityDataPoints":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.activityDataPoint.findMany({
          where: { activity: { userId } },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      SERIES_PAGE_SIZE,
    ),
    serializeRow,
  );

  yield '],"measurements":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.measurement.findMany({
          where: { userId },
          orderBy: [{ measuredAt: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      PAGE_SIZE,
    ),
    serializeRow,
  );

  yield '],"sleepSessions":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.sleepSession.findMany({
          where: { userId },
          orderBy: [{ dateKey: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      PAGE_SIZE,
    ),
    serializeRow,
  );

  yield '],"dailyWellness":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.dailyWellness.findMany({
          where: { userId },
          orderBy: [{ dateKey: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      PAGE_SIZE,
    ),
    serializeRow,
  );

  yield '],"gear":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.gear.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: { components: { orderBy: { createdAt: 'asc' } } },
        }),
      PAGE_SIZE,
    ),
    (gear) => ({ ...serializeRow(gear), components: gear.components.map(serializeRow) }),
  );

  yield '],"devices":[';
  yield* jsonArray(
    paginate(
      (take, cursor) =>
        prisma.device.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      PAGE_SIZE,
    ),
    serializeRow,
  );

  yield ']}';
}

/** Web ReadableStream adapter with backpressure and client-disconnect cleanup. */
export function exportWebStream(userId: string): ReadableStream<Uint8Array> {
  const iterator = streamAccountExport(userId)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

export function exportFilename(date = new Date()): string {
  return `stridash-export-${date.toISOString().slice(0, 10)}.json`;
}
