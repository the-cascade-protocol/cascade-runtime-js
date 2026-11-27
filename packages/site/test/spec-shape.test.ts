import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const FOLDER = "packages/cascade-runtime";
const CLI = fileURLToPath(
  new URL("../../../../scripts/spec-shape.mjs", import.meta.url),
);

/** A case as node:test's JUnit report writes it: nested `testsuite`s are its describes, `file` its compiled test file. */
function xml(
  cases: readonly (readonly [file: string, ...titles: string[]])[],
): string {
  const body = cases
    .map(([file, ...titles]) => {
      const name = titles.at(-1) ?? "";
      const compiled = `/home/runner/work/x/x/${FOLDER}/dist/test/${file.replace(/\.ts$/, ".js")}`;
      const open = titles
        .slice(0, -1)
        .map((title) => `<testsuite name="${title}">`)
        .join("");
      const close = "</testsuite>".repeat(titles.length - 1);
      return `${open}<testcase name="${name}" time="0.001" classname="test" file="${compiled}"/>${close}`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?><testsuites>${body}</testsuites>`;
}

/**
 * `node scripts/spec-shape.mjs <junit>... <spec.json>` runs in the CI of every repository that publishes a tests page. Its
 * exit status says whether the page can be made of the reports: it never judges how a test is named, and fails only on a
 * report or a spec it cannot read.
 */
describe("Checking that a package's reports can be read for the tests page · scripts/spec-shape.mjs", () => {
  let folder: string;

  before(() => {
    folder = mkdtempSync(join(tmpdir(), "spec-shape-"));
  });

  after(() => {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  });

  /** The command over a report of `cases` and a `spec.json` of `spec` in the package's own folder. */
  const run = (cases: Parameters<typeof xml>[0], spec: unknown) => {
    const junit = join(folder, "junit.xml");
    const specFile = join(folder, FOLDER, "test", "spec.json");
    mkdirSync(dirname(specFile), { recursive: true });
    writeFileSync(junit, xml(cases));
    writeFileSync(specFile, JSON.stringify(spec));
    return spawnSync(process.execPath, [CLI, junit, specFile], {
      encoding: "utf8",
    });
  };

  describe("with names the page once refused", () => {
    it("exits 0, saying how many cases it read", () => {
      const done = run(
        [
          [
            "sample.test.ts",
            "Opening a pod · openPod()",
            "under Node's permission model",
            "returns rows",
          ],
          ["sample.test.ts", "Opening a pod · openPod()", "the widget"],
          [
            "sample.test.ts",
            "A group no list names",
            "openPod()",
            "should work",
          ],
          ["sample.test.ts", "returns rows"],
        ],
        { capabilities: ["Opening a pod · openPod()"] },
      );
      assert.equal(done.status, 0, done.stdout);
      assert.match(done.stdout, /4 cases read from 1 report/);
    });
  });

  describe("with the suite run in two parts, a report of each", () => {
    it("exits 0, counting the cases of both", () => {
      const specFile = join(folder, FOLDER, "test", "spec.json");
      mkdirSync(dirname(specFile), { recursive: true });
      writeFileSync(specFile, JSON.stringify({}));
      const junits = [["sample.test.ts"], ["other.test.ts"]].map(
        ([file = ""], at) => {
          const junit = join(folder, `part-${at}.xml`);
          writeFileSync(junit, xml([[file, "A", "returns rows"]]));
          return junit;
        },
      );
      const done = spawnSync(process.execPath, [CLI, ...junits, specFile], {
        encoding: "utf8",
      });
      assert.equal(done.status, 0, done.stdout);
      assert.match(done.stdout, /2 cases read from 2 reports/);
    });
  });

  describe("with a report that is not JUnit", () => {
    it("exits 2", () => {
      const junit = join(folder, "not-junit.xml");
      writeFileSync(junit, "<html></html>");
      const spec = join(folder, "spec.json");
      writeFileSync(spec, JSON.stringify({}));
      const done = spawnSync(process.execPath, [CLI, junit, spec], {
        encoding: "utf8",
      });
      assert.equal(done.status, 2);
    });
  });

  describe("with a spec that is not JSON", () => {
    it("exits 2", () => {
      const junit = join(folder, "report.xml");
      writeFileSync(junit, xml([["sample.test.ts", "A", "returns rows"]]));
      const spec = join(folder, "broken.json");
      writeFileSync(spec, '{"about": ');
      const done = spawnSync(process.execPath, [CLI, junit, spec], {
        encoding: "utf8",
      });
      assert.equal(done.status, 2);
    });
  });

  describe("with a missing argument", () => {
    it("exits 2", () => {
      const junit = join(folder, "report.xml");
      writeFileSync(junit, xml([]));
      for (const args of [[junit], []]) {
        const done = spawnSync(process.execPath, [CLI, ...args], {
          encoding: "utf8",
        });
        assert.equal(done.status, 2, args.join(" "));
      }
    });
  });
});
