// The reference tables' and the sandbox's builds this checkout tests with, installed over the ones package-lock.json
// names, which are only what a fresh clone's `npm ci` gets so that it builds.
//   npm run builds [-- --tables <commit|file.tgz>] [--sandbox <commit|file.tgz>]
//       the newest build of each default branch, or the build of the commit or the file named: downloaded and checked
//       against GitHub's digest of it, installed, and recorded in node_modules/.cascade-builds.json, where the pack reads
//       it for the release's notes. `npm ci` deletes node_modules, the record with it: run this again after one.
//   node scripts/builds.mjs --install <folder>
//       CI: installs the files <folder>/builds.json names, as the `builds` job of check.yml picked and recorded them.
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const RECORD = join("node_modules", ".cascade-builds.json");
const API = "https://api.github.com";
const CACHE = join("build", "cache", "builds");

/** Each package, by its name on npm: the repository that builds it, where its builds are, and how a build's file is named. */
export const PRODUCERS = {
  "cascade-reference-tables": {
    repository: "the-cascade-protocol/cascade-reference-tables",
    option: "--tables",
    file: /^cascade-reference-tables-0\.0\.0-commit-([0-9a-f]{40})\.tgz$/,
    release: "package-builds",
  },
  "@the-cascade-protocol/sandbox": {
    repository: "the-cascade-protocol/cascade-sandbox",
    option: "--sandbox",
    file: /^the-cascade-protocol-sandbox-0\.0\.0-commit-([0-9a-f]{40})\.tgz$/,
    release: undefined,
  },
};

/** The newest of `commits`, newest first, that has a build, and how many commits behind the first it is. */
export function newestBuilt(commits, built) {
  const behind = commits.findIndex((commit) => built.has(commit));
  if (behind < 0) return undefined;
  return { commit: commits[behind], behind };
}

async function read(path) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(`${API}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok)
    throw new Error(`GitHub answered ${response.status} to ${path}`);
  return response.json();
}

/** Every build of the package, by commit: the asset of its release that holds the file. */
async function buildsOf({ repository, file, release }) {
  const assets = [];
  if (release === undefined) {
    for (let page = 1; ; page += 1) {
      const held = await read(
        `repos/${repository}/releases?per_page=100&page=${page}`,
      );
      for (const { tag_name: tag, assets: files } of held)
        if (tag.startsWith("build-")) assets.push(...files);
      if (held.length < 100) break;
    }
  } else {
    const { id } = await read(`repos/${repository}/releases/tags/${release}`);
    for (let page = 1; ; page += 1) {
      const held = await read(
        `repos/${repository}/releases/${id}/assets?per_page=100&page=${page}`,
      );
      assets.push(...held);
      if (held.length < 100) break;
    }
  }
  const built = new Map();
  for (const asset of assets) {
    const commit = file.exec(asset.name)?.[1];
    if (commit !== undefined) built.set(commit, asset);
  }
  return built;
}

async function downloaded(asset) {
  const response = await fetch(asset.browser_download_url);
  if (!response.ok)
    throw new Error(
      `${asset.browser_download_url} answered ${response.status}`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, digest] = String(asset.digest ?? "").split(":");
  if (algorithm && createHash(algorithm).update(bytes).digest("hex") !== digest)
    throw new Error(
      `${asset.name} does not match GitHub's ${algorithm} digest of it`,
    );
  mkdirSync(CACHE, { recursive: true });
  const path = resolve(CACHE, asset.name);
  writeFileSync(path, bytes);
  return path;
}

