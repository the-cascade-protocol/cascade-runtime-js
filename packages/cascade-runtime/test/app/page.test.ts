import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

/** The entry point an app imports, read as loosely as the tests call it. */
const APP: string = "cascade-runtime/app";
const {
  engineWarming,
  idleCounted,
  IDLE_LOCK_MS,
  isPageBusy,
  offerTools,
  pageBusy,
  pageCommitted,
  pageFailed,
  pageReady,
  pageSettled,
  revalidateWhenIdle,
  sayingNow,
  toolsNow,
  warmEngine,
  watchRouter,
  whenNamed,
} = (await import(APP)) as {
  engineWarming: () => boolean;
  idleCounted: <Api extends object>(api: Api) => Api;
  IDLE_LOCK_MS: number;
  isPageBusy: () => boolean;
  offerTools: (offered: unknown) => () => void;
  pageBusy: (said?: string) => void;
  pageCommitted: (seen: Seen) => void;
  pageFailed: (reason: string) => void;
  pageReady: () => void;
  pageSettled: () => Promise<void>;
  revalidateWhenIdle: (revalidate: () => unknown) => () => void;
  sayingNow: () => string | undefined;
  toolsNow: (first: Now) => {
    get(): Now;
    set(next: Now): void;
    arrives(): Promise<void>;
  };
  warmEngine: (host: {
    engine(): Promise<unknown>;
    tables(): Promise<unknown>;
  }) => void;
  watchRouter: (router: Router) => void;
  whenNamed: <T>(read: () => Promise<T>, unsaid: T, what: string) => Promise<T>;
};

interface Seen {
  locationKey: string;
  navigation: string;
  revalidation: string;
  busyFetchers: number;
  matches: { id: string; loaderData: unknown }[];
}
interface Now {
  confirm: (asking: unknown, signal?: AbortSignal) => Promise<boolean>;
  offered: boolean;
}
type State = Record<string, unknown>;
interface Router {
  state: State;
  subscribe(listener: (state: State) => void): () => void;
}

const globals = globalThis as unknown as Record<string, unknown>;

/** The page's `document` as far as the page functions read it: its body, its buttons, `main` and the model context. */
function fakePage() {
  const buttons = [{ disabled: false }, { disabled: false }];
  const body = { dataset: {} as Record<string, string | undefined> };
  const listeners = new Map<string, Set<() => void>>();
  const page = {
    body,
    buttons,
    filling: false,
    visibilityState: "visible",
    modelContext: undefined as unknown,
    querySelectorAll: () => buttons,
    querySelector(selector: string) {
      if (selector === "main") return {};
      return page.filling ? {} : null;
    },
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) =>
      listeners.get(type)?.delete(listener),
    dispatch: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
  return page;
}

/** A router state that is idle and has read everything, with `over` of it changed. */
const idle = (over: State = {}): State => ({
  initialized: true,
  location: { key: "a" },
  navigation: { state: "idle" },
  fetchers: new Map(),
  revalidation: "idle",
  matches: [],
  loaderData: {},
  errors: null,
  ...over,
});

/** The commit's view of `state`, as a page that drew it gives it. */
const drawnAs = (state: State): Seen => ({
  locationKey: (state["location"] as { key: string }).key,
  navigation: (state["navigation"] as { state: string }).state,
  revalidation: state["revalidation"] as string,
  busyFetchers: 0,
  matches: (state["matches"] as { route: { id: string } }[]).map(
    ({ route: { id } }) => ({
      id,
      loaderData: (state["loaderData"] as State)[id],
    }),
  ),
});

let page: ReturnType<typeof fakePage>;
const observers: { callback: () => void; watching: boolean }[] = [];

beforeEach(() => {
  page = fakePage();
  globals["document"] = page;
  globals["location"] = { href: "https://app.test/pods/", pathname: "/pods/" };
  globals["MutationObserver"] = class {
    private readonly seen = { callback: () => {}, watching: false };
    constructor(callback: () => void) {
      this.seen.callback = callback;
      observers.push(this.seen);
    }
    observe() {
      this.seen.watching = true;
    }
    disconnect() {
      this.seen.watching = false;
    }
  };
});

afterEach(() => {
  delete globals["document"];
  delete globals["location"];
  delete globals["MutationObserver"];
  observers.length = 0;
});

/**
 * An app's page says what it is doing in `data-state` on the body, from the moment its router starts to read or run
 * anything, and the suites wait on it: it is set as the router changes, and ready only in the commit that draws what the
 * router read.
 */
