# 0111 — The merge record, one gated merge entry, merge commits only and the branch's rules

Date: 2026-11-02
Status: accepted (amends ADR 0062 and ADR 0106 point 6)

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
consequence no longer holds. Amendment of ADR 0106 point 6: "Merge in any order" holds because
Forerunner's merges are merge commits; after a squash or rebase merge on GitHub's website the
dependent branch needs the rebuild that 'dependent-branches' builds.

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
