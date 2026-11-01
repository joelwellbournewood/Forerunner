# 0102 — Core-experience round: the design target, the person's task actions, Stop now, the calibration, and no Docker bypass

Date: 2026-11-01
Status: accepted

## Context

The owner reported that the app "does not work for a person and is not intuitive" after U-001
to U-088 were fixed one ticket at a time, and approved a plan
(`docs/status/handoff/NEXT-SESSION.md`): build a bench on the real daemon and UI, walk the core
journeys hands-on, write a design target, then fix by area. The walks (2026-11-01, stand-in
model, no API key that day) produced `docs/design/core-experience.md`. Its synthesis named four
choices for the owner. The owner asked for action, not another round of questions, so they are
decided here and can be reversed by a later ADR.

## Decision

1. **The design target.** `docs/design/core-experience.md` is the target for the fixes of this
   round. On what a person sees (screens, actions, wording, how a session behaves) it wins over
   the spec's requirement list until the owner says otherwise; the spec still governs limits,
   budgets, enforcement and security.

2. **The person's task actions.** The Tasks tab offers the per-status actions of the design
   (§3.5: Make ready, Edit, Change what it waits for, Pause, Resume, Stop, Try again, Answer,
   Redo, Reopen, Cancel). Mark failed, Send to review, Mark done and Needs me are no longer
   person buttons: they led to states nothing processes or that the person could not explain.
   The underlying transitions stay in the state graph for agents and the daemon. Closing a task
   without a review is offered only on its Inbox card, labelled "Mark done anyway", confirmed,
   and recorded with the reason "accepted without review".

3. **Stop now keeps what was written.** Stopping a running task at once returns the task to
   Ready and leaves the files it wrote in the project's folder. Nothing is rolled back: the
   workspace commits a baseline before every run (U-037), so the person can see and undo the
   change, and the next attempt starts from what is there.

4. **The monthly critic calibration** runs as the critic agent, never holds the person's agent
   or blocks Start, is skipped while no model is configured, and does not run on the day an
   install first sees its schedule (it runs on the next due date).

5. **No Docker bypass on the wait card.** The design's "Run with a light review" option on the
   Docker wait card is not built. ADR 0101 records the owner's decision that full-review (tier
   2+) tasks run only in the Docker sandbox so reviews can be comprehensive. The card offers the
   steps to set up Docker and Cancel task. A person can still choose a task's review level when
   creating or editing a task, as New task allowed before; the choice says what it means
   ("Light review: the critic reads the work, nothing runs in isolation").

## Consequences

- Fixes are judged by a fresh agent walking the journey on the bench against the design, with
  tests at the boundary the person uses (`docs/maintainers/validation.md`).
- Tests that asserted the removed buttons change with the design, and the change is named in the
  commit; no test is weakened to pass.
- A person without Docker sees full-review tasks wait with one card and plain steps, as in ADR
  0101; the rest of the plan goes on.

## Alternatives considered

- Ask the owner each choice first: the owner asked for action, and each choice is reversible.
- Build "Run with a light review": it contradicts ADR 0101, the owner's explicit decision.
- Roll back a stopped task's files: it loses work the person may want, and the workspace
  baseline already makes the change visible and reversible.
