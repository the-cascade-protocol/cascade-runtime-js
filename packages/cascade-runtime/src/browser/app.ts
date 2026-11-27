// `cascade-runtime/app` in a browser: what every target gives, with the host whose pods are this browser's IndexedDB
// databases and the sign-ins that happen in a popup. It shares its modules with the root browser build (`index.ts`), and
// the package's browser build keeps the two entries as one runtime, so that a `Refusal` thrown here is the one that build
// exports. A page whose pods are at its server bundles `../app/index.js` instead, through `cascadeRuntime({ browser: false })`.
export * from "../app/index.js";
export * from "./app/browser-host.js";
export * from "./app/sign-ins.js";
