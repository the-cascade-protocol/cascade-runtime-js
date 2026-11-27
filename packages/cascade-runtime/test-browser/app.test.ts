// The packed package's `cascade-runtime/app` under its `browser` condition, opened in Chromium by a page with nothing
// installed: `npm run build:package`, then `npm run test:pod-browser`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { PACKAGE, serving } from "./serving.js";

/** The kit the published sample is made of, which the page copies as a sample person. */
const PERSON = "alex-rivera";

/** What the page of the app imports from the browser build, as much of it as the cases use. */
interface AppBuild {
  browserHost(options?: {
    samples: { names: readonly string[]; at: string };
  }): object;
  worthALook(
    answers: object,
    about?: undefined,
    said?: undefined,
    sections?: readonly object[],
  ): { sentence: string; tag?: string }[];
  podApi(
    host: object,
    options?: { sections?: readonly object[] },
  ): {
    makePod(input: { person: string }): Promise<unknown>;
    pods(): Promise<{ pods: { name: string }[] }>;
    pod(input: { pod: string }): Promise<unknown>;
    ask(input: {
      pod: string;
      question: string;
    }): Promise<{ rows: Record<string, unknown>[] }>;
    answers(input: { pod: string }): Promise<{
      answers: Record<string, unknown[]>;
    }>;
    close(): Promise<void>;
  };
}

/** The sample's files as the packed package publishes them, by the paths a page beside the samples' root reads. */
async function published(): Promise<Map<string, Uint8Array>> {
  const { samplesToPublish } = (await import(
    pathToFileURL(join(PACKAGE, "dist", "src", "node", "published.js")).href
  )) as typeof import("../src/node/published.js");
  const { files } = await samplesToPublish({ kits: [PERSON] });
  return new Map([...files].map(([path, bytes]) => [`/${path}`, bytes]));
}

/**
 * An app's page imports the browser build of `cascade-runtime/app` from the packed package and nothing else: the pod is a
 * copy of a sample published beside the app, kept in the browser's IndexedDB, and what PodApi answers of it is what Node's
 * host answers of the same sample.
 */
describe("Opening a sample pod in a browser through cascade-runtime/app · browserHost(), podApi()", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;

  before(async () => {
    assert.ok(
      existsSync(join(PACKAGE, "dist", "browser", "index.js")),
      `${PACKAGE} holds no packed browser build: run npm run build:package`,
    );
    server = await serving(await published());
    browser = await chromium.launch();
    page = await browser.newPage();
    const { port } = server.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${port}/`);
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  describe("given Alex Rivera's sample published beside the app", () => {
    it("copies it into IndexedDB, answers Alex's active allergies and the question of the app's one tile, and says what needs review", async () => {
      const seen = await page.evaluate(async (person) => {
        const url = "/dist/browser/app.js";
        const { browserHost, podApi, worthALook } = (await import(
          url
        )) as AppBuild;
        const allergies = {
          one: "allergy",
          question: "pod/My active allergies",
          field: "allergenName",
          codes: ["code"],
          columns: [],
        };
        const api = podApi(
          browserHost({
            samples: { names: [person], at: new URL("/", location.href).href },
          }),
          { sections: [allergies] },
        );
        const made = await api.makePod({ person });
        const { pods } = await api.pods();
        const { rows } = await api.ask({
          pod: person,
          question: "pod/My active allergies",
        });
        const { answers } = await api.answers({ pod: person });
        await api.close();
        return {
          made,
          pods: pods.map(({ name }) => name),
          allergens: rows.map((row) => String(row.allergenName)).sort(),
          drawn: Object.entries(answers)
            .filter(([, answered]) => answered.length > 0)
            .map(([question]) => question)
            .includes("pod/My active allergies"),
          review: worthALook(answers, undefined, undefined, [allergies]),
        };
      }, PERSON);
      const { review, ...read } = seen;
      assert.deepEqual(read, {
        made: { pod: PERSON, loaded: true },
        pods: [PERSON],
        allergens: ["Latex", "Peanuts", "Penicillin", "Sulfamethoxazole"],
        drawn: true,
      });
      assert.deepEqual(
        review.map(({ sentence, tag }) => ({ sentence, tag })),
        [
          {
            sentence:
              "Influenza, injectable, quadrivalent, preservative free was matched in two different ways.",
            tag: "Needs review",
          },
          {
            sentence:
              "Sources disagree on how severe the Sulfamethoxazole allergy is.",
            tag: "Needs review",
          },
        ],
      );
    });

    it("throws the `Refusal` the package's root build exports, from the same module, for a pod it has not", async () => {
      const seen = await page.evaluate(async () => {
        const app = "/dist/browser/app.js";
        const root = "/dist/browser/index.js";
        const { browserHost, podApi } = (await import(app)) as AppBuild;
        const { Refusal } = (await import(root)) as {
          Refusal: new (...rest: never[]) => Error;
        };
        const api = podApi(browserHost());
        try {
          await api.pod({ pod: "nobody" });
        } catch (error) {
          return error instanceof Refusal;
        }
        return "took it";
      });
      assert.equal(seen, true);
    });
  });
});
