import { copyFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions } from "esbuild";
import {
  BRIDGE_GLUE,
  BRIDGE_WASM,
  documentName,
} from "@cascade-runtime/runtime";
import { packageVersion } from "./address.js";

const WORKSPACE = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(WORKSPACE, "dist", "src", "browser");
const WEB = join(WORKSPACE, "..", "runtime", "dist", "src", "web");
const WASM = "web_bg.wasm";
/** The file beside the entries that lists the files a page loads with each: the Vite plugin preloads them. */
const PRELOADS = "preloads.json";

const BUNDLED: BuildOptions = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  logLevel: "warning",
};

export interface BrowserBuild {
  readonly commit: string;
  /** Whether the checkout held uncommitted changes. */
  readonly dirty: boolean;
  /** The components the package carries, as `packed.json` records them. */
  readonly components: readonly {
    readonly repository: string;
    readonly commit: string;
  }[];
  readonly bridge: string;
}

/**
 * The entries a page imports, which are bundled together with their shared code in chunks, so that the page has one copy
 * of each module: `cascade-runtime` and `cascade-runtime/app` throw the one `Refusal` and keep the one set of tables.
 */
const PAGE_ENTRIES: Record<string, string> = {
  index: join(ENTRY, "index.js"),
  app: join(ENTRY, "app.js"),
};

/**
 * Bundles the entries into `out` with their shared code in chunks. Gives, for each entry, the files a page loads with it
 * at once, its own and the chunks it imports statically, as paths under `out`. Writes no output that no entry reaches,
 * statically or by an `import()` an emitted file keeps: bundling writes the chunks of an `import()` in a module the
 * entries tree-shake, which nothing loads.
 */
export async function bundlePages(
  out: string,
  entries: Record<string, string> = PAGE_ENTRIES,
  define: Record<string, string> = {},
): Promise<Record<string, string[]>> {
  const { metafile } = await build({
    ...BUNDLED,
    entryPoints: entries,
    splitting: true,
    outdir: out,
    define,
    metafile: true,
  });
  const graph = new Map(
    Object.entries(metafile.outputs).map(([path, { imports }]) => [
      basename(path),
      imports
        .filter(({ external }) => !external)
        .map(({ path, kind }) => ({ file: basename(path), kind })),
    ]),
  );
  const reached = new Set<string>();
  const walk = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const { file: next } of graph.get(file) ?? []) walk(next);
  };
  const closures: Record<string, string[]> = {};
  for (const name of Object.keys(entries)) {
    const loaded = new Set<string>();
    const load = (file: string): void => {
      if (loaded.has(file)) return;
      loaded.add(file);
      for (const { file: next, kind } of graph.get(file) ?? [])
        if (kind === "import-statement") load(next);
    };
    load(`${name}.js`);
    closures[name] = [...loaded];
    walk(`${name}.js`);
  }
  await Promise.all(
    [...graph.keys()]
      .filter((file) => !reached.has(file))
      .map((file) => rm(join(out, file))),
  );
  return closures;
}

/** The bundled browser build's code, without its version: what tells one uncommitted build from another. */
async function codeOf(): Promise<string> {
  const { outputFiles } = await build({
    ...BUNDLED,
    entryPoints: PAGE_ENTRIES,
    splitting: true,
    write: false,
    outdir: "out",
  });
  if (outputFiles.length === 0)
    throw new Error("the page's entries bundled to nothing");
  const code = new TextEncoder().encode(
    outputFiles
      .toSorted((a, b) => a.path.localeCompare(b.path))
      .map((file) => file.text)
      .join("\0"),
  );
  return documentName(code);
}

/**
 * Writes the browser build into `out`: the entries a page imports, `cascade-runtime` and `cascade-runtime/app`, bundled
 * with their shared code in chunks, the input checker, the tables' worker, Argon2's and the Bridge's, the Bridge's glue
 * bundled into its worker, with Oxigraph's module and the Bridge's beside them. Gives the build's version, fixed in
 * it here: the commit's package version, or for an uncommitted build that and its code's name, with the components.
 */
export async function bundleBrowser(
  out: string,
  packing: BrowserBuild,
): Promise<string> {
  await rm(out, { recursive: true, force: true });
  const code = packing.dirty
    ? `${packageVersion(packing.commit)}+${await codeOf()}`
    : packageVersion(packing.commit);
  const version = await documentName(
    new TextEncoder().encode(JSON.stringify([code, packing.components])),
  );
  const define = {
    CASCADE_BROWSER_BUILD_VERSION: JSON.stringify(version),
    CASCADE_RUNTIME_COMMIT: JSON.stringify(packing.commit),
    CASCADE_RUNTIME_DIRTY: JSON.stringify(packing.dirty),
  };
  const [closures] = await Promise.all([
    bundlePages(out, PAGE_ENTRIES, define),
    build({
      ...BUNDLED,
      entryPoints: {
        check: join(WORKSPACE, "dist", "src", "check.js"),
        "tables-worker": join(ENTRY, "tables-worker.js"),
        "argon2-worker": join(WEB, "argon2-worker.js"),
      },
      outdir: out,
      define,
    }),
  ]);
  await writeFile(join(out, PRELOADS), JSON.stringify(closures));
  const glue = join(packing.bridge, BRIDGE_GLUE).replaceAll("\\", "/");
  await build({
    ...BUNDLED,
    stdin: {
      contents: [
        `import * as glue from ${JSON.stringify(glue)};`,
        `import { serveBridge } from "./wasm-worker.js";`,
        "serveBridge(glue);",
      ].join("\n"),
      resolveDir: WEB,
      sourcefile: "bridge-worker.js",
      loader: "js",
    },
    outfile: join(out, "wasm-worker.js"),
  });
  await copyFile(
    fileURLToPath(new URL(WASM, import.meta.resolve("oxigraph/web.js"))),
    join(out, WASM),
  );
  await copyFile(join(packing.bridge, BRIDGE_WASM), join(out, BRIDGE_WASM));
  return version;
}
