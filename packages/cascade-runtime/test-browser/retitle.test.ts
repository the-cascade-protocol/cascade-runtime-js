// The packed package's browser build, opened over IndexedDB in Chromium: `npm run build:package`, then
// `npm run test:pod-browser`. A browser has the engine, IndexedDB and workers that no Node test has.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { PACKAGE, serving } from "./serving.js";

/**
 * A pod kept in the browser's IndexedDB opens again with the title an app gave it. The title is in the pod's manifest and
 * in `pod.json` beside its answers, and `pod.titled` says whether one was ever given.
 */
describe("Retitling a pod in a browser · openPod(), pod.retitle(), podTitle()", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;

  before(async () => {
    assert.ok(
      existsSync(join(PACKAGE, "dist", "browser", "index.js")),
      `${PACKAGE} holds no packed browser build: run npm run build:package`,
    );
    server = await serving();
    browser = await chromium.launch();
    page = await browser.newPage();
    const { port } = server.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${port}/`);
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  describe("given a pod made with no title", () => {
    it("opens again with the new title in `pod.json` and in its manifest, and as titled", async () => {
      const seen = await page.evaluate(async () => {
        const url = "/dist/browser/index.js";
        const { openPod, podTitle, deletePod } = (await import(url)) as {
          openPod(name: string): Promise<{
            titled: boolean;
            retitle(title: string): Promise<void>;
            ask(question: { query: string }): Promise<unknown[]>;
            close(): Promise<void>;
          }>;
          podTitle(name: string): Promise<string | undefined>;
          deletePod(name: string): Promise<void>;
        };
        const name = "retitle-in-a-browser";
        const first = await openPod(name);
        const before = first.titled;
        const untitledAs = await podTitle(name);
        await first.retitle("Ada Lovelace");
        const during = first.titled;
        await first.close();
        const second = await openPod(name);
        const kept = second.titled;
        const keptTitle = await podTitle(name);
        await second.ask({ query: "SELECT * WHERE { ?s ?p ?o } LIMIT 1" });
        const computed = second.titled;
        await second.close();
        await deletePod(name);
        return { before, untitledAs, during, kept, keptTitle, computed };
      });
      assert.deepEqual(seen, {
        before: false,
        untitledAs: "retitle-in-a-browser",
        during: true,
        kept: true,
        keptTitle: "Ada Lovelace",
        computed: true,
      });
    });
  });

  describe("given an option key the browser's calls do not take", () => {
    it("refuses it in `configureRuntime`, `openPod` and `pod.import`, naming the call and the key, before the engine loads", async () => {
      const seen = await page.evaluate(async () => {
        const url = "/dist/browser/index.js";
        const { openPod, deletePod, configureRuntime } = (await import(
          url
        )) as {
          openPod(
            name: string,
            options?: object,
          ): Promise<{
            import(exported: string, options?: object): Promise<unknown>;
            close(): Promise<void>;
          }>;
          deletePod(name: string): Promise<void>;
          configureRuntime(settings: object): void;
        };
        const refusal = async (call: () => unknown): Promise<string> => {
          try {
            await call();
          } catch (error) {
            return `${(error as Error).name}: ${(error as Error).message}`;
          }
          return "took it";
        };
        const name = "refuse-an-option-in-a-browser";
        const configured = await refusal(() => configureRuntime({ bogus: 1 }));
        const opened = await refusal(() => openPod(name, { bogus: 1 }));
        const pod = await openPod(name);
        const imported = await refusal(() =>
          pod.import("x", { aboutSubject: true }),
        );
        await pod.close();
        await deletePod(name);
        return { configured, opened, imported };
      });
      assert.deepEqual(seen, {
        configured:
          "TypeError: configureRuntime does not take bogus: it takes base.",
        opened:
          "TypeError: openPod does not take bogus: it takes title, from, secret, key.",
        imported:
          "TypeError: pod.import does not take aboutSubject: it was renamed claimProfiles in build-6979c2fc.",
      });
    });
  });
});
