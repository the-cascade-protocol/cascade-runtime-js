import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it, mock } from "node:test";
import { replayKit } from "cascade-runtime/fixtures";

type Handle = (request: Request, pages?: Pages) => Promise<Response>;
type Pages = (request: Request) => Response | Promise<Response>;
interface Launch {
  readonly token: string;
  exchange(given: string | undefined): string | undefined;
}
type Api = Record<string, (input: unknown) => Promise<unknown>>;

/** The entry point an app imports, read as loosely as the tests call it. */
const APP: string = "cascade-runtime/app";
const {
  appHandler,
  newLaunch,
  launchCookie,
  nodeHost,
  podApi,
  remoteApi,
  PAGE_TOOLS,
  TOOLS,
} = (await import(APP)) as {
  appHandler: (options: unknown) => Handle;
  newLaunch: () => Launch;
  launchCookie: (url: URL) => string;
  nodeHost: (options: { folder: string }) => object;
  podApi: (host: object) => { close(): Promise<void> };
  remoteApi: (
    base: string,
    options: {
      fetch: (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>;
      headers?: Record<string, string>;
    },
  ) => { pods(input: object): Promise<unknown> };
  PAGE_TOOLS: { name: string }[];
  TOOLS: { name: string; tier: string; opens?: true }[];
};

/** `handle` on a bare `node:http` server: a request in as a `Request`, its `Response` written out. */
function listen(handle: Handle): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : (Readable.toWeb(req) as ReadableStream);
    const answered = await handle(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        ...(body === undefined ? {} : { body, duplex: "half" }),
      } as RequestInit),
    );
    res.writeHead(answered.status, Object.fromEntries(answered.headers));
    res.end(Buffer.from(await answered.arrayBuffer()));
  });
}

/**
 * Any server can mount the one handler every app on `cascade-runtime/app` gets: a `Request` in, a `Response` out. It
 * answers `POST /api/<operation>` only to the page the launch opened, and turns away every other site and every other
 * program on the machine.
 */
