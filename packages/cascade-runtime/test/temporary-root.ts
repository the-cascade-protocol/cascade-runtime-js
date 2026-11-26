import { tmpdir } from "node:os";

export function sweepEndedRoots(_parent: string): void {}

export function takeTemporaryRoot(): string {
  return tmpdir();
}
