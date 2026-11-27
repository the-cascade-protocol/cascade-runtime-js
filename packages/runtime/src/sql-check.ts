import {
  answersWithARecord,
  bindsARecord,
  boundToRecords,
} from "./bound-records.js";
import { type VocabularyBuild, vocabularyBuild } from "./build.js";
import type { Assertion } from "./conformance.js";
import type { Database, DatabaseFunction, Statement } from "./database.js";
import { addLayout } from "./dataset.js";
import { type Files, MemoryFiles, readText } from "./files.js";
import { Graph } from "./graph.js";
import { keptMatcherJudgments } from "./kept.js";
import {
  keyedChanges,
  keyedKind,
  screenTables,
  undone,
} from "./keyed-changes.js";
import type { Layout } from "./layout.js";
import { lenses } from "./questions.js";
import {
  iri,
  literal,
  ntriples,
  RDF,
  type Term,
  written as ntWritten,
} from "./rdf.js";
import { References } from "./references.js";
import {
  askedOf,
  askedWhole,
  graphsOfDump,
  loadStatements,
  dayKey,
  instantKey,
  parsedNt,
  sqlAnswer,
  sqlDatabaseFunctions,
  sqlFunctions,
  SqlFunctionRefused,
  sqlNt,
  sqlParts,
  sqlStatements,
  sqlTermOf,
  SQL_FUNCTION_VECTORS,
  STATEMENTS_SCHEMA,
  LITERAL,
  BLANK,
  IRI,
  sparqlCompare,
  wholeScope,
} from "./statements.js";
import {
  RestorableUnion,
  type Store,
  type StoreFactory,
  Union,
} from "./store.js";

/** The address a fixture's files are read under, as the vocabulary's tests read them. */
export const FIXTURE_ADDRESS = "https://pod.example/";
export const FIXTURES = "tests/fixtures/";
const QUERIES = "queries/";
const MATCHER = "queries/matcher/";
const LENSES = "queries/lenses/";
export const VIEWS = "queries/views/";
const QUESTIONS = "queries/questions/";
export const LABELS = "queries/labels.rq";
const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const WRITTEN_BY = "https://ns.cascadeprotocol.org/cascade#writtenByQueryPath";
const INSTANCE = "http://www.w3.org/ns/solid/terms#instance";
const MF = "http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#";
const QT = "http://www.w3.org/2001/sw/DataAccess/tests/test-query#";
const CTM = "https://ns.cascadeprotocol.org/test-manifest#";
const SPECIALIZATION_OF = "http://www.w3.org/ns/prov#specializationOf";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const XSD_STRING = `${XSD}string`;
const SCREEN_PARTS = ["tables", "fill", "finish"] as const;

/** One row of an answer: each column's term as N-Triples, or null where unbound. */
export type Row = readonly (string | null)[];

/** A query of the vocabulary's with a `.sql` beside it. */
export interface Ported {
  /** The `.rq`'s path in the vocabulary. */
  readonly rq: string;
  readonly rqText: string;
  readonly sql: string;
}

interface ManifestEntry {
  readonly name: string;
  readonly query?: string;
  readonly lens?: string;
  readonly result?: string;
  readonly records: readonly string[];
}

/** A fixture built under a lens, the runtime's store holding it, and the statements loaded from it into SQLite. */
export interface BuiltFixture {
  readonly name: string;
  readonly lens: string;
  readonly union: Union;
  readonly db: Database;
  readonly entries: readonly ManifestEntry[];
  /** Why each ported `.sql` that cannot be answered cannot, by its `.rq`'s path: a screen that failed, or reads one. */
  readonly screens: ReadonlyMap<string, string>;
  /** Whether the manifest names `queries/views/`, so that the screens are filled keyed over the fixture too. */
  readonly screensFilled: boolean;
  /** Fills every screen again for the entries in scope: each view's fill, the labels, then each view's finish. */
  refill(): void;
  close(): void;
}

export interface SqlCheckOptions {
  readonly vocabulary: Files;
  readonly newStore: StoreFactory;
  readonly layout: Layout;
  /** An empty database in memory, with the functions given registered. */
  readonly open: (functions: readonly DatabaseFunction[]) => Database;
}

