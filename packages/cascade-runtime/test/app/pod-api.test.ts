import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  canonical,
  MemoryFiles,
  ntriples,
  OxigraphStore,
} from "@cascade-runtime/runtime";
import { checkouts, findRoot } from "@cascade-runtime/runtime/node";
import { loadHospital } from "@the-cascade-protocol/sandbox/node";
import {
  ConnectionFailure,
  openPod,
  pullFiles,
  Refusal,
  sixWords,
  timelineIn,
  Unopened,
} from "cascade-runtime";
import { loadSample } from "cascade-runtime/samples";
import { trendOf } from "cascade-runtime/tools";
import { partsOf } from "../../src/node/resolved.js";
import { openPodWith } from "../../src/pod.js";
import {
  type About,
  Tables,
  versionName,
  writeStarterCopies,
} from "../../src/tables.js";
import { importClaimingEveryProfile } from "../claiming.js";
import { TILES } from "./fixtures.js";
import {
  type Alter,
  answering,
  type Loaded,
  pulled,
  routed,
  rowOf,
} from "../hospitals.js";
import { gone, removed, settled } from "../settled.js";
import {
  type PodTable,
  standIn,
  type StandInOptions,
} from "./stand-in-host.js";

type Input = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Output = Record<string, any>;
type Operation = (input: Input) => Promise<Output>;
type Api = Record<
  | "pods"
  | "held"
  | "pod"
  | "answers"
  | "said"
  | "trend"
  | "classes"
  | "panel"
  | "table"
  | "ask"
  | "tool"
  | "makePod"
  | "waiting"
  | "waitingWords"
  | "confirmWords"
  | "unlock"
  | "lock"
  | "deleteAll"
  | "resetAll"
  | "checkTables"
  | "setWorldDate"
  | "hospitals"
  | "connect"
  | "connection"
  | "bring",
  Operation
> & { close(): Promise<void> };
type Host = Record<string, unknown> & { tables: unknown };

/** What `podApi` takes besides the host: the clock the idle lock reads, in milliseconds, and the app's tiles. */
interface Clocked {
  clock?: () => number;
  sections?: typeof TILES;
}
/** The entry point an app imports, read as loosely as the tests call it. */
const APP: string = "cascade-runtime/app";
const {
  podApi,
  maps,
  notOpenedHere,
  WAIT_MS,
  IDLE_CHECK_MS,
  IDLE_LOCK_MS,
  remoteApi,
  nodeHost,
  appHandler,
  newLaunch,
  launchCookie,
  entryId,
  testsIn,
} = (await import(APP)) as {
  /** What an app's server mounts: a request in, a response out. */
  appHandler: (options: {
    api: Api;
    own: () => { hosts: Set<string>; origins: Set<string> };
    launch: Launch;
    address: { home: string; connection: () => string };
    back: () => undefined;
  }) => (request: Request) => Promise<Response>;
  newLaunch: () => Launch;
  launchCookie: (url: URL) => string;
  WAIT_MS: number;
  IDLE_CHECK_MS: number;
  IDLE_LOCK_MS: number;
  entryId: (entry: string) => string;
  testsIn: (labs: unknown[]) => { code: string; notation?: string }[];
  podApi: (host: Host, options?: Clocked) => Api;
  maps: (output: Output) => Output;
  notOpenedHere: (name: string) => string;
  /** PodApi at a server, through the app's own client. */
  remoteApi: (
    base: string,
    options: {
      fetch: (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>;
      headers?: Record<string, string>;
    },
  ) => Api;
  nodeHost: (options: { folder: string; opensEncrypted?: boolean }) => Host & {
    pods: {
      names(): Promise<string[]>;
      title(name: string): Promise<string | undefined>;
      open(
        name: string,
        options?: { secret?: string },
      ): Promise<{ encrypted: boolean; close(): Promise<void> }>;
      checkSecret(name: string, secret: string): Promise<boolean>;
      remove(names: string[], options: { all: boolean }): Promise<void>;
    };
  };
};
/** What proves a request comes from the page the launch opened: the token the printed address carries, spent for a cookie. */
interface Launch {
  readonly token: string;
  exchange(given: string | undefined): string | undefined;
}
/** What answers a request: the app's handler, as `app.request()` puts a request to it. */
interface App {
  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const STATIN = "story-statin";
const REVIEW = "profile/What needs review";
const EMPTY = "empty";
const SEALED = "sealed";
const LDL = "18262-6";
const ATORVASTATIN = "617310";
const SECOND_ATORVASTATIN = "617314";
const LABS = "pod/My lab results";
const IMPORTS = "pod/What each import brought in";
const MEDICATIONS = "pod/My medication history";

let folder: string;
/** The words that open the encrypted pod. */
const SEALED_WORDS = sixWords();
/** The IRIs of the LDL test and of atorvastatin, found in the statin pod by their notation. */
const iris = { ldl: "", atorvastatin: "" };
const named = (label: string) => ({ name: { label, altLabels: [] } });

/** A `Tables` holding one LOINC series, naming the LDL test and atorvastatin and nothing else. */
const FAKE = {
  held: async () => [
    {
      iri: "urn:uuid:loinc-terms",
      label: "LOINC terms",
      source: "urn:uuid:loinc",
      versions: [],
    },
  ],
  about: async (codes: string[]) =>
    new Map(
      codes.flatMap((code) =>
        code === iris.ldl
          ? [[code, named("LDL cholesterol")]]
          : code === iris.atorvastatin
            ? [[code, named("atorvastatin")]]
            : [],
      ),
    ),
  codeNamed: async (_: unknown, written: string) =>
    written === LDL ? iris.ldl : undefined,
  facts: async () => ({ notation: LDL, about: named("LDL cholesterol") }),
  search: async () => ({ found: [], total: 0, size: 50 }),
  uses: async () => [],
  inPanels: async () => [],
  classedElsewhere: async () => new Map(),
  labels: async () => new Map(),
  current: async () => [],
  variantClassification: async () => undefined,
  check: async () => [{ feed: "f", kept: ["v"], refused: [] }],
};

function counted<T>(give: () => Promise<T>) {
  const wrapped = Object.assign(
    () => {
      wrapped.calls += 1;
      return give();
    },
    { calls: 0 },
  );
  return wrapped;
}

/** Whether `value` is plain JSON: no Map, Set, Date, function, class instance or non-finite number; undefined allowed. */
function plainJson(value: unknown, at = "output"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number")
    return assert.ok(Number.isFinite(value), `${at} is ${value}`);
  if (typeof value === "string" || typeof value === "boolean") return;
  assert.equal(typeof value, "object", `${at} is a ${typeof value}`);
  if (Array.isArray(value))
    return value.forEach((each, n) => plainJson(each, `${at}[${n}]`));
  assert.equal(
    Object.getPrototypeOf(value),
    Object.prototype,
    `${at} is a ${value.constructor?.name}`,
  );
  for (const [key, each] of Object.entries(value))
    plainJson(each, `${at}.${key}`);
}

let north: Loaded;
/** The world's date the test hosts' hospitals answer as of. */
const world = {
  asOf: undefined as string | undefined,
  get() {
    return this.asOf;
  },
  set(asOf: string | undefined) {
    this.asOf = asOf;
  },
};

/**
 * Cascade North, in the process, as a host's hospitals: its sign-in page answered as the statin pod's patient, who
 * cancels it when the pod is the empty one. `seen` gets each authorize URL the sign-in is given; `alter` changes what
 * the hospital answers.
 */
function northHospitals(seen: URL[] = [], alter?: Alter) {
  const fetch = routed(
    [{ ...north, autoApprove: undefined }],
    { requests: [], secrets: new Set() },
    alter,
  );
  return {
    directory: async () => [rowOf(north)],
    registration: {
      clientId: "cascade-app",
      redirectUri: "https://app.test.invalid/callback",
    },
    fetch,
    ready: async () => undefined,
    signIn:
      (_: unknown, { pod }: { pod: string }, report: (href: string) => void) =>
      async (authorize: URL, signal?: AbortSignal) => {
        seen.push(new URL(authorize));
        report(authorize.href);
        return answering(STATIN, pod === EMPTY ? "cancel" : "allow")(fetch)(
          authorize,
          signal,
        );
      },
    pullName: () => "north",
  };
}

/** The real host, over `at`: the pods are folders, the tables are `FAKE`. */
const host = (at = folder) => ({
  ...nodeHost({ folder: at }),
  tables: counted(async () => FAKE),
  checkTables: async () => FAKE.check(),
  hospitals: northHospitals(),
  world,
});
const made: Api[] = [];

/** What each call that reached the server's instance came back with, in order, for `crossing()` to compare. */
type Call = PromiseSettledResult<Output>;

/** The handler over `built`, answering as `app.test`, and what `built` answered each call. */
function served(built: Api): [App, Call[], Launch] {
  const launch = newLaunch();
  const calls: Call[] = [];
  const recording = { ...built } as Api;
  for (const name of Object.keys(built) as (keyof Api)[]) {
    if (name === "close") continue;
    recording[name] = async (input: Input) => {
      try {
        const value = await built[name](input);
        calls.push({ status: "fulfilled", value });
        return value;
      } catch (reason) {
        calls.push({ status: "rejected", reason });
        throw reason;
      }
    };
  }
  const handle = appHandler({
    api: recording,
    own: () => ({
      hosts: new Set([new URL(ORIGIN).host]),
      origins: new Set([ORIGIN]),
    }),
    launch,
    address: { home: "/", connection: () => "/" },
    back: () => undefined,
  });
  return [
    { request: (input, init) => handle(new Request(input, init)) },
    calls,
    launch,
  ];
}
const ORIGIN = "http://app.test";

/** The cookie a page of the server holds once it has opened the address the server printed. */
function cookieOf(launch: Launch): string {
  const session = launch.exchange(launch.token);
  assert.ok(session, "the token was spent already");
  return `${launchCookie(new URL(ORIGIN))}=${session}`;
}

/** A refusal as the app tells it, by its name; an `Unopened` carries its `outcome`. */
const isRefusal = (error: unknown): error is Error & { outcome?: string } =>
  error instanceof Error &&
  (error.name === "Refusal" || error.name === "Unopened");
const unopened = (error: unknown, outcome: string) =>
  isRefusal(error) && error.outcome === outcome;

/**
 * `built` over HTTP: through the handler, by `app.request()`, with the app's own client.
 * A call over HTTP runs once, on `built`, unless its route refuses the input first, as PodApi would refuse it; what
 * comes back must be what `built` answered that call, after a JSON round trip, and what is thrown a refusal of the
 * same name with the same message. What `built` threw other than a `Refusal` crosses as a 500 naming the operation.
 */
function crossing(built: Api): Api {
  const origin = ORIGIN;
  const [app, calls, launch] = served(built);
  const remote = remoteApi(`${origin}/`, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      app.request(input, init),
    headers: { origin, cookie: cookieOf(launch) },
  });
  const over = {} as Api;
  for (const name of Object.keys(remote) as (keyof Api)[]) {
    if (name === "close") continue;
    over[name] = async (input: Input) => {
      const [crossed] = await Promise.allSettled([remote[name](input)]);
      const direct = calls.pop();
      assert.equal(calls.length, 0, `${name} ran once`);
      if (direct === undefined) {
        if (crossed.status === "fulfilled")
          assert.fail(`${name} answered, never reaching PodApi`);
        const [own] = await Promise.allSettled([built[name](input)]);
        if (own.status === "fulfilled")
          assert.fail(`${name} refused over HTTP only`);
        assert.equal(crossed.reason.name, "Refusal");
        assert.equal(crossed.reason.message, own.reason.message);
        throw crossed.reason;
      }
      if (crossed.status === "fulfilled") {
        assert.equal(direct.status, "fulfilled", `${name} over HTTP`);
        assert.deepStrictEqual(
          crossed.value,
          JSON.parse(JSON.stringify(direct.value)),
          `${name} over HTTP`,
        );
        return crossed.value;
      }
      assert.equal(direct.status, "rejected", `${name} over HTTP`);
      const [was, is] = [direct.reason, crossed.reason];
      if (was instanceof Refusal) {
        assert.equal(is.name, was instanceof Unopened ? "Unopened" : "Refusal");
        assert.equal(is.message, was.message);
        if (was instanceof Unopened) assert.equal(is.outcome, was.outcome);
      } else assert.equal(is.message, `${name}: the server answered 500`);
      throw is;
    };
  }
  over.close = async () => undefined;
  return over;
}
function api(given: Host, options?: Clocked) {
  const built = podApi(given, { sections: TILES, ...options });
  made.push(built);
  const checked = {} as Api;
  for (const [name, operation] of Object.entries(built))
    (checked as Record<string, unknown>)[name] =
      name === "close" || name === "tables"
        ? operation
        : async (input: Input) => {
            const output = await (operation as Operation)(input);
            plainJson(output, name);
            return output;
          };
  return checked;
}

/**
 * The stand-in host over `table`, and PodApi over it, in the process and over HTTP. `s.calls` is what the host and its
 * pods were asked, in order; the reference tables are `FAKE` unless `options` say otherwise.
 */
function local(
  table: Record<string, PodTable> = {},
  options: StandInOptions = {},
  clocked?: Clocked,
) {
  const s = standIn(table, { tables: FAKE, world, ...options });
  const built = api(s.host as unknown as Host, clocked);
  return { s, built, over: crossing(built) };
}
/** The pods a stand-in host was asked to open by `name`, in order. */
const openings = (s: ReturnType<typeof standIn>, name?: string) =>
  s
    .of("pods.open")
    .filter((call) => name === undefined || call.args[0] === name);
const rowsOf = (count: number): Output[] =>
  Array.from({ length: count }, (_, n) => ({ entry: `urn:test:row-${n}` }));

/** The folders of the tests that write, each its own, so the shared pods stay as they were made. */
const folders: string[] = [];

/** What the real pod's build through PodApi gave, read by the cases that need a real pod's content. */
const statin = {
  /** The parts the import reported, in order, with the connection's part at each claim. */
  parts: [] as string[],
  /** The pod's files when the first request for the patient came, and once the pull had settled. */
  atFirstRecord: [] as string[][],
  listing: [] as string[],
  shown: {} as Output,
  bringing: {} as Output,
  brought: {} as Output,
  connection: 0,
};
/** The instance the real pod is read through, in the process and over HTTP. */
let inProcess: Api;
let overHttp: Api;

/** The real pod's handle, as the real host opened it, for the one question PodApi has no operation for. */
interface StatinPod {
  ask(question: { query: string }): Promise<Output[]>;
}
let statinPod: StatinPod;

/** The pod's files, listed. */
const filesOf = async () =>
  (await readdir(join(folder, STATIN), { recursive: true })).sort();

before(async () => {
  folder = await mkdtemp(join(tmpdir(), "pod-api-"));
  north = await loadHospital("cascade-north");
  const sealed = await openPod(join(folder, SEALED), { secret: SEALED_WORDS });
  await sealed.close();
  const at = { pod: STATIN, connection: 0 };
  const recording = (pod: object) =>
    new Proxy(pod, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "judge")
          return async (...args: unknown[]) => {
            statin.parts.push(
              (await inProcess.connection(at)).bringing?.part as string,
            );
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        if (key !== "import")
          return typeof value === "function" ? value.bind(target) : value;
        return (
          files: unknown,
          options: { onProgress?: (told: { part: string }) => unknown },
        ) =>
          (value as (...a: unknown[]) => unknown).call(target, files, {
            ...options,
            onProgress: (told: { part: string }) => {
              statin.parts.push(told.part);
              return options.onProgress?.(told);
            },
          });
      },
    });
  const real = host();
  const opening = real.pods as unknown as {
    open(...a: unknown[]): Promise<object>;
  };
  const hospitals = northHospitals([], async (request, hospital) => {
    if (new URL(request.url).pathname.includes("/Patient"))
      statin.atFirstRecord.push(await filesOf());
    return hospital(request);
  });
  inProcess = api({
    ...real,
    hospitals,
    pods: {
      ...real.pods,
      open: async (...args: unknown[]) => {
        const pod = await opening.open(...args);
        if (args[0] === STATIN) statinPod = pod as StatinPod;
        return recording(pod);
      },
    },
  } as Host);
  overHttp = crossing(inProcess);
  await inProcess.makePod({ person: "Story Statin" });
  const connecting = await connected(inProcess, STATIN);
  statin.shown = connecting.shown;
  statin.listing = await filesOf();
  statin.connection = at.connection = connecting.connection;
  statin.bringing = await inProcess.bring(at);
  statin.brought = await inProcess.connection({ ...at, wait: true });
  assert.equal(statin.brought.broughtIn, true, JSON.stringify(statin.brought));
  const labs = (await inProcess.ask({ pod: STATIN, question: LABS })).rows;
  iris.ldl = testsIn(labs).find(({ notation }) => notation === LDL)!.code;
  iris.atorvastatin = timelineIn(
    (await inProcess.ask({ pod: STATIN, question: MEDICATIONS })).rows,
  ).find(({ notation }) => notation === ATORVASTATIN)!.code!;
});

