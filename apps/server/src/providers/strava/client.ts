/**
 * Strava API client (public v3 API).
 *
 * OAuth2:
 *   authorize  https://www.strava.com/oauth/authorize
 *   token      https://www.strava.com/oauth/token (authorization_code / refresh_token)
 *   API base   https://www.strava.com/api/v3
 *
 * Scopes requested by Stridash: `read,activity:read_all,profile:read_all`
 * (private activities + gear). The access token is a plain bearer; refresh
 * tokens rotate only when Strava chooses to rotate them, so the caller stores
 * whatever the token endpoint returns.
 */

export const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const STRAVA_DEFAULT_SCOPES = ['read', 'activity:read_all', 'profile:read_all'] as const;

export class StravaError extends Error {
  readonly kind: 'CREDENTIALS' | 'RATE_LIMIT' | 'CONNECTION';
  readonly status?: number;
  readonly detail?: unknown;

  constructor(
    kind: 'CREDENTIALS' | 'RATE_LIMIT' | 'CONNECTION',
    message: string,
    status?: number,
    detail?: unknown,
  ) {
    super(message);
    this.name = 'StravaError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

export interface StravaOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: readonly string[];
}

export interface StravaAthlete {
  id: number;
  username?: string | null;
  firstname?: string;
  lastname?: string;
  profile?: string;
  [key: string]: unknown;
}

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  /** absolute expiry, from Strava's expires_at (seconds) */
  expiresAt: Date;
  athlete: StravaAthlete | null;
  scopes: string[];
}

export interface StravaActivitySummary {
  id: number;
  name?: string;
  type?: string;
  sport_type?: string;
  start_date?: string;
  start_date_local?: string;
  elapsed_time?: number;
  moving_time?: number;
  distance?: number;
  average_speed?: number;
  max_speed?: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  max_watts?: number;
  average_cadence?: number;
  trainer?: boolean;
  gear_id?: string | null;
  device_name?: string | null;
  kilojoules?: number;
  [key: string]: unknown;
}

export interface StravaActivityDetail extends StravaActivitySummary {
  description?: string | null;
  calories?: number;
  suffer_score?: number;
  device_watts?: boolean;
}

export interface StravaGear {
  id: string;
  name?: string;
  brand_name?: string;
  model_name?: string;
  frame_type?: number | null;
  description?: string;
  distance?: number;
  primary?: boolean;
  [key: string]: unknown;
}

export type StravaStreamKey =
  | 'time'
  | 'distance'
  | 'latlng'
  | 'altitude'
  | 'velocity_smooth'
  | 'heartrate'
  | 'cadence'
  | 'watts'
  | 'temp';

export interface StravaStreams {
  time?: { data: number[] };
  distance?: { data: number[] };
  latlng?: { data: Array<[number, number]> };
  altitude?: { data: number[] };
  velocity_smooth?: { data: number[] };
  heartrate?: { data: number[] };
  cadence?: { data: number[] };
  watts?: { data: number[] };
  temp?: { data: number[] };
  [key: string]: unknown;
}

function scopesOf(scope: string | null | undefined, fallback: readonly string[]): string[] {
  return (scope ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(scope ? [] : fallback);
}

function parseTokens(
  json: {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    expires_in?: number;
    athlete?: StravaAthlete;
    scope?: string;
  } | null,
  fallbackRefresh: string | undefined,
  fallbackScopes: readonly string[],
): StravaTokens {
  if (!json?.access_token) {
    throw new StravaError('CONNECTION', 'Strava token response had no access_token');
  }
  const expiresAtMs = json.expires_at
    ? json.expires_at * 1000
    : Date.now() + (json.expires_in ?? 3600) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? fallbackRefresh ?? '',
    expiresAt: new Date(expiresAtMs),
    athlete: json.athlete ?? null,
    scopes: scopesOf(json.scope, fallbackScopes),
  };
}