function integrityOf(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

/** The build of `name` named by `named` (a commit, or a file), else the newest of its default branch. */
async function picked(name, named) {
  const producer = PRODUCERS[name];
  const repository = `https://github.com/${producer.repository}`;
  if (named?.endsWith(".tgz")) {
    const path = resolve(named);
    const commit = producer.file.exec(basename(path))?.[1];
    if (commit === undefined)
      throw new Error(`${named} is not named as a build of ${name} is`);
    return {
      path,
      record: {
        repository,
        commit,
        how: "the file named",
        file: basename(path),
        address: null,
      },
    };
  }
  const built = await buildsOf(producer);
  let commit;
  let how;
  if (named !== undefined) {
    const matching = [...built.keys()].filter((one) => one.startsWith(named));
    if (matching.length !== 1)
      throw new Error(
        `${producer.repository} has ${matching.length} builds of a commit starting ${named}, where one is wanted`,
      );
    [commit] = matching;
    how = "the build named";
  } else {
    const commits = (
      await read(`repos/${producer.repository}/commits?per_page=100`)
    ).map(({ sha }) => sha);
    const newest = newestBuilt(commits, new Set(built.keys()));
    if (newest === undefined)
      throw new Error(
        `none of the last ${commits.length} commits of ${producer.repository}'s default branch has a build`,
      );
    ({ commit } = newest);
    how =
      newest.behind === 0
        ? "the newest build of its default branch"
        : `the newest build of its default branch, ${newest.behind} commits behind its head ${commits[0]}, which has no build`;
  }
  const asset = built.get(commit);
  return {
    path: await downloaded(asset),
    record: {
      repository,
      commit,
      how,
      file: asset.name,
      address: asset.browser_download_url,
    },
  };
}

function npm(args) {
  const cli = process.env.npm_execpath;
  // npm is npm.cmd on Windows, which spawn starts only through a shell, so an argument is quoted there.
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" })
    : process.platform === "win32"
      ? spawnSync(["npm", ...args.map((one) => `"${one}"`)].join(" "), {
          stdio: "inherit",
          shell: true,
        })
      : spawnSync("npm", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm ${args[0]} exited ${result.status}`);
}

/** Installs each picked file over the build package-lock.json names, and records the picks beside them. */
function install(picks) {
  npm([
    "install",
    "--no-save",
    "--no-audit",
    "--no-fund",
    ...Object.values(picks).map(({ path }) => path),
  ]);
  const record = {};
  for (const [name, { path, record: one }] of Object.entries(picks)) {
    const { version } = JSON.parse(
      readFileSync(
        join("node_modules", ...name.split("/"), "package.json"),
        "utf8",
      ),
    );
    if (
      !PRODUCERS[name]?.file.test(one.file) ||
      !one.file.endsWith(`-${version}.tgz`)
    )
      throw new Error(`node_modules holds ${name} ${version}, not ${one.file}`);
    record[name] = { ...one, integrity: one.integrity ?? integrityOf(path) };
    process.stdout.write(`${name}: ${one.file}, ${one.how}\n`);
  }
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

async function main(argv) {
  if (argv[0] === "--install") {
    const folder = argv[1];
    if (folder === undefined)
      throw new Error(
        "--install needs the folder the builds job's artifact is in",
      );
    const recorded = JSON.parse(
      readFileSync(join(folder, "builds.json"), "utf8"),
    );
    install(
      Object.fromEntries(
        Object.entries(recorded).map(([name, one]) => [
          name,
          { path: resolve(folder, one.file), record: one },
        ]),
      ),
    );
    return;
  }
  const named = {};
  for (let at = 0; at < argv.length; at += 2) {
    const name = Object.keys(PRODUCERS).find(
      (one) => PRODUCERS[one].option === argv[at],
    );
    if (name === undefined || argv[at + 1] === undefined)
      throw new Error(
        `usage: npm run builds [-- --tables <commit|file.tgz>] [--sandbox <commit|file.tgz>]`,
      );
    named[name] = argv[at + 1];
  }
  const picks = {};
  for (const name of Object.keys(PRODUCERS))
    picks[name] = await picked(name, named[name]);
  install(picks);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`builds: ${error.message}\n`);
    process.exitCode = 1;
  });
