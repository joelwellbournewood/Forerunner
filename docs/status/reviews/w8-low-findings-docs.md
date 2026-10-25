# w8-low-findings-docs: the open low findings of w3-b5-reasons and w4-stale-docs, passages said twice

Build of 2026-10-25 on `worktree-agent-aa2a3f82d4c61499d`, forked from `ccr-af5a431d-jc9xqj`
at 7ad6011 and merged with its head 52ecb2d (the package-test-scripts fixes) before the
verification. Handover items 4 (the B.5 and w4-stale-docs low findings) and 8 (paragraphs a
merge kept from both sides) of `docs/status/PROGRESS.md`.

## w3-b5-reasons (review `w3-b5-reasons.md`, accept 86)

1. Insert paths (low): re-verified, a defect. `Repository.insert` ran no reason check, so a
   milestone row, or a session row created with its plan, carried `reason: ""` and no author
   while data-model.md said the refusal holds on every write path. Fixed with the guard (the
   callers can carry a real reason): `MilestoneRepo.insert` calls `requireChangeReason`;
   `SessionRepo.insert` does so when the row carries a plan (anything but the empty placeholder
   `{}` or `[]`, `isEmptyPlan`); `insertMany` goes through `insert`; both overrides are async so
   the refusal is a rejection. The three production creators of planned sessions name a reason
   with the agent as author: the projects mirror (`GitHub projects mirror run (<trigger>)`), the
   intake (`intake of <project>`) and the critic calibration (its plan summary); the plan writer
   already passed the plan's reason on milestones. Every test fixture that seeded an unreasoned
   milestone or planned session now carries one (state suite and migration test, small-project,
   projects-mirror, handover-job, the critic and state-api harnesses, the e2e worlds). No ADR:
   the guard makes the documented rule true rather than changing a decision. Tests: suite.ts
   "a milestone insert, and a session insert that carries a plan, need the reason and the
   actor too" (fails without the guard; SQLite and the Postgres conformance run), schema.test.ts
   (the migration test asserts the refusal and a reasoned insert), the reason read back in
   `projects-mirror.test.ts`, `intake.test.ts`, `calibration-job.test.ts`. Docs: data-model.md
   (generated from `docs.ts`), migrations.md, runtime.md (the callers), capabilities.md,
   critic.md, state-service.md, testing.md.
2. The fresh read before `setPlan` (low): re-verified, the comment was wrong ("spend counters"
   touch no session row: `recordSpend` has no production caller, `addSpent` writes
   `budget_window`). What does move the row while the planner works is the daemon's pause port
   (`session-ports.ts` marks a running row `paused` at once) and a kill, each bumping the
   version; neither is a plan conflict, and the runner is the row's only plan writer. The fresh
   read stays: checking against the version from `start()` would turn a pause during planning
   into a `version_conflict` failure of the session. The comment and the runtime.md sentence
   say so. Test: `session.test.ts` "writes the plan against a fresh read of the row": a planner
   that pauses the row mid-plan still gets the plan written (agent, summary as reason, no
   `session.error`), and a write against the start version is refused as stale with the plan
   intact; the repository-level refusal stays in suite.ts.
3. Shared `data-testid="milestone-reason"` (low): fixed, the input is `milestone-change-reason`;
   `project-tabs.test.tsx` asserts exactly one `milestone-reason` element with the dialog open.
   No e2e or phone spec used the id (grep over `apps/`, `tests/`).
4. Small-project Edit dialog untested (low): fixed, `small-project.test.tsx` "the one
   milestone's Edit dialog posts the version and the reason; the reason shows under it":
   posted body (version 1, reason, every field), the dialog closing, the reason under the same
   milestone `smallProjectMilestone` recomputes, the other milestones unchanged.
5. Last-reason-only history: not a defect, unchanged (runtime.md Known issues says so).

## w4-stale-docs (review `w4-stale-docs.md`, accept 92)

1. apps.md approvals web, the solo `sqlite:` desktop row (low): re-verified against
   `compose.ts`: `registerDevice = services || remoteEnabled || opts.remote?.enabled`, so the
   `desktop` row exists on every store whenever the services run (ADR 0030;
   `loop-routes.test.ts` "a solo install's desktop is the paired device"), and only the
   heartbeat and the watcher need `remoteCommandsEnabled`, which on a `sqlite:` store needs
   `FORERUNNER_REMOTE_COMMANDS=1`. The entry now says that (the review's wording would still
   have been short of the row existing).
