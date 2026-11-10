/**
 * Zwift sync-service unit tests — mocked prisma + mocked HTTP client, no
 * network and no database. Covers the orchestration the normalize tests
 * can't reach: page-scan stopping, ingest scalar/stream enrichment,
 * failure classification (PARTIAL vs ERROR) and the self-healing upgrade
 * pass.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Prisma stub ──────────────────────────────────────────────────────────────

// vi.mock factories are hoisted above module code — everything they touch
// must come from vi.hoisted so the references exist by factory time.
const { prisma, listActivities, getActivityDetail, getFitnessData, zwiftRefresh } = vi.hoisted(() => ({
  prisma: {
    syncLog: {
      create: vi.fn(async () => ({ id: "log-1" })),
      update: vi.fn(async () => ({})),
    },
    connection: { update: vi.fn(async () => ({})) },
    activity: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "act-created" })),
      update: vi.fn(async () => ({})),
    },
    activitySource: {
      findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
      upsert: vi.fn(async () => ({})),
    },
    activityDataPoint: { upsert: vi.fn(async () => ({})) },
  },
  listActivities: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(),
  getActivityDetail: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  getFitnessData: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  zwiftRefresh: vi.fn<(...a: unknown[]) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>>(),
}));

vi.mock("../src/db.js", () => ({ prisma }));

vi.mock("../src/crypto.js", () => ({
  decryptToken: vi.fn((enc: string) => enc.replace("ENC:", "")),
  encryptToken: vi.fn((t: string) => `ENC:${t}`),
}));

// keep the REAL ZwiftError — syncFailure classification relies on instanceof
vi.mock("../src/providers/zwift/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/zwift/client.js")>();
  class MockZwiftClient {
    listActivities = listActivities;
    getActivityDetail = getActivityDetail;
    getFitnessData = getFitnessData;
    withAccessToken(): this {
      return this;
    }
  }
  return { ...actual, ZwiftClient: MockZwiftClient, zwiftRefresh };
});

import { syncZwiftConnection } from "../src/services/zwift-sync.js";
import { ZwiftError, type ZwiftActivity } from "../src/providers/zwift/client.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const env = {
  STRIDASH_ENC_KEY: "x".repeat(32),
  STRIDASH_JWT_SECRET: "y".repeat(32),
} as Parameters<typeof syncZwiftConnection>[0];

const connection = {
  id: "conn-1",
  userId: "user-1",
  providerUserId: "athlete-1",
  accessTokenEnc: "ENC:access",
  refreshTokenEnc: "ENC:refresh",
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  status: "ACTIVE",
};

/** A valid minimal fitness payload (seconds/cm — the wire format). */
const fitnessData = {
  timeInSec: [0, 1, 2],
  distanceInCm: [0, 100, 200],
  speedInCmPerSec: [0, 300, 500],
  heartRate: [100, 120, 140],
  cadencePerMin: [80, 85, 90],
  powerInWatts: [120, 180, 220],
  altitudeInCm: [0, 10, 20],
};

/** The detail payload: stream URL + the scalars list rows lack. */
const detail = {
  fitnessData: { status: "ok", fullDataUrl: "https://us-or-rly101.zwift.com/api/activities/1/file/9" },
  movingTimeInMs: 1_800_000,
  avgHeartRate: 123.6,
  maxHeartRate: 150,
  maxWatts: 250,
  maxCadenceInRotationsPerMinute: 95,
};

let nextRowId = 1;
function row(over: Partial<ZwiftActivity> = {}): ZwiftActivity {
  const id = `90071992547409${nextRowId++}`; // safe-integer > 2^53 id_str
  return {
    id_str: id,
    sport: "CYCLING",
    name: "Zwift - Half an Hour of Relaxation",
    startDate: "2026-11-08T18:00:00.000Z",
    endDate: "2026-11-08T18:30:00.000Z",
    distanceInMeters: 15_000,
    ...over,
  } as ZwiftActivity;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.activitySource.findMany.mockImplementation(async (args: { take?: number }) => {
    // first call = known-id scan; second = upgradeable scan (take: 50)
    return "take" in args ? [] : [];
  });
  listActivities.mockResolvedValue([]);
  getActivityDetail.mockResolvedValue(detail);
  getFitnessData.mockResolvedValue(fitnessData);
});

