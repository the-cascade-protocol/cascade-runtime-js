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
import { after, before, describe, it } from "node:test";
import { replayKit } from "cascade-runtime/fixtures";

/** The entry point an app imports, read as loosely as the tests call it. */
const APP: string = "cascade-runtime/app";
const { appHandler, newLaunch, launchCookie, nodeHost, podApi } = (await import(
  APP
)) as {
  appHandler: (options: unknown) => (request: Request) => Promise<Response>;
  newLaunch: () => {
    token: string;
    exchange(given: string | undefined): string | undefined;
  };
  launchCookie: (url: URL) => string;
  nodeHost: (options: { folder: string }) => object;
  podApi: (host: object) => { close(): Promise<void> };
};

/** `handle` on a bare `node:http` server: a request in as a `Request`, its `Response` written out. */
function listen(handle: (request: Request) => Promise<Response>): Server {
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
    const post = (headers: Record<string, string>) =>
      fetch(`${origin}/api/pods`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
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

    it("is exported by `cascade-runtime/app`", () => {
      assert.equal(typeof appHandler, "function");
    });

    it("answers 403 to a request from another site, whatever cookie it holds", async () => {
      const refused = await post({ origin: "http://evil.example", cookie });
      assert.equal(refused.status, 403);
      assert.deepEqual(await refused.json(), {
        refused: "a request from another site",
      });
    });

    it("answers 403 to a request from the app's own origin that holds no launch cookie", async () => {
      const refused = await post({ origin });
      assert.equal(refused.status, 403);
      assert.match(
        ((await refused.json()) as { refused: string }).refused,
        /address .* printed/,
      );
    });

    it("returns the pods' names to a request that holds the launch cookie", async () => {
      const answered = await post({ origin, cookie });
      assert.equal(answered.status, 200);
      const { pods } = (await answered.json()) as { pods: { name: string }[] };
      assert.deepEqual(
        pods.map(({ name }) => name),
        ["alex-rivera"],
      );
    });
  });
});
