/**
 * Authenticated Garmin Connect API (connectapi.garmin.com) client.
 *
 * Bearer-token transport mirrors python-garminconnect's ApiTransportMixin:
 * native Android UA + Accept, access token from the DI exchange, refresh via
 * the DI refresh grant when the JWT claims say it is (nearly) expired.
 */

import {
  CONNECTAPI_BASE,
  NATIVE_API_UA,
  NATIVE_X_GARMIN_UA,
  GarminError,
  peekJwtExpMs,
  refreshDiToken,
  type DiTokens,
} from "./sso.js";

const VERIFY_PATH = "/userprofile-service/socialProfile";
const LIST_PATH = "/activitylist-service/activities/search/activities";
const FIT_PATH = "/download-service/files/activity";

async function connectapiGet(path: string, bearer: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${CONNECTAPI_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "User-Agent": NATIVE_API_UA,
      "x-garmin-user-agent": NATIVE_X_GARMIN_UA,
      "DI-Backend": "connectapi.garmin.com",
    },
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, json: res.status === 204 ? {} : await res.json().catch(() => null) };
}

export interface GarminProfile {
  displayName?: string;
  fullName?: string;
  userId?: number | string;
  userName?: string;
}

/** One-liner check that the API tier accepts the token (garth `_verify_token`). */
export async function verifyToken(bearer: string): Promise<boolean> {
  const { status } = await connectapiGet(VERIFY_PATH, bearer);
  return status !== 401 && status !== 403;
}

export async function getProfile(bearer: string): Promise<GarminProfile> {
  const { json } = await connectapiGet(VERIFY_PATH, bearer);
  return (typeof json === "object" && json !== null ? json : {}) as GarminProfile;
}

/** One page of the activity list, newest first. */
export async function listActivities(bearer: string, start: number, limit: number): Promise<GarminActivityRow[]> {
  const { json } = await connectapiGet(`${LIST_PATH}?start=${start}&limit=${limit}`, bearer);
  if (!Array.isArray(json)) return [];
  return json as GarminActivityRow[];
}

export async function downloadFit(bearer: string, activityId: string): Promise<Buffer> {
  const res = await fetch(`${CONNECTAPI_BASE}${FIT_PATH}/${activityId}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "*/*",
      "User-Agent": NATIVE_API_UA,
      "x-garmin-user-agent": NATIVE_X_GARMIN_UA,
      "DI-Backend": "connectapi.garmin.com",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new GarminError("CONNECTION", `FIT download for ${activityId} returned HTTP ${res.status}`);
  }
  const arr = new Uint8Array(await res.arrayBuffer());
  return Buffer.from(arr);
}

/** One page of the activity list chunk into a pageful of raw rows. */
export interface GarminActivityRow {
  activityId: number | string;
  activityName?: string;
  startTimeGMT?: string; // "2026-01-05 12:34:56"
  distance?: number; // meters
  duration?: number; // seconds (total, incl. pauses)
  movingDuration?: number;
  averageSpeed?: number; // m/s
  maxSpeed?: number;
  elevationGain?: number;
  elevationLoss?: number;
  averageHR?: number;
  maxHR?: number;
  averagePower?: number;
  maxPower?: number;
  calories?: number;
  deviceId?: number;
  activityType?: { typeId?: number; typeKey?: string };
  eventTypeId?: { typeKey?: string };
}

export function tokenExpiryMs(token: string): number | null {
  return peekJwtExpMs(token);
}

/** Re-authenticate a Garmin connection with the DI refresh grant. */
export async function maybeRefresh(
  tokens: DiTokens,
): Promise<{ fresh: boolean; tokens: DiTokens }> {
  const exp = peekJwtExpMs(tokens.diToken);
  if (exp !== null && Date.now() < exp - 900_000 && tokens.diRefreshToken) {
    return { fresh: true, tokens };
  }
  if (!tokens.diRefreshToken) {
    throw new GarminError(
      "CONNECTION",
      "Garmin session expired and no refresh token was stored — reconnect the account",
    );
  }
  return { fresh: false, tokens: await refreshDiToken(tokens.diRefreshToken, tokens.diClientId) };
}
