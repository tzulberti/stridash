/**
 * Password hashing + token-at-rest encryption.
 *
 * No crypto library deps on purpose: node:crypto covers everything we need.
 * - passwords: scrypt with per-user random salt (async — never block the
 *   event loop on a login attempt)
 * - provider tokens: AES-256-GCM, key derived from STRIDASH_ENC_KEY once and
 *   memoized (the key is process-wide; deriving it per encrypt/decrypt call
 *   used to cost a full scrypt run each time)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

// ─── Passwords ───────────────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN = 64;

/** scrypt on the libuv threadpool — a login must never stall other requests. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Format: "scrypt:$N:$r:$p:$salt_b64:$hash_b64" (argon2-style, upgradable). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, HASH_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split(':');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;

  const N = Number(n);
  const rParam = Number(r);
  const pParam = Number(p);
  // A corrupted/tampered hash must read as "wrong password", never throw (and
  // never hand arbitrary scrypt parameters to the KDF).
  if (!Number.isInteger(N) || !Number.isInteger(rParam) || !Number.isInteger(pParam)) return false;
  if (N < 2 || rParam < 1 || pParam < 1) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;

  try {
    const actual = await scryptAsync(password, salt, expected.length, {
      N,
      r: rParam,
      p: pParam,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ─── Token encryption at rest ────────────────────────────────────────────────

/** Derived keys are cheap to keep and expensive to compute — one per key. */
const derivedKeys = new Map<string, Buffer>();

function deriveKey(encKey: string): Buffer {
  const cached = derivedKeys.get(encKey);
  if (cached) return cached;
  const key = scryptSync(encKey, 'stridash-connections', 32);
  derivedKeys.set(encKey, key);
  return key;
}

const ALGO = 'aes-256-gcm';

/** Returns "v1:$iv_b64:$tag_b64:$ciphertext_b64" */
export function encryptToken(plaintext: string, encKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(encKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptToken(encrypted: string, encKey: string): string {
  const [version, ivB64, tagB64, dataB64] = encrypted.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unknown encrypted token format');
  }
  const decipher = createDecipheriv(ALGO, deriveKey(encKey), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
