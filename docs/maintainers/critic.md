# Critic

Package: `packages/critic` (`@forerunner/critic`). Spec module H, with B.4 (no close with open
findings or failed required checks), D.2 and D.3 (retry ladder under a ceiling), D.14 and D.15
(critic models and effort), P.14 (doc drift at tier 2+) and the phase 3 gate.

## Purpose

The critic is the independent reviewer of every task result and every session. It sees the
evidence of the work and nothing of how the worker got there, grades it 0 to 100 with a
confidence, lists findings with a severity, and returns one of four verdicts: `accept`,
`revise`, `escalate` or `human`. What a verdict may be is decided by rules in code, never by the
prompt alone. Findings are persisted and tracked to resolution; a task cannot close while one is
open. Repeat findings across sessions become lesson proposals. The critic also reviews sessions
(plan quality, cost efficiency, honesty of the summary) and calibrates itself against the golden
eval set so grade drift is visible.

## How it works

### Tiers

| Tier | Depth | Model (spec D table) | Effort | Time | Ends with |
| --- | --- | --- | --- | --- | --- |
| 0 | automated checks only, no model (`tier0.ts`) | none | - | check timeouts | accept only if every required check passes and criteria exist |
| 1 | light read | Sonnet (`critic_t1`) | medium | 30 s target, also the run timeout | model verdict, bounded by the rules |
| 2 | full review: the task's check commands are run, doc drift checked | Opus (`critic_t23`) | high | task budget, 10 min default timeout | model verdict, bounded by the rules |
| 3 | deep review (checks run) plus human sign-off | Opus | max | task budget | always `human`, with a blocking `HumanRequest` carrying the summary and findings |

`model.ts#pickCriticModel` reads `MODE_DEFAULTS` from the runtime ladder, caps the rung at the
ceiling, shifts the effort by the project's speed-versus-quality slider
(`settings.speed_quality_offset`) and caps it at the registry prompt's `max_effort`. The
provider comes from the `ProviderRegistry` by name (`anthropic` in production, `fake` in tests);
model ids come from the ladder, never from the critic.

The ceiling is resolved in code, not by the caller (D.3): `CriticService.settingsFor(ctx)` takes
`ctx.projectSettings` when given (`null` means none) and otherwise reads the project row named
by the session token (`store.project.get(claims.projectId).settings.critic_ceiling`); the
stricter of that and `ctx.ceiling` applies (`model.ts#stricterCeiling`), and the ladder's
default `opus` when neither is set. A caller can lower the ceiling for one review, never raise
it above the project's. `modelFor(tier, ctx)` is the synchronous view of the same pick from the
settings in the context alone (plans, UI).

Opus fast mode (spec D.20, [ADR 0057](../decisions/0057-opus-fast-mode.md)): a review whose
pick lands on the Opus rung (tiers 2 and 3 by default) of a project with `settings.fast_mode`
on goes through the runtime's `decideFastMode`, the same rules a specialist run follows, on the
loop driver. `CriticDeps.fastMode()` supplies the kind of the source the critic is billed to
(`billingSourceId`) and the price table in force; the daemon reads the source row from the
store at every review, or, when its calls are routed (ADR 0100), the source a review would use
now (`RoutedProvider.peek`). The Run row's `billing_source_id` is the source that paid the
review (`RunResult.billingSourceId`, which a routed provider sets per call), else
`billingSourceId`. Without the dep, the decision assumes an API-style source and the
built-in table. Applied: every call carries `speed: "fast"` on the unchanged model id, and the
variant (`<id>-fast`) is used everywhere the review is recorded:
- the run's pricing (`deps.pricing(variant)`, so the estimate before each call and the actual
  read the variant's rate);
- the hooks' ledger rows;
- the Run row's `model`;
- `ReviewOutput.model` (so the Review row's `critic_model`).

Ignored, the review stays standard. The reasons are a `subscription` or `plan_credits` source
("API only"), a provider without `fastMode`, and a missing variant price row. An ignored
decision is also a `warning` event on `ctx.onEvent`. Applied or ignored, a persisted review
writes one `model.fast_mode` audit row on its run, with `specialist: "critic"`, the review
tier, the rung, the model, the variant, the source and its kind. A calibration run
(`persist: false`) writes nothing. A review below the Opus rung, or a project with the flag
off, is unchanged and writes nothing.

Checks: `ctx.checks` (argv commands, `ctx.cwd` the worktree) are run through the `CheckRunner`
(`tier0.ts#runChecks`; the default `ProcessCheckRunner` uses `platform.run` with a timeout per
command and resolves a relative command `cwd` under the worktree) at tiers 0, 2 and 3, before
the evidence is rendered. The results join `evidence.checkResults`, so the model reads the
output and a failed required check is a high finding; the evidence list records each as
`ran: <name> -> pass|fail (<first line>)`. Tier 1 is a light read under its 30 s target: it
does not run commands and records `checks: N command(s) not run at tier 1 ...` instead, so the
omission is never silent.

Mandatory tiers (open decision in the spec): anything touching main, security, data, money or
science claims is reviewed at tier 2 or higher. Small-project mode (spec B.6, ADR 0051)
defaults a new task that names no tier to tier 0: that default is chosen in one place, the
runtime's `defaultRiskTier(project)` (`packages/runtime/src/session/project-plan.ts`), by every
task creation path, and stored on the task (`risk_tier`). The critic reviews at the tier it is
given and never reads the flag, so a tier named on a task stands whatever the mode and flipping
the flag leaves existing tasks' tiers alone (`packages/runtime/test/small-project.test.ts`,
`packages/commands/test/small-project.test.ts`).

