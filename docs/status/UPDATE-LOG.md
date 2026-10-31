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
- **Check in the app.** Every entry has a line saying what a person does to see the fix
  (where to click, what should happen). The owner walks these before a release; a test should
  do the same steps (`docs/maintainers/validation.md`).
- **Fixed needs evidence.** An entry moves to `fixed` only with:
  - the commits;
  - the test that failed before the fix and passes after it;
  - the CI runs that passed.
- **Commits name the issue.** A commit that works on an issue puts its ID in the subject, for
  example `ui: the start dialog opens the session it started (U-003)`.
- **The owner tries a batch before it is released.** The Desktop app workflow run of the
  development branch (Actions → Desktop app → Run workflow) builds the installers; the owner
  installs that build ("Trying a build before it is released" in `docs/setup-guide.md`) and
  checks the batch's fixes. A release is cut only after that.
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

- Released: **1.0.4** (2026-10-30), with U-013 to U-017.
- Next release: not scheduled. U-012, U-018 to U-035 and U-037 to U-077 are open; U-036 is won't fix.

## Open and fixed, not released

| ID | Found | What you see | Action | Status |
| --- | --- | --- | --- | --- |
| U-012 | 2026-10-30, 1.0.2 | (Release checks.) The Windows installed-app check called its install folders read-only; on the hosted runner they never were, so a Windows-only read-only problem would not be caught. | Run the Windows self-test as a standard (non-administrator) local user, so Program Files is read-only for it as it is for people. Until then the read-only fallback is checked on Linux and in unit tests. | open |
| U-018 | 2026-10-31, 1.0.4 | After closing Forerunner, background processes keep running, so the install folder cannot be deleted and the next version cannot be installed over it. | Quit stops the background service and everything it started (asking first when a session is running); closing the window still hides to the tray, and says so the first time; the installer stops what runs from the install folder before it replaces files (ADR 0094). | open |
| U-019 | 2026-10-31, 1.0.4 | "kill switch is active for this agent; resume it first" when starting a session, even after clicking Resume: the kill switch comes back every time the app starts. | Resume removes the kill request file, so a restart no longer applies an old kill again. | open |
| U-020 | 2026-10-31, 1.0.4 | The inbox has no way to mark every message read; each needs its own click. | A "Mark all read" button above the messages. | open |
| U-021 | 2026-10-31, 1.0.4 | Enabling an extension puts an approval in the Inbox whose two buttons both read "[object Object]", and clicking either one denies it; removing the extension leaves the approval behind, so it can appear twice. | The buttons read Approve and Deny and do that, old requests included; removing an extension takes its approval out of the Inbox. | open |
| U-022 | 2026-10-31, 1.0.4 | A task that needs your answers (stack, hosting, repository) is given to a specialist that cannot ask you; it fails up to four times, spending money, and the Inbox then shows a critic sign-off ("approval needed") instead of the questions. | To decide with the owner (see the entry). | open |
| U-023 | 2026-10-31, 1.0.4 | Extensions and Settings overlap: enabling voice-local in Extensions installs nothing (the install is Settings → Voice); the anthropic row switches nothing; the GitHub connector does not say the built-in GitHub works without it. | To decide with the owner (see the entry). | open |
| U-024 | 2026-10-31, 1.0.4 | Installing GPU voice ends with "Unable to open file 'model.bin'" for speech recognition, on the GPU and the CPU, although the download reports "whisper ready"; Talk says voice is not available. | Find the cause with the owner (see the entry); then download the speech model into a plain folder instead of the shared model cache. | open |
| U-025 | 2026-10-31, 1.0.4 | The principal agent is always called "Alice" and there is no way to rename it. | A name field in Settings renames your agent (owner's request). | open |
| U-026 | 2026-10-31, 1.0.4 | Adding an extension yourself in the Extensions panel puts a second, blocking "approval needed" card in the Inbox for what you just did. | To decide with the owner (see the entry). | open |
| U-027 | 2026-10-31, 1.0.4 (sweep) | Approve or Reject on a reviewed task in the phone's Reviews tab does nothing (sign-off cards) or denies (tool approvals); the phone says the session continues. | The answer's `decision` is read like an option click. | open |
| U-028 | 2026-10-31, 1.0.4 (sweep) | Inbox cards whose buttons do nothing: a rebase conflict ("I resolved it", "Drop the branch and retry", "Cancel the task") and a merge ("I merged it"). | Each option does what it says; a test clicks each one. | open |
| U-029 | 2026-10-31, 1.0.4 (sweep) | A medium-risk change from Chat or voice that waits in the Inbox never runs after you answer yes (default local install). | The Inbox answer runs or cancels the change on every install. | open |
| U-030 | 2026-10-31, 1.0.4 (sweep) | Approving or denying an extension in the Extensions panel leaves its Inbox card open; clicking Deny there later does nothing. | Approve and Deny in the panel withdraw the Inbox card. | open |
| U-031 | 2026-10-31, 1.0.4 (sweep) | Answering "do not mirror this project" to GitHub Projects is asked again every 15 minutes. | A no turns the mirror off for that project. | open |
| U-032 | 2026-10-31, 1.0.4 (sweep) | The kill switch comes back after a restart when it was lifted by starting a session from the phone or by a session's Stop button (sibling of U-019). | Every path that lifts the kill switch clears the request file. | open |
| U-033 | 2026-10-31, 1.0.4 (sweep) | A session review that needs your eyes (the summary misstates what was done or spent) never reaches the Inbox. | The request is filed for you, and its options do what they say. | open |
| U-034 | 2026-10-31, 1.0.4 (sweep) | Typing an answer that matches no option on a sign-off, findings, plan, intake, specialist or model watch card closes the card and leaves the task stuck. | An answer the card cannot act on is refused with the options listed; the card stays open. | open |
| U-035 | 2026-10-31, 1.0.4 (sweep) | A model watch recommendation answered on the Updates page leaves its Inbox card open (a click there does nothing), and "remind me" never reminds. | Answering in either place closes both; the reminder is filed when due. | open |
| U-036 | 2026-10-31, 1.0.4 (sweep) | (Suspected.) After the app gives up restarting the service, a stale `restart.json` can make a later restart misjudge a slow service as gone. | Verified: cannot happen (see the entry). | won't fix |
| U-037 | 2026-10-31, 1.0.4 (audit) | [blocks use] In a project without a repository link, specialists can do no file work: every read and write is refused (API key) or lands in an empty folder (subscription); tasks fail and are retried. | Runs in a project without a repository work in the project's workspace folder. | open |
| U-038 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] Items in the next-session queue, notes from Chat ("noted for the next session") and the first-session list approved with the project plan are marked read but never reach the work. | The queue and the approved first session reach the plan and the specialists' briefs. | open |
| U-039 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] Cancel, Mark failed or Needs me on a task that is running ends the whole session as failed; the other planned tasks never start. | A person's move stops that task's run; the session goes on with the rest. | open |
| U-040 | 2026-10-31, 1.0.4 (audit); hands-on | [wrong outcome] "Nothing to plan: no task is ready" while ready tasks exist: a dependency that is cancelled, failed or a typo blocks a task for good, and one large task empties the whole plan when it does not fit the budget. | Dependencies are checked when entered and editable; the planner skips what does not fit; the Start dialog and the summary say which task waits on what. | open |
| U-041 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] New task says "Priority (1 high)" but higher numbers run first. | The label matches the order. | open |
| U-042 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] The budget set on a task is never enforced; the run is capped at the estimate instead, while the Tasks tab shows the budget. | The task's budget is the cap. | open |
| U-043 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] A start that waits behind a running session is silently replaced by the next start request (an approved plan's start, a CI trigger). | Queued starts are kept in order, or the replaced one says so. | open |
| U-044 | 2026-10-31, 1.0.4 (audit) | [spends money] Retries that cannot change anything: "split or change specialist" runs the same specialist again; research specialists lose web access on an API key but are still given research tasks. | Change the specialist when the ladder says so; do not plan web research without web tools. | open |
| U-045 | 2026-10-31, 1.0.4 (audit) | [confusing] When the critic's review itself fails, the task stays "in review" for good, with no card. | The review is retried, or a card asks you. | open |
| U-046 | 2026-10-31, 1.0.4 (audit); hands-on | [confusing] A project setup (intake) that fails is invisible: no card, no error, no retry; the Start dialog says a plan waits in the Inbox. | The project page shows the failure and a Retry. | open |
| U-047 | 2026-10-31, 1.0.4 (hands-on) | [blocks use] Without a Claude key, Chat refuses everything, even "add a task: …" (which needs no model), and says "run fr setup", a command the installed app does not have. | Commands that need no model work; the message points to the setup assistant. | open |
| U-048 | 2026-10-31, 1.0.4 (audit) | [blocks use, suspected] A setup with only a Claude subscription token may fail at the first chat or plan: the token is sent without the header subscription tokens need. | Verify with a subscription-only setup; fix the provider if confirmed. | open |
| U-049 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] A replaced key (a revoked Claude key, an expired GitHub token) is saved but not used until the app restarts, and nothing says so. | Replacing a key takes effect at once (or restarts the service). | open |
| U-050 | 2026-10-31, 1.0.4 (audit) | [blocks use] If the local data folder is lost but the settings folder kept, the service never starts again, and the fix it names is a command the installed app does not have. | The service recreates what it needs and starts. | open |
| U-051 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] The GitHub token check never looks at repository access: a token that reaches no repository passes; the setup guide says it is refused. | The check lists the repositories and their access, and warns. | open |
| U-052 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] The Claude subscription allowance is fixed at USD 50 a month and the app cannot change it; a Max subscriber's tasks stop early. | A Settings field for the allowance. | open |
| U-053 | 2026-10-31, 1.0.4 (audit) | [confusing, shows a secret] A key pasted with a line break inside is shown in full in the error; real network errors lose their cause ("fetch failed"). | Refuse inner line breaks without echoing the key; keep the network cause. | open |
| U-054 | 2026-10-31, 1.0.4 (audit) | [blocks use] The mailbox password and cloud voice keys can only be stored with `fr vault set`, which the installed app does not have. | A field to store each on the Email page and the voice rows. | open |
| U-055 | 2026-10-31, 1.0.4 (audit) | [blocks use] Pair a phone is disabled on a default install, with a reason naming environment variables no guide explains. | Plain steps in the app and the guide, or pairing that works without them. | open |
| U-056 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] Two active projects that disagree: the header's switch changes the app only; Chat keeps using the project last switched by Chat, voice or the phone, so "add a task" lands in the other project. | One active project for every channel. | open |
| U-057 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] Undo skips the confirmation the restored value needs: undoing a lowered monthly cap raises it with one click (raising needs this PC's confirmation). | Undo asks for the confirmation of the value it restores. | open |
| U-058 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] The default autonomy setting is saved but new projects from the app ignore it (always 2). | New projects use it. | open |
| U-059 | 2026-10-31, 1.0.4 (audit) | [confusing] Model settings show choices that do not run: fast mode for planning and chat, fable for a specialist capped at opus. | Hide or explain what does not apply; show the cap. | open |
| U-060 | 2026-10-31, 1.0.4 (audit); hands-on | [confusing] Settings shows only part of the settings: quiet hours, notifications, language, the per-session cap and others can only be changed by Chat and are shown nowhere, while texts point to Settings for them. | Every setting is visible in Settings; pointers name real controls. | open |
| U-061 | 2026-10-31, 1.0.4 (hands-on) | [wrong outcome] Undo in Changes says "Undone" but changes nothing when the undo is impossible; Undo is offered when it cannot work; task moves are not in the change log although the dialog says they are. | Undo says when it cannot; it is offered only when possible; task moves are logged (or the dialog stops saying so). | open |
| U-062 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] Quit during the first start (the splash, up to two minutes) or while the service hangs leaves the service running; opening Forerunner again during Quit can leave one behind too. | Quit ends the process the app started whatever its state; a relaunch during Quit waits and opens a fresh one. | open |
| U-063 | 2026-10-31, 1.0.4 (audit) | [wrong outcome, teams] Quit (now ending the service) releases every agent's task claims on a shared store, other people's included. | Quit releases only your own agents' claims. | open |
| U-064 | 2026-10-31, 1.0.4 (audit) | [wrong outcome, suspected] The app gives the service 1.5 s to answer Quit or the kill switch; a slower answer is treated as a failure (Quit then ends the service hard; the kill switch says it failed when it worked). | A longer time limit for actions. | open |
| U-065 | 2026-10-31, 1.0.4 (audit) | [wrong outcome, suspected] A service that is slow to answer at start gets a second one started beside it on the same data; whichever stops first deletes the other's address file. | One service per data folder (a lock); a slow answer is not "not running". | open |
| U-066 | 2026-10-31, 1.0.4 (audit) | [release check] The Windows installed-app check never runs the new installer step (U-018) against a running Forerunner, and ignores the uninstaller's exit code; the step's folder pattern breaks on an install path with an apostrophe or brackets, and a console window may flash. | The check installs, starts, upgrades and uninstalls with Forerunner running, and checks the result; the step compares paths without wildcards and runs hidden. | open |
| U-067 | 2026-10-31, 1.0.4 (audit) | [confusing] Uninstall leaves `<install>\dependencies` (voice, gigabytes) and the `fr://` link registration. | The uninstaller removes both, or the guide says how. | open |
| U-068 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] Commands run through `cmd /c` (npm, npx, .cmd tools) get `&`, `|`, `%VAR%` in their arguments interpreted, e.g. an MCP server for `D:\R&D\app`. | Escape arguments for cmd. | open |
| U-069 | 2026-10-31, 1.0.4 (audit) | [blocks voice, suspected] The voice install fails in a deep install folder without Windows long paths. | Check the real limit first and fall back to the data folder. | open |
| U-070 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] The update command accepts an installer file as an update; the old version starts, the update rolls back and the release is marked rolled back for everyone sharing the store. | The service refuses installer files as updates. | open |
| U-071 | 2026-10-31, 1.0.4 (hands-on) | [confusing] Status that is wrong: "connected" while the service is gone; a finished session keeps saying "connecting"; a project shows "blocked" with nothing waiting; the Chat conversation is lost on a tab switch, with any Yes/No card in it. | Status follows reality; Chat keeps its conversation. | open |
| U-072 | 2026-10-31, 1.0.4 (audit); hands-on | [confusing] Counts that disagree and results that read as fine: a session whose only task was sent back says "0 done, 0 need you" and grades 85; the log, the notification and the summary count differently. | One set of counts everywhere, including sent back and waiting for review. | open |
| U-073 | 2026-10-31, 1.0.4 (audit); hands-on | [confusing] Inbox cards that do not say what they are about: sign-off cards do not name the task; the project plan's decision document cannot be read before approving. | Every card names its task and project and shows what it asks you to approve. | open |
| U-074 | 2026-10-31, 1.0.4 (audit); hands-on | [confusing] Wording: USD where you entered CHF; raw JSON and ids in logs, Settings and Memory; jargon (tier, ladder, verdict, autonomy 2); app cards that say "reply yes to the email"; "Undo." as plain text; texts that tell you to run `fr` commands. | Plain words, CHF everywhere, no raw ids or JSON, no terminal commands in the app. | open |
| U-075 | 2026-10-31, 1.0.4 (audit) | [confusing] Talk without voice installed says "no STT provider" instead of "install voice in Settings → Voice"; email is set in two places (Extensions and the Email page) that can disagree. | Talk says what to do; one place for email. | open |
| U-076 | 2026-10-31, 1.0.4 (audit) | [wrong outcome] Update and restart, and Roll back, end running sessions without asking; Run evaluations does not show what it will cost. | Ask first while sessions run; show the cost. | open |
| U-077 | 2026-10-31, 1.0.4 (audit); hands-on | [cosmetic and small] The setup name field prefilled with "me"; "never in a file" while the vault fell back to a file; a failed update check still says "not checked yet"; the palette shows ⌘K on Windows; the Cancel dialog's buttons read "Cancel" and "Confirm"; a hidden first-close notice is never shown again; a minimized window reopens at the default place; and other details listed in the entry. | Fix in a batch. | open |

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

