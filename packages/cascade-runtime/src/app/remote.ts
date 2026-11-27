// PodApi called at a server's `/api/`, `POST /api/<operation>` with the input as JSON, typed by PodApi's own inputs and
// outputs. What the server refuses is thrown as PodApi throws it in-process, by name.
import type { Input as In, Operation } from "./inputs.js";
import type { Output } from "./pod-api.js";

/** What a client sends each request with: `fetch` in place of the global one, and headers beside its own. */
export interface RemoteOptions {
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** PodApi's own errors, by the names the runtime's carry: the screens tell them apart by `name`. */
class Refusal extends Error {
  override name = "Refusal";
}
class Unopened extends Error {
  override name = "Unopened";
  readonly outcome: string;
  constructor(outcome: string, message: string) {
    super(message);
    this.outcome = outcome;
  }
}

/** What the server answered `operation`, or what it refused: 400 a `Refusal`, 423 an `Unopened`, else an `Error`. */
async function answer<K extends Operation>(
  operation: K,
  sent: Promise<Response>,
): Promise<Output<K>> {
  const response = await sent;
  const parsed: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    if (parsed === undefined)
      throw new Error(
        `${operation}: the server answered ${response.status} with ${response.headers.get("content-type") ?? "no content type"}, not JSON`,
      );
    return parsed as Output<K>;
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  if (typeof body.refused === "string") {
    if (response.status === 403) throw new Error(body.refused);
    if (response.status === 423)
      throw new Unopened(String(body.unopened), body.refused);
    if (response.status === 400) throw new Refusal(body.refused);
  }
  throw new Error(`${operation}: the server answered ${response.status}`);
}

/** Every operation of PodApi at the server whose app is at `base`. */
export function remoteApi(base: string, options: RemoteOptions = {}) {
  const root = base.endsWith("/") ? base : `${base}/`;
  const send = <K extends Operation>(operation: K, json: In<K>) =>
    answer(
      operation,
      (options.fetch ?? fetch)(new URL(`api/${operation}`, root), {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: JSON.stringify(json),
      }),
    );
  return {
    pods: (json: In<"pods"> = {}) => send("pods", json),
    held: (json: In<"held"> = {}) => send("held", json),
    pod: (json: In<"pod">) => send("pod", json),
    answers: (json: In<"answers">) => send("answers", json),
    said: (json: In<"said">) => send("said", json),
    trend: (json: In<"trend">) => send("trend", json),
    classes: (json: In<"classes">) => send("classes", json),
    panel: (json: In<"panel">) => send("panel", json),
    table: (json: In<"table"> = {}) => send("table", json),
    ask: (json: In<"ask">) => send("ask", json),
    tool: (json: In<"tool">) => send("tool", json),
    makePod: (json: In<"makePod">) => send("makePod", json),
    waiting: (json: In<"waiting">) => send("waiting", json),
    waitingWords: (json: In<"waitingWords">) => send("waitingWords", json),
    confirmWords: (json: In<"confirmWords">) => send("confirmWords", json),
    unlock: (json: In<"unlock">) => send("unlock", json),
    lock: (json: In<"lock"> = {}) => send("lock", json),
    deleteAll: (json: In<"deleteAll"> = {}) => send("deleteAll", json),
    resetAll: (json: In<"resetAll"> = {}) => send("resetAll", json),
    checkTables: (json: In<"checkTables"> = {}) => send("checkTables", json),
    setWorldDate: (json: In<"setWorldDate">) => send("setWorldDate", json),
    hospitals: (json: In<"hospitals"> = {}) => send("hospitals", json),
    connect: (json: In<"connect">) => send("connect", json),
    connection: (json: In<"connection">) => send("connection", json),
    bring: (json: In<"bring">) => send("bring", json),
    close: async () => undefined,
  };
}
