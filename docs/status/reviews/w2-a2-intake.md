# w2-a2-intake

Item: PM intake (spec A.2, with A.1 and J.3): a pasted brief becomes one proposal (the
standard doc set, milestones, tasks and a first-session plan) in the inbox, written only on
approval. Built on `wave/w2-a2-intake`, merged in `f4d4912` (3 commits, 17 files, +2279/-12)
without a review; ADR 0055.

## Review

Independent adversarial review, stage REVIEW AND FIX, 2026-10-25. Reviewed the item's changes
as they stand on the integration branch `ccr-af5a431d-jc9xqj` at `60689f2` (the code moved
since the merge: the G.5 scaffold deferral when `intake: true`, the B.5 reason guard on session
inserts, the plan approval of ADR 0053 with its shared conditional mark `answer-mark.ts`, the
late approvals of ADR 0088, the small-project mode of ADR 0051, the D.4 run settings of
ADR 0072). Read the brief, ADR 0055, runtime.md's intake paragraph, its Known issues and its
tests paragraph, apps.md's inbox rows, then traced `session/intake.ts` whole,
`session/project-plan.ts` (`shapeProjectPlan`, `applyProjectPlan`, `orderByDependencies`),
`session/findings.ts` (`unappliedBlockingAnswers`), `session/plan-approval.ts` and
`session/late-approval.ts` (their row predicates), `session/answer-mark.ts`,
`daemon/compose.ts` (the `IntakeService` wiring, `syncApprovals` and its `syncChain`, the
compose-time sync), `daemon/server.ts` (`POST /projects`, the two intake routes,
`POST /requests/:id/answer`, `POST /sessions/:id/stop`), `daemon/create-project.ts`,
`agent/loop.ts` and `enforcement/hooks.ts` (what runs before the one model call),
`enforcement/killswitch.ts`, `session/runner.ts` (`start`'s active-session rule),
`state/repos/session.ts`, `state/ids.ts`, `services/state-api/src/routes/inbox.ts`
(`answerRequestAs`), the registry's `project-manager.md`, `apps/ui/src/pages/InboxPage.tsx`
(`intakeCardOf`, `IntakeCard`) and `NewProjectDialog.tsx`. Ran the item's test
(`intake.test.ts`: 16 passed) and two throwaway tests (deleted afterwards) for the findings
marked "verified with a throwaway test".

**Verdict: revise.** Score: 70/100. The item does what the brief asks on the happy path and
with care: one planning-rung call through the loop driver and the enforcement hooks (budget
precheck, the human's and the project's caps, the kill switch, the wall clock) on a session
row of its own with a reason (B.5), no tool offered to the model, the reply parsed by one
strict schema with allowlisted doc paths, one blocking request whose card carries the whole
proposal and the call's model and cost, nothing written before the answer (rows, docs, plan
and summary cache all checked), approve writing rows and the applied mark in one transaction
and the docs after it, reject writing a note only, another human's answer refused both at the
daemon's route (403) and in the sync (`wrong_human`), the state service attributing an answer
to the device's own human, and the later merges' syncs (`plan:` keys; tool approvals need
`card.tool`) never touching an intake card. The tests prove what their names say: breaking the
applied-once mark, the allowlist or the dependency check makes them fail. What is wrong: a
proposal with a dependency cycle passes the proposal check, is approved and then fails every
sync in silence; the apply is not guarded against a second producer on a shared store (two
installs each write the plan); a daemon crash during the call leaves a `running` intake
session that blocks every later session start with nothing that closes it; and the brief's
data markers can be closed by the brief itself.

### Requirements checked

- [x] A.2 "turns the brief into docs, milestones, tasks and a first-session plan": one call
  returns `plan` (the plan writer's own shape), `docs` (the standard set plus the first
  decision) and `firstSession` (plan keys with estimates); the brief goes to the model whole
  up to `MAX_BRIEF_CHARS`, named as data (finding 4 on the framing).
