import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** The script, as the compiled test reaches it: this file is in packages/site/dist/test. */
const SCRIPT = new URL("../../../../scripts/test-files.mjs", import.meta.url);
const { compiledTests, suiteOptions } = (await import(SCRIPT.href)) as {
  compiledTests: (group?: "listed" | "unlisted") => string[];
  suiteOptions: (
    given?: string[],
    env?: Record<string, string>,
    processors?: number,
  ) => string[];
};

const files = (group?: "listed" | "unlisted"): string[] =>
  compiledTests(group).map((path) => path.split("\\").join("/"));

/**
 * `scripts/test-files.mjs` names the compiled test files `scripts/test.mjs` runs. CI runs the files each package's
 * `test/spec.json` lists as `randomOrder` in a random order and the rest as written, so the suite is run once, whole.
 */
describe("Choosing the files a suite runs · scripts/test-files.mjs", () => {
  describe("with the suite in two parts, listed and unlisted", () => {
    it("names every file once between them", () => {
      const all = files();
      const parts = [...files("listed"), ...files("unlisted")];
      assert.ok(all.length > 100, `${all.length} files`);
      assert.deepEqual([...parts].sort(), [...all].sort());
      assert.equal(new Set(parts).size, parts.length);
    });

    it("names a file its package lists as randomOrder in the listed part only", () => {
      const { randomOrder } = JSON.parse(
        readFileSync("packages/site/test/spec.json", "utf8"),
      ) as { randomOrder: string[] };
      const [first = ""] = randomOrder;
      const compiled = `packages/site/dist/test/${first.replace(/\.ts$/, ".js")}`;
      assert.ok(files("listed").includes(compiled), compiled);
      assert.ok(!files("unlisted").includes(compiled), compiled);
    });
  });
});

const count = (options: string[], flag: string): string | undefined =>
  options
    .find((option) => option.startsWith(`${flag}=`))
    ?.slice(flag.length + 1);

/**
 * `scripts/test.mjs` passes `node --test` the options `suiteOptions()` names, so that a suite on a laptop runs few files at
 * once, a test that hangs fails by name, and `npm test` is the unit suite: the case that runs the whole conformance command
 * is skipped unless a report is named, which `conformance (native)` writes and asserts on in every CI run.
 */
describe("Setting how a suite runs · scripts/test-files.mjs", () => {
  describe("given a machine with some number of processors", () => {
    it("runs at most 3 files at once, and one fewer than the processors when that is less", () => {
      const caps = [1, 2, 4, 8, 64].map((processors) =>
        count(suiteOptions([], {}, processors), "--test-concurrency"),
      );
      assert.deepEqual(caps, ["1", "1", "3", "3", "3"]);
    });

    it("lets CASCADE_TEST_CONCURRENCY and CASCADE_TEST_TIMEOUT change the cap and the timeout of a test", () => {
      const env = {
        CASCADE_TEST_CONCURRENCY: "6",
        CASCADE_TEST_TIMEOUT: "1000",
      };
      const options = suiteOptions([], env, 8);
      assert.equal(count(options, "--test-concurrency"), "6");
      assert.equal(count(options, "--test-timeout"), "1000");
    });

    it("fails a test that runs longer than 180 seconds, with nothing set", () => {
      assert.equal(count(suiteOptions([], {}, 8), "--test-timeout"), "180000");
    });

    it("refuses a variable that is not a whole number above 0", () => {
      for (const bad of ["0", "-1", "2.5", "many"])
        assert.throws(
          () => suiteOptions([], { CASCADE_TEST_TIMEOUT: bad }, 8),
          /CASCADE_TEST_TIMEOUT/,
          bad,
        );
    });

    it("leaves out an option the caller names itself", () => {
      const options = suiteOptions(["--test-concurrency=2"], {}, 8);
      assert.equal(count(options, "--test-concurrency"), undefined);
      assert.equal(count(options, "--test-timeout"), "180000");
    });
  });

  describe("given a conformance report, or none", () => {
    const skips = (env: Record<string, string>): string[] =>
      suiteOptions([], env, 8)
        .filter((option) => option.startsWith("--test-skip-pattern="))
        .map((option) => option.slice("--test-skip-pattern=".length));

    it("skips the case that runs the conformance command when no report is named", () => {
      assert.deepEqual(skips({}), ["Reporting a conformance run"]);
    });

    it("runs that case against the report CASCADE_CONFORMANCE_REPORT names", () => {
      assert.deepEqual(skips({ CASCADE_CONFORMANCE_REPORT: "earl.nt" }), []);
    });

    it("skips a heading that conformance.test.ts still has", () => {
      const source = readFileSync(
        "packages/runtime/test/conformance.test.ts",
        "utf8",
      );
      const [pattern = ""] = skips({});
      assert.ok(source.includes(`describe("${pattern} ·`), pattern);
    });
  });
});