const decoded = (
  vocabulary: Files,
  value: string | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : value.startsWith(vocabulary.iri)
      ? decodeURIComponent(value.slice(vocabulary.iri.length))
      : value;

/** Each `.rq` outside `queries/matcher/` with a `.sql` beside it, sorted by path. */
export async function portedQueries(vocabulary: Files): Promise<Ported[]> {
  const paths = await vocabulary.list(QUERIES.slice(0, -1));
  const held = new Set(paths);
  const found: Ported[] = [];
  for (const rq of paths
    .filter((path) => path.endsWith(".rq") && !path.startsWith(MATCHER))
    .sort()) {
    const sql = `${rq.slice(0, -3)}.sql`;
    if (held.has(sql))
      found.push({
        rq,
        rqText: await readText(vocabulary, rq),
        sql: await readText(vocabulary, sql),
      });
  }
  return found;
}

/** The names of the vocabulary's fixtures, each a folder of `tests/fixtures/` with a manifest. */
export async function fixtureNames(vocabulary: Files): Promise<string[]> {
  return [
    ...new Set(
      (await vocabulary.list(FIXTURES.slice(0, -1)))
        .filter((path) => path.endsWith("/manifest.ttl"))
        .map((path) => path.slice(FIXTURES.length, -"/manifest.ttl".length))
        .filter((name) => !name.includes("/")),
    ),
  ].sort();
}

/** A fixture's manifest: its entries, and each query file or folder of them it names by ctm:comparesSqlWithSparqlUnderEveryLens. */
async function manifestOf(
  vocabulary: Files,
  fixture: string,
  store: Store,
): Promise<{
  entries: ManifestEntry[];
  comparesSqlWithSparqlUnderEveryLens: string[];
}> {
  const path = `${FIXTURES}${fixture}/manifest.ttl`;
  const graph = new Graph(
    await store.parse(await readText(vocabulary, path), vocabulary.iri + path),
  );
  const [head] = graph.subjects(`${RDF}type`, iri(`${MF}Manifest`));
  const comparesSqlWithSparqlUnderEveryLens =
    head === undefined
      ? []
      : graph
          .objects(head, `${CTM}comparesSqlWithSparqlUnderEveryLens`)
          .flatMap(({ value }) => decoded(vocabulary, value) ?? []);
  const found: ManifestEntry[] = [];
  let list: Term | undefined =
    head === undefined ? undefined : graph.objects(head, `${MF}entries`)[0];
  while (list !== undefined && list.value !== `${RDF}nil`) {
    const entry = graph.objects(list, `${RDF}first`)[0];
    list = graph.objects(list, `${RDF}rest`)[0];
    if (entry === undefined) continue;
    const action = graph.objects(entry, `${MF}action`)[0];
    const one = (
      subject: Term | undefined,
      predicate: string,
    ): string | undefined =>
      subject === undefined
        ? undefined
        : graph.objects(subject, predicate)[0]?.value;
    found.push({
      name: one(entry, `${MF}name`) ?? entry.value,
      query: decoded(vocabulary, one(action, `${QT}query`)),
      lens: decoded(vocabulary, one(action, `${CTM}lensQueryPath`)),
      result: decoded(vocabulary, one(entry, `${MF}result`)),
      records:
        action === undefined
          ? []
          : graph
              .objects(action, `${CTM}boundRecord`)
              .map(({ value }) => value)
              .sort(),
    });
  }
  return { entries: found, comparesSqlWithSparqlUnderEveryLens };
}

/**
 * The comparisons the fixtures' manifests choose, by fixture: each ported `.rq` compared with its `.sql` over the
 * fixture, with the lenses it is compared under. A manifest chooses a `.rq` under each lens where it names the `.rq`, or
 * a folder holding it, by ctm:comparesSqlWithSparqlUnderEveryLens, and otherwise under the lens of each of its entries that runs the `.rq`.
 * A fixture that chooses none is left out. Of the fixtures given, or of all of them, and of the queries given, or of all of them.
 */
export async function sqlComparisons(
  vocabulary: Files,
  newStore: StoreFactory,
  ported?: readonly Ported[],
  fixtures?: readonly string[],
  only?: readonly string[],
  /** Told, by fixture, each file or folder its manifest names by ctm:comparesSqlWithSparqlUnderEveryLens. */
  named?: Map<string, readonly string[]>,
): Promise<Map<string, Map<string, string[]>>> {
  const queries = (ported ?? (await portedQueries(vocabulary)))
    .map(({ rq }) => rq)
    .filter((rq) => only === undefined || only.includes(rq));
  const every = await lenses(vocabulary);
  const chosen = new Map<string, Map<string, string[]>>();
  const store = newStore();
  try {
    for (const fixture of fixtures ?? (await fixtureNames(vocabulary))) {
      const { entries, comparesSqlWithSparqlUnderEveryLens } = await manifestOf(
        vocabulary,
        fixture,
        store,
      );
      const here = new Map<string, string[]>();
      named?.set(fixture, comparesSqlWithSparqlUnderEveryLens);
      for (const rq of queries) {
        const underEveryLens = comparesSqlWithSparqlUnderEveryLens.some(
          (path) => path === rq || (path.endsWith("/") && rq.startsWith(path)),
        );
        const under = underEveryLens
          ? every
          : every.filter((lens) =>
              entries.some(
                (entry) => entry.query === rq && lensOf(entry.lens) === lens,
              ),
            );
        if (under.length > 0) here.set(rq, under);
      }
      if (here.size > 0) chosen.set(fixture, here);
    }
  } finally {
    store.free?.();
  }
  return chosen;
}

/** The test of a `.sql` that no fixture's manifest chooses: the `.sql`, and in its fragment the `.sql` again. */
const unchosenSqlTest = (vocabulary: Files, rq: string): string =>
  `${vocabulary.iri}${encodeURI(sqlPath(rq))}#${encodeURI(sqlPath(rq))}`;

/** The test of a check over the vocabulary's SQL as a whole: the schema, and in its fragment the check. */
export const sqlCheckTest = (vocabulary: Files, check: string): string =>
  `${vocabulary.iri}${STATEMENTS_SCHEMA}#${check}`;

export const MANIFESTS_CHECK = "manifests-name-only-ported-queries";

/**
 * A failed assertion for each ported `.sql` that no fixture's manifest chooses, so that none goes uncompared, and one
 * assertion that no manifest names by ctm:comparesSqlWithSparqlUnderEveryLens a file that is no ported `.rq`, or a folder
 * holding none, which would choose nothing for any fixture, silently.
 */
export async function unchosenSqlAssertions(
  options: Pick<SqlCheckOptions, "vocabulary" | "newStore">,
): Promise<Assertion[]> {
  const { vocabulary, newStore } = options;
  if ((await vocabulary.read(STATEMENTS_SCHEMA)) === undefined) return [];
  const ported = await portedQueries(vocabulary);
  const named = new Map<string, readonly string[]>();
  const chosen = await sqlComparisons(
    vocabulary,
    newStore,
    ported,
    undefined,
    undefined,
    named,
  );
  const lines = [...named]
    .flatMap(([fixture, paths]) =>
      paths
        .filter(
          (path) =>
            !ported.some(({ rq }) =>
              path.endsWith("/") ? rq.startsWith(path) : rq === path,
            ),
        )
        .map((path) => `${fixture}: ${path}`),
    )
    .sort();
  return [
    ...unchosen(vocabulary, ported, chosen),
    {
      test: sqlCheckTest(vocabulary, MANIFESTS_CHECK),
      name: "each manifest names by ctm:comparesSqlWithSparqlUnderEveryLens only a .rq with a .sql beside it, or a folder holding one",
      outcome: lines.length === 0 ? "passed" : "failed",
      ...(lines.length === 0
        ? {}
        : {
            why: `each names a file or folder that chooses nothing: ${lines.join(", ")}`,
          }),
    },
  ];
}

function unchosen(
  vocabulary: Files,
  ported: readonly Ported[],
  comparisons: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
): Assertion[] {
  const chosen = new Set(
    [...comparisons.values()].flatMap((queries) => [...queries.keys()]),
  );
  return ported
    .filter(({ rq }) => !chosen.has(rq))
    .map(({ rq }): Assertion => ({
      test: unchosenSqlTest(vocabulary, rq),
      name: `${sqlPath(rq)} is compared over no fixture`,
      outcome: "failed",
      why: `no fixture's manifest names ${rq}, or a folder holding it, by ctm:comparesSqlWithSparqlUnderEveryLens, or runs it in an entry`,
    }));
}

/** A store's dump of the TriG, each of its graphs listed, for `restore`: so its graphs are outside any union. */
async function restoredTrig(
  store: Store,
  newStore: StoreFactory,
  trig: string,
): Promise<void> {
  const body = new TextEncoder().encode(trig);
  const dumped = (graphs: readonly string[]): Uint8Array => {
    const head = new TextEncoder().encode(
      `# ${JSON.stringify({ graphs, length: body.length })}\n`,
    );
    const bytes = new Uint8Array(head.length + body.length);
    bytes.set(head);
    bytes.set(body, head.length);
    return bytes;
  };
  const scratch = newStore();
  let graphs: string[];
  try {
    await scratch.restore(dumped([]));
    const { rows } = await scratch.select(
      "SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }",
      new Set(),
    );
    graphs = rows.flatMap((row) => row.get("g")?.value ?? []);
  } finally {
    scratch.free?.();
  }
  await store.restore(dumped(graphs));
}

interface Context extends SqlCheckOptions {
  readonly build: VocabularyBuild;
  readonly schema: string;
  readonly functions: readonly DatabaseFunction[];
  readonly ported: readonly Ported[];
}

/**
 * The fixture as the runtime builds a pod under the lens: each Turtle file a graph named by the address and its path,
 * each TriG file's graphs outside the union, the lens's derivations with the Sames M7 keeps (a version whose rows no
 * TriG file holds joins nothing), the files the layout's queries write, and the layout; then its union's graphs loaded
 * into SQLite and each ported view's screen made.
 */
async function builtFixture(
  context: Context,
  fixture: string,
  lens: string,
): Promise<BuiltFixture> {
  const { vocabulary, newStore, layout, build } = context;
  const folder = `${FIXTURES}${fixture}/`;
  const paths = await vocabulary.list(folder.slice(0, -1));
  const store = newStore();
  try {
    const trig = paths.filter((path) => path.endsWith(".trig"));
    if (trig.length > 0)
      await restoredTrig(
        store,
        newStore,
        (
          await Promise.all(
            trig.map(
              async (path) =>
                `@base <${FIXTURE_ADDRESS}${path.slice(path.lastIndexOf("/") + 1)}> .\n${await readText(vocabulary, path)}\n`,
            ),
          )
        ).join(""),
      );
    const union = new Union(store);
    const files = await Promise.all(
      paths
        .filter(
          (path) => path.endsWith(".ttl") && path !== `${folder}manifest.ttl`,
        )
        .map(async (path) => ({
          graph: FIXTURE_ADDRESS + path.slice(folder.length),
          turtle: new TextEncoder().encode(await readText(vocabulary, path)),
        })),
    );
    await union.loadFiles(files);
    await build.derivations.derive(union, lens, async (held) => {
      const index = new MemoryFiles("urn:cascade:fixture-tables/");
      const versions = await held.construct(
        `CONSTRUCT { ?version <${SPECIALIZATION_OF}> ?series } WHERE { ?version <${SPECIALIZATION_OF}> ?series FILTER EXISTS { GRAPH ?version { ?s ?p ?o } } }`,
      );
      await index.write("references.ttl", ntriples(versions));
      const tables = References.of(index, "", newStore);
      return keptMatcherJudgments(held, {
        vocabulary,
        newStore,
        references: () => tables,
      });
    });
    await build.queried(union, FIXTURE_ADDRESS);
    await addLayout(union, layout, FIXTURE_ADDRESS);
    const db = context.open(context.functions);
    try {
      loadStatements(
        db,
        context.schema,
        graphsOfDump(await store.dump(), union.graphs),
        `${fixture} under ${lens}`,
      );
      if (labelsOf(context.ported) !== undefined) unlabelled(db);
    } catch (error) {
      db.close();
      throw error;
    }
    const manifest = await manifestOf(vocabulary, fixture, store);
    const compiled = new Map<string, Statement>();
    return {
      name: fixture,
      lens,
      union,
      db,
      entries: manifest.entries,
      screens: madeScreens(db, context.ported),
      screensFilled:
        manifest.comparesSqlWithSparqlUnderEveryLens.includes(VIEWS),
      refill: () => refilled(db, context.ported, compiled),
      close: () => {
        db.close();
        store.free?.();
      },
    };
  } catch (error) {
    store.free?.();
    throw error;
  }
}

export const sqlPath = (rq: string): string => `${rq.slice(0, -3)}.sql`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The tables a view's `tables` part makes. */
export function tablesOf(parts: ReadonlyMap<string, string>): string[] {
  return [
    ...(parts.get("tables") ?? "").matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/gi,
    ),
  ].flatMap((found) => found[1] ?? []);
}

