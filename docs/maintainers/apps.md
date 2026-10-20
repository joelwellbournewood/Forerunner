# Apps

The one React UI (`apps/ui`) that the Tauri desktop shell (`apps/desktop`, Windows and Linux)
and the Android shell (`apps/mobile`) wrap, plus the approvals web fallback
(`apps/approvals-web`, still a skeleton). The first part of this file covers the UI; the
"Desktop shell" section at the end covers `apps/desktop` (lifecycle, injection, tray,
notifications, restart, deep links).

## Purpose

Phase-1 screens of spec module K against the local daemon API (ADR 0011, ADR 0025): Home,
Project page with tabs, Live session view, Inbox, Settings, Memory and Extensions placeholders,
plus the shell with the active project, kill switch, inbox badge, command palette, keyboard
shortcuts and dark mode. Quick chat per project with streaming replies, read-back
confirmations and "make this a task" (module J, partial). The UI never touches the database:
everything goes through the daemon client, every response is validated with the zod schemas
from `packages/runtime/src/daemon/api-types.ts`, and money is shown in CHF only.

Requirements covered (phase-1 clauses; see `docs/requirements.md`): K.1 (home cards), K.2
(project tabs: Summary, Plan without timeline/graph, Tasks/log, Costs, Chat; Docs, Reviews and
Data as placeholders naming their phase), K.3 (live session view), K.4 (inbox, blocking first),
K.7 (settings with scope on every row, read-only), K.8 partial (command palette, shortcuts,
dark mode, active project in the header; notifications, tray and Android come later), J.1
partial (quick chat, streaming, make-this-a-task; voice comes with module O), J.3 partial
(requests with options and blocking flag), D.18 (replies stream; progress states are never a
silent spinner), D.19 partial (time to first token shown against the 1 s target in chat).

## How it works

### Structure

```
apps/ui/
  index.html, vite.config.ts, vitest.config.ts, playwright.config.ts, biome.json (nested:
  enables Biome's Tailwind CSS parser for this app only)
  src/
    main.tsx, App.tsx (client + store from the globals, BrowserRouter), routes.tsx (AppRoutes)
    styles.css           Tailwind 4; dark variant bound to <html data-theme="dark">
    api/config.ts        DaemonConfig resolution (shell injection > Vite env > default)
    api/client.ts        createClient(): typed fetch client over DAEMON_ROUTES (phase-1 routes,
                         decisions, peers; the rest is listed under Known issues)
    api/sse.ts           EventSource subscriptions with polling fallback; SseParser for fetch streams
    api/chat-stream.ts   streamChat(): POST /chat/stream tokens -> final reply
    store/store.ts       reducer + subscribe/getSnapshot (projects, active project, inbox count,
                         connection, kill state, theme); persistence of two keys per install
    store/context.tsx    AppProvider (bootstrap: /health, /me, /agents, /projects, /inbox, then
                         the /events stream), useClient, useUiState, useIdentity
    store/theme.ts       prefers-color-scheme + stored override -> data-theme
    lib/                 money (CHF formatting), time, storage, use-async, task-transitions
    components/          ui.tsx (Button, Badge, SpendBar, Money, Loading, ErrorBanner,
                         Placeholder, Field), Dialog.tsx (native <dialog>)
    shell/               Shell.tsx (header, nav, switcher, kill switch, banners), CommandPalette,
                         commands.ts, shortcuts.ts (sequence matcher), ShortcutsHelp, ShellContext
    pages/               HomePage, NewProjectDialog, ProjectPage (+ project/*Tab, NewTaskDialog,
                         StartSessionDialog), SessionPage, InboxPage, SettingsPage, PlaceholderPages
  test/                  Vitest + Testing Library (jsdom); fixtures.ts, fake-daemon.ts, helpers.tsx
  e2e/                   Playwright specs against the fake daemon
```

### Routes