after(async () => {
  await Promise.all(made.map((each) => each.close()));
  for (const each of [folder, ...folders]) await removed(each);
});

const labs = async (): Promise<Output[]> =>
  (await overHttp.ask({ pod: STATIN, question: LABS })).rows;

/** Runs `make` the first time it is asked for, and gives every later ask what it made. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}
/** What `call` rejected with, and a failure when it did not reject. */
const caught = (call: Promise<unknown>) =>
  call.then(
    () => assert.fail("it did not reject"),
    (error: Error & { outcome?: string }) => error,
  );
const FHIR_BASE = () => rowOf(north).fhirBase;
/** A connection of `pod` to Cascade North, waited for until it has settled. */
async function connected(local: Api, pod: string) {
  const { connection } = await local.connect({ pod, fhirBase: FHIR_BASE() });
  let shown = await local.connection({ pod, connection, wait: true });
  // `wait` returns when the hold runs out, not when the pull has settled: a slow pull is a wait, not a Refusal.
  for (let tries = 0; !shown.settled && tries < 120; tries++) {
    shown = await local.connection({ pod, connection, wait: true });
  }
  return { connection, shown };
}
/** `connected`, failing with the step it got when the connection settled anywhere but at "pulled". */
async function connectedAndPulled(local: Api, pod: string) {
  const got = await connected(local, pod);
  assert.equal(
    got.shown.step,
    "pulled",
    `the connection is at step "${got.shown.step}", not "pulled"`,
  );
  return got;
}
/** An instance whose host cannot read the reference tables, with the pod `STATIN` and nothing in it. */
const brokenApi = () =>
  local({ [STATIN]: {} }, { tablesFail: new Error("tables are broken") }).built;

const CASCADE = "https://ns.cascadeprotocol.org/cascade#";
const CLINVAR_FEED = "https://tables.example/feed.ttl";
const CLINVAR_PREFIXES = `@prefix cascade: <${CASCADE}> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix pav: <http://purl.org/pav/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix spdx: <http://spdx.org/rdf/terms#> .
`;

/**
 * The reference tables an app starts from when the one series they hold is ClinVar's, whose one row, found by the coding
 * expression `NM_000249.3:c.2042C>T`, classifies the variation Pathogenic; and the parts a pod is opened with over them.
 */
