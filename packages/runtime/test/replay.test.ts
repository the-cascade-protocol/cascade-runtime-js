import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { runConformance } from "../src/conformance.js";
import { MemoryFiles, relative } from "../src/files.js";
import { FolderFiles } from "../src/node/folder-files.js";
import { localVocabulary } from "../src/node/runtime.js";
import { featurePod } from "../src/node/story-pod.js";
import { OxigraphStore } from "../src/oxigraph-store.js";
import { iri, literal, RDF, type Triple } from "../src/rdf.js";
import { PERFORMERS, replay, type Replayed } from "../src/replay.js";
import type { Step, Story } from "../src/story.js";
import { notIsomorphic } from "../src/graphs.js";
import { filed, layout, ROOT, RUNTIME, vocabulary } from "./vocabulary.js";

const ADDRESS = "https://pod.example/";
const SUBJECT = "urn:uuid:7c2d9e41-5a8b-4f36-b0e2-9d1a4c6f8e53";
const text = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes);

/** A story of the owner of the pod at `ADDRESS`, one step to each argument. */
const storyOf = (...steps: Step[]): Story => ({
  address: ADDRESS,
  subject: SUBJECT,
  steps,
});

const creation = (name: string, when: string): Step => ({
  name,
  when,
  happened: { kind: "creation" },
});

/** The options of a replay that every one of these stories shares, apart from its performers and its build. */
async function replaying(story: Story, pod: MemoryFiles) {
  return {
    runtime: RUNTIME,
    story,
    source: new MemoryFiles("https://vocabulary.example/"),
    vocabulary: await vocabulary(),
    folder: "",
    title: "",
    pod,
    layout: await layout(),
    newStore: () => new OxigraphStore(),
  };
}

/**
 * A story is a pod's address, its owner, and the dated steps that happened to it. `replay()` performs the steps in
 * order on a pod and returns what each wrote or why it was refused: a kit's story, a feature's example and an app's
 * demonstration pod are all made this way.
 */
