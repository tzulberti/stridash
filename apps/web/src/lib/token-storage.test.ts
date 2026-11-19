import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  clearTokens,
  readToken,
  remembering,
  saveTokens,
  storedRefreshToken,
} from './token-storage';

/** Minimal in-memory Storage implementation. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

function withWindow(local = memoryStorage(), session = memoryStorage()) {
  vi.stubGlobal('window', { localStorage: local, sessionStorage: session });
  return { local, session };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('token storage without a window (SSR / tests)', () => {
  it('reads as empty and never throws', () => {
    expect(readToken()).toBeNull();
    expect(storedRefreshToken()).toBeNull();
    expect(remembering()).toBe(false);
    expect(() => saveTokens('a', 'r', true)).not.toThrow();
    expect(() => clearTokens()).not.toThrow();
  });

  it('treats a throwing storage as empty', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('blocked');
      },
      get sessionStorage(): Storage {
        throw new Error('blocked');
      },
    });
    expect(readToken()).toBeNull();
    expect(storedRefreshToken()).toBeNull();
    expect(remembering()).toBe(false);
  });
});

describe('token storage', () => {
  it('remember=true writes both tokens to localStorage only', () => {
    const { local, session } = withWindow();
    saveTokens('access', 'refresh', true);

    expect(local.getItem(ACCESS_TOKEN_KEY)).toBe('access');
    expect(local.getItem(REFRESH_TOKEN_KEY)).toBe('refresh');
    expect(session.length).toBe(0);
    expect(readToken()).toBe('access');
    expect(storedRefreshToken()).toBe('refresh');
    expect(remembering()).toBe(true);
  });

  it('remember=false writes both tokens to sessionStorage only', () => {
    const { local, session } = withWindow();
    saveTokens('access', 'refresh', false);

    expect(session.getItem(ACCESS_TOKEN_KEY)).toBe('access');
    expect(session.getItem(REFRESH_TOKEN_KEY)).toBe('refresh');
    expect(local.length).toBe(0);
    expect(readToken()).toBe('access');
    expect(storedRefreshToken()).toBe('refresh');
    expect(remembering()).toBe(false);
  });

  it('moves tokens between stores when remember changes', () => {
    const { local, session } = withWindow();
    saveTokens('a1', 'r1', true);
    saveTokens('a2', 'r2', false);

    expect(local.length).toBe(0);
    expect(session.getItem(ACCESS_TOKEN_KEY)).toBe('a2');
    expect(readToken()).toBe('a2');
  });

  it('prefers the persistent store when both have an access token', () => {
    const { local, session } = withWindow();
    local.setItem(ACCESS_TOKEN_KEY, 'local-access');
    session.setItem(ACCESS_TOKEN_KEY, 'session-access');
    expect(readToken()).toBe('local-access');
  });

  it('clearTokens empties both stores', () => {
    const { local, session } = withWindow();
    saveTokens('a', 'r', true);
    session.setItem(ACCESS_TOKEN_KEY, 'other');
    clearTokens();

    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
    expect(readToken()).toBeNull();
    expect(storedRefreshToken()).toBeNull();
  });
});
