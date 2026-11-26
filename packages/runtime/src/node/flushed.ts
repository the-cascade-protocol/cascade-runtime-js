import type { FileHandle } from "node:fs/promises";

/** Flushes an open file or folder to its disk; under Node's permission model a process may not, and keeps its bytes as the system keeps them. */
export async function flushed(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_ACCESS_DENIED")
      throw error;
  }
}
