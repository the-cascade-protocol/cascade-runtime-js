import type { Assertion } from "../conformance.js";
import type { Files } from "../files.js";
import { Layout } from "../layout.js";
import { OxigraphStore } from "../oxigraph-store.js";
import { type SqlCheckOptions, sqlNamedAssertions } from "../sql-check.js";
import { openDatabase } from "./sqlite.js";

/** The counts of the outcomes of the assertions, as a line. */
export function summary(assertions: readonly Assertion[]): string {
  const count = (outcome: Assertion["outcome"]): number =>
    assertions.filter((a) => a.outcome === outcome).length;
  return `${assertions.length} tests: ${count("passed")} passed, ${count("failed")} failed, ${count("inapplicable")} inapplicable`;
}

export const seconds = (milliseconds: number): string =>
  (milliseconds / 1000).toFixed(1);

/** What the SQL comparison runs on: the vocabulary, Oxigraph's stores, its layout and an SQLite database in memory. */
export async function sqlCheckOptions(files: Files): Promise<SqlCheckOptions> {
  return {
    vocabulary: files,
    newStore: () => new OxigraphStore(),
    layout: await Layout.read(files, () => new OxigraphStore()),
    open: (functions) => openDatabase(":memory:", { functions }),
  };
}

/**
 * The comparisons the names choose and nothing else, each said as it ends; the exit code is 1 when one fails, unlike a
 * conformance run's, which reports in the EARL file, for an author asking about one `.sql` has no report to read.
 */
export async function sqlOnly(
  files: Files,
  names: readonly string[],
  say: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const started = performance.now();
  const assertions = await sqlNamedAssertions(
    await sqlCheckOptions(files),
    names,
  );
  for (const { name, outcome, why } of assertions)
    say(
      `${outcome}: ${name}${why === undefined ? "" : `\n  ${why.replaceAll("\n", "\n  ")}`}`,
    );
  say(`${summary(assertions)} in ${seconds(performance.now() - started)} s`);
  return assertions.some(({ outcome }) => outcome !== "passed") ? 1 : 0;
}
