import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BUILDS = join(ROOT, "scripts", "builds.mjs");

const TABLES = "cascade-reference-tables";
const SANDBOX = "@the-cascade-protocol/sandbox";
const TABLES_REPOSITORY = "the-cascade-protocol/cascade-reference-tables";
const SANDBOX_REPOSITORY = "the-cascade-protocol/cascade-sandbox";
const commit = (digit: string) => digit.repeat(40);
const tablesFile = (at: string) => `${TABLES}-0.0.0-commit-${at}.tgz`;
const sandboxFile = (at: string) =>
  `the-cascade-protocol-sandbox-0.0.0-commit-${at}.tgz`;
const tablesAddress = (at: string) =>
  `https://github.com/${TABLES_REPOSITORY}/releases/download/package-builds/${tablesFile(at)}`;
const sandboxAddress = (at: string) =>
  `https://github.com/${SANDBOX_REPOSITORY}/releases/download/build-${at}/${sandboxFile(at)}`;

/** A package tarball of `name` at `version`, which npm installs with no network. */
function tarball(name: string, version: string): Buffer {
  const body = Buffer.from(JSON.stringify({ name, version }));
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
    148,
    "ascii",
  );
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

const tablesBuild = (at: string) => tarball(TABLES, `0.0.0-commit-${at}`);
const sandboxBuild = (at: string) => tarball(SANDBOX, `0.0.0-commit-${at}`);
const digestOf = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const integrityOf = (bytes: Buffer) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

type Answers = Record<string, unknown>;

/** The answers GitHub gave, recorded: what `scripts/builds.mjs` asks of it, by path, and the bytes of each download. */
function world(
  options: {
    tablesBuilt?: string[];
    digestOfTables?: (bytes: Buffer) => string;
    sandboxPages?: string[][];
  } = {},
): Answers {
  const {
    tablesBuilt = [commit("2"), commit("3")],
    digestOfTables = digestOf,
    sandboxPages = [[commit("4")]],
  } = options;
  const asset = (name: string, address: string, digest: string) => ({
    name,
    browser_download_url: address,
    digest,
  });
  const answers: Answers = {
    [`repos/${TABLES_REPOSITORY}/commits?per_page=100`]: [
      commit("1"),
      commit("2"),
      commit("3"),
    ].map((sha) => ({ sha })),
    [`repos/${TABLES_REPOSITORY}/releases/tags/package-builds`]: { id: 7 },
    [`repos/${TABLES_REPOSITORY}/releases/7/assets?per_page=100&page=1`]:
      tablesBuilt.map((at) =>
        asset(
          tablesFile(at),
          tablesAddress(at),
          digestOfTables(tablesBuild(at)),
        ),
      ),
    [`repos/${SANDBOX_REPOSITORY}/commits?per_page=100`]: [
      commit("4"),
      commit("5"),
    ].map((sha) => ({ sha })),
  };
  for (const at of tablesBuilt)
    answers[tablesAddress(at)] = tablesBuild(at).toString("base64");
  sandboxPages.forEach((commits, index) => {
    const releases = commits.map((at) => ({
      tag_name: `build-${at}`,
      assets: [
        asset(sandboxFile(at), sandboxAddress(at), digestOf(sandboxBuild(at))),
      ],
    }));
    const path = `repos/${SANDBOX_REPOSITORY}/releases?per_page=100`;
    if (index === 0) answers[path] = releases;
    answers[`${path}&page=${index + 1}`] = releases;
    for (const at of commits)
      answers[sandboxAddress(at)] = sandboxBuild(at).toString("base64");
  });
  return answers;
}

/** A page of 100 sandbox builds of commits other than the ones the cases name. */
const FULL_PAGE = Array.from({ length: 100 }, (_, index) =>
  index.toString(16).padStart(40, "e"),
);

const FETCH = `
import { readFileSync } from "node:fs";
const answers = JSON.parse(readFileSync(process.env.BUILDS_ANSWERS, "utf8"));
globalThis.fetch = async (url) => {
  const hit = answers[String(url).replace("https://api.github.com/", "")];
  if (hit === undefined) return new Response("not recorded", { status: 404 });
  return typeof hit === "string" ? new Response(Buffer.from(hit, "base64")) : Response.json(hit);
};
`;

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Runs `node scripts/builds.mjs <args>` in a new workspace, over `answers`, which no network is asked for. */
async function builds(args: string[], answers: Answers) {
  const root = await mkdtemp(join(tmpdir(), "cr-builds-"));
  roots.push(root);
  const workspace = join(root, "ws");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ name: "ws", private: true }),
  );
  await writeFile(join(root, "fetch.mjs"), FETCH);
  await writeFile(join(root, "answers.json"), JSON.stringify(answers));
  const run = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(join(root, "fetch.mjs")).href, BUILDS, ...args],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        BUILDS_ANSWERS: join(root, "answers.json"),
        npm_config_offline: "true",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
      },
    },
  );
  const recordPath = join(workspace, "node_modules", ".cascade-builds.json");
  return {
    status: run.status,
    out: run.stdout + run.stderr,
    workspace,
    record: existsSync(recordPath)
      ? (JSON.parse(await readFile(recordPath, "utf8")) as Record<
          string,
          Record<string, unknown>
        >)
      : undefined,
  };
}

