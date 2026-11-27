import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  RECORD,
  releaseNotes,
  testedBuilds,
  type TestedBuild,
} from "../pack/notes.js";

const TABLES = "a".repeat(40);
const SANDBOX = "b".repeat(40);
const LOCKED = "c".repeat(40);
const TABLES_FILE = `cascade-reference-tables-0.0.0-commit-${TABLES}.tgz`;
const SANDBOX_FILE = `the-cascade-protocol-sandbox-0.0.0-commit-${SANDBOX}.tgz`;
const TABLES_ADDRESS = `https://github.com/the-cascade-protocol/cascade-reference-tables/releases/download/package-builds/${TABLES_FILE}`;

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A checkout whose node_modules holds the tables at `tables` and the sandbox at `sandbox`, with the lock naming `LOCKED`. */
async function checkout(
  tables: string,
  sandbox: string,
  record?: unknown,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cr-notes-"));
  roots.push(root);
  const lockEntry = (file: string, at: string) => ({
    version: `0.0.0-commit-${LOCKED}`,
    resolved: `https://github.com/the-cascade-protocol/${file}/releases/download/${at}`,
    integrity: `sha512-${file}`,
  });
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/cascade-reference-tables": lockEntry(
          "cascade-reference-tables",
          `package-builds/cascade-reference-tables-0.0.0-commit-${LOCKED}.tgz`,
        ),
        "node_modules/@the-cascade-protocol/sandbox": lockEntry(
          "cascade-sandbox",
          `build-${LOCKED}/the-cascade-protocol-sandbox-0.0.0-commit-${LOCKED}.tgz`,
        ),
      },
    }),
  );
  for (const [name, commit] of [
    ["cascade-reference-tables", tables],
    ["@the-cascade-protocol/sandbox", sandbox],
  ] as const) {
    const folder = join(root, "node_modules", ...name.split("/"));
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ name, version: `0.0.0-commit-${commit}` }),
    );
  }
  if (record !== undefined)
    await writeFile(join(root, RECORD), JSON.stringify(record));
  return root;
}

const RECORDED = {
  "cascade-reference-tables": {
    repository:
      "https://github.com/the-cascade-protocol/cascade-reference-tables",
    commit: TABLES,
    how: "the newest build of its default branch",
    file: TABLES_FILE,
    integrity: "sha512-tables",
    address: TABLES_ADDRESS,
  },
  "@the-cascade-protocol/sandbox": {
    repository: "https://github.com/the-cascade-protocol/cascade-sandbox",
    commit: "d".repeat(40),
    how: "pull request #7, the package artifact of its run at its head",
    file: SANDBOX_FILE,
    integrity: "sha512-sandbox",
    address: null,
  },
};

/**
 * What a release of the package says about itself: each file it holds with its integrity, what it carries, and the
 * builds of the reference tables and the sandbox it was tested and packed with, which an app installs beside it.
 */
describe("A build's release notes and the builds it was tested with · releaseNotes(), testedBuilds()", () => {
  describe("testedBuilds(root)", () => {
    it("returns each build as scripts/builds.mjs recorded it, when node_modules holds the builds the record names", async () => {
      const tested = await testedBuilds(
        await checkout(TABLES, SANDBOX, RECORDED),
      );
      assert.deepEqual(
        tested.map(({ name, commit, file, address, integrity }) => ({
          name,
          commit,
          file,
          address,
          integrity,
        })),
        [
          {
            name: "cascade-reference-tables",
            commit: TABLES,
            file: TABLES_FILE,
            address: TABLES_ADDRESS,
            integrity: "sha512-tables",
          },
          {
            name: "@the-cascade-protocol/sandbox",
            commit: "d".repeat(40),
            file: SANDBOX_FILE,
            address: null,
            integrity: "sha512-sandbox",
          },
        ],
      );
    });

    it("returns each build package-lock.json names, as `npm ci` installed it, when nothing was recorded", async () => {
      const [tables] = await testedBuilds(await checkout(LOCKED, LOCKED));
      assert.deepEqual(tables, {
        name: "cascade-reference-tables",
        repository:
          "https://github.com/the-cascade-protocol/cascade-reference-tables",
        commit: LOCKED,
        how: "the build package-lock.json names, as `npm ci` installed it",
        file: `cascade-reference-tables-0.0.0-commit-${LOCKED}.tgz`,
        integrity: "sha512-cascade-reference-tables",
        address: `https://github.com/the-cascade-protocol/cascade-reference-tables/releases/download/package-builds/cascade-reference-tables-0.0.0-commit-${LOCKED}.tgz`,
      });
    });

    it("refuses a package node_modules holds at a build neither the record nor package-lock.json names", async () => {
      await assert.rejects(
        testedBuilds(await checkout(TABLES, "e".repeat(40), RECORDED)),
        /node_modules holds @the-cascade-protocol\/sandbox 0\.0\.0-commit-e{40}, which is neither the build .* records nor the one package-lock\.json names/,
      );
      await assert.rejects(
        testedBuilds(await checkout(TABLES, LOCKED)),
        /node_modules holds cascade-reference-tables 0\.0\.0-commit-a{40}, which is neither/,
      );
    });
  });

  describe("releaseNotes(release)", () => {
    const tested: TestedBuild[] = Object.entries(RECORDED).map(
      ([name, build]) => ({ name, ...build }),
    );
    const notes = releaseNotes({
      address: "https://example.org/cascade-runtime-0.0.0-commit-1.tgz",
      mcp: "https://example.org/cascade-mcp-0.0.0-commit-1.tgz",
      commit: "1",
      files: [
        { file: "cascade-runtime-0.0.0-commit-1.tgz", integrity: "sha512-rt" },
        { file: "cascade-mcp-0.0.0-commit-1.tgz", integrity: "sha512-mcp" },
      ],
      carried: [{ name: "cascade-vocabulary", iri: "urn:v", commit: "2" }],
      bridge: { release: "build-3", commit: "3" },
      breaking: "",
      tested,
    });
    const lines = notes.split("\n");

    it("gives each file the release holds its integrity, on a row of its own", () => {
      assert.ok(
        lines.includes("| cascade-runtime-0.0.0-commit-1.tgz | `sha512-rt` |"),
      );
      assert.ok(
        lines.includes("| cascade-mcp-0.0.0-commit-1.tgz | `sha512-mcp` |"),
      );
    });

    it("names each build it was tested with on a row: the package, the address an install takes, the commit and the integrity", () => {
      assert.ok(
        lines.includes(
          `| cascade-reference-tables | <${TABLES_ADDRESS}> | \`${TABLES}\` | \`sha512-tables\` |`,
        ),
      );
    });

    it("names a build that is at no address, a pull request's artifact, by its file", () => {
      assert.ok(
        lines.includes(
          `| @the-cascade-protocol/sandbox | \`${SANDBOX_FILE}\` | \`${"d".repeat(40)}\` | \`sha512-sandbox\` |`,
        ),
      );
    });

    it("says how each build was picked", () => {
      assert.ok(
        lines.includes(
          "How each was picked: cascade-reference-tables, the newest build of its default branch; @the-cascade-protocol/sandbox, pull request #7, the package artifact of its run at its head.",
        ),
      );
    });
  });
});
