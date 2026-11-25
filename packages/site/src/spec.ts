import {
  featuresOf,
  type Files,
  kitsOf,
  type Outcome,
  OxigraphStore,
  readWrittenFeature,
  Union,
  type WrittenExample,
  type WrittenFeature,
  type WrittenRule,
} from "@cascade-runtime/runtime";
import type { Ingredient } from "./front-page.js";
import { type Chrome, type Content, Html, markup, shell } from "./html.js";
import { anchorOf, frontPageLink, pageNameOf } from "./links.js";
import { STYLESHEET } from "./stylesheet.js";

const EARL = "http://www.w3.org/ns/earl#";
const VOCABULARY = "cascade-vocabulary";
export const SPEC_STYLESHEET_FILE = "spec.css";
export const SPEC_INDEX = "index.html";

/** One example's or check's latest result, by its test's IRI relative to the vocabulary's. */
export interface SpecResult {
  readonly outcome: Outcome;
  readonly why?: string;
}

/** What a conformance report says: each test's result, and what the runtime was run with. */
export interface SpecReport {
  readonly results: ReadonlyMap<string, SpecResult>;
  /** The vocabulary's IRI the run read, ending in a slash, which each of its tests' IRIs begins with. */
  readonly vocabulary?: string;
  readonly ranWith: readonly Ingredient[];
  /** Each test the report holds more than one assertion of, as {@link results} keys it. */
  readonly repeated: readonly string[];
}

export interface SpecOptions {
  /** The vocabulary, named by the IRI of its tree. */
  readonly vocabulary: Files;
  readonly report: SpecReport;
  /** What the pages were built from, for the index's footer. */
  readonly builtFrom: readonly Ingredient[];
  readonly at: string;
  readonly chrome: Chrome;
}

/** Something the pages are built from does not agree with the rest. */
export interface SpecWarning {
  readonly kind: "two examples share a test" | "page name taken" | "report";
  readonly where: string;
  readonly what: string;
}

/** One feature's or kit's line of the results table: how many of its examples passed, failed or were not run. */
export interface FeatureResult {
  readonly path: string;
  readonly name: string;
  /** The feature's page among the spec's pages. */
  readonly page: string;
  readonly kit: boolean;
  readonly rules: number;
  /** The rules with no example, which no result can speak for. */
  readonly withoutExample: number;
  readonly passed: number;
  readonly failed: number;
  readonly notRun: number;
  /** A kit's checks after Check 1 (which is its examples), counted apart from the examples; none for a feature. */
  readonly checks?: {
    readonly passed: number;
    readonly failed: number;
    readonly notRun: number;
  };
}

export interface SpecPages {
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The features and then the kits, each with its tally. */
  readonly features: readonly FeatureResult[];
  readonly warnings: readonly SpecWarning[];
}

