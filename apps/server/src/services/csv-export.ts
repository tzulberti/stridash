/**
 * CSV exports (user owns their data). Streaming by uuid cursor keeps memory
 * bounded; each kind is one flat table so it opens directly in a spreadsheet.
 * RFC 4180 escaping: quote fields containing commas/quotes/newlines and double
 * embedded quotes.
 */

import { prisma } from '../db.js';
import { serializeRow } from '../serialize.js';

export const CSV_KINDS = ['activities', 'measurements', 'sleep', 'wellness'] as const;
export type CsvKind = (typeof CSV_KINDS)[number];

const PAGE_SIZE = 200;

function escapeCsv(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(values: readonly unknown[]): string {
  return `${values.map(escapeCsv).join(',')}\r\n`;
}

async function* paginate<T extends { id: string }>(
  fetchPage: (take: number, cursor: string | undefined) => Promise<T[]>,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await fetchPage(PAGE_SIZE, cursor);
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

const ACTIVITY_FIELDS = [
  'id',
  'startTime',
  'headline',
  'type',
  'providers',
  'durationS',
  'movingTimeS',
  'distanceM',
  'totalAscentM',
  'totalDescentM',
  'avgSpeedMs',
  'maxSpeedMs',
  'avgHr',
  'maxHr',
  'avgPowerW',
  'maxPowerW',
  'avgCadence',
  'maxCadence',
  'caloriesKcal',
  'trainingLoad',
  'indoor',
  'gearId',
  'notes',
] as const;

const MEASUREMENT_FIELDS = [
  'id',
  'measuredAt',
  'provider',
  'kind',
  'connectionId',
  'weightKg',
  'bodyFatPct',
  'muscleMassKg',
  'skeletalMusclePct',
  'bmi',
  'visceralFatLevel',
  'systolicMmhg',
  'diastolicMmhg',
  'pulseBpm',
  'notes',
] as const;

const SLEEP_FIELDS = [
  'dateKey',
  'startAt',
  'endAt',
  'totalSleepS',
  'deepS',
  'lightS',
  'remS',
  'awakeS',
  'awakeCount',
  'avgSleepStress',
  'avgHr',
  'restingHr',
  'hrvStatus',
  'hrvAvg',
  'bodyBatteryChange',
  'sleepNeedMin',
  'sleepScore',
] as const;

const WELLNESS_FIELDS = [
  'dateKey',
  'steps',
  'stepsGoal',
  'distanceM',
  'floorsAsc',
  'floorsDesc',
  'activeCal',
  'restingCal',
  'totalCal',
  'hrMin',
  'hrMax',
  'restingHr',
  'moderateMin',
  'vigorousMin',
  'intensityGoal',
  'stressAvg',
  'stressMax',
  'batteryMin',
  'batteryMax',
  'batteryLatest',
] as const;

function pick(row: Record<string, unknown>, fields: readonly string[]): unknown[] {
  return fields.map((field) => row[field]);
}

export async function* streamCsvExport(userId: string, kind: CsvKind): AsyncGenerator<string> {
  if (kind === 'activities') {
    yield csvLine(ACTIVITY_FIELDS);
    const rows = paginate((take, cursor) =>
      prisma.activity.findMany({
        where: { userId },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { sources: { select: { connection: { select: { provider: true } } } } },
      }),
    );
    for await (const activity of rows) {
      const flat = {
        ...serializeRow(activity),
        providers: activity.sources.map((s) => s.connection.provider).join(';'),
      };
      yield csvLine(pick(flat, ACTIVITY_FIELDS));
    }
    return;
  }

  if (kind === 'measurements') {
    yield csvLine(MEASUREMENT_FIELDS);
    const rows = paginate((take, cursor) =>
      prisma.measurement.findMany({
        where: { userId },
        orderBy: [{ measuredAt: 'asc' }, { id: 'asc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    for await (const measurement of rows) {
      yield csvLine(pick(serializeRow(measurement), MEASUREMENT_FIELDS));
    }
    return;
  }

  if (kind === 'sleep') {
    yield csvLine(SLEEP_FIELDS);
    const rows = paginate((take, cursor) =>
      prisma.sleepSession.findMany({
        where: { userId },
        orderBy: [{ dateKey: 'asc' }, { id: 'asc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    for await (const sleep of rows) {
      yield csvLine(pick(serializeRow(sleep), SLEEP_FIELDS));
    }
    return;
  }

  yield csvLine(WELLNESS_FIELDS);
  const rows = paginate((take, cursor) =>
    prisma.dailyWellness.findMany({
      where: { userId },
      orderBy: [{ dateKey: 'asc' }, { id: 'asc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );
  for await (const day of rows) {
    yield csvLine(pick(serializeRow(day), WELLNESS_FIELDS));
  }
}

export function csvWebStream(userId: string, kind: CsvKind): ReadableStream<Uint8Array> {
  const iterator = streamCsvExport(userId, kind)[Symbol.asyncIterator]();
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

export function csvFilename(kind: CsvKind, date = new Date()): string {
  return `stridash-${kind}-${date.toISOString().slice(0, 10)}.csv`;
}
