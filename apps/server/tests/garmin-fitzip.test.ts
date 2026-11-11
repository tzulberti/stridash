/**
 * Garmin download blob → FIT member extraction (fitzip.ts).
 *
 * Real Garmin downloads are streamed ZIPs (data-descriptor entries → the
 * local header's compressedSize is 0) wrapping one .fit member. Builds a
 * synthetic buggy-in-all-the-right-ways zip here: DEFLATE'd member named
 * like Garmin's ("…_ACTIVITY.fit") with compressedSize = 0, plus a stored
 * bare-FIT passthrough check.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { extractFitFromDownload } from '../src/providers/garmin/fitzip.js';

function localHeader(
  name: string,
  method: number,
  compressedSize: number,
): { header: Buffer; start: number } {
  const nameBuf = Buffer.from(name, 'utf8');
  const h = Buffer.alloc(30 + nameBuf.length);
  h.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  h.writeUInt16LE(method, 8);
  h.writeUInt32LE(compressedSize, 18); // 0 = data descriptor / streamed
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt32LE(0, 22); // extra len 0 (masked by write ordering)
  nameBuf.copy(h, 30);
  return { header: h, start: 0 };
}

describe('extractFitFromDownload', () => {
  it("unwraps a streamed (data-descriptor) ZIP with one DEFLATE'd .fit member", () => {
    const payload = Buffer.from(
      Array.from({ length: 3256 }, (_, i) => i & 0xff), // mimics a FIT blob
    );
    const deflated = deflateRawSync(payload);

    const name = '24945898776_ACTIVITY.fit';
    const { header } = localHeader(name, 8, 0); // size 0: streamed zip
    const zip = Buffer.concat([header, deflated, Buffer.from('trailer central dir…')]);

    const fit = extractFitFromDownload(zip);
    expect(fit.toString('hex')).toBe(payload.toString('hex'));
  });

  it('passes bare FIT bytes through untouched', () => {
    const fit = Buffer.from('0e10-this-is-not-a-zip');
    expect(extractFitFromDownload(fit)).toBe(fit);
  });
});