| Route | Page | Data |
| --- | --- | --- |
| `/` | Home: project cards (stage, next milestone, health, spend vs budget, waiting-on-you, latest critic grade), New project dialog | store (`GET /projects`), `POST /projects` |
| `/projects/:id/:tab?` | Project page; tabs `summary`, `plan`, `tasks`, `docs`, `reviews`, `costs`, `data`, `chat` (default `summary`); opening a project makes it active | `GET /projects/:id`, `/summary`, `/tasks`, `/runs`, `GET /costs?projectId=`, `POST /projects/:id/tasks`, `POST /tasks/:id/transition`, `POST /sessions`, `POST /chat/stream` |
| `/sessions/:id` | Live session view: header (status, agent, current task + specialist, steps/stepCap, spent/cap bar, Stop), event stream with level chips, raw JSON toggle, follow/auto-scroll | `GET /sessions/:id`, `GET /sessions/:id/events` (JSON backlog, then SSE), `POST /sessions/:id/stop` |
| `/inbox` | Requests (blocking first, newest first) with option buttons and a free-text answer, messages with read marking; reloads itself when the install stream reports a blocking count the page has not seen (an answer given on another device) | `GET /inbox?humanId=`, `POST /requests/:id/answer`, `POST /messages/:id/read` |
| `/settings` | Theme override, daemon connection status (version, profile, platform, uptime, state URL, vault, sessions, sandbox kind and engine, extensions enabled and pending), every setting grouped by scope with the scope badge on each row ("edit via chat" hint) | `GET /settings`, `GET /health` from the store |
| `/memory`, `/extensions` | Placeholders naming phase 4 and phase 6 | none |

Placeholders render `<Placeholder phase={n}>` so the phase is visible in the UI
(`data-testid="placeholder" data-phase="n"`); the Plan tab's timeline/dependency-graph area says
"coming with phase 5" and derives milestones from the card's `nextMilestone` plus the tasks'
`milestoneId`s until a milestones route exists.

### API client

`createClient(config, fetchImpl?)` returns a `DaemonClient` with one method per phase-1 route
(`health, me, agents, projects, createProject, project, projectSummary, tasks, createTask,
transitionTask, runs, decisions, peers, sessions, startSession, session, sessionEvents,
stopSession, kill, resume, inbox, answerRequest, markRead, chat, costs, settings`) plus `url()`
and `raw()` for the stream helpers. `decisions` (`DecisionView[]`) and `peers` (`PeerFeedView`)
have no page yet; they are there so the project page can show them in phase 2 without touching
the client. Routes the table gained after phase 1 (estimates, project settings, mirror,
extensions, updates, model watch) have no method yet; see Known issues. Paths come from `routePath(name, params)` over `DAEMON_ROUTES`, URL-encoded; the
client sends `Authorization: Bearer <token>` and validates every JSON body with the contract's
zod schema. Failures are `ApiError { code, status, details }`: the daemon's `ErrorBody.code`
when it sent one, else `ui.network`, `ui.http_error`, `ui.invalid_response`, `ui.aborted`.
`describeError()` turns one into a banner line without leaking the token. Types the contract
exports only as schemas (`HumanView`, `AgentView`, `SettingView`, request bodies) are derived in
`client.ts` with `z.infer`.

Config (`api/config.ts`): `window.__FORERUNNER__` from the shell, else
`import.meta.env.VITE_DAEMON_URL/_TOKEN`, else `http://127.0.0.1:8787` with no token; the Shell
shows a "Not connected" banner until `/health` answers. The import is
`@forerunner/runtime/daemon/api-types` (browser-safe); never import the runtime package index
from the UI.

### Realtime and streaming

`subscribeDaemonEvents(client, humanId, handlers)` and `subscribeSessionEvents(client,
sessionId, handlers, { afterSeq })` open an `EventSource` on `/events` or
`/sessions/:id/events` with the token as `?token=` (EventSource cannot send headers, ADR
0025). Events are parsed with `parseDaemonEvent` (`session.event`, `inbox.changed`,
`session.changed`, `project.changed`, `heartbeat`; unknown or malformed frames are dropped).
When `EventSource` is missing (jsdom) or closes, the helper polls every 5 s and retries SSE
every 30 s; `onMode` reports `connecting | sse | polling | closed` and the session header shows
"live" or "polling every 5 s". Chat uses `streamChat()` over `POST /chat/stream`: `token`
frames build the reply as they arrive, the `reply` frame finishes it, `error` frames become
`ApiError`; a plain JSON `ChatReplyView` is accepted as well.