/** The EARL report a conformance run wrote, read. */
export async function readSpecReport(bytes: Uint8Array): Promise<SpecReport> {
  const store = new Union(new OxigraphStore());
  await store.loadTurtle(bytes, "urn:report");
  const used = await store.select(`SELECT ?used ?name ?revision WHERE {
      ?subject a <${EARL}TestSubject> ; <http://purl.org/dc/terms/requires> ?used .
      ?used <http://usefulinc.com/ns/doap#name> ?name ; <http://usefulinc.com/ns/doap#revision> ?revision
    }`);
  const ranWith = used.rows
    .map((row) => ({
      name: row.get("name")?.value ?? "",
      version: (row.get("revision")?.value ?? "").slice(0, 12),
      href: row.get("used")?.value ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const named = ranWith.find(({ name }) => name === VOCABULARY)?.href;
  const vocabulary = named === undefined ? undefined : withSlash(named);
  const { rows } = await store.select(`PREFIX earl: <${EARL}>
    SELECT ?assertion ?test ?outcome ?why WHERE {
      ?assertion a earl:Assertion ; earl:test ?test ; earl:result ?result . ?result earl:outcome ?outcome
      OPTIONAL { ?result <http://purl.org/dc/terms/description> ?why }
    }`);
  const results = new Map<string, SpecResult>();
  const assertions = new Map<string, Set<string>>();
  for (const row of rows) {
    const test = row.get("test")?.value ?? "";
    const why = row.get("why")?.value;
    const key =
      vocabulary !== undefined && test.startsWith(vocabulary)
        ? test.slice(vocabulary.length)
        : test;
    const seen = assertions.get(key) ?? new Set();
    seen.add(termKey(row.get("assertion")));
    assertions.set(key, seen);
    const result: SpecResult = {
      outcome: (row.get("outcome")?.value ?? "").slice(EARL.length) as Outcome,
      ...(why === undefined ? {} : { why }),
    };
    const held = results.get(key);
    if (held === undefined || RANK(result) > RANK(held))
      results.set(key, result);
  }
  return {
    results,
    ranWith,
    repeated: [...assertions]
      .filter(([, seen]) => seen.size > 1)
      .map(([key]) => key)
      .sort(),
    ...(vocabulary === undefined ? {} : { vocabulary }),
  };
}

const withSlash = (iri: string): string =>
  iri.endsWith("/") ? iri : `${iri}/`;

/** Of two results for one test, a fail outranks a pass, which outranks anything else. */
const RANK = ({ outcome }: SpecResult): number =>
  outcome === "failed" ? 2 : outcome === "passed" ? 1 : 0;

const termKey = (
  term: { readonly termType: string; readonly value: string } | undefined,
): string => (term === undefined ? "" : `${term.termType}:${term.value}`);

const RULE_NUMBER = /^([A-Z]+\d+[a-z]?|Check \d+)\.\s*/;
/** The rule's number, `R19` or `Check 3`, as its heading's anchor is made from, or undefined for a rule with none. */
export const numberOf = (rule: WrittenRule): string | undefined =>
  RULE_NUMBER.exec(rule.name)?.[1];

const LABEL: Readonly<Record<string, string>> = {
  passed: "pass",
  failed: "fail",
};
const resultClass = (result: SpecResult | undefined): string =>
  result?.outcome === "passed"
    ? "passed"
    : result?.outcome === "failed"
      ? "failed"
      : "not-run";
const badge = (result: SpecResult | undefined): Html =>
  markup`<span class="result ${resultClass(result)}">${LABEL[result?.outcome ?? ""] ?? "not run"}</span>`;

interface Tally {
  passed: number;
  failed: number;
  notRun: number;
}

function tally(results: readonly (SpecResult | undefined)[]): Tally {
  const counted: Tally = { passed: 0, failed: 0, notRun: 0 };
  for (const result of results)
    if (result?.outcome === "passed") counted.passed++;
    else if (result?.outcome === "failed") counted.failed++;
    else counted.notRun++;
  return counted;
}

const tallied = ({ passed, failed, notRun }: Tally): string =>
  `${passed} pass, ${failed} fail, ${notRun} not run`;

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** A rule's line of the contents: its example count, and the results of those that have one. */
const contentsTally = ({ passed, failed, notRun }: Tally): string =>
  passed + failed + notRun === 0
    ? "no example"
    : `${plural(passed + failed + notRun, "example")}: ${[
        passed > 0 ? `${passed} pass` : "",
        failed > 0 ? `${failed} fail` : "",
        notRun > 0 ? `${notRun} not run` : "",
      ]
        .filter((part) => part !== "")
        .join(", ")}`;

/** Marks, in the contents, the last rule whose top is above the line near the window's top, and the last rule at the page's end. */
const IN_VIEW = `
(function () {
  var nav = document.querySelector(".rules-nav");
  var sections = document.querySelectorAll("section.rule[id]");
  if (!nav || !sections.length) return;
  var links = {};
  nav.querySelectorAll("a[href^='#']").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
  var line = 17;
  var marked = null;
  var queued = false;
  function mark() {
    queued = false;
    var current = sections[0].id;
    for (var i = 0; i < sections.length; i += 1) {
      if (sections[i].getBoundingClientRect().top > line) break;
      current = sections[i].id;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = sections[sections.length - 1].id;
    if (current === marked) return;
    marked = current;
    Object.keys(links).forEach(function (id) {
      if (id === current) links[id].setAttribute("aria-current", "true");
      else links[id].removeAttribute("aria-current");
    });
    var a = links[current];
    if (!a) return;
    var box = nav.getBoundingClientRect();
    var at = a.getBoundingClientRect();
    if (current === sections[0].id) nav.scrollTop = 0;
    else if (at.top < box.top || at.bottom > box.bottom) nav.scrollTop += at.top - box.top - nav.clientHeight / 3;
  }
  function soon() { if (!queued) { queued = true; requestAnimationFrame(mark); } }
  window.addEventListener("scroll", soon, { passive: true });
  window.addEventListener("resize", soon);
  mark();
})();
`;

class Spec {
  readonly warnings: SpecWarning[] = [];
  readonly blob: string;
  readonly chrome: Chrome;
  readonly #options: SpecOptions;
  readonly features: readonly WrittenFeature[];
  readonly kits: readonly { folder: string; feature: WrittenFeature }[];

  constructor(
    options: SpecOptions,
    features: readonly WrittenFeature[],
    kits: readonly { folder: string; feature: WrittenFeature }[],
  ) {
    this.#options = options;
    this.features = features;
    this.kits = kits;
    const { iri } = options.vocabulary;
    this.blob = iri.includes("/tree/") ? iri.replace("/tree/", "/blob/") : iri;
    this.tree = iri;
    this.chrome = options.chrome;
  }

  readonly tree: string;

  /** Each feature file's page, where it is not the one its name gives. */
  readonly pages = new Map<string, string>();

  pageOf(path: string): string {
    return this.pages.get(path) ?? pageNameOf(path);
  }

  result(example: Pick<WrittenExample, "iri">): SpecResult | undefined {
    const { iri } = this.#options.vocabulary;
    const { results } = this.#options.report;
    return example.iri.startsWith(iri)
      ? (results.get(example.iri.slice(iri.length)) ?? results.get(example.iri))
      : results.get(example.iri);
  }

  /** What keeps the report's results from joining the pages, as warnings on the index. */
  joined(): void {
    const { report, vocabulary } = this.#options;
    if (report.results.size === 0) return;
    for (const test of report.repeated)
      this.#warn(
        "report",
        test,
        "the report holds more than one result for this test; the worst is shown",
      );
    if (report.vocabulary === undefined)
      this.#warn(
        "report",
        "",
        `the report names no ${VOCABULARY} it was run with`,
      );
    else if (report.vocabulary !== vocabulary.iri)
      this.#warn(
        "report",
        "",
        `the report was run with ${report.vocabulary}, the pages are built from ${vocabulary.iri}`,
      );
    const all = [...this.features, ...this.kits.map(({ feature }) => feature)];
    if (
      all.every(({ rules }) =>
        rules.every(({ examples }) =>
          examples.every((e) => this.result(e) === undefined),
        ),
      )
    )
      this.#warn(
        "report",
        "",
        "no result of the report joins an example of the pages",
      );
    for (const feature of all) {
      const seen = new Set<string>();
      for (const { examples } of feature.rules)
        for (const { iri, name } of examples) {
          if (seen.has(iri))
            this.#warn(
              "two examples share a test",
              feature.path,
              `more than one example is "${name}"`,
            );
          seen.add(iri);
        }
    }
  }

  warn(kind: SpecWarning["kind"], where: string, what: string): void {
    this.#warn(kind, where, what);
  }

  check(kit: string, number: string): SpecResult | undefined {
    const prefix = `${kit}/#${anchorOf(number)}-`;
    for (const [test, result] of this.#options.report.results)
      if (test.startsWith(prefix)) return result;
    return undefined;
  }

  /** The result of each of a kit's checks after Check 1, which is its examples. */
  kitCheckResults(folder: string): (SpecResult | undefined)[] {
    return this.features
      .flatMap(({ rules }) => rules)
      .map(numberOf)
      .filter(
        (number) =>
          number?.startsWith("Check ") === true && number !== "Check 1",
      )
      .map((number) => this.check(folder, number ?? ""));
  }

  /** Check 1 of a kit: every example passes. */
  everyExample(feature: WrittenFeature): SpecResult | undefined {
    const counted = tally(
      feature.rules.flatMap(({ examples }) =>
        examples.map((e) => this.result(e)),
      ),
    );
    if (counted.failed > 0)
      return { outcome: "failed", why: `${counted.failed} examples fail` };
    if (counted.notRun > 0 || counted.passed === 0) return undefined;
    return { outcome: "passed" };
  }

  #warn(kind: SpecWarning["kind"], where: string, what: string): void {
    this.warnings.push({ kind, where, what });
  }
}

