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
  const providerKey = 'test-provider-key-0123456789abcdef';
  const config = {
    STRIDASH_ENC_KEY: key,
    STRIDASH_PROVIDER_ENC_KEY: providerKey,
    STRIDASH_ENC_KEY_ID: 'app-1',
    STRIDASH_PROVIDER_ENC_KEY_ID: 'provider-1',
    STRIDASH_ENC_SALT: 'test-kdf-salt',
  };

  it('legacy v1 round-trips and never reuses an IV', () => {
    const first = encryptToken('secret-token', key);
    const second = encryptToken('secret-token', key);

    expect(first).toMatch(/^v1:/);
    expect(first).not.toBe(second);
    expect(decryptToken(first, key)).toBe('secret-token');
  });

  it('decrypts legacy v1 rows with the full key configuration', () => {
    const legacy = encryptToken('secret-token', key);
    expect(decryptToken(legacy, config)).toBe('secret-token');
  });

  it('v2 embeds the key id + KDF salt and uses the provider key', () => {
    const first = encryptToken('secret-token', config);
    const second = encryptToken('secret-token', config);

    expect(first).toMatch(/^v2:provider-1:/);
    expect(first).not.toBe(second);
    expect(decryptToken(first, config)).toBe('secret-token');

    // a different active salt does not matter: v2 carries its own salt
    expect(decryptToken(first, { ...config, STRIDASH_ENC_SALT: 'another-salt' })).toBe(
      'secret-token',
    );
  });

  it('uses a per-process KDF salt when none is configured', () => {
    const bare = { STRIDASH_ENC_KEY: key };
    const encrypted = encryptToken('secret-token', bare);
    expect(encrypted).toMatch(/^v2:app-v1:/);
    expect(decryptToken(encrypted, bare)).toBe('secret-token');
    // legacy v1 still uses the fixed salt, not the random v2 fallback
    expect(decryptToken(encryptToken('secret-token', key), bare)).toBe('secret-token');
  });

  it('does not decrypt a provider-key row without the provider key', () => {
    const encrypted = encryptToken('secret-token', config);
    expect(() =>
      decryptToken(encrypted, {
        STRIDASH_ENC_KEY: key,
        STRIDASH_ENC_KEY_ID: 'app-1',
      }),
    ).toThrow(/Unknown encryption key id/);
  });

  it('uses retirement keys to decrypt rows from an older key id', () => {
    const oldProvider = 'old-provider-key-0123456789abcdef';
    const encrypted = encryptToken('secret-token', {
      ...config,
      STRIDASH_PROVIDER_ENC_KEY: oldProvider,
      STRIDASH_PROVIDER_ENC_KEY_ID: 'provider-old',
      STRIDASH_ENC_SALT: 'old-salt',
    });

    const rotated = {
      ...config,
      STRIDASH_PROVIDER_ENC_KEY: 'new-provider-key-0123456789abcdef',
      STRIDASH_PROVIDER_ENC_KEY_ID: 'provider-2',
      STRIDASH_ENC_SALT: 'new-salt',
      STRIDASH_ENC_OLD_KEYS: JSON.stringify({ 'provider-old': oldProvider }),
    };
    expect(decryptToken(encrypted, rotated)).toBe('secret-token');
  });

  it('uses retirement keys to decrypt legacy v1 rows after app-key rotation', () => {
    const oldApp = 'old-app-key-0123456789abcdefghij';
    const encrypted = encryptToken('secret-token', oldApp);

    const rotated = {
      STRIDASH_ENC_KEY: 'new-app-key-0123456789abcdefghij',
      STRIDASH_ENC_OLD_KEYS: JSON.stringify({ 'app-old': oldApp }),
    };
    expect(decryptToken(encrypted, rotated)).toBe('secret-token');
  });

  it('rejects tampered v1 and v2 ciphertext (GCM auth tag)', () => {
    for (const encrypted of [
      encryptToken('secret-token', key),
      encryptToken('secret-token', config),
    ]) {
      const parts = encrypted.split(':');
      const dataIndex = encrypted.startsWith('v1:') ? 3 : 5;
      const data = Buffer.from(parts[dataIndex]!, 'base64');
      data[0] = data[0]! ^ 0xff;
      parts[dataIndex] = data.toString('base64');
      expect(() => decryptToken(parts.join(':'), config)).toThrow();
    }
  });

  it('rejects malformed or unknown ciphertext formats', () => {
    expect(() => decryptToken('v2:a:b:c', key)).toThrow(/Unknown encrypted token format/);
    expect(() => decryptToken('v3:a:b:c:d', key)).toThrow(/Unknown encrypted token format/);
    expect(() => decryptToken(encryptToken('secret-token', config), key)).toThrow(
      /v2 tokens require a key configuration/,
    );
  });
});
