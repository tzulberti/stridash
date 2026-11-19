/**
 * Re-encrypt every stored provider token with the active key id / KDF salt.
 *
 * Run this AFTER configuring the new key material and BEFORE removing the old
 * key from `STRIDASH_ENC_OLD_KEYS`. Tokens are decrypted with the current key
 * ring (old keys included), then written as v2 with the active key. A dry run
 * reports the rows without writing.
 *
 *   npm run crypto:reencrypt -w @stridash/server
 *   npm run crypto:reencrypt -w @stridash/server -- --dry-run
 */

import { prisma } from '../db.js';
import { decryptToken, encryptToken } from '../crypto.js';
import { loadEnv } from '../env.js';

const env = loadEnv();
const dryRun = process.argv.includes('--dry-run');

const rows = await prisma.connection.findMany({
  select: {
    id: true,
    provider: true,
    accessTokenEnc: true,
    refreshTokenEnc: true,
  },
});

let rewritten = 0;
let skipped = 0;
let failed = 0;

for (const row of rows) {
  const data: { accessTokenEnc?: string; refreshTokenEnc?: string } = {};
  for (const field of ['accessTokenEnc', 'refreshTokenEnc'] as const) {
    const stored = row[field];
    if (!stored) continue;
    try {
      data[field] = encryptToken(decryptToken(stored, env), env);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reencrypt] ${row.provider} ${row.id} ${field}: ${message}`);
    }
  }

  if (Object.keys(data).length === 0) {
    skipped += 1;
    continue;
  }
  if (!dryRun) await prisma.connection.update({ where: { id: row.id }, data });
  rewritten += 1;
}

console.log(
  `[reencrypt] ${dryRun ? 'dry-run: would rewrite' : 'rewrote'} ${rewritten} connection(s), skipped ${skipped}, failed ${failed}`,
);

await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;
