/**
 * Cancel on a person's session waiting to go on, or on a Start kept for the reset
 * (d1109-run-visible V-2, V-5): what pressing it does, said with the button. A file of its own
 * with no imports, so the browser build can read it: `run-words.ts` reaches Node modules
 * through `task-words.ts`, and a value import of it made the app throw at load
 * (apps/ui/test/browser-imports.test.ts).
 */
export const CANCEL_WAIT_EXPLAIN =
  "Cancel: nothing starts when Claude is back; its tasks wait for your Start.";
