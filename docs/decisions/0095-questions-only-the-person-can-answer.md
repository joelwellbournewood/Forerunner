# 0095 — Questions only the person can answer are Inbox questions, never a specialist's work

Date: 2026-10-31
Status: accepted

## Context

U-022: the owner's project held the 1.0.3 plan's task "Confirm stack, hosting and repository
with the human". A session gave it to `ops`. A specialist has no tool to ask the person and no
write access to the decision docs, so the run did nothing; the critic graded it 30, "human";
the retry ladder ran it four times at about USD 0.05 each; the Inbox then showed a critic
sign-off ("approval needed") that did not contain the questions, so there was nothing to
answer. Three causes: the project setup planned a task only the person can do (U-017 stopped
that for new projects only); nothing turned "needs the person's answer" into a question in the
Inbox; the ladder retried a task whose blocker is the person, not the worker.

The owner chose option 3 of the U-entry: both a planned path and an asking tool, and the
critic's verdict on a run that needs the person's answers files the questions and stops the
ladder at once.

## Decision

1. **One card.** A question for the person is a blocking `decision` request whose `steps` are
   the questions and whose one option is "Cancel the task"; `change_card.key` is
   `person_questions:<task id>` and the card carries the task, the questions, where they came
   from (`planned`, `specialist`, `critic`) and what an answer does (`done` or `ready`). The
   Inbox shows one answer field per question and sends `{ answers: [{ question, answer }] }`;
   every other place (phone, web approvals, a typed answer) sends one text, which answers all
   of them. The card's reader (`personQuestionsAnswer`) is registered with `acceptsAnswer`, so
   a blank answer is refused and the card stays open (U-034).
2. **Planned person tasks.** The explicit field is `specialist: "person"` (the intake plans a
   decision the brief does not settle that way; `human` and `owner` are aliases). Rows from
   plans made before the field are recognised by a title that asks the person ("… with the
   human", "ask the owner", "the human's decision"; "user" is not a person word, it is the
   product's user). Such a task never reaches a specialist: the daemon's approvals sync files
   its questions at once and moves it to `needs_human` (a 1.0.3 row stuck in `needs_human`
   with a critic sign-off gets its questions and the sign-off is withdrawn), and the executor
   does the same, with no Run row and no spend, for one that reaches a session anyway.
3. **`ask_person`.** Every specialist on the loop driver is offered the tool. It files the
   card with the run's id and ends the run (`endRun`); it never waits in the model loop. The
   executor reports the task `needs_human`, which the runner applies with no critic review.
   The Agent SDK path has no bridge for the runtime's tools; there the brief asks for a
   "Questions for the person:" list at the end of the report, which point 4 reads.
4. **The critic path.** A run whose report says it needs the person's answers (that list, or a
   sentence such as "this needs the human's decision") and that the critic does not accept
   (any verdict but accept, `human` included) files the questions instead of the sign-off,
   moves the task to `needs_human` and does not apply the verdict, so no rung of the ladder
   runs: one attempt, one review.
5. **Answers.** The approvals sync applies each answer once: the answers are appended to the
   project's decision doc in its workspace (`docs/decisions/0001-*.md`, the first one there,
   else `0001-project-decisions.md`), one section per request with a marker so it is never
   written twice; a planned task's open findings are resolved and it closes along the
   workflow's own edges (`needs_human -> ready -> claimed -> in_progress -> in_review -> done`,
   so no new edge is added); a task paused by a specialist or the critic goes back to `ready`,
   one session of its project is asked for, and the next run's brief carries "Answers from the
   person". "Cancel the task" cancels it.

## Consequences

- No specialist is paid to fail at a question again, and the Inbox always shows the
  questions themselves.
- The decision doc in the workspace becomes the record of the person's answers for a project
  without a repository too; a project whose docs went to its repository by pull request gets
  the answers in the workspace, not in a second pull request.
- A specialist may ask too eagerly; the brief and the tool's description say to ask only when
  the acceptance criteria cannot be met without the answers, and every question is one the
  person can cancel.
- The title fallback is a heuristic for old rows. A specialist task with a title such as "check
  with the owner" would become a question; the person cancels the card or edits the task.

## Alternatives considered

- **A `needs_human -> done` edge.** Simpler to close a planned task, but it changes the shared
  workflow graph the store, the state service and the app's buttons enforce, and would let a
  person's click close any waiting task without review.
- **A tool that waits for the answer inside the run.** It would hold a model loop, a claim and
  a budget open for hours; the run ends instead and the next run gets the answers.
- **Only the critic path.** It still spends one run and one review per question, and never
  helps a planned decision task, which needs no specialist at all.
