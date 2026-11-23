import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AnswerRow,
  askedRows,
  askedWhole,
  compared,
  counted,
  type Database,
  finalOrder,
  graphsOfDump,
  isConstruct,
  loadStatements,
  madeScreens,
  paged,
  portedQueries,
  readText,
  recordsInEntries,
  rqAnswer,
  sqlDatabaseFunctions,
  sqlRows,
  STATEMENTS_SCHEMA,
  Union,
} from "@cascade-runtime/runtime";
import { databaseAt } from "@cascade-runtime/runtime/node";
import { timed, timedSync } from "@cascade-runtime/runtime/probe";
import { databaseBeside, resolved } from "../../src/node/resolved.js";
import { type Context } from "../perf-context.js";
import {
  type Job,
  maybeProbed,
  type Measured,
  measured,
  samplesOf,
  stepper,
  type TraceNote,
} from "../perf-job.js";
import {
  clockRow,
  countRow,
  outputRow,
  part,
  type Row,
  unique,
} from "../perf-rows.js";

/** How long a query may run on the reference engine, in seconds, before it is said to have run past its limit. */
export const QUERY_LIMIT_SECONDS = 60;

/** The first page of a list question, in entries: the page the app asks for. */
export const QUERY_PAGE = 20;

/** How many records a question about one record is asked of. */
export const QUERY_RECORDS = 5;

/** What a query of the vocabulary is, by where its file sits under `queries/`. */
export type QueryKind =
  "derivation" | "lens" | "view" | "labels" | "question" | "table";

/** What one query of the vocabulary took on each engine, and whether they agreed. */
export interface QueryRun {
  /** The `.rq`'s path under `queries/`. */
  readonly rq: string;
  readonly kind: QueryKind;
  /** How many records it was asked of: 0 when it was asked of the whole pod. */
  readonly records: number;
  readonly hasSql: boolean;
  /** Seconds on the reference engine; none where it could not be run. */
  readonly sparql?: number;
  /** Seconds for the `.sql` over the whole pod, or over each of the records, added up. */
  readonly sql?: number;
  /** Seconds for the first page of 20 entries, for a `.sql` that gives pages. */
  readonly page?: number;
  /** How many rows the reference engine gave, and the sha256 of them sorted. */
  readonly rows?: number;
  readonly sha256?: string;
  /** Whether both engines gave the same rows, where both ran and the rows can be compared. */
  readonly equal?: boolean;
  /** Why it could not be run, or how the two differ. */
  readonly why?: string;
}

/** Every query of the vocabulary asked of one pod, on both engines. */
export interface EachQuery {
  /** Seconds to fill the reference engine's store from the pod's database. */
  readonly referenceLoad: number;
  /** Seconds to fill a database with the same statements and make every view's screen. */
  readonly databaseLoad: number;
  readonly statements: number;
  /** The records the questions about one record were asked of. */
  readonly records: readonly string[];
  readonly queries: readonly QueryRun[];
}

const QUERIES = "queries/";
const MATCHER = "queries/matcher/";

/** What a query is, from where its file is. */
export function kindOfQuery(rq: string): QueryKind {
  if (rq.startsWith("derivations/")) return "derivation";
  if (rq.startsWith("lenses/")) return "lens";
  if (rq.startsWith("views/")) return "view";
  if (rq === "labels.rq") return "labels";
  if (rq.startsWith("questions/")) return "question";
  return "table";
}

/** Why a table query is not asked: it reads the reference tables, which the pod's database and the reference store do not hold. */
const TABLES_WHY =
  "it reads the reference tables, which the pod's database does not hold";

/** The pod's rows, named by the query they answer: the path under `queries/` as a part of a row's name, once each. */
export function queryNames(queries: readonly QueryRun[]): Map<string, string> {
  const taken = new Set<string>();
  return new Map(queries.map(({ rq }) => [rq, unique(taken, part(rq))]));
}

