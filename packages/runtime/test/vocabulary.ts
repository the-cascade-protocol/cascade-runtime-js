import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { featureStory } from "../src/conformance.js";
import { Layout } from "../src/layout.js";
import type { Story } from "../src/story.js";
import { type Files, MemoryFiles } from "../src/files.js";
import { FolderFiles } from "../src/node/folder-files.js";
import { type Replayed, replay, type ReplayOptions } from "../src/replay.js";
import { OxigraphStore } from "../src/oxigraph-store.js";
import { readConfig, resolveVocabulary } from "../src/node/runtime.js";
import { runtimeIri } from "../src/config.js";
import { parseGraph } from "../src/graph.js";
import { blank, type BlankNode, type Term, type Triple } from "../src/rdf.js";

const REVISION = "https://ns.cascadeprotocol.org/cascade#Revision";
const GENERATED_BY = "http://www.w3.org/ns/prov#wasGeneratedBy";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** A pod's files as one graph, but the imports' own, with each revision and the import that made it as blank nodes. */
export async function filed(pod: MemoryFiles): Promise<Triple[]> {
  const newStore = (): OxigraphStore => new OxigraphStore();
  const triples: Triple[] = [];
  const { folder: imports } = (await layout()).place(
    "http://www.w3.org/ns/prov#Activity",
    ["http://www.w3.org/ns/prov#used"],
  );
  for (const path of await pod.list("")) {
    if (!(await layout()).isRdf(path) || path.startsWith(imports ?? ""))
      continue;
    const bytes = await pod.read(path);
    if (bytes !== undefined)
      triples.push(
        ...(await parseGraph(bytes, pod.iri + path, newStore)).triples,
      );
  }
  const runDependent = new Set(
    triples.flatMap(([s, p, o]) =>
      p.value === GENERATED_BY
        ? [s.value, o.value]
        : p.value === TYPE && o.value === REVISION
          ? [s.value]
          : [],
    ),
  );
  const blanked = <T extends Term>(term: T): T | BlankNode =>
    term.termType === "NamedNode" &&
    runDependent.has(term.value.split("#")[0] ?? "")
      ? blank(term.value)
      : term;
  return triples.map(
    ([s, p, o]) => [blanked(s), p, blanked(o)] as unknown as Triple,
  );
}

export const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

let resolved: Promise<FolderFiles> | undefined;

/** The vocabulary this checkout runs against, resolved once per run as the commands resolve it. */
export function vocabulary(): Promise<FolderFiles> {
  resolved ??= readConfig(ROOT)
    .then((config) => resolveVocabulary(ROOT, config))
    .then((found) => new FolderFiles(found.folder, found.iri));
  return resolved;
}

let read: Promise<Layout> | undefined;

/** The vocabulary's pod layout, read once per run. */
export function layout(): Promise<Layout> {
  read ??= vocabulary().then((files) =>
    Layout.read(files, () => new OxigraphStore()),
  );
  return read;
}

/** A copy of the vocabulary with the text of some of its files put in place of its own; nothing is written to the real one. */
export function overlaid(
  real: Files,
  texts: Readonly<Record<string, string>>,
): Files {
  return {
    iri: real.iri,
    read: async (path) =>
      path in texts
        ? new TextEncoder().encode(texts[path])
        : await real.read(path),
    write: async () => {
      throw new Error("an overlaid vocabulary is read only");
    },
    list: (folder) => real.list(folder),
  };
}

/**
 * The story an example of a feature file tells, or the feature's background when no example is named: whose pod,
 * the folder its steps name their files under, and the steps through the one named, or all of them.
 */
export async function storyFrom(
  feature: string,
  example?: string,
  through?: string,
): Promise<{ readonly story: Story; readonly folder: string }> {
  const { person, steps } = await featureStory(
    await vocabulary(),
    feature,
    () => new OxigraphStore(),
    { example, through },
  );
  return {
    story: { address: person.address, subject: person.subject, steps },
    folder: person.folder,
  };
}

/** The runtime the tests' acts name (N7): this repository at a commit no checkout is at. */
export const RUNTIME = runtimeIri("0".repeat(40));

/**
 * The example of a feature replayed on a new pod, its story's files those `source` gives for the example's folder and
 * otherwise the vocabulary's. `importers`, `build` and `performers` are the replay's.
 */
export async function replayed(
  feature: string,
  example: string,
  options: {
    readonly source?: (files: Files, folder: string) => Promise<Files>;
    readonly importers?: ReplayOptions["importers"];
    readonly build?: ReplayOptions["build"];
    readonly performers?: ReplayOptions["performers"];
    /** The pod's files, from its address, where they are not `MemoryFiles`. */
    readonly pod?: (address: string) => Files;
  } = {},
): Promise<Replayed & { readonly folder: string }> {
  const files = await vocabulary();
  const { story, folder } = await storyFrom(feature, example);
  const done = await replay({
    runtime: RUNTIME,
    story,
    source:
      options.source === undefined
        ? files
        : await options.source(files, folder),
    vocabulary: files,
    folder,
    title: "",
    pod: options.pod?.(story.address) ?? new MemoryFiles(story.address),
    newStore: () => new OxigraphStore(),
    layout: await layout(),
    ...(options.importers === undefined
      ? {}
      : { importers: options.importers }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.performers === undefined
      ? {}
      : { performers: options.performers }),
  });
  return { ...done, folder };
}
