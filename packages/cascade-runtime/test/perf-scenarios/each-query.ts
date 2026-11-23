import { type Context } from "../perf-context.js";
import { type Job, type Measured } from "../perf-job.js";
import { type Row } from "../perf-rows.js";

/** How long a query may run on the reference engine, in seconds. */
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
  /** Whether both engines gave the same rows, where both ran. */
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

/** The pod's rows, named by the query they answer: the path under `queries/` as a part of a row's name. */
export function queryNames(queries: readonly QueryRun[]): Map<string, string> {
  void queries;
  return new Map();
}

/** One query asked of the pod in the job's folder on both engines. */
export function measureEachQuery(job: Job): Promise<Measured> {
  void job;
  throw new Error("each-query is not built yet");
}

/** The time a run took in all: filling both engines and asking every query of each. */
export const eachQueryTotal = (each: Measured): number =>
  Object.values(each.seconds).reduce((sum, value) => sum + value, 0);

/** The rows of the runs of one size. */
export function eachQueryRows(
  ctx: Context,
  name: string,
  runs: readonly Measured[],
): Row[] {
  void ctx;
  void name;
  void runs;
  return [];
}
