# 0106 — An empty linked repository gets Forerunner's first commit; the status update never rides on a task's pull request

Date: 2026-11-02
Status: accepted (point 6 amended by 0111: merges are merge commits; a dependent branch is kept true and its pull request says to merge in order, never "Merge in any order")

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

   **Since 2026-11-02 (phase E, C-57; the session lead's default, pending the owner's
   confirmation) the status pull request is off by default**: a repository project keeps
   `docs/status.md` in the app (`<data>/projects/<id>/app-status/docs/status.md`, no commit, no
   pull request), the Docs tab reads its Status from there first ("kept in the app: no status
   pull request (Settings turns it on)") and the session log says "kept in the app". The
   session's end still clones or fetches this computer's copy of the repository and puts it on
   the default branch, as the status write did, so the Docs and Files tabs and the chat read
   what is merged (nothing is pushed). One pull
   request to merge after every session was noise, even for a one-task project. The project
   setting **Status pull request** (Settings, Other settings; `settings.set status_pull_request`)
   turns the behaviour above back on for that project. Only this project's docs pull requests are
   listed on its Overview and Docs tab (L-16): the status PR while its setting is on, the intake's
   set on the branch named for the project, a scaffold PR that names the project in its body
   ("Forerunner project <id>.") or that the project's scaffold wrote its docs onto; an open
   scaffold PR of another project on the same repository is no longer recorded or shown as this
   one's. Alternative the owner may still choose: the status PR on by default (as before).
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

## Amendment: two projects on one repository (W15-01, 'w15-merge', 2026-11-09)

Points 3 and 5 assumed one project per repository. Live check 2 linked two projects to one
repository with **Status pull request** on for both: `fr/status` is one branch per repository,
so the second project's session started from the first project's open status pull request,
pushed its status into it, commented on it, and its Overview listed it with Merge.

Until the owner answers W15-112 (whether two projects on one repository get a status pull
request each), only the safety part is built:

- Every status and scaffold pull request Forerunner opens ends its body with a hidden mark
  naming its project, `<!-- forerunner:pr project=<id> -->` (an HTML comment: GitHub does not
  show it; the same form carries a task pull request's task and session, W15-08). The visible
  "Forerunner project <id>." line of the scaffold body is gone; it is still read for pull
  requests an earlier version opened.
- A project never pushes to, comments on or lists another project's status or scaffold pull
  request. While another project's status pull request is open on `fr/status`, this project
  opens none: its status stays in the app (as with the setting off) and the daemon log says why
  in one line. With none open, the behaviour of point 3 is unchanged.
- A status or scaffold pull request without a mark (an earlier version's, or one a person
  opened on that branch) is a project's only while it is the one project on this install linked
  to the repository; with two linked it is neither's. This fails closed.
- No per-project branch and no second pull request: both would change one `docs/status.md`
  and conflict on merge, which is the owner's question.

## Amendment: the kept status shows on Docs (W15-01 fix-up, 'w15-merge', 2026-11-09)

The review of the amendment above found that "its status stays in the app (as with the setting
off)" was only half true: the status was written to the app's folder, but the Docs tab read
`docs/status.md` from the app only with the setting off, so the second project's Docs tab said
the status was not written yet. Now a project whose last status stayed in the app because
another project's status pull request was open reads it there, as with the setting off, after a
restart too (a file beside the status says so). Its next status written to its own pull request
removes that file, and the Docs tab reads the repository's copy again. The Docs tab's note on
that row still reads as with the setting off; its words are not changed in wave 15.

## Amendment: one repository, one project (d1109-onerepo-link, 2026-11-15, ADR 0117)

D1 answers W15-112: one repository is one project, so no new pair is made (ADR 0117 refuses a
second project on a link from every entry point, and two installs share a repository as one
project worked on together). The W15-01 rules stay for pairs made before this version and for
another Forerunner's pull requests:

- "The one project on this install linked to the repository" is now the repository index's
  answer (`ownsUnmarkedDocs`): every spelling of the repository and a folder with that origin
  count as one link; a project joined into another counts as the kept one; a together project
  is never the sole user; and this computer's copy's marker must name no other project. It still
  fails closed (an index that cannot be read owns nothing).
- A together project never writes `fr/status`: its status stays in the app, whatever the
  setting, and the Docs row says 'Kept in the app: you work on "Kite club" together, so GitHub's
  copy is left as it is.'
- The Docs row of a status kept in the app because another status pull request held `fr/status`
  now says why (the note above that read as with the setting off): 'Kept in the app while "A"'s
  status pull request is open on GitHub.'; for a marked one of a project not here, '... another
  project's status pull request ...; close it there to have this one's there.'; for an unmarked
  one, '... another status pull request ...'. The holder is recorded beside the kept status (its
  number and the project its mark names), so it reads the same after a restart.

## Amendment (2026-11-24, wave 8, w8-repo-guide): the first commit carries the guide, and no status file (ADR 0121)

An empty repository's first commit now carries AGENTS.md (Forerunner's part rendered from the
guide's facts) and CLAUDE.md (`@AGENTS.md`), and no docs/status.md; the session's end then finds
the guide current and opens no docs pull request. The status of a repository project stays in
the app by default (C-57); the optional `fr/status` branch is unchanged until the status issue
(w8-status-write) replaces it.

## Amendment (2026-11-24, w8-status-write)

The status part (point 3, C-57's status pull request on `fr/status` and its setting) is
superseded by ADR 0122: no status pull request any more; a repository project's
`docs/status.md` is the app's; on GitHub the status is the project's pinned status issue, one
comment per Forerunner, with no costs (the session's "Spent CHF x." note never reaches GitHub,
R11). An earlier version's open status pull request of the project is closed by this install
with one line.
