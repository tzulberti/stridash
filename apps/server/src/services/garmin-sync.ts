/**
 * Garmin sync service: page the activity list, ingest each new activity via
 * its FIT download (scalars + series), deduped user-level on
 * (userId, startTime, type, distance) with per-connection provenance in
 * activity_sources. Every run writes a sync_logs row.
 */

import { prisma } from '../db.js';
import { encryptToken, decryptToken } from '../crypto.js';
import { Prisma } from '../generated/prisma/client.js';
import { GarminError, type DiTokens } from '../providers/garmin/sso.js';
import {
  maybeRefresh,
  listActivities,
  downloadFit,
  listGear,
  listGearActivities,
  listDevices,
  getActivityDevice,
  type GarminActivityRow,
  type GarminGearRow,
} from '../providers/garmin/api.js';
import {
  fitToActivity,
  rowToActivity,
  mapGearRow,
  type Series,
} from '../providers/garmin/normalize.js';
import { extractFitFromDownload } from '../providers/garmin/fitzip.js';
import { parseFitFile } from '../providers/igpsport/fit.js';
import { upsertDevice } from './devices.js';
import type { FitRecord, FitSession } from '../providers/igpsport/normalize.js';
import type { ActivityInput } from '../providers/garmin/normalize.js';
import {
  ensureGarminTokens,
  type GarminConnectionLike as ConnectionLike,
} from './garmin-tokens.js';
import type { Env } from '../env.js';

export type GarminSyncResult = {
  syncLogId: string;
  status: 'OK' | 'PARTIAL' | 'ERROR';
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  failedActivities: string[];
};

