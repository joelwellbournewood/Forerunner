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

Checks: `ctx.checks` (argv commands, `ctx.cwd` the worktree) are run through the `CheckRunner`
(`tier0.ts#runChecks`; the default `ProcessCheckRunner` uses `platform.run` with a timeout per
command and resolves a relative command `cwd` under the worktree) at tiers 0, 2 and 3, before
the evidence is rendered. The results join `evidence.checkResults`, so the model reads the
output and a failed required check is a high finding; the evidence list records each as
`ran: <name> -> pass|fail (<first line>)`. Tier 1 is a light read under its 30 s target: it
does not run commands and records `checks: N command(s) not run at tier 1 ...` instead, so the
omission is never silent.

Mandatory tiers (open decision in the spec): anything touching main, security, data, money or
science claims is reviewed at tier 2 or higher; small-project mode defaults to tier 0. The tier
is chosen by the planner and stored on the task (`risk_tier`); the critic reviews at the tier it
is given.

### Independence (H.1, ADR 0028)

Independence comes from a clean context and a different tier, not a different vendor:

- the system prompt is the registry critic prompt (`evals/registry/critic/critic.md`, loaded by
  the runtime's `loadRegistry`) plus a fixed suffix that names the tool to return the review in;
- the only user message is `evidence.ts#renderEvidence(ReviewInput)`: brief, acceptance
  criteria, source files (the inputs the work is checked against, ADR 0041), changed files,
  diff, the runner's check results, test output, the worker's final report (labelled as
  claims), PR, artifacts, the docs section at tier 2+, earlier open findings, the session
  facts for a session subject. `ReviewEvidence` has no field for the worker's transcript or
  reasoning, and the renderer sends nothing outside the type; the test passes a decoy transcript
  in an extra field and asserts it never reaches the provider;
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
ReviewInput  { subject: {kind:"task", taskId} | {kind:"session", sessionId}; tier: 0|1|2|3;
               evidence: ReviewEvidence }
ReviewEvidence { diff?, changedFiles?, sourceFiles?: {path, content, truncated?}[], testOutput?,
               checkResults?: {name, passed, output, required?}[],
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
0.5, below the accept line on purpose (the floor below lifts it only on deterministic
evidence). When a model answers in text instead, the first JSON object in the text that parses
is used; nothing at all is `outcome: "no_verdict"` and a conservative `escalate`. Every
`evidence` line is something a human can check: criteria met or unmet with the evidence the
critic cited, checks run, the prompt version, the run id, the compression bypass, the
doc-drift result, the confidence floor when it applied and, for tier 1, whether the 30 s
target was met.

What the critic may rely on without running anything itself is rendered so it cannot be read
as a claim (ADR 0041):

- `Checks run by the runner (data)` (`CHECKS_SECTION`): a lead line (`checksSummary`) counting
  the required checks run before the review, how many passed and failed and that a PASS is
  evidence the critic relies on at every tier while a FAIL of a required check blocks accept;
  then one line per check (`checkLine`: `PASS (required) <name>`, `FAIL (optional) <name>`)
  with the check's output fenced under it (cap `maxOutputChars`).
- `Source files (data)` (`SOURCE_FILES_SECTION`): the inputs the work is checked against as
  they were before the work (fixtures, documents the answer cites, unchanged files the brief
  names), placed between the criteria and the result, each under `### <path>` in a fence.
  Budget: `maxSourceFileChars` per file (default 24 000; head and tail kept past it, a file the
  reader already cut is marked) and `maxSourceChars` in total (default 80 000); files past the
  budget are listed by name and size under "Omitted by the critic's size cap" so the critic
  knows what it was not shown. The block is absent when no source file was given, so a review
  without its inputs shows that.

### Rules in code (`rules.ts`)

Applied to every verdict, tier 0 included, and recorded as `adjustments` so the review shows
what the model said and what the code made of it:

0. `confidence_floor` (ADR 0041), before the rules: when the model's verdict is `accept`, its
   confidence is at least `CONFIDENCE_FLOOR_FROM` (0.5, the prompt's "medium") and below
   `LOW_CONFIDENCE`, and the evidence is deterministic (`deterministicEvidence`: at least one
   required check in `checkResults`, every required check passed, no finding medium or above
   among the model's and the code's), confidence becomes `LOW_CONFIDENCE` and the review
   carries the line `confidence: floored 0.50 -> 0.60 (...)`. A medium confidence with every
   check green is the critic saying it did not run the checks itself; the runner did. Low
   confidence is never lifted, nor anything with a failed or no required check, optional
   checks only, a blocking finding, or a verdict other than accept. `applyVerdictRules(raw,
   tier, { checkResults })`; without the option there is no floor (tier 0 passes none).
1. `blocking_finding`: a finding of severity medium or above turns `accept` into `revise`
   (B.4). Medium counts because an accepting review's findings are stored `wontfix` (they never
   block close); a medium finding such as doc drift must stay open.
2. `grade_verdict_consistency`: `accept` needs a grade of at least `ACCEPT_MIN_GRADE` (70).
3. `low_confidence`: confidence below `LOW_CONFIDENCE` (0.6) never accepts; it escalates (H.4).
   Unchanged by the floor: 0.59 without a passing required check behind it still escalates.
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
low-confidence escalate, keeps its empty finding list: nothing is wrong with it, and an invented
open finding would block the close after the human accepts (B.4). The tier 3 test asserts a
grade 97 review leaves no open finding row and a sign-off request with no steps.

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
  spend with no planned task done (medium);
- honesty: `parseSummaryClaims` reads "Done: N" (also "N tasks done", "completed N tasks"),
  "failed: N" and "Cost: USD x" from the summary and compares them with the task states and the
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

### Calibration (`calibration.ts`, H.7, phase 3 gate)

`calibrate({ evalSet, tier, critic, ctx })` reviews every eval task twice through the normal
path with `persist: false`: the clean expected output and the seeded-defect variant, both
produced by `expectedOutputDriver` from `@forerunner/evals` (or a real driver). The eval runner
writes the files and runs the mechanical checks; the critic receives (`evidenceFor`) the brief,
the criteria (plus rubric criteria), the task's `setup.files` the work did not replace as source
files (`sourceFilesFor`: a researcher's cited document, a coder's existing tests and manifest;
a fixture the work overwrote is in the diff as its new version), a new-file diff of the files
on disk, the mechanical check results as required checks, the final text.
The report counts `catchRate` = seeded variants with a verdict other than `accept` over seeded
variants, and `passRate` = clean variants accepted over clean variants, evaluates the gate
(`CALIBRATION_THRESHOLDS`: catch at least 0.8, pass at least 0.9), lists every task with both
verdicts, grades, the mechanical status and the cost, and writes
`<data dir>/critic/calibration-<YYYY-MM-DD>.json` (a second run the same day gets a time suffix).
`formatCalibrationReport` renders it for `docs/status/gates.md`. The eval package depends on
this one, so the runner is loaded with a dynamic import (or injected through `evals`).

## How to change it

- The prompt: edit `critic/critic.md` in the `forerunner-registry` repository and sync it to
  `evals/registry/critic/critic.md`. The frontmatter's `max_effort` caps the effort; the body is
  the system prompt. Every run stores the prompt version (`critic@<semver>+<sha8>`), so a change
  shows in the calibration report. Keep the prompt under 120 lines (the registry loader enforces
  it). The prompt may ask for care; it cannot loosen a rule.
- Thresholds: `LOW_CONFIDENCE`, `ACCEPT_MIN_GRADE`, `CONFIDENCE_FLOOR_FROM`,
  `BLOCKING_SEVERITIES` in `rules.ts` (the floor's conditions are `deterministicEvidence`;
  change them only with an ADR, as 0041 did); `CALIBRATION_THRESHOLDS` in `calibration.ts`
  (the phase 3 gate numbers, change only with an ADR); `COST_OVERRUN_RATIO`,
  `COST_CLAIM_TOLERANCE` in `session-review.ts`.
- Models and effort per tier: `MODE_DEFAULTS` in `packages/runtime/src/models/ladder.ts`
  (`critic_t1`, `critic_t23`); the critic only reads them. Per project: `settings.critic_ceiling`
  and `settings.speed_quality_offset`.
- The doc-drift table: change `scripts/docs-check.mjs` and `src/docs-drift.ts` together;
  `test/docs-drift.test.ts` fails otherwise.
- The tool schema: `schema.ts`. New fields must stay optional or defaulted so an older prompt
  still validates.
- Evidence sections: `evidence.ts#renderEvidence`. Never add a field that carries the worker's
  transcript; the clean-context test guards the type. Source files are inputs, never the
  worker's output: the runtime loop reads only unchanged files the task names, calibration only
  fixtures the work did not replace. Caps: `RenderOptions.maxSourceFileChars`,
  `maxSourceChars` (`deps.render`); the loop's byte caps are `MAX_SOURCE_FILE_BYTES`,
  `MAX_SOURCE_TOTAL_BYTES`, `MAX_NAMED_PATHS` in `packages/runtime/src/loop/critic.ts`.
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
network):

- `tier0.test.ts`: pass-share grade, required and optional checks, missing criteria, no checks
  (low confidence), the check runner, relative and absolute command `cwd` resolution, and a
  real process with exit code and timeout.
- `rules.test.ts`: each rule, clamps, rules only tighten; the confidence floor (lifted from
  0.5 and 0.59 on passing required checks; never for low confidence, 0.49, no check results,
  no check run, optional checks only, a failed required check, a medium finding or a verdict
  other than accept) and `deterministicEvidence`.
- `evidence.test.ts`: the checks block (PASS/FAIL lines, the required count, the output
  fenced, absent when nothing ran) and the source files block (placed between the criteria and
  the result, each under its path, the per-file cut and the total budget with the omitted
  list, absent when none were given).
- `model.test.ts`: the tier table, ceiling, offset, `max_effort`, project settings,
  `stricterCeiling`, `modelFor` (a call lowers, never raises) and `settingsFor` reading the
  project row.
- `fingerprint.test.ts`, `schema.test.ts`, `docs-drift.test.ts` (table equality with the CI
  script and behavioural equivalence on samples).
- `critic.test.ts`: clean context with a decoy transcript, the issued token's claims (one tool,
  no paths, domains or secrets, budget and expiry within the parent, depth + 1) with another
  tool denied, compression bypass on the evidence and `compression: "off"` on the run, every
  rule end to end, the live run's miss (medium confidence with every required check passed
  accepts through the floor, the review and the stored row carry it) against medium confidence
  with no checks, no check run or optional checks only (escalate) and with a failed required
  check (revise, no floor), tier 3 sign-off with a clean result leaving no finding,
  low-confidence escalate without an invented finding (on passing checks: the floor never
  lifts a low), model revise with no finding getting one, failed required check, unmet
  criteria, no verdict, a research answer reviewed with the document it cites as a source file
  (and without one, the block absent), checks run at tier 2 and noted at tier 1, doc
  drift at tier 2 and not at tier 1, waiver, persistence of review, findings, run and event,
  resolution of earlier findings, patterns to lesson proposals across two sessions, model by
  tier and context ceiling, the project row's ceiling from the store with a caller unable to
  raise it, session subject at tier 1, session review event on the subject session.
