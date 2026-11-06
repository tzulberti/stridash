/**
 * Omron sync service: pull every registered scale / BP monitor's measurements
 * from the Omron Connect cloud and upsert them into `measurements` (dedup key:
 * connection_id + kind + measured_at), writing a sync_logs row per run.
 *
 * Runs server-side only — the apps never talk to Omron directly (that is the
 * whole point of Stridash).
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { decryptToken, encryptToken } from "../crypto.js";
import { OmronConnectError, OmronConnectV1, type OmronDevice } from "../providers/omron/client.js";
import { type OmronRegion, regionForCountry } from "../providers/omron/regions.js";
import { normalizeSample } from "../providers/omron/normalize.js";
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

export type OmronSyncResult = {
  syncLogId: string;
  status: "OK" | "PARTIAL" | "ERROR";
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  devices: Array<{ deviceModel: string; serial: string; category: string; samples: number }>;
};

const DECIMAL_FIELDS = new Set([
  "weightKg", "bodyFatPct", "muscleMassKg", "skeletalMusclePct", "bmi", "visceralFatLevel",
  "subcutaneousFatPct", "fatFreeMassKg", "fatMassKg", "skeletalMuscleMassKg", "impedanceOhm",
  "bodyWaterPct", "boneMassKg", "meanArterialPressure",
]);

/** Update payload: Prisma Decimal nulling needs `{ set: null }` (create accepts null directly). */
function toUpdatePayload(data: Record<string, unknown>): Record<string, unknown> {
  const { kind: _k, connectionId: _c, measuredAt: _m, ...rest } = data;
  return Object.fromEntries(
    Object.entries(rest).map(([k, v]) =>
      v === null && DECIMAL_FIELDS.has(k) ? [k, { set: null }] : [k, v],
    ),
  );
}

/** Prisma Measurement scalar list — nulls for fields the provider didn't send. */
function toMeasurementRowNonNullable(userId: string, input: NonNullable<ReturnType<typeof normalizeSample>>) {
  return {
    kind: input.kind,
    userId,
    connectionId: input.connectionId,
    measuredAt: input.measuredAt,
    bodyFatPct: input.bodyFatPct ?? null,
    muscleMassKg: null as number | null, // not delivered by Omron (Amramin-era confusion with FFM)
    skeletalMusclePct: input.skeletalMusclePct ?? null,
    weightKg: input.weightKg ?? null,
    bmi: input.bmi ?? null,
    visceralFatLevel: input.visceralFatLevel ?? null,
    restingMetabolismKcal: input.restingMetabolismKcal ?? null,
    metabolicAge: input.metabolicAge ?? null,
    subcutaneousFatPct: input.subcutaneousFatPct ?? null,
    fatFreeMassKg: input.fatFreeMassKg ?? null,
    fatMassKg: input.fatMassKg ?? null,
    skeletalMuscleMassKg: input.skeletalMuscleMassKg ?? null,
    impedanceOhm: input.impedanceOhm ?? null,
    bodyWaterPct: null as number | null, // not delivered by Omron bodyIndexList
    boneMassKg: null as number | null,
    systolicMmhg: input.systolicMmhg ?? null,
    diastolicMmhg: input.diastolicMmhg ?? null,
    pulseBpm: input.pulseBpm ?? null,
    meanArterialPressure: input.meanArterialPressure ?? null,
    notes: null as string | null,
    segments: (input.segments ? (input.segments as Prisma.InputJsonValue) : Prisma.DbNull) as never,
    raw: input.raw as unknown as Prisma.InputJsonValue,
  };
}

/** Read the Omron country code out of connection.config — set at connect time. */
export function omronCountryOf(connection: ConnectionLike): string | null {
  const cfg = connection.config as { omron?: { country?: string } } | null;
  return cfg?.omron?.country ?? null;
}

/**
 * Run one Omron sync for a connection. Errors throw — route handler decides
 * how to surface them; partial device failures degrade to status PARTIAL.
 */