### State

`createStore(config, storage)` holds `UiState` (`connection`, `me`, `agents`, `projects`,
`activeProjectId`, `blockingCount`, `killActive`, `theme`); React reads it with
`useUiState(selector)` over `useSyncExternalStore` (selectors must return stable values: the
state itself, a primitive, or a memoised object). `activeProject` and `theme` persist in
`localStorage` under `forerunner.ui.<installId>.<name>` (`lib/storage.ts`, wrapped in try/catch;
`memoryStorage()` in tests). Page data (tasks, events, inbox, costs) stays in the page through
`useAsync(loader, deps)` which aborts stale loads.

### Money

`lib/money.ts` formats `chfMicro` as "CHF 12.34" (half-up, ties away from zero, Swiss `'`
grouping) and never prints USD except in `moneyTooltip`. `SpendBar` shows spent vs cap with the
percentage and colours at 80 % and 100 %. CHF inputs convert with `chfMicroToUsdMicro(chf,
referenceMoney)` at the rate implied by a Money pair (default 0.80, ADR 0008).

### Shell, palette, shortcuts, theme

The header always shows the active project (button opens a switcher listing every project and
"+ New project"), the nav (Home, Inbox with the blocking badge, Memory, Extensions, Settings;
collapses behind a menu button under 768 px), the connection badge, the palette button and the
kill switch (`POST /kill {scope:"all"}`; the button then reads "Resume" and posts
`/kill/resume`). `Ctrl/Cmd+K` opens the palette (`shell/commands.ts` builds navigation,
"Switch project: …", New project, Stop all/Resume, theme and shortcuts commands;
`filterCommands` matches every word). Shortcuts (`shell/shortcuts.ts`): `g h` Home, `g i` Inbox,
`g s` Settings, `g p` active project, `g m` Memory, `g e` Extensions, `?` help, `Escape` closes;
sequences are ignored inside text fields, chords with a modifier are not. Theme: `system |
light | dark`, resolved to `<html data-theme>` and `color-scheme`; `styles.css` binds Tailwind's
`dark:` variant to that attribute with `@custom-variant`.

### Fake daemon

`test/fake-daemon.ts` exports `createFakeDaemon(options)` (a Hono app over `test/fixtures.ts`
with mutable state: projects, tasks, sessions, events, requests, messages, kill flag, pending chat
confirmation; decisions and the peer feed are served read-only from `DECISIONS` and `PEERS`) and
`startFakeDaemon({ port })` (`@hono/node-server` on 127.0.0.1). Its `/health` answer is the
`HEALTH` fixture, which must carry every field of `HealthView`, `sandbox` (the process stand-in,
no engine) and `extensions` included: when the contract gains a field, this fixture is the first
thing that fails (`pnpm typecheck`), before every page test does. It requires
the bearer token on every route (and accepts `?token=` on the two SSE routes), answers CORS,
records every POST at `GET /__test/calls`, resets at `POST /__test/reset`, and can push an event
with `POST /__test/emit`. `POST /sessions` starts a scripted run (six events including a warning
and an escalation, `eventDelayMs` apart, then `completed`); `/chat/stream` streams word tokens
and scripts a read-back confirmation when the text contains "start a session", answered by
"yes"/"no". Run directly (`pnpm exec tsx test/fake-daemon.ts`) it reads `FAKE_DAEMON_PORT`,
`FAKE_DAEMON_TOKEN` and `FAKE_DAEMON_EVENT_DELAY_MS`.

### What the Tauri shells inject

Before the bundle runs, a shell may set `window.__FORERUNNER__ = { daemonUrl, daemonToken,
installId, platform, shellVersion }` (type `ShellInjection` in `api/config.ts`). The desktop
shell reads `daemon.json` from the runtime directory (ADR 0011) and injects the URL and token
through an origin-guarded initialization script (see "Desktop shell" below); `installId`
namespaces the two persisted conveniences; `platform` and `shellVersion` show in Settings. The Android shell does not reach the daemon directly (spec R): it will inject the
state-service relay address instead once phase 5 lands; the same `DaemonConfig` shape applies.
The desktop CSP (`apps/desktop/src-tauri/tauri.conf.json`) already allows
`http://127.0.0.1:*`.

