# Update log

Every problem found in a released version of Forerunner, what will be done about it, and where it
stands. Each entry says what you see first, then the cause and the fix for maintainers.

## How this log works

- **One ID per problem.** IDs are `U-001`, `U-002` and so on, in the order problems are found,
  and are never reused.
- **Status** is one of:
  - `open`: found and logged, not fixed yet. The entry says what will be done.
  - `fixed`: fixed and verified on the development branch, not in a published version yet.
  - `released x.y.z`: in that published version.
  - `won't fix`: with the reason.
- **Fixed needs evidence.** An entry moves to `fixed` only with:
  - the commits;
  - the test that failed before the fix and passes after it;
  - the CI runs that passed.
- **Commits name the issue.** A commit that works on an issue puts its ID in the subject, for
  example `ui: the start dialog opens the session it started (U-003)`.
- **Releases are batches.** Fixes collect on the development branch
  (`claude/optimistic-einstein-zj5xx2`) and under `## [Unreleased]` in `CHANGELOG.md`. A release
  is cut only when the owner asks for one. Then:
  - `scripts/release-version.mjs --set x.y.z` sets the version;
  - the `[Unreleased]` entries become the `[x.y.z]` section;
  - the batch's entries here become `released x.y.z`.
- **The download matches a release.** The default branch (`claude/forerunner-1-0-build-o53s04`,
  what "Download ZIP" gives) moves only when a release is published, so it never carries
  unreleased changes under a released version number.

## Current version

- Released: **1.0.3** (2026-10-30), with U-003 to U-011.
- Next release: not scheduled. U-012 to U-016 are open.

## Open and fixed, not released

| ID | Found | What you see | Action | Status |
| --- | --- | --- | --- | --- |
| U-013 | 2026-10-30, 1.0.3 | After clicking Claim on tasks, every session says "Nothing to plan: no task is ready"; the tasks stay claimed forever. | People cannot claim (the button is gone, the service refuses it); a session puts claimed tasks nobody holds, and lapsed claims, back to ready before it plans. | open: fix on `claude/wizardly-planck-gzi0u5`, CI not run yet |
| U-014 | 2026-10-30, 1.0.3 | A planned task fails at once, spending nothing: "specialist ops is not in the registry". | The plan's informal names ("ops", "writer", "data analyst") run the registry entry they mean; the planner's prompts list the exact names; a name that means none waits for you and lists the names instead of failing. | open: fix on `claude/wizardly-planck-gzi0u5`, CI not run yet |
| U-015 | 2026-10-30, 1.0.3 | In Chat, "add a task: …" (what the app suggests) is not understood without a model for Chat. | The phrase creates a ready task. | open: fix on `claude/wizardly-planck-gzi0u5`, CI not run yet |
| U-016 | 2026-10-30, 1.0.3 | "Make this a task" in Chat makes a draft, which no session works on. | It makes a ready task (ADR 0093). | open: fix on `claude/wizardly-planck-gzi0u5`, CI not run yet |
| U-012 | 2026-10-30, 1.0.2 | (Release checks.) The Windows installed-app check called its install folders read-only; on the hosted runner they never were, so a Windows-only read-only problem would not be caught. | Run the Windows self-test as a standard (non-administrator) local user, so Program Files is read-only for it as it is for people. Until then the read-only fallback is checked on Linux and in unit tests. | open |

### U-013 A task a person claims is never worked on

- **Found:** 2026-10-30 in 1.0.3, by the owner: "I get the message that there is no task to do,
  even though I claimed a bunch of tasks".
- **What happens:** the Tasks tab offered every move of the workflow graph, Claim and Start
  included. A claim is an agent's lock (spec §347): the agent's id in `claimed_by`, an expiry,
  renewals while it works. The button only moved the status to `claimed`, with no holder and
  no expiry. A session plans only `ready` tasks, so it ended with "Nothing to plan", and the
  expiry sweep needs a holder and an expiry, so nothing put the task back. The sweep
  (`expireClaims`) was also never called outside tests, so a crashed session's claim never
  lapsed either.
