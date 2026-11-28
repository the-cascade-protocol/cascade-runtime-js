import { type AdaptersOf, EVERY_FINDING } from "./bridge.js";
import { featureStory } from "./conformance.js";
import type { Files } from "./files.js";
import { notIsomorphic, triples } from "./graphs.js";
import type { Importer } from "./importer.js";
import { kitImports } from "./kit-bridge.js";
import { kitsOf } from "./kit.js";
import { savesBridgeOutput } from "./replay.js";
import { OxigraphStore } from "./oxigraph-store.js";
import type { Term } from "./rdf.js";
import { CASCADE } from "./step.js";

const OA = "http://www.w3.org/ns/oa#";
const RDF_VALUE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#value";
const SH_VALUE = "http://www.w3.org/ns/shacl#value";
const NOT_ACCOUNTED = `${CASCADE}SourcePathNotAccounted`;

/**
 * The name of the check a kit is held to beside those of `KIT_CHECKS`: each document its story imports converts, holds no
 * field its adapter's accounting leaves unnamed, agrees with that accounting, and, where the kit saves the graph, is
 * converted to that graph.
 */
export const KIT_FINDINGS_CHECK =
  "the-documents-of-the-kit-are-converted-and-accounted-for";

/** The imports, by kit and step, whose export its importer cannot read and for which the kit saves nothing. */
export const KNOWN_SKIPPED: readonly string[] = [
  "conformance/priya-natarajan E11",
];

/** What holds a kit's check from passing on nothing: an import skipped that is not known, or no document converted. */
export function unvouchedFor(
  kit: string,
  found: { readonly skipped: readonly string[]; readonly converted: number },
): string[] {
  return [
    ...found.skipped
      .filter((name) => !KNOWN_SKIPPED.includes(name))
      .map(
        (name) =>
          `${name}: its importer failed and the kit saves nothing, which is not a known skip`,
      ),
    ...(found.converted === 0 ? [`${kit} converted nothing`] : []),
  ];
}

/**
 * Where each census note of a conversion's findings puts its path, as a person finds it: the path the note's selectors
 * give, a Bundle's entry first, and, when the note's own value goes further, that value, the path inside the record.
 */
export function unaccountedPaths(findings: Uint8Array | undefined): string[] {
  if (findings === undefined || findings.length === 0) return [];
  const all = triples(findings);
  const of = (node: Term, predicate: string): Term[] =>
    all
      .filter(([s, p]) => s.value === node.value && p.value === predicate)
      .map(([, , o]) => o);
  return all
    .filter(
      ([, p, o]) => p.value === `${OA}hasBody` && o.value === NOT_ACCOUNTED,
    )
    .map(([note]) => {
      const chain: string[] = [];
      for (const target of of(note, `${OA}hasTarget`))
        for (const selector of of(target, `${OA}hasSelector`))
          for (
            let each: Term | undefined = selector;
            each !== undefined;
            each = of(each, `${OA}refinedBy`)[0]
          ) {
            const value = of(each, RDF_VALUE)[0]?.value;
            if (value) chain.push(value);
          }
      const path = chain.join(" | ");
      const inside = of(note, SH_VALUE)[0]?.value;
      return inside === undefined || path.includes(inside)
        ? path
        : `${path} (in the record ${inside})`;
    });
}

/** What the kits' documents fail. */
export interface KitFindings {
  /** One line for each failure, with the kit's name first. */
  readonly differ: string[];
  readonly skipped: string[];
  /** The documents converted, each once in its kit. */
  readonly converted: number;
  /** Of those, the documents compared with the graph their kit saves. */
  readonly compared: number;
  readonly unaccepted: number;
  readonly acceptedUnaccepted: number;
  /** The documents converted by an adapter whose Bridge offers no agreement check: the check was not made for them. */
  readonly agreementUnchecked: number;
}

/** The most lines of one document's disagreement that are told; the rest are counted. */
const UNMET_TOLD = 3;

/**
 * What fails, by kit, step and stem, for each document its importers find in an import step's download: the first adapter
 * to accept it converts it, and where the kit saved that no adapter accepts it, none does. A converted document fails
 * where it holds a field the adapter's accounting does not name (the census), where the accounting says a field is
 * carried and the conversion neither wrote nor explained it (the agreement), and, for a kit that saves its graphs, where
 * the conversion is not the graph saved. A kit that saves no Bridge output is checked the same but for that.
 */
