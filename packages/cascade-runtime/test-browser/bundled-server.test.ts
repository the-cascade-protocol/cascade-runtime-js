// A server that bundles the packed package with its dependencies, and what the package declares of itself:
// `npm run build:package`, then `npm run test:pod-browser`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { build, type Rolldown } from "vite";
import { PACKAGE } from "./serving.js";

const ROOT = join(PACKAGE, "..", "..");

/** A folder's manifest, as much of it as the cases read. */
async function read(
  folder: string,
): Promise<{ name: string; sideEffects?: unknown }> {
  return JSON.parse(await readFile(join(folder, "package.json"), "utf8")) as {
    name: string;
    sideEffects?: unknown;
  };
}

/**
 * A server whose build bundles every dependency, `cascade-runtime` among them, still runs what the runtime does when its
 * Node entry loads: it picks the engine `CASCADE_OXIGRAPH` names. The package's manifests say which of their modules do
 * that, as the workspaces' own do.
 */
describe("A server bundled with the packed package · openPod(), CASCADE_OXIGRAPH, sideEffects", () => {
  let folder: string;

  before(async () => {
    assert.ok(
      existsSync(join(PACKAGE, "dist", "src", "index.js")),
      `${PACKAGE} holds no packed package: run npm run build:package`,
    );
    folder = await mkdtemp(join(tmpdir(), "bundled-server-"));
    await mkdir(join(folder, "node_modules"));
    await symlink(
      PACKAGE,
      join(folder, "node_modules", "cascade-runtime"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(folder, "server.js"),
      `import { openPod } from "cascade-runtime";\nexport const open = (path) => openPod(path);\n`,
    );
  });

  after(async () => {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  });

  it("keeps the call that chooses the engine when the runtime's Node entry loads", async () => {
    const built = await build({
      root: folder,
      logLevel: "silent",
      configFile: false,
      ssr: {
        noExternal: true,
        external: [
          "better-sqlite3-multiple-ciphers",
          "cascade-bridge-rs",
          "oxigraph",
        ],
      },
      build: {
        ssr: join(folder, "server.js"),
        write: false,
        minify: false,
        rolldownOptions: { output: { codeSplitting: false } },
      },
    });
    const output = (Array.isArray(built) ? built : [built]).flatMap((each) =>
      "output" in each ? each.output : [],
    );
    const code = output
      .flatMap((each: Rolldown.OutputChunk | Rolldown.OutputAsset) =>
        each.type === "chunk" ? [each.code] : [],
      )
      .join("\n");
    assert.ok(
      /useOxigraph\(\(\) => chooseOxigraph\(\)\)/.test(code),
      "the bundle of openPod holds no call of useOxigraph with the Node entry's chooser",
    );
  });

  it("has each carried workspace's manifest declare the `sideEffects` its source declares, and the package's the same", async () => {
    const carried = join(PACKAGE, "node_modules", "@cascade-runtime");
    const sources = new Map<string, string>();
    for (const workspace of await readdir(join(ROOT, "packages"))) {
      const at = join(ROOT, "packages", workspace);
      if (existsSync(join(at, "package.json")))
        sources.set((await read(at)).name, at);
    }
    const compared: [string, unknown, unknown][] = [];
    for (const name of await readdir(carried)) {
      const packed = join(carried, name);
      const source = sources.get(`@cascade-runtime/${name}`);
      assert.ok(source, `no workspace of the repository is named ${name}`);
      compared.push([
        `@cascade-runtime/${name}`,
        (await read(packed)).sideEffects,
        (await read(source)).sideEffects,
      ]);
    }
    compared.push([
      "cascade-runtime",
      (await read(PACKAGE)).sideEffects,
      (await read(join(ROOT, "packages", "cascade-runtime"))).sideEffects,
    ]);
    assert.ok(
      compared.length > 2,
      "the package carries no workspace of the repository",
    );
    for (const [name, packed, source] of compared)
      assert.deepEqual(packed, source, `${name}'s sideEffects`);
  });
});
