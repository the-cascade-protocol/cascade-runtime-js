import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Files, readText } from "../src/files.js";
import { openDatabase } from "../src/node/sqlite.js";
import { OxigraphStore } from "../src/oxigraph-store.js";
import { literal, written } from "../src/rdf.js";
import {
  type BuiltFixture,
  fixtureBuilt,
  sqlCheckAssertions,
  sqlCheckContext,
  type SqlCheckOptions,
  sqlFailures,
  sqlFunctionAssertions,
  unchosenSqlAssertions,
} from "../src/sql-check.js";
import {
  sqlStaticAssertions,
  sqlWholeRunAssertions,
} from "../src/sql-static-check.js";
import {
  instantKey,
  LITERAL,
  loadStatements,
  sparqlLcase,
  SqlFunctionRefused,
  sqlDatabaseFunctions,
  SQL_FUNCTION_VECTORS,
  STATEMENTS_SCHEMA,
} from "../src/statements.js";
import { Union } from "../src/store.js";
import { layout, overlaid, vocabulary } from "./vocabulary.js";

const XSD = "http://www.w3.org/2001/XMLSchema#";
const WHAT_IT_SHOWS = "queries/questions/entry/What it shows.rq";
const ALLERGIES = "queries/views/allergies.sql";
const CONDITIONS = "queries/views/conditions.sql";

async function optionsOver(files: Files): Promise<SqlCheckOptions> {
  return {
    vocabulary: files,
    newStore: () => new OxigraphStore(),
    layout: await layout(),
    open: (functions) => openDatabase(":memory:", { functions }),
  };
}

/** The text with `from` put right for `to`; that it was in the text is asserted, so a mutation never silently misses. */
function replaced(text: string, from: string | RegExp, to: string): string {
  const found = text.replace(from, to);
  assert.notEqual(found, text, `${String(from)} is not in the text`);
  return found;
}

const outcomes = (
  found: readonly { name: string; outcome: string }[],
): string[] => found.map(({ name, outcome }) => `${outcome}: ${name}`);

/** A fixture of one small pod in the vocabulary's schema, its statements the Turtle given, for a `.sql` over it to be asked of. */
async function podOf(
  turtle: string,
  more = "",
): Promise<{ built: BuiltFixture; close: () => void }> {
  const db = openDatabase(":memory:", {
    functions: await sqlDatabaseFunctions(),
  });
  loadStatements(
    db,
    await readText(await vocabulary(), STATEMENTS_SCHEMA),
    [],
    "test",
  );
  if (more !== "") db.exec(more);
  const store = new OxigraphStore();
  const union = new Union(store);
  await union.loadTurtle(turtle, "urn:x:g");
  return {
    built: {
      name: "f",
      lens: "everyday",
      union,
      db,
      entries: [],
      screens: new Map(),
      screensFilled: false,
      refill: () => [],
      close: () => undefined,
    },
    close: () => {
      db.close();
      store.free?.();
    },
  };
}

/**
 * The checks the vocabulary's own tests once made of the SQL beside its queries, made by the runtime's comparison: each
 * is shown by a `.sql` or a file of the vocabulary made wrong, over the fixtures that compare it, which the check
 * refuses and the vocabulary as it is does not.
 */
