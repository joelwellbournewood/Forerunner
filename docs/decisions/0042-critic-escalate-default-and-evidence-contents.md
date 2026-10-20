# 0042 — Critic: an escalate needs a named ground, and what the evidence must contain

Date: 2026-10-20
Status: accepted

## Context

The phase 3 gate ("critic catches at least 80% of seeded defects and passes at least 90% of
clean work") was run on the live model for the first time on 2026-10-20 (ADR 0040, tier 1,
Sonnet). The catch rate passed, 40 of 40; the pass rate failed, 15 of 40 clean results accepted
(37.5%; the 10-task coder subset 7 of 10). Every miss had the same shape: verdict `escalate`,
grade 80 to 88, confidence "medium" (0.5 after the vocabulary mapping of ADR 0028), no finding,
with a summary such as "correct against all five criteria by reading" or "the fixture text was
not provided, so I could not verify". Two causes, both outside the model's control:

1. The tier 1 critic discounted the runner's passing checks because it had not run them
   itself. The evidence listed them under "Check results" with no statement of who ran them or
   what a pass means, and the prompt told the critic to "re-run tests and checks when your
   tier allows commands", which the critic's one-tool token never does.
2. The researcher evidence carried the answer, the checks and the worker's report, but not the
   source documents the researcher was given, so the critic could not check a citation and
   escalated for missing material that the eval set had all along.

ADR 0028 bounded verdicts in code but had no rule about what an `escalate` must rest on, and
mapped the prompt's `medium` confidence to 0.5, under the 0.6 line, so that "medium escalates"
held in code. On the live model, "medium" is what the critic answers whenever a check it did
not run itself is involved, which at tier 1 is every review. The spec (H) says low confidence
never becomes accept; it says nothing about medium.

## Decision

1. **The evidence contains, for every task, the brief, the files the worker was given, the
   diff or the produced files in full up to the cap, the checks the runtime ran with their
   output, and the worker's report as claims.** `ReviewEvidence` gains `inputFiles` (path and
   content, rendered in full up to the per-block cap), `checksNotRun` (commands a light read
   left to tier 2), `unavailable` (material the builder could not provide, by name and reason)
   and `limits` (limit conditions the runtime recorded for the work). The check results are
   rendered under "Check results (run by the runtime: verified)" with one fixed line that says a
   pass is verified evidence, not a claim of the worker, to be trusted unless the diff
   contradicts it. Calibration (`evidenceFor`) sends `task.setup.files` as the input files for
   every task, drops the duplicated test-output block and the driver's notes, and scrubs the
   work directory (whose name carries the variant) from check output: nothing the critic reads
   names "clean" or "seeded_defect", so a caught defect is caught from the work.
2. **The evidence ends with "Evidence not available", always present.** It lists the caller's
   `unavailable` items, a diff that could not be rendered for changed files, and every block
   the size cap cut (named with "(truncated)"); when nothing is missing it says so in a fixed
   sentence. The prompt makes this section the only grounds for "I could not verify". A check
   not run at tier 1 is rendered under its own heading as the tier's design, never as missing
   evidence.
3. **An escalate needs a named ground, checked in code** (`rules.ts`, rule
   `escalate_needs_reason`, applied before the ADR 0028 rules). The grounds are: a critical or
   high finding (verified or not; a critical or high finding with evidence keeps the verdict
   the model chose, revise or escalate, as before), the review run itself ending in a limit
   (timeout, budget, step cap, killed), a `limit` the runtime recorded in the evidence, an
   `evidence_missing` reason whose detail names an item of the "Evidence not available"
   section, or low confidence (H.4). The model states its reason through a new optional
   `escalation: { reason: unverified_finding | evidence_missing | limit, detail }` field of
   `submit_review`. An escalate without a qualifying ground is downgraded to the verdict its
   findings justify: `revise` with a medium or higher finding, otherwise `accept`, after which
   the grade rule (accept needs 70) and the low-confidence rule still apply. Every such change
   is an adjustment on the review, an entry in the `critic.review` event, and an audit row
   `critic.verdict_adjusted` (review id, task, tier, the adjustments; never the evidence). An
   escalate that stands on a ground other than a finding gets no synthesised finding: nothing
   is wrong with the work, and an invented open finding would block the close after the human
   accepts (B.4).