function page(
  spec: Spec,
  title: string,
  main: Content,
  after?: Content,
): Uint8Array {
  return new TextEncoder().encode(
    shell({
      chrome: spec.chrome,
      title: markup`${title} · Cascade runtime rules`,
      stylesheet: SPEC_STYLESHEET_FILE,
      hubRoot: "../",
      nav: markup`${frontPageLink(1)}
<a href="${SPEC_INDEX}">The rules</a>
${spec.features.map((feature) => markup`<a href="${spec.pageOf(feature.path)}">${feature.name}</a>\n`)}`,
      main: markup`${main}\n`,
      after,
    }).text,
  );
}

/** The feature file of a page, copied beside it for a tool. */
const fileOfPage = (page: string): string =>
  page.replace(/\.html$/, ".feature");

const forTools = (spec: Spec, feature: WrittenFeature): Html =>
  markup`<p class="kind">For tools: <a href="${fileOfPage(spec.pageOf(feature.path))}">${feature.path}</a></p>`;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

/** The lines of one paragraph: those that begin `- ` are the items of a list, a line after one that is indented further is that item's own, and any other starts a paragraph. */
function paragraph(lines: readonly string[]): Html {
  const blocks: { list: boolean; lines: string[]; indent: number }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const indent = indentOf(raw);
    const item = line.startsWith("- ");
    const last = blocks.at(-1);
    if (last === undefined || (item && !last.list))
      blocks.push({ list: item, lines: [line], indent });
    else if (item) {
      last.lines.push(line);
      last.indent = indent;
    } else if (last.list && indent > last.indent)
      last.lines[last.lines.length - 1] += ` ${line}`;
    else if (last.list) blocks.push({ list: false, lines: [line], indent });
    else last.lines.push(line);
  }
  return markup`${blocks.map(({ list, lines: block }) =>
    list
      ? markup`<ul>\n${block.map((line) => markup`<li>${oneLine(line.slice(2))}</li>\n`)}</ul>\n`
      : markup`<p class="prose">${oneLine(block.join(" "))}</p>\n`,
  )}`;
}