- **Action:**
  - `TaskRepo.transition` refuses a person's move to `claimed` or `in_progress`
    (`AGENT_ONLY_STATUSES`); the app offers only the moves a person may make
    (`humanTransitions`).
  - `expireClaims` also returns a `claimed` task nobody holds to `ready`, and the session runs
    it before it plans (event `task.claims_released`), so rows 1.0.3 left behind recover on the
    next session.
  - Tests: `packages/state/test/suite.ts` ("a person cannot move a task to claimed ..."),
    `packages/runtime/test/session-stuck-claims.test.ts`, `apps/ui/test/tasks.test.tsx`; each
    fails without the fix.
- **Status:** open: fixed on `claude/wizardly-planck-gzi0u5`, CI not run yet.

### U-014 Planned tasks fail with "specialist ops is not in the registry"

- **Found:** 2026-10-30 in 1.0.3, by the owner, in a session's log: "Finished task: failed
  (0.00 USD). specialist ops is not in the registry".
- **What happens:** the project manager's prompt listed the specialists by informal names
  (ops, writer, data analyst, science evaluator, migration specialist), and the intake prompt
  named none. The registry's entries are `ops-deploy`, `writer-marketing`, `data-analyst`,
  `science-evaluator`, `migration-specialist`. Plans stored whatever name the model wrote, and
  the executor threw on a name it did not have, so the task failed, and failed again when marked
  ready.
- **Action:**
  - `canonicalSpecialistName` (`packages/runtime/src/registry/specialist-names.ts`) maps the
    informal names; plans store the registry name, and the executor resolves the name of a task
    planned before, then records the resolved one on the task.
  - A name that means no entry ends the task `needs_human` with the registry's names, nothing
    run, instead of `failed`.
  - The PM prompt (`project-manager` 1.0.1) and the intake prompt list the exact names.
  - Tests: `packages/runtime/test/executor-specialist-names.test.ts`, the updated case in
    `executor.test.ts`.
- **Status:** open: fixed on `claude/wizardly-planck-gzi0u5`, CI not run yet. The registry
  prompt change must also go to `forerunner-registry` (`scripts/sync-registry.ts --apply`).

### U-015 "add a task: …" in Chat is not understood

- **Found:** 2026-10-30, while looking into U-013. The Start dialog and the session summary
  (U-009) tell people to say it in Chat.
- **What happens:** the intent parser had no pattern for it; without a model for Chat the
  answer is "I did not understand".
- **Action:** "add a task: …", "create a [new] task: …", "new task: …" and "neue Aufgabe: …"
  create a `ready` task (`intent.test.ts`).
- **Status:** open: fixed on `claude/wizardly-planck-gzi0u5`, CI not run yet.

### U-016 "Make this a task" makes a task no session works on

- **Found:** 2026-10-30, while looking into U-013; the owner decided the action.
- **What happens:** the Chat button and the phrase created a `draft` task (spec J.1). Sessions
  plan only `ready` tasks, so it waited until someone clicked Mark ready on the Tasks tab.
- **Action:** both create a `ready` task (ADR 0093). Tests: `intent.test.ts`,
  `conversation.test.ts`, `apps/ui/test/chat.test.tsx`.
- **Status:** open: fixed on `claude/wizardly-planck-gzi0u5`, CI not run yet.

### U-012 The Windows installed-app check cannot make a folder read-only

- **Found:** 2026-10-30, while verifying U-011.
- **What happened:** for 1.0.2 the Windows check denied the job's user write access to each
  install folder, and the CHANGELOG and docs called those folders read-only.
  - On the hosted runner they never were. Its administrator account still created files after
    a deny entry (desktop run 41094877855) and after a read-and-run-only ACL (run 41101161788).
  - Nothing showed it before U-011, because nothing wrote into the install folder.
  - Resetting that ACL failed on thousands of files ("Access is denied"), so every later
    uninstall and install failed with error 1603.