export async function kitFindings(options: {
  readonly vocabulary: Files;
  readonly importers: readonly Importer[];
  readonly adaptersOf: AdaptersOf;
}): Promise<KitFindings> {
  const { vocabulary: files, importers, adaptersOf } = options;
  const differ: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let converted = 0;
  let compared = 0;
  let unaccepted = 0;
  let acceptedUnaccepted = 0;
  let agreementUnchecked = 0;
  for (const kit of await kitsOf(files)) {
    const skippedBefore = skipped.length;
    const convertedBefore = converted;
    const { person, steps } = await featureStory(
      files,
      `${kit}/${kit.slice(kit.lastIndexOf("/") + 1)}.feature`,
      () => new OxigraphStore(),
    );
    const saves = await savesBridgeOutput(files, person.folder);
    for (const {
      step,
      converted: saved,
      failure,
      documents,
    } of await kitImports({
      vocabulary: files,
      folder: person.folder,
      steps,
      importers,
      adaptersOf,
    })) {
      if (failure !== undefined) {
        const count = (await files.list(`${saved}/`)).length;
        if (count > 0)
          differ.push(
            `${kit} ${step.name}: its importer failed (${String(failure)}), but ${count} files are saved`,
          );
        else skipped.push(`${kit} ${step.name}`);
        continue;
      }
      const wanted = new Set(
        documents.flatMap(({ stem }) =>
          ["graph.ttl", "findings.ttl", "unaccepted.txt"].map(
            (name) => `${saved}/${stem}/${name}`,
          ),
        ),
      );
      for (const stray of await files.list(`${saved}/`))
        if (!wanted.has(stray))
          differ.push(
            `${kit} ${step.name}: ${stray} is saved, but no document of the import has such a file`,
          );
      for (const {
        stem,
        path: documentPath,
        iri: iriOf,
        offered,
        accepting,
      } of documents) {
        const at = `${saved}/${stem}/`;
        const named = `${kit} ${step.name} ${stem}`;
        const where = `${named} (${documentPath})`;
        const [graph, refused] = await Promise.all([
          files.read(`${at}graph.ttl`),
          files.read(`${at}unaccepted.txt`),
        ]);
        const known = `${kit} ${iriOf}`;
        if (refused !== undefined) {
          seen.add(known);
          unaccepted++;
          if (accepting !== undefined) acceptedUnaccepted++;
          continue;
        }
        if (graph === undefined && saves) {
          if (!seen.has(known))
            differ.push(`${named}: nothing is saved for it`);
          continue;
        }
        if (graph === undefined && seen.has(known)) continue;
        seen.add(known);
        converted++;
        if (accepting === undefined) {
          differ.push(`${named}: no adapter accepts it`);
          continue;
        }
        const made = await accepting.convert(offered, EVERY_FINDING);
        if (graph !== undefined) {
          compared++;
          const why = notIsomorphic(triples(graph), triples(made.graph));
          if (why !== undefined) differ.push(`${named}: ${why}`);
        }
        if (made.unvalidated !== undefined)
          differ.push(
            `${where}: its graph was not validated (${made.unvalidated}), so its census was not read`,
          );
        for (const path of unaccountedPaths(made.findings))
          differ.push(
            `${where}: ${path} is in the document, and the adapter's accounting does not name it`,
          );
        const unmet = await accepting.unmet?.(offered);
        if (unmet === undefined) agreementUnchecked++;
        else {
          for (const line of unmet.slice(0, UNMET_TOLD))
            differ.push(
              `${where}: the accounting and the conversion disagree: ${line}`,
            );
          if (unmet.length > UNMET_TOLD)
            differ.push(
              `${where}: and ${unmet.length - UNMET_TOLD} more disagreements`,
            );
        }
      }
    }
    differ.push(
      ...unvouchedFor(kit, {
        skipped: skipped.slice(skippedBefore),
        converted: converted - convertedBefore,
      }).map((line) => (line.startsWith(kit) ? line : `${kit} ${line}`)),
    );
  }
  return {
    differ,
    skipped,
    converted,
    compared,
    unaccepted,
    acceptedUnaccepted,
    agreementUnchecked,
  };
}