### U-018 Background processes keep running after Forerunner is closed

- **Found:** 2026-10-31 in 1.0.4, by the owner: after closing Forerunner the folder cannot be
  deleted and updates fail.
- **What happens:**
  - The window's close button hid the window to the tray; `Forerunner.exe` kept running.
  - Quit in the tray ended the window process only ("Quit (the daemon keeps running)", ADR 0026,
    ADR 0031). The background service (`node.exe` from `<install>\runtime`, and what it
    started) kept running with files in the install folder open.
  - Windows refuses to replace or delete a file a process has open, so deleting the folder and
    installing the next version over it failed.
- **Action (owner's choice, ADR 0094):**
  - Quit stops the service: it asks first when a session is running, ends the sessions, closes
    the service (`POST /shutdown`), and ends the process tree if it does not go within 15 s.
  - The close button still hides to the tray, and the first time it says so in a notification
    ("Quit from the tray to stop it").
  - The Windows installer ends the processes that run from the install folder before it
    checks for files in use, on upgrade and on uninstall
    (`apps/desktop/src-tauri/wix/stop-running.wxs`). This also stops a running 1.0.4.
  - Tests: `packages/runtime/test/shutdown-route.test.ts` (the route stops runs, answers, then
    ends the process, and leaves no kill behind); the shell's `quit_targets`,
    `quit_confirm_text` and `take_first_close_hint` unit tests; `scripts/msi-stop-running.test.ts`
    (the installer step runs before the files-in-use check, only when a version is installed,
    never fails the install, and targets only the install folder). The Windows installed-app
    check in CI runs the installer step on every uninstall.
- **Check in the app:** with 1.0.4 still running, install the test MSI: it installs without a
  "files in use" message. Close the window: a notification says Forerunner is still running
  (once). Start a session, then tray → Quit Forerunner: it asks first; confirm. Task Manager
  shows no `Forerunner.exe` and no `node.exe` from the install folder, and the folder can be
  renamed. Open Forerunner again: it starts normally.
- **Status:** open.

### U-019 The kill switch comes back after every restart

- **Found:** 2026-10-31 in 1.0.4, by the owner: "kill switch is active for this agent; resume it
  first".
- **What happens:** the kill switch (Stop all in the header, the tray, `fr kill`) writes
  `<runtime>\kill.json`, which every runtime reads at start so a kill survives a crash. Resume
  only lifted the kill in the running service and left the file, so the next start (opening the
  app, a restart, an update) read it and stopped everything again. Sessions then refuse to
  start.
- **Action:** Resume removes the file (`POST /kill/resume`, used by the header and the tray).
  Test: `packages/runtime/test/kill-resume-restart.test.ts` fails without the fix.
- **Check in the app:** click Stop all in the header, then Resume. Quit from the tray and open
  Forerunner again. Start a session: it starts, with no "kill switch is active" message.
- **Status:** open.

### U-022 Questions for the person go to a specialist that cannot ask them

- **Found:** 2026-10-31 in 1.0.4, by the owner: "there are some human needs for the test
  project, but I was never asked anything in any structured way".
- **What happens:** the project's plan (made by 1.0.3's project setup, before U-017) holds the
  task "Confirm stack, hosting and repository with the human". A session gives it to a
  specialist (`ops`). Specialists have no tool to ask the person and no write access to
  `docs/decisions/`, so the run ends with nothing done. The critic grades it 30, "human". After
  the retry ladder (four attempts, about 0.05 USD each) the Inbox gets a sign-off request about
  the critic's findings. It does not contain the questions themselves, so there is nothing to
  answer.
