/**
 * Browser token storage.
 *
 * "Remember me" puts both tokens in localStorage (survives the browser);
 * unchecked keeps them in sessionStorage (dies with the tab). Every access is
 * guarded: the web build is occasionally imported in a test/SSR context where
 * `window` does not exist, and storage can throw (private mode, blocked
 * cookies). A missing store simply behaves like an empty one.
 */

export const ACCESS_TOKEN_KEY = 'stridash.accessToken';
export const REFRESH_TOKEN_KEY = 'stridash.refreshToken';

type StoreKind = 'local' | 'session';

function store(kind: StoreKind): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function get(kind: StoreKind, key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function set(kind: StoreKind, key: string, value: string): void {
  try {
    store(kind)?.setItem(key, value);
  } catch {
    // quota / disabled storage — the in-memory React state still works
  }
}

function remove(kind: StoreKind, key: string): void {
  try {
    store(kind)?.removeItem(key);
  } catch {
    // nothing to clean up
  }
}

export function readToken(): string | null {
  return get('local', ACCESS_TOKEN_KEY) || get('session', ACCESS_TOKEN_KEY);
}

export function saveTokens(accessToken: string, refreshToken: string, remember: boolean): void {
  clearTokens();
  const kind: StoreKind = remember ? 'local' : 'session';
  set(kind, ACCESS_TOKEN_KEY, accessToken);
  set(kind, REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(): void {
  for (const kind of ['local', 'session'] as const) {
    remove(kind, ACCESS_TOKEN_KEY);
    remove(kind, REFRESH_TOKEN_KEY);
  }
}

/** Login decides the store; a refresh rotates in place in whichever store was
 * selected, so "remember" = tokens live in localStorage. */
export function remembering(): boolean {
  return !!(get('local', REFRESH_TOKEN_KEY) || get('local', ACCESS_TOKEN_KEY));
}

/** The token to revoke on logout / exchange on refresh (session wins, matching the login store). */
export function storedRefreshToken(): string | null {
  return get('session', REFRESH_TOKEN_KEY) ?? get('local', REFRESH_TOKEN_KEY);
}