describe("Saying what the page is doing · pageBusy(), pageReady(), pageFailed(), watchRouter(), pageCommitted()", () => {
  it("sets `data-state` and the doing line, switches every button off while busy and on again once ready, and settles `pageSettled()`", async () => {
    pageBusy("Importing…");
    assert.equal(page.body.dataset["state"], "busy");
    assert.equal(sayingNow(), "Importing…");
    assert.ok(isPageBusy());
    assert.deepEqual(
      page.buttons.map(({ disabled }) => disabled),
      [true, true],
    );
    const settled = pageSettled();
    pageReady();
    await settled;
    assert.equal(page.body.dataset["state"], "ready");
    assert.deepEqual(
      page.buttons.map(({ disabled }) => disabled),
      [false, false],
    );
  });

  it("keeps why the page went wrong in `data-error`, and says so on the console", () => {
    const logged = mock.method(console, "error", () => undefined);
    try {
      pageFailed("the screen broke");
      assert.equal(page.body.dataset["state"], "error");
      assert.equal(page.body.dataset["error"], "the screen broke");
      assert.equal(logged.mock.callCount(), 1);
      pageReady();
      assert.equal(page.body.dataset["error"], undefined);
    } finally {
      logged.mock.restore();
    }
  });

  describe("given a router that moves, submits and reads again", () => {
    let router: Router & { emit(next: State): void };
    beforeEach(() => {
      const listeners = new Set<(state: State) => void>();
      router = {
        state: idle(),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        emit(next) {
          router.state = next;
          for (const listener of listeners) listener(next);
        },
      };
      watchRouter(router);
    });

    it("says what it is doing for each: opening a person's pod, a search, a step's own words, a read again", () => {
      const form = new FormData();
      form.set("doing", "Making the pod…");
      for (const [state, said] of [
        [
          idle({
            navigation: {
              state: "loading",
              location: { pathname: "/pods/alex-rivera/" },
            },
          }),
          "Opening Alex Rivera's pod…",
        ],
        [
          idle({
            navigation: {
              state: "loading",
              formMethod: "GET",
              location: { pathname: "/tables/" },
            },
          }),
          "Searching…",
        ],
        [
          idle({
            navigation: {
              state: "submitting",
              formMethod: "POST",
              formData: form,
            },
          }),
          "Making the pod…",
        ],
        [idle({ revalidation: "loading" }), "Working…"],
      ] as const) {
        router.emit(state);
        assert.equal(page.body.dataset["state"], "busy");
        assert.equal(sayingNow(), said);
      }
    });

    it("says the page went wrong the moment a step has, and ignores a router that is not yet initialized", () => {
      const logged = mock.method(console, "error", () => undefined);
      try {
        router.emit(
          idle({ initialized: false, errors: { root: new Error("early") } }),
        );
        assert.equal(page.body.dataset["state"], undefined);
        router.emit(idle({ errors: { root: new Error("boom") } }));
        assert.equal(page.body.dataset["state"], "error");
        assert.equal(
          page.body.dataset["error"],
          "the screen could not be drawn: boom",
        );
      } finally {
        logged.mock.restore();
      }
    });

    it("says ready only in the commit that draws what the router last read, never in an older one", () => {
      const now = idle({ location: { key: "b" } });
      router.emit(now);
      pageCommitted(drawnAs(idle({ location: { key: "a" } })));
      assert.equal(page.body.dataset["state"], undefined, "an older commit");
      pageCommitted(drawnAs(now));
      assert.equal(page.body.dataset["state"], "ready");
    });

    it("says busy in the commit when the router is still reading, and wrong when a loader says its read failed", () => {
      const logged = mock.method(console, "error", () => undefined);
      try {
        const reading = idle({
          matches: [{ route: { id: "pod" } }],
          loaderData: { pod: { busy: "Reading the pod…" } },
        });
        router.emit(reading);
        pageCommitted(drawnAs(reading));
        assert.equal(page.body.dataset["state"], "busy");
        const failed = idle({
          matches: [{ route: { id: "pod" } }],
          loaderData: { pod: { failed: "the pod would not open" } },
        });
        router.emit(failed);
        pageCommitted(drawnAs(failed));
        assert.equal(page.body.dataset["error"], "the pod would not open");
      } finally {
        logged.mock.restore();
      }
    });

    it("waits after a step for the parts of `main` still filling, and says ready once the last has", () => {
      const form = new FormData();
      router.emit(
        idle({
          navigation: {
            state: "submitting",
            formMethod: "POST",
            formData: form,
          },
        }),
      );
      const done = idle({ location: { key: "c" } });
      router.emit(done);
      page.filling = true;
      pageCommitted(drawnAs(done));
      assert.equal(page.body.dataset["state"], "busy", "still filling");
      assert.equal(observers.at(-1)?.watching, true);
      page.filling = false;
      observers.at(-1)!.callback();
      assert.equal(page.body.dataset["state"], "ready");
    });
  });
});

