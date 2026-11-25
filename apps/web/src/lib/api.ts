/**
 * Browser API client for the dashboard.
 *
 * Keeps auth refresh in one place: an access token that expires mid-session
 * triggers one refresh attempt (shared across concurrent failures) and a
 * replay of the original request. Login state is owned by App; the listener
 * below lets a refresh update React's in-memory token.
 */
import {
  clearTokens,
  readToken,
  remembering,
  saveTokens,
  storedRefreshToken,
} from './token-storage';

export type TokenListener = (token: string) => void;

let onTokenChanged: TokenListener = () => {};

export function setTokenListener(listener: TokenListener): void {
  onTokenChanged = listener;
}

/** Try to mint a fresh pair from the stored refresh token (false once dead). */
let refreshInflight: Promise<boolean> | null = null;
export async function tryRefresh(): Promise<boolean> {
  refreshInflight ??= (async () => {
    const rt = storedRefreshToken();
    if (!rt) return false;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (res.status === 401) {
        // the refresh token is genuinely dead (expired, revoked, replayed)
        clearTokens();
        return false;
      }
      if (!res.ok) {
        // transient (429 rate limit, 5xx) — keep the tokens and try later
        return false;
      }
      const j = (await res.json()) as { accessToken: string; refreshToken: string };
      saveTokens(j.accessToken, j.refreshToken, remembering());
      onTokenChanged(j.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  query?: Record<string, string>;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
  const call = (tok: string | null | undefined) =>
    fetch(`/api${path}${qs}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  const res = await (opts.token ? call(opts.token) : call(readToken()));
  const json = (await res.json().catch(() => null)) as T & { error?: string; detail?: unknown };
  // A 401 mid-dashboard usually means the 15-minute access token ran out —
  // refresh once and replay before surfacing an error.
  if (res.status === 401 && !path.startsWith('/auth/') && (await tryRefresh())) {
    const retry = await call(readToken());
    const json2 = (await retry.json().catch(() => null)) as T & {
      error?: string;
      detail?: unknown;
    };
    if (retry.ok) return json2;
    throw new Error(`${json2?.error ?? retry.statusText}`);
  }
  if (!res.ok) {
    const detail = typeof json?.detail === 'string' ? ` — ${json.detail}` : '';
    throw new Error(`${json?.error ?? res.statusText}${detail}`);
  }
  return json;
}
