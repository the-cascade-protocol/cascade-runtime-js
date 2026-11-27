// Every way a page can resolve the packed package gives it one runtime: `npm run build:package`, then
// `npm run test:pod-browser`.
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
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build as esbuild } from "esbuild";
import { chromium, type Browser } from "playwright";
import { build, createServer, type Plugin } from "vite";
import { PACKAGE } from "./serving.js";

const ORIGIN = "http://page.test";
/** Where the page's `configureRuntime` names the runtime's files, and the samples it names. */
const RUNTIME_AT = "runtime-files/";
const SAMPLES_AT = "samples/";

/**
 * A page of an app that runs pods in the page: `configureRuntime` from the package's root, `browserHost` and `podApi` from
 * `cascade-runtime/app`. It reports whether a `Refusal` and an `Unopened` PodApi throws are the root's classes, and sends
 * a sample's copy to the engine, which reads its components where `configureRuntime` said.
 */
const PODS_PAGE = `
import { configureRuntime, Refusal as RootRefusal, Unopened as RootUnopened } from "cascade-runtime";
import { browserHost, podApi } from "cascade-runtime/app";
configureRuntime({ base: new URL(${JSON.stringify(RUNTIME_AT)}, location.href).href });
const locked = {
  pods: {
    names: async () => ["x"],
    title: async () => undefined,
    checkSecret: async () => false,
    remove: async () => undefined,
    open: async () => { throw new RootUnopened("secret needed", "The pod is encrypted."); },
  },
  samples: [],
  tables: async () => { throw new Error("no tables"); },
  checkTables: async () => [],
  unsaid: () => undefined,
  opensEncrypted: true,
};
(async () => {
  const refused = await podApi(browserHost()).pod({ pod: "nobody" }).catch((error) => error);
  const unopened = await podApi(locked).unlock({ pod: "x", secret: "" }).catch((error) => error);
  await podApi(browserHost({ samples: { names: ["s"], at: new URL(${JSON.stringify(SAMPLES_AT)}, location.href).href } }))
    .makePod({ person: "s" }).catch(() => undefined);
  window.result = {
    refusal: refused instanceof RootRefusal,
    unopened: unopened instanceof RootUnopened && unopened.outcome === "incorrect secret",
  };
})();
`;

/** The definitions of a class or a function that a bundle holds, whatever it was renamed to where two collide. */
const definitions = (code: string, name: string) =>
  [
    ...code.matchAll(
      new RegExp(`\\b(?:class|function|var|let|const) ${name}\\d*\\b`, "g"),
    ),
  ].length;

/** The folder every case's page is built in: the packed package installed beside it, as an app installs it. */
async function appFolder(main: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "one-runtime-"));
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
  await writeFile(join(folder, "main.js"), main);
  return folder;
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};

/** Every file under the folder, by its path from it. */
async function filesUnder(folder: string, at = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(folder, at), {
    withFileTypes: true,
  }))
    if (entry.isDirectory())
      found.push(...(await filesUnder(folder, join(at, entry.name))));
    else found.push(join(at, entry.name).replaceAll("\\", "/"));
  return found;
}

/** What the page reports, and every URL it asked for, when it is opened from the folder a build wrote. */
async function opened(
  browser: Browser,
  built: string,
): Promise<{ result: Record<string, boolean>; requested: string[] }> {
  const page = await browser.newPage();
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    const asked = (await filesUnder(built)).includes(file);
    if (!asked) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: TYPES[extname(file)] ?? "application/octet-stream",
      body: await readFile(join(built, file)),
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(
    () => (window as unknown as { result?: unknown }).result !== undefined,
    null,
    { timeout: 30_000 },
  );
  const result = (await page.evaluate(
    () => (window as unknown as { result: Record<string, boolean> }).result,
  )) as Record<string, boolean>;
  await page.close();
  return { result, requested };
}

/**
 * A page that runs pods, bundled from the packed package by a bundler with no plugin of the package's: the root's
 * `configureRuntime` and `cascade-runtime/app`'s `podApi` reach one copy of the runtime, so the base the page configured is
 * where its engine reads, and a `Refusal` or an `Unopened` PodApi throws is the root's class.
 */
