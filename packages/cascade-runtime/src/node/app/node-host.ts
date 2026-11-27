// The host `podApi` reads on Node: the pods are folders in `folder`, the reference tables are kept beside them.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PodHost } from "../../app/pod-api.js";
import { checkSecret, openPod, tablesBeside } from "../../index.js";
import { podReads } from "../pod-reads.js";
import { deletePod, podNames, podTitle, restoreKits } from "./pods.js";

/**
 * The pods in `folder` and their tables, for `podApi`. With `opensEncrypted` false, an encrypted pod is refused rather
 * than asked for its words; `unsaid(kind, error)` is told when the tables cannot say what a page would name.
 */
export function nodeHost({
  folder,
  opensEncrypted = true,
  unsaid = () => {},
}: {
  folder: string;
  opensEncrypted?: boolean;
  unsaid?: (kind: string, error: Error) => void;
}): PodHost {
  return {
    pods: {
      names: () => podNames(folder),
      title: (name) => podTitle(name, folder),
      open: (name, options) => openPod(join(folder, name), options),
      checkSecret: (name, secret) => checkSecret(join(folder, name), secret),
      async remove(names, { all = false } = {}) {
        for (const name of names) await deletePod(name, folder);
        if (all)
          await rm(join(folder, ".answers"), { recursive: true, force: true });
      },
    },
    compact: (name, pod, input) =>
      podReads({ names: async () => [name], open: async () => pod }).compact!({
        ...input,
        pod: name,
      }),
    samples: [],
    restore: () => restoreKits(folder),
    tables: () => tablesBeside(folder),
    checkTables: async () =>
      (await tablesBeside(folder)).check({ cache: "no-cache" }),
    opensEncrypted,
    unsaid,
  };
}