async function clinvarTables() {
  const series = "urn:uuid:0a1e2c3d-4b5a-4c6d-8e7f-a1b2c3d4e5f6";
  const url = "https://tables.example/rows/clinvar.nq.gz";
  const found = await partsOf(
    await checkouts(findRoot(dirname(fileURLToPath(import.meta.url)))),
  );
  const rows = await new OxigraphStore().parse(
    `${CLINVAR_PREFIXES}<https://identifiers.org/clinvar:90011> cascade:hgvsExpression <https://ns.cascadeprotocol.org/codes/hgvs/NM_000249.3%3Ac.2042C%3ET> ; cascade:clinvarClassification cascade:Pathogenic .`,
    "urn:test:rows",
  );
  const version = await versionName(series, undefined, rows);
  const bytes = new Uint8Array(
    await new Response(
      new Blob([
        (await canonical(rows))
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => `${line.replace(/\s*\.\s*$/, "")} <${version}> .`)
          .sort()
          .join("\n"),
      ])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const checksum = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const catalog = await new OxigraphStore().parse(
    `${CLINVAR_PREFIXES}<${series}> a cascade:ReferenceSeries ; rdfs:label "ClinVar" ;
  cascade:tableKind cascade:VariantClassifications ; dct:bibliographicCitation "ClinVar, NCBI." ;
  dcat:hasCurrentVersion <${version}> .
<${version}> prov:specializationOf <${series}> ; pav:version "1" ; cascade:coversGene "MLH1" ;
  dcat:distribution [ dcat:downloadURL <${url}> ; spdx:checksum [ spdx:checksumValue "${checksum}" ] ] .`,
    CLINVAR_FEED,
  );
  const served: typeof fetch = async (input) =>
    String(input) === CLINVAR_FEED
      ? new Response(new TextDecoder().decode(ntriples(catalog)))
      : String(input) === url
        ? new Response(bytes.slice())
        : new Response(null, { status: 404 });
  const starter = new MemoryFiles("urn:test:starter/");
  await writeStarterCopies(
    {
      feeds: [CLINVAR_FEED],
      vocabulary: found.vocabulary,
      newStore: found.newStore,
      fetch: served,
    },
    (path, bytes) => starter.write(path, bytes),
  );
  const tables = new Tables({
    files: new MemoryFiles("urn:test:app/"),
    feeds: [CLINVAR_FEED],
    vocabulary: found.vocabulary,
    newStore: found.newStore,
    starter,
  });
  return { tables, parts: { ...found, tables } };
}

/** A stub pod `reviewed`: one allergy that needs review, and one table version the app does not hold. */
const reviewing = (options?: Clocked) =>
  local(
    {
      reviewed: {
        answers: {
          "pod/My active allergies": [
            { entry: "urn:uuid:0e1f", allergenName: "Latex" },
          ],
          "entry/What needs review": [
            {
              entry: "urn:uuid:0e1f",
              entryLabel: "Allergy entry · Latex",
              needs: "judged different, still joined",
            },
          ],
        },
        unheld: ["urn:x:ingredient-map-2"],
      },
    },
    {},
    options,
  ).over;

/**
 * PodApi's reads give each screen of a pod what it shows, as plain JSON: first the pod's own rows, which need no
 * reference tables, then what the tables say of them. A screen can so be drawn before the tables have loaded.
 */
describe("Reading a pod for its screens · api.pods(), api.pod(), api.answers(), api.said(), api.trend(), api.classes(), api.panel()", () => {
  let read: Output;
  before(async () => {
    read = await crossing(inProcess).answers({ pod: STATIN });
  });

  describe("api.pods()", () => {
    it("returns every pod's name and title, in the order of their names", async () => {
      const { over, s } = local({ b: { title: "Bee" }, a: {} });
      assert.deepEqual((await over.pods({})).pods, [
        { name: "a", title: "a" },
        { name: "b", title: "Bee" },
      ]);
      assert.equal(s.of("pods.names").length > 0, true);
    });
  });

  describe("api.answers({ pod })", () => {
    it("returns the pod's rows by named question, and its lab changes, in `answers` and `changes`", () => {
      assert.ok(read.answers[LABS].length > 0);
      assert.ok(
        read.changes.some(
          ({ key }: { key: string }) => key === `start:${ATORVASTATIN}:${LDL}`,
        ),
      );
    });

    it("returns the same lab changes for an app whose tiles do not ask for lab results", async () => {
      const untiled = await crossing(
        api(host(), {
          sections: TILES.filter(({ question }) => question !== LABS),
        }),
      ).answers({ pod: STATIN });
      assert.ok(read.changes.length > 0);
      assert.deepEqual(untiled.changes, read.changes);
    });

    it("reads no reference table", async () => {
      const { over, s } = local({ p: { answers: { [LABS]: rowsOf(2) } } });
      await over.pods({});
      assert.equal((await over.answers({ pod: "p" })).answers[LABS]?.length, 2);
      assert.equal(s.of("tables").length, 0);
    });

    it("returns in `unheld` the versions of the tables the pod was written under that the app does not hold", async () => {
      assert.deepEqual(read.unheld, []);
      assert.deepEqual(
        (await reviewing().answers({ pod: "reviewed" })).unheld,
        ["urn:x:ingredient-map-2"],
      );
    });

    it("returns, given `wait`, neither `adopting` nor `adopted` for a pod whose open had nothing to take in", async () => {
      const { over } = local({ p: { opened: Promise.resolve(undefined) } });
      const waited = await over.answers({ pod: "p", wait: true });
      assert.equal(waited.adopting, undefined);
      assert.equal(waited.adopted, undefined);
    });

    it("returns no `adopting` for a pod whose open had nothing newer to take in, though it is the pod's first read", async () => {
      const { over } = local({ p: { opened: Promise.resolve(undefined) } });
      assert.equal((await over.answers({ pod: "p" })).adopting, undefined);
    });
  });

  describe("given a pod that takes in the app's newer tables after it opens, api.answers({ pod, wait })", () => {
    let order: string[];
    let first: Output;
    let waitedEarly: boolean;
    let waited: Output;
    let tookIn: Output;
    before(async () => {
      tookIn = await local({
        taking: { opened: Promise.resolve({ wrote: [], unheld: [] }) },
      }).over.answers({ pod: "taking", wait: true });
      let release!: () => void;
      const opened = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      const { s, over: adopting } = local({ adopting: { opened } });
      first = await adopting.answers({ pod: "adopting" });
      order = s.calls
        .filter(({ on }) => ["pod.ask", "pod.unheldTableVersions"].includes(on))
        .map(({ on }) => on);
      const waiting = adopting.answers({ pod: "adopting", wait: true });
      waitedEarly = await Promise.race([
        waiting.then(() => true),
        delay(50).then(() => false),
      ]);
      release();
      waited = await waiting;
    });

    it("returns `adopting` with the answers given before that open is done", () => {
      assert.equal(first.adopting, true);
    });

    it("asks for the unheld versions as it asks the questions, not after their answers", () => {
      assert.equal(order[0], "pod.unheldTableVersions");
    });

    it("returns, given `wait`, once that open is done, without `adopting`", () => {
      assert.equal(waitedEarly, false);
      assert.equal(waited.adopting, undefined);
    });

    it("returns, given `wait`, `adopted` when that open took something in, and none when it took in nothing", () => {
      assert.equal(tookIn.adopted, true);
      assert.equal(waited.adopted, undefined);
    });
  });

  describe("given a pod that answers from a table, api.panel() and api.classes()", () => {
    it("ask the pod for the panel's results by the panel's code and for the medications' classes, and the questions beside them", async () => {
      const { s, over } = local({ p: {} });
      await over.panel({ pod: "p", panel: "24331-1" });
      const asked = (call: string) => s.of(call, "p").map(({ args }) => args);
      assert.deepEqual(asked("pod.panelResults"), [["24331-1"]]);
      assert.deepEqual(asked("pod.ask"), [[LABS]]);
      assert.deepEqual(asked("pod.medicationClasses"), []);
      await over.classes({ pod: "p" });
      assert.deepEqual(asked("pod.panelResults"), [["24331-1"]]);
      assert.deepEqual(asked("pod.ask"), [
        [LABS],
        ["pod/My active medications"],
      ]);
      assert.equal(asked("pod.medicationClasses").length, 1);
    });
  });

  describe("api.said({ pod, entry })", () => {
    it("returns what the reference tables say of the pod's codes, in `about`", async () => {
      assert.equal(
        maps(await overHttp.said({ pod: STATIN })).about.get(iris.ldl).name
          .label,
        "LDL cholesterol",
      );
    });

    it("returns one view entry as its screen reads it, with the panels its test is in, when `entry` names it", async () => {
      const row = (await labs()).find((each) => each.code === iris.ldl)!;
      const out = await overHttp.said({
        pod: STATIN,
        entry: entryId(row.entry),
      });
      assert.equal(out.entry.entry, row.entry);
      assert.deepEqual(out.panels, []);
    });
  });

  describe("api.trend({ pod, test, medication })", () => {
    it("returns the test and medication of the pod's strongest lab change when neither is named", async () => {
      const out = await overHttp.trend({ pod: STATIN });
      assert.equal(out.series.test.notation, LDL);
      assert.equal(out.medication, ATORVASTATIN);
    });

    it("returns a trend for every lab change `find_changes` gives", async () => {
      const { value } = await overHttp.tool({
        pod: STATIN,
        tool: "find_changes",
      });
      assert.ok(value.length > 0);
      for (const finding of value)
        await overHttp.trend({ pod: STATIN, ...trendOf(finding) });
    });
  });

  describe("api.classes({ pod })", () => {
    it("returns the pod's medications, and the drug classes other tables give them, in `elsewhere`", async () => {
      const out = await overHttp.classes({ pod: STATIN });
      assert.ok(
        out.medications.some(({ code }: Output) => code === iris.atorvastatin),
      );
      assert.ok(maps(out).elsewhere instanceof Map);
    });

    it("rejects with the host's own error, as `api.panel()` does, when the reference tables cannot be read", async () => {
      const quiet = mock.method(console, "error", () => undefined);
      try {
        const broken = brokenApi();
        await assert.rejects(
          broken.classes({ pod: STATIN }),
          /tables are broken/,
        );
        await assert.rejects(
          broken.panel({ pod: STATIN, panel: LDL }),
          /tables are broken/,
        );
      } finally {
        quiet.mock.restore();
      }
    });
  });

  describe("api.panel({ pod, panel })", () => {
    it("returns the panel's rows and the pod's lab results", async () => {
      const out = await overHttp.panel({ pod: STATIN, panel: "24331-1" });
      assert.deepEqual(out.rows, []);
      assert.ok(out.labs.some(({ code }: Output) => code === iris.ldl));
    });
  });
});

/**
 * The reference tables screen lists the series the app holds, and a check reads the feeds for newer versions.
 * After a check that kept a version, PodApi opens each pod again so its rows are read under the new tables, without
 * asking for an encrypted pod's six words a second time.
 */
describe("Reading the reference tables for their screens · api.held(), api.table(), api.checkTables()", () => {
  describe("api.held()", () => {
    it("returns the series the reference tables hold", async () => {
      assert.deepEqual(
        (await local().over.held({})).held.map(({ source }: Output) => source),
        ["urn:uuid:loinc"],
      );
    });

    it("returns none, with `failed: true`, when the reference tables cannot be read", async () => {
      const quiet = mock.method(console, "error", () => undefined);
      try {
        const broken = brokenApi();
        for (const each of [broken, crossing(broken)])
          assert.deepEqual(await each.held({}), { held: [], failed: true });
      } finally {
        quiet.mock.restore();
      }
    });
  });

  describe("api.table({ id, code })", () => {
    it("returns the first publisher's series when no `id` is given", async () => {
      assert.equal((await local().over.table({})).source.iri, "urn:uuid:loinc");
    });

    it("returns what the reference tables say of one code, in `facts`, when `code` is given", async () => {
      assert.equal(
        (await local().over.table({ id: "loinc", code: LDL })).facts.notation,
        LDL,
      );
    });
  });

  describe("api.checkTables()", () => {
    /** A plain pod and an unlocked encrypted pod, read, checked by a host whose check kept a version, and read again. */
    const checkedOnce = once(async () => {
      const { s, over } = local(
        { [STATIN]: {}, [SEALED]: { secret: SEALED_WORDS } },
        { checked: await FAKE.check() },
      );
      await over.unlock({ pod: SEALED, secret: SEALED_WORDS });
      await over.pod({ pod: STATIN });
      const { checked } = await over.checkTables({});
      await over.pod({ pod: STATIN });
      return {
        checked,
        opened: openings(s, STATIN).map((call) => call.args[0]),
        sealed: await over.pod({ pod: SEALED }),
      };
    });

    it("returns what the host's check did, in `checked`", async () => {
      assert.deepEqual((await checkedOnce()).checked, await FAKE.check());
    });

    it("opens a pod that is not encrypted again at its next read, when the check kept a version", async () => {
      assert.deepEqual((await checkedOnce()).opened, [STATIN, STATIN]);
    });

    it("keeps an unlocked encrypted pod open", async () => {
      assert.equal((await checkedOnce()).sealed.locked, undefined);
    });
  });
});

/**
 * `api.ask()` returns a named question's rows a slice at a time, or the pod's compact read a page at a time, and
 * `api.tool()` runs one of cascade-runtime's lab-change tools, or the app's own `worth_a_look`, on a pod. The tools
 * a model uses from the chat, a web page or an MCP client are built on these two.
 */
describe("Asking a pod a named question, and running a tool on it · api.ask(), api.tool()", () => {
  describe("api.ask({ pod, question, limit, offset })", () => {
    const rows = rowsOf(5);
    const asking = () => local({ p: { answers: { [LABS]: rows } } }).over;

    it("returns `limit` rows, and in `total` how many the question has", async () => {
      const out = await asking().ask({ pod: "p", question: LABS, limit: 2 });
      assert.equal(out.total, 5);
      assert.deepEqual(out.rows, rows.slice(0, 2));
    });

    it("returns the rows from `offset` on", async () => {
      const later = await asking().ask({
        pod: "p",
        question: LABS,
        limit: 2,
        offset: 1,
      });
      assert.deepEqual(later.rows, rows.slice(1, 3));
    });

    it("returns `offset` only when it is not 0", async () => {
      const over = asking();
      const later = await over.ask({
        pod: "p",
        question: LABS,
        limit: 2,
        offset: 1,
      });
      assert.equal(later.offset, 1);
      for (const given of [{}, { offset: 0 }]) {
        const first = await over.ask({
          pod: "p",
          question: LABS,
          limit: 2,
          ...given,
        });
        assert.equal(first.offset, undefined, JSON.stringify(given));
      }
    });
  });

  describe('api.ask({ pod, format: "compact" })', () => {
    it("returns a small pod's compact read whole, with no `next`", async () => {
      const small = await overHttp.ask({ pod: STATIN, format: "compact" });
      assert.equal(small.format, "compact");
      assert.equal(small.next, undefined);
      assert.ok(small.views.some(({ total }: Output) => total > 0));
    });

    it("refuses on a host that gives no `compact`", async () => {
      const { over } = local({ p: {} });
      await assert.rejects(
        over.ask({ pod: "p", format: "compact" }),
        /does not offer the compact read/,
      );
    });
  });

  describe('api.tool({ pod, tool: "find_changes" })', () => {
    it("returns the pod's lab changes in `value`, each with its medication's view entry", async () => {
      const { value } = await overHttp.tool({
        pod: STATIN,
        tool: "find_changes",
      });
      assert.ok(
        value.some(({ key }: Output) => key === `start:${ATORVASTATIN}:${LDL}`),
      );
      assert.ok(
        value.every(
          ({ medication }: Output) => typeof medication.entry === "string",
        ),
      );
    });
  });

  describe('api.tool({ pod, tool: "worth_a_look" })', () => {
    const lines = once(async () =>
      reviewing().tool({ pod: "reviewed", tool: "worth_a_look" }),
    );

    it("returns each Worth a look line's sentence and tag", async () => {
      const { value } = await lines();
      assert.equal(value.length, 1);
      assert.match(value[0].sentence, /Latex/);
      assert.equal(value[0].tag, "Needs review");
    });

    it("names each line's view entry by its short id, as `entryId()` gives it", async () => {
      assert.equal((await lines()).value[0].entry, entryId("urn:uuid:0e1f"));
    });

    it("calls a line's entry what the app's tile calls one of its rows, as `podApi`'s `sections` give them", async () => {
      const allergies = TILES.find(({ one }) => one === "allergy")!;
      const { value } = await reviewing({
        sections: [{ ...allergies, one: "reaction" }],
      }).tool({ pod: "reviewed", tool: "worth_a_look" });
      assert.equal(
        value[0].sentence,
        "Latex was marked as different, but is still shown as one reaction.",
      );
    });

    it("returns none for a pod with nothing worth a look", async () => {
      assert.deepEqual(
        (await overHttp.tool({ pod: STATIN, tool: "worth_a_look" })).value,
        [],
      );
    });
  });

  describe('given reference tables that say what Worth a look reads of them, api.tool({ pod, tool: "worth_a_look" })', () => {
    /** The statin story's pod with a second atorvastatin of another code, which the tables say share an ingredient. */
    const statins = once(async () => {
      const at = await mkdtemp(join(tmpdir(), "pod-api-statins-"));
      folders.push(at);
      const { pull } = await pulled(north, STATIN);
      const files = pullFiles(pull, "north");
      const bundle = JSON.parse(
        new TextDecoder().decode(files.get("north/bundle.json")),
      );
      const [first] = bundle.entry.filter(
        ({ resource }: Output) =>
          resource.resourceType === "MedicationRequest" &&
          resource.medicationCodeableConcept.coding[0].code === ATORVASTATIN,
      );
      const [coding] = first.resource.medicationCodeableConcept.coding;
      bundle.entry.push({
        ...first,
        fullUrl: first.fullUrl.replace("med-1", "med-3"),
        resource: {
          ...first.resource,
          id: "story-statin-med-3",
          medicationCodeableConcept: {
            coding: [
              {
                ...coding,
                code: SECOND_ATORVASTATIN,
                display: "atorvastatin 40 MG Oral Tablet",
              },
            ],
            text: "Atorvastatin 40 mg tablet",
          },
        },
      });
      const pod = await openPod(join(at, "two-atorvastatins"));
      const imported = await importClaimingEveryProfile(
        pod,
        new Map([
          ...files,
          [
            "north/bundle.json",
            new TextEncoder().encode(JSON.stringify(bundle)),
          ],
        ]),
      );
      assert.equal(imported.refused, undefined);
      await pod.close();
      await settled(at);
      const rxnorm = "https://ns.cascadeprotocol.org/codes/rxnorm/";
      const ingredient = `${rxnorm}83367`;
      const notation = (code: string) => code.slice(rxnorm.length);
      const about = (code: string): About | undefined =>
        code === ingredient
          ? {
              notation: notation(code),
              name: {
                label: "atorvastatin",
                altLabels: [],
                origin: "urn:test:names",
              },
            }
          : code.startsWith(rxnorm)
            ? {
                notation: notation(code),
                ingredients: {
                  codes: [ingredient],
                  origin: "urn:test:ingredients",
                },
              }
            : undefined;
      // What the tables say of these codes is written here, in the shape `Tables` gives; that the real tables say it stays
      // with the kit's case, on the packed runtime.
      const tables: Pick<Tables, "held" | "about"> = {
        held: async () => [],
        about: async (codes) =>
          new Map(
            codes.flatMap((code): [string, About][] => {
              const said = about(code);
              return said === undefined ? [] : [[code, said]];
            }),
          ),
      };
      const through = api({
        ...nodeHost({ folder: at }),
        tables: async () => tables,
      });
      return async () =>
        (await through.tool({ pod: "two-atorvastatins", tool: "worth_a_look" }))
          .value as Output[];
    });

    /** Martin's sample pod, opened over the ClinVar series, whose 2022 report of his MLH1 variant is of uncertain significance. */
    const martin = once(async () => {
      const at = await mkdtemp(join(tmpdir(), "pod-api-martin-"));
      folders.push(at);
      const { tables, parts } = await clinvarTables();
      await loadSample("martin-okafor", join(at, "martin-okafor"), { tables });
      const given = nodeHost({ folder: at });
      const through = api({
        ...given,
        tables: async () => tables,
        pods: {
          ...given.pods,
          open: (name: string) => openPodWith(parts, join(at, name)),
        },
      } as Host);
      return async () =>
        (await through.tool({ pod: "martin-okafor", tool: "worth_a_look" }))
          .value as Output[];
    });

    it("says two medications that share an ingredient, with the ingredient's name", async () => {
      const lines = await (await statins())();
      assert.ok(
        lines.some(({ sentence }) =>
          /share an ingredient, atorvastatin/.test(sentence),
        ),
        JSON.stringify(lines),
      );
    });

    it("says a report that differs from ClinVar today", async () => {
      const lines = await (await martin())();
      const differing = lines.filter(({ tag }) => tag === "Differs");
      assert.ok(differing.length > 0, JSON.stringify(lines));
      assert.match(
        differing[0]!.sentence,
        /2022 report.* differs from ClinVar today\.$/,
      );
    });
  });
});

/** Six words of an encrypted pod made through the wait: its words and the two typed back, as a page sends them. */
const typedBack = (words: string, pod: string) => {
  const [, word2, , , word5] = words.split(" ");
  return { pod, word2, word5, password: words, username: pod };
};

const madeOnce = once(async () => {
  const { over } = local({}, { samples: ["sample"] });
  const person = { person: "Rowan Ellery Marsh" };
  return {
    first: await over.makePod(person),
    again: await over.makePod(person),
    sample: await over.makePod({ person: "Sample" }),
    sampleAgain: await over.makePod({ person: "Sample" }),
    pods: (await over.pods({})).pods.map(({ name }: Output) => name),
  };
});

/** An encrypted pod made through the wait, read after the host was closed and opened again. */
const inesOnce = once(async () => {
  const { built, s, over } = local();
  const waiting = await over.makePod({ person: "Ines", encrypt: true });
  const listed = (await over.pods({})).pods.map(({ name }: Output) => name);
  const asked = await over.waitingWords({ pod: "ines" });
  const { words } = asked;
  const typed = typedBack(words, "ines");
  const wrong = await caught(over.confirmWords({ ...typed, word2: "x" }));
  const waitingAfterWrong = await over.waiting({ pod: "ines" });
  const confirmed = await over.confirmWords(typed);
  const encrypted = (await over.pod({ pod: "ines" })).encrypted;
  const afterwards = await caught(over.waitingWords({ pod: "ines" }));
  const waitingAfterMade = await caught(over.waiting({ pod: "ines" }));
  await built.close();
  const later = crossing(api(s.host as unknown as Host));
  const locked = await caught(later.answers({ pod: "ines" }));
  const unlocked = await later.unlock({ pod: "ines", secret: words });
  const opened = (await later.answers({ pod: "ines" })).answers;
  const again = await later.unlock({ pod: "ines", secret: words });
  const againEmpty = await later
    .unlock({ pod: "ines", secret: "" })
    .catch((error: unknown) => error);
  const againWrong = await later
    .unlock({ pod: "ines", secret: "not the words" })
    .catch((error: unknown) => error);
  return {
    againEmpty,
    againWrong,
    waiting,
    waitingAfterWrong,
    waitingAfterMade,
    wrong,
    listed,
    asked,
    confirmed,
    encrypted,
    afterwards,
    locked,
    unlocked,
    opened,
    again,
  };
});

/** Three pods, one of them waiting and one connected, deleted, then the host's own restored. */
const clearedOnce = once(async () => {
  const { over, s } = local(
    {},
    { restores: ["restored"], hospitals: northHospitals() },
  );
  for (const person of ["One", "Two"]) await over.makePod({ person });
  await over.makePod({ person: "Three", encrypt: true });
  const { connection } = await connected(over, "one");
  const one = { pod: "one", connection };
  const deleted = await over.deleteAll({});
  const removing = s.of("pods.remove").map(({ args }) => args);
  const left = (await over.pods({})).pods;
  const waiting = await caught(over.waitingWords({ pod: "three" }));
  await over.makePod({ person: "One" });
  const brought = await caught(over.bring(one));
  await over.deleteAll({});
  const restored = await over.resetAll({});
  return {
    deleted,
    removing,
    left,
    waiting,
    brought,
    restored,
    pods: (await over.pods({})).pods,
  };
});

const removedOnce = once(async () => {
  const at = await mkdtemp(join(tmpdir(), "pod-api-remove-"));
  for (const name of ["a", "b"]) {
    await mkdir(join(at, name), { recursive: true });
    await writeFile(join(at, name, "pod.ttl"), "");
  }
  await mkdir(join(at, ".answers", "no-pod"), { recursive: true });
  await mkdir(join(at, ".tables"), { recursive: true });
  await writeFile(join(at, ".tables", "marker"), "");
  await nodeHost({ folder: at }).pods.remove(["a", "b"], { all: true });
  const left = await readdir(at);
  const marker = existsSync(join(at, ".tables", "marker"));
  await gone(at);
  return { left, marker };
});

/**
 * A pod is made under a name made from a person's name. An encrypted pod is made only once the person has typed
 * back words 2 and 5 of its six words, which shows they kept them; until then the pod is waiting, and nothing is
 * written.
 */
describe("Making, unlocking, locking and deleting pods · api.makePod(), api.waiting(), api.waitingWords(), api.confirmWords(), api.unlock(), api.lock(), api.deleteAll(), api.resetAll(), nodeHost()", () => {
  describe("api.makePod({ person })", () => {
    it("makes a pod named from the person's name, and returns `made: true`", async () => {
      const { first, pods } = await madeOnce();
      assert.deepEqual(first, { pod: "rowan-ellery-marsh", made: true });
      assert.ok(pods.includes("rowan-ellery-marsh"));
    });

    it("returns `made: false`, and makes nothing, for a pod there already is", async () => {
      assert.deepEqual((await madeOnce()).again, {
        pod: "rowan-ellery-marsh",
        made: false,
      });
    });

    it("loads the host's sample of that name in place of an empty pod, and returns `loaded: true`", async () => {
      const { sample, sampleAgain, pods } = await madeOnce();
      assert.deepEqual(sample, { pod: "sample", loaded: true });
      assert.deepEqual(sampleAgain, { pod: "sample", made: false });
      assert.deepEqual(pods, ["rowan-ellery-marsh", "sample"]);
    });

    it("refuses `encrypt: true` for a sample's name with a sentence that says samples are not encrypted, and loads nothing", async () => {
      const { over, s } = local({}, { samples: ["sample"] });
      await assert.rejects(
        over.makePod({ person: "Sample", encrypt: true }),
        (error: Error) =>
          error.name === "Refusal" &&
          /sample/i.test(error.message) &&
          /encrypt/i.test(error.message),
      );
      assert.deepEqual(
        (await over.pods({})).pods.map(({ name }: Output) => name),
        [],
      );
      assert.equal(s.of("copySample").length, 0);
    });

    it("refuses `encrypt: true` for a sample that is already loaded, and leaves the pod as it was", async () => {
      const { over } = local({}, { samples: ["sample"] });
      await over.makePod({ person: "Sample" });
      await assert.rejects(
        over.makePod({ person: "Sample", encrypt: true }),
        (error: Error) =>
          error.name === "Refusal" &&
          /sample/i.test(error.message) &&
          /encrypt/i.test(error.message),
      );
      assert.equal((await over.pod({ pod: "sample" })).encrypted, false);
    });

    it("refuses `encrypt: true` for a pod that exists unencrypted, with a sentence that says so", async () => {
      const { over } = local();
      await over.makePod({ person: "Plain" });
      await assert.rejects(
        over.makePod({ person: "Plain", encrypt: true }),
        (error: Error) =>
          error.name === "Refusal" &&
          /exists already/.test(error.message) &&
          /not encrypted/.test(error.message),
      );
    });

    it("copies a sample once when two calls ask for it at the same moment", async () => {
      const { built, s } = local({}, { samples: ["sample"] });
      await Promise.all([
        built.makePod({ person: "Sample" }),
        built.makePod({ person: "Sample" }),
      ]);
      assert.equal(s.of("copySample").length, 1);
    });
  });

  describe("api.makePod({ person, encrypt: true })", () => {
    it("returns `waiting: true`, and makes no pod yet", async () => {
      const { waiting, listed } = await inesOnce();
      assert.deepEqual(waiting, { pod: "ines", waiting: true });
      assert.equal(listed.includes("ines"), false);
    });
  });

  describe("api.waitingWords({ pod })", () => {
    it("returns the six words of a pod that is waiting, with the person's name as typed", async () => {
      const { asked } = await inesOnce();
      assert.equal(asked.person, "Ines");
      assert.equal(asked.words.split(" ").length, 6);
    });

    it("refuses once the pod is made", async () => {
      assert.match((await inesOnce()).afterwards.message, /not waiting/);
    });

    it("refuses a second call for the same pod, saying the words are shown once and not saying them, and the pod stops waiting", async () => {
      const { over } = local();
      await over.makePod({ person: "Once", encrypt: true });
      const first = await over.waitingWords({ pod: "once" });
      assert.equal(first.words.split(" ").length, 6);
      const second = await caught(over.waitingWords({ pod: "once" }));
      assert.equal(second.name, "Refusal");
      assert.match(second.message, /shown once/);
      assert.ok(!second.message.includes(first.words.split(" ")[0]));
      await assert.rejects(over.waiting({ pod: "once" }), /not waiting/);
    });

    it("gives new words when the pod is made again after that", async () => {
      const { over } = local();
      await over.makePod({ person: "Once", encrypt: true });
      const first = await over.waitingWords({ pod: "once" });
      await caught(over.waitingWords({ pod: "once" }));
      await over.makePod({ person: "Once", encrypt: true });
      const next = await over.waitingWords({ pod: "once" });
      assert.notEqual(next.words, first.words);
    });
  });

  describe("api.waiting({ pod })", () => {
    it("says a pod is waiting, with the person's name as typed and without its words, however often it is asked", async () => {
      const { over } = local();
      await over.makePod({ person: "Peek", encrypt: true });
      const asked = [
        await over.waiting({ pod: "peek" }),
        await over.waiting({ pod: "peek" }),
      ];
      assert.deepEqual(asked, [
        { pod: "peek", person: "Peek" },
        { pod: "peek", person: "Peek" },
      ]);
      assert.equal((await over.waitingWords({ pod: "peek" })).person, "Peek");
    });

    it("still says a pod is waiting after words 2 and 5 were typed back wrong, and refuses once the pod is made", async () => {
      const { wrong, waitingAfterWrong, waitingAfterMade } = await inesOnce();
      assert.match(wrong.message, /aren't words 2 and 5/);
      assert.deepEqual(waitingAfterWrong, { pod: "ines", person: "Ines" });
      assert.match(waitingAfterMade.message, /not waiting/);
    });
  });

  describe("api.confirmWords({ pod, word2, word5, password, username })", () => {
    it("makes the encrypted pod when words 2 and 5 are typed back", async () => {
      const { confirmed, encrypted } = await inesOnce();
      assert.deepEqual(confirmed, { pod: "ines", made: true });
      assert.equal(encrypted, true);
    });

    it("refuses when a pod of that name was made in the meantime, and stops waiting", async () => {
      const { over } = local();
      await over.makePod({ person: "Taken", encrypt: true });
      const { words } = await over.waitingWords({ pod: "taken" });
      await over.makePod({ person: "Taken" });
      await assert.rejects(
        over.confirmWords(typedBack(words, "taken")),
        /exists already/,
      );
      await assert.rejects(over.waitingWords({ pod: "taken" }), /not waiting/);
    });
  });

  describe("api.unlock({ pod, secret })", () => {
    it("opens an encrypted pod with its six words, and returns `opened: true`", async () => {
      const { locked, unlocked, opened } = await inesOnce();
      assert.equal(locked.outcome, "secret needed");
      assert.deepEqual(unlocked, { pod: "ines", opened: true });
      assert.ok(opened);
    });

    it("returns `opened: true` for an encrypted pod that is already open, given its own six words", async () => {
      assert.deepEqual((await inesOnce()).again, { pod: "ines", opened: true });
    });

    it("throws `Unopened` with `incorrect secret` for an encrypted pod that is already open, given other words", async () => {
      const { againWrong } = await inesOnce();
      assert.ok(unopened(againWrong, "incorrect secret"), String(againWrong));
    });

    it("throws `Unopened` with `incorrect secret` for an encrypted pod that is already open, given no words", async () => {
      const { againEmpty } = await inesOnce();
      assert.ok(unopened(againEmpty, "incorrect secret"), String(againEmpty));
    });

    it("answers each of two calls at the same moment by its own secret: the right words open the pod, other words throw `Unopened`", async () => {
      // In the process: `crossing()` pairs each call with the one answer it made, so it takes no two at the same moment.
      const { s, built: each } = local({ [SEALED]: { secret: SEALED_WORDS } });
      const holding = s.holding();
      const calls = Promise.allSettled([
        each.unlock({ pod: SEALED, secret: SEALED_WORDS }),
        each.unlock({ pod: SEALED, secret: "not the words at all" }),
      ]);
      await holding.started(2);
      holding.release();
      const [right, wrong] = await calls;
      assert.deepEqual(
        right.status === "fulfilled" && right.value,
        { pod: SEALED, opened: true },
        String(right.status === "rejected" && right.reason),
      );
      assert.ok(
        wrong.status === "rejected" &&
          unopened(wrong.reason, "incorrect secret"),
        wrong.status === "fulfilled" ? "opened with the wrong words" : "",
      );
      assert.equal((await each.pod({ pod: SEALED })).locked, undefined);
    });

    it("keeps one opening and closes the other of two calls at the same moment with the right words", async () => {
      const { s, built: each } = local({ [SEALED]: { secret: SEALED_WORDS } });
      const holding = s.holding();
      const calls = Promise.all([
        each.unlock({ pod: SEALED, secret: SEALED_WORDS }),
        each.unlock({ pod: SEALED, secret: SEALED_WORDS }),
      ]);
      await holding.started(2);
      holding.release();
      assert.deepEqual(await calls, [
        { pod: SEALED, opened: true },
        { pod: SEALED, opened: true },
      ]);
      const opens = openings(s).filter(
        ({ args }) =>
          (args[1] as { secret?: string } | undefined)?.secret !== undefined,
      ).length;
      const closes = s.of("pod.close").length;
      assert.equal(opens - closes, 1, `${opens} openings, ${closes} closed`);
    });

    it("opens no pod to check the words of an encrypted pod that is already open", async () => {
      const { s, over: each } = local({ [SEALED]: { secret: SEALED_WORDS } });
      await each.unlock({ pod: SEALED, secret: SEALED_WORDS });
      const calls = openings(s).length;
      assert.deepEqual(
        await each.unlock({ pod: SEALED, secret: SEALED_WORDS }),
        { pod: SEALED, opened: true },
      );
      await assert.rejects(
        each.unlock({ pod: SEALED, secret: "not the words at all" }),
        (error) => unopened(error, "incorrect secret"),
      );
      assert.equal(openings(s).length, calls);
    });

    it("returns `opened: true` for a pod that is open and not encrypted, whatever `secret` holds", async () => {
      const { over } = local({ [STATIN]: {} });
      assert.deepEqual(
        await over.unlock({ pod: STATIN, secret: "any words" }),
        {
          pod: STATIN,
          opened: true,
        },
      );
    });

    it("throws `Unopened` with `incorrect secret` when `secret` holds no word", async () => {
      const { over } = local({ [SEALED]: { secret: SEALED_WORDS } });
      await assert.rejects(
        over.unlock({ pod: SEALED, secret: "  " }),
        (error) => unopened(error, "incorrect secret"),
      );
    });

    it("answers what nodeHost answers over the same pods, a plain one and an encrypted one", async () => {
      const outcome = async (
        pods: ReturnType<typeof nodeHost>["pods"],
        through: Api,
      ) => {
        const refused = (call: Promise<unknown>) =>
          call.then(
            () => "opened",
            (error: Error & { outcome?: string }) => error.outcome,
          );
        return {
          names: await pods.names(),
          titles: [await pods.title(STATIN), await pods.title(SEALED)],
          screens: [
            await through.pod({ pod: STATIN }),
            await through.pod({ pod: SEALED }),
          ],
          withoutWords: await refused(pods.open(SEALED)),
          withOtherWords: await refused(
            pods.open(SEALED, { secret: "not the words at all" }),
          ),
          rightWords: await pods.checkSecret(SEALED, SEALED_WORDS),
          otherWords: await pods.checkSecret(SEALED, "not the words at all"),
        };
      };
      const { s, built: standing } = local({
        [STATIN]: { title: "Story Statin" },
        [SEALED]: { secret: SEALED_WORDS },
      });
      assert.deepEqual(
        await outcome(s.host.pods as never, standing),
        await outcome(nodeHost({ folder }).pods, inProcess),
      );
    });
  });

  describe("given an encrypted pod that is not open", () => {
    it('returns `locked: "secret needed"` from `api.pod()`', async () => {
      const { over } = local({ [SEALED]: { secret: SEALED_WORDS } });
      assert.equal((await over.pod({ pod: SEALED })).locked, "secret needed");
    });

    it("throws `Unopened` with `secret needed` from `api.answers()`", async () => {
      const { over } = local({ [SEALED]: { secret: SEALED_WORDS } });
      await assert.rejects(over.answers({ pod: SEALED }), (error) =>
        unopened(error, "secret needed"),
      );
    });

    it("refuses with a sentence that says where to open it, on a host that opens no encrypted pod", async () => {
      const { over: elsewhere } = local(
        { [SEALED]: { secret: SEALED_WORDS } },
        { opensEncrypted: false },
      );
      assert.equal(
        (await elsewhere.pod({ pod: SEALED })).locked,
        "secret needed",
      );
      await assert.rejects(
        elsewhere.answers({ pod: SEALED }),
        (error) =>
          isRefusal(error) &&
          error.outcome === undefined &&
          error.message === notOpenedHere(SEALED),
      );
    });
  });

  describe("api.lock()", () => {
    /** An instance whose stand-in host counts each pod it opens and closes, and a pod of each kind made through it. */
    async function sealedAndPlain(options?: Clocked) {
      const { s, over } = local({}, {}, options);
      await over.makePod({ person: "Lock Me", encrypt: true });
      const { words } = await over.waitingWords({ pod: "lock-me" });
      await over.confirmWords(typedBack(words, "lock-me"));
      await over.makePod({ person: "Plain" });
      return { over, s, words };
    }

    it("closes the encrypted pods this instance holds open and names them, so the pod asks for its words again", async () => {
      const { over, s, words } = await sealedAndPlain();
      assert.ok((await over.answers({ pod: "lock-me" })).answers);
      assert.deepEqual(await over.lock({}), { locked: ["lock-me"] });
      assert.equal(s.of("pod.close").length, 1);
      await assert.rejects(over.answers({ pod: "lock-me" }), (error) =>
        unopened(error, "secret needed"),
      );
      assert.equal(
        (await over.pod({ pod: "lock-me" })).locked,
        "secret needed",
      );
      await over.unlock({ pod: "lock-me", secret: words });
      assert.ok((await over.answers({ pod: "lock-me" })).answers);
    });

    it("leaves a pod that is not encrypted open", async () => {
      const { over, s } = await sealedAndPlain();
      const opens = openings(s, "plain").length;
      await over.lock({});
      assert.ok((await over.answers({ pod: "plain" })).answers);
      assert.equal(
        openings(s, "plain").length,
        opens,
        "the plain pod was not opened again",
      );
    });

    it("closes nothing, and names nothing, when no encrypted pod is open", async () => {
      const { over, s } = await sealedAndPlain();
      await over.lock({});
      assert.deepEqual(await over.lock({}), { locked: [] });
      assert.equal(s.of("pod.close").length, 1);
    });

    it("forgets the six words of a pod that is still waiting for them to be typed back", async () => {
      const { over } = await sealedAndPlain();
      await over.makePod({ person: "Not Yet", encrypt: true });
      await over.lock({});
      await assert.rejects(over.waiting({ pod: "not-yet" }), /not waiting/);
    });
  });

  describe("when no request comes for the idle time, `IDLE_LOCK_MS`, 15 minutes", () => {
    const FIFTEEN_MINUTES = 15 * 60 * 1000;

    it("is 15 minutes", () => assert.equal(IDLE_LOCK_MS, FIFTEEN_MINUTES));

    /** The instance of `api.lock()`'s tests, read by a clock the test moves. */
    async function clocked(hospitals?: object) {
      let now = 1_000_000;
      const { s, built, over } = local(
        {},
        hospitals === undefined
          ? {}
          : { hospitals: hospitals as StandInOptions["hospitals"] },
        { clock: () => now },
      );
      await over.makePod({ person: "Idle", encrypt: true });
      const { words } = await over.waitingWords({ pod: "idle" });
      await over.confirmWords(typedBack(words, "idle"));
      return {
        over,
        built,
        s,
        words,
        pass: (ms: number) => void (now += ms),
      };
    }

    it("keeps an encrypted pod open while each request comes within the time of the one before", async () => {
      const { over, s, pass } = await clocked();
      pass(IDLE_LOCK_MS - 1);
      assert.ok((await over.answers({ pod: "idle" })).answers);
      pass(IDLE_LOCK_MS - 1);
      assert.ok((await over.answers({ pod: "idle" })).answers);
      assert.equal(s.of("pod.close").length, 0);
    });

    it("closes the pod when a request comes after the time, before it answers, so the pod asks for its words again", async () => {
      const { over, s, pass, words } = await clocked();
      pass(IDLE_LOCK_MS);
      await assert.rejects(over.answers({ pod: "idle" }), (error) =>
        unopened(error, "secret needed"),
      );
      assert.equal(s.of("pod.close").length, 1);
      await over.unlock({ pod: "idle", secret: words });
      assert.ok((await over.answers({ pod: "idle" })).answers);
    });

    it("closes the pod, and stops its sign-in, though the page asks after its connection every WAIT_MS, as that is no request of the person", async () => {
      const signals: AbortSignal[] = [];
      const { built, s, pass } = await clocked(parkedHospitals(signals));
      const { connection } = await built.connect({
        pod: "idle",
        fhirBase: FHIR_BASE(),
      });
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        let ended = false;
        for (let minute = 0; minute < 16 && !ended; minute += 1) {
          pass(60_000);
          let over = false;
          const asked = built
            .connection({ pod: "idle", connection, wait: true })
            .then(
              (shown) => shown.settled,
              () => true,
            )
            .finally(() => (over = true));
          while (!over) {
            mock.timers.tick(WAIT_MS);
            await new Promise((done) => setImmediate(done));
          }
          ended = await asked;
        }
        assert.ok(ended, "the connection ended within 16 minutes");
      } finally {
        mock.timers.reset();
      }
      assert.equal(s.of("pod.close").length, 1);
      assert.equal(signals[0]!.aborted, true);
    });

    it("closes the pod by itself, with no request, when the time has passed at one of its checks", async () => {
      mock.timers.enable({ apis: ["setInterval"] });
      try {
        const { s, pass } = await clocked();
        pass(IDLE_LOCK_MS);
        mock.timers.tick(IDLE_CHECK_MS);
        for (
          let waited = 0;
          s.of("pod.close").length === 0 && waited < 100;
          waited += 1
        )
          await new Promise((done) => setImmediate(done));
        assert.equal(s.of("pod.close").length, 1);
      } finally {
        mock.timers.reset();
      }
    });
  });

  describe("api.deleteAll()", () => {
    it("removes every pod, and returns their names in `deleted`", async () => {
      const { deleted, removing, left } = await clearedOnce();
      assert.deepEqual(deleted, { deleted: ["one", "two"] });
      assert.deepEqual(removing, [[["one", "two"], { all: true }]]);
      assert.deepEqual(left, []);
    });

    it("forgets the six words of a pod that was waiting", async () => {
      assert.match((await clearedOnce()).waiting.message, /not waiting/);
    });

    it("forgets every connection", async () => {
      assert.match((await clearedOnce()).brought.message, /no connection/);
    });
  });

  describe("api.resetAll()", () => {
    it("deletes every pod, then returns the pods the host puts back", async () => {
      const { restored, pods } = await clearedOnce();
      assert.deepEqual(restored, { pods: ["restored"] });
      assert.deepEqual(pods, [{ name: "restored", title: "restored" }]);
    });
  });

  describe("when the pods of `nodeHost({ folder })` are removed with `{ all: true }`", () => {
    it("removes the pods' folders and every kept answer", async () => {
      assert.deepEqual((await removedOnce()).left, [".tables"]);
    });

    it("keeps the folder of the reference tables", async () => {
      assert.equal((await removedOnce()).marker, true);
    });
  });
});

const state = ({ step, requests, bringing }: Output) =>
  JSON.stringify([step, requests, bringing]);
const keys = (value: unknown): string[] =>
  value !== null && typeof value === "object"
    ? Object.entries(value).flatMap(([key, each]) => [key, ...keys(each)])
    : [];

/** A connection of Ada's pod, as a page watches it until it has pulled. */
const pulledOnce = once(async () => {
  const authorized: URL[] = [];
  const { built: local_ } = local(
    {},
    { hospitals: northHospitals(authorized) },
  );
  await local_.makePod({ person: "Ada" });
  const { connection: n, authorize } = await local_.connect({
    pod: "ada",
    fhirBase: FHIR_BASE(),
  });
  const connection = { pod: "ada", connection: n };
  let shown = await local_.connection(connection);
  const states = [state(shown)];
  const held = [0];
  while (!shown.settled) {
    const asked = performance.now();
    shown = await local_.connection({ ...connection, wait: "change" });
    held.push(performance.now() - asked);
    states.push(state(shown));
  }
  return { n, authorize, authorized: authorized[0]!, states, held, shown };
});

/** North, with the answer to `/metadata` changed to `answer`, and Ada's pod connected: what the pod was asked to write. */
async function signedInUnder(answer: () => Response) {
  const north_ = northHospitals();
  const watching = {
    ...north_,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      return answer !== undefined &&
        new URL(request.url).pathname.endsWith("/metadata")
        ? answer()
        : north_.fetch(request);
    }) as typeof globalThis.fetch,
  };
  const { s, built: local_ } = local({}, { hospitals: watching });
  await local_.makePod({ person: "Ada" });
  const { shown } = await connected(local_, "ada");
  return { shown, wrote: s.of("pod.connect").length };
}
const silentOnce = once(() =>
  signedInUnder(() => new Response("{}", { status: 404 })),
);
const oddOnce = once(() =>
  signedInUnder(() => Response.json({ resourceType: "Basic" })),
);

