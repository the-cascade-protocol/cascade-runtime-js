import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { before, describe, it } from "node:test";
import { promisify } from "node:util";
import { join } from "node:path";
import { OxigraphStore } from "../src/oxigraph-store.js";
import { openDatabase } from "../src/node/sqlite.js";
import { type SqlCheckOptions, sqlNamedAssertions } from "../src/sql-check.js";
import { layout, ROOT, vocabulary } from "./vocabulary.js";

const CLI = join(ROOT, "packages", "runtime", "dist", "src", "node", "cli.js");
const ALLERGIES = "queries/views/allergies";
const KINDS = "queries/questions/pod/How many of each kind";

async function options(): Promise<SqlCheckOptions> {
  return {
    vocabulary: await vocabulary(),
    newStore: () => new OxigraphStore(),
    layout: await layout(),
    open: (functions) => openDatabase(":memory:", { functions }),
  };
}

/** What a run of the conformance command with `args` ends with: its exit code and what it says on stderr. */
async function run(
  ...args: string[]
): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await promisify(execFile)(process.execPath, [
      CLI,
      "conformance",
      ...args,
    ]);
    return { code: 0, stderr };
  } catch (error) {
    const { code, stderr } = error as { code: number; stderr: string };
    return { code, stderr };
  }
}

const passed = (assertions: { name: string; outcome: string }[]): string[] =>
  assertions.map(({ name, outcome }) => `${outcome}: ${name}`);

/**
 * An author who changes one `.sql` checks it against its `.rq` over the fixtures that compare it, on the runtime's own
 * loader, without running the whole conformance command. A fixture's name, as the vocabulary names it, or a query's
 * `.sql` or `.rq` path, selects the comparisons it takes part in, and the names given together narrow each other. A name
 * that selects no comparison is refused by name, never passed over.
 */
describe("Checking one SQL comparison alone · npm run conformance -- --sql-only <fixture or query>", () => {
  it("compares the named fixture's `.sql` files under each lens and nothing else, and the named `.sql` over each fixture that compares it", async () => {
    const found = await sqlNamedAssertions(await options(), ["allergies-view"]);
    assert.deepEqual(passed(found), [
      "passed: queries/questions/entry/What it shows.sql over allergies-view under everyday",
      "passed: queries/questions/entry/Where it came from.sql over allergies-view under everyday",
      "passed: queries/questions/pod/My active allergies.sql over allergies-view under everyday",
      `passed: ${ALLERGIES}.sql over allergies-view under everyday`,
      `passed: ${ALLERGIES}.sql over allergies-view under export`,
    ]);
    const byQuery = await sqlNamedAssertions(await options(), [`${KINDS}.rq`]);
    assert.ok(byQuery.length >= 2, "no fixture compares the query");
    for (const { name, outcome, why } of byQuery) {
      assert.match(name, new RegExp(`^${KINDS}\\.sql over `));
      assert.equal(outcome, "passed", why);
    }
    assert.deepEqual(
      passed(
        await sqlNamedAssertions(await options(), [
          "allergies-view",
          `${ALLERGIES}.sql`,
        ]),
      ),
      passed(found).filter((line) => line.includes(ALLERGIES)),
    );
  });

  it("refuses, naming each, a name that is no fixture or `.sql`, a fixture that chooses no comparison, and a pair where the fixture does not compare the query", async () => {
    const refusal = async (...names: string[]): Promise<string> => {
      try {
        await sqlNamedAssertions(await options(), names);
      } catch (error) {
        return String(error);
      }
      return "";
    };
    assert.match(await refusal("no-such-fixture"), /no-such-fixture/);
    assert.match(
      await refusal("queries/views/no-such-query.sql"),
      /queries\/views\/no-such-query\.sql/,
    );
    assert.match(
      await refusal("a-before-outranks-the-clocks"),
      /a-before-outranks-the-clocks.*chooses no comparison/,
    );
    assert.match(
      await refusal("allergies-view", `${KINDS}.sql`),
      /allergies-view.*chooses no comparison of/,
    );
    const both = await refusal("one-missing", "another-missing");
    assert.match(both, /one-missing/);
    assert.match(both, /another-missing/);
  });

  describe("given the command", () => {
    let one: Awaited<ReturnType<typeof run>>;
    let missing: Awaited<ReturnType<typeof run>>;
    let sharded: Awaited<ReturnType<typeof run>>;

    before(async () => {
      [one, missing, sharded] = await Promise.all([
        run("--sql-only", "allergies-view"),
        run("--sql-only", "no-such-fixture"),
        run("--sql-only", "allergies-view", "--sql", "0/2"),
      ]);
    });

    it("runs the comparisons the name selects and says each, with no feature file, SQL function or other comparison", () => {
      assert.equal(one.code, 0, one.stderr);
      assert.deepEqual(
        one.stderr
          .split("\n")
          .filter((line) => /^(passed|failed|inapplicable): /.test(line))
          .map((line) => line.replace(/^passed: .*\.sql over /, "")),
        [
          "allergies-view under everyday",
          "allergies-view under everyday",
          "allergies-view under everyday",
          "allergies-view under everyday",
          "allergies-view under export",
        ],
      );
      assert.match(one.stderr, /^5 tests: 5 passed, 0 failed, 0 inapplicable/m);
    });

    it("exits non-zero, naming a fixture that matches none", () => {
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /no-such-fixture/);
    });

    it("refuses to be given with `--sql`, whose share of the fixtures it would contradict, and says so", () => {
      assert.notEqual(sharded.code, 0);
      assert.match(sharded.stderr, /--sql-only.*--sql|--sql.*--sql-only/);
    });
  });
});
