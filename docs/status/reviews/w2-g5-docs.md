# w2-g5-docs

Item: the PM keeps the standard doc set current (spec G.5): the eight docs scaffolded at
project creation as a pull request on the linked repository (`fr/docs-scaffold`, never the
default branch, never over an existing file) or under the install's workspace without one,
deferred to the intake's approval when the project is created with `intake: true`;
`docs/status.md` rewritten at session end on the session's PR branch or `fr/status-<session id>`,
skipped by a session that only filed its plan; the critic's docs-drift check at tier 2+. Built
on `wave/w2-g5-docs`, merged in `e47837e` (3 commits, 13 files) without a review; ADR 0058.

## Review

Independent adversarial review, stage REVIEW AND FIX, 2026-10-25. Reviewed the item's changes
as they stand on the integration branch `ccr-af5a431d-jc9xqj` at `60689f2` (the code moved
since the merge: the intake of ADR 0055, the B.5 reason guard, the A.3 import with its
token-origin rule of ADR 0069, the A.4 source discovery of ADR 0056, the monthly jobs). Read
the brief, ADR 0058, memory.md "Project docs", runtime.md "Project docs" and its Known issues,
the G.5 residual row of BLOCKERS.md, then traced `packages/memory/src/docs.ts`,
`packages/runtime/src/loop/docs.ts`, `loop/ports.ts`, `daemon/server.ts` (`POST /projects`),
`daemon/create-project.ts`, `daemon/compose.ts` (the `ProjectDocs`, `SourceDiscovery`,
`IntakeService` and command-port wiring), `session/runner.ts` (step 4), `session/intake.ts`
(the docs path and the reject branch), `loop/critic.ts` (the drift block),
`packages/commands/src/commands/project.ts`, `packages/capabilities/src/githost/git.ts`
(`tokenHeaderKey`, `GitOps`) and `sources/discovery.ts` (the marker reader). Ran the item's
tests (`docs-scaffold`, `loop-docs`, `memory/docs`: 27 passed).

**Verdict: revise.** Score: 62/100. What the item built is solid where it runs: the eight
docs from templates with frontmatter, the no-overwrite rule (`scaffoldDocs` skips what exists,
the branch is taken from its remote so drafted files survive, `git checkout -B` never fails
on a stale local branch), the branch-and-PR path (`fr/docs-scaffold`, a push to the default
branch is never attempted and `GitOps.push` refuses to force one), the workspace fallback
under `<projectsRoot>/<id>/workspace`, the status doc's format (`applyStatusUpdate` keeps a
human's sections and frontmatter, idempotent per session, capped log), the status commit on
the session's own PR branch or a small PR of its own, the skip for a session that touched no
task, and a failure that is recorded and never fatal. The tests prove those: the branch tree,
the byte-identical README, `main` untouched, the events and the row. What is wrong: the
scaffold hangs on the `POST /projects` route handler rather than on project creation, so the
two other ways a project comes into being (an accepted source proposal, which is how a
repository gets linked from a scan, and `project.create` by chat or voice) create projects
with no doc set; a project created with `intake: true` whose intake is rejected or fails
never gets its deferred scaffold; the docs clone sends the install's token to any http(s)
origin instead of the repository's; and the install marker the A.4 scan reads is still
written by nothing.

### Requirements checked

- [x] The eight docs (`STANDARD_DOCS`, templates with `maintained-by` frontmatter and a
  `read_if` line; `docs/decisions/` as its README), name, goal and repos filled in.
- [~] Scaffolded at project creation with a linked repository as a PR on `fr/docs-scaffold`:
  true for `POST /projects` only. An accepted source proposal (`SourceDiscovery.createProject`
  in `compose.ts`) and `project.create` from chat or voice insert the row and scaffold
  nothing (findings 1 and 2).
- [x] Never the default branch: every push names `fr/docs-scaffold`, the PR branch or
  `fr/status-<id>`; `GitOps.push` refuses a force push of the default branch. Never over an
  existing file: `scaffoldDocs` skips what exists; the branch is checked out from
  `origin/fr/docs-scaffold` when it exists (`docs-scaffold.test.ts`, "files already drafted on
  the branch").
- [~] Without a repository under the install's workspace: yes (`WORKSPACE_DIR`); a project
  linked to a local folder (spec A.4) writes the workspace too, and `docsDirsFor` lists both.
- [~] Deferred to the intake's approval when created with `intake: true`: the approval path
  writes drafts plus the templates for what the draft left out; the rejection and the failed
  intake leave the project with no doc set (finding 4).
- [x] `docs/status.md` at session end on the session's PR branch (the last PR the session
  opened or updated; a branch merged at level 3 is dropped from the list) or
  `fr/status-<session id>` with its own PR; a repository without the doc gets it scaffolded in
  the same commit; the four sections from the project's state, the entry from the session.
- [x] Skipped by a session that only filed its plan: nothing ran, so `touched` is false and
  the guard on `plan_awaiting_approval` holds too; no test names the case (finding 6).
