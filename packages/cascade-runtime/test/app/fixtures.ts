// What the app tests share: a sample app's tiles, as the starter kit's pod page draws them, and the rows, ClinVar answers
// and tables the tests of `said.ts` build their pages from.
import assert from "node:assert/strict";
import { codeStems, terms, type Terms } from "cascade-runtime";
import {
  day,
  rounded,
  type Section,
  type SectionRow,
  variantRows,
} from "cascade-runtime/app";

const text = (head: string, of: (row: SectionRow) => string | undefined) => ({
  head,
  show: (row: SectionRow) => of(row) ?? "",
});
const date = (head: string, of: (row: SectionRow) => string | undefined) => ({
  head,
  show: (row: SectionRow) => day(of(row)),
});
const number = (
  head: string,
  of: (row: SectionRow) => string | number | undefined,
) => ({ head, show: (row: SectionRow) => rounded(of(row)) });

const SEVERITY: Readonly<Record<string, string>> = {
  high: "High severity",
  low: "Low severity",
};
const LIFECYCLES: Readonly<Record<string, string>> = {
  [terms.MedicationActive]: "Active",
  [terms.MedicationPaused]: "Paused",
  [terms.MedicationUnknown]: "Unknown",
  [terms.MedicationStopped]: "Stopped",
};

/** A medication's status as the kit's Medications tile says it: its lifecycle, with the day it stopped or runs until. */
function medicationStatus(row: SectionRow): string {
  const said = LIFECYCLES[row.lifecycle ?? ""] ?? "Unknown";
  if (row.ended === undefined) return said;
  return row.lifecycle === terms.MedicationStopped
    ? `${said} ${day(row.ended)}`
    : `${said}, until ${day(row.ended)}`;
}

/** The starter kit's tiles, as `podApi` and the functions that read tiles take them. */
export const TILES: readonly Section[] = [
  {
    one: "allergy",
    question: "pod/My active allergies",
    field: "allergenName",
    codes: ["code"],
    columns: [
      text("Allergen", (row) => row.allergenName),
      {
        head: "Severity",
        show: (row) =>
          row.criticality === undefined
            ? ""
            : (SEVERITY[row.criticality] ??
              row.criticality.replaceAll("-", " ")),
      },
    ],
  },
  {
    one: "medication",
    question: "pod/My medication history",
    field: "medication",
    codes: ["code"],
    shows: (row) => row.lifecycle !== terms.MedicationEnteredInError,
    columns: [
      text("Medication", (row) => row.medication),
      { head: "Status", show: medicationStatus },
      date("Since", (row) => row.started),
      date("Prescribed", (row) => row.written),
    ],
  },
  {
    one: "condition",
    question: "pod/My active conditions",
    field: "condition",
    codes: ["conditionCode"],
    columns: [
      text("Condition", (row) => row.condition),
      date("Since", (row) => row.onset),
    ],
  },
  {
    one: "lab result",
    question: "pod/My lab results",
    field: "test",
    codes: ["code"],
    columns: [
      text("Test", (row) => row.test),
      number("Value", (row) => row.value),
      text("Unit", (row) => row.unit),
      date("Date", (row) => row.performed),
    ],
  },
  {
    one: "immunization",
    question: "pod/My immunizations",
    field: "vaccine",
    codes: ["code"],
    columns: [
      text("Vaccine", (row) => row.vaccine),
      date("Date", (row) => row.given),
    ],
  },
  {
    one: "procedure",
    question: "pod/My procedures",
    field: "procedure",
    codes: ["procedureCode"],
    columns: [
      text("Procedure", (row) => row.procedure),
      date("Date", (row) => row.performed),
    ],
  },
  {
    one: "variant",
    field: "variant",
    codes: [],
    rows: variantRows,
    columns: [
      text("Variant", (row) => row.variant),
      number("Reports", (row) => row.reports),
    ],
  },
];

export const ALLERGIES = "pod/My active allergies";
export const CONDITIONS = "pod/My active conditions";
export const LABS = "pod/My lab results";
export const MEDICATIONS = "pod/My medication history";
export const HISTORY = "pod/My medication history";
export const SEEN = "pod/What was seen more than once";
export const REVIEW = "entry/What needs review";
export const SOURCES = "entry/Where it came from";
export const VARIANTS = "pod/My genetic variants";
export const REPORTS = "pod/What each report says of a variant";

export const GROUPS = {
  iri: "urn:uuid:c1a6678c-2b4d-4287-b852-9039e6a71afd",
  label: "Example vaccine groups",
  licence: "http://creativecommons.org/publicdomain/zero/1.0/",
  publisher: "https://publisher.example/",
  credit: "Source: an example publisher",
  current: { iri: "ni:///v2", label: "2", issued: "2026-10-08T19:22:23Z" },
  versions: [
    { iri: "ni:///v2", label: "2", issued: "2026-10-08T19:22:23Z" },
    { iri: "ni:///v1", label: "1", issued: "2026-10-01T00:00:00Z" },
  ],
  checked: "2026-10-08T21:55:00Z",
  watched: { at: "2026-10-08T20:00:00Z", found: "nothing new" },
};