2. The triage's P2 count (low): a dated addendum (2026-10-25) under the P2 table of
   `docs/status/reports/triage-2026-10-23.md` classifies the web chat envelope
   (`Chat.tsx` sends `command: "chat"`, `routes/remote.ts` has `start`, `pause`, `stop`, `kill`)
   as P2 with workaround and fix, and states the count as 164. The only status file edited.
3. testing.md re-wrap (low): the two sentences the review names (now at the live harness's
   test list and the phase 1 gate case) plus every other prose line past 120 columns (the
   phase 5 harness paragraph, the measured week, the RT-P5-2 pin, the phase 7 list, the live
   run's environment notes, the metered abort cases, scenario 9's rows) re-wrapped at the
   document's width; code blocks and table rows left as they are; no content change.

## Passages said twice (handover item 8)

Method: every `docs/maintainers/*.md` and `docs/decisions/*.md` swept for exact duplicate
lines (25 characters and longer, table separators and headings ignored), the same first cell
twice in one table, near-duplicate paragraphs and sentences (word-set overlap), plus the
combined diff (`git log -p --cc`) of the 52 merges since 2026-10-22 over `docs/`, scored for a
hunk that kept similar text from both parents. Hits and what was done:

- testing.md: the e2e project's CI step being named after the phase 3 and 4 harnesses was in
  both the gate harness's and the scenarios' Known issues; merged into the harness note (with
  `ci.yml` and "on both OS" from the other), the scenarios' bullet keeps its own facts and
  points there.
- commands.md `settings.set` rows: the one both-sides hunk the merge scan found; already merged
  by the status pass (102c8bc).
- Checked, not duplicates: data.md's two `POST /projects/:id/data` rows (JSON and multipart
  bodies of one route); sandbox.md's engine matrix (several rows per OS); testing.md's three
  "Other stand-ins: to be filled by the testenv items that build them" section-end
  placeholders (one per section, no fact; testenv has no further stand-in yet); ADR 0057's
  decision item 5 and its consequence bullet on intake, chat and the model watch staying at
  standard speed (decision and consequence, both from the original ADR and its critic
  amendment, not a merge); cloudflare.md's How-it-works sentence and Tests bullet on
  `cloudflare-hooks.test.ts`; the How-it-works and Known-issues pairs in cloud-runner.md,
  critic.md, model-watch.md, sandbox.md and runtime.md (different sections, each with facts
  the other lacks). data-model.md's repeated lines are the generator's per-table headers.
- Not in scope, noted: capabilities.md's status line still says browser, email, desktop
  control and connectors "land with phase 6" (a stale status line, w4-stale-docs territory).

## Build report

Branch `worktree-agent-aa2a3f82d4c61499d`, six commits over `ccr-af5a431d-jc9xqj` (merged in
at 52ecb2d): 1d9d8ca state insert guard, 607a365 reasons on the mirror, intake and calibration
sessions and the fixtures, 69235c8 the runner's fresh read explained and pinned, dc16902 the
UI test id and the small-project dialog test (plus apps.md's desktop-row sentence), c3aed58
testing.md re-wrap, CI-step note once, triage addendum, and this report.
Tests added: suite.ts 1 (SQLite run; the Postgres conformance run needs `FORERUNNER_TEST_PG`,
not available here), schema.test.ts extended, session.test.ts 1, small-project.test.tsx 1,
project-tabs.test.tsx one assertion; reasons asserted in projects-mirror, intake and
calibration-job tests.
Verification on 2026-10-25 (4 cores shared with other agents):
- `pnpm exec biome check` over the 22 changed code files: no errors; the 2 warnings are the
  pre-existing `open[0]!` assertions in session.test.ts (on the base too).
- `node scripts/check-paths.mjs`: ok (1084 files). `pnpm typecheck`: clean.
- `pnpm exec vitest run --project unit packages/state/test`: 6 files, 102 passed.
- `pnpm exec vitest run --project unit packages/runtime/test`: 140 files, 1298 passed, 1
  skipped (177 s; a first run whose log a sibling agent's run overwrote in the shared
  scratchpad is discarded).
- `... packages/capabilities/test packages/critic/test`: 50 files, 509 passed.
- `... services/state-api/test` (unit): 12 files, 163 passed.
- `pnpm --filter @forerunner/ui test` (whole suite): 54 files, 386 passed on the re-run; the
  first full run under load had 1 failure of 386 in 295 s whose name the cut output lost.
- `node scripts/docs-check.mjs --base ccr-af5a431d-jc9xqj`: ok (31 files).
  `node scripts/link-check.mjs`: ok (149 files). `pnpm docs:schema`: unchanged.
