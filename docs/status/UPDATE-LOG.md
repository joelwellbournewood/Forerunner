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

- Released: **1.0.2** (2026-10-30).
- Next release: not scheduled. The open and fixed entries below are its candidates.

## Open and fixed, not released

| ID | Found | What you see | Action | Status |
| --- | --- | --- | --- | --- |
| U-003 | 2026-10-30, 1.0.2 | Start session: "daemon response for POST /sessions does not match the contract: id … agentId … agentName …" | The service answers with the session it started, or says it is queued; the dialog opens the session or says why it waits. | open |
| U-004 | 2026-10-30, 1.0.2 | Project page, Next session: "Route not available on this daemon … GET /projects/:id/queue" | The service serves the next-session queue: list, add, dismiss. | open |
| U-005 | 2026-10-30, 1.0.2 | Project page, Docs tab: "Route not available on this daemon … GET /projects/:id/docs" | The service lists the project's docs and returns one doc to read. | open |
| U-006 | 2026-10-30, 1.0.2 | Project page, Data tab, Import: fails; the screen calls a route the service does not have | The screen uses the import the service has. | open |
| U-007 | 2026-10-30, 1.0.2 | "Route not available" says "Check Updates for a newer version" even when no version has the feature | The message says the feature is not in this version yet, without sending you to Updates. | open |
| U-008 | 2026-10-30, 1.0.2 | (Cause of U-003 to U-006.) The app's screen tests run against a stand-in service that drifted from the real one, so they passed while the real app failed. | A test runs the app's own client against the real service for these screens and for the read calls of every screen. | open |
| U-009 | 2026-10-30, 1.0.2 | A session ends as soon as it starts and spends nothing, without saying why | The Start dialog says beforehand when no task is ready and how to give the agent work; the session's summary says the same. | open |
| U-010 | 2026-10-30, 1.0.2 | Moving a task or editing a milestone always asks for a reason, and nothing happens until you type one | The reason becomes optional. Left empty, the app records one for you (what changed, from the app), so the history the agent reads stays complete. | open |
| U-011 | 2026-10-30, 1.0.2 | The GPU voice install (about 8 GB) always goes to `C:\Users\<you>\AppData\Local\forerunner\data\voice`, even when Forerunner is installed on another drive | Proposed: Settings → Voice lets you choose the folder for voice (default unchanged), for example on the drive Forerunner is installed on. Waiting for the owner's go-ahead. | open |

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
- **Status:** open.

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
- **Status:** open.

### U-005 Docs tab: route not available

- **Found:** 2026-10-30 in 1.0.2, while looking into U-004.
- **What happens:** the Docs tab shows "Route not available on this daemon". The docs are still
  written: to the project's repository as a pull request, or to the project's folder.
- **Cause:** as U-004. `GET /projects/:id/docs` and `GET /projects/:id/docs/:path` are proposed
  routes the service never got.
- **Action:** the service lists the project's standard docs and returns one doc's text.
- **Status:** open.

### U-006 Data tab: Import calls a route the service does not have

- **Found:** 2026-10-30 in 1.0.2, while looking into U-004.
- **What happens:** Import on the Data tab fails.
- **Cause:** the screen posts to the proposed `POST /projects/:id/import { source, locator }`.
  The service has `POST /projects/:id/data/import` with a different body and answer.
- **Action:** the screen calls the service's import and shows its answer.
- **Status:** open.

### U-007 The "Route not available" message points to Updates

- **Found:** 2026-10-30 in 1.0.2, by the owner.
- **What happens:** the message says "Check Updates for a newer version". No newer version has
  these routes, so the advice sends you looking for an update that does not exist.
- **Action:** the message says this part is not in this version of Forerunner yet. It no longer
  sends you to Updates.
- **Status:** open.

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
- **Status:** open.

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
- **Status:** open.

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
- **Status:** open.

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
- **Proposed action (not started; waits for the owner):**
  - Settings → Voice gets a "Voice folder" choice before an install, kept in `voice.json`;
  - the default stays `<data>\voice`;
  - a folder inside the install folder is refused, with the reason;
  - switching folders moves or reinstalls the packages.
- **Status:** open.

## Released

| ID | What you saw | Released in |
| --- | --- | --- |
| U-001 | The 1.0.0 app attached to an old 0.1.0 service ("GET /me does not match the contract: desktopDeviceId"). Setup needed PowerShell and a source checkout. | 1.0.1: the installers carry the service; keys are pasted into the app (ADR 0092). |
| U-002 | 1.0.1 on Windows: "The Forerunner daemon did not start: fr daemon exited with code 1", wherever it was installed. | 1.0.2: the app passes Node plain paths, and every installer is installed and started in CI before it is published. |
