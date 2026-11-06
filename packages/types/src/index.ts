/**
 * Stridash shared domain + API types.
 *
 * Source of truth: docs/data-model.md — keep this file in sync with the
 * Prisma schema in apps/server/prisma/schema.prisma (types here are the
 * contract between server and apps until we generate them from Prisma).
 *
 * Naming mirrors the database columns (snake_case in DB, camelCase here) so
 * a future Prisma-generated type swap is mechanical.
 */

// ─── Users ───────────────────────────────────────────────────────────────────

export type Sex = "MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED";

export interface User {
  id: string;
  email: string;
  displayName: string;
  heightCm: number | null;
  dateOfBirth: string | null; // ISO date
  sex: Sex | null;
  createdAt: string; // ISO datetime
}

export interface AuthIdentity {
  id: string;
  userId: string;
  kind: IdentityKind;
  updatedAt: string;
}

export type IdentityKind = "PASSWORD";

// ─── Connections (external providers) ────────────────────────────────────────

/** Providers Stridash can sync from. */
export type Provider = "STRAVA" | "GARMIN" | "ZWIFT" | "IGPSPORT" | "OMRON" | "MANUAL";

export type ConnectionStatus = "PENDING" | "ACTIVE" | "ERROR" | "REVOKED";

/** A (user, external account) pair. Tokens live server-side only. */
export interface Connection {
  id: string;
  userId: string;
  provider: Provider;
  providerUserId: string;
  status: ConnectionStatus;
  scopes: string[];
  /** provider-specific non-secret config (e.g. { omron: { country } }) */
  config: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Connect an Omron account (server verifies credentials; password never stored). */
export interface OmronConnectRequest {
  provider: "OMRON";
  email: string;
  /** Omron Connect account password — sent over TLS once, never persisted. */
  password: string;
  /** ISO 3166-1 alpha-2 country the account was registered under. */
  country: string;
}

export type SyncKind = "ACTIVITIES" | "MEASUREMENTS" | "TOKEN_REFRESH";
export type SyncStatus = "OK" | "PARTIAL" | "ERROR";

export interface SyncLog {
  id: string;
  connectionId: string;
  kind: SyncKind;
  status: SyncStatus;
  itemsPulled: number;
  itemsCreated: number;
  itemsUpdated: number;
  errorDetail: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
}

// ─── Activities ──────────────────────────────────────────────────────────────

export type ActivityType =
  | "RUN"
  | "RIDE"
  | "VIRTUAL_RIDE"
  | "WALK"
  | "HIKE"
  | "SWIM"
  | "WORKOUT"
  | "OTHER";

export interface Activity {
  id: string;
  userId: string;
  headline: string;
  type: ActivityType;
  startTime: string; // ISO datetime — dedup key component
  durationS: number;
  movingTimeS: number | null;
  distanceM: number | null;
  totalAscentM: number | null;
  totalDescentM: number | null;
  elevationHighM: number | null;
  elevationLowM: number | null;
  avgSpeedMs: number | null;
  maxSpeedMs: number | null;
  avgHr: number | null;
  maxHr: number | null;
  /** minutes per HR zone, index 0 = zone 1 — source-reported when available */
  hrZonesMin: number[] | null;
  avgPowerW: number | null;
  maxPowerW: number | null;
  avgCadence: number | null;
  maxCadence: number | null;
  caloriesKcal: number | null;
  /** source-reported training load / stress (TSS-like); semantics vary by provider */
  trainingLoad: number | null;
  indoor: boolean;
  gearId: string | null;
  notes: string | null;
  createdAt: string;
}

/**
 * A named numeric series array. Only the keys the provider delivered are
 * present; unrelated streams are absent (not null-filled).
 */
export type ActivitySeriesArray = {
  timeMs: number[]; // always present — sample clock in ms since epoch
  latDeg?: number[];
  lngDeg?: number[];
  distanceM?: number[];
  altitudeM?: number[];
  speedMs?: number[];
  hrBpm?: number[];
  cadenceRpm?: number[];
  powerW?: number[];
  temperatureC?: number[];
};

/** Per-sample performance series for an activity ("stream"). */
export interface ActivityDataPoint {
  id: string;
  activityId: string;
  /** which provider delivered this series (one row per activity+provider) */
  provider: Provider;
  sampleCount: number;
  series: ActivitySeriesArray;
  createdAt: string;
}

/** Which connection(s) produced an activity (same ride via Strava AND Garmin). */
export interface ActivitySource {
  activityId: string;
  connectionId: string;
  sourceActivityId: string;
  sourceUpdatedAt: string;
}

export type GearKind = "BIKE" | "SHOES" | "OTHER";

export interface Gear {
  id: string;
  userId: string;
  name: string;
  kind: GearKind;
  brand: string | null;
  model: string | null;
  retired: boolean;
  createdAt: string;
}

// ─── Measurements ────────────────────────────────────────────────────────────

/**
 * Point-in-time health reading. One table, discriminated by `kind`.
 * Metrics that don't apply to a kind are null — see docs/data-model.md
 * for the Omron field mapping.
 */
export type MeasurementKind = "WEIGH_IN" | "BLOOD_PRESSURE";

/** Segmental body composition (Omron codes 275–288): body part × metric. */
export interface BodySegmentMetrics {
  musclePct: number;
  subcutaneousFatPct: number;
}

export interface BodySegments {
  arms?: BodySegmentMetrics;
  trunk?: BodySegmentMetrics;
  legs?: BodySegmentMetrics;
}

export interface Measurement {
  id: string;
  userId: string;
  /** null = manual entry in Stridash */
  connectionId: string | null;
  kind: MeasurementKind;
  measuredAt: string; // ISO datetime — dedup key component
  // — WEIGH_IN —
  weightKg: number;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  skeletalMusclePct: number | null;
  bmi: number | null;
  visceralFatLevel: number | null;
  restingMetabolismKcal: number | null;
  metabolicAge: number | null;
  subcutaneousFatPct: number | null;
  fatFreeMassKg: number | null;
  fatMassKg: number | null;
  skeletalMuscleMassKg: number | null;
  impedanceOhm: number | null;
  bodyWaterPct: number | null;
  boneMassKg: number | null;
  // — BLOOD_PRESSURE —
  systolicMmhg: number | null;
  diastolicMmhg: number | null;
  pulseBpm: number | null;
  meanArterialPressure: number | null;
  // — meta —
  notes: string | null;
  segments: BodySegments | null;
}

// ─── API contracts (v1) ──────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
  version: string;
}

export interface CredentialsRequest {
  email: string;
  password: string;
}

export interface RegisterRequest extends CredentialsRequest {
  displayName: string;
}

export interface AuthTokens {
  /** Short-lived (15 min) JWT. */
  accessToken: string;
  /** Long-lived (30 d) JWT. M1: stateless; rotation lands post-M1. */
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: User;
}

export interface ApiError {
  error: string;
  detail?: string | Record<string, string>;
}

export type PaginatedResponse<T> = {
  items: T[];
  nextCursor: string | null;
};
