import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cascadeRuntime } from "cascade-runtime/vite";
import { build } from "vite";

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

/** The files of an installed package as `cascadeRuntime()` reads them: its browser build, its preloads and a component tree. */
const runtimeFiles = (tree: string): Record<string, string> => ({
  "package.json": JSON.stringify({
    name: "cascade-runtime",
    version: "1.2.3",
  }),
  "dist/browser/index.js": `export { here } from "./chunk-A.js"; export const lazy = () => import("./chunk-LAZY.js");`,
  "dist/browser/app.js": `import { here } from "./chunk-A.js"; export const podApi = () => here;`,
  "dist/browser/chunk-A.js": `import { base } from "./chunk-B.js"; export const here = import.meta.url + base;`,
  "dist/browser/chunk-B.js": "export const base = '';",
  "dist/browser/chunk-LAZY.js": "export const later = 1;",
  "dist/browser/preloads.json": JSON.stringify({
    index: ["index.js", "chunk-A.js", "chunk-B.js"],
    app: ["app.js", "chunk-A.js", "chunk-B.js"],
  }),
  "dist/browser/tables-worker.js": "",
  "components/cascade-runtime.json": "{}",
  "components/packed.json": JSON.stringify({
    components: [
      { repository: "https://github.com/x/vocabulary", commit: "abc" },
    ],
  }),
  "components/tables.json": "{}",
  "components/tables/files.json": JSON.stringify(["a.ttl"]),
  "components/tables/a.ttl": "",
  [`${tree}.json`]: "{}",
  [`${tree}/files.json`]: JSON.stringify(["rules.md"]),
  [`${tree}/rules.md`]: "rules",
});

