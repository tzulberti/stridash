/**
 * Zwift private game-client API client — Zwift has no public API, so this
 * speaks the same protocol as their game client (documented by the community;
 * see docs/zwift.md).
 *
 * Auth: Keycloak-style OAuth token endpoint shared with the game client
 *   POST https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token
 *   form: grant_type=password|refresh_token, client_id="Zwift Game Client"
 *   → {access_token, refresh_token, expires_in}.
 * The refresh grant is real (rotating refresh tokens) — but only succeeds
 * when the request's client_id matches the refresh token's audience, so the
 * client_id constant must stay "Zwift Game Client" for both grants.
 *
 * API base: https://us-or-rly101.zwift.com — requests MUST carry the
 * game-client identity headers (Platform / Source / User-Agent) or Zwift
 * rejects them as non-client traffic.
 *
 * Data:
 *   list    GET /api/profiles/{athleteId}/activities?start&limit  (newest first)
 *   detail  GET /api/activities/{id}?fetchSnapshots=true
 *   streams GET detail.fitnessData.fullDataUrl — parallel per-second arrays;
 *           distance/speed/altitude arrive in CENTIMETERS (÷100 → m).
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const ZWIFT_AUTH_URL = "https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token";
export const ZWIFT_API_BASE = "https://us-or-rly101.zwift.com";
/** The refresh token's audience is bound to this client id — do not change. */
export const ZWIFT_CLIENT_ID = "Zwift Game Client";

