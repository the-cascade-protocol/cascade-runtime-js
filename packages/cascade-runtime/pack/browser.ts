import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
const PAGE_ENTRIES = {
  index: join(ENTRY, "index.js"),
  app: join(ENTRY, "app.js"),
};

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
  await Promise.all([
    build({
      ...BUNDLED,
      entryPoints: PAGE_ENTRIES,
      splitting: true,
      outdir: out,
      define,
    }),
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