/** Hospitals whose sign-in waits for the person, so a connection stays `signing in` until it is stopped; `signals` gets each sign-in's stop. */
const parkedHospitals = (signals: AbortSignal[]) => ({
  ...northHospitals(),
  signIn:
    (_: unknown, __: unknown, report: (href: string) => void) =>
    (authorize: URL, given?: AbortSignal) =>
      new Promise<URL>((_, reject) => {
        const signal = given!;
        signals.push(signal);
        report(authorize.href);
        signal.addEventListener(
          "abort",
          () => reject(new ConnectionFailure("cancelled", "stopped")),
          { once: true },
        );
      }),
});

/** A sign-in that waits for the person, so a connection stays `signing in`, and what stops it. */
const parkedOnce = once(async () => {
  const signals: AbortSignal[] = [];
  const { built: local_ } = local({}, { hospitals: parkedHospitals(signals) });
  const start = async () => {
    await local_.makePod({ person: "Ada" });
    return (await local_.connect({ pod: "ada", fhirBase: FHIR_BASE() }))
      .connection;
  };
  const first = await start();
  mock.timers.enable({ apis: ["setTimeout"] });
  let held: Output | undefined;
  void local_
    .connection({ pod: "ada", connection: first, wait: true })
    .then((shown) => (held = shown));
  while (held === undefined) {
    mock.timers.tick(WAIT_MS);
    await new Promise((done) => setImmediate(done));
  }
  mock.timers.reset();
  await local_.deleteAll({});
  const deleted = signals[0]!.aborted;
  await start();
  await local_.close();
  return { held, deleted, closed: signals[1]!.aborted };
});