## How to change it

- **Add a page**: create `src/pages/XPage.tsx`, add a `<Route>` in `src/routes.tsx`, a nav entry
  in `shell/Shell.tsx` (`NAV`) if it belongs in the header, a palette command in
  `shell/commands.ts` and, if it gets a shortcut, an entry in `shell/shortcuts.ts` (`SHORTCUTS`)
  and a case in the Shell's key handler. Load data with `useAsync` and the client; render
  `<Loading what=…>` while waiting and `<ErrorBanner>` on failure. Add a unit test in `test/`
  (render with `renderApp(route)` from `test/helpers.tsx`) and, for a user flow, a spec in
  `e2e/`.
- **Add a route to the client**: the contract changes first (`api-types.ts`, ADR); then add the
  method to `DaemonClient` in `api/client.ts` using `routePath` and the schema, the fixture in
  `test/fixtures.ts`, the handler in `test/fake-daemon.ts`, a round-trip assertion plus a
  malformed-body rejection in `test/client.test.ts`, and the method name in the list above.
- **Links that look like buttons**: use `buttonClassName(variant)` from `components/ui.tsx` on
  the `<Link>`; never put a `<Button>` inside a link (invalid HTML, double tab stop).
- **Fill a placeholder tab** (Docs phase 4, Reviews phase 3, Data phase 5, Plan graph phase 5,
  Memory phase 4, Extensions phase 6): replace the `<PlaceholderTab>` / `<Placeholder>` in
  `ProjectPage.tsx` or `PlaceholderPages.tsx`; the tests that assert `data-phase` must change
  with it.
- **Change money display**: `lib/money.ts` and its test; keep USD out of any visible string.
- **Change the dark-mode binding**: `styles.css` (`@custom-variant dark`) and `store/theme.ts`.
- **Task transition buttons**: `lib/task-transitions.ts` mirrors `packages/state/src/workflow.ts`;
  `test/tasks.test.tsx` fails when they drift.
- **Lint for this app** runs under `apps/ui/biome.json` (extends the root, enables
  `css.parser.tailwindDirectives`); keep every other rule from the root.

## Tests

```
cd apps/ui && pnpm typecheck      # tsc over src, test, e2e and the configs
cd apps/ui && pnpm test           # Vitest + Testing Library, jsdom, fake daemon in-process
cd apps/ui && pnpm test:ui        # Playwright, headless Chromium, fake daemon + Vite on free ports
```

Unit tests (`test/*.test.ts[x]`): `client` (config resolution, route paths, token header,
contract validation rejects malformed bodies, `/health` with its sandbox and extensions sections
and rejection of a health body without them, decisions and peers round trips with malformed
bodies rejected, error mapping, mutation round trips), `money`,
`sse` (parser, event validation, EventSource path, polling fallback without repeats, chat
stream incl. error frames), `store`, `app` (shell with no daemon), `home` (cards from fixtures,
header, badge, Open is a link and not a button nested in one, New project dialog, not-connected
state), `project` (summary + Read aloud
disabled without speech, plan milestones and phase-5 TODO, costs, placeholders, Start session
dialog with CHF conversion then the live view), `tasks` (transition mirror vs. state, filters,
links, legal transition buttons posting version + reason, New task dialog), `session`
(escalations highlighted, filters, raw toggle, stop, polling fallback visible), `inbox`
(blocking first, option answer, free text, reload when the store's blocking count changes behind
the page's back, mark read), `chat` (streaming, pending confirmation
Yes/No sends "yes"/"no", make-this-a-task draft), `settings` (scope on every row, daemon
status incl. sandbox and extensions, placeholders name their phase), `shell` (shortcut matcher, palette filter and project
switch, g-sequences, header switcher, kill switch, persistence).

