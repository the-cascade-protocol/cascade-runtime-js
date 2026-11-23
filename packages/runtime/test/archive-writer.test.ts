import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { archivedFiles, archiveDirectory } from "../src/archives.js";
import {
  type DeriveKey,
  EncryptedFiles,
  madeNewPod,
  newHeader,
  SealedIndex,
} from "../src/encryption.js";
import { type Files, MemoryFiles } from "../src/files.js";
import type { Layout } from "../src/layout.js";
import { FolderFiles, openSharedHandles } from "../src/node/folder-files.js";
import { StepWrites } from "../src/pod.js";
import { OxigraphStore } from "../src/oxigraph-store.js";
import { probing } from "../src/probe.js";
import { archivesOf, crc32, MOST_BYTES } from "../src/zip-pack.js";
import { Refusal } from "../src/step.js";
import { layout as vocabularyLayout } from "./vocabulary.js";

const POD = "https://pod.example/";
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (read: Uint8Array | undefined): string | undefined =>
  read && new TextDecoder().decode(read);
const sha256 = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const SUBJECT = "subject/cc/cc000000-0000-4000-8000-000000000003.ttl";
const CARD = "profile/card.ttl";
const RECORD = "records/conditions/aa/aa000000-0000-4000-8000-000000000001.ttl";
const VERSION = `records/conditions/bb/${"bb".repeat(32)}.ttl`;
const STORED = `attachments/sha-256/${"cd".repeat(32)}`;
const ACT = "provenance/imports/dd/dd000000-0000-4000-8000-000000000004.ttl";
const SECOND_RECORD =
  "records/conditions/ee/ee000000-0000-4000-8000-000000000005.ttl";
const SECOND_ACT =
  "provenance/imports/ff/ff000000-0000-4000-8000-000000000006.ttl";
/** The one line of the requirement's file, and its name: the SHA-256 of the requirement's IRI (O4, N9). */
const REQUIREMENT_LINE =
  "<../> <http://purl.org/dc/terms/requires> <https://ns.cascadeprotocol.org/cascade#ReadingFilesHeldInArchives> .\n";
const MARKER =
  "format/4c0299bfcb615af1d3456fb1755dea6e0229b4852c7890bae85f0328c453a95d.ttl";

const FIRST: readonly (readonly [string, string])[] = [
  [SUBJECT, "<#s> a <#Subject> .\n"],
  [CARD, "<#me> a <#Person> .\n"],
  [RECORD, "<#a> a <#Condition> .\n"],
  [VERSION, "<#b> a <#Condition> .\n"],
  [STORED, '{"resourceType":"Bundle"}'],
];

/** The step a person's import is, in the order the runtime adds a step's files. */
function step(
  files: readonly (readonly [string, string])[],
  act: string,
): StepWrites {
  const writes = new StepWrites();
  for (const [path, body] of files) writes.add(path, bytes(body));
  writes.act({ name: `${POD}${act}`, path: act, triples: [] });
  return writes;
}