describe("Replaying a story into a pod · replay(), PERFORMERS", () => {
  describe("replay(options)", () => {
    const pod = new MemoryFiles(ADDRESS);
    let replayed: Replayed;

    before(async () => {
      const story = storyOf(
        creation("create", "2026-02-01T08:00:00Z"),
        {
          name: "refused",
          when: "2026-02-01T08:30:00Z",
          happened: { kind: "entry", file: "entry.ttl" },
        },
        {
          name: "export",
          when: "2026-02-02T08:00:00Z",
          happened: { kind: "import", export: "e", converted: "c" },
        },
      );
      replayed = await replay({
        ...(await replaying(story, pod)),
        performers: {
          creation: PERFORMERS.creation,
          entry: (pod, step, { time }) => {
            time.begin(step.when);
            return pod.enter({
              bytes: new TextEncoder().encode(
                `@prefix prov: <http://www.w3.org/ns/prov#> .
            <urn:uuid:1e6c3a8d-5f27-4b90-9d4e-a7b2c8f0e513> a prov:Activity .
            <urn:cascade:output-0> a <https://ns.cascadeprotocol.org/cascade#AllergyOrIntolerance> .
            <urn:cascade:output-0-version> prov:specializationOf <urn:cascade:output-0> ;
              <https://ns.cascadeprotocol.org/cascade#patient> <${SUBJECT}> .
            <urn:cascade:zz-version> prov:specializationOf <urn:cascade:no-draft> .`,
              ),
              base: ADDRESS,
              name: "entry.ttl",
            });
          },
        },
      });
    });

    it("returns a refused step with the sentence refusing it and no file written", () => {
      const [, refused] = replayed.steps;
      assert.deepEqual(
        [refused?.step.name, refused?.wrote.length, refused?.refused],
        [
          "refused",
          0,
          "entry.ttl: urn:cascade:zz-version is the version of no draft",
        ],
      );
    });

    it("leaves the pod holding only the files the steps before a refused one wrote", async () => {
      const [created] = replayed.steps;
      assert.equal(created?.wrote.length, 3);
      assert.equal(created?.refused, undefined);
      assert.deepEqual(await pod.list(""), [...(created?.wrote ?? [])].sort());
    });

    it("tries the step after a refused one", () => {
      assert.equal(replayed.stopped?.step.name, "export");
    });

    it("stops at a step whose kind, here an import, it is given no performer for, naming the kind in `stopped.why`", () => {
      assert.match(replayed.stopped?.why ?? "", /kind import/);
    });

    it("returns only the steps it performed before it stopped", () => {
      assert.deepEqual(
        replayed.steps.map(({ step }) => step.name),
        ["create", "refused"],
      );
    });
  });

  describe("given a build", () => {
    const seen: string[] = [];
    const derivedPod = new MemoryFiles(ADDRESS);
    const viewPod = new MemoryFiles(ADDRESS);
    let replayed: Replayed;
    let viewFile: string;
    let viewTriples: Triple[];

    before(async () => {
      replayed = await replay({
        ...(await replaying(
          storyOf(
            creation("create", "2026-02-01T08:00:00Z"),
            creation("later", "2026-02-02T08:00:00Z"),
          ),
          derivedPod,
        )),
        build: {
          lens: "everyday",
          derive: (_store, lens, { at }) => {
            seen.push(`${lens} ${at}`);
            return Promise.resolve(
              new Map([
                [
                  "clinical/built.ttl",
                  [[iri(ADDRESS), iri(`${RDF}value`), literal(at)]] as const,
                ],
              ]),
            );
          },
        },
      });

      [{ file: viewFile = "" } = {}] = (await layout()).views;
      const view = ADDRESS + viewFile;
      viewTriples = [
        [iri(view), iri(`${RDF}type`), iri("urn:example:View")],
        [iri(`${view}#entry`), iri(`${RDF}value`), iri(`${view}#entry`)],
      ];
      await replay({
        ...(await replaying(
          storyOf(creation("create", "2026-02-01T08:00:00Z")),
          viewPod,
        )),
        build: {
          lens: "everyday",
          derive: () => Promise.resolve(new Map([[viewFile, viewTriples]])),
        },
      });
    });

    it("derives once after each step, with the build's lens, as of the step's time", () => {
      assert.deepEqual(seen, [
        "everyday 2026-02-01T08:00:00Z",
        "everyday 2026-02-02T08:00:00Z",
      ]);
    });

    it("leaves a file the build writes out of every step's `wrote`", () => {
      assert.ok(
        !replayed.steps.some(({ wrote }) =>
          wrote.includes("clinical/built.ttl"),
        ),
      );
    });

    it("leaves a built file as the derivation after the last step gives it", async () => {
      const built = await new OxigraphStore().parse(
        (await derivedPod.read("clinical/built.ttl")) ?? new Uint8Array(),
        ADDRESS,
      );
      assert.deepEqual(
        built.map(([, , value]) => value),
        [literal("2026-02-02T08:00:00Z")],
      );
    });

    /**
     * No check of a kit reads the bytes a replay put in the pod: check 6 writes each view again from its triples
     * (`podAddressesIn` over `builtFileBytes`), so these two leaves are where those bytes are read.
     * @rule runtime/the-kit.feature Check 6
     */
    it("writes a view with no pod address in its bytes", async () => {
      assert.ok(
        !text(await viewPod.read(viewFile)).includes(ADDRESS),
        "the view's bytes name the pod's address",
      );
    });

    it("writes a view that parses, against its own address, to the triples derived", async () => {
      const lines = (triples: readonly Triple[]) =>
        triples
          .map((triple) => triple.map(({ value }) => value).join(" "))
          .sort();
      assert.deepEqual(
        lines(
          await new OxigraphStore().parse(
            (await viewPod.read(viewFile)) ?? new Uint8Array(),
            ADDRESS + viewFile,
          ),
        ),
        lines(viewTriples),
      );
    });
  });

  const MARTIN = "conformance/martin-okafor/martin-okafor.feature";
  const MARTINS = "conformance/martin-okafor/scripted-input/martin/bridge/";

  /** The vocabulary with every file whose path starts as `hidden` does gone. */
  function without(
    local: Awaited<ReturnType<typeof localVocabulary>>,
    hidden: string,
  ): typeof local {
    class Hiding extends FolderFiles {
      override read(path: string): Promise<Uint8Array | undefined> {
        return relative(this, path).startsWith(hidden)
          ? Promise.resolve(undefined)
          : super.read(path);
      }
      override async list(folder: string): Promise<string[]> {
        return (await super.list(folder)).filter(
          (path) => !path.startsWith(hidden),
        );
      }
    }
    return { ...local, files: new Hiding(local.files.folder, local.files.iri) };
  }

  /**
   * A person's scripted input holds a `bridge/` folder with the saved output of every import step, or holds none and
   * every import step is converted. A step the saved output lacks stops the replay: a kit that lost a folder is not
   * taken for one that saves nothing.
   * @rule runtime/the-kit.feature Check 4
   */
  describe("given a kit that saves its Bridge output but one step's folder is missing", () => {
    it("stops at that step, without converting its download", async () => {
      let asked = 0;
      await assert.rejects(
        featurePod(
          without(await localVocabulary(ROOT), `${MARTINS}E5/`),
          MARTIN,
          new MemoryFiles(ADDRESS),
          {
            adapters: () => {
              asked += 1;
              return Promise.reject(new Error("the adapters were asked"));
            },
          },
        ),
        /stopped at step E5: .*saves no Bridge output/s,
      );
      assert.equal(asked, 0);
    });
  });

  /**
   * An example that saves Bridge output for a person keeps reading it, so a runtime that converted a document it keeps
   * has none to read and fails.
   * @rule runtime/arrivals.feature A1
   */
  describe("given a run with adapters over the examples that save Bridge output, A1 and Alex's E7", () => {
    it("converts nothing, and passes the example that has the same export imported again", async () => {
      let asked = 0;
      const outcomes = await runConformance({
        vocabulary: (await localVocabulary(ROOT)).files,
        runtime: RUNTIME,
        newStore: () => new OxigraphStore(),
        newPod: (address) => new MemoryFiles(address),
        layout: await layout(),
        adapters: () => {
          asked += 1;
          return Promise.reject(new Error("the adapters were asked"));
        },
        features: [
          "runtime/arrivals.feature",
          "conformance/alex-rivera/alex-rivera.feature",
        ],
      });
      const guards = outcomes.filter(({ test }) =>
        /#(an-export-bringing-a-document-the-pod-already-keeps-writes-nothing|e7-imports-x-e6-again-and-writes-no-file-not-even-an-import)$/.test(
          test,
        ),
      );
      assert.deepEqual(
        guards.map(({ outcome }) => outcome),
        ["passed", "passed"],
      );
      assert.equal(asked, 0);
    });
  });

  /**
   * An import step converts its download with the adapters when its person's scripted input holds no `bridge/` folder.
   * Martin's kit is replayed both ways, its saved output hidden.
   * @rule runtime/the-kit.feature Check 4
   */
  describe("given a kit that saves no Bridge output", () => {
    let saved: MemoryFiles;
    let converted: MemoryFiles;
    let steps: Replayed["steps"];

    before(async () => {
      const local = await localVocabulary(ROOT);
      assert.ok(
        (await local.files.list(MARTINS)).length > 0,
        "the saved side reads no saved output",
      );
      saved = new MemoryFiles(ADDRESS);
      converted = new MemoryFiles(ADDRESS);
      await featurePod(local, MARTIN, saved);
      ({ steps } = await featurePod(
        without(local, MARTINS),
        MARTIN,
        converted,
      ));
    });

    it("replays every step, as it does from the saved output", () => {
      assert.deepEqual(
        steps.filter(({ refused }) => refused !== undefined),
        [],
      );
    });

    it("files, the imports' own files and the snapshots' apart, the same statements as the saved output does", async () => {
      // A snapshot names the import's file, whose name is random.
      const snapshots = /cascade#(fileAddedToSet|firstParentSnapshot|setHash)$/;
      const statements = async (pod: MemoryFiles) =>
        (await filed(pod)).filter(([, p]) => !snapshots.test(p.value));
      const expected = await statements(saved);
      assert.ok(expected.length > 0);
      assert.equal(
        notIsomorphic(expected, await statements(converted)),
        undefined,
      );
    });
  });
});
