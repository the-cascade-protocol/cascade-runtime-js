// What each query of the vocabulary costs, read from the rows of the each-query scenario (packages/cascade-runtime/test/perf-scenarios/
// each-query.ts) and, beside them, the rows of the same build's first import that say what the adapters' conversion and the
// vocabulary's own queries took inside it. A few plain lines for the pull request comment, the job summary, /perf/ and
// /perf/runs/, and a table of every query's two times. It sets no bound on any figure and says nothing about one being too much.

import { escaped, plural, ratio, took, whole } from "./perf-jobs.mjs";
import { storedTitle } from "./perf-stored.mjs";

/**
 * The rows a page keeps of a build's file for the queries: those of the scenario, and what the first import is read against, the
 * probed run's total, the Bridge's conversion and the queries inside it, and the vocabulary's own queries the import runs.
 */
export const QUERIES_ROW =
  /^(?:each-query-[^/]+\/(?:total|reference-load|database-load|(?:sparql|sql|page|rows|equal|timeout|not-run)\/.+|count\/(?:queries|with-sql|without-sql|not-run))|fresh-first-screen-[^/]+\/(?:probed-total|count\/records|stage\/(?:arrivals\.convert|bridge\.query-.+|derive\.step-queries-.+|build\.query-.+|matcher\.rule-.+)))$/;

/** What the section is about, for the pages: what is asked, of what, and how the figures are made. */
export const QUERIES_ABOUT =
  "Every query of the vocabulary outside the matcher is asked of a copy of the pod a fresh import left. The reference engine answers each from the pod's own statements; a query that has a SQL version is also answered by the pod's database, which holds the same statements, and the rows of the two are compared. A view's or the labels' SQL time includes making the screen the view stands on, which a pod does as it changes. A question about one record is asked of five records chosen by position, and the five times are added up. A derivation has no SQL version yet, so it has the reference engine's time alone. The first import's figures are from its run with the probe on, which slows some work, so they are shares of that run. Times are the median of the runs and counts are exact; they are measurements, nothing more. To keep every build's measurement short, a build runs the queries once and the nightly run runs them three times.";

const KINDS = [
  ["question", "Questions"],
  ["view", "Views"],
  ["labels", "Labels"],
  ["derivation", "Derivations"],
  ["lens", "Lenses"],
  ["table", "Table queries"],
];

/** What a query is, from where its file is under `queries/`. */
export function kindOfQuery(rq) {
  if (rq.startsWith("derivations/")) return "derivation";
  if (rq.startsWith("lenses/")) return "lens";
  if (rq.startsWith("views/")) return "view";
  if (rq === "labels.rq") return "labels";
  if (rq.startsWith("questions/")) return "question";
  return "table";
}

const lastOf = (extra) =>
  typeof extra === "string" ? extra.split(" | ").at(-1) : undefined;

/** The suffix of each size a file asked the queries at (`synthea-10y`), in the order its rows come. */
export function queriesKeys(file) {
  const pattern = /^each-query-(.+?)\/count\/queries$/;
  return [
    ...new Set(
      (file.results ?? []).flatMap(({ name }) => {
        const found = pattern.exec(name ?? "");
        return found === null ? [] : [found[1]];
      }),
    ),
  ];
}

const pct = (share) =>
  share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;

