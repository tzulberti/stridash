/**
 * Zwift connection sync — activities in, per-second streams alongside.
 *
 * Token strategy differs from iGPSPORT (no usable refresh grant there):
 * Zwift's Keycloak-style endpoint DOES have one, and it rotates the refresh
 * token on every use (`refreshTokenEnc` holds the latest grant, never data).
 * The access JWT is refreshed when the stored expiry nears; both new tokens
 * are persisted after each rotation.
 *
 * Streams arrive via detail.fitnessData.fullDataUrl on the graph-carrying
 * activities; they are fetched at ingest time. Older/failed stream fetches
 * degrade to summary-only rows (same fallback as iGPSPORT's FIT path).
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { decryptToken, encryptToken } from "../crypto.js";
import {
  ZwiftClient,
  ZwiftError,
  zwiftRefresh,
  type ZwiftActivity,
} from "../providers/zwift/client.js";
import { mapZwiftActivityRow, toZwiftSeries, type ZwiftSeries } from "../providers/zwift/normalize.js";
import { redactProviderDetail } from "../redact.js";
import type { ActivityInput } from "../providers/igpsport/normalize.js";
import type { Env } from "../env.js";

export type ZwiftSyncResult = {
  syncLogId: string;
  status: "OK" | "PARTIAL" | "ERROR";
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  failedActivities: string[];
};

interface ConnectionLike {
  id: string;
  userId: string;
  providerUserId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt?: Date | unknown;
  status: string;
}

/** Rehydrate or rotate the stored token pair and return a ready client. */
async function ensureClient(env: Env, connection: ConnectionLike): Promise<ZwiftClient> {
  if (connection.status === "REVOKED") {
    throw new ZwiftError("CONNECTION", "Connection revoked — reconnect the Zwift account first");
  }
  if (!connection.providerUserId) {
    throw new ZwiftError("CONNECTION", "Connection has no Zwift athlete id — reconnect");
  }

  const expMs = (connection.tokenExpiresAt as Date | null | undefined)?.getTime() ?? 0;
  const client = new ZwiftClient(connection.providerUserId);

  const storedAccess = connection.accessTokenEnc
    ? decryptToken(connection.accessTokenEnc, env.STRIDASH_ENC_KEY)
    : "";
  if (storedAccess && Date.now() < expMs - 60_000) {
    return client.withAccessToken(storedAccess); // fast path: still valid
  }

  // rotate: the refresh grant must use client_id "Zwift Game Client" (baked in)
  const refreshToken = connection.refreshTokenEnc
    ? decryptToken(connection.refreshTokenEnc, env.STRIDASH_ENC_KEY)
    : "";
  if (!refreshToken) {
    throw new ZwiftError("CONNECTION", "No stored Zwift credentials — reconnect the account");
  }
  const tokens = await zwiftRefreshWithPersist(env, connection, refreshToken);
  return client.withAccessToken(tokens.accessToken);
}

/** One refresh round-trip; persists the rotated pair before returning. */
async function zwiftRefreshWithPersist(env: Env, connection: ConnectionLike, refreshToken: string) {
  const tokens = await zwiftRefresh(refreshToken);
  await prisma.connection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptToken(tokens.accessToken, env.STRIDASH_ENC_KEY),
      refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken, env.STRIDASH_ENC_KEY) : undefined,
      tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      status: "ACTIVE",
    },
  });
  return tokens;
}

/** Fetch the URL (resolved against the API base) and map it to Stridash series.
 * activityId MUST be the exact-precision id_str: these ids exceed Number's
 * safe range, and a rounded-off numeric id 404s server-side. */
async function fetchSeries(client: ZwiftClient, activityId: string, act: ZwiftActivity): Promise<ZwiftSeries | null> {
  let fullDataUrl = act.fitnessData?.fullDataUrl;
  if (!fullDataUrl) {
    // the list row often omits it — the detail version carries it
    const detail = await client.getActivityDetail(activityId);
    fullDataUrl = detail.fitnessData?.fullDataUrl;
  }
  if (!fullDataUrl) return null;
  const raw = await client.getFitnessData(fullDataUrl);
  return toZwiftSeries(raw);
}

/** Persist (or replace) an activity's ZWIFT series row. */
async function storeSeries(activityId: string, series: ZwiftSeries): Promise<void> {
  await prisma.activityDataPoint.upsert({
    where: { activityId_provider: { activityId, provider: "ZWIFT" } },
    create: {
      activityId,
      provider: "ZWIFT",
      sampleCount: series.timeMs.length,
      series: series as unknown as Prisma.InputJsonValue,
    },
    update: {
      sampleCount: series.timeMs.length,
      series: series as unknown as Prisma.InputJsonValue,
    },
  });
}

/** Upsert one activity row (+ series + source registration). Dedup mirrors
 * iGPSPORT: the user-level heuristic key catches the same ride from other
 * providers; per-source identity lives in activity_sources. */
