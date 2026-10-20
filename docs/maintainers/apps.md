# Apps

The one React UI (`apps/ui`) that the Tauri desktop shell (`apps/desktop`, Windows and Linux)
and the Android shell (`apps/mobile`) wrap, plus the approvals web fallback
(`apps/approvals-web`, still a skeleton). This file covers the UI; the shells only inject the
daemon address (see "What the shells inject").

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
shell reads `daemon.json` from the runtime directory (ADR 0011) and injects the URL and token;
`installId` namespaces the two persisted conveniences; `platform` and `shellVersion` show in
Settings. The Android shell does not reach the daemon directly (spec R): it will inject the
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
- Desktop notifications and the tray menu (K.8) are shell features for a later phase.
- The nested `apps/ui/biome.json` exists only because the root config disables Biome's Tailwind
  CSS syntax; if the root enables `css.parser.tailwindDirectives`, delete the nested file.
