import { join } from "node:path";

/** Where scripts/builds.mjs records the builds it installed, which `npm ci` deletes with node_modules. */
export const RECORD = join("node_modules", ".cascade-builds.json");

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

export function testedBuilds(_root: string): Promise<TestedBuild[]> {
  return Promise.reject(new Error("not yet"));
}

export function releaseNotes(_release: Release): string {
  return "";
}

export function shipped(
  text: string,
  _address: string,
  _tested: readonly Pick<TestedBuild, "name" | "address" | "file">[],
): string {
  return text;
}