- [x] "then shows it for approval": one blocking `approval` request, options approve / reject,
  `change_card.key` `intake:<project>`, the proposal on the card; the inbox renders it as the
  plan card (`inbox.test.tsx`: phases, tasks with tier / priority / specialist / dependencies,
  docs and target, first session with estimates, the call's cost, the ordinary option buttons).
- [x] Nothing written before the yes: no milestone, task, doc, summary-cache plan or queue item
  but the creation-time brief note until the answer (`intake.test.ts` first case); a malformed
  reply files nothing and closes its session `failed`.
- [x] Approve creates everything in one go: `applyProjectPlan` (rows, dependencies as ids,
  tiers, author, reason), estimates on the tasks, `summary_cache.first_session` and
  `next_steps`, the queue item, the applied mark, one audit row, all in one transaction; the
  docs after it (workspace or pull request), a docs failure recorded on the card.
  Partly: a proposal that cannot be written is approved and never applied (finding 1); two
  producers write it twice (finding 2).
- [x] Reject writes nothing but a note (`kind: note`, the request id, the brief stays queued).
- [x] Cost and model: the card carries `model`, `cost_usd_micro`, `run_id`, `session_id`; the
  Run row has tokens, cost, first token and duration (D.19), the prompt version (D.5); the
  effort is the planning table's shifted by the slider under the registry cap (D.16, D.4);
  the rung stays under the project's ceiling (D.3); the spend lands on the project's ledger.
- [x] A.1: `POST /projects` keeps the brief whole and queues it as before (`closeout-projects`
  stays green); `intake: true` runs the intake in the background, off by default; the New
  project dialog sets it when a brief was pasted (`home.test.tsx`).
- [x] J.3: the request has context (`why`, `steps`), options and `blocking: true`.
- [x] Security: the brief is data (system prompt, markers, no tools, strict schema, allowlisted
  paths; a brief that says "delete the repository" can only become a proposal); the proposal
  cannot escape the approval (no write path before `syncAnswers`); the call runs under the
  hooks with its own cap (`DEFAULT_INTAKE_BUDGET_USD_MICRO` or the project setting) and a
  token that expires with the planning timeout; a replayed answer is a version conflict at the
  route; a forged card still needs the addressee's own answer; another human's answer on a
  shared store is skipped as `wrong_human`. The crash residual is not bounded (finding 3).
- [x] Conventions: time through the clock; paths through `join` / `fromPosix` / `safeSegment`;
  `ForerunnerError` codes (`validation`, `unavailable`, `conflict` at the route); every row
  through the repositories (envelope); the session row inserted with its plan and reason
  (B.5); nothing hardcoded to an org, host or path; the token by reference (`gitToken` from
  the vault in compose); logs carry ids and counts, never the brief.
- [~] Docs agree with the code: runtime.md's intake paragraph, apps.md and ADR 0055 match,
  except the two constants of finding 8 and the gap of finding 9.

### Findings

1. **medium**: `packages/runtime/src/session/intake.ts:119-150` (`IntakeProposalBody`'s
   `superRefine`: dependencies must be plan keys, nothing about cycles), `:557`
   (`shapeProjectPlan(plan, project)`, pure, no ordering) and `:966-972` (`syncAnswers`'
   catch: log and leave the row). A proposal whose tasks depend on each other (`a` after `b`,
   `b` after `a`) is filed as a request; the human approves; `applyProjectPlan`'s
   `orderByDependencies` (`project-plan.ts:304-325`) refuses the cycle with `validation`; the
   catch logs "intake answer not applied" and leaves the card unmarked, so the row is scanned
   and fails again on every sync (every answer, every poll) for ever, the status route says
   `pending` for a request the human already answered, and nothing tells the human. Verified
   with a throwaway test through the composed daemon: `POST /projects/:id/intake` 202 with the
   cyclic proposal, the answer route 200, then `card.applied_at === null`, 0 tasks, a second
   `syncApprovals()` with `intake: { applied: 0 }`, `GET /projects/:id/intake` `state:
   "pending"`. Fix: the plan must be writable before it is put to the human (the code's own
   comment at `:556`): run the dependency ordering at proposal time and refuse a cycle with
   `validation` and nothing filed; and at apply time record a deterministic `validation`
   failure on the card (`apply_failed`, the error, an audit row) so it is shown, counted and
   not retried, while a transient store error stays retryable; the status route reports it as
   `failed` with the error.

2. **medium**: `packages/runtime/src/session/intake.ts:1033-1045` (`applyApproved`: the card
   mark is `tx.humanRequest.patch(row.id, …)`, unconditional) against `session/answer-mark.ts`
   (`markAnswer`: the version-conditional mark the plan and late approvals share so that "an
   answered request is acted on at most once holds across the route, the poll, a restart and
   two installs"). The intake's sync re-reads nothing inside its transaction and marks without
   a version, so two producers that both scanned the row before either committed (two desktop
   installs of one human on a shared Postgres; `registerDesktopDevice` and ADR 0041 contemplate
   several) both write the plan: duplicate milestones and tasks, two pull requests. Within one
   daemon `syncChain` serialises the syncs, which is why the item's "applied once" test passes.
   Verified with a throwaway test: two `IntakeService` instances over one store,
   `Promise.all([a.syncAnswers(), b.syncAnswers()])` on one approved request, both answered
   `applied: 1`, and a one-milestone, one-task proposal left 2 milestones and 2 tasks. Fix:
   mark the card inside the transaction with `humanRequest.update(row.id, row.version, …)`
   (conditional on the version the scan read), so the loser's transaction rolls back its rows
   with the `version_conflict`, which the sync treats as "applied by the other producer".

3. **medium**: `packages/runtime/src/session/intake.ts:684-707` (`callModel`: the session row
   is `planned` then `start`ed, closed only in the `finally` of the same process) with
   `session/runner.ts:385-391` (`start` refuses any session while `store.session.active(agent)`
   lists one) and `daemon/server.ts:911-916` (`POST /sessions/:id/stop` aborts registered runs
   and revokes tokens; the row's status is untouched). A daemon that dies during the call
   (restart for an update, a crash, the laptop closed; the call lasts up to the planning
   timeout, 5 min) leaves the intake session `running`; nothing in compose, the CLI
   (`fr stop` is the kill switch) or the routes closes it, and every later session start of
   the agent fails with `claim_conflict` until someone edits the database. ADR 0055 lists the
   residual as the runner's; the runner's has the same shape but this one is the item's. The
   spend is bounded (the token expires, the session cap holds, the call died with the process);
   the block is not. Verified with a throwaway test: a `running` intake session row, then
   `rt.runner.start(…)` throws `claim_conflict`, `POST /sessions/:id/stop` answers 200 and the
   row stays `running`. Fix: store the call's deadline on the row (`plan.intake.deadline`,
   the planning timeout plus the token's margin, from the clock) and close an intake session
   whose deadline has passed as `failed` ("the daemon did not finish the call") at compose
   time and before every `propose`, so the residual lasts at most one planning timeout.

4. **low**: `packages/runtime/src/session/intake.ts:906-910` (`userMessage`: the brief is put
   raw between `<<<BRIEF` and `BRIEF>>>`). A brief containing `BRIEF>>>` closes the data block
   early and the text after it reads as the operator's words, outside the "data, between the
   markers" framing the system prompt relies on. The consequence is bounded by code (no tool
   is offered, the reply must fit the strict schema, doc paths are allowlisted, nothing is
   written before the human's yes), so the worst case is a worse proposal that the human sees;
   still, the marker scheme the ADR describes does not hold for the one input it exists for.
   Verified with a throwaway test: the recorded model request shows the injected sentence
   outside the block. Fix: neutralise the marker sequences inside the brief before framing it
   (`<<<BRIEF`, `BRIEF>>>` spaced out), with a test that an instruction-shaped brief produces
   a request, is offered no tool and stays inside the block.

5. **low**: `packages/runtime/src/session/intake.ts:530-545` (`propose`: an open request is
   reused before `opts.brief` is read). `POST /projects/:id/intake { brief }` while a proposal
   is open answers 202 `reused: true` for the old proposal and drops the new brief without a
   word; the caller believes the open proposal is about the brief they just sent. Verified with
   a throwaway test (second call with another brief: 202, `reused: true`, no model call). Fix:
   when a brief is given and a proposal is open, refuse with `conflict` naming the open
   request ("answer it first"); reuse stays for a call without a brief.

6. **low**: `packages/runtime/src/session/intake.ts:566-590` (`why`, `steps` and the route's
   `summary.milestones` count `plan.milestones`). In small-project mode `shapeProjectPlan`
   joins every phase into one milestone (ADR 0051) and `applyProjectPlan` writes one, but the
   request says "2 milestone(s)" and lists two `Milestone:` lines, so the human approves what
   will not be written as shown. Verified with a throwaway test (`small_project_mode: true`,
   a two-phase proposal: `why` "2 milestone(s)", two milestone steps). Fix: count and list the
   shaped plan's milestones and say that the phases join one milestone in the mode.

7. **low**: `packages/runtime/src/session/intake.ts:1120` (branch
   `fr/intake-${safeSegment(project.id).slice(0, 8)}-docs`). Project ids are UUIDv7
   (`state/ids.ts`): the first 8 hex characters are the top 32 bits of the millisecond
   timestamp, the same for every id created within one 65-second window. Two projects on one
   repository created that close share the branch: the second finds the first's open pull
   request, branches from it, finds every file present, keeps them all and comments on the
   first project's pull request. Fix: the whole safe id in the branch name
   (`fr/intake-<project id>-docs`, as runtime.md already writes it).

8. **low** (docs and dead code): `packages/runtime/src/session/intake.ts:77-79`
   (`INTAKE_TIMEOUT_MS`, `INTAKE_MAX_TOKENS`, exported, used nowhere) and
   `docs/maintainers/runtime.md:748-749` ("`INTAKE_TIMEOUT_MS`) through the loop driver").
   The call's timeout and output cap are `resolveRunSettings`' `planning.timeoutMs` and
   `maxTokens`, which the principal's `model_config.modes.planning` overrides (the item's own
   D.4 test shows `max_tokens: 12_000` reaching the provider). The doc names a constant the
   call does not read. Fix: drop the two constants and name the mode settings in runtime.md.

9. **low** (docs): `docs/maintainers/runtime.md:3322-3324` and ADR 0055 decision 7. A project
   created with `intake: true` has its G.5 scaffold deferred (`server.ts:622-624`); when the
   intake is then rejected (writes nothing) or fails (recorded on `summary_cache.intake`), the
   project keeps no standard doc set until an intake is approved, and the reject note tells the
   human to re-run without saying the docs are missing. Verified by reading the three paths.
   Fix: say so in Known issues and in the reject note.

Not findings, checked: the one call goes through `driver.run` with the composed hooks
(`beforeModelCall`: wall clock, steps, the run's precheck, the human's and project's caps;
the kill switch registration; `afterModelCall` accounting), no tool, `maxTurns` 1, the
token expiring with the planning timeout; the registry's PM prompt has `allowed_tools: []`;
the daemon's answer route refuses another human's request (403) and checks the version, and
the state service sets `answered_by` to the device's own human; `syncApprovals` is one chain
per daemon; the late-approval predicate needs `card.tool`, the plan predicate `plan:`, so
neither consumes an intake answer; the intake predicate `intake:` matches no other card; the
audit rows carry ids and counts, never the brief; `recordFailure` and the session summary
redact; `est_cost_usd_micro` patches keep the row's reason; nested `store.transaction` is a
savepoint on SQLite; `enqueue` holds one job per project and never leaves a rejection
unhandled; `wrong_human` consumes the request as ADR 0055 decision 6 says (the addressee
re-runs); the UI's `intakeCardOf` is defensive and the inbox test asserts the rendered text
and the option buttons; `apps/ui/test/home.test.tsx` asserts `intake: true` on a pasted brief.
