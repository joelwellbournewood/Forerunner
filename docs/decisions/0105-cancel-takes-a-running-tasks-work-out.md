# 0105 — Cancelling a task that runs takes its work out of the folder; Undo brings it back

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
6. **Only a live run or review is set aside, and only then is it said** (review of the fix,
   2026-11-02). The line says the work is removed when the cancel stopped a run or review of
   this install (the kill switch answers it), and the session sets aside exactly such a run's
   changes. A task in review that no session reviews (its review failed or a finding is open,
   and its card waits; or Forerunner closed during its review) is cancelled with its files where
   they are, and the line says only 'Cancelled "X".'; such a task with its card reads "Needs
   your decision", not "Being reviewed". Everything since the folder's baseline is no longer
   that task's alone once another run worked there.
7. **The app's own writes are not the run's.** The person's answers written into the decision
   record while a run goes on are committed on top of the folder's baseline as they are written,
   with the files in the folder untouched, so the run's change set (the critic's diff, a
   cancel's set-aside) never holds them: a cancel leaves them in the folder, and Undo brings back
   only the run's changes.

Stop now (ADR 0102, point 3) is unchanged: it keeps what was written. A Stop now, Stop all or
Quit while the critic reviews a task puts it back to Ready as for a running task (the stopped
review records nothing), and the next session runs it again; the start after a crash does the
same for a task whose review was going, unless a card waits on the person for it. Before the
review of the fix such a task stayed "Being reviewed" for good.

8. **A task a session's own budget stops twice asks the person once** (added 2026-11-02, phase E,
   C-36; the session lead's default, pending the owner's confirmation at hand-over). Phase C made
   a stop at the session's budget release the task to Ready (no card, no attempt counted), so a
   task that alone always needs more than a session's budget ran again in every session until
   the person noticed, each run bounded only by the session's budget and the monthly cap. Now the
   first such stop releases it as before; the second since its last card moves it to "Needs your
   decision" with one Inbox card, '"Long report" needs more than a session's budget' ("Two
   sessions of CHF 2.00 stopped while it ran; it spent CHF 4.40 so far."), and three buttons:
   **Raise session budget** (this project's budget per session becomes the amount named, twice
   the session's, and a session tries again), **Raise its budget** (one session of that amount
   for this task, which starts now; later sessions keep their budget) and **Cancel task**.
   Alternatives the owner may still choose: keep re-running it every session (the phase C
   behaviour), or ask at the first stop.

## Consequences

- No later task, review or summary sees the cancelled task's files, and the session's result
  does not list them.
- Reopen of a cancelled task starts it again from the folder as it is; its earlier changes stay
  set aside until a later cancel of the same task replaces them (Undo of the original cancel is
  no longer offered once the task moved on, U-061).
- Changes the person made by hand in the project's folder while the task ran are taken out with
  the run's (they are in the same change set) and come back with Undo.
- A cancel that lands in the moment between a run's end and its review's start stops nothing:
  its line says only that the task is cancelled, and its files stay, as said.

## Alternatives considered

- Keep the files and say so plainly: the walk showed the next task building on dropped work,
  which a sentence does not prevent.
- Reset to the snapshot and drop the changes: loses work the person may want back; Undo exists
  for every other move.
- `git stash`: a stash is shared by every checkout of the repository and its entries move when
  others are added; a named ref is the task's own.

## Amendment (2026-11-02, phase E, area "stops": L-6, L-7, L-8)

The live check of phase C with the real model found three places where the words of point 5
promised more than the code kept:

- **Undo's promise (L-6).** A session goes on after a cancel, and its next task often changes
  the same files within seconds (Bakery: index.html six seconds later), so Undo could not put
  the work back while the dialog and the line had said "Undo brings it back". Points 3 and 5 now
  read: the line 'Cancelled "X": its run stopped and what it changed is removed. Undo reopens
  it, and its changes come back unless the same files changed since.', the same in the Cancel
  dialog, and an Undo that could not put the changes back says "What it changed could not be put
  back: the same files changed since. Its next run does the work again." (the task is ready
  again, so the next session redoes it). The session log line no longer mentions Undo. A
  three-way merge of the set-aside changes was not chosen: a rewritten file conflicts anyway,
  and conflict markers in the person's files are worse than a redo.
- **A promise with nothing to stop (L-7).** Point 6 made the line true; the dialog and the
  chat's read-back were still worded from the stored status. A task being reviewed now says
  on its view whether its review goes on in the app (`display.live`, from the kill switch), and
  the dialog and the read-back say the work is removed only then. A running task keeps the
  words: its run stops wherever it runs, and its runner sets its work aside.
- **A cancel in the first moment of a review (L-8).** The critic's own run now gets the
  review's signal, and the review's controller is registered before the task reads "Being
  reviewed", so a cancel at any moment of the review stops it at once; the consequence above
  ("a cancel between a run's end and its review's start stops nothing") now holds only for the
  moment before that registration, which a person cannot see: the task still reads "Running"
  then.