function errorKind(status: number): StravaError['kind'] {
  if (status === 401 || status === 403 || status === 400) return 'CREDENTIALS';
  if (status === 429 || status === 427) return 'RATE_LIMIT';
  return 'CONNECTION';
}

async function tokenRequest(
  config: StravaOAuthConfig,
  body: Record<string, string>,
  failure: string,
  fallbackRefresh?: string,
): Promise<StravaTokens> {
  let res: Response;
  try {
    res = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...body,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new StravaError(
      'CONNECTION',
      `Strava auth unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    expires_in?: number;
    athlete?: StravaAthlete;
    scope?: string;
    error?: string;
    message?: string;
  } | null;
  if (!res.ok) {
    throw new StravaError(
      errorKind(res.status),
      `${failure} (HTTP ${res.status}${json?.error ? ` ${json.error}` : ''})`,
      res.status,
      json ? { error: json.error, message: json.message } : null,
    );
  }
  return parseTokens(json, fallbackRefresh, config.scopes ?? STRAVA_DEFAULT_SCOPES);
}

/** OAuth consent URL; `state` is the signed per-login nonce. */
export function stravaAuthorizeUrl(config: StravaOAuthConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: (config.scopes ?? STRAVA_DEFAULT_SCOPES).join(','),
    state,
  });
  return `${STRAVA_AUTH_URL}?${q.toString()}`;
}

/** Authorization-code exchange after the callback. */
export function exchangeStravaCode(config: StravaOAuthConfig, code: string): Promise<StravaTokens> {
  return tokenRequest(
    config,
    { code, grant_type: 'authorization_code' },
    'Strava authorization-code exchange failed',
  );
}

/** Refresh grant; caller must persist the returned pair/expiry. */
export function refreshStravaToken(
  config: StravaOAuthConfig,
  refreshToken: string,
): Promise<StravaTokens> {
  return tokenRequest(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    'Strava token refresh failed — reconnect the account',
    refreshToken,
  );
}

export class StravaClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request(path: string, failure: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${STRAVA_API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new StravaError(
        'CONNECTION',
        `${failure}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new StravaError(
        errorKind(res.status),
        `${failure} (HTTP ${res.status})`,
        res.status,
        text || null,
      );
    }
    return res.json().catch(() => null);
  }

  /** Newest-first activity page; `after`/`before` are unix seconds. */
  async listActivities(
    opts: { after?: number; before?: number; page?: number; perPage?: number } = {},
  ): Promise<StravaActivitySummary[]> {
    const q = new URLSearchParams({
      page: String(opts.page ?? 1),
      per_page: String(opts.perPage ?? 100),
    });
    if (opts.after !== undefined) q.set('after', String(opts.after));
    if (opts.before !== undefined) q.set('before', String(opts.before));
    const json = await this.request(
      `/athlete/activities?${q.toString()}`,
      'Strava activity list failed',
    );
    return Array.isArray(json) ? (json as StravaActivitySummary[]) : [];
  }

  async getActivity(id: string | number): Promise<StravaActivityDetail> {
    return (await this.request(
      `/activities/${id}`,
      `Strava activity ${id} detail failed`,
    )) as StravaActivityDetail;
  }

  async getActivityStreams(
    id: string | number,
    keys: StravaStreamKey[] = [
      'time',
      'distance',
      'latlng',
      'altitude',
      'velocity_smooth',
      'heartrate',
      'cadence',
      'watts',
      'temp',
    ],
  ): Promise<StravaStreams> {
    const q = new URLSearchParams({ keys: keys.join(','), key_by_type: 'true' });
    return (await this.request(
      `/activities/${id}/streams?${q.toString()}`,
      `Strava activity ${id} streams failed`,
    )) as StravaStreams;
  }

  async getGear(id: string): Promise<StravaGear> {
    return (await this.request(
      `/gear/${encodeURIComponent(id)}`,
      `Strava gear ${id} failed`,
    )) as StravaGear;
  }
}
