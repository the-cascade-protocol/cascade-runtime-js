import { type Files, relative, sameBytes, under, writeEach } from "./files.js";
import { ARCHIVE_NAME, type Layout } from "./layout.js";
import { counted, timedAside } from "./probe.js";
import {
  READING_FILES_HELD_IN_ARCHIVES,
  refuseUnmetRequirements,
  requirementBytes,
  requirementFile,
  sha256Hex,
} from "./requirements.js";
import { CASCADE, Refusal } from "./step.js";
import type { StoreFactory } from "./store.js";
import { archivesOf, crc32, MOST_BYTES, packZip } from "./zip-pack.js";

/** How many times a step that backs out its archives tries their removal, a scanner holding one open often letting go within a moment. */
const BACK_OUT_TRIES = 3;
const END = 0x06054b50;
const END_LENGTH = 22;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const CENTRAL = 0x02014b50;
const CENTRAL_LENGTH = 46;
const LOCAL = 0x04034b50;
const LOCAL_LENGTH = 30;
const MOST_COMMENT = 0xffff;
/** A field at its largest value, which in a ZIP says that the value is in a ZIP64 field. */
const ZIP64_SIZE = 0xffffffff;
const ZIP64_EXTRA = 0x0001;
const ENCRYPTED = 0x0001;
const STRONGLY_ENCRYPTED = 0x0040;
const UTF8 = 0x0800;
const STORED = 0;
const DEFLATED = 8;
/** The most a local header's extra field can be, and the most its data descriptor, which follows the data. */
const MOST_EXTRA = 0xffff;
const MOST_DESCRIPTOR = 24;
/** What deflate can give for each byte it is given at most (1,032 to 1, measured 1,029 to 1), and what it gives of none. */
const MOST_RATIO = 1032;
const RATIO_SLACK = 64;
/**
 * The most an archive may declare of its files' sizes together. Memory follows the sizes an archive says, so the sum is
 * bounded: 1 GiB is twenty times the 53 MB archive of a 16,833-record pod, and a writer that reaches it starts another.
 */
export const MOST_DECLARED = MOST_BYTES;
/** The path of a file held sealed: where a sealed pod's host keeps each file, under its keyed name (never the index's). */
const SEALED_FILE = /^sealed\/[0-9a-f]{2}\/[0-9a-f]{62}$/;

/** One file an archive holds, as its central directory gives it. */
export interface ArchiveEntry {
  /** The archive's path in the pod. */
  readonly archive: string;
  /** The file's path. */
  readonly path: string;
  readonly method: typeof STORED | typeof DEFLATED;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  /** Where its local header starts, and where the next entry's, or the directory, does. */
  readonly offset: number;
  readonly end: number;
  readonly name: Uint8Array;
}

const notInProfile = (archive: string, why: string): Refusal =>
  new Refusal(
    `${archive} is no archive of the pod's files: ${why}; nothing is read from it`,
  );

const torn = (archive: string): Refusal =>
  new Refusal(
    `${archive} has no end of central directory record: it is torn, and nothing is read from it`,
  );

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** The path an entry's name bytes give, or why they give none. */
function pathOf(name: Uint8Array, flags: number): string | { why: string } {
  if ((flags & UTF8) === 0 && name.some((byte) => byte >= 0x80))
    return { why: "a path is not in UTF-8" };
  try {
    return UTF8_DECODER.decode(name);
  } catch {
    return { why: "a path is not in UTF-8" };
  }
}

/** The ZIP64 field among an entry's extra fields, if it has one. */
function hasZip64(extra: Uint8Array): boolean {
  const fields = view(extra);
  for (
    let at = 0;
    at + 4 <= extra.length;
    at += 4 + fields.getUint16(at + 2, true)
  )
    if (fields.getUint16(at, true) === ZIP64_EXTRA) return true;
  return false;
}

/** The end of central directory record in the bytes at the end of an archive: where it starts in them. */
function endIn(tail: Uint8Array): number | undefined {
  const fields = view(tail);
  for (let at = tail.length - END_LENGTH; at >= 0; at--)
    if (
      fields.getUint32(at, true) === END &&
      fields.getUint16(at + 20, true) === tail.length - at - END_LENGTH
    )
      return at;
  return undefined;
}

