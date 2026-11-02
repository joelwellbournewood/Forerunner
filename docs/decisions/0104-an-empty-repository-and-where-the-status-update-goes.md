# 0104 — An empty linked repository gets Forerunner's first commit; the status update never rides on a task's pull request

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

## Consequences

- Linking a repository just created on GitHub works without the person pushing a README first.
- A reviewed pull request holds only the task's change; the status log is one PR the person can
  merge when they like.
- A repository with a default branch that does not exist (a misconfiguration) stops the task with
  the reason and the fix, not git's output.
- `ProjectDocsPort.writeSessionStatus` no longer takes `prBranch`; `statusBranchFor` is gone.

## Alternatives considered

- Ask the person to add a README: it blocks a newcomer on a step the app can do, and the owner
  hit it on the first live walk.
- Keep the status update local (never pushed): `docs/status.md` would no longer be in the
  repository the spec (G.5) puts it in.
- One status pull request per session: a PR to merge after every session.
