// The one handler an app's server mounts: a `Request` in, a `Response` out, so any server can carry it. It holds the
// guard, the launch's cookie, PodApi at `/api/`, the reads of the tool list at `/tools`, the chat at `/chat` when the app
// has it, a hospital's redirect back at `/callback`, and the app's own pages for any other address a person opens.
import type { InputSchema } from "../../check.js";
import { checkInput } from "../../check.js";
import { withPod } from "../../pod-tools.js";
import { INPUT_SCHEMAS, type Operation, refusalOf } from "../../app/inputs.js";
import type { PageDoor } from "../../app/page-tools.js";
import { PAGE_TOOLS } from "../../app/page-tools.js";
import type { PodApi } from "../../app/pod-api.js";
import { TOOLS } from "../../app/tools.js";
import { type Own, pageOf, refusedBy } from "./guard.js";
import { type Launch, launchCookie } from "./launch.js";

/** The operations the routes call: PodApi, as `podApi(host)` gives it. */
export type Operations = Omit<PodApi, "close">;

/** What an app's server answers when the app answers: a page, a file, or what the app's own routes say. */
export type Pages = (request: Request) => Response | Promise<Response>;

/** The addresses of the app the handler redirects to or builds for its tools: the app's own table, `addresses()`. */
export type AppAddresses = Partial<PageDoor["address"]> & {
  readonly home: string;
  connection(pod: string, connection: number): string;
};

export interface AppHandlerOptions {
  readonly api: Operations;
  /** This server's own addresses, known once it listens. */
  own(): Own;
  /** What the printed address `/?launch=<token>` trades for the cookie every route that reads a pod asks for. */
  readonly launch: Launch;
  readonly address: AppAddresses;
  /** The sign-in a hospital's redirect to `/callback` finishes, as `{ pod, connection }`; none when none waits. */
  back(url: URL): { pod: string; connection: number } | undefined;
  /** The demo people the hospitals hold, as `demoPeople` gives them, at `/demo-people.json`; none when not given. */
  people?(): readonly object[];
  /** `GET /chat` and `POST /chat`, when the app has the chat; without it `/chat` is a 404. */
  readonly chat?: Pages;
  /**
   * Whether the pages are asked for the cookie too, as development's are (Vite serves any file under the app): a
   * navigation without it is told to open the printed address, any other request is refused in JSON.
   */
  readonly pagesNeedLaunch?: boolean;
}

const MAX_BODY_BYTES = 1024 * 1024;
const FAILED = "the server failed; its log says why";
const NO_COOKIE =
  "this request does not come from the page the app opened: open the address `npm start` printed";

/** What the handler answers itself, served or not, and never as the app's page: the routes that read a pod. */
const SERVED = /^\/(?:api\/|tools(?:\/|$)|chat$)/;

/** An error PodApi throws for an input the rules refuse, by name, as the runtime's `Refusal` and `Unopened` carry it. */
interface Refused {
  readonly name: string;
  readonly message: string;
  readonly outcome?: string;
}

export const refused = (error: unknown): error is Refused =>
  error instanceof Error &&
  (error.name === "Refusal" || error.name === "Unopened");

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain;charset=UTF-8" },
  });
const tooLong = () =>
  json({ refused: `the body must be at most ${MAX_BODY_BYTES} bytes` }, 400);

/** The cookie `name` of the request, or nothing. */
function cookieNamed(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name)
      return pair.slice(at + 1).trim();
  }
  return undefined;
}

/** The request's body as text, or nothing when it is over `MAX_BODY_BYTES`. */
async function bodyOf(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const read = await reader?.read();
    if (read === undefined || read.done) break;
    size += read.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader?.cancel();
      return undefined;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The answer to a call that threw: 400 `{ refused }` for a refusal, 423 `{ unopened, refused }` for an `Unopened`, else 500. */
function failed(error: unknown, path: string): Response {
  if (refused(error))
    return error.outcome === undefined
      ? json({ refused: error.message }, 400)
      : json({ unopened: error.outcome, refused: error.message }, 423);
  console.error(`${path} failed:`, error);
  return json({ error: FAILED }, 500);
}

/**
 * `POST /api/<operation>`: 200 with the output; 400 `{ refused }` for an input its schema refuses, a `Refusal`, a body
 * that is no JSON or over 1 MiB; 423 `{ unopened, refused }` for an `Unopened` (an error with `outcome`); 404 for what
 * is no operation; and 500 with a fixed sentence for anything else, the error going to the log.
 */
async function apiAnswer(
  api: Operations,
  request: Request,
  path: string,
): Promise<Response> {
  const body = request.method === "POST" ? await bodyOf(request) : undefined;
  if (request.method === "POST" && body === undefined) return tooLong();
  const operation = path.slice("/api/".length) as Operation;
  const run = (api as Record<string, unknown>)[operation];
  if (
    request.method !== "POST" ||
    !Object.hasOwn(INPUT_SCHEMAS, operation) ||
    typeof run !== "function"
  )
    return json({ refused: "no such operation" }, 404);
  let input: unknown;
  try {
    input = JSON.parse(body ?? "");
  } catch {
    return json({ refused: "the body must be JSON" }, 400);
  }
  const checked = INPUT_SCHEMAS[operation].safeParse(input);
  if (!checked.success) return json({ refused: refusalOf(checked.error) }, 400);
  try {
    return json(await run.call(api, checked.data));
  } catch (error) {
    return failed(error, path);
  }
}

interface Read {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly tier: string;
  readonly ofPod?: boolean;
  readonly opens?: boolean;
  run(api: Operations, input: object, door: object): Promise<unknown>;
}

const OWN = new Set(PAGE_TOOLS.map(({ name }) => name));
/** The reads of the one list for a page that carries no runtime: the tools that move the app or write are the page's own. */
const READS = (TOOLS as unknown as readonly Read[]).filter(
  ({ name, tier, opens }) => tier === "free" && !opens && !OWN.has(name),
);

/** `GET /tools` names the reads; `POST /tools/<name>` runs one on a JSON input, answering as `/api/` does. */
async function toolsAnswer(
  api: Operations,
  address: AppAddresses,
  request: Request,
  path: string,
): Promise<Response> {
  if (path === "/tools" && request.method === "GET")
    return json(
      READS.map(({ name, description, inputSchema, ofPod }) => ({
        name,
        description,
        inputSchema,
        ofPod: ofPod === true,
      })),
    );
  const body = await bodyOf(request);
  if (body === undefined) return tooLong();
  const asked = path.slice("/tools/".length);
  const name = (() => {
    try {
      return decodeURIComponent(asked);
    } catch {
      return asked;
    }
  })();
  const read = READS.find((each) => each.name === name);
  if (read === undefined) return json({ refused: "no such tool" }, 404);
  try {
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      input = undefined;
    }
    checkInput(
      read.ofPod ? withPod(read.inputSchema) : read.inputSchema,
      input,
    );
    return json(await read.run(api, input as object, { address }));
  } catch (error) {
    return failed(error, path);
  }
}