describe("Importing the package in a web page · browserBuildVersion(), cascadeRuntime()", () => {
  describe("given a Vite build with a `base`, using `cascadeRuntime()`", () => {
    const tree = "components/vocabulary/abc";
    let folder: string;
    let out: string;

    before(async () => {
      folder = await mkdtemp(join(tmpdir(), "vite-plugin-"));
      const installed = join(folder, "installed");
      await write(installed, runtimeFiles(tree));
      const app = join(folder, "app");
      await write(app, {
        "index.html": `<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>`,
        "main.js": `import { here } from "cascade-runtime"; import { podApi } from "cascade-runtime/app"; document.title = here + podApi;`,
      });
      await build({
        root: app,
        base: "/made/",
        logLevel: "silent",
        configFile: false,
        plugins: [cascadeRuntime({ from: installed })],
      });
      out = join(app, "dist");
    });

    after(async () => {
      await rm(folder, { recursive: true, force: true, maxRetries: 5 });
    });

    it("copies the package's browser build and the components a page reads into `cascade-runtime/` under the build's output", async () => {
      const served = (
        await readdir(join(out, "cascade-runtime"), { recursive: true })
      ).map((path) => path.replaceAll("\\", "/"));
      for (const path of [
        "index.js",
        "app.js",
        "tables-worker.js",
        "components/packed.json",
        "components/tables.json",
        "components/tables/a.ttl",
        `${tree}/rules.md`,
      ])
        assert.ok(served.includes(path), `${path} is under the base`);
    });

    it("leaves `cascade-runtime` and `cascade-runtime/app` out of the app's bundle, as imports the page resolves", async () => {
      const scripts = (await readdir(join(out, "assets"))).filter((name) =>
        name.endsWith(".js"),
      );
      assert.equal(scripts.length, 1);
      const bundle = await readFile(join(out, "assets", scripts[0]!), "utf8");
      assert.match(bundle, /from\s*["']cascade-runtime["']/);
      assert.match(bundle, /from\s*["']cascade-runtime\/app["']/);
      assert.doesNotMatch(bundle, /import\.meta\.url/);
    });

    it("preloads every file of each entry the app imports, and no lazy chunk", async () => {
      const page = await readFile(join(out, "index.html"), "utf8");
      const preloaded = [
        ...page.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g),
      ].map((match) => match[1]);
      assert.deepEqual(preloaded.toSorted(), [
        "/made/cascade-runtime/app.js",
        "/made/cascade-runtime/chunk-A.js",
        "/made/cascade-runtime/chunk-B.js",
        "/made/cascade-runtime/index.js",
      ]);
    });

    it("writes an import map that points `cascade-runtime` and `cascade-runtime/app` at the copies under the base", async () => {
      const page = await readFile(join(out, "index.html"), "utf8");
      const map = /<script type="importmap">(.*?)<\/script>/s.exec(page)?.[1];
      assert.deepEqual(JSON.parse(map ?? "null"), {
        imports: {
          "cascade-runtime": "/made/cascade-runtime/index.js",
          "cascade-runtime/app": "/made/cascade-runtime/app.js",
        },
      });
    });
  });

  describe("given an app on `cascade-runtime/app`, using `cascadeRuntime({ app: true })`", () => {
    let folder: string;
    let installed: string;
    let app: string;

    /** A build of the app, in `mode` of the target, with the environment `settings` names the About box's from. */
    async function built(
      browser: boolean,
      settings: Record<string, string> = {},
    ) {
      const saved = Object.fromEntries(
        Object.keys(settings).map((name) => [name, process.env[name]]),
      );
      Object.assign(process.env, settings);
      try {
        const out = join(app, browser ? "dist-browser" : "dist-node");
        await build({
          root: app,
          logLevel: "silent",
          configFile: false,
          build: {
            outDir: out,
            rolldownOptions: { external: ["cascade-runtime/app"] },
          },
          plugins: [cascadeRuntime({ from: installed, browser, app: true })],
        });
        return out;
      } finally {
        for (const [name, was] of Object.entries(saved))
          if (was === undefined) delete process.env[name];
          else process.env[name] = was;
      }
    }

    before(async () => {
      folder = await mkdtemp(join(tmpdir(), "vite-app-"));
      installed = join(folder, "installed");
      await write(installed, runtimeFiles("components/vocabulary/abc"));
      app = join(folder, "app");
      await write(app, {
        "package.json": JSON.stringify({
          name: "demo-app",
          version: "4.5.6",
          repository: { url: "https://example.test/demo-app.git" },
        }),
        "index.html": `<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>`,
        "main.js": `import { podApi } from "cascade-runtime/app"; document.title = String(podApi);`,
      });
    });

    after(async () => {
      await rm(folder, { recursive: true, force: true, maxRetries: 5 });
    });

    it("puts the app's name, version and code, the runtime's version and the samples on the body of its page, as the environment names them", async () => {
      const out = await built(true, {
        CASCADE_VERSION: "9.9.9",
        CASCADE_HUB: "https://hub.example.test/",
        CASCADE_SAMPLES: "alex-rivera priya-natarajan",
      });
      const body = /<body([^>]*)>/.exec(
        await readFile(join(out, "index.html"), "utf8"),
      )?.[1];
      assert.match(body ?? "", /data-name="demo-app"/);
      assert.match(body ?? "", /data-version="9.9.9"/);
      assert.match(body ?? "", /data-runtime="1.2.3"/);
      assert.match(
        body ?? "",
        /data-code="https:\/\/example\.test\/demo-app\.git"/,
      );
      assert.match(body ?? "", /data-hub="https:\/\/hub\.example\.test\/"/);
      assert.match(body ?? "", /data-samples="alex-rivera priya-natarajan"/);
    });

    it("keeps the preloads and the import map of the plugin beside the About box's attributes, in one page", async () => {
      const page = await readFile(
        join(await built(true), "index.html"),
        "utf8",
      );
      assert.match(page, /<script type="importmap">/);
      assert.match(
        page,
        /<link rel="modulepreload"[^>]*cascade-runtime\/app\.js/,
      );
      assert.match(page, /<body[^>]*data-name="demo-app"/);
    });

    it("serves the demo hospitals from the base in the browser build: the worker, a data file for each hospital, the brands, the people, and the page a sign-in returns to", async () => {
      const out = await built(true);
      const files = (await readdir(out, { recursive: true })).map((path) =>
        path.replaceAll("\\", "/"),
      );
      for (const file of [
        "demo-hospital-worker.js",
        "demo-brands.json",
        "demo-people.json",
        "signed-in.html",
      ])
        assert.ok(files.includes(file), file);
      assert.ok(
        files.some((file) => /^demo-hospitals\/.+\.json$/.test(file)),
        "a data file for a hospital",
      );
      assert.match(
        await readFile(join(out, "signed-in.html"), "utf8"),
        /"cascade-runtime":"\.\/cascade-runtime\/index\.js"/,
      );
    });

    it("adds the About box's attributes and nothing else when the build is not the browser's", async () => {
      const out = await built(false);
      const files = await readdir(out, { recursive: true });
      assert.deepEqual(
        files.filter((file) => /demo|signed-in|cascade-runtime/.test(file)),
        [],
      );
      assert.match(
        await readFile(join(out, "index.html"), "utf8"),
        /<body[^>]*data-name="demo-app"/,
      );
    });
  });

  describe("given a build that is not the browser's, of a page that imports two modules naming a `.wasm` file each and uses one, and whose HTML names a third", () => {
    let folder: string;
    let written: string[];

    before(async () => {
      folder = await mkdtemp(join(tmpdir(), "vite-wasm-"));
      const installed = join(folder, "installed");
      await write(installed, runtimeFiles("components/vocabulary/abc"));
      const app = join(folder, "app");
      await write(app, {
        "index.html": `<!doctype html><html><head><link rel="preload" href="./page.wasm" as="fetch" crossorigin></head><body><script type="module" src="./main.js"></script></body></html>`,
        "main.js": `import { called } from "./called.js"; import { uncalled } from "./uncalled.js"; document.title = called();`,
        "called.js": `export const called = () => new URL("./called.wasm", import.meta.url).href;`,
        "uncalled.js": `export const uncalled = () => new URL("./uncalled.wasm", import.meta.url).href;`,
        "called.wasm": "called",
        "page.wasm": "page",
        "uncalled.wasm": "uncalled",
      });
      await build({
        root: app,
        logLevel: "silent",
        configFile: false,
        build: { assetsInlineLimit: 0 },
        plugins: [cascadeRuntime({ from: installed, browser: false })],
      });
      written = (await readdir(join(app, "dist", "assets"))).filter((name) =>
        name.endsWith(".wasm"),
      );
    });

    after(async () => {
      await rm(folder, { recursive: true, force: true, maxRetries: 5 });
    });

    it("writes the `.wasm` files a chunk or the page names and not the one nothing names", () => {
      assert.deepEqual(
        written.map((name) => name.replace(/-[\w-]+\.wasm$/, ".wasm")),
        ["called.wasm", "page.wasm"],
      );
    });
  });
});
