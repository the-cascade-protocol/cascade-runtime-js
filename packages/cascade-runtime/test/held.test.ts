import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkReply,
  type CheckedFact,
  heldInWords,
  type PodAsker,
} from "cascade-runtime";
import { readConfig, resolveVocabulary } from "@cascade-runtime/runtime/node";

const NS = "https://ns.cascadeprotocol.org/cascade#";

// Priya's pod, cut to what names her sources: S3 is Fernhill Family Clinic (record 2a2516eb) and S12 Northbay Clinical
// Laboratories (record ca582a17).
const priya = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../test/fixtures/reply/priya.pod.json", import.meta.url),
    ),
    "utf8",
  ),
) as Record<string, Readonly<Record<string, string>>[]>;
const S3 = "urn:uuid:2a2516eb-46b0-8352-9042-93639f23ae9c";
const S12 = "urn:uuid:ca582a17-052b-890b-a5ad-0f2567e25670";
// another record of the document S3 is, so a source states two records
const S3_ELSEWHERE = "urn:uuid:80afad1b-91cb-8766-b527-1beabf2a4158";
const MED = `pod://p/clinical/medications.ttl#${"a95bee7d".padEnd(64, "0")}`;
const LAB = `pod://p/clinical/lab-results.ttl#${"41e35923".padEnd(64, "0")}`;

/** A cell of a SPARQL TSV result as the runtime hands it over: an IRI without its brackets, a literal without its type. */
const cell = (text: string | undefined): string | undefined => {
  if (text === undefined || text === "") return undefined;
  const iri = /^<(.*)>$/.exec(text);
  if (iri !== null) return iri[1];
  return /^"(.*)"(\^\^<.*>)?$/.exec(text)?.[1] ?? text;
};

/**
 * The rows of a vocabulary fixture's `what-it-shows.tsv`, which are what `entry/What it shows` returns for it: its entry
 * is `entry`, and each record it names (`urn:x:prescribed`) is the member `records` maps it to.
 */
