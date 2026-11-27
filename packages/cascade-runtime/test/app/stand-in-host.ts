// A host for PodApi's tests that is no runtime and holds no pod: the pods are a table the test writes, and every call
// the host and its pods are given is recorded. It answers what the table says and nothing it is not told, so a test
// reads what PodApi asked of the host, and what it did with the answer.
import { Unopened } from "@cascade-runtime/runtime";
import type { PodHost } from "../../src/app/pod-api.js";
import type { Pod } from "../../src/pod.js";

type Rows = readonly Record<string, unknown>[];
type Told = (...args: never[]) => unknown;

/** What the host says of one pod. A pod the table has no entry for is not there; opening its name makes it, as a folder does. */
export interface PodTable {
  /** The title the host keeps for the pod. */
  title?: string;
  /** Whether the pod says it was given a title; by default, when it has one. */
  titled?: boolean;
  /** Set when the pod is encrypted: it opens only with these words. */
  secret?: string;
  /** The rows of each named question; a function is asked at each call. */
  answers?: Record<string, Rows | (() => Rows)>;
  /** The table versions the pod names that the app does not hold. */
  unheld?: readonly string[];
  /** What the pod's open of newer tables settles to. */
  opened?: Promise<unknown>;
  /** What the pod answers `look`, `import`, `match`, `judge` and `connect`, given what it was asked. */
  look?: Told;
  import?: Told;
  match?: Told;
  judge?: Told;
  connect?: Told;
  /** Any other method of the pod: what it answers. */
  other?: Record<string, Told>;
}

/** One call the host or one of its pods was given, in order: `on` is `pods.open`, `pod.ask` and so on. */
export interface Call {
  on: string;
  pod?: string;
  args: unknown[];
}

export interface StandInOptions {
  /** What the host's `tables()` gives; each ask is a call. */
  tables?: unknown;
  /** The pod's reads of the reference tables fail with this. */
  tablesFail?: Error;
  compact?: PodHost["compact"];
  hospitals?: PodHost["hospitals"];
  world?: PodHost["world"];
  opensEncrypted?: boolean;
  /** The sample pods, copied to a pod of their name. */
  samples?: string[];
  /** The pods `restore` puts back. */
  restores?: string[];
  checked?: unknown;
}

/** Holds each opening that is given words until `release()`; `started(n)` resolves once `n` such openings have begun. */
export interface Hold {
  release(): void;
  started(n: number): Promise<void>;
}

