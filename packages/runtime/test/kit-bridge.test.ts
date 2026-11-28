import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { kitImports } from "../src/kit-bridge.js";
import { importersNamed } from "../src/importers.js";
import { checkouts } from "../src/node/components.js";
import { notIsomorphic, triples } from "../src/graphs.js";
import { ROOT, storyFrom, vocabulary } from "./vocabulary.js";

const KIT = "conformance/priya-natarajan";
const ALEX = "conformance/alex-rivera";
const CLI = join(ROOT, "packages/runtime/dist/src/node/cli.js");

const kitBridge = (out: string, kit = KIT): Promise<unknown> =>
  promisify(execFile)(process.execPath, [CLI, "kit-bridge", kit, out], {
    cwd: ROOT,
    maxBuffer: 1 << 24,
  });

/** The paths of the files under `folder`, with `/`, in order, that `keep` keeps. */
async function filesUnder(
  folder: string,
  keep: (path: string) => boolean = () => true,
): Promise<string[]> {
  return (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(folder.length + 1)
        .replaceAll("\\", "/"),
    )
    .filter(keep)
    .sort();
}

/**
 * `npm run kit:bridge` converts every document a kit's story imports with the Bridge and writes the graphs as the kit
 * saves them, into a folder of the caller's. A vocabulary maintainer runs it when an adapter changes, and compares that
 * folder with the kit.
 */
describe("Writing a kit's saved output again · npm run kit:bridge", () => {
  describe("given the command run on `conformance/priya-natarajan`, which still saves its Bridge output", () => {
    let out: string;
    /** For each document the kit's story imports: what the kit saved and where the command wrote its own. */
    let documents: {
      saved: Uint8Array;
      graph: string;
      named: string;
    }[];
    let savedFiles: string[];

    before(async () => {
      out = await mkdtemp(join(tmpdir(), "kit-bridge-"));
      await kitBridge(out);
      const files = await vocabulary();
      const { story, folder } = await storyFrom(
        `${KIT}/priya-natarajan.feature`,
      );
      const imports = await kitImports({
        vocabulary: files,
        folder,
        steps: story.steps,
        importers: importersNamed((await checkouts(ROOT)).config.importers),
        adaptersOf: () => [],
      });
      documents = [];
      savedFiles = [];
      let accepted = 0;
      for (const { converted, documents: imported } of imports) {
        savedFiles.push(
          ...(await files.list(`${converted}/`))
            .filter((path) => path.endsWith("/graph.ttl"))
            .map((path) => path.slice(folder.length + 1)),
        );
        for (const { stem, iri: named, repeated } of imported) {
          const at = `${converted}/${stem}/`;
          const saved = await files.read(`${at}graph.ttl`);
          const unaccepted =
            (await files.read(`${at}unaccepted.txt`)) !== undefined;
          if (!repeated && !unaccepted) accepted += 1;
          if (saved === undefined) {
            // The kit saves no graph for a document no adapter accepts, or one an earlier step converted.
            assert.ok(repeated || unaccepted, `${at} is saved`);
            continue;
          }
          const here = join(out, converted.slice(folder.length + 1), stem);
          documents.push({
            saved,
            graph: join(here, "graph.ttl"),
            named,
          });
        }
      }
      assert.ok(accepted > 0, "the story imports a document the kit accepts");
      assert.equal(
        savedFiles.length,
        accepted,
        "the graphs the kit saves, against the documents the story imports that are neither repeated nor unaccepted",
      );
    });

    after(async () => {
      await rm(out, { recursive: true, force: true });
    });

    it("writes the graph file the kit saves for each document it accepts, and no other", async () => {
      assert.deepEqual(await filesUnder(out), savedFiles.sort());
    });

    it("writes for each document a graph isomorphic to the kit's", async () => {
      for (const one of documents)
        assert.equal(
          notIsomorphic(triples(one.saved), triples(await readFile(one.graph))),
          undefined,
          `${one.named}'s graph`,
        );
    });
  });

  describe("given the command run on `conformance/alex-rivera`", () => {
    let out: string;
    let folder: string;

    before(async () => {
      out = await mkdtemp(join(tmpdir(), "kit-bridge-"));
      await kitBridge(out, ALEX);
      ({ folder } = await storyFrom(`${ALEX}/alex-rivera.feature`));
    });

    after(async () => {
      await rm(out, { recursive: true, force: true });
    });

    it("writes a `graph.ttl` for each one the kit holds, and no other: a document an earlier step kept is converted under no later step", async () => {
      const files = await vocabulary();
      const graphs = (at: string) =>
        filesUnder(at, (path) => path.endsWith("/graph.ttl"));
      assert.deepEqual(
        await graphs(join(out, "bridge")),
        await graphs(join(files.folder, folder, "bridge")),
      );
    });
  });

  describe("given a folder inside the vocabulary", () => {
    let inside: string;
    let refused: { code?: number; stderr?: string } | undefined;

    before(async () => {
      inside = join((await vocabulary()).folder, KIT, "kit-bridge-refused");
      refused = await kitBridge(inside).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error,
      );
    });

    after(async () => {
      await rm(inside, { recursive: true, force: true });
    });

    it("exits with code 1, saying the folder is outside the vocabulary", () => {
      assert.equal(refused?.code, 1);
      assert.match(refused?.stderr ?? "", /outside the vocabulary/);
    });

    it("writes nothing there", async () => {
      await assert.rejects(stat(inside), { code: "ENOENT" });
    });
  });
});
