// Pods as folders: what a pod may be called, the pods a folder holds, their titles, and the sample people's pods loaded
// into it.
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { podStated, Refusal, Unopened } from "@cascade-runtime/runtime";
import { notOpenedHere } from "../../app/pod-api.js";
import { openPod } from "../../index.js";
import { seconds } from "../../phase.js";
import type { Pod } from "../../pod.js";
import { loadSample } from "../../samples.js";
import { resolved } from "../resolved.js";

/** The kits whose pods the app was made with. */
export const KITS = [
  "alex-rivera",
  "priya-natarajan",
  "martin-okafor",
  "tamsin-vale",
];
export const POD_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The pod `name` in `folder`, opened without words, as the scripts and the MCP server do: an encrypted pod is a
 * `Refusal` saying so in one line, since only the app asks for its six words.
 */
export async function openWithoutWords(
  name: string,
  folder: string,
): Promise<Pod> {
  try {
    return await openPod(folder);
  } catch (error) {
    if (error instanceof Unopened && error.outcome === "secret needed")
      throw new Refusal(notOpenedHere(name));
    throw error;
  }
}

/**
 * The pods there are, by name: a folder still empty is none, so reading it never makes a pod, and neither is
 * `.answers`, where the runtime keeps each pod's answers.
 */
export async function podNames(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        (await readdir(join(folder, entry.name))).length > 0
      )
        names.push(entry.name);
    return names.sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** The folder the runtime keeps the pod's answers in. */
export function answersFolder(name: string, folder: string): string {
  return join(folder, ".answers", name);
}

/** Whether `error` says a file or folder is not there. */
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** The title `pod.json` keeps for the pod, the name typed when it was made; undefined where none is kept. */
export async function podTitle(
  name: string,
  folder: string,
): Promise<string | undefined> {
  try {
    const kept = JSON.parse(
      await readFile(join(answersFolder(name, folder), "pod.json"), "utf8"),
    ) as { title?: unknown };
    return typeof kept.title === "string" ? kept.title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The title the pod's manifest holds, for the pod that keeps no `pod.json` (a runtime run from a checkout writes none);
 * undefined where it was never titled, or where the pod is sealed.
 */
export async function titleInManifest(
  name: string,
  folder: string,
): Promise<string | undefined> {
  try {
    const parts = await resolved();
    const { files } = parts.folder(join(folder, name));
    return (await podStated(files, parts.layout, parts.newStore())).title;
  } catch {
    return undefined;
  }
}

/** Removes the pod and its answers. */
export async function deletePod(name: string, folder: string): Promise<void> {
  await rm(join(folder, name), { recursive: true, force: true });
  await rm(answersFolder(name, folder), { recursive: true, force: true });
}

/** Loads the kits' pods into `folder`; `out(text)`, when given, is told each kit with its seconds. Gives their names. */
export async function restoreKits(
  folder: string,
  out?: (text: string) => void,
): Promise<string[]> {
  for (const kit of KITS) {
    const started = performance.now();
    out?.(`\nLoading the pod ${kit}, from the kit the package carries…`);
    try {
      await loadSample(kit, join(folder, kit));
      out?.(` loaded in ${seconds(started)}\n`);
    } catch (error) {
      out?.("\n");
      throw new Error(`the pod ${kit} did not load: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }
  return [...KITS];
}

/** What an error says, whatever was thrown. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
