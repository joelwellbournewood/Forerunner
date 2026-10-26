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
