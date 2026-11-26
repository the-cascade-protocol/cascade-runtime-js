import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { earl } from "../src/conformance.js";
import { type Files, MemoryFiles, readText } from "../src/files.js";
import { openDatabase } from "../src/node/sqlite.js";
import { PodDatabase } from "../src/pod-database.js";
import { OxigraphStore } from "../src/oxigraph-store.js";
import {
  compared,
  FIXTURES,
  finalOrder,
  madeScreens,
  sqlCheckAssertions,
  sqlFailures,
  sqlFunctionAssertions,
  sqlTest,
  vectorFailures,
} from "../src/sql-check.js";
import { iri, literal, type Term } from "../src/rdf.js";
import { Union } from "../src/store.js";
import {
  askedOf,
  askedWhole,
  heldNt,
  loadStatements,
  sparqlDecimal,
  sqlAnswer,
  SQL_FUNCTION_VECTORS,
  sqlDatabaseFunctions,
  sqlFunctions,
  sqlStatements,
  STATEMENTS_SCHEMA,
} from "../src/statements.js";
import type { Database, DatabaseFunction } from "../src/database.js";
import { layout, vocabulary } from "./vocabulary.js";

const JUDGMENTS = "queries/questions/pod/How many judgments count.rq";
const MAPPED = "<https://ns.cascadeprotocol.org/cascade#SameMappedCode>";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const CASCADE = "https://ns.cascadeprotocol.org/cascade#";
const IN_ENTRY = `<${CASCADE}inEntry>`;

const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";

/** A pod of two records, each the one record of its entry, and the graphs given, in the vocabulary's schema with an `asked` table. */
async function twoEntries(
  graphs: readonly { graph: string; ntriples: string }[] = [],
): Promise<Database> {
  const pod = openDatabase(":memory:", {
    functions: await sqlDatabaseFunctions(),
  });
  loadStatements(
    pod,
    `${await readText(await vocabulary(), STATEMENTS_SCHEMA)}
CREATE TABLE IF NOT EXISTS asked (term INTEGER PRIMARY KEY) STRICT;`,
    [
      {
        graph: "urn:x:file",
        ntriples: ["a", "b"]
          .flatMap((name) => [
            `<urn:x:${name}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CASCADE}Record> .`,
            `<urn:x:${name}> ${IN_ENTRY} <urn:x:entry-${name}> .`,
            `<urn:x:entry-${name}> <${CASCADE}entryMember> <urn:x:${name}> .`,
          ])
          .join("\n"),
      },
      ...graphs,
    ],
    "test",
  );
  return pod;
}

/** Literals of each datatype Oxigraph's store reads into a value, each `[datatype, lexical form]`, some it cannot read. */
const LITERALS: readonly (readonly [string, string])[] = [
  ["dateTime", "2026-11-19T08:25:01.710Z"],
  ["dateTime", "2026-11-19T08:25:01.000+00:00"],
  ["dateTime", "2026-11-19T08:25:01.500-00:00"],
  ["dateTime", "2026-11-19T08:25:01.500+05:30"],
  ["dateTime", "2026-11-19T08:25:01"],
  ["dateTime", "2024-02-29T10:00:00.000Z"],
  ["dateTime", "2025-02-29T10:00:00.000Z"],
  ["dateTime", "2025-02-29T10:00:00+00:00"],
  ["dateTime", "1900-02-29T00:00:00.10Z"],
  ["dateTime", "2000-02-29T00:00:00.10Z"],
  ["dateTime", "0000-02-29T00:00:00.10Z"],
  ["dateTime", "-0004-02-29T00:00:00.10Z"],
  ["dateTime", "-0001-02-29T00:00:00.10Z"],
  ["dateTime", "-0001-01-01T00:00:00Z"],
  ["dateTime", "-0000-01-01T00:00:00Z"],
  ["dateTime", "12026-01-01T00:00:00.10Z"],
  ["dateTime", "02026-01-01T00:00:00.10Z"],
  ["dateTime", "-02026-01-01T00:00:00.10Z"],
  ["dateTime", "2026-01-01T24:00:00Z"],
  ["dateTime", "2026-12-31T24:00:00.0Z"],
  ["dateTime", "2026-01-01T24:00:00.1Z"],
  ["dateTime", "2026-01-01T00:00:60Z"],
  ["dateTime", "2026-01-01T00:00:00.123456789012345678Z"],
  ["dateTime", "2026-01-01T00:00:00.1234567890123456780Z"],
  ["dateTime", "2026-01-01T00:00:00.1234567890123456789Z"],
  ["dateTime", "2026-01-01T10:00:00.50+14:00"],
  ["dateTime", "2026-01-01T10:00:00.50-14:00"],
  ["dateTime", "2026-01-01T10:00:00.50+14:01"],
  ["dateTime", "2026-01-01T10:00:00.50+15:00"],
  ["dateTime", "2026-01-01T10:00:00.50+05:59"],
  ["dateTime", "2026-01-01T10:00:00.50+05:60"],
  ["dateTime", "2026-11-19T08:25:01.710z"],
  ["dateTime", "2026-01-01T00:00:00."],
  ["dateTimeStamp", "2026-11-19T08:25:01.710+00:00"],
  ["dateTimeStamp", "2025-02-29T00:00:00.10Z"],
  ["time", "08:25:01.100Z"],
  ["time", "08:25:01.00-00:00"],
  ["time", "24:00:00"],
  ["time", "24:00:00.5"],
  ["time", "10:00:00.10+15:00"],
  ["date", "2026-11-19-00:00"],
  ["date", "2026-11-19+05:00"],
  ["date", "2024-02-29-00:00"],
  ["date", "2026-02-29-00:00"],
  ["date", "2025-02-30+00:00"],
  ["date", "2026-04-31"],
  ["date", "-0000-01-01"],
  ["gYear", "2026+00:00"],
  ["gYear", "-0001-00:00"],
  ["gYear", "02026+00:00"],
  ["gYear", "2026+15:00"],
  ["gYearMonth", "2026-01+00:00"],
  ["gYearMonth", "2026-13+00:00"],
  ["gMonth", "--12-00:00"],
  ["gMonth", "--13+00:00"],
  ["gDay", "---01+00:00"],
  ["gDay", "---00+00:00"],
  ["gMonthDay", "--02-29+00:00"],
  ["gMonthDay", "--02-28+00:00"],
  ["gMonthDay", "--04-31+00:00"],
  ["integer", "+5"],
  ["integer", "-0"],
  ["integer", "99999999999999999999"],
  ["integer", " 5"],
  ["int", "05"],
  ["int", "abc"],
  ["long", "9223372036854775807"],
  ["long", "9223372036854775808"],
  ["nonNegativeInteger", "5"],
  ["byte", "1000"],
  ["decimal", "+1.50"],
  ["decimal", ".5"],
  ["decimal", "1.1234567890123456789"],
  ["boolean", "1"],
  ["boolean", "True"],
  ["double", "1.0E0"],
  ["double", "1.0E2"],
  ["double", "1e21"],
  ["double", "-0"],
  ["double", "1E400"],
  ["double", "abc"],
  ["float", "1.50"],
  ["float", "16777217"],
  ["duration", "P1Y0M"],
  ["duration", "P1DT24H"],
  ["dayTimeDuration", "PT60S"],
  ["dayTimeDuration", "P1Y"],
  ["yearMonthDuration", "P12M"],
  ["string", "2026-01-01T00:00:00.10Z"],
  ["anyURI", "urn:x:a"],
];

