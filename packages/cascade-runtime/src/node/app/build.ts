// What a build of an app on `cascade-runtime/app` carries beside its bundle, which `cascadeRuntime({ app: true })` adds.
// Both targets: what the About box says, on the body. The browser target, which runs PodApi in the page: the demo
// hospitals' service worker, unhashed at the base so that its scope is the app's, with one data file per hospital; the
// demo people and hospitals the page reads; the page a sign-in returns to. The sandbox package, which holds the demo
// hospitals, is the app's own dependency, read only here.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_WORKER = "demo-hospital-worker.js";
const WORKER_DATA = "demo-hospitals/";

const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const escaped = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");

/**
 * `html` with the About box's attributes on its body. `CASCADE_NAME`, `CASCADE_VERSION` and `CASCADE_CODE` name the app,
 * what it was built from and where its code is (the app's `package.json` by default; no link when it names none),
 * `CASCADE_HUB` the page it leads back to from the Help menu and the About box (none by default), and, in the browser
 * build, `CASCADE_SAMPLES` the samples a first visit copies, by folder, beside the base.
 */
export async function aboutBody(
  html: string,
  {
    root,
    runtime,
    browser,
    env = process.env,
  }: {
    root: string;
    runtime: string;
    browser: boolean;
    env?: Record<string, string | undefined>;
  },
): Promise<string> {
  const app = await json<{
    name: string;
    version: string;
    repository?: string | { url?: string };
    homepage?: string;
  }>(join(root, "package.json"));
  const body: Record<string, string> = {
    "data-name": env["CASCADE_NAME"] ?? app.name,
    "data-version": env["CASCADE_VERSION"] ?? app.version,
    "data-runtime": runtime,
    "data-code":
      env["CASCADE_CODE"] ??
      (typeof app.repository === "string"
        ? app.repository
        : app.repository?.url) ??
      app.homepage ??
      "",
    "data-hub": env["CASCADE_HUB"] ?? "",
    ...(browser && { "data-samples": env["CASCADE_SAMPLES"] ?? "" }),
  };
  const attributes = Object.entries(body)
    .map(([name, value]) => ` ${name}="${escaped(value)}"`)
    .join("");
  return html.replace(/<body([^>]*)>/, `<body$1${attributes}>`);
}

/** The demo hospitals' service worker, one classic script. */
async function workerScript(): Promise<string> {
  const { build } = await import("vite");
  const output = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(
          import.meta.resolve("@the-cascade-protocol/sandbox/web/worker"),
        ),
        formats: ["iife"],
        name: "demoHospitals",
      },
    },
  });
  const [built] = Array.isArray(output) ? output : [output];
  const chunk =
    built !== undefined && "output" in built ? built.output[0] : undefined;
  if (chunk?.type !== "chunk") throw new Error("the worker built no script");
  return chunk.code;
}

const signedIn = (runtime: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing in</title>
<script type="importmap">${JSON.stringify({ imports: { "cascade-runtime": `${runtime}index.js` } })}</script>
<script type="module">import { finishSignIn } from "cascade-runtime"; finishSignIn();</script>
</head>
<body>
<main><p>Signing you in…</p></main>
</body>
</html>
`;

/**
 * The files the browser target serves at the base for its demo hospitals, by file name: the worker, a data file for
 * each hospital, the brands, the demo people, and the page a sign-in returns to, which loads the runtime from `folder`.
 */
export async function demoFiles(folder: string): Promise<Map<string, string>> {
  const { brandsBundle, hospitalId } =
    await import("@the-cascade-protocol/sandbox");
  const { loadHospitals } = await import("@the-cascade-protocol/sandbox/node");
  const { demoPeople } = await import("../../app/said.js");
  const hospitals = await loadHospitals();
  const files = new Map<string, string>([[DEMO_WORKER, await workerScript()]]);
  for (const loaded of hospitals)
    files.set(
      `${WORKER_DATA}${hospitalId(loaded)}.json`,
      JSON.stringify(loaded),
    );
  files.set(
    "demo-brands.json",
    JSON.stringify(
      brandsBundle(
        hospitals.map(({ hospital }) => hospital),
        new Date().toISOString(),
      ),
    ),
  );
  files.set("demo-people.json", JSON.stringify(demoPeople(hospitals)));
  files.set("signed-in.html", signedIn(`./${folder}`));
  return files;
}
