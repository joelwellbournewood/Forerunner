# 0028 — Critic independence and verdict rules in code

Date: 2026-10-20
Status: accepted

## Context

Spec module H asks for an independent reviewer: "a different model or at least a clean context
with no access to the worker's reasoning", grades with confidence, findings with severity, four
verdicts, low confidence never accept, findings tracked to resolution, repeat findings turned
into lessons, session reviews and monthly calibration. The open decisions say the critic "gets
independence from a different tier and a clean context, not a different vendor", and that tier
2+ is mandatory for anything touching main, security, data, money or science claims. Module B
says a task cannot close with open findings or failed required checks; module D gives the
critic models (Sonnet medium under 30 s at tier 1, Opus high or max at tiers 2 and 3) and the
retry ladder. The spec leaves open how independence is enforced, what exactly bounds a verdict,
how a verdict is applied to the workflow, and how the calibration is wired to the eval package.

## Decision

1. **Independence is enforced by construction, not by instruction.** The critic runs as its own
   `AgentRow` (kind `critic`) on a capability token issued per review that allows exactly one
   tool, `submit_review`, no paths, no domains, no secrets, and never more budget or lifetime
   than the session token. The system prompt is the registry critic prompt; the only user
   message is rendered from `ReviewEvidence`, a type with no field for a transcript or
   reasoning. Evidence bypasses context compression (ADR 0003, bypass `"off"`). The model is
   picked by tier from the runtime ladder (`critic_t1`, `critic_t23`), capped by the project
   ceiling; a different vendor is not required.
2. **The verdict is bounded by rules in code**, applied after the model answers and recorded as
   adjustments: a medium or higher finding turns accept into revise; accept needs a grade of at
   least 70; confidence below 0.6 never accepts (escalate); tier 3 always ends in `human` with a
   blocking sign-off request. Failed required checks, unmet acceptance criteria and doc drift at
   tier 2+ become findings in code before the rules run. Medium findings block accept because an
   accepting review's findings are stored `wontfix`; letting a medium finding through would
   silently drop it.
3. **Verdicts are applied through the state workflow.** Accept resolves the review's findings
   with the run that produced the work and moves `in_review -> done`; the store's
   `findings_open` rule is the last word. Revise and the first three retry rungs go
   `in_review -> failed -> ready`, which is how the task repository counts an attempt. The
   runtime's `retryAction` decides the rung; the critic returns the decision and the session
   runner applies it. The ladder never exceeds the ceiling: at the ceiling the third failure goes
   to the human.
4. **Session reviews are deterministic first.** Plan quality, cost efficiency and honesty are
   checked against the store; a false "Done: N" is a high finding and a `human` verdict. A model
   read at tier 1+ can only lower the grade.
5. **Finding fingerprints** are a sha256 over the normalised description (paths, line numbers,
   numbers, quotes and case removed). A fingerprint seen in two or more sessions is a pattern
   and becomes a lesson proposal returned to the caller; the critic never writes lessons.
6. **Calibration lives in the critic package and loads the eval runner on demand.**
   `@forerunner/evals` depends on `@forerunner/critic` (the eval gate needs the critic), so the
   critic imports eval types only and obtains `runEvalSet` and `expectedOutputDriver` through a
   dynamic import or an injected port. The gate thresholds (0.8 catch, 0.9 pass) are constants in
   code and the report is written under the data directory per day.

## Consequences

- A prompt change cannot make the critic accept a failing check, a low-confidence review or a
  tier 3 task; tests in `packages/critic/test` prove each rule with the fake provider.
- The critic cannot run commands at tiers 2 and 3; "tests run" is the check results the session
  runner supplies. A read-only sandboxed command tool for the critic can be added later without
  changing the token model (it would be a second allowed tool).
- The session review's honesty check is narrow by design (counts and cost); anything else is
  left to the model and will be extended as summaries get a fixed structure.
- Two files hold the module-to-doc table (`scripts/docs-check.mjs` and `src/docs-drift.ts`); a
  test keeps them equal.

## Alternatives considered

- **A different vendor for the critic.** Rejected by the spec's open decision; one SDK and the
  fake provider keep the core loop testable, and a different tier plus a clean context already
  removes the shared-context failure mode.
- **Rules in the prompt only.** Rejected: "a prompt may ask; only code can allow" (AGENTS.md).
- **Low or info findings also blocking accept.** Rejected: it would make every nit a revision;
  they are stored `wontfix` and still count for patterns.
- **Revise as `in_review -> in_progress`.** The graph allows it, but it does not count an
  attempt, so the retry ladder would never advance; `failed -> ready` does.
- **Moving the eval task types into the critic package** to avoid the dynamic import. Deferred;
  it is a mechanical move once the registry sync settles.

