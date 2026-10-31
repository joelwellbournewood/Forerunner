# Apps

The one React UI (`apps/ui`) that the Tauri desktop shell (`apps/desktop`, Windows and Linux)
and the Android shell (`apps/mobile`) wrap, plus the approvals web fallback
(`apps/approvals-web`, still a skeleton). The first part of this file covers the UI; the
"Desktop shell" section at the end covers `apps/desktop` (lifecycle, injection, tray,
notifications, restart, deep links).

## Purpose

The screens of spec module K against the local daemon API (ADR 0011, ADR 0025, ADR 0037):
Home, the Project page with its eight tabs (Summary with the next-session queue, the peers
feed and the decision log; Plan with the milestone timeline and the dependency graph; Tasks;
Docs; Reviews with the grade trend; Costs with savings and cost per accepted task; Data with
registration and imports; Chat), the Live session view, Inbox, Memory (one view per agent,
the critic, shared lessons; search, edit, delete, pin; consolidation), Extensions (every
connector, MCP server, skill, specialist, capability and model provider with status,
permissions, cost, version, toggle, remove, add from the catalog or a URL), Settings (every
setting with its scope; changes run through the command registry), the change log with undo,
the Performance view and the Updates screen; plus the shell with the active project, kill
switch, inbox badge, restart banner, command palette, keyboard shortcuts and dark mode. The UI
never touches the database: everything goes through the daemon client, every response is
validated with the zod schemas from `packages/runtime/src/daemon/api-types.ts` (or the
mirrors in `src/api/contracts.ts`), and money is shown in CHF only.

Requirements covered (see `docs/requirements.md`): K.1, K.2, K.3, K.4, K.5, K.6, K.7, K.8
(palette, shortcuts, dark mode, active project; notifications and the tray are the desktop
shell's), B.1 and B.7 (plan and task log), D.7 and D.19 (Performance view per mode against
target), D.6 and M.5 (model watch and model updates on the Updates screen), F.6 (peers feed),
G.1, G.2, G.4 and G.5 (memory views, consolidation, the doc set with drift), H.3 and H.5
(reviews, findings, patterns), I.3, I.6 and I.7 (estimate accuracy, allocation with cost per
accepted task, savings apart), J.1 (quick chat), J.2 (next-session queue), J.3 and J.4 (inbox,
decisions), L.1 (data by path or URI, imports), L.5 (connectors reviewed on install), M.3 and
M.4 (update available, changelog, "Update and restart", rollback), Q.1, Q.4 to Q.8, Q.10, Q.11
and Q.12 (the settings screen runs the same commands as chat and voice: change card,
confirmation by risk, the sentence, the change log with undo).

## How it works

### Structure

```
apps/ui/
  index.html, vite.config.ts, vitest.config.ts, playwright.config.ts, biome.json (nested:
  enables Biome's Tailwind CSS parser for this app only)
  src/
    main.tsx, App.tsx (client + store from the globals, BrowserRouter; the Android shell and
                       the /m path mount src/mobile instead), routes.tsx (AppRoutes)
    styles.css           Tailwind 4; dark variant bound to <html data-theme="dark">
    api/config.ts        DaemonConfig resolution (shell injection > Vite env > default)
    api/client.ts        createClient(): one typed method per DAEMON_ROUTES entry, plus the
                         proposed routes of contracts.ts; ApiError, isRouteMissing, describeError
    api/contracts.ts     mirrors of runtime schemas the browser cannot import (extensions,
                         updates, model watch, estimates), the change card, and PROPOSED_ROUTES
                         with their view schemas (queue, milestones, imports, docs)
    api/sse.ts           EventSource subscriptions with polling fallback; SseParser for fetch streams
    api/chat-stream.ts   streamChat(): POST /chat/stream tokens -> final reply
    store/store.ts       reducer + subscribe/getSnapshot (projects, active project, inbox count,
                         connection, kill state, theme, restart announcement, extensions version)
    store/context.tsx    AppProvider (bootstrap: /health, /me, /agents, /projects, /inbox, then
                         the /events stream), useClient, useUiState, useIdentity,
                         refreshIdentity (/me and /agents again, after a rename, U-025)
    store/theme.ts       prefers-color-scheme + stored override -> data-theme
    lib/                 money (CHF formatting), time, clock (UiClock, useNow, formatCountdown),
                         format (bytes, ms, shares), storage, use-async (data, error,
                         routeMissing, errorStatus), task-transitions,
                         runner-unlock (the cloud runner unlock bridge contract, ADR 0068)
    components/          ui.tsx (Button, Badge, SpendBar, Money, Loading, ErrorBanner, Field),
                         Dialog.tsx (native <dialog>), RouteMissing.tsx, charts.tsx (TrendLine,
                         TargetBar), ChangeCardDialog.tsx (ChangeCard, CommandResult),
                         UnlockCard.tsx (the cloud runner unlock card, useAutoUnlock and
                         useUnlockWindow, shared by the desktop and phone), RunnerAutoUnlock.tsx
                         (the desktop's app-wide auto-unlock, mounted in the Shell),
                         QrCode.tsx (uqr-encoded QR drawn as one SVG path)
    shell/               Shell.tsx (header, nav, switcher, kill switch, banners, RunnerAutoUnlock), CommandPalette,
                         commands.ts, shortcuts.ts (sequence matcher), ShortcutsHelp, ShellContext
    pages/               HomePage, NewProjectDialog, ProjectPage (+ project/*Tab, *Section,
                         NewTaskDialog, StartSessionDialog), SessionPage, InboxPage, MemoryPage,
                         ExtensionsPage, ChangesPage, PerformancePage, UpdatesPage, SettingsPage
                         (+ DevicesSection, SourcesSection), EmailSettingsPage (Settings -> Capabilities -> Email),
                         PlaceholderPages (NotFound only)
    mobile/              the phone screens (module R; its own doc section, not covered here)
  test/                  Vitest + Testing Library (jsdom); fixtures.ts, fake-daemon.ts, helpers.tsx,
                         contrast.ts (WCAG ratio of Tailwind text, background and border classes,
                         light and dark, from the v4 oklch values in tailwindcss/theme.css
                         converted to sRGB; throws on opacity forms, arbitrary colours and
                         opacity-* rather than skipping them)
  e2e/                   Playwright specs against the fake daemon
```

### Routes

