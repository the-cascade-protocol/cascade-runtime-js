import { join } from "node:path";
import { Refusal, titleOf } from "@cascade-runtime/runtime";
import type { LocalVocabulary } from "@cascade-runtime/runtime/node";
import {
  downloadsImportedBy,
  type KitStep,
  kitsIn,
  replayKitFrom,
} from "./node/kits.js";
import { installedParts, resolved } from "./node/resolved.js";
import { acceptOptions } from "./options.js";
import type { Tables } from "./tables.js";

export type SampleStep = KitStep;

export interface SamplePerson {
  /** The name `loadSample` and `sampleExport` take, as `alex-rivera`. */
  readonly person: string;
  /** The person's own name, as `Alex Rivera`. */
  readonly title: string;
  /** The names `sampleExport` takes for this person, in the order the person's story brings them in: each is the name of the download in the kit, as `harbourline-2022`. */
  readonly exports: readonly string[];
}

/** Refuses a person the package does not carry, naming those it does. */
async function knownPerson(
  local: LocalVocabulary,
  person: string,
): Promise<void> {
  const people = (await kitsIn(local)).map(({ name }) => name);
  if (!people.includes(person))
    throw new Refusal(
      `there is no sample person ${person}; there are ${people.join(", ")}`,
    );
}

/**
 * The made-up people the package carries, each with the names of the exports its story brings in. Nothing is written
 * and no tables are made.
 */
export async function samplePeople(): Promise<readonly SamplePerson[]> {
  const { local } = await installedParts();
  const people: SamplePerson[] = [];
  for (const { name, folder } of await kitsIn(local))
    people.push({
      person: name,
      title: await titleOf(local.files, folder),
      exports: (await downloadsImportedBy(local, name)).map(
        (download) => download.name,
      ),
    });
  return people;
}

/**
 * The path of one export of a sample person, by the name of its download in the kit, which `samplePeople` lists: the
 * folder of an Apple Health export, a C-CDA file a portal handed out, or the folder of a saved pull. It is what `look`
 * and `import` take. A person or an export it does not have is refused, naming those it does.
 */
export async function sampleExport(
  person: string,
  name: string,
): Promise<string> {
  const { local } = await installedParts();
  await knownPerson(local, person);
  const downloads = await downloadsImportedBy(local, person);
  const found = downloads.find((download) => download.name === name);
  if (found === undefined)
    throw new Refusal(
      `${person} has no export ${name}; ${person} has ${downloads.map((download) => download.name).join(", ")}`,
    );
  return join(local.files.folder, ...found.path.split("/"));
}

/**
 * A sample person's pod, made in a missing or empty folder as `npm run reset` makes it: the person's story performed on
 * the reference tables of the folder's app, through the step named or to the end. A person the package does not carry is
 * refused, naming those it does. Returns the steps it performed.
 */
export async function loadSample(
  person: string,
  folder: string,
  options: { through?: string; tables?: Tables } = {},
): Promise<readonly SampleStep[]> {
  acceptOptions("loadSample", options, { through: true, tables: true });
  const parts = await resolved();
  await knownPerson(parts.local, person);
  return replayKitFrom(parts, person, folder, options);
}