- **What is still covered:**
  - the fallback code is the same on every platform;
  - it runs for real on Linux: the `.deb` in `/usr/lib`, `EACCES`, the data folder with the
    note;
  - `dependencies.test.ts` covers it as well.
- **What is not covered:** a Windows-only reason a read-only install folder could misbehave.
- **Action:** run the Windows self-test as a standard local user (created for the job, with
  write access to its data folder only), so Program Files is read-only for it as it is for
  people. The check no longer locks folders; it checks that dependencies go to
  `<install>\dependencies` (commit after 752b788).
- **Status:** open.

## Released

| ID | What you saw | Released in |
| --- | --- | --- |
| U-001 | The 1.0.0 app attached to an old 0.1.0 service ("GET /me does not match the contract: desktopDeviceId"). Setup needed PowerShell and a source checkout. | 1.0.1: the installers carry the service; keys are pasted into the app (ADR 0092). |
| U-002 | 1.0.1 on Windows: "The Forerunner daemon did not start: fr daemon exited with code 1", wherever it was installed. | 1.0.2: the app passes Node plain paths, and every installer is installed and started in CI before it is published. |
| U-003 | Start session: "daemon response for POST /sessions does not match the contract: id … agentId … agentName …" | 1.0.3: the service answers with the session it started; the dialog opens it or says it is queued. |
| U-004 | Project page, Next session: "Route not available on this daemon … GET /projects/:id/queue" | 1.0.3: the service serves the next-session queue. |
| U-005 | Project page, Docs tab: "Route not available on this daemon … GET /projects/:id/docs" | 1.0.3: the service lists and opens the project's docs. |
| U-006 | Project page, Data tab, Import: fails; the screen calls a route the service does not have | 1.0.3: the Data tab uses the service's import. |
| U-007 | "Route not available" says "Check Updates for a newer version" even when no version has the feature | 1.0.3: the message no longer sends you to Updates. |
| U-008 | (Cause of U-003 to U-006.) The app's screen tests run against a stand-in service that drifted from the real one, so they passed while the real app failed. | 1.0.3: a test runs the app's client against the real service. |
| U-009 | A session ends as soon as it starts and spends nothing, without saying why | 1.0.3: the Start dialog and the summary say when no task is ready and how to add work. |
| U-010 | Moving a task or editing a milestone always asks for a reason, and nothing happens until you type one | 1.0.3: the reason is optional; an empty one records what changed. |
| U-011 | The GPU voice install (about 8 GB) always goes to `C:\Users\<you>\AppData\Local\forerunner\data\voice`, even when Forerunner is installed on another drive whose space was the point | 1.0.3: dependencies go to `<install folder>\dependencies`, with pip's cache and temporary files. |

### U-003 Starting a session reports a contract error

- **Found:** 2026-10-30 in 1.0.2, by the owner, in the Start session dialog.
- **What happens:** the dialog shows the error and stays open. The request itself was accepted:
  the session started, or was queued behind one already running. Clicking Start again queues
  another start.
- **Cause:** `POST /sessions` answers `202 { result: "started" | "queued" | "deferred" }`. The
  dialog parses the answer as a session (`SessionView`: `id`, `agentId`, `agentName`, …) to open
  it. The UI's test stand-in (`apps/ui/test/fake-daemon.ts`) answers with a session, so the UI
  tests passed.
- **Action:** `POST /sessions` keeps `202` and `result`, and adds the start's id and, once the
  run has created it, the session. The dialog opens the session, or says the start is queued or
  deferred.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commits d64d0ec, ce13027. Test: `apps/ui/test/real-daemon.test.ts` "start session" failed before the fix with the owner's exact message and passes; `daemon.test.ts` checks the start answer and the kill switch's refusal; `project.test.tsx` the queued notice. CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-004 Next session queue: route not available

- **Found:** 2026-10-30 in 1.0.2, by the owner, on a project page.
- **What happens:** the Next session panel shows "Route not available on this daemon". Items
  still reach the queue (from chat and from an approved plan), and the agent still reads them;
  the panel cannot list, add or dismiss them.