## Amendment (2026-10-26, D.15: a max-effort review finishes inside its budget)

**Context.** The live D.15 run of 2026-10-25 (`tests/live/test/live-7-critic-tiers.live.test.ts`)
ended both tier 3 reviews (Opus 5.5, effort max) with no verdict. The first call stopped at
`max_tokens` 8192 after about 75 s of thinking (8192 output tokens, about USD 0.17). Tier 2 at
effort high finished in about 2000. A fixed 20000 cap at effort max was rejected in review
for two reasons. First, a review was two calls (`submit_review`, then a closing call after
"Review recorded. You may stop now."), and the loop's precheck prices every call at its full
output cap. Under the live test's USD 0.50 per review the closing call was refused, so the
review ended `budget_exceeded` with its verdict captured. Second, fast mode (USD 40 per MTok
output) priced even the first call over USD 0.50.

**Decision.** At effort `max` only:
1. The verdict ends the run. `submit_review` returns `endRun: true`, a new `ToolResult` field
   the loop driver honours by making no further call. A max-effort review is one model call.
2. The first call's cap comes from the budget. The run sets `maxTokensCeiling` 24000
   (`MAX_EFFORT_TOKENS_CEILING`), and the loop asks for the largest `max_tokens` between 8192
   and 24000 whose priced estimate fits what is left: the critic token's run cap less the
   run's spend, or the session's budget left, whichever is smaller. When 8192 does not fit,
   the precheck refuses the call as before. (Narrowed the same day after the change's own
   review; see "Follow-up" below.)

At every effort:
3. A captured verdict stands. When `submit_review` recorded a verdict and the run then ends
   `budget_exceeded`, `step_cap_exceeded` or `max_turns`, the refused call was not needed. The
   review is `completed` with the verdict; the evidence says what was refused, and the Run row
   keeps the run's outcome. Timeout, kill and error are not covered by this rule.

Tiers 1 and 2 at their default efforts are otherwise unchanged: two calls at 8192.

**Consequences.** One max-effort review never costs more than its run cap: the one call's
priced estimate fits the budget left, and the actual cost is below the estimate. Under USD
0.50 with a few thousand input tokens, Opus 5.5 gets 24000 output tokens (about USD 0.49
priced at the cap) and fast mode about 12000 (about USD 0.50). A review that needs more than
its cap still ends `no_verdict` at `max_tokens`, and the live line shows each call's
`max_tokens`.

**Follow-up (2026-10-26, from the independent review of this amendment, 82, accept).** Two
gaps in rule 2, fixed in the loop (`EnforcementHooks.callRoomUsdMicro`):
- *The 80% line.* The session precheck sets no-new-work for good once spend plus estimate
  reaches 80% of the session cap. Priced at 24000, a review call could cross that line though
  it costs a fraction of its estimate (cap USD 5, USD 3.50 spent: about USD 0.50 priced, about
  USD 0.17 spent), ending the session's new work early. While the session still takes new
  work, the room now stops strictly below that line (and, for the work phase, at the review
  reserve): `SessionBudget.quietRoomUsdMicro`. Once no-new-work is set, only the caps bound it.
- *Outer caps.* The human's month and the project's budget were not read, so a cap with room
  for the 8192 estimate but not the 24000 one refused the call and the review ended
  `no_verdict`, a regression from the fixed 8192. `CapsPort` gains an optional
  `remainingUsdMicro(scope, opts)`: the smallest money remainder across its levels (never the
  plan share). The room takes it less one, since the outer check stops at spend + estimate
  >= cap.
The room never takes the cap below 8192: when 8192 itself does not fit, the call asks for it
and the hooks decide exactly as they did before this amendment. Also: the ceiling is clamped
to the model's output limit when the provider reports one (`ModelProvider.maxOutputTokens`;
the Anthropic adapter reads it from the Models API) and must be a positive whole number. A
max-effort review stays bounded by its deep-review timeout (10 min by default).

**Alternatives considered.**
- *A small fixed cap for the calls after the verdict.* That still pays for a call nobody reads,
  and it needs a per-turn cap the loop does not have. Ending the run is simpler and cheaper.
- *`maxTurns: 1` at effort max.* This takes away the retry after a malformed `submit_review`
  (the schema error goes back to the model). With `endRun` the run ends only on a recorded
  verdict.
- *The same shape (one call, budget-sized cap) at every tier.* This changes every review's
  calls and the recordings for no measured gain. At 8192 the closing call fits the usual
  budgets, and rule 3 covers the case where it does not.
- *Sizing the cap in the critic.* The critic would have to count input tokens exactly as the
  loop does (system, transcript, tool definitions). The loop already has these numbers and the
  budget, so the sizing is a loop option (`maxTokensCeiling`) that any run can use.