- [~] The critic's docs-drift check at tier 2+: wired in `loop/critic.ts` as a non-required
  check; proven at the function level (`packages/critic/test/docs-drift.test.ts`,
  `packages/memory/test/docs.test.ts`) only, and it repeats a `docs/status.md` finding the PM
  resolves minutes later on the same PR (finding 7).
- [~] Secrets and the token rule of ADR 0069: no token, lesson or private value enters a
  scaffolded doc or a PR body (name, goal, repos, task titles, the stop reason and the spend);
  the token reaches git through the environment, never argv; but it is not scoped to the
  repository's origin (finding 3).
- [x] Time through the Clock (`endedAt`, `scaffolded_at`, `failed_at`); paths through the
  platform (`join`, `fromPosix`, `safeSegment` on every id in a path); git through
  `GitOps`'s argv arrays; `ForerunnerError` codes in `GitOps`; nothing hardcoded to an org,
  host or user path; the envelope untouched (the outcome lives in `summary_cache.docs` and
  `handoff.docs`, no new table).
- [x] Content from the repository is never read into a model by this item; the PR body and
  the status doc are rendered from the store's own rows.
- [x] Semantic conflicts with later merges: `parseRepoRef` and the executor's `repoFor` both
  return null for an absolute path (a folder project runs without the PR flow and keeps its
  docs in the workspace); the intake's placeholder rule (`isScaffoldPlaceholder`) matches
  `renderStandardDoc` byte for byte; the B.5 reason guard concerns session plans, not the
  project patch the scaffold makes. One doc sentence is wrong since the intake merged
  (finding 5).

### Findings

1. **high**: `packages/runtime/src/daemon/compose.ts:2979-2990` (`SourceDiscovery.createProject`) against `packages/runtime/src/daemon/server.ts:618-630`. The G.5 scaffold is a statement in the `POST /projects` handler, not part of creating a project. The source discovery's accept (spec A.4, `POST /sources/candidates/:id/accept` and `fr sources accept`) creates the project through `createProjectRecord` alone, and that path is the one that links a repository found by a scan: such a project gets no docs PR, no `summary_cache.docs`, and (finding 8) no install marker, while the requirement row says the set is scaffolded at project creation. Verified by reading both call sites (`create-project.ts` has no docs dependency) and, in stage 2, by the failing test: an accepted repository proposal leaves `summary_cache.docs` undefined and the host without a PR. Smallest correct fix: `createProjectRecord` takes an optional `docs` port and runs the scaffold itself after the insert (never failing the creation, as the route does), unless the caller says the intake will (`intake: true`); the route and the accept both pass the port. Test: `sources-routes.test.ts` (the composed daemon's accept of a repository candidate records `summary_cache.docs` and opens the PR on the fake host).
   Resolution: pending.

