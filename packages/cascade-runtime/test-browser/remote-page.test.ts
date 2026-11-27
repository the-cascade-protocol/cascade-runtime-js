// A page that talks to a server, built from the packed package as an app installs it, by Vite with `cascadeRuntime()`:
// `npm run build:package`, then `npm run test:pod-browser`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build as esbuild } from "esbuild";
import { build, type Plugin, type Rolldown } from "vite";
import { PACKAGE } from "./serving.js";

/** The modules the page's two functions are written in, under the packed package. */
const WRITTEN_IN = ["dist/src/app/remote.js", "dist/src/app/said.js"];

/** Each module's real path, with forward slashes, so that a path through a link is the path it names. */
const real = async (path: string) =>
  (await realpath(path)).replaceAll("\\", "/");

/**
 * A page of an app whose pods are at its server, which calls PodApi there through `remoteApi` and says a pod's name with
 * `personName`, carries those two and what they need, and none of the runtime that runs a pod.
 */
describe("A page that talks to a server, bundled from the packed package · cascade-runtime/app, cascadeRuntime({ browser: false })", () => {
  let folder: string;
  let output: (Rolldown.OutputChunk | Rolldown.OutputAsset)[];
  let budget: { bytes: number; modules: Set<string> };

  before(async () => {
    assert.ok(
      existsSync(join(PACKAGE, "dist", "browser", "index.js")),
      `${PACKAGE} holds no packed browser build: run npm run build:package`,
    );
    folder = await mkdtemp(join(tmpdir(), "remote-page-"));
    await mkdir(join(folder, "node_modules"));
    await symlink(
      PACKAGE,
      join(folder, "node_modules", "cascade-runtime"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(folder, "index.html"),
      `<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>`,
    );
    await writeFile(
      join(folder, "main.js"),
      [
        `import { personName, remoteApi } from "cascade-runtime/app";`,
        `remoteApi(location.href).pods({}).then(({ pods }) => { document.title = personName(pods[0].name); });`,
      ].join("\n"),
    );
    const { cascadeRuntime } = (await import(
      pathToFileURL(join(PACKAGE, "dist", "src", "node", "vite.js")).href
    )) as { cascadeRuntime(options: { browser: boolean }): Plugin };
    const built = await build({
      root: folder,
      logLevel: "silent",
      configFile: false,
      plugins: [cascadeRuntime({ browser: false })],
      build: { write: false },
    });
    output = (Array.isArray(built) ? built : [built]).flatMap((each) =>
      "output" in each ? each.output : [],
    );
    const at = await real(PACKAGE);
    const { metafile } = await esbuild({
      entryPoints: WRITTEN_IN.map((path) => join(at, path)),
      absWorkingDir: at,
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      outdir: "out",
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.entries(metafile.inputs);
    budget = {
      bytes: inputs.reduce((sum, [, { bytes }]) => sum + bytes, 0),
      modules: new Set(
        await Promise.all(inputs.map(([path]) => real(resolve(at, path)))),
      ),
    };
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  });

  it("holds no module but those the two functions are written in and what they import, in fewer bytes than those modules weigh", async () => {
    const chunks = output.filter(
      (each): each is Rolldown.OutputChunk => each.type === "chunk",
    );
    const page = await real(folder);
    const modules = await Promise.all(
      chunks
        .flatMap(({ moduleIds }) => moduleIds)
        .filter((id) => isAbsolute(id))
        .map(real),
    );
    const bytes = chunks.reduce(
      (sum, { code }) => sum + Buffer.byteLength(code),
      0,
    );
    assert.ok(
      bytes < budget.bytes,
      `the page is ${bytes} bytes, its functions' modules ${budget.bytes}`,
    );
    assert.deepEqual(
      modules.filter(
        (id) => !id.startsWith(`${page}/`) && !budget.modules.has(id),
      ),
      [],
    );
  });

  it("writes no `.wasm` file", () => {
    assert.deepEqual(
      output
        .filter(({ fileName }) => fileName.endsWith(".wasm"))
        .map(({ fileName }) => fileName),
      [],
    );
  });
});
