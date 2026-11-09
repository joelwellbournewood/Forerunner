# 0115 — A task larger than one session runs anyway and continues cleanly

Date: 2026-11-09
Status: accepted

## Context

The owner's decision D4 of 2026-11-09, answering W6-23 ("should a task whose estimate alone is
more than the session's work budget also get an Inbox card?"): "it should get a warning, but it
should get done anyway. when the budget will run out, it should be the case that the agent will
do as much as it can, and wrap up in an organized and error free way such that the work can be
continued in the next run."

Before, such a task never ran. `cutPlanToBudget` (`session/runner.ts`) treated a task larger
than the whole work budget (the session's cap less the fifth kept for reviews) like one that
only did not fit after the others, and the queue ran only what the cut kept: alone it emptied
the session ("Nothing could run: "Long report" needs about CHF 1.20, more than this session's
work budget of CHF 0.32. Start a session with a larger budget."), and beside other work it was
"Left for next time" in every session of that size. The Start check mirrored the cut, so the
Start dialog turned Start off ("Nothing can run within this budget: ...") and told the person to
"Give the session a larger budget, or the task a smaller one."; `POST /sessions`, Approve and
start and the chat's "start a session" refused the start. The plan card said nothing. And a task
that resumed from the work its paused runs kept (ADR 0112, budget-resume) was priced at its
whole estimate again, so it stayed "larger" than a session that could finish it.

This ADR records the first part (d1109-oversize-start, run C sub-run C1): the pick, the figure
for kept work and the warning. The pause, its wrap-up, the check of the kept work and the card
are the second part (d1109-oversize-pause, C2), appended below when built; who starts the next
session follows ADR 0118.

## Decision

1. **The pick.** A ready task is larger than one session when its plan figure alone is more than
   the session's work budget. `cutPlanToBudget(plan, room, workBudget)` keeps today's greedy cut
   for every task that fits and returns, apart, the first larger task in the planner's order
   (`plan.oversized`, with its whole figure); a second one is left out with the reason
   `one_large` (one a session: two cannot both get a useful share), a fitting task left out keeps
   `after_others`. The runner holds the larger task out of the queue and the re-plans and takes
   it once the queue is empty and a re-plan adds nothing, so the tasks that fit, and those that
   become ready meanwhile, run first and are reviewed whole this session; it gets what is left of
   the work budget, when that is at least a fifth of it (`OVERSIZED_MIN_ROOM_SHARE`, the share a
   run keeps to wrap up, beside `WRAP_UP_SHARE`) and the session still takes new work, else it
   waits for the next session (`no_room`). Taken, it joins the plan row (a versioned change:
   'took "X", larger than this session's work budget, with what is left') with its planned
   figure set to that room, so the session review measures what it was allowed to spend; the log
   says 'Took "X", larger than this session's work budget, with about CHF 2.80 left.' once. At
   autonomy 0 and 1 the plan the person approves names it.
2. **Never refused.** The Start check holds the same task (`oversized`, with the room the tasks
   before it leave, those that follow as they become ready included) and is not blocked by it:
   the Start dialog keeps Start on, `POST /sessions`, Approve and start and the chat start it.
3. **No limit is passed.** Its run is capped as every run is: its own budget left, else its
   specialist's limit per run; at most what is left of the session's work budget; the hooks'
   outer caps. The review reserve is never used for work, and the room it gets is what is left of
   the work budget, never more.
4. **What is left of the estimate, for kept work only.** `estimateLeftUsdMicro(estimate, kept)`
   gives a task that resumes from its kept work its estimate less that work's cost: the
   consecutive runs ending with its latest that each paused at a budget with their work kept (the
   condition under which its next brief starts with "## Where the last run stopped"); once that
   cost reached the estimate, a fifth of the estimate, marked `estimatePassed`. A task that starts
   over (a Redo from main, a review that sent it back, a Try again after a failure) keeps its
   whole estimate: planning it at estimate less earlier spend would let the Start dialog, the plan
   card and a later join-if-fits rule admit it as fitting when it does not. A task's own budget
   still caps the figure. One function for the planner, the Start check, the plan card and the
   chat. The learner still takes no sample from a paused task (ADR 0112).
5. **The warning, said the same way everywhere.** `daemon/oversize-words.ts` writes every sentence
   about such a task from the Start check's facts: the Start dialog's amber note ('"Build the
   shop" needs about CHF 6.00, more than this session's work budget of CHF 4.00: it works until
   that budget is used, keeps its work, and asks you to continue.', after other tasks 'after the
   other tasks it works with about CHF 2.80'), its plan sentence ('..., then works on "Build the
   shop" with what is left.'), the plan card's note ('More than a session's work budget (CHF
   4.00): it pauses with its work kept and asks you to continue.'), the chat's read-back ('Start a
   session on Shop (up to CHF 5)? "Build the shop" needs more than its work budget of CHF 4.00:
   it pauses with its work kept and asks you to continue.'), why a second one waits, and the log
   line. "Keeps its work" and "asks you to continue" are what ADR 0112's pause does today (a
   commit of its own and one card with Continue).

Nothing here starts a session: the larger task runs in a session the person started (Start,
Approve and start, the chat's start, Continue on a card) or, until ADR 0118 is built, in one
that starts as today.

## Consequences

- A task larger than the work budget is done in steps: each session gives it what the work that
  fits leaves, it pauses with its work kept and one card, and the next run goes on from there,
  priced at what is left.
- The plan row's figure for the larger task is its room, not its estimate: the session review
  compares its spend with what it was allowed.
- The Start dialog's over-budget advice ("Give the session a larger budget, or the task a smaller
  one.") is gone; the result's W6-23 sentence ("Nothing could run: ... Start a session with a
  larger budget.") is gone (W6-23 is closed by D4).
- Open owner question (built default, one place to change it): the larger task runs after the
  tasks that fit, so they finish and are reviewed this session; running it first by priority
  would take the whole work budget while they wait. The order is the runner's `takeHeld` call
  after the queue and the re-plan.

## Alternatives considered

- **Refuse with a clearer sentence** (the state before): the owner's "it should get done
  anyway" rules it out.
- **Run it first, by priority:** it would take the whole work budget and the tasks that fit would
  wait for the next session; built as after (owner question above).
- **Two larger tasks a session, sharing what is left:** neither would get a useful share.
- **Price every task at its estimate less its spend:** a task that starts over would read as
  fitting when it does not.