2. **medium**: `packages/commands/src/commands/project.ts:163-169` (`projectCreate.run`) with `packages/runtime/src/daemon/compose.ts:2485-2510` (the command ports). `project.create` by chat, voice or the palette inserts the row and nothing scaffolds; ADR 0058 and the BLOCKERS residual say so, but the requirement row reads "scaffolded at project creation" and the command is a creation. Verified by reading (no port is called after the insert; `CommandPorts` has no project hook). Smallest fix: a `CommandPorts.projectCreated?(projectId)` hook the command awaits after the insert (a throwing hook is logged, never fails the command), wired in `compose.ts` to the same scaffold the route runs, in the background so the chat answers at once. Tests: `commands.test.ts` (the hook called with the id, a throwing hook harmless); `docs-scaffold.test.ts` (`POST /commands/execute` with `project.create` ends with the set under the project's workspace).
   Resolution: pending.

3. **medium**: `packages/runtime/src/loop/docs.ts:245-249` (`ProjectDocs.checkout`: `new GitOps({ auth: { token } })`). The install's GitHub token is handed to git without `origin`, so `tokenHeaderKey(undefined)` makes it the global `http.extraheader` (`packages/capabilities/src/githost/git.ts:37-52`, `:130-137`): git attaches it to every http(s) URL it talks to, including a remote a `url.<other>.insteadOf` rewrite in the user's git config points elsewhere, or a clone URL a host answers on another origin. ADR 0069 set the rule for the same token (the A.3 import passes `origin: new URL(target.url).origin`, `data/import.ts:555-557`); the PR executor shares the gap (a known residual, not this item's). Verified by reading. Smallest fix: `gitAuthFor(token, cloneUrl)` in `loop/docs.ts`: an http(s) clone URL gives `{ token, origin }`, any other (a local path, ssh) gives no token at all, since there is no origin to scope it to. Test: the helper on an https URL, a local path and an ssh URL; the sources test of finding 8 clones from the fake host over HTTP with the token scoped to its origin (the push is refused otherwise).
   Resolution: pending.

4. **medium**: `packages/runtime/src/daemon/server.ts:622-630` (the deferral) with `packages/runtime/src/session/intake.ts:933-953` (the reject branch). A creation with `intake: true` leaves the set to the intake's approval; a rejecting answer writes a queue note ("nothing was written") and a failed intake call (no model key, malformed output) records the error, and in both cases the deferred scaffold never runs: the project has no README, no `docs/status.md`, nothing for the chat's docs search or the status write to start from (the status write scaffolds `docs/status.md` alone). Verified by reading the reject branch (a note and an audit row only) and the route (the scaffold is skipped before the intake is even enqueued). Smallest fix: the intake takes an optional docs port and, on a rejected answer, scaffolds the standard set (templates only; the drafts were refused), so the deferral ends with the templates; a failed automatic intake is left to the status route, which tells the human to run it again, and the re-run's approval still writes the set. Test: `intake.test.ts` (a project created with `intake: true`, rejected: the workspace holds the eight templates, none drafted).
   Resolution: pending.

5. **low** (wording): `docs/decisions/0058-project-docs-in-the-repo-by-pull-request.md` point 1 ("files the intake drafted there are kept"), `docs/maintainers/runtime.md` "Project docs" ("from `origin/fr/docs-scaffold` when the branch exists, so files the intake drafted there are kept") and `packages/runtime/test/docs-scaffold.test.ts` ("files already drafted on the branch (the intake) are kept"). The intake never writes on `fr/docs-scaffold`: its branch is `fr/intake-<id8>-docs` (`intake.ts:1131`), its own PR. What the code does, and the test proves, is keep whatever an existing `fr/docs-scaffold` branch already carries (an earlier scaffold, a human's edits on the open PR). Fix the three sentences to say that.
   Resolution: pending.

6. **low**: `packages/runtime/src/session/runner.ts:1181` (`stopReason !== "plan_awaiting_approval"`). No test proves "skipped by a session that only filed its plan": `grep -rn plan_awaiting_approval packages/runtime/test` finds four files, none of which looks at the docs events or the workspace. Mutating the guard changes nothing observable (a plan-only session ran nothing, so `touched` is false and `docs.status_skipped` is emitted instead of silence), which is fine behaviour, but the requirement sentence stands on no test. Fix: a case in `loop-docs.test.ts` (an assisted-mode project files its plan; no `docs.status_written`, nothing under the workspace, no PR).
   Resolution: pending.

7. **low**: `packages/runtime/src/loop/critic.ts:292-297` (`checkDocDrift(worktree, { changedFiles, tasksChanged: true })`) and `docs/requirements.md` row G.5, which lists `packages/runtime/test/loop-critic.test.ts`. That file has no drift or worktree case (`grep -c "drift\|worktree"` is 0; `loopWorld`'s executors return no `worktree`, so the drift block never runs in it), so the runtime wiring of the check at tier 2+ is proven nowhere; and the check lists `docs/status.md` for every specialist change although the runner's `ProjectDocs` writes that file on the same PR right after the review (the residual row). Fix: `CriticLoopDeps.statusDocManaged` (set by the daemon, which wires the docs port) drops the `docs/status.md` entries from the drift result; a case in `loop-critic.test.ts` runs a tier-2 task with a worktree, asserts the `docs-drift` check names `docs/architecture.md` and `docs/status.md` without the flag and only the former with it.
   Resolution: pending.

8. **medium** (handed over from `docs/status/reviews/w2-a4-sources.md` finding 4, ADR 0056 amendment point 5): `packages/runtime/src/sources/discovery.ts:121` (`INSTALL_MARKER_FILE`) is read by `repoHasMarker` and `folderFound`; nothing writes `.forerunner/project.json`, so for repositories the existing-install mark fires on hand-marked ones only, and the scaffold of ADR 0058, the first thing Forerunner writes into a managed repository, writes the doc set without it. Verified: `grep -rn "\.forerunner/" packages/` finds the reader, the schema comment and tests only. Fix: a marker module (`sources/marker.ts`: the shape `{ schema: 1, project, name }`, render, parse, `writeInstallMarker`) used by `ProjectDocs.scaffoldProject` for the same branch and PR as the doc set and for the workspace without a repository, and by the intake's deferred scaffold; a marker of another project is reported (`other_project`) and never overwritten. Tests: `docs-scaffold.test.ts` (the marker on the branch and in the workspace, a second project on the same repository reported and the marker kept), `sources.test.ts` (a repository this install scaffolded, once the PR is merged, scanned as an existing install with the marker; unlinked, still proposed as one).
   Resolution: pending.

### Not findings, checked

- The docs clone lives under `<worktrees>/docs/<safeSegment(project id)>` and the workspace
  under `<projectsRoot>/<safeSegment(id)>/workspace`; no write leaves them.
- A second status session on a project reuses the clone and `git checkout -B` resets a stale
  local branch from its remote, so a branch name seen before never fails the write.
- The host's `listPullRequests(head)` is sent the bare branch name; the fake host accepts
  both `owner:branch` and `branch`, GitHub's documented form is `owner:branch`. The adapter is
  shared with the PR executor and the intake and cannot be checked against the real host from
  here; noted, not changed.
- The status entry's note publishes the session's spend into the repository's doc. The cost
  ledger is shared state among a project's members by the spec, and the repository's
  visibility is the human's; left as designed.
- `summary_cache.docs` is rewritten whole by every scaffold outcome, including the error
  record; the intake writes other keys of the cache and neither clobbers the other.
