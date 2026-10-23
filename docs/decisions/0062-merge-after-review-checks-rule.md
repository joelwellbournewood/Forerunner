# 0062 — Merge after an accepting review: an unattended `merge_pr` call behind the hooks, the checks rule in the tool, and what is never merged automatically

Date: 2026-10-23
Status: accepted

## Context

Spec J.9: "Level 3 Trusted: also merges reviewed PRs and deploys to staging." The autonomy
table already freed `merge_pr` at level 3 and the git host port had `mergePullRequest`, but no
runtime code merged anything: after an accepting review the task was `done` and its pull
request stayed open for the human. The merge has to be enforced in code like every other limit:
a tool call the hooks see, with its audit row and its token. It also has to be safe without a
human looking: the critic reviewed one commit, CI may still be running or red, the base may
have moved, a peer may have pushed to the branch since the review.

## Decision

1. **Where.** The session runner, on `decision: "accepted"` for a task with a `pr_url`, calls
   `MergePort.mergeReviewed` (`ReviewedPrMerge`, `packages/runtime/src/loop/merge.ts`). Tier 0
   tasks close without a review and are never merged.
2. **A tool call through the hooks, unattended.** The port derives a token from the session's
   (only `merge_pr`, only the task worktree, budget 0) and calls `beforeToolCall` /
   `afterToolCall` around the `merge_pr` tool (action class `merge_pr`, the worktree a
   `pathFields` entry, the PR URL a `domainFields` entry). The call carries
   `RunContext.unattended`: nobody waits on an approval card for a step the runtime takes on its
   own, so where the level does not free the class the hooks refuse it as
   `autonomy_insufficient` with the audit row instead of filing an approval request. At level 2
   the PR therefore stays open for the human exactly as before (no new card per accepted task);
   at level 3 the tool runs. An always-human class stays refused unattended at every level.
3. **The checks rule lives in the tool**, so it holds for any caller:
   - The PR head must be the reviewed commit, which is the HEAD of the task worktree that
     `PrTaskExecutor` pushed and the critic diffed. A different head (a push after the review)
     is never merged. Without a worktree the reviewed commit is unknown and nothing is merged
     (`unverified`).
   - When the base moved past the branch (`git merge-base --is-ancestor`), the worktree is
     rebased onto it (as the executor does before the PR) and pushed with a lease. A conflict
     is never merged. A clean rebase keeps the reviewed change. Since CI must then see the
     rebased head, every check the reviewed head had is required again on the new head, and a
     missing one counts as pending.
   - The host's check runs on the head decide, taking the latest run per name. Any `failure`,
     `cancelled`, `timed_out` or `action_required` refuses. A queued or running check is waited
     for, polling every 30 s for up to 10 minutes. No check runs at all means the host has no
     CI and the merge goes on. `mergeable: false` is a conflict.
   - The merge is pinned to the checked head (`mergePullRequest(..., { sha })`), so a push
     between the last look and the merge fails on the host.
4. **What goes to the human.** A failed check, a check still running at the end of the wait, a
   conflict, a moved head and a host refusal each file one non-blocking `decision` request
   naming the check or the files. The hooks' refusal files none, since that is the level's
   normal course. Every outcome is written on the task row (`reason`) and reported in
   `SessionResult.merges`, the handoff, a `pr.merged` / `pr.left_open` event and the session
   summary.

Never merged automatically: below level 3; a PR whose head is not the reviewed commit; one
with a failed or still-running check; one with a conflict (on the host or in the rebase); a
task closed without a review (tier 0); a task whose reviewed commit is unknown.

## Consequences

- J.9 is met for PRs in code: the merge is a tool call with a token, an audit row and the
  autonomy decision, and level 2 projects see no change in behaviour.
- A rebase before the merge pushes to the task branch (with a lease, never the default branch).
  That push is part of the admitted `merge_pr` call, not a separate routine action.
- CI slower than the wait leaves the PR to the human, and no later session retries the merge by
  itself (runtime.md Known issues). Commit statuses (the older status API) are not read.
- The session grant in the daemon names `merge_pr`, and no tool registry offers it to a model.
  A specialist's token, an intersection with its spec, never carries it.

## Alternatives considered

- **Ask the human at level 2 through the normal approval path.** Rejected: it would add a
  card to every accepted task at the default level and change J.8. The human already merges
  from the Reviews tab or GitHub.
- **Call `GitHost.mergePullRequest` directly from the runner.** Rejected: the merge would
  bypass the hooks (no token check, no audit row, no autonomy decision). Limits are enforced by
  the hooks, never by the caller's good behaviour.
- **Merge without waiting for checks, or treat "no checks yet" after a rebase as green.**
  Rejected: right after a push the host may not have created its check runs yet, so "none"
  would merge an untested rebased head. Requiring the reviewed head's checks again closes that.
- **A sweep at the next session for PRs whose checks were still running.** Deferred: it needs
  a durable "merge pending" marker on the task and a rule for how stale an acceptance may be.
  The bounded wait plus a request covers the common case.
