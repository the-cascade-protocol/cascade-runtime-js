import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { numberOf, type SpecPages } from "../src/spec.js";
import {
  ASSERTIONS,
  BLOB,
  FEATURE,
  hubWith,
  KIT,
  kimVocabulary,
  pagesOf,
  RAN_WITH,
  text,
  TREE,
  treeText,
} from "./kim-vocabulary.js";
import { readPage } from "./page.js";

/** The text of one page of `pages`. */
const pageText = (pages: SpecPages, path: string): string =>
  new TextDecoder().decode(pages.files.get(path));

/** Each example's result on a page, by its name. */
const results = (pages: SpecPages, path: string): Map<string, string> =>
  new Map(
    [
      ...pageText(pages, path).matchAll(
        /<details class="example ([\w-]+)">\n<summary><span[^>]*>[^<]*<\/span>([^<]*)<\/summary>/g,
      ),
    ].map(([, outcome, name]) => [
      (name ?? "").replaceAll("&#39;", "'"),
      outcome ?? "",
    ]),
  );

/**
 * The specification is the vocabulary's features. `specPages()` writes a page for each feature and each kit: every
 * rule, and every example with its latest conformance result.
 */
describe("The specification's pages · specPages()", () => {
  let built: SpecPages;

  before(async () => {
    built = await pagesOf(await kimVocabulary(), ASSERTIONS, RAN_WITH);
  });

  describe("with a feature", () => {
    it("gives each rule an anchor from its number", () => {
      const { ids } = readPage(pageText(built, "naming.html"));
      assert.ok(ids.has("n1"));
      assert.ok(ids.has("n2"));
    });

    it("shows each example's latest result: passed, failed with why, or not run", () => {
      assert.deepEqual(
        results(built, "naming.html"),
        new Map([
          ["one content is one version", "passed"],
          ["a version the run did not reach", "not-run"],
          ["a revision's name", "failed"],
        ]),
      );
      assert.match(
        readPage(pageText(built, "naming.html")).said,
        /N2: the revision has no name/,
      );
    });
  });

  describe("with a feature's list of its rules", () => {
    const entries = (html: string): string[] =>
      [...html.matchAll(/<li>(<a href="#[^"]+"[\s\S]*?)<\/li>/g)].map(
        ([, entry]) =>
          (entry ?? "")
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
      );

    it("gives each rule's number and title, its example count and its result", () => {
      assert.deepEqual(entries(pageText(built, "naming.html")), [
        "N1. A version is named by its content 2 examples: 1 pass, 1 not run",
        "N2. A revision is named by its own triples 1 example: 1 fail",
        "N3. A pod declares its scheme once no example",
        "N4. Files go where the layout says no example",
      ]);
    });

    it("keeps the whole title on hover, for a title the list cuts at two lines", () => {
      assert.match(
        pageText(built, "naming.html"),
        /<a href="#n2" title="N2\. A revision is named by its own triples">/,
      );
    });

    it("is a sidebar from 1000 px wide, and the script marks the rule in view", () => {
      const html = pageText(built, "naming.html");
      assert.match(
        html,
        /<nav class="rules-nav" aria-label="The rules"[^>]*>\s*<ol class="contents">/,
      );
      const css = new TextDecoder().decode(built.files.get("spec.css"));
      assert.match(
        css,
        /@media \(min-width: 1000px\)[^@]*\.rules-nav[^@]*position: sticky/,
      );
      assert.match(css, /-webkit-line-clamp: 2/);
      assert.match(
        html,
        /<script>[^]*aria-current[^]*addEventListener\("scroll"/,
      );
    });
  });

  describe("with a feature that opens on a scenario", () => {
    let scenario: SpecPages;

    before(async () => {
      const vocabulary = await kimVocabulary();
      await vocabulary.write(
        "runtime/scenario.feature",
        text(
          "Feature: Scenario\n  Kim has one allergy, recorded twice.\n\n  Rule: S1. A rule\n\n    Example: an example\n      Given a pod\n",
        ),
      );
      scenario = await pagesOf(vocabulary, ASSERTIONS, RAN_WITH);
    });

    it("keeps it behind a closed `details`, and shows the rules beside it", () => {
      const html = pageText(scenario, "scenario.html");
      const opening = html.indexOf('<details class="scenario">');
      assert.ok(opening > 0);
      assert.match(
        html.slice(opening),
        /^<details class="scenario">\s*<summary>The scenario the examples run<\/summary>[^]*Kim has one allergy, recorded twice\.[^]*<\/details>/,
      );
      assert.doesNotMatch(
        html.slice(0, opening),
        /Kim has one allergy, recorded twice/,
      );
    });

    it("opens no `details` for a feature that has none", () => {
      assert.doesNotMatch(pageText(built, "naming.html"), /class="scenario"/);
    });
  });

  describe("with a feature file, for a tool", () => {
    it("copies the feature file beside its page, and links that copy and not GitHub's page", () => {
      const html = pageText(built, "naming.html");
      assert.equal(pageText(built, "naming.feature"), FEATURE);
      assert.match(
        html,
        /For tools: <a href="naming\.feature">runtime\/naming\.feature<\/a>/,
      );
      assert.ok(!html.includes(`${BLOB}runtime/naming.feature`));
    });

    it("does the same for a kit's feature file", () => {
      assert.equal(pageText(built, "kim.feature"), KIT);
      assert.match(
        pageText(built, "kim.html"),
        /For tools: <a href="kim\.feature">conformance\/kim\/kim\.feature<\/a>/,
      );
    });
  });

  describe("with a rule whose description holds paragraphs and a list", () => {
    const LISTED = `Feature: Listed
  Rule: L1. Holds paragraphs and a list
    First paragraph, which
    wraps.

    The rows are:

    - R1, one: first.
    - R2, two: second,
      which wraps.

    Last paragraph.

  Rule: L2. Opens on a sentence, then a list
    Rows follow.

    - R1: a.
    - R2: b.

  Rule: L3. Closes a list with an unindented line
    - R1: a,
      which wraps.
    - R2: b.
    That is all of them.
`;
    let page: string;

    before(async () => {
      const vocabulary = await kimVocabulary();
      await vocabulary.write("runtime/listed.feature", text(LISTED));
      page = pageText(await pagesOf(vocabulary, [], RAN_WITH), "listed.html");
    });

    const rule = (id: string) => {
      const html = page.slice(page.indexOf(`id="${id}"`));
      return html.slice(0, html.indexOf("</section>"));
    };

    it("keeps its paragraphs, and shows a list as a list, whether the list follows a paragraph or the rule's first sentence", () => {
      for (const id of ["l1", "l2"]) {
        const html = page.slice(page.indexOf(`id="${id}"`));
        const section = html.slice(0, html.indexOf("</section>"));
        assert.match(section, /<ul[^>]*>\s*<li>R1[^]*<li>R2/);
      }
      const first = rule("l1");
      assert.match(
        first,
        /<p class="prose">First paragraph, which wraps\.<\/p>/,
      );
      assert.match(first, /<li>R2, two: second, which wraps\.<\/li>/);
      assert.match(first, /<p class="prose">Last paragraph\.<\/p>/);
    });

    it("starts a paragraph at an unindented line after a list item, and joins only an indented line to it", () => {
      const closed = rule("l3");
      assert.match(closed, /<li>R1: a, which wraps\.<\/li>/);
      assert.match(closed, /<li>R2: b\.<\/li>/);
      assert.match(closed, /<p class="prose">That is all of them\.<\/p>/);
    });
  });

  describe("with a kit", () => {
    let page: ReturnType<typeof readPage>;

    before(() => {
      page = readPage(pageText(built, "kim.html"));
    });

    it("shows the kit's name and its story", () => {
      assert.equal(page.h1, "Kim's pod");
      assert.match(page.said, /Background: Kim's story/);
    });

    it("links the input its story runs on and its expected views on GitHub", () => {
      for (const link of [
        `${BLOB}conformance/kim/scripted-input/people.ttl`,
        `${TREE}conformance/kim/scripted-input/kim/bridge/`,
        `${BLOB}conformance/kim/expected/allergies.ttl`,
      ])
        assert.ok(page.hrefs.includes(link), link);
    });

    it("shows each check's result, with why for one that failed", () => {
      assert.match(page.said, /Check 1\. Every example passes pass/);
      assert.match(
        page.said,
        /Check 2\. Each final view equals expected\/ fail why allergies\.ttl differs/,
      );
    });

    it("shows each example's result", () => {
      assert.deepEqual(
        results(built, "kim.html"),
        new Map([["one allergy record", "passed"]]),
      );
    });
  });

  describe("`index.html`", () => {
    it("links every feature's page and every kit's", () => {
      const { hrefs } = readPage(pageText(built, "index.html"));
      for (const page of ["naming.html", "the-kit.html", "kim.html"])
        assert.ok(hrefs.includes(page), page);
    });
  });
});

describe("A rule's number · numberOf()", () => {
  describe("`numberOf()`", () => {
    const numbered = (name: string) =>
      numberOf({ name, description: "", examples: [] });

    it("reads the number of a rule's name, with or without a lower-case letter, and of a check", () => {
      assert.equal(numbered("M4. Matcher."), "M4");
      assert.equal(numbered("M4a. Matcher."), "M4a");
      assert.equal(numbered("R12. Another."), "R12");
      assert.equal(numbered("Check 3. A kit's."), "Check 3");
      assert.equal(numbered("M4A. Not a number."), undefined);
      assert.equal(numbered("A rule with none"), undefined);
    });
  });
});

/**
 * The vocabulary keeps a `decisions/` folder for its records, and the hub publishes none of it: a page of it would be
 * the vocabulary's reasoning under the hub's name, unchecked.
 */
describe("The hub publishes no decision notes · specSection", () => {
  it("writes no page under `decisions/` and no page links to one, though the vocabulary has the folder", async () => {
    const vocabulary = await kimVocabulary();
    await vocabulary.write("decisions/a-record.md", text("# A record\n"));
    const tree = await hubWith(vocabulary, ASSERTIONS);
    assert.deepEqual(
      [...tree.keys()].filter((path) => path.startsWith("decisions/")),
      [],
    );
    assert.deepEqual(
      [...tree.keys()].filter(
        (path) =>
          path.endsWith(".html") &&
          /href="[^"]*decisions\//.test(treeText(tree, path)),
      ),
      [],
    );
  });
});
