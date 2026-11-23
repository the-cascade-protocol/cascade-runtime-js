/** Placeholder until the writer: every file in one archive. */
export function archivesOf(
  files: readonly (readonly [string, Uint8Array])[],
  _limits?: { readonly entries: number; readonly bytes: number },
): (readonly (readonly [string, Uint8Array])[])[] {
  return [files];
}
