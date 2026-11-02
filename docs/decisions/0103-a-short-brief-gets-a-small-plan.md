# 0103 — A short brief gets a small plan, and planning never loses a plan to a long text

Date: 2026-11-01
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

## Decision

1. **Small-project mode is decided from the brief at creation.** A new project without a
   repository whose brief is under 200 characters, on at most two lines and with no bulleted or
   numbered list (`isShortBrief`) starts in small-project mode (spec B.6: one milestone, a flat
   task list, new tasks at critic tier 0 unless the plan names a tier). The intake is told so
   ("Small-project mode: on (a small plan: see Size in your instructions)") and its prompt says
   what a small plan is: one milestone of one to three tasks, no reviewer, deploy, marketing or
   research task unless the brief asks, no person task unless the work cannot start, and only
   README.md and the decision record (Forerunner writes the other standard docs from its
   templates). A longer brief, a list, or a repository brought in leaves the mode off. The person
   can change it in Settings, and the New project dialog says a sentence or two gets a small plan.
2. **A long text never costs the person the plan.** Prose fields of a plan (the reason, task
   titles, milestone names, the first-session summary and rationales, doc bodies) are shortened
   at a sentence or a word with an ellipsis; only identifiers and counts (a key, the number of
   tasks or criteria) are refused. The prompt states every limit.
3. **A reply that does not validate is asked for once more**, in the same intake session and
   budget, with the problems in words, before the person sees "Planning failed"; the failure
   words name the real cause.

## Consequences

- Tasks of a small project that name no tier run at tier 0: they close when the specialist
  finishes cleanly, without a critic model (spec B.6). A one-line brief costs less to plan and
  run; the critic does not read that work unless the plan gives a task a tier. A person who wants
  reviews turns small-project mode off in Settings before approving the plan.
- Tests and bench briefs that relied on a short brief giving a multi-milestone plan use a brief
  with a list of features.
- The intake may make two model calls per draft; both are budgeted and billed.

## Alternatives considered

- A separate "small plan" hint for the intake without the mode: two notions of a small project,
  and the plan would still be shaped and reviewed as a large one. The spec's mode is the one.
- Raising the reason limit: the next field over its limit would fail the same way; shortening
  covers every prose field.
- Turning the mode on for every brief under the limit, repositories included: a short brief for
  an existing repository says nothing about the repository's size.
