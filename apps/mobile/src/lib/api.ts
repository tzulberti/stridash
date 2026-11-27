/** Mobile API configuration/helpers (pure, no React Native imports so the
 * first test tier can run in plain Node). */

import type { Activity, HealthResponse, Measurement, MeResponse, Provider } from '@stridash/types';

export const DEFAULT_API_URL = 'http://localhost:3000';

/** `EXPO_PUBLIC_API_URL` when set (trimmed), otherwise localhost for dev. */
export function getApiUrl(): string {
  return process.env.EXPO_PUBLIC_API_URL?.trim() || DEFAULT_API_URL;
}

/** Fetch `/api/health`; throws on a non-2xx response. */
export async function fetchHealth(baseUrl = getApiUrl()): Promise<HealthResponse> {
  const res = await fetch(`${baseUrl}/api/health`);
  if (!res.ok) throw new Error(`health check failed (HTTP ${res.status})`);
  return (await res.json()) as HealthResponse;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface MobileConnection {
  id: string;
  provider: Provider;
  providerUserId: string;
  status: string;
  lastSyncedAt: string | null;
}

export interface SleepLite {
  dateKey: string;
  totalSleepS: number | null;
  sleepScore: number | null;
  restingHr: number | null;
}

export interface WellnessLite {
  dateKey: string;
  steps: number | null;
  restingHr: number | null;
  batteryLatest: number | null;
}

export interface DashboardData {
  me: MeResponse;
  connections: MobileConnection[];
  measurements: Measurement[];
  activities: Activity[];
  sleeps: SleepLite[];
  wellness: WellnessLite[];
}

type Query = Record<string, string | number | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  token?: string | null;
  body?: unknown;
  query?: Query;
  baseUrl?: string;
}

function urlOf(path: string, opts: RequestOptions): string {
  const base = (opts.baseUrl ?? getApiUrl()).replace(/\/$/, '');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) q.set(k, String(v));
  }
  return `${base}/api${path}${q.size ? `?${q.toString()}` : ''}`;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(urlOf(path, opts), {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep null; error messages below fall back to the HTTP status
  }
  if (!res.ok) {
    const detail =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error?: unknown }).error)
        : null;
    throw new ApiError(detail || `request failed (HTTP ${res.status})`, res.status);
  }
  return json as T;
}

export function login(email: string, password: string): Promise<AuthTokens> {
  return apiRequest<AuthTokens>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
}

export function register(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthTokens & { user: MeResponse }> {
  return apiRequest('/auth/register', {
    method: 'POST',
    body: { email, password, displayName },
  });
}

/** One dashboard round-trip: identity, connections + latest health/activity
 * rows. The mobile first pass only needs the newest measurement/sleep/day. */
export async function loadDashboard(token: string, baseUrl?: string): Promise<DashboardData> {
  const [me, connections, measurements, activities, sleeps, wellness] = await Promise.all([
    apiRequest<MeResponse>('/me', { token, baseUrl }),
    apiRequest<{ items: MobileConnection[] }>('/connections', { token, baseUrl }),
    apiRequest<{ items: Measurement[] }>('/measurements', {
      token,
      baseUrl,
      query: { limit: 20 },
    }),
    apiRequest<{ items: Activity[] }>('/activities', {
      token,
      baseUrl,
      query: { limit: 20 },
    }),
    apiRequest<{ items: SleepLite[] }>('/sleeps', {
      token,
      baseUrl,
      query: { limit: 7 },
    }),
    apiRequest<{ items: WellnessLite[] }>('/wellness', {
      token,
      baseUrl,
      query: { limit: 7 },
    }),
  ]);
  return {
    me,
    connections: connections.items,
    measurements: measurements.items,
    activities: activities.items,
    sleeps: sleeps.items,
    wellness: wellness.items,
  };
}

/** Queue a sync for one connection (server returns 202). */
export function syncConnection(id: string, token: string): Promise<unknown> {
  return apiRequest(`/connections/${id}/sync`, { method: 'POST', token });
}

export type ManualMeasurement =
  | {
      kind: 'WEIGH_IN';
      weightKg: number;
      bodyFatPct?: number;
    }
  | {
      kind: 'BLOOD_PRESSURE';
      systolicMmhg: number;
      diastolicMmhg: number;
      pulseBpm?: number;
    };

/** Quick-add a manual weigh-in or blood-pressure reading (provider MANUAL). */
export function createMeasurement(token: string, measurement: ManualMeasurement): Promise<unknown> {
  return apiRequest('/measurements', { method: 'POST', token, body: measurement });
}

export type CredentialProvider = 'OMRON' | 'IGPSPORT' | 'GARMIN' | 'ZWIFT';

export type ConnectProviderBody =
  | { provider: 'OMRON'; identifier: string; password: string; country: string }
  | { provider: 'IGPSPORT'; username: string; password: string; region: 'intl' }
  | { provider: 'GARMIN'; email: string; password: string }
  | { provider: 'ZWIFT'; username: string; password: string };

export interface ConnectResult {
  mfaRequired?: boolean;
  method?: string;
  connection?: { id: string };
  [key: string]: unknown;
}

/** Credential-based provider connect (Garmin may answer 202 + mfaRequired). */
export function connectProvider(token: string, body: ConnectProviderBody): Promise<ConnectResult> {
  return apiRequest('/connections', { method: 'POST', token, body });
}

export function verifyConnectionMfa(
  token: string,
  connectionId: string,
  code: string,
): Promise<unknown> {
  return apiRequest(`/connections/${connectionId}/mfa`, {
    method: 'POST',
    token,
    body: { code },
  });
}

/** Strava consent URL; the caller opens it in the system browser. */
export function stravaAuthorizeUrl(token: string): Promise<{ url: string }> {
  return apiRequest('/strava/authorize', { token });
}

export function registerPushToken(
  token: string,
  pushToken: string,
  platform: 'ios' | 'android' | 'web',
): Promise<unknown> {
  return apiRequest('/push-tokens', {
    method: 'POST',
    token,
    body: { token: pushToken, platform },
  });
}