Playwright (`e2e/*.spec.ts`, one worker, 2-minute global budget, ~25 s): home shows two
projects and connects; kill switch; nav collapse under 768 px; open project → tasks tab lists
tasks and filters; task transition with reason; plan/costs/reviews placeholders; Start session
dialog posts and the live view fills over real SSE ("live" badge, escalation row, steps, spend,
completed); Stop; inbox answer flow (blocking first, option posted with version, free text, mark
read); chat confirmation flow and make-this-a-task; command palette switches project and the
choice survives a reload; keyboard shortcuts and the theme override. `playwright.config.ts`
picks two free ports and a random token once and pins them in `FORERUNNER_UI_FAKE_PORT`,
`FORERUNNER_UI_PORT`, `FORERUNNER_UI_FAKE_TOKEN` so worker processes agree; the CI desktop
workflow runs `pnpm --filter @forerunner/ui test:ui` after `playwright install chromium`
(see `.github/workflows/desktop.yml`; the Linux runner needs the Playwright system packages).

## Known issues

- The daemon server exists (`packages/runtime/src/daemon/server.ts`, started by `fr daemon`,
  ADR 0026) and implements the ADR 0025 conventions (CORS, `?token=` on the two SSE routes,
  `token`/`reply`/`error` chat frames, `killActive`), but the UI has so far only been run against
  the fake daemon. The first run against the real one should confirm the open shapes of ADR 0025
  item 5 and the SSE frames end to end, and that run goes into `docs/status/gates.md`.
- Routes in `DAEMON_ROUTES` without a client method or fake-daemon handler: `costEstimates`,
  `updateProjectSettings`, `mirrorSync`, `extensions`, `extensionCatalog`, `extension`,
  `addExtension`, `toggleExtension`, `approveExtension`, `denyExtension`, `extensionPermissions`,
  `removeExtension`, `updates`, `updatesStatus`, `applyUpdate`, `rollbackUpdate`,
  `modelWatchReports`, `modelWatchLatest`, `modelWatchReport`, `modelWatchRun`,
  `modelWatchAnswer`, `modelWatchSync`. They arrive with the screens that need them (project
  settings and mirror with phase 2, Extensions phase 6, updates and model watch phase 7),
  each the way "Add a route to the client" describes. ADR 0025 item 9 ("serving every route")
  reads as every route the client has.
- The Inbox reloads on a changed blocking count only; a non-blocking request answered elsewhere
  shows up on Refresh or with the next blocking change (the `inbox.changed` frame carries only
  the count).
- No milestones route: the Plan tab derives milestones from tasks and the card.
- `Read aloud` uses the browser's Web Speech API; WebKitGTK (Linux Tauri) may expose no voices,
  in which case the button is disabled with a tooltip saying so.
- The project page tab bar scrolls horizontally on narrow screens; a proper mobile layout for
  the Tasks table (cards instead of a table) comes with the Android work in phase 5.
- Desktop notifications and the tray menu (K.8) live in the desktop shell (next section); the
  UI itself raises no OS notification.
- The nested `apps/ui/biome.json` exists only because the root config disables Biome's Tailwind
  CSS syntax; if the root enables `css.parser.tailwindDirectives`, delete the nested file.

## Desktop shell (`apps/desktop`)

### Purpose

The Tauri 2 shell for Windows and Linux that attaches the shared UI to the local daemon
(ADR 0026, ADR 0034): it resolves the app directories exactly as `appDirs()` does, reads
`<runtime>/daemon.json`, checks `/health`, starts `fr daemon` when nothing healthy is there,
injects the daemon address and token into the webview before the UI loads, keeps a tray with
the kill switch, "pause email", "Update and restart" and Quit, shows OS notifications for the
daemon's `notification` events, applies the restart contract, remembers the window and handles
`fr://` deep links. No TypeScript: `apps/desktop/package.json` only runs the Tauri CLI; the UI
comes from `apps/ui/dist`.

