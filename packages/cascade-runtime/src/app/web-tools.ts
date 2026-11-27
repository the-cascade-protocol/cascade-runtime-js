// The tools a model reaches the app by through the page's model context (WebMCP), where the browser has one: the reads
// of the one list (`tools.ts`) as the host runs them, and the tools the page runs itself (`PAGE_TOOLS`). A tool that
// moves the app moves it in place through the app's router, as a step does; a write waits on the person's Allow, then
// runs as the route's action. A framework offers them while the screen shown is the one they were offered for, and
// takes them away in the commit that draws the next, by what `offerTools` gives back.
import { Refusal } from "@cascade-runtime/runtime";
import { checkInput, type Input, type Schema } from "../check.js";
import { withPod } from "../pod-tools.js";
import { isPageBusy } from "./page-state.js";
import {
  PAGE_TOOLS,
  type PageDoor,
  type PageTool,
  type PageToolInput,
} from "./page-tools.js";

/** The tool WebMCP's `registerTool` takes: it goes when its `signal` aborts. */
interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  execute(input: Input, options?: { signal?: AbortSignal }): Promise<unknown>;
}

interface ModelContext {
  registerTool(tool: ModelTool, options: { signal: AbortSignal }): unknown;
}

const modelContext = () =>
  (document as unknown as { modelContext?: ModelContext }).modelContext;

/** A read of the one list, as the host lists it. */
export interface ReadTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly ofPod: boolean;
}

/** What a model asks to do: the action in words, and the input it gave. */
export interface Asking {
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Shows the person `asking` and resolves true on Allow, false on Cancel; asks made meanwhile wait their turn. An ask
 * whose `signal` aborts is withdrawn, from the box or from the queue, and resolves false.
 */
export type Confirm = (
  asking: Asking,
  signal?: AbortSignal,
) => Promise<boolean>;

/** The steps the app's router runs for a tool. */
export interface ToolSteps {
  /** Runs the page's tool `name`, a write, as a step of the screen shown; what it gave, or its refusal thrown. */
  write(name: string, input: PageToolInput): Promise<unknown>;
  /** Moves the app to the router path `to`, as a step: settles once the screen there is drawn. */
  move(to: string): Promise<void>;
}

/** What a tool's run reads at the time of the call, not of the commit that offered it. */
export interface ToolsNow {
  readonly confirm: Confirm;
  /** Whether the tools offered are those of the screen shown: its pod, if any, has been read. */
  readonly offered: boolean;
}

/**
 * What the calls of the tools offered read when they run: set in each commit, and the move of a tool waits through
 * `arrives()` for the commit that draws the screen it moved to.
 */
export function toolsNow(first: ToolsNow) {
  let current = first;
  const arriving: (() => void)[] = [];
  return {
    get: () => current,
    set(next: ToolsNow) {
      current = next;
      if (next.offered) for (const resolve of arriving.splice(0)) resolve();
    },
    arrives: () =>
      new Promise<void>((resolve) => {
        arriving.push(resolve);
      }),
  };
}

/**
 * What the agent reads when a call is refused: WebMCP only logs a rejected `execute` and tells the agent an opaque
 * `OperationError`, so a refusal resolves, and only a broken runtime rejects.
 */
async function answering(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "Refusal" || error.name === "Unopened")
    )
      return { refused: error.message };
    throw error;
  }
}

/** What an app gives for the tools of the screen shown. */
export interface ToolsOffered {
  /** PodApi, as the page tools run it. */
  readonly api: Parameters<PageTool["run"]>[0];
  /** The host's reads of the one list. */
  readonly reads: { run(name: string, input: object): Promise<unknown> };
  readonly listed: readonly ReadTool[];
  /** The pod the screen shown is of, when it is open: the tools of one pod take it as given. */
  readonly pod: string | undefined;
  readonly address: PageDoor["address"];
  readonly steps: ToolSteps;
  readonly now: ReturnType<typeof toolsNow>;
  /** What the person is asked to allow, for each write a page tool makes, by the tool's name. */
  readonly actions: Readonly<Record<string, string>>;
  /** What the model is told when the person cancels a write. */
  readonly said: string;
  /** The router path of an address of the app. */
  routed(url: URL): string;
}

/**
 * Offers the model context every tool of the one list but the never list's, while the screen shown is the one `offered`
 * names. With a pod shown, the tools of one pod take it as given; on a screen without one they take its name as `pod`.
 * `open_pod` always takes the name: it is how a model reaches another pod. Gives what takes them away again.
 */
export function offerTools(offered: ToolsOffered): () => void {
  const context = modelContext();
  if (context === undefined) return () => undefined;
  const { api, reads, listed, pod, address, steps, now } = offered;
  const controller = new AbortController();
  const { signal } = controller;

  /** Runs a tool the page runs itself: a move in place through the router, a write once the person has said yes. */
  async function runPage(
    tool: PageTool,
    input: PageToolInput,
    called: AbortSignal | undefined,
  ) {
    const writes = tool.tier === "ask";
    if (
      writes &&
      !(await now
        .get()
        .confirm(
          { action: offered.actions[tool.name] ?? tool.name, input },
          called,
        ))
    )
      throw new Refusal(
        called?.aborted === true ? "The ask was withdrawn" : offered.said,
      );
    if (isPageBusy())
      throw new Refusal("The page is busy with something else; try again");
    if (writes) return steps.write(tool.name, input);
    let to: string | undefined;
    const door: PageDoor = {
      address,
      async open(at) {
        to = offered.routed(new URL(at, location.href));
      },
    };
    const output = await tool.run(api, input, door);
    if (to !== undefined) {
      await steps.move(to);
      if (!now.get().offered) await now.arrives();
    }
    return output;
  }

  const offering: ModelTool[] = [
    ...listed.map((read): ModelTool => {
      const filled = read.ofPod && pod !== undefined;
      const base = read.inputSchema as Schema;
      const schema = read.ofPod && !filled ? withPod(base) : base;
      return {
        name: read.name,
        description: read.description,
        inputSchema: schema,
        execute: (input) =>
          answering(async () => {
            checkInput(schema, input);
            return reads.run(read.name, filled ? { ...input, pod } : input);
          }),
      };
    }),
    ...PAGE_TOOLS.map((tool): ModelTool => {
      const takes =
        tool.ofPod === true && (tool.name === "open_pod" || pod === undefined);
      const base = tool.inputSchema as Schema;
      const schema = takes ? withPod(base) : base;
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: schema,
        execute: (input, options) =>
          answering(async () => {
            checkInput(schema, input);
            return runPage(
              tool,
              tool.ofPod === true && !takes
                ? { ...(input as PageToolInput), pod }
                : (input as PageToolInput),
              options?.signal,
            );
          }),
      };
    }),
  ];
  for (const tool of offering) context.registerTool(tool, { signal });
  return () => controller.abort();
}
