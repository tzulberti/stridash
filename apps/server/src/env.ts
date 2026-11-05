import { z } from "zod";

/**
 * Environment config. Validated once at startup — fail fast, not at request
 * time. Provider API credentials are NOT here: they are per-user OAuth /
 * account credentials stored encrypted in the `connections` table.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  STRIDASH_JWT_SECRET: z.string().min(32, "JWT secret must be ≥32 chars (use `openssl rand -hex 32`)"),
  STRIDASH_ENC_KEY: z.string().min(32, "Encryption key must be ≥32 chars (use `openssl rand -hex 32`)"),
  PORT: z.coerce.number().int().positive().default(3000),
  STRIDASH_VERSION: z.string().default("0.1.0-dev"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nSee apps/server/.env.example`);
  }

  return parsed.data;
}
