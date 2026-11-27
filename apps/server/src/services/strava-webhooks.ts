/** Manage Strava push subscriptions (list/create/delete) for the webhook route. */

import type { Env } from '../env.js';

const API = 'https://www.strava.com/api/v3/push_subscriptions';

export interface StravaWebhookConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  verifyToken: string;
}

export interface StravaSubscription {
  id: number;
  callback_url?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export function stravaWebhookConfig(env: Env): StravaWebhookConfig {
  const clientId = env.STRIDASH_STRAVA_CLIENT_ID;
  const clientSecret = env.STRIDASH_STRAVA_CLIENT_SECRET;
  const callbackUrl = env.STRIDASH_STRAVA_WEBHOOK_URL;
  const verifyToken = env.STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN;
  if (!clientId || !clientSecret) {
    throw new Error('Set STRIDASH_STRAVA_CLIENT_ID and STRIDASH_STRAVA_CLIENT_SECRET');
  }
  if (!callbackUrl) throw new Error('Set STRIDASH_STRAVA_WEBHOOK_URL');
  if (!verifyToken) throw new Error('Set STRIDASH_STRAVA_WEBHOOK_VERIFY_TOKEN');
  return { clientId, clientSecret, callbackUrl, verifyToken };
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through to the HTTP error
  }
  if (!res.ok) {
    const detail =
      json && typeof json === 'object' && 'message' in json
        ? String((json as { message?: unknown }).message)
        : text.slice(0, 300);
    throw new Error(`Strava push subscription failed (HTTP ${res.status}): ${detail}`);
  }
  return json as T;
}

export async function listStravaSubscriptions(
  config: StravaWebhookConfig,
): Promise<StravaSubscription[]> {
  const q = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return call<StravaSubscription[]>(`${API}?${q.toString()}`);
}

export async function createStravaSubscription(
  config: StravaWebhookConfig,
): Promise<StravaSubscription> {
  return call<StravaSubscription>(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      callback_url: config.callbackUrl,
      verify_token: config.verifyToken,
    }).toString(),
  });
}

export async function deleteStravaSubscription(
  config: StravaWebhookConfig,
  id: string | number,
): Promise<void> {
  const q = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  await call<unknown>(`${API}/${encodeURIComponent(String(id))}?${q.toString()}`, {
    method: 'DELETE',
  });
}