describe("Checking the vocabulary's SQL against its queries · sqlFailures(), sqlStaticAssertions(), sqlWholeRunAssertions(), sqlFunctionAssertions()", () => {
  it("fails a .sql that leaves an object in the database, however its statement is spelled, and none for the tables SQLite makes of itself", async () => {
    const real = await vocabulary();
    const text = await readText(real, WHAT_IT_SHOWS.replace(/\.rq$/, ".sql"));
    const options = await optionsOver(real);
    const over = async (
      given: Readonly<Record<string, string>>,
    ): Promise<{ outcome: string; why?: string }[]> =>
      await sqlCheckAssertions(options, ["files-and-folders"], given, [
        WHAT_IT_SHOWS,
      ]);
    assert.deepEqual(
      (await over({})).map(({ outcome }) => outcome),
      ["passed", "passed"],
    );
    for (const spelling of [
      "CREATE TEMP TABLE view_statements",
      "CREATE TABLE temp.view_statements",
    ]) {
      const uncleaned = replaced(text, /-- part: cleanup[\s\S]*/, "");
      const leaking = uncleaned.replace(
        "CREATE TEMP TABLE view_statements",
        spelling,
      );
      const found = await over({ [WHAT_IT_SHOWS]: leaking });
      assert.deepEqual(
        found.map(({ outcome }) => outcome),
        ["failed", "failed"],
        spelling,
      );
      assert.match(
        found[0]?.why ?? "",
        /leaves in the database.*view_statements/,
      );
    }
  });

  it("fails a SELECT that binds no record whose .rq, bound to a record no pod holds, gives rows its .sql does not, and a CONSTRUCT's rows as a set", async () => {
    const { built, close } = await podOf("<urn:x:a> <urn:x:p> 1 .");
    const files = await vocabulary();
    try {
      const failures = (rq: string, rqText: string, sql: string) =>
        sqlFailures(files, built, { rq, rqText, sql });
      const question = "queries/questions/q.rq";
      const plain = "SELECT ?x WHERE { ?r <urn:x:p> ?x }";
      const nested =
        "SELECT ?x WHERE { { SELECT ?record ?x WHERE { ?record <urn:x:p> ?x } } }";
      const sql = `SELECT '"1"^^<${XSD}integer>' AS x`;
      assert.deepEqual(await failures(question, plain, sql), []);
      const found = await failures(question, nested, sql);
      assert.equal(found.length, 1);
      assert.match(
        found[0] ?? "",
        /bound to urn:cascade:no-such-record, against the \.rq: unexpected: \?x=/,
      );
      const construct =
        "CONSTRUCT { <urn:x:a> <urn:x:q> ?o } WHERE { <urn:x:a> <urn:x:p> ?o }";
      const triple = `SELECT '<urn:x:a>' AS s, '<urn:x:q>' AS p, '"1"^^<${XSD}integer>' AS o`;
      const stray =
        "SELECT '<urn:x:a>' AS s, '<urn:x:b>' AS p, '<urn:x:c>' AS o";
      const derivation = "queries/derivations/c.rq";
      assert.deepEqual(
        await failures(derivation, construct, `${triple} UNION ALL ${triple}`),
        [],
      );
      assert.deepEqual(
        (
          await failures(
            derivation,
            construct,
            `${triple} UNION ALL ${stray} UNION ALL ${stray}`,
          )
        ).map((line) => line.replace(/^.*against the \.rq: /, "")),
        ["unexpected: ?s=<urn:x:a> ?p=<urn:x:b> ?o=<urn:x:c>"],
      );
    } finally {
      close();
    }
  });

  it("fails a list question whose pages ignore the key to continue after, or the page size", async () => {
    const { built, close } = await podOf(
      "<urn:x:a> <urn:x:p> 1 .",
      "CREATE TABLE listed (k TEXT); INSERT INTO listed VALUES ('a'), ('b'), ('c');",
    );
    const files = await vocabulary();
    try {
      const rqText =
        "SELECT ?entry WHERE { VALUES ?entry { <urn:x:a> <urn:x:b> <urn:x:c> } } ORDER BY ?entry";
      const rows =
        "SELECT '<urn:x:' || k || '>' AS entry, k AS page_key FROM listed";
      const pages = async (sql: string): Promise<string[]> =>
        sqlFailures(files, built, {
          rq: "queries/questions/pod/list.rq",
          rqText,
          sql,
        });
      assert.deepEqual(
        await pages(
          `${rows} WHERE k > coalesce(:after, '') ORDER BY k LIMIT coalesce(:page_size, -1)`,
        ),
        [],
      );
      for (const ignoring of [
        `${rows} WHERE (:after IS NULL OR 1) ORDER BY k LIMIT coalesce(:page_size, -1)`,
        `${rows} WHERE k > coalesce(:after, '') ORDER BY k LIMIT coalesce(:page_size, -1) + 100`,
      ])
        assert.match((await pages(ignoring))[0] ?? "", /a page of 1 after/);
    } finally {
      close();
    }
  });

  it("fails the screens of a view whose keyed fill leaves the rows of an entry a record moved out of, one whose fill run again makes or drops a table, and one that fills whole though the layout places the view at two addresses", async () => {
    const real = await vocabulary();
    const conditions = await readText(real, CONDITIONS);
    const allergies = await readText(real, ALLERGIES);
    const forgetting = replaced(
      conditions,
      /\n\s*UNION SELECT entry FROM \w+_member WHERE record IN \(SELECT term FROM scope\)/,
      "",
    );
    const one = (text: string): string =>
      replaced(
        text,
        "CASE WHEN count(DISTINCT i.lex) = 1 THEN min(i.lex) END",
        "min(i.lex)",
      );
    const over = async (
      texts: Readonly<Record<string, string>>,
      fixture: string,
    ): Promise<
      {
        test: string;
        outcome: string;
        why?: string;
        observed?: readonly string[];
      }[]
    > =>
      sqlCheckAssertions(
        await optionsOver(overlaid(real, texts)),
        [fixture],
        {},
      );
    const whole = await over({}, "conditions-view");
    assert.deepEqual(
      whole.filter(({ outcome }) => outcome !== "passed"),
      [],
    );
    assert.deepEqual(
      whole
        .filter(({ test }) => test.includes("#keyed/"))
        .map(({ observed }) =>
          (observed ?? []).filter((each) => each.startsWith("screen:")),
        ),
      [
        ["screen:queries/views/conditions.rq"],
        ["screen:queries/views/conditions.rq"],
      ],
    );
    const keyed = (await over({ [CONDITIONS]: forgetting }, "conditions-view"))
      .filter(({ outcome }) => outcome === "failed")
      .map(({ test, why }) => ({ test: test.split("#")[1], why }));
    assert.deepEqual(
      keyed.map(({ test }) => test),
      ["keyed/conditions-view/everyday", "keyed/conditions-view/export"],
    );
    assert.match(
      keyed[0]?.why ?? "",
      /moved out of entry .*: condition_member holds .* a whole fill does not/,
    );
    for (const remaking of [
      replaced(
        conditions,
        "CREATE TEMP TABLE IF NOT EXISTS condition_filled",
        "DROP TABLE IF EXISTS temp.condition_filled;\nCREATE TEMP TABLE condition_filled",
      ),
      replaced(
        conditions,
        "DELETE FROM condition_filled;",
        "DELETE FROM condition_filled;\nANALYZE temp.condition_filled;",
      ),
    ]) {
      const remade = (await over({ [CONDITIONS]: remaking }, "conditions-view"))
        .filter(({ outcome }) => outcome === "failed")
        .map(({ test, why }) => ({ test: test.split("#")[1], why }));
      assert.deepEqual(
        remade.map(({ test }) => test),
        ["keyed/conditions-view/everyday", "keyed/conditions-view/export"],
      );
      assert.match(
        remade[0]?.why ?? "",
        /queries\/views\/conditions\.sql: its fill part, run again, makes, drops or analyzes a table, view or index/,
      );
    }
    const addressed = (
      await over({ [ALLERGIES]: one(allergies) }, "allergies-view")
    )
      .filter(({ outcome }) => outcome === "failed")
      .map(({ why }) => why);
    assert.equal(addressed.length, 1);
    assert.match(
      addressed[0] ?? "",
      /filled whole though the layout places the view at two addresses/,
    );
  });

  it("refuses a view's fill at two addresses once for the whole run, and by a constraint's failure alone", async () => {
    const real = await vocabulary();
    const context = await sqlCheckContext(await optionsOver(real));
    const view = "queries/views/allergies.rq";
    const ported = context.ported.find(({ rq }) => rq === view);
    assert.ok(ported !== undefined);
    const built = await fixtureBuilt(context, "allergies-view", "everyday");
    try {
      let refills = 0;
      let failing: Error | undefined;
      const counting: BuiltFixture = {
        ...built,
        refill: () => {
          refills += 1;
          if (failing !== undefined) throw failing;
          return built.refill();
        },
      };
      const checked = new Set<string>();
      const observed: string[] = [];
      for (let again = 0; again < 3; again += 1)
        assert.deepEqual(
          await sqlFailures(
            real,
            counting,
            ported,
            undefined,
            observed,
            checked,
          ),
          [],
        );
      assert.equal(refills, 1, "refilled once for three comparisons");
      assert.deepEqual(
        observed.filter((each) => each.startsWith("two-addresses:")),
        [`two-addresses:${view}`],
      );
      assert.deepEqual([...checked], [view]);
      failing = Object.assign(new Error("NOT NULL constraint failed"), {
        code: "SQLITE_CONSTRAINT_NOTNULL",
      });
      assert.deepEqual(
        await sqlFailures(real, counting, ported, undefined, undefined),
        [],
      );
      failing = new Error("disk I/O error");
      await assert.rejects(
        sqlFailures(real, counting, ported, undefined, undefined),
        /disk I\/O error/,
      );
    } finally {
      built.close();
    }
  });

  it("fails the checks of the SQL files themselves for a .sql in the wrong parts, a screen table never emptied, an index with no statistics row, a .rq changed without its pin, and a .rq with no .sql unlisted", async () => {
    const real = await vocabulary();
    const allergies = await readText(real, ALLERGIES);
    const labels = await readText(real, "queries/labels.rq");
    const unported = await readText(real, "tests/sql-unported.txt");
    const failing = async (
      texts: Readonly<Record<string, string>>,
    ): Promise<string[]> =>
      (await sqlStaticAssertions(await optionsOver(overlaid(real, texts))))
        .filter(({ outcome }) => outcome === "failed")
        .map(({ test, why }) => `${test.split("#")[1]}: ${why}`);
    assert.deepEqual(await failing({}), []);
    assert.deepEqual(
      await failing({
        [ALLERGIES]: `${allergies}
-- part: extra
SELECT 1;
`,
      }),
      [
        "parts-in-their-order: queries/views/allergies.sql has the parts [tables, fill, finish, triples, extra], not [tables, fill, finish, triples]",
      ],
    );
    assert.deepEqual(
      await failing({
        [ALLERGIES]: replaced(
          allergies,
          "DELETE FROM allergy WHERE entry IN (SELECT entry FROM allergy_filled);\n",
          "",
        ),
      }),
      ["screen-tables-emptied: queries/views/allergies.rq: allergy"],
    );
    assert.deepEqual(
      await failing({
        [ALLERGIES]: replaced(
          allergies,
          "  ('allergy_code', 'allergy_code', '675 1 1'),\n",
          "",
        ),
      }),
      ["statistics-rows: none for allergy_code allergy_code"],
    );
    assert.match(
      (await failing({ "queries/labels.rq": `${labels}# changed\n` }))[0] ?? "",
      /^pins-by-hash: queries\/labels\.rq: pinned [0-9a-f]{64}, its bytes hash to [0-9a-f]{64}; check its \.sql/,
    );
    const [first = "", ...rest] = unported.split("\n");
    assert.deepEqual(
      await failing({ "tests/sql-unported.txt": rest.join("\n") }),
      [
        `unported-queries: ${first} has no .sql and tests/sql-unported.txt does not name it`,
      ],
    );
  });

  it("fails a manifest that names by ctm:comparesSqlWithSparqlUnderEveryLens a folder holding no ported query, which would choose nothing, silently", async () => {
    const real = await vocabulary();
    const path = "tests/fixtures/conditions-view/manifest.ttl";
    const manifest = await readText(real, path);
    const check = async (
      files: Files,
    ): Promise<{ outcome: string; why?: string }> => {
      const found = await unchosenSqlAssertions({
        vocabulary: files,
        newStore: () => new OxigraphStore(),
      });
      const [named] = found.filter(({ test }) =>
        test.endsWith("#manifests-name-only-ported-queries"),
      );
      assert.ok(named !== undefined);
      return named;
    };
    assert.equal((await check(real)).outcome, "passed");
    const wrong = await check(
      overlaid(real, {
        [path]: replaced(manifest, "queries/views/>", "queries/nothing-here/>"),
      }),
    );
    assert.equal(wrong.outcome, "failed");
    assert.match(wrong.why ?? "", /conditions-view: queries\/nothing-here\//);
  });

  it("fails a query that gives no row on any fixture it is compared on, and a kind of keyed change no fixture makes", () => {
    const files = { iri: "urn:x:v/" } as unknown as Files;
    const compared = (rq: string, ...rest: string[]) => ({
      test: rq,
      name: rq,
      outcome: "passed" as const,
      observed: [`compared:${rq}`, ...rest],
    });
    assert.deepEqual(sqlWholeRunAssertions(files, []), []);
    const found = sqlWholeRunAssertions(files, [
      compared("queries/a.rq", "rows:queries/a.rq"),
      compared("queries/b.rq"),
      compared("queries/b.rq"),
    ]);
    assert.deepEqual(
      found.map(({ outcome, why }) => [outcome, why]),
      [
        [
          "failed",
          "each gives no row on any fixture it is compared on, so is compared with nothing: queries/b.rq",
        ],
        ["passed", undefined],
      ],
    );
    const unscreened = sqlWholeRunAssertions(files, [
      compared("queries/views/v.rq", "rows:queries/views/v.rq"),
      compared(
        "queries/views/w.rq",
        "rows:queries/views/w.rq",
        "screen:queries/views/w.rq",
        "two-addresses:queries/views/w.rq",
      ),
    ]);
    assert.equal(unscreened[0]?.outcome, "failed");
    assert.match(
      unscreened[0]?.why ?? "",
      /no fixture whose screens are filled keyed gives its screen a row: queries\/views\/v\.rq\n.*two addresses: queries\/views\/v\.rq$/,
    );
    const views = sqlWholeRunAssertions(files, [
      compared(
        "queries/views/v.rq",
        "rows:queries/views/v.rq",
        "screen:queries/views/v.rq",
        "two-addresses:queries/views/v.rq",
        "kept:unchanged",
        "kept:moved",
      ),
    ]);
    assert.match(
      views[1]?.why ?? "",
      /no fixture the screens are filled on makes: .*agent renamed.*document retrieved again/,
    );
  });

  it("fails a function whose vector is not Oxigraph's SPARQL answer, but where the vector marks Oxigraph's own answer", async () => {
    const real = await vocabulary();
    const text = await readText(real, SQL_FUNCTION_VECTORS);
    const found = async (files: Files): Promise<string[]> =>
      outcomes(await sqlFunctionAssertions(files, () => new OxigraphStore()));
    const all = await found(real);
    assert.equal(all.length, 12);
    assert.deepEqual(
      all.filter((line) => !line.startsWith("passed: ")),
      [],
    );
    const wrong = await found(
      overlaid(real, {
        [SQL_FUNCTION_VECTORS]: replaced(
          text,
          /("sparql_encode_for_uri": \{[\s\S]*?"output": ")[^"]*"/,
          '$1not-this"',
        ),
      }),
    );
    assert.deepEqual(
      wrong.filter((line) => !line.startsWith("passed: ")),
      [
        "failed: sparql_encode_for_uri gives each vector's output",
        "failed: sparql_encode_for_uri's vectors are Oxigraph's SPARQL answers",
      ],
    );
  });

  it("refuses to load a pod into a schema that needs a newer SQLite than the one the runtime ships", () => {
    const db = openDatabase(":memory:");
    try {
      assert.throws(
        () =>
          loadStatements(db, "-- It needs SQLite 99.0.0 or later.\n", [], "t"),
        /SQLite \d+\.\d+\.\d+ is older than the 99\.0\.0 the schema needs/,
      );
    } finally {
      db.close();
    }
  });

  it("orders strings, times and counts by the keys of queries/statements.sql's paging convention as Oxigraph orders them", async () => {
    const db = openDatabase(":memory:");
    const turned = (text: string): string => {
      let found = "hex(:text)";
      for (const [digit, letter] of [..."0123456789ABCDEF"].map(
        (each, at) => [each, "ponmlkjihgfedcba"[at]] as const,
      ))
        found = `replace(${found}, '${digit}', '${letter}')`;
      return found + text;
    };
    const flipped = (digits: string): string =>
      [...digits].map((digit) => String(9 - Number(digit))).join("");
    const ascending = db.prepare("SELECT '3' || hex(:text) || '.' AS key");
    const descending = db.prepare(`SELECT ${turned(" || '~'")} AS key`);
    const countText = (value: number): string => {
      const digits = String(Math.abs(value)).padStart(19, "0");
      return value >= 0 ? `p${digits}` : `n${flipped(digits)}`;
    };
    const cases: [string, string[]][] = [
      ["string", ["", "a", "ab", "b", "B", "é", "Z", "a b"]],
      [
        "dateTime",
        [
          "2025-01-01T10:00:00+05:00",
          "2025-01-01T06:00:00Z",
          "2025-01-01T05:30:00Z",
          "2024-12-31T23:00:00-08:00",
          "2025-01-01T05:00:00.5Z",
        ],
      ],
      ["date", ["2024-06-01", "2023-01-01Z", "2024-06-02+13:00"]],
      ["integer", ["0", "7", "-7", "12", "-12", "100", "-100", "9", "-1"]],
    ];
    const union = new Union(new OxigraphStore());
    for (const [type, values] of cases) {
      const terms = values.map((value) =>
        written(literal(value, `${XSD}${type}`)),
      );
      const keyOf = (value: string): string =>
        type === "integer"
          ? countText(Number(value))
          : type === "string"
            ? value
            : (instantKey({
                kind: LITERAL,
                value,
                datatype: `${XSD}${type}`,
              }) ?? "");
      for (const [direction, key] of [
        ["", ascending],
        ["DESC", descending],
      ] as const) {
        const { rows } = await union.select(
          `SELECT ?x WHERE { VALUES ?x { ${terms.join(" ")} } } ORDER BY ${direction}(?x)`,
        );
        const byKey = [...values].sort((a, b) => {
          const [x, y] = [a, b].map((value) =>
            String(key.get({ text: keyOf(value) })?.key),
          );
          return (x ?? "") < (y ?? "") ? -1 : (x ?? "") > (y ?? "") ? 1 : 0;
        });
        assert.deepEqual(
          byKey,
          rows.map((row) => row.get("x")?.value),
          `${type} ${direction}`,
        );
      }
    }
    db.close();
  });

  it("lower-cases each cased character as Oxigraph's LCASE does, and refuses only those Oxigraph lower-cases that Unicode 15.0 does not", async () => {
    const characters = [
      ...new Set([
        ...Array.from({ length: 0x20000 }, (_, code) =>
          String.fromCodePoint(code),
        ).filter(
          (character) =>
            character !== character.toLowerCase() &&
            !/[\p{Cc}\p{Cs}]/u.test(character),
        ),
        ...[0x1c89, 0xa7cb, 0xa7ce, 0x10d50, 0x10d65, 0x16ea0, 0x16eb8].map(
          (code) => String.fromCodePoint(code),
        ),
        "İ",
        "Σ",
      ]),
    ];
    const union = new Union(new OxigraphStore());
    const refused: string[] = [];
    const differing: string[] = [];
    for (let at = 0; at < characters.length; at += 1000) {
      const chunk = characters.slice(at, at + 1000);
      const { rows } = await union.select(
        `SELECT ?c ?l WHERE { VALUES ?c { ${chunk.map((character) => written(literal(character))).join(" ")} } BIND(LCASE(?c) AS ?l) }`,
      );
      for (const row of rows) {
        const character = row.get("c")?.value ?? "";
        const lowered = row.get("l")?.value;
        try {
          if (sparqlLcase(character) !== lowered) differing.push(character);
        } catch (error) {
          if (!(error instanceof SqlFunctionRefused)) throw error;
          if (lowered === character) differing.push(character);
          refused.push(character);
        }
      }
    }
    assert.deepEqual(differing, []);
    assert.equal(refused.length, 55);
  });
});