/**
 * Every file the archive holds, from its directory alone: two ranged reads, its end and its central directory. An
 * archive with no end record is torn and refused; one outside the ISO/IEC 21320-1 profile as X1 narrows it (entries
 * stored or deflated, UTF-8 paths, no ZIP encryption, no ZIP64, one disk, one entry a path) is refused, naming it.
 * An entry for a folder holds no file and is passed over; any other that is not a file the layout names as N9 names a
 * file to keep in an archive (X1: a file of a snapshot's set, or a sealed one, never a view, a stored document, nor a
 * name a host may read as another's) is refused, as is an entry in the archives' folder. So is one declaring more than
 * deflate can give for the bytes it has, or an archive declaring more than `MOST_DECLARED` of them together.
 */
export async function archiveDirectory(
  files: Files,
  archive: string,
  layout: Layout,
): Promise<ArchiveEntry[]> {
  const folder = layout.archivesFolder;
  const ranged = async (start: number, length: number): Promise<Uint8Array> => {
    const read =
      files.readRange === undefined
        ? (await files.read(archive))?.slice(
            start,
            start < 0 ? undefined : start + length,
          )
        : await files.readRange(archive, start, length);
    if (read === undefined) throw new Error(`${archive} is gone`);
    return read;
  };
  let tail = await ranged(
    -(END_LENGTH + ZIP64_LOCATOR_LENGTH),
    END_LENGTH + ZIP64_LOCATOR_LENGTH,
  );
  let at = endIn(tail);
  if (at === undefined) {
    const longest = END_LENGTH + ZIP64_LOCATOR_LENGTH + MOST_COMMENT;
    tail = await ranged(-longest, longest);
    at = endIn(tail);
  }
  if (at === undefined) throw torn(archive);
  const end = view(tail);
  if (
    at >= ZIP64_LOCATOR_LENGTH &&
    end.getUint32(at - ZIP64_LOCATOR_LENGTH, true) === ZIP64_LOCATOR
  )
    throw notInProfile(archive, "it has a ZIP64 end record");
  const count = end.getUint16(at + 10, true);
  const size = end.getUint32(at + 12, true);
  const offset = end.getUint32(at + 16, true);
  if (
    end.getUint16(at + 4, true) !== 0 ||
    end.getUint16(at + 6, true) !== 0 ||
    end.getUint16(at + 8, true) !== count
  )
    throw notInProfile(archive, "it spans more than one disk");
  if (size === ZIP64_SIZE || offset === ZIP64_SIZE)
    throw notInProfile(archive, "it has a ZIP64 field");
  const directory = await ranged(offset, size + 4);
  if (
    directory.length !== size + 4 ||
    view(directory).getUint32(size, true) !== END
  )
    throw notInProfile(
      archive,
      "its central directory is not where its end record says",
    );
  const fields = view(directory);
  const entries: ArchiveEntry[] = [];
  const paths = new Set<string>();
  let next = 0;
  let declared = 0;
  for (let n = 0; n < count; n++) {
    if (
      next + CENTRAL_LENGTH > size ||
      fields.getUint32(next, true) !== CENTRAL
    )
      throw notInProfile(archive, "its central directory is malformed");
    const flags = fields.getUint16(next + 8, true);
    const method = fields.getUint16(next + 10, true);
    const crc = fields.getUint32(next + 16, true);
    const compressed = fields.getUint32(next + 20, true);
    const length = fields.getUint32(next + 24, true);
    const nameLength = fields.getUint16(next + 28, true);
    const extraLength = fields.getUint16(next + 30, true);
    const commentLength = fields.getUint16(next + 32, true);
    const disk = fields.getUint16(next + 34, true);
    const local = fields.getUint32(next + 42, true);
    const nameAt = next + CENTRAL_LENGTH;
    next = nameAt + nameLength + extraLength + commentLength;
    if (next > size)
      throw notInProfile(archive, "its central directory is malformed");
    const name = directory.slice(nameAt, nameAt + nameLength);
    const extra = directory.subarray(
      nameAt + nameLength,
      nameAt + nameLength + extraLength,
    );
    if ((flags & (ENCRYPTED | STRONGLY_ENCRYPTED)) !== 0)
      throw notInProfile(archive, "an entry is encrypted");
    if (method !== STORED && method !== DEFLATED)
      throw notInProfile(
        archive,
        `an entry is compressed by method ${method}, and only stored and deflated entries are read`,
      );
    if (
      hasZip64(extra) ||
      compressed === ZIP64_SIZE ||
      length === ZIP64_SIZE ||
      local === ZIP64_SIZE
    )
      throw notInProfile(archive, "it has a ZIP64 field");
    if (disk !== 0) throw notInProfile(archive, "it spans more than one disk");
    const path = pathOf(name, flags);
    if (typeof path !== "string") throw notInProfile(archive, path.why);
    if (path.endsWith("/") && length === 0 && compressed === 0) continue;
    try {
      if (
        path === "" ||
        path.includes("\0") ||
        relative({ iri: "urn:archive:" }, path) !== path
      )
        throw new Error(path);
      if (path.split("/").some((part) => part === "" || part === "."))
        throw new Error(path);
    } catch {
      throw notInProfile(
        archive,
        `it holds ${JSON.stringify(path)}, which is no path`,
      );
    }
    if (folder !== undefined && under(folder, path))
      throw notInProfile(archive, `it holds ${path}, in the archives' folder`);
    if (paths.has(path)) throw notInProfile(archive, `it holds ${path} twice`);
    if (
      !SEALED_FILE.test(path) &&
      !(layout.inSnapshotSet(path) && !layout.inStoredBytes(path))
    )
      throw notInProfile(
        archive,
        `it holds ${path}, which is no file N9 names for an archive to hold (not a view, a stored document, nor a file the layout gives by itself)`,
      );
    if (method === STORED && compressed !== length)
      throw notInProfile(archive, `${path} is stored, yet its sizes differ`);
    if (length > compressed * MOST_RATIO + RATIO_SLACK)
      throw notInProfile(
        archive,
        `${path} declares ${length} bytes of ${compressed}, more than deflate gives`,
      );
    declared += length;
    if (declared > MOST_DECLARED)
      throw notInProfile(
        archive,
        `it declares more than ${MOST_DECLARED} bytes of files`,
      );
    paths.add(path);
    entries.push({
      archive,
      path,
      method,
      crc,
      compressed,
      size: length,
      offset: local,
      end: offset,
      name,
    });
  }
  if (next !== size)
    throw notInProfile(archive, "its central directory is malformed");
  const byOffset = [...entries].sort((one, other) => one.offset - other.offset);
  const spanned = new Map<ArchiveEntry, number>();
  byOffset.forEach((entry, index) => {
    const ends = byOffset[index + 1]?.offset ?? offset;
    if (
      entry.offset + LOCAL_LENGTH + entry.name.length + entry.compressed >
      ends
    )
      throw notInProfile(archive, "its entries overlap");
    spanned.set(entry, ends);
  });
  return entries.map((entry) => ({
    ...entry,
    end: spanned.get(entry) ?? offset,
  }));
}

