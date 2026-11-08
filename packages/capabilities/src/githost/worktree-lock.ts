import { resolve } from "@forerunner/platform";

/**
 * One lock per task folder, in this process (ADR 0111, leftovers7-merge2 R-lock). Every git step
 * in a task's worktree takes it: the PR executor's run, a resolved conflict, a rebuild of a
 * dependent branch, setting work aside, and the merge step's own steps there (bringing the base
 * into the branch and pushing it, reading the reviewed commit, the files of a conflict). Two of
 * them never interleave in one folder: before, the merge step built its git on the task
 * folder with no lock, so a rebuild could reset the branch between its merge of the base and
 * its push, and the merge then pushed (and merged) the rebuilt head as if it were reviewed.
 *
 * `inWorktree` waits for the folder; `tryWorktree` skips a busy one (a rebuild: it is owed and
 * tried again at the next poll). Keys are the resolved path, so two spellings of one folder
 * share the lock. A daemon is one process; another process on the same folder is not covered.
 */
const worktreesInUse = new Map<string, Promise<unknown>>();

function keyOf(dir: string): string {
  return resolve(dir);
}

/** Runs `fn` once nothing else works in `dir` (in this process), holding it meanwhile. */
export async function inWorktree<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(dir);
  for (let held = worktreesInUse.get(key); held; held = worktreesInUse.get(key))
    await held.catch(() => undefined);
  const p = fn();
  worktreesInUse.set(key, p);
  try {
    return await p;
  } finally {
    if (worktreesInUse.get(key) === p) worktreesInUse.delete(key);
  }
}

/** Runs `fn` holding `dir`, or returns null at once when something works there now. */
export async function tryWorktree<T>(dir: string, fn: () => Promise<T>): Promise<T | null> {
  if (worktreesInUse.has(keyOf(dir))) return null;
  return inWorktree(dir, fn);
}

/** Whether something works in `dir` now (in this process). */
export function worktreeBusy(dir: string): boolean {
  return worktreesInUse.has(keyOf(dir));
}
