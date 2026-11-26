import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdaptersOf } from "../bridge.js";
import { featureStory } from "../conformance.js";
import type { Files } from "../files.js";
import { ofMediaType } from "../load-adapter.js";
import { OxigraphStore } from "../oxigraph-store.js";
import {
  importing,
  PERFORMERS,
  type Replayed,
  replay,
  titleOf,
} from "../replay.js";
import { deriveWith, vocabularyBuild } from "../build.js";
import { importersNamed } from "../importers.js";
import type { References } from "../references.js";
import { WasmBridge } from "../wasm-bridge.js";
import { checkouts } from "./components.js";
import { type LocalVocabulary, findRoot, thisRuntime } from "./runtime.js";
import { compiledBridge, inWorker, loadSharedAdapters } from "./wasm.js";

let checkedOut: Promise<AdaptersOf> | undefined;

/**
 * The adapters `cascade-runtime.json` names, from the checkouts this runtime runs in, loaded once for the process: the
 * Bridge's workers do not keep it alive.
 */
function adaptersOfCheckouts(): Promise<AdaptersOf> {
  if (checkedOut !== undefined) return checkedOut;
  const loading = (async () => {
    const components = await checkouts(
      findRoot(dirname(fileURLToPath(import.meta.url))),
    );
    const { folder } = await components.bridge();
    const bridge = new WasmBridge(inWorker(await compiledBridge(folder)));
    return ofMediaType(
      await loadSharedAdapters(
        folder,
        bridge,
        components.config.adapters,
        components,
      ),
    );
  })();
  checkedOut = loading;
  loading.catch(() => {
    if (checkedOut === loading) checkedOut = undefined;
  });
  return loading;
}

/**
 * The steps of a feature file of the vocabulary replayed into the pod through the step named, all of them when none
 * is: its background's, a kit's story, or those of the example named. The files the build writes are rebuilt under
 * the runtime's lens after every step. Given `tables`, the pod is given those instead of the story's own, and the
 * story's `reference` and `open` steps, which name the story's own versions, are left out. An import step whose story
 * saves no Bridge output is converted by the `adapters` given, or else by those the checkouts name, loaded when a step
 * first needs them.
 */
export async function featurePod(
  vocabulary: LocalVocabulary,
  path: string,
  pod: Files,
  options: {
    readonly example?: string;
    readonly through?: string;
    readonly tables?: () => Promise<References>;
    /** Builds the pod whole after each step too, and stops where the build in part differs. */
    readonly verify?: boolean;
    readonly adapters?: () => Promise<AdaptersOf>;
  } = {},
): Promise<Replayed> {
  const newStore = () => new OxigraphStore();
  const { tables, verify, adapters, ...which } = options;
  const { feature, person, steps } = await featureStory(
    vocabulary.files,
    path,
    newStore,
    which,
  );
  const build = await vocabularyBuild(vocabulary.files, vocabulary.layout);
  const replayed = await replay({
    story: {
      address: person.address,
      subject: person.subject,
      steps:
        tables === undefined
          ? steps
          : steps.filter(
              ({ happened }) =>
                happened.kind !== "reference" && happened.kind !== "open",
            ),
    },
    source: vocabulary.files,
    vocabulary: vocabulary.files,
    folder: person.folder,
    title: await titleOf(vocabulary.files, feature.folder),
    pod,
    layout: vocabulary.layout,
    newStore,
    runtime: await thisRuntime(),
    importers: importersNamed(vocabulary.config.importers),
    performers: {
      ...PERFORMERS,
      import: importing(adapters ?? adaptersOfCheckouts),
    },
    ...(tables === undefined ? {} : { references: tables }),
    build: {
      lens: vocabulary.config.lens,
      derive: deriveWith(build),
      incremental: build,
      ...(verify === true ? { verify } : {}),
    },
  });
  if (replayed.stopped !== undefined)
    throw new Error(
      `the replay of ${path} stopped at step ${replayed.stopped.step.name}: ${replayed.stopped.why}`,
    );
  return replayed;
}
