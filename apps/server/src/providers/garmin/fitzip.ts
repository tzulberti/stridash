/**
 * Garmin FIT extraction.
 *
 * `/download-service/files/activity/<id>` answers `application/x-zip-compressed`:
 * a ZIP archive whose member is the activity's actual `.FIT` file (verified
 * live against a real account, 2026-11). Some accounts/older paths answer bare
 * FIT bytes, so detection is by ZIP magic. This mirrors what python-garminconnect
 * does after the same download.
 *
 * The extractor is deliberately tiny: Garmin archives have exactly one member,
 * with the FIT either STORED or DEFLATE-compressed — enough to parse both
 * local-file-header formats by hand with node zlib.
 */

import { inflateRawSync } from 'node:zlib';
import { parseFitSeries } from '../igpsport/fit.js';
import type { FitRecord } from '../igpsport/normalize.js';

const ZIP_MAGIC = 0x04_03_4b_50; // readUInt32LE of bytes "PK\x03\x04"
const FIT_EXT = '.fit';

/** Extract the FIT member of a zip-wrapped download; passthrough for bare FIT. */
export function extractFitFromDownload(buf: Buffer): Buffer {
  if (buf.length < 4 || buf.readUInt32LE(0) !== ZIP_MAGIC) return buf; // bare FIT

  const offset = findZipMemberOffset(buf, FIT_EXT);
  if (offset === null) {
    throw new Error('Garmin download is a ZIP but contains no .FIT member');
  }
  return readZipMember(buf, offset);
}

interface ZipHeader {
  getName: () => string;
  method: number;
  compressedSize: number;
  dataStart: number;
}

/** Walk local file headers; return the compressed-data start of the .FIT member. */
function findZipMemberOffset(buf: Buffer, ext: string): ZipHeader | null {
  let pos = 0;
  while (pos + 30 <= buf.length) {
    if (buf.readUInt32LE(pos) !== ZIP_MAGIC) break; // not a local header
    const method = buf.readUInt16LE(pos + 8);
    const compressedSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    // crc32/size fields are 0 in data-descriptor ("streamed zip") entries —
    // those are the ones Garmin actually emits, sizes are trustworthy anyway
    // because they re-appear post-EOCD… except when not. Safer: rely on name
    // + compressedSize and skip to the next header conservatively.
    const name = buf
      .subarray(nameStart, nameStart + nameLen)
      .toString('utf8')
      .toLowerCase();
    if (name.endsWith(ext)) {
      return {
        getName: () => name,
        method,
        compressedSize,
        dataStart: nameStart + nameLen + extraLen,
      };
    }
    const prevPos = pos;
    pos = nameStart + nameLen + extraLen + (compressedSize || 0);
    // guarded advance: data-descriptor ("streamed zip") entries lie with a 0
    // compressedSize — no forward progress means we cannot walk further
    // (Garmin's bundles put the FIT member first, so hitting this after it is
    // a bail-out, not a bug)
    if (pos <= prevPos || pos > buf.length) return null;
  }
  return null;
}

function readZipMember(buf: Buffer, header: ZipHeader): Buffer {
  const data = buf.subarray(header.dataStart, header.dataStart + header.compressedSize);
  if (header.method === 0) return Buffer.from(data); // stored
  if (header.method === 8) {
    // A streaming zipfile may leave compressedSize = 0 in the local header and
    // write the real value only in the central directory; if it is 0, inflate
    // with a big window and let inflateRawSync consume to the descriptor.
    const raw = header.compressedSize ? data : buf.subarray(header.dataStart);
    const out = inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 });
    return Buffer.from(out);
  }
  throw new Error(`unsupported ZIP compression method ${header.method} (Garmin FIT member)`);
}

/** PARSE a downloaded Garmin file into FIT records (zip-aware). */
export async function garminFitToSeries(buf: Buffer): Promise<FitRecord[]> {
  return parseFitSeries(extractFitFromDownload(buf));
}
