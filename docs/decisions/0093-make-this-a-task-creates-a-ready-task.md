# 0093 — "Make this a task" creates a ready task

Date: 2026-10-30
Status: accepted

## Context

Spec J.1 said the "make this a task" button turns a chat message into a draft task, and the
typed phrase ("make this a task", "mach daraus eine Aufgabe") did the same. A session plans only
`ready` tasks, so a task made this way was never worked on until the person found it on the
Tasks tab and clicked Mark ready. Nothing said so. The owner found it among the ways the app
fails (U-013 to U-016) and decided: "saying make something a task should make it a task, a
ready one".

## Decision

Both paths create a `ready` task: the typed phrase (`IntentParser.matchTask`) and the button
(`seedFromMessage` prefills the New task dialog with status `ready`). "add a task: ..." does
the same (U-015). The `task.create` command keeps `draft` as its default for callers that name
no status, and the dialog still lets the person pick draft.

## Consequences

- The next session takes a task made from chat, with its read-back confirmation and undo as
  before (undo cancels it).
- A message turned into a task by mistake can now be worked on if a session starts before the
  person undoes it; the change sentence ("Created the ready task ...") and undo cover that.
- The spec's J.1 text and the requirement row are amended.

## Alternatives considered

- Keep drafts and say "draft: mark it ready to hand it over" in the reply: still a step every
  time, for no benefit the owner wanted.
- Ask "draft or ready?" each time: a question for an answer that is almost always "ready".
