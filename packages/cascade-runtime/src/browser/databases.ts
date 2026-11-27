// What the browser build names the IndexedDB databases it keeps, which the app's host lists to find the pods.

/** What names a pod's IndexedDB database, before the pod's name. */
export const DATABASE = "cascade-pod:";
/** What names the IndexedDB database a pod's answers are kept in, before the pod's name. */
export const ANSWERS_DATABASE = "cascade-answers:";
