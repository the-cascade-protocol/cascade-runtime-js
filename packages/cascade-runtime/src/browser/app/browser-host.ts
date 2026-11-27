// The host `podApi` reads in a page: the pods are the databases this browser keeps in IndexedDB, the tables the runtime keeps
// here, and the samples are published beside the app.
import type { Hospitals, PodHost, World } from "../../app/pod-api.js";
import {
  appTables,
  checkSecret,
  checkTables,
  deletePod,
  openPod,
  podTitle,
} from "../index.js";
import { ANSWERS_DATABASE, DATABASE } from "../databases.js";

/** How long a deletion waits before it says the pods are held open in other tabs. */
const OTHER_TABS_MS = 2000;

export interface BrowserHostOptions {
  /**
   * The sample pods the app publishes, by name, and the folder they are published in: a sample `<name>` is copied from
   * `<at>/<name>/pod/`. With none, the app has no samples.
   */
  readonly samples?: {
    readonly names: readonly string[];
    readonly at: string | URL;
  };
  /** Told what a page should say while a deletion waits for the pods to close in the person's other tabs. */
  readonly busy?: (said: string) => void;
  /** The hospitals the app signs in at, with `popupSignIns().signIn` for how a sign-in reaches the person. */
  readonly hospitals?: Hospitals;
  /** The world's date the demo hospitals answer as of. */
  readonly world?: World;
}

/** The names of the databases here whose name starts with `prefix`, without it. */
async function databases(prefix: string): Promise<string[]> {
  return (await indexedDB.databases())
    .map(({ name }) => name ?? "")
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .sort();
}

/**
 * The pods this browser keeps and their tables, for `podApi`. A person's pods are the databases `cascade-pod:<name>`,
 * which every app on this origin shares. The tables are the ones `configureTables` names, set before the first pod opens.
 */
export function browserHost({
  samples,
  busy = () => {},
  hospitals,
  world,
}: BrowserHostOptions = {}): PodHost {
  const published = samples && new URL(samples.at, location.href);
  if (published !== undefined && !published.pathname.endsWith("/"))
    throw new Error(
      `the samples' folder is a folder, its URL ending in a slash: ${published.href}`,
    );
  return {
    pods: {
      names: () => databases(DATABASE),
      title: (name) => podTitle(name),
      open: (name, options) => openPod(name, options),
      checkSecret: (name, secret) => checkSecret(name, secret),
      /** Deletes the pods and their answers, with `all` every answers database; never the tables. */
      async remove(names, { all = false } = {}) {
        const gone = all
          ? [...new Set([...names, ...(await databases(ANSWERS_DATABASE))])]
          : names;
        const slow = window.setTimeout(
          () => busy("Waiting for the pods to close in your other tabs…"),
          OTHER_TABS_MS,
        );
        const deleted = await Promise.allSettled(gone.map(deletePod));
        window.clearTimeout(slow);
        const failure = deleted.find(({ status }) => status === "rejected");
        if (failure !== undefined)
          throw (failure as PromiseRejectedResult).reason;
      },
    },
    samples: samples?.names ?? [],
    copySample: (name) =>
      openPod(name, { from: new URL(`${name}/pod/`, published).href }),
    tables: (pod) => appTables(pod),
    checkTables: () => checkTables(),
    opensEncrypted: true,
    ...(hospitals !== undefined && { hospitals }),
    ...(world !== undefined && { world }),
  };
}
