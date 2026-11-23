# 0058 — Project docs: in the repository by pull request, the status doc rewritten per session

Date: 2026-10-23
Status: accepted

## Context

Spec G.5: "Standard project doc set: `README`, `docs/overview.md`, `architecture.md`,
`status.md`, `decisions/` (ADRs), `runbook.md`, `data.md`, `testing.md`. PM keeps them
current; critic checks drift." `scaffoldDocs` and `checkDocDrift` existed in
`packages/memory` and the critic ran the drift check at tier 2+, but nothing scaffolded the
docs at project creation or wrote `docs/status.md` at session end (`docs/status/BLOCKERS.md`,
row G.5). Three things were open: where the docs live for a project with and without a
repository, how the PM's writes reach the repository (spec F: "code changes only via
branches and PRs"), and what the status doc looks like when both the PM and a human edit it.
A parallel item (A.2 intake) drafts doc content and will call `scaffoldDocs`.

## Decision

1. **The docs live in the project's first repository and reach it by pull request only.**
   `ProjectDocs` (`packages/runtime/src/loop/docs.ts`) resolves `project.repos[0]`
   (`owner/name` or a clone URL, `parseRepoRef`; the PR executor uses the same resolution),
   clones into `<worktrees>/docs/<project id>`, writes on a branch with `GitOps` and opens the
   pull request on the `GitHost`. The default branch is never pushed and an existing file is
   never overwritten: the scaffold branch `fr/docs-scaffold` is checked out from its remote
   when it exists, so files the intake drafted there are kept, and `scaffoldDocs` skips what
   is present. A project without a repository keeps the set under
   `<projectsRoot>/<project id>/workspace`, beside its `data/`, as plain files.
2. **The scaffold runs inside `POST /projects`, synchronously, and never fails the creation.**
   The card the dashboard gets back names the PR (`summary_cache.docs`); a git host error is
   recorded there (`error`, `failed_at`) and logged, and the critic's drift check reports the
   missing docs at the first review. `scaffoldDocs` keeps its signature; the intake can pass
   drafted content through its own extension and `renderStandardDoc` tells an untouched
   template from an edited doc.
3. **The status update rides on the session's own pull request, else on a small PR of its
   own.** At session end (runner step 4, after the task states are final) the update is
   committed on the branch of the last PR the session opened or updated, so that PR carries
   `docs/status.md`; a session that opened none commits on `fr/status-<session id>` (the
   whole id: an id prefix could collide within a minute) and opens its own PR. A session that
   executed no plan or changed no task writes nothing. A repository without `docs/status.md`
   gets it scaffolded in the same commit. The write is a port (`ProjectDocsPort`) so the
   runner's tests run with a fake; a failure is a session event, never fatal.
4. **The status doc's format is fixed by `applyStatusUpdate` in `packages/memory`.** The four
   standard sections ("## Done", "## In flight", "## Blocked", "## Next") are rewritten from
   the project's current state in the store (not only this session's tasks), every other
   section and the frontmatter are kept in place, missing standard sections are added, and a
   "## Sessions" log holds one dated entry per session (`### <date> session <id>` with
   Done, In flight, Blocked, Next and a note of the stop reason and spend), newest first,
   replaced for the same session id and capped at 20. Human prose outside those sections
   survives every rewrite.

## Consequences

- G.5 closes with `packages/memory/test/docs.test.ts`, `packages/runtime/test/docs-scaffold.test.ts`
  and `packages/runtime/test/loop-docs.test.ts`.
- The critic's `docs-drift` check still runs before the session-end write, so a tier 2+
  review of a specialist's diff lists `docs/status.md` even though the PM commits it on the
  same PR afterwards (runtime.md, Known issues). Sessions that open no PR each file a small
  status PR; they merge in order.
- `project.create` from chat or voice (`@forerunner/commands`) does not scaffold; the daemon
  route does. A second repository on a project is not documented from here.
- A clone per project for the docs: large repositories make the first creation slow, as they
  do the first task.

## Alternatives considered

- **Write through the git host's contents API instead of a clone.** Fewer moving parts, but
  GitHub (and the fake HTTP host) needs the branch created first, which the `GitHost` port
  does not offer, and the on-disk `scaffoldDocs` and the critic's `checkDocDrift` already work
  on files; a clone keeps one code path for both and the in-memory host for tests.
