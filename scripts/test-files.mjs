import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** The describe whose case runs the whole conformance command when no report is named. */
const CONFORMANCE_CASE = "Reporting a conformance run";

/** The longest a test or a hook may run, in milliseconds: 4 times the slowest suite on CI (74.8 s), rounded up, for a slower machine. */
const TEST_TIMEOUT = 300_000;

/** The value of a variable naming a whole number above 0, or `fallback` when it is unset. */
function wholeNumber(env, name, fallback) {
  if (!env[name]) return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} is "${env[name]}", not a whole number above 0`);
  return value;
}

/**
 * The `node --test` options every run of the suite carries, before the ones the caller gave: how many test files run at
 * once (3, or one fewer than the processors if that is less, `CASCADE_TEST_CONCURRENCY` to change it), how long a test or
 * a hook may take (`CASCADE_TEST_TIMEOUT`, in milliseconds), the end of the run once every test has finished or timed out
 * (`--test-force-exit`, so a test that hangs on an open handle does not keep it going), and, unless
 * `CASCADE_CONFORMANCE_REPORT` names a report or the caller names a test name pattern (the skip would win over it and the
 * run would be empty), a skip of the case that would run the conformance command itself. An option the caller names is
 * not given a second time.
 */
export function suiteOptions(
  given = [],
  env = process.env,
  processors = availableParallelism(),
) {
  const options = {
    "--test-concurrency": wholeNumber(
      env,
      "CASCADE_TEST_CONCURRENCY",
      Math.max(1, Math.min(3, processors - 1)),
    ),
    "--test-timeout": wholeNumber(env, "CASCADE_TEST_TIMEOUT", TEST_TIMEOUT),
  };
  const named = (flag) =>
    given.some((option) => option === flag || option.startsWith(`${flag}=`));
  const passed = Object.entries(options)
    .filter(([flag]) => !named(flag))
    .map(([flag, value]) => `${flag}=${value}`);
  if (!named("--test-force-exit")) passed.push("--test-force-exit");
  if (!env.CASCADE_CONFORMANCE_REPORT && !named("--test-name-pattern"))
    passed.push(`--test-skip-pattern=${CONFORMANCE_CASE}`);
  return passed;
}

/** The test files a package's spec lists as `randomOrder`, as written there: a path under its `test/`. */
function listedBy(name) {
  try {
    const { randomOrder } = JSON.parse(
      readFileSync(join("packages", name, "test", "spec.json"), "utf8"),
    );
    return new Set(Array.isArray(randomOrder) ? randomOrder : []);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

/**
 * The compiled test files of every package, from the repository's root, by their path. `listed` keeps only the files each
 * package's `test/spec.json` lists as `randomOrder`, `unlisted` only the files it does not, and `all` every one; the first
 * two are the third in two parts. A name in a list that is no test file is no file here.
 */
export function compiledTests(group = "all") {
  const compiled = [];
  const packages = readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of packages) {
    let entries;
    try {
      entries = readdirSync(join("packages", name, "test"), {
        recursive: true,
      });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const listed = listedBy(name);
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".test.ts")) continue;
      const kept = listed.has(entry.split("\\").join("/"));
      if (group === "listed" ? !kept : group === "unlisted" && kept) continue;
      compiled.push(
        join("packages", name, "dist", "test", entry.slice(0, -3) + ".js"),
      );
    }
  }
  return compiled;
}
