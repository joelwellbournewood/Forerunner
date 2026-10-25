# 0055 — PM intake: one proposal in the inbox, written only on approval

Date: 2026-10-23
Status: accepted

## Context

Spec A.2: "PM agent turns the brief into docs, milestones, tasks and a first-session plan,
then shows it for approval." Until now `POST /projects` kept the brief whole in
`summary_cache.brief` and queued it as a next-session note; the first session's `StaticPlanner`
planned whatever ready tasks existed (none, for a new project) and advisor mode put that empty
plan to the human (`docs/status/BLOCKERS.md`, row A.2). The pieces the step needs existed
apart: the plan writer `applyProjectPlan` (ADR 0051) takes phases with tasks and writes the
rows in one transaction; `@forerunner/memory`'s `scaffoldDocs` writes the standard doc set
from templates and never touches an existing file; `PrTaskExecutor` in `@forerunner/capabilities`
opens a branch and a pull request over `GitOps` and the git host port; `syncApprovals` in the
daemon applies answered inbox requests (sign-offs, blocked findings, consolidations) once each.
The decisions below are the ones the spec leaves open: the shape of the model's output, where
the proposal waits, what an approval writes and where the docs go.

## Decision

1. **One model call, one JSON object, strictly validated.** `IntakeService.propose`
   (`packages/runtime/src/session/intake.ts`) makes one call on the planning rung (the
   `planning` mode's tier and effort from the tables in force, Sonnet at high effort by
   default; the registry's `project-manager` prompt plus an intake section) through the loop
   driver and the enforcement hooks, with no tools, `maxTurns` 1, a budget of its own
   (`DEFAULT_INTAKE_BUDGET_USD_MICRO`, USD 2, or `project.settings.intake_budget_usd_micro`)
   on a session row of its own (`summary: "intake: <project>"`, closed `completed` or
   `failed`), so the spend lands on the project's ledger like any other call. The reply must
   be one JSON object: `plan` in `ProjectPlanBody`'s own shape (so the plan writer's rules and
   caps apply unchanged), `docs` as a map of allowlisted paths (the standard doc set and
   `docs/decisions/0001-<slug>.md`) to markdown, `firstSession` as plan task keys with
   estimates. Unknown keys, a doc outside the allowlist, a dependency that is not a plan key,
   a first-session item that names no plan task, or a plan that does not shape are refused
   with `validation` and nothing is filed; `parseIntakeReply` is the one parser. The brief is
   handed to the model whole up to `MAX_BRIEF_CHARS` and marked as data between markers.
