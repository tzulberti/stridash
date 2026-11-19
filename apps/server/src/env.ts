import { z } from 'zod';

/**
 * Environment config. Validated once at startup — fail fast, not at request
 * time. Provider API credentials are NOT here: they are per-user OAuth /
 * account credentials stored encrypted in the `connections` table.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  STRIDASH_JWT_SECRET: z
    .string()
    .min(32, 'JWT secret must be ≥32 chars (use `openssl rand -hex 32`)'),
  STRIDASH_ENC_KEY: z
    .string()
    .min(32, 'Encryption key must be ≥32 chars (use `openssl rand -hex 32`)'),
  PORT: z.coerce.number().int().positive().default(3000),
  STRIDASH_VERSION: z.string().default('0.1.0-dev'),

  // ─── Auth rate limiting (see rate-limit.ts) ───────────────────────────────
  /** Requests per IP across /api/auth/* within one window (default 30/15 min). */
  STRIDASH_AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  /** Window for the per-IP limiter, and the default for the per-email one. */
  STRIDASH_AUTH_RATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  /** Login attempts per email within one window (default 10/15 min). */
  STRIDASH_LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Connection attempts per user within one window (default 10/15 min). */
  STRIDASH_CONNECTION_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Window for the per-user connection-create limiter (default 15 min). */
  STRIDASH_CONNECTION_RATE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  /**
   * Trust `X-Forwarded-For` for the client IP. Only enable when the server
   * sits behind a reverse proxy that overwrites the header — otherwise a
   * client can spoof it and bypass the limiter.
   */
  STRIDASH_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\nSee apps/server/.env.example`);
  }

  return parsed.data;
}