const ACMG_LABELS = {
  Pathogenic: "Pathogenic",
  LikelyPathogenic: "Likely pathogenic",
  UncertainSignificance: "Uncertain significance",
  LikelyBenign: "Likely benign",
  Benign: "Benign",
} as const;
const CLINVAR_LABELS = {
  ClinVarConflicting: "Conflicting classifications of pathogenicity",
  ClinVarConflictingData: "conflicting data from submitters",
  ClinVarCombinationOnly: "-",
  ClinVarVusHigh: "VUS-high",
  ClinVarRiskFactor: "risk factor",
  ClinVarMultipleSubmittersNoConflicts:
    "criteria provided, multiple submitters, no conflicts",
  ClinVarSingleSubmitter: "criteria provided, single submitter",
  ClinVarNoAssertionCriteria: "no assertion criteria provided",
} as const;
const CONCEPTS: Record<string, string> = {
  ...ACMG_LABELS,
  ...CLINVAR_LABELS,
};
export const concept = (name: string) => {
  assert.ok(name in CONCEPTS, name);
  return { iri: terms[name as keyof Terms] as string, label: CONCEPTS[name] };
};
export const LABELS = new Map(
  Object.entries(ACMG_LABELS).map(([name, label]) => [
    terms[name as keyof typeof ACMG_LABELS],
    label,
  ]),
);
export const VERSION = "ni:///clinvar-1";
export const ROW = `${codeStems.ClinVar}90011`;
export const rows = (fields: Record<string, unknown>) => ({
  found: "rows",
  series: "urn:test:clinvar",
  version: VERSION,
  rows: [{ variation: ROW, classification: [], ...fields }],
});
export const report = (
  id: string,
  classification: string | undefined,
  date: string | undefined,
) => ({
  report: id,
  variant: "v1",
  ...(classification === undefined
    ? {}
    : { classification: terms[classification as keyof Terms] as string }),
  ...(date === undefined ? {} : { date }),
});
export const verdict = (reportId: string, said: string, extra = {}) => ({
  report: reportId,
  row: ROW,
  origin: VERSION,
  verdict: said,
  ...extra,
});

export const DIFFERS = "Differs";
export const HARBOURLINE = "Harbourline Genetics";
export const COLUMBA = "St Columba's Hospital";
export const CLINVAR = {
  iri: "urn:test:clinvar",
  label: "ClinVar variant classifications",
  credit:
    "ClinVar, NCBI. Not intended for direct diagnostic use or medical decision-making without review by a genetics professional.",
  versions: [{ iri: VERSION, label: "1", issued: "2026-10-01" }],
};
export const entryRow = (
  entry: string,
  label: string,
  record: string,
  document: string,
  extra: object,
) => ({
  entry,
  entryLabel: label,
  record,
  document,
  importLabel: "FHIR pull",
  ...extra,
});
export const NAME = "NM_000249.3:c.2042C>T";
/**
 * One variant entry kept from two labs, a report of it from each, and a report whose variant only the reports name,
 * which has no lab.
 */
export const VARIANT_ANSWERS = {
  [ALLERGIES]: [{ entry: "e1", allergenName: "Penicillin" }],
  [VARIANTS]: [
    { variant: "v1", gene: "MLH1", hgvs: NAME },
    { variant: "v1", gene: "MLH1", hgvs: "NM_000249.4:c.2042C>T" },
    { variant: "v1", gene: "MLH1", variation: "90011" },
  ],
  [REPORTS]: [
    report("r1", "UncertainSignificance", "2022-05-01"),
    report("r2", "LikelyPathogenic", "2024-03-21"),
    { ...report("r3", "Benign", "2023-01-01"), variant: "orphan" },
  ],
  [SEEN]: [HARBOURLINE, COLUMBA].map((place) => ({
    entry: "v1",
    place,
    records: "1",
    places: "2",
  })),
  [SOURCES]: [
    entryRow("v1", `Variant entry · ${NAME}`, "v1-a", "doc-2022", {
      hospital: HARBOURLINE,
      arrived: "2026-09-01T10:00:00Z",
    }),
    entryRow("v1", `Variant entry · ${NAME}`, "v1-b", "doc-2024", {
      hospital: COLUMBA,
      arrived: "2026-09-02T10:00:00Z",
    }),
    entryRow("r1", "Interpretation entry · VUS", "r1-a", "doc-2022", {
      hospital: HARBOURLINE,
      arrived: "2026-09-01T10:00:00Z",
    }),
    entryRow("r2", "Interpretation entry · LP", "r2-a", "doc-2024", {
      hospital: COLUMBA,
      arrived: "2026-09-02T10:00:00Z",
    }),
    entryRow("r3", "Interpretation entry · Benign", "r3-a", "doc-other", {}),
    entryRow(
      "orphan",
      "Variant entry · NM_000500.1:c.1A>G",
      "o-a",
      "doc-other",
      {},
    ),
  ],
};
export const VARIANTS_SAID = {
  says: new Map([["v1", rows({ classification: [concept("Pathogenic")] })]]),
  verdicts: [verdict("r1", "differs")],
  labels: LABELS,
};