export async function syncOmronConnection(env: Env, connection: ConnectionLike): Promise<OmronSyncResult> {
  if (connection.status === "REVOKED") {
    throw new OmronConnectError("Connection revoked — reconnect the Omron account first");
  }
  const country = omronCountryOf(connection);
  if (!country) throw new OmronConnectError("Connection has no Omron region configured — reconnect");

  const log = await prisma.syncLog.create({
    data: { connectionId: connection.id, kind: "MEASUREMENTS", status: "OK" },
  });

  const result: OmronSyncResult = {
    syncLogId: log.id,
    status: "OK",
    itemsPulled: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    devices: [],
  };

  try {
    const client = await ensureSession(env, connection, country);
    const devices = await client.getDevices(90);
    const fromMs = connection.lastSyncedAt
      ? connection.lastSyncedAt.getTime() - 86400_000 // 1 day overlap for server-side edits/corrections
      : 0;

    for (const device of devices) {
      if (device.category !== "0" && device.category !== "1") continue; // BPM, SCALE
      try {
        const perDevice = await syncDevice(client, device, connection.id, connection.userId, fromMs);
        result.devices.push({
          deviceModel: device.deviceModel,
          serial: device.deviceSerialID,
          category: device.category,
          samples: perDevice.pulled,
        });
        result.itemsPulled += perDevice.pulled;
        result.itemsCreated += perDevice.created;
        result.itemsUpdated += perDevice.updated;
      } catch (err) {
        // One sick device must not poison the whole sync — record and move on.
        result.status = "PARTIAL";
        result.devices.push({
          deviceModel: device.deviceModel,
          serial: device.deviceSerialID,
          category: device.category,
          samples: -1, // failed
        });
        console.error(`[omron] device ${device.deviceModel} sync failed:`, err);
      }
    }
  } catch (err) {
    const detail = err instanceof OmronConnectError
      ? { error: err.message, status: err.status, providerDetail: err.detail }
      : { error: err instanceof Error ? err.message : String(err) };
    await prisma.syncLog.update({
      where: { id: result.syncLogId },
      data: {
        status: "ERROR",
        errorDetail: detail as never,
        finishedAt: new Date(),
      },
    });
    console.error(`[omron] sync ${connection.id} failed:`, detail);
    throw err;
  }

  await prisma.syncLog.update({
    where: { id: result.syncLogId },
    data: {
      status: result.status,
      itemsPulled: result.itemsPulled,
      itemsCreated: result.itemsCreated,
      itemsUpdated: result.itemsUpdated,
      errorDetail: (result.status === "PARTIAL" ? { note: "one or more devices failed" } : null) as never,
      finishedAt: new Date(),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: new Date() },
  });

  return result;
}

/** Authenticate (refresh or reuse stored access token) and return a client. */
async function ensureSession(env: Env, connection: ConnectionLike, country: string): Promise<OmronConnectV1> {
  const region: OmronRegion | null = regionForCountry(country);
  if (!region) throw new OmronConnectError(`No Omron server region for country ${country}`);
  const client = new OmronConnectV1(region, {
    onTokensRefreshed: async (tokens) => {
      await prisma.connection.update({
        where: { id: connection.id },
        data: {
          accessTokenEnc: encryptToken(tokens.accessToken, env.STRIDASH_ENC_KEY),
          refreshTokenEnc: encryptToken(tokens.refreshToken, env.STRIDASH_ENC_KEY),
          tokenExpiresAt: null, // protocol does not advertise expiry; refresh on every sync
          status: "ACTIVE",
        },
      });
    },
  });

  if (connection.accessTokenEnc) {
    client.withAccessToken(decryptToken(connection.accessTokenEnc, env.STRIDASH_ENC_KEY));
    // Cheap validity probe: a token refresh would 400 with an invalid grant.
    // Kii tokens are long-lived; still, prefer refreshing when we have no idea.
    if (!connection.refreshTokenEnc) return client;
  }
  if (connection.refreshTokenEnc) {
    const refreshToken = decryptToken(connection.refreshTokenEnc, env.STRIDASH_ENC_KEY);
    await client.refresh(refreshToken);
  }
  return client;
}

async function syncDevice(
  client: OmronConnectV1,
  device: OmronDevice,
  connectionId: string,
  userId: string,
  fromMs: number,
): Promise<{ pulled: number; created: number; updated: number }> {
  const samples = await client.getMeasureSamples(device, fromMs);
  let created = 0;
  let updated = 0;
  for (const sample of samples) {
    const row = normalizeSample(sample, device, connectionId);
    if (!row) continue;
    const data = toMeasurementRowNonNullable(userId, row);
    const existing = await prisma.measurement.findUnique({
      where: {
        connectionId_kind_measuredAt: {
          connectionId: row.connectionId,
          kind: row.kind,
          measuredAt: row.measuredAt,
        },
      },
      select: { id: true },
    });
    if (existing) {
      // unique-key fields are fixed by the lookup itself — not updatable
      await prisma.measurement.update({ where: { id: existing.id }, data: toUpdatePayload(data) });
      updated++;
    } else {
      await prisma.measurement.create({ data });
      created++;
    }
  }
  return { pulled: samples.length, created, updated };
}
