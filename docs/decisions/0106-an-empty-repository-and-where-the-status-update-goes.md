# 0106 — An empty linked repository gets Forerunner's first commit; the status update never rides on a task's pull request

Date: 2026-11-02
Status: accepted

## Context

The first walk on a real GitHub repository (2026-11-01, `forerunner-sandbox`) and the bench walk
with the stand-in for GitHub (2026-11-02) showed two things that make repository work end wrong:

1. **An empty repository fails everything.** A repository created on GitHub without a README has
   no branch. Every task failed with git's own words ("git checkout -B fr/… failed: fatal:
   'origin/main' is not a commit and a branch … cannot be created from it"), the doc scaffold at
   project creation failed the same way (only in the daemon log), the intake's doc set fell back
   to a folder nobody reads, and nothing told the person the repository was empty. The owner had
   to push a README by hand before anything worked.
2. **The status update landed on a reviewed pull request.** At session end `ProjectDocs`
   committed `docs/status.md` onto the branch of the last pull request the session opened, after
   the critic had accepted that branch. The person's reviewed PR then held a file the critic
   never saw, and a PR "Add the README" carried the project's status log too.

ADR 0058 said the default branch is never pushed. ADR 0097 already lets Forerunner push the first
commit of a repository it created for a project.

## Decision

1. **The first commit of an empty repository.** When the linked repository has no branch at all,
   the first thing that needs one (the doc scaffold, the intake's approved doc set, the status
   update, or a task) makes one commit on the repository's default branch and pushes it
   (`ensureBaseBranch`, `packages/capabilities/src/githost/base-branch.ts`): the doc set where the
   caller has it (the scaffold or the intake's set, then without a pull request: there is nothing
   to review it against), else a README with the project's name and goal. Branches and pull
   requests then work as for any repository. Only an empty repository is written to directly; a
   repository with commits keeps ADR 0058's rule.
2. **Words when it cannot.** A repository with branches but not its default one is not guessed
   at: the task fails with "<repo> has no branch "<base>" to start from (it has …). Set its default
   branch on GitHub, then press Try again." A first push that fails says the repository is empty
   and to add a first commit on GitHub, then press Try again.
3. **The status update on Forerunner's own branch.** `docs/status.md` goes on `fr/status` with
   one pull request at a time ("docs: project status"): a later session adds its entry to the
   open one (a comment says so); once that PR is merged or closed, the next update starts the
   branch again from the default branch and opens a new one. It never goes on a task's branch.
   Before, a session that opened no task PR opened one status PR per session
   (`fr/status-<session id>`), which left the person a PR to merge after every session.
4. **The docs clone reads what is merged.** After each docs write the clone is back on the
   default branch, so the Docs and Files tabs and the chat read the merged state; the docs that
   wait in a docs pull request are listed with its number and link (`docsInPullRequests`).
5. **A project's folder keeps its whole history.** In a project without a repository the
   session's work and the status update are committed in the folder at session end (the last
   task's files stayed uncommitted before), and a `.gitignore` keeps caches such as
   `__pycache__/` and `node_modules/` out of it.

6. **A task that waits for unmerged work builds on it** (added 2026-11-02, phase E; the session
   lead's default, pending the owner's confirmation at hand-over). Every task used to branch from
   the default branch, so a task that waits for a done task whose pull request was not merged
   yet did not see that work: live on forerunner-sandbox the tester of a two-task plan found
   neither the page nor the README section it had to check and failed, and passed only after the
   owner merged the coder's PR by hand and pressed Try again (L-14, C-49). Now the branches of
   the done tasks it waits for (and those they wait for) whose pull requests are still open are
   merged into the task's branch before it runs (`PrTaskExecutor`, `DEPS_BASE_REF`). Its pull
   request still targets the default branch and says which pull requests it includes ('Builds on
   #4 ("Add index.html"), not merged yet: this pull request includes its changes, so merging it
   merges them too. Merge in any order.'). The critic's diff and the task's changed files are
   the task's own commits, measured from the default branch with the dependencies merged in. Work
   of two dependencies that conflicts stops the task before it runs, with one card in words
   ("The work it builds on conflicts: ... Merge them on GitHub, resolving the conflict, then
   press Try again."), never a silent drop.

## Consequences

- Linking a repository just created on GitHub works without the person pushing a README first.
- A reviewed pull request holds only the task's change; the status log is one PR the person can
  merge when they like.
- A repository with a default branch that does not exist (a misconfiguration) stops the task with
  the reason and the fix, not git's output.
- `ProjectDocsPort.writeSessionStatus` no longer takes `prBranch`; `statusBranchFor` is gone.

- A dependent task's pull request carries its dependencies' commits until they are merged: on
  GitHub its "Files changed" shows their files too (the PR's body names them); merging it first
  merges them too, and GitHub then marks their pull requests merged.

## Alternatives considered

- For a task that waits for unmerged work (point 6): **stacked pull requests** (the task's
  branch and PR based on its dependency's branch) show only the task's change on GitHub, but
  the person must merge them in order and retarget each after a merge; **hold the task until
  its dependency's PR is merged** keeps every PR clean but stops a plan after its first task
  until the person merges by hand, which is what the owner met live. The owner may still choose
  either.

- Ask the person to add a README: it blocks a newcomer on a step the app can do, and the owner
  hit it on the first live walk.
- Keep the status update local (never pushed): `docs/status.md` would no longer be in the
  repository the spec (G.5) puts it in.
- One status pull request per session: a PR to merge after every session.