export async function syncGarminConnection(
  env: Env,
  connection: ConnectionLike,
): Promise<GarminSyncResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: 'ACTIVITIES', status: 'OK' },
  });
  const result: GarminSyncResult = {
    syncLogId: log.id,
    status: 'OK',
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failedActivities: [],
  };

  try {
    const bearer = await ensureGarminTokens(env, connection);
    const known = await prisma.activitySource.findMany({
      where: { connectionId: connection.id },
      select: { sourceActivityId: true },
    });
    const knownIds = new Set(known.map((s) => s.sourceActivityId));

    // Garmin is the only provider that carries gear: the v2 gear list (bikes,
    // shoes, usage counters, ACTIVE/RETIRED) plus which activities each gear
    // was used in. Failures here degrade to PARTIAL — activities still sync.
    const gearByActivityId = await syncGear(bearer, connection.userId, result);

    // Device model names come from the registration endpoint (deviceId ==
    // the FIT device message's serial). One call per sync; failure only
    // costs the friendly name, never the device row itself.
    const deviceNames = await syncDeviceNames(bearer, result);

    // Garmin pages of 20; a years-deep account needs a few thousand rows of
    // headroom (each page costs ~1 list request; FIT downloads only happen for
    // fresh ids, so rerun sweeps re-paging the list are cheap thanks to dedup)
    const NEW_PAGE_SCAN_LIMIT = Number(process.env.GARMIN_SYNC_MAX_PAGES ?? 150);
    for (let page = 0; page < NEW_PAGE_SCAN_LIMIT; page++) {
      let rows: GarminActivityRow[];
      try {
        rows = await listActivities(bearer, page * 20, 20);
      } catch (err) {
        result.status = 'PARTIAL';
        result.failedActivities.push(`page:${page}`);
        console.error(`[garmin] list page ${page} failed:`, err);
        break;
      }
      if (!rows.length) break;

      for (const row of rows) {
        result.itemsPulled++;
        const id = String(row.activityId);
        if (knownIds.has(id)) continue;
        try {
          await ingestActivity(
            bearer,
            connection,
            row,
            gearByActivityId.get(id) ?? null,
            deviceNames,
          );
          result.itemsCreated++;
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedActivities.push(id);
          console.error(`[garmin] activity ${id} ingest failed:`, err);
        }
      }

      // Stale pages (already-ingested ids) are expected on reruns and deep
      // backfills — Garmin's list is newest-first, so pages long before the
      // account's oldest activity can be stale. Only an EMPTY page means done.
    }

    // Self-healing gear backfill: activities ingested before gear sync
    // existed carry gear_id null. The gear→activity map fixes them bounded
    // per pass (converges over repeated syncs, same pattern as Zwift's
    // upgrade pass). Activities with genuinely no gear stay null forever —
    // cheap re-scan of their provenance rows each run.
    if (gearByActivityId.size > 0) {
      const unassigned = await prisma.activitySource.findMany({
        where: { connectionId: connection.id, activity: { gearId: null } },
        select: { activityId: true, sourceActivityId: true },
        take: 500,
      });
      for (const s of unassigned) {
        const gearId = gearByActivityId.get(s.sourceActivityId);
        if (!gearId) continue;
        await prisma.activity.update({ where: { id: s.activityId }, data: { gearId } });
        result.itemsUpdated++;
      }
    }
    // Self-healing device backfill: activities ingested before devices were
    // tracked have device_id null. The activity detail endpoint's
    // metadataDTO.deviceMetaDataDTO names the recorder cheaply (one JSON GET,
    // no FIT re-download); bounded per pass like the gear pass — converges
    // over repeated syncs.
    {
      const missing = await prisma.activitySource.findMany({
        where: { connectionId: connection.id, activity: { deviceId: null } },
        select: { activityId: true, sourceActivityId: true },
        take: 50,
        orderBy: { activity: { startTime: 'desc' } },
      });
      for (const s of missing) {
        try {
          const dev = await getActivityDevice(bearer, s.sourceActivityId);
          if (!dev) continue; // no recorder reported (manual entries) — stays null
          const deviceId = await upsertDevice(connection.userId, {
            provider: 'GARMIN',
            sourceDeviceId: dev.deviceId,
            manufacturer: dev.manufacturer ? dev.manufacturer.toLowerCase() : null,
            model: deviceNames.get(dev.deviceId) || null,
            raw: dev as unknown as never,
          });
          await prisma.activity.update({ where: { id: s.activityId }, data: { deviceId } });
          result.itemsUpdated++;
        } catch (err) {
          result.status = 'PARTIAL';
          result.failedActivities.push(`device:${s.sourceActivityId}`);
          console.error(`[garmin] device backfill for ${s.sourceActivityId} failed:`, err);
        }
      }
    }
  } catch (err) {
    const detail =
      err instanceof GarminError
        ? { error: err.message, providerDetail: err.detail }
        : { error: String(err) };
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: 'ERROR', errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error('[garmin] sync failed:', detail);
    throw err;
  }

  await prisma.syncLog.update({
    where: { id: result.syncLogId },
    data: {
      status: result.status,
      itemsPulled: result.itemsPulled,
      itemsCreated: result.itemsCreated,
      itemsUpdated: result.itemsUpdated,
      errorDetail: (result.failedActivities.length
        ? { failed: result.failedActivities }
        : null) as never,
      finishedAt: new Date(),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date() },
  });
  return result;
}

/**
 * Sync the user's Garmin gear (gear-service v2) and build the
 * garminActivityId → gear.id map. Gear failures degrade to PARTIAL entries
 * in failedActivities ("gear:list", "gear:<uuid>") — never fatal, activities
 * keep syncing without gear attribution.
 */
