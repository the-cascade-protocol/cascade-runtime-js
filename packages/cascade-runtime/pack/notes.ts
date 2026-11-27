import { BRIDGE_REPOSITORY } from "@cascade-runtime/runtime/node";
import type { TestedBuild } from "./tested.js";

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
    "How each was picked:",
    "",
    ...tested.map(({ name, how }) => `- ${name}: ${how}`),
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
