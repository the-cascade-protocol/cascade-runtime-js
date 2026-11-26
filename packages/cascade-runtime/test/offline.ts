import { isMainThread } from "node:worker_threads";

/**
 * The preload of every test process (`scripts/test.mjs`). A worker thread inherits it, and none of what it sets up
 * (see offline-main.ts) is needed there, so a worker loads nothing else: loading the runtime in each worker was most of
 * the time a worker took to start.
 */
if (isMainThread) await import("./offline-main.js");