| Route | Page | Data |
| --- | --- | --- |
| `/` | Home: project cards (stage, next milestone, health, spend vs budget, waiting-on-you, latest critic grade; `ProjectStateBadge`: "blocked" only while something waits in the Inbox, a task that needs you without a card reads "needs you: <task>" and links to the Tasks tab, U-071), New project dialog (a pasted brief sends `intake: true`, so the PM intake drafts the plan, the doc set and the first-session plan in the background and the proposal lands in the inbox; spec A.2, ADR 0055) | store (`GET /projects`), `POST /projects` |
| `/projects/:id/:tab?` | Project page; tabs `summary`, `plan`, `tasks`, `docs`, `reviews`, `costs`, `data`, `chat` (default `summary`); opening a project makes it active. Above the tabs, the plan from the brief (`IntakeBanner`, `useIntakeStatus`; U-046): "Drafting the plan from your brief" while the daemon drafts it (read again every 3 s), "waits for your approval in the Inbox" with a link, or "could not be drafted" with the daemon's error and **Retry** (`POST /projects/:id/intake/retry`, which answers `drafting`; a refusal shown under the button); nothing without an intake or once it was answered. **Create a repository** (`CreateRepoDialog`, U-037, ADR 0097) shows for a project whose card has empty `repos`: name (from the project's), organization (empty: the token's account), Private; Preview runs `repo.create` through `POST /commands/execute` (`source: "ui"`) and shows the daemon's change card, Yes confirms it (`tap`, or this device for a public one), and the project reloads without the button. **Start session** (`StartSessionDialog`): a budget and a reason; when it opens (and as the budget is typed) it reads the start check: with no ready task it says a session would end at once and how to give the agent work (Tasks tab, Mark ready on a draft, "add a task: …" in Chat; U-009), and names the plan from the brief only as it stands: waiting in the Inbox, being drafted, or failed with the project page's Retry (U-046: it named a plan in the Inbox for every project); with ready tasks of which none can run it says so (`start-session-cannot-run`) and names each one waiting on another task, with that task's title and state and what to do when it is cancelled, failed or missing, and each one larger than the work budget, with its estimate and the budget; when some can run, the others are listed under "Not in this session" (`start-session-left-out`; U-040); a started session opens its live view, a queued or deferred start says so in the dialog (`startNotice`, U-003), with how many waiting starts come before it from the answer's `ahead` ("This one starts when that one ends." only when none does; waiting starts run in order, none replaced, U-043) | `GET /projects/:id` and the tab routes below; `GET /projects/:id/intake`, `POST /projects/:id/intake/retry`; `GET /projects/:id/start-check?budgetUsdMicro=`, `POST /sessions` |
| `summary` tab | the cached one-screen summary with Read aloud (the daemon's voice provider reads it, `POST /projects/:id/speak`; the text being read is shown and Stop cancels it; the browser's speech is the fallback on 503); **Next session** (queue items by priority with type badges, add note/task/correction/idea with a priority, dismiss; consumed items collapsed; the line under the title says what the runtime does with an item, U-038: it reaches the brief of the task it names, or every task's brief, and an approved first-session plan decides the first session); **Peers** (per agent: online, active claims with expiry, open PRs, last handoff done/in flight/blocked/next, files in flight); **Decisions** (question, chosen option, the others, rationale, who, supersedes) | `GET /projects/:id/summary`, `GET /projects/:id/queue`, `POST /projects/:id/queue`, `POST /queue/:id/dismiss` (served since U-004), `GET /projects/:id/peers`, `GET /projects/:id/decisions` |
| `plan` tab | milestone **timeline** (SVG: dated milestones on a time axis with today's tick, undated ones after), milestones with status, success criteria and their tasks, the task **dependency graph** (layered SVG, a task after everything it depends on); without a milestones route the timeline and the list are derived from the tasks and the card (the card's dated next milestone on the axis, the ids the tasks reference after it) behind a route-missing notice; today's tick comes from a `now` prop (wall clock by default, injected in tests); in **small-project mode** (spec B.6, the card's `smallProjectMode`) the tab shows instead the one milestone (the open one from the route, or the card's next milestone without it; milestones on file from before the mode are named, not hidden), the tasks as a **flat list** in the daemon's order with no grouping and no timeline, and the graph; every milestone the route served (never a derived one) has **Edit**: a dialog with name, target date, status and success criteria (one per line) with an **optional reason** (U-010; left empty, `DEFAULT_MILESTONE_REASON`, "Milestone edited in the app", is sent, since the daemon keeps a reason on every change), posted with the row's `version` (spec B.5; the daemon's refusal, a stale version or a bad date, stays in the dialog), and the reason of the last change is shown under the milestone | `GET /projects/:id/tasks`, `GET /projects/:id/milestones`, `POST /milestones/:id` |
| `tasks` tab | task log table with filters, transitions a person may make (`humanTransitions`: the graph without `claimed` and `in_progress`, which only an agent's claim sets; U-013) with an optional reason (U-010; left empty, `defaultTransitionReason` sends what changed, e.g. "Cancelled in the app"); on a `claimed` or `in_progress` task the move's dialog says the run stops now and the session goes on with its other tasks (`transition-stops-run`, U-039: the daemon's route stops the task's run through `KillSwitch.stopTask`), dependencies by title (`describeDependencies`: "after "Title"", with the state of one not done) and, on a ready task waiting on a cancelled, failed or missing one, a note that no session runs it until its dependencies change (`stuck-dependency`); **Depends on…** on every task not done or cancelled opens a dialog with the project's other tasks by title (`DependencyPicker`; a cancelled one is not offered, a missing one stays listed to untick) and an optional reason (left empty: "Dependencies changed in the app"), whose Save sends every dependency the task keeps and shows the daemon's refusal (a cycle, a cancelled task) in the dialog (U-040), priority shown as its level ("High priority", `PRIORITY_LABELS` from `@forerunner/runtime/priority`; U-041), New task dialog (its "Depends on" is the same picker, never typed ids; its Priority is a select of Low, Medium (default) and High with "High runs first.", sending the word; its risk tier offers "project default (tier N)" from the card's `defaultRiskTier` and sends no `riskTier` unless one is picked, so the daemon applies the project's default: 0 in small-project mode, B.6); under each task's cost, what stops its runs (`TaskCap`, U-042, from the view's `cap` and `capSource`): "of CHF x budget" for a task with a budget, else "no budget; each run stops at CHF y (specialist limit)"; the estimate is never shown as a limit | `GET /projects/:id/tasks`, `/runs`, `POST /projects/:id/tasks`, `POST /tasks/:id/transition`, `POST /tasks/:id/dependencies` |
| `docs` tab | the standard doc set with present/missing/drift state, size and date, and where each was read (the linked folder, the project folder, or this PC's copy of the repository); a document opens in a reader | `GET /projects/:id/docs`, `GET /projects/:id/docs/:path` (served since U-005) |
| `reviews` tab | counts (reviews, open findings, average grade, verdicts), the grade trend chart with the accept line, every review newest first (grade, verdict, tier, confidence, model, task, session link, summary, evidence, findings with severity and status), verdict filter | `GET /projects/:id/reviews` |
| `costs` tab | totals, by model / specialist / task with accepted share and cost per accepted task, savings apart | `GET /costs?projectId=` |
| `data` tab | registered datasets (name, kind, size, locator, sample, who), register by path or URI, remove (two clicks), import from github/zip/folder with the result in one line (`importSummary`: the repository and its migration branch with the default branch untouched, or the files and bytes and where they went, and the daemon's note) | `GET /projects/:id/data`, `POST /projects/:id/data`, `DELETE /data/:id`, `POST /projects/:id/data/import` (since U-006) |
| `chat` tab | quick chat with streaming, read-back confirmation, make-this-a-task (the New task dialog prefilled from the message, status `ready`: U-016, ADR 0093); without a Claude key the commands that need no model still run and any other line is answered with where the setup assistant is (U-047: the daemon no longer refuses Chat with 503; the fake's `noModel` option answers the same way) | `POST /chat/stream` |
| `/sessions/:id` | Live session view: header (status, agent, current task + specialist, steps/stepCap, spent/cap bar, Stop), event stream with level chips, raw JSON toggle, follow/auto-scroll | `GET /sessions/:id`, `GET /sessions/:id/events` (JSON backlog, then SSE), `POST /sessions/:id/stop` |
| `/inbox` | Requests (blocking first, newest first) with option buttons and a free-text answer, messages with read marking; every card names its project (a link to the project) and, when it is about a task, the task (`Task: <title>`, a link to the project's Tasks tab; `taskTitle` from `GET /inbox`, U-073); reloads when the install stream reports a blocking count the page has not seen. An intake proposal (spec A.2, ADR 0055: a card whose `key` is `intake:<project>`) renders as a plan card (`IntakeCard`, `intakeCardOf`): phases with their tasks (tier, priority, specialist, dependencies), the docs and where they go with each drafted doc's text behind its own `<details>` (the decision doc, `docs/decisions/NNNN-…`, first and open, so the person reads what they approve; U-073), the first session with estimates, the planning call's cost; the raw card stays behind "Change card" and the options are the ordinary approve / reject buttons; a task planned for the person is listed as "asks you in the Inbox". Questions only the person can answer (U-022, ADR 0095: a `decision` whose `key` is `person_questions:<task>`, `personQuestionsOf`; the prefix is checked against the runtime's) render as a form (`PersonQuestionsForm`) with one answer field per question, the context the specialist or the critic gave, and Send answers, which sends `{ answers: [{ question, answer }] }` without the blank ones (disabled until one is typed); the steps list, the raw card and the one-line answer are not shown, and the card's one option, Cancel the task, is a secondary button. A cloud runner vault unlock (spec S.12, ADR 0068: a `credential` request whose card is the runner's challenge, `unlockChallengeOf`) renders as the **unlock card** (`UnlockCard`) instead of the options and the free-text box: the runner, the project, when it was filed, the challenge's age and time left; Unlock once / Unlock and allow for 1, 8 or 24 h / Unlock and clear the window / Deny. The key never reaches the page: `daemonRunnerKeys(client)` asks the daemon, which holds the OS keyring, to wrap it (`POST /runner-unlock/wrap { requestId }`: the page names the request, the daemon reads the challenge from its store) and the page sends the wrapped answer as the request's answer; the window it set is recorded in browser storage (`runnerUnlockWindow.<human>`) only after the answer was accepted. While that window is open the next challenge is answered once, without a choice, with a notice, on whatever page is open: `RunnerAutoUnlock` in the `Shell` (not the inbox page) reads the inbox on mount, on every streamed blocking count and every minute while the window is open, and runs `useAutoUnlock`; the page and the shell share the window record through `desktopUnlockWindowStore` / `useUnlockWindow`, so a window set on a card applies at once. Without the key on this computer (`GET /runner-unlock/:runnerId/key`) or after the challenge expired, the card is read-only with the reason. `InboxPage` takes `runnerKeys`, `unlockWindows` and `now` props for tests | `GET /inbox?humanId=`, `POST /requests/:id/answer`, `POST /messages/:id/read`, `GET /runner-unlock/:runnerId/key`, `POST /runner-unlock/wrap` |
| `/memory` | one view per principal agent (the human's own first, then the peers' as listed-but-not-readable), the critic, shared lessons, each with active and pinned counts; search (debounced); per lesson: pin, tags, confidence, uses, last used, source, project, file; edit text and tags, delete (two clicks); Share (spec G.6: proposes the lesson for every project; shown for an active lesson that is not shared already, `canShare`: neither a global shared lesson nor a project copy of one accepted from an offer, whose `source` names its `promotion` origin, the rows the daemon refuses too; the row then says the critic reviews it at the next session end and gains the `general` tag); "Shared across projects": the proposals waiting for the critic and the offers of promoted lessons to the human's other projects (open first: Accept for that project / Dismiss, applied at once; decided ones with their outcome; its own route-missing notice when the daemon lacks the offers route); consolidation proposals with merged/contradictions/retired and "Run now" (its own route-missing notice, under the Consolidation heading, when the daemon lacks the consolidation routes) | `GET /memory/scopes`, `GET /memory?scope=&agentId=&q=`, `PUT /memory/lessons/:id`, `POST /memory/lessons/:id/pin`, `DELETE /memory/lessons/:id`, `POST /memory/lessons/:id/propose`, `GET /memory/promotions`, `GET /memory/offers`, `POST /memory/offers/:id/answer`, `GET /memory/consolidation`, `POST /memory/consolidation/run` |
| `/extensions` | grouped by kind (connectors and MCP servers, skills, specialists, capabilities, model providers): name, version, status, connected, cost, description, permissions summary with the full list behind details; On/Off switch; Remove (two clicks); pending rows show the review (stage, risk, summary, tools, requested permissions, and "also in the inbox" or, for a row confirmed here, "confirmed here with Approve, not in the inbox") with Approve/Deny; Add dialog: catalog with search and kind filter, or an MCP server URL; **Add on a catalog entry** (U-026, ADR 0096) posts `{ catalogId, confirmIn: "panel" }` and opens the confirmation in the panel (`grant-dialog`) with the change card (`GrantCard`: the step, the risk, the summary, every tool with its class and risk, the tools, action classes, domains, paths, secrets and scopes) and a note that a high-risk grant is confirmed on a paired device, this PC counting as one, and that Cancel adds nothing; **Confirm on this device** posts `POST /extensions/:id/approve { answer: "device", deviceId: /me.desktopDeviceId }` (no id when `/me` names none), shows a refusal in the dialog with the daemon's reason, shows the card again with the tools found after a discovery step ("Start it once on this device"), and closes with "<name> is added and enabled."; **Cancel** (or closing the dialog) posts `/deny` and says "Cancelled: <name> was not added."; Approve on any pending row opens the same dialog (Cancel there only closes it); an add from a URL still waits in the Inbox; the capabilities group opens with a line pointing to **Settings → Voice** (U-023: local voice and the providers in force live there) and saying a cloud voice capability is used instead while it is on; the model providers group says the model and its key are set in the setup and lists no switch; a row another screen owns (`managedIn: "email"`, an agent's email settings row, U-075) has no switch and no Remove but a link "set on the Email page" to `/settings/capabilities/email`; every cloud voice row carries a badge (in force for STT/TTS when the pick is any provider the row stands for; preferred but not in force with the registry's reason; or not in force with the daemon's reason: switched off, key not granted or without a value, another row preferred, an override); a daemon without the voice route shows no badge; reloads (list and voice status) on every `extension.changed` frame, after every toggle and after a removal; a row whose permissions name a cloud voice key (`deepgram_api_key`, `cartesia_api_key`, `elevenlabs_api_key`) has a key box (`SecretValueField`, U-054: a password field with Save or Replace, `POST /secrets/store { name, value }`, emptied after sending, "Saved in this computer's credential store as <name>." or whether one is saved from `GET /secrets/store`; the daemon's refusal as a banner) | `GET /extensions`, `GET /extensions/catalog`, `POST /extensions` (201 or 202; `confirmIn: "panel"` from Add), `POST /extensions/:id/toggle`, `/approve` (with the device answer), `/deny`, `DELETE /extensions/:id`, `GET /voice/status`, `GET /me`, `GET /secrets/store`, `POST /secrets/store` |
| `/changes` | the change log newest first: source, scope, project, undo state, who asked and when, the sentence, the words used, revert time, commands / before / after behind details, Undo while undoable; project filter and "undoable only" | `GET /changes?projectId=&undoable=`, `POST /changes/:id/undo` |
| `/performance` | per mode (spec D.7, D.19): target (first token / first audio / total / by task), the effort in force (`effortLabel`: the effort, the table's when the project's offset moved it, and the effort a risky task raises it to, e.g. "medium; high from risk tier 2"; the title says whether the offset reaches the mode and the registry `max_effort` it is held at), samples, first-token p50/p90 and total p50/p90 by nearest rank, within-target share, a bar of the p90 against the target (met/missed in words), the last measurement; the window (`performance-days`: last 1, 7, 30 or 90 days, sent as `?days=`; the line under the title names the window and the project's offset); recent measurements with their source (run, chat, voice); a daemon failure is an error with a retry (the route is served, so no "route not available" state); estimate accuracy (overall and per specialist and kind); project filter; "Audit log" with a format select (JSON lines / CSV) and **Export audit log** (spec S.9): fetches the daemon's file through `client.auditExport`, saves it under the daemon's name with `saveTextFile` (`src/lib/download.ts`: a Blob behind an object URL on a hidden anchor, clicked once) and reports `Exported N rows to <file>`; says so when the browser cannot save files or the daemon lacks the route, pointing at `fr audit export` | `GET /performance?projectId=&days=`, `GET /costs/estimates`, `GET /audit/export?format=` |
| `/updates` | app: running and installed version, channel, state, the available release with changelog, size and "Update and restart", previous version with "Roll back and restart", last rollback, rejected releases, last error; connector updates (installed vs available); model updates; model watch: latest report with recommendations to adopt/ignore/remind, "Run now" (the free check: `POST /model-watch/run` with no body makes no paid eval, ADR 0089), and, when the report withheld its paid evals (`evals_deferred`), a line saying so (only Run evaluations or the opt-in runs them; Adopt applies the price rows only) and **Run evaluations** (`model-watch-evaluate`, answers `evaluate`), recent reports. **Ask first (U-076;
| `/settings` | **Your agent** (U-025; `AgentNameSection.tsx`): the name of the signed-in human's principal agent (`ownPrincipal`: the human's principal on `/agents`), editable with **Save**, which is disabled while the field is blank or holds the current name; Save posts `POST /agents/:id/rename { name }` as typed (the daemon trims, checks and answers the agent), shows "Saved. Your agent is now called <name>." and re-reads `/me` and `/agents` (`refreshIdentity`), so every place that names the agent follows; the daemon's refusal (another of the human's agents has the name, case-insensitively; empty, over 60 characters, a control character) shows as an `ErrorBanner` in its words with the field kept, and a daemon without the route shows the route-missing state; then **Accounts and keys** (a link to the setup assistant, `/setup`), **Claude subscription allowance** (U-052; `PlanAllowanceSection.tsx`: the allowance in CHF a month from `GET /settings/plan-allowance`, "(the default)" while unset, the USD it is stored as; a CHF field and Save, disabled while empty or not a positive amount, posting `POST /settings/plan-allowance { chfMonthly }` and showing "Saved. Subscription work stops at 95% of CHF … a month, from the next task on."; a note when no subscription token is saved; locked with the reason while `FORERUNNER_PLAN_USD_MONTHLY` decides), **Claude: which to use first** (U-078, ADR 0100; `BillingOrderSection.tsx`: the person's Claude credentials from `GET /settings/billing-order` in the order every call uses them, numbered, each with how it is used ("Through Claude Code" or "Straight to the API: promotional credits apply"), whether it can be used now ("Can be used now", "Not now: this month's allowance is reached", "Not now: its monthly cap is reached", "Resting until <time> after a usage limit", "Not now: no key is saved" / "no subscription token is saved", "Turned off") and what it spent this month (the subscription's share of its allowance, a key in CHF, of its cap when it has one); **Move up** / **Move down** (labelled "Move <name> up/down", disabled at the ends) post `POST /settings/billing-order { order }` with the swapped order and show "Saved: the API key, then the Claude subscription. It is in Changes, where you can undo it."; while no order is chosen a line says what the defaults are; the route-missing state for either route), theme override, daemon connection status (with links to Updates and Extensions), the **Devices** section (spec R.2; `DevicesSection.tsx`: **Pair a phone** asks the daemon for a pairing and shows the QR of its `fr://pair?u=&c=&h=` link (`QrCode`, uqr, ECC M, quiet zone of 4), the code in two groups (`K7QX-2MPA`), the service URL, the link as selectable text and the expiry counting down through the section's `UiClock`; once expired the QR and code are gone and **Start a new pairing** asks again; while the code is live the list is re-read every `pollMs` (3 s), and when a device the list did not have at the start appears the panel closes with "<name> is paired and listed below"; a service URL on a loopback host (`isLoopbackUrl`: `localhost`, `127.0.0.0/8`, `::1`) gets a warning that a phone cannot reach it and what to set; Done closes the panel and reloads the list; the devices newest pairing first with name, kind and platform, paired at, last seen, this install marked "this device" and without Revoke; the revoked ones under a collapsed "Revoked (n)"; **Revoke** opens a confirmation that says the revocation is immediate, then the device leaves the list at once with "<name> is revoked; n session(s) ended" (or, when the daemon revoked the row in the shared store because the service failed, "<name> is revoked in the shared store (the state service failed: …); its next request is refused") and the list reloads; a failure stays in the dialog and the device stays listed; a daemon without a state service (or without its admin token) answers `pairingAvailable: false` with `pairingSetup` (U-055) and the section shows the plain steps still missing (`PairingSetupSteps.tsx`: run the shared state service and choose its admin token; the address as the `FORERUNNER_STATE_API_URL` environment variable, explained as a setting of the user account with where to add it on Windows and to quit and reopen Forerunner, or "✓ This PC uses the state service at …"; the admin token pasted in a `SecretValueField` stored as `state_api_admin`; the setup guide's section linked from `pairingSetup.guideUrl`) with the button disabled; a 503 from the pairing route is a banner with Retry; a daemon without the routes shows the route-missing state for `GET /devices`, or for `POST /devices/pairing` alone, ADR 0037), the **Sources** section (spec A.4: connected GitHub orgs, accounts, repositories and local folders with their last scan's counts; connect one by kind, locator, display name and, for a GitHub kind, the token's vault reference, sent to the daemon as typed and refused there when it is not a `secret:` reference, so a pasted value is never stored; a repository URL on another git host is refused the same way; Scan or Rescan, Candidates, Remove with a confirmation that says projects stay; each candidate with its status, the existing-install mark, a link to the project it is or duplicates, and Create project on a proposal, which refreshes the project list; a daemon without the route shows a note), a **Models per agent and specialist** section (spec D.4, ADR 0072; `ModelSettingsSection.tsx`): one row per mode of the principal agent (planning, chat), the critic's review modes (read-only, with the note that its tiers set its model) and one per runnable specialist, columns Model (rung and the provider's model id; the daemon sends the rung that runs, so an agent mode set above the default ceiling shows Opus), Effort, Max tokens, Speed mode, Timeout (min) and **Temperature only when the daemon says the provider accepts one** (`provider.acceptsTemperature`; otherwise no column and the line says none is sent); each value shows its source (`effort table`, `registry file`, or a `set` badge whose title names the default it replaces); a click opens the shared change dialog (`SettingChangeDialog`, a select for rung, effort and speed with a "default (…)" entry, a specialist's efforts only up to its `max_effort`, a text input for the numbers with their range, "default" to clear) that runs `model.settings.set`; a daemon without the route shows the route-missing state, a malformed `model_config` the daemon's reason, a **Capabilities** section linking to Email (the browser and desktop control are switched in Extensions), the **Voice** card (ADR 0090; `VoiceSettingsCard.tsx`: the voice profile in force with the devices its check verified and a warning with the reason when the CPU stands in for a failed GPU check, the GPU found, the voice folder ("Installed in" or "Installs into" `folder`, with `folderNote` when it is the data folder because the install folder cannot be written; U-011), every profile with its disk size, download and trade-off, "recommended here" for the detected one; a switch is confirmed first (it names the download and the `fr voice install` command), then `POST /voice/install` and the job's progress read from `GET /voice/install/events` over fetch with the bearer header (`api/voice-install.ts`): a bar per download and the last messages; the card reloads when the job ends, re-attaches to a job still running when the page opens, and opens the stream again from the last event it has when it ends or fails while the job runs, with a backoff from 0.5 s to 10 s and the error cleared when events arrive again; **Cancel** while it runs calls `POST /voice/install/cancel`; under the profiles, **Voice providers in force** (spec O.4, U-023; moved from Extensions): the STT and TTS pair the next voice session uses with kind and reason, available or the reason it is not, and a note that local voice is used unless a cloud voice extension is on in Extensions (a link), that a cloud one needs its key, that a change applies at the next session and that `FORERUNNER_VOICE_STT` / `_TTS` override both; re-read on every `extension.changed` frame and when an install ends; a daemon without `GET /voice/status` shows nothing there), every setting grouped by scope with the scope badge; rows that map to a command have Change: a dialog with the current value (a three-stop slider, speed / balanced / quality, for a project's speed-versus-quality row, spec D.16), the change card from the daemon, Yes/No (a tap; a high-risk card asks this paired device), the sentence with Undo, a link to Changes; other rows say read-only | `GET /me`, `GET /agents`, `POST /agents/:id/rename`, `GET /settings/plan-allowance`, `POST /settings/plan-allowance`, `GET /settings/billing-order`, `POST /settings/billing-order`, `GET /settings`, `GET /settings/models`, `POST /commands/execute`, `POST /commands/:id/confirm`, `POST /changes/:id/undo`, `GET /devices`, `POST /devices/pairing`, `POST /devices/:id/revoke`, `GET /voice/install`, `POST /voice/install`, `GET /voice/install/events`, `GET /voice/status` |
| `/setup` | The setup assistant (ADR 0092; `SetupPage.tsx`): Welcome (name and time zone, the browser's zone when the daemon says UTC), Claude (API key or Claude subscription, with "Get an API key" to the Claude Console), GitHub ("Create a token on GitHub" opens GitHub's form with the permissions filled in; the permissions listed under details), Done (what is connected, the caps, Docker optional) with **Start using Forerunner**. Each secret box (`SecretBox`) is a password field with Show, Paste (the clipboard when the webview allows it, else a Ctrl+V hint) and Check and save; a paste checks at once and the field is cleared after sending; a value with a line break or a space inside is not sent (the box is cleared and a hint says to copy it again in one piece, without showing it; U-053); the daemon's summary and problems are shown (amber when the value was saved with warnings), with, for a GitHub token, "Repositories this token reaches:" and each repository's access (read and write, read only, admin; the first 20, then "and n more"; U-051), a value in the wrong step is the daemon's 400 as a banner. Finish posts `/setup/finish`; when the daemon restarts to use a new key the page waits for `/health` (the desktop shell reloads the window itself). **Set up later** closes it. A saved check says when the key is used (U-049): "In use from the next request. No restart needed." for a replaced key (the daemon reads it per call), or that the service restarts once when the assistant is finished or left, for the first key of its kind (`restartNeeded`); leaving the page any other way (the sidebar, a link) with `restartNeeded` set posts `/setup/finish` on unmount, so the restart is not lost. The `Shell` opens it on mount while `GET /setup` says `showAssistant` (`useSetupGate`); a daemon without the route leaves the app as it was. Settings → **Accounts and keys** links here. External links are plain `<a href>` in the shell (`ExternalLink`: the navigation policy opens them in the OS browser), a new tab elsewhere | `GET /setup`, `POST /setup/profile`, `POST /setup/anthropic`, `POST /setup/github`, `POST /setup/finish` |
| `/settings/capabilities/email` | Settings -> Capabilities -> Email (spec S.15, S.28, S.29, T.14; ADR 0066): one card per **principal** agent of the signed-in human (`/agents` filtered by `/me` and `kind: principal`; U-075: the daemon uses the principal's mailbox only, so the critic gets no card, and a line says email is used by your agent only) with the mode badge and the mailbox address; pause / resume with the state (the tray's routes); the **mode picker** over the five modes with their one-line meanings and the plain full-discretion sentence ("the agent can email strangers on your behalf …") under the option before any change; Apply runs the registry's `email.mode.set` (`POST /commands/execute`, `source: ui`, the agent's id named; spec Q: a mode change is high risk; ADR 0066 amended 2026-10-25) and opens the dialog with the daemon's card (`CommandResult`: old → new, high risk, "Confirm on this device" answering `{ answer: "device", deviceId: <me.desktopDeviceId> }`, No cancelling the card on the daemon with nothing changed, the done sentence shown as the mode note with Undo through `POST /changes/:id/undo`, a refusal as such with the card left open), the full-discretion sentence repeated in that dialog beside the card; the mode never travels in a `PUT` (the daemon and the fake answer 403 `mode_change_needs_command`), and after a done change or an undo the card re-reads the settings; the limits that stay on (daily and per-recipient caps, signature on/off and text, daily digest) and, in allowlist mode only, the allowlist editor (one entry per line); the mailbox form (address, IMAP, SMTP, passwords as `secret:<name>` references; the daemon's 400 for a value shown as such; the stored TLS flags and folders the form has no field for are carried as they are, because the daemon replaces the mailbox whole and would otherwise reset them to the schema's defaults, review of 2026-10-25); the command settings (toggle, the registered address, the private marker with Rotate, the task cap, the autonomy level; ADR 0081: a mode change to off that turns commands off says so in the card's sentence (the registry's words, shown as the mode note) and the toggle follows the stored value, and turning commands on at Off shows the daemon's 400 sentence; the fake daemon mirrors both rules, `email-settings.test.tsx`); the **command audit** newest first (when, from, subject, interpretation, result with a session link, the reason a mail was ignored); the sent copies newest first (to you / to others, the copy as sent). A daemon without the routes shows the route-missing state per card; another human's agent is not listed; per side a password box (`SecretValueField`, U-054) that stores the typed password with `POST /secrets/store` under the name the reference field names when it is a mailbox password name, else the agent's default (`agent_imap_password` for the principal, `<agent>_imap_password` for another agent; `mailboxPasswordName`), fills the reference in and is emptied | `GET|PUT /agents/:agentId/email/settings`, `POST /agents/:agentId/email/pause`, `.../resume`, `.../rotate-marker`, `GET /agents/:agentId/email/commands?limit=`, `GET /agents/:agentId/email/sent?limit=`; the mode through `POST /commands/execute` (`email.mode.set`), `POST /commands/:id/confirm`, `POST /changes/:id/undo`, `GET|POST /secrets/store` |
`UpdateConfirm.tsx`):** "Update and restart" and "Roll back and restart" read `GET /health` when pressed and, while
`activeSessions` is above 0, open a dialog that names how many sessions the restart stops (`updates-confirm`, "Not now"
sends nothing); with none running they act at once. "Run evaluations" names what the runs may spend before it runs them
(the report's `eval_budget_usd_micro` in CHF, on the button, in the deferred line and in its dialog) and answers
`evaluate` only after the dialog's yes. Opening the screen (the sidebar's **Updates** entry, `g u`, the command palette) reads local state only, with "last checked …" or "not checked yet"; **Check for updates** (`updates-check`) is the only thing that asks the release feed and keeps the local view with a banner when the feed is unreachable; installing stays the human's "Update and restart" click (the human's decision of 2026-10-25, ADR 0015 amendment); when the release's artefact for this platform is an OS installer (`isInstallerArtifact`: the desktop's MSI, AppImage or `.deb`, which the staged install cannot run), the screen shows **Download the installer** (`download-installer`, the view's `artifactUrl`) with a note to run it instead of the button (ADR 0092) | `GET /updates`, `GET /updates/status`, `POST /updates/check`, `POST /updates/apply`, `POST /updates/rollback`, `GET /model-watch/reports`, `/latest`, `POST /model-watch/run`, `POST /model-watch/reports/:id/answer` |

### API client

`createClient(config, fetchImpl?)` returns a `DaemonClient` with one method per entry of
`DAEMON_ROUTES` (phase-1 routes, `renameAgent(id, name)` over `POST /agents/:id/rename`
answering `AgentView`, U-025, decisions, peers, project settings and the mirror, estimates,
extensions, updates, model watch, reviews, memory and consolidation, commands and the change
log, `milestones` and `changeMilestone`, the data assets `dataAssets`, `registerDataAsset`,
`removeDataAsset`), the project page's panels (`queue`, `enqueue`, `dismissQueueItem`,
`docs`, `doc` over the daemon's routes since U-004 and U-005, with `QueueItemView`, `DocView`
and `DocContentView` from `api-types.ts`; `importProject` over `importData`,
`POST /projects/:id/data/import`, with the runtime's `ImportResultView`, since U-006),
`startSession` (`StartSessionView`: the scheduler's outcome, the start's id and the session it
began, U-003), `performance(filter?)` (`GET /performance?projectId=&days=`
from `DAEMON_ROUTES`, validated with the runtime's `PerformanceView`, no mirror), the source discovery methods (spec A.4: `sources`, `addSource`, `scanSource`,
`sourceCandidates`, `acceptCandidate`, `removeSource` over `DAEMON_ROUTES`, their schemas
read straight from `daemon/api-types`, no mirror), the agent email routes (`emailSettings`,
`updateEmailSettings`, `emailSent`, `pauseEmail`, `resumeEmail`, `rotateEmailMarker`,
`emailCommands`; views from `api-types.ts`, no mirror), the desktop control routes the banner
uses (`desktopStatus`, `desktopRevoke(reason?)`, `desktopResume`; `DesktopStatusView` and
`DesktopRevokeView` from `api-types.ts`, ADR 0067), the device methods (spec R.2:
`devices`, `startPairing`, `revokeDevice` over the daemon's `/devices` routes; the daemon,
not `state-client.ts`, is the path because the service's `pairing/start` and revoke routes
are admin-only and the admin token stays in the daemon, ADR 0009), `auditExport(filter?)` (spec S.9:
`GET /audit/export` with `agentId`, `sessionId`,
`from`, `to` and `format`; the body as text with the row count and the base name from
`Content-Disposition`, `filenameFromDisposition` / `countExportRows`) and `url()` / `raw()`
for the stream helpers. Paths come from `routePath(name,
params)` over `DAEMON_ROUTES` or `proposedPath(name, params)` over `PROPOSED_ROUTES` (which
follows the daemon's entry as soon as one exists; empty since U-004 to U-006), URL-encoded; the client sends
`Authorization: Bearer <token>` and validates every JSON body with the contract's zod schema.
Failures are `ApiError { code, status, details }`: the daemon's `ErrorBody.code` when it sent
one (flat, or wrapped under `error` as the capability routes for email and desktop answer
it), else `ui.network`, `ui.http_error`, `ui.invalid_response`, `ui.aborted`.
`isRouteMissing(error)` is true for a 404/405/501 that is not a typed `not_found` about an
entity; `useAsync` exposes it as `routeMissing` and the pages render `<RouteMissing>` (ADR
0032). `describeError()` turns an error into a banner line without leaking the token (a typed
403 keeps its message, an untyped one is the token). Types the contract exports only as
schemas are derived in `client.ts` with `z.infer`.

Config (`api/config.ts`): `window.__FORERUNNER__` from the shell, else
`import.meta.env.VITE_DAEMON_URL/_TOKEN`, else `http://127.0.0.1:8787` with no token; the Shell
shows a "Not connected" banner until `/health` answers. The import is
`@forerunner/runtime/daemon/api-types` (browser-safe); never import the runtime package index
from the UI. `contracts.ts` mirrors the schemas of `extensions/types.ts`, `update/screen.ts`,
`models/watch.ts` and `estimates/view.ts` field for field; `test/contracts.test.ts` parses the
fixtures with both sides and compares key sets so drift fails before a screen does.

### Commands from the UI

The email page's mode picker is a client of the registry too (ADR 0066, amended 2026-10-25
on review): Apply runs `email.mode.set` with the agent's id through `POST /commands/execute`
(`source: "ui"`), shows the daemon's high-risk card in its dialog through `CommandResult`,
answers it on this paired device, and offers the change log's Undo; the full-discretion
sentence is repeated in that dialog beside the card. The caps, the allowlist, the signature,
the digest, the mailbox and the command settings go through the capability's own `PUT
/agents/:agentId/email/settings`, which audits every change as an `email.settings` row and
which the policy reads on the next send; they have no change card and no undo (the spec's
risk table names the mode, not them), and a `PUT` carrying another mode is the daemon's 403
`mode_change_needs_command`, which the fake mirrors.

The settings screen is a client of the command registry (spec Q.1, ADR 0037):
`commandForSetting(row)` maps `project.autonomy` to `autonomy.set`, `project.budget` and
`human.monthly_cap` to `budget.set`, and the keys of `SETTING_SPECS` to `settings.set`; the
dialog posts `executeCommands({ commands: [one], wordsUsed: "Settings: <label> to <value>",
source: "ui" })` (the change log row reads `ui`, where chat and voice read theirs),
shows the daemon's card through `CommandResult`, answers `needs_yes` with `{ answer: "tap" }`
and `needs_device` with `{ answer: "device", deviceId: <me.desktopDeviceId> }` (this PC's own
device row as `GET /me` names it, ADR 0030: the daemon checks the row like any paired device
and refuses an id it does not know, which the dialog shows as a refusal with the card still
open; while `/me` has not loaded, or failed, the answer goes without an id and the
daemon-token route answers with its own desktop row; a daemon whose `/me` names no row, one
composed without its services, refuses that id-less answer with 409 `conflict` "deviceId is
required: this daemon has no desktop device row to answer for", shown as the dialog's error
with the card still pending), and shows the sentence with Undo (`POST /changes/:id/undo`). The
daemon status block shows the row as "This PC: paired device <id>", or, when `/me` names none,
that high-risk changes cannot be confirmed on this PC. `ChangeCard` renders the
spec Q.4 card (what, old → new, scope, duration, impact, undo hint, the parts of a plan) from
the daemon's `card` through `parseChangeCard` (lenient: unknown fields kept, missing ones
defaulted).

Every setting has a plain label and a control of its own (U-060): the table shows the daemon's
`label` (`settingLabel`, with `SETTING_LABELS` for an older daemon) and the value in words
(`describeSetting`: "from 22:00 to 07:00", "on", "asks before any paid evaluation"), never the
key or JSON; the dialog's title is "Change <label> for <project>". `structuredCommand`
(`pages/SettingsFields.tsx`) gives each structured setting its control: quiet hours (a check box
and two time fields; off sends `null`), the notification channel, voice alerts, small-project
mode and fast mode (lists), the highest model (the ladder's four rungs), the default autonomy
(the five levels by name), the budget per session (`budget.set` scope `session`, CHF), the model
watch (two check boxes) and the monthly calibration and handover test (labelled fields:
enabled, day, time, budget, and the handover's seed as title, outcome, criteria and files one
per line; a half-filled seed is not sent). `inputType: "fields"` renders `FieldsInput`, which
keeps the values as JSON of name to text that `params` turns into the command's value. The
language and the review reserve are shown without a control (`INFORMATION_ONLY`: stored, read
by nothing yet; the daemon's description says so). Settings → **Desktop control: allowed
applications** (`DesktopAllowlistSection.tsx`, the heading `DESKTOP_ALLOWLIST_CONTROL` the
desktop approval card names) lists the allowlist (`GET /desktop/allowlist/:humanId`) and adds or
removes an application (`PUT` with the whole list; the daemon stores names as `{ app }`).

An undo from the setting dialog, the Changes screen or the Tasks tab can come back `pending`
(U-057: it puts back a higher limit): the dialog shows the card again, and Changes shows it in
`changes-undo-pending` with "Confirm on this device" (`{ answer: "device", deviceId }`), Yes
(`tap`) or No ("Undo cancelled. Nothing changed."). Changes offers Undo only while the row's
`undoable` is true and otherwise shows `undoBlockedReason` ("Cannot be undone now: ..."); a
refused undo reads "Not undone: <reason>." (U-061). A move in the Tasks tab shows its change log
sentence with Undo (`TaskTransitionView.change`) and a link to Changes.

The Opus fast mode card (spec D.20, ADR 0057) sits above "All settings" when the daemon lists
`project.fast_mode` rows (`fastModeRows`): the row's description is shown as written (what the
flag is, then "On: ..." and "Off: ..." with the two rates and the surcharge factor, priced by
the daemon from the table in force; the UI computes no price), then one line per project with
its name from the store's project cards, an on/off badge and a Turn on / Turn off button.
The button opens the same setting dialog with the other value prefilled (`fastModeToggle`, the
`settings.set` command of `commandForSetting` with a flipped `initial`), so the change card
the daemon returns carries the effect and the surcharge of the direction asked; medium risk,
so it needs a tap. Without the rows (an older daemon) there is no card. `fast_mode` is in
`SETTING_KEYS`, so the row in "All settings" opens the same command. With the built-in table
the card reads USD 8 / 40 against 4 / 20, a 2x surcharge, and no longer says "research
preview": Opus 5.5 fast mode is generally available (ADR 0057 amendment, 2026-10-25);
`test/fast-mode.test.tsx` pins those sentences exactly.

The project's speed-versus-quality slider (spec D.16; `project.speed_quality_offset` in
`GET /settings`) is the one row that is not a typed value: `commandForSetting` gives it
`inputType: "slider"` over `SPEED_QUALITY_POSITIONS` (-1 speed, 0 balanced, +1 quality) and
the dialog renders `SliderInput`, a range input from -1 to +1 in steps of 1 with the stop names
under it (each one a button that picks its stop, `aria-pressed` on the chosen one), the chosen
stop's effect, and "Current: balanced (0)" as the hint. The table cell reads the row by
position (`speedQualityLabel`: "quality (+1)"; unset or junk reads balanced, as the runtime
reads it). A move is still one `settings.set` through `executeCommands` with `source: "ui"`,
and the words used name the position ("Settings: Speed or quality to speed (-1)");
the sentence with the effect comes from the daemon (`commands.md`). The Performance view does
not move the slider: it shows response times per mode and, per mode, the effort in force that
the slider's position yields (held at the registry's `max_effort`), as the daemon computes it,
from the table's effort or the principal's own D.4 setting (`effortSource: "agent"`, which
`effortLabel` names "your setting", e.g. "medium (your setting low)").

The model settings section (spec D.4) uses the same dialog: `modelSettingCommand(target, field,
value)` builds a synthetic row (`specialist.<name>.<field>` or `agent.<mode>.<field>`, scope
`agent`) and a `SettingCommand` named `model.settings.set` whose `params` give `{ agent, mode |
specialist, field, value }` (`null` for "default"; numbers checked against the command's ranges
before the post; a rung or effort outside the lists refused); `SettingCommand.options` makes the
dialog a select. The rows say what runs (U-059): a row whose `speedModeApplies` is false (chat
and planning) shows "standard (always)" with no button; each row shows its `ceiling.note`; the
model list stops at a ceiling nothing raises (chat: no fable) and labels a rung above a raisable
one ("fable (runs only where a project's highest model is fable; else opus)").

### Realtime and streaming

`subscribeDaemonEvents(client, humanId, handlers)` and `subscribeSessionEvents(client,
sessionId, handlers, { afterSeq })` open an `EventSource` on `/events` or
`/sessions/:id/events` with the token as `?token=` (EventSource cannot send headers, ADR
0025). Events are parsed with `parseDaemonEvent` (`session.event`, `inbox.changed`,
`session.changed`, `project.changed`, `agent.changed`, `extension.changed`, `restart.requested`,
`desktop.indicator`, `speak.started`, `heartbeat`; unknown or malformed frames are dropped).
`agent.changed` (`{ id, name }`, an agent renamed in Settings here or in another window,
U-025) re-reads `/me` and `/agents` through `refreshIdentity`. `extension.changed`
bumps `extensionsVersion` in the store so the Extensions panel reloads (and re-reads desktop
control, which a panel toggle revokes or resumes); `desktop.indicator` sets `desktopControl`
(`desktopControlFromIndicator`), and because a frame sent while the stream was down is lost,
`refreshDesktopControl` re-reads `GET /desktop/status` at bootstrap and every time `onMode`
reports `sse` (first open and every reopen), and the polling fallback turns the status into
the frame it stands for (`indicatorFromStatus`, spec S.32, ADR 0067). The read and the stream
are two connections, so an answer given before a frame can arrive after it: the store orders
them (`desktopOrder`; a `desktopRead` action takes a token, and the read's answer applies only
if no frame or later read landed since), and a stale "off" never hides a running burst's
banner. When a frame turns control off, `refreshDesktopControl` re-reads the status so a stop
from any shell (the tray included) shows the "stopped" line; `restart.requested` sets `restart` (the shell shows a
banner on every page) until a heartbeat arrives from a daemon on the target version. When
`EventSource` is missing (jsdom) or closes, the helper polls every 5 s and retries SSE every
30 s; `onMode` reports `connecting | sse | polling | closed`. **The connection status follows
the daemon (U-071):** a poll the daemon does not answer, or refuses with 401, calls `onDown`
and the header reads "not connected" with **Retry** (`connection-retry`) and a banner saying
why in plain words (`NOT_REACHABLE`, `TOKEN_REFUSED`); the next poll that goes through, or the
live stream (re)opening, calls `onUp`: "connected" again, and `/health` (the kill switch) and
the project list are read again. A start where nothing answered retries on the poll cadence;
**Retry** dispatches `reconnect`, which bumps `connection.attempt` and makes `AppProvider`
bootstrap and reopen `/events` at once. A heartbeat alone no longer sets "connected". The live
session view (`SessionPage`) does not subscribe to a session that has ended (`ENDED`:
completed, stopped, failed, killed; the daemon ends that stream, so an EventSource would
reconnect and the fallback poll for good) and shows **finished**; a session that ends while
the page is open (a `session.ended` event on the stream, or a `session.changed` with an ended
status from the poll) closes the stream after one last read of the header and the log. The page
reuses the provider's `streamOptions` (`useStreamOptions`), so tests poll fast. Chat uses `streamChat()` over
`POST /chat/stream`: `token` frames build the reply as they arrive, the `reply` frame finishes
it, `error` frames become `ApiError`; a plain JSON `ChatReplyView` is accepted as well.

**Speech player (ADR 0063).** The window is what makes the daemon's speech audible: the desktop
sidecar shows toasts but plays no audio and the daemon's own sink only paces the frames. Where
the window has EventSource and Web Audio (`canPlaySpeech()` in `lib/speech.ts`; tests pass
`AppProvider`'s `realtime: { eventSource, audio }`), `AppProvider` opens `/events` with
`?speech=play` (`subscribeDaemonEvents(..., { speechPlayer: true })`), so the daemon counts it
as someone who hears voice alerts and `summary.speak`, and hands every `speak.started` frame to
`createSpeechAnnouncer`: an utterance announced for any player (`player: "any"`: an urgent
alert, `summary.speak` by chat) is played with `playSpeech`, one at a time (a newer one
replaces it, as the daemon has one voice); one with `player: "requester"` is the Read aloud
button's own and left to it. `playSpeech` resumes the AudioContext (one created without a user
gesture may start suspended), decodes the base64 16-bit PCM frames and schedules them back to
back. The daemon holds playback until the stream attached (`runtime.md`, "Read aloud"), so the
first words are not lost. On `speak.done` with state `done` it keeps the output open until the
scheduled audio has played (what is left after `currentTime`, plus `baseLatency`,
`outputLatency` and `SPEECH_TAIL_MARGIN_MS`, 50 ms; a `setTimer` seam), then closes it and
resolves `done`; a cancel, a failure or `stop()` close at once. The daemon also announces the
end only once its sink's play-head has played out (`voice.md`, `AudioSink.drain`); before
both, closing on `speak.done` cut the last ~300 ms.

### State

`createStore(config, storage)` holds `UiState` (`connection`, `me`, `agents`, `projects`,
`activeProjectId`, `blockingCount`, `killActive`, `theme`, `restart`, `extensionsVersion`,
`desktopControl`: `{ active, app, sessionId, agentId, since, revoked }` or null before the
daemon said anything, set from a frame by `desktopControlFromIndicator` and from a status by
`desktopControlFromStatus`, where `revoked` is a stop the banner can resume and never a
revoke by the Extensions panel (reason "… disabled|removed in the Extensions panel"); and
`desktopOrder`, the frame/read order above; `chats`: each project's Chat conversation,
U-071, below);
React reads it with `useUiState(selector)` over `useSyncExternalStore` (selectors must return
stable values). `activeProject` and `theme` persist in `localStorage` under
`forerunner.ui.<installId>.<name>` (`lib/storage.ts`, wrapped in try/catch; `memoryStorage()`
in tests). Page data stays in the page through `useAsync(loader, deps)` (`data`, `error`,
`routeMissing`, `errorStatus`, `loading`, `reload`, `setData`), which aborts stale loads.
The Chat tab's conversation is the exception (U-071: a tab switch or a reload lost it, with an
unanswered Yes/No card): it lives in `chats[projectId]` (`store/chat-history.ts`). The tab
dispatches `chat.load` on mount (the store reads `forerunner.ui.<installId>.chat.<projectId>`,
a reply cut off by a reload turned into one that says so) and every change as `chat` with an
updater, so a reply still streaming after the tab closed lands in the store; the store saves
the newest 100 messages when a message is added or a reply ends (not on every token). The
daemon has no per-project transcript route, so the window keeps what it showed.

### Money

`lib/money.ts` formats `chfMicro` as "CHF 12.34" (half-up, ties away from zero, Swiss `'`
grouping) and never prints USD except in `moneyTooltip`. `SpendBar` shows spent vs cap with the
percentage and colours at 80 % and 100 %. CHF inputs convert with `chfMicroToUsdMicro(chf,
referenceMoney)` at the rate implied by a Money pair (default 0.80, ADR 0008). A setting whose
value is a Money pair renders as CHF.

