/**
 * The arguments a worker thread is started with, from the ones node was started with. A worker given the process's own
 * list loads each `--import` and `--require` preload again before its first call, and node refuses a list holding a
 * per-process option (`--max-old-space-size`, and the dozen `node --test` adds). So only the options that change what a
 * worker may do or report are kept: the permission model, which a worker started with a list of its own runs outside,
 * and `--enable-source-maps`.
 */
export function workerExecArgv(
  argv: readonly string[] = process.execArgv,
): string[] {
  const kept: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at] as string;
    if (
      /^--(permission|enable-source-maps|allow-(worker|child-process|addons|wasi)|allow-[a-z-]+=.*)$/.test(
        argument,
      )
    )
      kept.push(argument);
    else if (/^--allow-fs-(read|write)$/.test(argument) && at + 1 < argv.length)
      kept.push(argument, argv[++at] as string);
  }
  return kept;
}