/** Required identity headers — without these Zwift rejects the request. */
const GAME_HEADERS: Record<string, string> = {
  Platform: "OSX",
  Source: "Game Client",
  "User-Agent": "CNL/3.30.8 (macOS 13 Ventura; Darwin Kernel 22.4.0) zwift/1.0.110983 curl/7.78.0",
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ZwiftError extends Error {
  /** "CREDENTIALS" = the provider rejected our credentials/tokens. */
  readonly kind: "CREDENTIALS" | "CONNECTION";
  readonly status?: number;
  readonly detail?: unknown;

  constructor(kind: "CREDENTIALS" | "CONNECTION", message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "ZwiftError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface ZwiftTokens {
  accessToken: string;
  refreshToken: string;
  /** seconds until the access token expires */
  expiresIn: number;
}

/** One activity from the list or detail endpoints (same model, detail richer). */
export interface ZwiftActivity {
  id?: number;
  id_str?: string;
  sport?: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  /** Zwift detail rows carry elapsed — identical to endDate−startDate */
  movingTimeInMs?: number;
  distanceInMeters?: number;
  avgSpeedInMetersPerSecond?: number;
  maxSpeedInMetersPerSecond?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgWatts?: number;
  maxWatts?: number;
  avgCadenceInRotationsPerMinute?: number;
  maxCadenceInRotationsPerMinute?: number;
  totalElevationInMeters?: number;
  calories?: number;
  fitnessData?: { fullDataUrl?: string };
  [key: string]: unknown;
}

/** Parallel per-second sample arrays (NOT mutually offset — aligned by index). */
export interface ZwiftFitnessData {
  /** seconds since activity start (index i → sample i) */
  timeInSec?: number[];
  powerInWatts?: number[];
  heartRate?: number[];
  cadencePerMin?: number[];
  distanceInCm?: number[];
  speedInCmPerSec?: number[];
  altitudeInCm?: number[];
  /** world-surface coordinates, NOT real GPS — deliberately unused */
  latlng?: Array<[number, number]> | Array<number[]>;
}

// ─── Token endpoint ──────────────────────────────────────────────────────────

/** password grant — the password is verified once, never stored. */
export async function zwiftSignIn(username: string, password: string): Promise<ZwiftTokens> {
  return tokenRequest({ grant_type: "password", username, password }, "Zwift sign-in failed (check username/password)");
}

/** refresh grant — Keycloak ROTATES the refresh token; caller must persist the new pair. */
export async function zwiftRefresh(refreshToken: string): Promise<ZwiftTokens> {
  const tokens = await tokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    "Zwift token refresh failed — reconnect the account",
    refreshToken,
  );
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

type TokenBody = Record<string, string>;

async function tokenRequest(body: TokenBody, failMessage: string, previousRefresh?: string): Promise<ZwiftTokens> {
  let res: Response;
  try {    res = await globalThis.fetch(ZWIFT_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: ZWIFT_CLIENT_ID, ...body }).toString(),
    });
  } catch (err) {
    throw new ZwiftError("CONNECTION", `Zwift auth unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
    | null;
  if (!res.ok) {
    const detail = json ? { errorCode: json.error, message: json.error_description } : null;
    // Keycloak answers dead/expired grants with 400 invalid_grant (the
    // grant is unknown/expired), and wrong credentials with 401.
    const rejected = res.status === 400 || res.status === 401 || res.status === 403;
    throw new ZwiftError(
      rejected ? "CREDENTIALS" : "CONNECTION",
      `${failMessage} (HTTP ${res.status}${detail?.errorCode ? ` ${detail.errorCode}` : ""})`,
      res.status,
      detail,
    );
  }
  if (!json?.access_token) throw new ZwiftError("CONNECTION", "Zwift auth response had no access token");
  // A refresh response that omits refresh_token means the old one survives.
  const refreshToken = json.refresh_token ?? previousRefresh ?? "";
  return { accessToken: json.access_token, refreshToken, expiresIn: json.expires_in ?? 3600 };
}

// ─── API client ──────────────────────────────────────────────────────────────

export class ZwiftClient {
  private accessToken: string = "";

  constructor(private readonly athleteId: string) {}

  withAccessToken(accessToken: string): this {
    this.accessToken = accessToken;
    return this;
  }

  private headers(): Record<string, string> {
    return {
      ...GAME_HEADERS,
      Accept: "application/json",
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
    };
  }

  private async get(path: string, failure: string): Promise<unknown> {
    let res: Response;
    try {      res = await globalThis.fetch(`${ZWIFT_API_BASE}${path}`, { headers: this.headers() });
    } catch (err) {
      throw new ZwiftError("CONNECTION", `${failure}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const kind: ZwiftError["kind"] = res.status === 401 || res.status === 403 ? "CREDENTIALS" : "CONNECTION";
      const text = (await res.text().catch(() => "")).slice(0, 500);
      throw new ZwiftError(kind, `${failure} (HTTP ${res.status}): ${text}`, res.status, text || null);
    }
    return res.json();
  }

  /** authenticated rider identity — the providerUserId connector key. */
  async getMe(): Promise<ZwiftActivity & { id?: number; firstName?: string; lastName?: string }> {
    return (await this.get("/api/profiles/me", "Zwift profile fetch failed")) as never;
  }

  /** newest first; `start` is an offset into the rider's activity list. */
  async listActivities(start: number, limit: number): Promise<ZwiftActivity[]> {
    const rows = await this.get(
      `/api/profiles/${this.athleteId}/activities?start=${start}&limit=${limit}`,
      "Zwift activity list failed",
    );
    return Array.isArray(rows) ? (rows as ZwiftActivity[]) : [];
  }

  /** detail may add fitnessData.fullDataUrl (the per-second stream URL). */
  async getActivityDetail(activityId: string): Promise<ZwiftActivity> {
    return (await this.get(`/api/activities/${activityId}?fetchSnapshots=true`, `Zwift activity ${activityId} fetch failed`)) as never;
  }

  /** the per-second sample arrays. URLs may be relative to the API base. */
  async getFitnessData(url: string): Promise<ZwiftFitnessData> {
    const target = url.startsWith("http") ? url : `${ZWIFT_API_BASE}${url}`;
    let res: Response;
    try {      res = await globalThis.fetch(target, { headers: this.headers() });
    } catch (err) {
      throw new ZwiftError("CONNECTION", `Zwift fitness data fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const kind: ZwiftError["kind"] = res.status === 401 || res.status === 403 ? "CREDENTIALS" : "CONNECTION";
      throw new ZwiftError(kind, `Zwift fitness data fetch failed (HTTP ${res.status})`, res.status);
    }
    return (await res.json()) as ZwiftFitnessData;
  }
}