**Plain words (U-074).** `lib/plain-words.ts` turns the daemon's every-channel texts into what
the app says: `inAppText` drops "Say yes to confirm, or reply yes to the email." and turns "Say
undo or tap Undo in the change log." into "Undo it from Changes." (the change card's undo line,
a command's read-back, a pending chat confirmation, an Inbox card's steps); `withoutUndoWord`
strips a change sentence's spoken "Undo.": the settings dialog shows its Undo button, a Chat
reply an **Undo** button for each action with an `undoToken` (`POST /changes/:id/undo`, the
outcome said under the reply), an Inbox message a link to Changes. `reviewLevel`,
`verdictLabel` and `autonomyLabel` name the tier, the critic's call and the autonomy level
(Tasks, Plan, Reviews, the new-task dialog, the project header and card). Ids are shown as
names: a setting's scope (`scopeName`: you, the agent, the project), a lesson's project, a
task's dependencies (by title), the Inbox's answered list (the answer's words, never JSON). The
Chat header says what happens: a small change is made at once with Undo, a bigger one is read
back and waits for Yes. The intake card's estimates are CHF (`usdMicroToChfMicro`).

### Charts

`components/charts.tsx` draws the two charts in SVG without a library: `TrendLine` (one series,
2 px line, 8 px markers with a hover title, a dashed reference line, recessive grid, text in
the text tokens, "No data yet" when empty) for the grade trend, and `TargetBar` (one thin bar
for the measured p95, a tick for the target, emerald/red only for met/missed and always with
the word beside it; blue when there is no target) for the Performance view. Both follow
`data-theme` for dark mode; the numbers always stand in a table next to the chart.

### Shell, palette, shortcuts, theme

The header always shows the active project, the one of every channel (U-056): at start the one
`/me.activeProjectId` names (the daemon's record) over this window's stored choice, and the
switcher, the palette's "Switch project", Home's Make active and Open and a new project from
the dialog run `project.switch` (`switchActiveProject` in `store/context.tsx`, `source: "ui"`,
logged in Changes) so chat, voice and the phone use it too; opening a project page does not
switch it, and that page's Chat tab sends `projectTab: true` so its turn is about that project
(the button opens a switcher listing every project and "+ New project"), the nav (Home, Inbox with the blocking badge, Memory, Extensions, Changes,
Performance, Updates, Settings; collapses behind a menu button under 768 px), the connection
badge, the palette button and the kill switch (`POST /kill {scope:"all"}`; the button then
reads "Resume" and posts `/kill/resume`), plus the kill banner and the restart banner.
Above the header, as the window's first child and outside the scrolling `<main>` (so on every
page and through navigation), `shell/DesktopControlBanner.tsx` shows desktop control while
`desktopControl.active` (spec S.32, ADR 0067): white on red with a yellow rule,
`role="alert"`, "Desktop control active", the agent's name (from `agents`, the id when
unknown), the application ("the desktop" until the controller names one) and the session as
a link to `/sessions/:id`, with "Stop desktop control" (`POST /desktop/revoke`: interrupts and
refuses desktop actions until resumed; the sessions keep running, unlike "Stop all"). After a
stop (from the banner, the tray or the route) an amber line says desktop control is stopped,
with "Resume desktop control" (`POST /desktop/resume`); a revoke by the Extensions panel shows
no such line (the panel is where it is undone, and resume alone would not undo it). A failed
stop keeps the banner with the error.
`Ctrl/Cmd+K` opens the palette (`shell/commands.ts` builds navigation, "Switch project: …", New
project, "Start session: <active project>" (opens `StartSessionDialog` from the shell, U-077),
Stop all/Resume, theme and shortcuts commands; `filterCommands` matches every word). The header's
palette button reads `paletteShortcut(config.platform)`: "⌘K" on macOS only, "Ctrl+K" on
Windows and Linux (U-077).

**Small fixes (U-077).** The setup assistant says where a pasted key is kept as `/health`'s
`vaultBackend` reports it (`vaultWhere`: the OS credential store only for `keyring`, "an
encrypted file on this computer" otherwise) and prefills the name the daemon sends (empty for its
placeholder, `shownHumanName` in `daemon/human-name.ts`). A failed **Check for updates** says
"the last check failed" and why, not "not checked yet". The Cancel-task dialog's buttons read
**Keep task** and **Cancel task**. Extensions' empty Specialists group says the built-in
specialists are not extensions and links to Settings; the note after adding an extension that
waits for approval goes once it no longer waits (approved here or in the Inbox, denied,
removed). The start dialog shows the daemon's 409 under Stop all (`KILL_ACTIVE_START_MESSAGE`).
Shortcuts (`shell/shortcuts.ts`): `g h` Home, `g i` Inbox, `g s` Settings, `g p` active
project, `g m` Memory, `g e` Extensions, `g c` Changes, `g t` Performance, `g u` Updates, `?`
help, `Escape` closes; sequences are ignored inside text fields, chords with a modifier are
not. Theme: `system | light | dark`, resolved to `<html data-theme>` and `color-scheme`;
`styles.css` binds Tailwind's `dark:` variant to that attribute with `@custom-variant`.

