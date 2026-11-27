import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pod, Tables } from "cascade-runtime/published";
import { looks } from "cascade-runtime/vite";

/**
 * A sample pod keeps what its page asks the tables, as the page asks it with the app's tiles, so that a first visit draws
 * those names before the engine; a lookup that fails fails the build.
 */
describe("Building a sample app's pods, with what their first paint asks the tables · looks()", () => {
  describe("given a table lookup that throws", () => {
    it("rejects with an AggregateError holding each lookup's failure", async () => {
      const down = new Error("the tables are down");
      const pod = {
        ask: async () => [],
        unheldTableVersions: async () => [],
      } as unknown as Pod;
      const tables = {
        about: async () => {
          throw down;
        },
        held: async () => [],
      } as unknown as Tables;
      await assert.rejects(looks(pod, tables), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [down]);
        return true;
      });
    });
  });

  describe("given the app's tiles as `sections`", () => {
    it("asks the tables of the codes a tile's rows hold, which it does not ask without the tile", async () => {
      const question = "pod/My devices";
      const code = "urn:x:device-code";
      const pod = {
        ask: async (asked: string) =>
          asked === question ? [{ entry: "urn:x:device", code }] : [],
        unheldTableVersions: async () => [],
      } as unknown as Pod;
      const tile = {
        one: "device",
        question,
        field: "name",
        codes: ["code"],
        columns: [],
      };
      const askedOf = async (options?: { sections: (typeof tile)[] }) => {
        const codes: string[] = [];
        const tables = {
          about: async (each: string[]) => {
            codes.push(...each);
            return new Map();
          },
          held: async () => [],
        } as unknown as Tables;
        await looks(pod, tables, options);
        return codes;
      };
      assert.deepEqual(
        { none: await askedOf(), tiled: await askedOf({ sections: [tile] }) },
        { none: [], tiled: [code] },
      );
    });
  });
});