- `session-review.test.ts`: claim parsing, the "Done: 3 when 1" lie, an unplanned task a run
  finished counting as done (and "Done: 2" still a lie), plan quality, cost efficiency, an
  honest session, tier 0 session review through the service.
- `followup.test.ts`: every verdict path, `findings_open` on accept with a foreign open finding,
  the retry ladder up to the ceiling and then the human, the project row's ceiling honoured
  with no ceiling in the context and with a higher or lower one.
- `calibration.test.ts`: the rate and gate arithmetic, a full run over synthetic eval tasks
  with the report on disk, the gate passing, evidence rendering (`evidenceFor`,
  `sourceFilesFor`), and the two shapes of the live run's misses: a clean result accepted at
  medium confidence passing on the runner's checks while the seeded variant is still caught,
  and a researcher task whose scripted critic can only judge with the fixture in front of it
  (accepts the right figure, finds the wrong one, and never answers "the fixture text was not
  provided").

The phase 3 gate (catch at least 80% of seeded defects, pass at least 90% of clean work on the
real eval sets with a live model) is run with `calibrate` over `loadEvalSet("evals/registry/evals/coder")`
and `.../researcher`; the result and the report path go to `docs/status/gates.md`. The first
live run (2026-10-20, `claude-sonnet-5-5` at tier 1, critic@1.0.0) caught 40/40 and accepted
15/40 clean results: every miss was an accept at confidence 0.5 that rule 3 escalated, on
coder tasks because the model had not run the passing checks itself and on every researcher
task because the fixtures were not in the evidence. ADR 0041 is the answer; the re-run on
critic@1.1.0 with the floor and the source files is pending (gates.md phase 3 row).

## Known issues

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
- The critic does not store lessons (by design); until the memory package consumes
  `lessonProposals`, patterns are visible only in `ReviewOutput` and `FindingRepo.repeated()`.
- The runtime loop finds source files by the paths the task's own text names
  (`namedPaths` over title, outcome and acceptance criteria); a task that names no file gets
  none, and the executor's brief `contextLinks` (task id, PR, branch) are not file paths. A
  task-level list of input files is a later addition to the task row.

## Requirement IDs covered

H.1 (independence: clean context, own token, one tool, compression bypass), H.2 (tiers 0 to 3,
tier 3 human sign-off), H.3 (grade, confidence, findings with severity, verdict, evidence),
H.4 (low confidence never accepts), H.5 (findings tracked to resolution, patterns to lesson
proposals), H.6 (session review: plan, cost, honesty), H.7 (calibration report against the eval
set), B.4 (no close with open findings or failed required checks), D.2 (retry ladder), D.3
(ceiling from project settings), D.14 and D.15 (critic model and effort per tier), P.14 (doc
drift at tier 2+).
