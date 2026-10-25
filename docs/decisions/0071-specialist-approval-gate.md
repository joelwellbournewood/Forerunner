# 0071 — The specialist approval gate: the pass threshold, the eval budget and where results are recorded

Date: 2026-10-23
Status: accepted

Amended 2026-10-23 by the review of `wave/w3-c5-specialist-approval`
(`docs/status/reviews/w3-c5-specialist-approval.md`): points 1, 3 and 7 now name the
ownership rule, the one-shot rule, the live-evaluation lock and its recovery, and the monthly
testing share.

Amended 2026-10-25 by item `w8-c5-propose-tool` (review finding 5's open part): point 8
names the command the PM proposes with (`specialist.propose`), its risk and confirmation,
the runnable invariant checked in code, the audit rows and the undo. The consequence "no
agent tool calls `propose` yet" is withdrawn.

## Context

Spec C.5: "PM can propose a new specialist; it goes live only after human approval and
passing its eval set." `proposeSpecialist` (`packages/runtime/src/registry/proposals.ts`)
wrote `proposed/<name>/specialist.md` and `proposal.json` and the loader kept the entry
`runnable: false`, but nothing could make it active: no request reached the human, no eval
run happened, and the stand-in was a human running the set by hand and editing `status`
(`docs/status/BLOCKERS.md`, row C.5). The registry already named a bar
(`MIN_EVAL_TASKS_FOR_ACTIVATION` = 10, `ACTIVATION_PASS_RATE` = 0.9) and an eval runner
existed for the model watch (`LoopEvalRunner`, ADR 0029), but it ran runnable entries only.
Open points: what exactly passes, which model and budget the run uses, where the result is
recorded, what promotion writes, and how the answer is applied exactly once.

## Decision

1. **One blocking approval request per proposal.** `SpecialistApprovals.file(name)`
   (`packages/runtime/src/registry/approval.ts`) files a `kind: "approval"`, `blocking`
   request for the proposal's human with options approve / reject and `change_card.key`
   `specialist:<name>`; the card carries the summary (description and rationale), the
   `prompt_version` shown, `eval_task_count`, the `threshold`, the tools, domains, budget,
   tier and risk floor. Filing is idempotent (an open request with the key is returned).
   `propose()` writes the proposal and files in one call; the daemon's `syncApprovals` (at
   start, on the answer route, on the poll) files for proposals on disk without a request,
   never for one whose request is open or answered and not yet applied. A proposal is filed
   only for the install's own human; `proposal.json`'s `approval.requestId` names the request.
2. **The threshold is the registry's, counted on decided tasks.** A run passes when the set
   ran at least `MIN_EVAL_TASKS_FOR_ACTIVATION` (10) tasks, at least 10 of them were decided
   mechanically (`passed + failed`; rubric tasks waiting on the critic, `needs_model`, are not
   a pass), and `passRate = passed / (passed + failed) >= ACTIVATION_PASS_RATE` (0.9; 9 of
   10 passes). `ACTIVATION_THRESHOLD` and `gateVerdict` are the one place the rule lives;
   every recorded result carries the threshold it was judged against.