async function upsertZwiftActivity(
  connection: ConnectionLike,
  externalId: string,
  activity: ActivityInput,
  series: ZwiftSeries | null,
): Promise<"created" | "updated"> {
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
    // another provider stored this activity — register provenance only
    await prisma.activitySource.upsert({
      where: { activityId_connectionId: { activityId: dup.id, connectionId: connection.id } },
      create: { activityId: dup.id, connectionId: connection.id, sourceActivityId: externalId, sourceUpdatedAt: new Date() },
      update: { sourceUpdatedAt: new Date() },
    });
    return "updated";
  }

  const created = await prisma.activity.create({
    data: {
      userId: connection.userId,
      headline: activity.headline,
      type: activity.type,
      startTime: activity.startTime,
      durationS: activity.durationS,
      movingTimeS: activity.movingTimeS,
      distanceM: activity.distanceM ?? null,
      avgSpeedMs: activity.avgSpeedMs ?? null,
      maxSpeedMs: activity.maxSpeedMs ?? null,
      totalAscentM: activity.totalAscentM ?? null,
      totalDescentM: activity.totalDescentM ?? null,
      elevationHighM: activity.elevationHighM ?? null,
      elevationLowM: activity.elevationLowM ?? null,
      avgHr: activity.avgHr,
      maxHr: activity.maxHr,
      avgPowerW: activity.avgPowerW,
      maxPowerW: activity.maxPowerW,
      avgCadence: activity.avgCadence,
      maxCadence: activity.maxCadence,
      trainingLoad: null, // Zwift does not report a TSS-like number
      caloriesKcal: activity.caloriesKcal,
      indoor: activity.indoor,
      raw: activity.raw as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  await prisma.activitySource.upsert({
    where: { activityId_connectionId: { activityId: created.id, connectionId: connection.id } },
    create: { activityId: created.id, connectionId: connection.id, sourceActivityId: externalId, sourceUpdatedAt: new Date() },
    update: { sourceUpdatedAt: new Date() },
  });

  if (series) {
    await storeSeries(created.id, series);
  }
  return "created";
}

/** Pages the newest activities first; stops when nothing new for 2 pages. */
export async function syncZwiftConnection(env: Env, connection: ConnectionLike): Promise<ZwiftSyncResult> {
  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: "ACTIVITIES", status: "OK" },
  });
  const result: ZwiftSyncResult = {
    syncLogId: log.id,
    status: "OK",
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    failedActivities: [],
  };

  try {
    const client = await ensureClient(env, connection);
    const known = await prisma.activitySource.findMany({
      where: { connectionId: connection.id },
      select: { sourceActivityId: true },
    });
    const knownIds = new Set(known.map((s) => s.sourceActivityId));

    let stalePageStreak = 0;
    const PAGE_SCAN_LIMIT = 10;
    const PAGE_SIZE = 20;
    for (let page = 0; page < PAGE_SCAN_LIMIT; page++) {
      let rows: ZwiftActivity[] = [];
      try {
        rows = await client.listActivities(page * PAGE_SIZE, PAGE_SIZE);
      } catch (err) {
        result.status = "PARTIAL";
        result.failedActivities.push(`page:${page}`);
        console.error(`[zwift] list page ${page} failed:`, err);
        break;
      }
      if (!rows.length) break;

      let freshCount = 0;
      for (const row of rows) {
        const externalId = String(row.id_str ?? row.id ?? "");
        if (!externalId) continue;
        result.itemsPulled++;
        if (knownIds.has(externalId)) continue;
        freshCount++;
        try {
          const activity = mapZwiftActivityRow(row);
          if (!activity) throw new ZwiftError("CONNECTION", `activity ${externalId} has no usable start date`);
          let series: ZwiftSeries | null = null;
          try {
            series = await fetchSeries(client, externalId, row);
          } catch (err) {
            // stream hiccups must be visible in the sync result, not silent
            result.status = "PARTIAL";
            result.failedActivities.push(externalId);
            console.error(`[zwift] streams unavailable for ${externalId} — summary only`, err);
          }
          await upsertZwiftActivity(connection, externalId, activity, series);
          result.itemsCreated++;
        } catch (err) {
          result.status = "PARTIAL";
          result.failedActivities.push(externalId);
          console.error(`[zwift] activity ${externalId} ingest failed:`, err);
        }
      }

      if (freshCount === 0) {
        stalePageStreak++;
        if (stalePageStreak >= 2) break; // everything further back is known
      } else {
        stalePageStreak = 0;
      }
    }

    // Upgrade pass: activities registered by this connection that still have
    // NO Zwift series (stream hiccup during ingest, or the earlier
    // precision bug that queried a rounded-off id) get their streams now.
    // Bounded per pass so one force-sync tap never hammers the API.
    const upgradeable = await prisma.activitySource.findMany({
      where: {
        connectionId: connection.id,
        activity: { dataPoints: { none: { provider: "ZWIFT" } } },
      },
      select: { activityId: true, sourceActivityId: true },
      orderBy: { sourceUpdatedAt: "desc" },
      take: 50,
    });
    for (const s of upgradeable) {
      try {
        const detail = await client.getActivityDetail(s.sourceActivityId);
        const url = detail.fitnessData?.fullDataUrl;
        if (!url) continue; // upstream keeps it summary-only
        const series = toZwiftSeries(await client.getFitnessData(url));
        if (series) {
          await storeSeries(s.activityId, series);
          result.itemsUpdated++;
        }
      } catch (err) {
        result.status = "PARTIAL";
        result.failedActivities.push(s.sourceActivityId);
        console.error(`[zwift] streams upgrade failed for ${s.sourceActivityId}:`, err);
      }
    }
  } catch (err) {
    const detail = err instanceof ZwiftError
      ? { error: err.message, kind: err.kind, status: err.status, providerDetail: redactProviderDetail(err.detail) }
      : { error: err instanceof Error ? err.message : String(err) };
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: { status: "ERROR", errorDetail: detail as never, finishedAt: new Date() },
    });
    console.error(`[zwift] sync ${connection.id} failed:`, detail);
    throw err;
  }

  await prisma.syncLog.update({
    where: { id: result.syncLogId },
    data: {
      status: result.status,
      itemsPulled: result.itemsPulled,
      itemsCreated: result.itemsCreated,
      itemsUpdated: result.itemsUpdated,
      errorDetail: (result.failedActivities.length ? { failed: result.failedActivities.slice(0, 20) } : null) as never,
      finishedAt: new Date(),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date() },
  });
  return result;
}
