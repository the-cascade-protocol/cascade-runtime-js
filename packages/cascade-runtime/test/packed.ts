import { createHash } from "node:crypto";
import { type FolderFiles, packZip } from "@cascade-runtime/runtime/node";

/**
 * Moves the pod's files at the paths into one archive the runtime's writer makes, in `archives/` and named by the SHA-256 of
 * its bytes, and removes them from their own paths, as a host that keeps archives holds them (X1); returns the archive's
 * path.
 */
export async function packedFolder(
  files: FolderFiles,
  paths: readonly string[],
): Promise<string> {
  const sorted = [...paths].sort();
  const held: (readonly [string, Uint8Array])[] = [];
  for (const path of sorted)
    held.push([path, (await files.read(path)) ?? new Uint8Array()]);
  const { bytes } = packZip(held);
  const path = `archives/${createHash("sha256").update(bytes).digest("hex")}.zip`;
  await files.write(path, bytes);
  await files.remove(sorted);
  return path;
}
