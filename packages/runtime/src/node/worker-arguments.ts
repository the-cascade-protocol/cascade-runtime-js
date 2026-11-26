import { Worker } from "node:worker_threads";

const PRELOAD = /^(--import|--require|-r)(=.*)?$/;
const NO_SUCH_OPTION = "--cascade-no-such-option";
const REFUSED = /invalid execArgv flags: (.*)$/;

/**
 * The `execArgv` a worker thread is started with, from the arguments node was started with, or `undefined` to let node
 * start it as it does by default, which passes on what a process without a preload needs. A worker given the process's
 * own list loads each `--import` and `--require` preload again before its first call, so with a preload the list is the
 * process's arguments less the preloads and less the options node refuses for a worker (`--max-old-space-size`, the
 * dozen `node --test` adds). A list of its own would otherwise drop the permission model, which such a worker runs
 * outside.
 */
export function workerExecArgv(
  argv: readonly string[] = process.execArgv,
): string[] | undefined {
  const kept: string[] = [];
  let preloaded = false;
  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at] as string;
    const preload = PRELOAD.exec(argument);
    if (!preload) kept.push(argument);
    else {
      preloaded = true;
      if (preload[2] === undefined) at++;
    }
  }
  return preloaded ? withoutRefused(kept) : undefined;
}

/**
 * Node has no call that asks which options a worker accepts, but the error for a list it refuses names every refused
 * option, and a list with an option that does not exist is always refused, so no worker starts. If node ever words
 * the error differently, only the permission model and source maps are kept.
 */
function withoutRefused(list: string[]): string[] {
  try {
    new Worker("", { eval: true, execArgv: [...list, NO_SUCH_OPTION] });
  } catch (error) {
    const named = REFUSED.exec((error as Error).message);
    if (named) {
      const refused = new Set((named[1] as string).split(", "));
      const accepted: string[] = [];
      for (let at = 0; at < list.length; at++) {
        const argument = list[at] as string;
        if (!refused.has(argument)) accepted.push(argument);
        else if (!argument.includes("=") && !list[at + 1]?.startsWith("-"))
          at++;
      }
      return accepted;
    }
  }
  const kept: string[] = [];
  for (let at = 0; at < list.length; at++) {
    const argument = list[at] as string;
    if (
      /^--(permission|enable-source-maps|allow-[a-z-]+(=.*)?)$/.test(argument)
    )
      kept.push(argument);
    if (/^--allow-fs-(read|write)$/.test(argument) && at + 1 < list.length)
      kept.push(list[++at] as string);
  }
  return kept;
}
