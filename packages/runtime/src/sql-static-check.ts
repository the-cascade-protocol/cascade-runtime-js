import { sha256 } from "hash-wasm";
import type { Assertion } from "./conformance.js";
import { type Files, readText } from "./files.js";
import { KEYED_KINDS } from "./keyed-changes.js";
import {
  LABELS,
  portedQueries,
  type Ported,
  sqlCheckTest,
  type SqlCheckOptions,
  sqlPath,
  tablesOf,
  VIEWS,
} from "./sql-check.js";
import {
  questionParts,
  sqlDatabaseFunctions,
  sqlParts,
  STATEMENTS_SCHEMA,
} from "./statements.js";

const QUERIES_FOLDER = "queries";
const PINS = "tests/sql-pins.json";
const UNPORTED = "tests/sql-unported.txt";
const MATCHER = "queries/matcher/";
const VIEW_PARTS = ["tables", "fill", "finish", "triples"];
const LABELS_PARTS = ["fill", "triples"];

/** The checks over the vocabulary's SQL as a whole, by the fragment of their test, each with the name its assertion has. */
export const SQL_STATIC_CHECKS: Readonly<Record<string, string>> = {
  "parts-in-their-order":
    "each .sql is in the parts queries/statements.sql names, in their order",
  "screen-tables-emptied":
    "each table a screen makes is emptied where the screen is filled again",
  "statistics-rows":
    "each index of the schema and of the screens, and each table with none, has a shipped statistics row",
  "pins-by-hash":
    "each ported .rq is pinned by the hash its .sql was last checked against",
  "unported-queries":
    "no .rq outside queries/matcher/ is without a .sql but those tests/sql-unported.txt names, and no .sql is without a .rq",
};

/** The checks of what the comparisons of a whole run saw, by the fragment of their test. */
export const SQL_WHOLE_RUN_CHECKS: Readonly<Record<string, string>> = {
  "each-query-gives-a-row":
    "each ported .rq gives a row on some fixture it is compared on, and each view's screen holds one on some fixture the screens are filled keyed on",
  "each-kind-of-keyed-change":
    "each kind of keyed change is made to some fixture the screens are filled on",
};