async function fixtureRows(
  fixture: string,
  entry: string,
  records: Readonly<Record<string, string>>,
  more: readonly Record<string, string>[] = [],
): Promise<Record<string, string>[]> {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const { folder } = await resolveVocabulary(root, await readConfig(root));
  const [head, ...lines] = readFileSync(
    join(folder, "tests", "fixtures", fixture, "what-it-shows.tsv"),
    "utf8",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const names = head!.split("\t").map((it) => it.slice(1));
  const rows = lines.map((line) => {
    const row: Record<string, string> = {};
    line.split("\t").forEach((text, at) => {
      const value = cell(text);
      if (value !== undefined) row[names[at]!] = value;
    });
    row.entry = entry;
    if (row.from !== undefined) row.from = records[row.from] ?? row.from;
    return row;
  });
  // as the question gives them: by field, so one record's rows are not together
  return [...rows, ...more].sort((a, b) =>
    (a.field ?? "").localeCompare(b.field ?? ""),
  );
}

const asking =
  (rows: readonly Record<string, string>[]): PodAsker["ask"] =>
  async (question) =>
    question === "entry/What it shows"
      ? rows
      : (priya[question] ?? ([] as Record<string, string>[]));

const check = async (
  rows: readonly Record<string, string>[],
  entry: string,
  ...facts: Record<string, unknown>[]
): Promise<readonly CheckedFact[]> => {
  const checked = await checkReply(
    {
      answer: "…",
      short: "…",
      items: [
        {
          says: "…",
          why: "…",
          confidence: "high",
          facts: facts.map((fact) => ({
            says: "…",
            cite: { entry },
            field: "value",
            ...fact,
          })),
        },
      ],
    },
    { ask: asking(rows), ran: [] },
  );
  assert.deepEqual(checked.errors, []);
  return checked.items[0]!.facts;
};

/** What a person reads for a fact: each item's lines, and the sources that state it. */
const read = (fact: CheckedFact) =>
  fact.filled!.held.map((item) => ({
    sources: item.sources,
    lines: heldInWords(item),
  }));

/** The records each item is of, in the order the items come. */
const recordsOf = (fact: CheckedFact) =>
  fact.filled!.held.map((item) => item.records);

const TWO_DOSAGES =
  "a-medicine-with-two-dosages-shows-each-dose-on-its-own-dosage";
const RANGE = "lab-results-view";
const SO = { "urn:x:prescribed": S3, "urn:x:listed": S12 };

const A_10 =
  "Dosage: 10.0 milligram · 1 per 1 day · route snomed:26643006 / C38288 in another code system";
const A_2 = "Dosage: 2 per 1 day · from 2026-02-01 · until 2026-03-01T10:00Z";
const B_AT_MOST_2 =
  "Dosage: at most 2 tablet · 1 per 1 day · route snomed:26643006";

/**
 * What a pod holds beside a fact that names its field, as rows and then as words: `filled.held` is the pod's rows of the
 * field, by part and by who states them and never as text; `heldInWords` words one for a person, once, for every app.
 * The rows are the vocabulary's own fixtures, not shapes made up here.
 * @rule runtime/naming.feature N13
 */
describe("Showing a person what a pod holds beside a fact · heldInWords(), filled.held", () => {
  describe("given a medicine two sources state dosages of", () => {
    it("words a dosage as one line, its dose, its schedule, its route and its bounds, whichever one source holds", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [both] = await check(rows, MED, {
        property: "structuredDosage",
        source: "S3",
      });
      assert.deepEqual(read(both!), [
        { sources: ["S3"], lines: [A_10] },
        { sources: ["S3"], lines: [A_2] },
      ]);
    });

    it("shows the whole dosage a fact names one field of, never a fragment: the period only, or the route only", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [period, route] = await check(
        rows,
        MED,
        { property: "dosageRepeatPeriod", source: "S3" },
        { property: "dosageRouteCode", source: "S3" },
      );
      assert.deepEqual(read(period!), [
        { sources: ["S3"], lines: [A_10] },
        { sources: ["S3"], lines: [A_2] },
      ]);
      assert.deepEqual(read(route!), [{ sources: ["S3"], lines: [A_10] }]);
    });

    it("gives each source's dosage as a whole dose of its own when the two agree on the schedule and differ on the dose", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [frequency] = await check(rows, MED, {
        property: "dosageRepeatFrequency",
      });
      assert.deepEqual(read(frequency!), [
        { sources: ["S3"], lines: [A_10] },
        { sources: ["S3"], lines: [A_2] },
        { sources: ["S12"], lines: [B_AT_MOST_2] },
      ]);
      assert.deepEqual(recordsOf(frequency!), [[S3], [S3], [S12]]);
    });

    it("keeps two records of one source apart, each dosage its own, never one record's schedule on the other's dose", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, {
        "urn:x:prescribed": S3,
        "urn:x:listed": S3_ELSEWHERE,
      });
      const [dosages] = await check(rows, MED, {
        property: "structuredDosage",
      });
      assert.deepEqual(read(dosages!), [
        { sources: ["S3"], lines: [A_10] },
        { sources: ["S3"], lines: [A_2] },
        { sources: ["S3"], lines: [B_AT_MOST_2] },
      ]);
      assert.deepEqual(recordsOf(dosages!), [[S3], [S3], [S3_ELSEWHERE]]);
    });

    it("shows the whole dosage a fact naming its dose rests on, so a wrong schedule can be seen, the comparator in front of its number", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [dose] = await check(rows, MED, {
        property: "dosageDoseQuantity",
        source: "S12",
      });
      assert.deepEqual(read(dose!), [
        { sources: ["S12"], lines: [B_AT_MOST_2] },
      ]);
    });

    it("words a quantity once whether it holds a decimal beside its written form or a UCUM unit and no unit text", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [dose] = await check(
        rows.filter((it) => it.field !== `${NS}unitText`),
        MED,
        { property: "dosageDoseQuantity", source: "S3" },
      );
      assert.deepEqual(read(dose!), [
        {
          sources: ["S3"],
          lines: [
            "Dosage: 10.0 mg · 1 per 1 day · route snomed:26643006 / C38288 in another code system",
          ],
        },
      ]);
    });

    it("keeps a label that holds a comma whole", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [route] = await check(
        rows.map((it) =>
          it.field === `${NS}dosageRouteCode`
            ? { ...it, valueLabel: "Oral route, swallowed" }
            : it,
        ),
        MED,
        { property: "dosageRouteCode", source: "S12" },
      );
      assert.deepEqual(read(route!), [
        {
          sources: ["S12"],
          lines: [
            "Dosage: at most 2 tablet · 1 per 1 day · Oral route, swallowed (snomed:26643006)",
          ],
        },
      ]);
    });

    it("shows a field it has no wording for by its name and its value, never drops it", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO, [
        {
          entry: MED,
          field: `${NS}dosageAsNeededReason`,
          value: "pain",
          from: S12,
          part: "structuredDosage 1",
        },
      ]);
      const [dosage] = await check(rows, MED, {
        property: "dosageAsNeededReason",
      });
      assert.deepEqual(read(dosage!), [
        {
          sources: ["S12"],
          lines: [
            "Dosage: at most 2 tablet · 1 per 1 day · route snomed:26643006 · dosage as needed reason pain",
          ],
        },
      ]);
    });

    it("words a field of the entry itself by its name and its value, and names every source that states it", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [text] = await check(rows, MED, {
        property: "dosageInstructionText",
      });
      assert.deepEqual(read(text!), [
        {
          sources: ["S3"],
          lines: ["Dosage instruction text: 1 tablet by mouth every morning"],
        },
        {
          sources: ["S12"],
          lines: ["Dosage instruction text: Take 1 tablet daily"],
        },
      ]);
    });

    it("words a coded value by its label and then its code", async () => {
      const [route] = await check(
        [
          {
            entry: MED,
            field: `${NS}dosageRouteCode`,
            value: "http://snomed.info/id/26643006",
            valueLabel: "Oral route",
            from: S3,
          },
        ],
        MED,
        { property: "dosageRouteCode" },
      );
      assert.deepEqual(read(route!), [
        {
          sources: ["S3"],
          lines: ["Dosage route code: Oral route (snomed:26643006)"],
        },
      ]);
    });

    it("returns each part as the pod holds it: its way, its fields with their labels, and the parts beneath it", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [dose] = await check(rows, MED, {
        property: "structuredDosage",
        source: "S12",
      });
      assert.deepEqual(dose!.filled!.held, [
        {
          sources: ["S12"],
          records: [S12],
          part: "structuredDosage 1",
          fields: [
            { name: "dosageRepeatFrequency", value: "1" },
            { name: "dosageRepeatPeriod", value: "1" },
            { name: "dosageRepeatPeriodUnit", value: "d" },
            {
              name: "dosageRouteCode",
              value: "http://snomed.info/id/26643006",
            },
          ],
          parts: [
            {
              part: "structuredDosage 1/dosageDoseQuantity",
              fields: [
                { name: "decimalValue", value: "2" },
                { name: "quantityComparator", value: "<=" },
                { name: "unitText", value: "tablet" },
                { name: "writtenValue", value: "2" },
              ],
            },
          ],
        },
      ]);
    });

    it("names one item both sources when they hold exactly the same", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [same] = await check(
        [
          ...rows.filter((it) => it.from !== S12),
          ...rows
            .filter((it) => it.from === S3)
            .map((it) => ({ ...it, from: S12 })),
        ],
        MED,
        { property: "dosageDoseQuantity" },
      );
      assert.deepEqual(read(same!), [
        { sources: ["S3", "S12"], lines: [A_10] },
      ]);
      assert.deepEqual(recordsOf(same!), [[S3, S12]]);
    });
  });

  describe("given a fact whose field or source the pod does not hold", () => {
    it("says there is no such field from a source that does not hold the field another source does", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [named, anyone] = await check(
        rows,
        MED,
        { property: "dosageRouteCodeInOtherSystem", source: "S12" },
        { property: "dosageRouteCodeInOtherSystem" },
      );
      assert.deepEqual(named!.verdict.ok, false);
      assert.deepEqual(
        (named!.verdict as { reason: string }).reason,
        "no such field",
      );
      assert.deepEqual(anyone!.verdict.ok, true);
    });

    it("knows a source that states only parts of the entry, no field of the entry itself", async () => {
      const rows = await fixtureRows(TWO_DOSAGES, MED, SO);
      const [dose] = await check(
        rows.filter((it) => it.from !== S12 || it.part !== undefined),
        MED,
        { property: "dosageDoseQuantity", source: "S12" },
      );
      assert.deepEqual(dose!.verdict.ok, true);
      assert.deepEqual(read(dose!), [
        { sources: ["S12"], lines: [B_AT_MOST_2] },
      ]);
    });
  });

  describe("given a dosage that states only some of its parts", () => {
    const dosage = (...fields: [string, string][]) =>
      heldInWords({
        part: "structuredDosage 1",
        fields: fields.map(([name, value]) => ({ name, value })),
      });

    it("words what it states and nothing it does not, a period of more than one in the plural and a comparator it does not know as written", () => {
      assert.deepEqual(
        [
          dosage(),
          dosage(["dosageRepeatFrequency", "3"]),
          dosage(["dosageRepeatPeriod", "2"]),
          dosage(["dosageRepeatPeriodUnit", "wk"]),
          dosage(
            ["dosageRepeatFrequency", "3"],
            ["dosageRepeatPeriod", "2"],
            ["dosageRepeatPeriodUnit", "wk"],
          ),
          dosage(
            ["dosageRepeatFrequency", "3"],
            ["dosageRepeatPeriod", "1.0"],
            ["dosageRepeatPeriodUnit", "d"],
          ),
        ].flat(),
        [
          "Dosage: nothing stated",
          "Dosage: frequency 3",
          "Dosage: period 2",
          "Dosage: period unit week",
          "Dosage: 3 per 2 weeks",
          "Dosage: 3 per 1.0 day",
        ],
      );
      assert.deepEqual(
        heldInWords({
          part: "referenceRangeHigh",
          fields: [
            { name: "quantityComparator", value: "~" },
            { name: "writtenValue", value: "5" },
            { name: "ucumUnit", value: "mg" },
          ],
        }),
        ["Reference range high: ~ 5 mg"],
      );
    });
  });

  describe("given a lab result with a reference range", () => {
    it("shows the whole bound a fact naming the bound's number rests on", async () => {
      const rows = await fixtureRows(RANGE, LAB, { "urn:x:mcv": S3 });
      const [written] = await check(rows, LAB, { property: "writtenValue" });
      assert.deepEqual(read(written!), [
        {
          sources: ["S3"],
          lines: ["Reference range high: 100 fl"],
        },
        { sources: ["S3"], lines: ["Reference range low: 80 fL"] },
      ]);
    });

    it("words a bound as a quantity: the written number, and the unit text else the UCUM unit", async () => {
      const rows = await fixtureRows(RANGE, LAB, { "urn:x:mcv": S3 });
      const [low, high] = await check(
        rows,
        LAB,
        { property: "referenceRangeLow" },
        { property: "referenceRangeHigh" },
      );
      assert.deepEqual(read(low!), [
        { sources: ["S3"], lines: ["Reference range low: 80 fL"] },
      ]);
      assert.deepEqual(read(high!), [
        { sources: ["S3"], lines: ["Reference range high: 100 fl"] },
      ]);
    });
  });
});
