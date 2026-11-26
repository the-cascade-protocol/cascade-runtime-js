import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkReply,
  type CheckedFact,
  downloadsSource,
  numberedReply,
  type PodAsker,
  replyErrors,
  replySchema,
  type Ran,
  recordsReplySchema,
  type Source,
} from "cascade-runtime";
import { checkCopiedReply } from "cascade-runtime/copied-reply";
import { readConfig, resolveVocabulary } from "@cascade-runtime/runtime/node";
// The package does not export it: it exists to be held to the vocabulary, which is what the last leaf does.
import { POD_FIELDS } from "../src/citations.js";

const read = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../test/fixtures/reply/${name}`, import.meta.url),
      ),
      "utf8",
    ),
  );

// The reply is a model's answer in a recorded eval run (history/2026-11-03-1822d32-custom), with the calls it ran, its
// facts re-pointed by hand to the contract in which a fact names an entry and a field and copies nothing.
const reply = read("blood-clot.json");
const ran = read("blood-clot.calls.json") as Ran[];

const NS = "https://ns.cascadeprotocol.org/cascade#";
const LOINC = "http://loinc.org/rdf/";
const MEMBER = "urn:uuid:1889f959-6178-8833-9850-96a22a25cc04";
const entry = (file: string, start: string) =>
  `pod://p/clinical/${file}.ttl#${start.padEnd(64, "0")}`;
const REPORT = entry(
  "reports",
  "de64c5136ee1f407e99705e33b2f3ecd40608a404c14e75d22a432798cce2d89",
);
const PROCEDURE = entry("procedures", "7eb7ac1d");
const CONDITION = entry("conditions", "9f080aa6");
const LAB = entry("lab-results", "41e35923");

const shown = (
  which: string,
  fields: [string, string][],
  from = "urn:uuid:other",
) =>
  fields.map(([field, value]) => ({
    entry: which,
    field: NS + field,
    value,
    from,
  }));

const WHAT_IT_SHOWS = [
  ...shown(
    REPORT,
    [
      ["reportName", "CT angiography chest (pulmonary embolism protocol)"],
      ["reportCode", `${LOINC}24627-2`],
      ["workflowStatus", "final"],
      ["reportEffectiveTime", "2025-07-08T22:30:00Z"],
      [
        "reportConclusion",
        "No pulmonary embolism. Lungs are clear. No pleural or pericardial effusion. Mild degenerative changes of the thoracic spine.",
      ],
    ],
    MEMBER,
  ),
  ...shown(PROCEDURE, [
    ["procedureName", "CT angiography of the chest"],
    ["workflowStatus", "completed"],
    ["procedureDate", "2025-07-08"],
  ]),
  ...shown(CONDITION, [
    ["conditionName", "Pulmonary embolism"],
    ["conditionCode", "http://snomed.info/id/59282003"],
    ["verificationStatus", "refuted"],
    ["onsetDate", "2025-07-08"],
  ]),
  ...shown(LAB, [
    ["testName", "D-dimer"],
    ["testCode", `${LOINC}48065-7`],
    ["resultValueText", "0.92"],
    ["resultUnitText", "mg/L{FEU}"],
    ["workflowStatus", "final"],
    ["resultClinicallyRelevantTime", "2025-07-08T09:00:00Z"],
  ]),
];

const ask = async (question: string) =>
  question === "entry/What it shows" ? WHAT_IT_SHOWS : [];

// Priya's pod (the eval case priya-natarajan), cut to the rows the checker reads of her and of two view entries, with one
// provenance row per document so its sources are named as a whole read of her pod names them: her hemoglobin A1c of
// 2025-09-22, which came from both her clinic (S3, Fernhill Family Clinic) and the lab (S12, Northbay Clinical
// Laboratories), and a plan of care note two records state, each with its own date.
const priya = read("priya.pod.json") as Record<
  string,
  Readonly<Record<string, string>>[]
>;
const askPriya = async (question: string) => priya[question] ?? [];
const POD = "pod://62c61be2-abd9-4485-b614-87ee83666495/clinical";
const HBA1C = "Lcd05f84f";
const NOTE = "Nfcb7c333";
const PERSON = "urn:uuid:a6a69b65-6745-4520-b1cd-fc8321062ab3";

/** The reply of one item resting on the facts. */
const replyOf = (...facts: Record<string, unknown>[]) => ({
  answer: "…",
  short: "…",
  items: [{ says: "…", why: "…", confidence: "high", facts }],
});

