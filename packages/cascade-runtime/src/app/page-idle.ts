// The page's side of the idle lock: PodApi's own clock cannot blank what the page shows, so a page that has made no call
// the person caused for `IDLE_LOCK_MS` reads itself again, and the server, which looks first, has locked the pods.
import { IDLE_LOCK_MS } from "./pod-api.js";

const listeners = new Set<() => void>();

/**
 * `api` that tells the page's idle clock of each call the person caused. A `connection` that waits is the page asking
 * again by itself, and counts for nothing, as it does not at the server.
 */
export function idleCounted<Api extends object>(api: Api): Api {
  return Object.fromEntries(
    Object.entries(api).map(([operation, run]) => [
      operation,
      async (input?: { wait?: unknown }) => {
        const counts = !(
          operation === "connection" && input?.wait !== undefined
        );
        if (counts) for (const each of listeners) each();
        try {
          return await (run as (input?: object) => Promise<unknown>)(input);
        } finally {
          if (counts) for (const each of listeners) each();
        }
      },
    ]),
  ) as unknown as Api;
}

/**
 * Calls `revalidate`, which reads the page's loaders again, once no call the person caused has been made for
 * `IDLE_LOCK_MS`, and when the tab is shown again; the function it gives stops that.
 */
export function revalidateWhenIdle(revalidate: () => unknown): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rearm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void revalidate(), IDLE_LOCK_MS);
  };
  const shown = () => {
    if (document.visibilityState === "visible") void revalidate();
  };
  rearm();
  listeners.add(rearm);
  document.addEventListener("visibilitychange", shown);
  return () => {
    clearTimeout(timer);
    listeners.delete(rearm);
    document.removeEventListener("visibilitychange", shown);
  };
}