function prose(text: string): Html {
  return markup`${text
    .split(/\n\s*\n/)
    .filter((block) => block.trim() !== "")
    .map((block) => paragraph(block.split("\n")))}`;
}

function example(spec: Spec, written: WrittenExample): Html {
  const result = spec.result(written);
  return markup`<details class="example ${resultClass(result)}">
<summary>${badge(result)}${written.name}</summary>
<pre>${written.text}</pre>
${result?.outcome === "failed" && result.why !== undefined ? markup`<pre class="failure">${result.why}</pre>\n` : ""}</details>
`;
}

function examples(spec: Spec, rule: WrittenRule): Html {
  return markup`${rule.examples.map((written) => example(spec, written))}`;
}

function kitChecks(spec: Spec, number: string): Html {
  return markup`<table class="checks">
<thead><tr><th>kit</th><th>result</th></tr></thead>
<tbody>
${spec.kits.map(({ folder, feature }) => {
  const result =
    number === "Check 1"
      ? spec.everyExample(feature)
      : spec.check(folder, number);
  return markup`<tr><td data-label="kit"><a href="${spec.pageOf(feature.path)}">${feature.name}</a></td><td data-label="result">${badge(result)}${result?.outcome === "failed" && result.why !== undefined ? markup`<details><summary>why</summary><pre class="failure">${result.why}</pre></details>` : ""}</td></tr>\n`;
})}</tbody>
</table>
`;
}

function rulesPart(spec: Spec, feature: WrittenFeature): Html {
  return markup`${feature.rules.map((rule) => {
    const number = numberOf(rule);
    const counted = tally(rule.examples.map((e) => spec.result(e)));
    const id = number === undefined ? undefined : anchorOf(number);
    return markup`<section class="rule"${id === undefined ? "" : markup` id="${id}"`}>
<h2>${rule.name === "" ? "Examples under no rule" : rule.name}</h2>
${prose(rule.description)}${rule.examples.length === 0 ? "" : markup`<p class="count">${plural(rule.examples.length, "example")}: ${tallied(counted)}</p>\n`}${examples(spec, rule)}${number?.startsWith("Check ") === true ? kitChecks(spec, number) : ""}</section>
`;
  })}`;
}

