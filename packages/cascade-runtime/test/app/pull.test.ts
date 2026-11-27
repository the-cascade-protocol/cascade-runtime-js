import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { brandsBundle, demoRemapFetch } from "@the-cascade-protocol/sandbox";
import { loadHospital, serveDemo } from "@the-cascade-protocol/sandbox/node";
import { directoryOf, openPod } from "cascade-runtime";
import { rowOf } from "../hospitals.js";
import { gone } from "../settled.js";

const APP: string = "cascade-runtime/app";
const { nodeHost, podApi, signIns, worldOf } = (await import(APP)) as {
  nodeHost: (options: { folder: string }) => object;
  podApi: (
    host: object,
  ) => Record<
    "connect" | "connection",
    (input: object) => Promise<Connected>
  > & { close(): Promise<void> };
  signIns: () => {
    signIn: unknown;
    back: (url: URL) => unknown;
  };
  worldOf: (
    listener: { setWorldDate(asOf: string | undefined): void },
    asOf: string | undefined,
  ) => object;
};
type Connected = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * On Node an app serves its demo hospitals from a listener of its own, and `signIns()` gives PodApi the sign-in, and the
 * app's `/callback` the way back, that reach it. With them an app signs a demo person in and pulls their records with no
 * hospital on the internet. (The kit's `nodeHospitals` is this glue with the app's own directory.)
 */
describe("Reaching the demo hospitals from the Node server · signIns()", () => {
  describe("given a pod's `connect` to a demo hospital, approved at the listener", () => {
    let folder: string;
    let listener: Awaited<ReturnType<typeof serveDemo>> | undefined;
    let api: ReturnType<typeof podApi> | undefined;
    let fhirBase: string;
    let authorize: string;
    let returned: unknown;
    let pulledThere: Connected;

    before(async () => {
      folder = await mkdtemp(join(tmpdir(), "cascade-pull-"));
      const data = await loadHospital("cascade-north");
      fhirBase = rowOf(data).fhirBase;
      const demo = [{ ...data, autoApprove: "pt-1001" }];
      listener = await serveDemo(demo);
      const at = join(folder, "pods");
      await (await openPod(join(at, "pod"))).close();
      const { signIn, back } = signIns();
      api = podApi({
        ...nodeHost({ folder: at }),
        hospitals: {
          directory: async () =>
            directoryOf(
              brandsBundle(
                demo.map(({ hospital }) => hospital),
                new Date().toISOString(),
              ),
              "demo",
            ),
          registration: {
            clientId: "cascade-app",
            redirectUri: "http://127.0.0.1:3000/callback",
          },
          fetch: demoRemapFetch(listener.origin),
          ready: async () => undefined,
          signIn,
          pullName: () => "north",
        },
        world: worldOf(listener, undefined),
      });
      const { connection: n, authorize: toSignIn } = await api.connect({
        pod: "pod",
        fhirBase,
      });
      authorize = toSignIn;
      const approved = await globalThis.fetch(authorize, {
        redirect: "manual",
      });
      returned = back(new URL(approved.headers.get("location")!));
      pulledThere = await api.connection({
        pod: "pod",
        connection: n,
        wait: true,
      });
    });

    after(async () => {
      await api?.close();
      await listener?.close();
      await gone(folder);
    });

    it("sends the person to the listener to sign in", () => {
      assert.ok(
        authorize?.startsWith(listener!.origin),
        `sent to ${authorize}`,
      );
    });

    it("returns from `back(url)` the pod and the connection the hospital's redirect is for", () => {
      assert.deepEqual(returned, { pod: "pod", connection: 1 });
    });

    it("pulls from the hospital's FHIR base", () => {
      assert.equal(pulledThere["step"], "pulled");
      assert.deepEqual(
        pulledThere["sources"].map(({ server }: Connected) => server),
        [fhirBase],
      );
    });
  });
});