/** Each of `LITERALS` as the runtime makes it, and each as a statement of Oxigraph's own N-Triples once its store holds it. */
async function heldByOxigraph(): Promise<{ made: Term[]; held: string[] }> {
  const made = LITERALS.map(([type, value]) => literal(value, `${XSD}${type}`));
  const store = new OxigraphStore();
  try {
    await store.add(
      made.map((object, at) => [iri(`urn:x:s${at}`), iri("urn:x:p"), object]),
      { graph: "urn:x:g" },
    );
    const lines = new TextDecoder().decode(await store.dump()).split("\n");
    return {
      made,
      held: made.map((_, at) => {
        const line = lines.find((found) => found.startsWith(`<urn:x:s${at}> `));
        assert.ok(line !== undefined, `the store holds no statement of ${at}`);
        return line.replace(/ <urn:x:g> \.$/, " .");
      }),
    };
  } finally {
    store.free?.();
  }
}

/** A screen of one table, each entry and its record. */
const screen = (name: string, fill: string): string =>
  [
    "-- part: tables",
    `CREATE TABLE ${name} (entry INTEGER PRIMARY KEY, record INTEGER NOT NULL) STRICT;`,
    "-- part: fill",
    `DELETE FROM ${name} WHERE entry IN (SELECT o FROM quad WHERE p = (SELECT id FROM term WHERE nt = '${IN_ENTRY}') AND s IN (SELECT term FROM scope));`,
    fill,
    "-- part: finish",
    "-- part: triples",
    `SELECT NULL AS s, NULL AS p, NULL AS o FROM ${name}`,
  ].join("\n");

/** A question in two parts: its prepare makes, each time it is asked, the table its answer reads, from a tally of the times asked. */
const ASKED_IN_PARTS = [
  "-- part: prepare",
  "CREATE TEMP TABLE IF NOT EXISTS times_asked (n INTEGER);",
  "INSERT INTO times_asked VALUES (1);",
  "DROP TABLE IF EXISTS temp.asked_now;",
  "CREATE TEMP TABLE asked_now AS SELECT count(*) AS n FROM times_asked;",
  "-- part: answer",
  "SELECT '<urn:x:asked-' || n || '>' AS entry FROM asked_now",
].join("\n");

/** A question in three parts: its prepare makes a temporary table, its answer reads it (and fails where `answer` is not a select of it), its cleanup drops it. */
const WITH_CLEANUP = (answer = "SELECT k AS entry FROM said"): string =>
  [
    "-- part: prepare",
    "DROP TABLE IF EXISTS temp.said;",
    "CREATE TEMP TABLE said (k TEXT) STRICT;",
    "INSERT INTO said VALUES ('<urn:x:a>');",
    "-- part: answer",
    answer,
    "-- part: cleanup",
    "DROP TABLE IF EXISTS temp.said;",
  ].join("\n");

const NO_SUCH_COLUMN = "SELECT no_such_column AS entry FROM said";