Requirements covered: K.8 (desktop notifications, tray menu; dark mode is the UI's), S.8 (kill
switch from the tray), S.28 (one-click "pause email" in the tray), M.3 and M.4 ("Update and
restart" and the relaunch after the staged install's health check or rollback). The Android
client (R) is `apps/mobile`, not this shell.

### How it works

```
apps/desktop/src-tauri/
  Cargo.toml, build.rs, tauri.conf.json (no static window; deep-link scheme "fr"), capabilities/default.json
  src/
    lib.rs            run(): directories, log plugin, plugins (single-instance, notification, dialog,
                      deep-link, opener), the frshell:// splash protocol, setup (install id, tray,
                      deep links, bootstrap), close-to-tray, "never exit while only the tray is left"
    main.rs           calls run(); windows_subsystem = "windows" in release
    env.rs            Env trait (ProcessEnv; MapEnv fixture in tests)
    dirs.rs           app_dirs(): mirror of packages/platform/src/paths.ts appDirs()
    secret.rs         Secret (Debug/Display print "[redacted]"), redact()
    daemon.rs         daemon.json parsing, /health parsing, precheck/decide, DaemonClient (reqwest)
    install.rs        locate_fr(): staged version, FORERUNNER_INSTALL_DIR, install.json, PATH -> argv
    supervisor.rs     spawn_daemon() (argv, detached, log file), wait_for_daemon(), watch_exit()
    restart.rs        restart.json parsing, decide_after_exit() (the restart budget)
    inject.rs         initialization_script(): origin-guarded window.__FORERUNNER__
    sse.rs            SseParser (mirror of apps/ui/src/api/sse.ts), typed daemon events
    deeplink.rs       fr:// -> UI route, is_safe_route(), navigate_script(), navigation policy
    window_state.rs   <config>/window-state.json, placement() against the monitors
    state.rs          ShellState (shared), tray_view(): what the tray shows, derived from facts
    actions.rs        bootstrap() attach-or-start, attached(), handle_daemon_exit(), kill switch,
                      resume, probe_email(), email toggle, update_and_restart()
    events.rs         the Rust /events subscription and the 10 s /health monitor
    tray.rs           tray icon, menu items, refresh() from tray_view, menu dispatch
    windows.rs        main window (build/rebuild with the injection), splash, deep-link navigation
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
stale file; otherwise `GET /health` with a 1.5 s timeout. Healthy → attach. Else, when starting
is allowed, show the splash window (served by the shell's own `frshell://` protocol, no
scripts), locate `fr` (`install::locate_fr`), spawn it with an argv array (`… daemon`),
detached (own process group on Unix, `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` on
Windows), stdout and stderr appended to `<logs>/daemon-shell.log`, then poll every 250 ms for a
`daemon.json` with the child's pid that answers `/health` (60 s budget; the child exiting
first is a failure). Failures end in a native dialog with the log path; the tray stays and
"Open" tries again. The daemon is never killed by the shell.

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
where `<id>` is `/me`'s `agent.id`; enabled only after `GET /agents/<id>/email` answered 200,
disabled with the reason in its text otherwise, since menu items have no tooltips); Update and
restart (confirm dialog → `POST /updates/apply {}`; 202 expected); Quit (the daemon keeps
running). The icon tooltip reads "Forerunner <version> — N running sessions[, M waiting on
you][; kill switch active][; email paused]". Left-click opens the window. Closing the window
hides it; the shell keeps running in the tray (`RunEvent::ExitRequested` without a code is
prevented).

**Notifications (`events.rs`).** The shell holds its own `GET /events` (reqwest, bearer
header, 60 s read timeout, backoff 1→15 s) and shows an OS notification (notification plugin)
for every `notification` event: `{ title, body?, level?, route? }`, title required, truncated
at 200/1000 characters, `route` kept only when `is_safe_route` accepts it. Quiet hours are the
daemon's: the shell shows what it receives. `inbox.changed` updates the tooltip,
`restart.requested` marks the next exit as expected. The `/health` monitor (10 s) refreshes
the tray; after three misses the daemon counts as unreachable and, when the daemon was not
the shell's own process and no restart is expected, the shell looks for a new `daemon.json`
without starting one.