/** The bytes inflated, when they inflate to exactly `size` of them; none otherwise. */
async function inflated(
  data: Uint8Array,
  size: number,
): Promise<Uint8Array | undefined> {
  const reader = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const chunks: Uint8Array[] = [];
  let at = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > size) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
      at += value.length;
    }
  } catch {
    return undefined;
  }
  if (at !== size) return undefined;
  const out = new Uint8Array(size);
  let from = 0;
  for (const chunk of chunks) {
    out.set(chunk, from);
    from += chunk.length;
  }
  return out;
}

/**
 * The file an entry holds, by one ranged read of its local header and its data, inflated when it is deflated; refused,
 * naming it and its archive, when the bytes are not those its directory says.
 */
export async function archiveEntryBytes(
  files: Files,
  entry: ArchiveEntry,
): Promise<Uint8Array> {
  counted("archives.entries.read");
  const span = Math.min(
    entry.end - entry.offset,
    LOCAL_LENGTH +
      entry.name.length +
      MOST_EXTRA +
      entry.compressed +
      MOST_DESCRIPTOR,
  );
  const read =
    files.readRange === undefined
      ? (await files.read(entry.archive))?.slice(
          entry.offset,
          entry.offset + span,
        )
      : await files.readRange(entry.archive, entry.offset, span);
  if (read === undefined) throw new Error(`${entry.archive} is gone`);
  const wrong = new Refusal(
    `${entry.path} in ${entry.archive} does not hold the bytes its directory says`,
  );
  if (read.length !== span) throw wrong;
  const fields = view(read);
  if (
    fields.getUint32(0, true) !== LOCAL ||
    fields.getUint16(8, true) !== entry.method ||
    fields.getUint16(26, true) !== entry.name.length ||
    !sameBytes(
      read.subarray(LOCAL_LENGTH, LOCAL_LENGTH + entry.name.length),
      entry.name,
    )
  )
    throw wrong;
  const start = LOCAL_LENGTH + entry.name.length + fields.getUint16(28, true);
  if (start + entry.compressed > span) throw wrong;
  const data = read.subarray(start, start + entry.compressed);
  const bytes =
    entry.method === STORED ? data.slice() : await inflated(data, entry.size);
  if (
    bytes === undefined ||
    bytes.length !== entry.size ||
    crc32(bytes) !== entry.crc
  )
    throw wrong;
  return bytes;
}