// ─── Page scan ───────────────────────────────────────────────────────────────

describe("syncZwiftConnection — page scan", () => {
  it("ingests fresh rows: detail scalars merged, series + provenance stored", async () => {
    prisma.activitySource.findMany
      .mockResolvedValueOnce([]) // known ids: none yet
      .mockResolvedValueOnce([]); // upgradeable: none
    listActivities
      .mockResolvedValueOnce([row(), row()])
      .mockResolvedValueOnce([]); // page 2 empty → stop

    const result = await syncZwiftConnection(env, connection);

    expect(result.status).toBe("OK");
    expect(result.itemsPulled).toBe(2);
    expect(result.itemsCreated).toBe(2);
    expect(result.failedActivities).toEqual([]);

    expect(prisma.activity.create).toHaveBeenCalledTimes(2);
    const first = (prisma.activity.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    // detail scalars override the (HR-less) list row
    expect(first.avgHr).toBe(124); // 123.6 rounded
    expect(first.maxHr).toBe(150);
    expect(first.maxPowerW).toBe(250);
    expect(first.maxCadence).toBe(95);
    expect(first.movingTimeS).toBe(1800);
    expect(first.workoutName).toBe("Half an Hour of Relaxation");
    // detail payload stored whole
    expect(first.detailRaw).toBe(detail);

    // series stored with converted sample count
    expect(prisma.activityDataPoint.upsert).toHaveBeenCalledTimes(2);
    const dp = (prisma.activityDataPoint.upsert.mock.calls[0][0] as { create: { sampleCount: number; provider: string } }).create;
    expect(dp.sampleCount).toBe(3);
    expect(dp.provider).toBe("ZWIFT");

    // final sync-log write reflects the result
    const logUpdate = prisma.syncLog.update.mock.calls.at(-1)![0] as { data: { status: string; itemsPulled: number } };
    expect(logUpdate.data.status).toBe("OK");
    expect(logUpdate.data.itemsPulled).toBe(2);
    expect(prisma.connection.update).toHaveBeenCalled();
  });

  it("stops after two consecutive stale pages (already-known ids)", async () => {
    const known = [row(), row(), row()];
    prisma.activitySource.findMany
      .mockResolvedValueOnce(known.map((r) => ({ sourceActivityId: r.id_str })))
      .mockResolvedValueOnce([]);
    listActivities
      .mockResolvedValueOnce([...known]) // stale #1
      .mockResolvedValueOnce([...known]); // stale #2 → break

    const result = await syncZwiftConnection(env, connection);

    expect(listActivities).toHaveBeenCalledTimes(2);
    expect(result.itemsPulled).toBe(6); // counted even when known
    expect(result.itemsCreated).toBe(0);
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it("caps the scan at 10 pages even when every page is fresh", async () => {
    prisma.activitySource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    listActivities.mockImplementation(async (start: unknown) =>
      Array.from({ length: 20 }, () => row()));

    await syncZwiftConnection(env, connection);

    expect(listActivities).toHaveBeenCalledTimes(10);
    expect(prisma.activity.create).toHaveBeenCalledTimes(200);
  });

  it("a failed list page marks PARTIAL and stops the scan", async () => {
    prisma.activitySource.findMany.mockResolvedValue([]);
    listActivities.mockRejectedValueOnce(new Error("boom"));

    const result = await syncZwiftConnection(env, connection);

    expect(result.status).toBe("PARTIAL");
    expect(result.failedActivities).toContain("page:0");
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });
});

// ─── Failure classification ─────────────────────────────────────────────────

describe("syncZwiftConnection — failure classification", () => {
  it("a stream fetch failure degrades to PARTIAL, still storing the summary", async () => {
    prisma.activitySource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    listActivities.mockResolvedValueOnce([row()]).mockResolvedValueOnce([]);
    getFitnessData.mockRejectedValueOnce(new Error("stream 503"));

    const result = await syncZwiftConnection(env, connection);

    expect(result.status).toBe("PARTIAL");
    expect(result.itemsCreated).toBe(1);
    expect(result.failedActivities).toHaveLength(1);
    // detail fetched fine → stored whole; summary-only otherwise
    const data = (prisma.activity.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.detailRaw).toBe(detail);
    expect(prisma.activityDataPoint.upsert).not.toHaveBeenCalled();
  });

  it("a detail failure stores the list-row scalars only", async () => {
    prisma.activitySource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    listActivities.mockResolvedValueOnce([row()]).mockResolvedValueOnce([]);
    getActivityDetail.mockRejectedValueOnce(new Error("404"));

    const result = await syncZwiftConnection(env, connection);

    expect(result.status).toBe("PARTIAL");
    const data = (prisma.activity.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    // no detail → no HR patch, no series
    expect(data.avgHr).toBeNull();
    expect("detailRaw" in data ? data.detailRaw : undefined).toBeUndefined();
    expect(prisma.activityDataPoint.upsert).not.toHaveBeenCalled();
  });

  it("a revoked connection errors out before touching the API", async () => {
    await expect(
      syncZwiftConnection(env, { ...connection, status: "REVOKED" }),
    ).rejects.toBeInstanceOf(ZwiftError);
    expect(listActivities).not.toHaveBeenCalled();
    const errUpdate = prisma.syncLog.update.mock.calls[0][0] as { data: { status: string } };
    expect(errUpdate.data.status).toBe("ERROR");
  });

  it("a rejected credential refresh errors out and marks the log ERROR", async () => {
    zwiftRefresh.mockRejectedValueOnce(
      new ZwiftError("CREDENTIALS", "invalid_grant", 400),
    );
    const revokedish = { ...connection, accessTokenEnc: null, tokenExpiresAt: new Date(0) };

    await expect(syncZwiftConnection(env, revokedish)).rejects.toBeInstanceOf(ZwiftError);
    const errUpdate = prisma.syncLog.update.mock.calls[0][0] as { data: { status: string; errorDetail: { kind: string } } };
    expect(errUpdate.data.status).toBe("ERROR");
    expect(errUpdate.data.errorDetail.kind).toBe("CREDENTIALS");
  });
});

// ─── Upgrade pass ────────────────────────────────────────────────────────────

describe("syncZwiftConnection — upgrade pass", () => {
  it("heals a legacy summary-only row: detail + scalars + series", async () => {
    // ingest sees a page of already-known rows so it creates nothing fresh
    const knownId = "9007199254740999";
    prisma.activitySource.findMany
      .mockResolvedValueOnce([{ sourceActivityId: knownId }])
      .mockResolvedValueOnce([
        {
          activityId: "act-legacy",
          sourceActivityId: knownId,
          activity: { movingTimeS: null, detailRaw: null, dataPoints: [] },
        },
      ]);
    listActivities.mockResolvedValueOnce([row({ id_str: knownId })]).mockResolvedValueOnce([]);

    const result = await syncZwiftConnection(env, connection);

    // three heals off ONE detail call: detail_raw, scalars, series
    const updates = prisma.activity.update.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(updates.some((d) => d.detailRaw === detail)).toBe(true);
    expect(updates.some((d) => d.movingTimeS === 1800 && d.avgHr === 124)).toBe(true);
    expect(prisma.activityDataPoint.upsert).toHaveBeenCalled();
    expect(result.itemsUpdated).toBe(1);
    expect(result.status).toBe("OK");
  });

  it("an upgrade failure degrades to PARTIAL without failing the sync", async () => {
    prisma.activitySource.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          activityId: "act-1",
          sourceActivityId: "a1",
          activity: { movingTimeS: 600, detailRaw: null, dataPoints: [{ id: "dp" }] },
        },
      ]);
    getActivityDetail.mockRejectedValueOnce(new Error("detail down"));

    const result = await syncZwiftConnection(env, connection);

    expect(result.status).toBe("PARTIAL");
    expect(result.failedActivities).toContain("a1");
  });
});