### Independence (H.1, ADR 0028)

Independence comes from a clean context and a different tier, not a different vendor:

- the system prompt is the registry critic prompt (`evals/registry/critic/critic.md`, loaded by
  the runtime's `loadRegistry`) plus a fixed suffix that names the tool to return the review in;
- the only user message is `evidence.ts#renderEvidence(ReviewInput)`: brief, acceptance
  criteria, changed files, the input files the worker was given (in full up to the cap), diff,
  check results under "Check results (run by the runtime: verified)" with the fixed trust line,
  checks not run at this tier, test output, the worker's final report (labelled as claims), PR,
  artifacts, limits the runtime recorded, the docs section at tier 2+, earlier open findings,
  the session facts for a session subject, and always a closing "Evidence not available"
  section (ADR 0042). `ReviewEvidence` has no field for the worker's transcript or reasoning,
  and the renderer sends nothing outside the type; the test passes a decoy transcript in an
  extra field and asserts it never reaches the provider;
- the critic runs as its own agent (`criticAgentId`, an `AgentRow` of kind `critic`) on a
  capability token issued for the review: the session's ids, owner, project, budget (never more
  than the session token's) and expiry, depth + 1, no paths, no domains, no secrets, and
  exactly one tool, `submit_review`. The runtime hooks deny anything else (`tool_not_allowed`);
- evidence blocks bypass context compression (`ContextPipeline.compressToolResult(..., "off")`,
  ADR 0003) so the critic reads raw output, and the driver run itself is started with
  `compression: "off"` on the session pipeline (`deps.context`) so the loop's own tool-result
  compression is bypassed too; the compression records show zero savings and the Run row stores
  the same tokens before and after;
- the critic never edits the work and never messages the worker during the review. Follow-up
  messages (`followup.ts`) go to the owner agent after the verdict is persisted.

### Evidence format (`types.ts`)

```
ReviewInput  { subject: {kind:"task", taskId} | {kind:"session", sessionId}
                      | {kind:"lesson", lessonId}; tier: 0|1|2|3;
               evidence: ReviewEvidence }
ReviewEvidence { diff?, changedFiles?, inputFiles?: {path, content}[], testOutput?,
               checkResults?: {name, passed, output, required?}[], checksNotRun?: string[],
               unavailable?: {name, reason}[], limits?: string[],
               prUrl?, acceptanceCriteria: string[], brief?, artifacts?, docsTouched?,
               moduleFilesTouched?, docsWaiver?, finalReport?, runId?,
               sessionPlan?, sessionSummary?, sessionCostUsdMicro?, sessionEstimateUsdMicro? }
ReviewOutput { grade, confidence, verdict, findings: {severity, description, requiredAction,
               fingerprint, where?}[], evidence: string[], summary, model, tier, durationMs,
               costUsdMicro, outcome, adjustments, patterns, lessonProposals, promptVersion?,
               reviewId?, findingIds?, resolvedFindingIds?, humanRequestId?, runId? }
```

The model returns the review through the `submit_review` tool (`schema.ts`, zod). The schema
accepts the prompt's vocabulary (confidence `high|medium|low`, severity
`blocker|major|minor|note`) and the store's (`0-1`, `critical|high|medium|low|info`);
`CONFIDENCE_OF_WORD` and `SEVERITY_OF_WORD` are the only mapping. `medium` confidence maps to
0.7, above the H.4 line, and `low` to 0.2 (ADR 0042: medium is the normal confidence of a light
read whose checks the runtime ran; the spec's "low confidence never accepts" is about `low`).
An `escalate` carries an optional `escalation: { reason: unverified_finding | evidence_missing
| limit, detail }`, the ground the rules check. When a model answers in text instead, the first
JSON object in the text that parses is used; nothing at all is `outcome: "no_verdict"` and a
conservative `escalate`. Every `evidence` line is something a human can check: criteria met or
unmet with the evidence the critic cited, checks run, the prompt version, the run id, the
compression bypass, the doc-drift result, the ground an escalate stood on (`escalate: ...`) or
why it did not qualify (`escalate not qualified: ...`) and, for tier 1, whether the 30 s target
was met.

The closing "Evidence not available" section is what bounds "I could not verify": it lists the
caller's `evidence.unavailable` items (name and reason), a diff the renderer could not produce
for listed changed files, and every block the size cap cut (`<name> (truncated)`); with nothing
missing it carries the fixed sentence `EVIDENCE_COMPLETE_LINE`. The renderer returns the names
(`RenderedEvidence.unavailable`) and the service hands them to the rules. Checks a tier 1 review
did not run are rendered under their own heading as the tier's design, never as missing
evidence, so a light read grades the diff by reading. The section titles are constants
(`EVIDENCE_SECTIONS`) and `test/evidence.test.ts` asserts the registry prompt names them.

### Rules in code (`rules.ts`)

Applied to every verdict, tier 0 included, and recorded as `adjustments` so the review shows
what the model said and what the code made of it:

0. `escalate_needs_reason` (ADR 0042): an `escalate` must stand on a ground the code can see,
   checked by `rules.ts#escalationCheck` in this order: a critical or high finding (verified or
   not: a critical or high finding with evidence keeps the verdict the model chose, revise or
   escalate), the review run itself ending in a limit (`outcome` other than completed), low
   confidence (H.4), an `evidence_missing` reason whose `detail` names an item of the
   "Evidence not available" section (`namesUnavailable`: containment either way, details under
   four characters never match), or a `limit` reason when `evidence.limits` records one.
   Without a ground the verdict becomes what the findings justify: `revise` with a medium or
   higher finding, otherwise `accept`, and the rules below then apply to that. The model's
   confidence under the line is itself a ground, so a `low` escalate stands; a `medium`
   one (0.7) with nothing wrong is an accept. The adjustment's reason records why the model's
   ground did not qualify (for example: it named "the fixture text" as missing, but the evidence
   is complete).
1. `blocking_finding`: a finding of severity medium or above turns `accept` into `revise`
   (B.4). Medium counts because an accepting review's findings are stored `wontfix` (they never
   block close); a medium finding such as doc drift must stay open.