/** Every file in the folder, by its path in it, sorted. */
async function onDisk(at: string): Promise<string[]> {
  return (await readdir(at, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(at.length + 1)
        .split("\\")
        .join("/"),
    )
    .sort();
}

/** Every flush the files of a folder were given: a handle's `sync` that returned. */
async function counting<T>(
  doing: () => Promise<T>,
): Promise<{ result: T; syncs: number }> {
  const probe = await open(join(tmpdir(), `sync-probe-${process.pid}`), "w");
  const prototype = Object.getPrototypeOf(probe) as {
    sync: () => Promise<void>;
  };
  await probe.close();
  await rm(join(tmpdir(), `sync-probe-${process.pid}`), { force: true });
  const sync = prototype.sync;
  let syncs = 0;
  prototype.sync = async function (this: unknown) {
    await sync.call(this);
    syncs += 1;
  };
  try {
    return { result: await doing(), syncs };
  } finally {
    prototype.sync = sync;
  }
}

/**
 * A host that keeps a pod's files that never change in ZIP archives writes each step's new files as one archive, in
 * the folder the layout gives them, after the file that says a runtime must be able to read archives to read the pod
 * (X1, W1, O4): the step's stored documents first at their paths, its other files an archive may hold as one archive,
 * flushed and renamed, and the files the layout gives by themselves after it. A pod that held its files loose first
 * has its subject's file in its first archive, so that no runtime that cannot read archives opens it to see part of it.
 */
describe("Writing a pod's files into archives · ArchivedFiles, StepWrites.commit(), archivesOf()", () => {
  let folder: string;
  let layout: Layout;
  let made = 0;

  before(async () => {
    folder = await mkdtemp(join(tmpdir(), "archive-writer-"));
    layout = await vocabularyLayout();
  });

  after(() => rm(folder, { recursive: true, force: true }));

  const podAt = (): FolderFiles =>
    new FolderFiles(join(folder, `pod-${(made += 1)}`), POD, {
      refuseLinks: true,
    });

  it("writes a step as its stored documents and the files the layout gives by themselves loose and every other file as one archive named by its bytes, after the requirement's file, both flushed", async () => {
    const host = podAt();
    const pod = archivedFiles(host, layout);
    const { syncs } = await counting(() => step(FIRST, ACT).commit(pod));
    const files = await onDisk(host.folder);
    const [archive] = files.filter((path) => path.startsWith("archives/"));
    assert.deepEqual(files, [archive, MARKER, STORED, CARD].sort());
    assert.ok(archive !== undefined);
    const written = (await host.read(archive)) as Uint8Array;
    assert.equal(archive, `archives/${sha256(written)}.zip`);
    assert.equal(text(await host.read(MARKER)), REQUIREMENT_LINE);
    assert.ok(
      syncs >= 2,
      `the requirement's file and the archive are flushed, not ${syncs}`,
    );

    const entries = await archiveDirectory(host, archive, layout);
    assert.deepEqual(
      entries.map((entry) => entry.path),
      [ACT, RECORD, VERSION, SUBJECT],
      "its entries are the files an archive may hold, in path order",
    );
    const { seen } = await probing(async () =>
      archivedFiles(host, layout).read(CARD),
    );
    assert.equal(
      seen.counts.get("archives.opened"),
      undefined,
      "the card is no file an archive holds, so reading it reads no archive",
    );
    const reopened = archivedFiles(host, layout);
    for (const [path, body] of FIRST)
      assert.equal(text(await reopened.read(path)), body, path);
    assert.deepEqual(
      await reopened.list(""),
      [ACT, CARD, RECORD, STORED, SUBJECT, VERSION].sort(),
      "a reader lists every file at its path, and neither the archive nor the requirement's file",
    );

    const second = step(
      [[SECOND_RECORD, "<#c> a <#Condition> .\n"]],
      SECOND_ACT,
    );
    await second.commit(pod);
    const after = await onDisk(host.folder);
    assert.equal(
      after.filter((path) => path.startsWith("archives/")).length,
      2,
      "a second step is a second archive",
    );
    assert.equal(
      after.filter((path) => path.startsWith("format/")).length,
      1,
      "and the requirement's file is written once",
    );
    assert.equal(
      text(await pod.read(SECOND_RECORD)),
      "<#c> a <#Condition> .\n",
    );
    for (let turns = 0; turns < 50 && openSharedHandles() > 0; turns++)
      await new Promise((done) => setTimeout(done, 5));
    assert.equal(openSharedHandles(), 0, "no handle is left on an archive");
  });

  it("keeps a pod made loose a pod: the first archive written into it holds the subject's file too, and its loose copy goes, after the archive is in place", async () => {
    const host = podAt();
    await host.write(SUBJECT, bytes("<#s> a <#Subject> .\n"));
    await host.write(CARD, bytes("<#me> a <#Person> .\n"));
    await host.write(RECORD, bytes("<#a> a <#Condition> .\n"));
    const pod = archivedFiles(host, layout);
    await step([[SECOND_RECORD, "<#c> a <#Condition> .\n"]], SECOND_ACT).commit(
      pod,
    );
    const files = await onDisk(host.folder);
    assert.ok(!files.includes(SUBJECT), "no loose copy of the subject's file");
    assert.ok(files.includes(RECORD), "the other loose files stay as they are");
    const [archive] = files.filter((path) => path.startsWith("archives/"));
    assert.ok(archive !== undefined);
    assert.deepEqual(
      (await archiveDirectory(host, archive, layout)).map(({ path }) => path),
      [SECOND_ACT, SECOND_RECORD, SUBJECT],
    );
    assert.equal(
      text(await archivedFiles(host, layout).read(SUBJECT)),
      "<#s> a <#Subject> .\n",
    );
    assert.equal(text(await host.read(MARKER)), REQUIREMENT_LINE);
  });

  it("leaves the pod as it was when the archive fails to land, the subject's loose copy still in place and no archive at a name", async () => {
    const host = podAt();
    await host.write(SUBJECT, bytes("<#s> a <#Subject> .\n"));
    const failing: Files = {
      iri: host.iri,
      read: (path) => host.read(path),
      readRange: (path, start, length) => host.readRange(path, start, length),
      list: (path) => host.list(path),
      write: (path, written) => host.write(path, written),
      remove: (paths) => host.remove(paths),
      writeFlushed: async (path, written) => {
        if (path.startsWith("archives/")) throw new Error("the disk is full");
        await host.write(path, written);
      },
    } as Files;
    await assert.rejects(
      step([[RECORD, "<#a> a <#Condition> .\n"]], ACT).commit(
        archivedFiles(failing, layout),
      ),
      /the disk is full/,
    );
    assert.deepEqual(
      (await onDisk(host.folder)).filter((path) => path !== MARKER),
      [SUBJECT],
    );
  });

  it("removes the subject's loose copy an archive holds with the same bytes at the next step, as a step stopped before the removal left it", async () => {
    const host = podAt();
    await host.write(SUBJECT, bytes("<#s> a <#Subject> .\n"));
    await step([[RECORD, "<#a> a <#Condition> .\n"]], ACT).commit(
      archivedFiles(host, layout),
    );
    assert.ok(!(await onDisk(host.folder)).includes(SUBJECT));

    await host.write(SUBJECT, bytes("<#s> a <#Subject> .\n"));
    await step([[SECOND_RECORD, "<#c> a <#Condition> .\n"]], SECOND_ACT).commit(
      archivedFiles(host, layout),
    );
    assert.ok(
      !(await onDisk(host.folder)).includes(SUBJECT),
      "the copy put back is gone after the next step",
    );

    await host.write(SUBJECT, bytes("<#other> a <#Subject> .\n"));
    const third = archivedFiles(host, layout);
    await step(
      [[VERSION, "<#b> a <#Condition> .\n"]],
      "provenance/imports/ab/ab000000-0000-4000-8000-000000000007.ttl",
    ).commit(third);
    assert.ok(
      (await onDisk(host.folder)).includes(SUBJECT),
      "a loose copy with other bytes is not removed, for a listing to refuse",
    );
  });

  it("keeps the step it wrote whole when the removal of the subject's loose copy throws after the archive is in place, and removes the copy at the next step", async () => {
    const host = podAt();
    await host.write(SUBJECT, bytes("<#s> a <#Subject> .\n"));
    let held = true;
    const flaky = {
      iri: host.iri,
      read: (path: string) => host.read(path),
      readRange: (path: string, start: number, length: number) =>
        host.readRange(path, start, length),
      list: (path: string) => host.list(path),
      write: (path: string, written: Uint8Array) => host.write(path, written),
      writeFlushed: (path: string, written: Uint8Array) =>
        host.writeFlushed(path, written),
      remove: async (paths: readonly string[]) => {
        if (held) throw new Error("the file is held open");
        await host.remove(paths);
      },
    } as Files;
    const pod = archivedFiles(flaky, layout);
    await step([[RECORD, "<#a> a <#Condition> .\n"]], ACT).commit(pod);
    const after = await onDisk(host.folder);
    assert.equal(
      after.filter((path) => path.startsWith("archives/")).length,
      1,
      "the step's archive is in place",
    );
    assert.ok(after.includes(SUBJECT), "the loose copy is left");
    assert.equal(
      text(await archivedFiles(host, layout).read(SUBJECT)),
      "<#s> a <#Subject> .\n",
    );

    held = false;
    await step([[SECOND_RECORD, "<#c> a <#Condition> .\n"]], SECOND_ACT).commit(
      pod,
    );
    assert.ok(!(await onDisk(host.folder)).includes(SUBJECT));
  });

  it("backs out its own archive when another opening's, landed while it wrote, holds a file with other bytes, so that no pod is left that refuses to open", async () => {
    const host = podAt();
    let reached: () => void = () => undefined;
    const atTheArchive = new Promise<void>((done) => (reached = done));
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => (release = done));
    const slow = {
      iri: host.iri,
      read: (path: string) => host.read(path),
      readRange: (path: string, start: number, length: number) =>
        host.readRange(path, start, length),
      list: (path: string) => host.list(path),
      write: (path: string, written: Uint8Array) => host.write(path, written),
      remove: (paths: readonly string[]) => host.remove(paths),
      writeFlushed: async (path: string, written: Uint8Array) => {
        if (path.startsWith("archives/")) {
          reached();
          await held;
        }
        await host.writeFlushed(path, written);
      },
    } as Files;
    const behind = step([[RECORD, "<#a> a <#Two> .\n"]], SECOND_ACT).commit(
      archivedFiles(slow, layout),
    );
    const refused = assert.rejects(
      behind,
      /records\/conditions\/aa\/.* is held twice with other bytes/,
    );
    await atTheArchive;
    await step([[RECORD, "<#a> a <#One> .\n"]], ACT).commit(
      archivedFiles(host, layout),
    );
    release();
    await refused;
    const archives = (await onDisk(host.folder)).filter((path) =>
      path.startsWith("archives/"),
    );
    assert.equal(archives.length, 1, "only the archive that was kept is left");
    assert.equal(
      text(await archivedFiles(host, layout).read(RECORD)),
      "<#a> a <#One> .\n",
    );
  });

  it("writes a file of a snapshot's set that no archive may hold before the archive that holds the act's file", async () => {
    const written: string[] = [];
    const host = new MemoryFiles(POD);
    const watching = {
      iri: host.iri,
      read: (path: string) => host.read(path),
      list: (path: string) => host.list(path),
      write: async (path: string, held: Uint8Array) => {
        written.push(path);
        await host.write(path, held);
      },
    } as Files;
    const writes = new StepWrites();
    writes.add(RECORD, bytes("<#a> a <#Condition> .\n"));
    writes.add(VERSION, new Uint8Array(MOST_BYTES + 1));
    writes.act({ name: `${POD}${ACT}`, path: ACT, triples: [] });
    await writes.commit(archivedFiles(watching, layout));
    const archive = written.findIndex((path) => path.startsWith("archives/"));
    assert.ok(archive >= 0, "the step's archive is written");
    assert.ok(
      written.indexOf(VERSION) >= 0 && written.indexOf(VERSION) < archive,
      `the large file is written before the archive, not after: ${written.join(", ")}`,
    );
  });

  it("finds an archive another opening wrote since it opened: a listing lists its files, and a step writes none of them, refusing one it holds with other bytes", async () => {
    const host = podAt();
    const mine = archivedFiles(host, layout);
    await step([[RECORD, "<#a> a <#Condition> .\n"]], ACT).commit(mine);
    const other = archivedFiles(host, layout);
    await step([[SECOND_RECORD, "<#c> a <#Condition> .\n"]], SECOND_ACT).commit(
      other,
    );
    assert.ok(
      (await mine.list("")).includes(SECOND_RECORD),
      "the other's file is listed",
    );

    const third = podAt();
    const first = archivedFiles(third, layout);
    await step([[VERSION, "<#b> a <#Condition> .\n"]], ACT).commit(first);
    const later = archivedFiles(third, layout);
    await later.read(VERSION);
    await step([[RECORD, "<#a> a <#Condition> .\n"]], SECOND_ACT).commit(first);
    const archives = async () =>
      (await onDisk(third.folder)).filter((path) =>
        path.startsWith("archives/"),
      ).length;
    const before = await archives();
    await assert.rejects(
      step(
        [[RECORD, "<#other> a <#Condition> .\n"]],
        "provenance/imports/ac/ac000000-0000-4000-8000-000000000008.ttl",
      ).commit(later),
      /records\/conditions\/aa\/.* is in the pod already, holding other bytes/,
    );
    assert.equal(await archives(), before, "a refused step writes no archive");
    await step(
      [[RECORD, "<#a> a <#Condition> .\n"]],
      "provenance/imports/ab/ab000000-0000-4000-8000-000000000007.ttl",
    ).commit(later);
    assert.equal(
      await archives(),
      before + 1,
      "the file held with the same bytes is not written again, its act's file is",
    );
  });

  it("writes no file of an encrypted pod into an archive: its files are sealed one by one at their keyed names, and no archive nor requirement's file is made", async () => {
    const host = podAt();
    const derive: DeriveKey = async (secret, salt) =>
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new Uint8Array([...secret, ...salt]),
        ),
      );
    const header = await newHeader(
      "abacus abdomen abdominal abide abiding zoom",
      derive,
    );
    assert.ok(await madeNewPod(host, header));
    const beneath = archivedFiles(host, layout);
    const sealed = new EncryptedFiles(beneath, header.key, {
      index: await SealedIndex.open(beneath, header.key),
    });
    await step(
      [
        [SUBJECT, "<#s> a <#Subject> .\n"],
        [RECORD, "<#a> a <#Condition> SECRET-HEALTH-DATA .\n"],
        [STORED, "SECRET-HEALTH-DATA"],
      ],
      ACT,
    ).commit(sealed);
    const files = await onDisk(host.folder);
    assert.deepEqual(
      files.filter((path) => /^(archives|format)\//.test(path)),
      [],
    );
    for (const path of files) {
      const held = Buffer.from(await readFile(join(host.folder, path)));
      assert.ok(
        !held.includes("SECRET-HEALTH-DATA") && !held.includes("Condition"),
        `${path} holds the pod's data unsealed`,
      );
    }
    assert.equal(
      text(await sealed.read(RECORD)),
      "<#a> a <#Condition> SECRET-HEALTH-DATA .\n",
    );
  });

  it("checks a file taken from an archive by the CRC-32 zlib gives, for every length across the eight bytes it reads at a time", () => {
    const random = new Uint8Array(4099);
    for (let at = 0; at < random.length; at++)
      random[at] = (at * 2654435761) >>> 24;
    for (const length of [...Array(40).keys(), 255, 256, 4099])
      assert.equal(
        crc32(random.subarray(0, length)),
        zlibCrc32(random.subarray(0, length)),
        `${length} bytes`,
      );
  });

  it("starts another archive where a step's files pass what one may hold, the act's file in the last, and leaves a file no archive may hold alone", () => {
    const files = [
      ["records/conditions/a1.ttl", bytes("aaaa")],
      ["records/conditions/a2.ttl", bytes("bbbb")],
      ["records/conditions/a3.ttl", bytes("cccc")],
      ["records/conditions/a4.ttl", bytes("dddd")],
      ["records/conditions/a5.ttl", bytes("eeee")],
      [ACT, bytes("ff")],
    ] as const;
    assert.deepEqual(
      archivesOf(files, { entries: 2, bytes: 100 }).map((one) =>
        one.map(([path]) => path),
      ),
      [
        ["records/conditions/a1.ttl", "records/conditions/a2.ttl"],
        ["records/conditions/a3.ttl", "records/conditions/a4.ttl"],
        ["records/conditions/a5.ttl", ACT],
      ],
      "by the number of entries",
    );
    assert.deepEqual(
      archivesOf(files, { entries: 65535, bytes: 9 }).map((one) =>
        one.map(([path]) => path),
      ),
      [
        ["records/conditions/a1.ttl", "records/conditions/a2.ttl"],
        ["records/conditions/a3.ttl", "records/conditions/a4.ttl"],
        ["records/conditions/a5.ttl", ACT],
      ],
      "by the bytes they declare",
    );
    assert.equal(archivesOf(files).length, 1, "a step of six files is one");
  });

  describe("given a pod that requires what the runtime cannot do", () => {
    const UNKNOWN = "https://ns.cascadeprotocol.org/cascade#SomethingLater";
    const named = async (iri: string): Promise<string> =>
      `format/${sha256(bytes(iri))}.ttl`;

    it("refuses at the first read, naming each requirement it does not meet or else the file; reads no file of a requirement it meets; ignores a name no requirement has", async () => {
      const host = new MemoryFiles(POD);
      await host.write(CARD, bytes("<#me> a <#Person> .\n"));
      await host.write(MARKER, bytes(REQUIREMENT_LINE));
      await host.write("format/.DS_Store", bytes("noise"));
      const reads: string[] = [];
      const watched: Files = {
        iri: host.iri,
        read: (path) => (reads.push(path), host.read(path)),
        write: (path, written) => host.write(path, written),
        list: (path) => host.list(path),
      };
      const newStore = () => new OxigraphStore();
      const opened = archivedFiles(watched, layout, newStore);
      assert.equal(text(await opened.read(CARD)), "<#me> a <#Person> .\n");
      assert.ok(
        !reads.includes(MARKER),
        "a met requirement's file is not read",
      );

      const later = await named(UNKNOWN);
      await host.write(
        later,
        bytes(
          `<../> <http://purl.org/dc/terms/requires> <${UNKNOWN}> , <https://ns.cascadeprotocol.org/cascade#ReadingFilesHeldInArchives> .\n`,
        ),
      );
      reads.length = 0;
      await assert.rejects(
        archivedFiles(watched, layout, newStore).read(CARD),
        (error: unknown) =>
          error instanceof Refusal &&
          error.message.includes(UNKNOWN) &&
          !error.message.includes("ReadingFilesHeldInArchives"),
      );
      assert.deepEqual(
        reads,
        [later],
        "nothing of the pod is read but that file",
      );

      await host.write(later, bytes("this is no Turtle {"));
      await assert.rejects(
        archivedFiles(watched, layout, newStore).read(CARD),
        (error: unknown) =>
          error instanceof Refusal && error.message.includes(later),
      );
    });

    it("keeps the requirements' folder out of a snapshot's set, out of what a build loads and out of what an upgrade refuses as changed", () => {
      assert.equal(layout.requirementsFolder, "format/");
      assert.equal(layout.inSnapshotSet(MARKER), false);
      assert.equal(layout.loads(MARKER), false);
      assert.equal(layout.uses(MARKER), false);
      assert.equal(layout.inSnapshotSet(RECORD), true);
    });
  });
});
