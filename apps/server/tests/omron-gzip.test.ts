import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gunzipCapped } from '../src/providers/omron/client.js';

describe('gunzipCapped', () => {
  it('decompresses within the cap', () => {
    const input = Buffer.from('{"ok":true}');
    expect(gunzipCapped(gzipSync(input)).toString('utf8')).toBe('{"ok":true}');
  });

  it('refuses a gzip bomb above maxOutputLength', () => {
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x61));
    expect(bomb.length).toBeLessThan(8 * 1024); // tiny on the wire
    expect(() => gunzipCapped(bomb, 1024 * 1024)).toThrow();
  });
});
