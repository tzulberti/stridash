/**
 * iGPSPORT sync service: paginated discovery via queryMyActivity, then a
 * FIT download per new ride, upserting `activities` (+ `activity_sources`,
 * + `activity_data_points` series) keyed on the exact dedup rules in the
 * data model. Every run writes a sync_logs row.
 */

import { prisma } from "../db.js";
import { encryptToken, decryptToken } from "../crypto.js";
import { Prisma } from "../generated/prisma/client.js";
import {
  IgpSportError,
  IgpSportClient,
  peekJwtClaims,
  type IgpSportActivityRow,
} from "../providers/igpsport/client.js";
import { regionForKey } from "../providers/igpsport/regions.js";
import { type ActivityInput, type FitRecord, fitToActivity } from "../providers/igpsport/normalize.js";
import { parseFitSeries } from "../providers/igpsport/fit.js";
import type { Env } from "../env.js";

interface ConnectionLike {
  id: string;
  userId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  lastSyncedAt: Date | null;
  status: string;
  config: unknown;
}

export type IgpSportSyncResult = {
  syncLogId: string;
  status: "OK" | "PARTIAL" | "ERROR";
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  failedRides: string[];
};

/** Read the { igpsport: { region } } config blob. */
function regionKeyOf(connection: ConnectionLike): string {
  const cfg = connection.config as { igpsport?: { region?: string } } | null;
  return cfg?.igpsport?.region ?? "intl";
}

/** Activity scalars → Prisma create payload (jsonb + nulls handled). */
function toActivityCreate(userId: string, connectionId: string, input: ActivityInput) {
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
    trainingLoad: null, // provider hasn't delivered a TSS-like number for FIT runs
    caloriesKcal: input.caloriesKcal,
    indoor: input.indoor,
    raw: input.raw as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Ensure an authenticated client: reuse the stored access JWT if it has not
 * expired, otherwise re-login with the stored (AES-encrypted) account
 * password. Writes the fresh token pair + expiry back to the connection row.
 */
async function ensureClient(env: Env, connection: ConnectionLike): Promise<IgpSportClient> {
  if (connection.status === "REVOKED") {
    throw new IgpSportError("Connection revoked — reconnect the iGPSPORT account first");
  }
  const region = regionForKey(regionKeyOf(connection))!;
  const client = new IgpSportClient(region);

  const username = await (async () => {
    const cfg = connection.config as { igpsport?: { username?: string } } | null;
    return cfg?.igpsport?.username ?? "";
  })();

  const expMs = connection.tokenExpiresAt?.getTime() ?? 0;
  const tokenFresh = connection.accessTokenEnc && Date.now() < expMs - 60_000;
  if (tokenFresh) {
    client.withAccessToken(decryptToken(connection.accessTokenEnc!, env.STRIDASH_ENC_KEY));
    return client;
  }

  // (Re-)login. The account password is persisted encrypted in
  // refreshTokenEnc (the protocol has no refresh-token grant we can rely on).
  if (!connection.refreshTokenEnc) {
    throw new IgpSportError("No stored iGPSPORT credentials — reconnect the account");
  }
  const password = decryptToken(connection.refreshTokenEnc, env.STRIDASH_ENC_KEY);
  const login = await client.login(username, password);
  const claims = peekJwtClaims(login.access_token);
  const expiresAt = claims.exp
    ? new Date(claims.exp * 1000)
    : new Date(Date.now() + (login.expires_in ?? 3600) * 1000);

  await prisma.connection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptToken(login.access_token, env.STRIDASH_ENC_KEY),
      // keep the password blob as-is (refreshTokenEnc)
      tokenExpiresAt: expiresAt,
      status: "ACTIVE",
    },
  });
  return client.withAccessToken(login.access_token);
}

/**
 * Run one iGPSPORT sync. Pages through the activity list starting at the
 * newest ride; stops at the first page whose rows are all already known.
 */
export async function syncIgpSportConnection(env: Env, connection: ConnectionLike): Promise<IgpSportSyncResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: "ACTIVITIES", status: "OK" },
  });
  const result: IgpSportSyncResult = {
    syncLogId: log.id,
    status: "OK",
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failedRides: [],
  };

  try {
    const client = await ensureClient(env, connection);
    const known = await prisma.activitySource.findMany({
      where: { connectionId: connection.id },
      select: { sourceActivityId: true },
    });
    const knownIds = new Set(known.map((s) => s.sourceActivityId));

    let stalePageStreak = 0;
    const NEW_PAGE_SCAN_LIMIT = 5; // keep first-syncs bounded
    for (let page = 1; page <= NEW_PAGE_SCAN_LIMIT; page++) {
      let rows: IgpSportActivityRow[];
      try {
        rows = await client.listActivities(page, 20);
      } catch (err) {
        // Partial failure: keep what we have, note the failure
        result.status = "PARTIAL";
        result.failedRides.push(`page:${page}`);
        console.error(`[igpsport] list page ${page} failed:`, err);
        break;
      }
      if (!rows.length) break;

      let freshCount = 0;
      for (const row of rows) {
        result.itemsPulled++;
        if (knownIds.has(String(row.rideId))) continue;
        freshCount++;
        try {
          await ingestRide(client, connection, row);
          result.itemsCreated++;
        } catch (err) {
          result.status = "PARTIAL";
          result.failedRides.push(String(row.rideId));
          console.error(`[igpsport] ride ${row.rideId} ingest failed:`, err);
        }
      }

      if (freshCount === 0) {
        stalePageStreak++;
        if (stalePageStreak >= 2) break; // everything from here on is old
      } else {
        stalePageStreak = 0;
      }
    }
  } catch (err) {
    const detail = err instanceof IgpSportError ? { error: err.message, providerDetail: err.detail } : { error: String(err) };
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: "ERROR", errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error("[igpsport] sync failed:", detail);
    throw err;
  }

  await prisma.syncLog.update({
    where: { id: result.syncLogId },
    data: {
      status: result.status,
      itemsPulled: result.itemsPulled,
      itemsCreated: result.itemsCreated,
      itemsUpdated: result.itemsUpdated,
      errorDetail: (result.failedRides.length ? { failed: result.failedRides } : null) as never,
      finishedAt: new Date(),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date() },
  });
  return result;
}

