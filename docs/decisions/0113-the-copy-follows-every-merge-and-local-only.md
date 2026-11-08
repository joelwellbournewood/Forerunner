# 0113 — This computer's copy of a repository follows every merge, under one lock per copy, and a "Local only" folder never leaves this computer

Date: 2026-11-03
Status: accepted (the owner's decisions of 2026-11-02 on merging: "local_copy", "local_only_folder"
and "own_folder: No"); amended by 'merged-actions' (2026-11-08): the preview of a pull request,
which takes the copy's lock, Take this work out, and Autopilot asks

## Context

A repository project's files on this computer are Forerunner's clones: the copy under
`<worktrees>/docs/<project>` (the docs clone, which the Files tab, Open folder and the chat's docs
search read) and each task's worktree `<worktrees>/<task>`. Read in the code at `c5910a9`:

- The copy was brought to the default branch only as a side effect of the session's status write
  (`loop/docs.ts` `writeSessionStatus` → `refreshCopy`). A pull request merged on GitHub, or one
  merged between sessions, was missing from Files, Open folder and the chat until the next
  session ended (bench, 2026-11-03: a docs pull request merged on the fake host, two watcher
  polls later Files still listed README.md only). A project made from a brief had no copy at all
  until then: its Docs tab read README.md as "not written yet" while its plan waited (W6-25).
- The copy is also the clone the docs writes switch to their pull request branches. A refresh
  started by the watcher, by a merge or by a preview would have run git in the same clone while a
  docs write had it on another branch.
- There was no place for the person's own files: anything put in the copy is reset by a
  refresh's checkout or, in a worktree, committed and pushed with the task's work (`commitAll`
  stages with `git add -A`; `.gitignore` covered caches only). The Docker sandbox mounts only the
  task's worktree. Forerunner's own try folder (`.forerunner-try/`) was not kept out of git either
  (W6-26): a daemon that died during a review left it for the next commit.
- A folder copied into each run has its own risks: the copy back could overwrite what the person
  changed during the run, a crash leaves it half copied, an agent can plant a link (or a Windows
  junction) that a copy back would follow, `.git/info/exclude` stops `git add -A` but not
  `git add -f` or an agent's own commit, and the review's file list and the project's checks
  would read it as evidence.

## Decision