2. `grade_verdict_consistency`: `accept` needs a grade of at least `ACCEPT_MIN_GRADE` (70).
3. `low_confidence`: confidence below `LOW_CONFIDENCE` (0.6) never accepts; it escalates (H.4).
4. `tier3_human_signoff`: tier 3 always ends in `human` (H.2).

Before the rules run, `critic.ts#buildVerdict` adds findings the model cannot talk away: a
high finding per failed required check from `checkResults` (B.4), a high finding per
acceptance criterion the model marked unmet, a medium finding per module changed without its
maintainer doc at tier 2+ (`docs-drift.ts`, same table and waiver as `scripts/docs-check.mjs`;
`test/docs-drift.test.ts` fails when the two tables differ), and the session checks' findings
for a session subject, whose grade also bounds the model's. The rules only tighten: a `revise`
or `escalate` is never turned into `accept`. Grades are clamped to 0 to 100, confidence to 0 to 1.

After the rules, a `revise` or `escalate` that names no finding gets one synthesised from the
summary (medium, "Address the critic's summary and resubmit") so the retry has something to act
on (`needsFallbackFinding`). That happens only when the model asked for changes or the grade
rule found the work short. A clean result that a rule sends on anyway, the tier 3 sign-off or a
low-confidence escalate, and an escalate that stands on a ground other than a finding (low
confidence, missing evidence, a limit), keep their empty finding list: nothing is wrong with the
work, and an invented open finding would block the close after the human accepts (B.4). The
tier 3 test asserts a grade 97 review leaves no open finding row and a sign-off request with no
steps.

### Persistence (H.3, H.5)

