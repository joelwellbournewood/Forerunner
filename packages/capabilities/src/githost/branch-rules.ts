import type { GitOps } from "./git.ts";
import { DEPS_BASE_REF } from "./pr-executor.ts";

/**
 * What a task branch holds, for the merge step and the PR executor (ADR 0111). A branch that
 * brought other work in by merging (a dependency's unmerged branch, or the base) must be kept
 * up to date by merging: a rebase would copy that work into the branch as new commits, and the
 * work it copied would never reach the base as itself (its pull request never marked merged,
 * a later merge of it an add/add conflict).
 */

/**
 * True when the worktree's branch holds work merged in from elsewhere: the marker of the
 * dependencies it builds on (`DEPS_BASE_REF`), or a merge commit since it left `base` (a ref
 * such as `origin/main`).
 */
export async function holdsMergedWork(git: GitOps, base: string, head = "HEAD"): Promise<boolean> {
  if (await git.hasRef(DEPS_BASE_REF)) return true;
  return git.hasMergesSince(base, head);
}

/**
 * The patch id of the task's own change on `head`: the diff from what the branch builds on to
 * `head`, without context lines (`GitOps.patchId`). What it builds on is the dependencies'
 * marker when the worktree has one (after `base` was merged in since, the merge of the marker
 * and that base), else where the branch left `base`. The same change made another way (main
 * merged in, a rebuild onto main once a dependency is in it) keeps its id; a commit pushed on
 * top that changes anything changes it. Null when it cannot be told (no common history, or a
 * git too old to merge trees), which every caller reads as "changed".
 */
export async function ownChangeId(
  git: GitOps,
  base: string,
  head = "HEAD",
): Promise<string | null> {
  const forked = await git.mergeBase(base, head);
  if (!forked) return null;
  let from: string = forked;
  if (await git.hasRef(DEPS_BASE_REF)) {
    from = DEPS_BASE_REF;
    // The base was merged into the branch after its dependencies were: the branch now builds
    // on both, so the own change is measured from their merge.
    if (!(await git.isAncestor(forked, DEPS_BASE_REF))) {
      const both = await git.mergeTree(DEPS_BASE_REF, forked);
      if (!both) return null;
      from = both;
    }
  }
  return git.patchId(from, head);
}
