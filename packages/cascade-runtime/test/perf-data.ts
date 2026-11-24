import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  type ImportOptions,
  type Imported,
  ownerAbout,
  type Pod,
  pullFiles,
} from "cascade-runtime";
import { componentsOf } from "@cascade-runtime/runtime/node";

/** A person's record the fhir-r4 adapter commits, by the id a row names it with, and the id of its bench/manifest.json entry. */
export const DATASETS = {
  "synthea-10y": "fhir-r4-synthea-10y-trimmed",
  "synthea-lifetime": "fhir-r4-synthea-lifetime",
} as const;
export type DatasetId = keyof typeof DATASETS;

/** The size every build runs, and the sizes a nightly or on-demand run adds. */
export const PER_BUILD: DatasetId = "synthea-10y";
export const LARGE: DatasetId = "synthea-lifetime";

export interface Dataset {
  readonly id: DatasetId;
  /** The sha256 of the uncompressed Bundle, as the adapter's manifest states it, and verified. */
  readonly sha256: string;
  readonly records: number;
  readonly bundle: object;
  readonly fhirBase: string;
  readonly patient: string;
}

async function adapterFolder(): Promise<string> {
  const given = process.env.PERF_INPUTS_DIR;
  if (given !== undefined) return given;
  const components = await componentsOf(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const adapter = components.config.adapters.find(({ repository }) =>
    repository.endsWith("cascade-bridge-adapter-fhir-r4"),
  );
  if (adapter === undefined)
    throw new Error("cascade-runtime.json names no fhir-r4 adapter");
  return (await components.resolve(adapter)).folder;
}

/** Where the adapter commits a record's gzipped Bundle, and the digest its bench/manifest.json states for the uncompressed one. */
export async function inputOf(
  id: DatasetId,
): Promise<{ path: string; sha256: string }> {
  const folder = await adapterFolder();
  const manifest = JSON.parse(
    await readFile(join(folder, "bench", "manifest.json"), "utf8"),
  ) as { inputs: { id: string; path: string; sha256: string }[] };
  const input = manifest.inputs.find(({ id: each }) => each === DATASETS[id]);
  if (input === undefined)
    throw new Error(
      `the adapter's bench/manifest.json holds no ${DATASETS[id]}`,
    );
  return { path: join(folder, input.path), sha256: input.sha256 };
}

/** One Synthea patient's record, read from the adapter's committed input and checked against the digest its manifest holds. */
export async function loadDataset(id: DatasetId): Promise<Dataset> {
  const input = await inputOf(id);
  const bytes = gunzipSync(await readFile(input.path));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.sha256)
    throw new Error(
      `${input.path} is ${sha256}, the manifest says ${input.sha256}`,
    );
  const bundle = JSON.parse(new TextDecoder().decode(bytes)) as {
    entry: {
      fullUrl: string;
      resource: { resourceType: string; id: string };
    }[];
  };
  const patient = bundle.entry.find(
    ({ resource }) => resource.resourceType === "Patient",
  );
  if (patient === undefined) throw new Error(`${input.path} has no Patient`);
  // A Bundle whose entries are named urn:uuid:… has no server; the pull is given one, as a hospital's would be.
  const served = patient.fullUrl.startsWith("https://");
  const fhirBase = served
    ? patient.fullUrl.slice(
        0,
        patient.fullUrl.lastIndexOf(`/Patient/${patient.resource.id}`),
      )
    : "https://synthea.demo.invalid/fhir";
  return {
    id,
    sha256,
    records: bundle.entry.length,
    bundle: served ? bundle : atServer(bundle, fhirBase),
    fhirBase,
    patient: patient.resource.id,
  };
}

/**
 * The Bundle as a server's pull of it would be, made in place: each entry's `fullUrl`, where it is a `urn:uuid:` (a generator's
 * name, which a Bundle holds before any server has the resource), becomes `<fhirBase>/<ResourceType>/<id>`, and each
 * `reference` that named an entry by its `urn:uuid:` becomes the relative `<ResourceType>/<id>`, as a HAPI-style server's pull
 * writes it. Nothing else is touched: an Identifier's `value` that happens to be a `urn:uuid:` is the source's identifier, not an
 * address, and a reference to a resource of no entry is left as it was. The Bundle stays a `transaction` with its `entry.request`
 * and keeps its conditional (`Practitioner?identifier=...`) and `#` references, which a server pull would not carry, so the pod
 * links to practitioners, locations and organizations less than a real pull's. It changes the Bundle given, which `loadDataset`
 * has just parsed, so a Bundle of 50 MB is not held twice.
 */
export function atServer<B extends object>(bundle: B, fhirBase: string): B {
  const { entry } = bundle as unknown as {
    entry: {
      fullUrl?: string;
      resource: { resourceType: string; id: string };
    }[];
  };
  const address = new Map<string, string>();
  const relative = new Map<string, string>();
  for (const { fullUrl, resource } of entry)
    if (fullUrl?.startsWith("urn:uuid:")) {
      const local = `${resource.resourceType}/${resource.id}`;
      address.set(fullUrl, `${fhirBase}/${local}`);
      relative.set(fullUrl, local);
    }
  const rename = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const member of value) rename(member);
      return;
    }
    const object = value as Record<string, unknown>;
    for (const [key, member] of Object.entries(object))
      if (key === "reference" && typeof member === "string")
        object[key] = relative.get(member) ?? member;
      else rename(member);
  };
  for (const each of entry) {
    rename(each.resource);
    if (each.fullUrl !== undefined)
      each.fullUrl = address.get(each.fullUrl) ?? each.fullUrl;
  }
  return bundle;
}

export function pullOf(
  data: Dataset,
  bundle: object,
): ReadonlyMap<string, Uint8Array> {
  return pullFiles(
    {
      fhirBase: data.fhirBase,
      patient: data.patient,
      source: "Synthea",
      retrievedAt: "2026-11-01T09:00:00Z",
      bundle,
    },
    "pull",
  );
}

/**
 * An import as an app does it for a person's own record: the pull is filed without matching, the owner files an About for
 * each patient profile it names, and the matcher then runs on the import. The profile is named by what the import holds, so it
 * is known only once the import is made: a profile worked out beforehand from some of the entries is another profile, and a pod
 * that claims none shows no one's results, since every record is left out for having no known subject.
 */
export async function importedAsTheApp(
  pod: Pod,
  pull: ReadonlyMap<string, Uint8Array>,
  onProgress?: ImportOptions["onProgress"],
): Promise<Imported> {
  const filed = await pod.import(pull, {
    match: false,
    ...(onProgress !== undefined && { onProgress }),
  });
  if (filed.activity === undefined) return filed;
  const profiles = filed.unclaimedProfiles;
  const of = profiles.length + 1;
  await onProgress?.({ part: "judging", done: 0, of });
  for (const [index, profile] of profiles.entries()) {
    await pod.judge(ownerAbout(pod, profile));
    await onProgress?.({ part: "judging", done: index + 1, of });
  }
  const matched = await pod.match(filed.activity);
  return { ...filed, matched, unclaimedProfiles: [] };
}