**Restart (`restart.rs`, `actions::handle_daemon_exit`).** When the daemon the shell started
exits: read `<runtime>/restart.json`; the exit matches the request when it equals the file's
`exitCode` (86 and 75 when absent). `decide_after_exit(code, request, consecutive)`:
Restart (first time; or second time when the request says `rollback`), GiveUp (dialog with
the log path), Crashed (any other non-zero code or a signal; dialog), Stopped (code 0; no
dialog). The restart counter resets once the daemon has been healthy for 30 s. On Restart the
request file is removed, the splash says "Restarting…", the shell waits 3 s for a user service
to bring a fresh `daemon.json`, else runs `bootstrap` again; `locate_fr` prefers the version
`<data>/versions/current.json` names when its directory is a runnable install. For a daemon
the shell did not start, "Update and restart" watches `/health` until it fails and then applies
the same path with the request's exit code.

**Deep links (`deeplink.rs`).** Scheme `fr`, registered by the bundler on Windows and Linux
(`tauri.conf.json` → `plugins.deep-link.desktop.schemes`) and at start with `register_all()`
(AppImage, dev); the single-instance plugin forwards a second launch to the running shell.
`fr://open` or `fr://` → `/`, `fr://inbox`, `fr://projects/<id>[/<tab>]`, `fr://sessions/<id>`,
`fr://settings`, `fr://memory`, `fr://extensions`; query and fragment dropped; segment
characters `A-Z a-z 0-9 . _ ~ -`. The UI is navigated with `history.pushState` + `popstate`
(`navigate_script`), which `BrowserRouter` follows. Unknown links only bring the window up.

**Window and theme.** `<config>/window-state.json` (`x, y, width, height, maximized`) is
written when the window closes to the tray, on Quit and at most every 2 s while it moves or
resizes; on build the size is lifted to the 900×600 minimum and the position is applied only
when it still lands on a connected monitor. Dark mode is the UI's toggle (ADR 0025): the shell
sets no theme and the webview follows the OS until the UI's stored override says otherwise.

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
  case to the tests; document it in ADR 0034's list.
- **Another way to find `fr`**: add a step to `install::locate_fr` (keep the order of ADR 0026)
  with a `FakeFs` test.
- **The restart budget**: `restart::MAX_RESTARTS`, `STABLE_AFTER_SECS` and
  `decide_after_exit`; the tests enumerate every branch.

### Tests

```
cd apps/desktop/src-tauri && cargo fmt --check
cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings
cd apps/desktop/src-tauri && cargo test            # unit tests, no daemon, no network
cd apps/desktop/src-tauri && cargo check           # Linux here; Windows in CI (desktop.yml)
```

Unit tests live next to the code (`#[cfg(test)]`): `dirs` (override on every platform,
relative `FORERUNNER_HOME`, empty override ignored, the Windows/XDG cases of `paths.test.ts`,
the full fixture table per platform, home fallback, app name); `daemon` (the file
`startDaemon` writes, missing/bad JSON/bad shape, off-machine URL refused, stale pid, attach vs
start, freshness, daemon error bodies, client `Debug` hides the token); `install` (install dir
→ node argv, Windows `node.exe` and `.cmd` shims, fall-through to PATH, the tried list,
`install.json` parsing and reading, staged version first); `restart` (file parsing, exit-code
matching, one restart then give up, rollback's extra relaunch, crash/stop, file round trip);
`inject` (every field, JSON escaping, dev origin added once, `Debug` hides the token); `sse`
(frames across chunks and CRLF, comments, blank frames, notification validation and
truncation, restart/inbox/heartbeat/unknown); `deeplink` (documented links, rejections,
safe routes, navigate script, navigation policy); `window_state` (monitor check, minimum size,
file round trip); `state` (tray view for unreachable, kill/resume, email availability and
toggle, busy, `Debug` hides the token); `supervisor` (log path, spawn failure logged);
`secret`; `env`; `lib` (install id persisted, 0600). The Tauri glue (window building, tray
wiring, dialogs) is exercised by `tauri dev` and the CI build, not by unit tests.

### Known issues

- The daemon does not emit `notification` events yet (the notification module of phase 5);
  the shell parses and shows them as soon as it does.
- The daemon does not mount the email routes of `packages/capabilities/src/email/routes.ts`
  yet, so the tray's email item reads "Pause email (not available: the daemon has no email
  routes yet)" until the wiring lands.
