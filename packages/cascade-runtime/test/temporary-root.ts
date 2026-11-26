import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = /^cascade-test-(\d+)-/;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Held open by another process: the next process to start tries again.
  }
}

/** Removes the roots in `parent` whose process has ended: a run that was killed, or a file held open when its process ended. */
export function sweepEndedRoots(parent: string): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = ROOT.exec(name)?.[1];
    if (pid !== undefined && !running(Number(pid))) remove(join(parent, name));
  }
}

/**
 * Makes the process's temp directory a new folder of its own, removed when the process ends, so every folder a test
 * makes there goes with it, whether or not the test removes it. The temp directory the process was started with is
 * swept of the roots of processes that have ended. Gives the root.
 */
export function takeTemporaryRoot(): string {
  const parent = tmpdir();
  sweepEndedRoots(parent);
  const root = mkdtempSync(join(parent, `cascade-test-${process.pid}-`));
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
  process.once("exit", () => remove(root));
  return root;
}