const digestOf = (rows: readonly AnswerRow[]): string => {
  const lines = [...counted(rows).values()]
    .map(({ row, count }) => `${count}\u0000${JSON.stringify(row)}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
};

/** The rows of one engine where the other gave `want`: why they differ, or nothing where they are the same. */
function disagreement(
  names: readonly string[],
  want: readonly AnswerRow[],
  got: readonly AnswerRow[],
  columns: readonly string[],
  construct: boolean,
  rqText: string,
  keyed: boolean,
): string | undefined {
  if (columns.join(" ") !== names.join(" "))
    return `the .sql gives the columns ${columns.join(", ")}, the .rq ${names.join(", ")}`;
  const unrepeated = (rows: readonly AnswerRow[]) =>
    [...counted(rows).values()].map(({ row }) => row);
  const lines = construct
    ? compared(names, unrepeated(want), unrepeated(got))
    : compared(names, want, got, keyed ? undefined : finalOrder(rqText, names));
  return lines[0];
}

/** Every record the pod puts in an entry that a question about one record is asked of: five, chosen by position, the same on every run. */
export function chosenRecords(all: readonly string[]): string[] {
  if (all.length <= QUERY_RECORDS) return [...all];
  return Array.from(
    { length: QUERY_RECORDS },
    (_, at) =>
      all[Math.floor(((2 * at + 1) * all.length) / (2 * QUERY_RECORDS))],
  ) as string[];
}

/** The pod's statements as the text a store restores, each graph a block of its statements as N-Triples, and how many there are. */
function dumpOf(db: Database): {
  bytes: Uint8Array;
  graphs: string[];
  statements: number;
} {
  const graphs: string[] = [];
  const blocks: string[] = [];
  let open: string | undefined;
  let lines: string[] = [];
  let statements = 0;
  const close = () => {
    if (open === undefined) return;
    graphs.push(open);
    blocks.push(`<${open}> {\n${lines.join("")}}\n`);
  };
  for (const row of db
    .prepare(
      "SELECT g.lex AS g, s.nt AS s, p.nt AS p, o.nt AS o FROM quad q " +
        "JOIN term g ON g.id = q.g JOIN term s ON s.id = q.s JOIN term p ON p.id = q.p JOIN term o ON o.id = q.o " +
        "ORDER BY q.g",
    )
    .iterate()) {
    const graph = String(row.g);
    if (graph !== open) {
      close();
      open = graph;
      lines = [];
    }
    lines.push(`${String(row.s)} ${String(row.p)} ${String(row.o)} .\n`);
    statements += 1;
  }
  close();
  const body = blocks.join("");
  const text = `# ${JSON.stringify({ graphs, length: Buffer.byteLength(body) })}\n${body}`;
  return { bytes: new TextEncoder().encode(text), graphs, statements };
}

/**
 * Every query of the vocabulary outside the matcher asked of the pod in the job's folder, on the reference engine over the
 * pod's own statements and, where it has a `.sql`, on a database holding the same statements with every view's screen made:
 * the time of each, the rows and whether the two gave the same.
 */
export async function measureEachQuery(job: Job): Promise<Measured> {
  const { seconds, step } = stepper();
  const notes: TraceNote[] = [];
  const parts = await resolved();
  const vocabulary = parts.vocabulary;
  const found = await databaseBeside(job.folder);
  if (!(await found.exists()))
    throw new Error(`the pod in ${job.folder} keeps no database`);
  const functions = await sqlDatabaseFunctions();
  const schema = await readText(vocabulary, STATEMENTS_SCHEMA);
  const ported = await portedQueries(vocabulary);
  const sqlOf = new Map(ported.map((each) => [each.rq, each]));
  const paths = (await vocabulary.list(QUERIES.slice(0, -1)))
    .filter((path) => path.endsWith(".rq") && !path.startsWith(MATCHER))
    .sort();
  const body = await maybeProbed(job, "each-query", notes, async () => {
    const dump = (() => {
      const beside = found.open({ functions: [] });
      try {
        return dumpOf(beside);
      } finally {
        beside.close();
      }
    })();
    const store = parts.newStore();
    const copy = join(dirname(job.folder), "each-query.db");
    await rm(copy, { force: true });
    const db = databaseAt(copy).open({ functions });
    try {
      await step("reference-load", async () => {
        await store.restore(dump.bytes);
      });
      const union = new Union(store, dump.graphs);
      const screens = new Map<string, number>();
      let failed = new Map<string, string>();
      await step("database-load", async () => {
        db.transaction(() =>
          loadStatements(
            db,
            schema,
            graphsOfDump(dump.bytes, new Set(dump.graphs)),
            "each-query",
          ),
        );
        failed = madeScreens(db, ported, (rq, spent) =>
          screens.set(rq, (screens.get(rq) ?? 0) + spent),
        );
      });
      const records = chosenRecords(recordsInEntries(db));
      const queries: QueryRun[] = [];
      for (const path of paths) {
        queries.push(
          await oneQuery({
            path,
            rqText: await readText(vocabulary, path),
            sql: sqlOf.get(path)?.sql,
            union,
            db,
            records,
            screen: screens.get(path),
            screenFailed: failed.get(path),
          }),
        );
      }
      return { statements: dump.statements, records, queries };
    } finally {
      db.close();
      store.free?.();
      await rm(copy, { force: true });
    }
  });
  const result = body.result;
  const spent = (pick: (each: QueryRun) => number | undefined) =>
    result.queries.reduce((sum, each) => sum + (pick(each) ?? 0), 0);
  const each: EachQuery = {
    referenceLoad: seconds["reference-load"] ?? 0,
    databaseLoad: seconds["database-load"] ?? 0,
    ...result,
  };
  return {
    ...measured({
      seconds: {
        "reference-load": each.referenceLoad,
        "database-load": each.databaseLoad,
        sparql: spent(({ sparql }) => sparql),
        sql: spent(({ sql, page }) => (sql ?? 0) + (page ?? 0)),
      },
      parts: {},
      rssBytes: process.memoryUsage.rss(),
      wrote: 0,
      seen: body.seen,
      notes,
    }),
    eachQuery: each,
  };
}

interface Asked {
  readonly path: string;
  readonly rqText: string;
  readonly sql: string | undefined;
  readonly union: Union;
  readonly db: Database;
  readonly records: readonly string[];
  /** What making the view's screen took, for a view. */
  readonly screen: number | undefined;
  /** Why the view's screen cannot be made. */
  readonly screenFailed: string | undefined;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const NOT_COMPARED_LABELS =
  "labels.sql rewrites the pod's labels, and the pod already holds them, so its rows are not compared with the reference engine's";

/** One query of the vocabulary on both engines. */
async function oneQuery(asked: Asked): Promise<QueryRun> {
  const { path, rqText, sql, union, db } = asked;
  const rq = path.slice(QUERIES.length);
  const kind = kindOfQuery(rq);
  const hasSql = sql !== undefined;
  if (kind === "table")
    return { rq, kind, records: 0, hasSql, why: TABLES_WHY };
  const construct = isConstruct(rqText);
  const keyed =
    kind === "question" &&
    (rq.startsWith("questions/record/") || rq.startsWith("questions/entry/")) &&
    rqText.includes("?record") &&
    (sql === undefined || /\basked\b/.test(sql));
  const bound = keyed ? asked.records : [];
  let names: readonly string[] = [];
  let want: AnswerRow[] = [];
  let sparql = 0;
  try {
    for (const record of keyed ? bound : [undefined]) {
      const started = performance.now();
      const answer = await timed("each-query.sparql", () =>
        rqAnswer(union, rqText, record),
      );
      sparql += (performance.now() - started) / 1000;
      names = answer.names;
      want = want.concat(answer.rows);
    }
  } catch (error) {
    return { rq, kind, records: bound.length, hasSql, why: messageOf(error) };
  }
  const base = {
    rq,
    kind,
    records: bound.length,
    hasSql,
    sparql,
    rows: want.length,
    sha256: digestOf(want),
  };
  if (sql === undefined) return base;
  if (asked.screenFailed !== undefined)
    return { ...base, why: asked.screenFailed };
  let columns: readonly string[] = [];
  let got: AnswerRow[];
  let sqlSeconds: number;
  try {
    const started = performance.now();
    if (keyed)
      got = timedSync("each-query.sql", () => askedRows(db, sql, bound));
    else {
      askedWhole(db);
      const answer = timedSync("each-query.sql", () => sqlRows(db, sql));
      columns = answer.columns;
      got = answer.rows;
    }
    sqlSeconds = (performance.now() - started) / 1000 + (asked.screen ?? 0);
  } catch (error) {
    return { ...base, why: `the .sql fails: ${messageOf(error)}` };
  }
  let page: number | undefined;
  if (!keyed && /:page_size\b/.test(sql)) {
    const started = performance.now();
    try {
      timedSync("each-query.sql", () => paged(db, sql, QUERY_PAGE, null));
      page = (performance.now() - started) / 1000;
    } catch (error) {
      return {
        ...base,
        sql: sqlSeconds,
        why: `a page of the .sql fails: ${messageOf(error)}`,
      };
    }
  }
  const comparable = rq !== "labels.rq";
  const why = !comparable
    ? NOT_COMPARED_LABELS
    : keyed
      ? disagreement(names, want, got, names, construct, rqText, true)
      : disagreement(names, want, got, columns, construct, rqText, false);
  return {
    ...base,
    sql: sqlSeconds,
    ...(page !== undefined && { page }),
    ...(comparable && { equal: why === undefined }),
    ...(why !== undefined && { why }),
  };
}

/** The time a run took in all: filling both engines and asking every query of each. */
export const eachQueryTotal = (each: Measured): number =>
  Object.values(each.seconds).reduce((sum, value) => sum + value, 0);

/** Whether a query ran past its limit on the reference engine, the median of its runs having taken longer. */
const pastLimit = (samples: readonly number[]): boolean =>
  samples.length > 0 &&
  clockRow("x/x", "s", samples, "").value > QUERY_LIMIT_SECONDS;

/** The rows of the runs of one size: each query's time on each engine, its rows and their fingerprint, whether the engines agreed. */
export function eachQueryRows(
  ctx: Context,
  name: string,
  runs: readonly Measured[],
): Row[] {
  const { how } = ctx;
  const first = runs.find((each) => each.eachQuery !== undefined)?.eachQuery;
  if (first === undefined) return [];
  const names = queryNames(first.queries);
  const from = (pick: (each: EachQuery) => number | undefined): number[] =>
    runs.flatMap((each) =>
      each.eachQuery === undefined ? [] : (pick(each.eachQuery) ?? []),
    );
  const of = (rq: string, pick: (each: QueryRun) => number | undefined) =>
    from((each) => pick(each.queries.find((one) => one.rq === rq) as QueryRun));
  const rows: Row[] = [
    clockRow(
      `${name}/total`,
      "s",
      runs.map(eachQueryTotal),
      `filling both engines and asking every query of each; ${how}`,
    ),
    clockRow(
      `${name}/reference-load`,
      "s",
      from(({ referenceLoad }) => referenceLoad),
      `${first.statements} statements; ${how}`,
    ),
    clockRow(
      `${name}/database-load`,
      "s",
      from(({ databaseLoad }) => databaseLoad),
      `${first.statements} statements and every view's screen; ${how}`,
    ),
    clockRow(
      `${name}/rss`,
      "By",
      samplesOf(runs, (each) => each.rssBytes),
      `after every query was asked; ${how}`,
    ),
    clockRow(
      `${name}/peak-rss`,
      "By",
      samplesOf(runs, (each) => each.peakRssBytes),
      how,
    ),
  ];
  for (const query of first.queries) {
    const row = names.get(query.rq) as string;
    const said =
      query.records > 0
        ? `${query.rq}; asked of ${query.records} records, the times added up`
        : query.rq;
    if (query.sparql === undefined) {
      rows.push(
        outputRow(
          `${name}/not-run/${row}`,
          1,
          `${query.rq}: ${query.why ?? "it did not run"}`,
        ),
      );
      continue;
    }
    const sparql = of(query.rq, (each) => each.sparql);
    rows.push(clockRow(`${name}/sparql/${row}`, "s", sparql, said));
    rows.push({
      ...outputRow(`${name}/rows/${row}`, query.rows ?? 0, query.rq),
      ...(query.sha256 !== undefined && { sha256: query.sha256 }),
    });
    if (pastLimit(sparql))
      rows.push({
        name: `${name}/timeout/${row}`,
        unit: "s",
        value: QUERY_LIMIT_SECONDS,
        kind: "output",
        extra: query.rq,
      });
    if (query.sql !== undefined)
      rows.push(
        clockRow(
          `${name}/sql/${row}`,
          "s",
          of(query.rq, (each) => each.sql),
          said,
        ),
      );
    if (query.page !== undefined)
      rows.push(
        clockRow(
          `${name}/page/${row}`,
          "s",
          of(query.rq, (each) => each.page),
          `${query.rq}; the first ${QUERY_PAGE} entries`,
        ),
      );
    if (query.equal !== undefined)
      rows.push(
        outputRow(
          `${name}/equal/${row}`,
          query.equal ? 1 : 0,
          query.why ?? query.rq,
        ),
      );
  }
  const count = (pick: (each: QueryRun) => boolean) =>
    first.queries.filter(pick).length;
  rows.push(
    countRow(`${name}/count/queries`, first.queries.length, ctx.about),
    countRow(
      `${name}/count/with-sql`,
      count((each) => each.hasSql),
    ),
    countRow(
      `${name}/count/without-sql`,
      count((each) => !each.hasSql),
    ),
    countRow(
      `${name}/count/not-run`,
      count((each) => each.sparql === undefined),
    ),
  );
  return rows;
}
