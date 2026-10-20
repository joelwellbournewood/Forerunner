# 0041 — Critic evidence: the runner's checks and the source files are evidence; a confidence floor

Date: 2026-10-20
Status: accepted

## Context

The first live calibration (`calibrate()` at tier 1 on the real `claude-sonnet-5-5` critic,
2026-10-20, run `2026-10-20T17:07:09Z`) caught every seeded defect (40/40) and accepted 15 of
40 clean results (37.5%, gate 90%). Every miss had one shape: the model accepted with grade 80
to 88 and confidence 0.5 ("medium"), findings low or none, and rule 3 of ADR 0028 (confidence
below 0.6 never accepts) turned the accept into `escalate`. Every accepted clean review had
reported confidence 0.9. The critic's own summaries name two causes:

1. Coder tasks: the evidence carried the eval runner's passing mechanical checks (`checkResults`
   with `passed: true`), but the model reported medium confidence because it had not run the
   tests itself ("correct against all five criteria by reading"). Tier 1 is a light read by
   spec H.2 and never runs commands; the runner already had.
2. Researcher tasks (all 20): the evidence carried the answer files as a diff but not the
   task's `setup.files` the answer cites, so the critic had nothing to check the claims against
   ("the fixture text was not provided, so I could not verify the extra details").

Spec H says low confidence never becomes accept, and AGENTS.md says a prompt may ask, only
code can allow: the rule stays. What was missing was the evidence the critic is entitled to
rely on, rendered so it cannot be read as a claim, and a code-side statement of what a medium
confidence on deterministic evidence means.

## Decision

1. **The runner's check results are evidence, rendered unmistakably.** `evidence.ts` renders
   them as the section `Checks run by the runner (data)` with a lead line that counts the
   required checks and says what the critic may make of them, and one line per check,
   `PASS (required) <name>` or `FAIL (optional) <name>`, followed by the check's output. The
   registry prompt (`critic.md`, version 1.1.0) says the critic relies on them at every tier,
   that a PASS of a required check is the criterion it covers met whether or not the critic ran
   it, that confidence reflects the evidence in front of it and never whether it ran commands,
   and that a criterion lacking evidence is named instead of lowering the confidence of the
   whole review.
2. **The inputs the work is checked against travel with the evidence.** `ReviewEvidence` gains
   `sourceFiles: { path, content, truncated? }[]`: fixtures, documents the answer cites,
   unchanged files the brief names; never the worker's own output and never a transcript.
   The renderer puts them as `Source files (data)` between the criteria and the result, each
   under its path, within a budget (24 000 characters per file, head and tail kept past it;
   80 000 in total, the rest listed by name). Calibration (`evidenceFor`) adds the task's
   `setup.files` the work did not replace (`sourceFilesFor`). The runtime's `CriticLoop` adds
   the unchanged files the task's title, outcome and acceptance criteria name, read from the
   worktree (`namedPaths`, `readSourceFiles`: inside the worktree only, regular text files
   only, 64 KiB per file, 256 KiB in total, at most 32 names); a changed file stays in the diff.
3. **A confidence floor on deterministic evidence.** Before the verdict rules, when the model's
   verdict is `accept`, its confidence is at least 0.5 and below 0.6, at least one required
   check ran and every required check passed, and no finding (the model's or the code's) is
   medium or above, confidence becomes 0.6 (`rules.ts#applyVerdictRules(raw, tier,
   { checkResults })`, `CONFIDENCE_FLOOR_FROM`, `deterministicEvidence`). The lift is recorded
   as the adjustment `confidence_floor` and as an evidence line on the review. Low confidence
   (0.2, "the critic could not verify") is never lifted; neither is a result with a failed or
   no required check, optional checks only, a blocking finding, or a verdict other than accept.
   Rule 3 of ADR 0028 is unchanged: 0.59 without a passing required check still escalates.
4. **Numbering.** 0040 is the live-model harness (`tests/live`: budget cap, spend ledger,
   opt-in command), written on the build box together with the harness and not yet on this
   branch; this record takes 0041 so the two do not collide when the harness lands.

## Consequences

- A clean result the model accepts at medium confidence on passing required checks now
  accepts, and the stored review says the code lifted the confidence. On the 2026-10-20
  misses this covers the seven coder tasks directly and the researcher tasks once the fixture
  is in front of the critic; the live re-run decides the gate (`docs/status/gates.md`).
- Nothing changes for a failed required check, a blocking finding, optional checks only, no
  checks, low confidence, or a model that did not accept: tests in
  `packages/critic/test/rules.test.ts` and `critic.test.ts` prove each.
- Every review at tier 1 and above carries more text: the fixtures or the named source files.
  The caps bound it; a review of a research task on a 100-page source shows the head and
  tail and says what was cut.
- The e2e phase 3 harness keeps judging from the diff: its markers are lines no clean fixture
  contains (`cleanCorpus` includes `setup.files`), so a source file never shows a defect.
- Anything that parsed the old `## Check results` block or its `[pass]` / `[FAIL]` lines
  reads `CHECKS_SECTION` and `checkLine` instead; the e2e fallback rule was updated.

## Alternatives considered

- **Lower `LOW_CONFIDENCE` to 0.5.** Rejected: the rule of ADR 0028 stays; a medium
  confidence from a model with no check to rely on must still escalate.
- **Map `medium` to 0.6 in the tool schema.** Rejected: it would lift every medium whatever
  the checks said; the floor is conditional on the evidence being deterministic.
- **Run the checks at tier 1 as well.** Rejected: spec H.2 makes tier 1 a light read under
  the 30 s target, and the runner already ran them; the fix is to make the critic rely on the
  results it is given.
- **Floor the confidence whatever the model's verdict.** Rejected: the rules only tighten a
  verdict; the floor adjusts the confidence input of an accept the model already gave and
  never turns an escalate or revise into accept.
- **Send the whole worktree as source files.** Rejected: unbounded; the task's own text names
  the files that matter, while the executor's brief links name task ids and branches, not
  files.