/** Each path an opening's archives hold, with the entry it is read from. */
type Held = Map<string, ArchiveEntry>;

/**
 * A pod's files over a host that may keep some of them in ZIP archives, in `folder` (X1): every file at its own path and
 * every entry of every archive named as N9 names one, the archives' folder itself no part of the pod. Each archive's
 * directory is read once, at the first call, and held for the life of this opening; an entry is one ranged read
 * through the host, which keeps no handle on an archive once its reads have ended. A path held in two places with other bytes is refused, naming it,
 * when a listing finds both. A file an archive holds is never written over nor removed.
 *
 * It is also the writer: `writeStep` keeps a step's files an archive may hold in one archive, written as W1 says, the
 * requirement's file (O4) first. It does so only when the layout gives the requirements' folder, so that no archive is
 * written that a runtime unable to read it would not refuse; given a `newStore`, every opening begins by refusing a
 * pod that requires what this runtime cannot do.
 */
export class ArchivedFiles implements Files {
  readonly #files: Files;
  readonly #folder: string;
  readonly #layout: Layout;
  readonly #newStore: StoreFactory | undefined;
  #held: Promise<Held> | undefined;
  /** The paths found at their own paths and in an archive, compared once. */
  readonly #compared = new Set<string>();
  /** Whether the pod's requirements have been looked at. */
  #required: Promise<void> | undefined;
  /** The archives whose directory is in the index. */
  readonly #opened = new Set<string>();
  /** The requirement's file, once this opening has seen it in the pod or written it. */
  #requirement: Promise<void> | undefined;
  /** Whether this opening has seen to the subject's file: held in an archive, with no loose copy of it left. */
  #subjectFiled = false;