describe("Serving PodApi to the app's pages from any server · appHandler()", () => {
  describe("mounted on a `node:http` server over Alex Rivera's sample pod", () => {
    let folder: string;
    let server: Server;
    let api: ReturnType<typeof podApi>;
    let origin: string;
    let cookie: string;
    const post = (
      operation: string,
      headers: Record<string, string>,
      input: object = {},
    ) =>
      fetch(`${origin}/api/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(input),
      });

    before(async () => {
      folder = await mkdtemp(join(tmpdir(), "app-handler-"));
      await replayKit("alex-rivera", join(folder, "alex-rivera"), {
        through: "E2",
      });
      api = podApi(nodeHost({ folder }));
      const launch = newLaunch();
      const handle = appHandler({
        api,
        own: () => ({
          hosts: new Set([new URL(origin).host]),
          origins: new Set([origin]),
        }),
        launch,
        address: { home: "/", connection: () => "/" },
        back: () => undefined,
      });
      server = listen(handle);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      cookie = `${launchCookie(new URL(origin))}=${launch.exchange(launch.token)}`;
    });

    after(async () => {
      server?.close();
      await api?.close();
      await rm(folder, { recursive: true, force: true, maxRetries: 5 });
    });

    it("answers 403 to a request from another site, whatever cookie it holds", async () => {
      const refused = await post("pods", {
        origin: "http://evil.example",
        cookie,
      });
      assert.equal(refused.status, 403);
      assert.deepEqual(await refused.json(), {
        refused: "a request from another site",
      });
    });

    it("answers 403 to a request from the app's own origin that holds no launch cookie", async () => {
      const refused = await post("pods", { origin });
      assert.equal(refused.status, 403);
      assert.match(
        ((await refused.json()) as { refused: string }).refused,
        /address .* printed/,
      );
    });

    it("returns the pods' names at `pods`, and a named question's rows at `answers`, to a request that holds the launch cookie", async () => {
      const pods = await post("pods", { origin, cookie });
      assert.equal(pods.status, 200);
      assert.deepEqual(
        ((await pods.json()) as { pods: { name: string }[] }).pods.map(
          ({ name }) => name,
        ),
        ["alex-rivera"],
      );
      const answered = await post(
        "answers",
        { origin, cookie },
        { pod: "alex-rivera" },
      );
      assert.equal(answered.status, 200);
      const { answers } = (await answered.json()) as {
        answers: Record<string, unknown[]>;
      };
      assert.ok(answers["pod/What each import brought in"]!.length > 0);
    });

    it("answers 400 with the rules' reason for a pod there is none of", async () => {
      const refused = await post(
        "answers",
        { origin, cookie },
        { pod: "nobody" },
      );
      assert.equal(refused.status, 400);
      assert.match(
        ((await refused.json()) as { refused: string }).refused,
        /no pod nobody/,
      );
    });
  });
});

const ORIGIN = "http://app.test";
const REFUSED_ADDRESS = /address .* printed/;

/** A PodApi that holds one pod, and says so in `calls` each time an operation of it runs. */
function stubApi(over: Api = {}) {
  const calls: string[] = [];
  const operations: Api = {
    pods: async () => ({ pods: [{ name: "alex-rivera" }] }),
    ask: async () => ({ rows: [] }),
    ...over,
  };
  const recording = Object.fromEntries(
    Object.entries(operations).map(([name, run]) => [
      name,
      async (input: unknown) => {
        calls.push(name);
        return run(input);
      },
    ]),
  ) as Api;
  return { api: recording, calls };
}

/** The handler over `stub`, answering as `app.test`, and the cookie the page that opened the printed address holds. */
function served(
  stub = stubApi(),
  options: Record<string, unknown> = {},
  home = "/",
) {
  const launch = newLaunch();
  const handle = appHandler({
    api: stub.api,
    own: () => ({
      hosts: new Set(["app.test"]),
      origins: new Set([ORIGIN]),
    }),
    launch,
    address: { home, connection: (pod: string) => `/pods/${pod}/` },
    back: () => undefined,
    ...options,
  });
  const request = (path: string, init: RequestInit = {}, pages?: Pages) =>
    handle(new Request(`${ORIGIN}${path}`, init), pages);
  /** The cookie of the page that opens the address the server printed, once. */
  const cookie = () =>
    `${launchCookie(new URL(ORIGIN))}=${launch.exchange(launch.token)}`;
  return { calls: stub.calls, handle, launch, request, cookie };
}

/** A POST to `path` as the app's own page sends one. */
const posted = (
  cookie: string,
  body: BodyInit = "{}",
  type = "application/json",
) => ({
  method: "POST",
  headers: { origin: ORIGIN, "content-type": type, cookie },
  body,
});

/**
 * What the handler refuses before it answers: a request that names another host, a method it does not serve, and a
 * request to a route that reads a pod that does not carry the cookie the launch's address gave the app's page.
 */
describe("Guarding the server · guard, newLaunch(), GET /?launch=<token>", () => {
  it("responds 403 to a request whose `Host` is not the server's own address, on `/api/` in JSON and elsewhere as a page", async () => {
    const { handle } = served();
    const api = await handle(
      new Request("http://rebound.example/api/pods", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(api.status, 403);
    assert.deepEqual(await api.json(), {
      refused: "not this server's address",
    });
    const page = await handle(new Request("http://rebound.example/tools"));
    assert.equal(page.status, 403);
    assert.match(await page.text(), /<h1>Refused: not this server's address/);
  });

  it("responds 405 to a method that is neither GET nor POST", async () => {
    const { request } = served();
    for (const method of ["PUT", "DELETE", "PATCH"])
      assert.equal(
        (await request("/api/pods", { method })).status,
        405,
        method,
      );
  });

  describe("given a program that names the server's own `Host`, `Origin` and `Content-Type` and holds no launch cookie", () => {
    const ask = (
      request: ReturnType<typeof served>["request"],
      method: string,
      path: string,
      headers: Record<string, string> = {},
    ) =>
      request(path, {
        method,
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...headers,
        },
        ...(method === "POST" && { body: "{}" }),
      });

    for (const [method, path] of [
      ["POST", "/api/pods"],
      ["POST", "/api/answers"],
      ["POST", "/api/waitingWords"],
      ["POST", "/api/unlock"],
      ["GET", "/tools"],
      ["POST", "/tools/list_pods"],
      ["GET", "/chat"],
      ["POST", "/chat"],
    ] as const)
      it(`responds 403 to ${method} ${path}, in JSON, and runs no operation`, async () => {
        const { request, calls } = served();
        const refused = await ask(request, method, path);
        assert.equal(refused.status, 403);
        assert.match(
          ((await refused.json()) as { refused: string }).refused,
          REFUSED_ADDRESS,
        );
        assert.deepEqual(calls, []);
      });

    it("responds 403 to a cookie that is not the launch's", async () => {
      const { request, cookie } = served();
      cookie();
      const name = launchCookie(new URL(ORIGIN));
      for (const held of [`${name}=wrong`, `${name}=`, `${name}`, "x=y"])
        assert.equal(
          (await ask(request, "GET", "/tools", { cookie: held })).status,
          403,
          held,
        );
    });

    it("responds 403 to the cookie of another port's launch, which a browser sends to every port of the same host", async () => {
      const { request, launch } = served();
      const session = launch.exchange(launch.token);
      const other = launchCookie(new URL("http://app.test:3001"));
      assert.notEqual(other, launchCookie(new URL(ORIGIN)));
      const refused = await ask(request, "GET", "/tools", {
        cookie: `${other}=${session}`,
      });
      assert.equal(refused.status, 403);
    });

    it("does not ask for the cookie at `/callback`, which a hospital's redirect reaches with none", async () => {
      const { request } = served();
      const answered = await request("/callback?code=x");
      assert.equal(answered.status, 400);
      assert.match(await answered.text(), /No sign-in is waiting/);
    });
  });

  describe("when a person opens the address the server printed, `/?launch=<token>`", () => {
    it("answers 303 to `/` with a cookie the page keeps: `HttpOnly`, `SameSite=Strict`, `Path=/`, named for the port and not the token", async () => {
      const { request, launch } = served();
      const answered = await request(`/?launch=${launch.token}`);
      assert.equal(answered.status, 303);
      assert.equal(answered.headers.get("location"), "/");
      const set = answered.headers.get("set-cookie") ?? "";
      const name = launchCookie(new URL(ORIGIN));
      assert.match(set, new RegExp(`^${name}=[\\w-]{43};`));
      assert.match(set, /HttpOnly/i);
      assert.match(set, /SameSite=Strict/i);
      assert.match(set, /Path=\//);
      assert.ok(!set.includes(launch.token), "the token is not the cookie");
      const [pair = ""] = set.split(";");
      const read = await request("/tools", { headers: { cookie: pair } });
      assert.equal(read.status, 200);
    });

    it("keeps the rest of the address, and drops only the token", async () => {
      const { request, launch } = served();
      const answered = await request(`/?back=%2Fpods&launch=${launch.token}`);
      assert.equal(answered.headers.get("location"), "/?back=%2Fpods");
    });

    it("sends on a page that holds the cookie already, whatever the spent token it carries, and gives no new cookie", async () => {
      const { request, launch } = served();
      const first = await request(`/?launch=${launch.token}`);
      const [cookie = ""] = (first.headers.get("set-cookie") ?? "").split(";");
      const again = await request(`/?launch=${launch.token}`, {
        headers: { cookie },
      });
      assert.equal(again.status, 303);
      assert.equal(again.headers.get("location"), "/");
      assert.equal(again.headers.get("set-cookie"), null);
    });

    it("answers 403 to the token a second time, and gives no cookie, as the token is spent", async () => {
      const { request, launch } = served();
      await request(`/?launch=${launch.token}`);
      const again = await request(`/?launch=${launch.token}`);
      assert.equal(again.status, 403);
      assert.equal(again.headers.get("set-cookie"), null);
      const page = await again.text();
      assert.match(page, /This address was opened already/);
      assert.match(page, /Start the app again/);
    });

    it("answers 403 to a token that is not the launch's, and to none, and spends nothing", async () => {
      const { request, launch } = served();
      for (const query of [
        "?launch=wrong",
        "?launch=",
        `?launch=${launch.token.slice(0, -1)}`,
      ]) {
        const refused = await request(`/${query}`);
        assert.equal(refused.status, 403, query);
        assert.equal(refused.headers.get("set-cookie"), null, query);
      }
      const spent = await request(`/?launch=${launch.token}`);
      assert.equal(spent.status, 303, "a wrong token spends nothing");
    });
  });
});

/**
 * The handler offers each PodApi operation at `POST /api/<operation>`, taking and returning JSON, and turns away a
 * request that does not come from one of the app's own pages. What PodApi throws for an input the rules refuse crosses
 * with its sentence (tested over the real PodApi, with `remoteApi()`, in `pod-api.test.ts`).
 */
describe("Calling PodApi over HTTP · POST /api/<operation>", () => {
  const broken = () =>
    stubApi({
      pods: async () => {
        throw new Error("/secret/path");
      },
    });

  for (const [title, status, path, init] of [
    [
      "responds 404 for an operation there is not",
      404,
      "/api/nothing",
      (cookie: string) => posted(cookie),
    ],
    [
      "responds 404 for `close`, which stays in the process",
      404,
      "/api/close",
      (cookie: string) => posted(cookie),
    ],
    [
      "responds 404 for a GET",
      404,
      "/api/pods",
      (cookie: string) => ({ headers: { cookie } }),
    ],
    [
      "responds 415 for a body that is not sent as JSON",
      415,
      "/api/pods",
      (cookie: string) => posted(cookie, "{}", "text/plain"),
    ],
    [
      "responds 403 for a request whose `Origin` is another site",
      403,
      "/api/pods",
      (cookie: string) => ({
        ...posted(cookie),
        headers: { ...posted(cookie).headers, origin: "http://evil.example" },
      }),
    ],
    [
      "responds 400 for a body that is no object",
      400,
      "/api/pods",
      (cookie: string) => posted(cookie, "[]"),
    ],
    [
      "responds 400 for a body that is no JSON",
      400,
      "/api/pods",
      (cookie: string) => posted(cookie, "{"),
    ],
  ] as const)
    it(title, async () => {
      const { request, cookie } = served();
      assert.equal((await request(path, init(cookie()))).status, status);
    });

  it("responds 400 for a body over 1 MiB, sent whole or in pieces, and runs no operation", async () => {
    const { request, cookie, calls } = served();
    const held = cookie();
    const whole = await request(
      "/api/pods",
      posted(held, " ".repeat(1024 * 1024 + 1)),
    );
    assert.equal(whole.status, 400);
    const piece = " ".repeat(1024 * 64);
    const pieces = new ReadableStream({
      start(controller) {
        for (let at = 0; at <= 16; at += 1)
          controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    });
    const streamed = await request("/api/pods", {
      ...posted(held, undefined),
      body: pieces,
      duplex: "half",
    } as RequestInit);
    assert.equal(streamed.status, 400);
    assert.deepEqual(calls, []);
  });

  it("responds 500 with one fixed sentence, and keeps the error's text out of it, when PodApi throws an error that is no refusal", async () => {
    const quiet = mock.method(console, "error", () => undefined);
    try {
      const { request, cookie } = served(broken());
      const response = await request("/api/pods", posted(cookie()));
      assert.equal(response.status, 500);
      const said = await response.text();
      assert.equal(
        said,
        JSON.stringify({ error: "the server failed; its log says why" }),
      );
      assert.ok(!said.includes("/secret/path"));
    } finally {
      quiet.mock.restore();
    }
  });

  it("throws an error that says to open the address the app printed, and not a `Refusal`, from the app's client when the page holds no launch cookie", async () => {
    const { handle } = served();
    const bare = remoteApi(`${ORIGIN}/`, {
      fetch: (input, init) => handle(new Request(input, init)),
      headers: { origin: ORIGIN },
    });
    const crossed = await bare.pods({}).then(
      () => assert.fail("answered"),
      (error: Error) => error,
    );
    assert.equal(crossed.name, "Error");
    assert.match(crossed.message, /open the address `npm start` printed/);
  });
});

/**
 * A page that carries no runtime of its own offers a model the app's read tools by calling the server: `GET /tools`
 * lists them, and `POST /tools/<name>` runs one on a JSON input. Only `free` tools that open no screen are here; a
 * tool that writes or moves the app is the page's own. Over a real pod they are tested in `pod-api.test.ts`.
 */
describe("Running the read tools over HTTP · GET /tools, POST /tools/<name>", () => {
  const run = (
    request: ReturnType<typeof served>["request"],
    cookie: string,
    name: string,
    input: object,
  ) => request(`/tools/${name}`, posted(cookie, JSON.stringify(input)));

  it("lists each `free` tool that opens no screen and is not the page's own, with its description and input schema", async () => {
    const { request, cookie } = served();
    const listed = (await (
      await request("/tools", { headers: { cookie: cookie() } })
    ).json()) as { name: string; description: unknown; inputSchema: unknown }[];
    const own = new Set(PAGE_TOOLS.map(({ name }) => name));
    assert.deepEqual(
      listed.map(({ name }) => name).sort(),
      TOOLS.filter(
        ({ tier, opens, name }) =>
          tier === "free" && opens === undefined && !own.has(name),
      )
        .map(({ name }) => name)
        .sort(),
    );
    assert.ok(listed.length > 0, "the server lists no tool");
    for (const { name, description, inputSchema } of listed) {
      assert.equal(typeof description, "string", name);
      assert.equal(typeof inputSchema, "object", name);
    }
  });

  it("runs `list_pods`, and returns the pods", async () => {
    const { request, cookie } = served();
    const pods = await run(request, cookie(), "list_pods", {});
    assert.equal(pods.status, 200);
    assert.ok(Array.isArray(await pods.json()));
  });

  it("responds 400, with the tool's refusal in `refused`, for input the tool's schema refuses", async () => {
    const { request, cookie } = served();
    const wrong = await run(request, cookie(), "ask", {
      pod: "x",
      question: "SELECT * WHERE {}",
    });
    assert.equal(wrong.status, 400);
    assert.match(
      ((await wrong.json()) as { refused: string }).refused,
      /must be one of/,
    );
  });

  it("responds 423 with `{ unopened, refused }`, as `/api/` does, for an encrypted pod that is not open", async () => {
    const { request, cookie } = served(
      stubApi({
        ask: async () => {
          throw Object.assign(new Error("the pod is sealed"), {
            name: "Unopened",
            outcome: "secret needed",
          });
        },
      }),
    );
    const locked = await run(request, cookie(), "ask", {
      pod: "sealed",
      format: "compact",
    });
    assert.equal(locked.status, 423);
    assert.deepEqual(await locked.json(), {
      unopened: "secret needed",
      refused: "the pod is sealed",
    });
  });

  it("responds 404 for a tool that writes or moves the app, and for a name that is no tool", async () => {
    const { request, cookie } = served();
    const held = cookie();
    for (const name of ["make_pod", "open_pod", "nothing"])
      assert.equal((await run(request, held, name, {})).status, 404, name);
  });
});

/**
 * `/world-date?back=<path>` sends a person back to a path of this app with the world's date's form open, and home
 * for anything that is not one.
 */
describe("Setting the world's date from a link · GET /world-date", () => {
  for (const [back, to, title] of [
    [
      "/pods/a/",
      "/pods/a/#world-date",
      "redirects to `/pods/a/#world-date` for `/pods/a/`",
    ],
    [
      "/pods/a/hospitals?q=north",
      "/pods/a/hospitals?q=north#world-date",
      "redirects to `/pods/a/hospitals?q=north#world-date` for `/pods/a/hospitals?q=north`",
    ],
    [undefined, "/", "redirects home when no `back` is given"],
    ["//evil.test/", "/", "redirects home for `//evil.test/`"],
    ["https://evil.test/", "/", "redirects home for `https://evil.test/`"],
    ["/\\evil.test/", "/", "redirects home for `/\\evil.test/`"],
    ["/..//evil.test/", "/", "redirects home for `/..//evil.test/`"],
    ["/.//evil.test/", "/", "redirects home for `/.//evil.test/`"],
    ["/%2e%2e//evil.test/", "/", "redirects home for `/%2e%2e//evil.test/`"],
    ["/a/..//evil.test", "/", "redirects home for `/a/..//evil.test`"],
    ["pods/a/", "/", "redirects home for `pods/a/`"],
  ] as const)
    it(title, async () => {
      const { request } = served();
      const response = await request(
        `/world-date${back === undefined ? "" : `?back=${encodeURIComponent(back)}`}`,
        { redirect: "manual" },
      );
      assert.ok(response.status >= 300 && response.status < 400);
      assert.equal(response.headers.get("location"), to);
    });
});