`CriticService.review` writes, through the state repositories: a `Run` row for the critic call
(model, effort, prompt version, tokens, cost, timing, outcome); a `Review` row (task or session,
model, tier, grade, confidence, verdict, evidence, summary); one `Finding` row per finding with
its `fingerprint` (`fingerprint.ts`: sha256 of the normalised description with paths, line
numbers, numbers, quotes and case removed, so the same defect hashes the same in another
session); open findings of the task listed as resolved by the critic, or all of them on an
accept, marked `resolved` with `resolved_by_run` = the run that produced the work; a blocking
`HumanRequest` (kind `approval`, options accept, revise, cancel) for a `human` verdict; and a
`critic.review` event on the subject session (the reviewed session for a session subject, the
token's session for a task). The critic's own Run row and ledger entries always belong to the
token's session, which paid for the call. Findings of an accepting review are stored `wontfix`.
A review whose verdict the rules changed also leaves one audit row `critic.verdict_adjusted`
(`VERDICT_ADJUSTED_AUDIT_TOOL`: the review id, task, tier and every adjustment with its rule,
from, to and reason; `result_summary` names the final verdict and what the model said; never
the evidence), and the `critic.review` event carries the adjustments (ADR 0042). Calibration
persists nothing, so it writes no audit row either.

The critic's Run row stores `ttft_ms` and `duration_ms` as whole milliseconds: the columns are
INTEGER and the store refuses a fraction, so the runtime's driver rounds what it measures and
the critic rounds again at the insert (`wholeMs` from `@forerunner/runtime`). The first live run
(ADR 0040) lost every critic Run row that way, with only a warning line. A Run row the store
refuses never loses the review: the Review and Finding rows are still written, and the failure
is an `error` line through the logger plus an audit row `run.persist_failed`
(`RUN_PERSIST_FAILED_AUDIT_TOOL` from the runtime: the run, session, critic agent and human ids,
the tier, the store's message; never the prompt or the evidence).

Patterns: after persisting, `patterns.ts` asks `FindingRepo.patterns(fingerprint)`; a fingerprint
seen in at least two distinct sessions is returned in `patterns` and as a `LessonProposal`
(`scope: "critic"`, tags `critic`, `pattern`, severity, `source: critic:pattern:<fp>`). The
critic never writes lessons; the memory package stores proposals.

### Follow-up (`followup.ts`, B.4, D.2, D.3)

`applyVerdict(taskId, review, ctx)` applies a verdict through `TaskRepo.transition`, so every
rule the store enforces holds:

| Verdict | What happens | Returns |
| --- | --- | --- |
| accept | the review's findings (and the ones it listed as resolved) are resolved with the work run; `in_review -> done`. Any other open finding makes the store throw `findings_open` and the task stays in review | `{ action: "accepted", task, resolvedFindingIds }` |
| revise | `in_review -> failed -> ready` (the second move counts `attempt`); a `request` message with `requires_ack` to the owner agent listing the required actions | `{ action: "revise", task, attempt, messageId, requiredActions }` |
| escalate | the runtime's `retryAction(attempt + 1, currentTier, ceiling)`: 1st `improve_brief`, 2nd `split_or_change_specialist`, 3rd `escalate` with `nextTier = nextRung(current, ceiling)` when under the ceiling, otherwise `human`. The task goes back to ready and the owner agent is told; the session runner applies the decision | `{ action: "retry", retry, task, attempt, nextTier, messageId, requiredActions }` or `{ action: "human", ..., reason: "retry_ladder_exhausted" }` |
| human | `in_review -> needs_human`; the review's sign-off request is reused while open, otherwise a new blocking one is created | `{ action: "human", task, humanRequestId, reason: "verdict" }` |

A `lesson` subject (spec G.6, [ADR 0059](../decisions/0059-cross-project-promotion-in-the-loop.md)):
the runtime's promotion review of a lesson proposed for the shared store, a tier-1 light read
of the lesson text (an input file and the claims) against the promotion criteria the runtime
sends. The review and finding rows carry no task and the token's session, the run label reads
`critic tier 1 on lesson <id>`, and a `human` verdict files no sign-off request: there is no
task to sign off. The verdict rules apply unchanged; the runtime promotes on `accept`, retires
the proposal on any other completed verdict (`human` included; `rejected_by:<review>` in its
source) and tells the human why in one warning message (runtime.md "Cross-project sharing";
ADR 0059 amendment of 2026-10-25), and leaves it pending when the run did not complete.

Every sign-off request (the one `CriticService.review` files for a `human` verdict on a task or
session subject, the one `applyVerdict` files when the ladder ends, and the runtime loop's own
after a last-rung revise) names its task in the `why` (`Critic sign-off needed for "<title>"
(tier …)`, `Retry ladder exhausted after … for "<title>"`; U-073: the phone shows the text
alone, and the desktop's Inbox shows the task's title and project beside it) and has the
options `SIGNOFF_OPTIONS` (`accept`, `revise`, `cancel`) and a `change_card`
built by `signoffCard` and keyed `SIGNOFF_KEY` (`critic:signoff`): the task, the review, the
run that produced the work, the review's finding ids, the reason (`verdict` or
`retry_ladder_exhausted`) and `applied_at: null`. The answer is applied by the runtime
(`syncSignoffAnswers` in `packages/runtime/src/session/findings.ts`, from
`RuntimeApp.syncApprovals`; runtime.md, "The core loop"; ADR 0049): accept closes the task
with the card's findings and the task's other open findings up to the card's review
resolved against `run_id` (the ladder's last rung leaves the earlier rungs' findings open:
this package resolves them only on its own accept), revise sends it down the ladder, cancel
cancels it, and the card's `applied_at` and `outcome` make every answer apply once. The
runtime applies an answer only when the card's `review_id` is the task's latest review
(`ReviewRepo.latestForTask`): a sign-off left open while the task was reviewed again is
`stale` and touches nothing, so a filing site must set `review_id` to the review the
sign-off is about. This package files the card and never reads it.

A task in `in_progress` is moved to `in_review` first; any other state is a `validation` error.
Escalation never goes above the ceiling: `followup.ts#escalationCeiling` always reads the task's
project row (`settings.critic_ceiling`) and takes the stricter of it and `ctx.ceiling` (the
ladder's default when neither is set); `nextRung` returns null at the ceiling and the ladder
hands over to the human. A caller that passes no ceiling, or a higher one, cannot escalate past
the project's.

### Session review (`session-review.ts`, H.6)

`reviewSession({ store, sessionId, criticAgentId })` runs three deterministic checks against the
store and persists a `Review` with `session_id` set and `task_id` null:

- plan quality: estimate within the session budget; every plan item is a task that exists and
  is not a draft; no spend without a plan;
- cost efficiency: actual spend (cost ledger, else the session counter) against the estimate
  (medium finding above 1.5x and one cent), spend above the cap (high), cost per done task,
  spend with no planned task done (medium), and a plan with none done whose tasks failed or
  were sent back by the critic (the session handoff's `sent_back`, `sentBackOf`), even at no
  cost: one medium finding naming both counts ("No planned task was done: 1 of 2 failed, 1 sent
  back by the critic"; U-017: an all-failed session was graded 100; U-072: so was one whose only
  task was sent back). The service's own event is
  `critic.session_review_metrics` (the measurements); the runner reports the review as
  `critic.session_review`, so the session log shows it once;
- honesty: `parseSummaryClaims` reads "Done: N" (also "N tasks done", "completed N tasks"),
  "failed: N", "Cost: USD x" and "Spent CHF x" (the runner's summary says CHF, U-074; checked
  against the ledger's `chf_micro`, `ledgerChfMicro`) from the summary and compares them with the task states and the
  ledger. Done tasks are counted over every task the session planned or ran
  (`loadSessionReviewData` loads the plan items and the task ids of the session's Run rows), so
  a task a run finished that the plan never listed counts; the planned subset is reported too
  (`metrics.plannedDoneTasks`). A done count that matches neither the overall nor the planned
  count is a high finding ("Summary claims N task(s) done but M of the K task(s) the session
  planned or ran are done") and the verdict is `human`: the human was told something untrue.
  A cost claim more than 10% off is medium. An empty summary of a finished session with a plan
  is low.

Grade is 100 minus a penalty per finding (critical 50, high 30, medium 15, low 5). At tier 1+,
`CriticService.review({ kind: "session" })` runs the same checks, sends the plan, summary,
estimate and spend to the model as the Session section, takes the lower of the two grades and
keeps a `human` verdict from the checks.

A `human` verdict files one request (`fileSessionReviewRequest`, at every tier; U-033) for the
session's owner: `ReviewSessionOptions.humanId` / `ReviewContext.humanId`, else the session
token's owner, else the owner of the session's agent (`sessionOwnerOf`). It was filed with
`human_id: null`, which no inbox lists, and at tier 1+ with the task sign-off's options and no
card. Its options are "Acknowledge" and "Correct the summary" (`SESSION_REVIEW_OPTIONS`), its
card `{ key: SESSION_REVIEW_KEY, session_id, review_id, finding_ids, metrics }`; the runtime's
`syncSessionReviewAnswers` applies the answer (`runtime.md`): acknowledge marks the review's
open findings `wontfix`, correct appends a correction from the records to the session's
summary and resolves the summary findings. The old options were "acknowledge" and "cancel";
a review is filed after its session ended, so "cancel" had nothing to cancel and was replaced.
`isSessionReviewRequest` also recognises a request with the old options (`cancel` reads as an
acknowledgement); such requests were filed for nobody and are not re-addressed.

### Calibration (`calibration.ts`, H.7, phase 3 gate)

`calibrate({ evalSet, tier, critic, ctx })` reviews every eval task twice through the normal
path with `persist: false`: the clean expected output and the seeded-defect variant, both
produced by `expectedOutputDriver` from `@forerunner/evals` (or a real driver). The eval runner
writes the files and runs the mechanical checks; the critic receives (`evidenceFor`, ADR 0042)
the brief as the worker saw it (`renderBrief`), the criteria plus the rubric criteria, the
task's `setup.files` as input files in full (the researcher's sources, the coder's starting
files), a new-file diff of the files on disk, the runner's checks with their output under the
verified heading, and the final text as the worker's report. Nothing names the variant: the
driver's notes and the duplicated test-output block are dropped, and the work directory (whose
name carries `clean` or `seeded_defect`) is replaced by `<work dir>` in check output
(`WORK_DIR_PLACEHOLDER`), so a caught defect is caught from the work. The report counts
`catchRate` = seeded variants with a verdict other than `accept` over seeded
variants, and `passRate` = clean variants accepted over clean variants, evaluates the gate
(`CALIBRATION_THRESHOLDS`: catch at least 0.8, pass at least 0.9), lists every task with both
verdicts, grades, the mechanical status and the cost, and writes
`<data dir>/critic/calibration-<YYYY-MM-DD>.json` (a second run the same day gets a time suffix).
`formatCalibrationReport` renders it for `docs/status/gates.md`. The eval package depends on
this one, so the runner is loaded with a dynamic import (or injected through `evals`).

Monthly (spec H.7 "so drift is visible", ADR 0060): the runtime's `CalibrationJob`
(`packages/runtime/src/jobs/calibration.ts`, `runtime.md` "Monthly jobs") calls `calibrate()`
once a month over the registry's eval sets under a session budget the hooks enforce, keeps
the report under the same `<data dir>/critic/` and raises a notification with the catch rate,
the pass rate and the drift in points against the previous report. `EvalsPort.loadEvalSet` is
optional for that job (`loadEvalsPort()` now returns it; a caller with its own tasks leaves it
out).

## How to change it

- The prompt: edit `critic/critic.md` in the `forerunner-registry` repository and sync it to
  `evals/registry/critic/critic.md`. The frontmatter's `max_effort` caps the effort; the body is
  the system prompt. Every run stores the prompt version (`critic@<semver>+<sha8>`), so a change
  shows in the calibration report; bump `version` in the frontmatter with a change of meaning
  (1.1.0 is ADR 0042) and re-run the live calibration. Keep the prompt under 120 lines (the
  registry loader enforces it). The prompt names the evidence sections, the three confidence
  words and the escalation reasons; `test/evidence.test.ts` fails when they drift from
  `EVIDENCE_SECTIONS` and `ESCALATION_REASONS`. The prompt may ask for care; it cannot loosen a
  rule.
- Escalation grounds: `rules.ts#escalationCheck` (the order and the matching); the reasons the
  model may give are `ESCALATION_REASONS` in `schema.ts`. A new ground needs a line there, a
  row in the rules table test and a prompt sentence.
- What counts as missing evidence: a builder declares it in `evidence.unavailable` (name and
  reason); the renderer adds a missing diff and truncated blocks itself. Never list something
  the review is designed to do without (tier 1 checks go in `checksNotRun`), or every tier 1
  review can escalate on it.
- Thresholds: `LOW_CONFIDENCE`, `ACCEPT_MIN_GRADE`, `BLOCKING_SEVERITIES` in `rules.ts`;
  `CALIBRATION_THRESHOLDS` in `calibration.ts` (the phase 3 gate numbers, change only with an
  ADR); `COST_OVERRUN_RATIO`, `COST_CLAIM_TOLERANCE` in `session-review.ts`.
- Models and effort per tier: `MODE_DEFAULTS` in `packages/runtime/src/models/ladder.ts`
  (`critic_t1`, `critic_t23`); the critic only reads them. Per project: `settings.critic_ceiling`
  and `settings.speed_quality_offset`.
- The doc-drift table: change `scripts/docs-check.mjs` and `src/docs-drift.ts` together;
  `test/docs-drift.test.ts` fails otherwise.
- The tool schema: `schema.ts`. New fields must stay optional or defaulted so an older prompt
  still validates.
- Evidence sections: `evidence.ts#renderEvidence`. Never add a field that carries the worker's
  transcript; the clean-context test guards the type.
- Checks: pass `checkResults` in the evidence (pre-executed) or `ctx.checks` (argv commands
  run in `ctx.cwd` through `ProcessCheckRunner` at tiers 0, 2 and 3; timeout per command,
  output tail kept, a relative command `cwd` resolved under `ctx.cwd`). Inject a `CheckRunner`
  through `deps.checkRunner` for a sandboxed executor. To run commands at tier 1 as well, change
  the tier test in `modelReview` and the 30 s target together.
- Ceilings: `settings.critic_ceiling` on the project row is the source of truth; pass
  `ctx.projectSettings` only to avoid the store read (the daemon has the row), `ctx.ceiling` to
  tighten for one review.

## Tests

`pnpm vitest run --project unit packages/critic/test` (fake provider, in-memory SQLite, no
network). The fixture world (`test/helpers.ts`) seeds its session with a plan, so the row names
a reason (`fixture session`) and the owner agent as author, as the store's B.5 insert guard
requires.

- `fast-mode.test.ts` (spec D.20, ADR 0057):
  - With the flag on, a tier-2 review on the Opus rung of an API source carries
    `speed: "fast"`. The Run row, the ledger rows and `ReviewOutput.model` name the variant at
    its price, and one audit row says applied.
  - A project with the flag off, and a tier-1 review on the sonnet rung, are unchanged with no
    audit row.
  - A subscription source is ignored with an "API only" audit row and a warning.
  - Without the facts dep, a provider without fast mode is noted and never asked.
  - Calibration (`persist: false`) writes no audit row.
- `tier0.test.ts`: pass-share grade, required and optional checks, missing criteria, no checks
  (low confidence), the check runner, relative and absolute command `cwd` resolution, and a
  real process with exit code and timeout.
- `rules.test.ts`: each rule, clamps, rules only tighten a revise; a table of escalate cases
  (ADR 0042): clean work at medium confidence with no reason becomes accept, a medium finding
  becomes revise, a high or critical finding stands (the seeded-defect case), low confidence
  stands (H.4), the review run's own limit stands, `evidence_missing` stands only when it names
  a listed item (including a truncated block by its base name) and falls otherwise, a short
  detail names nothing, `unverified_finding` with only a medium finding is revise, `limit`
  stands only with a recorded limit, no grounds object means complete evidence, a downgraded
  accept under the grade line is revise, tier 3 still ends with the human, `namesUnavailable`.
- `evidence.test.ts`: the sections in order with the input files in full, the verified heading
  and trust line, the "nothing missing" close; the caller's unavailable items first, then a
  diff missing for listed files and every block the cap cut, named; checks not run and limits
  rendered; a session subject closes the same way; the registry prompt names the sections, the
  reasons, verified checks and "Low confidence is never accept", at version 1.1.0.
- `model.test.ts`: the tier table, ceiling, offset, `max_effort`, project settings,
  `stricterCeiling`, `modelFor` (a call lowers, never raises) and `settingsFor` reading the
  project row.
- `fingerprint.test.ts`, `schema.test.ts`, `docs-drift.test.ts` (table equality with the CI
  script and behavioural equivalence on samples).
- `lesson-subject.test.ts`: a lesson subject at tier 1 on a clean context (`Subject: lesson
  <id>`, the text and tags in the evidence, one tool), the review row with no task and the
  token's session plus its critic Run row, a `human` verdict filing no sign-off request, a
  `revise` with its finding row, and a subject without an id or of an unknown kind refused.
- `critic.test.ts`: clean context with a decoy transcript, the issued token's claims (one tool,
  no paths, domains or secrets, budget and expiry within the parent, depth + 1) with another
  tool denied, compression bypass on the evidence and `compression: "off"` on the run, every
  rule end to end, tier 3 sign-off with a clean result leaving no finding, low-confidence
  escalate without an invented finding, model revise with no finding getting one, failed
  required check, unmet criteria, no verdict, checks run at tier 2 and noted at tier 1, doc
  drift at tier 2 and not at tier 1, waiver, persistence of review, findings, run and event,
  resolution of earlier findings, patterns to lesson proposals across two sessions, model by
  tier and context ceiling, the project row's ceiling from the store with a caller unable to
  raise it, session subject at tier 1, session review event on the subject session; ADR 0042:
  medium confidence accepts a clean result with no audit row, an escalate with no ground on
  clean work becomes accept with the `critic.verdict_adjusted` audit row (ids, adjustments,
  never the evidence) and the adjustment on the `critic.review` event, an escalate naming a
  listed-unavailable item stands while one naming present material does not, a grade-40
  escalate with no finding becomes revise with the summary as the finding, an escalate on a
  major finding and one at low confidence stand with their ground in the evidence.
- `run-row.test.ts`: a review whose first-token time and duration are fractional (12.345 ms and
  987.65 ms on the fake provider with simulated latency) persisted on the real in-memory store
  with `ttft_ms` 12, an integer duration, the outcome and the cost; a refused Run row insert
  keeping the Review row and leaving a `run.persist_failed` audit row and a log line that name
  the run and never the prompt or the evidence.
- `session-review.test.ts`: claim parsing, the "Done: 3 when 1" lie, an unplanned task a run
  finished counting as done (and "Done: 2" still a lie), plan quality, cost efficiency, an
  honest session, tier 0 session review through the service.
- `followup.test.ts`: every verdict path, `findings_open` on accept with a foreign open finding,
  the retry ladder up to the ceiling and then the human, the project row's ceiling honoured
  with no ceiling in the context and with a higher or lower one, the sign-off request's
  options and `critic:signoff` card (reason `verdict` and `retry_ladder_exhausted`). The
  card's consumer is tested in the runtime (`packages/runtime/test/signoff-answer.test.ts`:
  accept, revise and cancel through the critic loop on the fake provider).
- `calibration.test.ts`: the rate and gate arithmetic, a full run over synthetic eval tasks
  with the report on disk, the gate passing, evidence rendering (input files, the work
  directory scrubbed from check output, no driver note, nothing naming the variant), and the
  ADR 0042 table: a critic that answers clean work with escalate at medium confidence and no
  ground (as the live tier 1 model did) and a failed check with revise or with escalate plus a
  major finding; both rows pass the gate, the clean reviews are accepts at grade 86 with a
  confidence above the line, the defects are caught, and the evidence every review read
  carries the fixture in full, the verified heading, the files as a diff and the "nothing
  missing" close, and never `seeded_defect`, the driver's note or a work directory name.

The phase 3 gate (catch at least 80% of seeded defects, pass at least 90% of clean work on the
real eval sets with a live model) is run with `calibrate` over `loadEvalSet("evals/registry/evals/coder")`
and `.../researcher`; the result and the report path go to `docs/status/gates.md`.

### Output tokens and the shape of a review (ADR 0028, amendment of 2026-10-26)

At every effort but `max` a review is two model calls at `REVIEW_TOKENS_PER_CALL` (8192)
each: the model calls `submit_review`, the tool answers "Review recorded. You may stop now."
and the loop makes a closing call. `CriticDeps.maxTokensPerCall` overrides the 8192.

At effort `max` (tier 3 on Opus by default; tier 2 when the speed-versus-quality slider raises
high to max) two things change, both in `modelReview`:
- `submit_review` returns `endRun: true` (`ToolResult.endRun`, runtime), so the verdict ends
  the run. A review is one call. No closing call is priced at a full output cap after the
  verdict.
- The run asks for `maxTokensCeiling: MAX_EFFORT_TOKENS_CEILING` (24000). The loop sizes each
  call's `max_tokens` as the largest value between 8192 and 24000 whose priced estimate (full
  input plus the cap at the output price, the precheck's own estimate) fits the room left for
  the review: the critic token's run cap less the run's spend, the session's budget left and
  (while the session still takes new work) what stays below its 80% no-new-work line, and the
  room under the human's and the project's caps (`CapsPort.roomUsdMicro`: below their 80%
  lines, so no spurious "budget at 80%" warning). The 24000 is first clamped to the model's
  own output limit when the provider reports it within 5 s (a stalled Models API never holds
  the review: the read gets the run's signal and the loop stops waiting after 5 s).
  When even 8192 does not fit, the call asks for 8192 and the hooks decide as before
  (`budget_exceeded` when a cap refuses it). Details in `runtime.md`, "Two options let a run
  ...".

Why: the live D.15 run of 2026-10-25 ended both tier 3 reviews (Opus 5.5, effort max) at
`max_tokens` 8192 with no verdict, after about 75 s of thinking. A fixed 20000 cap was rejected
in review: with the closing call also priced at 20000, it was refused under the review's USD
0.50, and fast mode (USD 40 per MTok output) priced even the first call over it.

Worst case of one max-effort review is its run cap, since the one call is never priced above
what is left. With the live test's evidence (about 2400 input tokens in the unit test, a few
thousand live) under USD 0.50: Opus 5.5 gets the full 24000 (about USD 0.49 at the cap); fast
mode gets about 12000 (USD 0.50 at the cap). A model that needs more than its cap still stops
at `max_tokens` with `no_verdict`; the live line prints each call's `max_tokens`.

A verdict that is captured stands. When `submit_review` has recorded one and the run then ends
`budget_exceeded`, `step_cap_exceeded` or `max_turns` (a later call refused, which at efforts
below max is the closing call), the review's outcome is `completed` with that verdict. The
evidence gets `run: <outcome> after the verdict was recorded ...` and the Run row keeps the
run's own outcome. A timeout, a kill or an error after the verdict still name the review.

Tests: `critic.test.ts`, "a max-effort review finishes inside its budget". A tier 3 review
under USD 0.50 where the model needs 15000 output tokens, on Opus pricing and in fast mode
(needs 10000). Tier 2 unchanged (8192, two calls). A captured verdict whose closing call is
refused. A max-effort review whose model does not answer within
`DEFAULT_DEEP_REVIEW_TIMEOUT_MS` (10 min) ends `timeout` with no verdict: the larger cap buys
a longer call, not a longer review. Runtime side: `packages/runtime/test/loop-call-cap.test.ts`
(the 80% line, the outer caps' room, the model-limit clamp and a stalled limit read, `endRun` on an error result
and next to a pending approval).

## Known issues

### Measured

- 2026-10-20, first live run (run `2026-10-20T17:07:09Z`, `critic@1.0.0+219813d0`, Sonnet
  tier 1): defects caught 40/40, clean accepted 15/40 (37.5%, the 10-task subset 7/10), the
  gate failed on the pass rate. Every miss was `escalate` at grade 80 to 88 and confidence
  "medium" (0.5 then) with no finding: the critic discounted the runner's passing checks it had
  not run itself, and the researcher evidence lacked the source fixtures.
- 2026-10-20, after ADR 0042 (run `2026-10-20T18:17:27.641Z`, `critic@1.1.0+7661cc6c`,
  `claude-sonnet-5-5` tier 1, one run): subset defects caught 10/10, clean accepted 10/10
  (100%), 20 reviews, USD 0.4733, 197 s; full set defects caught 40/40, clean accepted 40/40
  (100%), 80 reviews, USD 1.8459, 783 s. All 40 clean reviews (20 coder, 20 researcher)
  `accept` at grades 88 to 96 with confidence 0.9 (the model answered `high`, so no
  `escalate_needs_reason` downgrade fired on the live model); all 40 seeded reviews `revise` at
  grades 0 to 30. Critic model calls (160): median 4.1 s, p90 7.8 s, max 9.5 s; wall time per
  task pair median 19.4 s, max 22.9 s. Run totals 200 ledger rows, USD 2.3192, no refusal. Gate
  row and report paths in `docs/status/gates.md`; the ledger is `tests/live/spend.json`.

### Open

- The runtime's `CriticLoop` passes no `inputFiles`, `unavailable` or `limits` yet (ADR 0042):
  a production tier 1 review grades the diff with the project's check commands listed under
  "Checks not run at this tier" and the "nothing missing" close. Wiring the worker's run outcome
  into `limits` and the worktree's starting state into `inputFiles` is a runtime follow-up.
- The escalate ground `evidence_missing` is matched by name containment; a model that names an
  item vaguely ("some files") does not qualify and is downgraded with the reason recorded. If
  that proves too strict on a later run, the match lives in one function (`namesUnavailable`).
- At tiers 2 and 3 the service runs `ctx.checks` itself before the model reads; the critic
  token still allows no commands, so the model cannot run anything beyond those checks. A
  sandboxed read-only command tool for the critic is a later addition. With no `ctx.checks` and
  no `checkResults`, tier 2 reviews the diff only; the session runner must pass one of them.
- The requirement rows H.1 to H.7, B.4, D.2, D.3, D.14, D.15 and P.14 in `docs/requirements.md`
  and the phase 3 gate in `docs/status/gates.md` are owned by the integrator: the gate needs
  `calibrate()` over the real eval sets with a live model, which this package cannot run in
  unit tests.
- Session review honesty checks parse a narrow set of claims (done, failed, cost); other claims
  are left to the model at tier 1+.
- `evals` depends on `critic` and `critic` has `evals` as a dev dependency; calibration loads the
  runner dynamically. A later split of the eval task types into a leaf package removes the
  dynamic import.
- The critic does not store lessons (by design); the runtime's critic loop records
  `lessonProposals` in critic memory and the memory loop proposes the ones tagged `general`
  for the shared store, which the critic reviews as a `lesson` subject (spec G.6).

## Requirement IDs covered

H.1 (independence: clean context, own token, one tool, compression bypass; the evidence's
contents and its "Evidence not available" close, ADR 0042), H.2 (tiers 0 to 3, tier 3 human
sign-off: the blocking request with its `critic:signoff` card, whose answer the runtime
applies, `packages/runtime/test/signoff-answer.test.ts`), H.3 (grade, confidence, findings with severity, verdict, evidence; an escalate's
ground and a downgraded escalate's reason in the evidence and the audit log), H.4 (low
confidence never accepts: `low` and any number under 0.6 escalate; `medium` sits above the
line), H.5 (findings tracked to resolution, patterns to lesson
proposals), H.6 (session review: plan, cost, honesty), H.7 (calibration report against the eval
set; monthly with the drift by the runtime's job), G.6 (the `lesson` subject: critic approval before a lesson is promoted to the shared store), B.4 (no close with open findings or failed required checks), D.2 (retry ladder), D.3
(ceiling from project settings), D.14 and D.15 (critic model and effort per tier), P.14 (doc
drift at tier 2+), D.20 (Opus fast mode reaches the project's Opus reviews on an API-style
source, `fast-mode.test.ts`), D.5 and D.19 (the critic's own Run row: model, effort, prompt version,
tokens, cost, first-token time and total time as whole milliseconds; a refused row audited and
logged, never silent).