/** The temporary table the question in three parts makes, while a connection holds it. */
const temporaryTables = (db: Database): unknown[] =>
  db.prepare("SELECT name FROM sqlite_temp_schema WHERE name = 'said'").all();

const FILLED = (name: string): string =>
  `INSERT INTO ${name} SELECT o, s FROM quad WHERE p = (SELECT id FROM term WHERE nt = '${IN_ENTRY}') AND s IN (SELECT term FROM scope);`;

/**
 * The vocabulary keeps a `.sql` beside each question's `.rq`, over its schema of a pod's statements in SQLite, calling six
 * functions where SQLite has no answer of its own. The runtime loads a pod into that schema, registers the functions,
 * and checks each `.sql` gives its `.rq`'s rows on the fixtures, and under the lenses, the fixtures' manifests choose for
 * it, as EARL assertions.
 */
describe("Answering the vocabulary's SQL from a pod's statements · loadStatements(), sqlFunctions(), sqlCheckAssertions()", () => {
  let db: Database;

  before(async () => {
    db = openDatabase(":memory:", { functions: await sqlDatabaseFunctions() });
  });

  after(() => db.close());

  it("gives each vector's output from its input, and refuses each input a vector marks refused", async () => {
    const { functions } = JSON.parse(
      await readText(await vocabulary(), SQL_FUNCTION_VECTORS),
    ) as {
      functions: Record<
        string,
        { vectors: Parameters<typeof vectorFailures>[1] }
      >;
    };
    const implemented = await sqlFunctions();
    assert.deepEqual(
      Object.keys(functions).sort(),
      Object.keys(implemented).sort(),
    );
    for (const [name, { vectors }] of Object.entries(functions))
      assert.deepEqual(vectorFailures(implemented[name], vectors), [], name);
  });

  it("registers the six on a connection, each taking as many arguments as it is given, a whole number given back as an integer", () => {
    assert.deepEqual(
      db
        .prepare(
          `SELECT sparql_decimal('+', '0.1', '0.2') AS sum, sparql_decimal('floor', '-2.5') AS floor,
             typeof(sparql_compare('"a"', '"b"')) AS kind, sparql_compare('"a"', '"b"') AS compared`,
        )
        .get(),
      { sum: "0.3", floor: "-3", kind: "integer", compared: -1 },
    );
  });

  it("loads a store's graphs, each term once with its kind, lexical form, datatype and calendar keys, every record in scope", async () => {
    const pod = openDatabase(":memory:");
    loadStatements(
      pod,
      await readText(await vocabulary(), STATEMENTS_SCHEMA),
      [
        {
          graph: "urn:x:file",
          ntriples: [
            `<urn:x:a> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://ns.cascadeprotocol.org/cascade#Record> .`,
            `<urn:x:a> <urn:x:at> "2025-03-27T07:00:00.5-05:00"^^<${XSD}dateTime> .`,
            `<urn:x:a> <urn:x:said> "a\\nb"@en .`,
          ].join("\n"),
        },
      ],
      "test",
    );
    assert.deepEqual(
      pod
        .prepare(
          "SELECT nt, kind, lex, datatype, lang, instant, day FROM term WHERE kind = 3 ORDER BY nt",
        )
        .all(),
      [
        {
          nt: `"2025-03-27T07:00:00.5-05:00"^^<${XSD}dateTime>`,
          kind: 3,
          lex: "2025-03-27T07:00:00.5-05:00",
          datatype: `${XSD}dateTime`,
          lang: null,
          instant: "2025-03-27T12:00:00.500000000000000000",
          day: "2025-03-27",
        },
        {
          nt: '"a\\nb"@en',
          kind: 3,
          lex: "a\nb",
          datatype: "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString",
          lang: "en",
          instant: null,
          day: null,
        },
      ],
    );
    assert.deepEqual(
      pod
        .prepare("SELECT t.nt FROM scope JOIN term t ON t.id = scope.term")
        .all(),
      [{ nt: "<urn:x:a>" }],
    );
    assert.deepEqual(
      pod.prepare("SELECT built, fingerprint FROM ledger").all(),
      [{ built: "pod", fingerprint: "test" }],
    );
    pod.close();
  });

  it("asserts failed, naming the fixture, the query and the row, a .sql that drops a value from a row the fixture's manifest pins", async () => {
    const files = await vocabulary();
    const text = await readText(files, JUDGMENTS.replace(/\.rq$/, ".sql"));
    const broken =
      `SELECT verdict, CASE WHEN justification = '${MAPPED}' THEN NULL ELSE justification END AS justification, ` +
      `madeBy, judgments FROM (${text})`;
    const options = {
      vocabulary: files,
      newStore: () => new OxigraphStore(),
      layout: await layout(),
      open: (functions: readonly DatabaseFunction[]) =>
        openDatabase(":memory:", { functions }),
    };
    const held = await sqlCheckAssertions(options, ["which-judgments-count"]);
    const mine = held.filter(({ name }) =>
      name.startsWith(JUDGMENTS.replace(/\.rq$/, ".sql")),
    );
    assert.deepEqual(
      mine.map(({ outcome }) => outcome),
      ["passed", "passed"],
      mine.map(({ why }) => why ?? "").join("\n"),
    );
    const found = await sqlCheckAssertions(options, ["which-judgments-count"], {
      [JUDGMENTS]: broken,
    });
    const everyday = found.find(
      ({ name }) =>
        name.endsWith("under everyday") &&
        name.startsWith("queries/questions/pod/How many"),
    );
    assert.equal(everyday?.outcome, "failed");
    const why = everyday?.why ?? "";
    assert.match(
      why,
      new RegExp(
        `which-judgments-count, under everyday, ${JUDGMENTS}, against the \\.rq: missing: [^\\n]*\\?justification=${MAPPED.replace(/[.#]/g, "\\$&")}`,
      ),
    );
    assert.match(
      why,
      new RegExp(
        `how-many-count-everyday, under everyday, ${JUDGMENTS}: missing: [^\\n]*\\?justification=${MAPPED.replace(/[.#]/g, "\\$&")}`,
      ),
    );
    const report = new TextDecoder().decode(earl(found, "cascade-runtime-js"));
    assert.ok(report.includes("<http://www.w3.org/ns/earl#failed>"));
  });

  it("compares each .sql over the fixtures and lenses the fixtures' manifests choose for it and no other, and fails a .sql that none chooses", async () => {
    const real = await vocabulary();
    const whether = "queries/questions/judgment/Whether it counts.rq";
    const kinds = "queries/questions/pod/How many of each kind.rq";
    const person = "queries/questions/pod/The person this pod is about.rq";
    const kept = new Set(
      [JUDGMENTS, whether, kinds, person].map((rq) =>
        rq.replace(/\.rq$/, ".sql"),
      ),
    );
    const own = new MemoryFiles(real.iri);
    const manifest = (said: string): Uint8Array =>
      new TextEncoder().encode(
        [
          "@prefix ctm: <https://ns.cascadeprotocol.org/test-manifest#> .",
          "@prefix mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#> .",
          `<> a mf:Manifest ${said} ; mf:entries () .`,
        ].join("\n"),
      );
    await own.write(
      `${FIXTURES}names-a-question/manifest.ttl`,
      manifest(`; ctm:comparesSqlBeside <../../../${encodeURI(kinds)}>`),
    );
    await own.write(`${FIXTURES}names-nothing/manifest.ttl`, manifest(""));
    const relative = (path: string): string =>
      path.startsWith(real.iri) ? path.slice(real.iri.length) : path;
    // The real vocabulary but its fixtures, which-judgments-count kept, and its `.sql` files, four kept.
    const shown = (path: string): boolean =>
      path.startsWith(FIXTURES)
        ? path.startsWith(`${FIXTURES}which-judgments-count/`)
        : !path.endsWith(".sql") ||
          path === STATEMENTS_SCHEMA ||
          kept.has(path);
    const files: Files = {
      iri: real.iri,
      read: async (path) =>
        (await own.read(path)) ??
        (shown(relative(path)) ? real.read(path) : undefined),
      write: (path, bytes) => own.write(path, bytes),
      list: async (folder) =>
        [
          ...new Set([
            ...(await real.list(folder)).filter(shown),
            ...(await own.list(folder)),
          ]),
        ].sort(),
    };
    const found = await sqlCheckAssertions({
      vocabulary: files,
      newStore: () => new OxigraphStore(),
      layout: await layout(),
      open: (functions) => openDatabase(":memory:", { functions }),
    });
    const sql = (rq: string): string => rq.replace(/\.rq$/, ".sql");
    assert.deepEqual(
      found.map(({ name, outcome }) => `${outcome}: ${name}`).sort(),
      [
        `passed: ${sql(JUDGMENTS)} over which-judgments-count under everyday`,
        `passed: ${sql(JUDGMENTS)} over which-judgments-count under export`,
        `passed: ${sql(whether)} over which-judgments-count under everyday`,
        `passed: ${sql(kinds)} over names-a-question under everyday`,
        `passed: ${sql(kinds)} over names-a-question under export`,
        `failed: ${sql(person)} is compared over no fixture`,
      ].sort(),
      found.flatMap(({ why }) => why ?? []).join("\n"),
    );
  });

  it("gives a list question's rows without its trailing page_key, and the key of each row as it was written", () => {
    assert.deepEqual(
      sqlAnswer(
        db,
        "SELECT '<urn:x:a>' AS entry, '34D69677.' AS page_key UNION ALL SELECT NULL, 'mnmp~'",
      ),
      {
        columns: ["entry"],
        rows: [["<urn:x:a>"], [null]],
        keys: ["34D69677.", "mnmp~"],
      },
    );
  });

  it("gives a question in the parts prepare and answer the rows of its answer, after running its prepare statements each time it is asked, and a question in no part as before", () => {
    assert.deepEqual(sqlAnswer(db, ASKED_IN_PARTS), {
      columns: ["entry"],
      rows: [["<urn:x:asked-1>"]],
    });
    assert.deepEqual(sqlAnswer(db, ASKED_IN_PARTS).rows, [["<urn:x:asked-2>"]]);
    assert.deepEqual(sqlAnswer(db, "SELECT '<urn:x:a>' AS entry"), {
      columns: ["entry"],
      rows: [["<urn:x:a>"]],
    });
  });

  it("asks a pod's database a question in the parts prepare and answer, its statements compiled once on the connection, as it asks a question in no part", async () => {
    const files = new MemoryFiles("https://example.test/vocabulary/");
    await files.write(STATEMENTS_SCHEMA, new Uint8Array());
    const database = await PodDatabase.opened(
      {
        open: ({ functions }) => openDatabase(":memory:", { functions }),
        builtWhole: async () => undefined,
        remove: async () => undefined,
        exists: async () => true,
      },
      new MemoryFiles("https://example.test/pod/"),
      files,
    );
    assert.deepEqual(database.answer(ASKED_IN_PARTS), {
      rows: [{ entry: "urn:x:asked-1" }],
    });
    assert.deepEqual(database.answer(ASKED_IN_PARTS), {
      rows: [{ entry: "urn:x:asked-2" }],
    });
    assert.deepEqual(database.answer("SELECT '<urn:x:a>' AS entry"), {
      rows: [{ entry: "urn:x:a" }],
    });
  });

  it("drops what a question's prepare part made by its cleanup part, once its answer has given its rows and when it fails", () => {
    assert.deepEqual(sqlAnswer(db, WITH_CLEANUP()), {
      columns: ["entry"],
      rows: [["<urn:x:a>"]],
    });
    assert.deepEqual(temporaryTables(db), []);
    assert.throws(() => sqlAnswer(db, WITH_CLEANUP(NO_SUCH_COLUMN)));
    assert.deepEqual(temporaryTables(db), []);
  });

  it("drops what a question's prepare part made from a pod's database by its cleanup part, each time it is asked, also when the answer fails", async () => {
    const files = new MemoryFiles("https://example.test/vocabulary/");
    await files.write(STATEMENTS_SCHEMA, new Uint8Array());
    let opened: Database | undefined;
    const database = await PodDatabase.opened(
      {
        open: ({ functions }) =>
          (opened = openDatabase(":memory:", { functions })),
        builtWhole: async () => undefined,
        remove: async () => undefined,
        exists: async () => true,
      },
      new MemoryFiles("https://example.test/pod/"),
      files,
    );
    const held = (): unknown[] => temporaryTables(opened as Database);
    for (let asked = 0; asked < 2; asked++) {
      assert.deepEqual(database.answer(WITH_CLEANUP()), {
        rows: [{ entry: "urn:x:a" }],
      });
      assert.deepEqual(held(), []);
    }
    assert.throws(() => database.answer(WITH_CLEANUP(NO_SUCH_COLUMN)));
    assert.deepEqual(held(), []);
    assert.deepEqual(database.answer(WITH_CLEANUP()), {
      rows: [{ entry: "urn:x:a" }],
    });
    assert.deepEqual(held(), []);
  });

  it("refuses a question's parts in another order than prepare, answer and cleanup", () => {
    assert.throws(
      () =>
        sqlAnswer(
          db,
          "-- part: prepare\nSELECT 1;\n-- part: cleanup\nSELECT 2;\n-- part: answer\nSELECT 1 AS entry",
        ),
      /prepare, answer/,
    );
  });

  it("splits a part into its statements at each ; outside a string, a quoted name and a comment, so each is compiled once and run again", () => {
    assert.deepEqual(
      sqlStatements(
        `-- a; comment\nCREATE TABLE "a;b" (v TEXT);\nINSERT INTO [a;b] VALUES ('x;''y') /* ; */;\n-- the end\n`,
      ).map((statement) => statement.trim()),
      [
        `-- a; comment\nCREATE TABLE "a;b" (v TEXT)`,
        "INSERT INTO [a;b] VALUES ('x;''y') /* ; */",
      ],
    );
  });

  it("gives no SQL assertion, and throws nothing, for a vocabulary with no SQL", async () => {
    const empty = new MemoryFiles("urn:x:vocabulary/");
    assert.deepEqual(await sqlFunctionAssertions(empty), []);
    assert.deepEqual(
      await sqlCheckAssertions({
        vocabulary: empty,
        newStore: () => new OxigraphStore(),
        layout: await layout(),
        open: (functions) => openDatabase(":memory:", { functions }),
      }),
      [],
    );
  });

  it("asks a question bound to records through asked, leaving scope to the build, and says when the pod holds none of them", async () => {
    const pod = await twoEntries();
    const held = (table: string): unknown[] =>
      pod
        .prepare(
          `SELECT t.nt FROM ${table} JOIN term t ON t.id = ${table}.term ORDER BY t.nt`,
        )
        .all()
        .map(({ nt }) => nt);
    const scope = held("scope");
    assert.equal(askedOf(pod, ["urn:x:nowhere"]), false);
    assert.deepEqual(held("asked"), []);
    assert.equal(askedOf(pod, ["urn:x:a", "urn:x:nowhere"]), true);
    assert.deepEqual(held("asked"), ["<urn:x:a>"]);
    assert.deepEqual(held("scope"), scope);
    askedWhole(pod);
    assert.deepEqual(held("asked"), []);
    pod.close();
  });

  it("fails only the screen whose part throws, naming it and the part, and the questions that read it", async () => {
    const pod = await twoEntries();
    const failed = madeScreens(pod, [
      {
        rq: "queries/views/good.rq",
        rqText: "",
        sql: screen("good", FILLED("good")),
      },
      {
        rq: "queries/views/bad.rq",
        rqText: "",
        sql: screen("bad", "INSERT INTO nowhere VALUES (1);"),
      },
      {
        rq: "queries/questions/reads-good.rq",
        rqText: "",
        sql: "SELECT entry FROM good",
      },
      {
        rq: "queries/questions/reads-bad.rq",
        rqText: "",
        sql: "SELECT entry FROM bad",
      },
    ]);
    assert.deepEqual([...failed.keys()].sort(), [
      "queries/questions/reads-bad.rq",
      "queries/views/bad.rq",
    ]);
    assert.match(
      failed.get("queries/views/bad.rq") ?? "",
      /queries\/views\/bad\.sql fails in its fill part: .*nowhere/,
    );
    assert.match(
      failed.get("queries/questions/reads-bad.rq") ?? "",
      /reads the screen of queries\/views\/bad\.sql/,
    );
    assert.equal(pod.prepare("SELECT count(*) AS n FROM good").get()?.n, 2);
    pod.close();
  });

  it("makes the labels file's labels from labels.sql after every view's fill and before any finish, and takes it for no screen", async () => {
    const pod = await twoEntries([
      {
        graph: "urn:x:layout",
        ntriples: [
          `_:placement <${CASCADE}writtenByQueryPath> "labels.rq" .`,
          "_:placement <http://www.w3.org/ns/solid/terms#instance> <urn:x:labels> .",
        ].join("\n"),
      },
      {
        graph: "urn:x:labels",
        ntriples: `<urn:x:entry-a> <${LABEL}> "stale" .`,
      },
    ]);
    const labelsIn = (graph: string): string[] =>
      pod
        .prepare(
          "SELECT s.nt || ' ' || o.nt AS row FROM quad JOIN term s ON s.id = quad.s JOIN term o ON o.id = quad.o " +
            "WHERE quad.g = (SELECT id FROM term WHERE nt = ?) AND quad.p = (SELECT id FROM term WHERE nt = ?) ORDER BY 1",
        )
        .all(`<${graph}>`, `<${LABEL}>`)
        .map(({ row }) => String(row));
    const named = ['<urn:x:entry-a> "named"', '<urn:x:entry-b> "named"'];
    const ported = [
      {
        rq: "queries/labels.rq",
        rqText: "",
        sql: [
          "-- part: fill",
          "DROP TABLE IF EXISTS temp.named;",
          "CREATE TEMP TABLE named AS SELECT entry FROM s;",
          "-- part: triples",
          `SELECT t.nt AS s, '<${LABEL}>' AS p, '"named"' AS o FROM named JOIN term t ON t.id = named.entry`,
        ].join("\n"),
      },
      {
        rq: "queries/views/s.rq",
        rqText: "",
        sql: [
          "-- part: tables",
          "CREATE TABLE s (entry INTEGER PRIMARY KEY, record INTEGER NOT NULL) STRICT;",
          "CREATE TABLE s_named (entry INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;",
          "-- part: fill",
          "DELETE FROM s; DELETE FROM s_named;",
          FILLED("s"),
          "-- part: finish",
          `INSERT INTO s_named SELECT s.entry, o.nt FROM s JOIN quad q ON q.s = s.entry AND q.p = (SELECT id FROM term WHERE nt = '<${LABEL}>') JOIN term o ON o.id = q.o;`,
          "-- part: triples",
          "SELECT NULL AS s, NULL AS p, NULL AS o FROM s",
        ].join("\n"),
      },
    ];
    try {
      assert.deepEqual([...madeScreens(pod, ported)], []);
      assert.deepEqual(labelsIn("urn:x:labels"), named);
      assert.deepEqual(
        pod
          .prepare("SELECT label FROM s_named ORDER BY entry")
          .all()
          .map(({ label }) => label),
        ['"named"', '"named"'],
      );
    } finally {
      pod.close();
    }
  });

  it("writes the labels file's labels back in one transaction with statements prepared once, however many rows labels.sql gives", async () => {
    const ran = async (rows: number) => {
      const pod = await twoEntries([
        {
          graph: "urn:x:layout",
          ntriples: [
            `_:placement <${CASCADE}writtenByQueryPath> "labels.rq" .`,
            "_:placement <http://www.w3.org/ns/solid/terms#instance> <urn:x:labels> .",
          ].join("\n"),
        },
      ]);
      let depth = 0;
      const counted = { prepared: 0, writtenAlone: 0, transactions: 0 };
      const watched: Database = {
        prepare: (sql) => {
          counted.prepared += 1;
          const statement = pod.prepare(sql);
          return {
            all: (...given) => statement.all(...given),
            iterate: (...given) => statement.iterate(...given),
            get: (...given) => statement.get(...given),
            columns: () => statement.columns(),
            run: (...given) => {
              if (depth === 0) counted.writtenAlone += 1;
              return statement.run(...given);
            },
          };
        },
        exec: (sql) => pod.exec(sql),
        transaction: (work) => {
          counted.transactions += 1;
          depth += 1;
          try {
            return pod.transaction(work);
          } finally {
            depth -= 1;
          }
        },
        close: () => pod.close(),
      };
      try {
        const failed = madeScreens(watched, [
          {
            rq: "queries/labels.rq",
            rqText: "",
            sql: [
              "-- part: fill",
              "SELECT 1;",
              "-- part: triples",
              `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) ` +
                `SELECT '<urn:x:thing-' || i || '>' AS s, '<${LABEL}>' AS p, '"label ' || i || '"' AS o FROM n`,
            ].join("\n"),
          },
        ]);
        assert.deepEqual([...failed], []);
        const written = pod
          .prepare(
            "SELECT count(*) AS n FROM quad WHERE g = (SELECT id FROM term WHERE nt = '<urn:x:labels>')",
          )
          .get()?.n;
        assert.equal(written, rows);
        return counted;
      } finally {
        pod.close();
      }
    };
    const few = await ran(3);
    const many = await ran(60);
    assert.deepEqual(many, few);
    assert.equal(many.writtenAlone, 0);
    assert.equal(many.transactions, 1);
  });

  it("asserts failed a manifest entry that runs the query and pins no result", async () => {
    const pod = await twoEntries();
    const store = new OxigraphStore();
    try {
      const found = await sqlFailures(
        await vocabulary(),
        {
          name: "f",
          lens: "everyday",
          union: new Union(store),
          db: pod,
          entries: [
            {
              name: "pins nothing",
              query: "queries/q.rq",
              lens: "queries/lenses/everyday.rq",
              records: [],
            },
          ],
          screens: new Map(),
          close: () => undefined,
        },
        {
          rq: "queries/q.rq",
          rqText: "SELECT ?x WHERE { ?x ?p ?o }",
          sql: "SELECT NULL AS x WHERE 0",
        },
      );
      assert.deepEqual(found, [
        "f, pins nothing: it runs queries/q.rq and pins no mf:result",
      ]);
    } finally {
      pod.close();
      store.free?.();
    }
  });

  it("writes each literal the runtime made as Oxigraph's store holds it, and one Oxigraph cannot read as it was written", async () => {
    const { made, held } = await heldByOxigraph();
    assert.deepEqual(
      made.map((object, at) => `<urn:x:s${at}> <urn:x:p> ${heldNt(object)} .`),
      made.map((_, at) =>
        held.find((line) => line.startsWith(`<urn:x:s${at}> `)),
      ),
    );
  });

  it("loads Oxigraph's own N-Triples of each literal, a calendar value it keeps as written among them", async () => {
    const { held } = await heldByOxigraph();
    const pod = openDatabase(":memory:");
    try {
      loadStatements(
        pod,
        await readText(await vocabulary(), STATEMENTS_SCHEMA),
        [{ graph: "urn:x:g", ntriples: held.join("\n") }],
        "test",
      );
      const objects = new Set(
        pod
          .prepare("SELECT t.nt AS nt FROM quad JOIN term t ON t.id = quad.o")
          .all()
          .map((row) => String(row.nt)),
      );
      for (const line of held)
        assert.ok(
          objects.has(line.slice(line.indexOf("> <urn:x:p> ") + 12, -2)),
          line,
        );
    } finally {
      pod.close();
    }
  });

  it("refuses to load a literal Oxigraph would hold in another, canonical, form", async () => {
    const schema = await readText(await vocabulary(), STATEMENTS_SCHEMA);
    for (const literal of [
      `"01"^^<${XSD}integer>`,
      `"1.50"^^<${XSD}decimal>`,
      `"1"^^<${XSD}boolean>`,
    ]) {
      const pod = openDatabase(":memory:");
      assert.throws(
        () =>
          loadStatements(
            pod,
            schema,
            [
              {
                graph: "urn:x:g",
                ntriples: `<urn:x:a> <urn:x:p> ${literal} .`,
              },
            ],
            "test",
          ),
        /not as Oxigraph writes it/,
        literal,
      );
      pod.close();
    }
  });

  it("gives null, as the vocabulary's Python does, for a decimal operand SQLite gives as the integer 0", () => {
    assert.equal(sparqlDecimal("+", 0, "1"), null);
    assert.equal(sparqlDecimal("+", "1", 0), null);
  });

  it("names a .sql's assertion with the .sql in its fragment, so a report that shows only the fragment names the query", async () => {
    assert.ok(
      sqlTest(
        await vocabulary(),
        { rq: "queries/questions/pod/My lab results.rq" },
        "f",
        "everyday",
      ).endsWith("#queries/questions/pod/My%20lab%20results.sql/f/everyday"),
    );
  });
  it("reads a fixture's expected answer from its SPARQL TSV file: a row to a line, an unbound field empty, the header checked against the query's variables, and refuses a term no comparison can match exactly", async () => {
    const files = new MemoryFiles("https://example.org/v/");
    const pod = await twoEntries();
    const store = new OxigraphStore();
    // The query has no rows, so each row the file pins is reported missing, as the runtime read it.
    const read = async (text: string, variables = ["x"]): Promise<string[]> => {
      await files.write("answer.tsv", new TextEncoder().encode(text));
      const prefix = "f, e, under everyday, queries/q.rq: missing: ";
      const found = await sqlFailures(
        files,
        {
          name: "f",
          lens: "everyday",
          union: new Union(store),
          db: pod,
          entries: [
            {
              name: "e",
              query: "queries/q.rq",
              lens: "queries/lenses/everyday.rq",
              records: [],
              result: "answer.tsv",
            },
          ],
          screens: new Map(),
          close: () => undefined,
        },
        {
          rq: "queries/q.rq",
          rqText: `SELECT ${variables.map((name) => `?${name}`).join(" ")} WHERE { ?x ?p ?o }`,
          sql: `SELECT ${variables.map((name) => `NULL AS ${name}`).join(", ")} WHERE 0`,
        },
      );
      return found.map((line) =>
        line.startsWith(prefix) ? line.slice(prefix.length) : line,
      );
    };
    try {
      const whole = `<${XSD}integer>`;
      const terms: [field: string, found: string][] = [
        [`"007"^^${whole}`, `"007"^^${whole}`],
        ['"a b"', '"a b"'],
        [`"a"^^<${XSD}string>`, '"a"'],
        ['"hi"@en-GB', '"hi"@en-GB'],
        ["<urn:x:a>", "<urn:x:a>"],
        ['"\\u0041\\u001F\\t\\n\\"\\\\·"', '"A\\u001F\\t\\n\\"\\\\·"'],
      ];
      for (const [field, found] of terms)
        assert.deepEqual(await read(`?x\n${field}\n`), [`?x=${found}`], field);
      assert.deepEqual(await read("?x\n\n"), [""]);
      assert.deepEqual(await read("?x\n"), []);
      assert.deepEqual(
        await read('?a\t?b\n<urn:x:1>\t\n\t"y"\n<urn:x:2>\t"z"\n', ["a", "b"]),
        ["?a=<urn:x:1>", '?a=<urn:x:2> ?b="z"', '?b="y"'],
      );
      assert.deepEqual(await read("?x\t?ghost\n<urn:x:a>\t\n"), [
        "f, e: expected the variables [x], found [ghost, x]",
      ]);
      assert.deepEqual(await read("?x\n", ["x", "y"]), [
        "f, e: expected the variables [x, y], found [x]",
      ]);
      const refused: [text: string, why: RegExp][] = [
        ["?x\n_:b0\n", /_:b0, which no comparison can match exactly/],
        ["?x\n1\n", /1, which no comparison can match exactly/],
        ['?x\n"""a"""\n', /which no comparison can match exactly/],
        ['?x\n"a\\qb"\n', /whose backslash is no escape of Turtle/],
        ["?x\n<urn:x:a>", /does not end in a newline/],
        ["x\n<urn:x:a>\n", /each variable once, with a leading \?/],
        ["?x\t?x\n", /each variable once, with a leading \?/],
        ["?a\t?b\n<urn:x:a>\n", /a row has 1 fields, the header 2/],
        ["?a\n<urn:x:a>\t<urn:x:b>\n", /a row has 2 fields, the header 1/],
      ];
      for (const [text, why] of refused)
        await assert.rejects(read(text), why, text);
    } finally {
      pod.close();
      store.free?.();
    }
  });
  it("judges an ORDER BY's ties on a STR or a SUBSTR of it by that text, and on a term by SPARQL's <", () => {
    const at = (value: string): string => `"${value}"^^<${XSD}dateTime>`;
    const unzoned = at("2024-01-01T10:00:00");
    const zoned = at("2024-01-01T05:00:00-08:00");
    const whole = { start: 1, unboundEmpty: false };
    const day = { start: 1, length: 10, unboundEmpty: true };
    assert.deepEqual(
      finalOrder("SELECT ?a ?b ?c WHERE { } ORDER BY DESC(?b) ?a STR(?c) ?c", [
        "a",
        "b",
        "c",
      ]),
      [{ column: 1 }, { column: 0 }, { column: 2, read: whole }, { column: 2 }],
    );
    assert.deepEqual(
      finalOrder(
        'SELECT ?a ?b WHERE { } ORDER BY DESC(COALESCE(SUBSTR(STR(?a), 1, 10), "")) ?b',
        ["a", "b"],
      ),
      [{ column: 0, read: day }, { column: 1 }],
    );
    assert.deepEqual(
      compared(
        ["t"],
        [[zoned], [unzoned]],
        [[unzoned], [zoned]],
        [{ column: 0 }],
      ),
      [],
    );
    assert.deepEqual(
      compared(
        ["t"],
        [[zoned], [unzoned]],
        [[unzoned], [zoned]],
        [{ column: 0, read: whole }],
      ),
      [
        `the same rows in another order, from row 1: expected ?t=${zoned}, found ?t=${unzoned}`,
      ],
    );
    assert.deepEqual(
      compared(
        ["t", "u"],
        [
          [unzoned, zoned],
          [zoned, unzoned],
        ],
        [
          [zoned, unzoned],
          [unzoned, zoned],
        ],
        [{ column: 0, read: day }],
      ),
      [],
    );
    assert.notDeepEqual(
      compared(
        ["t", "u"],
        [
          [unzoned, unzoned],
          [zoned, zoned],
        ],
        [
          [zoned, zoned],
          [unzoned, unzoned],
        ],
        [
          { column: 0, read: day },
          { column: 1, read: whole },
        ],
      ),
      [],
    );
  });
});