  constructor(files: Files, layout: Layout, newStore?: StoreFactory) {
    const folder = layout.archivesFolder;
    if (folder === undefined)
      throw new Error("the layout gives no folder for archives");
    this.#files = files;
    this.#layout = layout;
    this.#newStore = newStore;
    this.iri = files.iri;
    this.#folder = folder.endsWith("/") ? folder : `${folder}/`;
    const { writeAll, writeMany, writeNew, replace, remove } = files;
    if (writeAll !== undefined)
      this.writeAll = async (written) =>
        writeAll.call(files, await this.#kept(written));
    if (writeMany !== undefined)
      this.writeMany = async (written) =>
        writeMany.call(files, await this.#kept(written));
    if (writeNew !== undefined)
      this.writeNew = async (pathOrIri, bytes) => {
        const path = this.#path(pathOrIri);
        if ((await this.#index()).has(path)) return false;
        return writeNew.call(files, path, bytes);
      };
    if (replace !== undefined)
      this.replace = async (pathOrIri, bytes, holds) => {
        const path = this.#path(pathOrIri);
        const entry = (await this.#index()).get(path);
        if (entry === undefined) return replace.call(files, path, bytes, holds);
        const held = await archiveEntryBytes(files, entry);
        if (!sameBytes(held, holds)) return false;
        if (!sameBytes(held, bytes)) throw this.#otherBytes(path);
        return true;
      };
    if (remove !== undefined)
      this.remove = async (pathsOrIris) => {
        const held = await this.#index();
        for (const pathOrIri of pathsOrIris) {
          const path = relative(this, pathOrIri);
          if (layout.inRequirements(path))
            throw new Error(
              `${path} is a requirement's file, which is never removed`,
            );
          const entry = held.get(path);
          if (entry !== undefined)
            throw new Error(
              `${entry.path} is held in ${entry.archive}, and a file an archive holds is never removed`,
            );
        }
        return remove.call(files, pathsOrIris);
      };
  }

  readonly writeAll?: (
    files: Iterable<readonly [string, Uint8Array]>,
  ) => Promise<void>;
  readonly writeMany?: (
    files: Iterable<readonly [string, Uint8Array]>,
  ) => Promise<void>;
  readonly writeNew?: (
    pathOrIri: string,
    bytes: Uint8Array,
  ) => Promise<boolean>;
  readonly replace?: (
    pathOrIri: string,
    bytes: Uint8Array,
    holds: Uint8Array | undefined,
  ) => Promise<boolean>;
  readonly remove?: (pathsOrIris: readonly string[]) => Promise<void>;

  /**
   * Writes the files one step adds as W1 says (X1): its stored documents first, each at its own path; then, when the
   * layout gives the requirements' folder, the requirement's file if the pod lacks it and every file an archive may
   * hold as one archive, or more where one would pass what an archive may hold, the last file given, the act's, in the
   * last, each flushed to storage and renamed to its name; then the rest at their paths. The first archive an opening writes
   * in a pod also holds the subject's file, whose loose copy goes once the archive is in place, so that a runtime that
   * cannot read archives refuses the pod rather than see part of it; a loose copy an archive holds with the same bytes,
   * left by a step that stopped before it was removed, or whose removal failed, goes with it. A step looks at the
   * archives again once its own are in place, and removes its own, refusing the step, if the pod would hold a file
   * twice with other bytes; an archive at the name of its own, found in place before it wrote, is another opening's
   * of the same step, and is neither written again nor removed. Two windows leave a pod that refuses to open, which
   * nothing in the runtime repairs: the removal still throwing after three tries, and a stop between the rename and
   * the second look. A file of a snapshot's set too large for an archive is written before the archives, the act's file
   * in them. A file an archive holds with the same bytes is not written
   * again; one with other bytes is refused.
   */
  async writeStep(
    written: Iterable<readonly [string, Uint8Array]>,
  ): Promise<void> {
    await this.#refreshed();
    const kept = await this.#kept(written);
    const stored: [string, Uint8Array][] = [];
    const archived: [string, Uint8Array][] = [];
    const rest: [string, Uint8Array][] = [];
    for (const file of kept) {
      const [path, bytes] = file;
      const mayBeInArchive =
        this.#layout.requirementsFolder !== undefined &&
        this.#layout.inSnapshotSet(path);
      if (
        this.#layout.inStoredBytes(path) ||
        (mayBeInArchive && bytes.length > MOST_BYTES)
      )
        stored.push(file);
      else if (mayBeInArchive) archived.push(file);
      else rest.push(file);
    }
    if (stored.length > 0) await writeEach(this.#files, stored);
    if (archived.length > 0) await this.#archive(archived);
    if (rest.length > 0) await writeEach(this.#files, rest);
  }

  /** `write`, flushed to storage where the host can. */
  #flushed(path: string, bytes: Uint8Array): Promise<void> {
    return this.#files.writeFlushed === undefined
      ? this.#files.write(path, bytes)
      : this.#files.writeFlushed(path, bytes);
  }

  /** The requirement's file is in the pod: written flushed, before the first archive, if the pod lacks it. Never removed. */
  #requirementWritten(): Promise<void> {
    if (this.#requirement === undefined) {
      const writing = (async () => {
        const path = await requirementFile(
          this.#layout,
          READING_FILES_HELD_IN_ARCHIVES,
        );
        if ((await this.#files.read(path)) === undefined)
          await this.#flushed(
            path,
            requirementBytes(READING_FILES_HELD_IN_ARCHIVES),
          );
      })();
      this.#requirement = writing;
      writing.catch(() => {
        if (this.#requirement === writing) this.#requirement = undefined;
      });
    }
    return this.#requirement;
  }

  /**
   * The files at their own paths that the pod's first archive must also hold: the subject's, which a runtime that cannot
   * read archives would otherwise find loose and open the pod by, to see only the files not in an archive.
   */
  async #looseSubject(
    step: ReadonlySet<string>,
    held: Held,
  ): Promise<{ moved: [string, Uint8Array][]; stale: string[] }> {
    const moved: [string, Uint8Array][] = [];
    const stale: string[] = [];
    if (this.#subjectFiled) return { moved, stale };
    const folder = this.#layout.find(`${CASCADE}Subject`)?.folder;
    if (folder === undefined) return { moved, stale };
    for (const path of await this.#files.list(folder)) {
      if (
        step.has(path) ||
        !this.#layout.inSnapshotSet(path) ||
        this.#layout.inStoredBytes(path)
      )
        continue;
      const bytes = await this.#files.read(path);
      if (bytes === undefined) continue;
      const entry = held.get(path);
      if (entry === undefined) moved.push([path, bytes]);
      else if (sameBytes(await archiveEntryBytes(this.#files, entry), bytes))
        stale.push(path);
    }
    return { moved, stale };
  }

  async #archive(
    files: readonly (readonly [string, Uint8Array])[],
  ): Promise<void> {
    const held = await this.#index();
    await this.#requirementWritten();
    const { moved, stale } = await this.#looseSubject(
      new Set(files.map(([path]) => path)),
      held,
    );
    const written: string[] = [];
    const found: string[] = [];
    for (const split of archivesOf([...moved, ...files])) {
      const packed = packZip(split);
      const path = `${this.#folder}${await sha256Hex(packed.bytes)}.zip`;
      if ((await this.#files.list(this.#folder)).includes(path)) {
        found.push(path);
        continue;
      }
      await timedAside("archives.write", () =>
        this.#flushed(path, packed.bytes),
      );
      written.push(path);
      this.#opened.add(path);
      counted("archives.written");
      counted("archives.entries.written", packed.entries.length);
      for (const entry of packed.entries)
        if (!held.has(entry.path))
          held.set(entry.path, {
            archive: path,
            path: entry.path,
            method: 0,
            crc: entry.crc,
            compressed: entry.size,
            size: entry.size,
            offset: entry.offset,
            end: entry.end,
            name: entry.name,
          });
    }
    try {
      await this.#absorbed(held, await this.#unopened());
    } catch (error) {
      throw await this.#backedOut(written, error);
    }
    if (found.length > 0) {
      const listed = await this.#files.list(this.#folder);
      const gone = found.find((path) => !listed.includes(path));
      if (gone !== undefined) {
        this.#held = undefined;
        this.#opened.clear();
        throw new Refusal(
          `${gone}, which another opening wrote with this step's files, was removed before this step looked again: the step is not in the pod`,
        );
      }
    }
    const loose = [...moved.map(([path]) => path), ...stale];
    if (loose.length > 0 && this.#files.remove !== undefined) {
      try {
        await this.#files.remove(loose);
      } catch {
        counted("archives.subject.left", loose.length);
        return;
      }
    }
    this.#subjectFiled = true;
  }

  /**
   * This step's archives are removed, after a look found the pod holding a file twice with other bytes: an archive
   * another opening wrote while this one wrote its own, which an archive this step found already in place, the same
   * step's, is not one of. The removal is tried three times; one that still throws leaves a refusal that says so and
   * carries the host's error, the archive left in the pod. The index is read again from what is left. Returns what
   * the step is refused with.
   */
  async #backedOut(
    archives: readonly string[],
    refusal: unknown,
  ): Promise<unknown> {
    this.#held = undefined;
    this.#opened.clear();
    if (this.#files.remove === undefined || archives.length === 0)
      return refusal;
    for (let tried = 1; ; tried++) {
      try {
        await this.#files.remove(archives);
        return refusal;
      } catch (removal) {
        if (tried < BACK_OUT_TRIES) {
          await new Promise((done) => setTimeout(done, tried * 20));
          continue;
        }
        return refusal instanceof Refusal
          ? new Refusal(
              `${refusal.message}; ${archives.join(", ")} could not be removed, so the pod stays refused until it is`,
              { cause: removal },
            )
          : refusal;
      }
    }
  }

  /** The pod's IRI, a value and no getter, so that a proxy over these files reads it as it reads the host's. */
  readonly iri: string;

  /** The path, refused when it is in the archives' folder, which only a host's own writer of archives writes. */
  #path(pathOrIri: string): string {
    const path = relative(this, pathOrIri);
    if (under(this.#folder, path))
      throw new Error(
        `${path} is in the archives' folder, which no file of the pod is written in`,
      );
    if (this.#layout.inRequirements(path))
      throw new Error(
        `${path} is in the requirements' folder, which no file of the pod is written in`,
      );
    return path;
  }

  #otherBytes(path: string): Refusal {
    return new Refusal(`${path} is in the pod already, holding other bytes`);
  }

  /** The files to write but those an archive holds with the same bytes; one an archive holds with other bytes is refused. */
  async #kept(
    written: Iterable<readonly [string, Uint8Array]>,
  ): Promise<[string, Uint8Array][]> {
    const held = await this.#index();
    const kept: [string, Uint8Array][] = [];
    for (const [pathOrIri, bytes] of written) {
      const path = this.#path(pathOrIri);
      const entry = held.get(path);
      if (entry === undefined) kept.push([path, bytes]);
      else if (!sameBytes(await archiveEntryBytes(this.#files, entry), bytes))
        throw this.#otherBytes(path);
    }
    return kept;
  }

  /** Every archive's directory, read at the first call and held; a path two archives hold must hold the same bytes. */
  #index(): Promise<Held> {
    if (this.#held === undefined) {
      const reading = timedAside("archives.open", async () => {
        await this.#requirementsMet();
        const held: Held = new Map();
        await this.#absorbed(held, await this.#unopened());
        return held;
      });
      this.#held = reading;
      reading.catch(() => {
        if (this.#held === reading) this.#held = undefined;
      });
    }
    return this.#held;
  }

  /** The pod requires nothing this runtime cannot do (O4): looked at once, before the opening's first read, whatever it reads. */
  #requirementsMet(): Promise<void> {
    if (this.#newStore === undefined) return Promise.resolve();
    if (this.#required === undefined) {
      const looking = refuseUnmetRequirements(
        this.#files,
        this.#layout,
        this.#newStore,
      );
      this.#required = looking;
      looking.catch(() => {
        if (this.#required === looking) this.#required = undefined;
      });
    }
    return this.#required;
  }

  /** Whether an archive may hold the file: a file of a snapshot's set or a sealed one. The card, the settings and the views are never in one. */
  #mayBeArchived(path: string): boolean {
    return SEALED_FILE.test(path) || this.#layout.inSnapshotSet(path);
  }

  /** The archives in the folder whose directory this opening has not read, sorted. */
  async #unopened(): Promise<string[]> {
    return (await this.#files.list(this.#folder))
      .filter(
        (path) =>
          ARCHIVE_NAME.test(path.slice(this.#folder.length)) &&
          !this.#opened.has(path),
      )
      .sort();
  }

  /** Reads each archive's directory and adds its entries to the index; a path two archives hold must hold the same bytes. */
  async #absorbed(held: Held, archives: readonly string[]): Promise<void> {
    const directories = await Promise.all(
      archives.map((archive) =>
        archiveDirectory(this.#files, archive, this.#layout),
      ),
    );
    for (const [at, entries] of directories.entries()) {
      this.#opened.add(archives[at] as string);
      counted("archives.opened");
      counted("archives.entries", entries.length);
      for (const entry of entries) {
        const first = held.get(entry.path);
        if (first === undefined) held.set(entry.path, entry);
        else if (
          first.size !== entry.size ||
          first.crc !== entry.crc ||
          !sameBytes(
            await archiveEntryBytes(this.#files, first),
            await archiveEntryBytes(this.#files, entry),
          )
        )
          throw new Refusal(
            `${entry.path} is held twice with other bytes, in ${first.archive} and in ${entry.archive}`,
          );
      }
    }
  }

  /**
   * The index with any archive another opening wrote since, whose directory is read now: a listing and a step's write
   * look again, one listing of the archives' folder, so that a file another session archived is found, and one it
   * archived with other bytes is refused, as a file it wrote at its own path would be.
   */
  async #refreshed(): Promise<Held> {
    const held = await this.#index();
    const fresh = await this.#unopened();
    if (fresh.length > 0) await this.#absorbed(held, fresh);
    return held;
  }

  /** Refuses the pod when the file at its own path holds other bytes than the archive's entry at that path. */
  async #same(entry: ArchiveEntry): Promise<void> {
    if (this.#compared.has(entry.path)) return;
    const [loose, archived] = await Promise.all([
      this.#files.read(entry.path),
      archiveEntryBytes(this.#files, entry),
    ]);
    if (loose !== undefined && !sameBytes(loose, archived))
      throw new Refusal(
        `${entry.path} is held twice with other bytes, at its own path and in ${entry.archive}`,
      );
    this.#compared.add(entry.path);
  }

  async read(pathOrIri: string): Promise<Uint8Array | undefined> {
    const path = relative(this, pathOrIri);
    if (under(this.#folder, path) || this.#layout.inRequirements(path))
      return undefined;
    await this.#requirementsMet();
    if (!this.#mayBeArchived(path)) return this.#files.read(path);
    const entry = (await this.#index()).get(path);
    return entry === undefined
      ? this.#files.read(path)
      : archiveEntryBytes(this.#files, entry);
  }

  async readRange(
    pathOrIri: string,
    start: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    const path = relative(this, pathOrIri);
    if (under(this.#folder, path) || this.#layout.inRequirements(path))
      return undefined;
    await this.#requirementsMet();
    const entry = this.#mayBeArchived(path)
      ? (await this.#index()).get(path)
      : undefined;
    if (entry === undefined && this.#files.readRange !== undefined)
      return this.#files.readRange(path, start, length);
    const whole =
      entry === undefined
        ? await this.#files.read(path)
        : await archiveEntryBytes(this.#files, entry);
    if (whole === undefined) return undefined;
    const from = start < 0 ? Math.max(0, whole.length + start) : start;
    return whole.slice(from, from + length);
  }

  async write(pathOrIri: string, bytes: Uint8Array): Promise<void> {
    for (const [path, kept] of await this.#kept([[pathOrIri, bytes]]))
      await this.#files.write(path, kept);
  }

  /** Every file at its own path and every entry of every archive under the folder, sorted; none in the archives' folder. */
  async list(folder: string): Promise<string[]> {
    const prefix = relative(this, folder);
    const [held, loose] = await Promise.all([
      this.#refreshed(),
      this.#files.list(folder),
    ]);
    const paths = new Set(
      loose.filter(
        (path) =>
          !under(this.#folder, path) && !this.#layout.inRequirements(path),
      ),
    );
    for (const [path, entry] of held) {
      if (!under(prefix, path)) continue;
      if (paths.has(path)) await this.#same(entry);
      else paths.add(path);
    }
    return [...paths].sort();
  }
}

/** The pod's files over the host: `ArchivedFiles` in the layout's archives' folder, or, where it gives none, the host's. */
export function archivedFiles(
  files: Files,
  layout: Layout,
  newStore?: StoreFactory,
): Files {
  return layout.archivesFolder === undefined
    ? files
    : new ArchivedFiles(files, layout, newStore);
}
