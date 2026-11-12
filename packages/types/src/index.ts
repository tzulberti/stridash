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

export type Sex = 'MALE' | 'FEMALE' | 'OTHER' | 'UNDISCLOSED';

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

export type IdentityKind = 'PASSWORD';

/** Account preferences — one typed column per setting in `user_preferences`
 * (no jsonb). A new setting is a new column, not a new json key. */
export type PrefUnit = 'km' | 'mi';
export type PrefTheme = 'dark' | 'light';

export interface UserPreferences {
  units: PrefUnit;
  theme: PrefTheme;
}

/** GET /api/me response: account + the preference pair. */
export interface MeResponse {
  email: string;
  displayName: string;
  createdAt: string;
  preferences: UserPreferences;
}

// ─── Connections (external providers) ────────────────────────────────────────

/** Providers Stridash can sync from. */
export type Provider = 'STRAVA' | 'GARMIN' | 'ZWIFT' | 'IGPSPORT' | 'OMRON' | 'MANUAL';

export type ConnectionStatus = 'PENDING' | 'ACTIVE' | 'ERROR' | 'REVOKED';

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
  provider: 'OMRON';
  /** Omron Connect account identifier — email or username. */
  identifier: string;
  /** Omron Connect account password — sent over TLS once, never persisted. */
  password: string;
  /** ISO 3166-1 alpha-2 country the account was registered under. */
  country: string;
}

/** Connect a Garmin account (SSO credential login; only DI tokens are stored). */
export interface GarminConnectRequest {
  provider: 'GARMIN';
  /** Garmin account email (SSO login field). */
  email: string;
  /** Garmin account password — used once over TLS, never persisted. */
  password: string;
}

/** Complete a pending Garmin MFA login. */
export interface GarminMfaRequest {
  /** Verification code from the second-factor channel. */
  code: string;
}

export type SyncKind = 'ACTIVITIES' | 'MEASUREMENTS' | 'TOKEN_REFRESH';
export type SyncStatus = 'OK' | 'PARTIAL' | 'ERROR';

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
  'RUN' | 'RIDE' | 'VIRTUAL_RIDE' | 'WALK' | 'HIKE' | 'SWIM' | 'WORKOUT' | 'OTHER';

export interface Activity {
  id: string;
  userId: string;
  headline: string;
  /** workout identity for virtual platforms (Zwift "Zwift - <workout>"); null otherwise */
  workoutName?: string | null;
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
  /** providers that delivered this row (a length-2 list = same ride arrived twice) */
  providers?: string[];
  /** provider detail-endpoint payload as-received (Zwift carries ~45 fields
   * beyond the list row); absent where no detail endpoint exists */
  detailRaw?: unknown;
  indoor: boolean;
  gearId: string | null;
  notes: string | null;
  createdAt: string;
}

/** Recording device — the physical hardware that produced activities
 * (Garmin watch, iGPSPORT head unit). `sourceDeviceId` is the FIT device
 * message's serial; `model` is the friendly name when the provider resolves
 * it ("Forerunner 955 Solar"). Zwift/Omron report no per-activity device. */
export interface Device {
  id: string;
  provider: Provider;
  sourceDeviceId: string;
  manufacturer: string | null;
  model: string | null;
  productCode: number | null;
  softwareVersion: string | null;
  hardwareVersion: string | null;
  /** the FIT device message / provider payload as-received */
  raw?: unknown;
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
  /** FIT "vertical_oscillation" (Garmin running dynamics), meters */
  verticalOscillationM?: number[];
  /** FIT "stance_time_percent" — ground-contact % of stride cycle */
  stanceTimePct?: number[];
  /** FIT "vertical_ratio" — vertical oscillation ÷ step length, % */
  verticalRatioPct?: number[];
  /** FIT "step_length", meters */
  stepLengthM?: number[];
  /** breaths/min (FIT "enhanced_respiration_rate") */
  respirationRate?: number[];
  /** Garmin stamina — % of potential remaining */
  staminaPct?: number[];
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

export type GearKind = 'BIKE' | 'SHOES' | 'OTHER';
export interface Gear {
  id: string;
  userId: string;
  name: string;
  kind: GearKind;
  brand: string | null;
  model: string | null;
  /** which provider this row came from (null = added manually in Stridash) */
  provider: Provider | null;
  /** provider's gear id (e.g. Garmin's dashed gear uuid); null for manual gear */
  sourceGearId: string | null;
  firstUsedAt: string | null;
  /** null = still in use */
  retiredAt: string | null;
  /** how the provider counts usage ("DISTANCE" / "TIME") */
  usageType: string | null;
  /** provider-reported retirement threshold, meters */
  thresholdM: number | null;
  createdAt: string;
}

export type GearComponentKind =
  | 'CHAIN'
  | 'CASSETTE'
  | 'CHAINRING'
  | 'BRAKE_PADS'
  | 'TIRES'
  | 'TUBES'
  | 'PEDALS'
  | 'BATTERY'
  | 'OTHER';

/** A wear item mounted on a piece of gear, managed in Stridash (Garmin has
 * no component concept); usage is computed from linked activities. */
export interface GearComponent {
  id: string;
  gearId: string;
  name: string;
  kind: GearComponentKind;
  /** usage counts activities starting on/after this date; null → usage 0 */
  installedAt: string | null;
  /** null = still mounted */
  retiredAt: string | null;
  /** user's own replacement threshold, meters (advisory) */
  thresholdM: number | null;
  notes: string | null;
  createdAt: string;
}

/** Usage aggregated from the activities linked to the gear. */
export interface GearUsage {
  /** sum of activities.distance_m, meters */
  distanceM: number;
  /** sum of activities.duration_s, seconds */
  durationS: number;
  count: number;
}

export interface GearWithUsage extends Gear {
  usage: GearUsage;
  components: (GearComponent & { usage: GearUsage })[];
}

// ─── Measurements ────────────────────────────────────────────────────────────

/**
 * Point-in-time health reading. One table, discriminated by `kind`.
 * Metrics that don't apply to a kind are null — see docs/data-model.md
 * for the Omron field mapping.
 */
export type MeasurementKind = 'WEIGH_IN' | 'BLOOD_PRESSURE';

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
  status: 'ok';
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
