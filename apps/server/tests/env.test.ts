import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDatabaseUrl } from '../src/env.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadDatabaseUrl', () => {
  it.each(['postgresql://user:pass@db:5432/stridash', 'postgres://user:pass@db:5432/stridash'])(
    'accepts %s',
    (url) => {
      vi.stubEnv('DATABASE_URL', url);

      expect(loadDatabaseUrl()).toBe(url);
    },
  );

  it('rejects a missing URL', () => {
    vi.stubEnv('DATABASE_URL', '');

    expect(() => loadDatabaseUrl()).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres URL', () => {
    vi.stubEnv('DATABASE_URL', 'mysql://user:pass@db:3306/stridash');

    expect(() => loadDatabaseUrl()).toThrow(/DATABASE_URL/);
  });
});
