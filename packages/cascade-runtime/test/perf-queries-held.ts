import { createHash } from "node:crypto";
import { type Context } from "./perf-context.js";
import {
  type EachQuery,
  eachQueryRows,
  type Measured,
  type QueryRun,
  type Row,
} from "./perf-report.js";

const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * Every kind of query as one pod gives it, for the tests of the rows and the pages: a derivation with no `.sql`; a view and a
 * question that both engines answered alike; a question about one record with no `.sql`; a list question whose `.sql` gave
 * other rows and whose reference answer ran over its limit; and a table query the pod's database cannot run.
 */
export const heldQueries = (): EachQuery => {
  const run = (more: QueryRun): QueryRun => more;
  return {
    referenceLoad: 0.9,
    databaseLoad: 1.4,
    statements: 184332,
    records: ["https://pod.example/r1", "https://pod.example/r2"],
    queries: [
      run({
        rq: "derivations/records.rq",
        kind: "derivation",
        records: 0,
        hasSql: false,
        sparql: 0.8,
        rows: 1200,
        sha256: sha("records"),
      }),
      run({
        rq: "views/lab-results.rq",
        kind: "view",
        records: 0,
        hasSql: true,
        sparql: 2,
        sql: 0.2,
        rows: 40000,
        sha256: sha("lab-results"),
        equal: true,
      }),
      run({
        rq: "questions/pod/My lab results.rq",
        kind: "question",
        records: 0,
        hasSql: true,
        sparql: 1.8,
        sql: 0.036,
        page: 0.004,
        rows: 8100,
        sha256: sha("my lab results"),
        equal: true,
      }),
      run({
        rq: "questions/record/What needs review.rq",
        kind: "question",
        records: 5,
        hasSql: false,
        sparql: 3,
        rows: 12,
        sha256: sha("needs review"),
      }),
      run({
        rq: "questions/pod/What each folder holds.rq",
        kind: "question",
        records: 0,
        hasSql: true,
        sparql: 70,
        sql: 4,
        rows: 300,
        sha256: sha("folders"),
        equal: false,
        why: "unexpected: row 1",
      }),
      run({
        rq: "tables/agreement.rq",
        kind: "table",
        records: 0,
        hasSql: false,
        why: "it reads the reference tables, which the pod's database does not hold",
      }),
    ],
  };
};

/** One run of the held queries as the child hands it back. */
export const measuredQueries = (each: EachQuery = heldQueries()): Measured => ({
  seconds: { "reference-load": each.referenceLoad },
  parts: {},
  rssBytes: 1,
  peakRssBytes: 2,
  eachQuery: each,
});

/** The rows of the held queries at one size, as the harness writes them. */
export const rowsOfQueries = (
  dataset = "synthea-10y",
  each: EachQuery = heldQueries(),
): Row[] =>
  eachQueryRows(
    { how: "unprobed, one run in a process of its own; test" } as Context,
    `each-query-${dataset}`,
    [measuredQueries(each)],
  );

/**
 * The rows of the first import that the queries are read against, as a build's file has them: the probed run's total, the Bridge's
 * conversion with the adapters' queries inside it, and the vocabulary's own queries the import runs.
 */
export const rowsOfImport = (dataset = "synthea-10y"): Row[] => {
  const key = `fresh-first-screen-${dataset}`;
  const stage = (name: string, value: number): Row => ({
    name: `${key}/stage/${name}`,
    unit: "s",
    value,
    kind: "clock",
    samples: 1,
    range: `${value}-${value}`,
  });
  return [
    {
      name: `${key}/probed-total`,
      unit: "s",
      value: 10,
      kind: "clock",
      samples: 1,
      range: "10-10",
    },
    {
      name: `${key}/count/records`,
      unit: "{count}",
      value: 647,
      kind: "cost",
    },
    stage("arrivals.convert", 2.5),
    stage("bridge.stage-mapping", 0.5),
    stage("bridge.query-record.rq", 0.2),
    stage("bridge.query-lab-result.rq", 0.1),
    stage("derive.step-queries-derivations-records.rq", 0.3),
    stage("build.query-clinical-labels.ttl", 0.2),
    stage("matcher.rule-same-code-and-day", 0.1),
  ];
};
