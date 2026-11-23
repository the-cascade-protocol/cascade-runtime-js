import type { Files } from "./files.js";
import type { Layout } from "./layout.js";
import { Refusal } from "./refusal.js";
import type { StoreFactory } from "./store.js";

const REQUIRES = "http://purl.org/dc/terms/requires";
const STEM = /^[0-9a-f]{64}\.ttl$/;

/** The requirement that a pod's files held in archives be read from them (O4). */
export const READING_FILES_HELD_IN_ARCHIVES =
  "https://ns.cascadeprotocol.org/cascade#ReadingFilesHeldInArchives";

/** Every requirement this runtime meets. */
const MET: readonly string[] = [READING_FILES_HELD_IN_ARCHIVES];

/** The SHA-256 of the bytes, or of the text's UTF-8, in lower-case hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      bytes as Uint8Array<ArrayBuffer>,
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The path of the file that says the pod requires the requirement: its IRI's SHA-256 in lower-case hex, adding `.ttl` (N9). */
export async function requirementFile(
  layout: Layout,
  requirement: string,
): Promise<string> {
  const { requirementsFolder } = layout;
  if (requirementsFolder === undefined)
    throw new Error("the layout gives no folder for requirements");
  return `${requirementsFolder}${await sha256Hex(requirement)}.ttl`;
}

/** What the file of a requirement holds, the same in every pod (O4): the pod, written `<../>`, requires it. */
export function requirementBytes(requirement: string): Uint8Array {
  return new TextEncoder().encode(`<../> <${REQUIRES}> <${requirement}> .\n`);
}

/**
 * Refuses the pod, reading nothing of it but the file, when the files in the requirements' folder of `files`, as the host
 * holds them and never inside an archive, say it requires what this runtime does not meet (O4). A file named for a
 * requirement it meets is not read. Any other file named as N9 names one is read: the refusal names each requirement
 * it states that is not met, and otherwise the file, as when it states none or is no Turtle. A file with any other name
 * is a write that stopped and is ignored. A layout with no such folder requires nothing.
 */
export async function refuseUnmetRequirements(
  files: Files,
  layout: Layout,
  newStore: StoreFactory,
): Promise<void> {
  const { requirementsFolder } = layout;
  if (requirementsFolder === undefined) return;
  const listed = (await files.list(requirementsFolder)).filter((path) =>
    STEM.test(path.slice(requirementsFolder.length)),
  );
  if (listed.length === 0) return;
  const met = new Set(
    await Promise.all(MET.map((each) => requirementFile(layout, each))),
  );
  for (const path of listed) {
    if (met.has(path)) continue;
    const refusal = (why: string): Refusal =>
      new Refusal(
        `${files.iri}${path} ${why}: nothing else of the pod is read or written`,
      );
    const bytes = await files.read(path);
    if (bytes === undefined) throw refusal("is gone as it is read");
    let stated: string[];
    try {
      stated = (await newStore().parse(bytes, files.iri))
        .filter(([, predicate]) => predicate.value === REQUIRES)
        .map(([, , object]) => object.value);
    } catch {
      throw refusal("is no Turtle, so what it requires is not known");
    }
    const unmet = [...new Set(stated)].filter((each) => !MET.includes(each));
    if (unmet.length === 0)
      throw refusal("says nothing this runtime knows it requires");
    throw new Refusal(
      `the pod requires ${unmet.join(", ")}, which this runtime cannot do (${files.iri}${path}): nothing else of the pod is read or written`,
    );
  }
}
