import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { workerExecArgv } from "../src/node/worker-arguments.js";

describe("The arguments a worker thread is started with · workerExecArgv()", () => {
  it("returns undefined for a process with no preload, so node starts the worker as it does by default", () => {
    assert.equal(
      workerExecArgv([
        "--permission",
        "--allow-fs-read=/app",
        "--disallow-code-generation-from-strings",
        "--max-old-space-size=300",
      ]),
      undefined,
    );
    assert.equal(workerExecArgv([]), undefined);
  });

  it("with a preload, keeps what node accepts for a worker, and drops the preloads and every option node refuses", () => {
    assert.deepEqual(
      workerExecArgv([
        "--import",
        "file:///a.mjs",
        "--enable-source-maps",
        "--import=file:///b.mjs",
        "-r",
        "c.cjs",
        "--require=e.cjs",
        "--permission",
        "--allow-fs-read=/app",
        "--allow-fs-write",
        "/out",
        "--allow-worker",
        "--max-old-space-size=300",
        "--use-largepages=off",
        "--disallow-code-generation-from-strings",
        "--frozen-intrinsics",
        "--conditions=development",
      ]),
      [
        "--enable-source-maps",
        "--permission",
        "--allow-fs-read=/app",
        "--allow-fs-write",
        "/out",
        "--allow-worker",
        "--frozen-intrinsics",
        "--conditions=development",
      ],
    );
  });

  describe("given the options `node --test` starts a test with", () => {
    it("starts a worker", async () => {
      const worker = new Worker("0", {
        eval: true,
        execArgv: workerExecArgv(),
      });
      await once(worker, "exit");
    });
  });

  describe("given a process started under `--permission`", () => {
    for (const preloaded of [false, true])
      it(`starts a worker that still cannot read outside the allowed folder, ${preloaded ? "with" : "without"} a preload`, async () => {
        const folder = await mkdtemp(join(tmpdir(), "worker-permission-"));
        const outside = await mkdtemp(join(tmpdir(), "worker-outside-"));
        try {
          await writeFile(join(outside, "secret"), "secret");
          const helper = fileURLToPath(
            import.meta.resolve("../src/node/worker-arguments.js"),
          );
          await writeFile(
            join(folder, "run.mjs"),
            `import { Worker } from "node:worker_threads";
import { workerExecArgv } from ${JSON.stringify(import.meta.resolve("../src/node/worker-arguments.js"))};
const worker = new Worker(
  \`import { readFileSync } from "node:fs";
  import { parentPort } from "node:worker_threads";
  try { readFileSync(${JSON.stringify(join(outside, "secret").replaceAll("\\", "/"))});parentPort.postMessage("read"); }
  catch (error) { parentPort.postMessage(error.code); }\`,
  { eval: true, execArgv: workerExecArgv() },
);
worker.on("message", (said) => { console.log(said); worker.terminate(); });
`,
          );
          await writeFile(join(folder, "preload.mjs"), "");
          const { stdout } = await promisify(execFile)(process.execPath, [
            ...(preloaded
              ? ["--import", pathToFileURL(join(folder, "preload.mjs")).href]
              : []),
            "--permission",
            `--allow-fs-read=${folder}`,
            `--allow-fs-read=${helper}`,
            "--allow-worker",
            join(folder, "run.mjs"),
          ]);
          assert.equal(stdout.trim(), "ERR_ACCESS_DENIED");
        } finally {
          await rm(folder, { recursive: true, force: true });
          await rm(outside, { recursive: true, force: true });
        }
      });
  });
});
