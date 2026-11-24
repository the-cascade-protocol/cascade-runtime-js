// The steps compatibility.json gives the compatibility check for this runtime's one host.
//   node scripts/compatibility-host.mjs setup                the install, then the native Oxigraph build where it is relied on
//   node scripts/compatibility-host.mjs conformance <args>   `npm run conformance -- <args>`, on the engine it names
// On Linux x64, every repository's compatibility run of this runtime uses the published native build, as a pull
// request's `conformance (native)` job does. `CASCADE_OXIGRAPH` names another engine for a run that means to, and
// `CASCADE_OXIGRAPH_NATIVE` a build already made, which the fetch would otherwise replace with the published one.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const INSTALL = ["npm", "ci"];
const FETCH = ["npm", "run", "--silent", "oxigraph:fetch"];

/** The engine this run is on, or none where nothing has been said and no published build is relied on. */
function engineOf(env, platform, arch) {
  if (env.CASCADE_OXIGRAPH) return env.CASCADE_OXIGRAPH;
  return platform === "linux" && arch === "x64" ? "native" : undefined;
}

/** The commands the host's setup runs, in order. */
export function setupSteps(
  env = process.env,
  platform = process.platform,
  arch = process.arch,
) {
  const fetched =
    engineOf(env, platform, arch) === "native" && !env.CASCADE_OXIGRAPH_NATIVE;
  return fetched ? [INSTALL, FETCH] : [INSTALL];
}

/** The environment the conformance command runs in. */
export function conformanceEnv(
  env = process.env,
  platform = process.platform,
  arch = process.arch,
) {
  const engine = engineOf(env, platform, arch);
  return engine === undefined
    ? { ...env }
    : { ...env, CASCADE_OXIGRAPH: engine };
}

function run(argv, env) {
  // npm is npm.cmd on Windows, which spawn starts only through a shell, so an argument is quoted there.
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync(
        [argv[0], ...argv.slice(1).map((one) => `"${one}"`)].join(" "),
        {
          stdio: "inherit",
          env,
          shell: true,
        },
      )
    : spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(mode, rest) {
  if (mode === "setup") {
    for (const step of setupSteps()) {
      const status = run(step, process.env);
      if (status !== 0) {
        if (step === FETCH)
          process.stderr.write(
            "compatibility-host: Oxigraph's native build could not be fetched or does not load here, and this run relies on it " +
              "(Linux x64). To run on the WebAssembly build instead, set CASCADE_OXIGRAPH=wasm for the run; to use a build " +
              "already made, set CASCADE_OXIGRAPH_NATIVE to its file.\n",
          );
        return status;
      }
    }
    return 0;
  }
  if (mode === "conformance")
    return run(
      ["npm", "run", "--silent", "conformance", "--", ...rest],
      conformanceEnv(),
    );
  process.stderr.write(
    "usage: node scripts/compatibility-host.mjs setup | conformance <conformance arguments>\n",
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, ...rest] = process.argv.slice(2);
  process.exitCode = main(mode, rest);
}
