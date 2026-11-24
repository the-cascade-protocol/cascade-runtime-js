import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadHospital } from "@the-cascade-protocol/sandbox/node";
import { probing, type Seen } from "@cascade-runtime/runtime/probe";
import {
  type Done,
  type Imported,
  openPod,
  type Pod,
  type Pull,
  pullFiles,
  type Row,
  type ExportSource,
} from "cascade-runtime";
import { importClaimingEveryProfile } from "./claiming.js";
import { pulled } from "./hospitals.js";

const HYPERTENSION = "http://snomed.info/id/59621000";

/** The SHA-256 of every file under the folder, by its path in it. */
async function hashed(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(
      path.slice(folder.length),
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    );
  }
  return files;
}

/** A clock stopped at the time, whose milliseconds end in zeros, as a stored `xsd:dateTime` drops them. */
function stopped(time: string): { now: () => Date } {
  return { now: () => new Date(time) };
}

/**
 * `pullFiles` saves a pull as files, which `pod.look()` and `pod.import()` take as they take an export. Pulls from two
 * hospitals land in one pod, where the matcher joins the records both hold. The files themselves, and the pulls
 * `pullFiles` refuses, are on the fhir-pull page, under "Saving a pull as files" and "Refusing a pull an import cannot
 * state".
 * @rule runtime/arrivals.feature A11
 * @rule runtime/arrivals.feature A1
 * @rule runtime/matcher.feature M14
 */
describe("Bringing a pull into a pod · pullFiles(), pod.look(), pod.import()", () => {
  let north: Pull;
  let looked: readonly ExportSource[];
  let imported: Done[];
  let conditions: Row[];
  let again: Done;
  let pod: Pod;
  let folder: string;

  /** Every step in order, once: a leaf run alone must find what the ones before it did. */
  before(async () => {
    north = (
      await pulled(
        await loadHospital("cascade-north"),
        "pt-1001",
        stopped("2026-10-07T08:04:46.170Z"),
      )
    ).pull;
    const south = (
      await pulled(
        await loadHospital("cascade-south"),
        "s-48213",
        stopped("2026-10-07T08:05:00.000Z"),
      )
    ).pull;
    pod = await openPod();
    folder = await mkdtemp(join(tmpdir(), "cascade-pull-"));

    looked = await pod.look(pullFiles(north, "north"));
    imported = [];
    for (const [one, name] of [
      [north, "north"],
      [south, "south"],
    ] as const)
      imported.push(
        await importClaimingEveryProfile(pod, pullFiles(one, name)),
      );
    conditions = await pod.ask("pod/My active conditions");

    for (const [path, bytes] of pullFiles(north, "north")) {
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await writeFile(join(folder, path), bytes);
    }
    again = await pod.import(join(folder, "north"));
  });

  after(async () => {
    await pod.close();
    await rm(folder, { recursive: true, force: true });
  });

  describe("pod.look(files)", () => {
    it("returns one source for a pull's files: the hospital's name, its FHIR base as `server`, and the pull's `retrievedAt` in `received`", () => {
      assert.equal(looked.length, 1);
      assert.equal(looked[0]?.name, north.source);
      assert.equal(looked[0]?.server, north.fhirBase);
      assert.deepEqual(looked[0]?.received, [north.retrievedAt]);
    });
  });

  describe("given one person's pulls from two hospitals, each imported and claimed", () => {
    it("stores both, with neither import `refused`", () => {
      for (const [at, done] of imported.entries()) {
        assert.equal(done.refused, undefined, `import ${at}`);
        assert.ok(done.wrote.length > 0, `import ${at} wrote nothing`);
      }
    });

    it("shows a condition both hospitals hold as one row of `pod/My active conditions`, made of two records", () => {
      const hypertension = conditions.filter(
        ({ conditionCode }) => conditionCode === HYPERTENSION,
      );
      assert.equal(hypertension.length, 1);
      assert.equal(hypertension[0]?.records, "2");
    });
  });

  describe("given a pull the pod already holds, saved to a folder", () => {
    it("writes nothing when it is imported again from the folder's path", () => {
      assert.equal(again.refused, undefined);
      assert.deepEqual(again.wrote, []);
      assert.equal(again.activity, undefined);
    });
  });

  describe("given a pull a pod kept in a folder holds, imported again after the pod is opened again", () => {
    let held: Imported;
    let seen: Seen;
    let filesBefore: Map<string, string>;
    let filesAfter: Map<string, string>;
    let rowsBefore: Row[];
    let rowsAfter: Row[];

    before(async () => {
      const kept = await mkdtemp(join(tmpdir(), "cascade-held-"));
      try {
        let podHere = await openPod(kept);
        await importClaimingEveryProfile(podHere, pullFiles(north, "north"));
        await podHere.close();
        podHere = await openPod(kept);
        rowsBefore = await podHere.ask("pod/My active conditions");
        filesBefore = await hashed(kept);
        ({ result: held, seen } = await probing(() =>
          podHere.import(pullFiles(north, "north")),
        ));
        filesAfter = await hashed(kept);
        rowsAfter = await podHere.ask("pod/My active conditions");
        await podHere.close();
      } finally {
        await rm(kept, { recursive: true, force: true });
      }
    });

    it("files no activity and runs no matcher, writing nothing", () => {
      assert.equal(held.refused, undefined);
      assert.deepEqual(held.wrote, []);
      assert.equal(held.activity, undefined);
      assert.equal(held.matched, undefined);
    });

    it("performs no step: it reads none of the pod's revisions or its kept build, loads no adapter, rebuilds nothing and asks no matcher", () => {
      for (const name of [
        "arrivals.revisionsOf",
        "core-pod.import.adapters",
        "arrivals.accepting",
        "kept.readBack",
        "kept.whole",
        "pod.match",
        "matcher.of",
      ])
        assert.equal(seen.spans.get(name)?.calls ?? 0, 0, name);
      assert.deepEqual(
        [...seen.spans.keys()].filter((name) =>
          name.startsWith("core-pod.step.rebuild"),
        ),
        [],
      );
    });

    it("leaves every file of the pod as it was, and the same rows for a later question", () => {
      assert.ok(filesBefore.size > 0);
      assert.deepEqual(filesAfter, filesBefore);
      assert.deepEqual(rowsAfter, rowsBefore);
      assert.ok(rowsBefore.length > 0);
    });
  });
});