/** The facts checked against the pod that `asking` reads; none breaks the contract. */
const pointedIn = async (
  asking: PodAsker["ask"],
  ...facts: Record<string, unknown>[]
) => {
  const checked = await checkReply(replyOf(...facts), {
    ask: asking,
    ran: [],
  });
  assert.deepEqual(checked.errors, []);
  return checked.items[0]!.facts;
};
const pointed = (...facts: Record<string, unknown>[]) =>
  pointedIn(askPriya, ...facts);
const fact = (entry: string, field: string, more = {}) => ({
  says: "…",
  cite: { entry },
  field,
  ...more,
});
const reasons = (facts: readonly CheckedFact[]) =>
  facts.map(({ verdict }) =>
    verdict.ok ? "ok" : `${verdict.reason}: ${verdict.missing.join(", ")}`,
  );
const A1C_LABEL = "Hemoglobin A1c/Hemoglobin.total in Blood";

/** Each place a schema uses what a provider's structured output does not take; a map of schemas by name is no schema. */
function beyondStructuredOutput(
  schema: unknown,
  at = "",
  map = false,
): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  if (Array.isArray(schema))
    return schema.flatMap((it, i) => beyondStructuredOutput(it, `${at}/${i}`));
  const it = schema as Record<string, unknown>;
  if (map)
    return Object.entries(it).flatMap(([name, value]) =>
      beyondStructuredOutput(value, `${at}/${name}`),
    );
  const found = [
    "$schema",
    "oneOf",
    "not",
    "if",
    "dependentRequired",
    "dependentSchemas",
    "pattern",
    "patternProperties",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "maxItems",
    "minProperties",
    "maxProperties",
    "uniqueItems",
  ]
    .filter((word) => word in it)
    .map((word) => `${at} ${word}`);
  if (typeof it.minItems === "number" && it.minItems > 1)
    found.push(`${at} minItems ${it.minItems}`);
  if (Array.isArray(it.type)) found.push(`${at} type ${String(it.type)}`);
  if (it.type === "object" && it.additionalProperties !== false)
    found.push(`${at} open object`);
  return [
    ...found,
    ...Object.entries(it).flatMap(([key, value]) =>
      key === "enum"
        ? []
        : beyondStructuredOutput(
            value,
            `${at}/${key}`,
            key === "properties" || key === "$defs",
          ),
    ),
  ];
}

/** The field names one view's CONSTRUCT template writes; it throws, saying what to do, on a view or a prefix it cannot read. */
function constructedBy(file: string, text: string): string[] {
  const from = text.indexOf("CONSTRUCT {");
  const to = text.search(/^WHERE/m);
  if (from === -1 || to < from)
    throw new Error(
      `${file} has no "CONSTRUCT {" block ending at a line that starts with WHERE, so its fields cannot be read: ` +
        `put the template in that shape, or teach this test the view's shape`,
    );
  const template = text.slice(from, to);
  const prefix = /\b([A-Za-z]\w*):([A-Za-z_]\w*)/g;
  const names: string[] = [];
  for (const [, at, name] of template.matchAll(prefix)) {
    if (!["cascade", "prov", "obo"].includes(at!))
      throw new Error(
        `${file} writes ${at}:${name}, a prefix this test does not read, so a field could be missed: ` +
          `add "${at}" to the prefixes read in constructedBy`,
      );
    if (/^[a-z]|^RO_/.test(name!)) names.push(name!);
  }
  if (/<https?:/.test(template))
    throw new Error(
      `${file} writes a field by full IRI, which this test does not read: write it with a prefix`,
    );
  return names;
}

/** The field names the vocabulary's views construct on a view entry. */
async function viewFields(): Promise<string[]> {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const { folder } = await resolveVocabulary(root, await readConfig(root));
  const dir = join(folder, "queries", "views");
  const names = new Set<string>();
  for (const file of (await readdir(dir)).filter((it) => it.endsWith(".rq")))
    for (const name of constructedBy(
      file,
      await readFile(join(dir, file), "utf8"),
    ))
      names.add(name);
  return [...names].sort();
}

/**
 * A model that answers about a person's records replies in a fixed JSON form, the reply contract: items, each resting
 * on facts that cite a record and on absences. `checkReply` holds a reply to the contract and each fact to the record it
 * cites, and returns what the pod itself holds of that record, so an app shows the pod's words and never the model's.
 * @rule runtime/naming.feature N13
 */
