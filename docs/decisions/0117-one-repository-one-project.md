# 0117 — One repository, one project

Date: 2026-11-15
Status: accepted

## Context

The owner's decision D1 of 2026-11-09: "There should not be 2 projects in one repo. ... Make it
such that multiple projects are not done on one repo, in an intelligent way." And, answer 1 of
the same evening (D9): "if 2 people are working on the same project they should be able to work
seamlessly in the same git. Isnt this already built in cleanly?"

Before this decision every way of linking a repository or a folder made a project without
asking which project already used it. The bench walk of 2026-11-15
(`/tmp/frbench/fix-d1109-onerepo-link/before`) made "Shop" on Atlas's repository from New
project and "Shop two" on `bench/seeded` from chat, without a word. Sources compared raw
strings, so `https://github.com/O/site.git` and `o/site` were two links; the Data tab's import
cloned into a project whatever another project used. A second Forerunner (another person's, or
the person's own earlier install) working on one repository was a second project with its own
marker, its own docs pull requests and its own `fr/status`, so W15-01 (ADR 0106, amended) had to
keep two projects' pull requests apart, fail closed, and leave the second project's status in
the app with a note that blamed the setting.

## Decision

1. **One identity for a link** (`packages/runtime/src/sources/repository-use.ts`,
   `identityOf`). A GitHub repository is `github:<owner>/<name>` in lower case whatever the
   spelling (https, ssh, scp, `.git`, `www.`, a `/tree/...` tail, a schemeless
   `github.com/o/n`); a folder is its real path (lower case on Windows, `path.win32`), with its
   git root, its worktree's main tree (from the `.git` file's `gitdir` and `commondir`) and its
   origin's repository key read from `.git/config` as files. No git process runs in the person's
   folder. Two links are one when a key matches, or when one folder is inside the other with no
   git root of its own below the linked one. A URL on a host the install does not use is
   refused in words ('Forerunner works with repositories on github.com, not gitlab.com. Link a
   GitHub repository or a folder.').
2. **The index** (`RepositoryIndex`) reads every project row (at most 10,000; above it, words):
   a project uses every entry of its `repos`; a project joined into another counts as the kept
   one (`settings.joined_from`, written by d1109-onerepo-join); a removed project (the Undo of
   its creation, W15-36) uses nothing. `knows(id)` is true for a row here, an id joined into one
   and an id a project here took over.
3. **Every entry point asks before anything is written** (`RepositoryUse.check`): New project
   (`POST /projects` with or without `switch`, the chat's port), `project.create` from chat,
   voice and the palette (its plan, before any read-back, and its run, through the commands'
   `repositoryUse` port), Sources' accept, and the Data tab's GitHub import (`checkHere`, this
   computer only). A link a project here uses is refused with its name: 'o/site is already the
   project "Site". Open it, or add this to it as new work.' (409 `conflict`, `details.cause`
   `repository_in_use`). The New project dialog shows it with Open it, Add to it (when a brief
   or goal was typed) and Cancel; chat gets the sentence as the tool's answer; Sources say
   'Already the project "Site"' with Open; the import answers the sentence and clones nothing.
4. **Add to it is a plan of new work only** (OR-08). `POST /projects/:id/intake` on a project
   that already has tasks (or is worked on together) asks the planner for the plan-only form:
   the project's tasks as quoted data ("Already in the project (data, between the markers):",
   up to 40 titles with their status), the instruction "Plan only work that is not already in
   the project.", no documents (no second doc set in the repository); its card is marked
   `plan_only` and its approval writes tasks only. An open plan answers 'A plan for "Site" waits
   for your answer. Answer it first.'
5. **The repository itself is read** when no project here uses it, with the person's token and
   the configured host only (never the page reader): `.forerunner/project.json` on the default
   branch (schema 1, a UUID) and the hidden marks of its pull requests in every state, newest
   first (`sort=updated`, 100), with who last updated each (`updatedAt`, `authorLogin`) and the
   token's own login. An id there that is not on this computer is another Forerunner's project:
   another person's, or the person's own earlier install.
6. **Work together first** (D9). 'o/kite is already the Forerunner project "Kite club", which is
   not on this computer; last active on GitHub on 3 Nov. Work on it together, or take it over if
   nobody works on it any more.' Work together makes the project here with that id (read from
   the repository at the press, never from the model or the request beyond matching it), the
   marker's name unless one here has it, and `settings.together`; nothing is written to GitHub
   then or later by that project: no marker, no doc set, no scaffold, intake or status pull
   request (its status stays in the app: 'Kept in the app: you work on "Kite club" together, so
   GitHub's copy is left as it is.'), its first plan is plan-only, and it never lists, pushes to
   or comments on the other Forerunner's pull requests; each install keeps its own tasks and
   merges its own. A removed together project comes back as the same row.