4. **`medium` confidence maps to 0.7, above the line; `low` stays at 0.2.** The spec's "low
   confidence never becomes accept" keeps its rule (`LOW_CONFIDENCE` 0.6, numeric or the word
   `low`); the prompt defines the three words: `high` when every criterion is checked against
   the request's evidence, `medium` when the grade rests on evidence read but a minor point or
   a claim of the worker's is not independently shown, `low` when the critic cannot stand
   behind the grade because a listed-unavailable item bears on a criterion or a blocker or
   major finding could not be confirmed. The tool description asks for the word, and accepts
   a number. The task that filed this ADR asked that "confidence under the threshold alone
   does not escalate clean work"; this ADR implements it as the `medium` remap and keeps the
   H.4 rule for `low`, because the spec outranks the task text (AGENTS.md precedence). A clean
   result the critic answers `low` on still escalates, by the spec, and the prompt tells the
   critic what `low` is for.
5. **The prompt (registry `critic/critic.md` 1.1.0) says it plainly**: the sections and what
   each is, that passing checks recorded in the evidence count as verified although the critic
   did not run them, that the critic grades the work against the brief from the diff, the input
   files and the checks, that "I could not verify" is a finding only for an item the evidence
   lists as unavailable, the three confidence words, and that an escalate names its ground or
   is recorded as the verdict the findings justify. The prompt version records the new hash;
   the gate rows carry it.

## Consequences

- A prompt still cannot loosen a rule: the downgrade only removes an escalate the model could
  not ground, and every ADR 0028 rule runs after it. The catch rate is protected by the high
  finding the code adds for every failed required check (B.4) and by keeping a critical or
  high finding's verdict as the model chose it.
- The production `CriticLoop` (runtime) passes no `inputFiles`, `unavailable` or `limits` yet;
  its tier 1 reviews now render "Checks not run at this tier" for the project's check commands
  and end with the "nothing missing" sentence, so a medium-confidence clean review accepts. The
  phase 1 live run's two "escalate 88 at confidence 0.5" verdicts are this case. Wiring the
  worker's run outcome into `limits` and the worktree's starting files into `inputFiles` is a
  runtime follow-up.
- Calibration evidence is larger by the fixtures (under 1.1 KB per task in the current sets);
  the per-run cap of ADR 0040 covers it.
- The `critic.verdict_adjusted` audit row is the first audit row the critic writes for its own
  decision rather than for a tool call; the reviews UI can show it next to the verdict.

## Alternatives considered

- **Removing the low-confidence rule for clean work** (the task text's literal reading).
  Rejected: spec H says low confidence never becomes accept, and a stored review with
  confidence 0.5 and verdict accept would contradict it on its face. Remapping `medium` keeps
  the stored numbers truthful to the words the critic used.
- **Lowering `LOW_CONFIDENCE` to 0.5 and keeping `medium` at 0.5.** Equivalent for the word,
  but it changes the meaning of every numeric confidence already stored and shown; the word
  map is the one place the prompt's vocabulary meets the store's.
- **Letting the model name a `limit` ground freely.** Rejected: the model knows limits only
  from the evidence; a limit it reads in the worker's report is a finding (the prompt's "budget
  or limits silently exceeded"), and a limit the runtime knows is recorded in `limits`.
- **A separate tier 1 prompt.** Rejected: one prompt, one version, one hash; the tier-specific
  parts (which checks ran, what was not run) are rendered as evidence by the code that knows.
- **Dropping the fixtures from the coder evidence** to keep it small. Rejected: the starting
  files are what a modification is read against, the sets are small, and the e2e marker
  script was checked against fixture content (no marker line occurs in a fixture).
