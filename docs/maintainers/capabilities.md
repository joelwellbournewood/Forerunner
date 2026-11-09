# Capabilities

> Status: built. Git host adapters, browser, email, desktop control and connectors are in and
> pass the phase 6 gate on the fake provider and the in-process mail server; the live halves
> (a real mailbox and host) are pending rows in `docs/status/gates.md` phase 6.

## Purpose

`packages/capabilities`: what agents can reach outside the runtime. Each capability is
granted or revoked per run through the capability token (tools, domains, secrets). This file
covers the git host adapters; browser, email, desktop control and MCP connectors are added
with their milestone.

## Git hosts (`src/githost/`)

- `GitHost` (`types.ts`) is the contract: repositories, branches, file contents, pull requests
  (create, list, merge, comment, review), issues, check runs, releases with assets, rate limit.
- `GitHubHost` (`github.ts`) implements it for api.github.com, GitHub Enterprise and the fake
  git host in `testenv` (same REST shapes). The token is a bearer header taken from the vault by
  reference; it is never logged. With `tokenSource` (the daemon passes the vault read of
  `github_token`) the token is read again before every REST and GraphQL request, so a token
  replaced in the app is used by the next call without a restart (U-049). `listPullRequests`
  sends `head` as `owner:branch` (a bare branch is qualified with the repository's owner) and
  keeps only the pull requests of that branch: GitHub ignores a bare branch and returns every
  open pull request, so a task took the project's docs pull request for its own and failed at
  its start (U-083). Git over HTTPS does the
  same: every consumer of the person's token (`PrTaskExecutor`, project docs, the reviewed-PR
  merge, the intake's docs push, repository creation) takes a `GitTokenSource` (a token or a
  function) and resolves it with `resolveGitToken()` when the step runs; the daemon passes the
  vault read. Read once at start, a replaced token kept pushing as the old token's owner while
  the API worked as the new one (U-082). A request that gets
  no answer is a retryable `provider_error` "GitHub API unreachable at <origin>: <cause>"
  (`describeNetworkError`: DNS, refused, a proxy's certificate; never the token, U-053), not
  fetch's bare "fetch failed". 403 with an exhausted rate limit waits for the reset once
  (bounded by `maxRateLimitWaitSec`); 5xx retries with backoff; 401/403/404/405/409/422 map to
  `provider_auth`, `tool_not_allowed`, `not_found` and `validation` codes. A merge that GitHub
  refuses returns `{ merged: false, message }` instead of throwing so the caller can open a
  human request. `mergePullRequest(repo, n, { sha })` pins the head the caller checked (the
  reviewed commit, the one the checks ran on): GitHub and the fake host refuse with 409 ("Head
  branch was modified") when the head moved, `MemoryGitHost` answers the same message, so the
  runtime's merge step after an accepting review (`packages/runtime/src/loop/merge.ts`, spec
  J.9, ADR 0062) never merges a commit nobody reviewed. **Merge commits only** (ADR 0111): the
  method defaults to `"merge"` (it was `"squash"`, which copied a dependent branch's dependency
  commits into one new commit, so that pull request never merged); the in-memory host honours
  the method (`MemoryGitHost.merges` lists each merge with its method) and the fake git host
  makes a merge commit with two parents, a squash or a rebase as GitHub does.
  `getRepo` reads `allow_merge_commit` (`RepoInfo.allowMergeCommit`; the fake host and the
  in-memory host refuse a merge commit where it is off, "Merge commits are not allowed on this
  repository."); a merged pull request carries `mergeCommitSha` (an open one's test merge is
  never taken for it). `updatePullRequest(repo, n, { title?, body?, state? })` edits a pull
  request (a dependent's "Builds on" line, a close) and `getBranchHead(repo, branch)` reads the
  commit a branch points at, or null (the git host watcher's default-branch head; ADR 0111). `getBranchRules(repo, branch)` reads what a merge into the branch must
  meet: the rulesets' rules (`GET /rules/branches/{branch}`, read access; a server without the
  endpoint answers 404, read as none: approvals, code owners, `required_status_checks` with
  `strict`, `required_linear_history` and `allowed_merge_methods` as `allowedMethods`, and
  `blockers` in words for signed commits, a merge queue, required deployments, the `update`
  restriction, code scanning, resolved conversations) and classic protection (the branch's
  `protected` and visible required checks for anyone, the full `/protection` for an admin, the
  only one GitHub lets go around it; a protected branch whose protection an admin token cannot
  read is `unreadable`). The merge step reads it before every merge and never goes around it.
  `listCommitStatuses(repo, ref)` reads
  the combined status (`GET /commits/<ref>/status`, the latest status per context: the status
  API Jenkins and many external CIs report through) beside `listCheckRuns`, so the merge step
  refuses a red status as it refuses a red check run; `MemoryGitHost.setCommitStatuses` sets
  them for tests. `listRepos({ org })`, `listRepos({ user })` (a user's public repositories)
  and `listRepos()` (every repository the token is affiliated with) follow the `Link:
  rel="next"` header page by page up to `MAX_LIST_PAGES` (100), `pageSize` items per page
  (1 to 100, default 100; `nextPageUrl` parses the header), so a source scan (spec A.4,
  `packages/runtime/src/sources`) sees an organisation whole; `github.test.ts` serves two
  pages from its stub. A `next` URL, like every absolute URL the host answers, must be on
  `baseUrl`'s origin (`originOf`): otherwise `request` refuses it with `provider_error`
  before anything is sent, so the token goes to the API host of the install and nowhere the
  host points (the rule the A.3 import applies to git's `http.<origin>/.extraheader`). The
  release upload is the one explicit opt-in (`otherOrigin`): GitHub hands out
  `uploads.github.com` as `upload_url`, and the asset cannot go anywhere else.
  `github.test.ts` runs a second listener on its own origin: a `Link` to it stops the listing
  and it sees no request, while an `upload_url` on it receives the asset with the bearer.
- PR feedback (spec E.1, ADR 0075): `listPullRequestComments(repo, n, { since })` walks every
  page of the conversation comments (GitHub lists the oldest first, so a single page of 100
  would never show a new comment on a long PR) and passes `since` (comments updated at or
  after the instant); `listPullRequestReviews(repo, n)` lists the submitted reviews as
  `ReviewInfo` (`id`, `author`, `state`: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`,
  `DISMISSED`, `PENDING`, `body`, `submittedAt`, `htmlUrl`). The runtime's
  `GitHostWatcher` reads both, plus `listCheckRuns` on the PR head, to fire the `ci` and
  `pr_comment` session triggers (`runtime.md` § Triggers). The fake git host honours `since`
  on `GET /repos/:o/:r/issues/:n/comments`; `MemoryGitHost` filters by `createdAt` and
  records reviews `reviewPullRequest` submits. `listPullRequestReviewComments(repo, n,
  { since })` lists the review line comments (`ReviewCommentInfo`: the comment plus
  `reviewId`, `path`, `line`, `inReplyTo`) from `GET /pulls/:n/comments`, every page, oldest
  first; `MemoryGitHost.addReviewComment` is its test seam. The agent's mark:
  `commentOnPullRequest` and `reviewPullRequest` append `AGENT_TEXT_MARKER`
  (`<!-- forerunner:agent -->`, hidden on GitHub; `markAgentText`, once) in both adapters, and
  `isAgentText` tells the poller the agent's own text from the human's when the token is the
  human's PAT and both write under one login. `githost-feedback.test.ts` proves paging,
  `since`, the reviews and review-comments mapping and the mark against the fake host and the
  memory host; `github.test.ts` the mark on the stub.
- `GitOps` (`git.ts`) runs local git with argv arrays: clone, fetch, branch, commit, rebase onto
  the base before a PR (conflicts are reported by file and the rebase aborted, leaving the tree
  clean), push with `--force-with-lease` only when asked and never on the default branch,
  `isAncestor(base, of)` (has the base moved past the branch; any git failure throws rather
  than reading as "moved"), changed files, log, `remoteDefaultBranch()` (from
  `refs/remotes/origin/HEAD`; `validation` for an empty repository) and
  `localBranches(prefix)` and `remoteUrl(remote)` (null when there is no such remote). HTTPS
  auth passes an `http.extraheader` entry through the process environment (`gitConfigEnv()`:
  `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, git 2.31+, appended after any
  entries the caller's environment already carries), so the token is never on the command
  line where a process listing shows it and never touches disk (ADR 0069); with
  `GitAuth.origin` the key is `http.<origin>/.extraheader` (`tokenHeaderKey()`; a non-http(s)
  origin is `validation`), which git applies to URLs under that origin only, so a remote on
  another host or an `insteadOf` rewrite gets no token. The header is
  `AUTHORIZATION: basic base64("x-access-token:<token>")` (`tokenAuthHeader()`), never
  `bearer`: GitHub's git endpoint answers a bearer header with 401 "invalid credentials" even
  for a fine-grained PAT its REST API accepts (seen live on Windows, 2026-10-26: the setup
  check passed, every clone failed). Only network commands (clone, fetch, push) carry the
  header; local commands never see the token. Git's urlmatch lets the most specific matching
  `http.<url>.extraheader` win, so a header scoped to the origin would lose to a human's entry
  for the repository path: ours therefore sits on the repository URL itself (`tokenScope()`:
  credentials, query and fragment dropped, trailing slash added), and empty entries first reset
  every level that could carry an older header (the unscoped `http.extraheader`, the origin,
  the repository path with and without its slash). A remote outside `GitAuth.origin` gets no
  header at all. Every caller scopes the auth to its clone URL's origin (`gitAuthFor()` in intake,
  merge, the PR executor and project docs; the data import sets the origin itself). The reset drops every
  `http.extraheader` in the human's own git config for our git calls, auth or not (a proxy or
  SSO header included): a deliberate choice for an agent's clone. Every command runs with
  `-c credential.helper=`, which
  empties the helper list from all config levels: Git Credential Manager (Git for Windows'
  system default) or any other helper is never asked for, never given and never told to
  erase a credential, so git uses exactly our token and the human's store is untouched. A
  consequence: a tokenless clone of a private repository no longer borrows the human's saved
  credentials; it fails with `provider_auth` "no token configured for <origin>".
  `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=""`, `SSH_ASKPASS=""` and `GCM_INTERACTIVE=never`
  keep it from prompting. Every command runs with `-c core.autocrlf=false -c core.safecrlf=false`
  (files byte for byte as committed, on both platforms), and every folder our git makes says the
  line endings in its own config (R-copystuck, ADR 0113 amendment of 2026-11-09): `clone` passes
  `--config core.autocrlf=false`, `init` and `pinLineEndings()` write `core.autocrlf=false` into
  `.git/config` (`pinLineEndings` reads it first with `--type=bool` and writes nothing when it
  already says so; true when it wrote). So any other git used in the folder (the person's own in
  this computer's copy or their project's folder, an agent's in its worktree) reads and writes
  files as ours does: the folder's config beats Git for Windows' system `core.autocrlf=true`,
  which wrote a file the person put back with CRLF that ours then read as changed. Only
  `core.autocrlf` is written: it is the one setting of ours that changes the bytes read or
  written; `core.safecrlf` only warns or refuses on the person's own `git add`. Error output is redacted (`redactToken()` removes the token raw and
  in its Basic form). git missing
  from PATH is `unavailable`, a spawn failure `provider_error`, a command the runner killed at
  `timeoutMs` (default 5 minutes) `timeout` naming the limit. `GitOpsOptions.runner` swaps the
  process runner (tests record argv and env). Every command gets `EMAIL=forerunner@localhost`
  unless `EMAIL` is set: git's own fallback, used only when no `user.email` is configured, so a
  commit never fails with "unable to auto-detect email address" on a machine whose person never
  set up git (Windows CI found it in the U-037 workspace commits), and a configured address is
  never overridden (`git.test.ts`). Git has no such fallback for the name: an account without
  one (a container user; Linux CI) fails every commit with "empty ident name not allowed". So a
  command that writes a commit (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`,
  `stash`) first reads `git config --get user.name`, and only when no level sets it (and no
  `identity` was given) runs with `-c user.name=Forerunner`; a person's own name is never
  overridden. The data module's GitHub repository import
  (`data.md`) uses it to clone a project's repository onto its migration branch.
- `ensureBaseBranch` (`base-branch.ts`, ADR 0106) makes sure `origin/<base>` exists before a
  branch is made from it: an empty repository (no branch at all on the remote, as one just
  created on GitHub) gets one first commit on its default branch, written by the caller's
  `first(dir)` into a scratch repository and pushed (the doc set from `ProjectDocs` or the
  intake, a README with the project's name and goal from `PrTaskExecutor`), then the clone is
  fetched. A remote with branches but not `base` is `not_found` in words ("<repo> has no branch
  "<base>" to start from (it has main). Set its default branch on GitHub, then press Try
  again."); a first push that fails says, in words from `firstPushFailedWords` (`push-words.ts`)
  and never git's output, that the repository is empty and what to do: refused, `provider_auth`
  (not a transient code, so the runner does not try again at once): "<repo> is empty and GitHub
  refused Forerunner's first commit (the token may not write to it). Add a README on GitHub or
  check the token in Settings, then press Try again."; not reached, `provider_error`; anything
  else, `provider_error` with the host's one line ('git said "..."'). When someone else's first
  commit arrived meanwhile, theirs is used. Before, every task on an empty repository failed with
  git's "'origin/main' is not a commit", and then (review, 2026-11-02) a refused first push put
  git's multi-line output into the task's reason and its card.
- `push-words.ts`: `pushFailure(e)` sorts a failed push into unreachable, refused or other (with
  the one line that says why: the host's `remote:` line, else the reason after "[remote
  rejected]", else git's first line that is not its framing, redacted; the host's progress lines,
  "remote: Resolving deltas ...", are never the reason); `pushFailedWords` (a task's branch) and
  `firstPushFailedWords` (an empty repository's first commit) word them. The runner cuts a
  task's reason at 200 characters, so these stay under it for a usual name. Their git runs
  with `GitOpsOptions.untranslated` (the PR executor's `gitFor`, `ensureBaseBranch`'s scratch;
  TM-6, leftovers7-tailmerge: `UNTRANSLATED_ENV`, `LC_ALL=C` and an empty `LANGUAGE`), so
  git's words are read in English whatever the person's language; other GitOps keep the
  process's language. `GitOps` reports a
  failed command as `git push <branch> failed: <git's stderr>`, so git's first line shares a line
  with that header: `pushFailure` takes the header off before reading the lines. With git's
  default configuration the host's `remote:` line is git's first line; before (CI on 193e579), it
  was missed there and the person read git's generic "pre-receive hook declined" instead of the
  host's sentence. It was found only where `push.negotiate=true` makes git print two lines first
  ("fatal: expected 'acknowledgments'...", "warning: push negotiation failed..."), as in the
  development container's global config; `push-words.test.ts` feeds both shapes, and Windows'
  CRLF, through `GitOps.push` with a stub runner, so it does not depend on the machine's git.
  Over HTTPS a refused push (a token that may not write, an archived repository) ends with git's
  "fatal: unable to access '<url>': The requested URL returned error: 403" after the host's line:
  `HOST_REFUSED` (a 401 or 403, or a `remote:` line saying denied or permission) is read before
  "unable to access" counts as unreachable, and a refusal carries the host's line (`said`), which
  the words quote with what to do (R-2, polish-words: before, the person read "GitHub could not
  be reached"). A progress line is only a progress shape ("Writing objects", "Resolving deltas",
  "Total 3"): a host's reason that starts with such a word ("Writing to this repository is
  disabled") is the reason shown (R-3). `pushFailedWords` names no branch (C-59; the review of
  polish-words): the task's branch carries its id part ("fr/1a2b3c4d-write-the-guide"), and the
  sentence is the task's reason, read on its row, drawer and card, which name the task. A
  refusal leads with the host's line ('GitHub refused the push: "Permission to o/r.git denied to
  some-bot". Check the GitHub token in Settings and o/r on GitHub, then press Try again.'), so
  the Tasks row's "Failed: …", cut at 100 characters, reaches it; before, the head with the
  branch and the repository took the row.
  `GitOps.remoteBranches()` lists the remote's branches as last fetched; `changedFiles(base,
  head)` takes a head other than HEAD; `filesBetween(from, to)` compares two trees;
  `hasMergesSince(base, head)`, `setRef(ref, rev | null)`, `mergeFrom(ref, message?, {
  noFastForward })` (`--no-ff`: always a merge commit), `rebaseOntoFrom(onto, upstream, branch?)`
  (`git rebase --onto`: replays only the commits after `upstream`; aborted and the files named on
  a conflict), `refsUnder(prefix)` and `commitCount(from, to)` serve the dependent branches
  below. For the merge step and its record (ADR 0111): `resolveRef`,
  `mergeBase`, `mergeTree` (`git merge-tree --write-tree`, git 2.38 or later, null on a
  conflict), `conflictFiles` (the files such a merge conflicts in), `patchId(from, to)` (the
  patch id of a diff without context lines, "empty" for none) and `parentsOf`.
  `branch-rules.ts` holds what a task branch holds: `holdsMergedWork(git, base)` (the
  `DEPS_BASE_REF` marker, or a merge commit since `base`: such a branch is kept up to date by
  merging, never rebased) and `ownChangeId(git, base, head?)` (the patch id of the task's own
  change: from the marker, or from the marker merged with the base when the base was merged in
  since, or from where the branch left the base; the same change made another way keeps it, a
  commit on top changes it; null when it cannot be told). The merge step pins it at the accept;
  the PR executor uses both (dependent branches, below).
- `PrTaskExecutor.prepareReview(task)` (W15-27, the runner's review-only pass): a repository
  task's worktree put back on its branch (a local branch only; nothing fetched, committed or
  pushed), a project's folder as it is; null without a worktree or a branch, or when git refuses
  the checkout (the specialist then runs again). Test: `pr-executor.test.ts` 'w15-review, wave 15'.
- `PrTaskExecutor` (`pr-executor.ts`) forwards `chooseSpecialist` to its inner executor (the
  specialist the next attempt runs with, which the runner names on `task.started`; ADR 0108) and
  wraps any task executor in the branch-and-PR flow: clone
  or fetch into a per-task worktree (`ensureBaseBranch` for an empty repository), branch from
  the base (or the existing PR branch), run the
  inner executor inside the worktree, commit, rebase onto the base, push and open a pull
  request whose body carries the outcome, the acceptance criteria (no heading when there are
  none) and the report without its "Lesson:" lines (`withoutLessons`; the commit message is the
  report as plain text, `plainReport`, L-19); a second run on the same task updates the PR.
  A run that changed no file fails with "The run changed no file. It reported: …" in plain words
  (`emptyChangeSummary`, L-18, polish-words; before, the raw report and "(no changes were made in
  the worktree)").
  **One branch per task** (R-branch, leftovers7-merge): the branch is
  `taskBranchName(task)`, `fr/<the id's last 8 hex characters>-<title>`, stored on the task at
  its first run. Before, it took the id's first 8 characters, which are a UUIDv7's creation
  time and the same for 65 s: two tasks titled alike created within a minute got one branch,
  and the second found the first's open pull request by branch name, resumed it and pushed its
  work onto it. A pull request found on the task's branch whose body names another task
  (`openedForAnotherTask`: "Task <id>, session ..." from `openOrUpdatePr`) is never resumed:
  a task that stored such a name before the fix moves to its own (`unusedBranch`, the name or
  `-r<n>`). Tests: `pr-executor.test.ts` "leftovers of wave 7, merge side"; the real daemon
  (`real-daemon.test.ts`, same describe) lists two pull requests for two such tasks.
  **A task that waits for unmerged work builds on it** (C-49, ADR 0106; kept true by ADR
  0111, 'dependent-branches'): `unmergedDependencies` walks `depends_on` (deepest first) for
  done tasks of the project whose branch still has an open pull request on the host;
  `dependencyBase` merges their branches, in order, into the base on a detached HEAD, each with
  a merge commit (`--no-ff`, never a fast-forward, so a branch that brought a dependency in
  always shows it), and keeps the commit under `DEPS_BASE_REF` (`refs/forerunner/deps-base`) in
  the task's worktree, with one ref per dependency held (`depsHeldRef`,
  `refs/forerunner/deps/<task id>`, the commit of its branch merged in); the task's branch
  starts there, so its specialist sees the work. Its PR still targets the default branch and
  says `buildsOnText` ('Builds on #4 (not merged yet): this pull request includes its changes.
  Merge #4 first, or use Merge in Forerunner, which merges them in order.'; never "Merge in any
  order", which held only for GitHub's merge commits); `withBuildsOn` keeps that paragraph of
  the body true when what it builds on changes (`GitHost.updatePullRequest`). Its
  `changedFiles` are `GitOps.filesBetween(DEPS_BASE_REF)` (its own work only), and the critic's
  `GitDiffPort` diffs from that ref too (`runtime.md`). The marker is never removed while the
  branch holds a dependency's commits (only a rebuild onto main without open dependencies
  removes it; a marker the checked-out branch does not hold is stale and dropped). A branch
  that holds merged-in work (`holdsMergedWork`: the marker, or a merge commit since the base,
  such as GitHub's Update branch) is kept up to date by a merge, never rebased (`mergeMoved`
  after the run and in `continueResolved`, only when the base or a dependency moved; a later
  run reuses the base while nothing under it moved, `baseStillHolds`). **Rebuilds** (ADR 0111):
  `rebuildBranch` reads what each held dependency became (`heldState`: `open`; `in_main`, its
  commit is in the base, a merge commit, nothing to do; `copied`, merged by squash or rebase;
  `closed`; `redone`, its task is not done or its open PR no longer carries the commit held;
  `cancelled`) and, when one went away, rebuilds the branch: the base again with the
  dependencies still open, then `git rebase --onto <new base> DEPS_BASE_REF`, which replays only
  the task's own commits; the marker then names the new base, or is removed. A run does it
  before the inner executor (a resume) and again before its push; a rebuild that conflicts is
  aborted and files the rebase-conflict request with the dropped pull requests named
  (`droppedWords`). `rebuildDependents(projectId, changedDependencyTaskId, hooks)` does it for
  every done task of the project that waits for that one (directly or through others) and whose
  worktree holds it (`rebuildTask` for one task), a task before those that build on it: a
  rebuild that kept the task's own change records `refs/forerunner/rebuilt/<old head>` (the new
  head) in its worktree, and a dependent holding the old head follows it (`rebuiltTo`: kept,
  `open`) instead of reading it as redone (a 3-task chain on the bench, 2026-11-03, voided the
  third task before this). Such a kept dependency is marked `rebuilt` (`HeldDependency.rebuilt`)
  and the dependent is rebuilt onto its new head too (R-chain, leftovers7-merge2: when the
  middle of a chain could not be rebuilt at first, the third had been rebuilt onto the middle's
  old head, which still held the first task's pre-squash commits, and nothing rebuilt it again);
  `rebuildDependents` passes each task it rebuilt in the pass on to the tasks after it
  (`rebuildTask(task, hooks, onlyIfHolding)` takes one id or several). Each: the branch as the
  host has it, rebuilt,
  `hooks.beforePush(rebuild, pr)` (the runtime settles the merge record there), then a push
  with a lease (never the default branch) and the "Builds on" line updated. A worktree a run or
  another rebuild uses is skipped (`busy`; the run rebuilds it itself), as is one with
  uncommitted changes. **One lock per task folder** (`githost/worktree-lock.ts`, exported:
  `inWorktree` waits, `tryWorktree` skips a busy folder, `worktreeBusy`; keyed by the resolved
  path, in this process): every git step in a task's worktree takes it, the PR executor's run,
  a resolved conflict, a rebuild, setting work aside, and since leftovers7-merge2 (R-lock) the
  runtime's merge step too (`loop/merge.ts`: bringing the base in and pushing it, reading the
  reviewed commit, the files of a conflict), so a rebuild and a merge never interleave in one
  folder. `conflictsWithBase(task)` (R-conflict) reads, in the task's worktree under the lock,
  the files its branch on the host conflicts in with the base (null when busy or gone).
  `mergeMethodOf(task, mergeSha, head)` reads how a PR was merged on the
  host (two parents: `merge`; one: `rebase` when the PR had several commits and the last one is
  repeated, else `squash`). A redo of a task whose PR was merged or closed (none open) pushes to
  a fresh branch (`freshBranch`: the old name with `-r2`, `-r3`, ... that no host branch or PR
  used), so a branch GitHub keeps after a merge never makes the push fail. Dependencies whose work conflicts with the base or with each other end the run as
  `needs_human` before the inner executor runs, with `dependencyConflictWords` ("The work it
  builds on conflicts: "B" (pull request #2) and "A" (pull request #1) both change index.html.
  Merge them on GitHub, resolving the conflict, then press Try again."), which the runner's
  "could not run" card carries; nothing is dropped silently (a merge git refuses with no
  conflicting file, such as local changes in the way, fails the run with git's words). A task
  with nothing unmerged
  before it starts with no `DEPS_BASE_REF` and works as before. A rebase conflict pushes the branch as it is (so the person can fetch
  and resolve it; the steps name the worktree when the push fails) and becomes a blocking
  `decision` request (`change_card.key` `REBASE_CONFLICT_KEY`, the branch, base, files and
  whether it was pushed) with the task outcome `needs_human`. Its first sentence, the card's
  title, names the task ('"Write the guide" conflicts with main in README.md'), never the branch
  (W14-5, polish-words: it read "Rebase of fr/e34de89b-… onto main conflicts in …"); the steps
  name the branch, where the person fetches it. Its options each lead somewhere
  (U-028): the runtime's `syncPrAnswers` applies the answer (`runtime.md`), and the task's next
  run reads it from the card (`outcome`, then `consumed_at` once a run used it). "I resolved
  it" first finishes a rebase or merge the person left under way in the task's folder
  (`GitOps.finishUnfinished`: a resolved file is staged, a commit the resolution emptied is
  skipped, a file still holding conflict markers files the card again with the step left under
  way; git's messages are never parsed), then takes the person's branch: the folder's when a
  step was just finished there, or when it holds the base and the host's does not (committed
  here, not pushed), else the host's, else the folder's (`GitOps.hasRef`). The run reads the
  answer before its start's clean-up, which skips `cleanAfterCutShortRun` while "I resolved it"
  waits (TM-2, leftovers7-tailmerge: before, the clean-up aborted the person's half-done
  rebase, the resolution was lost and the same conflict came back as a second card). It then
  checks the base is in it (rebasing when not; a conflict that is still there files a new
  request), pushes (with a lease when the person's rebase rewrote it)
  and opens the PR without running the inner executor again (`costUsdMicro: 0`); "Drop the
  branch and retry from scratch" starts the branch again from the base, runs the inner
  executor and replaces the old branch on the host (force with lease); "Cancel the task" is the
  runtime's alone. A request filed before the key (the same options) is read the same way. A
  later card of the task that the runtime marked `REDO_FROM_BASE_FIELD` (`redo_from_base`: a
  rebuild card's Redo, R-rebuildcard's fix-up) is read as "dropped" (`conflictAnswer`), so its
  next run starts again from the base and the open pull request gets the new work; before, that
  redo resumed the open branch, rebuilt it again and hit the same conflict. No
  changes means `failed`: the branch holds no file of the task's own from where its work
  started (`holdsOwnChange`: from `DEPS_BASE_REF`, else the base; Local only and the try folder
  never count; a git error falls back to "this run committed, or a pull request is open"), not
  "this run committed nothing" (TM-1, leftovers7-tailmerge, ADR 0111 amended 2026-11-09).
  Before, a redo from the base (Drop, a card's Redo) that changed nothing on a task with an
  open pull request force-pushed the base's head to it, and the empty pull request went to
  review and was offered for Merge; a run that continued a paused task's work and added
  nothing more failed "no changes" although its branch held that work. A pull request open on
  the branch is now closed instead (`closeEmptied`: one comment saying why, then the close;
  the branch on the host stays as it was) and the result's summary is one sentence
  (`emptiedSentence`: "Redone from main, it changed nothing, so #4 was closed."); a close the
  host refuses leaves the pull request and the old summary. The same reading runs again after
  the branch is brought up to date with the base (the rebase or the merge before the push) and
  in `continueResolved` before its push (TM-1's sibling, the review fix-up): a branch whose
  change the base already has (the rebase drops a commit the base holds, a merge of the base
  leaves nothing, or the person's resolution kept the base's side only) is not pushed; its open
  pull request is closed (`endUpToDate`, `closeEmptied` with `up_to_date`: "Brought up to date
  with main, this task's work no longer changes anything, so this pull request is closed. Its
  branch is kept.") and the task fails in one sentence ("#4 no longer changes anything on
  main, so it was closed.", or "main already has this change." with no pull request). Before,
  a Tasks-tab Redo or a rework of a task whose change had reached main force-pushed main's head
  to its pull request, which the critic accepted and the Overview offered for Merge, and a fresh
  task's push opened an empty pull request. A task without a repository runs in the folder `workspaceFor` names
  (U-037, ADR 0097: the runtime passes the project's workspace for a project with no repository
  link), kept as a local git repository: `inWorkspace` writes a `.gitignore` for caches when the
  folder has none (`ensureWorkspaceGitignore`, `WORKSPACE_GITIGNORE`: `__pycache__/`, `*.pyc`,
  `node_modules/`, `.venv/`, ...; live, 2026-11-02, a Python run's bytecode was staged into the
  project), says our line endings in the folder's git config (`pinLineEndings`, for a folder
  made before `init` did; a failure is logged and the run goes on; R-copystuck), commits what is
  there as the baseline
  ("Workspace before ..."; an empty first commit for a fresh folder), runs the inner executor
  with that folder as its worktree, stages the run's change (`GitOps.stageAll`) and returns the
  folder as `worktree` with the staged files as `changedFiles`, so the critic's `git diff HEAD`
  there is that run's change; without `workspaceFor` the inner executor runs directly, as before.
  The workspace's commits use the executor's `identity`, else `WORKSPACE_IDENTITY`
  (Forerunner, forerunner@localhost). A task the person cancels while it runs or is reviewed
  (phase C, ADR 0105): `setAside(task)` takes what its run changed out of the folder it ran in
  (the workspace, else the task's own worktree of the repository; nothing for a project linked
  to the person's own folder) with `GitOps.setAside(ref, message)`: every change since HEAD,
  new and deleted files included, becomes one commit under `setAsideRef(task.id)`
  (`refs/forerunner/set-aside/<task>`, HEAD does not move) and the folder goes back to HEAD;
  with nothing to set aside an older commit under the ref is dropped. `bringBack(task)` (Undo
  of the cancel) applies that commit's diff on top of the folder as it is now
  (`GitOps.bringBack`: `git diff --binary --no-color --no-ext-diff`, so a person's
  `color.ui=always` or external diff tool cannot spoil the patch, then `git apply`, all or
  nothing; before, such a config made every bring-back a `conflict`): `restored` with the files, `conflict` when
  the folder changed in the same places since (the ref stays), `missing` when nothing is set
  aside. Ignored files stay where they are. `GitOps.commitFile(path, content, message)` commits
  one file's content on top of HEAD through a temporary index (`GIT_INDEX_FILE`), the files in
  the worktree untouched, and moves HEAD only if nothing moved it meanwhile; `fileAt(rev, path)`
  reads a file as a commit holds it. The runtime uses them for the person's answers in a
  workspace's decision record, so a run going on there never holds them in its change set (a
  cancel's `setAside` took them out before, phase C review). A variable a caller passes in
  `env` adds to the ones `GitOps` sets. **A paused task keeps its work** (budget-resume, [ADR
  0112](../decisions/0112-a-budget-stop-is-a-clean-pause.md) amended 2026-11-08): in
  `executeIn`, a result in `WIP_OUTCOMES` (`paused`, `needs_human`, `usage_limit`, `killed`)
  is saved by `saveWorkInProgress`: one commit on the task's own branch,
  `workInProgressMessage` ("Work in progress: <title> (paused at its budget)", then "Where I
  stopped" and "Left to do" from `result.handoff`, then the task), `wipRef(task)`
  (`refs/forerunner/wip/<task>`) set to it, the task's own files returned as `changedFiles`
  (`ownFiles`: from `DEPS_BASE_REF` or the base), and pushed (force, never the default branch,
  through the `neverPush` guard; `isNeverPushed(e)` is said in its own words) only when the
  `pushUnfinishedFor(task)` dep says the project's "Push unfinished work to GitHub" is on. The
  next run checks out that branch when `workInProgress` finds the marker in it (never `checkout
  -B` from the host), merges in what a person pushed to the host's copy and the base when it
  moved (`Bring in main`; never a rebase, ADR 0111), and a conflict goes to `conflict` (the
  rebase-conflict card); "Drop the branch and retry from scratch" and the fresh path drop the
  marker, and a run that went to review removes it. A run after the drop that pauses before
  review marks its work in progress as made from the base (`wipFromBaseRef`, beside `wipRef`):
  the next run continues it while the drop is still unused (`workInProgressFromBase`), never
  brings the host's branch (the dropped work) into it, and its pushes replace the host's branch
  (TM-3, leftovers7-tailmerge; before, every run after such a pause started from the base again
  and lost the work since the redo); a pushed work in progress with no pull
  request is replaced by a force-with-lease push. A `failed` or `timeout` result's leftovers go
  to `failedRef(task)` (`setLeftoversAside`, W6-24), so the next attempt starts clean. A run
  the app's close or a crash cut short does neither (both happen only after the inner executor
  returns): the next run first ends a git step left half done (`GitOps.abortUnfinished`: a
  rebase, merge, revert or cherry-pick) and sets uncommitted leftovers aside under the same ref
  (`cleanAfterCutShortRun`, R-dirtyworktree, leftovers7-merge), before any checkout; while the
  task's "I resolved it" waits, a step under way is the person's and is finished instead (TM-2,
  above). Before, it
  carried them into its own work, git refused its `checkout -B` ("untracked working tree files
  would be overwritten"), or a half-done rebase made the next conflict card name no file. In a
  project's folder (`inWorkspace`) a pause is one commit of its own with the same message and
  marker; the task's next run keeps that commit's files out of its snapshot
  (`GitOps.commitAllExcept`, while `builtOnBy` finds no later task's "Workspace before" or work
  in progress after it: `ownWorkInProgress`), so its change set is the whole work; another
  task's snapshot is made even when nothing changed while a work in progress is in the folder,
  so a cancel knows it built on it. `setAsideWork(task, { running })` (the runner's `setAside`
  for a stopped run, and the cancel of a paused task through the commands' `setAsideWork` port
  and the budget card's Cancel): in a repository the worktree's uncommitted changes as before,
  then the work in progress kept under `setAsideWipRef(task)`, the branch reset to where its work
  started, and a pushed branch with no open pull request deleted on the host
  (`GitOps.deleteRemoteBranch`); in the project's folder only while nothing built on it
  (`GitOps.applyCommitted(rev, message, { reverse: true })`, its own commit "Set aside: ..."),
  else `{ files: [], kept: '"Y" built on it' }`. `bringBack(task)` restores the work in
  progress first (repository: `resetHard` to it and the marker again, pushed again when the
  setting is on; folder: `applyCommitted` as "Work in progress: <title> (brought back)"), then
  what a stopped run changed. `applyCommitted` writes its patch to the system's temp folder,
  never under `<cwd>/.git`, which is a file in a linked worktree (the review of budget-resume;
  `git.test.ts` "applyCommitted works in a git worktree"). Tests: `pr-executor.test.ts` "a
  paused task keeps its work and continues from it". `GitOps` gained `commitAll(message, { allowEmpty })`, `hasCommits`, `stageAll`, `stagedFiles`
  and `setRemote` for it and for the repository creation; `createRepo` takes `autoInit` (default
  true, the host's README commit; false: an empty repository for a first push).
- **A pull request's preview and taking merged work out** (merged-actions, the owner's decisions
  of 2026-11-02 "pr_preview" and "merging"). `GitOps.fetchRef(ref)` fetches one ref of the
  remote (GitHub's `refs/pull/<n>/head` for a pull request whose branch is gone; false when the
  remote has none); `worktreeAdd(dir, rev)` makes a second working folder of the clone at a commit
  with no branch (`git worktree add --detach`), `worktreeRemove(dir)` removes it whatever was
  changed in it and prunes a folder that is gone (the runtime's `ProjectDocs.previewPullRequest`
  puts a waiting pull request's version beside the project's copy with them); `revert(commits,
  { mainline })` takes commits back on the current branch (`git revert --no-edit`, `-m 1` for a
  merge commit's change against its first parent), aborting on a conflict with the files named;
  `commitsNotIn(from, to)` lists a branch's own commits that `from` lacks, oldest first, without
  merge commits. A merge commit whose merged side carries a commit of a task this one waits for
  (`carriesDependencyWork`: the dependency's branch on the host or its record's reviewed commit,
  in the merged parent and not in the first) is `unknown_shape` (R-takeoutdep, leftovers7-merge:
  `-m 1` took the dependency's work out of main too). `PrTaskExecutor.takeOut({ task, number,
  mergeSha, headSha, branch })` (a new method; the runtime's `TaskTakeOut` calls it) works in a
  clone of its own
  (`<worktreeRoot>/<task>-take-out`, under the same per-folder lock as a worktree, never the
  task's worktree), fetches (and `refs/pull/<n>/head` when the head is on no branch), checks the
  merge commit is in the default branch, asks `takeOutPlan(git, mergeSha, headSha)` how to take it
  back (two parents: `revert -m 1`; one parent and the pull request's own commits copied onto the
  default branch ending at the merge commit, each matched by patch id: a rebase, the copies
  reverted newest first; one parent whose change is the pull request's whole change: a squash,
  reverted without `-m`; anything else null), makes `branch` from the default branch, reverts and
  pushes it (forced with a lease, never the default branch, through `neverPush`). It returns
  `TakeOutGitResult`: `pushed` (branch, base, repo, `how`, `sure`, the commits), `conflict` (the
  files; nothing pushed), `unknown_shape`, `not_in_main` or `no_repository`. A pull request of one
  commit squash-merged or rebase-merged leaves the same shape in git: its one commit is taken back
  either way and `sure` is false, so the runtime's words say "merged", not which (review of
  merged-actions: a rebase read "squash-merged"). The clone is removed once the push or the
  conflict is done (a failure to remove it is logged; the next take-out fetches into it). Test:
  `test/take-out.test.ts` on the fake GitHub's own merge, squash and rebase, of two commits and of
  one, and the clone gone after each.
- **Local only** (`local-only.ts`, merged-copy, [ADR 0113](../decisions/0113-the-copy-follows-every-merge-and-local-only.md),
  the owner's decision of 2026-11-02): a repository project's folder that never leaves this
  computer and that agents can use. `LOCAL_ONLY_DIR` ("Local only"), `TRY_DIR`
  (".forerunner-try", a review's try folder, W6-26) and `NEVER_PUSHED` (both).
  `excludeNeverPushed(dir, folders)` appends `/<folder>/` to the clone's `.git/info/exclude`
  (idempotent; `.gitignore` untouched); with `{ dropOthers: true }` (the PR executor's task
  worktrees only: this computer's copy keeps the person's own files there out of git) it also
  removes Forerunner's line for a `NEVER_PUSHED` folder not in `folders` (R-exclude,
  leftovers7-merge: a reused worktree kept `/Local only/`
  after the repository started tracking a folder of that name, so the agent's new files there
  were silently left out of the commit). The PR executor's `excludedFolders(git, target)` is
  `[TRY_DIR]` when the base tracks Local only, else both, for the exclude and for the files a
  run reports as changed. `GitOpsOptions.neverPush`: before every `push`,
  `neverPushedIn(branch, defaultBranch)` lists the paths under those folders the push would
  upload (tracked at the tip, or touched by any commit no remote branch has: `git log <branch>
  --not --remotes=origin`), a folder the remote's default branch already tracks being the
  repository's own; any is a `path_not_allowed` refusal with `neverPushedWords` ("Forerunner did
  not upload the branch ...: it holds "Local only/notes.txt", files of Local only, which never
  leave this computer. Press Try again to redo the work without them."), `isNeverPushed` tells it.
  The branch is named without its task-id part (`branchWords`: "fr/1a2b3c4d-write-the-guide" reads
  "write-the-guide", C-59, polish-words); the stored name keeps it, so same-titled tasks keep two
  branches.
  `trackedUnder(rev, folders)` reads the files a commit tracks under them (`-z`, raw names).
  `PrTaskExecutorDeps.localOnlyFor(task)` names the project's folder (in its copy, runtime.md);
  `execute` wraps the inner run (`withLocalOnly`): a copy an earlier run left is copied back
  first, then `copyLocalOnlyIn` (regular files only, a link or a junction skipped with a log
  line, a path resolving outside the folder refused; the marker `.git/forerunner-local-only.json`
  written before, `copying` then `in`, with each file's hash), the run, and `copyLocalOnlyBack`
  in a `finally`: only files the run changed or added are written back (through a temporary file
  and a rename), a file the run deleted stays, nothing is written through a link in the
  person's folder, and a file the person changed since the copy in keeps their version while the
  agent's is kept beside it (`besideName`: "notes (from Write the page).txt"); the worktree's
  copy and the marker are removed. `keptBesideSentence` is put first in the task's result
  summary (never the PR body or the commit). `recoverLocalOnly()` (compose, at the start) and
  the next run recover a copy a crash left by the same rules (`recoverLocalOnlyCopies`). The
  worktree excludes both folders (only the try's when the repository tracks a folder named Local
  only), `inWorkspace` excludes the try's, the executor's GitOps sets `neverPush`, and the
  changed files leave them out. A task branch whose HEAD tracks anything under `Local only/` (the
  repository started tracking such a folder before the copy's next refresh said so) gets no copy
  in, with a log line: the copy in would have replaced the repository's files and the pull
  request deleted them (review of merged-copy). `besideName` and `yoursName` count up until a
  name is free (no clock). The repository taking the folder over (review of merged-copy, bench
  W8; runtime.md `switchCopy`): `keepLocalOnlyFromCheckout(git, dir, ref)` renames, before a
  checkout of `ref`, each file or folder of the person's under `Local only/` that a file `ref`
  tracks would replace (the file at the path, a file where a folder goes, a folder where a file
  goes; a path HEAD tracks is the repository's and left to git; links moved as links) to
  `yoursName` ("notes (yours).txt", "data (yours)"), returning `KeptYours[]`; `dropKeptSame`
  drops a kept file the checked-out one matches byte for byte; `localOnlyTakenLine(kept)` is the
  Files tab's sentence. `GitOps.createBranch(name, from, { keepIgnored })` adds
  `--no-overwrite-ignore`, so an ignored file still in the way stops the checkout instead of
  being replaced (git's default replaces it without a word). Tests: `test/pr-executor.test.ts`
  "Local only" (read and written in the run, copied back, never pushed or in the PR or the
  changed files; the person's change kept with the agent's beside it and the sentence; an agent's
  own commit refused at the push; a link out of the folder, a junction on Windows, never
  followed; a run killed after the copy in recovered; a task branch that tracks a folder named
  Local only gets none and its PR keeps the repository's) and `test/git.test.ts` "a push never
  carries Local only" and "a checkout never replaces the person's ignored file".
- `MemoryGitHost` (`memory.ts`) is an in-memory implementation of the contract for unit tests
  of callers.
- Project operations on the same contract (`ensureProject`, `ensureFields`, `listProjectItems`,
  `findItem`, `upsertItem`, `setItemFields`, `archiveItem`) back the one-way task mirror below.
  `GitHubHost` serves them over the GraphQL endpoint (`github-graphql.ts` holds the documents;
  Projects V2 has no REST API); `MemoryGitHost` keeps them in maps and records every call in
  `projectCalls` so tests can count outward actions.

## GitHub Projects mirror (`src/githost/projects-mirror.ts`)

### Purpose

Spec, build order phase 2: "One-way mirror of tasks to GitHub Projects"; "Source of truth
rules": tasks live in the shared state service, GitHub is a mirror so the work is visible there.
`ProjectsMirror.sync(projectId)` reads the tasks of one Forerunner project from the store and
makes a GitHub Projects V2 board show them: one draft-issue item per task with title, status,
specialist, cost in CHF and links to the PR and the review; done and cancelled tasks (and
deleted ones) are archived. Nothing flows the other way: the host's state only decides whether
an item already exists, the store decides what it says. Edits made on GitHub survive only until
the task next changes (or `full: true` re-asserts the whole board); they never reach the store.

### Operations

| Step | Host call | When |
| --- | --- | --- |
| Board | `ensureProject(owner, title)` | once; the id is stored in `settings.github_mirror.project_id` |
| Fields | `ensureFields(projectId, MIRROR_FIELDS)` | once per process per board, and again when `MIRROR_FIELDS_VERSION` moved |
| Item | `upsertItem(projectId, taskToItem(task, ledger, review))` | every task whose `version` differs from the cursor |
| Archive | `archiveItem(projectId, itemId)` | after the upsert of a done or cancelled task; for a task id in the persisted cursor whose row no longer exists (`findItem` first), on incremental and `full` runs alike |

`upsertItem` is idempotent by the `forerunner_task_id` text field: the GitHub adapter lists
the board once per process (100 items per page) and keeps an index task id -> item; a new item
is `addProjectV2DraftIssue` + one `MirrorSetFields` mutation that writes every field with
aliases (one request per item, not one per field); an existing item gets
`updateProjectV2DraftIssue` only when title or body changed, a field mutation only for values
that differ, and `unarchiveProjectV2Item` when it was archived. Items a human added (issues,
pull requests) carry no task id and are never written to.

Order of a run: settings check -> host -> board -> fields -> read tasks -> diff against the
cursor -> batches of `batchSize` (default 25) upserts, cursor saved after each batch ->
archive deleted -> save cursor and `last_sync_at` -> event -> result. The mirror runs on a
session of its own (trigger `manual` or `schedule`, agent = `opts.agentId` or the first active
principal) so the run event has a home; pass `sessionId` to write into a running session instead.
That row is created with its plan (`[{ kind: "mirror", project_id }]`), so it names its reason,
`GitHub projects mirror run (<trigger>)`, and the agent as author, as the store's B.5 insert
guard requires (data-model.md, Invariants).
A run that can get no session (no `sessionId`, no `agentId`, no active principal agent) is not
silent: the same counts go to the audit log as one `github.projects.sync` row
(`MIRROR_AUDIT_TOOL`, `runSummary` builds the line the session summary also uses) and the
result carries `sessionId: null, eventId: null`.

Enforcement in code, not prompts: `sync` throws `tool_not_allowed` unless
`project.settings.github_mirror.enabled === true` (the human's opt-in, set by `fr mirror enable`
or the UI); with a `MirrorHumanPort` wired, creating a board is asked once
(`approval_required` on a denial; `approved: true` is remembered). The port answers `approve`,
`deny` (the person's no) or `unanswered` (the wait timed out, the request was withdrawn or
expired). A no is kept (U-031): `sync` writes `settings.github_mirror.enabled = false` (the
owner, title and secret reference kept), the same setting `fr mirror disable` and the project
settings panel write, calls `deps.onDisabled(projectId)` (the daemon drops the project's
15-minute schedule) and throws `approval_required` with `details.mirrorDisabled: true` and a
message that says how to turn it on again; turning it on again asks again, since `approved`
was never set. Before, a no saved nothing and every scheduled run filed the same card again.
An `unanswered` question switches nothing off: the next run asks again
(`projects-mirror.test.ts`: the no through the production port and two more scheduled runs,
one card in all; the re-enable; the unanswered case). Unknown fields or options are
refused by the host before any request (`validation`). Every outward action appends an audit
row (`github.projects.ensure_project`, `ensure_fields`, `upsert_item`, `archive_item`; a denied
creation is logged with `allowed: false`).

Rate limits: the GitHub adapter waits for `Retry-After` (secondary limits, 403/429), for
`X-RateLimit-Reset` when `X-RateLimit-Remaining` is 0, and for `RATE_LIMITED` errors inside a
200 body, on the injected Clock, bounded by `maxRateLimitWaitSec` (default 120 s); past that it
throws a retryable `provider_rate_limit`. The mirror catches that, stops the run, keeps the
cursor of the finished batches, records `stopped: { reason: "rate_limit", retryAfterMs }` in the
result and the event, and the next run continues where it stopped without creating twins.

### Field mapping (`taskToItem`)

| Board field | Type | Value |
| --- | --- | --- |
| title | draft issue | `task.title` |
| body | draft issue | outcome, acceptance criteria, status, specialist, cost, risk tier, milestone, PR and review links, and the sentence that edits here are not synced back; cut at `MIRROR_BODY_MAX_CHARS` (60 000, under GitHub's 65 536 cap) with `MIRROR_BODY_TRUNCATED_MARKER` at the end (`capBody`) |
| `Status` | single-select (GitHub's built-in field, options added) | `MIRROR_STATUS_LABELS[task.status]`: Draft, Ready, Claimed, In Progress, In Review, Needs Human, Done, Failed, Cancelled (title case so GitHub's own "In Progress" and "Done" options are reused) |
| `specialist` | text | `task.specialist`, cleared when null |
| `cost` | text | `CHF x.xx` from the cost ledger sum for the task (`chf_micro`); `USD x.xx` from `actual_cost_usd_micro` when the ledger has no entry (ADR 0008: CHF is the display currency) |
| `forerunner_task_id` | text | `task.id`; the idempotency key, written once on creation |
| `pr` | text | `task.pr_url` |
| `review` | text | `<verdict> <grade>/100 <link>` of the latest review (`deps.reviewLink`, default `forerunner://reviews/<id>`) |
| `milestone` | text | name of the task's milestone (`store.milestone`, loaded once per run), cleared when the task has none (added in field set version 2) |

Archived: `task.status` in `CLOSED_TASK_STATUSES` (`done`, `cancelled`) or the task row is gone.
Milestones are mirrored as a field on each task, not as items of their own: a board groups by
`milestone` the way it groups by `Status`.

### Cursor and settings

`project.settings.github_mirror` (type `MirrorSettings`, read by `mirrorSettingsOf`):
`enabled` (the only switch), `owner` (default: owner of the first repo locator,
`ownerFromLocator`), `title` (default: project name), `secret_ref` (default
`secret:github_token`), `project_id` / `project_url` / `project_number` once the board exists,
`approved`, `fields_version`, `cursor` (task id -> task `version` last mirrored) and
`last_sync_at`. The cursor is exact (a per-row version, not a timestamp), so clock skew between
two installs writing the same Postgres cannot hide a change, and a run after no changes makes
zero host calls. Settings are written with optimistic concurrency and retried on
`version_conflict`; the cursor is persisted after every batch, so a crash mid-run redoes at most
one batch (upserts are idempotent anyway). The cursor follows the task row only: a change that
lives elsewhere (a milestone renamed, a new ledger entry, a new review) reaches the board when
the task next changes or on `fr mirror sync --full`. `fields_version` records which field set
(`MIRROR_FIELDS_VERSION`) a board was last ensured with; a board set up by an older build gets
the new fields on its next run.

A `full` run resets only the working cursor (so every present task is re-asserted); the ids of
tasks deleted since the last run are always computed from the cursor as persisted, and they
stay in the working cursor until their items are archived. A full run therefore archives a
task deleted since the previous incremental run instead of forgetting it, and a full run that
stops early (rate limit, crash) still hands the deleted ids to the next run.

Rate-limit arithmetic (`retryAfterMs`, or `resetAt` minus now) runs on the injected `Clock`,
never on the wall clock, so the stop reason in the event is right under a simulated clock too.

### Scopes

The token comes from the vault by reference (`githubHostForSecretRef`: the value goes into the
bearer header only; `resolveSecretRefs` audits the name, never the value). It needs, for a
fine-grained PAT, "Projects: Read and write" on the user or organisation that holds the board
(plus repository "Metadata: Read"); for a classic PAT, the `project` scope (`read:project` is
not enough). A GitHub App installation needs the organisation permission "Projects: write".
Insufficient scopes surface as `tool_not_allowed` (`INSUFFICIENT_SCOPES` / `FORBIDDEN`).

### Wiring

- Scheduler: `scheduleMirror(scheduler, { projectId, everyMinutes })` registers an `every`
  schedule under the pseudo agent `mirror:<projectId>` (one run at a time per project, quiet
  hours respected). The orchestrator wraps its session starter:
  `start: mirrorStartHandler(mirror, startSession)`; mirror requests run `sync`, everything else
  goes on to `startSession`. A manual `scheduler.request({ agentId: mirrorAgentId(id), projectId: id, trigger: "manual" })` runs it now.
- CLI: `registerMirrorCli(program, { open })` adds `fr mirror sync --project <name-or-id> [--all] [--full]`,
  `fr mirror enable --project ... [--owner] [--title] [--secret]` and `fr mirror disable`.
  `program` is typed structurally (`MirrorCliCommand`) so this package does not depend on
  commander; a commander `Command` satisfies it.
- Human port: `MirrorHumanPort { ask(request) }`; `HumanRequestMirrorPort` files a non-blocking
  `approval` human request with the two options and polls the store on the Clock until it is
  answered (timeout withdraws it and counts as deny).

### How to change it

- New field: add it to `MIRROR_FIELDS`, fill it in `taskToItem`, bump `MIRROR_FIELDS_VERSION`
  so existing boards get it on their next run, extend both hosts' tests.
- New status: `TASK_STATUSES` drives the Status options; add its label to
  `MIRROR_STATUS_LABELS` (the type forces it).
- Another git host: implement the project operations in its adapter; the mirror only uses the
  contract. The fake git host in `testenv` speaks classic REST projects only (retired by GitHub),
  so adapter tests use `test/helpers/fake-projects-graphql.ts`, a node:http GraphQL stand-in
  that records every request body.
- Never add a read-back: anything that copies board state into the store breaks the
  one-way test and the "Source of truth rules".

### Decisions (recorded here; no ADR number was reserved for this module)

- Projects V2 over GraphQL, not classic projects: classic projects were retired in 2024 and
  the only supported API is GraphQL. The fake git host's classic routes are therefore not used.
- Draft issues, not repository issues, as items: a draft issue belongs to the board and needs
  no repository permission; the one-way rule is easier to keep (no issue webhooks, no
  comments to reconcile). Linking real issues can come later as an opt-in.
- Cursor as a per-task version map in project settings rather than an `updated_at`
  watermark: exact under clock skew and concurrent writers; the cost is one small JSON entry per
  task.
- The spec's "edits there sync back only for status and comments" is deferred: phase 2 asks
  for the one-way mirror; a sync-back would be a separate, explicitly approved capability with
  its own tests. Until then the board is informational.

### Tests

`packages/capabilities/test/github-projects.test.ts` (adapter over the GraphQL stand-in:
endpoint derivation, ensureProject lookup-then-create and bearer header, ensureFields creating
fields and extending Status options with colours, idempotent upsert with batched aliased field
writes and a fresh-process lookup, archive/unarchive and item paging, Retry-After and
RATE_LIMITED waits on `SimulatedClock` with the give-up bound, error code mapping and
unknown-field refusal, `buildSetFieldsMutation`, memory host parity) and
`packages/capabilities/test/projects-mirror.test.ts` (first run creates board, fields, items with
status, specialist, CHF cost, PR and review, plus event and audit rows; cursor skips unchanged
tasks and re-mirrors only changes; archive on done, cancelled and deleted, unarchive on reopen;
one-way guarantee with a tampered board and a `full` re-assert; rate-limit stop with
per-batch cursor and continuation without twins; not-enabled refusal and owner derivation;
approval port deny/approve asked once; `HumanRequestMirrorPort` answer and timeout; scheduler
hook; CLI registration and commands; host from a vault reference; `taskToItem` for every
status; body cap with the cut marker; milestone name on the item, a milestone rename reaching
the board only through a task change or a full run, and a board with an older `fields_version`
getting its fields ensured again once; `resetAt` retry delay computed on the simulated clock;
a full run archiving a task deleted since the last run and dropping its id from the cursor; a
full run stopped by a rate limit keeping the deleted ids until the next run archives them; a
run without a principal agent writing its counts to the audit log instead of an event;
end-to-end run over GraphQL). Run: `pnpm vitest run --project unit packages/capabilities/test/github-projects.test.ts packages/capabilities/test/projects-mirror.test.ts`
(28 tests).

### Known issues

- The GitHub adapter's item index is per process; two processes mirroring the same board at
  the same time could each create an item for a task created between their listings. Run the
  mirror from one place (the scheduler) per project.
- A milestone rename, a new ledger entry or a new review does not bump the task's version, so
  the cursor hides it until the task changes or a `--full` run; the board is informational, so
  this is accepted rather than widening the cursor to those rows.
- Milestones are a text field, not a single-select: option ids would have to be kept in sync
  with milestone rows (creates, renames, deletes); a text field needs no reconciliation.
- The fake git host in `testenv` speaks classic (REST) projects only; the GraphQL stand-in
  lives in this package's test helpers and is not shared with other packages.
- A done or cancelled task that changes version while its item is already archived costs two
  extra mutations (`upsertItem` unarchives, `mirrorTask` re-archives). Kept on purpose: an
  archived item is read-only on GitHub until it is restored, and the API does not document
  field writes on one, so the unarchive is what lets the update land; two cheap mutations are
  preferred to an undocumented edge of the API.
- The "Decisions" subsection above belongs in `docs/decisions/` as an ADR; no number was
  reserved for this module yet, so it stays here until the orchestrator lifts it.

### Requirements

No row in `docs/requirements.md` names the mirror (it sits under "Source of truth rules" in
the Architecture section, outside the A-V scheme). It contributes to: B.1 (milestones and
tasks of a project, shown on the board), B.3 (every workflow status and side exit has exactly
one board option), B.7 (task log with cost, verdict and links to PR and review, reproduced on
the board), S.1 (enabled flag, approval and field checks enforced in code), S.4 (token by
reference, value only in the header), S.5 (scopes documented and insufficient scopes
surfaced), S.6 (creating the board can be routed through a human), S.9 (audit row per outward
action), U.9 (run event with counts on a session).

## Web research (`src/web/`, ADR 0107)

The researcher's and the science-evaluator's page reader on both credentials (the owner's
decisions of 2026-11-01 and 2026-11-02, 'sites'): `webFetchTool(opts)` is the `web_fetch` tool the
runtime maps `cc:WebFetch` to on the loop driver and, through the Agent SDK's tool server, on a
subscription (`packages/runtime/src/registry/tools.ts`, `WEB_FETCH_TOOL`; the name is spelled out
here because the runtime imports this package). The composition root registers it as a built-in
unless `FORERUNNER_WEB_FETCH=off`.

- **Rules (`policy.ts`, `WebReadPolicy`, ADR 0107 'sites' amendment).** `checkUrl`:
  `http:`/`https:` only, at most `WEB_MAX_URL_CHARS` (2,000), no user name or password; a name
  without a dot or a local name (`localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`,
  ... `isLocalName`) refused whatever any list says; then the project's rule
  (`WebReadRules {mode, only, never}`): a host covered by a never entry refused, and in `only`
  mode a host no only entry covers refused, each refusal naming the list; `only` with nothing on
  its list stays `only` and reads no website (R-failopen), never any public one. `siteCovers` is the
  reader's own matcher: an entry covers the site and its subdomains, case, `*.`, a leading `www.`
  and a trailing dot normalised (`hostOfUrl` strips one trailing dot too, C-70); the capability
  token's `domainCovered` is not used here and is unchanged. `addressAllowed`: only a public
  address (`isPublicAddress`: a `net.BlockList` of this computer, private, shared, link-local,
  CGNAT, multicast, documentation, benchmarking and reserved ranges, IPv4 and IPv6; IPv4 inside
  IPv6, NAT64 and 6to4 `2002::/16` judged as the IPv4 address they carry). No list opens a
  private address any more. The rule comes per call from `opts.rules(ctx)` (the daemon passes
  `webAccessOf(project.settings)`, `packages/runtime/src/wiring/web-access.ts`).
- **The loopback seam.** `opts.loopback` (policy option `loopback`) lets the reader reach this
  computer's loopback (127.0.0.0/8, `::1`, the name `localhost`), never the local network. Only
  the composition of the scripted development modes (`fr daemon --provider bench` and
  `bench-api`) and tests set it; no list, setting or environment variable does.
- **A proxy.** The reader connects directly. With `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` set
  (`proxySetIn(opts.env ?? process.env)`), a connection that never reached the site (not found,
  refused, reset, unreachable, timed out) adds `PROXY_SENTENCE` to its words, as a condition ("If
  this computer reaches the internet only through its proxy, …", P7-27: a mistyped host fails
  too, so the proxy is not said to be the cause).
- **The read (`fetch.ts`, `readWebPage`).** A GET over `node:http(s)` with `agent: false` and a
  `lookup` that resolves every address of the host (`opts.resolve`, default `dns.lookup` with
  `all: true`) and refuses the connection when one is not allowed, so the check is on the
  addresses the socket uses (an IP literal is checked before, as net resolves nothing for it).
  No cookie, no authorisation, the AI-agent user agent. Redirects followed here, each hop
  through `checkUrl` and the lookup, at most `WEB_MAX_REDIRECTS` (5). The body (gzip, deflate,
  br decompressed) up to `maxBytes` (2 MiB) within `timeoutMs` (30 s) and the run's signal;
  charset from the header. HTML through the browser's `extractFromHtml`/`renderExtract` (40
  links at most); text, JSON, XML, CSV, YAML, markdown as they are; other types `not_supported`.
  The visible text is cut at `maxChars` (default 30,000, the model may ask 500 to 60,000).
- **Errors in words.** A refusal by the rules is `domain_not_allowed` "Refused: <why>." and
  an audit row (`allowed: false`, `deniedReason`); an error status, a non-text page, too many
  redirects, a host not found, a timeout are `unavailable` / `not_supported` with one
  sentence. The loop driver returns the message to the model as `ERROR: ...`.
- **The result.** `renderWebPage`: the final address, status and title, "redirected from" and
  the cut note when they apply, then the text; `untrusted: { source: "web_page", origin }`;
  `artifacts` with the address, final address, status, title, type, characters, `truncated`
  (the executor's source log reads them, `runtime.md` "Web research").

Not here: web search (Anthropic's server tool on an API key, Claude Code's WebSearch on a
subscription: `runtime.md` "Web research"), reading through a proxy (only the sentence above),
the Windows system proxy setting, robots.txt, PDF text.

## How it works

## How to change it

## Tests

`web-fetch.test.ts` runs `web_fetch` against a real HTTP server on the loopback: a page read
as text with its title and the hidden passage apart, text, JSON, gzip and Latin-1 pages, a
redirect on the same site, the byte and character cuts; this computer and the local network
refused before any request (each refusal an audit row), a name resolving to a private address
(also one of several), this computer and the local network refused whatever the lists say
(`localhost`, `127.0.0.1`, IPv4 inside IPv6 and 6to4 on an only list; a dotless name), the
loopback seam reading the loopback and nothing else, a never entry covering its subdomains with or
without a trailing dot, only mode reading its sites and subdomains and refusing another with the
rule named, the never list winning over the only list, every redirect hop checked, other schemes,
credentials and long addresses refused; error status, non-text page, redirect loop, unknown host
(with the proxy sentence when a proxy is set), timeout and the run's stop in words; the address
table with 6to4 and the loopback. Test host names resolve to the loopback through
`opts.resolve`, and `opts.isPublic` counts the loopback public only behind them.

`github.test.ts` reads commit statuses from the combined-status endpoint, sends the merge's
`sha` pin to the stub and has `MemoryGitHost` refuse a merge
pinned to a head the PR no longer has; `merge-commits.test.ts` (the fake git host) merges with a
merge commit by default (two parents, `mergeCommitSha`), reads `allow_merge_commit` and is
refused where it is off, has a pull request whose commits reached main inside another marked
merged, reads a ruleset's and classic protection's rules (an admin's merge goes around classic
protection on the host, which is why the merge step reads them first; a collaborator who cannot
read the protection is not `unreadable`), and has `holdsMergedWork` and `ownChangeId` on real
git (main merged in keeps the id, a commit on top changes it, a branch built on a dependency is
measured from the marker, also after main was merged in); `git.test.ts` has `isAncestor` false while the base has
moved and true after the rebase. The runtime's merge step on the fake git host is
`packages/runtime/test/loop-merge.test.ts`.

`git.test.ts` also runs `GitOps` against local bare repositories: the token reaching git
through `GIT_CONFIG_*` and never argv (a recording runner), a caller's own `GIT_CONFIG_*`
entries kept, the key scoped to `GitAuth.origin` (`http.<origin>/.extraheader`, normalised;
non-http origins refused), a killed command reported as `timeout` with the limit,
`remoteDefaultBranch()`, `remoteUrl()` and `localBranches(prefix)`, no force-push of the
default branch, redacted errors. The recording runner also pins the auth shape: a Basic
`x-access-token` header after an empty reset entry, no `bearer`, no raw token in argv or env,
`-c credential.helper=` before the subcommand with or without a token. Line endings
(R-copystuck): a clone and an `init` say `core.autocrlf=false` in their own config, the
person's git set up as Git for Windows' default (`core.autocrlf=true` in a `GIT_CONFIG_GLOBAL`
file, never a `-c`, which would beat the folder's config) puts a file back as committed and our
`status` reads it unchanged, and `pinLineEndings` writes a folder made before (no setting, or
`true`) once and leaves `.git/config` untouched when it already says so. `pr-executor.test.ts`
"in a project's folder, the person's own git with Git for Windows' default puts a file back as
ours reads it" does the same in a project's folder, one made before the fix included.

`git-auth.integration.test.ts` runs `GitOps` against a real `git http-backend` behind a small
Node server that, like GitHub's git endpoint, takes only Basic with the right token and answers
anything else with 401 "invalid credentials". The human's config is simulated through
`GIT_CONFIG_GLOBAL`: a credential helper that offers a stale password and logs every call, and
a stale global `http.extraheader`. Clone, branch, push and fetch succeed with the token both
unscoped and scoped to the origin, every request carries our credential and nothing else, and
the helper is never called; a wrong token fails with the token redacted, the helper still not
called (the old code asked it to `get` and then `erase`) and the stale credential never sent.

`pr-executor.test.ts` runs `PrTaskExecutor` against local bare repositories and
`MemoryGitHost`: the PR flow end to end, a push the host refuses (a pre-receive hook) failing
the task with `pushFailedWords` ('GitHub refused the push: "<the host's line>". Check the GitHub
token in Settings and <repo> on GitHub, then press Try again.', no branch named; the network and
other refusals have their own words; before, the reason was git's output), an empty repository getting its README commit on
`main` before the task's branch and PR (the branch holding only the task's change), a base
branch the remote lacks failing in words, an empty repository whose host refuses the first
commit (a pre-receive hook) failing with `firstPushFailedWords`' exact sentence and the inner
executor never run, a first commit refused for another reason naming the host's one line, a rebase conflict as a blocking human request with no
PR, and no changes as a failure. "a task that waits for unmerged work builds on it (C-49)": B
sees A's unmerged file, B's PR targets main and names A's PR, B's changed files and
`DEPS_BASE_REF` are its own; a chain C after B after A gets both, and a dependency merged on the
host meanwhile is no longer named; B's next attempt keeps its base (no new merge, its files its
own, the PR's comment names A's PR); two dependencies that conflict end `needs_human` with the
exact sentence and the inner executor never run; the PR body has no empty criteria heading and
no "Lesson:" line, and the commit message no markdown (L-19). The dependent branches against
the testenv fake GitHub (squash, rebase and close as GitHub makes them) are
`packages/runtime/test/dependent-branches.test.ts` (no replay after a squash, the merge commit
and marker of one dependency, a redo on a fresh branch, the PR words),
`dependent-branches-merge.test.ts` (composed with the runner, the merge step and the watcher)
and `dependent-branches-restart.test.ts`; `git.test.ts` has `noFastForward` and
`rebaseOntoFrom`. What each of the conflict request's options does, answered
through the daemon's route with the strings the Inbox shows and followed by the task's next
run, is `packages/runtime/test/pr-answers.test.ts` (U-028). Like `git.test.ts` it spawns dozens of git processes, so both
suites carry a 120 s timeout rather than the unit default of 20 s: loaded Windows runners have
run them several times slower than usual.

## Known issues

- `GitOps` hands the token to git through `GIT_CONFIG_*`, which git older than 2.31 ignores
  (it then talks to the remote anonymously).
- The PR executor, the merge step and the docs writer construct `GitOps` without
  `GitAuth.origin`, so their header still applies to every http(s) remote the command
  reaches, as before; only the data module's import scopes it. Passing the repository's
  origin there too is a small follow-up.

### Changed files for peer awareness

After a successful rebase the PR executor records `git diff --name-only base...HEAD` as
`changedFiles` on the task result. The session runner appends a `task.files` event and stores
the list under `in_flight_files` in the session handoff, which is what peers use for overlap
detection (`runtime.md` § Peer awareness). The diff is informational: a failure to compute it
never fails the pull request.
