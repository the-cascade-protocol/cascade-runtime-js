import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  type BridgeDocument,
  EVERY_FINDING,
  isBridgeError,
  type LoadedAdapter,
} from "../src/bridge.js";
import { MemoryFiles } from "../src/files.js";
import { documentName } from "../src/names.js";
import { SavedOutputBridge } from "../src/saved-output-bridge.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const ADAPTER = { iri: "https://adapter.example/tree/c/", files: new Map() };
const PEANUT = "s/export/clinical-records/AllergyIntolerance-peanut.json";

/** A document of the story's export, named as a runtime names it. */
async function documentOf(text: string): Promise<BridgeDocument> {
  const content = bytes(text);
  return { iri: await documentName(content), bytes: content };
}

/**
 * A kit saves, beside each export, the graph the Bridge made of each document. `SavedOutputBridge` answers a conversion
 * from those files, so a story replays where no Bridge can run, and what the kit saved stays the expected output every
 * runtime is held to.
 */
describe("Converting from a kit's saved output · SavedOutputBridge.of()", () => {
  const peanut = '{"resourceType": "AllergyIntolerance", "id": "peanut"}';
  const mango = '{"resourceType": "AllergyIntolerance", "id": "mango"}';
  const kiwi = '{"resourceType": "AllergyIntolerance", "id": "kiwi"}';
  const graph = bytes("<urn:record> a <urn:Allergy> .");
  const story = new MemoryFiles("https://vocabulary.example/");

  before(async () => {
    for (const [name, text] of [
      ["peanut", peanut],
      ["mango", mango],
      ["kiwi", kiwi],
    ] as const)
      await story.write(
        `s/export/clinical-records/AllergyIntolerance-${name}.json`,
        bytes(text),
      );
    await story.write(
      "s/bridge/AllergyIntolerance-kiwi/unaccepted.txt",
      new Uint8Array(),
    );
    await story.write("s/bridge/AllergyIntolerance-peanut/graph.ttl", graph);
  });

  describe("given a step whose export is a folder of documents", () => {
    let adapter: LoadedAdapter;

    before(async () => {
      adapter = await (
        await SavedOutputBridge.of(story, {
          export: "s/export",
          converted: "s/bridge",
        })
      ).load(ADAPTER);
    });

    it("accepts a document the step saved output for", async () => {
      assert.equal(await adapter.accepts(await documentOf(peanut)), true);
    });

    it("converts it to the graph saved under its file's name", async () => {
      const converted = await adapter.convert(await documentOf(peanut));
      assert.deepEqual(converted.graph, graph);
      assert.equal(converted.findings, undefined);
    });

    it("rejects a conversion that asks for findings with a BridgeError of kind `bridge`: it saves none", async () => {
      await assert.rejects(
        adapter.convert(await documentOf(peanut), EVERY_FINDING),
        (error) => isBridgeError(error) && error.kind === "bridge",
      );
    });

    it("declines a document the step marks with `unaccepted.txt`", async () => {
      assert.equal(await adapter.accepts(await documentOf(kiwi)), false);
    });

    it("accepts a document the step saved nothing for", async () => {
      assert.equal(await adapter.accepts(await documentOf(mango)), true);
    });

    it("rejects the conversion of that document with a BridgeError of kind `bridge`", async () => {
      await assert.rejects(
        adapter.convert(await documentOf(mango)),
        (error) => isBridgeError(error) && error.kind === "bridge",
      );
    });
  });

  describe("given a step whose export is one document", () => {
    it("converts the document to the graph saved under its file's name", async () => {
      const adapter = await (
        await SavedOutputBridge.of(story, {
          export: PEANUT,
          converted: "s/bridge",
        })
      ).load(ADAPTER);
      assert.deepEqual(
        (await adapter.convert(await documentOf(peanut))).graph,
        graph,
      );
    });
  });
});
