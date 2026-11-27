import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pod, Tables } from "cascade-runtime/published";
import { looks } from "cascade-runtime/vite";

describe("Building a sample app's pods, when the tables cannot be read · looks()", () => {
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
});
