import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** Where scripts/builds.mjs records the builds it installed, which `npm ci` deletes with node_modules. */
export const RECORD = join("node_modules", ".cascade-builds.json");

/** How `testedBuilds()` says a build is the one package-lock.json names, which `npm ci` installs. */
export const LOCKED_HOW =
  "the build package-lock.json names, as `npm ci` installed it";

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

/** The name `npm pack` gives the file of a package at a version. */
function packedName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

/** The integrity npm wrote for `name` when it installed it, where it wrote one: node_modules/.package-lock.json. */
async function installedIntegrity(
  root: string,
  name: string,
): Promise<string | undefined> {
  const path = join(root, "node_modules", ".package-lock.json");
  if (!existsSync(path)) return undefined;
  const { packages } = (await json(path)) as {
    packages?: Record<string, { integrity?: string }>;
  };
  return packages?.[`node_modules/${name}`]?.integrity;
}

/**
 * The build of each package the runtime is tested with that node_modules under `root` holds: as scripts/builds.mjs
 * recorded it when it installed it, else as package-lock.json names it, which `npm ci` installs. A package held at a
 * build neither names is refused, as a release could not say what it was tested with. A build counts as the one a
 * record or the lock names only when the integrity npm wrote for what it installed is that build's, where npm wrote one:
 * a file of the same name installed from other bytes is not it.
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
    const held = await installedIntegrity(root, name);
    const recorded = record[name];
    const locked = packages[`node_modules/${name}`];
    if (
      recorded?.file === packedName(name, version) &&
      (held === undefined || held === recorded.integrity)
    ) {
      tested.push({ name, ...recorded });
    } else if (
      recorded === undefined &&
      locked?.version === version &&
      (held === undefined || held === locked.integrity)
    ) {
      tested.push({
        name,
        repository,
        commit: /-commit-([0-9a-f]{40})$/.exec(version)?.[1] ?? version,
        how: LOCKED_HOW,
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

/**
 * The line a local test run opens with, naming the build of each package it runs on and whether it is the one committed
 * or one picked, so a plain `npm install` that put the committed ones back is seen. It never refuses a run.
 */
export async function testedLine(root: string): Promise<string> {
  try {
    const parts = (await testedBuilds(root)).map(
      ({ name, commit, how }) =>
        `${name} ${commit.slice(0, 8)} (${how === LOCKED_HOW ? "the committed default, which package-lock.json names: `npm run builds` installs the newest" : `picked: ${how}`})`,
    );
    return `Builds under test: ${parts.join("; ")}`;
  } catch (error) {
    return `Builds under test: ${error instanceof Error ? error.message : String(error)}`;
  }
}