- **Cause:** the screen was built against proposed routes (`PROPOSED_ROUTES` in
  `apps/ui/src/api/contracts.ts`, ADR 0032) that the local service never got:
  - `GET /projects/:id/queue?status=`;
  - `POST /projects/:id/queue`;
  - `POST /queue/:id/dismiss`.

  The store has the queue (`store.queue`).
- **Action:** the service serves the three routes over `store.queue`.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commit d64d0ec. Test: `real-daemon.test.ts` "next-session queue" failed before (404) and passes; `queue-docs-routes.test.ts` covers another human's item, a second dismissal and a bad filter. CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-005 Docs tab: route not available

- **Found:** 2026-10-30 in 1.0.2, while looking into U-004.
- **What happens:** the Docs tab shows "Route not available on this daemon". The docs are still
  written: to the project's repository as a pull request, or to the project's folder.
- **Cause:** as U-004. `GET /projects/:id/docs` and `GET /projects/:id/docs/:path` are proposed
  routes the service never got.
- **Action:** the service lists the project's standard docs and returns one doc's text.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commit d64d0ec. Test: `real-daemon.test.ts` "docs" failed before (404) and passes; `queue-docs-routes.test.ts` covers drift, the decisions folder and paths outside the set. CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-006 Data tab: Import calls a route the service does not have

- **Found:** 2026-10-30 in 1.0.2, while looking into U-004.
- **What happens:** Import on the Data tab fails.
- **Cause:** the screen posts to the proposed `POST /projects/:id/import { source, locator }`.
  The service has `POST /projects/:id/data/import` with a different body and answer.
- **Action:** the screen calls the service's import and shows its answer.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commits d64d0ec, ce13027. Test: `real-daemon.test.ts` "data import" failed before (404) and passes; `project-tabs.test.tsx` and the Playwright data spec read the daemon's answer. CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-007 The "Route not available" message points to Updates

- **Found:** 2026-10-30 in 1.0.2, by the owner.
- **What happens:** the message says "Check Updates for a newer version". No newer version has
  these routes, so the advice sends you looking for an update that does not exist.
- **Action:** the message says this part is not in this version of Forerunner yet. It no longer
  sends you to Updates.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commit 8f90e41. Test: `memory.test.tsx` checks the new text and that it names no Updates; added with the fix (the old text named it). CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-008 The UI's tests use a stand-in that drifted from the real service

- **Found:** 2026-10-30, as the cause of U-003 to U-006.
- **Cause:** the screen tests run against `apps/ui/test/fake-daemon.ts`. It answers the proposed
  routes and returns a session from `POST /sessions`. No test ran the UI's client against the
  real service.
- **Action:** a test composes the real runtime, runs the UI's own client (`createClient`)
  against it and parses every answer with the UI's schemas. It covers:
  - the flows of U-003 to U-006;
  - the read calls of every screen.

  It must fail on the current code and pass after the fixes. Any further mismatch it finds is
  logged here as its own entry.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commit d64d0ec. Test: `real-daemon.test.ts` failed 5 of 5 before the fixes and passes 5 of 5; its read sweep covers 43 calls of the screens. CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-009 A session with no ready task ends at once and does not say why

- **Found:** 2026-10-30 in 1.0.2, by the owner: "as soon as I start a session it just ends,
  spending no money".
- **What happens:** a session works only on the project's tasks with status `ready` (the
  daemon's planner, `StaticPlanner`). A project created without a brief, or whose plan is still
  waiting for approval in the Inbox, has none. The session plans nothing, ends `completed` and
  spends $0.00. Its summary says "Nothing to plan: no task is ready." but not what to do.
- **Ways to give a project work today:**
  - Tasks tab → New task;
  - in Chat, "add a task: …";
  - approving the plan in the Inbox, when the project was created with a brief.
