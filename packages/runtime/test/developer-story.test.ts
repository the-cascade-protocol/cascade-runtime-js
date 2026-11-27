import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { promisify } from "node:util";
import { podDataset } from "../src/dataset.js";
import { MemoryFiles } from "../src/files.js";
import { OxigraphStore } from "../src/oxigraph-store.js";
import { questions, withLists } from "../src/questions.js";
import { packed, vocabularyOf } from "../src/node/components.js";
import { localVocabulary } from "../src/node/runtime.js";
import { featurePod } from "../src/node/story-pod.js";
import { ROOT } from "./vocabulary.js";

const ALEX = "conformance/alex-rivera/alex-rivera.feature";
const FIRST_EXPORT =
  "conformance/alex-rivera/scripted-input/alex/downloads/x-e2/apple_health_export";
const PRIYA_DOWNLOADS =
  "conformance/priya-natarajan/scripted-input/priya/downloads";
const QUESTION = "pod/My active allergies";
/** A folder cascade-runtime's tarball is installed in, beside a copy of the script, to run the installed package. */
const APP =
  process.env.CASCADE_RUNTIME_APP === undefined
    ? undefined
    : resolve(process.env.CASCADE_RUNTIME_APP);

/** The folder the developer story's scripts and downloads are in: the repository's, or the app's copy of it. */
const STORY = APP ?? join(ROOT, "developer-story");

/** A tables store holding one version of a drug products series, so a fresh folder reads it without the feed. */
const DRUG_PRODUCTS = join(
  ROOT,
  "packages",
  "runtime",
  "test",
  "drug-products",
);

/** A row the script printed: a string for each column, an array of strings for each list column. */
type StoryRow = Record<string, string | readonly string[]>;

/**
 * What the script printed, run from a fresh folder, or the app's, on the arguments; its pod is removed after. A
 * fresh folder starts with `tables` as its `.tables/`; the app brings its own.
 */
async function printedBy(
  script: string,
  pod: string,
  downloads: readonly string[],
  tables?: string,
): Promise<string> {
  const folder = APP ?? (await mkdtemp(join(tmpdir(), "developer-story-")));
  if (APP === undefined && tables !== undefined)
    await cp(tables, join(folder, ".tables"), { recursive: true });
  if (APP === undefined)
    await writeFile(
      join(folder, "cascade-runtime.json"),
      JSON.stringify({ tables: { checkOnOpen: false } }),
    );
  const permissions =
    APP === undefined
      ? []
      : [
          "--permission",
          `--allow-fs-read=${APP}`,
          `--allow-fs-write=${APP}`,
          "--allow-worker",
        ];
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [...permissions, join(STORY, script), ...downloads],
      { cwd: folder, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    ).catch((error: { stderr?: string; code?: unknown; signal?: unknown }) => {
      throw new Error(
        `the script stopped (code ${String(error.code)}, signal ${String(error.signal)}): ${error.stderr || String(error)}`,
      );
    });
    return stdout;
  } finally {
    await rm(APP === undefined ? folder : join(APP, pod), {
      recursive: true,
      force: true,
    });
  }
}

/** Each row the script printed, a line of JSON each. */
async function story(
  script: string,
  pod: string,
  downloads: readonly string[],
  tables?: string,
): Promise<StoryRow[]> {
  return (await printedBy(script, pod, downloads, tables))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => {
          assert.ok(
            typeof value === "string" ||
              (Array.isArray(value) &&
                value.every((each) => typeof each === "string")),
            `?${column} is neither a string nor an array of strings`,
          );
          return [column, value as string | readonly string[]];
        }),
      ),
    );
}

/** The row with its entry as the path inside its pod: the replay's pod and the script's have different addresses. */
function inPod(row: StoryRow): StoryRow {
  return typeof row.entry !== "string"
    ? row
    : {
        ...row,
        entry: row.entry.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*\//i, ""),
      };
}