/** What a pod's import answers, as the real one's answers are told to the app. */
interface Imports {
  /** The profiles the pull names, which the app's `claimProfiles` is given when it has one. */
  named?: string[];
  wrote?: boolean;
  claimed?: string[];
  unclaimed?: string[];
  refused?: string;
  /** The import throws after it has told the part it is at. */
  throws?: Error;
}
/** A pod's `import`: each call answers the next of `script`, the last one again after that. */
function importing(...script: Imports[]) {
  let at = 0;
  return async (
    _files: unknown,
    options: {
      claimProfiles?: (named: string[]) => unknown;
      onProgress?: (part: object) => unknown;
    },
  ) => {
    const step = script[Math.min(at++, script.length - 1)]!;
    options.claimProfiles?.(step.named ?? []);
    for (const part of ["loading the adapter", "converting", "saving"])
      await options.onProgress?.({ part });
    const claims = (step.claimed ?? []).length;
    if (options.claimProfiles !== undefined)
      await options.onProgress?.({ part: "judging", done: 0, of: claims });
    if (step.throws !== undefined) throw step.throws;
    return {
      wrote: step.wrote === true ? ["urn:test:file"] : [],
      activity: "urn:test:import",
      claimedProfiles: (step.claimed ?? []).map((profile) => ({ profile })),
      unclaimedProfiles: step.unclaimed ?? [],
      ...(step.refused !== undefined && { refused: step.refused }),
    };
  };
}
const PROFILE = "urn:uuid:profile-of-the-pull";
/** The profile a judgment's Turtle is about. */
const profileOf = (turtle: string) =>
  /prov:hadMember <([^>]+)>/.exec(turtle)![1]!;
/** A row of `profile/What needs review`, as the pod shows a profile no one has answered. */
const unanswered = (profile: string, extra: Output = {}): Output => ({
  profile,
  profileLabel: "Ines Calloway",
  hospital: "Cascade North",
  records: 12,
  ...extra,
});

/**
 * A pod, in a stand-in host, brought the record of another person: `imports` is what its import answers, `rows` the
 * profiles it shows for review, and the profiles the app judged leave them. After a failed bring that can be tried
 * again it is, on the same app or, with `restarts`, on one opened again over the same host.
 */
