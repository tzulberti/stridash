import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, hashPassword, verifyPassword } from '../src/crypto.js';

describe('password hashing', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(stored.startsWith('scrypt:16384:8:1:')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('wrong horse battery staple', stored)).toBe(false);
  });

  it('treats malformed stored hashes as a failed login instead of throwing', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:not:a:hash')).toBe(false);
    expect(await verifyPassword('x', 'argon2:1:2:3:c2FsdA==:aGFzaA==')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:16384:8:1::')).toBe(false);
  });
});

describe('token encryption at rest', () => {
  const key = 'test-encryption-key-0123456789abcdef';

  it('round-trips and never reuses an IV', () => {
    const first = encryptToken('secret-token', key);
    const second = encryptToken('secret-token', key);

    expect(first).toMatch(/^v1:/);
    expect(first).not.toBe(second);
    expect(decryptToken(first, key)).toBe('secret-token');
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const [, iv, tag, ciphertext] = encryptToken('secret-token', key).split(':');
    const data = Buffer.from(ciphertext!, 'base64');
    data[0] = data[0]! ^ 0xff;
    const tampered = `v1:${iv}:${tag}:${data.toString('base64')}`;

    expect(() => decryptToken(tampered, key)).toThrow();
  });

  it('rejects an unknown ciphertext version', () => {
    expect(() => decryptToken('v2:a:b:c', key)).toThrow(/Unknown encrypted token format/);
  });
});