describe("Checking a model's reply against a person's records · checkReply(), replyErrors(), replySchema, numberedReply()", () => {
  describe("given a reply about a pod (`ask`)", () => {
    it("checks every fact and absence of a recorded reply: its four facts hold and its one absence is backed", async () => {
      const checked = await checkReply(reply, { ask, ran });
      assert.deepEqual(checked.errors, []);
      const [scan, ruledOut, dimer, later] = checked.items;
      const facts = [...scan!.facts, ...ruledOut!.facts, ...dimer!.facts];
      assert.deepEqual(
        facts.map(({ verdict }) => verdict.ok),
        [true, true, true, true],
      );
      assert.deepEqual(
        later!.absences.map(({ backing }) => backing),
        [{ backed: true }],
      );
    });

    it("returns in `record.source` the records the cited view entry's values came from", async () => {
      const checked = await checkReply(reply, { ask, ran });
      assert.deepEqual(checked.items[0]!.facts[0]!.record?.source, [MEMBER]);
    });

    it("returns in `filled` what the pod holds of the view entry: its IRI, its name, its value with its unit, and its date", async () => {
      const [result] = await pointed(fact(HBA1C, "value"));
      const { entry, label, value, date, dateKind } = result!.filled!;
      assert.deepEqual(
        { entry, label, value, date, dateKind },
        {
          entry: `${POD}/lab-results.ttl#cd05f84f584f21389ebd613489d46ab9634387697c9a20caf6af151360307712`,
          label: A1C_LABEL,
          value: "6.9 %",
          date: "2025-09-22",
          dateKind: "when",
        },
      );
    });

    it("returns in `held` every value the view entry holds of the field the fact names", async () => {
      const [result, note] = await pointed(
        fact(HBA1C, "value"),
        fact(NOTE, "date"),
      );
      assert.deepEqual(
        result!.filled!.held,
        [
          {
            records: [],
            sources: [],
            fields: [{ name: "resultValueText", value: "6.9" }],
          },
        ],
        "one value, of the entry as a whole",
      );
      assert.deepEqual(
        note!.filled!.held,
        [
          {
            records: ["urn:uuid:45c4f0ee-4874-8fbf-89d3-b7d0214ae2cb"],
            sources: ["S6"],
            fields: [
              { name: "noteOrDocumentDate", value: "2026-06-22T18:03:44Z" },
            ],
          },
          {
            records: ["urn:uuid:80afad1b-91cb-8766-b527-1beabf2a4158"],
            sources: ["S3"],
            fields: [
              { name: "noteOrDocumentDate", value: "2026-01-05T17:12:05Z" },
            ],
          },
        ],
        "a note two records state, each with its own time and its own source",
      );
      assert.equal(
        note!.filled!.date,
        "2026-06-22",
        "its date is the first of them",
      );
    });

    it("lists in `sources` each source of the view entry, by its short name and who wrote it", async () => {
      const [result] = await pointed(fact(HBA1C, "value"));
      assert.deepEqual(result!.filled!.sources, [
        "S3 Fernhill Family Clinic",
        "S12 Northbay Clinical Laboratories",
      ]);
    });

    it("checks a fact about the person, cited by the subject's IRI", async () => {
      const [born] = await pointed(fact(PERSON, "date"));
      assert.deepEqual(reasons([born!]), ["ok"]);
      assert.deepEqual(
        [
          born!.filled?.entry,
          born!.filled?.date,
          born!.filled?.held.map((item) => item.fields),
        ],
        [
          PERSON,
          "1968-11-04",
          [[{ name: "dateOfBirth", value: "1968-11-04" }]],
        ],
      );
    });
  });

  describe("given a fact that names a `source`", () => {
    it("returns in `held` and `sources` only what that source says", async () => {
      const facts = await pointed(
        fact(HBA1C, "value", { source: "S12" }),
        fact(HBA1C, "date", { source: "S3" }),
        fact(NOTE, "date", { source: "S6" }),
        fact(NOTE, "date", { source: "S3" }),
      );
      assert.deepEqual(reasons(facts), ["ok", "ok", "ok", "ok"]);
      assert.deepEqual(
        facts.map(({ filled }) =>
          filled?.held.map((item) => item.fields.map((it) => it.value)),
        ),
        [
          [["6.9"]],
          [["2025-09-22T16:15:00Z"]],
          [["2026-06-22T18:03:44Z"]],
          [["2026-01-05T17:12:05Z"]],
        ],
      );
      assert.deepEqual(
        facts.slice(0, 2).map(({ filled }) => filled?.sources),
        [["S12 Northbay Clinical Laboratories"], ["S3 Fernhill Family Clinic"]],
      );
      assert.deepEqual(
        facts.slice(0, 2).map(({ filled }) => {
          const { entry, label, value, date, dateKind } = filled!;
          return { entry, label, value, date, dateKind };
        }),
        Array(2).fill({
          entry: `${POD}/lab-results.ttl#cd05f84f584f21389ebd613489d46ab9634387697c9a20caf6af151360307712`,
          label: A1C_LABEL,
          value: "6.9 %",
          date: "2025-09-22",
          dateKind: "when",
        }),
        "the view entry's own name, value and date, whichever source is named",
      );
      assert.deepEqual(
        facts.slice(2).map(({ filled }) => filled?.date),
        ["2026-06-22", "2026-01-05"],
        "the note's date is that source's own",
      );
    });

    it("returns `no such source` for a source that is none of the view entry's", async () => {
      const [lacking] = await pointed(fact(HBA1C, "value", { source: "S1" }));
      assert.deepEqual(reasons([lacking!]), ["no such source: source S1"]);
    });
  });

  describe("given a fact that names a `property`", () => {
    it("never takes a value on a part for a value of the view entry: a reference bound is read by its own name, and the result stays the result", async () => {
      const S3 = "urn:uuid:2a2516eb-46b0-8352-9042-93639f23ae9c";
      const LAB_ENTRY = `${POD}/lab-results.ttl#cd05f84f584f21389ebd613489d46ab9634387697c9a20caf6af151360307712`;
      const row = (field: string, value: string, part?: string) => ({
        entry: LAB_ENTRY,
        field: NS + field,
        value,
        from: S3,
        ...(part === undefined ? {} : { part }),
      });
      const [result, high] = await pointedIn(
        async (question) =>
          question === "entry/What it shows"
            ? [
                ...priya[question]!,
                row("referenceRangeHigh", `${LAB_ENTRY}-high`),
                // a name a kind is mapped to, written on a part: the bound is still not the result
                row("writtenValue", "5.6", "referenceRangeHigh"),
                row("resultValueText", "5.6", "referenceRangeHigh"),
              ]
            : (priya[question] ?? []),
        fact(HBA1C, "value"),
        fact(HBA1C, "value", { property: "referenceRangeHigh" }),
      );
      assert.deepEqual(
        result!.filled!.held.map((item) => item.fields),
        [[{ name: "resultValueText", value: "6.9" }]],
      );
      assert.equal(result!.filled!.value, "6.9 %");
      assert.deepEqual(
        high!.filled!.held.map(({ part, fields }) => ({ part, fields })),
        [
          {
            part: "referenceRangeHigh",
            fields: [
              { name: "resultValueText", value: "5.6" },
              { name: "writtenValue", value: "5.6" },
            ],
          },
        ],
      );
    });

    it("returns `no such field` for a property the view entry does not hold", async () => {
      const [none] = await pointed(
        fact(HBA1C, "value", { property: "dispenseDaysSupply" }),
      );
      assert.deepEqual(reasons([none!]), ["no such field: dispenseDaysSupply"]);
    });

    it("takes the property as a full IRI, a prefixed name or the bare name", async () => {
      const facts = await pointed(
        ...[
          `${NS}referenceRangeText`,
          "cascade:referenceRangeText",
          "referenceRangeText",
        ].map((property) => fact(HBA1C, "value", { property })),
      );
      assert.deepEqual(reasons(facts), ["ok", "ok", "ok"]);
    });
  });

  describe("given a fact that cites by handle", () => {
    const sha = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const [first, later] = [1, 2].map(
      (n) => `urn:uuid:00000000-0000-4000-8000-00000000000${n}`,
    );
    const joined = `pod://p/clinical/lab-results.ttl#${sha(first!)}`;
    const askJoined = async (question: string) =>
      question === "entry/What it shows"
        ? [first, later].map((from) => ({
            entry: joined,
            from: from!,
            field: `${NS}testName`,
            value: "LDL cholesterol",
          }))
        : [];

    it("finds the view entry whose name the handle begins", async () => {
      const [result] = await pointed(fact(HBA1C, "value"));
      assert.match(
        result!.filled!.entry,
        /\/lab-results\.ttl#cd05f84f[0-9a-f]{56}$/,
      );
    });

    it("finds, for a handle made before another record joined the view entry, the view entry that record is in now", async () => {
      const [named] = await pointedIn(
        askJoined,
        fact(`L${sha(later!).slice(0, 12)}`, "name"),
      );
      assert.deepEqual(reasons([named!]), ["ok"]);
      assert.equal(named!.filled?.entry, joined);
    });

    it("returns `no such record`, with nothing in `filled`, for a handle no view entry has", async () => {
      const [none] = await pointed(fact("Lffffffff", "value"));
      assert.deepEqual(reasons([none!]), ["no such record: entry Lffffffff"]);
      assert.equal(none!.filled, undefined);
    });
  });

  describe("given a fact the pod does not bear out", () => {
    it("returns `no such field` when the view entry holds no value of the field", async () => {
      const [lacking] = await pointed(fact(HBA1C, "end"));
      assert.deepEqual(reasons([lacking!]), ["no such field: end"]);
    });

    it("returns `says otherwise` for a quote that is not words of the view entry's text", async () => {
      const facts = await pointed(
        fact(NOTE, "text", { quote: "new diagnosis of type 1 diabetes" }),
        fact(HBA1C, "value", { quote: "new diagnosis of type 2 diabetes" }),
      );
      assert.deepEqual(reasons(facts), [
        "says otherwise: quote new diagnosis of type 1 diabetes",
        "says otherwise: quote new diagnosis of type 2 diabetes",
      ]);
    });

    it("returns `quote too short` for a quote of fewer than three words", async () => {
      const facts = await pointed(
        fact(NOTE, "text", { quote: "the" }),
        fact(NOTE, "text", { quote: "new diagnosis" }),
      );
      assert.deepEqual(reasons(facts), [
        "quote too short: quote the",
        "quote too short: quote new diagnosis",
      ]);
    });

    it("returns `ok: true` for a quote of three words or more, and for one that is the whole of a shorter text", async () => {
      const seen = entry("reports", "5ee00001");
      const askSeen = async (question: string) =>
        question === "entry/What it shows"
          ? shown(seen, [
              ["reportName", "Chest film"],
              ["reportConclusion", "Not seen"],
            ])
          : [];
      const [long] = await pointed(
        fact(NOTE, "text", { quote: "new diagnosis of type 2 diabetes" }),
      );
      const [whole, part] = await pointedIn(
        askSeen,
        fact("R5ee00001", "text", { quote: "Not seen" }),
        fact("R5ee00001", "text", { quote: "seen" }),
      );
      assert.deepEqual(reasons([long!]), ["ok"], "three words or more");
      assert.deepEqual(
        reasons([whole!]),
        ["ok"],
        "the whole of a shorter text",
      );
      assert.deepEqual(
        reasons([part!]),
        ["quote too short: quote seen"],
        "part of a shorter text",
      );
    });

    it("returns `nothing to check` for the field `text` with no quote", async () => {
      const [bare] = await pointed(fact(NOTE, "text"));
      assert.deepEqual(reasons([bare!]), ["nothing to check: quote"]);
    });

    it("returns `filled` for a field the view entry lacks", async () => {
      const [lacking] = await pointed(fact(HBA1C, "end"));
      assert.equal(lacking!.filled?.label, A1C_LABEL);
    });
  });

  describe("given a pod that cannot be read", () => {
    it("rejects with the pod's own error, leaving no rejection unhandled", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (why: unknown) => unhandled.push(why);
      process.on("unhandledRejection", onUnhandled);
      try {
        for (const [what, cited] of [
          ["a fact citing a view entry", HBA1C],
          ["a fact citing the person", PERSON],
        ] as const) {
          const failing = (question: string) =>
            Promise.reject(new Error(`cannot read ${question}`));
          await assert.rejects(
            checkReply(replyOf(fact(cited, "value")), {
              ask: failing,
              ran: [],
            }),
            /cannot read/,
            what,
          );
        }
        await new Promise((done) => setImmediate(done));
        assert.deepEqual(unhandled, []);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  describe("given a reply that breaks the contract", () => {
    const broken = { answer: "x", short: "y", items: [] };

    it("returns the contract's errors, one line for each, saying where in the reply", async () => {
      assert.deepEqual(await replyErrors(broken), [
        "/items must NOT have fewer than 1 items",
      ]);
      assert.deepEqual(
        (await checkReply(broken, { ask, ran })).errors,
        await replyErrors(broken),
      );
    });

    it("returns no checked items", async () => {
      assert.deepEqual((await checkReply(broken, { ask, ran })).items, []);
    });

    it("returns an error for what `replySchema` cannot say: a blank `answer`, an eleventh item, two items numbered alike", async () => {
      const item = (n?: number) => ({
        says: "…",
        why: "…",
        confidence: "high",
        facts: [],
        ...(n === undefined ? {} : { n }),
      });
      for (const [what, given, expected] of [
        [
          "a blank answer",
          { answer: "   ", short: "y", items: [item()] },
          ["/answer must NOT have fewer than 1 characters"],
        ],
        [
          "an eleventh item",
          {
            answer: "x",
            short: "y",
            items: Array.from({ length: 11 }, () => item()),
          },
          ["/items must NOT have more than 10 items"],
        ],
        [
          "two items numbered alike",
          { answer: "x", short: "y", items: [item(2), item()] },
          [
            "/items more than one item has n 2 (an item without n is numbered by its place)",
          ],
        ],
      ] as const)
        assert.deepEqual(await replyErrors(given), expected, what);
    });
  });

  describe("given a reply that draws links", () => {
    const item = (n: number) => ({
      n,
      says: "…",
      why: "…",
      confidence: "high",
      facts: [{ says: "…", cite: { entry: "Lcd05f84f" }, field: "value" }],
    });
    const linked = (link: unknown) => ({
      answer: "x",
      short: "y",
      items: [item(1), item(2)],
      links: [link],
    });
    const says = "the later copy closes the earlier one";

    it("returns no error for a link from a fact of one item to a fact of another", async () => {
      assert.deepEqual(
        await replyErrors(
          linked({
            from: { item: 1, fact: 0 },
            to: { item: 2, fact: 0 },
            says,
          }),
        ),
        [],
      );
    });

    it("returns an error for a link that names its facts by number, not by their item and place", async () => {
      assert.notDeepEqual(
        await replyErrors(linked({ from: 1, to: 2, says })),
        [],
      );
    });

    it("returns an error, at the link, for a link that names item 0 or a fact before the first", async () => {
      assert.deepEqual(
        await replyErrors(
          linked({
            from: { item: 0, fact: 0 },
            to: { item: 2, fact: 0 },
            says,
          }),
        ),
        ["/links/0 must name items from 1 and facts from 0"],
      );
      assert.deepEqual(
        await replyErrors(
          linked({
            from: { item: 1, fact: 0 },
            to: { item: 2, fact: -1 },
            says,
          }),
        ),
        ["/links/0 must name items from 1 and facts from 0"],
      );
    });

    it("returns an error, at the link, for a link within an item that names a fact before the first", async () => {
      const within = {
        answer: "x",
        short: "y",
        items: [{ ...item(1), links: [{ from: -1, to: 0, says }] }],
      };
      assert.deepEqual(await replyErrors(within), [
        "/items/0/links/0 must name facts from 0",
      ]);
    });
  });

  describe("given a reply with an item that rests on no fact and no absence", () => {
    it("returns no error for an item that gives only the model's own knowledge", async () => {
      assert.deepEqual(
        await replyErrors({
          answer: "x",
          short: "y",
          items: [
            {
              says: "…",
              why: "…",
              confidence: "low",
              knowledge: { says: "Allergy to a drug can fade over years." },
            },
          ],
        }),
        [],
      );
    });
  });

  describe("given a reply written to the other contract", () => {
    const files: Source = { at: async () => undefined };
    const copied = {
      answer: "…",
      short: "…",
      items: [
        {
          says: "…",
          why: "…",
          confidence: "high",
          facts: [
            {
              says: "D-dimer was raised.",
              provider: "Cascade North Demo Hospital",
              cite: { entry: "L41e35923" },
              name: "D-dimer",
            },
          ],
        },
      ],
    };

    it("returns errors for a reply about a pod whose facts copy what the record says, and for a reply about downloads whose facts name a field", async () => {
      assert.notDeepEqual(
        (await checkReply(copied, { ask, ran })).errors,
        [],
        "an app's reply that copies is turned away",
      );
      assert.notDeepEqual(
        (await checkReply(reply, { files, ran })).errors,
        [],
        "a reply that names a field is no reply about downloads",
      );
    });
  });

  describe("given `files` in place of `ask`, for a reply about downloads", () => {
    it("checks each fact's citation against the file it cites, and returns that file in `record.source`", async () => {
      const files = downloadsSource(
        fileURLToPath(
          new URL("../../test/fixtures/citations/", import.meta.url),
        ),
      );
      const checked = await checkReply(
        replyOf({
          says: "LDL was 131 mg/dL.",
          provider: "Cascade North Demo Hospital",
          cite: { file: "bundle.json", resource: "Observation/ldl-1" },
          value: 131,
          unit: "mg/dL",
        }),
        { files, ran: [] },
      );
      assert.deepEqual(checked.errors, []);
      const [result] = checked.items[0]!.facts;
      assert.equal(result!.verdict.ok, true);
      assert.deepEqual(result!.record?.source, ["bundle.json"]);
    });

    it("returns `nothing to check against` for a fact that cites a view entry", async () => {
      const files: Source = { at: async () => undefined };
      const checked = await checkReply(
        replyOf({
          says: "D-dimer was raised.",
          provider: "Cascade North Demo Hospital",
          cite: { entry: "L41e35923" },
          name: "D-dimer",
        }),
        { files, ran },
      );
      assert.deepEqual(checked.errors, []);
      assert.deepEqual(
        checked.items[0]!.facts.map(
          ({ verdict }) => !verdict.ok && verdict.reason,
        ),
        ["nothing to check against"],
      );
    });
  });

  describe("given neither `ask` nor `files`", () => {
    it("rejects, naming both", async () => {
      // @ts-expect-error a call names a pod to ask or the downloads to read, and at least one of them
      const neither = checkReply(reply, { ran });
      await assert.rejects(neither, /`ask`.*`files`.*neither/);
    });
  });

  describe("checkCopiedReply(reply, { ask, ran })", () => {
    it("checks a reply that copies what a view entry says against the pod's rows", async () => {
      const copied = {
        answer: "…",
        short: "…",
        items: [
          {
            says: "…",
            why: "…",
            confidence: "high",
            facts: [
              {
                says: "D-dimer was raised.",
                provider: "Cascade North Demo Hospital",
                cite: { entry: "L41e35923" },
                name: "D-dimer",
              },
            ],
          },
        ],
      };
      const answered = await checkCopiedReply(copied, { ask, ran });
      assert.deepEqual(answered.errors, []);
      assert.deepEqual(
        answered.items[0]!.facts.map(({ verdict }) => verdict.ok),
        [true],
      );
    });
  });

  describe("numberedReply(reply)", () => {
    const items = (reply as { items: object[] }).items.map((item) =>
      Object.fromEntries(Object.entries(item).filter(([key]) => key !== "n")),
    );
    const numbers = (value: unknown): number[] =>
      (value as { items: { n: number }[] }).items.map(({ n }) => n);

    it("numbers an item without `n` by its place, from 1", () => {
      assert.ok(items.length >= 3, "the recorded reply has items to number");
      assert.deepEqual(
        numbers(numberedReply({ ...(reply as object), items })),
        items.map((_item, at) => at + 1),
      );
    });

    it("keeps an `n` that an item is given", () => {
      const given = items.map((item, at) =>
        at === 1 ? { ...item, n: 7 } : item,
      );
      assert.deepEqual(
        numbers(numberedReply({ ...(reply as object), items: given })),
        items.map((_item, at) => (at === 1 ? 7 : at + 1)),
      );
    });
  });

  describe("replySchema", () => {
    it("uses only the JSON Schema keywords a provider's structured output takes", () => {
      assert.deepEqual(beyondStructuredOutput(replySchema), []);
      assert.notDeepEqual(
        beyondStructuredOutput(recordsReplySchema),
        [],
        "the check finds what the contract that copies what a file says uses",
      );
    });
  });

  describe("given the fields the vocabulary's views write on a view entry", () => {
    it("has a view that writes every field a kind is mapped to", async () => {
      const fields = await viewFields();
      assert.ok(fields.length > 40, "the views were read");
      assert.deepEqual(
        Object.keys(POD_FIELDS).filter((name) => !fields.includes(name)),
        [],
        "a field no view writes is no coverage: remove it from POD_FIELDS. Any other field a view writes is cited by its name, as a `property`, with nothing to map",
      );
    });
  });
});
