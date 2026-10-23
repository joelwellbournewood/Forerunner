# w2-j9-merge: level 3 merges reviewed PRs after an accepting review (J.9)

Build: the commits `b78560d`, `1e6c912`, `89c25d1`, `8026c52` and `3806590` on
`wave/w2-j9-merge` over `ccr-4d8a843c-1k9syk` (merge base `049ed52`; the base has since moved to
`b1804e3`).

## Review

Verdict: revise

Score: 68

Reviewed `git log origin/ccr-4d8a843c-1k9syk..HEAD` and `git diff origin/ccr-4d8a843c-1k9syk...HEAD`
against the brief (J.9, with J.6 to J.10 and H.1 to H.3 as context) and the BLOCKERS row ("a
merge step in the critic loop at autonomy 3+ behind the hooks' `merge_pr` class, tested on the
fake git host with an accepting review and refused at level 2").

Requirements checked:
- After an accepting review on a task with a PR, the runner calls the merge port
  (`runner.ts` `case "accepted"`); a rejecting review makes no call. Holds.
- The merge is a `merge_pr` tool call through `beforeToolCall` / `afterToolCall` on a token
  derived from the session's (only `merge_pr`, only the worktree, budget 0), not a direct port
  call. Holds.
- Level 2: refused as `autonomy_insufficient` with an audit row, no approval card, PR open.
  Holds (`loop-merge.test.ts`, `hooks.test.ts`).
- Level 3: merged on the fake host, audit row allowed. Holds in the runner with test hooks; the
  daemon wiring is not proven (finding 1).
- Waits for the host's checks when the host reports checks; never merges a failing check or a
  conflict; those become a human request. Holds for check runs; not for commit statuses
  (finding 3), and "no check yet" is read as "no CI" (finding 4).
- Rebase before merge when the base moved, reusing `GitOps.rebaseOnto`. Holds.
- Records the merge on the task row (`reason`), an audit row, the session summary, the handoff
  and an event. Holds.
- Limits in code: the kill switch (finding 2) and the session wall-clock cap (finding 5) are
  not honoured by the merge step.
- Docs: runtime.md, capabilities.md and ADR 0062 describe the build; they say nothing about
  tier 3 tasks (finding 6).
- Base branch: a trial merge of `origin/ccr-4d8a843c-1k9syk` into the branch conflicts only in
  the Known issues list of `docs/maintainers/runtime.md` (both sides add a first bullet);
  with both bullets kept, `pnpm typecheck` is clean and
  `pnpm exec vitest run --project unit packages/runtime/test packages/capabilities/test` passes
  (152 files, 1394 passed, 1 skipped). No semantic conflict in `runner.ts` or `compose.ts`.
- Privacy and security: no secret in rows, logs or the request text (the token goes to `GitOps`
  auth only); the `unattended` flag is set only by runtime code, never from model input; an
  always-human class stays refused unattended at level 4. Holds.

### Findings

1. **medium**, `packages/runtime/src/daemon/compose.ts:2031`, `packages/runtime/test/loop-merge.test.ts:616`.
   The daemon test named "is composed on the daemon's hooks" issues its own token with
   `allowedTools: [MERGE_PR_TOOL]` and runs only level 2, so nothing proves that the daemon's
   session grant carries `merge_pr` or that its domains cover the PR URL, and nothing runs a
   level-3 merge through the daemon. Verified: with the `MERGE_PR_TOOL` entry deleted from
   `sessionGrant`, all 13 tests of `loop-merge.test.ts` still pass, while a real level-3 session
   in the daemon would be refused as `tool_not_allowed` and never merge.

2. **medium**, `packages/runtime/src/loop/merge.ts:370`. The kill switch does not stop the
   merge step. A `killed` error from `beforeToolCall` (the token revoked by `KillSwitch.stop`
   between the accepting review and the merge) is caught by
   `if (!(e instanceof ForerunnerError)) throw e;` and recorded as `not_allowed`. The task row
   then says "PR left open for you: the merge was refused (killed: ...)", and a session whose
   last task it was ends `completed` instead of `killed`: the loop's own kill check only runs
   before the next task. Verified with the added test (the kill switch pressed as the merge asks
   the hooks): before the fix the session status is `completed`. A stop *during* the checks
   wait is already handled, since `afterToolCall` throws `killed` on the revoked token. The
   added test for that path passed before the fix and stays as a regression test.

3. **medium**, `packages/runtime/src/loop/merge.ts:207`, `:252`. Only check runs are read.
   Commit statuses, the status API that Jenkins, many external CIs and deploy previews report
   through, are ignored. A PR whose CI reports `failure` as a commit status is merged at level 3.
   This breaks the brief's "never merges a PR with a failing check". The fake git host
   implements statuses (`testenv/src/githost/routes-checks.ts`), so this can be tested here.
   The build only listed it as a known issue. Verified with the added test (a
   `failure` status `ci/jenkins` beside a green check run): before the fix the PR is merged.

4. **medium**, `packages/runtime/src/loop/merge.ts:39`, `judgeChecks` `"none"`. "No check runs
   on the head" is read as "the host has no CI" and the PR is merged at once. A repository
   whose base branch reports checks does have CI; right after the PR push, or while the host
   is still queueing the workflow, the head simply has no check yet. Verified with the added
   test (`main` has a green `ci/test`, the PR head has none yet): before the fix the PR is
   merged without any check on its head.

5. **medium**, `packages/runtime/src/loop/merge.ts:227`, `:357`. The checks wait (10 minutes
   by default) and the run deadline ignore the session's wall-clock cap (spec I, "wall-clock cap
   per session", enforced in code). A session with one minute left waits the full 10 minutes
   for a running check. `beforeToolCall` checks the wall clock once at admission; the loop never
   does. Verified with the added test (a session of 2 minutes with a running check): before the fix
   the session is still waiting after 3 simulated minutes.

6. **low**, `docs/decisions/0062-merge-after-review-checks-rule.md:50`,
   `docs/maintainers/runtime.md:752`. A tier 3 task (deep review plus human sign-off, spec H)
   never reaches `decision: "accepted"` in the session: an accepting verdict becomes the
   sign-off request (`needs_human`), and the answer is applied outside a session by
   `syncSignoffAnswers`. So a tier 3 PR is never merged automatically. That is the right
   behaviour (the human who signs off is there to merge), but the ADR's "never merged
   automatically" list and runtime.md name only tier 0, and no test pins it.
