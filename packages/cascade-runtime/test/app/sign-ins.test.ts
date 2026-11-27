import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { popupSignIns } from "../../src/browser/app/sign-ins.js";
import type { DirectoryRow } from "../../src/connect/plan.js";

const ORIGIN = "https://app.test";
const SIGNED_IN = "cascade-runtime:signed-in";

interface FakePopup {
  readonly location: { href: string };
  closed: boolean;
  closes: number;
  close(): void;
}

const fakePopup = (): FakePopup => {
  const popup: FakePopup = {
    location: { href: "" },
    closed: false,
    closes: 0,
    close() {
      popup.closed = true;
      popup.closes += 1;
    },
  };
  return popup;
};

const row = (vendor: string): DirectoryRow => ({
  name: "A hospital",
  vendor,
  fhirBase: "https://hospital.test/fhir",
});

/** The page's `window` as far as sign-ins read it: `open` hands out the fake popups, and messages are delivered by `post`. */
describe("A sign-in at a hospital in a popup · popupSignIns()", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { window: globals["window"], location: globals["location"] };
  let opened: FakePopup[];
  let listeners: Set<(event: MessageEvent) => void>;
  let reports: string[];

  const post = (popup: FakePopup, url: string): void => {
    for (const listener of [...listeners])
      listener({
        origin: ORIGIN,
        source: popup,
        data: { type: SIGNED_IN, url },
      } as unknown as MessageEvent);
  };

  beforeEach(() => {
    opened = [];
    listeners = new Set();
    reports = [];
    globals["location"] = { origin: ORIGIN };
    globals["window"] = {
      open: () => {
        const popup = fakePopup();
        opened.push(popup);
        return popup;
      },
      addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (
        _: string,
        listener: (event: MessageEvent) => void,
      ) => listeners.delete(listener),
    };
  });

  afterEach(() => {
    globals["window"] = saved.window;
    globals["location"] = saved.location;
  });

  after(() => {
    globals["window"] = saved.window;
    globals["location"] = saved.location;
  });

  const report = (authorize: string): void => {
    reports.push(authorize);
  };

  describe("given a popup opened in the person's click", () => {
    it("takes that popup to the authorize URL, answers with the URL it is sent back to, and closes it", async () => {
      const sign = popupSignIns();
      sign.open();
      assert.equal(opened.length, 1);
      const pending = sign.signIn(
        row("epic"),
        { pod: "alex", connection: 1 },
        report,
      )(new URL("https://hospital.test/authorize?state=s"));
      const [popup] = opened;
      assert.equal(
        popup?.location.href,
        "https://hospital.test/authorize?state=s",
      );
      assert.deepEqual(reports, ["https://hospital.test/authorize?state=s"]);
      post(popup!, `${ORIGIN}/back?code=c&state=s`);
      assert.equal((await pending).href, `${ORIGIN}/back?code=c&state=s`);
      assert.equal(popup?.closed, true);
      assert.equal(opened.length, 1, "no other window was opened");
    });

    it("gives a second sign-in none: it opens its own", async () => {
      const sign = popupSignIns();
      sign.open();
      const first = sign.signIn(
        row("epic"),
        { pod: "alex", connection: 1 },
        report,
      )(new URL("https://hospital.test/authorize"));
      const second = sign.signIn(
        row("epic"),
        { pod: "alex", connection: 2 },
        report,
      )(new URL("https://hospital.test/authorize"));
      assert.equal(opened.length, 2);
      assert.notEqual(opened[0], opened[1]);
      post(opened[0]!, `${ORIGIN}/one`);
      post(opened[1]!, `${ORIGIN}/two`);
      assert.equal((await first).pathname, "/one");
      assert.equal((await second).pathname, "/two");
    });
  });

  describe("given the demo hospital and another vendor", () => {
    it("tells the demo hospital's page the pod as `login_hint`, and no other", async () => {
      const sign = popupSignIns();
      for (const vendor of ["demo", "epic"]) {
        sign.open();
        const pending = sign.signIn(
          row(vendor),
          { pod: "alex-rivera", connection: 1 },
          report,
        )(new URL("https://hospital.test/authorize?state=s"));
        post(opened.at(-1)!, `${ORIGIN}/back`);
        await pending;
      }
      assert.deepEqual(
        reports.map((href) => new URL(href).searchParams.get("login_hint")),
        ["alex-rivera", null],
      );
      assert.equal(
        new URL(reports[0]!).searchParams.get("state"),
        "s",
        "the hint is added to the URL, not made in its place",
      );
    });
  });

  describe("given a sign-in whose signal is already aborted", () => {
    it("is refused as cancelled, and closes the popup", async () => {
      const sign = popupSignIns();
      sign.open();
      await assert.rejects(
        sign.signIn(
          row("epic"),
          { pod: "alex", connection: 1 },
          report,
        )(new URL("https://hospital.test/authorize"), AbortSignal.abort()),
        { name: "ConnectionFailure", kind: "cancelled" },
      );
      assert.equal(opened[0]?.closed, true);
      assert.equal(listeners.size, 0, "nothing keeps listening");
    });
  });

  describe("given open() called twice", () => {
    it("lets the first closer close its own popup and leave the newer one for the next sign-in", () => {
      const sign = popupSignIns();
      const closeFirst = sign.open();
      sign.open();
      closeFirst();
      assert.equal(opened[0]?.closed, true);
      assert.equal(opened[1]?.closed, false);
      sign.close();
      assert.equal(opened[1]?.closed, true);
    });

    it("closes a popup no sign-in took, once", () => {
      const sign = popupSignIns();
      sign.open();
      sign.close();
      sign.close();
      assert.equal(opened[0]?.closes, 1);
    });
  });
});
