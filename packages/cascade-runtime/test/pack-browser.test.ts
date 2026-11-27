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
import { bundlePages } from "../pack/browser.js";

/** The files `file` imports, statically or by an `import()` its text keeps, read from the emitted code. */
const importsOf = (text: string): { files: string[]; lazy: string[] } => ({
  files: [...text.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)].map(
    (match) => match[1]!,
  ),
  lazy: [...text.matchAll(/import\("\.\/([^"]+\.js)"\)/g)].map(
    (match) => match[1]!,
  ),
});

/**
 * The browser build's page entries: what a page loads with each of them at once, and that nothing else is written into
 * the package.
 */
describe("The browser build's entries and their chunks · bundlePages()", () => {
  describe("given two entries that share a module, one lazy import, and a dynamic import in a module the entries tree-shake", () => {
    let folder: string;
    let out: string;
    let closures: Record<string, string[]>;

    before(async () => {
      folder = await mkdtemp(join(tmpdir(), "pack-browser-"));
      const src = join(folder, "src");
      await mkdir(src, { recursive: true });
      const files: Record<string, string> = {
        "index.js": `export * from "./shared.js"; export { used } from "./tree.js"; export const lazy = () => import("./lazy.js");`,
        "app.js": `export { shared } from "./shared.js"; export const app = "app";`,
        "shared.js": `export const shared = "x".repeat(200) + Date.now();`,
        "lazy.js": `export const later = "later" + Date.now();`,
        "tree.js": `export const used = 1; export function unused() { return import("./cucumber.js"); }`,
        "cucumber.js": `export const gherkin = "gherkin" + Date.now();`,
      };
      for (const [name, text] of Object.entries(files))
        await writeFile(join(src, name), text);
      out = join(folder, "out");
      closures = await bundlePages(out, {
        index: join(src, "index.js"),
        app: join(src, "app.js"),
      });
    });

    after(async () => {
      await rm(folder, { recursive: true, force: true, maxRetries: 5 });
    });

    it("gives each entry's file and the chunks it imports statically, and no lazy chunk", async () => {
      for (const entry of ["index", "app"]) {
        const files = closures[entry] ?? [];
        assert.ok(files.includes(`${entry}.js`), `${entry}.js is its own`);
        assert.ok(
          files.some((file) => file.startsWith("chunk-")),
          `${entry} imports the shared chunk`,
        );
        for (const file of files) {
          const { lazy } = importsOf(await readFile(join(out, file), "utf8"));
          assert.ok(
            lazy.every((name) => !files.includes(name)),
            `${file} lazily imports a file the closure holds`,
          );
        }
      }
      const lazy = importsOf(
        await readFile(join(out, "index.js"), "utf8"),
      ).lazy;
      assert.equal(lazy.length, 1);
      assert.ok(!closures["index"]?.includes(lazy[0]!));
    });

    it("writes only files an entry reaches, statically or by an import() an emitted file keeps", async () => {
      const reached = new Set<string>();
      const visit = async (file: string): Promise<void> => {
        if (reached.has(file)) return;
        reached.add(file);
        const { files, lazy } = importsOf(
          await readFile(join(out, file), "utf8"),
        );
        for (const next of [...files, ...lazy]) await visit(next);
      };
      await visit("index.js");
      await visit("app.js");
      assert.deepEqual(
        (await readdir(out)).toSorted(),
        [...reached].toSorted(),
        "every file under the output is reachable from an entry",
      );
    });
  });
});
