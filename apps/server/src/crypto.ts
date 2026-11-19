/**
 * Password hashing + token-at-rest encryption.
 *
 * No crypto library deps on purpose: node:crypto covers everything we need.
 * - passwords: scrypt with per-user random salt (async — never block the
 *   event loop on a login attempt)
 * - provider tokens: AES-256-GCM, key derived via scrypt and memoized per
 *   (key, salt) pair (deriving it on every encrypt/decrypt used to cost a full
 *   scrypt run each call). `v2` ciphertext embeds a key id + salt so keys can
 *   be rotated; `v1` remains readable for existing rows.
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

/**
 * Key material for provider tokens. `Env` structurally satisfies this; tests
 * may pass a bare key string to exercise the legacy `v1` format.
 *
 * Ciphertext formats:
 *  - `v1:<iv>:<tag>:<ct>` — legacy, fixed KDF salt, app key only
 *  - `v2:<keyId>:<salt>:<iv>:<tag>:<ct>` — key id + KDF salt embedded, so a
 *    deployment can rotate keys/salts and still decrypt old rows
 */
export interface TokenCipherConfig {
  STRIDASH_ENC_KEY: string;
  STRIDASH_PROVIDER_ENC_KEY?: string | undefined;
  STRIDASH_ENC_KEY_ID?: string | undefined;
  STRIDASH_PROVIDER_ENC_KEY_ID?: string | undefined;
  STRIDASH_ENC_SALT?: string | undefined;
  /** JSON object `{ "<keyId>": "<key>" }`; decryption-only retirement keys. */
  STRIDASH_ENC_OLD_KEYS?: string | undefined;
}

const LEGACY_KDF_SALT = 'stridash-connections';
/** Random when the operator does not pin one; v2 embeds it, so reads still work. */
const DEFAULT_V2_KDF_SALT = randomBytes(16).toString('base64');
const DEFAULT_APP_KEY_ID = 'app-v1';
const DEFAULT_PROVIDER_KEY_ID = 'provider-v1';

/** Derived keys are cheap to keep and expensive to compute — one per key+salt. */
const derivedKeys = new Map<string, Buffer>();

function deriveKey(encKey: string, salt: string): Buffer {
  const cacheKey = `${encKey}\0${salt}`;
  const cached = derivedKeys.get(cacheKey);
  if (cached) return cached;
  const key = scryptSync(encKey, salt, 32);
  derivedKeys.set(cacheKey, key);
  return key;
}

const ALGO = 'aes-256-gcm';

interface ActiveKey {
  keyId: string;
  key: string;
}

/** New encryptions use the dedicated provider key when configured. */
function activeKey(config: TokenCipherConfig): ActiveKey {
  if (config.STRIDASH_PROVIDER_ENC_KEY) {
    return {
      keyId: config.STRIDASH_PROVIDER_ENC_KEY_ID ?? DEFAULT_PROVIDER_KEY_ID,
      key: config.STRIDASH_PROVIDER_ENC_KEY,
    };
  }
  return {
    keyId: config.STRIDASH_ENC_KEY_ID ?? DEFAULT_APP_KEY_ID,
    key: config.STRIDASH_ENC_KEY,
  };
}

function oldKeys(config: TokenCipherConfig): Record<string, string> {
  if (!config.STRIDASH_ENC_OLD_KEYS) return {};
  try {
    const parsed = JSON.parse(config.STRIDASH_ENC_OLD_KEYS) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** Resolve a v2 key id: active app/provider key first, then retirement keys. */
function keyForId(config: TokenCipherConfig, keyId: string): string {
  const appId = config.STRIDASH_ENC_KEY_ID ?? DEFAULT_APP_KEY_ID;
  const providerId = config.STRIDASH_PROVIDER_ENC_KEY_ID ?? DEFAULT_PROVIDER_KEY_ID;
  const active = activeKey(config);
  if (keyId === active.keyId) return active.key;
  if (keyId === appId) return config.STRIDASH_ENC_KEY;
  if (keyId === providerId && config.STRIDASH_PROVIDER_ENC_KEY) {
    return config.STRIDASH_PROVIDER_ENC_KEY;
  }
  const retired = oldKeys(config)[keyId];
  if (retired) return retired;
  throw new Error(`Unknown encryption key id: ${keyId}`);
}

/** v1 has no key id: try the active app key, then retirement keys. */
function legacyKeyCandidates(config: TokenCipherConfig | string): string[] {
  if (typeof config === 'string') return [config];
  const keys = [config.STRIDASH_ENC_KEY, ...Object.values(oldKeys(config))];
  return [...new Set(keys)];
}

function decryptWith(
  key: string,
  salt: string,
  ivB64: string,
  tagB64: string,
  dataB64: string,
): string {
  const decipher = createDecipheriv(ALGO, deriveKey(key, salt), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Encrypt a provider token. A bare string keeps the legacy `v1` format (used
 * by tests); the server passes `env`, which enables `v2` with the provider key.
 */
export function encryptToken(plaintext: string, config: string | TokenCipherConfig): string {
  if (typeof config === 'string') {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, deriveKey(config, LEGACY_KDF_SALT), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
  }

  const active = activeKey(config);
  const salt = config.STRIDASH_ENC_SALT ?? DEFAULT_V2_KDF_SALT;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(active.key, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v2',
    active.keyId,
    Buffer.from(salt, 'utf8').toString('base64'),
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptToken(encrypted: string, config: string | TokenCipherConfig): string {
  const parts = encrypted.split(':');
  const version = parts[0];

  if (version === 'v1') {
    const [, ivB64, tagB64, dataB64] = parts;
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Unknown encrypted token format');
    let lastError: unknown;
    for (const key of legacyKeyCandidates(config)) {
      try {
        return decryptWith(key, LEGACY_KDF_SALT, ivB64, tagB64, dataB64);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('Unknown encrypted token format');
  }

  if (version === 'v2') {
    const [, keyId, saltB64, ivB64, tagB64, dataB64] = parts;
    if (!keyId || !saltB64 || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Unknown encrypted token format');
    }
    if (typeof config === 'string') throw new Error('v2 tokens require a key configuration');
    const salt = Buffer.from(saltB64, 'base64').toString('utf8');
    return decryptWith(keyForId(config, keyId), salt, ivB64, tagB64, dataB64);
  }

  throw new Error('Unknown encrypted token format');
}