1. **The copy follows every merge.** `ProjectDocs.refreshCopy(project, { head? })` clones a
   missing copy, fetches, puts it on the default branch as the host has it and records when
   (`.git/forerunner-copy.json`). It runs after every merge the app makes or hears of
   (`ReviewedPrMerge.onMerged`: a session's, a retry's, Merge in the app, a merge the watcher saw
   on GitHub; and at the end of each Merge pressed in the app, so a docs pull request merged on
   the click, which has no task and no `onMerged`, shows at once too: wired when merge-in-app and
   merged-copy were merged together), at the git host watcher's read of the default branch's head each poll (a merge by
   anyone, a docs pull request merged on GitHub's website; a copy already at that head is not
   fetched again), when a repository is linked, while the plan from a brief is drafted (part of
   the draft's job, so the copy is there while the plan waits; added by the review of
   merged-copy, which found it came only at the watcher's first poll, up to a minute later),
   after the intake wrote its docs to the repository, and at a session's end as before. A refresh that moved the copy tells the
   project's screens, and the Files tab reads it again. Nothing is pushed.
2. **One lock per copy.** `ProjectDocs.withCopy`: the refresh, the scaffold, the status pull
   request's write, the fetch of the Docs tab's waiting docs and 'merged-actions''s preview run
   one at a time in the clone; a refresh waits for a docs write and the copy ends on the default
   branch.
3. **The Files tab says when.** `GET /projects/:id/files` carries `copy.updatedAt`; the tab reads
   "This computer's copy of <repo>. As merged on GitHub, updated 14:05." A checkout that could not
   run (a file the person changed in the copy that the merge changed too) keeps the time of the
   last real update.
4. **Local only.** One folder per repository project, `Local only`, in the project's copy, kept
   out of git through `.git/info/exclude` (whatever `.gitignore` holds), listed in the Files tab
   with one line, "Never uploaded. Agents can read and change it.", and its own Open folder. A
   repository whose default branch already tracks a path under `Local only/` gets no such folder;
   the tab says "No Local only folder here: this repository already has a folder of that name."
   A repository that **starts** tracking such a folder after the copy made one (a collaborator
   commits `Local only/notes.txt` on GitHub) never takes a file of the person's (amended by the
   review of merged-copy, 2026-11-08; bench W8 found the refresh's `checkout -B` replacing the
   person's notes.txt without a word, because git replaces ignored files by default). Before
   every checkout in the copy, each file or folder of the person's that the incoming branch would
   replace is renamed "<name> (yours)<ext>" (`keepLocalOnlyFromCheckout`), and the checkout runs
   with `--no-overwrite-ignore`, so any other ignored file in the way stops it instead (the copy
   then keeps the time of its last real update). A kept file the repository's matches byte for
   byte is dropped. The person's files left in the folder stay out of git (the copy's exclude keeps
   its line) and no run gets them; the tab says "No Local only folder here any more: this
   repository now has a folder of that name. Your files in it stay on this computer; the one
   named like the repository's is now "notes (yours).txt"." A task branch that already tracks a
   folder named Local only (before the copy's next refresh) gets no copy in either, so its pull
   request never replaces or deletes the repository's files.
5. **Each run gets it and gives it back** (`local-only.ts`, the PR executor around the inner
   run). Copied in: regular files only; a link or a junction is skipped with a log line; a path
   whose real location is outside the folder is refused. A marker in the worktree's `.git`
   records the copy in before the run (each file's hash). Copied back after the run, whatever it
   returned: only the files the run changed or added; a file the run deleted stays in the
   person's folder (nothing is lost); nothing is written through a link in the person's folder; a
   file the person changed since the copy in keeps the person's version and the agent's is kept
   beside it as `<name> (from <task title>)<ext>`, with one sentence first in the task's result
   ("You changed "notes.txt" in Local only during this run, so your version stays and the agent's
   is beside it as "notes (from Write the page).txt"."), never in the pull request or the commit.
   The worktree's copy is removed, so the review never reads it. A crash between the copy in and
   the copy back is recovered at the task's next run and at the daemon's start, by the same
   rules. It reaches the Docker sandbox because it is inside the worktree.
6. **Never uploaded, checked in code.** The worktree excludes `Local only/` and `.forerunner-try/`
   too (only the try's when the repository tracks a folder named Local only; a workspace project
   excludes the try's), and before every push of a task branch (the PR executor's, a rebuild's,
   the merge step's, 'budget-resume''s work-in-progress push) `GitOps.push` with `neverPush`
   refuses a branch whose tip or whose commits not yet on the host touch a path under those
   folders, with one sentence ("Forerunner did not upload the branch ...: it holds "Local
   only/notes.txt", files of Local only, which never leave this computer. Press Try again to redo
   the work without them."), because a forced add or an agent's own commit gets past an exclude.
   A repository's first push from a workspace leaves the try folder out.
7. **Not evidence.** The critic's file list (`projectFileList`), the untested-files note, the
   pages a change asks to be tried and the task's changed files leave Local only out; the
   critic's diff never has it (excluded, and gone from the worktree by the review).
8. **The brief says what it is.** A repository task's brief: "A folder named "Local only" in the
   project's folder, when there is one, holds the person's own files on this computer and is
   never uploaded: read or change them when the task needs it, and put their content into your
   work only when the task asks for it."
9. **No link to the person's own working folder** (the owner's "own_folder: No"): the copy stays
   under Forerunner's data folder.

## Consequences

- Files, Open folder and the chat's docs search show what is merged within one watcher poll of a
  merge on GitHub, at once after a merge in the app, and a project made from a brief has its copy
  while its plan waits.
- A person's file in Local only is never pushed, never shown to the critic as the work, and
  never lost: a clash keeps both versions.
- "Never uploaded" means never to the git host: what an agent reads from Local only goes to the
  model like the rest of the work. The user guide says so and asks the person to keep passwords
  and keys out of it (it said "keys you would never commit" until the merged-copy resume of
  2026-11-08).
- A refresh can wait behind a docs write (a fetch and a push); the watcher's poll waits with it.
- Open question for the owner (U-037): when the person changed a Local only file while a run used
  it, (a) the person's file wins and the agent's is kept beside it (built), (b) the agent's wins
  and the person's is kept beside it, or (c) the folder is read-only for the person while a run
  uses it.
- Known limits: the brief's line is given to every repository task, also for a repository that
  already tracks a folder named Local only (rare). A file the person put elsewhere in the copy
  (not in Local only) that the repository's `.gitignore` leaves out and that a merge then adds
  stops the copy's checkout rather than being replaced: the copy keeps its old time until the
  person moves the file, and the refresh logs it (the same as a tracked file the person changed
  that the merge changes too). The Files tab does not say why the time stopped moving. (Until the
  review of merged-copy this said a repository that starts tracking a folder named Local only
  "keeps the person's folder until its checkout conflicts": it did not, git replaced the
  person's ignored files without a conflict. Decision 4 now keeps them.)

## Amendment: a pull request's preview, taking merged work out, and Autopilot asks ('merged-actions', 2026-11-08)

The owner's decisions of 2026-11-02, recorded here as decided: "pr_preview: 'Open this version'
on a waiting PR: its files on the PC to try before merging", "merging: ... 'Take this work out'
(revert PR naming later tasks that built on it)" and "autopilot_repo: Autopilot asks before
creating a repository (no silent creation)". Before, a waiting pull request could be looked at
only on GitHub; Done was final, Undo could not reach a merge, and nothing reverted a merged pull
request (a pull request the person merged on GitHub by squash or rebase has a merge commit with
one parent, or several copied commits, so `git revert -m 1` on the recorded commit would fail or
undo only part of it); and at Autopilot the agent created a repository with no card, from a
session's plan and from the chat.

1. **Open this version.** `POST /projects/:id/pull-requests/:number/preview` takes a pull request
   the Overview lists as waiting (a task's or a docs one) and, under this copy's lock
   (`withCopy`, decision 2), checks its head out into a second working folder of the copy's clone
   beside it (`<worktrees>/docs/previews/<project>/pr-<n>`, `git worktree add --detach`), never
   in the copy itself, so the copy stays on the default branch and the person's Local only files
   are never in the way of a checkout. When the default branch moved past the pull request, it is
   merged in there (never pushed): the folder holds what merging would give, and the row says
   "#7 as it would be merged. Changes here are not kept."; when the two do not merge cleanly the
   folder keeps the branch's own version and the sentence says so. Nothing runs there and Local
   only is not copied in. One preview per project: the next replaces it; it is removed when its
   pull request is merged (`onMerged`), closed (the watcher's `onPullRequestState`), or no longer
   open at the Overview's next read. The row carries it (`preview`), so it survives a reload, with
   Open folder.
2. **Take this work out.** On a merged task (its record `merged`; the Tasks row and the drawer,
   "Opens a pull request that takes its changes out of main; you merge it."),
   `POST /tasks/:id/take-out` reads the merge commit (the record's, else the host's) and how the
   pull request was merged, from git, not from the record's `method` alone
   (`PrTaskExecutor.takeOut`, `takeOutPlan`, in a clone of its own beside the task's worktree):
   a merge commit (two parents) is reverted with `-m 1`; one parent whose first-parent chain ends
   with copies of the pull request's own commits, each matched by patch id, is a rebase merge and
   those copies are reverted newest first; one parent whose change is the pull request's whole
   change is a squash and is reverted without `-m`; anything else (no head to compare with, a
   fast-forward, a commit that is no such shape) is refused with "#4 was merged in a way
   Forerunner cannot undo safely; undo it on GitHub." The branch (`<task branch>-take-out`, from
   the default branch) is pushed through the `neverPush` guard, never to the default branch, and
   a pull request "Take out: <title>" is opened whose body, like the answer, names the done tasks
   that built on it ("Later tasks built on it: ... Their work may need it: check them before you
   merge this."). A revert that conflicts with later work pushes nothing and files one Inbox
   notice per task (`take_out:conflict:<task>`, "... could not be taken out by itself. Later work
   changed the same lines in price.ts: undo it on GitHub by hand, or ask in Chat for a task that
   does it."), which asks nothing of a task. The merge record keeps the take-out
   (`take_out_pr_number`, `take_out_pr_url`, `take_out_state`; migration 0007), so the row reads
   "Taken out in #9 (waiting for you to merge)", then "Taken out in #9"; the Overview lists it
   under Waiting for you to merge in its own group with merge-in-app's Merge, which merges it as
   it is on the click (it has no record of its own); a take-out closed without merging offers the
   action again.
3. **Autopilot asks** (ADR 0097's amendment): the repository offer is filed at every level and
   `repo.create` is medium for every actor, so no level creates a repository without a yes; the
   offer holds no work and is not counted as a question in the project's line (C-60).

Known gaps: the take-out's merged or closed state is read when the Overview lists the pull
requests (a merge in the app marks it at once); a take-out merged or closed on GitHub while the
Overview is not opened keeps the row's "(waiting for you to merge)" until then. A Redo of a task
whose take-out is still open starts its record again and forgets that take-out (its pull request
stays open on GitHub, no longer listed as a take-out). A dependent pull request merged with a merge
commit that carried its dependency's commits (a dependency merged by GitHub through it) is
reverted whole by `-m 1`, the dependency's work included; Forerunner's own Merge merges the
dependency first, so this needs a merge made on GitHub.

## Alternatives considered

- **Refresh only at a session's end** (before): a merge on GitHub stayed invisible for hours.
- **Fetch the copy at every watcher poll**: a fetch per project every minute; the head the
  watcher reads already says when nothing moved.
- **Keep Local only outside the repository folder and mount it into the sandbox**: a second
  mount widens the sandbox's view and the process stand-in has no mount at all; inside the
  worktree it reaches both with the rules above.
- **Rely on `.git/info/exclude` alone**: an agent's `git add -f` or own commit uploads it.
- **Link the person's own working folder** (the owner said no).
