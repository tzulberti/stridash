/**
 * Password hashing + token-at-rest encryption.
 *
 * No crypto library deps on purpose: node:crypto covers everything we need.
 * - passwords: scrypt with per-user random salt
 * - provider tokens: AES-256-GCM, key derived from STRIDASH_ENC_KEY
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// ─── Passwords ───────────────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN = 64;

/** Format: "scrypt:$N:$r:$p:$salt_b64:$hash_b64" (argon2-style, upgradable). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split(":");
  if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;

  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

// ─── Token encryption at rest ────────────────────────────────────────────────

function deriveKey(encKey: string): Buffer {
  return scryptSync(encKey, "stridash-connections", 32);
}

const ALGO = "aes-256-gcm";

/** Returns "v1:$iv_b64:$tag_b64:$ciphertext_b64" */
export function encryptToken(plaintext: string, encKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(encKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptToken(encrypted: string, encKey: string): string {
  const [version, ivB64, tagB64, dataB64] = encrypted.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Unknown encrypted token format");
  }
  const decipher = createDecipheriv(ALGO, deriveKey(encKey), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