/** Each view's `.sql` under `queries/views/` with its parts: a screen each. */
function viewsOf(
  ported: readonly Ported[],
): { query: Ported; parts: ReadonlyMap<string, string> }[] {
  return ported
    .filter(({ rq }) => rq.startsWith(VIEWS))
    .map((query) => ({ query, parts: sqlParts(query.sql) }))
    .filter(({ parts }) => parts.size > 0);
}

/** labels.sql's parts, where it is ported in parts. */
function labelsOf(
  ported: readonly Ported[],
): ReadonlyMap<string, string> | undefined {
  const found = ported.find(({ rq }) => rq === LABELS);
  const parts = found === undefined ? undefined : sqlParts(found.sql);
  return parts === undefined || parts.size === 0 ? undefined : parts;
}

const LABELS_FILE =
  "SELECT g.id AS id FROM quad w JOIN quad x ON x.s = w.s JOIN term i ON i.id = x.o JOIN term g ON g.nt = '<' || i.lex || '>' " +
  "WHERE w.p = (SELECT id FROM term WHERE nt = ?) AND w.o = (SELECT id FROM term WHERE nt = ?) " +
  "AND x.p = (SELECT id FROM term WHERE nt = ?)";

/** The graph of the file the layout says labels.rq writes, or none where the pod holds no layout of it. */
function labelsFile(db: Database): number | undefined {
  const found = db
    .prepare(LABELS_FILE)
    .get(`<${WRITTEN_BY}>`, '"labels.rq"', `<${INSTANCE}>`)?.id;
  return found === undefined ? undefined : Number(found);
}

/** Takes the labels file's rdfs:label statements out of the pod; its other statements stay. */
function unlabelled(db: Database): void {
  const file = labelsFile(db);
  if (file === undefined) return;
  db.prepare(
    "DELETE FROM quad WHERE g = ? AND p = (SELECT id FROM term WHERE nt = ?)",
  ).run(file, `<${LABEL}>`);
}

/** Gives the id of the term the N-Triples text writes, made where the pod has none, from statements prepared once. */
function termIdsOf(db: Database): (nt: string) => number {
  const find = db.prepare("SELECT id FROM term WHERE nt = ?");
  const make = db.prepare(
    "INSERT INTO term (nt, kind, lex, datatype, lang, instant, day) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  return (nt) => {
    const held = find.get(nt)?.id;
    if (held !== undefined) return Number(held);
    const term = parsedNt(nt);
    make.run(
      nt,
      term.kind,
      term.kind === BLANK ? null : term.value,
      term.datatype ?? null,
      term.lang ?? null,
      instantKey(term),
      dayKey(term),
    );
    return Number(find.get(nt)?.id);
  };
}

/**
 * The labels file's rdfs:label statements made again from labels.sql, as a runtime writes the file: its `fill` run, the
 * file's labels deleted and its `triples` rows put in the file's graph, in one transaction. Left as it is where the pod has
 * no such graph.
 */
function labelled(
  db: Database,
  labels: ReadonlyMap<string, string>,
  run: (script: string) => void = (script) => db.exec(script),
): void {
  const file = labelsFile(db);
  if (file === undefined) return;
  run(labels.get("fill") ?? "");
  const { rows } = sqlAnswer(db, labels.get("triples") ?? "");
  const termId = termIdsOf(db);
  const clear = db.prepare(
    "DELETE FROM quad WHERE g = ? AND p = (SELECT id FROM term WHERE nt = ?)",
  );
  const put = db.prepare(
    "INSERT OR IGNORE INTO quad (s, p, o, g) VALUES (?, ?, ?, ?)",
  );
  db.transaction(() => {
    clear.run(file, `<${LABEL}>`);
    for (const [s, p, o] of rows) {
      if (s == null || p == null || o == null)
        throw new Error("labels.sql gives a triple with an unbound term");
      put.run(termId(s), termId(p), termId(o), file);
    }
  });
}

/**
 * Makes and fills each view's screen, every view's `tables`, then every `fill`, then the labels from labels.sql, then
 * every `finish`, and gives why each ported `.sql` that cannot be answered cannot, by its `.rq`'s path: a view whose part
 * throws, named with the part, its later parts not run; labels.sql where its labels cannot be made; and a `.sql` that
 * reads a table of a screen that failed. The other screens are made whole. Only a view under `queries/views/` is a
 * screen. `spent` is told the seconds each part of a view, and of the labels, took, by the `.rq`'s path, so that a caller
 * can say what making each screen cost.
 */
export function madeScreens(
  db: Database,
  ported: readonly Ported[],
  spent?: (rq: string, seconds: number) => void,
): Map<string, string> {
  const failed = new Map<string, string>();
  const thrown = new Set<string>();
  const views = viewsOf(ported).map((view) => ({
    ...view,
    tables: tablesOf(view.parts),
  }));
  const labels = labelsOf(ported);
  const readsFailed = (text: string, self: string): string | undefined =>
    views.find(
      ({ query, tables }) =>
        query.rq !== self &&
        thrown.has(query.rq) &&
        tables.some((table) => new RegExp(`\\b${table}\\b`).test(text)),
    )?.query.rq;
  const reading = (rq: string, read: string): void => {
    failed.set(
      rq,
      `reads the screen of ${sqlPath(read)}, which fails: ${failed.get(read) ?? ""}`,
    );
  };
  for (const part of SCREEN_PARTS) {
    for (const { query, parts } of views) {
      if (failed.has(query.rq)) continue;
      const read = readsFailed(query.sql, query.rq);
      if (read !== undefined) {
        reading(query.rq, read);
        continue;
      }
      const started = performance.now();
      try {
        db.exec(parts.get(part) ?? "");
      } catch (error) {
        thrown.add(query.rq);
        failed.set(
          query.rq,
          `the screen of ${sqlPath(query.rq)} fails in its ${part} part: ${messageOf(error)}`,
        );
      }
      spent?.(query.rq, (performance.now() - started) / 1000);
    }
    if (part !== "fill" || labels === undefined || failed.has(LABELS)) continue;
    const read = readsFailed(
      ported.find(({ rq }) => rq === LABELS)?.sql ?? "",
      LABELS,
    );
    if (read !== undefined) {
      reading(LABELS, read);
      continue;
    }
    const started = performance.now();
    try {
      labelled(db, labels);
    } catch (error) {
      failed.set(
        LABELS,
        `the labels of ${sqlPath(LABELS)} cannot be made: ${messageOf(error)}`,
      );
    }
    spent?.(LABELS, (performance.now() - started) / 1000);
  }
  for (const { rq, sql } of ported) {
    if (failed.has(rq)) continue;
    const read = readsFailed(sql, rq);
    if (read !== undefined) reading(rq, read);
  }
  return failed;
}

/**
 * Fills each view's screen again for the entries in scope: every view's fill, then the labels, then every view's finish,
 * each statement compiled once in `compiled`, as a runtime that fills keyed runs often does.
 */
function refilled(
  db: Database,
  ported: readonly Ported[],
  compiled: Map<string, Statement>,
): void {
  const views = viewsOf(ported);
  const labels = labelsOf(ported);
  const run = (script: string): void => {
    for (const text of sqlStatements(script)) {
      let statement = compiled.get(text);
      if (statement === undefined)
        compiled.set(text, (statement = db.prepare(text)));
      statement.run();
    }
  };
  for (const part of ["fill", "finish"]) {
    for (const { parts } of views) run(parts.get(part) ?? "");
    if (part === "fill" && labels !== undefined) labelled(db, labels, run);
  }
}

const CASCADE = "https://ns.cascadeprotocol.org/cascade#";

const CONSTRUCT_FORM = /^\s*CONSTRUCT\b/i;