/**
 * The engine says what the tables say of a pod's codes, and warms once the first screen is drawn; a loader that asks
 * for it meanwhile is told it is warming.
 */
describe("Warming the engine in the background · warmEngine(), whenNamed()", () => {
  it("warms once the first screen is drawn, says so on the body, then keeps the tables up to date", async () => {
    assert.equal(engineWarming(), true);
    pageReady();
    const warmed: string[] = [];
    warmEngine({
      engine: async () => warmed.push("engine"),
      tables: async () => warmed.push("tables"),
    });
    assert.equal(
      await whenNamed(async () => "named", "unsaid", "the names"),
      "named",
    );
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(warmed, ["engine", "tables"]);
    assert.equal(engineWarming(), false);
    assert.equal(page.body.dataset["engine"], "ready");
    assert.equal(page.body.dataset["tables"], "ready");
  });

  it("gives what is unsaid for a read the rules refuse, and says the page went wrong for any other failure", async () => {
    const logged = mock.method(console, "error", () => undefined);
    try {
      const refused = await whenNamed(
        () =>
          Promise.reject(Object.assign(new Error("no"), { name: "Refusal" })),
        "unsaid",
        "the names",
      );
      assert.equal(refused, "unsaid");
      assert.equal(page.body.dataset["error"], undefined);
      const broken = await whenNamed(
        () => Promise.reject(new Error("tables are down")),
        "unsaid",
        "the names",
      );
      assert.equal(broken, "unsaid");
      assert.equal(
        page.body.dataset["error"],
        "the names could not be read: tables are down",
      );
    } finally {
      logged.mock.restore();
    }
  });

  it("gives what is unsaid, and never reads, once the engine has failed to warm, and does not warm the tables", () => {
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `globalThis.document = { body: { dataset: {} }, querySelectorAll: () => [], querySelector: () => ({}) };
         const { pageReady, warmEngine, whenNamed, engineWarming } = await import(${JSON.stringify(import.meta.resolve(APP))});
         pageReady();
         let tables = 0;
         warmEngine({ engine: () => Promise.reject(new Error("no engine")), tables: async () => { tables += 1; } });
         let read = 0;
         const named = await whenNamed(async () => { read += 1; return "named"; }, "unsaid", "the names");
         console.log(JSON.stringify({ named, read, tables, warming: engineWarming(), engine: document.body.dataset.engine ?? null }));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      named: "unsaid",
      read: 0,
      tables: 0,
      warming: false,
      engine: null,
    });
  });
});

/**
 * A page that has made no call the person caused for `IDLE_LOCK_MS` reads itself again: the server, which looks first,
 * has locked the pods by then.
 */
describe("Reading the page again once the person has been idle · idleCounted(), revalidateWhenIdle()", () => {
  let revalidated: number;
  let stop: () => void;
  const api = idleCounted({
    pods: async () => ({ pods: [] }),
    connection: async (_input: { wait?: unknown }) => ({}),
  });
  const minutes = (n: number) => mock.timers.tick(n * 60 * 1000);

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    revalidated = 0;
    stop = revalidateWhenIdle(() => (revalidated += 1));
  });
  afterEach(() => {
    stop();
    mock.timers.reset();
  });

  it("reads again after `IDLE_LOCK_MS` with no call", () => {
    assert.equal(IDLE_LOCK_MS, 15 * 60 * 1000);
    minutes(14);
    assert.equal(revalidated, 0);
    minutes(1);
    assert.equal(revalidated, 1);
  });

  it("counts a call the person caused, which puts the wait off, and not a `connection` that waits, which is the page asking again by itself", async () => {
    minutes(14);
    await api.pods();
    minutes(14);
    assert.equal(revalidated, 0, "the call put the wait off");
    await api.connection({ wait: true });
    minutes(1);
    assert.equal(revalidated, 1, "the waiting connection did not");
  });

  it("reads again when the tab is shown again, and no more once stopped", () => {
    page.dispatch("visibilitychange");
    assert.equal(revalidated, 1);
    page.visibilityState = "hidden";
    page.dispatch("visibilitychange");
    assert.equal(revalidated, 1, "a hidden tab reads nothing");
    stop();
    page.visibilityState = "visible";
    page.dispatch("visibilitychange");
    minutes(15);
    assert.equal(revalidated, 1);
  });
});

/**
 * Where the browser has a model context (WebMCP), the page offers a model the reads of the one list and the tools it
 * runs itself: a move goes through the app's router, a write waits on the person's Allow.
 */
describe("Offering the model context its tools · offerTools(), toolsNow()", () => {
  interface Registered {
    name: string;
    inputSchema: { properties?: Record<string, unknown> };
    execute(
      input: object,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  }
  let registered: { tool: Registered; signal: AbortSignal }[];
  let said: string[];
  let confirms: boolean;
  let now: ReturnType<typeof toolsNow>;

  const READS = [
    {
      name: "list_pods",
      description: "The pods.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      ofPod: false,
    },
    {
      name: "timeline",
      description: "A pod's timeline.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      ofPod: true,
    },
  ];

  const offer = (pod: string | undefined, over: object = {}) =>
    offerTools({
      api: {
        pod: async () => ({}),
        makePod: async () => ({ pod: "ann" }),
      },
      reads: {
        run: async (name: string, input: object) => {
          said.push(`${name} ${JSON.stringify(input)}`);
          return { ran: name };
        },
      },
      listed: READS,
      pod,
      address: { pod: (name: string) => `/pods/${name}/` },
      steps: {
        write: async (name: string) => {
          said.push(`write ${name}`);
          return { wrote: name };
        },
        move: async (to: string) => {
          said.push(`move ${to}`);
        },
      },
      now,
      actions: { make_pod: "Make a pod" },
      said: "The person said no",
      routed: (url: URL) => `routed ${url.pathname}`,
      ...over,
    });
  const tool = (name: string) =>
    registered.find((each) => each.tool.name === name)!.tool;

  beforeEach(() => {
    registered = [];
    said = [];
    confirms = true;
    now = toolsNow({ confirm: async () => confirms, offered: true });
    page.modelContext = {
      registerTool: (
        registeredTool: Registered,
        { signal }: { signal: AbortSignal },
      ) => registered.push({ tool: registeredTool, signal }),
    };
  });

  it("offers each listed read and every tool the page runs itself, and takes them away when what it gave is called", () => {
    const away = offer(undefined);
    const names = registered.map(({ tool: { name } }) => name);
    for (const name of ["list_pods", "timeline", "open_pod", "make_pod"])
      assert.ok(names.includes(name), name);
    assert.ok(registered.every(({ signal }) => !signal.aborted));
    away();
    assert.ok(registered.every(({ signal }) => signal.aborted));
  });

  it("offers nothing, and still gives what takes it away, where the browser has no model context", () => {
    page.modelContext = undefined;
    const away = offer(undefined);
    assert.deepEqual(registered, []);
    away();
  });

  it("takes the pod as given for the tools of one pod when a pod is shown, and asks for it otherwise, `open_pod` always asking", async () => {
    offer("alex-rivera");
    assert.equal(tool("timeline").inputSchema.properties?.["pod"], undefined);
    assert.ok(tool("open_pod").inputSchema.properties?.["pod"]);
    await tool("timeline").execute({});
    assert.deepEqual(said, ['timeline {"pod":"alex-rivera"}']);
    registered = [];
    offer(undefined);
    assert.ok(tool("timeline").inputSchema.properties?.["pod"]);
  });

  it("answers a refused call with its sentence rather than rejecting, so that the agent reads why", async () => {
    offer(undefined);
    const answer = (await tool("timeline").execute({})) as { refused: string };
    assert.equal(typeof answer.refused, "string");
    assert.match(answer.refused, /pod/);
  });

  it("runs a write only once the person has said yes, and refuses it with their answer when they say no", async () => {
    offer(undefined);
    confirms = false;
    assert.deepEqual(await tool("make_pod").execute({ person: "Ann" }), {
      refused: "The person said no",
    });
    assert.deepEqual(said, []);
    confirms = true;
    assert.deepEqual(await tool("make_pod").execute({ person: "Ann" }), {
      wrote: "make_pod",
    });
    assert.deepEqual(said, ["write make_pod"]);
  });

  it("refuses a tool while the page is busy with something else", async () => {
    offer(undefined);
    page.body.dataset["state"] = "busy";
    assert.deepEqual(await tool("open_pod").execute({ pod: "alex-rivera" }), {
      refused: "The page is busy with something else; try again",
    });
    assert.deepEqual(said, []);
  });

  it("moves the app in place for a tool that opens a page, and waits for the screen it moved to to be the one shown", async () => {
    now.set({ confirm: async () => true, offered: false });
    offer(undefined);
    let answered = false;
    const moving = tool("open_pod")
      .execute({ pod: "alex-rivera" })
      .then((output) => {
        answered = true;
        return output;
      });
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(said, ["move routed /pods/alex-rivera/"]);
    assert.equal(answered, false, "the screen is not drawn yet");
    now.set({ confirm: async () => true, offered: true });
    assert.deepEqual(await moving, { opened: "/pods/alex-rivera/" });
  });
});