function featurePage(spec: Spec, feature: WrittenFeature): Uint8Array {
  const counted = tally(
    feature.rules.flatMap(({ examples: listed }) =>
      listed.map((e) => spec.result(e)),
    ),
  );
  const listed = feature.rules.filter((rule) => numberOf(rule) !== undefined);
  return page(
    spec,
    feature.name,
    markup`${forTools(spec, feature)}
<h1>${feature.name}</h1>
${
  feature.description.trim() === ""
    ? ""
    : markup`<details class="scenario">
<summary>The scenario the examples run</summary>
${prose(feature.description)}</details>
`
}<p class="count">${plural(feature.rules.length, "rule")}, ${plural(counted.passed + counted.failed + counted.notRun, "example")}: ${tallied(counted)}</p>
<div class="rules-layout">
<nav class="rules-nav" aria-label="The rules">
<ol class="contents">
${listed.map((rule) => {
  const own = tally(rule.examples.map((e) => spec.result(e)));
  return markup`<li><a href="#${anchorOf(numberOf(rule) ?? "")}" title="${rule.name}"><span class="title">${rule.name}</span></a> <span class="tally ${own.failed > 0 ? "failed" : own.notRun === 0 && own.passed > 0 ? "passed" : "not-run"}">${contentsTally(own)}</span></li>\n`;
})}</ol>
</nav>
<div class="rules-body">
${rulesPart(spec, feature)}</div>
</div>`,
    markup`<script>${new Html(IN_VIEW)}</script>\n`,
  );
}

function kitPage(
  spec: Spec,
  folder: string,
  feature: WrittenFeature,
  inputs: readonly (readonly [string, number])[],
  expected: readonly string[],
): Uint8Array {
  const checks = spec.features.find((f) =>
    f.rules.some((rule) => numberOf(rule)?.startsWith("Check ") === true),
  );
  const checkRules =
    checks?.rules.filter(
      (rule) => numberOf(rule)?.startsWith("Check ") === true,
    ) ?? [];
  return page(
    spec,
    feature.name,
    markup`${forTools(spec, feature)}
<h1>${feature.name}</h1>
${prose(feature.description)}
<h2 class="part">The result</h2>
<table class="checks">
<thead><tr><th>check</th><th>result</th></tr></thead>
<tbody>
${checkRules.map((rule) => {
  const number = numberOf(rule) ?? "";
  const result =
    number === "Check 1"
      ? spec.everyExample(feature)
      : spec.check(folder, number);
  return markup`<tr><td data-label="check"><a href="${checks === undefined ? "" : spec.pageOf(checks.path)}#${anchorOf(number)}">${rule.name}</a></td><td data-label="result">${badge(result)}${result?.outcome === "failed" && result.why !== undefined ? markup`<details><summary>why</summary><pre class="failure">${result.why}</pre></details>` : ""}</td></tr>\n`;
})}</tbody>
</table>
<h2 class="part">The story</h2>
<details class="example">
<summary>${feature.background.split("\n")[0] ?? ""}</summary>
<pre>${feature.background}</pre>
</details>
<h2 class="part">The scripted input</h2>
<ul class="files">
${inputs.map(([path, count]) => markup`<li><a href="${(path.endsWith("/") ? spec.tree : spec.blob) + folder}/scripted-input/${path}">${path}</a>${count > 1 ? markup` <span class="about">${plural(count, "file")}</span>` : ""}</li>\n`)}</ul>
<h2 class="part">The expected views</h2>
<ul class="files">
${expected.map((path) => markup`<li><a href="${spec.blob}${folder}/expected/${path}">${path}</a></li>\n`)}</ul>
<h2 class="part">The planted cases</h2>
${rulesPart(spec, feature)}`,
  );
}

function featureResult(
  spec: Spec,
  feature: WrittenFeature,
  kit: string | undefined,
): FeatureResult {
  const counted = tally(
    feature.rules.flatMap(({ examples: listed }) =>
      listed.map((e) => spec.result(e)),
    ),
  );
  return {
    path: feature.path,
    name: feature.name,
    page: spec.pageOf(feature.path),
    kit: kit !== undefined,
    rules: feature.rules.length,
    withoutExample: feature.rules.filter(
      ({ examples }) => examples.length === 0,
    ).length,
    passed: counted.passed,
    failed: counted.failed,
    notRun: counted.notRun,
    ...(kit === undefined ? {} : { checks: tally(spec.kitCheckResults(kit)) }),
  };
}