async function brought({
  title,
  imports,
  rows = [],
  restarts = false,
  disclaims,
}: {
  title?: string;
  imports: Imports[];
  rows?: Output[];
  restarts?: boolean;
  /** The profiles the owner says are not them once the first import has failed. */
  disclaims?: string[];
}) {
  const pod = "rowan-ellery-marsh";
  const judged: string[] = [];
  const notAbout = new Set<string>();
  const [first, ...rest] = imports;
  const { s } = local(
    {
      [pod]: {
        ...(title !== undefined && { title }),
        answers: {
          [REVIEW]: () =>
            rows
              .filter((row) => !judged.includes(row.profile))
              .map((row) =>
                notAbout.has(row.profile)
                  ? { ...row, saidNotAbout: true }
                  : row,
              ),
        },
        import: importing(
          ...(first === undefined || disclaims === undefined
            ? imports
            : [
                {
                  ...first,
                  throws: new Error("the owner said no meanwhile"),
                },
                ...rest,
              ]),
        ),
        judge: (turtle: string) => {
          judged.push(profileOf(turtle));
        },
      },
    },
    { hospitals: northHospitals() },
  );
  const logged = mock.method(console, "error", () => undefined);
  try {
    let each = api(s.host as unknown as Host);
    let { connection } = await connectedAndPulled(each, pod);
    let target = { pod, connection };
    await each.bring(target);
    const firstShown = await each.connection({ ...target, wait: true });
    if (disclaims !== undefined)
      for (const profile of disclaims) notAbout.add(profile);
    if (firstShown.retry) {
      if (restarts) {
        await each.close();
        each = api(s.host as unknown as Host);
        ({ connection } = await connectedAndPulled(each, pod));
        target = { pod, connection };
      }
      await each.bring(target);
    }
    const shown = await each.connection({ ...target, wait: true });
    const waiting = (await each.answers({ pod })).waiting;
    await each.close();
    const again = api(s.host as unknown as Host);
    return {
      failedFirst: firstShown.failed as string | undefined,
      shown,
      waiting,
      judged,
      retitled: s.of("pod.retitle").map(({ args }) => args[0]),
      matches: s.of("pod.match").length,
      title: (await again.pods({})).pods.find(
        ({ name }: Output) => name === pod,
      ).title as string,
    };
  } finally {
    logged.mock.restore();
  }
}
const FIRST_TRY = { named: [PROFILE], wrote: true, claimed: [PROFILE] };
/** The import claims fail, after the pull is filed: the first call throws; a retry files nothing and names what no one answered. */
const CLAIM_FAILS: Imports[] = [
  { ...FIRST_TRY, throws: new Error("no room to write the About") },
  { unclaimed: [PROFILE] },
];
const namedAfterBringIn = once(async () => ({
  untitled: await brought({ imports: [FIRST_TRY] }),
  titled: await brought({ title: "Ada", imports: [FIRST_TRY] }),
  refused: await brought({
    imports: [{ ...FIRST_TRY, refused: "not a record" }],
  }),
  disclaimed: await brought({
    imports: [{ named: [PROFILE], wrote: true }],
  }),
  retried: await brought({
    imports: CLAIM_FAILS,
    rows: [unanswered(PROFILE)],
  }),
  retriedBesideAnotherPull: await brought({
    imports: CLAIM_FAILS,
    rows: [unanswered(PROFILE), unanswered("urn:uuid:profile-of-another-pull")],
  }),
  disclaimedBeforeTheRetry: await brought({
    imports: [CLAIM_FAILS[0]!, { unclaimed: [] }],
    rows: [unanswered(PROFILE)],
    disclaims: [PROFILE],
  }),
  retriedBesideAnAnsweredProfile: await brought({
    imports: [
      {
        ...FIRST_TRY,
        named: [PROFILE, "urn:uuid:answered-before-this-pull"],
        throws: new Error("no room to write the About"),
      },
      { unclaimed: [PROFILE] },
    ],
    rows: [unanswered(PROFILE)],
  }),
  aboutRefused: await brought({
    imports: [
      { named: [PROFILE], wrote: true, unclaimed: [PROFILE] },
      { unclaimed: [PROFILE] },
    ],
    rows: [unanswered(PROFILE)],
  }),
  retriedAfterARestart: await brought({
    imports: [CLAIM_FAILS[0]!, { named: [PROFILE] }],
    rows: [unanswered(PROFILE)],
    restarts: true,
  }),
}));

/**
 * A pod with no name on file brought a record whose Patient is named only in `text`, which gives no name to title it
 * by: whether `retitle` was asked, what was logged, and whether the record was brought in.
 */
const unnamedPatientOnce = (given: unknown) =>
  once(async () => {
    const logged = mock.method(console, "error", () => undefined);
    try {
      const nameless = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(nameless)
          : typeof value === "object" && value !== null
            ? Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(
                  ([key, each]) => [
                    key,
                    key === "name" &&
                    (value as { resourceType?: string }).resourceType ===
                      "Patient"
                      ? given
                      : nameless(each),
                  ],
                ),
              )
            : value;
      const alter: Alter = async (request, hospital) => {
        const response = await hospital(request);
        if (!response.headers.get("Content-Type")?.includes("json"))
          return response;
        const body = nameless(await response.clone().json());
        return new Response(JSON.stringify(body), response);
      };
      const pod = "rowan-ellery-marsh";
      const { s, built: local_ } = local(
        { [pod]: { import: importing(FIRST_TRY) } },
        { hospitals: northHospitals([], alter) },
      );
      const { connection } = await connected(local_, pod);
      const at = { pod, connection };
      await local_.bring(at);
      const shown = await local_.connection({ ...at, wait: true });
      return {
        retitled: s.of("pod.retitle").length,
        logged: logged.mock.callCount(),
        broughtIn: shown.broughtIn,
        patient: shown.patient,
      };
    } finally {
      logged.mock.restore();
    }
  });

const textOnlyName = unnamedPatientOnce([{ text: "Rowan Marsh" }]);
const blankGivenName = unnamedPatientOnce([{ given: [" "] }]);

/** A bring-in whose import throws an error of the app's own, and what was logged. */
const failedOnce = once(async () => {
  const logged = mock.method(console, "error", () => undefined);
  try {
    const { built: local_ } = local(
      {
        ada: {
          import: async () => {
            throw new Error("the pod at C:\\secret\\ada is closed");
          },
        },
      },
      { hospitals: northHospitals() },
    );
    const at = { pod: "ada", connection: 0 };
    at.connection = (await connected(local_, "ada")).connection;
    await local_.bring(at);
    const failed = await local_.connection({ ...at, wait: true });
    return { failed, logged: logged.mock.callCount() };
  } finally {
    logged.mock.restore();
  }
});

/**
 * Bring-ins over a pod whose `import` and `match` are recorded: a pod's first bring, which files the pull and claims its
 * profile; a second connection's bring of the same pull, which files nothing and claims nothing; and, on another app, a
 * bring whose `match` fails once and is then tried again.
 */
const matchesOnce = once(async () => {
  const bringing = async (over: Api, n: number) => {
    const at = { pod: "ada", connection: n };
    await over.bring(at);
    return over.connection({ ...at, wait: true });
  };
  const { s, built: first } = local(
    {
      ada: {
        import: importing(FIRST_TRY, { named: [], wrote: false }),
        look: () => [{ server: FHIR_BASE() }],
      },
    },
    { hospitals: northHospitals() },
  );
  const one = (await connected(first, "ada")).connection;
  const firstShown = await bringing(first, one);
  const matchesAfterFirst = s.of("pod.match");
  const askedAfterFirst = s.of("pod.ask").map(({ args }) => args[0]);
  const secondShown = await bringing(
    first,
    (await connected(first, "ada")).connection,
  );
  const again = await first.bring({ pod: "ada", connection: one });
  const after = await first.connection({ pod: "ada", connection: one });
  let failing = true;
  const { s: failed, built: second } = local(
    {
      ada: {
        import: importing(FIRST_TRY, { wrote: false }),
        match: () => {
          if (!failing) return;
          failing = false;
          throw new Error("the matcher stopped");
        },
      },
    },
    { hospitals: northHospitals() },
  );
  const logged = mock.method(console, "error", () => undefined);
  try {
    const { connection } = await connected(second, "ada");
    return {
      imports: s.of("pod.import").length,
      matches: s.of("pod.match"),
      matchesAfterFirst,
      askedAfterFirst,
      firstShown,
      secondShown,
      again,
      after,
      failed: await bringing(second, connection),
      retried: await bringing(second, connection),
      failedMatches: failed.of("pod.match"),
    };
  } finally {
    logged.mock.restore();
  }
});

/**
 * A connection is one sign-in at one hospital and the pull that follows: `api.connection()` says how far it has
 * got and can wait for it to change, and `api.bring()` imports what was pulled into the pod. What goes wrong at the
 * hospital is said on the connection, and an error of the app's own is logged and said in one fixed sentence.
 *
 * @rule runtime/arrivals.feature A16
 */
describe("Connecting a pod to a hospital and bringing its records in · api.hospitals(), api.connect(), api.connection(), api.bring()", () => {
  describe("api.hospitals({ q })", () => {
    it("returns the hospitals of the host's directory whose name matches `q`", async () => {
      const { rows } = await local(
        {},
        { hospitals: northHospitals() },
      ).over.hospitals({ q: "north" });
      assert.deepEqual(
        rows.map(({ name }: Output) => name),
        [rowOf(north).name],
      );
    });
  });

  describe("api.connect({ pod, fhirBase })", () => {
    it("returns the connection's number, and in `authorize` where the person signs in", async () => {
      const { n, authorize, authorized } = await pulledOnce();
      assert.ok(Number.isInteger(n) && n > 0);
      assert.equal(authorize, authorized.href);
    });

    it("asks the hospital for the scopes `launch/patient`, `patient/*.read` and `patient/*.rs`", async () => {
      assert.deepEqual(
        (await pulledOnce()).authorized.searchParams.get("scope")!.split(" "),
        ["launch/patient", "patient/*.read", "patient/*.rs"],
      );
    });

    it("writes the hospital server's record to the pod before the first request for the patient", () => {
      assert.ok(statin.atFirstRecord.length > 0);
      assert.ok(statin.listing.length > 0);
      assert.deepEqual(statin.atFirstRecord[0], statin.listing);
    });

    it("writes into that record the client id the host registered", async () => {
      const CONNECT_ROWS = `PREFIX cascade: <https://ns.cascadeprotocol.org/cascade#>
SELECT ?act (COUNT(DISTINCT ?version) AS ?versions) (SAMPLE(?client) AS ?client) WHERE {
  { SELECT (COUNT(*) AS ?act) WHERE { ?a a cascade:ConnectToServer } }
  ?version cascade:connectClientId ?client .
} GROUP BY ?act`;
      const [row] = await statinPod.ask({ query: CONNECT_ROWS });
      assert.deepEqual(
        [row?.act, row?.versions, row?.client],
        ["1", "1", "cascade-app"],
      );
    });

    it("writes no file at a second sign-in when the server says the same of itself", async () => {
      const before_ = await filesOf();
      const second = await connectedAndPulled(inProcess, STATIN);
      assert.deepEqual(await filesOf(), before_);
      assert.equal(second.shown.notRecorded, undefined);
      assert.equal(statin.shown.notRecorded, undefined);
    });

    it("says in `notRecorded` that a server answered 404 to `metadata`, and pulls all the same", async () => {
      const { shown, wrote } = await silentOnce();
      assert.equal(shown.step, "pulled");
      assert.match(shown.notRecorded, /answered 404 to metadata/);
      assert.equal(wrote, 0);
    });

    it("says in `notRecorded` that a server's report was refused as no CapabilityStatement, and pulls all the same", async () => {
      const { shown } = await oddOnce();
      assert.equal(shown.step, "pulled");
      assert.match(shown.notRecorded, /^Refused: .*CapabilityStatement/);
    });

    it("writes no server record to the pod for a report that was refused", async () => {
      assert.equal((await oddOnce()).wrote, 0);
    });
  });

  describe("api.connection({ pod, connection, wait })", () => {
    it('returns with `wait: "change"` only when the step, the count of requests or the bring-in\'s part has changed', async () => {
      const { states, held } = await pulledOnce();
      assert.ok(states.length > 1);
      // A call the change did not end returns after `wait` 25 seconds, as it is: a loaded machine can stall that long.
      states.forEach((each, at) => {
        if (at > 0 && each === states[at - 1])
          assert.ok(held[at]! >= WAIT_MS, `${each} again after ${held[at]} ms`);
      });
    });

    it("returns the count of requests, the patient's name and the sources of the pull once it has pulled", () => {
      const { shown } = statin;
      assert.equal(shown.step, "pulled");
      assert.ok(shown.requests > 0);
      assert.ok(
        shown.sources.some(({ server }: Output) =>
          FHIR_BASE().startsWith(server),
        ),
        JSON.stringify(shown.sources),
      );
      assert.equal(shown.patient, "Ines Calloway");
    });

    it("returns `titled: true` once it has pulled for a pod that was made with a name", async () => {
      assert.equal((await pulledOnce()).shown.titled, true);
    });

    it("returns nothing of the pulled bundle itself", async () => {
      assert.ok(
        !keys((await pulledOnce()).shown).includes("bundle"),
        "the connection carries its bundle",
      );
    });

    it('returns `step: "failed"` and `failure: "cancelled"` when the person cancels the sign-in', async () => {
      const { over } = local({ [EMPTY]: {} }, { hospitals: northHospitals() });
      const { shown } = await connected(over, EMPTY);
      assert.equal(shown.step, "failed");
      assert.equal(shown.failure, "cancelled");
    });

    it("returns the connection as it is, still `signing in`, after 25 seconds of `wait: true`", async () => {
      assert.equal((await parkedOnce()).held.step, "signing in");
    });
  });

  describe("api.bring({ pod, connection })", () => {
    it('returns `step: "bringing in"`, and imports the pull into the pod', async () => {
      assert.deepEqual(statin.bringing, { step: "bringing in" });
      assert.equal(statin.brought.broughtIn, true);
      const answers = await inProcess.answers({ pod: STATIN });
      assert.ok(
        answers.changes.some(
          ({ key }: Output) => key === `start:${ATORVASTATIN}:${LDL}`,
        ),
      );
    });

    it("holds one import for one bring-in, so the pod's record of the connect is not among its imports", async () => {
      const imports = await inProcess.ask({ pod: STATIN, question: IMPORTS });
      const labels = new Map<string, string | undefined>(
        imports.rows.map(
          ({ import: id, importLabel }: Output) =>
            [id, importLabel] as [string, string | undefined],
        ),
      );
      assert.deepEqual([...labels.values()], ["FHIR pull"]);
    });

    it("reports loading the adapter, converting, saving and judging, in that order, in the connection's `bringing`", () => {
      const each = statin.parts.filter(
        (part, at) => part !== statin.parts[at - 1],
      );
      assert.deepEqual(each, [
        "loading the adapter",
        "converting",
        "saving",
        "judging",
      ]);
    });

    it("runs the matcher once on a pull that files records and claims their profile", async () => {
      const { matchesAfterFirst, firstShown } = await matchesOnce();
      assert.equal(firstShown.broughtIn, true);
      assert.equal(matchesAfterFirst.length, 1);
      assert.equal(matchesAfterFirst[0]!.args[0], "urn:test:import");
    });

    it("asks no `profile/What needs review` before it claims the profile of a pull it files on a first try", async () => {
      const { askedAfterFirst, firstShown } = await matchesOnce();
      assert.equal(firstShown.broughtIn, true);
      assert.deepEqual(
        askedAfterFirst.filter((question) => question === REVIEW),
        [],
      );
    });

    it("runs no matcher on a second pull of the same records, which files nothing and claims nothing", async () => {
      const { matches, secondShown } = await matchesOnce();
      assert.equal(secondShown.broughtIn, true);
      assert.equal(secondShown.failed, undefined);
      assert.equal(matches.length, 1);
    });

    it("runs the matcher again on a retried bring-in whose matcher run failed, though the retry files and claims nothing", async () => {
      const { failed, retried, failedMatches } = await matchesOnce();
      assert.match(failed.failed ?? "", /^Not brought in: /);
      assert.equal(retried.broughtIn, true);
      assert.equal(failedMatches.length, 2);
    });

    it('imports a pull once: a second call returns `step: "pulled"`, and the connection has `broughtIn: true`', async () => {
      const { again, after, imports } = await matchesOnce();
      assert.deepEqual(again, { step: "pulled" });
      assert.equal(after.step, "pulled");
      assert.equal(after.broughtIn, true);
      assert.equal(after.failed, undefined);
      assert.ok(after.sources.length > 0);
      assert.equal(imports, 2);
    });

    it("titles a pod with no name on file for the person of the record brought in, still so when it is opened again, and leaves a name on file", async () => {
      const { untitled, titled } = await namedAfterBringIn();
      assert.equal(untitled.title, "Ines Calloway");
      assert.deepEqual(untitled.retitled, ["Ines Calloway"]);
      assert.equal(titled.title, "Ada");
      assert.deepEqual(titled.retitled, []);
    });

    it("leaves the title of a pod when the import is refused", async () => {
      const { refused } = await namedAfterBringIn();
      assert.equal(refused.title, "rowan-ellery-marsh");
      assert.match(refused.shown.failed, /^Refused: not a record/);
    });

    it("claims no profile its owner said is not them, so the pod is not titled", async () => {
      const { disclaimed } = await namedAfterBringIn();
      assert.equal(disclaimed.shown.broughtIn, true);
      assert.deepEqual(disclaimed.judged, []);
      assert.deepEqual(disclaimed.retitled, []);
      assert.equal(disclaimed.title, "rowan-ellery-marsh");
    });

    it("claims a profile and titles the pod when a bring is tried again after its claim failed, though the second import files nothing", async () => {
      const { retried } = await namedAfterBringIn();
      assert.match(retried.failedFirst ?? "", /^Not brought in: /);
      assert.deepEqual(retried.judged, [PROFILE]);
      assert.equal(retried.title, "Ines Calloway");
      assert.equal(retried.matches, 1);
    });

    it("claims on a retry only the profiles its own pull's import filed, leaving another pull's of the same hospital for the person to answer", async () => {
      const { retriedBesideAnotherPull, retried } = await namedAfterBringIn();
      assert.deepEqual(retried.waiting, []);
      assert.deepEqual(retriedBesideAnotherPull.judged, [PROFILE]);
      assert.deepEqual(
        retriedBesideAnotherPull.waiting.map(({ profile }: Output) => profile),
        ["urn:uuid:profile-of-another-pull"],
      );
    });

    it("titles a pod on a retry whose pull names a profile already answered besides the one it claims, as it does when the pull names that one alone", async () => {
      const { retriedBesideAnAnsweredProfile, retried } =
        await namedAfterBringIn();
      assert.match(
        retriedBesideAnAnsweredProfile.failedFirst ?? "",
        /^Not brought in: /,
      );
      assert.equal(retriedBesideAnAnsweredProfile.title, retried.title);
      assert.deepEqual(retriedBesideAnAnsweredProfile.waiting, []);
    });

    it("fails a bring, to be tried again as one whose claim failed, when the import leaves unclaimed a profile it was asked to claim", async () => {
      const { aboutRefused, untitled } = await namedAfterBringIn();
      assert.match(aboutRefused.failedFirst ?? "", /^Not brought in: /);
      assert.equal(untitled.failedFirst, undefined);
      assert.deepEqual(aboutRefused.judged, [PROFILE]);
    });

    it("leaves a profile unclaimed when its owner said it is not them after the first claim failed and before the retry", async () => {
      const { disclaimedBeforeTheRetry: kept } = await namedAfterBringIn();
      assert.match(kept.failedFirst ?? "", /^Not brought in: /);
      assert.deepEqual(kept.judged, []);
      assert.deepEqual(kept.retitled, []);
      assert.equal(kept.title, "rowan-ellery-marsh");
    });

    it("claims nothing, and tells in the pod's `waiting` what waits, when a bring is tried again on an app opened again over the same folder", async () => {
      const { retriedAfterARestart: restarted } = await namedAfterBringIn();
      assert.match(restarted.failedFirst ?? "", /^Not brought in: /);
      assert.deepEqual(restarted.judged, []);
      assert.equal(restarted.title, "rowan-ellery-marsh");
      assert.deepEqual(
        restarted.waiting.map(({ profile }: Output) => profile),
        [PROFILE],
      );
      assert.match(restarted.waiting[0].hospital, /^Cascade North/);
      assert.ok(restarted.waiting[0].records > 0);
    });

    it("does not retitle a pod, and logs nothing, when the person of the record has no name to give it", async () => {
      const { retitled, logged, broughtIn } = await textOnlyName();
      assert.equal(broughtIn, true);
      assert.equal(retitled, 0);
      assert.equal(logged, 0);
    });

    it("does not retitle a pod when the name of the person of the record is only a blank given name", async () => {
      const { retitled, logged, broughtIn, patient } = await blankGivenName();
      assert.equal(broughtIn, true);
      assert.equal(retitled, 0);
      assert.equal(logged, 0);
      assert.equal(patient, undefined);
    });

    it("gives no `patient` when the person of the record has no name, so no screen says whose record it is", async () => {
      const { patient } = await textOnlyName();
      assert.equal(patient, undefined);
    });

    it("says `Not brought in: …` in `failed`, with `retry: true`, when the import throws an error of the app's own", async () => {
      const { failed } = await failedOnce();
      assert.equal(failed.step, "pulled");
      assert.equal(failed.retry, true);
      assert.match(failed.failed, /^Not brought in: /);
    });

    it("keeps that error's text out of `failed`, and logs it once", async () => {
      const { failed, logged } = await failedOnce();
      assert.ok(!failed.failed.includes("secret"), failed.failed);
      assert.equal(logged, 1);
    });
  });

  describe("when the pods are deleted or PodApi is closed with a sign-in under way", () => {
    it("stops the sign-in on `api.deleteAll()`", async () => {
      assert.equal((await parkedOnce()).deleted, true);
    });

    it("stops the sign-in on `api.close()`", async () => {
      assert.equal((await parkedOnce()).closed, true);
    });
  });
});

