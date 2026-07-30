// Minimal ZIP reader — enough to pull a single named entry out of an Office
// file. Uses the platform's DecompressionStream, so there is no dependency and
// nothing to keep patched.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

/** Refuse absurd expansions — a decompression bomb must not hang the page. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export class ZipError extends Error {}

function findEocd(view: DataView): number {
  // The EOCD sits at the end, after an optional comment of up to 65535 bytes.
  const maxScan = Math.min(view.byteLength, 65535 + 22);
  for (let i = 22; i <= maxScan; i++) {
    const offset = view.byteLength - i;
    if (offset < 0) break;
    if (view.getUint32(offset, true) === EOCD_SIG) return offset;
  }
  throw new ZipError('Not a valid ZIP archive (no end-of-directory record).');
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(view: DataView, bytes: Uint8Array): CentralEntry[] {
  const eocd = findEocd(view);

  // ZIP64 archives put the real offsets elsewhere. Office files this large are
  // vanishingly rare, and guessing would corrupt the read, so refuse clearly.
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new ZipError('ZIP64 archives are not supported.');
  }

  let offset = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  const entries: CentralEntry[] = [];
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIG) {
      throw new ZipError('Corrupt ZIP central directory.');
    }
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    entries.push({
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen)),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot decompress ZIP archives.');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ZipError('This file expands to more than 32 MB and was not opened.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Reads one entry by exact name. Returns null when the archive has no such entry. */
export async function readZipEntry(buffer: ArrayBuffer, entryName: string): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entry = readCentralDirectory(view, bytes).find((e) => e.name === entryName);
  if (!entry) return null;

  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError('That document is too large to import.');
  }

  const local = entry.localHeaderOffset;
  if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL_SIG) {
    throw new ZipError('Corrupt ZIP entry header.');
  }
  // Local headers carry their own name/extra lengths, which can differ from
  // the central directory's — always trust the local ones for the data offset.
  const nameLen = view.getUint16(local + 26, true);
  const extraLen = view.getUint16(local + 28, true);
  const dataStart = local + 30 + nameLen + extraLen;
  const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  let out: Uint8Array;
  if (entry.method === 0) {
    out = raw;
  } else if (entry.method === 8) {
    out = await inflateRaw(raw);
  } else {
    throw new ZipError(`Unsupported ZIP compression method ${entry.method}.`);
  }
  return new TextDecoder('utf-8').decode(out);
}
