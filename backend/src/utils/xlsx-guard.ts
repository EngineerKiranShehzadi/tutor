import { inflateRawSync } from 'zlib';
import { AppError } from '../middleware/errorHandler';

// An .xlsx is a zip. The 10 MB upload limit applies to the COMPRESSED file, and
// XML compresses extremely well, so a small file can inflate to gigabytes and
// freeze or crash the shared server while it is parsed. This checks the zip
// before the spreadsheet parser sees it:
//   - it must be a plain zip (not zip64, no exotic compression);
//   - entry count and the sizes the zip DECLARES must be within limits;
//   - every entry is actually inflated with a hard output cap, so a zip that
//     lies about its sizes is caught too.
// Real lecture datasets inflate to under 1 MB (≈20 entries), far below the defaults.

export interface XlsxLimits {
  maxUncompressedBytes: number;
  maxEntries: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const reject = (message: string): never => { throw new AppError(message, 400); };
const notXlsx = (): never => reject('The file is not a valid .xlsx workbook.');

export function assertSafeXlsx(buf: Buffer, limits: XlsxLimits): void {
  // A zip starts with a local file header ("PK\x03\x04"); anything else is refused at once.
  if (buf.length < 30 || buf.readUInt32LE(0) !== LFH_SIG) notXlsx();
  // End-of-central-directory record: last 22 bytes, plus up to 64 KB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) notXlsx();

  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) reject('The workbook uses an unsupported zip format (zip64).');
  if (entries > limits.maxEntries) reject(`The workbook has too many internal parts (${entries}; the limit is ${limits.maxEntries}).`);

  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  const tooBig = (): never =>
    reject(`The workbook expands to more than ${mb(limits.maxUncompressedBytes)} when opened — too large to import. Remove unused sheets or rows.`);

  let declared = 0;
  let actual = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) notXlsx();
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      reject('The workbook uses an unsupported zip format (zip64).');
    }
    declared += uncompSize;
    if (declared > limits.maxUncompressedBytes) tooBig();

    // The data starts after the local header (its name/extra lengths can differ from the central copy).
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIG) notXlsx();
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > buf.length) notXlsx();
    const data = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      actual += compSize;
    } else if (method === 8) {
      const budget = limits.maxUncompressedBytes - actual;
      try {
        actual += inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }).length;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) tooBig();
        notXlsx();
      }
    } else {
      reject('The workbook uses an unsupported compression method.');
    }
    if (actual > limits.maxUncompressedBytes) tooBig();
  }
}
