# w3-b5-reasons: every change to a milestone or a session plan carries author and reason

Build report: no build report file was committed on the branch; the build is the commits
`31bef20`, `bf1612d`, `57f0d3c` and `31f42b4` over `ccr-4d8a843c-1k9syk` (merged again at review
time with `82a6295`, the APK verifier, which does not overlap).

## Review

Verdict: accept

Score: 86

Reviewed `git log origin/ccr-4d8a843c-1k9syk..HEAD` and `git diff origin/ccr-4d8a843c-1k9syk...HEAD`
against the brief (B.5; the BLOCKERS row asks for "a `reason` on milestone updates and plan
patches, required by the repository method").

What holds:
- Migration 0005 adds `milestone.reason` and `session.reason` (`TEXT NOT NULL DEFAULT ''`, `IF NOT EXISTS`
  on Postgres). The schema snapshot, the forward-migration tests and the generated
  `data-model.md` agree.
- `MilestoneRepo.change` and `SessionRepo.setPlan` take the reason and the actor and do the
  optimistic version check. `requireChangeReason` sits in the `updateWhere` override, so the
  generic `update` and `patch` cannot skip it. I grepped every non-test caller in `packages/`,
  `services/`, `apps/` and `tests/`: none writes a milestone or a session `plan` through another
  path (the `data/import.ts`, `misc.ts` and memory `updateWhere` calls touch other tables).
- The daemon serves `GET /projects/:id/milestones` and `POST /milestones/:id`. A milestone change
  writes the row and a `milestone.change` audit row in one transaction (the before -> after
  history). A missing or blank reason, a stale version or a bad date returns 409, and nothing
  moves.
- `applyProjectPlan` puts the plan's reason on the milestones it inserts and on the
  small-project join. The runner writes the plan with `setPlan`, the agent as author and the
  planner's summary as the reason.
- The UI Plan tab's Edit dialog requires a reason and posts the row's version. The fake daemon
  checks the body with the real `ChangeMilestoneBody` schema.
- No command edits milestones, so `packages/commands` has nothing to change, as `runtime.md` says.

Verification run at review time (after the merge of the base):
- `pnpm exec vitest run --project unit packages/state/test packages/runtime/test/change-reasons.test.ts packages/runtime/test/session.test.ts packages/runtime/test/small-project.test.ts packages/runtime/test/closeout-sessions.test.ts packages/critic/test packages/capabilities/test/projects-mirror.test.ts`:
  24 files, 269 tests passed.
- `pnpm exec vitest run --project unit packages/runtime/test`: 115 files, 988 passed and 1 skipped.
- `pnpm --filter @forerunner/ui test`: 42 files, 254 tests passed.
- `pnpm typecheck`: clean.
- `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk`: `docs-check: ok (35 files)`.
- The Postgres conformance and migration tests (`FORERUNNER_TEST_PG`) were not run: there is no
  database on this runner. The Postgres DDL is the SQLite DDL plus `IF NOT EXISTS`, so I see
  little risk.

Findings:

1. **low**: `packages/state/src/repos/base.ts:184` (`insert`), with callers
   `packages/capabilities/src/githost/projects-mirror.ts:804` and
   `packages/runtime/src/session/intake.ts:635`. **Problem:** inserting a milestone, or a session
   that carries a non-empty `plan`, needs no reason. The mirror's session and the intake session
   are created with a plan, `author_agent` set and `reason: ""`. `MilestoneRepo.insert` also
   accepts a row with no reason and no author. The brief only asks for "updates and patches", and
   the one production milestone creator (`applyProjectPlan`) does pass the reason. Even so, the
   data-model.md invariant says the refusal applies "on every write path", which a reader will
   take to cover inserts, and spec B.5 says "every change". **Verified:** a throwaway test in
   `packages/state/test`, since deleted, inserted a milestone and a session with
   `plan: [{ kind: "mirror" }]` on a fresh store. Both rows read back with `reason === ""` and
   null authors. **Fix:** either guard inserts too (milestone always; session when `plan` is not
   `{}`) and pass a reason from the two session creators ("GitHub projects mirror", "intake of
   <project>"), or narrow the data-model.md and runtime.md wording to "every update path (`update`
   and `patch` included); inserts are not checked".
2. **low**: `packages/runtime/src/session/runner.ts:603-610` and
   `docs/maintainers/runtime.md:570`. **Problem:** the comment and the doc justify the extra
   read before `setPlan` with "spend counters bump the version between start and plan". No
   production code does that: `SessionRepo.recordSpend` has no non-test caller, and
   `misc.ts:addSpent` updates `budget_window`, not `session`. Reading the row just before writing
   it also makes the version check nearly useless, since it compares the row against itself
   milliseconds later. Behaviour is correct, but the stated reason is wrong and will mislead the
   next maintainer. **Verified:** grepped `recordSpend(` and every `.session.(patch|update|…)(`
   in `packages/*/src` and `services/*/src`. **Fix:** check against `session.version` from
   `start()` (line 376) and drop the extra read, or keep the read and correct the comment and the
   doc sentence.
3. **low**: `apps/ui/src/pages/project/PlanTab.tsx:557` and `:657`. **Problem:** the reason line
   under a milestone row and the reason `<input>` in the edit dialog share
   `data-testid="milestone-reason"`. The tests work only because each lookup is scoped with
   `within(row)` or `within(dialog)`. A plain `getByTestId("milestone-reason")` while the dialog
   is open finds several elements and throws, and the e2e and phone specs use plain lookups.
   **Verified:** read the component and `project-tabs.test.tsx` (the row assertions use
   `within(rowOf(...))`; the dialog typing uses `within(dialog)`). **Fix:** rename the input's test
   id to `milestone-change-reason` and update the two test lines.
4. **low**: `apps/ui/src/pages/project/PlanTab.tsx:750`
   (`SmallProjectPlan`). **Problem:** the small-project Plan tab has its own Edit button, dialog
   and `onSaved` wiring, but no test opens it. Only the phased-project path is tested in
   `project-tabs.test.tsx`, and `small-project.test.tsx` does not mention `edit-milestone`. A
   regression in the small-project wiring, such as `replaceMilestone` not reaching the open
   milestone that `smallProjectMilestone` recomputes, would go unnoticed. **Verified:** grepped
   `apps/ui/test` for `edit-milestone` / `milestone-dialog`; all 7 hits are in
   `project-tabs.test.tsx`. **Fix:** add one small-project case: edit the open milestone with a
   reason, assert the posted body and the reason shown under it.
5. **low**: `docs/maintainers/runtime.md:2054` (Known issues, "B.5 history"). **Problem:** this is
   documented, not hidden. Repository-level history is only the *last* reason (the same as tasks);
   the before -> after trail exists only where a caller appends an audit row. The session plan's
   trail is the `session.planned` event, which records the summary and the item count but not the
   previous plan. The brief's hint asked for "a history row readable back with before/after".
   That hint was marked as possibly imprecise, and the task path has no such row either, so I am
   not counting it against the item. **Verified:** read `MilestoneRepo.change`, `SessionRepo.setPlan`
   and `TaskRepo.transition` (`task.ts:142-175`, a column and no history). **Fix:** none needed for
   B.5 as the BLOCKERS row words it. If wanted later, append the audit row inside
   `MilestoneRepo.change` and `SessionRepo.setPlan` so every caller leaves history.
