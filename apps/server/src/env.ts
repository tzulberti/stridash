import { z } from 'zod';

/**
 * Environment config. Validated once at startup — fail fast, not at request
 * time. Provider API credentials are NOT here: they are per-user OAuth /
 * account credentials stored encrypted in the `connections` table.
 */
const databaseUrlSchema = z
  .string()
  .url()
  .refine((value) => /^postgres(?:ql)?:\/\//.test(value), {
    message: 'Must be a postgres:// or postgresql:// URL',
  });
const databaseEnvSchema = z.object({ DATABASE_URL: databaseUrlSchema });

const envSchema = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    STRIDASH_JWT_SECRET: z
      .string()
      .min(32, 'JWT secret must be ≥32 chars (use `openssl rand -hex 32`)'),
    STRIDASH_ENC_KEY: z
      .string()
      .min(32, 'Encryption key must be ≥32 chars (use `openssl rand -hex 32`)'),
    /**
     * Optional dedicated key for provider credentials (tokens, iGPSPORT
     * passwords). New writes use it; legacy `v1` rows still decrypt with
     * STRIDASH_ENC_KEY. Generate with `openssl rand -hex 32`.
     */
    STRIDASH_PROVIDER_ENC_KEY: z.string().min(32, 'Provider key must be ≥32 chars').optional(),
    /** Stable id stored in v2 ciphertext; defaults to app-v1 / provider-v1. */
    STRIDASH_ENC_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/, 'Key id must be 1–32 chars: A-Z a-z 0-9 . _ -')
      .optional(),
    STRIDASH_PROVIDER_ENC_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/, 'Key id must be 1–32 chars: A-Z a-z 0-9 . _ -')
      .optional(),
    /**
     * KDF salt for v2 writes. Optional; a random per-process salt is used when
     * absent (v2 embeds it). v1 reads always use the legacy fixed salt.
     * Generate with `openssl rand -base64 16`.
     */
    STRIDASH_ENC_SALT: z.string().min(8, 'KDF salt must be at least 8 chars').optional(),
    /**
     * JSON object of retired `{ "<keyId>": "<key>" }` pairs, decrypt-only.
     * Keep the previous key here while re-encrypting, then remove it.
     */
    STRIDASH_ENC_OLD_KEYS: z
      .string()
      .optional()
      .refine((value) => {
        if (!value) return true;
        try {
          const parsed = JSON.parse(value) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
          return Object.entries(parsed).every(
            ([id, key]) =>
              /^[A-Za-z0-9._-]{1,32}$/.test(id) && typeof key === 'string' && key.length >= 32,
          );
        } catch {
          return false;
        }
      }, 'STRIDASH_ENC_OLD_KEYS must be a JSON object of keyId → key (keys ≥32 chars)'),
    PORT: z.coerce.number().int().positive().default(3000),
    STRIDASH_VERSION: z.string().default('0.1.0-dev'),
    /**
     * Built dashboard directory. Defaults to `apps/web/dist`; set it when the
     * web build is mounted or copied elsewhere.
     */
    STRIDASH_WEB_DIST: z.string().optional(),

    // ─── Auth rate limiting (see rate-limit.ts) ───────────────────────────────
    /** Requests per IP across /api/auth/* within one window (default 30/15 min). */
    STRIDASH_AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    /** Window for the per-IP limiter, and the default for the per-email one. */
    STRIDASH_AUTH_RATE_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    /**
     * Registration attempts per IP within one window (default 10/15 min).
     * Compensating control for the accepted registration-enumeration risk.
     */
    STRIDASH_REGISTER_RATE_LIMIT: z.coerce.number().int().positive().default(10),
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
  })
  .refine(
    (v) =>
      !v.STRIDASH_PROVIDER_ENC_KEY ||
      (v.STRIDASH_ENC_KEY_ID ?? 'app-v1') !== (v.STRIDASH_PROVIDER_ENC_KEY_ID ?? 'provider-v1'),
    {
      message: 'STRIDASH_PROVIDER_ENC_KEY_ID must differ from STRIDASH_ENC_KEY_ID',
      path: ['STRIDASH_PROVIDER_ENC_KEY_ID'],
    },
  );

export type Env = z.infer<typeof envSchema>;

function formatEnvIssues(error: z.ZodError): string {
  const issues = error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  return `Invalid environment configuration:\n${issues}\nSee apps/server/.env.example`;
}

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) throw new Error(formatEnvIssues(parsed.error));

  return parsed.data;
}

/**
 * Validate just the database URL before the Prisma singleton is created. The
 * full env needs auth/encryption secrets that command-line DB scripts do not
 * necessarily use; this still fails at startup instead of the first query.
 */
export function loadDatabaseUrl(): string {
  const parsed = databaseEnvSchema.safeParse(process.env);

  if (!parsed.success) throw new Error(formatEnvIssues(parsed.error));

  return parsed.data.DATABASE_URL;
}