/** Each row as one string, its columns in name order, so two answers compare as multisets. */
function multiset(rows: readonly Record<string, unknown>[]): string[] {
  return rows
    .map((row) =>
      JSON.stringify(
        Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    )
    .sort();
}

/** The vocabulary the kits are in: the checkout's, or the installed package's. */
async function kits() {
  return APP === undefined
    ? localVocabulary(ROOT)
    : vocabularyOf(
        await packed(
          join(APP, "node_modules", "cascade-runtime", "components"),
        ),
      );
}

let throughJ1: Promise<StoryRow[]> | undefined;

/**
 * The rows "My active allergies" answers on the replay of Alex's kit through step J1, each entry as its path in the pod;
 * made once.
 */
function allergiesThroughJ1(): Promise<StoryRow[]> {
  throughJ1 ??= (async () => {
    const vocabulary = await kits();
    const replayed = await featurePod(
      vocabulary,
      ALEX,
      new MemoryFiles("https://pod.example/"),
      { through: "J1" },
    );
    const matched = replayed.steps.find(({ step }) => step.name === "M5");
    assert.ok(matched, "the replay through J1 has no matcher run M5");
    assert.equal(matched.refused, undefined, "M5 was refused");
    assert.equal(
      matched.wrote.filter((path) => !path.startsWith("provenance/")).length,
      0,
      "M5 wrote more than its act, so the replay, which claims after the matcher run, may no longer answer as the script, which claims at the import",
    );
    const last = replayed.steps.at(-1);
    assert.ok(last, `the replay of ${ALEX} through J1 performed no step`);
    const { store } = await podDataset(
      replayed.pod,
      vocabulary.layout,
      vocabulary.build,
      vocabulary.config.lens,
      new OxigraphStore(),
      { title: replayed.title, at: last.step.when },
    );
    const query = (await questions(vocabulary.files)).get(QUESTION);
    assert.ok(query, `the vocabulary has no question ${QUESTION}`);
    return (await store.select(query.text)).rows.map((row) =>
      inPod(
        withLists(
          Object.fromEntries(
            [...row].map(([column, term]) => [column, term.value]),
          ),
          query.lists,
        ),
      ),
    );
  })();
  return throughJ1;
}

const LISINOPRIL = {
  medication: "lisinopril 10 MG Oral Tablet",
  code: "https://ns.cascadeprotocol.org/codes/rxnorm/314076",
  records: "2",
};
const AMLODIPINE = {
  medication: "amlodipine 5 MG Oral Tablet",
  code: "https://ns.cascadeprotocol.org/codes/rxnorm/197361",
  records: "1",
};

/**
 * The scripts the README and the get-started page walk a developer through, run as that developer runs them: from a
 * folder outside the repository, on a kit's downloads, with the real Bridge.
 */
describe("The developer story's scripts, run from a fresh folder · developer-story/allergies.mjs, developer-story/medications.mjs, developer-story/first.mjs, developer-story/app.mjs, developer-story/review.mjs", () => {
  describe("when `allergies.mjs` is run on Alex's first export", () => {
    let printed: StoryRow[];
    let expected: StoryRow[];

    before(async () => {
      expected = await allergiesThroughJ1();
      const { files } = await kits();
      printed = await story("allergies.mjs", "alex-pod", [
        join(files.folder, FIRST_EXPORT),
      ]);
    });

    it('prints the rows that "My active allergies" answers on the kit\'s replay through step J1', (t) => {
      for (const row of printed) t.diagnostic(JSON.stringify(row));
      assert.deepEqual(multiset(printed.map(inPod)), multiset(expected));
    });
  });

  describe("when `app.mjs` loads Alex's sample pod through step J1 and asks it through `podApi` of `cascade-runtime/app`", () => {
    let printed: StoryRow[];
    let expected: StoryRow[];

    before(async () => {
      expected = await allergiesThroughJ1();
      printed = await story("app.mjs", "pods", []);
    });

    it('prints the rows that "My active allergies" answers on the kit\'s replay through step J1', (t) => {
      for (const row of printed) t.diagnostic(JSON.stringify(row));
      assert.deepEqual(multiset(printed.map(inPod)), multiset(expected));
    });
  });

  describe("when `review.mjs` loads Alex's whole sample pod and says what needs review through `worthALook` of `cascade-runtime/app`", () => {
    let printed: StoryRow[];

    before(async () => {
      printed = await story("review.mjs", "pods", []);
    });

    it("says, tagged Needs review, that sources disagree on how severe her Sulfamethoxazole allergy is: the one entry her pod says needs review", (t) => {
      for (const row of printed) t.diagnostic(JSON.stringify(row));
      assert.deepEqual(printed, [
        {
          sentence:
            "Sources disagree on how severe the Sulfamethoxazole allergy is.",
          tag: "Needs review",
        },
      ]);
    });
  });

  describe("when `first.mjs`, the get-started page's script, is run on Alex's sample export", () => {
    let printed: string;

    before(async () => {
      printed = await printedBy("first.mjs", "pods", []);
    });

    it("prints one source, Meridian Health System", (t) => {
      t.diagnostic(printed);
      assert.deepEqual(
        [...printed.matchAll(/^\s+name: '(.+)',$/gm)].map(([, name]) => name),
        ["Meridian Health System"],
      );
    });

    it("prints Codeine, Latex, Penicillin G and Sulfamethoxazole, each with the records it came from, all written by Meridian Health System", () => {
      const allergies = [
        ...printed.matchAll(
          /^(.+?) (\S+) \[\r?\n((?:\s+'.*',?\r?\n)+)\]\r?$/gm,
        ),
      ].map(([, allergen, , records]) => ({
        allergen,
        records: (records ?? "").trim().split(/\r?\n/),
      }));
      assert.deepEqual(
        allergies.map(({ allergen }) => allergen),
        ["Codeine", "Latex", "Penicillin G", "Sulfamethoxazole"],
      );
      for (const { allergen, records } of allergies)
        assert.ok(
          records.length > 0 &&
            records.every((record) =>
              record.includes("written by Meridian Health System"),
            ),
          `${allergen}: ${records.join()}`,
        );
    });
  });

  /**
   * The lisinopril of Priya's FHIR export and of her C-CDA summary is one entry: a README script reaches rule P2.
   * @rule conformance/priya-natarajan/priya-natarajan.feature P2
   */
  describe("when `medications.mjs` is run on Priya's export and her health summary", () => {
    let printed: StoryRow[];
    const medication = ({ medication, code, records }: StoryRow) => ({
      medication,
      code,
      records,
    });

    before(async () => {
      const { files } = await kits();
      printed = await story(
        "medications.mjs",
        "priya-pod",
        [
          join(files.folder, PRIYA_DOWNLOADS, "x-e2", "apple_health_export"),
          join(
            files.folder,
            PRIYA_DOWNLOADS,
            "kestrel-harbor-health-summary.xml",
          ),
        ],
        DRUG_PRODUCTS,
      );
    });

    it("prints an entry for every row, and no entry twice", (t) => {
      for (const row of printed) t.diagnostic(JSON.stringify(row));
      assert.ok(
        printed.every((row) => row.entry !== undefined),
        "a row names no ?entry",
      );
      assert.equal(
        new Set(printed.map((row) => row.entry)).size,
        printed.length,
        "two rows name one entry",
      );
    });

    it("prints lisinopril once, with two records", () => {
      assert.deepEqual(
        printed
          .filter((row) => row.medication === LISINOPRIL.medication)
          .map(medication),
        [LISINOPRIL],
      );
    });

    it("prints amlodipine once, with one record, and no other medication", () => {
      assert.deepEqual(
        multiset(printed.map(medication)),
        multiset([LISINOPRIL, AMLODIPINE]),
      );
    });
  });
});