- `fr setup` does not write `<config>/install.json` yet; `FORERUNNER_INSTALL_DIR` and `PATH`
  are the working sources today.
- A click on an OS notification does not open the window (the notification plugin reports no
  click on desktop); the `route` field is parsed for that day.
- Windows-only code (`creation_flags`, `node.exe`, `.cmd` shims, `http://tauri.localhost`)
  compiles by reasoning only: no Windows machine was available; the desktop CI workflow builds
  it on `windows-latest`.
- Linux tray needs an AppIndicator host (GNOME needs the AppIndicator extension); without one
  the icon is invisible but the window and the daemon work.
- The first run against the real daemon end to end (attach, restart, deep link) is not yet
  recorded in `docs/status/gates.md`.

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
| Header (Shell) | active project always shown (`<select>`, remembered per tab; defaults to the stored choice, else a blocked project, else the first), Inbox with the blocking badge, Chat, feed badge (live / polling / connecting), kill switch (confirm dialog → `kill {scope:"all"}` to `pc`, and `cloud` when it runs sessions; pick-up and outcome shown), Sign out | `GET /projects`, `GET /devices`, `GET /sessions?status=running,paused`, `GET /remote/commands`, `POST /remote/commands`, `GET /remote/commands/:id`, `GET /events` |
| Inbox | requests blocking first (then newest), each with kind, project, "Blocks work" / "Does not block", "High risk" badge, why it matters, context (steps), option buttons or a free-text field; answer posts `{ version, answer }`; `409` shows "changed on another device" with Reload; answered requests leave the list and are not asked again (the service lists open ones; the runtime records the decision, spec J.4); messages with Mark read; reloads on `human_request.changed` / `message.changed` and on polls | `GET /inbox?humanId=`, `POST /requests/:id/answer`, `POST /confirm/challenge`, `POST /messages/:id/receipt` |
| Chat | read-only quick chat for the active project relayed as `chat` remote command; the reply arrives through the command's result (`{ reply }`); "answering…", "not picked up yet", failures in plain words; disabled with the reason when the link has no `write:remote`, when no PC is online, or when there is no project | `POST /remote/commands`, `GET /remote/commands/:id` |

Presence (`lib/presence.ts`): a PC counts as online when a `desktop` device was seen within
five minutes, a session runs or pauses on the `pc` runner, or a runner touched a remote
command within five minutes; cloud sessions set `cloudActive` for the kill switch. Refreshed on
`device.changed`, `session.changed`, `remote_command.changed` and every poll.

### Tests

```
cd apps/approvals-web && pnpm typecheck   # tsc over src and test
cd apps/approvals-web && pnpm test        # Vitest, jsdom, fake state service on 127.0.0.1
```

Testing Library and Hono are not among this app's dependencies, so `test/harness.tsx` mounts
the page with `react-dom/client`, drives it with `act()` and a `waitFor`, and
`test/fake-state-service.ts` is a `node:http` server: pairing codes, hashed tokens, Ed25519
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
| `chat.test.tsx` | relay as `chat` command with project and text, reply shown, disabled without a PC (and enabled when a session appears), disabled without `write:remote`, service without chat, failed answer |
| `shell.test.tsx` | active project shown and remembered, kill switch confirm/cancel/confirm → command with `scope: all`, outcome shown, disabled without scope or PC |

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
- `REMOTE_COMMANDS` in the service has no `chat`, and the daemon consumes no remote commands
  yet, so chat and the kill switch only complete against the fake; against the real service
  chat shows "does not relay chat yet" and kill stays "pending" (ADR 0034 items 5 and 6).
- Nothing issues the link yet (no daemon route or Settings button calls `POST /pairing/start`
  with `kind: "web"`), and the daemon does not register as a `desktop` device, so presence
  relies on sessions and command pick-ups.
- The service does not serve `dist/` yet; build with `pnpm --filter @forerunner/approvals-web
  build` and mount the folder (relative asset paths).
- Ed25519 in WebCrypto needs a current browser (Chrome 137+, Firefox 130+, Safari 17+); older
  ones get a plain message at sign-in.
