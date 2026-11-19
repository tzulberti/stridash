import { describe, expect, it } from 'vitest';
import { redactProviderDetail, redactText, safeErrorForLog } from '../src/redact.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLXNlY3JldA';

describe('redactProviderDetail', () => {
  it('redacts known token keys but keeps a short identifier', () => {
    const out = redactProviderDetail({
      error: 'token rejected',
      access_token: JWT,
      nested: { refreshToken: 'refresh-secret-value-0123456789', password: 'hunter2' },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(JWT);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(String(out.access_token)).toContain('…');
  });

  it('scrubs Bearer and JWT values embedded in free text', () => {
    const out = redactProviderDetail({
      message: `upstream said Authorization: Bearer ${JWT} and also ${JWT}`,
    }) as { message: string };
    expect(out.message).toContain('Bearer [redacted]');
    expect(out.message).not.toContain(JWT);
    expect(out.message).not.toContain('c2lnbmF0dXJlLXNlY3JldA');
  });

  it('handles arrays, depth and non-string leaves', () => {
    expect(redactProviderDetail([{ token: 'abcdefghijklmnopqrstuvwxyz' }, 42, null])).toEqual([
      { token: 'abcdefghijkl…wxyz' },
      42,
      null,
    ]);
  });
});

describe('redactText', () => {
  it('leaves harmless text untouched', () => {
    expect(redactText('Omron API error on /measureData (HTTP 500)')).toBe(
      'Omron API error on /measureData (HTTP 500)',
    );
  });

  it('redacts multiple credential-shaped substrings', () => {
    const text = `a Bearer abcdefgh12345678 b ${JWT}`;
    const out = redactText(text);
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('abcdefgh12345678');
    expect(out).not.toContain(JWT);
  });
});

describe('safeErrorForLog', () => {
  it('keeps name/message/stack and redacts custom provider fields', () => {
    const err = Object.assign(new Error(`failed with Bearer ${JWT}`), {
      status: 401,
      detail: { access_token: JWT, hint: `retry with Bearer ${JWT}` },
    });
    const out = safeErrorForLog(err) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.status).toBe(401);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(JWT);
    expect(String(out.message)).toContain('Bearer [redacted]');
  });

  it('redacts plain objects and primitives', () => {
    expect(safeErrorForLog({ token: JWT })).toEqual({ token: expect.stringContaining('…') });
    expect(safeErrorForLog('Bearer abcdefgh12345678')).toBe('Bearer [redacted]');
    expect(safeErrorForLog(null)).toBeNull();
  });
});
