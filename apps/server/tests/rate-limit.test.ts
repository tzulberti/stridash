import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../src/rate-limit.js';

describe('FixedWindowLimiter', () => {
  it('allows requests up to the limit and blocks the next one', () => {
    const limiter = new FixedWindowLimiter(2, 60_000);
    const t = 1_000_000;

    expect(limiter.consume('ip', t)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('ip', t + 1)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('ip', t + 2)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('keeps buckets per key', () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    const t = 1_000_000;

    expect(limiter.consume('ip-a', t).allowed).toBe(true);
    expect(limiter.consume('ip-b', t).allowed).toBe(true);
    expect(limiter.consume('ip-a', t + 1).allowed).toBe(false);
  });

  it('starts a fresh window when the old one expired', () => {
    const limiter = new FixedWindowLimiter(1, 1_000);
    const t = 1_000_000;

    expect(limiter.consume('ip', t).allowed).toBe(true);
    expect(limiter.consume('ip', t + 999).allowed).toBe(false);
    expect(limiter.consume('ip', t + 1_000).allowed).toBe(true);
  });

  it('reports retry-after in whole seconds', () => {
    const limiter = new FixedWindowLimiter(1, 10_000);
    const t = 1_000_000;

    limiter.consume('ip', t);
    expect(limiter.consume('ip', t + 2_500).retryAfterS).toBe(8); // ceil(7500ms)
    expect(limiter.consume('ip', t + 9_999).retryAfterS).toBe(1); // never 0 on a 429
  });

  it('reset() forgets a key (successful login)', () => {
    const limiter = new FixedWindowLimiter(1, 60_000);
    const t = 1_000_000;

    expect(limiter.consume('login:alice', t).allowed).toBe(true);
    expect(limiter.consume('login:alice', t + 1).allowed).toBe(false);
    limiter.reset('login:alice');
    expect(limiter.consume('login:alice', t + 2).allowed).toBe(true);
  });

  it('prunes expired buckets once the map grows past 10k', () => {
    const limiter = new FixedWindowLimiter(1, 1_000);
    const base = 1_000_000;
    for (let i = 0; i < 10_000; i++) limiter.consume(`ip-${i}`, base);
    expect(limiter.size).toBe(10_000);

    // one more key at a later time triggers the sweep of expired entries
    limiter.consume('fresh', base + 2_000);
    expect(limiter.size).toBe(1);
  });

  it('refuses invalid configuration', () => {
    expect(() => new FixedWindowLimiter(0, 1_000)).toThrow();
    expect(() => new FixedWindowLimiter(1, 0)).toThrow();
    expect(() => new FixedWindowLimiter(1.5, 1_000)).toThrow();
  });
});
