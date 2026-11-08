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
a dependency closes can finish before the rebuild pushes.

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
another merge, one card per project) is not built; the rebuild card still offers "I merged it" and
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