/** A query's name as a person reads it: the file's name, with its folder where two queries share it. */
function labelled(queries) {
  const leaf = (rq) => rq.replace(/^.*\//, "").replace(/\.rq$/, "");
  const count = new Map();
  for (const { rq } of queries)
    count.set(leaf(rq), (count.get(leaf(rq)) ?? 0) + 1);
  for (const query of queries)
    query.label =
      count.get(leaf(query.rq)) > 1
        ? query.rq.replace(/^questions\//, "").replace(/\.rq$/, "")
        : leaf(query.rq);
}

/**
 * What a file says of the queries at one size (`key` as `queriesKeys` gives it): the lines that read the first import and the SQL
 * versions off the rows, and each query's times. Undefined for a file that did not ask them.
 */
export function queriesOf(file, key) {
  const values = new Map();
  const extras = new Map();
  for (const { name, value, extra } of file.results ?? []) {
    values.set(name, value);
    extras.set(name, extra);
  }
  const at = (name) => values.get(`each-query-${key}/${name}`);
  const total = at("count/queries");
  if (total === undefined) return undefined;
  const prefix = `each-query-${key}/`;
  const names = (group) =>
    [...values.keys()]
      .filter((name) => name.startsWith(`${prefix}${group}/`))
      .map((name) => name.slice(prefix.length + group.length + 1));
  const queries = [];
  for (const id of names("sparql")) {
    const rq = (lastOf(extras.get(`${prefix}sparql/${id}`)) ?? id).split(
      ";",
    )[0];
    const records = /asked of (\d+) records/.exec(
      lastOf(extras.get(`${prefix}sparql/${id}`)) ?? "",
    );
    queries.push({
      name: id,
      rq,
      kind: kindOfQuery(rq),
      records: records === null ? 0 : Number(records[1]),
      sparql: at(`sparql/${id}`),
      sql: at(`sql/${id}`),
      page: at(`page/${id}`),
      rows: at(`rows/${id}`),
      equal: at(`equal/${id}`),
      timeout: at(`timeout/${id}`),
      why: lastOf(extras.get(`${prefix}equal/${id}`)),
    });
  }
  for (const id of names("not-run")) {
    const [rq, ...why] = (
      lastOf(extras.get(`${prefix}not-run/${id}`)) ?? id
    ).split(": ");
    queries.push({
      name: id,
      rq,
      kind: kindOfQuery(rq),
      records: 0,
      why: why.join(": "),
    });
  }
  labelled(queries);
  const ran = queries.filter(({ sparql }) => sparql !== undefined);
  const both = ran.filter(({ sql }) => sql !== undefined);
  const sum = (list, pick) =>
    list.reduce((all, one) => all + (pick(one) ?? 0), 0);
  const lines = [];
  const line = (id, text) => lines.push({ id, text });

  const probed = values.get(`fresh-first-screen-${key}/probed-total`);
  const stages = [...values.entries()].filter(([name]) =>
    name.startsWith(`fresh-first-screen-${key}/stage/`),
  );
  const staged = (...starts) =>
    sum(
      stages.filter(([name]) =>
        starts.some((start) =>
          name.slice(name.indexOf("/stage/") + 7).startsWith(start),
        ),
      ),
      ([, value]) => value,
    );
  const convert = values.get(
    `fresh-first-screen-${key}/stage/arrivals.convert`,
  );
  if (probed !== undefined && probed > 0 && convert !== undefined) {
    const adapters = staged("bridge.query-");
    line(
      "import",
      `Of the first import's ${took(probed)} (measured with the probe on), the Bridge's conversion took ${took(convert)} (${pct(convert / probed)}), and the adapters' own queries inside it ${took(adapters)} (${pct(adapters / probed)}).`,
    );
    const inside = staged(
      "derive.step-queries-",
      "build.query-",
      "matcher.rule-",
    );
    line(
      "inside",
      `The vocabulary's own queries that the import runs on the reference engine (derivations, views, matching rules) took ${took(inside)} (${pct(inside / probed)}).`,
    );
  }
  const withSql = at("count/with-sql") ?? 0;
  if (withSql > 0 && both.length > 0) {
    const reference = sum(both, ({ sparql }) => sparql);
    const sql = sum(both, (one) => one.sql);
    const differing = both.filter(({ equal }) => equal === 0).length;
    line(
      "sql",
      `${withSql} of the ${total} ${total === 1 ? "query has" : "queries have"} a SQL version. On this pod they took ${took(reference)} on the reference engine and ${took(sql)} in SQL (${ratio(reference / sql)} times as fast, ${pct(1 - sql / reference)} less)${
        differing === 0 ? "" : `; ${differing} of them gave other rows`
      }.`,
    );
  }
  const without = at("count/without-sql") ?? 0;
  const alone = ran.filter(({ sql }) => sql === undefined);
  if (without > 0)
    line(
      "without",
      `${plural(without, "query", "queries")} ${without === 1 ? "has" : "have"} no SQL version yet; the reference engine took ${took(sum(alone, ({ sparql }) => sparql))} for the ${alone.length} of them it could run.`,
    );
  const slow = ran.filter(({ timeout }) => timeout !== undefined);
  if (slow.length > 0)
    line(
      "limit",
      `${slow.length} ${slow.length === 1 ? "query ran" : "queries ran"} longer than its ${whole(slow[0].timeout)} s limit on the reference engine: ${slow.map(({ label }) => label).join(", ")}.`,
    );
  const slowest = [...both]
    .sort((a, b) => b.sparql - a.sparql)
    .slice(0, 3)
    .map(
      (one) =>
        `${one.label}: ${plural(one.rows ?? 0, "row")}; SPARQL ${took(one.sparql)}; SQL ${took(one.sql)} (${ratio(one.sparql / one.sql)} times); same rows: ${one.equal === 1 ? "yes" : one.equal === 0 ? "no" : "not compared"}.`,
    );
  if (slowest.length > 0) line("slowest", slowest.join(" "));

  const [, dataset = "", sealed] = /^(.+?)(-encrypted)?$/.exec(key) ?? [];
  return {
    key,
    dataset,
    encrypted: sealed !== undefined,
    entries: values.get(`fresh-first-screen-${key}/count/records`),
    referenceLoad: at("reference-load"),
    databaseLoad: at("database-load"),
    lines,
    queries,
  };
}

/** The size a page's pod was measured at, as a person reads it: "647 source entries", "16,833 source entries, measured nightly". */
export const queriesTitle = (page) => storedTitle(page);

const cell = (text, number = true) =>
  `<td${number ? ' class="n"' : ""}>${escaped(text)}</td>`;

/** A query's row of the table: its name, rows, the two times, how many times as fast SQL is, and whether the rows are the same. */
function queryRow(one) {
  const note =
    one.records > 0
      ? ` title="asked of ${one.records} records, the times added up"`
      : "";
  if (one.sparql === undefined)
    return `<tr><td${note}>${escaped(one.label)}</td><td class="n" colspan="6">not asked: ${escaped(one.why ?? "")}</td></tr>`;
  const speed =
    one.sql === undefined ? "" : `${ratio(one.sparql / one.sql)} times`;
  const same =
    one.sql === undefined
      ? ""
      : one.equal === 1
        ? "yes"
        : one.equal === 0
          ? "no"
          : "not compared";
  return `<tr><td${note}>${escaped(one.label)}</td>${cell(whole(one.rows ?? 0))}${cell(took(one.sparql))}${cell(one.sql === undefined ? "" : took(one.sql))}${cell(speed)}${cell(same)}${cell(one.page === undefined ? "" : took(one.page))}</tr>`;
}

/**
 * What a build's queries took, for a page: the lines, then one table of every query by what kind it is, the slowest on the
 * reference engine first, and what the section is about. `heading` is the HTML of the heading the block opens with, which the
 * caller has made safe.
 */
export function queriesHtml(page, { heading = "" } = {}) {
  const groups = KINDS.flatMap(([kind, label]) => {
    const own = page.queries
      .filter((one) => one.kind === kind)
      .sort((a, b) => (b.sparql ?? -1) - (a.sparql ?? -1));
    return own.length === 0
      ? []
      : [
          `<tr class="group"><th colspan="7">${escaped(label)}</th></tr>`,
          ...own.map(queryRow),
        ];
  });
  return `${heading}
<ul class="queries">
${page.lines.map(({ text }) => `<li>${escaped(text)}</li>`).join("\n")}
</ul>
<div class="scroll"><table class="speed">
<thead><tr><th>Query</th><th class="n">Rows</th><th class="n">Reference engine</th><th class="n">SQL</th><th class="n">SQL, times as fast</th><th class="n">Same rows</th><th class="n">First page of 20, SQL</th></tr></thead>
<tbody>
${groups.join("\n")}
</tbody>
</table></div>
<p class="note">${escaped(QUERIES_ABOUT)}</p>`;
}
