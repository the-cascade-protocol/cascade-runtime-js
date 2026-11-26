import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const MODULE = new URL("./temporary-root.js", import.meta.url).href;

/**
 * A process that takes its temporary root while `parent` is its temp directory, makes a folder with a file in it, and
 * ends; what it printed, as JSON, and its process id.
 */
function oneProcess(parent: string): {
  root: string;
  made: string;
  pid: number;
} {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { mkdtempSync, writeFileSync } from "node:fs";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       import { takeTemporaryRoot } from ${JSON.stringify(MODULE)};
       const root = takeTemporaryRoot();
       const made = mkdtempSync(join(tmpdir(), "made-"));
       writeFileSync(join(made, "file"), "held");
       console.log(JSON.stringify({ root, made, pid: process.pid }));`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TEMP: parent, TMP: parent, TMPDIR: parent },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as { root: string; made: string; pid: number };
}

/**
 * Every folder a test run makes in the temp directory is made under one root of its process, so the run leaves nothing
 * behind that a test forgot to remove.
 */
describe("Folders a test run leaves in the temp directory · test/temporary-root.ts", () => {
  let parent: string;

  before(() => {
    parent = mkdtempSync(join(tmpdir(), "temporary-root-"));
  });

  after(() => {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
  });

  it("removes the folders a process made in the temp directory, and its root, when it ends", () => {
    const { root, made } = oneProcess(parent);
    assert.ok(made.startsWith(root), `${made} is not under ${root}`);
    assert.equal(existsSync(made), false, "a folder it made is left");
    assert.equal(existsSync(root), false, "its root is left");
  });

  it("removes the root of a process that has ended, and keeps the root of one still running", () => {
    const { pid: ended } = oneProcess(parent);
    const gone = join(parent, `cascade-test-${ended}-abc123`);
    const running = join(parent, `cascade-test-${process.pid}-abc123`);
    for (const root of [gone, running]) {
      mkdirSync(join(root, "inner"), { recursive: true });
      writeFileSync(join(root, "inner", "file"), "left");
    }
    oneProcess(parent);
    assert.equal(existsSync(gone), false, "an ended process's root is left");
    assert.equal(existsSync(running), true, "a running process's root went");
  });
});
