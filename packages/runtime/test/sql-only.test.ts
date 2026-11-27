import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { before, describe, it } from "node:test";
import { promisify } from "node:util";
import { join } from "node:path";
import { readText } from "../src/files.js";
import { OxigraphStore } from "../src/oxigraph-store.js";
import { sqlOnly } from "../src/node/sql-run.js";
import {
  type SqlCheckOptions,
  sqlComparisons,
  sqlNamedAssertions,
} from "../src/sql-check.js";
import { layout, overlaid, ROOT, vocabulary } from "./vocabulary.js";
import { openDatabase } from "../src/node/sqlite.js";

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

/** Each comparison the fixtures' manifests choose, as the assertion that makes it is named, by fixture and by `.rq`. */
async function chosen(): Promise<
  { fixture: string; rq: string; name: string }[]
> {
  return [
    ...(
      await sqlComparisons(await vocabulary(), () => new OxigraphStore())
    ).entries(),
  ].flatMap(([fixture, queries]) =>
    [...queries].flatMap(([rq, lenses]) =>
      lenses.map((lens) => ({
        fixture,
        rq,
        name: `${rq.slice(0, -3)}.sql over ${fixture} under ${lens}`,
      })),
    ),
  );
}

const named = (assertions: readonly { name: string }[]): string[] =>
  assertions.map(({ name }) => name).sort();

/**
 * An author who changes one `.sql` checks it against its `.rq` over the fixtures that compare it, on the runtime's own
 * loader, without running the whole conformance command. A fixture's name, as the vocabulary names it, or a query's
 * `.sql` or `.rq` path, selects the comparisons it takes part in, and the names given together narrow each other. A name
 * that selects no comparison is refused by name, never passed over; a comparison that fails exits 1, saying why.
 */
describe("Checking one SQL comparison alone · npm run conformance -- --sql-only <fixture or query>", () => {
  it("compares the named fixture's `.sql` files under each lens and nothing else, and the named `.sql` over each fixture that compares it", async () => {
    const all = await chosen();
    const found = await sqlNamedAssertions(await options(), ["allergies-view"]);
    assert.ok(found.length > 0, "the fixture is compared on nothing");
    for (const { name, outcome, why } of found)
      assert.equal(outcome, "passed", `${name}: ${why}`);
    assert.deepEqual(
      named(found),
      named(all.filter(({ fixture }) => fixture === "allergies-view")),
    );
    const byQuery = await sqlNamedAssertions(await options(), [`${KINDS}.rq`]);
    assert.ok(byQuery.length >= 2, "no fixture compares the query");
    for (const { name, outcome, why } of byQuery)
      assert.equal(outcome, "passed", `${name}: ${why}`);
    assert.deepEqual(
      named(byQuery),
      named(all.filter(({ rq }) => `${rq.slice(0, -3)}` === KINDS)),
    );
    const both = await sqlNamedAssertions(await options(), [
      "allergies-view",
      `${ALLERGIES}.sql`,
    ]);
    assert.ok(both.length > 0, "the fixture does not compare the view");
    assert.deepEqual(
      named(both),
      named(
        all.filter(
          ({ fixture, rq }) =>
            fixture === "allergies-view" && rq === `${ALLERGIES}.rq`,
        ),
      ),
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

  it("fails a comparison whose `.sql` is wrong, with its reason, and exits 1, where the vocabulary as it is exits 0", async () => {
    const real = await vocabulary();
    const view = await readText(real, `${ALLERGIES}.sql`);
    const none = replacedTriples(view);
    const failed = await sqlNamedAssertions(
      await options(),
      ["allergies-view"],
      { [`${ALLERGIES}.rq`]: none },
    );
    const mine = failed.filter(({ name }) =>
      name.startsWith(`${ALLERGIES}.sql `),
    );
    assert.ok(mine.length > 0);
    for (const { name, outcome, why } of mine) {
      assert.equal(outcome, "failed", name);
      assert.match(why ?? "", /missing: \?s=/, name);
    }
    const said: string[] = [];
    const broken = overlaid(real, { [`${ALLERGIES}.sql`]: none });
    assert.equal(
      await sqlOnly(broken, ["allergies-view"], (line) => said.push(line)),
      1,
    );
    assert.ok(
      said.some((line) =>
        line.startsWith(`failed: ${ALLERGIES}.sql over allergies-view under `),
      ),
      said.join("\n"),
    );
    assert.ok(said.some((line) => line.includes("missing: ?s=")));
    assert.match(said.at(-1) ?? "", /, [1-9]\d* failed, 0 inapplicable/);
    const clean: string[] = [];
    assert.equal(
      await sqlOnly(real, ["allergies-view"], (line) => clean.push(line)),
      0,
    );
    assert.match(clean.at(-1) ?? "", / 0 failed, 0 inapplicable/);
  });

  describe("given the command", () => {
    let one: Awaited<ReturnType<typeof run>>;
    let missing: Awaited<ReturnType<typeof run>>;
    let sharded: Awaited<ReturnType<typeof run>>;
    let folder: Awaited<ReturnType<typeof run>>;

    before(async () => {
      [one, missing, sharded, folder] = await Promise.all([
        run("--sql-only", "allergies-view"),
        run("--sql-only", "no-such-fixture"),
        run("--sql-only", "allergies-view", "--sql", "0/2"),
        run("--sql-only", "allergies-view", "--folder", "cascade-vocabulary=."),
      ]);
    });

    it("runs the comparisons the name selects and says each, with no feature file, SQL function or other comparison", async () => {
      assert.equal(one.code, 0, one.stderr);
      const lines = one.stderr
        .split("\n")
        .filter((line) => /^(passed|failed|inapplicable): /.test(line));
      assert.ok(lines.length > 0, one.stderr);
      for (const line of lines)
        assert.match(line, /^passed: .* over allergies-view under /);
      const total = new RegExp(
        `^${lines.length} tests: ${lines.length} passed, 0 failed, 0 inapplicable`,
        "m",
      );
      assert.match(one.stderr, total);
    });

    it("exits non-zero, naming a fixture that matches none", () => {
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /no-such-fixture/);
    });

    it("refuses to be given with `--sql`, whose share of the fixtures it would contradict, and says so", () => {
      assert.notEqual(sharded.code, 0);
      assert.match(sharded.stderr, /--sql-only.*--sql|--sql.*--sql-only/);
    });

    it("refuses to be given with `--folder`, which is read only where no sibling checkout is, and says so", () => {
      assert.notEqual(folder.code, 0);
      assert.match(folder.stderr, /--sql-only.*--folder/);
    });
  });
});

/** The view's `.sql` with its triples part giving none, so that each triple its `.rq` gives is missing. */
function replacedTriples(text: string): string {
  const found = text.replace(
    /^-- part: triples[\s\S]*$/m,
    "-- part: triples\nSELECT NULL AS s, NULL AS p, NULL AS o WHERE 0\n",
  );
  assert.notEqual(found, text);
  return found;
}