/**
 * What a real pod's views hold after a bring that went another way than its first try: over a profile its owner said is
 * not them, or tried again after a claim failed. The runtime's own suite answers what the views do with such a claim
 * (`test/pod.test.ts`, "given the owner's NotAbout over the export's patient, and a later import naming it"). These
 * run a real pod each and are candidates for deletion.
 */
describe("Bringing a record in on a real pod, past a claim its owner refused or that failed · api.bring()", () => {
  /**
   * A pod made in a folder of its own and a bring of a pull of the statin story into it. With `fails`, the first import
   * fails after it has filed the pull; with `disclaims`, the owner's NotAbout is filed over the pull's profiles then, or,
   * when the import does not fail, before the bring.
   */
  const realOnce = (fails: boolean, disclaims: boolean) =>
    once(async () => {
      const at = await mkdtemp(join(tmpdir(), "pod-api-disclaimed-"));
      folders.push(at);
      const notAbout = (
        owner: { subject: string; owner: string },
        profile: string,
      ) => `@prefix cascade: <https://ns.cascadeprotocol.org/cascade#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
<urn:cascade:this-judgment> a cascade:Judgment ;
    cascade:verdict cascade:NotAbout ; cascade:subject <${owner.subject}> ;
    prov:hadMember <${profile}> ; prov:wasAttributedTo <${owner.owner}> ;
    prov:wasGeneratedBy [ prov:qualifiedAssociation [ prov:agent <${owner.owner}> ; prov:hadRole cascade:PatientRole ] ] .
<${owner.owner}> a prov:Person .
`;
      const files = pullFiles((await pulled(north, STATIN)).pull, "north");
      const name = "rowan-ellery-marsh";
      if (!fails) {
        const scratch = await openPod();
        const { unclaimedProfiles } = await scratch.import(files, {
          match: false,
        });
        await scratch.close();
        const owner = await openPod(join(at, name));
        for (const profile of unclaimedProfiles)
          await owner.judge(notAbout(owner, profile));
        await owner.close();
      } else await (await openPod(join(at, name))).close();
      const base = host(at);
      let failing = fails;
      const opening = base.pods as unknown as {
        open(...a: unknown[]): Promise<object>;
      };
      const disclaiming = (pod: object) =>
        new Proxy(pod, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key !== "import")
              return typeof value === "function" ? value.bind(target) : value;
            return async (...args: unknown[]) => {
              const [given, options] = args as [
                unknown,
                { onProgress?: (part: object) => unknown },
              ];
              const failsHere = failing;
              failing = false;
              try {
                return await (
                  value as (...a: unknown[]) => Promise<object>
                ).call(target, given, {
                  ...options,
                  ...(failsHere && {
                    onProgress: async (part: {
                      part: string;
                      done?: number;
                    }) => {
                      await options.onProgress?.(part);
                      if (part.part === "judging" && part.done === 0)
                        throw new Error("no room to write the About");
                    },
                  }),
                });
              } catch (error) {
                if (failsHere && disclaims)
                  for (const { profile } of await (
                    target as unknown as {
                      ask(question: string): Promise<{ profile: string }[]>;
                    }
                  ).ask(REVIEW))
                    await (
                      Reflect.get(target, "judge", target) as (
                        ...a: unknown[]
                      ) => Promise<object>
                    ).call(target, notAbout(target as never, profile));
                throw error;
              }
            };
          },
        });
      const local_ = api({
        ...base,
        pods: {
          ...base.pods,
          open: async (...args: unknown[]) =>
            disclaiming(await opening.open(...args)),
        },
        hospitals: northHospitals(),
      } as Host);
      const logged = mock.method(console, "error", () => undefined);
      try {
        let { connection } = await connectedAndPulled(local_, name);
        const target = { pod: name, connection };
        await local_.bring(target);
        const first = await local_.connection({ ...target, wait: true });
        if (first.retry) {
          await local_.bring(target);
          await local_.connection({ ...target, wait: true });
        }
        const held = {
          failedFirst: first.failed as string | undefined,
          imports: new Set(
            (await local_.ask({ pod: name, question: IMPORTS })).rows.map(
              ({ import: id }: Output) => id,
            ),
          ).size,
          medications: (await local_.ask({ pod: name, question: MEDICATIONS }))
            .rows.length,
        };
        await local_.close();
        connection = 0;
        const again = api(host(at) as Host);
        const title = (await again.pods({})).pods.find(
          (each: Output) => each.name === name,
        ).title as string;
        await again.close();
        return { ...held, title };
      } finally {
        logged.mock.restore();
      }
    });
  const disclaimed = realOnce(false, true);
  const disclaimedBeforeTheRetry = realOnce(true, true);
  const retried = realOnce(true, false);

  it("claims no profile its owner said is not them, so its views leave the record out, though the record is in it", async () => {
    const read = await disclaimed();
    assert.ok(
      (await inProcess.ask({ pod: STATIN, question: MEDICATIONS })).rows
        .length > 0,
    );
    assert.equal(read.imports, 1);
    assert.equal(read.medications, 0);
    assert.equal(read.title, "rowan-ellery-marsh");
  });

  it("leaves a profile unclaimed when its owner said it is not them after the first claim failed and before the retry, so its views leave the record out", async () => {
    const kept = await disclaimedBeforeTheRetry();
    assert.match(kept.failedFirst ?? "", /^Not brought in: /);
    assert.equal(kept.medications, 0);
    assert.equal(kept.title, "rowan-ellery-marsh");
  });

  it("shows the record in its views, and titles the pod for good, after a bring tried again over a claim that failed", async () => {
    const read = await retried();
    assert.match(read.failedFirst ?? "", /^Not brought in: /);
    assert.equal(
      read.medications,
      (await inProcess.ask({ pod: STATIN, question: MEDICATIONS })).rows.length,
    );
    assert.ok(read.medications > 0);
    assert.equal(read.title, "Ines Calloway");
  });
});

/**
 * The world's date is a day the app can set so that the demo hospitals answer as they would have then, which lets
 * a person watch a sandbox story's later records arrive. It is kept as an instant, travels with each connection
 * started under it, and is said in words on the screens.
 */
describe("Setting the day the demo hospitals answer as of · api.setWorldDate(), worldInstant(), utcInstant(), worldDateSaid(), pulledAsOfSaid()", () => {
  const dated = once(async () => {
    let asOf: string | undefined;
    const kept = {
      get: () => asOf,
      set: (to: string | undefined) => {
        asOf = to;
      },
    };
    const { over } = local({}, { world: kept, hospitals: northHospitals() });
    const set = await over.setWorldDate({ date: "2024-02-01" });
    const held = asOf;
    await over.makePod({ person: "Ada" });
    const { shown } = await connected(over, "ada");
    const cleared = await over.setWorldDate({ date: "" });
    return { set, held, shown, cleared, clearedTo: asOf };
  });

  describe("api.setWorldDate({ date })", () => {
    it("sets the host's world date to the last second of the day given, and returns it in `asOf`", async () => {
      const { set, held } = await dated();
      assert.deepEqual(set, { asOf: "2024-02-01T23:59:59Z" });
      assert.equal(held, "2024-02-01T23:59:59Z");
    });

    it("clears it when `date` is empty", async () => {
      const { cleared, clearedTo } = await dated();
      assert.deepEqual(cleared, {});
      assert.equal(clearedTo, undefined);
    });
  });

  describe("given a world's date set before a sign-in at a demo hospital starts", () => {
    it("returns that date on the connection, in `asOf`", async () => {
      assert.equal((await dated()).shown.asOf, "2024-02-01T23:59:59Z");
    });
  });
});