export function isConstruct(text: string): boolean {
  return CONSTRUCT_FORM.test(
    text.replace(/^\s*(#.*|PREFIX\s.*|BASE\s.*)$/gm, ""),
  );
}

const ntOf = (term: Term | undefined): string | null =>
  term === undefined ? null : sqlNt(sqlTermOf(term));

/** What the `.rq` gives over the union, bound to the record if one is given: its columns and rows. */
export async function rqAnswer(
  union: Union,
  text: string,
  record?: string,
): Promise<{ names: readonly string[]; rows: Row[] }> {
  if (isConstruct(text))
    return {
      names: ["s", "p", "o"],
      rows: (await union.construct(text)).map((triple) =>
        triple.map((term) => ntOf(term)),
      ),
    };
  const { variables, rows } = await union.select(
    record === undefined ? text : boundToRecords(text, [record]),
  );
  return {
    names: variables,
    rows: rows.map((row) => variables.map((name) => ntOf(row.get(name)))),
  };
}

/**
 * How an ORDER BY condition reads its variable where it orders by its STR: the position, from 1, its text is taken
 * from, the length taken or none for the rest, and whether an unbound value reads as "", as in
 * DESC(COALESCE(SUBSTR(STR(?a), 1, 10), "")).
 */
export interface TextRead {
  readonly start: number;
  readonly length?: number;
  readonly unboundEmpty: boolean;
}

/**
 * A key the rows are ordered by: the columns whose first bound value it orders by, and how its condition reads that
 * value, or none where it orders the term itself.
 */
export interface OrderKey {
  readonly columns: readonly number[];
  readonly read?: TextRead;
}

function readAsText(condition: string): TextRead | undefined {
  if (!/\bSTR\s*\(\s*\?\w+\s*\)/.test(condition)) return undefined;
  const cut =
    /SUBSTR\s*\(\s*STR\s*\(\s*\?\w+\s*\)\s*,\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/.exec(
      condition,
    );
  return {
    start: cut === null ? 1 : Number(cut[1]),
    ...(cut?.[2] === undefined ? {} : { length: Number(cut[2]) }),
    unboundEmpty: /,\s*""\s*\)/.test(condition),
  };
}

/** The text a condition reading its variable as text orders the term by; null where it reads none. */
function asText(term: string | null, read: TextRead): string | null {
  const parsed = term === null ? undefined : parsedNt(term);
  let text =
    parsed === undefined || parsed.kind === BLANK
      ? null
      : Array.from(parsed.value)
          .slice(
            read.start - 1,
            read.length === undefined
              ? undefined
              : read.start - 1 + read.length,
          )
          .join("");
  if (text === null && read.unboundEmpty) text = "";
  return text;
}

const FIRST_BOUND = /COALESCE\s*\(\s*(\?\w+(?:\s*,\s*\?\w+)*)\s*\)/;

/**
 * The keys the query's rows are ordered by, after its last brace, one for each condition of its ORDER BY, each the
 * columns whose first bound value it orders by and how it reads that: a condition is a projected variable, or a COALESCE
 * of projected variables, alone or in an expression of it and of no other variable, such as DESC(COALESCE(STR(?a), ""))
 * or COALESCE(SUBSTR(STR(COALESCE(?a, ?b)), 1, 10), ""). None when the query has no ORDER BY there; a condition that is
 * not one of these is refused, naming it, never a key left out.
 */
export function finalOrder(
  text: string,
  names: readonly string[],
): OrderKey[] | undefined {
  const tail = text.slice(text.lastIndexOf("}"));
  const clause = /ORDER\s+BY\s/.exec(tail);
  if (clause === null) return undefined;
  let rest = tail.slice(clause.index + clause[0].length).trim();
  const keys: OrderKey[] = [];
  const refused = (condition: string): Error =>
    new Error(`no key can be read from the ORDER BY condition ${condition}`);
  while (rest !== "") {
    let condition: string;
    const variable = /^\?(\w+)/.exec(rest);
    if (variable !== null) condition = variable[0];
    else {
      const call = /^\w+\s*\(/.exec(rest);
      if (call === null) throw refused(rest.split(/\s/)[0] ?? "");
      let depth = 0;
      let at = call[0].length - 1;
      for (; at < rest.length; at += 1) {
        depth += rest[at] === "(" ? 1 : rest[at] === ")" ? -1 : 0;
        if (depth === 0) break;
      }
      condition = rest.slice(0, at + 1);
    }
    const coalesced = FIRST_BOUND.exec(condition);
    const shape =
      coalesced === null ? condition : condition.replace(FIRST_BOUND, "?_");
    const others = new Set(
      [...shape.replace(/"[^"]*"/g, "").matchAll(/\?(\w+)/g)].map(
        (found) => found[1] ?? "",
      ),
    );
    const found =
      coalesced === null
        ? [...others].sort()
        : [...(coalesced[1] ?? "").matchAll(/\w+/g)].map((word) => word[0]);
    if (
      others.size !== 1 ||
      (coalesced !== null && !others.has("_")) ||
      !found.every((name) => names.includes(name))
    )
      throw refused(condition);
    const read = readAsText(shape);
    keys.push({
      columns: found.map((name) => names.indexOf(name)),
      ...(read === undefined ? {} : { read }),
    });
    rest = rest.slice(condition.length).trim();
  }
  return keys;
}

/** Whether an ORDER BY may put two terms either way round. */
function tied(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const a = parsedNt(left);
  const b = parsedNt(right);
  if (a.kind !== b.kind || a.kind === IRI) return false;
  if (a.kind === BLANK) return true;
  try {
    const found = sparqlCompare(left, right);
    return found === null || found === 0;
  } catch (error) {
    if (error instanceof SqlFunctionRefused) return true;
    throw error;
  }
}

/**
 * Whether an ORDER BY of the keys puts the two rows one way round: the first key whose value differs, a text a
 * condition reads or else the term, holds two texts, or two terms SPARQL's `<` orders.
 */
function ordered(one: Row, other: Row, keys: readonly OrderKey[]): boolean {
  const bound = (row: Row, columns: readonly number[]): string | null =>
    columns
      .map((column) => row[column] ?? null)
      .find((term) => term !== null) ?? null;
  for (const { columns, read } of keys) {
    const a = bound(one, columns);
    const b = bound(other, columns);
    if (read !== undefined) {
      if (asText(a, read) !== asText(b, read)) return true;
    } else if (a !== b) return !tied(a, b);
  }
  return false;
}

function runs(found: readonly Row[], keys: readonly OrderKey[]): number[] {
  const lengths = found.length > 0 ? [1] : [];
  for (let at = 0; at + 1 < found.length; at += 1)
    if (ordered(found[at] ?? [], found[at + 1] ?? [], keys)) lengths.push(1);
    else lengths.push((lengths.pop() ?? 0) + 1);
  return lengths;
}

const shown = (names: readonly string[], row: Row): string =>
  names
    .flatMap((name, at) =>
      row[at] === null || row[at] === undefined ? [] : [`?${name}=${row[at]}`],
    )
    .join(" ");

const rowKey = (row: Row): string => JSON.stringify(row);

export function counted(
  rows: readonly Row[],
): Map<string, { row: Row; count: number }> {
  const found = new Map<string, { row: Row; count: number }>();
  for (const row of rows) {
    const key = rowKey(row);
    const held = found.get(key);
    if (held === undefined) found.set(key, { row, count: 1 });
    else held.count += 1;
  }
  return found;
}

/** The rows of `from` that `less` does not have, as many times as it lacks them. */
function lacking(from: readonly Row[], less: readonly Row[]): Row[] {
  const held = counted(less);
  const out: Row[] = [];
  for (const { row, count } of counted(from).values())
    for (let n = count - (held.get(rowKey(row))?.count ?? 0); n > 0; n -= 1)
      out.push(row);
  return out;
}

const written = (row: Row): string =>
  row.map((value) => value ?? "").join("\u0000");

/**
 * Why the rows found are not the rows wanted, as lines, or none: as multisets, and, given an ORDER BY's key columns,
 * as the same runs of rows those keys order, in the same order, each run a multiset.
 */
export function compared(
  names: readonly string[],
  wanted: readonly Row[],
  found: readonly Row[],
  keys?: readonly OrderKey[],
): string[] {
  const sorted = (rows: Row[]): Row[] =>
    rows.sort((a, b) =>
      written(a) < written(b) ? -1 : written(a) > written(b) ? 1 : 0,
    );
  const lines = [
    ...sorted(lacking(wanted, found)).map(
      (row) => `missing: ${shown(names, row)}`,
    ),
    ...sorted(lacking(found, wanted)).map(
      (row) => `unexpected: ${shown(names, row)}`,
    ),
  ];
  if (lines.length > 0 || keys === undefined) return lines;
  let at = 0;
  for (const length of runs(wanted, keys)) {
    const run = wanted.slice(at, at + length);
    const got = found.slice(at, at + length);
    if (lacking(run, got).length > 0) {
      const runKeys = new Set(run.map(rowKey));
      let wrong = at;
      for (let i = at; i < at + length; i += 1)
        if (!runKeys.has(rowKey(found[i] ?? []))) {
          wrong = i;
          break;
        }
      return [
        `the same rows in another order, from row ${wrong + 1}: expected ${run.map((row) => shown(names, row)).join(" or ")}, found ${shown(names, found[wrong] ?? [])}`,
      ];
    }
    at += length;
  }
  return lines;
}

const PAGED = /:page_size\b/;

/** A list question's whole list, or its page of `pageSize` entries after a key: its rows and each row's `page_key`. */
export function paged(
  db: Database,
  sql: string,
  pageSize: number | null,
  after: string | null,
): { rows: Row[]; keys: (string | null)[] } {
  const { rows, keys } = sqlAnswer(db, sql, { page_size: pageSize, after });
  return { rows: [...rows], keys: [...(keys ?? rows.map(() => null))] };
}

/** The `.sql`'s answer as its `.rq`'s: a view's through its `triples` part, a list question's whole, `page_key` dropped. */
export function sqlRows(
  db: Database,
  sql: string,
): { columns: readonly string[]; rows: Row[] } {
  const triples = sqlParts(sql).get("triples");
  const { columns, rows } =
    triples !== undefined
      ? sqlAnswer(db, triples)
      : PAGED.test(sql)
        ? sqlAnswer(db, sql, { page_size: null, after: null })
        : sqlAnswer(db, sql);
  return { columns, rows: [...rows] };
}

/**
 * Why a list question's pages do not give its whole list: a row with no `page_key`, keys out of order, a page of more
 * entries than its size or not after the key it was asked after, or pages of one entry and of two, each asked after the
 * last row's key, that do not join to the whole list's rows and keys in its order.
 */
function pageFailures(db: Database, sql: string): string[] {
  const whole = paged(db, sql, null, null);
  if (whole.keys.some((key) => key === null)) return ["it gives no page_key"];
  const keys = whole.keys as string[];
  const lines: string[] = [];
  if (keys.some((key, at) => at > 0 && key < (keys[at - 1] ?? "")))
    lines.push("its page keys are not in order");
  const wanted = whole.rows.map((row, at) =>
    rowKey([...row, keys[at] ?? null]),
  );
  for (const size of [1, 2]) {
    const joined: string[] = [];
    let after: string | null = null;
    let wrong: string | undefined;
    for (let asked = 0; asked <= keys.length; asked += 1) {
      const page = paged(db, sql, size, after);
      if (page.rows.length === 0) break;
      const first = page.keys[0] ?? "";
      if (
        new Set(page.keys).size > size ||
        (after !== null && first <= after)
      ) {
        wrong = `a page of ${size} after ${JSON.stringify(after)} gives the keys ${JSON.stringify(page.keys)}`;
        break;
      }
      joined.push(
        ...page.rows.map((row, at) => rowKey([...row, page.keys[at] ?? null])),
      );
      after = page.keys.at(-1) ?? null;
    }
    if (wrong !== undefined) {
      lines.push(wrong);
      continue;
    }
    if (JSON.stringify(joined) !== JSON.stringify(wanted)) {
      const at = joined.findIndex((row, i) => row !== wanted[i]);
      lines.push(
        `pages of ${size} give ${joined.length} rows, the whole list ${wanted.length}, the first apart at row ${(at < 0 ? Math.min(joined.length, wanted.length) : at) + 1}`,
      );
    }
  }
  return lines;
}

/**
 * The `.sql`'s rows asked of each record in turn, `asked` holding it alone, as a runtime asks a question bound to it;
 * a record the pod does not hold gives no rows, the `.sql` not run, since an empty `asked` is the whole pod. The
 * question is asked of the whole pod again after.
 */
export function askedRows(
  db: Database,
  sql: string,
  records: readonly string[],
): Row[] {
  const found: Row[] = [];
  try {
    for (const record of records)
      if (askedOf(db, [record])) found.push(...sqlRows(db, sql).rows);
  } finally {
    askedWhole(db);
  }
  return found;
}

/** Each record the pod puts in an entry, as its IRI. */
export function recordsInEntries(db: Database): string[] {
  return db
    .prepare(
      "SELECT DISTINCT t.lex FROM quad q JOIN term t ON t.id = q.s " +
        "WHERE q.p = (SELECT id FROM term WHERE nt = ?) AND t.kind = 2 ORDER BY t.lex",
    )
    .all(`<${CASCADE}inEntry>`)
    .map(({ lex }) => String(lex));
}

/** Each record the pod holds, as its IRI: those in an entry, and those left out of every view too. */
export function recordsOfThePod(db: Database): string[] {
  return db
    .prepare(
      "SELECT DISTINCT t.lex FROM quad q JOIN term t ON t.id = q.s " +
        "WHERE q.p = (SELECT id FROM term WHERE nt = ?) AND q.o = (SELECT id FROM term WHERE nt = ?) " +
        "AND t.kind = 2 ORDER BY t.lex",
    )
    .all(`<${RDF}type>`, `<${CASCADE}Record>`)
    .map(({ lex }) => String(lex));
}

/** A record no pod holds, which a question bound to records is also asked of: it gives no rows. */
const NO_SUCH_RECORD = "urn:cascade:no-such-record";

/** An answer file's field: an IRI in angle brackets, or a double-quoted string with a `^^<datatype>` or an `@language`. */
const TSV_TERM =
  // eslint-disable-next-line no-control-regex
  /^(?:<([^\x00-\x20<>"{}|^`\\]*)>|"((?:[^"\\\n\r]|\\[^\n])*)"(?:@([A-Za-z]+(?:-[A-Za-z0-9]+)*)|\^\^<([^\x00-\x20<>"{}|^`\\]*)>)?)$/;
const TURTLE_ESCAPES: Readonly<Record<string, string>> = {
  t: "\t",
  b: "\b",
  n: "\n",
  r: "\r",
  f: "\f",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

/** The term a field of an answer file writes, as the SQL check writes the term a row holds. */
function pinnedTerm(field: string): string {
  const found = TSV_TERM.exec(field);
  if (found === null)
    throw new Error(
      `an expected row holds ${field}, which no comparison can match exactly`,
    );
  const [, address, text, lang, datatype] = found;
  if (address !== undefined) return `<${address}>`;
  const value = (text ?? "").replace(
    /\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([^]))/g,
    (_, short?: string, long?: string, other = "") => {
      const hex = short ?? long;
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      const escaped = TURTLE_ESCAPES[other];
      if (escaped === undefined)
        throw new Error(
          `an expected row holds ${field}, whose backslash is no escape of Turtle`,
        );
      return escaped;
    },
  );
  return sqlNt(
    lang === undefined
      ? { kind: LITERAL, value, datatype: datatype ?? XSD_STRING }
      : { kind: LITERAL, value, datatype: `${RDF}langString`, lang },
  );
}

const pinnedRow = (pairs: Iterable<readonly [string, string]>): string =>
  [...pairs]
    .map(([name, term]) => `?${name}=${term}`)
    .sort()
    .join(" ");

/**
 * The rows a fixture's answer file holds, a SPARQL 1.1 Query Results TSV file: a header of `?variable`s, then a line
 * for each row with a field for each variable, an empty field for one the row leaves unbound.
 */
async function pinned(
  vocabulary: Files,
  result: string,
): Promise<{ names: string[]; rows: string[] }> {
  const lines = (await readText(vocabulary, result)).split("\n");
  if (lines.pop() !== "")
    throw new Error(`${result} does not end in a newline`);
  const header = (lines.shift() ?? "").split("\t");
  const names = header.map((field) => field.slice(1));
  if (
    !header.every((field) => field.startsWith("?")) ||
    new Set(names).size !== names.length
  )
    throw new Error(
      `${result}: the first line must name each variable once, with a leading ?`,
    );
  const rows = lines.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== names.length)
      throw new Error(
        `${result}: a row has ${fields.length} fields, the header ${names.length}`,
      );
    return pinnedRow(
      names.flatMap((name, at) => {
        const field = fields[at] ?? "";
        return field === "" ? [] : [[name, pinnedTerm(field)] as const];
      }),
    );
  });
  return { names, rows };
}

const lensOf = (path: string | undefined): string | undefined =>
  path !== undefined && path.startsWith(LENSES) && path.endsWith(".rq")
    ? path.slice(LENSES.length, -3)
    : undefined;

/**
 * What `read` gives of the union as labels.rq reads it, before it is run: without the rdfs:label statements of the file
 * the layout says labels.rq writes, the file's other statements kept. The store is put back after.
 */
export async function beforeLabels<T>(
  union: Union,
  read: (before: Union) => Promise<T>,
): Promise<T> {
  const { rows } = await union.select(
    `SELECT ?file WHERE { ?placement <${WRITTEN_BY}> "labels.rq" ; <${INSTANCE}> ?file } LIMIT 1`,
  );
  const file = rows[0]?.get("file")?.value;
  if (file === undefined) return read(union);
  const before = new RestorableUnion(union.store, union.graphs);
  try {
    const kept = await union.store.construct(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${file}> { ?s ?p ?o FILTER (?p != <${LABEL}>) } }`,
      new Set(),
    );
    await before.drop(file);
    await before.add(kept, file);
    return await read(before);
  } finally {
    await before.restore();
  }
}

/**
 * Why the `.sql`, over the fixture's pod under its lens, does not give the rows of the `.rq` beside it, as lines: in a
 * whole run, in its order where it has one, a CONSTRUCT's as a set of triples and a view's through its `triples` part;
 * for a question that binds a record, asked through `asked` of each record a manifest entry binds and each record the
 * pod holds, for a list question of each record in an entry too, and for a `.sql` reading `asked` of a record no pod holds,
 * and for a SELECT that binds no record and gives no `?record`, against the `.rq` bound to it; through each page
 * of a list question; the rows of each manifest entry under that lens that runs it; a view's screen, which is not
 * filled whole where the layout places the view at two addresses; and the objects the database holds, which are the
 * same after all of these as before, the `.sql` leaving none. Where `observed` is given, it is told `rows:` and the `.rq`
 * where the `.rq` gives a row, which a `.rq` binding a record does of a record the pod holds.
 */
export async function sqlFailures(
  vocabulary: Files,
  built: BuiltFixture,
  ported: Ported,
  sql: string = ported.sql,
  observed?: string[],
): Promise<string[]> {
  const { name: fixture, lens, union, db } = built;
  const where = `${fixture}, under ${lens}, ${ported.rq}`;
  const screen = built.screens.get(ported.rq);
  if (screen !== undefined) return [`${where}: ${screen}`];
  const before = schemaOf(db);
  const construct = isConstruct(ported.rqText);
  const wanted =
    ported.rq === LABELS && sqlParts(sql).size > 0
      ? await beforeLabels(union, (before) => rqAnswer(before, ported.rqText))
      : await rqAnswer(union, ported.rqText);
  let found: { columns: readonly string[]; rows: Row[] };
  try {
    found = sqlRows(db, sql);
  } catch (error) {
    return [
      `${where}: the .sql fails: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const { names } = wanted;
  if (found.columns.join(" ") !== names.join(" "))
    return [
      `${where}: the .sql gives the columns ${found.columns.join(", ")}, the .rq ${names.join(", ")}`,
    ];
  const against = (
    said: string,
    want: readonly Row[],
    got: readonly Row[],
  ): string[] => {
    const unique = (rows: readonly Row[]): Row[] =>
      [...counted(rows).values()].map(({ row }) => row);
    const lines = construct
      ? compared(names, unique(want), unique(got))
      : compared(names, want, got, finalOrder(ported.rqText, names));
    return lines.map((line) => `${where}, ${said}: ${line}`);
  };
  const lines = against("against the .rq", wanted.rows, found.rows);
  if (!construct && PAGED.test(sql))
    lines.push(...pageFailures(db, sql).map((line) => `${where}: ${line}`));
  const bound = new Set(
    construct ? [] : built.entries.flatMap((entry) => entry.records),
  );
  if (!construct && PAGED.test(sql))
    for (const record of recordsInEntries(db)) bound.add(record);
  const asks = ported.rq.startsWith(QUESTIONS)
    ? bindsARecord(ported.rqText)
    : /\basked\b/.test(sql);
  if (!construct && asks) {
    for (const record of recordsOfThePod(db)) bound.add(record);
    bound.add(NO_SUCH_RECORD);
  }
  // A question that gives a ?record column and binds none is never bound to a record: its binding would add the record
  // to each row that names none, as an entry's review would.
  const question = ported.rq.startsWith(QUESTIONS);
  const asksOfARecord = question && bindsARecord(ported.rqText);
  if (question && !asksOfARecord && answersWithARecord(ported.rqText))
    bound.clear();
  else if (question && !construct && !asksOfARecord)
    lines.push(
      ...against(
        `bound to ${NO_SUCH_RECORD}, against the .rq`,
        (await rqAnswer(union, ported.rqText, NO_SUCH_RECORD)).rows,
        found.rows,
      ),
    );
  let gaveRows = !asksOfARecord && wanted.rows.length > 0;
  for (const record of [...bound].sort()) {
    const answer = (await rqAnswer(union, ported.rqText, record)).rows;
    if (asksOfARecord && record !== NO_SUCH_RECORD && answer.length > 0)
      gaveRows = true;
    lines.push(
      ...against(
        `keyed to ${record}, against the .rq`,
        answer,
        askedRows(db, sql, [record]),
      ),
    );
  }
  if (gaveRows) observed?.push(`rows:${ported.rq}`);
  for (const entry of built.entries) {
    if (entry.query !== ported.rq) continue;
    if (entry.result === undefined) {
      lines.push(
        `${fixture}, ${entry.name}: it runs ${ported.rq} and pins no mf:result`,
      );
      continue;
    }
    const entryLens = lensOf(entry.lens);
    if (entryLens === undefined) {
      lines.push(
        `${fixture}, ${entry.name}: ${entry.lens ?? "no lens"} is no lens's query file`,
      );
      continue;
    }
    if (entryLens !== lens) continue;
    const pins = await pinned(vocabulary, entry.result);
    const expected = [...names].sort().join(", ");
    const header = [...pins.names].sort().join(", ");
    if (expected !== header) {
      lines.push(
        `${fixture}, ${entry.name}: expected the variables [${expected}], found [${header}]`,
      );
      continue;
    }
    const given =
      entry.records.length > 0 ? askedRows(db, sql, entry.records) : found.rows;
    const rows = given.map((row) =>
      pinnedRow(
        names.flatMap((name, at) =>
          row[at] === null ? [] : [[name, row[at] ?? ""] as const],
        ),
      ),
    );
    const want = pins.rows.map((row) => [row]);
    const got = rows.map((row) => [row]);
    for (const [kind, side] of [
      ["missing", lacking(want, got)],
      ["unexpected", lacking(got, want)],
    ] as const)
      for (const [row] of side.sort((a, b) =>
        (a[0] ?? "") < (b[0] ?? "") ? -1 : 1,
      ))
        lines.push(
          `${fixture}, ${entry.name}, under ${lens}, ${ported.rq}: ${kind}: ${row}`,
        );
  }
  lines.push(...twoAddressFailures(built, ported, where));
  const left = leftIn(db, before);
  if (left.length > 0)
    lines.push(
      `${where}: the .sql leaves in the database, or removes from it: ${left.join(", ")}`,
    );
  return lines;
}

/**
 * Each object, of every kind, that the connection's database and its temporary one hold, as its schema, type and name,
 * but those SQLite makes of itself, such as the tables an ANALYZE of a temporary table writes its statistics in.
 */
function schemaOf(db: Database): Set<string> {
  return new Set(
    db
      .prepare(
        "SELECT 'temp' AS home, type, name FROM sqlite_temp_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
          "UNION ALL SELECT 'main', type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      .all()
      .map(
        ({ home, type, name }) =>
          `${String(home)} ${String(type)} ${String(name)}`,
      ),
  );
}

/**
 * The objects the database holds now and did not before, and those it held and does not, each written `home type
 * name`; the tables and views added are dropped, so that the `.sql` after one is not blamed for what it left.
 */
function leftIn(db: Database, before: ReadonlySet<string>): string[] {
  const after = schemaOf(db);
  const added = [...after].filter((object) => !before.has(object));
  for (const object of added) {
    const [home, type, name] = object.split(" ");
    if (type === "table" || type === "view")
      try {
        db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${home}."${name}"`);
      } catch {
        // an object another one's drop took with it
      }
  }
  return [
    ...added,
    ...[...before].filter((object) => !after.has(object)),
  ].sort();
}

/**
 * Why the screens, filled whole over the fixture's pod under its lens, are not what a whole fill of the pod gives once
 * a change a keyed run may be given is made to its statements and the screens are filled again with scope holding what
 * the change touched: for each change, each screen table that holds other rows, as lines. Each kind of change it made
 * is given as `kinds`; a change of no kind is a line.
 */
export function keyedFillFailures(built: BuiltFixture): {
  lines: string[];
  kinds: string[];
} {
  const { db, name: fixture, lens } = built;
  const filled = screenTables(db);
  const lines: string[] = [];
  const kinds = new Set<string>();
  for (const { name, make } of keyedChanges(db, () => built.refill())) {
    const kind = keyedKind(name);
    if (kind === undefined)
      lines.push(`${fixture}, under ${lens}, ${name}: a change of no kind`);
    else kinds.add(kind);
    undone(db, () => {
      const touched = make(db);
      const kept = undone(db, () => {
        db.exec("DELETE FROM scope");
        const put = db.prepare("INSERT INTO scope (term) VALUES (?)");
        for (const term of touched) put.run(term);
        built.refill();
        return screenTables(db);
      });
      let wanted = filled;
      if (!name.endsWith(" unchanged")) {
        for (const table of filled.keys()) db.exec(`DELETE FROM "${table}"`);
        wholeScope(db);
        built.refill();
        wanted = screenTables(db);
      }
      for (const [table, rows] of wanted) {
        const have = kept.get(table) ?? [];
        if (JSON.stringify(have) === JSON.stringify(rows)) continue;
        lines.push(
          `${fixture}, under ${lens}, ${name}: ${table} holds ${JSON.stringify(have.filter((row) => !rows.includes(row)))} a whole fill does not, and lacks ${JSON.stringify(rows.filter((row) => !have.includes(row)))}`,
        );
      }
    });
  }
  return { lines, kinds: [...kinds] };
}

/** The name of a view, by its `.rq`: `allergies` of `queries/views/allergies.rq`. */
const viewNamed = (rq: string): string => rq.slice(VIEWS.length, -".rq".length);

/**
 * Why a view's screen, whose entries the pod holds, is filled whole though the layout places the view at a second address,
 * where it should fail rather than name the view's entries after either address: the second address given, the screens'
 * rows deleted and every screen filled again, all put back after.
 */
function twoAddressFailures(
  built: BuiltFixture,
  ported: Ported,
  where: string,
): string[] {
  if (!ported.rq.startsWith(VIEWS)) return [];
  const { db } = built;
  const tables = tablesOf(sqlParts(ported.sql));
  const screens = screenTables(db);
  if (!tables.some((table) => (screens.get(table)?.length ?? 0) > 0)) return [];
  const registered = db
    .prepare(
      "SELECT w.s AS s, w.g AS g FROM quad w JOIN term p ON p.id = w.p JOIN term o ON o.id = w.o WHERE p.nt = ? AND o.nt = ?",
    )
    .get(`<${WRITTEN_BY}>`, `"views/${viewNamed(ported.rq)}.rq"`);
  if (registered === undefined) return [];
  return undone(db, () => {
    const make = termIdsOf(db);
    db.prepare("INSERT INTO quad (s, p, o, g) VALUES (?, ?, ?, ?)").run(
      registered.s,
      make(`<${INSTANCE}>`),
      make("<https://pod.example/elsewhere.ttl>"),
      registered.g,
    );
    for (const table of screens.keys()) db.exec(`DELETE FROM "${table}"`);
    wholeScope(db);
    try {
      built.refill();
    } catch {
      return [];
    }
    return [
      `${where}: its screen is filled whole though the layout places the view at two addresses`,
    ];
  });
}

/** The check's own context, read once: the build, the schema, the functions and the ported queries. */
export async function sqlCheckContext(
  options: SqlCheckOptions,
): Promise<Context> {
  return {
    ...options,
    build: await vocabularyBuild(options.vocabulary, options.layout),
    schema: await readText(options.vocabulary, STATEMENTS_SCHEMA),
    functions: await sqlDatabaseFunctions(),
    ported: await portedQueries(options.vocabulary),
  };
}

/** The fixture built under the lens and loaded, for `sqlFailures`; closed by the caller. */
export function fixtureBuilt(
  context: Context,
  fixture: string,
  lens: string,
): Promise<BuiltFixture> {
  return builtFixture(context, fixture, lens);
}

/** The test of the screens over a fixture under a lens, filled keyed to each change a run may be given. */
export const sqlKeyedTest = (
  vocabulary: Files,
  fixture: string,
  lens: string,
): string => `${vocabulary.iri}${VIEWS}#keyed/${fixture}/${lens}`;

/**
 * The test a `.sql` over a fixture under a lens is: the `.sql`, and in its fragment the `.sql` again, the fixture and the
 * lens, so a report that shows a test by its fragment alone names the query.
 */
export const sqlTest = (
  vocabulary: Files,
  ported: Pick<Ported, "rq">,
  fixture: string,
  lens: string,
): string =>
  `${vocabulary.iri}${encodeURI(sqlPath(ported.rq))}#${encodeURI(sqlPath(ported.rq))}/${fixture}/${lens}`;

/**
 * One assertion for each comparison the fixtures' manifests choose (`sqlComparisons`), of the fixtures given or of all
 * of them: that the `.sql`, over the fixture as the runtime builds it under the lens and loads it into SQLite, gives the
 * rows its `.rq` gives and those the fixture's manifest pins. Over all of them, also one for each `.sql` none chooses.
 */
export async function sqlCheckAssertions(
  options: SqlCheckOptions,
  fixtures?: readonly string[],
  /** A `.sql`'s text to check in place of the vocabulary's, by its `.rq`'s path. */
  given: Readonly<Record<string, string>> = {},
  /** The `.rq` paths whose comparisons are made, of those the fixtures choose. */
  only?: readonly string[],
): Promise<Assertion[]> {
  if ((await options.vocabulary.read(STATEMENTS_SCHEMA)) === undefined)
    return [];
  const context = await sqlCheckContext(options);
  if (context.ported.length === 0) return [];
  const assertions: Assertion[] = [];
  const chosen = await sqlComparisons(
    options.vocabulary,
    options.newStore,
    context.ported,
    fixtures,
    only,
  );
  for (const [fixture, queries] of chosen)
    for (const lens of await lenses(options.vocabulary)) {
      const compared = context.ported.filter(({ rq }) =>
        queries.get(rq)?.includes(lens),
      );
      if (compared.length === 0) continue;
      let built: BuiltFixture | undefined;
      let why: string | undefined;
      try {
        built = await builtFixture(context, fixture, lens);
      } catch (error) {
        why = `${fixture}, under ${lens}: the runtime's build or the load fails: ${error instanceof Error ? error.message : String(error)}`;
      }
      try {
        for (const ported of compared) {
          let lines: string[];
          const observed = [`compared:${ported.rq}`];
          try {
            lines =
              built === undefined
                ? [why ?? ""]
                : await sqlFailures(
                    options.vocabulary,
                    built,
                    ported,
                    given[ported.rq],
                    observed,
                  );
          } catch (error) {
            lines = [
              `${fixture}, under ${lens}, ${ported.rq}: ${error instanceof Error ? error.message : String(error)}`,
            ];
          }
          assertions.push({
            test: sqlTest(options.vocabulary, ported, fixture, lens),
            name: `${ported.rq.slice(0, -3)}.sql over ${fixture} under ${lens}`,
            outcome: lines.length === 0 ? "passed" : "failed",
            ...(lines.length === 0 ? {} : { why: lines.join("\n") }),
            observed,
          });
        }
        if (only === undefined && built?.screensFilled) {
          let found: ReturnType<typeof keyedFillFailures>;
          try {
            found = keyedFillFailures(built);
          } catch (error) {
            found = {
              lines: [`${fixture}, under ${lens}: ${messageOf(error)}`],
              kinds: [],
            };
          }
          assertions.push({
            test: sqlKeyedTest(options.vocabulary, fixture, lens),
            name: `the screens over ${fixture} under ${lens} filled keyed to each change are what a whole fill gives`,
            outcome: found.lines.length === 0 ? "passed" : "failed",
            ...(found.lines.length === 0
              ? {}
              : { why: found.lines.join("\n") }),
            observed: found.kinds.map((kind) => `kept:${kind}`),
          });
        }
      } finally {
        built?.close();
      }
    }
  if (fixtures === undefined && only === undefined)
    assertions.push(...unchosen(options.vocabulary, context.ported, chosen));
  return assertions;
}

/**
 * The comparisons the names choose, made: a name ending in `.sql` or `.rq` is a ported query, by its path, and any
 * other is a fixture, by its folder under `tests/fixtures/`. A fixture chooses its comparisons and a query the
 * comparisons that are made of it, and the two together only the comparisons of both. A name that chooses none is
 * refused, each said by name in one error, so that a check never passes over nothing.
 */
export async function sqlNamedAssertions(
  options: SqlCheckOptions,
  names: readonly string[],
  given?: Readonly<Record<string, string>>,
): Promise<Assertion[]> {
  const { vocabulary, newStore } = options;
  if ((await vocabulary.read(STATEMENTS_SCHEMA)) === undefined)
    throw new Error(`the vocabulary has no ${STATEMENTS_SCHEMA} to compare`);
  const ported = await portedQueries(vocabulary);
  const known = await fixtureNames(vocabulary);
  const refused: string[] = [];
  const fixtures: string[] = [];
  const queries: string[] = [];
  for (const name of new Set(names)) {
    const rq = /\.(sql|rq)$/.test(name)
      ? `${name.slice(0, name.lastIndexOf("."))}.rq`
      : undefined;
    if (rq === undefined) {
      if (known.includes(name)) fixtures.push(name);
      else
        refused.push(
          `"${name}" is no fixture of ${FIXTURES} (a query is named by the path of its .sql or .rq)`,
        );
    } else if (ported.some((each) => each.rq === rq)) queries.push(rq);
    else refused.push(`"${name}" is no .rq with a .sql beside it`);
  }
  const chosen = await sqlComparisons(
    vocabulary,
    newStore,
    ported,
    fixtures.length > 0 ? fixtures : undefined,
    queries.length > 0 ? queries : undefined,
  );
  const wanted = queries.length > 0 ? ` of ${queries.join(", ")}` : "";
  for (const fixture of fixtures)
    if (!chosen.has(fixture))
      refused.push(
        `${fixture}: its manifest chooses no comparison${wanted} (ctm:comparesSqlWithSparqlUnderEveryLens, or an entry that runs the .rq)`,
      );
  const compared = new Set(
    [...chosen.values()].flatMap((here) => [...here.keys()]),
  );
  for (const rq of queries)
    if (!compared.has(rq))
      refused.push(
        `${rq}: ${fixtures.length > 0 ? "none of the fixtures named chooses" : "no fixture chooses"} a comparison of it`,
      );
  if (refused.length > 0) throw new Error(refused.join("\n"));
  return sqlCheckAssertions(
    options,
    [...chosen.keys()],
    given,
    queries.length > 0 ? queries : undefined,
  );
}

/** The test of a function against its vectors. */
export const sqlFunctionTest = (vocabulary: Files, name: string): string =>
  `${vocabulary.iri}${SQL_FUNCTION_VECTORS}#${name}`;

interface Vector {
  readonly input: readonly unknown[];
  readonly output?: unknown;
  readonly refused?: string;
  /** Oxigraph's own answer, where it is not the vector's output. */
  readonly oxigraph?: unknown;
}

/** The test of a function's vectors against Oxigraph's SPARQL. */
export const sqlVectorsInOxigraphTest = (
  vocabulary: Files,
  name: string,
): string => `${vocabulary.iri}${SQL_FUNCTION_VECTORS}#${name}-in-oxigraph`;

/** The SELECT of `?r` that gives what the function stands for over one vector's input, as SPARQL 1.1 gives it. */
function sparqlOf(name: string, input: readonly unknown[]): string {
  const text = (value: unknown): string => ntWritten(literal(String(value)));
  let expression: string;
  let values: string[];
  if (name === "sparql_compare") {
    expression = "IF(?a0 < ?a1, -1, IF(?a0 = ?a1, 0, IF(?a0 > ?a1, 1, 1/0)))";
    values = input.map(String);
  } else if (name === "sparql_decimal") {
    const [operator, ...operands] = input.map(String);
    expression = operator === "floor" ? "FLOOR(?a0)" : `?a0 ${operator} ?a1`;
    values = operands.map((operand) =>
      ntWritten(literal(operand, `${XSD}decimal`)),
    );
  } else {
    const calls: Readonly<Record<string, string>> = {
      sparql_replace: `REPLACE(${input.map((_, at) => `?a${at}`).join(", ")})`,
      sparql_sha256: "SHA256(?a0)",
      sparql_encode_for_uri: "ENCODE_FOR_URI(?a0)",
      sparql_lcase: "LCASE(?a0)",
    };
    const call = calls[name];
    if (call === undefined) throw new Error(`no SPARQL stands for ${name}`);
    expression = call;
    values = input.map(text);
  }
  const variables = values.map((_, at) => `?a${at}`).join(" ");
  return `SELECT (${expression} AS ?r) WHERE { VALUES (${variables}) { (${values.join(" ")}) } }`;
}

/** Each vector, but one marked refused, whose output is not what Oxigraph's SPARQL gives, where it marks no answer of its own. */
async function oxigraphFailures(
  union: Union,
  name: string,
  vectors: readonly Vector[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const vector of vectors) {
    if (vector.refused !== undefined) continue;
    const { rows } = await union.select(sparqlOf(name, vector.input));
    const term = rows[0]?.get("r");
    const got =
      term === undefined
        ? null
        : name === "sparql_compare"
          ? Number(term.value)
          : term.value;
    const wanted = "oxigraph" in vector ? vector.oxigraph : vector.output;
    if (got !== wanted)
      lines.push(
        `${JSON.stringify(vector.input)}: the vector gives ${JSON.stringify(wanted)}, Oxigraph ${JSON.stringify(got)}`,
      );
  }
  return lines;
}

/** Each vector of the function whose output the TypeScript function does not give, or that it does not refuse. */
export function vectorFailures(
  apply: ((...values: unknown[]) => unknown) | undefined,
  vectors: readonly Vector[],
): string[] {
  return vectors.flatMap((vector) => {
    const wanted = vector.refused !== undefined ? "refused" : vector.output;
    let got: unknown;
    if (apply === undefined) got = "no such function";
    else
      try {
        got = apply(...vector.input);
      } catch (error) {
        got =
          error instanceof SqlFunctionRefused
            ? "refused"
            : `throws ${String(error)}`;
      }
    return got === wanted
      ? []
      : [
          `${JSON.stringify(vector.input)}: expected ${JSON.stringify(wanted)}, gives ${JSON.stringify(got)}`,
        ];
  });
}

/**
 * One assertion for each function the vectors name: that it gives each vector's output and refuses each refused one;
 * and, given a store, one that each vector is what Oxigraph's SPARQL gives, but where it marks Oxigraph's own answer,
 * which Oxigraph must give.
 */
export async function sqlFunctionAssertions(
  vocabulary: Files,
  newStore?: StoreFactory,
): Promise<Assertion[]> {
  const bytes = await vocabulary.read(SQL_FUNCTION_VECTORS);
  if (bytes === undefined) return [];
  const { functions } = JSON.parse(new TextDecoder().decode(bytes)) as {
    functions: Record<string, { vectors: Vector[] }>;
  };
  const implemented = await sqlFunctions();
  const found: Assertion[] = [];
  const store = newStore?.();
  try {
    for (const [name, { vectors }] of Object.entries(functions).sort(
      ([a], [b]) => (a < b ? -1 : 1),
    )) {
      const lines = vectorFailures(implemented[name], vectors);
      found.push({
        test: sqlFunctionTest(vocabulary, name),
        name: `${name} gives each vector's output`,
        outcome: lines.length === 0 ? "passed" : "failed",
        ...(lines.length === 0 ? {} : { why: lines.join("\n") }),
      });
      if (store === undefined) continue;
      let said: string[];
      try {
        said = await oxigraphFailures(new Union(store), name, vectors);
      } catch (error) {
        said = [messageOf(error)];
      }
      found.push({
        test: sqlVectorsInOxigraphTest(vocabulary, name),
        name: `${name}'s vectors are Oxigraph's SPARQL answers`,
        outcome: said.length === 0 ? "passed" : "failed",
        ...(said.length === 0 ? {} : { why: said.join("\n") }),
      });
    }
  } finally {
    store?.free?.();
  }
  return found;
}
