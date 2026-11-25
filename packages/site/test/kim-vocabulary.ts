import {
  type Assertion,
  earl,
  MemoryFiles,
  type TestedWith,
} from "@cascade-runtime/runtime";
import { hubFiles } from "../src/front-page.js";
import { PLAIN } from "../src/html.js";
import { specSection } from "../src/hub/spec.js";
import { buildTree, type Finisher } from "../src/sections.js";
import { readSpecReport, type SpecPages, specPages } from "../src/spec.js";

export const TREE =
  "https://github.com/the-cascade-protocol/cascade-vocabulary/tree/abc/";
export const BLOB =
  "https://github.com/the-cascade-protocol/cascade-vocabulary/blob/abc/";
export const NAMING = `${TREE}runtime/naming.feature#`;

export const text = (value: string) => new TextEncoder().encode(value);

export const FEATURE = `Feature: Naming
  Rule: N1. A version is named by its content

    Example: one content is one version
      Given a new pod for Kim on 2026-09-01 at 09:55

    Example: a version the run did not reach
      Given a new pod for Kim on 2026-09-01 at 09:55

  Rule: N2. A revision is named by its own triples

    Example: a revision's name
      Given a new pod for Kim on 2026-09-01 at 09:55

  Rule: N3. A pod declares its scheme once

  Rule: N4. Files go where the layout says
`;

export const KIT = `Feature: Kim's pod
  Kim's story.

  Background: Kim's story
    Given a new pod for Kim on 2026-09-01 at 09:55 (E1)

  Rule: P1. One allergy

    Example: one allergy record
      Then the pod holds 1 allergy
`;

export const THE_KIT = `Feature: The conformance kit
  Rule: Check 1. Every example passes
    Its tests are the examples.

  Rule: Check 2. Each final view equals expected/
`;

export const ASSERTIONS: readonly Assertion[] = [
  { test: `${NAMING}one-content-is-one-version`, name: "", outcome: "passed" },
  {
    test: `${NAMING}a-revision-s-name`,
    name: "",
    outcome: "failed",
    why: "N2: the revision has no name",
  },
  {
    test: `${TREE}conformance/kim/kim.feature#one-allergy-record`,
    name: "",
    outcome: "passed",
  },
  {
    test: `${TREE}conformance/kim/#check-2-each-final-view-equals-expected`,
    name: "",
    outcome: "failed",
    why: "allergies.ttl differs",
  },
];

export const RAN_WITH: readonly TestedWith[] = [
  { name: "cascade-vocabulary", iri: TREE, revision: "abc" },
];

/** A vocabulary with a feature, a kit and a feature of the kit's checks. */
export async function kimVocabulary(): Promise<MemoryFiles> {
  const vocabulary = new MemoryFiles(TREE);
  await vocabulary.write("runtime/naming.feature", text(FEATURE));
  await vocabulary.write("runtime/the-kit.feature", text(THE_KIT));
  await vocabulary.write("runtime/pod-layout.ttl", text(""));
  await vocabulary.write("conformance/kim/kim.feature", text(KIT));
  await vocabulary.write("conformance/kim/scripted-input/people.ttl", text(""));
  for (const step of ["E1", "E2"])
    await vocabulary.write(
      `conformance/kim/scripted-input/kim/bridge/${step}/graph.ttl`,
      text(""),
    );
  await vocabulary.write("conformance/kim/expected/allergies.ttl", text(""));
  return vocabulary;
}

/** The pages of `vocabulary` with the conformance results `assertions`, run with `ranWith`. */
export async function pagesOf(
  vocabulary: MemoryFiles,
  assertions: readonly Assertion[],
  ranWith: readonly TestedWith[],
): Promise<SpecPages> {
  return specPages({
    vocabulary,
    report: await readSpecReport(
      earl(assertions, "cascade-runtime-js", ranWith),
    ),
    builtFrom: [],
    at: "2026-10-24T00:00:00Z",
    chrome: PLAIN,
  });
}

/** The tree the hub writes for the specification's section over `from`, given the results the context would read. */
export async function hubWith(
  from: MemoryFiles,
  ran: readonly Assertion[],
  files: { readonly earl?: Uint8Array; readonly table?: Uint8Array } = {},
  finishers: readonly Finisher<object>[] = [],
): Promise<ReadonlyMap<string, Uint8Array>> {
  const report = await readSpecReport(
    earl(ran, "cascade-runtime-js", RAN_WITH),
  );
  const { tree } = await buildTree({
    sections: [specSection],
    ctx: {
      vocabulary: async () => ({
        files: from,
        builtFrom: [],
        at: "2026-10-24T00:00:00Z",
      }),
      report: async () => ({ report, ...files }),
      chrome: PLAIN,
      tests: async () => [
        {
          suite: {
            repository: "the-cascade-protocol/cascade-runtime-js",
            title: "The runtime's tests",
            about: "npm test",
            workflow: "check.yml",
            artifact: "runtime-tests",
            report: "junit.xml",
            runner: "node:test" as const,
          },
        },
      ],
    },
    front: (rows) => hubFiles(["Records"], rows, PLAIN),
    finishers,
  });
  return tree;
}

export const treeText = (tree: ReadonlyMap<string, Uint8Array>, path: string) =>
  new TextDecoder().decode(tree.get(path));
