/** Mobile API configuration/helpers (pure, no React Native imports so the
 * first test tier can run in plain Node). */

import type { HealthResponse } from '@stridash/types';

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
