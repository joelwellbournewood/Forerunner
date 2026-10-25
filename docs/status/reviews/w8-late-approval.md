# w8-late-approval: a hooks approval answered after its session ended is consumed once

Branch `worktree-agent-acc862a6119ee2a76`, forked from `ccr-af5a431d-jc9xqj` at 7ad6011.
Item `w8-late-approval` (requirements J.7 and S.6; the open finding of the w5-review-findings
review in `docs/status/BLOCKERS.md`, "Open review findings of 2026-10-23").

## Build report

What was built (ADR 0088, `docs/decisions/0088-late-hooks-approval-consumed-by-the-task.md`):

1. `StateApprovals.request` (`packages/runtime/src/wiring/state-ports.ts`) matches a hooks
   approval by the task and the key across the agent's sessions: the session's own rows first,
   then the rows of the call's task filed by the same agent for the same human. The ADR 0052
   rules apply unchanged (open keeps pending with no second row; "no" denies; an always-human
   "yes" is spent once; any other "yes" holds). Another input, task, agent or human never
   matches; a run without a task sees only its session.
2. `syncLateApprovals` (`packages/runtime/src/session/late-approval.ts`, from
   `RuntimeApp.syncApprovals`, which now also runs when a session ends): a late "yes" claims
   the row (`markAnswer`, `answer-mark.ts`, the mark shared with the cloud runner), moves the
   task `needs_human -> ready` and asks the scheduler for one `message` start naming the
   request (`StartRequest.approvalRequestId`); the follow-up's re-made call consumes the
   answer. A "no" is `refused` and the task records it; a task that moved on is
   `task_moved_on`; a running session, a task in another session's hands, another agent's row
   and a row without a task wait. Start failures (port throw, background rejection through
   `reportingPlanStartFailures`) are `start_failed` with one warning.
3. The cloud runner's `InboxTrigger` claims such rows before its start, records the outcome
   after, skips rows the daemon acted on and releases a claim whose start was skipped.

Tests (all fail on the pre-change code): `packages/runtime/test/approvals-durable.test.ts`
(5 new cases, the port), `late-approval.test.ts` (7, the sync over the real runner and hooks),
`late-approval-daemon.test.ts` (2, the answer route), `services/cloud-runner/test/inbox-trigger.test.ts`
(5 new cases, the shared mark both ways; the pre-existing plan "released claim" case now
really reaches the release path: its trigger was built after the answer, so `since` excluded
the row).

Left open: several late approvals bundled into one cloud start name only the first on
`approvalRequestId` (cloud-runner.md Known issues); a late "yes" whose task is `in_review`
waits for the review; a level 0/1 follow-up files its plan again before the answer is consumed
(two approvals, both fail-closed). Pre-existing at the fork, not touched: `scripts/package-test-scripts.test.ts`
fails `pnpm typecheck` and `check-paths` (3 errors, `node:path`); the integration branch has
since fixed it (its diff against this branch shows the `flatMap` guard and the platform `join`).

Verification (2026-10-25, this worktree): `pnpm exec biome check <14 changed files>` "No fixes
applied"; `node scripts/check-paths.mjs` 1 hit, the pre-existing `scripts/package-test-scripts.test.ts`
(not mine); `pnpm typecheck` clean but for that file's 3 pre-existing errors;
`pnpm exec vitest run --project unit` on the four test files 38 passed (13 + 7 + 2 + 16); on
`packages/runtime/test` 140 files, 1296 passed, 1 skipped, 2 failed under load
(`context.test.ts` 20 s timeout, `monthly-jobs-wiring.test.ts` `settle()`), both passing on their
one re-run (16/16); on `services/cloud-runner/test` 9 files, 70 passed;
`node scripts/docs-check.mjs --base ccr-af5a431d-jc9xqj` ok (19 files).