/** What each call is, the way it is given, and what it is refused for: one row for each sentence a person can be given. */
const REFUSED: [keyof Api, string, () => Input, RegExp][] = [
  [
    "connect",
    "refuses a hospital that is not in the directory",
    () => ({ pod: STATIN, fhirBase: "https://nowhere.invalid/fhir" }),
    /not in the directory/,
  ],
  [
    "connection",
    "refuses a number that is no connection of the pod",
    () => ({ pod: STATIN, connection: 999 }),
    /no connection 999/,
  ],
  [
    "connection",
    'refuses a `wait` that is neither true nor "change"',
    () => ({ pod: STATIN, connection: 1, wait: "soon" }),
    /wait must be true or "change"/,
  ],
  [
    "bring",
    "refuses a connection that pulled nothing",
    () => ({ pod: EMPTY, connection: cancelled }),
    /nothing pulled to bring in/,
  ],
  [
    "makePod",
    "refuses a name with no letter from a to z and no digit",
    () => ({ person: "!!!" }),
    /at least one letter/,
  ],
  [
    "makePod",
    "refuses `Con`, a name Windows keeps for a device",
    () => ({ person: "Con" }),
    /Windows keeps for itself/,
  ],
  [
    "makePod",
    "refuses `COM1`, a name Windows keeps for a device",
    () => ({ person: "COM1" }),
    /Windows keeps for itself/,
  ],
  [
    "makePod",
    "refuses `lpt9`, a name Windows keeps for a device",
    () => ({ person: "lpt9" }),
    /Windows keeps for itself/,
  ],
  [
    "makePod",
    "refuses an `encrypt` that is neither true nor false",
    () => ({ person: "Ada", encrypt: "on" }),
    /encrypt must be true/,
  ],
  [
    "waitingWords",
    "refuses a pod that is not waiting",
    () => ({ pod: "nobody" }),
    /not waiting any more/,
  ],
  [
    "waiting",
    "refuses a pod that is not waiting",
    () => ({ pod: "nobody" }),
    /not waiting any more/,
  ],
  [
    "confirmWords",
    "refuses a word 2 that is not the one given",
    () => ({ ...typed, word2: "x" }),
    /aren't words 2 and 5/,
  ],
  [
    "confirmWords",
    "refuses a `password` that is not the six words",
    () => ({ ...typed, password: "x" }),
    /Password field/,
  ],
  [
    "confirmWords",
    "refuses a `username` that is not the pod's name",
    () => ({ ...typed, username: "x" }),
    /Pod field/,
  ],
  [
    "setWorldDate",
    "refuses text that is no date, saying the two forms a date takes",
    () => ({ date: "soon" }),
    /"soon" is not a date: give a day as YYYY-MM-DD, or an instant with its timezone\./,
  ],
  [
    "answers",
    "refuses a pod there is not, naming the pods there are",
    () => ({ pod: "nobody" }),
    /no pod nobody; the pods are/,
  ],
  [
    "pod",
    "refuses a `pod` that is no string",
    () => ({ pod: 5 }),
    /pod must be a string/,
  ],
  [
    "said",
    "refuses an entry the pod does not hold",
    () => ({ pod: STATIN, entry: "0" }),
    /holds no entry 0/,
  ],
  [
    "trend",
    "refuses a pod with no test results",
    () => ({ pod: EMPTY }),
    /holds no test results/,
  ],
  [
    "panel",
    "refuses a call that names no panel",
    () => ({ pod: STATIN }),
    /a panel is a LOINC code/,
  ],
  [
    "panel",
    "refuses an empty panel",
    () => ({ pod: STATIN, panel: "" }),
    /a panel is a LOINC code/,
  ],
  [
    "table",
    "refuses a reference table that is not held",
    () => ({ id: "nothing" }),
    /no reference table nothing/,
  ],
  [
    "table",
    "refuses a code the table does not hold",
    () => ({ id: "loinc", code: "0000-0" }),
    /holds no code 0000-0/,
  ],
  [
    "table",
    "refuses a `page` given as text",
    () => ({ page: "2" }),
    /page must be a whole number from 1/,
  ],
  [
    "table",
    "refuses a `page` that is a fraction",
    () => ({ page: 1.5 }),
    /page must be a whole number from 1/,
  ],
  [
    "ask",
    "refuses a `limit` of 0",
    () => ({ pod: STATIN, question: LABS, limit: 0 }),
    /limit/,
  ],
  [
    "ask",
    "refuses an `offset` below 0",
    () => ({ pod: STATIN, question: LABS, offset: -1 }),
    /offset must be/,
  ],
  [
    "ask",
    "refuses a `format` other than `rows` or `compact`",
    () => ({ pod: STATIN, question: LABS, format: "csv" }),
    /format must be rows or compact/,
  ],
  [
    "ask",
    "refuses `entries` that are not strings",
    () => ({ pod: STATIN, format: "compact", entries: [1] }),
    /entries must be a list of strings/,
  ],
  [
    "ask",
    'refuses `entries` without `format: "compact"`',
    () => ({ pod: STATIN, question: LABS, entries: ["x"] }),
    /entries need format compact/,
  ],
  [
    "tool",
    "refuses an `input` that is no object",
    () => ({ pod: STATIN, tool: "find_changes", input: "x" }),
    /input must be an object/,
  ],
  [
    "tool",
    "refuses a tool there is not",
    () => ({ pod: STATIN, tool: "nothing" }),
    /no tool nothing/,
  ],
  [
    "tool",
    "refuses a property `worth_a_look` does not take",
    () => ({ pod: STATIN, tool: "worth_a_look", input: { extra: true } }),
    /extra is not a property/,
  ],
];
/** The refusals whose sentence is the real pod's: it names the tests and medications the statin pod holds, or the runtime's own question or tool says it. */
const REFUSED_BY_THE_POD: [keyof Api, string, () => Input, RegExp][] = [
  [
    "trend",
    "refuses a test the pod has no results of, naming the tests it has",
    () => ({ pod: STATIN, test: "0000-0" }),
    /the tests it holds are .*18262-6/,
  ],
  [
    "trend",
    "refuses a medication the pod does not hold, naming those it holds",
    () => ({ pod: STATIN, test: LDL, medication: "0" }),
    /no medication 0 in the pod; the medications it holds are .*617310/,
  ],
  [
    "ask",
    "refuses a question that is no named question",
    () => ({ pod: STATIN, question: "pod/No such question" }),
    /no question/,
  ],
  [
    "tool",
    "refuses a test the pod lacks, from `find_changes`",
    () => ({ pod: STATIN, tool: "find_changes", input: { test: "0000-0" } }),
    /no test/,
  ],
  [
    "tool",
    "refuses a test the pod lacks, from `lab_series`",
    () => ({ pod: STATIN, tool: "lab_series", input: { test: "0000-0" } }),
    /no test/,
  ],
];
/** The connection the `EMPTY` pod's cancelled sign-in made, and the words of a pod that is waiting. */
let cancelled: number;
let typed: Input;

/**
 * PodApi throws a `Refusal` for input it cannot act on, with a sentence that says what to give in its place and,
 * where it helps, what there is to choose from. Each leaf is one such input; none of them changes a pod.
 */
describe("Input PodApi refuses, and the sentence it gives · podApi(), Refusal", () => {
  let refusing: Api;
  before(async () => {
    refusing = local(
      { [STATIN]: {}, [EMPTY]: {} },
      { hospitals: northHospitals() },
    ).over;
    await refusing.makePod({ person: "Waiting", encrypt: true });
    const { words } = await refusing.waitingWords({ pod: "waiting" });
    typed = typedBack(words, "waiting");
    cancelled = (await connected(refusing, EMPTY)).connection;
  });

  for (const [instance, table] of [
    [() => refusing, REFUSED],
    [() => overHttp, REFUSED_BY_THE_POD],
  ] as const)
    for (const operation of new Set(table.map(([each]) => each)))
      describe(`api.${operation}()`, () => {
        for (const [, title, input, reason] of table.filter(
          ([each]) => each === operation,
        ))
          it(title, async () => {
            await assert.rejects(
              instance()[operation](input()),
              (error) =>
                isRefusal(error) &&
                error.outcome === undefined &&
                reason.test(error.message),
            );
          });
      });
});

/**
 * The Node server offers each PodApi operation at `POST /api/<operation>`, taking and returning JSON, and the app's
 * own client, `remoteApi()`, calls them for the pages. A refusal crosses with its sentence.
 */
describe("Calling PodApi over HTTP · /api/, INPUT_SCHEMAS, refusalOf()", () => {
  describe("given the app's own client, `remoteApi()`, over the server", () => {
    const table = () => ({
      [STATIN]: {},
      [SEALED]: { secret: SEALED_WORDS },
    });

    it("returns what PodApi returned, after a round trip through JSON", async () => {
      const { built: inner, over } = local(table());
      assert.deepStrictEqual(
        await over.pods({}),
        JSON.parse(JSON.stringify(await inner.pods({}))),
      );
    });

    it("throws a `Refusal` carrying the sentence PodApi refused with, such as `there is no pod nobody; the pods are ...`, when PodApi refuses", async () => {
      const { built: inner, over } = local(table());
      const own = await caught(inner.answers({ pod: "nobody" }));
      const crossed = await caught(over.answers({ pod: "nobody" }));
      assert.equal(crossed.name, "Refusal");
      assert.equal(crossed.message, own.message);
    });

    it("throws `Unopened` with PodApi's `outcome` when a pod does not open", async () => {
      const crossed = await caught(
        local(table()).over.answers({ pod: SEALED }),
      );
      assert.equal(crossed.name, "Unopened");
      assert.equal(crossed.outcome, "secret needed");
    });

    it("throws an error that names the operation and the status 500 when PodApi throws anything else", async () => {
      const quiet = mock.method(console, "error", () => undefined);
      try {
        await assert.rejects(
          crossing(brokenApi()).classes({ pod: STATIN }),
          /classes: the server answered 500/,
        );
      } finally {
        quiet.mock.restore();
      }
    });
  });

  describe("given a server's answer the client reads on its own", () => {
    const sent = (answer: Response, base = "http://h/app/") => {
      const urls: string[] = [];
      const client = remoteApi(base, {
        fetch: async (input: RequestInfo | URL) => {
          urls.push(String(input));
          return answer;
        },
      });
      return { client, urls };
    };

    it("throws an error carrying the server's sentence, and not a `Refusal`, for a 403, which the page's own refusals are not", async () => {
      const sentence =
        "Open the address the app printed, which holds this launch's cookie.";
      const { client } = sent(
        Response.json({ refused: sentence }, { status: 403 }),
      );
      const error = await caught(client.pods({}));
      assert.equal(error.name, "Error");
      assert.equal(error.message, sentence);
    });

    it("posts to `api/<operation>` under the base address's path, whatever query or fragment the base carries", async () => {
      for (const base of [
        "http://h/app",
        "http://h/app/",
        "http://h/app?x=1",
        "http://h/app/#f",
        "http://h/app/?x=1#f",
      ]) {
        const { client, urls } = sent(Response.json({}), base);
        await client.pod({ pod: "x" });
        assert.deepEqual(urls, ["http://h/app/api/pod"], base);
      }
    });
  });
});

/** `name` as a model runs it through `POST /tools/<name>` on the handler over `built`, as a page that holds the cookie. */
function toolsOf(given: Api) {
  const [app, , launch] = served(given);
  const cookie = cookieOf(launch);
  return (name: string, input: object) =>
    app.request(`${ORIGIN}/tools/${name}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify(input),
    });
}

/** The statin story's pod with its lab results repeated on other days, so that the compact read of it is two pages. */
const paged = once(async () => {
  const at = await mkdtemp(join(tmpdir(), "pod-api-paged-"));
  folders.push(at);
  const { pull } = await pulled(north, STATIN);
  const files = pullFiles(pull, "north");
  const bundle = JSON.parse(
    new TextDecoder().decode(files.get("north/bundle.json")),
  );
  const labs = bundle.entry.filter(
    ({ resource }: Output) => resource.resourceType === "Observation",
  );
  for (let day = 0; day < 12; day += 1)
    for (const lab of labs)
      bundle.entry.push({
        ...lab,
        fullUrl: `${lab.fullUrl}-${day}`,
        resource: {
          ...lab.resource,
          id: `${lab.resource.id}-${day}`,
          effectiveDateTime: new Date(Date.UTC(2020, 0, 1 + day)).toISOString(),
        },
      });
  const pod = await openPod(join(at, "paged"));
  const imported = await importClaimingEveryProfile(
    pod,
    new Map([
      ...files,
      ["north/bundle.json", new TextEncoder().encode(JSON.stringify(bundle))],
    ]),
  );
  assert.equal(imported.refused, undefined);
  await pod.close();
  await settled(at);
  return toolsOf(api(host(at) as Host));
});

/** The pages of the paged pod's compact read, each asked for with the `next` of the page before. */
const pagesOnce = once(async () => {
  const run = await paged();
  const pages: Output[] = [];
  let input: Input | undefined = { pod: "paged", format: "compact" };
  while (input !== undefined && pages.length < 10) {
    const response = await run("ask", input);
    assert.equal(response.status, 200);
    const page: Output = await response.json();
    pages.push(page);
    input = page.next;
  }
  return pages;
});

/**
 * The read tools run over the handler on pods the app holds: a page that carries no runtime of its own asks the server
 * for them. (The refusals, and the tools' list, are tested over a stub in `handler.test.ts`.)
 */
describe("Running the read tools over HTTP on a pod · POST /tools/<name>", () => {
  it("runs `reference_table_checks` on a pod with the host's reference tables", async () => {
    const { built: given } = local({ [STATIN]: {} });
    const checked = await toolsOf(given)("reference_table_checks", {
      pod: STATIN,
    });
    assert.equal(checked.status, 200);
    assert.equal(((await checked.json()) as { tables: string }).tables, "on");
  });

  it("runs `ask` for a pod's compact read", async () => {
    const { built: given, s } = local(
      { [STATIN]: {} },
      {
        compact: async () => ({
          format: "compact",
          about: "",
          sources: "",
          views: [],
        }),
      },
    );
    const compact = await toolsOf(given)("ask", {
      pod: STATIN,
      format: "compact",
    });
    assert.equal(compact.status, 200);
    assert.equal(
      ((await compact.json()) as { format: string }).format,
      "compact",
    );
    assert.equal(s.of("compact")[0]!.args[0], STATIN);
  });

  it("responds 423 with `{ unopened, refused }`, as `/api/` does, for an encrypted pod that is not open", async () => {
    const { built: given } = local(
      { [SEALED]: { secret: SEALED_WORDS } },
      {
        compact: async () => ({
          format: "compact",
          about: "",
          sources: "",
          views: [],
        }),
      },
    );
    const locked = await toolsOf(given)("ask", {
      pod: SEALED,
      format: "compact",
    });
    assert.equal(locked.status, 423);
    const body = (await locked.json()) as { unopened: string; refused: string };
    assert.equal(body.unopened, "secret needed");
    assert.equal(typeof body.refused, "string");
  });

  it("returns a larger pod's compact read in two pages or more, each page's `next` being the input of the one after", async () => {
    const pages = await pagesOnce();
    assert.ok(pages.length >= 2, "the pod is read in more than one page");
    assert.equal(pages.at(-1)!.next, undefined);
  });

  it("returns every row of every view once across those pages", async () => {
    const shown = new Map<string, number>();
    const total = new Map<string, number>();
    for (const { views } of await pagesOnce())
      for (const view of views) {
        shown.set(view.question, (shown.get(view.question) ?? 0) + view.shown);
        total.set(view.question, view.total);
      }
    assert.deepEqual(shown, total);
  });
});
