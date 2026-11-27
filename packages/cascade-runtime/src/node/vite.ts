import { existsSync, readFileSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HtmlTagDescriptor, Plugin } from "vite";
import { acceptOptions } from "../options.js";

/** Where the runtime's files go under the base, as `configureRuntime({ base })` names them. */
export const RUNTIME_FOLDER = "cascade-runtime/";

/** The file of the browser build that lists, for each entry, the files a page loads with it. */
const PRELOADS = "preloads.json";
/** What an app imports to load each entry of the browser build. */
const IMPORTS: Record<string, string> = {
  index: "cascade-runtime",
  app: "cascade-runtime/app",
};

export interface CascadeRuntimeOptions {
  /** Whether this is the build that runs the runtime in the page; the plugin does nothing for another. Default true. */
  browser?: boolean;
  /** Where the runtime's files go under the base. Default `RUNTIME_FOLDER`. */
  folder?: string;
  /** The folder of the `cascade-runtime` package to serve. Default the one this plugin is in. */
  from?: string;
}

/** The folder of the package this file is in, the one named `cascade-runtime`. */
function installed(): string {
  let folder = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(folder, "package.json");
    if (
      existsSync(file) &&
      (JSON.parse(readFileSync(file, "utf8")) as { name?: string }).name ===
        "cascade-runtime"
    )
      return folder;
    const parent = dirname(folder);
    if (parent === folder)
      throw new Error(
        "No package.json named cascade-runtime is above cascade-runtime/vite; run npm install.",
      );
    folder = parent;
  }
}

const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

/** What a page reads of the package besides its browser build, by its path under the package: the components. */
async function components(folder: string): Promise<string[]> {
  const packed = await json<{
    components: { repository: string; commit: string }[];
  }>(join(folder, "components/packed.json"));
  const trees = [
    "components/tables",
    ...packed.components.map(
      ({ repository, commit }) =>
        `components/${repository.split("/").at(-1)}/${commit}`,
    ),
  ];
  const paths = ["components/cascade-runtime.json", "components/packed.json"];
  for (const tree of trees) {
    const listed = await json<string[]>(join(folder, tree, "files.json"));
    paths.push(
      `${tree}.json`,
      `${tree}/files.json`,
      ...listed.map((path) => `${tree}/${path}`),
    );
  }
  return paths;
}

/**
 * A Vite plugin that serves the runtime's browser build beside an app's bundle. The app's bundle keeps
 * `cascade-runtime` and `cascade-runtime/app` external; the build copies the package's browser build and the components
 * it reads under the base, and an import map in the page loads each entry from there, so the runtime keeps its own
 * `import.meta.url` and the two entries share one copy of it.
 */
export function cascadeRuntime(options: CascadeRuntimeOptions = {}): Plugin {
  acceptOptions("cascadeRuntime", options, {
    browser: true,
    folder: true,
    from: true,
  });
  const { browser = true, folder = RUNTIME_FOLDER, from } = options;
  const source = from ?? installed();
  let base = "/";
  let out = "";
  return {
    name: "cascade-runtime",
    config: () =>
      browser
        ? {
            build: {
              rolldownOptions: {
                external: ["cascade-runtime", "cascade-runtime/app"],
              },
            },
          }
        : {},
    configResolved(config) {
      base = config.base;
      out = resolve(config.root, config.build.outDir);
    },
    async transformIndexHtml(_html, { bundle }) {
      if (!browser) return [];
      const entry = `${base}${folder}index.js`;
      const closures = await json<Record<string, string[]>>(
        join(source, "dist", "browser", PRELOADS),
      );
      const imported = new Set(
        Object.values(bundle ?? {}).flatMap((file) =>
          file.type === "chunk" ? file.imports : [],
        ),
      );
      const entries = bundle === undefined ? ["index"] : Object.keys(closures);
      const preloaded = new Set(
        entries
          .filter(
            (name) => bundle === undefined || imported.has(IMPORTS[name] ?? ""),
          )
          .flatMap((name) => closures[name] ?? []),
      );
      const tags: HtmlTagDescriptor[] = [
        {
          tag: "script",
          attrs: { type: "importmap" },
          children: JSON.stringify({
            imports: {
              "cascade-runtime": entry,
              "cascade-runtime/app": `${base}${folder}app.js`,
            },
          }),
          injectTo: "head-prepend",
        },
        ...[...preloaded].map((file): HtmlTagDescriptor => ({
          tag: "link",
          attrs: { rel: "modulepreload", href: `${base}${folder}${file}` },
          injectTo: "head",
        })),
      ];
      return tags;
    },
    async writeBundle() {
      if (!browser) return;
      await cp(join(source, "dist", "browser"), join(out, folder), {
        recursive: true,
      });
      for (const path of await components(source))
        await cp(join(source, path), join(out, folder, path));
    },
  };
}