/** Download + parse one ride's FIT and upsert activity/streams/sources. */
async function ingestRide(
  client: IgpSportClient,
  connection: ConnectionLike,
  row: IgpSportActivityRow,
): Promise<void> {
  const rideId = String(row.rideId);

  let fitBuf: Buffer | null = null;
  try {
    fitBuf = await client.downloadFit(rideId);
  } catch (err) {
    console.error(`[igpsport] FIT unavailable for ride ${rideId} — using row summary`, err);
  }

  if (fitBuf) {
    let records: FitRecord[] = [];
    try {
      records = await parseFitSeries(fitBuf);
    } catch (err) {
      console.error(`[igpsport] FIT parse failed for ride ${rideId} — using row summary`, err);
    }
    if (records.length) {
      const rowIndoor = (row as Record<string, unknown>).indoor === 1;
      const parsed = fitToActivity(row, records, { indoor: rowIndoor });
      if (parsed) await upsertActivity(connection, rideId, parsed.activity, parsed.series);
      return;
    }
  }

  // Fallback: row summary only (no FIT / parse failed). startTime is stored
  // as-is (string without offset) — dedup still works because the ride id is
  // registered in activity_sources first anyway.
  const startTime = row.startTime
    ? new Date(`${row.startTime.replace(" ", "T")}Z`) // treat as UTC; corrected when FIT arrives
    : new Date(0);
  const activity: ActivityInput = {
    headline: row.title ?? row.name ?? "iGPSPORT ride",
    type: row.exerciseType === 0 ? "RIDE" : "OTHER",
    startTime,
    durationS: row.totalMovingTime ?? row.recordTime ?? 0,
    movingTimeS: row.totalMovingTime ?? null,
    distanceM: row.rideDistance ?? null,
    avgSpeedMs: row.avgSpeed ?? null,
    maxSpeedMs: row.maxSpeed ?? null,
    totalAscentM: row.totalAscent ?? null,
    totalDescentM: row.totalDescent ?? null,
    elevationHighM: row.maxAlt ?? null,
    elevationLowM: row.minAlt ?? null,
    avgHr: null,
    maxHr: null,
    avgPowerW: null,
    maxPowerW: null,
    avgCadence: null,
    maxCadence: null,
    caloriesKcal: null,
    indoor: false,
    raw: { provider: "IGPSPORT", sourceRow: row, approximateStartTime: true },
  };
  await upsertActivity(connection, rideId, activity, null);
}

interface StreamArray {
  timeMs: number[];
  [key: string]: number[];
}

/**
 * Upsert one activity row (+ series + source registration).
 *
 * Dedup: the user-level heuristic key (userId, startTime, type, distance)
 * catches the same ride arriving from another provider; per-source identity
 * lives in activity_sources (unique per connection).
 */
async function upsertActivity(
  connection: ConnectionLike,
  rideId: string,
  activity: ActivityInput,
  series: StreamArray | null,
): Promise<void> {
  const dup = await prisma.activity.findFirst({
    where: {
      userId: connection.userId,
      startTime: activity.startTime,
      type: activity.type,
      distanceM: activity.distanceM ?? undefined,
    },
    select: { id: true },
  });

  if (dup) {
    // another provider already stored this ride — just register provenance
    await prisma.activitySource.upsert({
      where: {
        activityId_connectionId: { activityId: dup.id, connectionId: connection.id },
      },
      create: { activityId: dup.id, connectionId: connection.id, sourceActivityId: rideId, sourceUpdatedAt: new Date() },
      update: { sourceActivityId: rideId, sourceUpdatedAt: new Date() },
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const created = await tx.activity.create({ data: toActivityCreate(connection.userId, connection.id, activity) });

    await tx.activitySource.upsert({
      where: {
        activityId_connectionId: { activityId: created.id, connectionId: connection.id },
      },
      create: { activityId: created.id, connectionId: connection.id, sourceActivityId: rideId, sourceUpdatedAt: new Date() },
      update: { sourceActivityId: rideId },
    });

    if (series) {
      await tx.activityDataPoint.upsert({
        where: {
          activityId_provider: { activityId: created.id, provider: "IGPSPORT" },
        },
        create: {
          activityId: created.id,
          provider: "IGPSPORT",
          sampleCount: (series.timeMs as number[]).length,
          series: series as unknown as Prisma.InputJsonValue,
        },
        update: {
          sampleCount: (series.timeMs as number[]).length,
          series: series as unknown as Prisma.InputJsonValue,
        },
      });
    }
  });
}
