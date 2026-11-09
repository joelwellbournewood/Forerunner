# 0111 — The merge record, one gated merge entry, merge commits only and the branch's rules

Date: 2026-11-02
Status: accepted (amends ADR 0062 and ADR 0106 point 6); amended by dependent-branches (2026-11-03): dependent branches kept true; amended by merge-in-app (2026-11-03): who merges is the project's merge mode, and Merge in the app

## Context

The owner's decision of 2026-11-02 on merging: for GitHub projects the default is "you press
Merge", with a one-click Merge in the app (dependency order, merge commits only, the safe merge
step); a per-project option "merge automatically after review"; "Take this work out" (a revert
pull request naming the later tasks that built on it); each task's agent keeps committing on
its own branch. Before either mode ships, four faults of the merge step had to go (research in
`/tmp/frbench/owner-answers.md` section 1 and the git experiments behind it):

1. **It replayed merged-in work.** When the base moved, `mergeChecked` rebased the PR branch
   onto it and force-pushed (ADR 0062 point 3). A dependent task's branch carries its
   dependencies' unmerged branches merged in (ADR 0106 point 6). The rebase copied those
   commits into the branch as new ones: the dependency's own commits never reached main, GitHub
   never marked its pull request merged, and merging it later was an add/add conflict.
2. **The reviewed version was not saved.** The reviewed commit was read from the task
   worktree's HEAD whenever the merge ran; the merge's own rebase moved that HEAD, so a retry
   after a rebase, or after a crash in the middle of one, would merge a commit nobody reviewed.
3. **A waiting merge was lost.** Checks still running after the bounded wait filed a card and
   wrote the task's reason text; nothing retried the merge, nothing survived the PC sleeping or
   the app closing, and `not_allowed` and `unverified` said nothing to the person.
