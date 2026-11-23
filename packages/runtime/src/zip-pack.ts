/** One file an archive was written with, where its entry starts and ends. */
export interface PackedEntry {
  readonly path: string;
  readonly name: Uint8Array;
  readonly crc: number;
  readonly size: number;
  /** Where its local header starts, and where the next entry's, or the directory, does. */
  readonly offset: number;
  readonly end: number;
}

/** An archive's bytes, and each entry it holds. */
export interface Packed {
  readonly bytes: Uint8Array;
  readonly entries: readonly PackedEntry[];
}

/** What one archive holds at most: no ZIP64, so 65,535 entries, and what a reader sizes its memory by (`MOST_DECLARED`). */
export interface ArchiveLimits {
  readonly entries: number;
  readonly bytes: number;
}

export const MOST_ENTRIES = 0xffff;
/** The most an archive may declare of its files' sizes together (see `MOST_DECLARED` in archives.ts, which reads it). */
export const MOST_BYTES = 1024 * 1024 * 1024;

const LOCAL_LENGTH = 30;
const CENTRAL_LENGTH = 46;
const END_LENGTH = 22;
const UTF8 = 0x0800;
/** Every entry's date: 1980-01-01 00:00, the earliest a ZIP can say, so that the same files pack to the same bytes. */
const DOS_DATE = 0x0021;

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** `TABLE` and the seven that carry a byte through one to seven more bytes, so that eight bytes are one step. */
const SLICES = (() => {
  const slices = new Uint32Array(8 * 256);
  slices.set(TABLE);
  for (let slice = 1; slice < 8; slice++)
    for (let n = 0; n < 256; n++) {
      const before = slices[(slice - 1) * 256 + n] as number;
      slices[slice * 256 + n] =
        ((TABLE[before & 0xff] as number) ^ (before >>> 8)) >>> 0;
    }
  return slices;
})();

/** The CRC-32 of the bytes, eight at a time: a reader checks each file it takes from an archive by it. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  let at = 0;
  const eights = bytes.length - 7;
  for (; at < eights; at += 8) {
    const low =
      c ^
      ((bytes[at] as number) |
        ((bytes[at + 1] as number) << 8) |
        ((bytes[at + 2] as number) << 16) |
        ((bytes[at + 3] as number) << 24));
    c =
      (SLICES[1792 + (low & 0xff)] as number) ^
      (SLICES[1536 + ((low >>> 8) & 0xff)] as number) ^
      (SLICES[1280 + ((low >>> 16) & 0xff)] as number) ^
      (SLICES[1024 + (low >>> 24)] as number) ^
      (SLICES[768 + (bytes[at + 4] as number)] as number) ^
      (SLICES[512 + (bytes[at + 5] as number)] as number) ^
      (SLICES[256 + (bytes[at + 6] as number)] as number) ^
      (SLICES[bytes[at + 7] as number] as number);
  }
  for (; at < bytes.length; at++)
    c = (TABLE[(c ^ (bytes[at] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Byte order of the paths' UTF-8, which is not UTF-16 code unit order for a path outside the basic plane. */
function byName(one: PackedFile, other: PackedFile): number {
  const a = one.name;
  const b = other.name;
  const common = Math.min(a.length, b.length);
  for (let at = 0; at < common; at++) {
    const difference = (a[at] as number) - (b[at] as number);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

interface PackedFile {
  readonly path: string;
  readonly name: Uint8Array;
  readonly bytes: Uint8Array;
}

/**
 * The files as one archive in the profile X1 narrows ISO/IEC 21320-1 to: each entry stored, its path in UTF-8, every date
 * 1980-01-01 00:00, no extra field, no ZIP64, entries in the byte order of their paths, so that the same files make the
 * same bytes. Throws for a path given twice, and for more than a ZIP without ZIP64 holds: `archivesOf` splits first.
 */
export function packZip(
  files: readonly (readonly [string, Uint8Array])[],
): Packed {
  const encoder = new TextEncoder();
  const sorted: PackedFile[] = files
    .map(([path, bytes]) => ({ path, name: encoder.encode(path), bytes }))
    .sort(byName);
  if (sorted.length > MOST_ENTRIES)
    throw new Error(`${sorted.length} files are more than one archive holds`);
  for (let at = 1; at < sorted.length; at++)
    if ((sorted[at] as PackedFile).path === (sorted[at - 1] as PackedFile).path)
      throw new Error(`${(sorted[at] as PackedFile).path} is given twice`);
  let total = END_LENGTH;
  for (const { name, bytes } of sorted)
    total += LOCAL_LENGTH + CENTRAL_LENGTH + 2 * name.length + bytes.length;
  if (total >= 0xffffffff)
    throw new Error("the files are more than one archive holds");
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const entries: PackedEntry[] = [];
  const crcs: number[] = [];
  let at = 0;
  for (const { path, name, bytes } of sorted) {
    const crc = crc32(bytes);
    crcs.push(crc);
    const start = at;
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, UTF8, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_DATE, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, bytes.length, true);
    view.setUint32(at + 22, bytes.length, true);
    view.setUint16(at + 26, name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(name, at + LOCAL_LENGTH);
    out.set(bytes, at + LOCAL_LENGTH + name.length);
    at += LOCAL_LENGTH + name.length + bytes.length;
    entries.push({
      path,
      name,
      crc,
      size: bytes.length,
      offset: start,
      end: at,
    });
  }
  const directory = at;
  sorted.forEach(({ name, bytes }, index) => {
    const entry = entries[index] as PackedEntry;
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, UTF8, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, crcs[index] as number, true);
    view.setUint32(at + 20, bytes.length, true);
    view.setUint32(at + 24, bytes.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, entry.offset, true);
    out.set(name, at + CENTRAL_LENGTH);
    at += CENTRAL_LENGTH + name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, sorted.length, true);
  view.setUint16(at + 10, sorted.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return { bytes: out, entries };
}

/**
 * The files split into the archives they are written as, in the order given, each holding no more than `limits` allows
 * (a ZIP without ZIP64 holds 65,535 entries; a reader takes no archive declaring more than 1 GiB of file sizes): a
 * step's last file, its act's, is in the last archive. A file larger than the bytes one archive may declare is its own
 * archive's alone, and so a reader refuses it: a caller keeps such a file out.
 */
export function archivesOf(
  files: readonly (readonly [string, Uint8Array])[],
  limits: ArchiveLimits = { entries: MOST_ENTRIES, bytes: MOST_BYTES },
): (readonly (readonly [string, Uint8Array])[])[] {
  const archives: (readonly [string, Uint8Array])[][] = [];
  let current: (readonly [string, Uint8Array])[] = [];
  let bytes = 0;
  for (const file of files) {
    if (
      current.length > 0 &&
      (current.length + 1 > limits.entries ||
        bytes + file[1].length > limits.bytes)
    ) {
      archives.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file[1].length;
  }
  if (current.length > 0) archives.push(current);
  return archives;
}