describe("A page bundled with the package, with the plugin or without it Â· cascade-runtime, cascade-runtime/app, cascadeRuntime()", () => {
  let browser: Browser;
  let folders: string[];

  before(async () => {
    assert.ok(
      existsSync(join(PACKAGE, "dist", "browser", "index.js")),
      `${PACKAGE} holds no packed browser build: run npm run build:package`,
    );
    folders = [];
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const folder of folders)
      await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  });

  async function app(main: string): Promise<string> {
    const folder = await appFolder(main);
    folders.push(folder);
    return folder;
  }

  for (const tool of ["esbuild", "Vite"] as const)
    describe(`given a page that runs pods, bundled by ${tool} with no plugin`, () => {
      let code: string;
      let page: Awaited<ReturnType<typeof opened>>;

      before(async () => {
        const folder = await app(PODS_PAGE);
        const out = join(folder, "out");
        if (tool === "esbuild")
          await esbuild({
            entryPoints: [join(folder, "main.js")],
            absWorkingDir: folder,
            bundle: true,
            platform: "browser",
            format: "esm",
            outdir: out,
            logLevel: "silent",
            loader: { ".wasm": "file" },
            external: ["*.wasm"],
          });
        else
          await build({
            root: folder,
            logLevel: "silent",
            configFile: false,
            build: { outDir: out, emptyOutDir: true, minify: false },
          });
        code = (
          await Promise.all(
            (await filesUnder(out))
              .filter((file) => file.endsWith(".js"))
              .map((file) => readFile(join(out, file), "utf8")),
          )
        ).join("\n");
        if (tool === "esbuild")
          await writeFile(
            join(out, "index.html"),
            `<!doctype html><script type="module" src="./main.js"></script>`,
          );
        page = await opened(browser, out);
      });

      it("holds one `configureRuntime`, one `Refusal` and one `browserBuildVersion`", () => {
        assert.deepEqual(
          [
            definitions(code, "configureRuntime"),
            definitions(code, "Refusal"),
            definitions(code, "browserBuildVersion"),
          ],
          [1, 1, 1],
        );
      });

      it("has its engine read the components under the base the page configured, and no others", () => {
        const components = page.requested.filter((url) =>
          url.includes("/components/"),
        );
        assert.ok(
          components.some((url) =>
            url.startsWith(`${ORIGIN}/${RUNTIME_AT}components/`),
          ),
          `no component was read under ${RUNTIME_AT}: ${components.join(", ")}`,
        );
        assert.deepEqual(
          components.filter(
            (url) => !url.startsWith(`${ORIGIN}/${RUNTIME_AT}components/`),
          ),
          [],
        );
      });

      it("throws, from PodApi, the `Refusal` and the `Unopened` the root exports", () => {
        assert.deepEqual(page.result, { refusal: true, unopened: true });
      });
    });

  describe("given a page that runs pods, built by Vite with `cascadeRuntime()`", () => {
    let code: string;
    let html: string;

    before(async () => {
      const folder = await app(PODS_PAGE);
      const { cascadeRuntime } = (await import(
        pathToFileURL(join(PACKAGE, "dist", "src", "node", "vite.js")).href
      )) as { cascadeRuntime(): Plugin };
      const built = await build({
        root: folder,
        logLevel: "silent",
        configFile: false,
        plugins: [cascadeRuntime()],
        build: { write: false },
      });
      const output = (Array.isArray(built) ? built : [built]).flatMap((each) =>
        "output" in each ? each.output : [],
      );
      code = output
        .flatMap((each) => (each.type === "chunk" ? [each.code] : []))
        .join("\n");
      const page = output.find(({ fileName }) => fileName === "index.html");
      html = String(page?.type === "asset" ? page.source : "");
    });

    it("bundles none of the runtime, and loads both entries from the one folder its import map names", () => {
      assert.deepEqual(
        [definitions(code, "configureRuntime"), definitions(code, "Refusal")],
        [0, 0],
      );
      const map = JSON.parse(
        /<script type="importmap">([^<]*)<\/script>/.exec(html)?.[1] ?? "{}",
      ) as { imports: Record<string, string> };
      assert.deepEqual(map.imports, {
        "cascade-runtime": "/cascade-runtime/index.js",
        "cascade-runtime/app": "/cascade-runtime/app.js",
      });
    });
  });

  for (const browserBuild of [true, false] as const)
    describe(`given the plugin's development server with browser: ${browserBuild}, for a page that imports ${browserBuild ? "both entries" : "`cascade-runtime/app` alone"}`, () => {
      let served: Map<string, string>;

      before(async () => {
        const folder = await app(
          browserBuild
            ? `import { Refusal as RootRefusal } from "cascade-runtime";\nimport { Refusal as AppRefusal, remoteApi } from "cascade-runtime/app";\nwindow.result = [RootRefusal, AppRefusal, remoteApi];`
            : `import { Refusal, remoteApi } from "cascade-runtime/app";\nwindow.result = [Refusal, remoteApi];`,
        );
        const { cascadeRuntime } = (await import(
          pathToFileURL(join(PACKAGE, "dist", "src", "node", "vite.js")).href
        )) as { cascadeRuntime(options: { browser: boolean }): Plugin };
        const server = await createServer({
          root: folder,
          configFile: false,
          logLevel: "silent",
          cacheDir: join(folder, ".vite"),
          plugins: [cascadeRuntime({ browser: browserBuild })],
          optimizeDeps: { include: ["cascade-runtime", "cascade-runtime/app"] },
          server: { port: 0, host: "127.0.0.1", fs: { strict: false } },
        });
        await server.listen();
        served = new Map();
        try {
          const base = server.resolvedUrls?.local[0] ?? "";
          const queue = ["main.js"];
          while (queue.length > 0) {
            const path = queue.shift()!;
            if (served.has(path)) continue;
            const text = await (await fetch(new URL(path, base))).text();
            served.set(path, text);
            for (const [, next] of text.matchAll(
              /(?:from|import)\s*["'](\/[^"']+)["']/g,
            ))
              queue.push(next!.slice(1));
          }
        } finally {
          await server.close();
        }
      });

      it("serves the runtime's `Refusal` from one file", () => {
        const holding = [...served].filter(
          ([, text]) => definitions(text, "Refusal") > 0,
        );
        assert.equal(
          holding.length,
          1,
          `held by ${holding.map(([path]) => path).join(", ") || "none"}`,
        );
      });
    });
});
