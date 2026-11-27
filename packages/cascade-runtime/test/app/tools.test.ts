import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { NEVER, TOOLS } from "cascade-runtime/app";
import {
  QUESTIONS,
  TIER_OF_KIND,
  TOOLS as RUNTIME,
} from "cascade-runtime/tools";

/** What each tool is given, and the PodApi operations it may call. A tool added to `TOOLS` needs a row. */
const RUNS: Record<string, [Record<string, unknown>, string[]]> = {
  list_pods: [{}, ["pods"]],
  find_changes: [{ pod: "p" }, ["tool"]],
  finding_rows: [{ pod: "p", key: "k" }, ["tool"]],
  lab_series: [{ pod: "p", test: "t" }, ["tool"]],
  timeline: [{ pod: "p" }, ["tool"]],
  worth_a_look: [{ pod: "p" }, ["tool"]],
  ask: [{ pod: "p", question: "pod/My lab results" }, ["ask"]],
  reference_table_checks: [{ pod: "p" }, ["tables"]],
  open_pod: [{ pod: "p" }, ["pod"]],
  open_trend: [{ pod: "p", test: "t", medication: "m" }, ["trend"]],
  open_entry: [{ pod: "p", entry: "e" }, ["ask"]],
  open_classes: [{ pod: "p" }, ["pod"]],
  open_panel: [{ pod: "p", panel: "24326-1" }, ["pod"]],
  open_table: [{ table: "t" }, ["table"]],
  make_pod: [{ person: "Ann", encrypt: true }, ["makePod"]],
  check_tables: [{}, ["checkTables"]],
  set_world_date: [{ date: "2026-01-01" }, ["setWorldDate"]],
};
/** The kind of act of each tool that neither reads nor opens a screen. */
const OTHER_KINDS: Record<string, string> = {
  make_pod: "MakingAPodThatIsNotEncrypted",
  check_tables: "ChangingTheAppsTablesOrSettings",
  set_world_date: "ChangingTheAppsTablesOrSettings",
};
const ANSWERS: Record<string, unknown> = {
  pods: { pods: [{ name: "p" }] },
  tool: { value: [], found: [] },
  ask: { rows: [{ entry: "e" }] },
  trend: { series: { test: { notation: "t" } }, timeline: [] },
  tables: undefined,
};
const address = () => "/";

/**
 * `TOOLS` of `cascade-runtime/app` is the one list of tools the chat, the MCP server and a browser's agent are offered.
 * Each tool has a tier: `free` reads, `ask` changes the app and waits for the person. `NEVER` lists the PodApi
 * operations no tool may call. A tool you add needs a row in `RUNS`.
 */
describe("The tool list a model is offered · TOOLS, NEVER", () => {
  describe("TOOLS", () => {
    /** The operations and inputs each tool's `run` called when given the input its `RUNS` row names. */
    const ran = new Map<
      string,
      { called: [string, Record<string, unknown>][] }
    >();

    before(async () => {
      for (const tool of TOOLS) {
        const [input] = RUNS[tool.name] ?? [{}];
        const called: [string, Record<string, unknown>][] = [];
        const recording = new Proxy(
          {},
          {
            get:
              (_, op: string) =>
              async (given: Record<string, unknown> = {}) => {
                called.push([op, given]);
                return op in ANSWERS ? ANSWERS[op] : {};
              },
          },
        );
        await tool.run(recording as never, input, {
          open: async () => {},
          address: {
            pod: address,
            trend: address,
            entry: address,
            classes: address,
            panel: address,
            table: address,
          },
        });
        ran.set(tool.name, { called });
      }
    });

    it("holds exactly the tools `RUNS` has a row for", () => {
      assert.deepEqual(
        TOOLS.map(({ name }) => name).sort(),
        Object.keys(RUNS).sort(),
      );
    });

    it("gives every tool the tier of its kind, free or ask", () => {
      for (const { name, kind, tier } of TOOLS) {
        assert.equal(tier, TIER_OF_KIND[kind], name);
        assert.ok(["free", "ask"].includes(tier), name);
      }
    });

    it("gives each tool the kind of act it takes", () => {
      for (const { name, kind } of TOOLS)
        assert.equal(
          kind,
          name.startsWith("open_")
            ? "MovingTheAppsView"
            : (OTHER_KINDS[name] ?? "ReadingPodsOrTables"),
          name,
        );
    });

    it("calls from each tool only the PodApi operations its row names", () => {
      for (const [name, { called }] of ran)
        assert.deepEqual(
          called.map(([op]) => op),
          RUNS[name]?.[1],
          name,
        );
    });

    it("puts the kind of each `NEVER` entry at the tier never", () => {
      for (const { op, kind } of NEVER)
        assert.equal(TIER_OF_KIND[kind], "never", op);
    });

    it("never calls an operation `NEVER` holds", () => {
      for (const [name, { called }] of ran)
        for (const [op, given] of called)
          assert.equal(
            NEVER.some(
              (never) =>
                never.op === op &&
                (never.with === undefined || given[never.with] !== undefined),
            ),
            false,
            `${name} calls ${op}`,
          );
    });
  });

  describe("given cascade-runtime's read tools", () => {
    it("carries each by its name, description and schema", () => {
      for (const { name, description, inputSchema, ofPod } of RUNTIME) {
        const mine = TOOLS.find((tool) => tool.name === name);
        assert.ok(mine, name);
        assert.deepEqual(
          {
            description: mine.description,
            inputSchema: mine.inputSchema,
            ofPod: mine.ofPod,
          },
          { description, inputSchema, ofPod },
          name,
        );
      }
    });

    it("offers the runtime's questions as the `ask` tool's question", () => {
      const ask = TOOLS.find((tool) => tool.name === "ask");
      assert.deepEqual(
        (ask?.inputSchema.properties?.question as { enum?: string[] }).enum,
        QUESTIONS,
      );
    });
  });
});