export function standIn(
  table: Record<string, PodTable> = {},
  options: StandInOptions = {},
) {
  const calls: Call[] = [];
  const record = (on: string, args: unknown[] = [], pod?: string) => {
    calls.push({ on, args, ...(pod !== undefined && { pod }) });
  };
  let hold: {
    gate: Promise<void>;
    begun: number;
    waiters: [number, () => void][];
  };
  let release: () => void = () => undefined;

  const told = (entry: PodTable, name: string, method: keyof PodTable) => {
    const answer = entry[method] as Told | undefined;
    return (...args: unknown[]) => {
      record(`pod.${method}`, args, name);
      return (answer as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    };
  };

  function podOf(name: string, entry: PodTable): Pod {
    const rowsOf = (question: string): Rows => {
      const given = entry.answers?.[question];
      return typeof given === "function" ? given() : (given ?? []);
    };
    const looked = told(entry, name, "look");
    const imported = told(entry, name, "import");
    const matched = told(entry, name, "match");
    const judged = told(entry, name, "judge");
    const connected = told(entry, name, "connect");
    const listed = (on: string) => async () => {
      record(on, [], name);
      return [];
    };
    const other = (method: string) => entry.other?.[method] as Told | undefined;
    const pod = {
      address: `urn:test:${name}/`,
      subject: `urn:test:${name}/subject`,
      owner: `urn:test:${name}/owner#me`,
      encrypted: entry.secret !== undefined,
      get titled() {
        return entry.titled ?? entry.title !== undefined;
      },
      head: undefined,
      opened: entry.opened ?? Promise.resolve(undefined),
      ask: async (question: string) => {
        record("pod.ask", [question], name);
        return rowsOf(question);
      },
      unheldTableVersions: async () => {
        record("pod.unheldTableVersions", [], name);
        return [...(entry.unheld ?? [])];
      },
      joinedBy: listed("pod.joinedBy"),
      medicationClasses: async () => {
        record("pod.medicationClasses", [], name);
        return (other("medicationClasses")?.() ?? []) as never;
      },
      panelResults: async (panel: string) => {
        record("pod.panelResults", [panel], name);
        return (other("panelResults")?.(panel as never) ?? []) as never;
      },
      agreement: listed("pod.agreement"),
      look: async (files: unknown) => (await looked(files)) ?? [],
      import: async (files: unknown, importOptions: unknown) =>
        (await imported(files, importOptions)) ?? {
          wrote: [],
          claimedProfiles: [],
          unclaimedProfiles: [],
          disclaimedProfiles: [],
          heldBackProfiles: [],
        },
      match: async (activity?: unknown) => (await matched(activity)) ?? {},
      judge: async (turtle: string) => (await judged(turtle)) ?? {},
      connect: async (files: unknown) => (await connected(files)) ?? {},
      retitle: async (title: string) => {
        record("pod.retitle", [title], name);
        entry.title = title;
        entry.titled = true;
      },
      close: async () => {
        record("pod.close", [], name);
      },
    };
    return pod as unknown as Pod;
  }

  const host = {
    pods: {
      names: async () => {
        record("pods.names");
        return Object.keys(table).sort();
      },
      title: async (name: string) => {
        record("pods.title", [name]);
        return table[name]?.title;
      },
      open: async (
        name: string,
        opening?: { title?: string; secret?: string },
      ) => {
        record("pods.open", [name, opening]);
        if (opening?.secret !== undefined && hold !== undefined) {
          hold.begun += 1;
          for (const [n, done] of hold.waiters) if (n <= hold.begun) done();
          await hold.gate;
        }
        const entry = (table[name] ??= {
          ...(opening?.title !== undefined && { title: opening.title }),
          ...(opening?.secret !== undefined && { secret: opening.secret }),
        });
        if (entry.secret !== undefined && opening?.secret !== entry.secret)
          throw new Unopened(
            opening?.secret === undefined
              ? "secret needed"
              : "incorrect secret",
            "the stand-in's pod is encrypted",
          );
        return podOf(name, entry);
      },
      checkSecret: async (name: string, secret: string) => {
        record("pods.checkSecret", [name, secret]);
        return table[name]?.secret === secret;
      },
      remove: async (
        names: readonly string[],
        removing?: { all?: boolean },
      ) => {
        record("pods.remove", [names, removing]);
        for (const name of names) delete table[name];
      },
    },
    ...(options.samples !== undefined && {
      samples: options.samples,
      copySample: async (name: string) => {
        record("copySample", [name]);
        table[name] ??= {};
        return podOf(name, table[name]!);
      },
    }),
    ...(options.restores !== undefined && {
      restore: async () => {
        record("restore");
        for (const name of options.restores!) table[name] ??= {};
        return options.restores!;
      },
    }),
    ...(options.compact !== undefined && {
      compact: (...args: Parameters<NonNullable<PodHost["compact"]>>) => {
        record("compact", [args[0], args[2]]);
        return options.compact!(...args);
      },
    }),
    tables: async () => {
      record("tables");
      if (options.tablesFail !== undefined) throw options.tablesFail;
      return options.tables;
    },
    checkTables: async () => {
      record("checkTables");
      return options.checked ?? [];
    },
    opensEncrypted: options.opensEncrypted ?? true,
    ...(options.hospitals !== undefined && { hospitals: options.hospitals }),
    ...(options.world !== undefined && { world: options.world }),
  } as unknown as PodHost;

  return {
    host,
    table,
    calls,
    /** The calls named `on`, of the pod `pod` when one is given. */
    of: (on: string, pod?: string) =>
      calls.filter(
        (call) => call.on === on && (pod === undefined || call.pod === pod),
      ),
    /** Holds every opening that is given words until `release()`. */
    holding(): Hold {
      const gate = new Promise<void>((done) => (release = done));
      hold = { gate, begun: 0, waiters: [] };
      return {
        release: () => release(),
        started: (n) =>
          new Promise<void>((done) => {
            if (hold.begun >= n) done();
            else hold.waiters.push([n, done]);
          }),
      };
    },
  };
}