- **Cause:**
  - project setup planned a task that only the person can do; U-017 stopped that for new
    projects only;
  - nothing turns "needs the person's answer" into a question in the Inbox;
  - the retry ladder retries a task whose blocker is the person, not the worker.
- **Options for the action (owner to choose):**
  1. A task whose acceptance criteria need the person's answers becomes an Inbox question at
     once (the questions, with a free-text answer per question), and the answers are written to
     the decision doc. No specialist runs and nothing is spent.
  2. Specialists get an "ask the person" tool that files such a question and pauses the task
     until it is answered.
  3. Both: (1) for planned decision tasks and (2) for questions that come up during work.
  In every option the critic's "human" verdict on a run that reports "I need the person's
  answers" files the questions, not a sign-off, and the ladder stops at the first such verdict.
- **Until then:** cancel that task on the Tasks tab and write the answers in Chat ("our stack
  is …, hosting …, repository …") or in `docs/decisions/0001-*.md` in the project workspace.
- **Status:** open.

### U-023 Extensions and Settings overlap and some switches do nothing

- **Found:** 2026-10-31 in 1.0.4, by the owner: "after enabling the voice-local option in
  extensions, nothing really happened … why is there a connector when there is also a
  dedicated option in the settings menu?"
- **What happens:**
  - `voice-local` in Extensions only marks local voice as the preferred provider; it installs
    nothing and has no tools. The install (CPU or GPU profile, ADR 0090) is Settings → Voice.
    Local voice is already the default, so enabling it changes nothing visible. Neither screen
    says so.
  - The `anthropic` row (kind model provider) is read by no code: the model uses the key or
    subscription token entered in setup.
  - `mcp-github` is an extra MCP server that gives agents general GitHub tools (issues, PRs,
    search) with the same token; the built-in GitHub features (repositories, the Projects
    mirror) do not need it, and the panel does not say so.
- **Options for the action (owner to choose):** remove `voice-local` from Extensions and keep
  voice only in Settings (or have the row link to Settings → Voice and show the install
  state); remove the `anthropic` row or show it read-only as "set in Settings"; describe
  `mcp-github` as "extra agent tools; not needed for the built-in GitHub"; add an Extensions
  section to the user guide.
- **Status:** open.

### U-024 Voice install: speech recognition cannot open its downloaded model

- **Found:** 2026-10-31 in 1.0.4, by the owner, installing into `D:\AGENT\Forerunner`:
  "whisper ready", "kokoro ready", then "model load failed: Unable to open file 'model.bin' in
  model '…\dependencies\voice\models\hub\models--Systran--faster-whisper-base\snapshots\…'"
  on the GPU and the CPU, so the profile is not installed and Talk is unavailable. The first
  GPU install had not worked either.
- **What is known:** `fr_voice_models.py` fetches the model with faster-whisper's
  `download_model` into the Hugging Face cache (`HF_HOME` under `dependencies\voice\models`).
  There `snapshots\<rev>\model.bin` is a link to `blobs\<hash>` where Windows allows links, and
  a copy otherwise. A later run skips any file whose snapshot entry exists. So a `model.bin`
  left broken by an interrupted first install (a closed app ends a running voice install, ADR
  0090), or a link the speech library cannot open, stays broken on every retry.
- **Not yet known:** which of the two it is. Needs from the owner: the output of
  `Get-Item "<that snapshot folder>\model.bin" | Format-List FullName,Length,LinkType,Target`
  and the file system of D: (`Get-Volume D`).
- **Workaround:** quit Forerunner, delete the folder
  `…\dependencies\voice\models\hub\models--Systran--faster-whisper-base`, and install voice
  again.
- **Likely action:** download the speech model into a plain folder (`download_model(...,
  output_dir=...)`, real files and no links) and load it from there; on "Unable to open file",
  delete that model's folder and fetch it once more before reporting failure. Test with a
  broken and a truncated `model.bin`.
- **Status:** open.

### U-025 The agent cannot be renamed

- **Found:** 2026-10-31 in 1.0.4, by the owner: "where did the name Alice come from, and how
  can I change the name of the principal agent?"
- **What happens:** the first start creates the principal agent with the name in
  `FORERUNNER_AGENT_NAME`, else "Alice" (`packages/runtime/src/daemon/compose.ts`). Nothing
  renames it later: setting the variable afterwards only picks an existing agent by name.
- **Action (owner's request):** Settings → "Your agent" renames it (`POST /agents/:id/rename`,
  1 to 60 characters, unique among your agents, not the critic). The new name shows at once
  in the app, in commit authors and in notifications; the phone shows it within 30 s. A start
  with the old `FORERUNNER_AGENT_NAME` still picks the same agent. Not covered: a second PC's
  service and a running cloud runner pick the name up at their next start
  (`docs/maintainers/runtime.md`). Commit 62bb1dd.
  Tests: `agent-rename-route.test.ts`, `services/state-api/test/routes.test.ts`,
  `apps/ui/test/settings-agent-name.test.tsx`, `apps/ui/test/real-daemon.test.ts` (the UI's
  client against the real daemon); each failed before the change.
- **Check in the app:** Settings → Your agent: type a new name, Save. The header, the Start
  session dialog and a new session's log show the new name; quit and reopen, it stays.
- **Status:** open (fix committed; fixed once CI is green).

### U-026 Adding an extension yourself asks for approval a second time, in the Inbox

- **Found:** 2026-10-31 in 1.0.4, by the owner: "why would I not want to approve it after
  adding it?"
- **What happens:** the panel's Add only files a request; the grant waits for an answer to a
  blocking, high-risk Inbox card. The design routes every grant through one place because spec
  §Security lists "granting a new capability" among the actions that always need a person,
  with a change card and a confirmation in the app, and because some grants are not the
  person's own click: an extension added from a URL is reviewed only after it has been started
  once (its real tools are learned then), and widening an extension's permissions is a grant
  as well. For a built-in catalog entry the person adds in the panel, the permissions are known
  before the click, so the Inbox card repeats a decision just made, with no new information.
- **Options for the action (owner to choose):** Add on a built-in entry opens a confirmation in
  the panel showing the same change card (tools, secrets, domains, scopes) and grants on
  Confirm, with no Inbox card; the Inbox keeps grants the person did not just see (from a URL
  after discovery, widened permissions, anything proposed by an agent).
- **Status:** open.

### U-037 to U-047: the work loop (projects, tasks, sessions)

- **Found:** 2026-10-31 in 1.0.4, by five review agents after the owner asked for more bugs and confusing features: one used the app against the real service with a stand-in model; four read the code (setup, the work loop, settings, the desktop app and Windows). Not yet seen by the owner unless the table says hands-on. Marked [suspected] where it depends on behaviour that could not be run.
- **Where:** U-037 `capabilities/src/githost/pr-executor.ts` (`makeLoop(undefined)`), `runtime/src/registry/executor.ts` (`allowedPaths: []`), `runtime/src/hooks.ts`; U-038 `session/runner.ts` (`consumeQueue`, `StaticPlanner` ignores `briefText`), `session/intake.ts` (`first_session` never read), `QueueSection.tsx`; U-039 `humanTransitions` on `in_progress`, `runner.ts` transitions without re-reading; U-040 `state/src/repos/task.ts` `readyTasks`, `server.ts` (dependencies unchecked), `runner.ts` `cutPlanToBudget`, `StartSessionDialog.tsx`; U-041 `NewTaskDialog.tsx`; U-042 `models/model.ts`, `executor.ts`; U-043 `session/triggers.ts`, `plan-approval.ts`; U-044 `critic` `ladder.ts`, `registry/tools.ts`; U-045 `runner.ts` after a failed review, `expireClaims`; U-046 `intake.ts`, the UI never calls `GET /projects/:id/intake`; U-047 `daemon/server.ts` chat routes refuse before the command parser.
- **Status:** open. The table's Action is a proposal; entries that change what a person sees or does are decided with the owner before they are built (AGENTS.md).

### U-048 to U-055: setup, keys and secrets

- **Found:** 2026-10-31 in 1.0.4, by five review agents after the owner asked for more bugs and confusing features: one used the app against the real service with a stand-in model; four read the code (setup, the work loop, settings, the desktop app and Windows). Not yet seen by the owner unless the table says hands-on. Marked [suspected] where it depends on behaviour that could not be run.
- **Where:** U-048 `daemon/compose.ts` (`authToken: oauth`), `provider/anthropic.ts` (no subscription header); U-049 `setup/routes.ts` (`restartNeeded` only for a missing key), keys read once in compose; U-050 `daemon/identity.ts`, compose start (the assistant records no email); U-051 `SetupPage.tsx` sends no repos, `setup/validators.ts` checks `GET /user` only, `setup-guide.md`; U-052 `setup/wizard.ts`, `billing` plan allowance default; U-053 `SetupPage.tsx`, `validators.ts`; U-054 `EmailSettingsPage.tsx`, `setup/routes.ts` stores only the Claude and GitHub keys, `ExtensionsPage.tsx`; U-055 `devices/manager.ts`, `DevicesSection.tsx`, `setup-guide.md`.
- **Status:** open. The table's Action is a proposal; entries that change what a person sees or does are decided with the owner before they are built (AGENTS.md).

### U-056 to U-061: settings, undo and the change log

- **Found:** 2026-10-31 in 1.0.4, by five review agents after the owner asked for more bugs and confusing features: one used the app against the real service with a stand-in model; four read the code (setup, the work loop, settings, the desktop app and Windows). Not yet seen by the owner unless the table says hands-on. Marked [suspected] where it depends on behaviour that could not be run.
- **Where:** U-056 `Shell.tsx`, `commands.ts` (palette), `conversation/agent.ts` (prefers the stored active project), `ChatTab.tsx`; U-057 `commands/src/executor.ts` `undo` (no risk check), `commands/budget.ts`; U-058 `create-project.ts` (`autonomyLevel ?? 2`); U-059 `intake.ts`, `conversation/agent.ts` (always standard), `executor.ts` (cap), `ModelSettingsSection.tsx`; U-060 `server.ts` `/settings` (11 keys), `SetupPage.tsx`, `UpdatesPage.tsx`, `desktop/approvals.ts` (points to a missing allowlist control); U-061 `commands/src/commands/task.ts` (undo returns silently), `executor.ts` (message from the old count), `server.ts` task transitions write no change, `TasksTab.tsx` dialog text, `server.ts` undo source "chat".
- **Status:** open. The table's Action is a proposal; entries that change what a person sees or does are decided with the owner before they are built (AGENTS.md).

### U-062 to U-070: the desktop app and Windows

- **Found:** 2026-10-31 in 1.0.4, by five review agents after the owner asked for more bugs and confusing features: one used the app against the real service with a stand-in model; four read the code (setup, the work loop, settings, the desktop app and Windows). Not yet seen by the owner unless the table says hands-on. Marked [suspected] where it depends on behaviour that could not be run.
- **Where:** U-062 `apps/desktop/src-tauri/src/actions.rs` `finish_quit` (no `daemon.json` yet: `child_pid` unused), `supervisor.rs`, `lib.rs` single instance, `windows.rs` `show_main`, `bootstrap` ignores `quitting`; U-063 `compose.ts` claim release on freeze (`store.agent.list(undefined)`), reached from `POST /shutdown`; U-064 `daemon.rs` one 1.5 s client for health and actions; U-065 `daemon.rs` (`pid_alive` is unknown on Windows), `actions.rs`, `server.ts` unlinks `daemon.json` unconditionally; U-066 `scripts/installed-check.ps1` (self-test stops its own daemon; `/x` exit code discarded), `wix/stop-running.wxs` (`-Like '…'`); U-067 the MSI template, `lib.rs` `register_all()`; U-068 `platform/src/shell.ts` (`cmd /c`); U-069 `voice/install.ts` (only espeak's length is checked); U-070 `update/install.ts` (installer accepted on the daemon side).
- **Status:** open. The table's Action is a proposal; entries that change what a person sees or does are decided with the owner before they are built (AGENTS.md).

### U-071 to U-077: what the app shows and says

- **Found:** 2026-10-31 in 1.0.4, by five review agents after the owner asked for more bugs and confusing features: one used the app against the real service with a stand-in model; four read the code (setup, the work loop, settings, the desktop app and Windows). Not yet seen by the owner unless the table says hands-on. Marked [suspected] where it depends on behaviour that could not be run.
- **Where:** U-071 `store/context.tsx`, `Shell.tsx` (status never reset), `SessionPage.tsx` (resubscribes to an ended stream), `daemon/views.ts` (blocked), `ChatTab.tsx` (state in the component); U-072 `daemon/views.ts`, `notifications/producers.ts`, `critic` session review; U-073 `critic` follow-up texts, `InboxPage.tsx` (intake card lists names only); U-074 `views.ts` `describeEvent` fallback, `runner.ts`, `producers.ts`, `InboxPage.tsx`, `SettingsPage.tsx`, `MemoryPage.tsx`, change card texts, `server.ts` and `voice/sessions.ts` ("run fr setup"); U-075 `voice/src/registry.ts` (drops the reason), `email-ports.ts`, `catalog.json`, `EmailSettingsPage.tsx` (a card for the critic); U-076 `restart.ts`, `UpdatesPage.tsx`; U-077 `SetupPage.tsx`, `vault/src/open.ts`, `UpdatesPage.tsx`, the palette, the task dialog, `windows.rs` (hint marker written when the toast is suppressed; minimized position saved), `actions.rs` (Quit's session count up to 10 s old), `voice/install.ts` (unguarded temp removal), `daemon-shell.log` never rotated, Extensions "Specialists: None installed", Performance's overall error, starting a session under Stop all returns HTTP 500, `user-guide.md` still says "Make this a task" makes a draft.
- **Status:** open. The table's Action is a proposal; entries that change what a person sees or does are decided with the owner before they are built (AGENTS.md).

### U-027 to U-036: found by a sweep for siblings of U-019 and U-021

- **Found:** 2026-10-31, by a code audit for the bug classes in
  `docs/maintainers/validation.md` (what is clicked is not what is parsed, a click that leads
  nowhere, state re-applied after a restart). Not yet seen by a person; each was confirmed by
  reading the code path end to end, except U-036.
- **Where:**
  - U-027: `services/state-api/src/routes/reviews.ts` answers with `{ decision, comment,
    reviewId }`; `answerWord` (`session/findings.ts`) and `isYes` read only `choice`/`answer`.
  - U-028: `capabilities/src/githost/pr-executor.ts` (rebase conflict) and
    `runtime/src/loop/merge.ts` ("I merged it"): no code reads the answers.
  - U-029: `commands/src/executor.ts` files the card; only `RemoteCommandWatcher.syncAnswered`
    applies answers, and it exists only when remote commands are on (not for `sqlite:`).
  - U-030: `extensions/registry.ts` `approve`/`deny` clear `pendingRequestId` without
    withdrawing the request (U-021 fixed only `remove`).
  - U-031: `githost/projects-mirror.ts`: a denial saves nothing, and the 15-minute schedule asks
    again.
  - U-032: `kill.resume()` without `clearKillRequest` in `remote/watcher.ts` (phone start, plan
    with a session start) and `daemon/server.ts` (`/sessions/:id/stop`).
  - U-033: `critic/src/session-review.ts` inserts with `human_id: null`; both inboxes list by
    human. "acknowledge" and "cancel" have no reader.
  - U-034: `signoffAnswer`, `blockedFindingsAnswer`, `planAnswer`, `intakeAnswer`,
    `specialistAnswer`, the model watch reader: an unrecognised answer is recorded and the card
    closes; `AnswerRequestBody` does not check the answer against the options.
  - U-035: `models/watch.ts` `resolve()` neither answers nor withdraws the request;
    `remind_at` is written and never read.
  - U-036: `apps/desktop/src-tauri/src/actions.rs` removes `restart.json` only on the Restart
    branch.
- **Fixes (each with a test that failed before; `pnpm check` green with all of them):**
  - U-027 (eebd8a0): the phone's verdict is stored as the card's own option, as a click would.
    Tests: `services/state-api/test/review-verdict.test.ts`.
  - U-028 (90de697, b29df98): the conflicting branch is pushed; "I resolved it" and "Drop the
    branch and retry" put the task back to ready (continue from your branch, or start again),
    "Cancel the task" cancels; "I merged it" / "Leave it open" are recorded. Tests:
    `pr-answers.test.ts` (real git, across a restart), `request-answers.test.ts`.
  - U-029 (1181a65): the answer runs or cancels the change on every install; a card the app
    can no longer run after a restart is expired with a message. Tests:
    `inbox-change-card.test.ts`.
  - U-030 (1e466aa): Approve and Deny in the panel withdraw the card. Tests:
    `extensions-registry.test.ts`, `real-daemon.test.ts`.
  - U-031 (041fd8b): a no turns the mirror off for the project; a timeout changes nothing.
    Tests: `projects-mirror.test.ts`, `mirror-deny-daemon.test.ts`.
  - U-032 (19271d0): the kill switch's resume clears `kill.json` on every path; a session Stop
    or the phone's stop keeps a kill in force. The live view's Stop answered with the wrong
    shape against the real daemon, also fixed. Tests: `kill-resume-restart.test.ts`,
    `killswitch.test.ts`, cloud-runner `remote.test.ts`, `real-daemon.test.ts`.
  - U-033 (67163ec, b29df98): filed for the session's owner; options "Acknowledge" and
    "Correct the summary" (cancel had nothing to cancel). Tests:
    `session-review-inbox.test.ts`, `request-answers.test.ts`.
  - U-034 (47089f8, b29df98): every answer route (desktop, phone, approvals page, Chat and
    voice) refuses an answer the card cannot act on, with "Choose one of: …"; the card stays.
    Tests: `answer-options-daemon.test.ts`, state-api `answer-options.test.ts`,
    `inbox.test.tsx`, `real-daemon.test.ts`, `request-answers.test.ts`.
  - U-035 (a430c0f): an answer on the Updates page withdraws the Inbox card; "remind me" files
    the question again when due (hourly job). Tests: `model-watch.test.ts`, `wiring.test.ts`.
  - U-036: not a bug. Only the restarter exits with code 86, and it writes a fresh
    `restart.json` first; every other exit ignores the file.
- **Check in the app:**
  - U-027: phone → Reviews → Approve on a task waiting for sign-off: the task becomes done;
    Reject sends it back to ready.
  - U-028: when a rebase conflict card appears, the branch is on GitHub; resolve and push,
    click "I resolved it": the next session opens the PR. "Cancel the task" cancels it.
  - U-029: Chat "set autonomy for <project> to 3", answer yes in the Inbox: Settings shows 3
    and Changes has Undo. No changes nothing.
  - U-030: Extensions → add browser, Approve in the panel: no card in the Inbox. Add
    cloudflare, Deny in the panel: no card.
  - U-031: answer "Do not mirror this project": the mirror setting turns off and the card does
    not come back.
  - U-032: Stop all, then Stop on a session page: the header still shows Resume; Quit and
    reopen: still stopped until Resume.
  - U-033: a session whose summary overstates its work shows a card; "Correct the summary"
    fixes the text on the session page.
  - U-034: type "maybe" on a sign-off card: "Choose one of: accept, revise, cancel" appears and
    the card stays.
  - U-035: Updates → Ignore on a model watch report: its Inbox card goes away.
- **Status:** U-027 to U-035 open (fix committed; fixed once CI is green). U-036 won't fix:
  not a bug (see Fixes).

### U-021 Extension approvals show "[object Object]" and both buttons deny

- **Found:** 2026-10-31 in 1.0.4, by the owner, after enabling voice-local in Extensions
  (screenshot: two identical "Install capability voice-local" cards).
- **Why there is an approval at all:** giving an agent a new capability (a connector's tools,
  the microphone, the browser) always needs a person's yes (spec Security, ADR 0029). The card
  lists what is granted ("scope: microphone and speaker on this machine"); Approve grants it,
  Deny removes the extension.
- **What happens:** the request's options were objects (`{ choice: "approve", stage,
  permissions, review }` and `{ choice: "deny" }`). The service turned each into text with
  `String()`, "[object Object]", and the inbox sends a clicked option's text back as the
  answer. "[object Object]" is not a yes, so both buttons denied, and a denied new extension is
  removed. Only typing "approve" in the text field worked. The test answered with "yes" and
  "no", never with what a button sends, and asserted the object shape.
- **Second problem:** removing an extension deleted it but left its open request in the Inbox,
  where answering it does nothing; enabling it again added a second, identical card.
- **Action:** the options are "Approve" and "Deny"; the service shows old rows' object options
  as "Approve"/"Deny", which answer correctly; `remove()` withdraws the open request. Tests:
  `packages/runtime/test/extensions-registry.test.ts` (answered with the shown options, an old
  row, the withdrawal); each fails without the fix. Old requests synced to the phone app and the
  approvals page still show their options as JSON text; new ones show Approve and Deny.
- **Check in the app:** Extensions → add voice-local (or any entry). The Inbox card shows
  Approve and Deny. Deny: the extension is gone. Add it again, Approve: it shows as installed
  and enabled. Add one more and remove it before answering: its card leaves the Inbox.
- **Status:** open.

### U-020 The inbox has no "mark all read"

- **Found:** 2026-10-31 in 1.0.4, by the owner.
- **Action:** a "Mark all read" button over the messages marks every unread message read,
  through the same route as Mark read. Test: `apps/ui/test/inbox.test.tsx` ("marks every
  unread message read with one click") fails without it. The Android inbox does not have it yet.
- **Check in the app:** with two or more unread messages, Inbox → Mark all read (N): every
  message turns read and the button goes away; reload, they stay read.
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
| U-013 | After clicking Claim on tasks, every session says "Nothing to plan: no task is ready"; the tasks stay claimed forever. | 1.0.4: people cannot claim (the button is gone, the service refuses it); a session puts claimed tasks nobody holds, and lapsed claims, back to ready before it plans. |
| U-014 | A planned task fails at once, spending nothing: "specialist ops is not in the registry". | 1.0.4: the plan's informal names ("ops", "writer", "data analyst") run the registry entry they mean; the planner's prompts list the exact names; a name that means none waits for you and lists the names instead of failing. |
| U-015 | In Chat, "add a task: …" (what the app suggests) is not understood without a model for Chat. | 1.0.4: the phrase creates a ready task. |
| U-016 | "Make this a task" in Chat makes a draft, which no session works on. | 1.0.4: it makes a ready task (ADR 0093). |
| U-017 | A session whose only task failed reads as fine: the notification says "0 done, 0 need you", the review says "accept (grade 100)" and shows twice in the log, and project setup plans tasks like "Confirm stack ... with the human" that no specialist can do. | 1.0.4: the notification names failed tasks; the review grades a session with every task failed below 100; the log shows the review once; project setup writes such choices into the first decision doc instead. |

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
- **Status:** released 1.0.4 (2026-10-30). Commits 24cd928, 5240bc4, 48debf9; CI 41144554642 green on Windows and Linux.

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
- **Status:** released 1.0.4 (2026-10-30). Commits 24cd928, 5240bc4, 48debf9; CI 41144554642 green on Windows and Linux. The registry
  prompt change must also go to `forerunner-registry` (`scripts/sync-registry.ts --apply`).

### U-015 "add a task: …" in Chat is not understood

- **Found:** 2026-10-30, while looking into U-013. The Start dialog and the session summary
  (U-009) tell people to say it in Chat.
- **What happens:** the intent parser had no pattern for it; without a model for Chat the
  answer is "I did not understand".
- **Action:** "add a task: …", "create a [new] task: …", "new task: …" and "neue Aufgabe: …"
  create a `ready` task (`intent.test.ts`).
- **Status:** released 1.0.4 (2026-10-30). Commits 24cd928, 5240bc4, 48debf9; CI 41144554642 green on Windows and Linux.

### U-016 "Make this a task" makes a task no session works on

- **Found:** 2026-10-30, while looking into U-013; the owner decided the action.
- **What happens:** the Chat button and the phrase created a `draft` task (spec J.1). Sessions
  plan only `ready` tasks, so it waited until someone clicked Mark ready on the Tasks tab.
- **Action:** both create a `ready` task (ADR 0093). Tests: `intent.test.ts`,
  `conversation.test.ts`, `apps/ui/test/chat.test.tsx`.
- **Status:** released 1.0.4 (2026-10-30). Commits 24cd928, 5240bc4, 48debf9; CI 41144554642 green on Windows and Linux.

### U-017 A session where everything failed looks like a good one

- **Found:** 2026-10-30, in the owner's session log for U-014.
- **What happens:**
  - The notification title counted done and needs-you tasks only: "Alice's session completed:
    0 done, 0 need you".
  - The session review found nothing wrong: its only "no task done" check needs money spent,
    and the task failed before spending any. "accept (grade 100, 0 finding(s))".
  - The review showed twice: the critic stored a `critic.session_review` event and the runner
    reported the review under the same type.
  - The intake prompt let the plan hold a task asking the human to confirm the stack, hosting
    and repository; it went to a specialist, which cannot answer it.
- **Action:** the title adds "N failed"; a planned set with none done and some failed is a
  medium finding; the critic's event is `critic.session_review_metrics` with its own log line;
  the intake prompt says to record such a choice in `docs/decisions/0001-<slug>.md`. Tests:
  `notifications-channels.test.ts`, `session-review.test.ts`, `event-lines.test.ts`.
- **Status:** released 1.0.4 (2026-10-30). Commits 24cd928, 5240bc4, 48debf9; CI 41144554642 green on Windows and Linux.

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