async function syncGear(
  bearer: string,
  userId: string,
  result: GarminSyncResult,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let rows: GarminGearRow[];
  try {
    rows = await listGear(bearer);
  } catch (err) {
    result.status = 'PARTIAL';
    result.failedActivities.push('gear:list');
    console.error('[garmin] gear list failed:', err);
    return map;
  }

  const gearIdByUuid = new Map<string, string>();
  for (const row of rows) {
    const input = mapGearRow(userId, row);
    if (!input) continue;
    try {
      const existing = await prisma.gear.findFirst({
        where: { userId, provider: 'GARMIN', sourceGearId: row.uuid },
        select: { id: true, retiredAt: true },
      });
      const gear = existing
        ? await prisma.gear.update({
            where: { id: existing.id },
            data: {
              name: input.name,
              kind: input.kind,
              brand: input.brand,
              model: input.model,
              firstUsedAt: input.firstUsedAt,
              usageType: input.usageType,
              thresholdM: input.thresholdM,
              raw: input.raw as never,
              // RETIRED is a status, not a date — first observed retired wins;
              // a re-activated gear clears it
              retiredAt: row.status === 'RETIRED' ? (existing.retiredAt ?? new Date()) : null,
            },
          })
        : await prisma.gear.create({ data: { ...input, raw: input.raw as never } });
      gearIdByUuid.set(row.uuid, gear.id);
    } catch (err) {
      result.status = 'PARTIAL';
      result.failedActivities.push(`gear:${row.uuid}`);
      console.error(`[garmin] gear ${row.uuid} upsert failed:`, err);
    }
  }

  for (const row of rows) {
    const gearId = gearIdByUuid.get(row.uuid);
    if (!gearId) continue;
    try {
      for (const a of await listGearActivities(bearer, row.uuid)) {
        map.set(String(a.activityId), gearId);
      }
    } catch (err) {
      result.status = 'PARTIAL';
      result.failedActivities.push(`gear:${row.uuid}`);
      console.error(`[garmin] gear ${row.uuid} activity listing failed:`, err);
    }
  }
  return map;
}

async function ingestActivity(
  bearer: string,
  connection: ConnectionLike,
  row: GarminActivityRow,
  gearId: string | null,
  deviceNames: Map<string, string>,
): Promise<void> {
  const id = String(row.activityId);

  let records: FitRecord[] = [];
  let session: FitSession | null = null;
  let device: Awaited<ReturnType<typeof parseFitFile>>['device'] = null;
  try {
    const fit = await downloadFit(bearer, id);
    ({ records, session, device } = await parseFitFile(extractFitFromDownload(fit)));
  } catch (err) {
    // NOTE: surfaces in sync logs as PARTIAL for that id — never fatal
    console.error(`[garmin] FIT unavailable/failed for activity ${id} — using list summary`, err);
  }

  if (records.length === 0) {
    console.warn(`[garmin] activity ${id} ingested WITHOUT a series (FIT empty/unparsed)`);
  }

  // the FIT's creator device_info message = the recording watch; the model
  // name resolves through the registration list (serial → display name)
  let deviceId: string | null = null;
  if (device) {
    try {
      deviceId = await upsertDevice(connection.userId, {
        provider: 'GARMIN',
        sourceDeviceId: device.serialNumber,
        manufacturer: device.manufacturer,
        model: deviceNames.get(device.serialNumber) || null,
        productCode: device.productCode,
        softwareVersion: device.softwareVersion,
        hardwareVersion: device.hardwareVersion,
        raw: device.raw,
      });
    } catch (err) {
      // device attribution is metadata — never fail the activity ingest
      console.error(`[garmin] device upsert failed for activity ${id}:`, err);
    }
  }

  const typeKey = (row.activityType?.typeKey ?? '').toLowerCase();
  const extraIndoor =
    /virtual|indoor|treadmill/.test(typeKey) ||
    (typeKey === 'cycling' && !records.some((r) => r.latDeg !== undefined));

  const parsed = records.length
    ? fitToActivity(row, records, { indoor: extraIndoor, session })
    : null;
  if (parsed) {
    await upsertActivity(connection, id, parsed.activity, parsed.series, gearId, deviceId);
    return;
  }
  if (!row.startTimeGMT) {
    throw new GarminError(
      'CONNECTION',
      `Garmin activity ${id} has neither FIT data nor a start time`,
    );
  }
  await upsertActivity(connection, id, rowToActivity(row), null, gearId, deviceId);
}

