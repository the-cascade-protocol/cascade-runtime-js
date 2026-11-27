import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BRIDGE_REPOSITORY } from "@cascade-runtime/runtime/node";

/** Where scripts/builds.mjs records the builds it installed, which `npm ci` deletes with node_modules. */
export const RECORD = join("node_modules", ".cascade-builds.json");

/** The packages the runtime is tested with and does not carry, and the repository that builds each. */
const TESTED_WITH = {
  "cascade-reference-tables":
    "https://github.com/the-cascade-protocol/cascade-reference-tables",
  "@the-cascade-protocol/sandbox":
    "https://github.com/the-cascade-protocol/cascade-sandbox",
} as const;

/** A build of a package this one is tested and packed with and does not carry, which an app installs beside it. */
export interface TestedBuild {
  readonly name: string;
  readonly repository: string;
  readonly commit: string;
  readonly how: string;
  readonly file: string;
  readonly integrity: string;
  readonly address: string | null;
}

export interface Release {
  readonly address: string;
  readonly mcp: string;
  readonly commit: string;
  readonly files: readonly {
    readonly file: string;
    readonly integrity: string;
  }[];
  readonly carried: readonly {
    readonly name: string;
    readonly iri: string;
    readonly commit: string;
  }[];
  readonly bridge: { readonly release: string; readonly commit: string };
  readonly breaking: string;
  readonly tested: readonly TestedBuild[];
}

/** The name `npm pack` gives the file of a package at a version. */
function packedName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

/**
 * The build of each package the runtime is tested with that node_modules under `root` holds: as scripts/builds.mjs
 * recorded it when it installed it, else as package-lock.json names it, which `npm ci` installs. A package held at a
 * build neither names is refused, as a release could not say what it was tested with.
 */
export async function testedBuilds(root: string): Promise<TestedBuild[]> {
  const recordPath = join(root, RECORD);
  const record = existsSync(recordPath)
    ? ((await json(recordPath)) as Record<string, Omit<TestedBuild, "name">>)
    : {};
  const { packages } = (await json(join(root, "package-lock.json"))) as {
    packages: Record<
      string,
      { version: string; resolved: string; integrity: string }
    >;
  };
  const tested: TestedBuild[] = [];
  for (const [name, repository] of Object.entries(TESTED_WITH)) {
    const { version } = (await json(
      join(root, "node_modules", ...name.split("/"), "package.json"),
    )) as { version: string };
    const recorded = record[name];
    const locked = packages[`node_modules/${name}`];
    if (recorded?.file === packedName(name, version)) {
      tested.push({ name, ...recorded });
    } else if (recorded === undefined && locked?.version === version) {
      tested.push({
        name,
        repository,
        commit: /-commit-([0-9a-f]{40})$/.exec(version)?.[1] ?? version,
        how: "the build package-lock.json names, as `npm ci` installed it",
        file: basename(locked.resolved),
        integrity: locked.integrity,
        address: locked.resolved,
      });
    } else {
      throw new Error(
        `node_modules holds ${name} ${version}, which is neither the build ${RECORD} records nor the one package-lock.json names: run \`npm ci\`, then \`npm run builds\``,
      );
    }
  }
  return tested;
}

/** What a build is installed from: its address, or its file where it is at none. */
function source({ address, file }: Pick<TestedBuild, "address" | "file">) {
  return address ?? file;
}

export function releaseNotes(release: Release): string {
  const { address, mcp, commit, files, carried, bridge, breaking, tested } =
    release;
  return [
    ...(breaking === "" ? [] : [breaking]),
    "```sh",
    `npm install ${address}`,
    "```",
    "",
    "With cascade-mcp, an MCP server over a folder of pods: install both in one `npm install`, then run `npx --no-install cascade-mcp --pods <folder>` in that folder.",
    "",
    "```sh",
    `npm install ${address} ${mcp}`,
    "```",
    "",
    `Built from commit ${commit}.`,
    "",
    "| File | Integrity |",
    "| --- | --- |",
    ...files.map(({ file, integrity }) => `| ${file} | \`${integrity}\` |`),
    "",
    "It carries:",
    "",
    "| Component | Tree | Commit |",
    "| --- | --- | --- |",
    ...carried.map(
      ({ name, iri, commit: at }) => `| ${name} | <${iri}> | \`${at}\` |`,
    ),
    `| cascade-bridge-rs | [${bridge.release}](${BRIDGE_REPOSITORY}/releases/tag/${bridge.release}) | \`${bridge.commit}\` |`,
    "",
    "It was tested and packed with these builds, which it does not carry:",
    "",
    "| Package | Build | Commit | Integrity |",
    "| --- | --- | --- | --- |",
    ...tested.map(
      (build) =>
        `| ${build.name} | ${build.address === null ? `\`${build.file}\`` : `<${build.address}>`} | \`${build.commit}\` | \`${build.integrity}\` |`,
    ),
    "",
    `How each was picked: ${tested.map(({ name, how }) => `${name}, ${how}`).join("; ")}.`,
    "",
  ].join("\n");
}

/**
 * A Markdown file the package ships: the package's install line where it says `<!-- INSTALL -->`, and the line that
 * installs the reference tables' build it was tested with where it says `<!-- TABLES -->`.
 */
export function shipped(
  text: string,
  address: string,
  tested: readonly Pick<TestedBuild, "name" | "address" | "file">[],
): string {
  const tables = tested.find(({ name }) => name === "cascade-reference-tables");
  return text
    .split(/\r?\n/)
    .flatMap((line) =>
      line === "<!-- INSTALL -->"
        ? ["```sh", `npm install ${address}`, "```"]
        : line === "<!-- TABLES -->" && tables !== undefined
          ? ["```sh", `npm install --save-exact ${source(tables)}`, "```"]
          : [line],
    )
    .join("\n");
}
