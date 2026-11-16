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
   `plan_only` and its approval writes tasks only. Such a card names no place documents go (no
   `docs_target`; the intake's answer has `docsTarget` null), so the Inbox's total line is the
   cost alone, never "the docs go to the project's repository as a pull request". An open plan
   answers 'A plan for "Site" waits for your answer. Answer it first.'
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
   back) while that pull request does not exist. It is refused while that pull request is open,
   once it merged, and while GitHub cannot be read, each reason a fragment the screens complete
   as every command's Undo refusal is: Changes reads 'Cannot be undone now: its pull request on
   GitHub already names this project. Close it there first.', 'Cannot be undone now: the
   repository already names this project on GitHub.' and 'Cannot be undone now: GitHub did not
   answer, so the repository cannot be checked. Try again.'
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

## Amendment 2026-11-16: Make one project (d1109-onerepo-join, run C sub-run C4)

The owner's words for it (D1, 2026-11-09): "There should not be 2 projects in one repo. If there
are multiple people and agents, and even if they are working on different parts of a bigger
project, they should be working on one project. Make it such that multiple projects are not done
on one repo, in an intelligent way." Projects that already share a repository or folder on this
computer (made before this decision, or by a bench) become one when the person chooses which to
keep.

1. **Shown, not stopped.** Each project of such a set has one Overview line, '"Site" and "Kite
   club" both work in o/site.' (the oldest project's spelling, so every Overview says the same),
   with Make one project and its line 'You choose which to keep; the other's tasks, plan and
   cards move into it.' (`ProjectCard.sharesRepositoryWith`, `join-preview.ts` `sharedLinkOf`
   through this decision's index). Both keep working meanwhile; W15-01 keeps their pull requests
   apart. The owner question (hold the newer project's sessions until joined) is not decided:
   nothing is held.
2. **The dialog** (`GET /projects/:id/join-preview`, `JoinProjectsDialog`) lists each project
   with its open and done tasks, open pull requests, spent so far in CHF, budget per session,
   project budget, who merges (a repository project) and what research reads. No project is
   chosen at first; Make one project stays disabled until one is, and while something holds the
   join (its sentence shows). Each setting of the kept project that differs has its line ('Who
   merges: "Site"'s setting applies to the moved work: you press Merge.'). The press is the yes
   (`project.join`, source ui, medium risk); chat reads it back with one question ('Make one
   project: move the tasks, plan and cards of "Kite club" into "Site"? Changes has its Undo.').
3. **What moves, in one store transaction** (`packages/commands/src/commands/project-join.ts`,
   SQLite and Postgres through the one store API): the closing project's tasks of every status
   (ids, dependencies, branches and `pr_url` kept), its milestones after the kept project's
   (`order_index` offset, a reason on each), the cards about its tasks and its open cards, its
   queued notes, merge records, decisions and accepted source proposals; its data assets add the
   kept project. What stays on the closed project, readable: its sessions, its cost-ledger rows
   (the truth the caps are measured on, never rewritten), its changes, its chat, its lessons and
   its answered project cards. The closed project is archived with `joined_into {project, name,
   at}`, never renamed or deleted; its `repos` is emptied and kept as `was_linked`; the kept
   project's `joined_from` gains its id, so `projectIdsOf` (this decision's docs paths, the pull
   request list) reads the closed project's status, scaffold and intake docs pull requests as the
   kept one's (one status pull request again), and its task pull requests merge from the kept
   project's Overview. Nothing on GitHub is edited.
4. **Refused in words, nothing moved**, while: a session works on either project ('A session is
   working on "Kite club". Make one project when it ends.'); the plan of either is being drafted;
   a session of either waits to go on after its Claude credential or a Start is kept for the
   reset ('A session of "Kite club" waits to go on at 15:40. Make one project after it ran, or
   cancel it first.', read through d1109-starts-engine's `keptContinuationOf` and `keptStartOf`
   with the time `continuations.waiting` names); a hands-off start is held ('A session of "Kite
   club" waits to start by itself. ...'); a closing project's plan waits for its answer ('The
   plan of "Kite club" waits for your answer. Answer it first.'); one of its merges is under way
   ('A pull request of "Kite club" is being merged. Try again in a minute.'); the projects share
   no repository or folder; a project is not the person's own ('Only your own projects can be
   made one.'); a project was removed or joined before.
5. **Money**: no cap, budget or ledger row changes; the kept project's cap keeps measuring its
   own ledger; the kept project's Costs says 'Spent in "Kite club" before it joined: CHF 3.20'
   (`CostView.joinedSpend`), and its Sessions list ends with '"Kite club" had 3 sessions before it
   joined.' with Open (ADR 0116 amended).
6. **The closed project's page** reads 'Joined into "Site" on 9 Nov.' with Open it (project
   status's first rule, `ProjectCard.joinedInto`), offers no start, plan or repository, and never
   says 'This project was removed.'; its sessions, changes, costs and chat answer. It starts
   nothing ('"Kite club" joined "Site", so its work runs there.'), leaves Home (only active
   projects are listed), counts as the kept project in the index (decision 2), and its own old
   changes say where it went instead of an Undo ('Cannot be undone now: "Kite club" joined
   "Site".'). The kept project's Overview says 'Includes the work of "Kite club".' linking to it;
   its creation cannot be undone while it includes another project's work ('Cannot be undone
   now: this project includes the work of "Kite club".'). Chat's recall in the kept project
   reads the closed project's records too (`scope.ts` `withJoined`), each hit named as the closed
   project's.
7. **Undo** (Changes, also after a restart) moves every moved row back, and the cards and merge
   records made on the kept project since for a moved task (a moved task merged from the kept
   project since goes back still merged with its record); reopens the closed project with its
   link and drops it from `joined_from`. Refused while a session runs on the kept project ('a
   session is working on "Site". Undo when it ends'), while a moved task's merge is under way,
   and while a task of the kept project that was not moved waits for a moved one ('"Shop page"
   waits for "Cart", which came from "Kite club": change that first'), or the other way round:
   Undo never leaves a dependency across two projects.
8. **Archiving is used only for a join** here: W5-40 (removing a project: none, archive or
   delete) stays open for every other case.

Consequences of the amendment:

- Lessons are not moved: a lesson's file is canonical (ADR 0002) and carries its project, so
  moving the index row alone would be undone by the next mirror; the closed project's lessons
  stay its own and chat's recall in the kept project reads them through `withJoined`. Sessions
  of the kept project do not get them in their memory yet.
- A GitHub that hangs is now bounded (C2-left-10): `GitHubHost` gives every request a timeout
  (30 s) and the link check waits on GitHub at most 8 s (`READ_WAIT_MS`), after which the read
  counts as failed (decision 9's rule: creation goes on, Work together and Take it over are
  refused). A pull request whose author GitHub does not name counts as another account's
  (decision 6: no Take it over on it within the 14 days).
- A marker's name is scanned as written and once cleaned (C2-left-9): a role line after a line
  break no longer loses its match when the break becomes a space; the injection suite covers
  this channel (`record.where: "repo_marker"`, record-008 to record-010, controls record-103 and
  record-104).
- `project_join` is a new chat tool (the tool list grows by one definition on every turn).