const installed = async (workspace: string, name: string) =>
  (
    JSON.parse(
      await readFile(
        join(workspace, "node_modules", ...name.split("/"), "package.json"),
        "utf8",
      ),
    ) as { version: string }
  ).version;

/**
 * The tool that installs the reference tables' and the sandbox's newest builds over the ones package-lock.json names,
 * and records them where the pack reads them, run in a workspace over the answers GitHub gave and no network.
 */
describe("Installing the newest builds of the tables and the sandbox · scripts/builds.mjs", () => {
  it("installs the newest build of each default branch that has one, and records each with how far behind its head it is", async () => {
    const run = await builds([], world());
    assert.equal(run.status, 0, run.out);
    assert.equal(
      await installed(run.workspace, TABLES),
      `0.0.0-commit-${commit("2")}`,
    );
    assert.equal(
      await installed(run.workspace, SANDBOX),
      `0.0.0-commit-${commit("4")}`,
    );
    assert.deepEqual(run.record?.[TABLES], {
      repository: `https://github.com/${TABLES_REPOSITORY}`,
      commit: commit("2"),
      how: `the newest build of its default branch, 1 commits behind its head ${commit("1")}, which has no build`,
      file: tablesFile(commit("2")),
      address: tablesAddress(commit("2")),
      integrity: integrityOf(tablesBuild(commit("2"))),
    });
    assert.equal(
      run.record?.[SANDBOX]?.how,
      "the newest build of its default branch",
    );
    assert.equal(run.record?.[SANDBOX]?.address, sandboxAddress(commit("4")));
  });

  it("finds a sandbox build named by its commit among more releases than one page holds", async () => {
    const run = await builds(
      ["--sandbox", "9999"],
      world({ sandboxPages: [FULL_PAGE, [commit("9")]] }),
    );
    assert.equal(run.status, 0, run.out);
    assert.equal(
      await installed(run.workspace, SANDBOX),
      `0.0.0-commit-${commit("9")}`,
    );
    assert.equal(run.record?.[SANDBOX]?.how, "the build named");
  });

  it("refuses what it cannot install as what was asked, naming why", async () => {
    const refused: [string, string[], Answers, RegExp][] = [
      [
        "an option it does not know",
        ["--sandbx", "9"],
        world(),
        /usage: npm run builds/,
      ],
      [
        "an option with no value",
        ["--tables"],
        world(),
        /usage: npm run builds/,
      ],
      [
        "a file not named as a build of the package",
        ["--tables", "other.tgz"],
        world(),
        /other\.tgz is not named as a build of cascade-reference-tables/,
      ],
      [
        "a commit no build of the package starts with",
        ["--tables", "ffff"],
        world(),
        /has 0 builds of a commit starting ffff, where one is wanted/,
      ],
      [
        "a commit more than one build starts with",
        ["--tables", "a"],
        world({ tablesBuilt: [`a1${"0".repeat(38)}`, `a2${"0".repeat(38)}`] }),
        /has 2 builds of a commit starting a, where one is wanted/,
      ],
      [
        "a default branch none of whose last commits has a build",
        [],
        world({ tablesBuilt: [] }),
        /none of the last 3 commits of the-cascade-protocol\/cascade-reference-tables's default branch has a build/,
      ],
      [
        "a download that is not the file GitHub gave a digest for",
        [],
        world({ digestOfTables: () => `sha256:${"0".repeat(64)}` }),
        /does not match GitHub's sha256 digest of it/,
      ],
      [
        "a download GitHub does not serve",
        [],
        (() => {
          const answers = world();
          delete answers[tablesAddress(commit("2"))];
          return answers;
        })(),
        /answered 404/,
      ],
      [
        "--install with no folder",
        ["--install"],
        world(),
        /--install needs the folder/,
      ],
    ];
    for (const [why, args, answers, message] of refused) {
      const run = await builds(args, answers);
      assert.equal(run.status, 1, `${why}: ${run.out}`);
      assert.match(run.out, message, why);
      assert.equal(run.record, undefined, `${why}: it recorded a build`);
    }
  });

  it("refuses to record a file that installs as another build than its name says, as a pick of CI's would be", async () => {
    const root = await mkdtemp(join(tmpdir(), "cr-builds-folder-"));
    roots.push(root);
    const file = tablesFile(commit("2"));
    await writeFile(join(root, file), tablesBuild(commit("3")));
    await writeFile(
      join(root, "builds.json"),
      JSON.stringify({
        [TABLES]: {
          repository: `https://github.com/${TABLES_REPOSITORY}`,
          commit: commit("2"),
          how: "the newest build of its default branch",
          file,
          address: tablesAddress(commit("2")),
        },
      }),
    );
    const run = await builds(["--install", root], {});
    assert.equal(run.status, 1, run.out);
    assert.match(
      run.out,
      new RegExp(
        `node_modules holds ${TABLES} 0\\.0\\.0-commit-${commit("3")}, not ${file}`,
      ),
    );
    assert.equal(run.record, undefined);
  });
});