- **Append-only status entries without touching the sections.** Simpler, but the top of the
  doc would go stale while the log grew; rewriting only the four owned sections from the
  store keeps the doc current and the human's prose intact.
- **Status on every task PR of the session.** Several PRs carrying the same file conflict on
  merge; one branch per session (the last PR, or its own) does not.
- **Scaffold asynchronously after the 201.** The dashboard would not know where the docs went
  until a later event; the synchronous call costs one clone and returns the PR on the card.

## Amendment (2026-10-25, independent review of w2-g5-docs)

1. **The scaffold belongs to project creation, not to one route.** `createProjectRecord`
   runs it for `POST /projects` and for an accepted source proposal (spec A.4, the path that
   links a repository found by a scan), and `project.create` by chat, voice or the palette
   reaches it through the command port `projectCreated`, in the background so the reply does
   not wait for a clone. The consequence above that `project.create` does not scaffold no
   longer holds.
2. **A rejected intake ends the deferral with the templates.** A creation with `intake: true`
   still leaves the set to the approval; a rejection scaffolds the standard set from the
   templates through the same port, since the drafts were refused and the set still has to
   exist. A failed automatic intake is left to the status route, which asks for a re-run.
3. **The install marker rides with the doc set.** `.forerunner/project.json`
   (`{ schema: 1, project, name }`, ADR 0056 point 4, `sources/marker.ts`) is written beside
   the docs: on `fr/docs-scaffold` and its pull request with a repository (the A.4 scan reads
   the default branch, so the repository shows as an existing install once the PR is merged),
   in the workspace without one, and by the intake's own doc write. A marker of another
   project is reported (`other_project`) and never overwritten.
4. **The token goes to the repository's origin only.** The docs clone scopes the install's
   token to the clone URL's http(s) origin (`gitAuthFor`, the rule of ADR 0069) and sends none
   to a local or ssh remote; before, the header was global to every http(s) URL git touched.
5. **The drift check leaves the status doc to the PM.** With a docs port wired the daemon
   sets `CriticLoopDeps.statusDocManaged`, and the tier 2+ check neither expects a
   specialist's change to touch `docs/status.md` nor reports it missing, since the runner
   writes it on the same pull request right after the review (the consequence above about
   the repeat finding is closed).
6. **Wording.** Point 1 said files "the intake drafted" on `fr/docs-scaffold` are kept; the
   intake writes on `fr/intake-<id8>-docs` (ADR 0055). What is kept is whatever an existing
   `fr/docs-scaffold` branch already carries.

## Amendment (2026-11-15, d1109-onerepo-link: one repository, one project, ADR 0117)

1. **A take-over replaces exactly the marker it took over.** "Never over another project's
   marker" (amendment of 2026-10-25, point 3) holds for every project but one a project here
   took the repository over from (`settings.took_over.projects`): its marker is replaced by
   this project's in the project's next docs pull request (the scaffold's or the intake's set;
   `writeInstallMarker` reports `replaced` with the old id and name), and that pull request's
   body says so in one line: 'This repository was the Forerunner project "Kite club"; it is now
   the project "Kites".' (worded so since 2026-11-23, L4-github-108: before, 'it is now
   "Kites"'s.'). The old name is cut, scanned and quoted (else "another Forerunner project").
2. **A together project writes no docs.** A project worked on together with another Forerunner
   (`settings.together`, D9) writes no marker, no doc set and no scaffold or intake pull request;
   its scaffold only brings this computer's copy along (recorded as `together: true`), and its
   plans are plan-only (point 3).
3. **A plan for a project that already has work adds tasks only.** The intake for a project with
   tasks (Add to it, the second brief, a together project) writes no document: its proposal has
   no `docs`, its card is `plan_only`, and its approval writes the tasks and milestone only. The
   standard set is written once, at the project's first plan.

## Amendment 2026-11-23: the scaffold's branch and the take-over's words (l4-github-link, run L4)

1. **No possessive after a quoted name** (L4-github-108, design section 5 rule 1): the take-over
   line reads 'This repository was the Forerunner project "Kite club"; it is now the project
   "Kite flyers".' (live check 4 showed 'it is now "Kite flyers"'s.').
2. **The scaffold's branch** starts from the default branch whenever no scaffold pull request of
   this project is open, and is never a branch Forerunner did not write for this project: an old
   `fr/docs-scaffold` that is not this project's own is left as it is and the set opens on
   `fr/docs-scaffold-<project name>` (ADR 0117, amendment of 2026-11-23, point 2).
