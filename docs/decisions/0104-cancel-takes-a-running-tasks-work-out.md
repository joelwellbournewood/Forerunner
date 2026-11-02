# 0104 — Cancelling a task that runs takes its work out of the folder; Undo brings it back

Date: 2026-11-02
Status: accepted

## Context

The second live walk on the real model (2026-11-01, part 3, C1) cancelled a task from chat
("Skip the About page task", Yes) while it ran. The run was stopped (U-039), but its files
stayed in the project's folder (about.html, and a link to it in index.html), the critic
reviewed and "accepted" the cancelled task ("About page · Cancelled · accepted"), and the next
task's README described the cancelled page. The person dropped the work; the project went on
building on it.

ADR 0102 (point 3) decided that **Stop now** keeps what a task wrote: the task goes back to
Ready and its next attempt starts from what is there. Cancel is a different request: the person
says the task should not be done at all. The phase C plan (approved by the owner on 2026-11-01,
`docs/status/handoff/NEXT-SESSION.md`) asked that cancelling a running task stops it, rolls its
changes back to the task's "Workspace before" snapshot, never reviews it, and that Undo of the
cancel restores the files.

## Decision

1. **Cancel of a task that is running or being reviewed stops it at once**: its run, or the
   critic's review of it (`KillSwitch.stopTask` for `claimed`, `in_progress` and `in_review`,
   from the Tasks tab, chat and every other person's move). A stopped review records no Review
   and no finding (its Run row says what it spent). A task found cancelled before its review
   starts is never reviewed.
2. **What its run changed is taken out of the folder it ran in before the next task starts**:
   the project's workspace (a project without a repository) or the task's own worktree of the
   repository. The changes are kept in that folder's git as one commit under
   `refs/forerunner/set-aside/<task>`, so nothing is lost. A project linked to a folder of the
   person's own has no run changes to take out.
3. **Undo of the cancel brings them back** on top of the folder as it is then, uncommitted, and
   says so; when the folder changed since in the same places nothing is applied and the undo
   says that. The ref survives a restart.
4. **A pull request already opened stays open**; the cancel says so. Closing it is the person's
   call on the host.
5. **What the person reads**: the line after the action ('Cancelled "About page": its run
   stopped and what it changed is removed; Undo brings it back.'), the Cancel dialog ("Its run
   stops now and what it changed is removed; Undo brings it back."), the session log line and
   the undo's sentence ("What it changed is back in the folder.").

Stop now (ADR 0102, point 3) is unchanged: it keeps what was written.

## Consequences

- No later task, review or summary sees the cancelled task's files, and the session's result
  does not list them.
- Reopen of a cancelled task starts it again from the folder as it is; its earlier changes stay
  set aside until a later cancel of the same task replaces them (Undo of the original cancel is
  no longer offered once the task moved on, U-061).
- Changes the person made by hand in the project's folder while the task ran are taken out with
  the run's (they are in the same change set) and come back with Undo.

## Alternatives considered

- Keep the files and say so plainly: the walk showed the next task building on dropped work,
  which a sentence does not prevent.
- Reset to the snapshot and drop the changes: loses work the person may want back; Undo exists
  for every other move.
- `git stash`: a stash is shared by every checkout of the repository and its entries move when
  others are added; a named ref is the task's own.
