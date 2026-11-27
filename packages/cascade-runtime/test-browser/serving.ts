// What the packed package's browser tests share: the folder of the packed package, and a server that gives it, as an app
// serves its files beside its bundle.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = fileURLToPath(
  new URL("../../../../build/package/", import.meta.url),
);

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".ttl": "text/turtle",
  ".rq": "text/plain",
};

/**
 * Serves the packed package's folder, and under `extra` the files a test makes, by their paths. `/` is an empty page, so
 * that a test's scripts are imported by their paths under the package.
 */
export function serving(
  extra: ReadonlyMap<string, Uint8Array> = new Map(),
): Promise<Server> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(
      new URL(request.url ?? "/", "http://x").pathname,
    );
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>pod</title>");
      return;
    }
    const made = extra.get(path);
    if (made !== undefined) {
      response.writeHead(200, {
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      });
      response.end(made);
      return;
    }
    const file = normalize(join(PACKAGE, path));
    if (!file.startsWith(PACKAGE)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file)
      .then((bytes) => {
        response.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        });
        response.end(bytes);
      })
      .catch(() => response.writeHead(404).end());
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}