/** Each `.sql` whose parts are not those its kind has, in their order: a view's four, labels.sql's two, a question's. */
function partsFailures(ported: readonly Ported[]): string[] {
  return ported.flatMap(({ rq, sql }) => {
    const found = [...sqlParts(sql).keys()];
    const wanted = rq.startsWith(VIEWS)
      ? VIEW_PARTS
      : rq === LABELS
        ? LABELS_PARTS
        : undefined;
    if (wanted !== undefined)
      return found.join(", ") === wanted.join(", ")
        ? []
        : [
            `${sqlPath(rq)} has the parts [${found.join(", ")}], not [${wanted.join(", ")}]`,
          ];
    if (found.length === 0) return [];
    try {
      questionParts(sql);
      return [];
    } catch (error) {
      return [
        `${sqlPath(rq)}: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  });
}

/** Each table a view's tables part creates that no DELETE FROM empties in its fill or finish part. */
function emptiedFailures(ported: readonly Ported[]): string[] {
  return ported
    .filter(({ rq }) => rq.startsWith(VIEWS))
    .flatMap(({ rq, sql }) => {
      const parts = sqlParts(sql);
      const emptied = `${parts.get("fill") ?? ""}\n${parts.get("finish") ?? ""}`;
      return tablesOf(parts)
        .filter(
          (table) =>
            !new RegExp(`DELETE\\s+FROM\\s+["\`[]?${table}\\b`, "i").test(
              emptied,
            ),
        )
        .map((table) => `${rq}: ${table}`);
    });
}

/** The statistics rows the schema and each screen's tables part make, against the indexes and the tables with none. */
async function statisticsFailures(
  options: SqlCheckOptions,
  schema: string,
  ported: readonly Ported[],
): Promise<string[]> {
  const db = options.open(await sqlDatabaseFunctions());
  try {
    db.exec(schema);
    for (const { rq, sql } of ported)
      if (rq.startsWith(VIEWS)) db.exec(sqlParts(sql).get("tables") ?? "");
    const wanted = new Set<string>();
    const indexed = new Set<string>();
    for (const { tbl_name: table, name } of db
      .prepare("SELECT tbl_name, name FROM sqlite_schema WHERE type = 'index'")
      .all()) {
      wanted.add(`${String(table)} ${String(name)}`);
      indexed.add(String(table));
    }
    for (const { name, wr } of db
      .prepare(
        "SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all())
      if (Number(wr) !== 0) wanted.add(`${String(name)} ${String(name)}`);
      else if (!indexed.has(String(name))) wanted.add(`${String(name)} null`);
    const held = new Set(
      db
        .prepare("SELECT tbl, idx FROM sqlite_stat1")
        .all()
        .map(({ tbl, idx }) => `${String(tbl)} ${String(idx)}`),
    );
    return [
      ...[...wanted]
        .filter((row) => !held.has(row))
        .map((row) => `none for ${row}`),
      ...[...held]
        .filter((row) => !wanted.has(row))
        .map(
          (row) =>
            `one for ${row}, which is neither an index nor a table with none`,
        ),
    ].sort();
  } finally {
    db.close();
  }
}

/** Each ported `.rq` whose bytes hash to another than the hash pinned, and each pin of a query with no `.sql`. */
async function pinFailures(
  vocabulary: Files,
  ported: readonly Ported[],
): Promise<string[]> {
  const bytes = await vocabulary.read(PINS);
  if (bytes === undefined) return [`${PINS} is missing`];
  const pinned = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    string
  >;
  const lines: string[] = [];
  for (const { rq } of ported) {
    const digest = await sha256(
      (await vocabulary.read(rq)) ?? new Uint8Array(),
    );
    if (pinned[rq] !== digest)
      lines.push(
        `${rq}: pinned ${pinned[rq]}, its bytes hash to ${digest}; check its .sql against it, then pin ${digest}`,
      );
  }
  for (const rq of Object.keys(pinned).sort())
    if (!ported.some((each) => each.rq === rq))
      lines.push(`${rq}: pinned, but it has no .sql`);
  return lines;
}

/** Each `.rq` with no `.sql` that the list of unported queries does not name, and each fault of the list or of a `.sql`. */
async function unportedFailures(
  vocabulary: Files,
  ported: readonly Ported[],
): Promise<string[]> {
  const paths = await vocabulary.list(QUERIES_FOLDER);
  const held = new Set(paths);
  const scope = paths
    .filter((path) => path.endsWith(".rq") && !path.startsWith(MATCHER))
    .sort();
  const text =
    (await vocabulary.read(UNPORTED)) === undefined
      ? ""
      : await readText(vocabulary, UNPORTED);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const listed = new Set(lines);
  const done = new Set(ported.map(({ rq }) => rq));
  return [
    ...scope
      .filter((rq) => !done.has(rq) && !listed.has(rq))
      .map((rq) => `${rq} has no .sql and ${UNPORTED} does not name it`),
    ...[...listed]
      .filter((rq) => !scope.includes(rq))
      .map(
        (rq) => `${UNPORTED} names ${rq}, which is no .rq outside ${MATCHER}`,
      ),
    ...[...listed]
      .filter((rq) => done.has(rq))
      .map((rq) => `${UNPORTED} names ${rq}, which has its .sql`),
    ...paths
      .filter(
        (path) =>
          path.endsWith(".sql") &&
          path !== STATEMENTS_SCHEMA &&
          !held.has(`${path.slice(0, -4)}.rq`),
      )
      .map((path) => `${path} has no .rq beside it`),
    ...(lines.join("\n") === [...listed].sort().join("\n")
      ? []
      : [`${UNPORTED} is not sorted, one name on each line`]),
  ];
}

function assertionOf(
  vocabulary: Files,
  check: string,
  name: string,
  lines: readonly string[],
): Assertion {
  return {
    test: sqlCheckTest(vocabulary, check),
    name,
    outcome: lines.length === 0 ? "passed" : "failed",
    ...(lines.length === 0 ? {} : { why: lines.join("\n") }),
  };
}

/**
 * One assertion for each check over the vocabulary's SQL files themselves, that no fixture is needed for: the parts each
 * `.sql` is in, that each screen table is emptied where it is filled, the statistics rows the schema ships, the pin of each
 * ported `.rq`, and the queries with no `.sql` yet.
 */
export async function sqlStaticAssertions(
  options: SqlCheckOptions,
): Promise<Assertion[]> {
  const { vocabulary } = options;
  const schema = await vocabulary.read(STATEMENTS_SCHEMA);
  if (schema === undefined) return [];
  const ported = await portedQueries(vocabulary);
  if (ported.length === 0) return [];
  const named = (check: string, lines: readonly string[]): Assertion =>
    assertionOf(vocabulary, check, SQL_STATIC_CHECKS[check] ?? check, lines);
  let statistics: string[];
  try {
    statistics = await statisticsFailures(
      options,
      new TextDecoder().decode(schema),
      ported,
    );
  } catch (error) {
    statistics = [error instanceof Error ? error.message : String(error)];
  }
  return [
    named("parts-in-their-order", partsFailures(ported)),
    named("screen-tables-emptied", emptiedFailures(ported)),
    named("statistics-rows", statistics),
    named("pins-by-hash", await pinFailures(vocabulary, ported)),
    named("unported-queries", await unportedFailures(vocabulary, ported)),
  ];
}

/**
 * The assertions of the checks over what the comparisons of a whole run saw: that each `.rq` compared gave a row on some
 * fixture it is compared on, and, where a view is among them, that some fixture the screens are filled on made each kind
 * of keyed change. None for a run that made no comparison.
 */
export function sqlWholeRunAssertions(
  vocabulary: Files,
  assertions: readonly Assertion[],
): Assertion[] {
  const seen = (prefix: string): Set<string> =>
    new Set(
      assertions.flatMap(({ observed }) =>
        (observed ?? [])
          .filter((each) => each.startsWith(prefix))
          .map((each) => each.slice(prefix.length)),
      ),
    );
  const compared = seen("compared:");
  if (compared.size === 0) return [];
  const rows = seen("rows:");
  const kept = seen("kept:");
  const screened = seen("screen:");
  const addressed = seen("two-addresses:");
  const named = (check: string, lines: readonly string[]): Assertion =>
    assertionOf(vocabulary, check, SQL_WHOLE_RUN_CHECKS[check] ?? check, lines);
  const silent = [...compared].filter((rq) => !rows.has(rq)).sort();
  const unfilled = [...compared]
    .filter((rq) => rq.startsWith(VIEWS) && !screened.has(rq))
    .sort();
  const unaddressed = [...compared]
    .filter((rq) => rq.startsWith(VIEWS) && !addressed.has(rq))
    .sort();
  const missing = [...compared].some((rq) => rq.startsWith(VIEWS))
    ? Object.keys(KEYED_KINDS).filter((kind) => !kept.has(kind))
    : [];
  return [
    named(
      "each-query-gives-a-row",
      [
        ...(silent.length === 0
          ? []
          : [
              `each gives no row on any fixture it is compared on, so is compared with nothing: ${silent.join(", ")}`,
            ]),
        ...(unfilled.length === 0
          ? []
          : [
              `no fixture whose screens are filled keyed gives its screen a row: ${unfilled.join(", ")}`,
            ]),
        ...(unaddressed.length === 0
          ? []
          : [
              `no fixture whose screen holds entries was filled with the view at two addresses: ${unaddressed.join(", ")}`,
            ]),
      ],
    ),
    named(
      "each-kind-of-keyed-change",
      missing.length === 0
        ? []
        : [`no fixture the screens are filled on makes: ${missing.join(", ")}`],
    ),
  ];
}