/** The table of each feature's rules and results, whose links to the pages begin with `base`. The spec's index and the conformance page both show it. */
export function resultsTable(
  listed: readonly FeatureResult[],
  base: string,
): Html {
  const checked = listed.some(({ checks }) => checks !== undefined);
  return markup`<table class="results">
<thead><tr><th>feature</th><th>rules</th><th>rules with no example</th><th>examples pass</th><th>examples fail</th><th>examples not run</th>${checked ? markup`<th>checks pass</th><th>checks fail</th><th>checks not run</th>` : ""}</tr></thead>
<tbody>
${listed.map(({ name, page, rules, withoutExample, passed, failed, notRun, checks }) => markup`<tr><td data-label="feature"><a href="${base}${page}">${name}</a></td><td data-label="rules">${rules}</td><td data-label="rules with no example">${withoutExample}</td>${passed + failed + notRun === 0 ? markup`<td data-label="examples" colspan="3" class="about">no example</td>` : markup`<td data-label="examples pass">${passed}</td><td data-label="examples fail">${failed}</td><td data-label="examples not run">${notRun}</td>`}${checked ? markup`<td data-label="checks pass">${checks?.passed ?? ""}</td><td data-label="checks fail">${checks?.failed ?? ""}</td><td data-label="checks not run">${checks?.notRun ?? ""}</td>` : ""}</tr>\n`)}</tbody>
</table>`;
}

/** The repositories a run was made with, as a list under a heading; nothing when it names none. */
export const ranWithList = (
  heading: string,
  listed: readonly Ingredient[],
): Html =>
  listed.length === 0
    ? markup``
    : markup`<p class="about">${heading}</p>
<ul class="about">
${listed.map(({ name, version, href }) => markup`<li><a href="${href}">${name} ${version}</a></li>\n`)}</ul>
`;

function indexPage(
  spec: Spec,
  options: SpecOptions,
  results: readonly FeatureResult[],
): Uint8Array {
  return page(
    spec,
    "The rules",
    markup`<h1>The Cascade runtime rules</h1>
<p class="prose">Every rule of cascade-vocabulary's <code>runtime/</code> features, its examples as written, and the
reference runtime's latest result for each, from the EARL report its conformance run wrote. The conformance kits follow: each person's story, its scripted
input, its expected views and its result. Built from the repositories on every run; never edited by hand.</p>
<h2 class="part">The features</h2>
${resultsTable(
  results.filter(({ kit }) => !kit),
  "",
)}
<h2 class="part">The kits</h2>
${resultsTable(
  results.filter(({ kit }) => kit),
  "",
)}
<h2 class="part" id="warnings">Warnings</h2>
<p class="prose">${plural(spec.warnings.length, "place")} where the pages and the report do not agree:</p>
<ul class="warnings">
${spec.warnings.map(({ kind, where, what }) => markup`<li><span class="about">${kind}</span> ${where === "" ? "" : markup`${where}: `}${what}</li>\n`)}</ul>
<footer>
<p class="about">Built at <time datetime="${options.at}">${options.at}</time> from:</p>
<ul class="about">
${options.builtFrom.map(({ name, version, href }) => markup`<li><a href="${href}">${name} ${version}</a></li>\n`)}</ul>
${ranWithList("The results are of the run with:", options.report.ranWith)}</footer>`,
  );
}

