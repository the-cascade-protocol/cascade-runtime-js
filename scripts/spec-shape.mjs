import { readFileSync } from "node:fs";
import process from "node:process";
import { readJunit } from "../packages/site/src/junit.ts";

/**
 * Whether a package's results can be put on the tests page: `node scripts/spec-shape.mjs <junit.xml>... <spec.json>`.
 * The last argument is the spec and each one before it a report. It exits 0 saying how many cases the reports hold, and
 * 2 when a report or the spec cannot be read, since the page would be built without it. It never judges a name: the page
 * is made of the tests as written, and the spec's `capabilities`, `shaped`, `allow` and `glossary` are no longer read, so
 * a spec that still has them passes. Other repositories run it from a sparse checkout of this one's `scripts` and
 * `packages/site/src`; Node runs the TypeScript there by stripping its types.
 */
function run(args) {
  const specFile = args.at(-1);
  const junits = args.slice(0, -1);
  if (junits.length === 0) {
    process.stderr.write(
      "usage: node scripts/spec-shape.mjs <junit.xml>... <spec.json>\n",
    );
    return 2;
  }
  let cases;
  try {
    cases = junits.flatMap(
      (junit) => readJunit(readFileSync(junit, "utf8")).cases,
    );
    JSON.parse(readFileSync(specFile, "utf8"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    return 2;
  }
  process.stdout.write(
    `${specFile}: ${cases.length} cases read from ${junits.length} ${junits.length === 1 ? "report" : "reports"}\n`,
  );
  return 0;
}

process.exitCode = run(process.argv.slice(2));