7. **Take it over only when nobody else works on it**: no pull request carrying one of its marks
   (open, merged or closed) was updated by another GitHub account in the last 14 days
   (`ACTIVE_ELSEWHERE_DAYS`; the person's own account never blocks it). Otherwise the offer says
   'another GitHub account worked on it on 8 Nov. One repository is one project, so work on it
   together here.' (several ids: '... so link another repository.'), with no Take it over. A
   take-over records `settings.took_over` {projects, name, at}; the project's next docs pull
   request (the scaffold's or the intake's set) replaces exactly that marker
   (`writeInstallMarker(..., {replace})`, status `replaced`) and its body says so in one line
   ('This repository was the Forerunner project "Kite club"; it is now "Kites"'s.'); any other
   project's marker is never overwritten. A marker naming the person's own removed project frees
   the repository the same way (`removed: true`). Nothing of the other project's on GitHub is
   pushed to, commented on, closed or listed.
8. **An existing project whose repository is another Forerunner's** (made before this rule, or
   while GitHub could not be read) gets one Overview line and no card: 'o/kite is also the
   Forerunner project "Kite club", which is not on this computer.' with Take it over and its
   consequence line, read from this computer's copy of the default branch (a file, no GitHub
   call); the 14-day rule reads the pull request marks once in five minutes and never waits more
   than four seconds (the press reads anew). With another account's activity the line says
   '; another GitHub account worked on it on 8 Nov.' and has no button. A together project's
   line is 'Shared on GitHub with another Forerunner: each keeps its own tasks.' with Details.
   Take it over runs the new command `repo.take_over`: medium risk for every actor (the press is
   the yes; chat reads it back with Yes and No), refused for an agent acting on its own ('Only
   you can take over a repository.'), checked against GitHub at the plan and again at the run,
   one change row 'Took over o/kite from "Kite club".', and the scaffold run again so the
   project's docs pull request carries its marker. Its Undo removes `took_over` (the line comes
   back) while that pull request does not exist; it is refused with 'Its pull request on GitHub
   already names this project: close it there first.' while it is open, 'The repository already
   names this project on GitHub, so this cannot be undone here.' once it merged, and while
   GitHub cannot be read.
9. **GitHub that cannot be read** at creation skips the repository's own check without a word
   (the one fail-open place: creation never waits on GitHub's answer, and the Overview's line
   appears once the copy shows another marker); Work together and Take it over need GitHub's
   answer and are refused ('GitHub did not answer, so the project cannot be checked. Try
   again.').
10. **W15-01 through the index** (OR-10): an unmarked status or scaffold pull request is a
    project's only when the index says it is the repository's only user, a together project is
    never its sole user, and this computer's copy's marker names no other project
    (`ownsUnmarkedDocs`, fails closed). The Docs row of a status kept in the app says why:
    'Kept in the app while "A"'s status pull request is open on GitHub.' (unmarked: '... another
    status pull request ...; close it there to have this one's there.').
11. **Repository text is data**: the marker and pull request bodies are parsed strictly (schema
    1, a URI-encoded mark), a marker's name is cut at 60 characters, control characters removed,
    passed through the injection scan (flagged: "another Forerunner project") and quoted; a
    command answer, refusal or read-back that quotes it carries the untrusted mark
    (`CommandOutcome.untrusted`, `ChangeCard.untrusted`), so the chat model gets it inside the
    data envelope and the rest of the turn reads every change back (ADR 0114).

## Consequences

- No new project can share a repository or a folder with another project on this computer; two
  installs share one by working together, as one project id with its own tasks on each.
- Tests and fixtures that made a second project on one repository through the API now make the
  pair through the store (`pairBeforeTheRule` in the real-daemon suite): they test what
  installs made before this version still have, which d1109-onerepo-join makes one project.
- The model's definition of `project.create` says one repository is one project and to offer
  the project that uses it; `repo.take_over` is a new tool (the chat's tool list changes).
- Command names may join two words with an underscore (`repo.take_over`; its tool name is
  `repo_take_over`).
- Chat cannot work together yet (OR-15's cut line): its answer ends 'Open New project to work
  on it together.'
- The repository's GitHub id (rename and transfer) is not used yet (OR-12's cut line): a renamed
  repository is a new key until the project's link is updated.
- The intake's docs branch is still named by the project id the creation gave
  (`fr/intake-<id>-docs`); a together project writes none.

## Alternatives considered

- **Refuse a second Forerunner outright.** The owner asked that two people work in one git
  seamlessly (D9).
- **Take it over first.** A take-over replaces another Forerunner's marker on GitHub; offered
  first it would be the click that breaks a colleague's install. Work together writes nothing.
- **Hold the second project until joined, instead of an Overview line.** Kept as the alternative
  of d1109-onerepo-join's owner question; this decision shows, never blocks, a project made
  before the rule.
- **Ask GitHub for every card read.** Home reads every project's card; the copy's marker is a
  file, and only a marker naming a project elsewhere asks GitHub, cached.
- **Fail closed when GitHub cannot be read at creation.** A person offline could not make a
  project; the Overview's line catches the case later.
