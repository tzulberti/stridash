/**
 * Minimal in-process rate limiting for the auth surface.
 *
 * A self-hosted Stridash is a single Node process, so a fixed-window counter
 * in memory is enough — no Redis, no extra dependency. Limits come from the
 * environment (see env.ts) so tests and unusual deployments can tune them.
 *
 * Keys:
 *  - `clientKey()` → the caller's IP (or X-Forwarded-For when TRUST_PROXY is
 *    enabled) — protects register/login/refresh/logout as a whole.
 *  - the auth routes additionally keep a per-email bucket for login, so
 *    password guessing against one account is capped even behind NAT.
 */

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 once blocked). */
  remaining: number;
  /** Seconds until the window resets — what a 429 should advertise. */
  retryAfterS: number;
  /** Epoch ms when the current window ends. */
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Rate limit must be a positive integer');
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error('Rate limit window must be a positive integer (ms)');
    }
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    const current = this.buckets.get(key);

    if (!current || current.resetAt <= now) {
      // opportunistic sweep: a map keyed by attacker-controlled IPs must not
      // grow forever; only sweep once it is worth the O(n) walk
      if (this.buckets.size >= 10_000) this.prune(now);
      const resetAt = now + this.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.limit - 1, retryAfterS: 0, resetAt };
    }

    if (current.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterS: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
        resetAt: current.resetAt,
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: this.limit - current.count,
      retryAfterS: 0,
      resetAt: current.resetAt,
    };
  }

  /** Forget a key — called after a successful login so the next one starts clean. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Caller identity for rate limiting.
 *
 * `app.request()` (integration tests, in-process calls) has no socket, and
 * `getConnInfo` throws there — fall back to a shared "unknown" key so the
 * limiter still works (and tests can exercise it).
 *
 * X-Forwarded-For is only honoured when the operator explicitly says the
 * server sits behind a trusted proxy; otherwise a client could spoof the
 * header and bypass the limit.
 */
export function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return first;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