4. **Squash, and no rules.** `mergePullRequest` defaulted to a squash; nothing read
   `allow_merge_commit` or the branch's rules. GitHub does not let a pull request's author
   approve it (Forerunner opens pull requests with the person's own token), and an admin token
   merges around classic branch protection unless `enforce_admins` is on, so an automatic merge
   could go around the person's own rules.

## Decision

The owner's decision of 2026-11-02 above, built as follows (the merge modes, their setting and
the Merge button are 'merge-in-app''s, which amends this ADR; the PR executor's own syncs and
the dependent rebuilds are 'dependent-branches'', which amends point 6 of ADR 0106 and this one).

1. **The merge record.** A table `merge_record` (migration 0006, SQLite and Postgres), one row
   per task: the PR, `reviewed_head_sha` (the task worktree's HEAD at the accept),
   `reviewed_base_sha`, `own_change_id` (the patch id of the task's own change,
   `ownChangeId`: its diff from `DEPS_BASE_REF`, or from the marker merged with the base when
   the base was merged in since, or from where it left the base; without context lines), the
   state (`queued`, `merging`, `waiting_checks`, `merged`, `left_to_you`), the approval
   (`none`, `mode`, `person`) and who gave it, the merge commit and method, attempts, one
   sentence for the person and the last outcome. `agent_id` names the install's agent that owns
   the record, because the store can be the shared Postgres: only that agent's daemon retries
   it (sharing records between installs or people is the collaboration module's, wave 8).
   `ReviewedPrMerge.mergeReviewed` pins it first, on every accept, before any gate, in every
   mode and at every level. From then on every merge is pinned to the record's commit. A task
   with no record (accepted before this change) or no known reviewed commit is never merged
   unattended.
2. **One gated entry.** `mergeRecorded(record, authority)` is the only way anything merges a
   task's pull request: the session's accept, the git host watcher's retry, the resume at the
   daemon's start, and the person's click in the app. It asks one gate first,
   `mayMerge(project, record, authority)`, with the project read again at every call. Its body
   here is the rule of ADR 0062: unattended only at autonomy level 3 or above; a person's click
   always (its approval is added for exactly that `merge_pr` call). 'merge-in-app' replaces
   only the body with the merge mode, so no path can merge around it. A refusal is one audit
   row (as the hooks would write) and the record `left_to_you` with its sentence; no card,
   since that is the level's normal course.
3. **Persisted and retried, with its own authority.** A merge that waits (checks running, the
   session ending, a sleep, a crash, the app closing) keeps its record in `waiting_checks`. The
   watcher's poll calls `retryWaiting` once per poll: each waiting record of the install's
   agents is tried once, without waiting (merged when its checks are green on the record's
   commit). The daemon's start settles a record left `merging` by what the host says (merged
   there, closed, or back to waiting). A retry or resume has no session: it issues its own
   narrow token (`merge_pr` only, that worktree, the PR's host only when it is the git host's,
   no secret, budget 0, ten minutes, the project's level as it is now), never derived from a
   session token, and goes through `beforeToolCall` and its audit row unchanged. Running checks
   no longer file a card: the record says "#4 merges when its checks pass." (after about a day
   of tries it goes to the person). Every merge left to the person carries one sentence on the
   record; what the person must act on (a failed check, a conflict, a moved head, a rule, merge
   commits off, a host refusal, a day of waiting) files one card, once per record, and that card
   says the record's sentence (never the step's own message, with its commit ids).
4. **No replay.** The merge step never rebases and never force-pushes. When main moved, the
   pull request is merged as it is with a merge commit: GitHub combines the two and nothing is
   copied, and a pull request that carried a dependency's commits brings them to main as they
   are, so GitHub marks that one merged too. Only when an update is needed (a rule that the
   branch be up to date, or the caller's mode needs the checks on the combined result) main is
   merged into the branch (a merge commit and a normal push) when it merges cleanly; the record
   then moves to the new head, and only if the task's own change is unchanged
   (`own_change_id`), else the branch goes back and the record is left to the person. Every
   check the reviewed head had must pass again on the new head. A PR head that moved to a
   commit keeping exactly the reviewed change (main merged in by a crashed attempt or GitHub's
   Update branch) moves the record; any other moved head is never merged unattended.
5. **Merge commits only.** Every merge Forerunner makes sends `merge_method: "merge"` pinned to
   the record's commit (`GitHubHost.mergePullRequest`'s default became "merge"). A repository
   whose `allow_merge_commit` is false, or whose rules allow no merge commit (linear history, a
   ruleset's allowed methods), is never merged by Forerunner, with one sentence.
6. **The branch's rules, never gone around.** Before any merge the branch's rules are read
   (`GitHost.getBranchRules`: the rulesets that apply, `GET /repos/{o}/{r}/rules/branches/{b}`,
   and the classic protection when the token may read it). A rule Forerunner cannot satisfy
   leaves the pull request to the person, unattended and on the person's click alike, with one
   sentence: an approving review ("This repository needs an approving review before merging,
   and GitHub does not let you approve your own pull request: merge it on GitHub once someone
   else approved it."), a code owner's review, signed commits, a merge queue, a required
   deployment, an update restriction, code scanning, resolved conversations, a locked branch; a
   protected branch whose protection an admin token cannot read. Never an admin bypass.
   Required status checks are waited for as checks. GitHub's asynchronous merge request with
   `bypass_rules: false` is not used: its documentation was not checked here; the plain
   endpoint pinned to the sha runs after this read.
7. **One callback.** `ReviewedPrMerge.onMerged(listener)` hears every merge this step makes
   (session, retry, resume) with the task, the record, the merge commit and the method;
   `merged(event)` lets 'dependent-branches' report the pull requests the watcher sees merged on
   GitHub through the same callback.

Amendment of ADR 0062: point 3's rebase and push with a lease, and the "after a rebase every
check must pass again" rule, become point 4 above (main merged in, never a rebase); point 4's
card for checks still running becomes the waiting record and its retry; the reviewed commit is
the record's, not the worktree's HEAD at merge time; the "no later session retries the merge"
consequence no longer holds. Amendment of ADR 0106 point 6: Forerunner's own merges are merge
commits; after a squash or rebase merge on GitHub's website the dependent branch needs the
rebuild that 'dependent-branches' builds (below), and the dependent PR no longer says "Merge in
any order".

## Amendment: dependent branches kept true ('dependent-branches', 2026-11-03)

The owner's decision of 2026-11-02 on merging says each task's agent keeps committing on its own
branch; this part keeps a branch that builds on unmerged work (ADR 0106 point 6) true when what
it builds on is merged, closed or redone. Before it, the PR executor still replayed: a single
dependency was brought in by a fast-forward (no merge commit), the next run deleted the marker
(`DEPS_BASE_REF`) once no dependency was open and rebased onto main, copying the dependency's
commits after a squash (a conflict) or keeping them silently after a close; nothing rebuilt a
dependent when its dependency was merged by squash or rebase, closed or redone; the watcher
stopped reading a PR once it was not open and reported nothing; a redo of a merged task pushed
to the old branch (refused when GitHub kept it); and every dependent PR said "Merge in any
order", true only for GitHub's merge commits. Built as follows:

1. **No replay in the PR executor.** The base a dependent starts from merges each dependency
   with `--no-ff`, so a branch that brought one in always shows a merge commit, and the
   worktree records each dependency held (`refs/forerunner/deps/<task>`). The marker is never
   removed while the branch holds a dependency's commits (only a rebuild onto main without open
   dependencies removes it). Every sync of a branch that holds merged-in work (the run's
   resume and post-run syncs, `continueResolved`) decides by `holdsMergedWork`: merged, never
   rebased.
2. **Rebuilds, one entry.** `PrTaskExecutor.rebuildDependents(projectId, changedTaskId)` (and
   `rebuildTask`, and a run's own check before and after the inner executor) reads what each
   held dependency became: open (kept), in main as itself (a merge commit: nothing to do, the
   dependent's PR then shows only its own commits), merged by squash or rebase, closed, redone
   or cancelled. When one went away the branch is rebuilt: the base again with the dependencies
   still open, then `git rebase --onto <new base> DEPS_BASE_REF`, which replays only the task's
   own commits; it is force-pushed with a lease (never the default branch) and its "Builds on"
   line updated. A rebuild that conflicts is aborted: the branch stays as it was.
3. **A rebuild never merges unseen.** Before the push, the dependent's merge record is settled:
   a dependency dropped whose work is not in main (closed, redone, cancelled) voids the review,
   so the record goes to `left_to_you` with one sentence ("#8 was rebuilt without #4, which was
   closed. It was reviewed with #4's changes, so it waits for you: look at it before you merge
   it, or send it back.") and one card, and nothing merges it unattended, in any mode; a rebuild
   that only dropped what main already has keeps the record, moved to the new head, when
   `ownChangeId` is unchanged (else the same as a void, with its own sentence); a conflicting
   rebuild leaves the record to the person with a sentence and a card naming the pull requests.
   A merge already waiting when this happens finds its head moved and does not follow it, since
   its record was moved meanwhile. The session's merge of an accepted task first checks its
   branch the same way, so work closed while it was reviewed never merges with it.
4. **The watcher reports what it reads**, and is the only place that reads PR states: an open PR
   on every poll (mergeable, head), a merged one once (its merge commit), a closed one once,
   before it is marked closed (`onPullRequestState`); and the default branch's head of each
   repository project once per poll (`onDefaultBranchHead`). The daemon marks a task PR merged
   on GitHub in its record (with the merge commit and the method read from the merge commit's
   parents and the PR's commits) and reports it through `ReviewedPrMerge.merged`, so `onMerged`
   hears merges by any method; a close leaves the record to the person. Every merge and close
   calls the rebuild; the default branch's head drives a sweep that drops a dependency redone or
   cancelled and retries a rebuild a busy worktree postponed. 'merge-in-app' and 'merged-copy'
   subscribe to these callbacks in compose.ts.
5. **The PR says how to merge it:** "Builds on #4 (not merged yet): this pull request includes
   its changes. Merge #4 first, or use Merge in Forerunner, which merges them in order." Never
   "Merge in any order".
6. **A redo of a task whose PR was merged or closed** starts from main on a fresh branch (the old
   name with `-r2`, `-r3`, ...), so a branch GitHub keeps after a merge never refuses the push;
   its merge record starts again for the new pull request.

Amendment of ADR 0106 point 6, completing the one above: a dependent branch is a merge of its
dependencies' branches with merge commits, its marker and held refs say what it holds, and it is
rebuilt as point 2 says; "Merge in any order" is gone.

Alternatives considered for this part: stacked pull requests (each based on the one before) and
holding a dependent until its dependency merges were rejected in the owner's research (the
merge order on the person, the stall). Keeping a voided review's record on the new head because
the task's own diff is unchanged was rejected: it was reviewed on top of code that is no longer
under it.

Known gaps: the rebuilds a busy worktree postponed are kept in memory (after a restart the run's
own check and the sweep's redo/cancel detection remain); a merge that is already under way when
a dependency closes can finish before the rebuild pushes. (Both closed by the leftovers7-merge2 amendment below.)

## Amendment: who merges, and Merge in the app ('merge-in-app', 2026-11-03)

The owner's decision of 2026-11-02 on merging, recorded here as decided: for GitHub projects the
default is "you press Merge", with a one-click Merge in the app (dependency order, merge commits
only, the safe merge step), and a per-project option "merge automatically after review". In the
owner's research the setting "is separate from level 3, which would also allow much more"
(owner-answers.md section 1): it replaces the merge half of requirement J.9 ("Level 3 Trusted:
also merges reviewed PRs and deploys to staging.") and J.10's note on it; the deploy half stays.
Before it, the merge's permission was the autonomy class `merge_pr`, free at level 3
(`autonomy.ts`), so every new project (level 2) left every pull request on GitHub with nothing
in the app to merge it, and a level-3 project merged with no per-project choice. Built as follows:

1. **The merge mode.** `settings.set merge_mode` per project (`project.settings.merge_mode`):
   `you`, the default, worded "You press Merge"; `after_review`, worded "Merge automatically after
   review", a yes first, whose card says that merges show under the person's own GitHub name, a
   comment on a merged pull request starts nothing, and on a repository whose main goes online by
   itself every accepted task goes live. Choosing the starting mode by reading the repository at
   linking was left out: the owner chose "you press Merge" as every project's default.
2. **The mode, not the level, frees a merge.** `merge_pr` is free at no level (`FREE_AT.merge_pr =
   null`); `mayMerge`'s body (point 2 above) reads the mode at every call, and the merge entry adds
   the approval of exactly that `merge_pr` call for the mode or the click, so `hooks.ts` is
   unchanged and the audit row's input says where the approval came from (`approved_by`). No
   retry, resume or record made before a switch merges in "You press Merge"; Autopilot follows the
   mode too.
3. **Checks on the combined result.** In the automatic mode, when main moved since the review with
   work the reviewed head does not hold (a move by a dependency merged with a merge commit counts
   as none), main is merged into the branch first and the repository's checks must pass on that
   head; on a repository without automatic checks nothing would test the two together, so that
   pull request waits for the person's Merge with one sentence.
4. **Merge in the app.** `POST /projects/:id/pull-requests/:number/merge` answers at once. The
   records of the chain (the open pull requests the task builds on, then itself) are approved by
   the person (`approval: person`) and queued before the answer, then merged in that order in the
   background through `mergeRecorded`, each with a merge commit, nothing rebased or forced between
   them (with merge commits each dependency's commits reach main as they are). A merge that waits
   for its checks is finished by the watcher's retry pass, after a restart too; a person-approved
   record waits there until what it builds on is merged, and when one of those goes to the person
   the rest are left to the person with one sentence. A pull request without a record merges as it
   is on GitHub now, and the answer says so. Forerunner's docs pull requests merge only on the
   click, as they are, in either mode. Where a rule needs an approval or merge commits are off, the
   row shows the sentence instead of a button; the view reads those once per look.
5. **True words.** The task row and drawer read "Merged", "Accepted · merges when its checks pass"
   or "Accepted · waiting for you to merge" from the record, and a pull request the click queued
   behind one whose checks run says "#6 merges after #5, once #5's checks pass." on its row
   ("Accepted · merges after #5" on the task row) instead of "Merging…": it is not in flight, so
   the Overview stops reading the list until the merge that frees it (review of 2026-11-08: it
   read the list every 1.5 s for as long as the checks ran, four GitHub calls a read). Once nothing
   of a Merge is in flight the Overview's line says what it came to ("Merged #2.", "#3 is not
   merged yet: the row below says why."), never the click's "Merging …"; the session result counts what merges
   by itself apart from what waits for the person, and the Overview adds "Since then: merged #2,
   #3 and #4."; the session line of a pull request left open is worded from the merge step's
   status. The Overview's pull-request block says without the raw error why it lists nothing: no
   token (GitHub is not asked), a refused token, or GitHub not answering (C-56).

Alternatives considered: keeping level 3 as what frees an unattended merge and adding only the
button (rejected by the owner's decision: level 3 also frees costly session starts, task and doc
edits and staging deploys); merging a dependent alone and letting GitHub mark its dependencies
merged (rejected for the click: the person sees the order they asked for, one merge commit per
pull request); waiting inside the request for the checks (rejected: a request would hang for up to
ten minutes).

Known gaps: the conflict notice (an open task pull request whose `mergeable` turned false after
another merge, one card per project) is not built (closed by the leftovers7-merge2 amendment); the rebuild card still offers "I merged it" and
"Leave it open" (Merge and Redo would fit); a merge the retry makes outside a session posts no
Update. (The last two are closed by the leftovers7-merge amendment below.)

## Amendment: the leftovers of wave 7, merge side ('leftovers7-merge', 2026-11-08)

1. **The retry pass reads the checks first.** A record waiting for its checks is looked at with two
   reads (the pull request, the runs and statuses on its reviewed commit) before any gated call;
   while they run the attempt is counted and nothing else happens (no token, no audit row). Before,
   each pass made the full `merge_pr` call for every waiting record every minute, up to 1440 times.
2. **A merge the app made by itself is an Update.** The retry pass and the resume at the daemon's
   start file one Inbox message ('Merged #4: "Add the page".'); a session's merge (its result says
   it) and the person's own click do not. A notification for it is not built (the daemon's
   notifier is wired in compose).
3. **The rebuild card offers what can be done.** The card a rebuild files offers Merge and Redo (a
   conflicted rebuild: Redo and Leave it open), never "I merged it" while the pull request is
   open. Merge is the Overview's Merge for that pull request (the person's approval, through the
   gated step); Redo makes the task ready again and starts a session, as every answer that makes
   a task runnable does. The review found that Redo resumed the open pull request's branch, so on
   a conflicted rebuild it rebuilt it again and stopped at the same conflict with a second card.
   Now Redo does the task again from the default branch, as its line says: the answered card
   carries `redo_from_base` (`REDO_FROM_BASE_FIELD`), which the PR executor reads as "Drop the
   branch and retry from scratch", so the next run starts the branch from the base (with any
   unmerged dependencies' work, C-49) and the open pull request gets the new work, force-pushed.
   This holds for both cards: a Redo after a clean rebuild also starts again rather than adding
   to the rebuilt commit.

## Amendment: the leftovers of wave 7, merge side, part 2 ('leftovers7-merge2', 2026-11-08)

This closes the known gaps of the two amendments above ('dependent-branches' and
'merge-in-app') and the notification left out of the one before:

1. **Owed rebuilds survive a restart.** The dependent's merge record keeps the task whose change
   its branch has not followed yet (`rebuild_owed_for`, migration 0008), marked before the
   rebuild starts and settled by its outcome (a rebuild that could not run, a busy or dirty
   folder or a failed step, stays owed). The watcher's sweep tries it again at every poll, also
   the first after a restart; a task no longer done owes nothing. Before, the owed rebuilds were
   in memory, and a squash-merge seen while the dependent was busy, then a restart, left the
   dependent's pull request with the dependency's commits for good.
2. **A rebuild never races a merge.** One lock per task folder (`worktree-lock.ts`) is taken by
   every git step there, the merge step's included (bringing the base in and pushing it, the
   reviewed commit, the files of a conflict), so the two never interleave; a rebuild that finds
   the folder busy is owed. Nothing claims a record that owes a rebuild, and the merge step asks
   again right before it moves the record to a pushed head and right before GitHub's merge: a
   record moved meanwhile, or owing a rebuild, is not merged (back to `queued` as approved). A
   record someone else moved while the call ran keeps that word, whatever GitHub answered.
   GitHub merges only the head the call names, so a rebuild pushed after the last look makes it
   refuse. What remains: a merge GitHub completes before the watcher has even read the
   dependency's close is a merge that happened first, as if the close came after it.
3. **A chain whose middle could not be rebuilt is rebuilt whole.** A dependency kept in the base
   whose branch was itself rebuilt since (`rebuiltTo`) is followed onto its new head
   (`HeldDependency.rebuilt`), and a pass hands each task it rebuilt to the tasks after it.
   Before, the third task of a chain kept the first task's pre-squash commits until the middle
   merged.
4. **The conflict notice** (point 6 of 'merge-in-app''s scope). An open task pull request that
   waits for the person and that GitHub says no longer merges cleanly is said once, from the
   watcher's own read of it (no GitHub call added), after the poll's rebuilds: the record is left
   to the person with one sentence ("#8 conflicts with main in index.html: resolve the conflict
   on GitHub, or redo the task."), the Overview offers no Merge for it, and one card offers Redo
   and Leave it open. The record's last outcome keeps it from being said again, after a restart
   too. Once GitHub says it merges cleanly again with the reviewed head (main changed back),
   Merge is offered again and an open conflict card is closed. A rebuild owed, or a rebuild's own
   conflict, comes first. The review found two gaps, closed in its fix-up: the card's Redo resumed
   the conflicting branch (now it does the task again from main, as the rebuild cards' Redo does,
   `redo_from_base`), and a resolution with a commit of the person's own offered Merge again
   although that head was not reviewed, so the Merge was refused. Now such a head is "changed
   after the review", as the merge step says it: no Merge on the Overview, and the card says so.
5. **A merge the app made by itself is a notification too** (the retry pass, the resume at the
   start): one `pr_merged` notification beside its Update, as a session's merge has its session's.

## Consequences

- A dependent pull request merged by Forerunner brings its dependencies' commits to main as
  they are, each pull request marked merged; nothing is duplicated and no branch is rewritten.
- A merge whose checks outlast the session's wait, or whose app was closed, still happens, with
  no session and on its own token; the person is not asked about running checks.
- Repositories that require approvals, code owners or other rules Forerunner cannot meet are
  never merged by it; the person merges on GitHub with one click, and the record says why.
- The merge record is the source the Overview's merge words, the in-app Merge, Take this work
  out (the record's method and merge commit) and the dependent rebuilds read.
- One more table to migrate on the shared Postgres; a client on an older schema refuses to
  sync until it is updated (spec M.6).

## Alternatives considered

- **Keep rebasing, but not branches with merged-in work** (`holdsMergedWork`): rejected for the
  merge step; a merge commit never needs a rebase, and two update paths would be two sets of
  rules. The PR executor keeps its own rule ('dependent-branches').
- **Squash by default** (one commit per task on main): rejected; a squash of a pull request
  that carries another's commits copies them, and GitHub then leaves that one open.
- **GitHub's merge queue or the asynchronous merge with `bypass_rules: false`**: not used until
  its behaviour with an admin token is checked against GitHub's documentation.
- **Retry inside the session for longer**: rejected; a session would hold the one-session rule
  for the length of someone's CI, and a sleep or a closed app would still lose the merge.

## Amendment: the leftovers of waves 12 and 14, merge side ('leftovers7-tailmerge', 2026-11-09)

1. **A redo that changes nothing leaves no empty pull request.** "No change" is now read from
   the branch, not from the run's commit: the task's own files from where its work started
   (the base, with the work it builds on). A redo from the base (the conflict notice's or a
   rebuild card's Redo, "Drop the branch and retry from scratch") whose run changes nothing ends
   as a fresh task with no change does: `failed`, with its failed-task card. The pull request
   open on the branch is closed, with one comment saying why, instead of receiving the base's
   head; its branch on the host stays as it was, so nothing the person dropped is deleted, and
   Try again opens a new pull request from a fresh branch. Closing was chosen over keeping it
   out of Merge: the pull request then holds only the work the person chose to drop, a failed
   task's pull request is not listed on the Overview anyway, and "Mark done anyway" would
   otherwise list it again with that dropped work and a Merge. Before, main's head was
   force-pushed to the branch, the empty pull request went to review, and the app offered it
   for Merge (bench, wave 14: it merged with no diff). The same reading keeps a run that
   continues a paused task's work, and adds nothing more, out of "no changes". It is read again
   once the branch is brought up to date with the base, before the push, and before the push of
   a branch the person resolved ("I resolved it"): a branch whose change the base already has
   (or whose resolution kept the base's side only) is not pushed, its pull request is closed
   the same way, and the task fails in one sentence ("#4 no longer changes anything on main, so
   it was closed."). The review of this amendment found the base's head still force-pushed to
   an open pull request after a Tasks-tab Redo of a task whose change had reached main, the
   critic accepting it and the Overview offering the empty pull request for Merge.
2. **A person's resolution in the task's folder is used, never aborted.** "I resolved it"
   given while the person's rebase or merge is still under way in the task's folder (the
   conflict card's steps) has that step finished with their resolution (resolved files staged,
   a commit the resolution emptied skipped), and the folder's branch is taken over the host's
   when the person resolved it there. A file that still holds conflict markers brings the card
   back with the step left as it was. Before, the run's start-up clean-up for a crash's
   leftovers aborted the step and the same conflict came back as a second card.
3. **A paused redo keeps its work.** The drop (or a card's Redo) stays in force until a run
   reaches review, as before, so the old conflicting branch is never brought back; but a run
   after the drop that pauses (a budget, a question) marks its work in progress as made from
   the base, and the next run continues that work instead of starting from the base again. Its
   push replaces the host's branch, so the pull request never carries the dropped commits.
4. **The retry pass merges only a done task's pull request.** A task redone (or cancelled, or
   failed) while its record waited for its checks is skipped by the watcher's retry pass; its
   record stays as it is until the task's next accept moves it to the new head. Before, the
   pass merged the old reviewed head while the task was being done again, or, when main had
   moved, waited for the task folder's lock that the redo's run held, which held the watcher's
   whole poll (no pull request events, copy refreshes or conflict notices) until the run ended.
5. **A merge that waits for the task folder's changes says why.** A rebuild never sweeps in
   changes nobody committed, so a task folder holding some keeps its rebuild owed and the merge
   waits (R-lock is unchanged). The merge step now writes that wait on the record when it meets
   it, and the Overview's row and the Tasks row say it in one sentence with the ways out (take
   the changes out of the folder, or redo the task), instead of "Merging…" with no reason; the
   folder's warning is logged once per such state instead of at every poll. The sentence offers
   only ways out the code keeps: taken out, the next check rebuilds the branch and the record
   says what came of it; a redo sets the changes aside and does the task again, and its record
   waits for the person's Merge again. It does not offer "commit them" (its first wording did,
   and the review of this amendment showed the commit dropped): the rebuild starts from the
   branch as GitHub has it, so a commit made in the folder would be on no branch afterwards.
6. **A conflict that goes away says again what was said before.** The conflict notice keeps what
   the record said before it (its outcome and sentence, and the head it was given on) on its
   card, and the words of a card it took over. When GitHub says the pull request merges cleanly
   again on that same head, the record, the row and the card say it again, with the Merge they
   offered: a rebuild's warning ("#8 was rebuilt without #4 ..."), or "builds on #X, which was
   not merged". Before, the sentence was emptied, and a rebuilt record (whose head is not the
   reviewed commit) read "changed after the review" with no Merge.

## Amendment: the merge side of live check 2 ('w15-merge', 2026-11-09)

Live check 2 ran the merge journeys with the real model on forerunner-sandbox and found, among
others, a false conflict in a chain, a person's commit that a rebuild could drop, a Merge that
answered "Merging #23." while it waited, and cards that did not start the work or never closed.
Each point keeps R-lock, R-chain, R-conflict and R-owed: nothing merges an unrebuilt head.

1. **A chain with a busy middle waits for the middle.** In a chain A <- B <- C, a task after
   one whose rebuild could not run cleanly in the same pass (its folder busy or holding the
   person's changes, its push held, a step failed, its rebuild conflicted) is not rebuilt onto
   that one's old head, which still holds the work that went away. It stays owed (`waits`) and
   follows once the middle is rebuilt. Before, C was rebuilt onto B's old head merged into main,
   which gave a false add/add conflict and a card when B changed A's file.
2. **A clean rebuild ends a stale rebuild conflict.** A rebuild with the same own change on a
   record that says its rebuild conflicted gives it the plain wait for the person's Merge again
   and withdraws its rebuild card; a rebuild tried again that conflicts in the same words files no
   second card.
3. **A person's commit in a task's folder is never dropped.** A rebuild starts the branch from
   GitHub's, so before it reset a commit the person made in the folder, which then was on no
   branch. A commit GitHub's branch lacks now holds the rebuild, unless it is Forerunner's own
   unpushed step (a base merge before its push, work in progress); one nobody can tell holds it
   (fails closed). The row says "#8 waits for a commit made in its task's folder: push it to
   GitHub or undo it." Forerunner's own rebuild whose push did not go through is put back at once,
   and one a stop of the app cut short is put back at the next try, markers included.
4. **The folder's wait is said at the poll, and the press keeps the approval.** The poll that
   finds a rebuild held by the folder writes the wait on the record, also on a record waiting for
   the person's Merge (over a plain wait only), so the row says it, with the folder and Open
   folder, before any press, and offers no Merge. A press made anyway answers that sentence,
   never "Merging #N."; its approval is kept and the merge goes on once the folder is clean and
   the rebuild ran (unless the rebuild dropped work its review read).
5. **The conflict notice and Redo.** The Tasks tab's Redo of a done task answers its open merge
   card as the card's own Redo does (closed "redone", the next run starts from main); it starts no
   session (the owner question on Tasks-row actions stays open). A notice whose record moved on
   closes once the pull request merges cleanly. A null `mergeable` is read again within the poll
   (1, 2, 4 and 8 s), so a notice comes and goes in one poll.
6. **Words.** The head-moved sentence offers "… merge it yourself or redo the task." (no button
   sent anything back); a done task's Tasks label follows its record's outcome as the Overview
   row does; a merge waiting because GitHub did not answer says so; the emptied-branch sentences
   read "The redo from main changed nothing, so #4 was closed.", "The last run changed nothing and
   #4 held no change, so it was closed." and "The main branch already has this change.", and the
   up-to-date comment "This task's work no longer changes anything on main, so this pull request is
   closed. Its branch is kept." Text Forerunner writes on GitHub names a session by its start
   time; the ids code reads are in a hidden mark.

## Amendment: the review's fix-up of the merge side ('w15-merge', 2026-11-09)

The independent review of the amendment above walked the bench and found that point 3's way out
("push it to GitHub") broke the decision this ADR started from: a commit pushed to the branch
after the review is never merged by Forerunner.

1. **A rebuild never makes work the review did not read reviewed.** A clean rebuild with the same
   own change before and after follows the merge record only when the branch, as GitHub had it
   before the rebuild, held the reviewed change: its own change is the record's, or, on a record
   without one, its head is the reviewed commit. Before, the rebuild compared the branch with
   itself, so the person's pushed commit (or anyone's on GitHub) became the reviewed head, the
   Overview offered Merge, and a Merge pressed during the folder's wait merged it. Now the record
   stays at the reviewed commit and says "#8 changed after the review: look at the new commits,
   then merge it yourself or redo the task." with no Merge; a kept approval is dropped, and one
   card says it (a new card only when the record did not already wait for the person's Merge, as
   the merge step does when it finds the head moved).
2. **The Tasks tab's Redo is undone whole.** Point 5's Redo closes the task's open merge card
   as part of the move itself: the move's change records the card, its line says so ("Reopened
   "X" to redo it from main: the next session works on it again. Its card in the Inbox was
   withdrawn."), and its Undo puts the task back to done and the same card back in the Inbox,
   without the Redo's mark. Before, the Undo left the conflict notice withdrawn for good (it is
   said once, so no later poll brought it back) and the Redo's line did not mention the card.

## Amendment: a Redo or a Try again holds for the person's commit too ('w15-tail', 2026-11-09)

Point 3 of the wave 15 amendment held only the rebuild. A task's next run reset its branch with
`checkout -B` at two places that never asked: the resume of a branch whose pull request is open
(the branch as GitHub has it; a Tasks-row Redo of a done task, a Try again) and the start from
main, which runs over the task's local branch whenever its name is kept: the redo from main while
the pull request is open (a Redo that closed a merge card, "Drop the branch and retry from
scratch"), and a Try again of a task whose earlier run opened no pull request at all (it failed,
timed out, changed nothing or its push was refused; the review of fix/w15-tail found this one on
the bench). A commit the person made in the task's folder was dropped without a word, and the run
spent model calls on work the person had not asked to drop.

1. **Hold, never reset and never bring the commit along unasked.** Before either reset, the run
   reads whether it would leave a commit of the person's on no branch (of the task's local
   branch, and of the folder's HEAD while it is on that branch or on no branch). Not at risk is
   what something else still holds: any branch on GitHub, also as the task's branch was before a
   later push replaced it there, the folder's other branches, and Forerunner's own unpushed
   states (its task commit whose push did not go through, named by `refs/forerunner/run-unpushed`
   from the commit until the push went through; its rebuild; the base its work builds on). Of the
   rest, work in progress and a merge that holds nothing of its own (a base or dependency merge)
   are Forerunner's. Anything else holds the run (fails closed).
2. **What the person sees.** The run ends before any model call: nothing reset, nothing pushed,
   no spend. The task waits on the cannot-run card ('"X" could not run. Its task folder has a
   commit that is not on GitHub: push it or undo it, then press Try again.'; for any start from
   main: '…, and doing the task again from main would drop it: undo it or keep it on another
   branch, then press Try again.'), with Try again and Cancel task; the Tasks row reads "Needs
   your decision: it could not run". The session goes on with its other tasks. Once the person
   did what the card says, Try again goes on: a resume from the branch that holds the pushed
   commit, a start from main from main again (a commit kept on another branch stays there).
3. **Not changed.** Changes nobody committed are still set aside under the failed-run ref at a
   run's start (kept, not said). A Tasks-row action still starts no session, and the hold is said
   at the run, not at the Redo itself (the owner's answer D6 of 2026-11-09 changes what Redo
   does; run C). Bringing the person's commit into the run instead of holding is an open owner
   question.

## Amendment (2026-11-09, wave 15 run B): the head-moved card says where each way out is (W15B-11)

Words only, no new button. The head-moved sentence names where each way out is: "#8 changed
after the review: look at the new commits, then merge it yourself on GitHub, or redo the task
from its row in Tasks." Its card is titled by what happened, '"X" changed after the review'
(before: 'The critic accepted "X", but pull request #8 was not merged', the old reason), and its
Details no longer say "ask for a new review", which nothing offers. The card is open only while
its task is done, whose row offers Redo, and a Redo withdraws it in the same transaction (point
5, and point 2 of the review's fix-up of the merge side above), so the sentence never stands
beside a task that offers no Redo.