3. **The run.** Approve runs the set through the composed `EvalRunnerPort` (the model
   watch's `LoopEvalRunner`) with `EvalRunInput.candidate` set to the proposed definition:
   the runner accepts a candidate only when it is `location: "proposed"` under the name asked
   for, and otherwise still runs runnable entries only. The model is the composed provider's
   rung for the proposal's `default_tier` at its `default_effort` (what it would run on once
   active); the pricing is the table in force. Every call is under the enforcement hooks with
   a token per task owned by the approving human, so the monthly cap, the kill switch and the
   audit log apply. Before the first call the run's worst case, the sum of its tasks' brief
   budgets, must fit the approval eval budget: USD 5 per run
   (`DEFAULT_APPROVAL_EVAL_BUDGET_USD_MICRO`, the model watch's per-run figure) and no more than
   what is left this UTC month of the human's testing share, 20% of the monthly cap
   (`APPROVAL_TESTING_SHARE`), after earlier approval runs (their cost is summed from the
   `registry.specialist_approval` audit rows of the month), else nothing runs (`over_budget`).
4. **Results are recorded in `proposal.json`.** `evalResult` (and appended to
   `evalHistory`): `passed`, `passRate`, `total`, `passedTasks`, `failedTasks`, `needsModel`,
   `decided`, `threshold`, `provider`, `model`, `effort`, the evaluated `promptVersion`,
   `costUsdMicro`, `durationMs`, `ranAt`, `approvedBy`, `reason` on a failure; `approval`
   holds `status` (`pending`, `evaluating`, `active`, `eval_failed`), the request id, who and
   when. The request's card gets the outcome, the reason and the `eval_result`, and an audit
   row `registry.specialist_approval` records each step with the cost. `proposal.json`
   travels with the files, so the result is part of the registry content the sync script
   carries to `forerunner-registry`; `docs/status/gates.md` is not written by the runtime.
5. **Promotion changes one line.** On a pass the file is written to
   `specialists/<name>/specialist.md` with exclusive create, its single frontmatter
   `status: proposed` line replaced by `status: active` and every other byte as evaluated;
   the result is validated as a `specialists/` entry and compared field by field (frontmatter
   and prompt) with the evaluated definition before the write. `proposal.json` moves with it
   (`status: active`, `activePromptVersion`, `activatedAt`), `proposed/<name>/` is removed,
   and the daemon puts the definition into its live registry (`onPromoted`), so the
   executor's next lookup finds it. The active prompt version differs from the evaluated one
   by the status line only, and both are recorded.
6. **Anything else keeps it proposed.** A failed set, fewer than 10 tasks, over budget, no
   model, an eval error or the name already active: the files stay, `approval.status` is
   `eval_failed`, the reason (and result) go on the card and a `warning` message goes to the
   human's inbox. It is not asked again by itself; `fr specialists approve <name>` files a new
   request and applies it. Reject withdraws: `proposed/<name>/` is removed, the record is
   copied onto the card, the name is free.
7. **Applied once, by its own human, by the install that holds the proposal.** Only the
   install whose `proposal.json` names the request applies it, so the cloud runner or a second
   install of the same human on a shared store never consumes the answer. Only the daemon
   applies inbox answers (`startServices: false` one-shots apply none, as with plan
   approvals); `fr specialists approve` applies an answer already given first, otherwise
   answers its own request, and waits. Every answered request is claimed with a versioned
   write (`applied_at`, outcome `evaluating`) before anything runs, so the answer route, the
   approvals poll and the CLI never evaluate one answer twice; the daemon runs the
   evaluation in the background after the claim (`settled()`, awaited by `close()`). From the
   claim on, `proposal.json` records `approval.status: "evaluating"` with the `pid` and a
   per-process token. While that run is live (in this process, or its pid alive and the
   claim younger than the set's worst case, tasks x `timeout_minutes` + 15 minutes), filing,
   approving or rejecting the name is refused (`claim_conflict`). A run that ended without a
   result (an exit, a crash, a kill) is recovered by the next sync or CLI call: the card and
   the record say `interrupted`, a note goes to the inbox, a new request is filed, and
   nothing re-runs without a new approve. An answer by anyone but the addressee, an unreadable answer, and a proposal
   whose prompt version is no longer the card's (edited after filing) run nothing, are
   recorded, and the proposal is filed again. The CLI path (`fr specialists approve|reject`)
   answers the open request as the install's human through the same steps.
8. **The PM proposes through the command registry, not a bespoke tool.** `specialist.propose`
   (`packages/commands/src/commands/specialist.ts`) is a command like `budget.set`: on the
   conversation agent's model path it is the `specialist_propose` tool, and the palette, the
   API and the phone run it by name, so the same card, confirmation policy, change log and
   undo apply whichever way the proposal is made. Its parameters are the registry file's
   frontmatter fields under their file names plus `prompt` and `rationale`, with cautious
   defaults for the limits; `status` and `eval_set` are never parameters. It is medium risk:
   the human says yes to the card before anything is written, so a model cannot fill the
   inbox with proposals, and the agent's own yes is refused as for every command. On the yes
   the command hands the proposal to `CommandPorts.specialists` (`specialistCommandPort` in
   `packages/runtime/src/wiring/specialist-ports.ts`, over `RuntimeApp.specialistApprovals`),
   whose `propose` runs the loader's checks on the exact bytes, reads the written file back
   and refuses and removes it unless it loads as `status: proposed`, `runnable: false` (the
   gate's invariant, enforced in code and not only by construction), writes a
   `registry.specialist_approval` audit row `proposed` naming the proposing agent and the
   prompt version, and files the one blocking request of point 1. The tool call is also on
   the hooks' audit log and in the change log with `author_agent`. The eval set stays a
   registry file set the tool cannot write; the card and the sentence say how many tasks
   exist and that at least 10 must before an approval can activate the specialist. What the
   gate refuses (an unknown tool, a prompt over 120 lines, a taken name) comes back to the
   model as the `ForerunnerError` code and message (`validation`, `claim_conflict`), never a
   stack trace, and leaves nothing on disk. The undo is `SpecialistApprovals.withdraw`: a
   waiting proposal is taken back through the reject steps; a request the human already
   answered, a live evaluation (`claim_conflict`) and a promoted specialist (`not_found`)
   refuse it, so an undo never overrides the human's answer. A proposal written by hand or
   pulled into `proposed/` is still filed by the next approvals sync (the answer route, the
   5 s poll), not at once; no watch is added.

## Consequences

- C.5 is built: no specialist becomes runnable without a human's approve and a recorded pass.
- Rubric-only sets (researcher-like) cannot pass until the critic grades eval rubrics in the
  runner; a proposal needs 10 mechanically checked tasks. Recorded in
  `adding-a-specialist.md`, Known issues.
- The running daemon's registry `files` and `hash` are not recomputed on promotion; the next
  start's registry hash includes the new file.
- The eval run in production costs real money, bounded per approval and per month by point 3
  and per call by the hooks; tests run it on the fake provider.
- An answered request whose proposal was deleted by hand is never applied (no install holds a
  `proposal.json` naming it); it stays answered.
- The PM proposes with `specialist.propose` from a chat or voice turn (point 8); a proposal
  written by hand or pulled into `proposed/` is filed by the daemon's next sync. Proposing
  costs the human two answers: the card's yes (may the agent file this?) and the inbox's
  approve (shall it run its eval set and go live?). They are different questions and the
  second costs money, so the two are kept.

## Alternatives considered

- **Re-serialize the frontmatter on promotion.** Rejected: a hand-written proposal would
  change formatting the human never saw; one line is reviewable.
- **Record results in `docs/status/gates.md` or the state store only.** Rejected: the
  installed app has no repository, and the registry is shared through files; the store keeps
  the card and audit rows as the second record.
- **Run the evaluation inside the answer route.** Rejected: an eval set can take minutes;
  the claim is synchronous, the run is not.
- **A bespoke `propose_specialist` ToolSpec in the daemon's built-in tool registry** (2026-10-25).
  Rejected: the built-in registry is what specialist runs are offered, and a specialist must
  not propose specialists; the principal's only model path with tools is the conversation
  agent's, which offers the command registry's tools and nothing else. A command gets the card,
  the change log, the undo and the palette for free.
- **A low-risk command (no yes before the proposal is filed)** (2026-10-25). Rejected: nothing
  would go live, but a model could file a proposal per turn and each is a blocking inbox
  request; the yes costs one word and keeps the agent's initiative visible.
- **A directory watch on `proposed/`** (2026-10-25). Rejected: the tool files its own request,
  and a hand-written proposal is filed within one approvals poll; a watcher adds a platform
  dependency for seconds of latency.
