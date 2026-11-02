# 0103 — A short brief gets a small plan, and planning never loses a plan to a long text

Date: 2026-11-01 (revised 2026-11-02: a short brief no longer turns small-project mode on)
Status: accepted

## Context

The first run on the real Claude API (bench live1, 2026-11-01) failed the most important flow:
creating a project from a brief showed "Planning failed" in five of six tries. Three plans were
refused because `plan.reason` was over 500 characters (a limit the prompt never stated), two
because the reply's docs held markdown code fences and the reader parsed a doc's snippet, and the
person read "Claude's plan was missing parts Forerunner needs" for all of them. The one plan for
a one-line brief ("A page that shows a random quote") had six tasks over three milestones,
including a reviewer, a Docker deploy and a marketing task, and nine full docs (about 5,600
output tokens): the request said "Small-project mode: off", because every project started with
the mode off. Design §3.3 asks for one to three tasks and a README for a one-line brief, the doc
set scaffolded silently.

The owner decided on 2026-11-01 (`docs/status/handoff/NEXT-SESSION.md`) that the critic always
reviews code tasks and that the person never sees a "checks only" level.

## Decision

1. **A short brief asks the planner for a small plan; the project's review level stays.** A
   draft for a project without a repository whose brief is under 200 characters, on at most two
   lines and with no bulleted or numbered list (`isShortBrief`), or for a project the person put
   in small-project mode, is asked for "Plan size: small (a short brief: see Size in your
   instructions)" (`intakePlanSize`); any other draft for "Plan size: what the brief needs". The
   prompt says what a small plan is (`SMALL_PLAN_RULES`): one milestone of one to three tasks, no
   reviewer, deploy, marketing or research task unless the brief asks, no person task unless the
   work cannot start, riskTier left out (the critic reviews every task that builds or changes
   files), and only README.md and the decision record (Forerunner writes the other standard docs
   from its templates). A first plan of more than three tasks is asked for once more with its
   size in words; the second plan stands whatever its size, and when the second reply cannot be
   used or its call fails (a stop excepted) the first plan is filed: the size never costs the
   person the plan. A plan the person asked to change ("Change the plan") is never cut down for
   its size, since their change may add tasks. The project is created outside small-project mode
   whatever its brief, so a task that names no tier gets light review (tier 1) and the critic
   reviews it after the specialist.
2. **A long text never costs the person the plan.** Prose fields of a plan (the reason, task
   titles, milestone names, the first-session summary and rationales, doc bodies) are shortened
   at a sentence or a word with an ellipsis; only identifiers and counts (a key, the number of
   tasks or criteria) are refused. The prompt states every limit.
3. **A reply that does not validate is asked for once more**, in the same intake session and
   budget, with the problems in words, before the person sees "Planning failed"; the failure
   words name the real cause.

## Consequences

- A one-line brief costs less to plan and run (one to three tasks, two short docs) and its code
  tasks are still reviewed: each finished specialist run is followed by a critic review before
  the task is done. The New project dialog says that without a repository a sentence or two gets
  a small plan.
- The size is asked of the model and checked once; a model that sends four tasks twice gets a
  plan of four tasks. The live check confirms the real model's size.
- Tests and bench briefs that relied on a short brief giving a plan of more than three tasks in
  one call use a brief with a list of features.
- The intake may make two model calls per draft; both are budgeted and billed.

## Alternatives considered

- **Turning small-project mode on for a short brief** (the first version of this change): spec
  B.6 gives a task of the mode that names no tier tier 0, so the small plan's coder task closed
  without a critic call ("Checks only", bench review of fix/intake-live). That contradicts the
  owner's decision; the mode stays a setting the person chooses.
- **Giving small-project mode tier 1:** changes what the mode means for every project that has
  it (ADR 0051) and belongs with the phase C work on verifying code tasks.
- **Refusing a plan that is too big:** a plan the person could approve would be lost to its
  size, which is what a long reason did before.
- Raising the reason limit: the next field over its limit would fail the same way; shortening
  covers every prose field.
- Asking for a small plan for every brief under the limit, repositories included: a short brief
  for an existing repository says nothing about the repository's size.