/** One device-registration call per sync → serial → model-name map. */
async function syncDeviceNames(
  bearer: string,
  result: { status: 'OK' | 'PARTIAL' | 'ERROR'; failedActivities: string[] },
): Promise<Map<string, string>> {
  try {
    return new Map(
      (await listDevices(bearer))
        .filter((d) => d.productDisplayName)
        .map((d) => [String(d.deviceId), d.productDisplayName as string]),
    );
  } catch (err) {
    result.status = 'PARTIAL';
    result.failedActivities.push('devices:list');
    console.error('[garmin] device registration list failed:', err);
    return new Map();
  }
}

async function upsertActivity(
  connection: ConnectionLike,
  garminId: string,
  activity: ActivityInput,
  series: Series | null,
  gearId: string | null,
  deviceId: string | null = null,
): Promise<void> {
  const dup = await prisma.activity.findFirst({
    where: {
      userId: connection.userId,
      startTime: activity.startTime,
      type: activity.type,
      distanceM: activity.distanceM ?? undefined,
    },
    select: { id: true, gearId: true, deviceId: true },
  });

  if (dup) {
    // provider-sourced fills fill empty slots — never override a value
    // another provider (or the user) already set
    const fill: { gearId?: string; deviceId?: string } = {};
    if (gearId && !dup.gearId) fill.gearId = gearId;
    if (deviceId && !dup.deviceId) fill.deviceId = deviceId;
    if (Object.keys(fill).length > 0) {
      await prisma.activity.update({ where: { id: dup.id }, data: fill });
    }
    await prisma.activitySource.upsert({
      where: { activityId_connectionId: { activityId: dup.id, connectionId: connection.id } },
      create: {
        activityId: dup.id,
        connectionId: connection.id,
        sourceActivityId: garminId,
        sourceUpdatedAt: new Date(),
      },
      update: { sourceActivityId: garminId, sourceUpdatedAt: new Date() },
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const created = await tx.activity.create({
      data: { ...toActivityCreate(connection.userId, activity, deviceId), gearId },
    });

    await tx.activitySource.upsert({
      where: { activityId_connectionId: { activityId: created.id, connectionId: connection.id } },
      create: {
        activityId: created.id,
        connectionId: connection.id,
        sourceActivityId: garminId,
        sourceUpdatedAt: new Date(),
      },
      update: { sourceActivityId: garminId },
    });

    if (series) {
      await tx.activityDataPoint.upsert({
        where: { activityId_provider: { activityId: created.id, provider: 'GARMIN' } },
        create: {
          activityId: created.id,
          provider: 'GARMIN',
          sampleCount: series.timeMs.length,
          series: series as unknown as Prisma.InputJsonValue,
        },
        update: {
          sampleCount: series.timeMs.length,
          series: series as unknown as Prisma.InputJsonValue,
        },
      });
    }
  });
}

function toActivityCreate(userId: string, input: ActivityInput, deviceId: string | null = null) {
  return {
    userId,
    headline: input.headline,
    type: input.type,
    startTime: input.startTime,
    durationS: input.durationS,
    movingTimeS: input.movingTimeS,
    distanceM: input.distanceM ?? null,
    avgSpeedMs: input.avgSpeedMs ?? null,
    maxSpeedMs: input.maxSpeedMs ?? null,
    totalAscentM: input.totalAscentM ?? null,
    totalDescentM: input.totalDescentM ?? null,
    elevationHighM: input.elevationHighM ?? null,
    elevationLowM: input.elevationLowM ?? null,
    avgHr: input.avgHr,
    maxHr: input.maxHr,
    avgPowerW: input.avgPowerW,
    maxPowerW: input.maxPowerW,
    avgCadence: input.avgCadence,
    maxCadence: input.maxCadence,
    trainingLoad: input.trainingLoad ?? null,
    caloriesKcal: input.caloriesKcal,
    indoor: input.indoor,
    deviceId,
    hrZonesMin: (input.hrZonesMin as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
    raw: input.raw as unknown as Prisma.InputJsonValue,
  };
}

// series-from-records builder lives in providers/garmin/normalize.js