- **Action:**
  - the Start dialog checks the project's ready tasks when it opens, and says when there are
    none and how to add work;
  - the summary of a session that found no ready task says the same.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commit d64d0ec. Test: `project.test.tsx` "warns before a start that no task is ready", added with the fix (the old dialog had no check); the summary text is in `runner.ts`, still matched by `closeout-autonomy.test.ts`. CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-010 A reason is required for every task move and milestone edit

- **Found:** 2026-10-30 in 1.0.2, by the owner: "it always requires a reason. What is the
  purpose of that?"
- **Why the reason exists:** spec requirement B.5, "every change to plan, task or milestone is
  versioned with author and reason". The reason is stored on the row and in the change log,
  and the agent reads it in its next session's brief (why a task was cancelled or put back).
  The daemon refuses a change without one (`TransitionTaskBody`, `ChangeMilestoneBody`).
- **What happens:** the Tasks tab's move dialog and the Plan tab's milestone dialog keep
  Confirm and Save disabled until a reason is typed, even for a routine move.
- **Action:**
  - the field is optional in both dialogs;
  - left empty, the app sends a reason that says what changed, for example "Marked ready in
    the app" or "Milestone edited in the app";
  - a typed reason is sent as it is.

  The daemon and B.5 are unchanged: every change still carries a reason and its author.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commit 155c568. Test: `tasks.test.tsx` and `project-tabs.test.tsx` move a task and edit a milestone with no reason and check the reason sent; added with the fix (the old dialogs kept Confirm and Save disabled). CI 41091558763 (on 968cce7) and 41105628591 (on 42d3468), both OS; desktop 41105634630 (installers built and started, Playwright 30 passed, both OS).

### U-011 Voice always installs on C:

- **Found:** 2026-10-30 in 1.0.2, by the owner, who installed Forerunner on D: and saw the GPU
  voice install go to `C:\Users\Domino\AppData\Local\forerunner\data\voice\venv-gpu`.
- **Why it goes there:**
  - Everything the app writes goes to the data folder (`appDirs()`: `%LOCALAPPDATA%\forerunner`
    on Windows), never to the install folder.
  - The install folder can be read-only (Program Files), and an update or an uninstall
    replaces it, which would delete 8 GB of voice packages with it.
  - `voiceDirs()` puts the packages and models under `<data>\voice`.
  - The only override is `FORERUNNER_HOME`, which moves all of the app's folders at once
    (settings, data, logs). After that the app starts as a new install.
- **What is wrong:** someone who installs on D: to keep C: free has no way to put the largest
  download on D: too.
- **Owner's decision (2026-10-30):** "dependencies by default being stored in the same folder,
  in a dedicated subfolder, as the install. My C drive was full."
- **Action:**
  - Downloaded dependencies go into `<install folder>\dependencies` by default, for example
    `D:\AGENT\Forerunner\dependencies\voice` for the voice packages and models.
  - pip's download cache and its temporary files (a GPU install unpacks several GB) go there
    too, so a full C: no longer stops the install.
  - The data folder is used only when the install folder cannot be written (Program Files
    for a normal user, `/usr/lib` and the AppImage on Linux), and Settings → Voice says why.
  - `FORERUNNER_DEPENDENCIES_DIR` overrides both.
  - An existing install keeps working where `voice.json` recorded it. A new install into the
    new folder removes the old copy once the new one is verified.
  - Settings → Voice shows the folder.
- **Status:** released 1.0.3 (2026-10-30).
- **Evidence:** Commits c939a1e, 752b788, 42d3468. Test: `dependencies.test.ts` (8), `settings-voice.test.tsx`; added with the fix. Installed apps, desktop run 41105634630: Windows Program Files, `D:\AGENT\Forerunner`, `D:\My Apps\Forerünner Ä`, the long path, a share and a mapped drive all put voice in `<install>\dependencies\voice`; the Linux `.deb` falls back to the data folder with the note (`EACCES` in `/usr/lib`); the AppImage uses `Forerunner-dependencies` beside it. CI 41094872029 (on c939a1e, attempt 2) and 41105628591, both OS. The Windows read-only case is U-012.
