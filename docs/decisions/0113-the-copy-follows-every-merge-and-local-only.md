# 0113 — This computer's copy of a repository follows every merge, under one lock per copy, and a "Local only" folder never leaves this computer

Date: 2026-11-03
Status: accepted (the owner's decisions of 2026-11-02 on merging: "local_copy", "local_only_folder"
and "own_folder: No"; 'merged-actions' amends it with the preview of a pull request, which takes
the copy's lock)

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
   on GitHub), at the git host watcher's read of the default branch's head each poll (a merge by
   anyone, a docs pull request merged on GitHub's website; a copy already at that head is not
   fetched again), when a repository is linked, after the intake wrote its docs to the
   repository, and at a session's end as before. A refresh that moved the copy tells the
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
- A refresh can wait behind a docs write (a fetch and a push); the watcher's poll waits with it.
- Open question for the owner (U-037): when the person changed a Local only file while a run used
  it, (a) the person's file wins and the agent's is kept beside it (built), (b) the agent's wins
  and the person's is kept beside it, or (c) the folder is read-only for the person while a run
  uses it.
- Known limits: the brief's line is given to every repository task, also for a repository that
  already tracks a folder named Local only (rare); a repository that starts tracking such a
  folder after the copy made one keeps the person's folder until its checkout conflicts, and then
  the copy's time stops moving (the refresh logs it).

## Alternatives considered

- **Refresh only at a session's end** (before): a merge on GitHub stayed invisible for hours.
- **Fetch the copy at every watcher poll**: a fetch per project every minute; the head the
  watcher reads already says when nothing moved.
- **Keep Local only outside the repository folder and mount it into the sandbox**: a second
  mount widens the sandbox's view and the process stand-in has no mount at all; inside the
  worktree it reaches both with the rules above.
- **Rely on `.git/info/exclude` alone**: an agent's `git add -f` or own commit uploads it.
- **Link the person's own working folder** (the owner said no).