2. **The proposal is one blocking approval request; nothing is written before the answer.**
   The request's card (`change_card.key` `intake:<project id>`) carries the whole validated
   proposal, the model, the call's cost, the session and run ids and where the docs will go,
   so the inbox can show it (the UI's `IntakeCard`) and the apply step reads what the human
   saw, not what the project looks like later. An open intake request for the project is
   reused without a call. The brief stays on `summary_cache.brief` and in the queue as before.
3. **Approve applies once, in the order rows then docs.** `syncAnswers`, run from
   `RuntimeApp.syncApprovals` (the answer route and the approvals poll, like every other
   answer), applies an approving answer in one store transaction: `applyProjectPlan` writes
   the milestones and tasks (small-project mode shapes them, ADR 0051), the first-session
   items' estimates go onto the task rows, the first-session plan goes onto
   `summary_cache.first_session` (task ids, estimates, summary) and `next_steps` (the summary
   route's next three steps) and into the next-session queue as one `task` item at priority 9,
   and the card is marked applied (`applied_at`, `outcome: "approved"`, the written ids) inside
   that same transaction with one `project.intake` audit row, so a crash cannot apply the rows
   twice. The docs are written after the transaction (git and files are outside it): a
   failure there is recorded on the card (`docs.error`) and logged, the rows stand.
4. **Docs go to the repository as a pull request, else to the workspace; existing files are
   never replaced.** With a repository (`repos[0]` as `owner/name` or a repository URL) the doc
   set takes the executor's path: clone or fetch into `<worktrees>/intake/<project>`, branch
   `fr/intake-<id>-docs` from the base (or the branch's open pull request), write, commit, push,
   open the pull request (or comment on the open one) through the git host port. Without one,
   the files go under `<data>/projects/<project id>/workspace`, the doc root of a project that
   has no repository. In both places a drafted doc is written only where the file does not
   exist (`kept` on the card otherwise) and `scaffoldDocs` then fills any standard doc the
   model left out from its template, so the set is always complete and nothing the human
   wrote is overwritten. A pull request that cannot be opened falls back to the workspace with
   `repo_error` on the card.
5. **Reject writes nothing but a note.** The card records `rejected`; one queue note tells the
   next session the proposal was rejected and the brief stays queued.
6. **Only the addressee's answer counts.** An answered intake request whose `answered_by` is
   not the request's human (an answer written into a shared store by someone else) is skipped
   and recorded `wrong_human` with an audit row; an unreadable answer, a missing project or a
   card that no longer parses are skipped likewise.
7. **Triggers.** `POST /projects/:id/intake` runs it now and answers 202 with the request;
   `GET /projects/:id/intake` reports the latest intake and its outcome. `POST /projects` runs
   it in the background when the body says `intake: true` (the UI's New project dialog sets it
   when a brief was pasted); the flag is off by default so the CLI, scripts and the existing
   tests keep creating projects without a model call. A failed background intake is recorded
   on `summary_cache.intake` and served by the status route.

## Consequences

- A.2 closes with `packages/runtime/test/intake.test.ts` (through `composeRuntime` and the
  daemon routes, the fake provider, an in-memory git host over a bare repository) and
  `apps/ui/test/inbox.test.tsx` (the card).
- `AppliedPlan` gained `keyed` (plan key to task id), which the intake needs to turn the
  first-session keys into task ids; `unappliedBlockingAnswers` in `session/findings.ts` is the
  shared scan every answer path uses.
- The first session still plans with `StaticPlanner` (ready tasks by priority); the approved
  first-session plan reaches it as the queue item in the brief and as the tasks' estimates,
  not as an order the planner enforces. A planner that reads `summary_cache.first_session`
  directly is a later item.
- The intake session row counts as `running` while the call is in flight, like a runner
  session; a daemon that dies mid-call leaves it so until a human closes it (the same residual
  as the runner's, Known issues).
- Docs land in the workspace of a project without a repository; the proposed docs tab
  (`GET /projects/:id/docs`) should read from that directory when it is built.

## Alternatives considered

- **Writing the rows at proposal time and asking afterwards.** Simpler, but the spec says
  "shows it for approval", and a rejected plan would have to be deleted (task rows carry no
  delete path by design).
- **Running the intake inside the first session as the planner's model path.** The session
  runner plans from existing tasks; a new project has none, and the human would wait for a
  whole session start (checklist, git fetch, memory) to see a plan. A call of its own answers
  in the planning target.
- **Automatic intake on every `POST /projects` with a brief.** Breaks every caller that
  creates projects without wanting a model call (the CLI, the import paths, the tests), and
  costs money without being asked. The flag keeps the request explicit; the UI sets it.
- **Docs through `putFile` on the host port.** Works on the in-memory host, but GitHub's
  contents API needs the branch to exist first and the port has no `createBranch`; the
  executor's git path works on both and keeps one flow.
- **Overwriting an existing README in the repository with the draft.** The human would see it
  in the pull request, but the memory package's rule (never edit an existing doc) is the safer
  one for a step that runs once on a fresh project.

## Amendment of 2026-10-25 (review `docs/status/reviews/w2-a2-intake.md`)

The independent review found the proposal check incomplete, the apply unguarded against a
second producer and the crash residual unbounded. The decisions above stand with these
changes:

1. **What the inbox is shown is writable.** `shapeProjectPlan` refuses a dependency cycle
   with `validation` (the plan writer's own rule, now applied where the plan is shaped), so a
   cyclic proposal is refused before it is filed. An approved card the writer still refuses
   (one filed before this check) is recorded once as `apply_failed` with the error and an
   audit row, and the status route reports `failed`; it is not retried on every sync. A store
   or git failure stays retryable.
2. **One producer applies an answer.** Every mark the intake writes is `markAnswer`'s
   (`answer-mark.ts`, the version-conditional mark of ADR 0053 and ADR 0088): the approving
   transaction marks the card conditional on the version the scan read and rolls back, rows
   and all, when another producer (a second install of the human on a shared store, an
   overlapping sync) marked it first; a reject's mark and note are one write.
3. **The crash residual is bounded.** The intake session row carries the call's deadline
   (`plan.intake.deadline`: the planning timeout plus `INTAKE_DEADLINE_MARGIN_MS`, also the
   token's expiry). `closeExpired()` runs at compose and before every proposal and closes an
   intake session still `running` past its deadline as `failed`, whichever install owned it,
   since the call cannot outlive its timeout. The runner's one-session rule is held by a dead
   intake call for at most one timeout plus the margin.
4. **The brief's markers hold.** The brief's own occurrences of `<<<BRIEF` and `BRIEF>>>` are
   spaced out before the brief is framed, so the data block opens and closes once around the
   whole brief. The guarantees that matter stay in code (no tool, the strict schema, the
   allowlisted paths, nothing written before the answer); this keeps the framing honest.
5. **A new brief while a proposal is open is refused** (`claim_conflict`, 409, the open
   request's id) rather than dropped with a `reused` answer; the bare re-trigger still reuses.
6. **The request counts the shaped plan.** In small-project mode the `why`, `steps` and the
   route's `summary` name the one milestone the phases join, with a step saying so.
7. **The docs branch is `fr/intake-<the whole project id>-docs`** (`intakeDocsBranch`): the
   first eight characters of a UUIDv7 are a timestamp shared by every id of one minute.
8. **Consequence recorded.** A project created with `intake: true` whose intake is rejected or
   fails has no standard doc set until an intake is approved (the creation deferred the G.5
   scaffold); the reject note says so. `INTAKE_TIMEOUT_MS` and `INTAKE_MAX_TOKENS` are gone:
   the call's timeout and output cap are the planning mode's settings (ADR 0072).