**Conversation and the global hotkey (spec O.1, ADR 0064).** `shell/ConversationPanel.tsx` is
a dialog opened by the desktop shell's global hotkey (`forerunner://hotkey`, see "What the
Tauri shells inject"), the palette's "Talk to your agent" entry (hint: the chord) and the
header's Talk button (opens without starting voice). Every voice request (a hotkey press, the
palette, the panel's Talk button) toggles a push-to-talk turn through the daemon's `/voice`
routes: `GET /voice/status`, then `POST /voice/sessions { mode: "push_to_talk", replyMode,
projectId? }` once per panel (reused for later turns), `POST …/press { pressed: true,
replyMode }` (every press says it), the microphone
(`shell/voice-capture.ts`: getUserMedia + ScriptProcessorNode, 16-bit LE mono PCM, base64)
posted chunk by chunk to `…/audio`, one post after the other (the daemon appends chunks in
arrival order); the next request (or Send) stops the capture, waits until every chunk of the
turn was posted (the daemon's loop drops audio that arrives after the release), posts
`{ pressed: false }` and polls `GET /voice/sessions/:id` (500 ms, at most 60 s) until the turn
count grows (a press answer has no `recentTurns`, so a last `GET` fetches them when needed);
every ended turn in the answer's `recentTurns` not applied yet then completes its
lines (not only `lastTurn`: without the event stream, a turn cut short by a barge-in while the
panel waited for it would otherwise be lost), and a turn with nothing heard, no reply and no
error adds no "Agent:" line. A press while a session is live posts the press first, with no
status read before it, so a barge-in reaches the daemon at once. A press counts only when the
daemon's answer names a newer turn that is `listening` (the daemon queues a press that comes
while the last turn transcribes and answers once the new turn listens, `voice.md`); otherwise
the panel undoes the player's silencing (`interrupt()` returns the undo, compare-and-restore: it
leaves a bound a later press raised and a turn a real `barge_in`, `error` or cut-short
`turn_end` silenced in between) and, if it was waiting for a reply, goes back to waiting for it.
A press that gets 404, or 409 "has ended" (the daemon restarted, the session was stopped
elsewhere), forgets the session, takes the old player's audio output over
(`player.detachOutput()`: made in the click, it may start, where one made after the awaits may
not) and tries once more through the status read and a new session. A turn cut short by a press
while it transcribed carries its words into the next turn (`voice.md`): its `turn_end`
(`continued`) announces nothing, and the next turn's line is marked "(continued)"
(`data-continued`, from `transcript_final.carried`, or from the record's `carriedFrom` when the
panel only polls).
The text itself shows as it comes, from the session's event stream (below; the player hands
every frame but `audio` to the panel's `onFrame` after its seq check, so a reconnect's replay
shows nothing twice): the human's line from `transcript_partial` (italic, `data-partial`, as
often as the STT gives partials: faster-whisper re-transcribes once a second while the button
is held, a cost the daemon pays anyway) and then `transcript_final`; the agent's line from the
first non-empty `model_delta` (the conversation agent's sentence gate sends whole sentences
after an empty first piece, which adds no line), each finished `sentence` its own span and the part of the next sentence
generated so far after it (`consume` drops a sentence's text from that tail; the splitter's
sentences are trimmed substrings of the deltas). The sentence being heard is marked
(`data-speaking`, a highlight, `aria-current`; not a live region): the player's
`onSpeaking(turn, sentenceIndex)` fires by a timer when a sentence's first chunk is due at the
speaker (its scheduled start), not when the frame arrived, and silencing cancels what is not due
yet. The mark is cleared by the player's `onSpeakingEnd(turn)`: once the daemon said the turn's
audio is complete (`speaking_end` or `turn_end`) and the last node scheduled for it has ended,
not at the daemon's `turn_end` (the window plays on after it) and not when the queue runs dry in
the middle of the turn (an underrun); a reply cut short clears it at once. The visible lines are not a live region (they change with every
delta); a visually hidden `role="log" aria-live="polite"` (`conversation-announcer`, the last 20)
announces the human's final words, each finished `sentence` of a reply in text (a spoken
reply's sentences are heard; announcing them would talk over the TTS; the turn's mode comes from
its `turn_start`), every `error` in either mode, the end of each reply ("End of reply.", "Reply
interrupted; the rest was not spoken.", "Reply stopped.") and a typed chat's reply once it is
complete. A reply cut short (its `turn_end` carries
`unspokenText`) shows what was heard, then the unspoken rest (`conversation-unspoken`): a small
muted "not spoken" pill first (`conversation-unspoken-marker`, neutral-600 on neutral-100 in
light, neutral-400 on neutral-800 in dark, both above 4.5:1), so where speech stopped is
visible, then the words in the line's normal colour with a subtle dotted underline. No
strike-through and no grey text: the real-voice run of 2026-10-26 found struck-through text
hard to read, and the review of the first fix found a marker only at the end left the two parts
indistinguishable. The announcer still says "Reply interrupted; the rest was not spoken.". One
stopped with nothing unspoken (a text reply)
says "(stopped)". The lines of a voice turn are keyed by session and turn
(`<session>:<turn>:<role>`): the `voice.turn` frame and the polled record update them and add
them only when the stream showed nothing (no EventSource). **The reply mode** ("Reply:
[Voice | Text]", the `voice-reply-mode` `SegmentedControl` from `components/ui.tsx`: a
`role="radiogroup"` named "Reply" holding two visually hidden native radios, so one tab stop
and the arrow keys move the choice; the chosen side, `data-checked="true"`, is a raised pill
(white with a neutral-500 border, bold and a shadow in light; neutral-600 with white text and a
neutral-400 border in dark), not blue, so it does not read as a second primary button beside
Send; every side's text is above 4.5:1 and the chosen pill's outline above 3:1 against the
track in both themes, which `test/contrast.ts` checks from the class names; it replaced a "Reply in text" button with `aria-pressed` that did not read as
a toggle; `UiState.voiceReply`,
remembered per install like the theme under `STORAGE_NAMES.voiceReply`, default Voice) is sent
with the session start and with every press; the daemon applies it to the turn the press
starts (`voice.md`, "Reply in text"). In text nothing
plays and nothing is measured as heard (no audio frame comes; the release is forgotten at the
turn's `turn_end`). While a reply is generated or spoken (phase `waiting`) Talk and the hotkey
stay available: the press is the barge-in (`startTurn` bumps `waitRef`, so the release still
polling for the previous turn stops without touching the phase), which in text stops the
generation. The press silences more than the turn being played: `player.interrupt()` drops every
turn up to the newest one a frame named (the turn barged in on may still be thinking, with no
audio yet), and `player.silenceBefore(turn)` with the turn the press's answer names drops every
earlier one, so no late chunk of a turn cut short plays. The reply is
also heard: from the session's start the panel follows `GET /voice/sessions/:id/events`
(EventSource with `?token=`, `afterSeq` = the session's `lastSeq`; `shell/voice-playback.ts`)
and plays every `audio` frame (base64 16-bit LE PCM at its `sampleRate` and `channels`,
decoded with `decodeFrame` from `lib/speech.ts`) back to back through Web Audio, in arrival
order, behind a jitter buffer. A turn starts once `JITTER_START_MS` (200 ms) of audio is in
hand, or earlier once the buffered sentence is known to be complete (a chunk of the next
`sentenceIndex`, `speaking_end`, a normal `turn_end`) or nothing came for `JITTER_IDLE_MS`
(250 ms). A chunk that arrives after the queue ran dry inside a turn is an underrun: the turn
re-buffers to the target before resuming, so late audio (the real-audio run of 2026-10-26: a
gap inside a word at every late 100 ms chunk; the cause, `voice.md` "Known issues") pauses
once instead of at every chunk. When the late chunk belongs to the sentence of the last chunk
scheduled, the target first doubles, up to `JITTER_MAX_MS` (1 s); at a sentence boundary it
stays (that pause is the model or the TTS starting the next sentence, not the rate). The
target lives as long as the session's player and never shrinks (`player.bufferTargetMs`).
`player.interrupt()` silences what plays and drops what is buffered; `startTurn` calls it
before anything else, so a Talk press stops a reply the window still plays after the daemon's
turn ended (its buffer and lead: up to ~1.35 s once the target grew). Buffered
audio starts `PLAYBACK_LEAD_MS` (50 ms) after the context's current time, or right after what
still plays, so a main-thread stall between scheduling and rendering does not clip it into a
click; queued chunks follow without a gap and without a fade (consecutive chunks are one
waveform; a fade would dip every chunk). The cost is first-audio latency: about 200 ms of TTS
output at a session's start (with a fast TTS little more than the time to produce it, since
the daemon's sink sends the first 300 ms at once; `voice.md`), up to 1 s after underruns. The player keeps the last frame `seq` it
acted on and drops anything at or below it: an EventSource reconnects by itself (a stream
hiccup) and the daemon resumes after the `Last-Event-ID` it sends, but a replayed `barge_in`
must never silence the reply playing now. A `barge_in`, an `error` and a `turn_end` whose
latency says `interrupted` silence what is queued only when they are for the turn being played
(that turn's late frames are then dropped); `voice.stopped` always silences and also closes the
stream (the session is over; an open EventSource would reconnect every few seconds); a normal
`turn_end` lets the queue finish. The AudioContext is created and resumed synchronously at the
start of `startTurn` (`createVoiceOutput`), before its first await: in the Talk click itself,
and for the hotkey and the palette in the render their press causes (a global shortcut from
the shell carries no user activation in any case); the session's player then keeps it and a
later Talk only resumes it. What the human heard is measured here (`voice.md`, "Real-audio
run"): Send or the hotkey's release calls `player.turnEnded()` before anything is awaited, and
the next turn's first chunk posts `POST /voice/sessions/:id/heard { turn, heardFirstAudioMs }`
once: its scheduled start in context time mapped onto `performance.now()` (both read at
scheduling, when the buffer starts, so the buffering is included), plus `baseLatency` and `outputLatency` (consecutive stages), minus the release;
a turn played while the context is not `running` (its clock frozen) is not measured. A released turn that
ends without audio is not the reference for the next one. The page's clock is a seam too
(`realtime.now`). Nothing else plays these frames: the
desktop shell has no native audio path (`media.rs` only grants the microphone), so there is
no flag to defer to and the webview's player is the only one; without EventSource or Web
Audio (jsdom without the test seams) nothing plays and the text still shows. The seams are
`AppProvider`'s `realtime` (`useRealtime()`), the same as the speech player's. Closing the
panel (or unmounting the shell) stops the capture, silences and closes the player and posts
`…/stop`; a turn that is still
starting when the panel closes (status, session start, press, the microphone prompt) notices
it after every step and undoes what it began, so the microphone never stays on behind a
closed panel. The Android app's own Settings screen carries a "Global hotkey: unavailable"
row with the same reason (`hotkeyUnavailableReason`) and points to Chat. When voice is unavailable (the status's reason, a
503 from the start, a denied microphone, or a window that cannot capture audio) the panel
shows why and focuses the text input, which talks to the same agent over `/chat/stream`.
The chord's release is ignored. `shell/hotkey.ts` holds the chord grammar (the shell's, case
for case: both run `test/hotkey-chords.json`), `formatChord` (Ctrl on Windows and Linux, Win
on Windows) and the `HotkeyBridge`: live (`invoke` + `listen` from `@tauri-apps/api`) only
inside the Tauri shell on a desktop platform, otherwise an unavailable bridge with the reason.
Tests provide a bridge through `HotkeyContext` and a microphone through
`VoiceCaptureContext`. Settings → Global hotkey (`shell/HotkeySettings.tsx`) shows the chord,
whether the OS holds it ("active" / "not registered" with the shell's error), validates a new
one client-side (reason under the field, "Will register …" preview, Save disabled while
invalid), sends the canonical chord with `hotkey_set`, offers Reset to default and follows
`forerunner://hotkey-changed`; in a browser, the approvals page or the Android app it reads
"unavailable" and why. The chord is a per-install shell preference, not a daemon setting, so
it does not run through the command registry.

### Fake daemon

`test/fake-daemon.ts` exports `createFakeDaemon(options)` (a Hono app over `test/fixtures.ts`
with mutable state: the agents (`POST /agents/:id/rename` as the daemon answers it, U-025: 404
unknown, 403 `forbidden` for another human's agent before the body is read, 409 `conflict`
with cause `validation` for a non-principal, a name `RenameAgentBody` refuses or one of the
human's other agents' names in any case, the same name unchanged, `agent.changed` emitted),
projects, tasks, sessions, events, requests, messages, kill flag, pending
chat confirmation, extensions, the daemon version, model watch reports, reviews, lessons,
consolidation proposals, the change log, pending commands, the queue, data assets, milestones
(`POST /milestones/:id` mirrors the daemon: the version check and a required reason, 409
`conflict` otherwise, the human as author), sources and their candidates (the `/sources`
routes: a scan of a fresh source finds two candidates named after the locator, one an
existing install, a scan of the fixture source changes nothing, accepting a proposal adds a
project card and emits `project.changed`, a token value instead of a reference is refused
with the daemon's message), the human's devices (`/devices`: `DEVICES` with this install
marked; `POST /devices/pairing` answers the `PAIRING` fixture with `expiresAt` ten minutes
after its `now` option, the wall clock by default, and counts pairings; `pairingAvailable:
false` makes it a daemon without a state service, 503 `unavailable`; `pairing` replaces
fixture fields such as the service URL; revoke marks the row, 400 for the current device, 404
unknown, and answers `via: "store"` with `revokeServiceError` set); the setup assistant's
routes (ADR 0092: `GET /setup` answers a set-up install unless `setup` overrides it, so the app
opens where a test mounts it; a pasted value is valid unless it contains "bad", a GitHub token
in the Claude step and an Anthropic credential in the GitHub step are 400s, finish answers
`restarting` when a key was stored); decisions, the peer feed
and docs are served read-only;
`GET /performance` serves the `PERFORMANCE` fixture in the runtime's `PerformanceView` shape
with the query's window and project, 400 for a bad `days` and 404 for an unknown project, as
the daemon answers; with a project, the slider position Settings left in
`state.speedQuality` shifts each mode with `offsetApplied` one step, held at its `maxEffort`,
and sets `effortOffset`; an effort `model.settings.set` left in `state.modelSettings` with
source `agent` for planning, text chat, `coder` or `researcher` is the base it shifts, with
`effortSource: "agent"`) and
`startFakeDaemon({ port })` (`@hono/node-server` on 127.0.0.1). Its `/health` answer is the
`HEALTH` fixture with the extension counts derived from the extension state (3 enabled, 1
pending with the fixtures). It requires the bearer token on every route (and accepts `?token=`
on the two SSE routes), answers CORS, records every POST/PUT/DELETE at `GET /__test/calls`,
resets at `POST /__test/reset`, can push an event with `POST /__test/emit`, can hide routes
(`missingRoutes` option or `POST /__test/missing`: a path and its children answer a typed 404
"no route"; the real daemon registers no `notFound` handler and answers Hono's plain-text 404,
which `isRouteMissing` reads the same way) and can fail exact routes with a status and body
(`failing` option or `POST /__test/fail`). `POST /sessions` starts a scripted run (six events
including a warning and an escalation, `eventDelayMs` apart, then `completed`) and answers
the real daemon's `202 StartSessionView`, parsed with its schema (`startOutcome: "queued"` or
`"deferred"` answers no session, U-003); `POST /projects/:id/data/import` answers the
runtime's `ImportResultView`, parsed with it (U-006);
`/chat/stream` streams word tokens and scripts a read-back confirmation when the text contains
"start a session", answered by "yes"/"no". The extension routes file a `capability_grant`
request in the inbox for pending installs (answering it approves or denies), widen permissions
into `pending_approval`, and emit `extension.changed`; `POST /updates/apply` emits
`restart.requested` and bumps the version `/health` reports, or, like the daemon (U-070), answers
400 `not_supported` (`reason: "installer_artifact"`) when the `updateArtifact` option names an
installer; the command routes mirror the
daemon (one card and one change log row per request, low risk acts, medium needs a yes or a
tap, high needs `{ answer: "device" }` naming the one device row the fake has, the fixture's
`ME.desktopDeviceId` (any other id is refused `approval_required` "unknown device; pair it
first" with the card kept, as the real executor does; no id, or the literal `desktop`, means
the row `/me` names, as the daemon's route does, and when `/me` names none, 409 `conflict`
with the daemon's message), `confirm: "tap"` runs a medium change at once, the `SOURCE_OF` mapping
`text → chat`, `voice → voice`, `phone → chat`, `ui → ui`, undo rows; the `me` option
overrides the `/me` answer, e.g. `desktopDeviceId: null` or a row the fake does not have). Run
directly (`pnpm exec tsx test/fake-daemon.ts`) it reads `FAKE_DAEMON_PORT`, `FAKE_DAEMON_TOKEN`
and `FAKE_DAEMON_EVENT_DELAY_MS`.

The fake's Opus fast mode (spec D.20): `state.fastMode` maps a project id to its flag, with
`null` for a flag never set; it is empty by default, so the fixtures' row counts stay. It adds
one `project.fast_mode` row per listed project to `/settings`: the value is off unless `true`,
and the description is the runtime's `fastModeDescription()`. `settings.set` with `fast_mode`
answers with the daemon's card and flips the flag on apply:
- what: "Opus fast mode for <project>";
- the old value, "unset" for `null`, as the daemon's card says;
- the new value with `fastModeEffect(value)`;
- the sentence.

The fake's `/voice` routes answer with the fixture's providers: `GET /voice/status` is
`state.voiceStatus` (the `VOICE_STATUS` answer the O.4 Extensions tests mutate) with
`sessions` counted live from the sessions below, and the `voice: { available: false, reason }`
option makes the status say why and the start answer 503. A press, audio chunks and a release make one turn
whose transcript is `state.nextVoiceLine` (else "what is next") and whose reply is the chat
reply for it; like the daemon's loop, audio counts for the turn only between the press and the
release (`lastTurn.audioChunks`); sessions and their chunk counts are in `state.voiceSessions`.

### What the Tauri shells inject

Before the bundle runs, a shell may set `window.__FORERUNNER__ = { daemonUrl, daemonToken,
installId, platform, shellVersion }` (type `ShellInjection` in `api/config.ts`). The desktop
shell reads `daemon.json` from the runtime directory (ADR 0011) and injects the URL and token
through an origin-guarded initialization script (see "Desktop shell" below); `installId`
namespaces the two persisted conveniences (it is not a device the daemon knows: a high-risk
confirmation names the daemon's own desktop row from `/me`); `platform` and `shellVersion`
show in Settings. The Android shell
does not reach the daemon directly (spec R): it injects `stateUrl` and mounts `src/mobile`.
The desktop CSP (`apps/desktop/src-tauri/tauri.conf.json`) already allows
`http://127.0.0.1:*`.

Besides the injected global, the desktop shell talks to the UI through Tauri IPC for the
global hotkey only (ADR 0064): the commands `hotkey_status` and `hotkey_set { chord }` (granted
to the main window by `capabilities/hotkey.json`; both answer `{ chord, defaultChord,
registered, error }`, `hotkey_set` rejects with the shell's message when the grammar or the OS
refuses the chord) and two events emitted to the main window: `forerunner://hotkey`
`{ chord, state: "pressed" }` after the window was shown and focused, and
`forerunner://hotkey-changed` with the status after a change or a failed registration. The
Android shell has no such commands; the UI's bridge is unavailable there. The desktop shell
also answers the main window's permission requests (`media.rs`): the microphone is allowed for
the shell's own pages only, so the conversation panel's `getUserMedia({ audio })` works
without a webview prompt (WebKitGTK would otherwise deny it).

## How to change it

- **Add a page**: create `src/pages/XPage.tsx`, add a `<Route>` in `src/routes.tsx`, a nav entry
  in `shell/Shell.tsx` (`NAV`) if it belongs in the header, a palette command in
  `shell/commands.ts` and, if it gets a shortcut, an entry in `shell/shortcuts.ts` (`SHORTCUTS`)
  and a case in the Shell's key handler. Load data with `useAsync` and the client; render
  `<Loading what=…>` while waiting, `<ErrorBanner>` on failure and `<RouteMissing route=…>`
  when `routeMissing` is set. Add a unit test in `test/` (render with `renderApp(route)` from
  `test/helpers.tsx`) and, for a user flow, a spec in `e2e/`.
- **Add a route to the client**: the contract changes first (`api-types.ts`, ADR); then add the
  method to `DaemonClient` in `api/client.ts` using `routePath` and the schema, the fixture in
  `test/fixtures.ts`, the handler in `test/fake-daemon.ts`, a round-trip assertion plus a
  malformed-body rejection in `test/client.test.ts`, and the call in
  `test/real-daemon.test.ts` (the read sweep, or a flow of its own). A route the daemon does
  not serve yet goes into `PROPOSED_ROUTES` with its schema in `contracts.ts` and
  `proposedPath`; when the daemon gains it, `test/contracts.test.ts` fails until the proposal
  is removed and the page uses the daemon's shape. A screen never ships on a proposal alone:
  in 1.0.2 the Next session panel, the Docs tab and the Data tab's import did, and failed in
  the app while their fake-daemon tests passed (U-004 to U-006).
- **Mirror a runtime schema** the browser cannot import: copy it into `contracts.ts`, add the
  fixture to the two-sided parse in `test/contracts.test.ts`.
- **A new command from a screen**: build the body for `executeCommands`, show the result with
  `CommandResult` and confirm through `confirmCommand`; never bypass the card.
- **A new setting the UI can change**: extend `commandForSetting` in `SettingsPage.tsx` (and
  `SETTING_KEYS` when `SETTING_SPECS` in `@forerunner/commands` gains a key) and the fake's
  `SETTING_RISK`. The monthly jobs' `calibration` and `handover` keys (ADR 0060) are in
  `SETTING_KEYS` and the fake's risks (medium); their values are objects, edited as JSON.
  A setting with a few named positions can reuse `inputType: "slider"` with its own
  `positions` and `display`, as the speed-versus-quality slider does. A new
  D.4 field: `MODEL_SETTING_COLUMNS` and the option or number rules in
  `ModelSettingsSection.tsx`, the fake's `model.settings.set` key map and `MODEL_SETTINGS`.
- **Links that look like buttons**: use `buttonClassName(variant)` from `components/ui.tsx` on
  the `<Link>`; never put a `<Button>` inside a link (invalid HTML, double tab stop).
- **Change money display**: `lib/money.ts` and its test; keep USD out of any visible string.
- **Change the dark-mode binding**: `styles.css` (`@custom-variant dark`) and `store/theme.ts`.
- **Task transition buttons**: `lib/task-transitions.ts` mirrors `packages/state/src/workflow.ts`
  and `AGENT_ONLY_STATUSES` in `packages/state/src/repos/task.ts`; `test/tasks.test.tsx` fails
  when they drift.
- **Lint for this app** runs under `apps/ui/biome.json` (extends the root, enables
  `css.parser.tailwindDirectives`); keep every other rule from the root.

## Tests

```
cd apps/ui && pnpm typecheck      # tsc over src, test, e2e and the configs
cd apps/ui && pnpm test           # Vitest + Testing Library, jsdom, fake daemon in-process
cd apps/ui && pnpm test:ui        # Playwright, headless Chromium, fake daemon + Vite on free ports
```

`setup-assistant` covers the setup assistant (ADR 0092): a fresh install opens it instead of
Home, a set-up install and a daemon without `/setup` stay where the app opened, Settings links
to it; the walk through name and time zone, a rejected and an accepted API key checked on paste
(the field emptied, the key nowhere on the page), the GitHub link and a token in the wrong step,
finish and the return to Home; "Set up later" closes it without a credential.

`settings-voice` covers the Voice card against the fake daemon's scripted install job (the
current profile and devices, sizes and trade-offs, the confirmation before any POST, the
streamed progress and the new devices, a stream that drops mid-job resumed from the last event
(`voiceInstallDropOnce`, `state.voiceInstallStreamsAfter`), Cancel on a held job
(`voiceInstallHold`), a failed stream's error shown then cleared (`voiceInstallStreamFailsOnce`),
`reattachDelay`, the GPU fallback warning, a 409
while a voice session is open, `installProgress`; the providers in force with their reasons,
the link to Extensions and the re-read on `extension.changed`, U-023).

Settings, undo and the change log (U-056 to U-061): `active-project` (the header's switcher
and the palette post `project.switch` with `source: "ui"` and the daemon records it; the header
starts on `/me`'s project; switch by chat to Beacon, then Atlas's Chat tab: the body carries
`projectTab: true`, the task lands in Atlas, the header stays Beacon; opening a project page
switches nothing), `default-autonomy` (Settings → default autonomy 3, then New project: no
level sent, the project starts at 3), `undo-confirm` (Changes: the undo of a lowered monthly
cap shows the device card, this PC confirms with its own row, the cap is back; No changes
nothing), `undo-changes` (a Tasks-tab cancel is in the change log with its reason and its Undo
reopens the task; Changes shows "Cannot be undone now" with no button; a refused undo reads
"Not undone"; an undo from Changes is logged `ui`), `settings-all` (every row with a plain
label and a value in words; quiet hours, the model watch, the per-session cap and the highest
model through their controls with the bodies sent; the language without a control; the
desktop allowlist under the heading the approval card names, added and removed), and
`settings-models`' U-059 cases (no speed choice for chat and planning; the highest model per
row; chat offers nothing above opus; fable labelled for a specialist; the Highest model row
exists). `real-daemon` adds the same journeys against the real daemon (`/me.activeProjectId`
and `projectTab`, the default autonomy, the pending undo confirmed on this PC and logged `ui`,
the task move's `change` and its reopen, `undoBlockedReason`, the settings labels and quiet
hours, the model rows, the desktop allowlist).

Unit tests (`test/*.test.ts[x]`): `real-daemon` (U-008: the whole runtime composed as
`fr daemon` composes it, with the scripted provider, and the UI's own `createClient` over
`app.request`; 43 read calls of the screens parsed with the UI's schemas, a route missing or
an answer of another shape failing the test; the flows of U-003 to U-006: a start answered
with the session it began, the queue added, listed and dismissed, the docs listed and one
read, a folder imported; U-025: Settings' `renameAgent` renames the principal, trimmed, and
`/agents` and the runtime's own record follow, and a taken name is the daemon's 409 in its
words; the live view's Stop answered with the session it shows while Stop all stays in force
until Resume (U-032); Approve and Deny in the Extensions panel leaving no card for the
extension in the Inbox (U-030), which the fake mirrors: a panel decision or a removal
withdraws the extension's open card, one answered in the Inbox stays answered; the fake's
model watch answer likewise withdraws the report's open card, as the daemon does since U-035;
U-026: Add on a built-in entry with `confirmIn: "panel"` waits with no Inbox card, a plain yes
and an unpaired device are refused 403, this PC's `desktopDeviceId` grants it, and Cancel leaves
nothing, which the fake mirrors: every catalog add waits, only an `inbox` row gets a card, and
the approve route takes this PC's device only; U-078: Settings' Claude order, `billingOrder`
listing the person's credential rows with `name`, `via` and why one cannot be used,
`setBillingOrder` storing what Move up posts, the order read back and the change sentence in
Changes in words, an order naming a kind twice refused 400, which the fake mirrors:
`options.billingOrder` seeds its rows and a chosen order, its POST validates the same way and
writes the same change log sentence),
model watch answer likewise withdraws the report's open card, as the daemon does since U-035; a task only the person can do whose questions are in the Inbox, answered with what the form sends, closes (U-022: the fake's answer route mirrors `syncPersonQuestions`, done or back to ready, Cancel the task cancels); every card naming its task beside its project (U-073); a failed plan from the brief read with its error and retried, `drafting` then `failed` again on the scripted model (U-046: the fake serves `GET /projects/:id/intake` from `state.intake`, `drafting` after a creation with `intake: true` or a Retry of a failed one)),
`client` (config resolution, route paths, token header,
contract validation rejects malformed bodies, `/health` with its sandbox and extensions
sections, decisions and peers, phase-1 mutations, a missing route vs a typed not_found incl.
the real daemon's plain-text and empty-body 404 (on `docs`, which the fake is told to lack),
round trips for reviews / memory / commands /
the change log, the proposed routes, `performance` with its window and the daemon's 400 for a
`days` that is not decimal digits, extensions / updates / model watch), `contracts`
(two-sided parse of the extension, updates and estimate fixtures with key-set comparison,
proposed routes vs `DAEMON_ROUTES`, `parseChangeCard`), `money`, `sse` (parser, every event
name incl. `extension.changed`, `restart.requested` and `speak.started` (an unknown `player`
dropped), EventSource path, polling fallback, chat stream), `speech` (`playSpeech` with a fake
EventSource and a fake `AudioOutput`: the PCM decoded per channel, buffers scheduled back to
back, the sentence followed, `speak.done` / `error` / a cancelled record ending it, the tail
after `speak.done` played before the output closes and `stop()` during it closing at once; the speech
player playing `player: "any"` utterances one at a time and leaving `requester` ones alone;
`AppProvider` opening `/events?speech=play` and playing an announced alert's frames), `store`
(persistence, restart, extensions version), `app`, `home`, `project` (summary, Read aloud
through the daemon with Stop cancelling it, leaving the page cancelling it, the 503 notice,
derived milestones fallback, costs, every tab filled), `project-tabs` (graph layout
incl. a cut cycle, timeline positions, timeline and graph render, the milestone edit dialog:
the reason of the last change on the row, no Edit on a derived row, Save disabled without a
reason, the posted body with the version, the reason and every field, the row and the timeline
updated, and a stale version keeping the dialog open with the daemon's refusal (B.5), the
timeline and derived milestones when the route is missing, today's tick from an injected `now`, docs with drift
and a reader, data register / remove / import, queue add / dismiss, peers, decisions, solo
project and missing queue route, cost per accepted), `small-project` (B.6: the flat Plan tab
list with the one milestone from the route or, without it, the card, milestones from before
the mode named, the one milestone's Edit dialog posting the row's version and the reason and
the reason then shown under it (B.5), a small project without a milestone yet, the grouped tab
unchanged with the flag off; the dialog's "project default (tier N)" option from the card, no
`riskTier` in the
posted body unless picked and the picked one sent, a card without the field naming no number),
`fast-mode` (D.20: the Settings card with the effect and the surcharge both ways and each
project's state, no card without the rows, Turn on through the change card with the on effect,
a yes and the sentence, Turn off with the off effect, a never-set flag reading off with
"unset" as the card's old value and in the sentence, the row mapped to `settings.set` with a
boolean),
`reviews` (tones, trend, newest first,
findings, verdict filter, missing route), `tasks`, `session`, `inbox` (sorting, options,
free text, a typed answer that is none of a card's options shown under the card with the
options while the card stays (U-034: `fake-daemon.ts` refuses it with the runtime's own
`acceptsAnswer`, as the daemon does; `real-daemon.test.ts` checks the real 400), reload on a
streamed count, mark read, mark all read (U-020: one `POST
/messages/:id/read` per unread message, read ones untouched, the button gone after); an intake proposal rendered as the plan card
with phases, tasks with tier / priority / specialist / dependencies, docs and their target, the
first session with estimates and the call's cost, the ordinary options kept, and `intakeCardOf`
reading only intake cards that carry a proposal; spec A.2, ADR 0055; questions only the person can answer, U-022: one field per question, Send answers posting the typed answers only, Cancel the task posting the option the card shows), `unlock-card` (spec
S.12, ADR 0068: the cloud runner unlock card with the runner, project, filing time and the
challenge's age; Unlock once sends the key wrapped by the fake daemon's keyring and the test
unwraps it as the runner does; the key in neither the DOM nor any recorded call; a window set
with the answer and remembered, then the next challenge answered automatically with a notice;
the auto-answer from the home page too, including a challenge filed while the app sits there;
clear sends null and drops the record; deny never asks the keyring; no auto-answer after the
window; read-only without the key and for an expired challenge; over the bridge contract a key
holder's every handed-out copy is zeroed and a shell without a keyring is read-only), `chat`, `memory` (view
order, pinned first, search, critic and shared views, a peer's agent not readable, edit / pin
/ delete, consolidation, the offers and pending proposals with accept and dismiss posted and
the outcome shown, Share on a lesson row posting the proposal and joining the pending list
with no Share on a global shared lesson, missing memory routes with all three notices, missing
offers route alone, missing consolidation route alone), `extensions` (permission summary, every kind with status and
review, toggle and remove, Add on a catalog entry opening the confirmation with the change card
and no Inbox card, Confirm sending this PC's device answer, Cancel adding nothing, a refused
confirmation shown in the dialog, Approve on a row from a URL opening the same dialog (U-026),
add from a URL then deny, reload on `extension.changed`; the pointer to Settings → Voice in place of a providers card and the
model providers group's note (U-023), the cloud voice rows' badges, re-read after a toggle (the
row then switched off with the daemon's reason) and on `extension.changed`; `voiceBadges` in
force, fallen back, skipped, switched off, other rows, in force through any of the row's
providers),
`updates` (states, the Updates menu entry, nothing checked on open and the
check only on the button, available release with changelog, apply with the
restart banner, rollback, model watch adopt and run, a report with withheld evals answered
`evaluate`, feed failure kept local), `performance`
(formatting, the fixture parsed with the runtime schema, the p90 against each target, the
effort in force, every mode with the bar and the last measurement, the window select sent as
`?days=`, the project's slider shifting every mode it reaches held at the registry cap (the
title names the cap), a daemon failure as an error with no "route not available" state, estimates),
`audit-export` (the client's filename parsing and row counting, the fetch with the token and
the filters in both formats against the fake daemon, 401 without a token; the button downloads
the daemon's file in the chosen format and reports the count, says so when the browser cannot
save and names the missing route), `download` (`saveTextFile`: the Blob's type and size, the
anchor's `download` name clicked once and removed, the URL revoked later, false without object
URLs),
`changes` (rows with words / commands / before / after, undo and the undo row, filters,
missing route), `settings` (scope on every row, the paired-device line, command mapping,
autonomy by one step: card → yes → sentence → undo → the change log row, high risk needs this
device: the `/me` row's id is posted and performs, an id the fake does not know is shown as
the daemon's refusal with the card kept, no id while `/me` failed and the change performs,
`/me` naming no row: the status line says this PC cannot confirm and the daemon's 409 is shown
with nothing changed, cancel and refusal; `client`: the literal `desktop` is this PC; the
Devices section in the whole app: pairing shows the QR and code, revoke removes the phone),
`settings-agent-name` (U-025: the field shows the principal's name, Save stays disabled for
the same or a blank name, a save posts the name as typed, says so and the field and the store
show the trimmed name read again from `/agents`; a taken name shows the daemon's refusal and
nothing changes; a rename from another window arrives as `agent.changed` and the field follows),
`settings-devices` (spec R.2: code grouping, countdown floor, the QR path drawing exactly the
encoded modules; Pair a phone → the QR equal to `uqr`'s encoding of the link, the link parsed
by the phone's `parsePairingPayload`, the code, service and `in 10:00`, the countdown at
`0:30` and expired on a stepped clock shared with the fake, a new pairing from the expired
state; the list with kind, platform, last seen, this device marked without Revoke, the
revoked one apart; revoke cancelled sends nothing, confirmed posts the route and the phone
leaves the list with the note; a failed revoke keeps it with the error; route-missing for the
list and for the pairing route alone; no state service: pairing off with what to set, a 503
banner with Retry; the phone completing the pairing closes the panel and lists it with no
click; the loopback warning and `isLoopbackUrl`; the store-fallback note of a revocation),
`settings-slider` (spec D.16: the speed-versus-quality row mapped to a three-stop slider
behind `settings.set`, out-of-range and fractional values refused, the row read by position,
a move by the range input up to quality and by the stop name down to speed, the posted body
with `source: "ui"` and the position in the words used, the effect sentence both ways in the
result and the fake's change log, undo back to the previous position; the fake refusing -2,
+2, 0.5 and "1" in the daemon's words with nothing written),
`settings-billing-order` (U-078: the rows with how each is used, why one cannot be used now
(resting until a time, the allowance, the monthly cap, no key) and this month's spend; Move up
reorders the rows, posts `{ order: ["api_key", "subscription"] }`, says it is saved and in
Changes and drops the defaults note; Move down puts it back; the ends disabled; the
route-missing state),
`settings-models` (8, spec D.4: model, effort, max tokens, speed mode and timeout per agent
mode and specialist with the table or registry-file source and the `set` badge naming the
default it replaced, the critic read-only with its note; no temperature column or cell for a
provider that takes none and the line saying so, the column and the value for one that does
(`createHarness({ acceptsTemperature })`); a specialist's max tokens changed through the dialog
posting `model.settings.set` with source `ui`, the sentence, the row then marked `set` with
8000; speed mode from a select with the default entry, fast answered with a medium card and a
yes; a specialist's effort list stopping at its `max_effort` (`optionsFor`; the fake refuses
more like the daemon); the parameter mapping and range refusals, the row and column lists; the
route-missing state with the rest of Settings intact),
`sources` (spec A.4: counts and kind labels; the fixture source with its reference and counts,
its candidates with statuses, the install mark and the duplicate's project link, Create
project on a proposal posting to the accept route with the project landing in the store and
the counts updated; a folder source connected (the posted body), scanned to two proposals,
removed after the confirmation; a pasted token refused by the daemon and shown; the missing
route), `contracts` also parses the source fixtures with the daemon's schemas and checks the
route table,
`email-settings` (the audit row formatting; reached from Settings, the human's agents with the
picker, the five meanings and the full-discretion sentence before any change; a switch to full
discretion as `email.mode.set` through `/commands/execute` (the body with the agent and
`source: ui`), the dialog repeating the sentence beside the `needs_device` card, No cancelling
the card with nothing changed, the device answer naming this PC's row with the sentence, the
change log row (`ui`, before and after) and the badge, Undo through `/changes/:id/undo` putting
the mode back, and no `PUT` carrying the mode; allowlist as the same card without the sentence,
then the allowlist editor appearing and saving with the caps through `PUT`; a daemon without a
desktop row refusing the device answer, shown in the dialog with the card left open; pause and
resume through the tray's routes with the state; the mailbox saved with
references and a value refused by the fake's 400 shown as such, the marker rotated; a mailbox
set up outside the page (IMAP without TLS in its own folder, SMTP over TLS on 465) saved from
the form with one reference changed and the `PUT` carrying `secure`, `folder` and
`draftsFolder` as stored; the
command audit newest first with when, from, interpretation, result, session link and the
ignored reason, the sent copies newest first, the empty states; the route-missing state per
card against a daemon without the routes), `client` (the capability routes' nested error body
read as a typed 403 with its own sentence),
`shell` (matcher, palette filter, g-sequences incl. `g c` / `g t` / `g u`, switcher, kill
switch, persistence), `hotkey` (O.1: every case of `hotkey-chords.json` accepted with the
shell's canonical form or refused for its reason, the platform labels, the bridge only inside
the desktop shell, the palette's Talk entry; Settings says unavailable in a browser, shows the
chord and its registration, refuses an invalid chord before sending, sends the canonical one,
resets, shows the shell's refusal and a failure arriving as an event; the Android app's
Settings screen says unavailable; a press opens the
conversation and starts a push-to-talk turn — session in `push_to_talk`, press, audio chunks
— a release does nothing, the next press sends and shows transcript and reply, a third reuses
the session; voice unavailable or no microphone focuses the text input and the text reaches
the agent; closing or unmounting stops the capture and the session; closing while the
microphone or the session is still starting turns the microphone off and ends the session;
the release waits for every chunk, posted in order, and the turn counts them all; the PCM
encoding),
`desktop-indicator` (spec S.32, ADR 0067; an EventSource stand-in wired
to the fake daemon's listeners, `setDesktopControl` emitting the frame as `BusIndicator`
does: no banner while off; an `on` frame showing the banner above the header, high contrast,
naming the agent, the app and the session with its link, `off` hiding it without a "stopped"
line; an app becoming known updating it and "the desktop" without one; the banner on every
page through navigation; a missed `on` and a missed `off` corrected by the re-read when the
stream reopens; a re-read answered before a newer `on` frame and landing after it dropped
(the banner stays); the banner at start-up from the bootstrap read; "Stop desktop control"
posting `/desktop/revoke` with its reason and not `/kill`, the banner gone and resume posting
`/desktop/resume`; a stop from the tray offering resume at once and a revoke by the
Extensions panel showing no stopped line; a failed stop keeping the banner; polling reading
the indicator from the status view). `store` also orders desktop frames and reads (a read
started before a frame or a later read is dropped) and maps a panel revoke to `revoked:
false`. `sse` also parses `desktop.indicator` (on with names, off, a malformed one
dropped).

Playwright (`e2e/*.spec.ts`, one worker, 6-minute global budget): home shows two projects and
connects; kill switch; nav collapse under 768 px; project tabs, task transition, plan timeline
and graph, costs, reviews; Start session dialog and the live view over real SSE; Stop; inbox
answer flow; chat confirmation and make-this-a-task; palette and shortcuts; extensions add → confirm
in the panel (the change card, the device answer) → toggle, Cancel adding nothing, and deny; updates apply with the restart banner arriving over SSE and the
new version after reload, model watch adopt; reviews list and filter; memory edit → pin →
delete and the not-readable peer view; summary queue / peers / decisions, data register and
import, docs reader; performance targets; a settings change → card → yes → change log → undo.
`playwright.config.ts` picks free ports and random tokens once and pins them in
`FORERUNNER_UI_FAKE_PORT`, `FORERUNNER_UI_PORT`, `FORERUNNER_UI_FAKE_TOKEN` (and the fake
state service's for the phone specs) so worker processes agree; the CI desktop workflow runs
`pnpm --filter @forerunner/ui test:ui` after `playwright install chromium`.

## Known issues

- The fast-mode card names projects from the store's project cards; a project the daemon
  lists in `/settings` but not in `/projects` (archived) shows its id.
- Settings → Devices pairs phones only: the daemon's `POST /devices/pairing` accepts
  `kind: "web"`, but the approvals web reads its code from `<page url>#code=`, and no page URL
  is configured anywhere (the service does not serve `apps/approvals-web/dist`), so there is
  no "Send web link" button yet. The new phone is noticed by polling `GET /devices` while a
  code is live (the daemon's `/events` carries no `device.changed` frame); outside a pairing
  the list changes on Refresh. The countdown compares the service's `expiresAt` with this
  PC's clock, so a skew between the two shifts it.
- The UI has so far only been run against the fake daemon. The first run against the real
  one should confirm the shapes end to end and goes into `docs/status/gates.md`.
- The real daemon registers no `notFound` handler (`packages/runtime/src/daemon/server.ts`),
  so a route it lacks answers Hono's plain-text 404 while the fake answers a typed
  `not_found` "no route" body. `isRouteMissing` accepts both (untyped 404/405/501, or a typed
  one saying "no route"), so the pages degrade the same way against either; an `app.notFound`
  in `server.ts` matching the fake would make the two identical and belongs to the daemon.
- No route is proposed at present. The queue, docs and import routes that were (and showed
  "route not available" in 1.0.2) are served since U-004 to U-006, and the state now reads
  "Not available in this version" without sending the human to Updates (U-007). `GET /projects/:id/milestones` is served since B.5 landed; the Plan tab
  still derives the timeline and the milestones from the tasks and the card against an older
  daemon without it, and offers no Edit on those derived rows. The data asset routes
  (`GET/POST /projects/:id/data`, `DELETE /data/:id`) and `GET /performance`
  (`views.ts#performanceView`, runtime.md) are served by the daemon now and left the proposed
  list; the page reads the runtime's `PerformanceView`.
- The settings screen's changes are logged with source `ui` (`POST /commands/execute` with
  `source: "ui"`), but the Changes screen's undo (`POST /changes/:id/undo`, no body) is still
  logged as `chat` by the daemon; a `source` on that route and on `undoChange` would close it.
- The daemon's `GET /memory/scopes` lists the human's own principals only; the peers' agents
  come from `GET /agents` and show the daemon's answer (403 or an empty list).
- Permissions are shown, approved and denied; narrowing or widening them from the panel
  (`PUT /extensions/:id/permissions`) has a client method but no control yet.
- Connector updates are listed; applying one is remove-and-add in the Extensions panel.
- The Inbox reloads on a changed blocking count only; a non-blocking request answered
  elsewhere shows up on Refresh or with the next blocking change.
- `Read aloud` (`components/ReadAloud.tsx`, on the project summary and the live session view)
  asks the daemon to read the summary through its voice provider and plays the utterance's
  `audio` frames in the webview with Web Audio (`lib/speech.ts`: EventSource on
  `GET /speak/:id/events`, buffers scheduled back to back; polling of `GET /speak/:id` where
  the browser has no EventSource or no AudioContext, so the screen still follows it). The
  browser's Web Speech API is used only when the daemon answers 503 (no voice provider); where
  that is missing too (WebKitGTK without voices) the notice says so. Leaving the page while it
  reads cancels the daemon's utterance too. The desktop sidecar does not play the frames, so a
  spoken alert or a `summary.speak` by chat is heard only while the app window is open (the
  speech player above); with it closed the daemon skips the voice (`notifications.md`) and
  the command answers with the text. A browser tab that blocks audio until clicked stays
  silent until then; with the desktop app and a browser tab both open, both play.
- The panel's reply player has been exercised in jsdom with a fake EventSource and a fake
  AudioContext (`test/voice-playback.test.tsx`), not yet in a real window with a real TTS.
  The heard figure maps context time to the page's clock by reading `currentTime` and
  `performance.now()` together; `currentTime` advances per render quantum (about 3 ms at
  48 kHz), so the figure is that coarse. `getOutputTimestamp()` would be finer but already
  includes the device latency the figure adds, so it is not mixed in. Where a browser reports
  no `outputLatency` (or 0; not checked in WebView2 or WebKitGTK yet) only `baseLatency` is
  counted and the device's own buffer is not, so the figure is low by that much there.
  A stream that stalls longer than the queued audio still leaves a pause (the jitter buffer
  turns many short gaps into one, and grows, but cannot invent audio); the buffer's numbers
  (200 ms start, doubling to 1 s, 250 ms pause rule) are chosen from one run's report, not
  tuned on real hardware yet, and a target that grew stays for the session.
- The text of a voice reply streams in the panel since 2026-10-26 (it used to appear only
  with the polled record, after the reply had been spoken); exercised in jsdom with the fake
  EventSource (`test/voice-playback.test.tsx`, "the reply's text as it comes", "reply in
  text"), not yet in a real window. The "not spoken" split is the daemon's (sentences whose
  playback started at its sink, `voice.md` "Known issues"), so it can count as spoken a
  sentence the window had not played yet; the `data-speaking` mark follows the window's own
  schedule. A barge-in reaches a reply the daemon still runs; a reply only the window still
  plays (its buffer) is silenced by the press as before.
- The microphone capture (`browserMicCapture`) uses ScriptProcessorNode, deprecated but
  present in WebView2 and WebKitGTK; it has been exercised in jsdom with a fake capture only,
  not yet in a real desktop window with a real voice provider (no provider key here).
- **Export audit log** saves through an anchor `download` on an object URL, which the dev
  server and WebView2 (Windows) honour; the Linux desktop shell (WebKitGTK) registers no
  download handler yet (`apps/desktop/src-tauri`), so the click may do nothing there. The page
  cannot tell, and `fr audit export` writes the same file from the command line meanwhile.
- The project page tab bar scrolls horizontally on narrow screens; the phone layout is
  `src/mobile`.
- Desktop notifications and the tray menu (K.8) live in the desktop shell (next section); the
  UI itself raises no OS notification.
- The nested `apps/ui/biome.json` exists only because the root config disables Biome's Tailwind
  CSS syntax; if the root enables `css.parser.tailwindDirectives`, delete the nested file.

## Desktop shell (`apps/desktop`)

### Purpose

The Tauri 2 shell for Windows and Linux that attaches the shared UI to the local daemon
(ADR 0026, ADR 0031): it resolves the app directories exactly as `appDirs()` does, reads
`<runtime>/daemon.json`, checks `/health`, starts `fr daemon` when nothing healthy is there,
injects the daemon address and token into the webview before the UI loads, keeps a tray with
the kill switch, "pause email", the desktop-control state with "Stop desktop control",
"Updates…" (opens the Updates screen; it never checks or installs by itself, ADR 0015
amendment of 2026-10-25) and Quit (which stops the daemon, ADR 0094), shows OS notifications for the daemon's `notification` events,
applies the restart contract, remembers the window, handles `fr://` deep links and registers
the global hotkey that brings up the conversation (ADR 0064). No TypeScript:
`apps/desktop/package.json` only runs the Tauri CLI; the UI comes from `apps/ui/dist`.

Requirements covered: K.8 (desktop notifications, tray menu; dark mode is the UI's), S.8 (kill
switch from the tray), S.28 (one-click "pause email" in the tray), S.32 (the tray shows desktop
control while active, with the UI's banner in the window; ADR 0067), M.3 and M.4 ("Update and
restart" and the relaunch after the staged install's health check or rollback), O.1 (the
global hotkey: the shell's half; the conversation panel is the UI's). The Android
client (R) is `apps/mobile`, not this shell.

### How it works

```
apps/desktop/src-tauri/
  Cargo.toml, build.rs (app manifest: hotkey_status, hotkey_set; an empty runtime/ for
  development builds), tauri.conf.json (no static window; deep-link scheme "fr"; resources
  runtime/ -> runtime/, built by beforeBuildCommand), capabilities/default.json, capabilities/hotkey.json,
  permissions/autogenerated/ (generated by tauri-build for the two commands; committed)
  runtime/            the bundled runtime (ADR 0092; scripts/build-runtime-payload.mjs; gitignored)
  src/
    lib.rs            run(): directories, log plugin, plugins (single-instance, notification, dialog,
                      deep-link, opener), the frshell:// splash protocol, setup (install id, tray,
                      deep links, bootstrap), close-to-tray, "never exit while only the tray is left"
    main.rs           calls run(); windows_subsystem = "windows" in release
    env.rs            Env trait (ProcessEnv; MapEnv fixture in tests)
    dirs.rs           app_dirs(): mirror of packages/platform/src/paths.ts appDirs()
    secret.rs         Secret (Debug/Display print "[redacted]"), redact()
    daemon.rs         daemon.json parsing, /health parsing, precheck/decide, DaemonClient (reqwest)
    install.rs        locate_fr(): staged version (unless older than the bundle), FORERUNNER_INSTALL_DIR,
                      the bundled runtime, install.json, PATH -> argv (+ env); bundled_runtime()
    version.rs        compare(): semver order for the staged-vs-bundled and outdated-daemon checks
    selftest.rs       `--self-test [--report <file>]`: a launch's start path without a window,
                      JSON report, exit 0/1 (ADR 0092 amendment)
    supervisor.rs     spawn_daemon() (argv, env, detached, log file), wait_for_daemon(), watch_exit(),
                      stop_process() (an outdated daemon only, ADR 0092)
    restart.rs        restart.json parsing, decide_after_exit() (the restart budget)
    inject.rs         initialization_script(): origin-guarded window.__FORERUNNER__
    sse.rs            SseParser (mirror of apps/ui/src/api/sse.ts), typed daemon events
    deeplink.rs       fr:// -> UI route, is_safe_route(), navigate_script(), navigation policy
    window_state.rs   <config>/window-state.json, placement() against the monitors
    state.rs          ShellState (shared), tray_view(): what the tray shows, derived from facts
    actions.rs        bootstrap() attach-or-start, attached(), handle_daemon_exit(), kill switch,
                      resume, probe_email(), email toggle, probe_desktop(), desktop_stop(),
                      update_and_restart(),
                      watch_external_restart() for a daemon the shell did not start
    events.rs         the Rust /events subscription and the 10 s /health monitor
    tray.rs           tray icon, menu items, refresh() from tray_view, menu dispatch
    windows.rs        main window (build/rebuild with the injection), splash, deep-link navigation
    hotkey.rs         the chord grammar, HotkeyState (registration state machine), <config>/hotkey.json,
                      startup_chord(), the event and status payloads (pure, unit-tested)
    hotkey_shell.rs   tauri-plugin-global-shortcut with one handler, install() at start, the
                      hotkey_status / hotkey_set commands, the press handler
    media.rs          the main window's permission answers: the microphone for the app's own
                      pages only (the conversation panel), the camera denied (pure, unit-tested)
    test_http.rs      tests only: a std-only HTTP server on 127.0.0.1 (canned, delayed, hung
                      answers; stops listening after a route) for the client and Quit tests
```

**Directories.** `dirs::app_dirs(env, opts)` returns `config, data, cache, logs, worktrees,
runtime` with the rules of `appDirs()`: `FORERUNNER_HOME` (resolved like `path.resolve`)
overrides everything; Windows uses `APPDATA`/`LOCALAPPDATA` (defaults under the home
directory); Linux uses `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`,
`XDG_RUNTIME_DIR` with the XDG defaults; macOS is mirrored for parity. A set-but-empty variable
counts as set (Node's `??`), home is `HOME`, else `USERPROFILE`, else the OS home. The fixture
table in `dirs.rs` matches `packages/platform/test/paths.test.ts`; when `paths.ts` changes,
both tables change.

**Lifecycle (`actions::bootstrap`).** Read `daemon.json` (`url`, `token`, `pid`, `version`,
`startedAt`; the url must be loopback `http://`). A pid known to be dead (Linux `/proc`) is a
stale file; otherwise `GET /health` with a 1.5 s timeout. A time-out is not a refused
connection (U-065, `daemon::HealthError`): `Slow` (connected, no answer in time) means the
daemon runs, so the shell waits for it (`AttachDecision::Wait`, `settle_slow_daemon`: the splash
says "Waiting for the Forerunner background service to answer…", up to `SLOW_DAEMON_WAIT`,
60 s, probing through `supervisor::wait_for_answer`), attaches once it answers, starts a new one
only once it stops listening, and otherwise says it runs but does not answer, without starting
a second daemon on the same data; the health monitor only re-attaches. `Unreachable` (refused)
and `Bad` (a status or a body that is not a healthy `/health`) still lead to a start, and the
daemon's own lock refuses a second one on the same data folder (runtime.md). Healthy → attach,
unless the build
carries a runtime (`install::bundled_runtime`, `<resources>/runtime/runtime.json`) and the
daemon reports an older version or none (`daemon::outdated_reason`, ADR 0092): then the shell
shows "Updating the Forerunner background service…", ends that daemon
(`supervisor::stop_process`: `taskkill /PID <pid> /T /F` on Windows, `kill -TERM <pid>`
elsewhere, argv arrays) and waits up to 15 s for its `/health` to stop answering, then starts
the bundled one. A daemon that cannot be stopped gets a dialog and is attached to anyway; a
newer daemon (a staged update, a developer's checkout) is kept. Else, when starting
is allowed, show the splash window (served by the shell's own `frshell://` protocol, no
scripts), locate `fr` (`install::locate_fr`), spawn it with an argv array (`… daemon`),
detached (own process group on Unix, `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` on
Windows), stdout and stderr appended to `<logs>/daemon-shell.log` (rotated before a start once
it is above 5 MB, keeping `daemon-shell.log.1`; U-077), then poll every 250 ms for a
`daemon.json` that is fresh and answers `/health` (150 s budget, for the first `tsx` compile
of a fresh install; the child exiting first is a failure). Fresh (`daemon::is_fresh`) means a different `pid` or `startedAt` than the file on
disk before the spawn (else the last file attached to; any file when there was none). The pid
the shell spawned is accepted too but never required: `node …/tsx/dist/cli.mjs` runs the CLI
in a child node process and `fr.cmd` runs under `cmd.exe`, so the daemon records a grandchild
pid. Failures end in a native dialog with the log path; the tray stays and "Open" tries
again. The daemon is never killed by the shell, except an outdated one as above and on Quit.
During Quit (`ShellState.quitting`) nothing attaches or starts and no window comes up
(`state::open_action`, `begin_bootstrap`; U-062): a second launch or a deep link is remembered
(`defer_launch_during_quit`), and a start that raced Quit ends the child it just spawned
(`record_child` refuses it), so a spawn is either seen by Quit or ended by its spawner.
`fail_dialog` only logs during Quit.

**The bundled runtime (ADR 0092).** The installers carry `<resources>/runtime/`: Node
(`node/node[.exe]`), the runtime's and its workspace packages' sources, `evals/registry`, a
flat production `node_modules` and a `tsconfig.json` whose `paths` resolve `@forerunner/*`.
`locate_fr` runs it as `<runtime>/node/node <runtime>/node_modules/tsx/dist/cli.mjs
<runtime>/packages/runtime/src/cli/main.ts daemon` with the runtime as cwd and
`TSX_TSCONFIG_PATH` set (`FrCommand.env`). Order: the staged version of ADR 0015 unless it is
older than the bundle, `FORERUNNER_INSTALL_DIR`, the bundle, `install.json`, `PATH`; a staged
version without its own `node/` runs on the bundled Node. `release.md` covers how the payload
is built.

Node only gets plain paths (`install::without_verbatim_prefix`, applied in `bundled_runtime`,
`from_bundled` and `from_install_dir`). On Windows, Tauri's `resource_dir()` is
`\\?\D:\...`, and Node cannot run a script named that way: 1.0.1 died at once when
installed into `D:\AGENT\Forerunner`. **Self-test:** `forerunner-desktop --self-test [--report
<file>]` (`selftest.rs`, handled at the top of `run()` before any window or tray) runs a
launch's steps:
- Tauri's `resource_dir()`, `bundled_runtime` and `locate_fr`, which must pick the bundle;
- `spawn_daemon` and `wait_for_daemon`;
- `/health` with the bundle's version, `/me` with `desktopDeviceId`, and `/setup`.

It then stops the daemon and prints a JSON report, written to `--report` too, since a Windows
release build has no console. A failed report carries the end of `daemon-shell.log`.
`scripts/installed-check.ps1` and `.sh` run it from the installed MSI, `.deb` and AppImage in CI
(`release.md`). It uses the data folder `FORERUNNER_HOME` names, else the real one; on a user's
PC, run it only while the app is closed.

**Injection (`inject.rs`).** The main window is built in Rust (not from `tauri.conf.json`)
with an initialization script that defines a frozen, non-configurable
`window.__FORERUNNER__ = { daemonUrl, daemonToken, installId, platform, shellVersion }` only
when the page origin is one of `tauri://localhost`, `http(s)://tauri.localhost` or the dev
server. The window's navigation policy (`deeplink::navigation_allowed`) refuses every other
origin and opens `http(s)` targets in the OS browser (opener plugin). `installId` is the UUID
in `<config>/install-id` (created on first run, mode 0600). A restarted daemon has a new token,
so `windows::ensure_main` rebuilds the window when the url or token changed.

**Tray (`tray.rs`, `state::tray_view`).** Open Forerunner; Kill switch: stop everything
(confirm dialog → `POST /kill { scope: "all" }`; then disabled, "Resume" enabled →
`POST /kill/resume`); Pause email / Resume email (one item; `POST /agents/<id>/email/pause|resume`
where `<id>` is `/me`'s `agent.id`; enabled only after `GET /agents/<id>/email/settings`
answered 200, disabled with the reason in its text otherwise, since menu items have no
tooltips; a test reads `emailRouteTable()`'s source so a route rename fails it); Updates…
(opens the Updates screen; the shell posts no `/updates/apply` itself); Quit Forerunner (U-018,
ADR 0094: `actions::quit` reads `/health` right then (`sessions_running_now`; the tray's copy
can be 10 s old, U-077) and asks first while sessions run (`quit_confirm_text`), sets
`ShellState.quitting` so the daemon's exit triggers no restart or
dialog, hides the windows, then `supervisor::stop_for_quit`: `POST /shutdown`, wait up to 15 s
for `/health` to stop answering, else end `quit_targets` (the `daemon.json` pid and the spawned
pid, each once; `taskkill /T /F` on Windows, `kill -TERM` elsewhere) while it still answers.
When nothing answers (no `daemon.json` yet during the splash, or a daemon that hangs) the
process the shell started is still ended with everything under it (U-062,
`supervisor::end_own_tree`: `taskkill /T /F`; on Unix `kill -s TERM -- -<pid>` to its process
group, `KILL` after 5 s), while a `daemon.json` pid is never ended without an answer (it may be
stale). That child pid is the shell's own: it is recorded only while the shell holds the
`Child` and cleared once the exit watcher reaped it, and Quit waits up to
`QUIT_CHILD_WAIT` (10 s) for that before ending its tree. Then `app.exit(0)`, or
`app.request_restart()` when Forerunner was launched again during Quit). Closing the window
hides it to the tray; the first close shows a
notification (`windows::closed_to_tray`, marker `<config>/tray-hint-shown`), written only once
the notice was shown (`first_close_hint`, U-077): it goes through `notify-rust` directly
(`actions::show_notification_now`, off the event loop), whose answer says whether the OS took
it, so a refused notice (no notification service, a toast Windows could not create) is tried
again at the next close. A toast Windows takes but keeps quiet (Focus Assist) counts as shown;
the shell cannot see that. Below Open, desktop control (spec S.32, ADR 0067): an item `Desktop
control:
active (<app>)` while the daemon reports it on (enabled; it opens the window, where the banner
names the session) and `Desktop control: off` (disabled) otherwise, and "Stop desktop control"
(`POST /desktop/revoke {reason}`; enabled only while on and reachable). The icon tooltip reads
"Forerunner <version> — N running sessions[, M waiting on you][; kill switch active][; email
paused]", preceded while desktop control is on by a first line `DESKTOP CONTROL ACTIVE: <app>
(session <id>)`; the icon title (`set_title`, shown beside the icon by Linux app indicators)
is `Desktop control active (<app>)` while on and unset when off. While the daemon is
unreachable the last report stays, marked "last reported", with stop disabled. The state is
`ShellState.desktop` (`state::DesktopControl`, `apply` replaces every name on `on` and
clears them on `off`), set through `ShellState::apply_desktop_frame` (a frame, the stop's
answer) and `apply_desktop_read` (the re-read, applied only if no frame or later read landed
since `begin_desktop_read`, so an answer that crossed an `on` frame never clears the tray);
`<app>` is "the desktop" until the controller names one. Left-click opens the window. Closing the window
hides it; the shell keeps running in the tray (`RunEvent::ExitRequested` without a code is
prevented).

**Notifications (`events.rs`).** The shell holds its own `GET /events` (reqwest, bearer
header, 60 s read timeout, backoff 1→15 s) and shows an OS notification (notification plugin)
for every `notification` event: `{ title, body?, level?, route? }`, title required, truncated
at 200/1000 characters, `route` kept only when `is_safe_route` accepts it. Quiet hours are the
daemon's: the shell shows what it receives. `inbox.changed` updates the tooltip,
`desktop.indicator` (`sse::DesktopIndicator`: names trimmed, control characters dropped,
capped at 80 characters) updates the desktop-control state and the tray, and every time the
stream opens `actions::probe_desktop` re-reads `GET /desktop/status`'s `desktopControl`
(frames sent while the stream was down are lost; a 404 or failure leaves the state),
`restart.requested` marks the next exit as expected and, for a daemon the shell did not start
that nothing watches yet (`state::needs_external_watch`: the human pressed "Update and
restart" in the UI, not the tray), starts `actions::watch_external_restart`. The `/health`
monitor (10 s) refreshes the tray; after three misses the daemon counts as unreachable and,
when the daemon was not the shell's own process and no restart is expected, the shell looks
for a new `daemon.json` without starting one.

**Restart (`restart.rs`, `actions::handle_daemon_exit`).** When the daemon the shell started
exits: read `<runtime>/restart.json`; the exit matches the request when it equals the file's
`exitCode` (86 and 75 when absent). `decide_after_exit(code, request, consecutive)`:
Restart (first time; or second time when the request says `rollback`), GiveUp (dialog with
the log path), Crashed (any other non-zero code or a signal; dialog), Stopped (code 0; no
dialog). The restart counter resets once the daemon has been healthy for 30 s. On Restart the
request file is removed, the splash says "Restarting…", the shell waits 3 s for a user service
to bring a fresh `daemon.json`, else runs `bootstrap` again; `locate_fr` prefers the version
`<data>/versions/current.json` names when its directory is a runnable install. For a daemon
the shell did not start (tray or UI request alike), `watch_external_restart` probes `/health`
every second for up to 90 s and applies the same path once `restart::external_daemon_gone`
says the daemon is gone: a pid the OS reports dead (Linux `/proc`) after any miss; a pid
reported alive is waited for however many probes it misses (it may be staging the update);
without a pid signal (Windows), three consecutive misses together with `restart.json`, or ten
misses on their own. One missed probe alone never relaunches, so two daemons never write
`daemon.json` side by side. The exit code fed to `decide_after_exit` is the request's
(`external_exit_code`; `None`, a crash, when the daemon left no request); `restart.json` is
removed only when a relaunch is decided.

**The installer's stop step (`wix/stop-running.wxs`; U-018, ADR 0094, U-066).** Linked through
`bundle.windows.wix.fragmentPaths` and `componentRefs`. Before `InstallValidate` (the
files-in-use check), only when a version is installed (`Installed OR WIX_UPGRADE_DETECTED`), as
the person installing (immediate) and never failing the install (`Return="ignore"`), it runs
64-bit PowerShell through WiX's `WixQuietExec64` (no console window; tauri-bundler always gives
light the util extension and gives candle each `http://schemas.microsoft.com/wix/<Name>`
namespace a fragment declares). The command line is the property `WixQuietExec64CmdLine`, which
the custom action formats once: `[INSTALLDIR]` and `[LocalAppDataFolder]` are passed as separate
quoted arguments (with a `.` appended, so the trailing backslash cannot escape the quote) after
a script that ends in `#`, and the script reads them from
`[Environment]::GetCommandLineArgs()`; an apostrophe, brackets or braces in a folder name
cannot break it. It first ends the daemon's own tree (`taskkill /T` on the pid `daemon.json`
names, under `FORERUNNER_HOME` or `<LocalAppData>\forerunner\runtime`, only while that pid runs
from the install folder), which takes what the daemon started outside it (the voice venv's
python, `npx` MCP servers, Chromium), then every process whose path starts with the install
folder (`StartsWith`, ordinal, ignoring case), and waits up to 10 s. A folder that is not a full
path, or a drive's root, stops nothing. `scripts/msi-stop-running.test.ts` formats the property
as Windows Installer does with an install folder named `It's [x] {y} & 100%`, splits it as
Windows does and checks the script; on Windows it runs it against real processes (a process
from the folder, a "daemon" there with a child outside it, and a bystander that must survive).
`scripts/installed-check.ps1` installs, starts, reinstalls and uninstalls with Forerunner running.

**What the uninstall removes (`wix/uninstall-cleanup.wxs`, U-067).** Two components linked
through `componentRefs` (per-machine and per-user data apart, for ICE57). `<install>\dependencies`
(the app's downloads, voice above all) goes with WiX's `util:RemoveFolderEx`: it runs before
costing, when `INSTALLDIR` is not resolved yet, so the install records the folder in
`HKLM\Software\Forerunner\Installer\DependenciesDir`, a `RegistrySearch` reads it back, and a
`SetProperty` after `AppSearch` hands it to the removal only when `REMOVE~="ALL" AND NOT
UPGRADINGPRODUCTCODE`, so an upgrade (which removes the old version with
`UPGRADINGPRODUCTCODE` set) keeps the downloads. On every other run the property is empty and
the util action logs "Missing folder property" and goes on (it is `Return="ignore"` in the util
library): an expected line in install logs. The folder removal follows no junction and is
rolled back with the rest of a failed uninstall. `HKCU\Software\Classes\fr`, which
`register_all()` writes for the person at every start, is removed with a `RemoveRegistryKey`
for the person who uninstalls; the MSI's own `HKLM` registration goes with Tauri's component.
Data in `%APPDATA%`/`%LOCALAPPDATA%` (dependencies kept there when the install folder could not
be written included) and the keys stay (`docs/setup-guide.md`, "Uninstall").
`scripts/msi-stop-running.test.ts` checks the conditions and the namespace that makes
tauri-bundler give candle the util extension; the installed-app check requires a downloaded
file to survive the reinstall, and the folder and the key to be gone after the uninstall.

**Deep links (`deeplink.rs`).** Scheme `fr`, registered by the bundler on Windows and Linux
(`tauri.conf.json` → `plugins.deep-link.desktop.schemes`) and at start with `register_all()`
(AppImage, dev); the single-instance plugin forwards a second launch to the running shell.
`fr://open` or `fr://` → `/`, `fr://inbox`, `fr://projects/<id>[/<tab>]`, `fr://sessions/<id>`,
`fr://settings`, `fr://memory`, `fr://extensions`; query and fragment dropped; segment
characters `A-Z a-z 0-9 . _ ~ -`. The UI is navigated with `history.pushState` + `popstate`
(`navigate_script`), which `BrowserRouter` follows. Unknown links only bring the window up.

**Window and theme.** `<config>/window-state.json` (`x, y, width, height, maximized`) is
written when the window closes to the tray, on Quit and at most every 2 s while it moves or
resizes, never while it is minimised (`window_state::capture`: Windows parks a minimised window
at -32000, -32000, which would make the next start open at the default place, U-077); on build the
size is lifted to the 900×600 minimum and the position is applied only
when it still lands on a connected monitor. Dark mode is the UI's toggle (ADR 0025): the shell
sets no theme and the webview follows the OS until the UI's stored override says otherwise.

**Global hotkey (`hotkey.rs`, `hotkey_shell.rs`; spec O.1, ADR 0064).** At start (in `setup`,
after the tray) the shell reads `<config>/hotkey.json` (`{ "chord": "…" }`); a missing file
means the default `CommandOrControl+Shift+Space` (Ctrl+Shift+Space on Windows and Linux), a
chord that no longer parses means the default plus a note for Settings. It registers the chord
with tauri-plugin-global-shortcut (`=2.4.0`, the pinned-plugin rule); a refusal (the chord is
taken by another application) or, on Linux, a missing X display (`DISPLAY` unset: the plugin
works through X11/XWayland and would "succeed" without firing) is logged, kept in
`HotkeyState` and emitted as `forerunner://hotkey-changed`; the shell never fails its start
over it. The plugin's one handler acts on `Pressed` only and only for the registered id:
`windows::show_main` (show, un-minimise, focus; without a main window it starts the attach
and the press is not queued), then `forerunner://hotkey { chord, state: "pressed" }` to the
main window. `hotkey_set { chord }` validates with the same grammar (`parse_chord`: modifiers
`CommandOrControl|CmdOrCtrl|Mod`, `Control|Ctrl`, `Alt|Option`, `Shift`, `Super|Command|Cmd|
Meta|Win`; keys A–Z, 0–9, F1–F24, Numpad0–9 and `NAMED_KEYS`; one key, last; a modifier other
than Shift unless the key is a function key; CommandOrControl not with Control or Super),
plans the change (`HotkeyState::plan_change`: the same registered chord is a no-op; another
spelling of the hotkey the OS already holds for us, e.g. `Control+Shift+Space` for the default
on Windows and Linux (one plugin id), is adopted and saved without registering it twice;
otherwise register the new chord first and release the old one only after that succeeded, so
a refused chord keeps the working one), saves the canonical chord and answers the status. The plugin's
own JS commands are not granted to any window; `hotkey_status` and `hotkey_set` are granted to
the main window only (`capabilities/hotkey.json`, enforced because `build.rs` declares them in
the app manifest).

**Microphone (`media.rs`; ADR 0064).** The main window is built with a permission handler:
WebKitGTK denies a `getUserMedia` request nobody answers (verified against WebKitGTK 2.52 with
a virtual PulseAudio source: `NotAllowedError` unhandled, the stream once allowed) and WebView2
would prompt on every first press. `permission_decision` allows the microphone when the page
the window loaded last (`CurrentPage`, recorded from `on_page_load`, so the handler never calls
back into the webview) is on an app origin (`inject::app_origins`: the bundled UI, the dev
server in a dev build), denies it anywhere else or before the first load, denies the camera
(the UI never asks for it) and leaves every other kind to the webview. Every answer is logged.

**Time limits (`daemon::DaemonClient`, U-064).** `GET /health` is a probe with a 1.5 s limit
(`HEALTH_TIMEOUT`): slower counts as a miss. Every other request has its own client with a 30 s
limit (`REQUEST_TIMEOUT`): the actions (`POST /shutdown`, `/kill`, `/kill/resume`, the email
toggle, `/desktop/revoke`) do their work before they answer, and an answer after the probe's
limit is not a failure (1.0.4 used one 1.5 s client for both, so a kill switch that worked
could be reported as failed, and Quit ended a daemon hard that was shutting down). `/events`
has a 60 s read timeout only.

**Logs and secrets.** The shell logs through `tauri-plugin-log` to `<logs>/desktop-shell.log`
(stdout as well in debug builds). The token is a `Secret` (`Debug`/`Display` print
`[redacted]`), every error string from the HTTP client passes through `redact()`, and the
token never appears in a URL or an argv; tests assert the derived `Debug` output of every
struct that carries it. `node scripts/secret-scan.mjs apps/desktop` is clean.

### How to change it

- **A new tray action**: add the item id and `MenuItem` in `tray::install`, its text/enabled
  derivation to `state::tray_view` (with a test), the dispatch arm in `tray::on_menu` and the
  async action in `actions.rs`; call `tray::refresh` after every state change.
- **A new daemon event**: extend `sse::DaemonEvent` and `parse_daemon_event` (mirror the UI's
  `parseDaemonEvent`), handle it in `events::handle_event`.
- **A directory rule change**: change `packages/platform/src/paths.ts`, then `dirs.rs` and its
  fixture table in the same PR.
- **A new deep-link route**: add the root and its segment budget to `deeplink::ROOTS` and a
  case to the tests; document it in ADR 0031's list.
- **Another way to find `fr`**: add a step to `install::locate_fr` (keep the order of ADR 0026)
  with a `FakeFs` test.
- **The restart budget**: `restart::MAX_RESTARTS`, `STABLE_AFTER_SECS` and
  `decide_after_exit`; the tests enumerate every branch. The "gone" rule for a daemon the
  shell did not start is `restart::external_daemon_gone` and `MISSES_WITHOUT_REQUEST`; a
  test in `actions` pins that the misses fit the 90 s budget.
- **The desktop routes or the status field move**: change `actions::DESKTOP_STATUS_PATH` /
  `DESKTOP_REVOKE_PATH`; `actions::tests::desktop_paths_and_the_status_field_match_the_capability_source`
  reads `packages/capabilities/src/desktop/routes.ts` and `controller.ts`.
- **The hotkey grammar**: change `hotkey.rs` (`parse_chord`, `NAMED_KEYS`) and
  `apps/ui/src/shell/hotkey.ts` together and add the case to `apps/ui/test/hotkey-chords.json`;
  both test suites run every case, and
  `every_canonical_chord_is_accepted_by_the_plugin_parser` fails for a key the plugin does
  not know. **Another shell command**: add it to `build.rs`'s app manifest, the
  `generate_handler!` list in `lib.rs` and a capability (an unlisted command is refused).
- **The email routes move**: change `actions::email_settings_path` / `email_action_path`;
  `actions::tests::email_paths_match_the_route_table_source` fails until they match
  `packages/capabilities/src/email/routes.ts` again.

### Tests

```
cd apps/desktop/src-tauri && cargo fmt --check
cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings
cd apps/desktop/src-tauri && cargo test            # unit tests, no daemon, no network
cd apps/desktop/src-tauri && cargo check           # Linux here; Windows in CI (desktop.yml)
```

Unit tests live next to the code (`#[cfg(test)]`): `dirs` (override on every platform,
relative `FORERUNNER_HOME`, empty override ignored, the Windows/XDG cases of `paths.test.ts`,
the full fixture table per platform, home fallback, app name); `daemon` (a zombie counts as ended;
a refused connection, a time-out and a bad answer told apart and a slow daemon waited for, never
started beside, U-065; an action and a read answered after 2 s arrive while a
`/health` that slow is a miss, against a local HTTP server, and the two time limits, U-064; the file
`startDaemon` writes, missing/bad JSON/bad shape, off-machine URL refused, stale pid, attach vs
start, freshness as a changed file, a grandchild pid written after the spawn attaches, daemon
error bodies, client `Debug` hides the token, an older daemon replaced and a newer one kept);
`install` (install dir → node argv, Windows `node.exe` and `.cmd` shims, fall-through to PATH,
the tried list, `install.json` parsing and reading, staged version first, the bundled runtime
ahead of an old checkout's install record and of PATH on its own Node with
`TSX_TSCONFIG_PATH`, `FORERUNNER_INSTALL_DIR` still first, a bundle without Node skipped, a
staged version older than the bundle skipped and a newer one run on the bundled Node,
`runtime.json` parsing, verbatim `\\?\` drive and UNC paths made plain while other forms are
left alone, and no verbatim path in any part of the command Node gets); `version` (release and
pre-release order, non-versions); `selftest` (the flag and the report path, the log tail a
failed report carries); `restart` (file parsing, exit-code matching, one restart then
give up, rollback's extra relaunch, crash/stop, file round trip, the external "gone" rule per
signal, the external exit code); `actions` (email paths against the route table's source,
the desktop paths and `desktopControl.active` against the desktop module's source, the
external watch budget); `inject` (every field, JSON escaping, dev origin added once,
`Debug` hides the token); `sse` (frames across chunks and CRLF, bytes split inside a
character, invalid bytes, the line cap, comments, blank frames, notification validation and
truncation, restart/inbox/heartbeat/unknown, `desktop.indicator` on with names and off
without them, malformed refused, control characters and the cap, the status view's
`desktopControl` read the same way); `deeplink` (documented links, rejections,
safe routes, navigate script, navigation policy); `window_state` (monitor check, minimum size,
file round trip, a minimised window never remembered, U-077); `windows` (the first-close notice
marked only once shown, U-077); `actions` (Quit asks from the count `/health` gives when it is
chosen, U-077); `state` (tray view for unreachable, kill/resume, email availability and
toggle, busy, desktop control on (title, tooltip first line, item, stop enabled) and cleared
on off, "the desktop" without an app and a new `on` replacing the names, the last report kept
but not stoppable while unreachable, a status read never overwriting a newer frame (and the
later of two reads winning), when a restart announcement starts the external watch, nothing
opening or starting during
Quit, a launch during Quit remembered, a spawn that raced Quit not recorded (U-062), `Debug`
hides the token); `supervisor` (log path, the log rotated above 5 MB keeping one older file
(U-077), spawn failure logged, the stop argv per OS, the group argv for the shell's own child;
Quit against real process trees: during the splash with no client, with a hung daemon (a local
HTTP server that accepts and never answers; the `daemon.json` pid is left alone) and with a daemon
that answers and goes after `POST /shutdown`, U-062; waiting for a slow daemon ends answered, gone
or still slow, U-065); `events` (reconnect backoff);
`secret`; `env`; `lib` (install id persisted, 0600); `hotkey` (O.1: the default chord is the
shared one; every accepted and refused case of `apps/ui/test/hotkey-chords.json` with the
same canonical form or reason as the UI; messages name the token; every canonical chord over
all keys and four modifier sets parses with the plugin's own parser; the state machine:
startup failure, retry of the same chord, no-op, register-then-release for another chord, a
refused change keeps the working chord, the press id check, another spelling of the held
hotkey adopted without a second registration; the startup fallback for a bad
saved chord; no X display reported; the preference file round trip and garbage; the event and
status JSON); `media` (the microphone allowed for the app origins only, the dev server only in
a dev build, unreadable or foreign pages denied, the decision follows the last loaded page,
the camera denied, other kinds left to the webview). The Tauri glue (window building, tray
wiring, dialogs, the plugin calls in `hotkey_shell.rs`, the permission handler's wiring in
`windows.rs`) is exercised by `tauri dev` and the CI build, not by unit tests. Last run
2026-10-23 on Linux (item w2-o1-hotkey, rebase onto the release head): `cargo fmt --check`
clean, `cargo clippy --all-targets -- -D warnings` clean, `cargo test` 90 passed, 0 failed
(74 of the base plus the 16 `hotkey` and `media` tests).

### Known issues

- The tray's email item learns `settings.paused` from `probe_email` at start and when the
  daemon becomes reachable again; a pause or resume made on the Email page or from a phone is
  not pushed to it (the daemon's pause and resume routes emit no `/events` frame), so the
  item's text and the tooltip's "email paused" can lag until the next probe. A click still
  does the right thing: the routes are idempotent and the answer resyncs the state (review of
  w2-email-page, 2026-10-25, finding 4; an `email.paused` frame is the fix).
- A click on an OS notification does not open the window (the notification plugin reports no
  click on desktop); the `route` field is parsed for that day.
- Windows-only code (`creation_flags`, `node.exe`, `.cmd` shims, `http://tauri.localhost`)
  compiles by reasoning only: no Windows machine was available; the desktop CI workflow builds
  it on `windows-latest`.
- Global hotkey: on Linux it works through X11 (XWayland on a Wayland desktop); a pure Wayland
  session without XWayland gets "not registered" with the reason, and under XWayland some
  compositors deliver the chord only while an X window has focus. A `DISPLAY` that names no
  reachable X server reads as "active": global-hotkey's X11 thread exits and its `register`
  then answers Ok (global-hotkey 0.8 `x11/mod.rs`), so the shell cannot tell. A desktop-portal
  (`org.freedesktop.portal.GlobalShortcuts`) registration would close that and is not built.
- Global hotkey: a press while the main window does not exist yet (not attached, or being
  rebuilt after a daemon restart) starts the attach but is not queued; the human presses again
  once the window is up. The hotkey's registration and the press have been exercised through
  unit tests of the pure logic only; a run in a real desktop session is not recorded in
  `docs/status/gates.md` yet (no display here).
- Linux tray needs an AppIndicator host (GNOME needs the AppIndicator extension); without one
  the icon is invisible but the window and the daemon work.
- The first run against the real daemon end to end (attach, restart, deep link) is not yet
  recorded in `docs/status/gates.md`.
- `docs/requirements.md` rows K.8, S.8, S.28, M.3 and M.4 do not list the shell's test
  modules (`apps/desktop/src-tauri/src/{state,restart,sse,dirs,daemon,actions}.rs`) yet; same
  ownership.

## Approvals web

`apps/approvals-web`: the web fallback for approvals and chat (spec K.8), a separate React 19
+ Vite + Tailwind 4 page served by the state service (ADR 0024). It talks to the state
service as a `web` device (ADR 0009) and never to a daemon; ADR 0034 records the decisions
the spec left open (link and session, per-tab key, the re-entered code for high-risk answers,
chat as a remote command, presence, routes).

### When to use it

When no paired phone or desktop app is at hand: a human gets a link (desktop notification,
email, or copied from Settings → Devices), opens it in any current browser, answers the
requests that wait on them, asks the agent a quick question that the PC answers, or stops
everything. It is a fallback, not the app: no project pages, no settings, no voice, no
uploads, no reviews. Credentials are never entered here (a `credential` request shows a notice
instead of a field: secrets go into the vault from the desktop app).

### How the link is issued

The desktop runtime (admin) calls `POST /pairing/start { humanId, kind: "web", scopes,
ttlSeconds }` and sends `<service url>/<page path>#code=<code>` through the notification
channel. The default `web` scopes are `read`, `write:inbox`, `write:queue`,
`write:approvals`; add `write:remote` when the human should be able to chat and use the kill
switch from the web (the page disables both with the reason when it is missing). The code is
in the fragment: no server, proxy, log or referrer ever sees it, and the page strips it from
the address bar before doing anything else. The runtime side (issuing from the daemon, a
"Send web link" button in Settings → Devices) is not built yet; `scripts`/`fr` can call the
route by hand meanwhile.

### Auth

On load the page reads `#code=`, generates an Ed25519 key with WebCrypto, posts
`/pairing/complete { code, publicKey, proof, name, platform: "web" }` and receives the scoped
session token. Token, scopes, device id and the private key (JWK) are kept in
`sessionStorage` under `forerunner.approvals.session`, nowhere else: closing the tab signs
out, `Sign out` clears it, a session issued by another service URL or past its expiry is
dropped. Every mutation is signed (`X-Device-Signature` over
`METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0`, `X-Device-Timestamp` in epoch
milliseconds); reads carry only `Authorization: Bearer`. The token never appears in a URL, an
error message, a cookie, `localStorage` or console output (asserted by
`test/app.test.tsx` and `test/client.test.ts`).

High-risk answers (`risk: "high"` or a change card with `risk: "high"`): the page never sends
the biometric flag; it asks `POST /confirm/challenge { requestId }`, tells the human where the
fresh code went (`channel`), and posts the answer with `confirmation: { challengeId, code }`.
`403 confirmation_invalid` keeps the dialog open with the reason and a "Send a new code"
button; a service without the route (`404`) gets "cannot send confirmation codes yet, confirm
from your phone or the desktop app". The route is specified in ADR 0034 and implemented by the
test fake; the state service still has to add it (listed under Known issues).

Config (`src/api/config.ts`): `window.__FORERUNNER__.stateUrl` → `VITE_STATE_API_URL` →
`window.location.origin` (the service serves the page). For the dev server (`pnpm dev`, port
1430) set `VITE_STATE_API_URL` and the service's `FORERUNNER_STATE_API_CORS_ORIGIN`.

### Screens

```
apps/approvals-web/
  index.html, vite.config.ts (base "./": dist/ mounts anywhere), vitest.config.ts, tsconfig.json
  src/
    main.tsx            StrictMode + MemoryRouter + App
    App.tsx             fragment code → exchange → session; sign-in states; routes / and /chat
    api/config.ts       service URL resolution
    api/crypto.ts       base64/hex, SHA-256, canonical request, WebCrypto Ed25519 (generate, import JWK, sign, verify)
    api/types.ts        zod schemas for every response (views mirrored from api-types.ts and the service), ChangeEvent
    api/session.ts      parseFragment, stripFragment, load/save/clear, exchangeCode
    api/client.ts       createClient(): me, health, projects, inbox, answerRequest, markRead, confirmChallenge,
                        devices, sessions, remoteCommands, remoteCommand, sendRemoteCommand, stream; ApiError, describeError
    api/events.ts       SseParser, subscribeChanges(): fetch-based SSE, Last-Event-ID resume, polling fallback
    lib/clock.ts, lib/storage.ts (sessionStorage behind try/catch), lib/presence.ts (pcPresence)
    store/AppContext.tsx AppProvider: projects + active project (sessionStorage), blocking count, presence, feed mode,
                        onChange/onPoll subscriptions, go-live catch-up
    components/ui.tsx   Button, Badge, Banner, Loading, Dialog (native <dialog>)
    screens/SignIn.tsx, Shell.tsx, Inbox.tsx (RequestCard, MessageCard), ConfirmCodeDialog.tsx, Chat.tsx
  test/
    setup.ts, fake-state-service.ts (node:http), harness.tsx, *.test.ts[x]
```

| Screen | What it does | Routes used |
| --- | --- | --- |
| Sign-in | states: exchanging, error in plain words (used or expired link, unreachable service, unsupported browser), idle ("open this page from the link") | `POST /pairing/complete` |
| Header (Shell) | active project always shown (`<select>`, remembered per tab; defaults to the stored choice, else a blocked project, else the first), Inbox with the blocking badge, Chat, feed badge (live / polling / connecting), kill switch (confirm dialog → `kill {scope:"all"}` to every runner that is present: `pc` when a PC is online, `cloud` when it runs sessions; enabled when either is there, so cloud-only work can be stopped from the web; one request per target, a refusal shown next to the other target's status; pick-up and outcome shown), Sign out | `GET /projects`, `GET /devices`, `GET /sessions?status=running,paused`, `GET /remote/commands`, `POST /remote/commands`, `GET /remote/commands/:id`, `GET /events` |
| Inbox | requests blocking first (then newest), each with kind, project, the task it is about (`Task: <title>` from the service's `taskTitle`, U-073), "Blocks work" / "Does not block", "High risk" badge, why it matters, context (steps), option buttons or a free-text field; answer posts `{ version, answer }`; `409` shows "changed on another device" with Reload; answered requests leave the list and are not asked again (the service lists open ones; the runtime records the decision, spec J.4); a credential request shows no answer controls, and a cloud runner vault unlock (`runnerUnlockOf`, spec S.12, ADR 0068) names the runner and says this page has no keyring, so unlock from the desktop or Android app; messages with Mark read; reloads on `human_request.changed` / `message.changed` and on polls | `GET /inbox?humanId=`, `POST /requests/:id/answer`, `POST /confirm/challenge`, `POST /messages/:id/receipt` |
| Chat | read-only quick chat for the active project relayed as `chat` remote command; the reply arrives through the command's result (`{ reply }`); "answering…", "not picked up yet", failures in plain words; disabled with the reason when the link has no `write:remote`, when no PC is online, or when there is no project (the kill switch, by contrast, stays usable for a cloud runner alone) | `POST /remote/commands`, `GET /remote/commands/:id` |

Presence (`lib/presence.ts`): a PC counts as online when a `desktop` device was seen within
five minutes, a session runs or pauses on the `pc` runner, or a runner touched a remote
command within five minutes; cloud sessions set `cloudActive` for the kill switch. Refreshed on
`device.changed`, `session.changed`, `remote_command.changed` and every poll.

Catch-up rule for remote commands (Shell and Chat): the feed does not poll in live mode, and
a command's `remote_command.changed` events can arrive before the screen knows the command
(the POST response is still in flight, or the banner's subscription starts only after every
target answered). So the screen never relies on the event beating it: the kill banner fetches
each command once right after subscribing, the chat tracks the command id in a ref the moment
the POST answers and fetches the command once after adding the entry, and a fetched view
replaces the shown one only when its `version` is newer (two fetches overtaking each other
cannot roll a `done` back to `picked up`). Keep this when adding another command-driven
screen; `test/harness.tsx` `delayingFetch` reproduces the slow-response case.

### Tests

```
cd apps/approvals-web && pnpm typecheck   # tsc over src and test
cd apps/approvals-web && pnpm test        # Vitest, jsdom, fake state service on 127.0.0.1
```

Testing Library and Hono are not among this app's dependencies, so `test/harness.tsx` mounts
the page with `react-dom/client`, drives it with `act()` and a `waitFor`, can replace the
page's fetch (`delayingFetch`, `remoteCommandPost`: hold one response after the fake answered,
to reproduce races against the feed), and `test/fake-state-service.ts` is a `node:http` server: pairing codes, hashed tokens, Ed25519
signature verification (`node:crypto`, SPKI prefix), the five-minute window and replay guard,
scope checks, version conflicts, the high-risk rule with the `/confirm/challenge` stand-in, a
scripted PC that picks commands up and answers chat, SSE with `Last-Event-ID` replay, and a
record of every call. Options `supportsConfirm: false` and `supportsChat: false` make it
behave like the state service does today.

| File | Covers |
| --- | --- |
| `crypto.test.ts` | base64/hex, SHA-256 against `node:crypto`, the canonical string (five lines, `biometric=0`), sign/verify round trip, pairing proof |
| `session.test.ts` | fragment parsing (fragment only, never the query string), strip, load/save/clear (expired, other service, malformed), exchange (single use, scopes, code only in the POST body), error wording |
| `client.test.ts` | bearer-only reads, signed mutations the fake accepts, a forged key refused, error codes and `describeError`, contract validation rejects bad bodies, dead service, token in no URL or message |
| `events.test.ts` | `SseParser`, frame validation, live stream with the token in the header only, polling fallback and retry, `Last-Event-ID` resume with replay of what was missed |
| `presence.test.ts` | each signal, stale/revoked/phone devices, cloud flag |
| `app.test.tsx` | exchange from the link, fragment stripped, token in `sessionStorage` only and never in cookie / `localStorage` / console / URLs / address bar, reload reuses the session without a second exchange, foreign session ignored, sign out, used or unknown code |
| `inbox.test.tsx` | blocking first with why / steps / options / flags, answer with version and signature then gone for good, free text, credential notice, 409 → Reload → answer with the new version, high-risk code flow (wrong code, right code, `biometric` header never sent), service without the route, mark read, reload on another device's answer, read-only link |
| `chat.test.tsx` | relay as `chat` command with project and text, reply shown, a reply the feed announced before the POST response arrived is still shown in live mode (regression), disabled without a PC (and enabled when a session appears), disabled without `write:remote`, service without chat, failed answer |
| `shell.test.tsx` | active project shown and remembered, kill switch confirm/cancel/confirm → command with `scope: all`, outcome shown, PC status kept next to a cloud refusal, PC outcome still shown when the cloud POST answers late in live mode (regression), cloud-only kill when no PC is online (only `cloud` is posted), disabled without scope or without any runner |

### Requirement IDs covered

K.8 (web fallback for approvals; active project in the header), K.4 and J.3 (inbox, blocking
first, context, why, options, blocking flag), J.4 (answered requests are not asked again on
this surface), J.1 and O.1 partial (quick chat from the approvals page, relayed to the PC),
R.4 partial (remote commands from a device, pick-up visible), R.7 (scoped session token,
nothing but the session on the device, high-risk needs a fresh confirmation; biometrics
replaced by the code per ADR 0034), Q.8 partial (high risk never from a plain "yes"), S.8
(kill switch from the UI), S.4 (token and key never in logs; the tests assert it).

### Known issues (approvals web)

- The state service has no `POST /confirm/challenge` and no confirmation check in
  `answerRequestAs` yet; high-risk answers from the web fail with the explanation until it
  lands (ADR 0034 item 4).
- The page sends chat as `command: "chat"` with `{ projectId, text }`, but `REMOTE_COMMANDS`
  in the service (`services/state-api/src/routes/remote.ts`) has no `chat`, so the service
  refuses it (`validation`) and the page shows "does not relay chat yet" (ADR 0034 item 5).
  The daemon's `RemoteCommandWatcher` runs the phone's chat envelope (`command: "start"`,
  params `{ v: 1, kind: "chat", text, projectId, clientId }`); sending that envelope from the
  page, or adding `chat` to the service, would close it. The kill switch completes against
  the real service: the watcher consumes `kill` (ADR 0034 item 6).
- Nothing issues the link yet (no daemon route or Settings button calls `POST /pairing/start`
  with `kind: "web"`). The daemon registers its `desktop` device row (`registerDesktopDevice`
  in `packages/runtime/src/daemon/compose.ts`) on every store whenever its background
  services run (ADR 0030: the row the desktop app confirms a high-risk change on), and
  heartbeats it (`DesktopPresence`) only when remote commands are enabled
  (`remoteCommandsEnabled`): by default on a shared store; on a solo `sqlite:` store only
  with `FORERUNNER_REMOTE_COMMANDS=1`, so without the variable the row exists but is never
  heartbeated and no remote command is picked up.
- The service does not serve `dist/` yet; build with `pnpm --filter @forerunner/approvals-web
  build` and mount the folder (relative asset paths).
- Ed25519 in WebCrypto needs a current browser (Chrome 137+, Firefox 130+, Safari 17+); older
  ones get a plain message at sign-in.

## Android app (`apps/mobile` and `apps/ui/src/mobile`)

### Purpose

The phone client of spec module R (ADR 0009, ADR 0024, ADR 0026, ADR 0032): the same React
bundle as the desktop, mounted under `/m`, wrapped by a thin Tauri 2 Android shell. The phone
never talks to a PC's daemon. It pairs with the shared state service, reads its projects and
inbox, answers requests (high risk with the platform biometric prompt), relays quick chat,
push-to-talk voice turns and natural-language control to the PC as remote commands, uploads
photos, files and documents to a project, reviews PRs and critic findings (comment, approve,
reject), and shows the change log with Undo.
Heavy work stays on the PC or the cloud runner (R.8).

Requirements covered: R.1 (Tauri 2 Android target sharing the UI; the release APK signed by
Gradle with the keystore `scripts/android-keystore.mjs` prepares and verified by
`scripts/android-apk-verify.mjs` in CI, see `release.md` "Signing"; Play track and update
channel pending), R.2 (pairing by QR /
`fr://` deep link / typed code; own key; forget here, revoke on the desktop), R.3 (state
service client, live SSE with polling fallback, offline outbox flushed on reconnect), R.4
(start / pause / stop / kill as remote commands with `target: "pc"`; the live session log
screen), R.5 (quick chat as a remote command, natural-language control, notes to the
next-session queue, answering requests, uploads, PR and critic review, push-to-talk relayed to
the PC's voice loop, ADR 0080; the emulator run is open), R.6 partial
(in-app notices for approvals, sessions, budget warnings and messages with quiet hours; FCM
wired end to end and built in only when the `GOOGLE_SERVICES_JSON_BASE64` secret is set, so
the shipped APK is the polling stand-in until the human adds it), R.7 (biometric assertion inside the signed string for high-risk
answers, scoped 30-day tokens, no secret on the phone but its own wrapped key and token, lost
phone revoked from the desktop), R.8 (the phone only controls, contributes and reviews). On
the phone side also Q.2 to Q.4, Q.9 and Q.11 (understanding, active project in the header,
one change card for a plan, change log with undo), K.4 and J.3 (inbox, blocking first), F.3
(realtime), S.4 (no token or key in logs; tests assert it).

### How it works

```
apps/ui/src/api/
  state-signing.ts   canonical request string (= services/state-api/src/auth/crypto.ts), SHA-256 and
                     Ed25519 via WebCrypto, DeviceSigner and BiometricPort ports, the simulated prompt
  state-client.ts    typed client: pairing, /me, projects, inbox, requests, receipts, messages, queue,
                     remote commands (RemotePlanEnvelope / RemoteChatEnvelope / RemoteVoiceEnvelope,
                     verbForPlan), sessions, devices, /sync/outbox, uploads (signed multipart built by
                     multipartBody, so the bytes signed are the bytes sent), reviews (list, comment,
                     approve / reject); every mutation signed, biometric flag only from an assertion
  state-sse.ts       /events and /sessions/:id/events over fetch; live -> polling -> offline, resume
apps/ui/src/mobile/
  MobileApp.tsx      the /m route tree, header (active project, sync badge), bottom nav, the simulated
                     biometric dialog (outside the shell only)
  store.tsx          MobileController: bootstrap, pairing, refresh, change feed, outbox flush, answers,
                     receipts, notes, planCard/sendPlan/undo, chat; MobileProvider, useMobileState
  intent.ts          phrases -> module-Q commands (EN/DE, CHF/USD, tonight/tomorrow/until HH:MM), one
                     question with options when unclear, refuses content envelopes
  change-card.ts     ONE card per plan (risk, scope, duration, cost), inversePlan, renderCard
  change-log.ts      per-install log (200 entries), remote status mapping, canUndo
  outbox.ts          offline queue, batches to /sync/outbox, duplicates never applied twice
  uploads.ts         offline upload queue: files picked while unreachable, resent under their clientId
                     on reconnect (persisted up to 2 MiB in total, the rest held in memory)
  voice.ts           push-to-talk ports: VoiceRecorder (webRecorder: getUserMedia + AudioContext, 16 kHz
                     mono PCM), Speaker (webSpeaker: speechSynthesis), encodeTurn (5 s cap), toRelayPcm
  pairing.ts         fr://pair?u=&c=&h=, web link, qr JSON, bare code; buildPairingLink
  push.ts            PushPort, PollingPush (the stand-in), quiet hours, noticeFor(feed event),
                     parsePushLink / safeAppPath (fr://open?link=), pushTokenFingerprint
  storage.ts         per-install localStorage keys, SecureStore (shell | browser | memory); the
                     cloud runner's vault key sits in the shell's secure store under
                     runner-vault-key-<runner> (ADR 0068)
  shell-bridge.ts    invoke wrappers: shell_info, device_key_*, secure_store_*, assert_biometric,
                     push_status, barcode scan, deep links
  screens/           Pairing, Home, Inbox, Chat (with push-to-talk), Reviews, Upload, Remote, Changes,
                     Settings, Session (live log);
                     Inbox names each card's project and task (`Task: <title>`, U-073) and
                     renders a cloud runner unlock as the shared UnlockCard with
                     `controller.runnerKeys` (secureStoreRunnerKeys in the shell, read-only
                     without one) and `controller.answerUnlock` (biometric first, the window
                     recorded on the phone after the service accepted the answer); the
                     auto-answer inside the phone's window runs in `MobileShell`
                     (MobileApp.tsx) over the controller's inbox, on every screen
apps/mobile/
  package.json       tauri CLI scripts; test:emulator -> e2e/run.mjs
  e2e/run.mjs        emulator run (build, boot, install, fake service, CDP smoke); README.md has the
                     adb / gradle commands by hand
  e2e/webview-console.mjs  forwardPageConsole: the page's console and uncaught exceptions as
                     `webview:` lines on the runner's stdout (ADR 0086); its own module, typed by
                     webview-console.d.mts, so the driver below is untouched; tested in cdp.test.ts
  e2e/cdp.mjs        raw CDP client and DOM driver for the smoke (ADR 0054): /json/list, page socket,
                     Runtime.evaluate queries, Input.* clicks and fills; no eval in the page (CSP);
                     click = a layout-settle wait, instant scrollIntoView, measure + hit test +
                     guard in one in-page call, then CDP mouse events; the click guard (ADR
                     0087): events that land outside the measured element are stopped in the
                     page (the guard stays up until the attempt's click arrives, and records
                     where the page saw the event) and the click is sent again; after three
                     guarded misses at one unchanged box the fallback ladder (ADR 0087
                     amendment of 2026-10-25: a mouse click shifted by the reported offset, an
                     Input.dispatchTouchEvent tap, element.click() in the page), each step a
                     `click fallback:` line on stdout; describePage for the runner's page:
                     lines; cdp.test.ts against a fake endpoint
  e2e/cdp.d.mts      types of cdp.mjs for the test (keep in step); e2e/jsdom.d.ts: the jsdom slice it uses
  src-tauri/
    Cargo.toml, tauri.conf.json (no static window; deep-link scheme "fr"; CSP allows 127.0.0.1 and 10.0.2.2)
    capabilities/default.json (core, deep-link, log), mobile.json (biometric:allow-status,
                       biometric:allow-authenticate, barcode-scanner; Android/iOS only)
    src/lib.rs         run(): plugins, KeystorePlugin registration (Android), Shell state, injection
                       script, deep links, the window
    src/commands.rs    the invoke commands, Shell (secure files, config, info, push), build_shell,
                       the Android KeystoreWrapper over the Kotlin plugin
    src/keystore.rs    DeviceKey (ed25519-dalek; Debug redacts), Wrapper trait, SecureFiles (0600,
                       atomic writes), SESSION_TOKEN_KEY
    src/biometric.rs   BiometricOutcome; asserted() only after the platform prompt succeeded;
                       refusal_from_status / outcome_from_auth (the plugin's reason, never empty);
                       wait_bounded + PROMPT_LIMIT (45 s); TicketBook
    src/config.rs      <config>/mobile.json (state_url, device_name, install_id), recover(), the
                       fr://pair link parser
    src/dirs.rs        app_dirs(): mirror of packages/platform/src/paths.ts appDirs()
    src/push.rs        PushPort: PollingPush, FcmPush, FcmPending; configured(token, fcm_configured); Shell::set_push_token
                       follows the token push_status re-reads from info
    gen/android/app/build.gradle.kts
                       the Tauri-generated Gradle module (kept after `android init`), plus the release
                       signing config read from gen/android/keystore.properties when the file exists,
                       and FCM (firebase-messaging, src/fcm, the google-services plugin,
                       BuildConfig.FCM_CONFIGURED) only when app/google-services.json exists
    gen/android/app/src/main/java/app/forerunner/mobile/KeystorePlugin.kt
                       AES-256-GCM key in the Android Keystore (StrongBox when present) that wraps the
                       seed and the token; info (model, strongBox, biometric, fcmToken or null,
                       fcmConfigured)
    gen/android/app/src/main/java/app/forerunner/mobile/MainActivity.kt
                       notification tap -> fr://open?link=; POST_NOTIFICATIONS asked once (FCM builds);
                       the content view padded by the window insets (edge to edge, below)
    gen/android/app/src/main/java/app/forerunner/mobile/SafeArea.kt
                       Edges, SafeArea.padding: per edge the largest of system bars, cutout, keyboard
    gen/android/app/src/main/java/app/forerunner/mobile/PushLinks.kt, PushTokenStore.kt
                       pure link, kind and channel rules (JVM-tested); the token in private prefs
    gen/android/app/src/fcm/   ForerunnerMessagingService, FcmStartup, AndroidManifest.xml (FCM only)
    gen/android/app/src/test/  PushLinksTest, SafeAreaTest (JUnit 4)
scripts/android-google-services.mjs
                       GOOGLE_SERVICES_JSON_BASE64 -> gen/android/app/google-services.json (checked)
```

**Edge to edge.** Android 15+ draws every app targeting SDK 35+ (this one targets 37) under
the status and navigation bars, and `MainActivity` also calls `enableEdgeToEdge()`. The WebView
was laid out from y = 0, so on the signed rc.3 APK (Samsung SM-S911B) the header ran under the
clock and the sync badge under the battery icon. `MainActivity.padContentForInsets` sets an
insets listener on `android.R.id.content` (the WebView's parent): it pads that view by
`SafeArea.padding(systemBars, displayCutout, ime)`, per edge the largest of the three (they
overlap: the keyboard's bottom inset includes the navigation bar), and returns
`WindowInsetsCompat.CONSUMED`. The fix is native, not CSS: the page needs no
`env(safe-area-inset-*)` or inset variables, and because the insets are consumed a WebView that
reports `env(safe-area-inset-*)` itself sees zero, so nothing pads twice. The UI's fixed header
and bottom nav sit inside the padded WebView unchanged. The padded strips show the theme's
window background (Material 3 DayNight); the status bar icons follow `enableEdgeToEdge`'s
light/dark choice. The keyboard inset means the WebView shrinks above the keyboard, which
`adjustResize` no longer does for an edge-to-edge window. The activity uses `adjustResize` (so Android 10, the minimum, reports the keyboard as an inset
too), and the window background is the page's (white, `#0A0A0A` at night), so the padded strips
under the status and navigation bars match the header and the bottom navigation.

**Boot.** The shell resolves the app directories, loads `mobile.json`, builds the secure
files over the Keystore wrapper (Android) or the file wrapper (desktop dev builds; Settings
says "file"), and injects `window.__FORERUNNER__ = { platform: "android", shellVersion,
installId, stateUrl, deviceName }` before the bundle loads. `App.tsx` mounts `MobileApp`
when `platform` is `android` or the path starts with `/m`. `MobileController.bootstrap`
reads the saved session record (ids, scopes, expiry; never the token) and the token from the
secure store; with both it goes to Home, refreshes `/me`, projects and inbox, opens the change
feed and flushes the outbox; otherwise it shows Pairing. A deep link or a scan pre-fills the
code and the service URL.

**Pairing.** The desktop (admin) starts a pairing (`POST /pairing/start`); the phone posts the
code, its public key (`device_key_public`, generated on first use) and the proof
`sign("pair:<code>")`; the service answers with the device id and a scoped session token,
stored through `secure_store_set` (Keystore-wrapped). The same key signs every later
mutation (`X-Device-Signature`, `X-Device-Timestamp`, strictly increasing timestamps).

**High risk.** `MobileController.answerRequest` asks the `BiometricPort` first when the
request's `risk` or its change card's risk is `high`; only a returned assertion sets
`biometric=1` in the signed string and the `X-Biometric-Assertion` header, and the flag is
bound to the prompt in code (ADR 0032 item 3): a successful `assert_biometric` (Android's
BiometricPrompt through tauri-plugin-biometric; `asserted: false` with a reason on every
other target) issues a one-time ticket the shell keeps (`biometric::TicketBook`, 120 s),
and `device_key_sign` signs a canonical string whose last line is `biometric=1` only against
that ticket, consuming it. A screen that fabricates `{ asserted: true }` is refused by
`ShellSigner` before the IPC and by the shell (`biometric ticket missing` / `unknown or
already used`); the client reports `biometric_required` and sends nothing. Outside the shell
the simulated dialog says it is simulated and draws its ticket from `WebCryptoSigner.tickets`,
which applies the same rule. A cancelled prompt sends nothing. High-risk answers are never
queued.

**A phone that cannot confirm** (ADR 0086; `android.yml` run 39952987240, an emulator without
an enrolled fingerprint). Everything the biometric step can do other than resolve a ticketed
assertion in time is a refusal: `null`, a rejection of any shape (string, `Error`, a plugin's
`{ message, code }`), a synchronous throw, a malformed outcome, a prompt that does not answer.
`MobileController.assertHighRisk` races the port against `biometricTimeoutMs` (default
`BIOMETRIC_TIMEOUT_MS`, 60 s) and throws `biometric_required` with `details.reason`; the card
shows "This answer needs a biometric confirmation (<reason>)." under `m-request-error` and
its buttons work again; a success that arrives late is dropped, and a simulated prompt still
open when the bound runs out (web build) is closed with the refusal. In the shell,
`assert_biometric` runs the plugin's blocking `status` / `authenticate` on their own thread
behind `biometric::wait_bounded` (`PROMPT_LIMIT`, 45 s, inside the UI's bound), so it always
answers: the plugin's text for a not-available status ("Biometrics not enrolled.", else its
`errorCode`), "not confirmed: <the plugin's words>" for a failed prompt, "did not answer
within 45 s" or "failed without an answer" (a panic) otherwise. `shellBiometric` rejects with
`BiometricRefusedError(<reason>)` for a reasoned `asserted: false` and with "the shell's
prompt failed: <IPC error>" for a rejected invoke (`failureText`). Both ends of the step are
logged to the page console (`forerunner: high-risk answer: asking the biometric prompt` /
`... refused on the phone: <reason>`), which the emulator runner forwards; the shell logs
`assert_biometric: asserted=... method=... reason=...` to logcat, never the ticket.

**Remote control and the change card.** The Remote screen (and Chat, when a message is a
change sentence) parses the words with `intent.ts`, builds one `MobileChangeCard` for the
plan, and on Confirm sends ONE `POST /remote/commands` with the plan envelope (ADR 0032 item
4), logs the entry, follows the command through `remote_command.changed` events (or polling)
to `picked_up` / `done` / `failed`, and offers Undo while the entry is reversible: Undo sends
the inverse plan with `undoOf`. The scenario-9 sentence becomes `project.switch(proj_game)`,
`budget.set(scope session, 15 CHF, until 06:00 tomorrow, proj_game)` and
`session.start(proj_game, runner pc)`; the controls build the same plan, plus a Pause and a
Stop-everything control. Project names that contain a clause word ("Rock and Roll") are
guarded before the sentence is split. The card's old values come from service data, never
constants: project budgets from the cards, the human's monthly cap from `/me` `monthlyCap`
when the service sends it (it does not yet: the card then says "the current cap" and treats
a monthly change as high risk), the CHF rate from the cards' USD/CHF pairs
(`DEFAULT_CHF_PER_USD` only when none is known).

**Sync.** `subscribeStateEvents` streams `/events` with the bearer header through `fetch`
(EventSource cannot send it) and resumes with `Last-Event-ID`; when the stream is refused or
drops it polls the inbox and pending commands every 5 s and retries the stream every 30 s;
when polling fails too the mode is `offline`. The header badge and Settings show
`live / polling / offline` and the number of queued actions. An auth loss (`unauthorized`:
revoked on the desktop, or the token expired) runs `MobileController.lostAuth`: token,
session record and key go, the outbox and the change log stay, the notice and the pairing
screen count the queued actions, and `pair` flushes them under the new device. Only
`forgetDevice` ("Forget this device") clears them.

**Uploads, reviews and voice (spec R.5, [ADR 0080](../decisions/0080-phone-uploads-reviews-and-voice-relay.md)).**
The Upload screen (nav "Upload") picks a file through the web file input, or a photo through
the camera input (`accept="image/*" capture="environment"`; the Android shell has no picker
or share-target command yet), lets the human rename it, pick the project and the kind
(photo / document / file, guessed from the type), and shows the service's cap
(`GET /projects/:id/uploads` returns `maxBytes`) before and after the pick; a file over it is
refused on the phone (`MobileController.uploadFile`, `payload_too_large`) before a byte
leaves. The upload is `POST /projects/:id/uploads` as signed multipart with a fresh
`clientId`; the progress shows the phases (reading, sending, uploaded or queued; `fetch` has
no upload progress events). Unreachable, the file goes to `UploadQueue` and the header's
"n queued" counts it; a file over the queue's storage budget (`PERSIST_MAX_BYTES`, 2 MiB in
total) is held in memory only, and the screen (`m-upload-memory-only`) and the notice say it
is lost if the app closes before it is sent; `flushOutbox` sends it first on reconnect, a 4xx drops it with a notice,
and a resend after a lost answer is answered with the asset already made (the service's
`clientId` idempotency), so the project never gets a second copy. The Reviews screen (nav
"Reviews") lists `GET /reviews?projectId=` for the chosen project: task, PR link, verdict,
grade, tier, summary and every finding with severity, status and the required action; the
open approval request on the review's task (from the inbox) is shown as "waiting on you".
Comment is `POST /reviews/:id/comment` (a message to the agent responsible); Approve and
Reject are `POST /reviews/:id/approve|reject { body?, requestVersion? }`, which answer that
request at the version the phone saw, with the request's own option for the verdict (U-027:
Approve is the card's accept / yes / approve button, Reject its revise / rework / reject / no
button), so the outcome is the one that click has in the Inbox; the fake state service picks
the option with the same `reviewVerdictOption` (`mobile-reviews.test.tsx` asserts the stored
answer is the card's "Approve" / "Reject"). `MobileController.reviewVerdict` reads the inbox afresh
before it decides, so an approval filed after the last load is seen. When that request is high
risk the biometric prompt runs first and the flag is signed into the request (ADR 0045, the
rule of high-risk answers); a cancelled prompt sends nothing. Should the service still answer
`biometric_required` (a request the phone could not see, the inbox unreachable), the prompt
runs then and the verdict is sent once more with the flag. The service answers the request
before it messages the agent, so a refused verdict tells the agent nothing
(`state-service.md`). Verdicts are never queued. On Chat, "Hold to talk"
(pointer or Space / Enter held) records through `env.recorder`; the release (or the 5 s limit,
released for the human) sends ONE `POST /remote/commands` whose params are the voice envelope
`{ v: 1, kind: "voice", projectId, clientId, audio: { pcm, sampleRate: 16000, channels: 1,
durationMs } }`; the PC's watcher runs it through its voice loop (`runtime.md`, "The phone's
push-to-talk"), the result's `said` replaces the bubble's "Voice turn (n s)" and its `reply` is
shown and spoken through `env.speaker`. Where the page cannot record (the Android shell today:
`envFromGlobals` gives it no recorder; or a refused microphone, after which the screen switches
over) the button is "Say it" and relays the typed line as `transcript` instead. A PC without
voice answers `failed` and the screen says so; so does a PC that picks the turn up more than
two minutes late (`expired`, never run; `runtime.md`).

**Push.** `push.rs` and `push.ts` keep one port with two modes, decided by the Android build
(ADR 0085 point 9 and its amendment of 2026-10-25; ADR 0032 item 6).

The service half (ADR 0085, `state-service.md`, "Push to Android"): the state service
accepts `pushToken` at `POST /pairing/complete`, takes refreshed tokens at the signed
`PUT /devices/:id/push-token { pushToken }`, and sends approvals, finished sessions, budget
warnings and messages through FCM HTTP v1 to every device of the human with a token,
honouring the human's quiet hours, once a service account is configured by reference
(`FORERUNNER_FCM_SERVICE_ACCOUNT_REF`). The message carries a notification block with a
generic title and body and `data { kind, id, link, projectId? }` (kinds `approval`,
`session`, `budget`, `message`, the same names as the app's `PushCategory`); `link` is a
route the app opens.

The app half, the Android push wiring:

- **Gradle.** `gen/android/app/build.gradle.kts` checks for `google-services.json` in the app
  module. With the file it adds `com.google.firebase:firebase-messaging`, the `src/fcm`
  sources (`java.srcDir`) and manifest (merged as the `debug` and `release` build-type
  manifests, which this module does not otherwise have), applies the
  `com.google.gms.google-services` plugin (on the root classpath only) and sets
  `BuildConfig.FCM_CONFIGURED = true`. Without it none of that happens and the APK behaves as
  the polling stand-in: the FCM sources, the `firebase-messaging` dependency, the Google
  services plugin and the `POST_NOTIFICATIONS` permission are absent (the main source set
  still carries the small `PushLinks` and `PushTokenStore` and the notification icon). That is
  every build without the secret, fork PRs and the emulator smoke. `-PforerunnerFcmCompileCheck=true` adds the sources and the
  dependency without the file or the plugin, so CI compiles the FCM code on every run; that
  APK has no Firebase configuration and stays polling.
- **The file is a build secret.** It is gitignored (module and root `.gitignore`), never
  committed, and `pnpm secrets:scan` flags a Google API key shape. `scripts/android-google-services.mjs`
  decodes the Actions secret `GOOGLE_SERVICES_JSON_BASE64`, checks that it is a Firebase
  config with an Android client for `app.forerunner.mobile` (a wrong secret fails the step,
  not Gradle), and writes it mode 0600; without the secret it writes nothing and says push
  stays polling (a file a maintainer copied by hand is kept). `android.yml` and `release.yml`
  run it before the build, like `android-keystore.mjs` (`release.md`, "Signing").
- **`src/fcm`** (compiled only in the cases above): `ForerunnerMessagingService`
  (`FirebaseMessagingService`, registered in `src/fcm/AndroidManifest.xml`, not exported):
  `onNewToken` stores the token in `PushTokenStore` (app-private preferences);
  `onMessageReceived` (a message while the app is in the foreground) drops unknown kinds and
  any `link` that is not a plain app path, then posts the generic title and body on the
  `attention` channel (approval, budget; high importance) or `updates` (session, message),
  one notification per item, with a tap that opens `MainActivity` with the `link` extra.
  `FcmStartup` (a content provider after Firebase's own) creates both channels and stores
  `FirebaseMessaging.getInstance().token` at every launch. In the background the system tray
  shows the notification block on the channel the service names per kind
  (`android.notification.channel_id`, the same `attention` / `updates` split;
  `state-service.md`), falling back to the manifest's default channel (`updates`), with the
  icon `ic_notification`, and a tap launches `MainActivity` with the data as extras.
  `POST_NOTIFICATIONS` is declared there and `MainActivity` asks for it once per install on
  Android 13+, only when `FCM_CONFIGURED`.
- **Opening `link`.** `MainActivity` turns an intent with a `link` extra into
  `ACTION_VIEW fr://open?link=<path>` (`PushLinks.deepLink`; `onCreate` before the deep-link
  plugin reads the intent, `onNewIntent` for a running app). The UI's deep-link handler
  (`MobileController.offerDeepLink`) takes pairing links as before and `fr://open` through
  `parsePushLink` (a plain absolute app path only: no scheme, host, `//`, `..`, query or
  fragment); `pendingLink` is navigated to by `MobileShell` once the phone is paired.
- **`fcmToken`.** `KeystorePlugin.info` returns `PushTokenStore`'s token when
  `FCM_CONFIGURED`, `null` otherwise, and `fcmConfigured` (`BuildConfig.FCM_CONFIGURED`). The
  Rust shell reads both at setup and again on every `push_status` (on a blocking thread; a
  failed plugin call keeps the previous values): `push.rs` `configured(token, fcm_configured)`
  is `FcmPush` with a token, `FcmPending` (mode `fcm`, no token) in a Firebase build whose
  first token has not arrived, `PollingPush` otherwise.
- **Token at pairing and on refresh (TS).** `MobileController.pair` asks `push_status` and
  sends the token as `pushToken` on `POST /pairing/complete` when the mode is `fcm` with a
  token (the field is left out otherwise). The first token on a fresh install usually comes
  after that request, so `pair` ends with `syncPushToken`, and while the mode is `fcm`
  without a token it looks once more after `pushRetryMs` (10 s; cancelled by `close`).
  `syncPushToken` also runs after bootstrap and whenever the app returns to the foreground,
  on two signals: the shell's `tauri://resumed` (Tauri's `WindowEvent::Resumed`, from the
  Activity's `onResume`; `shellResumed` in `shell-bridge.ts`, `env.resumed`) and
  `visibilitychange` to visible, so the re-check does not depend on how the WebView reports
  visibility. When the token differs from the one registered for this device it sends
  `StateClient.setPushToken` (`PUT /devices/:id/push-token`, signed with the device key like
  every mutation; a token that disappeared from a build without Firebase is sent as null; a
  pending Firebase build never sends null), and a build without Firebase never sends.
  `forgetDevice` first sends `setPushToken(deviceId, null)` when a token is registered (best
  effort; the forget goes on when the service is unreachable), and dropping the identity
  clears `pendingLink`. The phone keeps only `{ deviceId, fingerprint }` (SHA-256 of
  the token) under `pushRegistration` to tell a refresh from the registered token; the
  state's `push` keeps mode and detail with `token: null`. Nothing logs the token on either
  side.

What the human still provides (ADR 0085 amendment): `google-services.json` as the
`GOOGLE_SERVICES_JSON_BASE64` secret, and on the state service the service account JSON in
the vault behind `FORERUNNER_FCM_SERVICE_ACCOUNT_REF`. Until then the shipped mode is
`polling`: the change feed raises in-app notices for approvals, finished sessions, budget
warnings and messages, suppressed inside quiet hours.

### How to change it

- **A new screen**: `src/mobile/screens/XScreen.tsx`, a `<Route>` in `MobileRoutes`, a nav
  entry in `NAV` when it belongs in the bottom bar, a `test/mobile-x.test.tsx` that mounts
  it through `renderMobile` in `test/mobile-helpers.tsx` against the in-process fake, and a
  Playwright spec when it is a flow.
- **The phone's microphone in the shell**: add a capture command to the shell (or grant the
  WebView's `RECORD_AUDIO` permission request), return a `VoiceRecorder` of kind `shell` from
  `envFromGlobals` when the shell reports it; the Chat screen and the envelope stay.
- **A share target or a native picker for uploads**: a shell command (or an intent filter
  feeding a deep link) that hands bytes to `MobileController.uploadFile`; the queue and the
  route stay.
- **A new phrase or command on the phone**: a matcher in `intent.ts` (keep the EN and DE
  forms), its card in `cardFor` and its inverse in `inversePlan` (`change-card.ts`), the fake
  PC's `executeOnPc` in `test/fake-state-service.ts`, and tests in `mobile-intent.test.ts`
  and `mobile-change-card.test.ts`. The PC's registry (`packages/commands`) must know the
  command; the phone never has the last word.
- **A new shell command**: a `#[tauri::command]` in `commands.rs`, its name in
  `generate_handler!` (`lib.rs`), a wrapper in `shell-bridge.ts`, and a unit test in the
  Rust module. Errors cross the bridge as strings without key material. Anything that signs
  goes through `Shell::sign`, so the biometric ticket rule applies to it too.
- **Another prompt that may set the biometric flag**: it must issue its ticket from the same
  book the signer redeems (`Shell::issue_biometric_ticket` in the shell,
  `signer.tickets.issue()` on the web) and put it in the `BiometricAssertion`; nothing else
  gets a `biometric=1` signature.
- **Turn on FCM**: download `google-services.json` for the Android app
  `app.forerunner.mobile` from the Firebase console, store it base64-encoded as the Actions
  secret `GOOGLE_SERVICES_JSON_BASE64` (`base64 -w0 google-services.json`; for a local build
  copy the file to `gen/android/app/` or run `node scripts/android-google-services.mjs` with
  the variable set), and check that the build log says `google-services.json found: FCM push
  is built in`. On the state service set `FORERUNNER_FCM_SERVICE_ACCOUNT_REF` to the vault
  secret holding the service account JSON and check `/health` says `push.mode: "fcm"`. Then a
  phone paired with that APK shows `fcm — Firebase Cloud Messaging` in Settings.
- **A new push kind**: the state service's fan-out (`state-service.md`), `PushLinks.KINDS`,
  `channelFor` and `defaultTitle` (with `PushLinksTest`), and `PushCategory` in `push.ts`.
- **A new notification route**: it is a mobile route in `MobileRoutes`; `safeAppPath`
  (`push.ts`) and `PushLinks.safeLink` accept any plain absolute path, so only a route with
  characters outside `A-Z a-z 0-9 . _ ~ - /` needs both rules changed together.
- **Change where the key lives**: implement `Wrapper` in `keystore.rs` (or another Kotlin
  plugin) and pick it in `platform_bits`; `SecureFiles` and the tests stay.
- **Directory rules**: `dirs.rs` mirrors `packages/platform/src/paths.ts`; change both and
  their tests together.

### Tests

- `apps/ui/test/state-signing.test.ts`: the canonical string is byte for byte the service's,
  RFC 8032 vector, WebCrypto signer, the simulated biometric port is marked simulated, the
  ticket book redeems once inside its TTL, a fabricated assertion gets no `biometric=1`
  signature and a real one signs exactly once.
- `apps/ui/test/state-client.test.ts`: pairing with a verified proof, scoped token, every
  mutation signed and verified by the service's own crypto module, replay and clock-skew
  refusals, biometric flag only with a ticketed assertion (a forged one never reaches the
  service), revocation, contract validation, outbox.
- `apps/ui/test/mobile-shell-signer.test.ts`: the `ShellSigner` path with the Tauri bridge
  mocked: a literal assertion object is refused before the IPC, the ticket is forwarded to
  `device_key_sign`, the shell's refusal maps to `biometric_required`, an outcome without a
  ticket is no assertion; `shellBiometric` turns the not-enrolled outcome into a
  `BiometricRefusedError` with the shell's reason, a malformed or reasonless outcome into
  `null`, and an IPC rejection of every shape (permission string, plugin object, `Error`,
  other) into a refusal naming it.
- `apps/ui/test/mobile-inbox.test.tsx` ("a high-risk answer on a phone that cannot
  confirm is refused"): `InboxScreen` with a biometric port per candidate of run 39952987240
  (null; the real `shellBiometric` over a mocked bridge answering "Biometrics not enrolled."
  and rejecting with a permission error; the plugin's error object, a string, an `Error`, a
  synchronous throw; a prompt that never settles, ended by the bounded wait; the simulated
  dialog closed by that bound, then a second Confirm that passes; a late success
  that sends nothing; reloads under the refusal), each asserting the refusal names the
  biometric step, sits under `m-request-error` in the card that holds `m-request-high`, and
  no answer leaves the phone; plus the enrolled happy path (answer signed with the
  assertion's flag).
- `apps/ui/test/state-sse.test.ts`: frame parsing, live stream with heartbeats, per-human
  filtering, polling and offline fallback, session log polling.
- `apps/ui/test/mobile-*.test.ts(x)`: every screen (pairing, home, inbox, chat, remote with
  the Pause control, changes, session with polling and live modes, settings) and the logic
  modules (intent, including project names that contain "and"; change card, including the
  unknown ceiling and the service rate; change log, outbox, push, store);
  `mobile-upload.test.tsx` (nav link, cap shown, a renamed file signed as multipart to the
  chosen project with its bytes stored, a camera photo as kind photo, a file over the cap
  refused before a byte leaves, offline queued and sent once on reconnect even after a lost
  answer (with the harness's background poll off, so only the test's own flushes send), a queued file over the storage budget shown as held in memory only and still sent
  on reconnect); `mobile-reviews.test.tsx` (nav link, reviews of the project with PR link and
  findings, the waiting approval shown, a signed comment, approve with a comment answering the
  task's request at its version, a high-risk reject that asks the prompt first: cancel sends
  nothing, confirm signs `biometric=1`; a high-risk approval filed after the screen loaded
  still asks the prompt (the inbox is read afresh); a `biometric_required` answer for a request
  the phone could not see prompts and resends once, the refused post messaging nobody; the
  fake refuses a high-risk verdict without the flag);
  `mobile-voice.test.tsx` (hold to record and release to relay 16 kHz PCM signed as a
  `kind: "voice"` command, the PC's transcript and reply shown and the reply spoken, a press
  released at the 5 s limit, the typed line relayed where there is no recorder, a refused
  microphone switching to the typed line, a PC without voice reported, float to 16 kHz PCM);
  `mobile-store.test.ts` asserts the token and the key never reach state, storage or logs,
  that an auth loss keeps the queue until the next pairing, and that the monthly cap and
  the CHF rate come from `/me` and the project cards.
- `apps/ui/test/mobile-unlock.test.tsx` (spec S.12, ADR 0068): the phone's unlock card with
  the key from a secure store standing in for the Keystore: unlock once only after the
  biometric prompt (device-signed, biometric flag), the answer unwraps to the key and the key
  is in neither the DOM nor a call; a cancelled prompt sends nothing; the 24 h window set and
  persisted; clear sends null; deny; the auto-answer inside the phone's window (the prompt
  opens on its own), on the inbox and on the home screen; read-only in a browser and on a phone without the runner's key.
- `apps/ui/e2e/mobile-{pairing,inbox,remote}.spec.ts`: Playwright on a Pixel 7 viewport with
  the fake state service as a web server (real signature checks, simulated PC): pairing,
  approve, high risk needs the prompt, scenario 9 end to end with undo.
- `apps/mobile/src-tauri`: `cargo test` (dirs rules, config parsing and the pairing link,
  keystore round trip with a visible wrapper and the RFC vector, injection script without
  secrets, biometric outcomes, the ticket book, `Shell::sign` refusing a `biometric=1`
  string without the prompt's ticket and consuming it on use, the status and prompt
  mappings, `wait_bounded` ending a call that hangs or panics, the capability naming
  `biometric:allow-status` / `biometric:allow-authenticate` for the `main` window with the
  plugin and the command registered in `lib.rs`, push stand-in, the push status following the
  token the platform reports now); no workflow runs the mobile crate's `cargo test` (the
  Android job compiles the crate for the Android targets only);
- `apps/ui/test/mobile-push-token.test.ts` (ADR 0085): the shell's FCM token sent as
  `pushToken` at pairing, the field left out on the polling stand-in (and no PUT ever), a
  refreshed token sent with `PUT /devices/:id/push-token` signed by the device and not
  re-sent when unchanged, a token rotated while closed sent at the next launch, a vanished
  token sent as null, the foreground re-check on `visibilitychange` and on the shell's resume
  event, nothing while unpaired, a failed PUT retried; the first-launch token synced at the end
  of `pair` and by the one delayed retry (none on the stand-in, none after `close`), a pending
  Firebase build never clearing a token; `forgetDevice` clearing the token first (best effort)
  and `pendingLink`;
  the token in no console line, service log line, stored value, state or device view (only
  its fingerprint stored); `parsePushLink` refusals and the route opened on launch from a
  notification. `scripts/android-google-services.test.ts`: the secret written mode 0600 and
  checked (JSON, project id, the app's package) without printing it, nothing without it, the
  Gradle gating, no Firebase in the main source set or manifest, `fcmToken` in `info`, the
  gitignore entries and both workflows' steps. `scripts/android-insets.test.ts`: the activity
  pads `android.R.id.content` from system bars, cutout and keyboard through `SafeArea.padding`
  and consumes the insets; `SafeArea.kt` imports nothing from Android.
  `gen/android/app/src/test/.../PushLinksTest.kt` and `SafeAreaTest.kt` (status and navigation
  bar, a cutout taller than the bar, a landscape side cutout, the keyboard replacing the
  navigation bar, no insets) run in CI only (`android.yml`, `./gradlew :app:testX86_64DebugUnitTest
  -PforerunnerFcmCompileCheck=true`, which also compiles `src/fcm`);
  `cargo clippy -D warnings`, `cargo fmt --check`.
- `apps/mobile/e2e/run.mjs`: the emulator smoke (CI's Android job; skips visibly here, and
  every skip, the release-APK one included, fails under `FR_ANDROID_REQUIRE=1`). It attaches
  to the WebView over raw CDP on the page target (`e2e/cdp.mjs`, ADR 0054), not Playwright:
  the Android WebView refuses the browser-level commands `connectOverCDP` starts with.
  Steps: pairing by code, approve a request, high risk refused without the prompt, the R.5
  Reviews screen (the parser review's two findings, a signed comment and approve), the R.5
  Upload screen (the cap shown, Upload disabled without a file; picking a file needs
  `DOM.setFileInputFiles`, which the raw driver does not send, so the pick is covered by the
  jsdom tests only), scenario 9 with the change log's Undo, and the R.5 voice turn (the shell
  has no recorder, so Chat's "Say it" relays the typed line as a signed `kind: "voice"`
  command and the simulated PC's reply is shown). The R.5 steps have not run on an emulator
  yet (no Android SDK on the build box).
- `apps/mobile/e2e/cdp.test.ts` (unit project): the driver against a fake DevTools endpoint
  (`node:http` serving `/json/list` and `/json`, a `ws` server answering the page socket, a
  jsdom document with `data-box` layout boxes and `elementFromPoint` over them, real
  `requestAnimationFrame`, and a CSP stand-in whose `eval` and `Function` refuse): page-target
  selection (workers never, the preferred page over the first), socket URL on the forwarded
  port, id-correlated responses with events ignored, protocol errors, request timeout, close
  rejecting the pending requests, connect failure; `getByRole` (heading, button, link; name as
  substring, case-insensitive, `exact`, hidden excluded), chained scopes, innermost text
  match (the scope root included), `filter({ has })`, `first` / `nth`, `count`,
  `getAttribute`, `innerText`; `waitFor` timing out on an attached but hidden element,
  resolving only after it is unhidden, and timing out with the locator named; `click` as
  `mouseMoved` / `mousePressed` / `mouseReleased` at the box centre after `scrollIntoView`,
  landing on the second position when the box moves once after the scroll, strict-mode
  refusal, an intercepting overlay reported; the click guard (ADR 0087, android.yml run
  40000764444): a nav that moves down between the measurement and the press (the base's
  driver clicked Home there) gets the click on its retry and Home sees no event, a page that
  never settles ends in `cdp.click_missed` naming what was at the point with no click
  received, a click with no event in the page is `cdp.click_lost`, release events that
  arrive after the CDP answer still meet the guard after a missed press (one click on Inbox,
  none on Home), a click that replaced the document counts as landed; the settled click and
  the fallback ladder (ADR 0087 amendment, android.yml run 40013402240): a page that keeps
  growing and re-rendering after the click starts gets one press, after the last box change
  and the last DOM mutation; a stable box whose mouse events the fake delivers 30 px lower
  (and reports there through `clientX`/`clientY`) gets three guarded misses, then one click
  shifted back through the mouse path and a `click fallback:` line; the same misses with no
  offset to learn go to the `Input.dispatchTouchEvent` tap (lands, one line); a tap that
  misses too goes to `element.click()` in the page (two lines); a page whose
  `element.click()` raises nothing and a WebView that refuses the touch domain end in
  `cdp.click_missed` naming everything tried; `describePage` (URL,
  title, capped screen text) and `run.mjs`'s step order (Home's list before the nav click,
  each screen's heading after it, the page read before the cleanups); `evaluate` with the function source spliced into
  the expression (no `eval` call sent, the CSP stand-in in force), `cdp.bad_function` for a
  non-function; `fill` through `Input.insertText` after focus and select-all, the
  native-setter fallback with `input` and `change`, `not_editable`; `connectPage` waiting for
  the target and giving up with `cdp.no_page_target`; `describeFailure` (the runner's `FAIL:`
  line) keeping a `CdpError`'s code and details; `forwardPageConsole`
  (`webview-console.mjs`; the fake's `Runtime.enable` hooks the jsdom page's console the way
  Chrome reports it, except that Chrome also replays the messages it kept from before the
  enable and the fake does not): `webview: [level]` lines with the call site on the head line
  for warnings and errors, every line of a stack prefixed, RemoteObject shapes, uncaught
  exceptions and unhandled rejections with
  location and stack, `stop()`, a refused `Runtime.enable` as one line that never fails the
  smoke, and `run.mjs` turning it on between the attach and the smoke.
- `scripts/android-keystore.test.ts` and `scripts/android-apk-verify.test.ts` (`release.md`
  "Tests"): the Gradle signing config reads what the keystore script writes, the workflows
  verify the release APK with `apksigner` before uploading it.

```
pnpm --filter @forerunner/ui test -- test/mobile- test/state-
pnpm --filter @forerunner/ui exec playwright test e2e/mobile-
cd apps/mobile/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm exec vitest run --project unit apps/mobile/e2e
node apps/mobile/e2e/run.mjs
```

### Known issues

- The phone's screens run against the fake service's simulated PC in these tests; the PC's
  side of `kind: "plan"`, `"chat"` and `"voice"` is the daemon's `RemoteCommandWatcher`
  (`runtime.md`), tested on its own (`packages/runtime/test/remote-watcher.test.ts`,
  `voice-relay.test.ts`). The emulator run of the new screens (R.5) has not happened: no
  Android SDK or emulator on the build box (BLOCKERS.md, emulator row).
- The service's `/me` does not send the human's `monthlyCap` yet (`humans.monthly_cap_usd_micro`
  exists in the schema); the phone's card says "the current cap" and treats a monthly change
  as high risk until the route carries it (`MeView.monthlyCap` is already accepted).
- Settings → Devices on the desktop starts the pairing through the daemon
  (`POST /devices/pairing`, which needs `FORERUNNER_STATE_API_URL` and the service's admin
  token in the daemon's vault) and its QR encodes the same link `buildPairingLink` builds; the
  phone specs still start pairings from the fake's `/__test/pair`.
- The change log lives on the phone (per install); the service has no device-facing change
  log route, so the desktop's log and the phone's are joined only through the remote command
  rows and `undoOf`.
- Push is the polling stand-in until `GOOGLE_SERVICES_JSON_BASE64` is set and the state
  service has its service account (`docs/status/BLOCKERS.md`, Firebase row); until then notices
  appear only while the app is open. The FCM Kotlin (`src/fcm`, `MainActivity`'s intent
  rewrite, `KeystorePlugin.info`'s token) is compiled in CI but has run on no device yet; the
  first FCM build needs a manual check on a phone (token at pairing, a notification for each
  kind on its channel, the tap opening its route, a token rotated while the app was in the
  background sent on resume). That `tauri://resumed` reaches the page on every resume, and
  that `visibilitychange` does, are both unverified on a device; either one is enough.
- The emulator's WebView is too old for the app's stylesheet (ADR 0087): the API 30
  `aosp_atd` image ships a Chromium 83-class WebView with no Play Store to update it, and
  Tailwind v4 puts every rule in cascade layers (`@layer`, Chrome 99+), which Chromium 83
  drops. There the app renders unstyled: the bottom nav (`m-nav`) is `position: static`, in
  the flow under the screen's content, and moves when a list arrives; `#root` keeps
  `height: 100%` (a plain rule in `apps/ui/src/styles.css`, outside the layers), so it is
  viewport-tall while the unstyled content is shorter. `android.yml` run 40000764444
  (4ff4fb1) lost the "Inbox" click to that move (the click landed on Home, 0 `m-request`
  matches, nothing logged); with the click guard and the runner's wait for Home's list, run
  40013402240 (bc10bc8) printed `webview engine: ... Chrome/83.0.4103.120 Mobile` and then
  failed the same click as `cdp.click_missed`: for the whole 30 s every retry measured the
  same stable box, the in-page hit test found the nav item at (67, 453), and the dispatched
  events landed on bare `#root`, which exists only below the content. That is not the layout
  race of ADR 0087 but a disagreement between the WebView's input path and the page's own
  coordinates (the cause ADR 0086 suspected for scenario 3's Confirm, also below the first
  screen). The driver now waits for the layout to settle, measures and hit-tests in the same
  call as it arms the guard, and after three guarded misses at one unchanged box runs the
  fallback ladder of ADR 0087's amendment (a mouse click shifted by the offset the page
  reported, a tap, then `element.click()` in the page), each step a `click fallback:` line
  in the log; the next run's lines say which path the nav clicks took (dispatch pending).
  Still open: the layout itself on a pre-99 WebView (real phones update theirs through the
  Play Store). Either an emulator image with a current WebView in `android.yml`
  (`google_apis`, API 34) or a build step that flattens the layers for old WebViews.
- The raw CDP driver (`e2e/cdp.mjs`) met the real WebView in `android.yml` run 39952987240
  (82a6295): the attach, pairing by code (fills) and the approval (a click near the top of
  the inbox) passed; scenario 3 then saw no refusal on the high-risk card. ADR 0086 fixes
  the paths in the app that could leave the card without a refusal and makes the runner
  print the page's console; the cause of that run is not confirmed on a device (no emulator
  on the build box), so the next run's `webview:` lines decide between a biometric step that
  never settled (fixed) and a click that did not reach the scrolled-to Confirm button (the
  driver's assumption that `Input.dispatchMouseEvent` coordinates are the layout viewport's
  CSS pixels, untested below the fold: no "asking the biometric prompt" line would show it).
  Since ADR 0087 a click that lands on something else is stopped and retried, and one that
  keeps missing fails as `cdp.click_missed` naming what was at the point, so that second
  cause can no longer pass silently; since its amendment (2026-10-25) the driver no longer
  assumes that the input path's coordinates and the page's agree: the guard records where
  the page saw the misplaced event (`clientX`/`clientY`), then the shifted click, the tap
  and `element.click()` follow, and the `click fallback:` lines say which one landed (a
  "shifted by" line confirms a constant offset in the WebView's input path; an
  "element.click()" line means neither input path reaches that point on this image). The
  driver still assumes the page runs `requestAnimationFrame` and `MutationObserver` (the
  settle wait; a WebView that stalls frames ends in `cdp.click_unsettled`, named in the
  `FAIL:` line), and `Input.dispatchTouchEvent` is tried, never required (a refusal moves to
  the next step).
  The shell's `prompt()` / `platform_prompt()` compile only for Android and iOS; their first
  compile is that run.
- When the shell's `PROMPT_LIMIT` (45 s) runs out while the platform prompt is on screen, the
  phone has refused, but tauri-plugin-biometric 2.4.0's `BiometricActivity` stays up until
  the human dismisses it: the plugin has no cancel command (`status` and `authenticate`
  only), and the platform thread behind `wait_bounded` stays blocked in `run_mobile_plugin`
  until then. A touch after the bound confirms nothing (no ticket is issued for a late
  outcome); the human taps Confirm on the card again. Closing it needs a cancel in the plugin. The driver covers the
  calls `smoke()` makes and nothing more: no keyboard shortcuts, no frames, no screenshots
  (the tap exists only as a click's fallback, not as a step the smoke can ask for).
- The CI Android job builds twice: the release APK (signed from `keystore.properties`,
  verified by `scripts/android-apk-verify.mjs`, uploaded as the artefact) and then, inside
  `test:emulator`, a debug APK for the smoke (x86_64, a few minutes on top), because a release
  WebView has debugging off. Both are needed: the release build is the signature check,
  the debug one the smoke. Neither Gradle build has run on the build box (no Android SDK, no
  emulator, no KVM); the Kotlin plugin and the signing config compile against the
  `tauri-android` project the Tauri CLI generates, in the Android workflow.
- `test/fake-state-service.ts` imports the service's `auth/crypto.ts` by relative path; a
  workspace dependency on the service package would be cleaner once `apps/ui/package.json`
  may change.
- Push-to-talk in the Android shell relays the typed line: the shell has no microphone
  command and the WebView's permission request is not wired (ADR 0080); a browser on the
  phone (`/m`) records. The PC's reply is spoken by the phone's speech synthesis, not the
  PC's TTS audio (only text comes back in the command's result).
- Uploads use the web file input; the shell has no share target ("share to Forerunner")
  or native picker. A queued upload is persisted in browser storage up to 2 MiB in total; a
  larger queued file is held in memory and lost if the app closes before it is sent.
  Upload progress is by phase, not by byte.