const SPEC_STYLES = `
.result { display: inline-block; min-width: 4.2rem; margin-right: .6rem; padding: 0 .4rem; border-radius: 3px;
          text-align: center; font: 600 .75rem/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
.result.passed { background: #e3f4e8; color: #1d6b35; }
.result.failed { background: #fbe5e5; color: #a3201f; }
.result.not-run { background: var(--paper); color: var(--muted); }
section.rule { margin: 2rem 0 0; padding: 1rem 0 0; border-top: 1px solid var(--rule); }
details.example summary { color: var(--ink); }
details.example pre { margin: .25rem 0 .75rem; }
pre.failure { background: #fdf2f2; white-space: pre-wrap; }
ol.contents { columns: 2 22rem; font-size: .9rem; }
ol.contents li { break-inside: avoid; margin-bottom: .35rem; }
.rules-nav a { display: block; }
.rules-nav .title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.tally { display: block; font-size: .78rem; color: var(--muted); }
.tally.failed { color: #a3201f; }
.rules-nav a[aria-current] { font-weight: 600; }
details.scenario { margin: .5rem 0 1rem; max-width: 46rem; }
details.scenario summary { cursor: pointer; }
section.rule { scroll-margin-top: 16px; }
@media (min-width: 1000px) {
  .rules-layout { display: grid; grid-template-columns: 17rem minmax(0, 1fr); gap: 2rem; align-items: start; }
  .rules-nav { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow-y: auto; padding-right: .5rem; }
  ol.contents { columns: 1; list-style: none; margin: 0; padding: 0; }
  .rules-nav a[aria-current] { border-left: 3px solid var(--ink); margin-left: -.6rem; padding-left: .5rem; }
  .rules-body section.rule:first-child { margin-top: 0; border-top: 0; padding-top: 0; }
}
ul.warnings { font-size: .9rem; }
main footer { margin-top: 3rem; border-top: 1px solid var(--rule); }
`;

/**
 * The spec's pages: an index, a page per feature of `runtime/` and a page per kit, each rule beside its examples and
 * each example beside its latest result; and everything the pages and the report do not agree on, as warnings.
 */
export async function specPages(options: SpecOptions): Promise<SpecPages> {
  const { vocabulary } = options;
  const paths = await featuresOf(vocabulary);
  const features = await Promise.all(
    paths
      .filter((path) => path.startsWith("runtime/"))
      .sort()
      .map((path) => readWrittenFeature(vocabulary, path)),
  );
  const kitFolders = (await kitsOf(vocabulary)).sort();
  const kits = await Promise.all(
    kitFolders.map(async (folder) => ({
      folder,
      feature: await readWrittenFeature(
        vocabulary,
        `${folder}/${folder.slice(folder.lastIndexOf("/") + 1)}.feature`,
      ),
    })),
  );
  const spec = new Spec(options, features, kits);
  const taken = new Set([
    SPEC_INDEX,
    ...features.map(({ path }) => pageNameOf(path)),
  ]);
  for (const { folder, feature } of kits) {
    const name = pageNameOf(feature.path);
    if (!taken.has(name)) continue;
    spec.pages.set(feature.path, `kit-${name}`);
    spec.warn(
      "page name taken",
      folder,
      `the kit's page would be ${name}, a feature's, so it is kit-${name}`,
    );
  }
  spec.joined();
  const files = new Map<string, Uint8Array>();
  for (const feature of features)
    files.set(spec.pageOf(feature.path), featurePage(spec, feature));
  for (const { path } of [...features, ...kits.map((kit) => kit.feature)]) {
    const bytes = await vocabulary.read(path);
    if (bytes === undefined) throw new Error(`${path} does not exist`);
    files.set(fileOfPage(spec.pageOf(path)), bytes);
  }
  for (const { folder, feature } of kits) {
    const listed = await vocabulary.list(`${folder}/scripted-input`);
    const inputs = new Map<string, number>();
    for (const path of listed) {
      const parts = path
        .slice(folder.length + "/scripted-input/".length)
        .split("/");
      const key =
        parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.join("/");
      inputs.set(key, (inputs.get(key) ?? 0) + 1);
    }
    const expected = (await vocabulary.list(`${folder}/expected`))
      .map((path) => path.slice(folder.length + "/expected/".length))
      .sort();
    files.set(
      spec.pageOf(feature.path),
      kitPage(
        spec,
        folder,
        feature,
        [...inputs].sort(([a], [b]) => a.localeCompare(b)),
        expected,
      ),
    );
  }
  const results = [
    ...spec.features.map((feature) => featureResult(spec, feature, undefined)),
    ...spec.kits.map(({ folder, feature }) =>
      featureResult(spec, feature, folder),
    ),
  ];
  files.set(SPEC_INDEX, indexPage(spec, options, results));
  files.set(
    SPEC_STYLESHEET_FILE,
    new TextEncoder().encode(STYLESHEET + SPEC_STYLES),
  );
  return {
    files,
    features: results,
    warnings: spec.warnings,
  };
}