/** Where `/world-date?back=` goes: `back` when it is a path of this app, with the world's date's form open; else home. */
export function worldDateBack(home: string, back: string | null): string {
  if (back === null || !back.startsWith("/") || back.startsWith("//"))
    return home;
  if (/[\\\s]/.test(back)) return home;
  const url = new URL(back, "http://app.invalid");
  return url.origin === "http://app.invalid" && !url.pathname.startsWith("//")
    ? `${url.pathname}${url.search}#world-date`
    : home;
}

const redirect = (to: string, status: 302 | 303, headers: HeadersInit = {}) =>
  new Response(null, { status, headers: { location: to, ...headers } });

/**
 * `GET /?launch=<token>`: the token of the address the server printed, once, for the cookie that opens the pod's routes,
 * then the same address without it. A page that holds the cookie already is sent on as well.
 */
function traded(launch: Launch, request: Request, url: URL): Response {
  const name = launchCookie(url);
  const token = url.searchParams.get("launch") ?? undefined;
  url.searchParams.delete("launch");
  const on = `${url.pathname}${url.search}`;
  const kept = { "cache-control": "no-store" };
  if (launch.holds(cookieNamed(request, name))) return redirect(on, 303, kept);
  const session = launch.exchange(token);
  if (session === undefined) {
    const page = pageOf("This address was opened already", 403, {
      title: "Address used",
      body: "<p>Start the app again. It prints a new address.</p>",
    });
    page.headers.set("cache-control", "no-store");
    return page;
  }
  return redirect(on, 303, {
    ...kept,
    "set-cookie": `${name}=${session}; Path=/; HttpOnly; SameSite=Strict`,
  });
}

/** Whether the request is a navigation or asks for HTML, as a person opening an address does. */
const navigating = (request: Request) =>
  request.headers.get("sec-fetch-mode") === "navigate" ||
  (request.headers.get("accept") ?? "").includes("text/html");

/**
 * The handler of `options`, called with each request and with `pages`, what answers an address a person opens rather
 * than one the handler answers: the app's built files and page, or in development Vite. Without `pages` that is a 404.
 */
export function appHandler(
  options: AppHandlerOptions,
): (request: Request, pages?: Pages) => Promise<Response> {
  const { api, launch, address } = options;
  return async (request, pages) => {
    const url = new URL(request.url);
    const turned = refusedBy(options.own(), request, url);
    if (turned !== undefined) return turned;
    const path = url.pathname;
    const cookie = cookieNamed(request, launchCookie(url));
    const get = request.method === "GET";
    if (SERVED.test(path) && !launch.holds(cookie))
      return json({ refused: NO_COOKIE }, 403);
    if (get && path === "/" && url.searchParams.has("launch"))
      return traded(launch, request, url);
    if (path.startsWith("/api/")) return apiAnswer(api, request, path);
    if (
      (get && path === "/tools") ||
      (request.method === "POST" && /^\/tools\/[^/]+$/.test(path))
    )
      return toolsAnswer(api, address, request, path);
    if (path === "/chat")
      return options.chat?.(request) ?? text("Not found", 404);
    if (get && path === "/callback") {
      const at = options.back(url);
      return at === undefined
        ? pageOf("No sign-in is waiting for this", 400, {
            title: "Not waiting",
          })
        : redirect(address.connection(at.pod, at.connection), 303);
    }
    if (get && path === "/world-date")
      return redirect(
        worldDateBack(address.home, url.searchParams.get("back")),
        302,
      );
    if (get && path === "/demo-people.json")
      return json(options.people?.() ?? []);
    if (!get || pages === undefined) return text("Not found", 404);
    if (options.pagesNeedLaunch === true && !launch.holds(cookie))
      return navigating(request)
        ? pageOf("Open the address the app printed", 403, {
            title: "Open the printed address",
            body: "<p>This page holds no launch cookie. The address the app printed when it started carries the one-time token that gives it.</p>",
          })
        : json({ refused: NO_COOKIE }, 403);
    return pages(request);
  };
}