/**
 * The handler answers what is its own and hands every other address a person opens to the app's pages: the built
 * app's files and page, or in development Vite's, which serves any file under the app and so is asked for the cookie.
 */
describe("Answering an address a person opens with the app's pages · appHandler(), pages", () => {
  describe("given no pages", () => {
    it("responds 404 to an address that is no route", async () => {
      const { request } = served();
      assert.equal((await request("/pods/a/")).status, 404);
    });
  });

  describe("given the app's chat", () => {
    it("responds 404 at `/chat` when the app has none, and hands the request to the chat when it has", async () => {
      const none = served();
      assert.equal(
        (await none.request("/chat", { headers: { cookie: none.cookie() } }))
          .status,
        404,
      );
      const chatting = served(stubApi(), {
        chat: async (request: Request) =>
          new Response(`chat ${new URL(request.url).pathname}`),
      });
      const answered = await chatting.request("/chat", {
        headers: { cookie: chatting.cookie() },
      });
      assert.equal(await answered.text(), "chat /chat");
    });
  });

  describe("given pages that need the launch, as `npm run dev` gives them, and a request that holds no launch cookie", () => {
    const dev = () => {
      const reached: string[] = [];
      const pages: Pages = (request) => {
        reached.push(new URL(request.url).pathname);
        return new Response("from vite");
      };
      const app = served(stubApi(), { pagesNeedLaunch: true });
      const ask = (path: string, headers: Record<string, string> = {}) =>
        app.request(path, { headers }, pages);
      return { ...app, ask, reached };
    };

    for (const path of [
      "/pods/probe-plain/clinical/labels.ttl",
      "/pods/probe-four/settings/encryption.json",
      "/pods/.answers/probe-four/pod.json",
      "/@fs/C:/app/pods/probe-four/settings/encryption.json",
      "/server/launch.ts",
      "/pod-api.ts",
      "/src/main.tsx",
    ])
      it(`responds 403 to GET ${path} and does not reach the pages`, async () => {
        const { ask, reached } = dev();
        const refused = await ask(path, { "sec-fetch-mode": "cors" });
        assert.equal(refused.status, 403);
        assert.match(
          ((await refused.json()) as { refused: string }).refused,
          REFUSED_ADDRESS,
        );
        assert.deepEqual(reached, []);
      });

    it("responds 403 with a page that says to open the address the app printed, to a navigation", async () => {
      const { ask, reached } = dev();
      for (const path of ["/", "/pods/a"]) {
        const refused = await ask(path, { "sec-fetch-mode": "navigate" });
        assert.equal(refused.status, 403, path);
        assert.match(refused.headers.get("content-type") ?? "", /text\/html/);
        assert.match(await refused.text(), /Open the address .* printed/s);
      }
      assert.deepEqual(reached, []);
    });

    it("responds 403 to a cookie that is not the launch's", async () => {
      const { ask, cookie, reached } = dev();
      cookie();
      const name = launchCookie(new URL(ORIGIN));
      for (const held of [`${name}=wrong`, `${name}=`, "x=y"])
        assert.equal(
          (await ask("/pods/a/clinical/labels.ttl", { cookie: held })).status,
          403,
          held,
        );
      assert.deepEqual(reached, []);
    });

    it("answers the pages when the request holds the launch cookie", async () => {
      const { ask, cookie, reached } = dev();
      const held = cookie();
      for (const path of ["/", "/src/main.tsx", "/@vite/client"]) {
        const answered = await ask(path, { cookie: held });
        assert.equal(answered.status, 200, path);
        assert.equal(await answered.text(), "from vite");
      }
      assert.deepEqual(reached, ["/", "/src/main.tsx", "/@vite/client"]);
    });

    it("trades the printed address's token for the cookie, which the page it sends the browser to then holds", async () => {
      const { ask, launch, reached } = dev();
      const traded = await ask(`/?launch=${launch.token}`, {
        "sec-fetch-mode": "navigate",
      });
      assert.equal(traded.status, 303);
      assert.equal(traded.headers.get("location"), "/");
      const cookie = (traded.headers.get("set-cookie") ?? "").split(";")[0]!;
      assert.equal(
        (await ask("/", { cookie, "sec-fetch-mode": "navigate" })).status,
        200,
      );
      assert.deepEqual(reached, ["/"]);
    });
  });
});
