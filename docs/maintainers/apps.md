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
                         with their view schemas (queue, milestones, data, docs, performance)
    api/sse.ts           EventSource subscriptions with polling fallback; SseParser for fetch streams
    api/chat-stream.ts   streamChat(): POST /chat/stream tokens -> final reply
    store/store.ts       reducer + subscribe/getSnapshot (projects, active project, inbox count,
                         connection, kill state, theme, restart announcement, extensions version)
    store/context.tsx    AppProvider (bootstrap: /health, /me, /agents, /projects, /inbox, then
                         the /events stream), useClient, useUiState, useIdentity
    store/theme.ts       prefers-color-scheme + stored override -> data-theme
    lib/                 money (CHF formatting), time, format (bytes, ms, shares), storage,
                         use-async (data, error, routeMissing, errorStatus), task-transitions
    components/          ui.tsx (Button, Badge, SpendBar, Money, Loading, ErrorBanner, Field),
                         Dialog.tsx (native <dialog>), RouteMissing.tsx, charts.tsx (TrendLine,
                         TargetBar), ChangeCardDialog.tsx (ChangeCard, CommandResult)
    shell/               Shell.tsx (header, nav, switcher, kill switch, banners), CommandPalette,
                         commands.ts, shortcuts.ts (sequence matcher), ShortcutsHelp, ShellContext
    pages/               HomePage, NewProjectDialog, ProjectPage (+ project/*Tab, *Section,
                         NewTaskDialog, StartSessionDialog), SessionPage, InboxPage, MemoryPage,
                         ExtensionsPage, ChangesPage, PerformancePage, UpdatesPage, SettingsPage,
                         PlaceholderPages (NotFound only)
    mobile/              the phone screens (module R; its own doc section, not covered here)
  test/                  Vitest + Testing Library (jsdom); fixtures.ts, fake-daemon.ts, helpers.tsx
  e2e/                   Playwright specs against the fake daemon
```

### Routes

| Route | Page | Data |
| --- | --- | --- |
| `/` | Home: project cards (stage, next milestone, health, spend vs budget, waiting-on-you, latest critic grade), New project dialog | store (`GET /projects`), `POST /projects` |
| `/projects/:id/:tab?` | Project page; tabs `summary`, `plan`, `tasks`, `docs`, `reviews`, `costs`, `data`, `chat` (default `summary`); opening a project makes it active | `GET /projects/:id` and the tab routes below |
| `summary` tab | the cached one-screen summary with Read aloud; **Next session** (queue items by priority with type badges, add note/task/correction/idea with a priority, dismiss; consumed items collapsed); **Peers** (per agent: online, active claims with expiry, open PRs, last handoff done/in flight/blocked/next, files in flight); **Decisions** (question, chosen option, the others, rationale, who, supersedes) | `GET /projects/:id/summary`, `GET /projects/:id/queue`, `POST /projects/:id/queue`, `POST /queue/:id/dismiss` (proposed), `GET /projects/:id/peers`, `GET /projects/:id/decisions` |
| `plan` tab | milestone **timeline** (SVG: dated milestones on a time axis with today's tick, undated ones after), milestones with status, success criteria and their tasks, the task **dependency graph** (layered SVG, a task after everything it depends on); without a milestones route the timeline and the list are derived from the tasks and the card (the card's dated next milestone on the axis, the ids the tasks reference after it) behind a route-missing notice; today's tick comes from a `now` prop (wall clock by default, injected in tests); in **small-project mode** (spec B.6, the card's `smallProjectMode`) the tab shows instead the one milestone (the open one from the route, or the card's next milestone without it; milestones on file from before the mode are named, not hidden), the tasks as a **flat list** in the daemon's order with no grouping and no timeline, and the graph | `GET /projects/:id/tasks`, `GET /projects/:id/milestones` (proposed) |
| `tasks` tab | task log table with filters, transitions with a reason, New task dialog (its risk tier offers "project default (tier N)" from the card's `defaultRiskTier` and sends no `riskTier` unless one is picked, so the daemon applies the project's default: 0 in small-project mode, B.6) | `GET /projects/:id/tasks`, `/runs`, `POST /projects/:id/tasks`, `POST /tasks/:id/transition` |
| `docs` tab | the standard doc set with present/missing/drift state, size and date; a document opens in a reader | `GET /projects/:id/docs`, `GET /projects/:id/docs/:path` (proposed) |
| `reviews` tab | counts (reviews, open findings, average grade, verdicts), the grade trend chart with the accept line, every review newest first (grade, verdict, tier, confidence, model, task, session link, summary, evidence, findings with severity and status), verdict filter | `GET /projects/:id/reviews` |
| `costs` tab | totals, by model / specialist / task with accepted share and cost per accepted task, savings apart | `GET /costs?projectId=` |
| `data` tab | registered datasets (name, kind, size, locator, sample, who), register by path or URI, remove (two clicks), import from zip/folder/repo with the result | `GET /projects/:id/data`, `POST /projects/:id/data`, `DELETE /data/:id`, `POST /projects/:id/import` (proposed) |
| `chat` tab | quick chat with streaming, read-back confirmation, make-this-a-task | `POST /chat/stream` |
| `/sessions/:id` | Live session view: header (status, agent, current task + specialist, steps/stepCap, spent/cap bar, Stop), event stream with level chips, raw JSON toggle, follow/auto-scroll | `GET /sessions/:id`, `GET /sessions/:id/events` (JSON backlog, then SSE), `POST /sessions/:id/stop` |
| `/inbox` | Requests (blocking first, newest first) with option buttons and a free-text answer, messages with read marking; reloads when the install stream reports a blocking count the page has not seen | `GET /inbox?humanId=`, `POST /requests/:id/answer`, `POST /messages/:id/read` |
| `/memory` | one view per principal agent (the human's own first, then the peers' as listed-but-not-readable), the critic, shared lessons, each with active and pinned counts; search (debounced); per lesson: pin, tags, confidence, uses, last used, source, project, file; edit text and tags, delete (two clicks); consolidation proposals with merged/contradictions/retired and "Run now" (its own route-missing notice, under the Consolidation heading, when the daemon lacks the consolidation routes) | `GET /memory/scopes`, `GET /memory?scope=&agentId=&q=`, `PUT /memory/lessons/:id`, `POST /memory/lessons/:id/pin`, `DELETE /memory/lessons/:id`, `GET /memory/consolidation`, `POST /memory/consolidation/run` |
| `/extensions` | grouped by kind (connectors and MCP servers, skills, specialists, capabilities, model providers): name, version, status, connected, cost, description, permissions summary with the full list behind details; On/Off switch; Remove (two clicks); pending rows show the review (stage, risk, summary, tools, requested permissions) with Approve/Deny; Add dialog: catalog with search and kind filter, or an MCP server URL; reloads on every `extension.changed` frame | `GET /extensions`, `GET /extensions/catalog`, `POST /extensions` (201 or 202), `POST /extensions/:id/toggle`, `/approve`, `/deny`, `DELETE /extensions/:id` |
| `/changes` | the change log newest first: source, scope, project, undo state, who asked and when, the sentence, the words used, revert time, commands / before / after behind details, Undo while undoable; project filter and "undoable only" | `GET /changes?projectId=&undoable=`, `POST /changes/:id/undo` |
| `/performance` | per mode: target (first token / first audio / total / by task), samples, first-token p50/p95, total p50/p95, within-target share, a bar of the p95 against the target (met/missed in words); recent runs; estimate accuracy (overall and per specialist and kind); project filter; "Audit log" with a format select (JSON lines / CSV) and **Export audit log** (spec S.9): fetches the daemon's file through `client.auditExport`, saves it under the daemon's name with `saveTextFile` (`src/lib/download.ts`: a Blob behind an object URL on a hidden anchor, clicked once) and reports `Exported N rows to <file>`; says so when the browser cannot save files or the daemon lacks the route, pointing at `fr audit export` | `GET /performance?projectId=` (proposed), `GET /costs/estimates`, `GET /audit/export?format=` |
| `/updates` | app: running and installed version, channel, state, the available release with changelog, size and "Update and restart", previous version with "Roll back and restart", last rollback, rejected releases, last error; connector updates (installed vs available); model updates; model watch: latest report with recommendations to adopt/ignore/remind, "Run now", recent reports. Asks the feed first and falls back to the local state with a banner | `GET /updates`, `GET /updates/status`, `POST /updates/apply`, `POST /updates/rollback`, `GET /model-watch/reports`, `/latest`, `POST /model-watch/run`, `POST /model-watch/reports/:id/answer` |
| `/settings` | theme override, daemon connection status (with links to Updates and Extensions), every setting grouped by scope with the scope badge; rows that map to a command have Change: a dialog with the current value, the change card from the daemon, Yes/No (a tap; a high-risk card asks this paired device), the sentence with Undo, a link to Changes; other rows say read-only | `GET /settings`, `POST /commands/execute`, `POST /commands/:id/confirm`, `POST /changes/:id/undo` |

### API client

`createClient(config, fetchImpl?)` returns a `DaemonClient` with one method per entry of
`DAEMON_ROUTES` (phase-1 routes, decisions, peers, project settings and the mirror, estimates,
extensions, updates, model watch, reviews, memory and consolidation, commands and the change
log) plus the proposed routes (`queue`, `enqueue`, `dismissQueueItem`, `milestones`,
`dataAssets`, `registerDataAsset`, `removeDataAsset`, `importProject`, `docs`, `doc`,
`performance`), `auditExport(filter?)` (spec S.9: `GET /audit/export` with `agentId`, `sessionId`,
`from`, `to` and `format`; the body as text with the row count and the base name from
`Content-Disposition`, `filenameFromDisposition` / `countExportRows`) and `url()` / `raw()`
for the stream helpers. Paths come from `routePath(name,
params)` over `DAEMON_ROUTES` or `proposedPath(name, params)` over `PROPOSED_ROUTES` (which
follows the daemon's entry as soon as one exists), URL-encoded; the client sends
`Authorization: Bearer <token>` and validates every JSON body with the contract's zod schema.
Failures are `ApiError { code, status, details }`: the daemon's `ErrorBody.code` when it sent
one, else `ui.network`, `ui.http_error`, `ui.invalid_response`, `ui.aborted`.
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

The settings screen is a client of the command registry (spec Q.1, ADR 0037):
`commandForSetting(row)` maps `project.autonomy` to `autonomy.set`, `project.budget` and
`human.monthly_cap` to `budget.set`, and the keys of `SETTING_SPECS` to `settings.set`; the
dialog posts `executeCommands({ commands: [one], wordsUsed: "Settings: <key> to <value>",
source: "ui" })` (the change log row reads `ui`, where chat and voice read theirs),
shows the daemon's card through `CommandResult`, answers `needs_yes` with `{ answer: "tap" }`
and `needs_device` with `{ answer: "device", deviceId: <installId> }` (the daemon checks the
device), and shows the sentence with Undo (`POST /changes/:id/undo`). `ChangeCard` renders the
spec Q.4 card (what, old → new, scope, duration, impact, undo hint, the parts of a plan) from
the daemon's `card` through `parseChangeCard` (lenient: unknown fields kept, missing ones
defaulted).

### Realtime and streaming

`subscribeDaemonEvents(client, humanId, handlers)` and `subscribeSessionEvents(client,
sessionId, handlers, { afterSeq })` open an `EventSource` on `/events` or
`/sessions/:id/events` with the token as `?token=` (EventSource cannot send headers, ADR
0025). Events are parsed with `parseDaemonEvent` (`session.event`, `inbox.changed`,
`session.changed`, `project.changed`, `extension.changed`, `restart.requested`, `heartbeat`;
unknown or malformed frames are dropped). `extension.changed` bumps `extensionsVersion` in the
store so the Extensions panel reloads; `restart.requested` sets `restart` (the shell shows a
banner on every page) until a heartbeat arrives from a daemon on the target version. When
`EventSource` is missing (jsdom) or closes, the helper polls every 5 s and retries SSE every
30 s; `onMode` reports `connecting | sse | polling | closed`. Chat uses `streamChat()` over
`POST /chat/stream`: `token` frames build the reply as they arrive, the `reply` frame finishes
it, `error` frames become `ApiError`; a plain JSON `ChatReplyView` is accepted as well.

### State

`createStore(config, storage)` holds `UiState` (`connection`, `me`, `agents`, `projects`,
`activeProjectId`, `blockingCount`, `killActive`, `theme`, `restart`, `extensionsVersion`);
React reads it with `useUiState(selector)` over `useSyncExternalStore` (selectors must return
stable values). `activeProject` and `theme` persist in `localStorage` under
`forerunner.ui.<installId>.<name>` (`lib/storage.ts`, wrapped in try/catch; `memoryStorage()`
in tests). Page data stays in the page through `useAsync(loader, deps)` (`data`, `error`,
`routeMissing`, `errorStatus`, `loading`, `reload`, `setData`), which aborts stale loads.

### Money

`lib/money.ts` formats `chfMicro` as "CHF 12.34" (half-up, ties away from zero, Swiss `'`
grouping) and never prints USD except in `moneyTooltip`. `SpendBar` shows spent vs cap with the
percentage and colours at 80 % and 100 %. CHF inputs convert with `chfMicroToUsdMicro(chf,
referenceMoney)` at the rate implied by a Money pair (default 0.80, ADR 0008). A setting whose
value is a Money pair renders as CHF.

### Charts

`components/charts.tsx` draws the two charts in SVG without a library: `TrendLine` (one series,
2 px line, 8 px markers with a hover title, a dashed reference line, recessive grid, text in
the text tokens, "No data yet" when empty) for the grade trend, and `TargetBar` (one thin bar
for the measured p95, a tick for the target, emerald/red only for met/missed and always with
the word beside it; blue when there is no target) for the Performance view. Both follow
`data-theme` for dark mode; the numbers always stand in a table next to the chart.

### Shell, palette, shortcuts, theme

The header always shows the active project (button opens a switcher listing every project and
"+ New project"), the nav (Home, Inbox with the blocking badge, Memory, Extensions, Changes,
Performance, Updates, Settings; collapses behind a menu button under 768 px), the connection
badge, the palette button and the kill switch (`POST /kill {scope:"all"}`; the button then
reads "Resume" and posts `/kill/resume`), plus the kill banner and the restart banner.
`Ctrl/Cmd+K` opens the palette (`shell/commands.ts` builds navigation, "Switch project: …", New
project, Stop all/Resume, theme and shortcuts commands; `filterCommands` matches every word).
Shortcuts (`shell/shortcuts.ts`): `g h` Home, `g i` Inbox, `g s` Settings, `g p` active
project, `g m` Memory, `g e` Extensions, `g c` Changes, `g t` Performance, `g u` Updates, `?`
help, `Escape` closes; sequences are ignored inside text fields, chords with a modifier are
not. Theme: `system | light | dark`, resolved to `<html data-theme>` and `color-scheme`;
`styles.css` binds Tailwind's `dark:` variant to that attribute with `@custom-variant`.

### Fake daemon

`test/fake-daemon.ts` exports `createFakeDaemon(options)` (a Hono app over `test/fixtures.ts`
with mutable state: projects, tasks, sessions, events, requests, messages, kill flag, pending
chat confirmation, extensions, the daemon version, model watch reports, reviews, lessons,
consolidation proposals, the change log, pending commands, the queue, data assets; decisions,
the peer feed, milestones, docs and performance are served read-only) and
`startFakeDaemon({ port })` (`@hono/node-server` on 127.0.0.1). Its `/health` answer is the
`HEALTH` fixture with the extension counts derived from the extension state (3 enabled, 1
pending with the fixtures). It requires the bearer token on every route (and accepts `?token=`
on the two SSE routes), answers CORS, records every POST/PUT/DELETE at `GET /__test/calls`,
resets at `POST /__test/reset`, can push an event with `POST /__test/emit`, can hide routes
(`missingRoutes` option or `POST /__test/missing`: a path and its children answer a typed 404
"no route"; the real daemon registers no `notFound` handler and answers Hono's plain-text 404,
which `isRouteMissing` reads the same way) and can fail exact routes with a status and body
(`failing` option or `POST /__test/fail`). `POST /sessions` starts a scripted run (six events
including a warning and an escalation, `eventDelayMs` apart, then `completed`);
`/chat/stream` streams word tokens and scripts a read-back confirmation when the text contains
"start a session", answered by "yes"/"no". The extension routes file a `capability_grant`
request in the inbox for pending installs (answering it approves or denies), widen permissions
into `pending_approval`, and emit `extension.changed`; `POST /updates/apply` emits
`restart.requested` and bumps the version `/health` reports; the command routes mirror the
daemon (one card and one change log row per request, low risk acts, medium needs a yes or a
tap, high needs `{ answer: "device" }`, `confirm: "tap"` runs a medium change at once, the
`SOURCE_OF` mapping `text → chat`, `voice → voice`, `phone → chat`, `ui → ui`, undo rows). Run directly
(`pnpm exec tsx test/fake-daemon.ts`) it reads `FAKE_DAEMON_PORT`, `FAKE_DAEMON_TOKEN` and
`FAKE_DAEMON_EVENT_DELAY_MS`.

### What the Tauri shells inject

Before the bundle runs, a shell may set `window.__FORERUNNER__ = { daemonUrl, daemonToken,
installId, platform, shellVersion }` (type `ShellInjection` in `api/config.ts`). The desktop
shell reads `daemon.json` from the runtime directory (ADR 0011) and injects the URL and token
through an origin-guarded initialization script (see "Desktop shell" below); `installId`
namespaces the two persisted conveniences and is the device id the settings screen offers for
a high-risk confirmation; `platform` and `shellVersion` show in Settings. The Android shell
does not reach the daemon directly (spec R): it injects `stateUrl` and mounts `src/mobile`.
The desktop CSP (`apps/desktop/src-tauri/tauri.conf.json`) already allows
`http://127.0.0.1:*`.

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
  malformed-body rejection in `test/client.test.ts`. A route the daemon does not serve yet goes
  into `PROPOSED_ROUTES` with its schema in `contracts.ts` and `proposedPath`; when the daemon
  gains it, `test/contracts.test.ts` fails until the proposal is removed and the page uses the
  daemon's shape.
- **Mirror a runtime schema** the browser cannot import: copy it into `contracts.ts`, add the
  fixture to the two-sided parse in `test/contracts.test.ts`.
- **A new command from a screen**: build the body for `executeCommands`, show the result with
  `CommandResult` and confirm through `confirmCommand`; never bypass the card.
- **A new setting the UI can change**: extend `commandForSetting` in `SettingsPage.tsx` (and
  `SETTING_KEYS` when `SETTING_SPECS` in `@forerunner/commands` gains a key) and the fake's
  `SETTING_RISK`.
- **Links that look like buttons**: use `buttonClassName(variant)` from `components/ui.tsx` on
  the `<Link>`; never put a `<Button>` inside a link (invalid HTML, double tab stop).
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
contract validation rejects malformed bodies, `/health` with its sandbox and extensions
sections, decisions and peers, phase-1 mutations, a missing route vs a typed not_found incl.
the real daemon's plain-text and empty-body 404, round trips for reviews / memory / commands /
the change log, the proposed routes, extensions / updates / model watch), `contracts`
(two-sided parse of the extension, updates and estimate fixtures with key-set comparison,
proposed routes vs `DAEMON_ROUTES`, `parseChangeCard`), `money`, `sse` (parser, every event
name incl. `extension.changed` and `restart.requested`, EventSource path, polling fallback,
chat stream), `store` (persistence, restart, extensions version), `app`, `home`, `project`
(summary, derived milestones fallback, costs, every tab filled), `project-tabs` (graph layout
incl. a cut cycle, timeline positions, timeline and graph render, the timeline and derived
milestones when the route is missing, today's tick from an injected `now`, docs with drift
and a reader, data register / remove / import, queue add / dismiss, peers, decisions, solo
project and missing queue route, cost per accepted), `small-project` (B.6: the flat Plan tab
list with the one milestone from the route or, without it, the card, milestones from before
the mode named, a small project without a milestone yet, the grouped tab unchanged with the
flag off; the dialog's "project default (tier N)" option from the card, no `riskTier` in the
posted body unless picked and the picked one sent, a card without the field naming no number),
`reviews` (tones, trend, newest first,
findings, verdict filter, missing route), `tasks`, `session`, `inbox`, `chat`, `memory` (view
order, pinned first, search, critic and shared views, a peer's agent not readable, edit / pin
/ delete, consolidation, missing memory routes with both notices, missing consolidation route
alone), `extensions` (permission summary, every kind with status and
review, toggle and remove, add from the catalog then approve, add from a URL then deny, reload
on `extension.changed`), `updates` (states, available release with changelog, apply with the
restart banner, rollback, model watch adopt and run, feed failure fallback), `performance`
(formatting, target comparison, every mode with the bar, estimates, missing route),
`audit-export` (the client's filename parsing and row counting, the fetch with the token and
the filters in both formats against the fake daemon, 401 without a token; the button downloads
the daemon's file in the chosen format and reports the count, says so when the browser cannot
save and names the missing route), `download` (`saveTextFile`: the Blob's type and size, the
anchor's `download` name clicked once and removed, the URL revoked later, false without object
URLs),
`changes` (rows with words / commands / before / after, undo and the undo row, filters,
missing route), `settings` (scope on every row, command mapping, autonomy by one step: card →
yes → sentence → undo → the change log row, high risk needs this device, cancel and refusal),
`shell` (matcher, palette filter, g-sequences incl. `g c` / `g t` / `g u`, switcher, kill
switch, persistence).

Playwright (`e2e/*.spec.ts`, one worker, 6-minute global budget): home shows two projects and
connects; kill switch; nav collapse under 768 px; project tabs, task transition, plan timeline
and graph, costs, reviews; Start session dialog and the live view over real SSE; Stop; inbox
answer flow; chat confirmation and make-this-a-task; palette and shortcuts; extensions add →
approve → toggle and deny; updates apply with the restart banner arriving over SSE and the
new version after reload, model watch adopt; reviews list and filter; memory edit → pin →
delete and the not-readable peer view; summary queue / peers / decisions, data register and
import, docs reader; performance targets; a settings change → card → yes → change log → undo.
`playwright.config.ts` picks free ports and random tokens once and pins them in
`FORERUNNER_UI_FAKE_PORT`, `FORERUNNER_UI_PORT`, `FORERUNNER_UI_FAKE_TOKEN` (and the fake
state service's for the phone specs) so worker processes agree; the CI desktop workflow runs
`pnpm --filter @forerunner/ui test:ui` after `playwright install chromium`.

## Known issues

- The UI has so far only been run against the fake daemon. The first run against the real
  one should confirm the shapes end to end and goes into `docs/status/gates.md`.
- The real daemon registers no `notFound` handler (`packages/runtime/src/daemon/server.ts`),
  so a route it lacks answers Hono's plain-text 404 while the fake answers a typed
  `not_found` "no route" body. `isRouteMissing` accepts both (untyped 404/405/501, or a typed
  one saying "no route"), so the pages degrade the same way against either; an `app.notFound`
  in `server.ts` matching the fake would make the two identical and belongs to the daemon.
- Proposed routes the daemon does not serve yet (the pages show "route not available" until
  it does): `GET/POST /projects/:id/queue`, `POST /queue/:id/dismiss`,
  `GET /projects/:id/milestones` (the Plan tab derives the timeline and the milestones
  meanwhile), `GET/POST /projects/:id/data`, `DELETE /data/:id`, `POST /projects/:id/import`,
  `GET /projects/:id/docs[/:path]`, `GET /performance`. Shapes are in `contracts.ts` and the
  fixtures.
- The settings screen's changes are logged with source `ui` (`POST /commands/execute` with
  `source: "ui"`), but the Changes screen's undo (`POST /changes/:id/undo`, no body) is still
  logged as `chat` by the daemon; a `source` on that route and on `undoChange` would close it.
- A high-risk confirmation from the desktop sends `installId` as the device id; the daemon
  accepts it only once the desktop registers as a device (ADR 0030, item 3). Until then the
  dialog shows the daemon's refusal as such.
- The daemon's `GET /memory/scopes` lists the human's own principals only; the peers' agents
  come from `GET /agents` and show the daemon's answer (403 or an empty list).
- Permissions are shown, approved and denied; narrowing or widening them from the panel
  (`PUT /extensions/:id/permissions`) has a client method but no control yet.
- Connector updates are listed; applying one is remove-and-add in the Extensions panel.
- The Inbox reloads on a changed blocking count only; a non-blocking request answered
  elsewhere shows up on Refresh or with the next blocking change.
- `Read aloud` uses the browser's Web Speech API; WebKitGTK (Linux Tauri) may expose no voices,
  in which case the button is disabled with a tooltip saying so.
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
                      resume, probe_email(), email toggle, update_and_restart(),
                      watch_external_restart() for a daemon the shell did not start
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
`daemon.json` that is fresh and answers `/health` (60 s budget; the child exiting first is a
failure). Fresh (`daemon::is_fresh`) means a different `pid` or `startedAt` than the file on
disk before the spawn (else the last file attached to; any file when there was none). The pid
the shell spawned is accepted too but never required: `node …/tsx/dist/cli.mjs` runs the CLI
in a child node process and `fr.cmd` runs under `cmd.exe`, so the daemon records a grandchild
pid. Failures end in a native dialog with the log path; the tray stays and "Open" tries
again. The daemon is never killed by the shell.

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
tooltips; a test reads `emailRouteTable()`'s source so a route rename fails it); Update and
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
  case to the tests; document it in ADR 0031's list.
- **Another way to find `fr`**: add a step to `install::locate_fr` (keep the order of ADR 0026)
  with a `FakeFs` test.
- **The restart budget**: `restart::MAX_RESTARTS`, `STABLE_AFTER_SECS` and
  `decide_after_exit`; the tests enumerate every branch. The "gone" rule for a daemon the
  shell did not start is `restart::external_daemon_gone` and `MISSES_WITHOUT_REQUEST`; a
  test in `actions` pins that the misses fit the 90 s budget.
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
the full fixture table per platform, home fallback, app name); `daemon` (the file
`startDaemon` writes, missing/bad JSON/bad shape, off-machine URL refused, stale pid, attach vs
start, freshness as a changed file, a grandchild pid written after the spawn attaches, daemon
error bodies, client `Debug` hides the token); `install` (install dir → node argv, Windows
`node.exe` and `.cmd` shims, fall-through to PATH, the tried list, `install.json` parsing and
reading, staged version first); `restart` (file parsing, exit-code matching, one restart then
give up, rollback's extra relaunch, crash/stop, file round trip, the external "gone" rule per
signal, the external exit code); `actions` (email paths against the route table's source,
the external watch budget); `inject` (every field, JSON escaping, dev origin added once,
`Debug` hides the token); `sse` (frames across chunks and CRLF, bytes split inside a
character, invalid bytes, the line cap, comments, blank frames, notification validation and
truncation, restart/inbox/heartbeat/unknown); `deeplink` (documented links, rejections,
safe routes, navigate script, navigation policy); `window_state` (monitor check, minimum size,
file round trip); `state` (tray view for unreachable, kill/resume, email availability and
toggle, busy, when a restart announcement starts the external watch, `Debug` hides the
token); `supervisor` (log path, spawn failure logged); `events` (reconnect backoff);
`secret`; `env`; `lib` (install id persisted, 0600). The Tauri glue (window building, tray
wiring, dialogs) is exercised by `tauri dev` and the CI build, not by unit tests. Last run
2026-10-20 on Linux: `cargo fmt --check` clean, `cargo clippy --all-targets -- -D warnings`
clean, `cargo test` 68 passed, 0 failed.

### Known issues

- The daemon does not emit `notification` events yet (the notification module of phase 5);
  the shell parses and shows them as soon as it does.
- The daemon does not mount the email routes of `packages/capabilities/src/email/routes.ts`
  yet, so the tray's email item reads "Pause email (not available: the daemon has no email
  routes yet)" until the wiring lands.
- A click on an OS notification does not open the window (the notification plugin reports no
  click on desktop); the `route` field is parsed for that day.
- Windows-only code (`creation_flags`, `node.exe`, `.cmd` shims, `http://tauri.localhost`)
  compiles by reasoning only: no Windows machine was available; the desktop CI workflow builds
  it on `windows-latest`.
- Linux tray needs an AppIndicator host (GNOME needs the AppIndicator extension); without one
  the icon is invisible but the window and the daemon work.
- The first run against the real daemon end to end (attach, restart, deep link) is not yet
  recorded in `docs/status/gates.md`.
- `.github/workflows/desktop.yml` only runs `tauri build`; the three Rust checks above
  (`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, each with
  `working-directory: apps/desktop/src-tauri`) still have to be added before the build step
  on both matrix OSes so the Windows fixture cases run in CI. The workflow is outside the
  desktop item's paths; the orchestrator owns `.github/`.
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
| Inbox | requests blocking first (then newest), each with kind, project, "Blocks work" / "Does not block", "High risk" badge, why it matters, context (steps), option buttons or a free-text field; answer posts `{ version, answer }`; `409` shows "changed on another device" with Reload; answered requests leave the list and are not asked again (the service lists open ones; the runtime records the decision, spec J.4); messages with Mark read; reloads on `human_request.changed` / `message.changed` and on polls | `GET /inbox?humanId=`, `POST /requests/:id/answer`, `POST /confirm/challenge`, `POST /messages/:id/receipt` |
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

## Android app (`apps/mobile` and `apps/ui/src/mobile`)

### Purpose

The phone client of spec module R (ADR 0009, ADR 0024, ADR 0026, ADR 0032): the same React
bundle as the desktop, mounted under `/m`, wrapped by a thin Tauri 2 Android shell. The phone
never talks to a PC's daemon. It pairs with the shared state service, reads its projects and
inbox, answers requests (high risk with the platform biometric prompt), relays quick chat and
natural-language control to the PC as remote commands, and shows the change log with Undo.
Heavy work stays on the PC or the cloud runner (R.8).

Requirements covered: R.1 (Tauri 2 Android target sharing the UI; the release APK signed by
Gradle with the keystore `scripts/android-keystore.mjs` prepares and verified by
`scripts/android-apk-verify.mjs` in CI, see `release.md` "Signing"; Play track and update
channel pending), R.2 (pairing by QR /
`fr://` deep link / typed code; own key; forget here, revoke on the desktop), R.3 (state
service client, live SSE with polling fallback, offline outbox flushed on reconnect), R.4
(start / pause / stop / kill as remote commands with `target: "pc"`; the live session log
screen), R.5 partial (quick chat as a remote command, natural-language control, notes to the
next-session queue, answering requests; uploads, PR and critic review come later), R.6 partial
(in-app notices for approvals, sessions, budget warnings and messages with quiet hours; FCM is
a documented stand-in), R.7 (biometric assertion inside the signed string for high-risk
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
                     remote commands (RemotePlanEnvelope / RemoteChatEnvelope, verbForPlan), sessions,
                     devices, /sync/outbox; every mutation signed, biometric flag only from an assertion
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
  pairing.ts         fr://pair?u=&c=&h=, web link, qr JSON, bare code; buildPairingLink
  push.ts            PushPort, PollingPush (the stand-in), quiet hours, noticeFor(feed event)
  storage.ts         per-install localStorage keys, SecureStore (shell | browser | memory)
  shell-bridge.ts    invoke wrappers: shell_info, device_key_*, secure_store_*, assert_biometric,
                     push_status, barcode scan, deep links
  screens/           Pairing, Home, Inbox, Chat, Remote, Changes, Settings, Session (live log)
apps/mobile/
  package.json       tauri CLI scripts; test:emulator -> e2e/run.mjs
  e2e/run.mjs        emulator run (build, boot, install, fake service, CDP smoke); README.md has the
                     adb / gradle commands by hand
  e2e/cdp.mjs        raw CDP client and DOM driver for the smoke (ADR 0054): /json/list, page socket,
                     Runtime.evaluate queries, Input.* clicks and fills; cdp.test.ts against a fake endpoint
  src-tauri/
    Cargo.toml, tauri.conf.json (no static window; deep-link scheme "fr"; CSP allows 127.0.0.1 and 10.0.2.2)
    capabilities/default.json (core, deep-link, log), mobile.json (biometric, barcode-scanner; Android/iOS only)
    src/lib.rs         run(): plugins, KeystorePlugin registration (Android), Shell state, injection
                       script, deep links, the window
    src/commands.rs    the invoke commands, Shell (secure files, config, info, push), build_shell,
                       the Android KeystoreWrapper over the Kotlin plugin
    src/keystore.rs    DeviceKey (ed25519-dalek; Debug redacts), Wrapper trait, SecureFiles (0600,
                       atomic writes), SESSION_TOKEN_KEY
    src/biometric.rs   BiometricOutcome; asserted() only after the platform prompt succeeded
    src/config.rs      <config>/mobile.json (state_url, device_name, install_id), recover(), the
                       fr://pair link parser
    src/dirs.rs        app_dirs(): mirror of packages/platform/src/paths.ts appDirs()
    src/push.rs        PushPort: PollingPush (shipped) and FcmPush (seam), configured(token)
    gen/android/app/build.gradle.kts
                       the Tauri-generated Gradle module (kept after `android init`), plus the release
                       signing config read from gen/android/keystore.properties when the file exists
    gen/android/app/src/main/java/app/forerunner/mobile/KeystorePlugin.kt
                       AES-256-GCM key in the Android Keystore (StrongBox when present) that wraps the
                       seed and the token; info (model, strongBox, biometric, fcmToken when FCM exists)
```

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

**Push.** FCM is not configured (no Firebase project; `docs/status/BLOCKERS.md`). `push.rs`
and `push.ts` keep one port; the shipped mode is `polling`: the change feed raises in-app
notices for approvals, finished sessions, budget warnings and messages, suppressed inside
quiet hours. The FCM wiring is listed in ADR 0032 item 6.

### How to change it

- **A new screen**: `src/mobile/screens/XScreen.tsx`, a `<Route>` in `MobileRoutes`, a nav
  entry in `NAV` when it belongs in the bottom bar, a `test/mobile-x.test.tsx` that mounts
  it through `renderMobile` in `test/mobile-helpers.tsx` against the in-process fake, and a
  Playwright spec when it is a flow.
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
- **Turn on FCM**: follow ADR 0032 item 6; `configured(token)` in `push.rs` already picks
  `FcmPush` when the Kotlin `info` command returns `fcmToken`.
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
  ticket is no assertion.
- `apps/ui/test/state-sse.test.ts`: frame parsing, live stream with heartbeats, per-human
  filtering, polling and offline fallback, session log polling.
- `apps/ui/test/mobile-*.test.ts(x)`: every screen (pairing, home, inbox, chat, remote with
  the Pause control, changes, session with polling and live modes, settings) and the logic
  modules (intent, including project names that contain "and"; change card, including the
  unknown ceiling and the service rate; change log, outbox, push, store);
  `mobile-store.test.ts` asserts the token and the key never reach state, storage or logs,
  that an auth loss keeps the queue until the next pairing, and that the monthly cap and
  the CHF rate come from `/me` and the project cards.
- `apps/ui/e2e/mobile-{pairing,inbox,remote}.spec.ts`: Playwright on a Pixel 7 viewport with
  the fake state service as a web server (real signature checks, simulated PC): pairing,
  approve, high risk needs the prompt, scenario 9 end to end with undo.
- `apps/mobile/src-tauri`: `cargo test` (dirs rules, config parsing and the pairing link,
  keystore round trip with a visible wrapper and the RFC vector, injection script without
  secrets, biometric outcomes, the ticket book, `Shell::sign` refusing a `biometric=1`
  string without the prompt's ticket and consuming it on use, push stand-in);
  `cargo clippy -D warnings`, `cargo fmt --check`.
- `apps/mobile/e2e/run.mjs`: the emulator smoke (CI's Android job; skips visibly here, and
  every skip, the release-APK one included, fails under `FR_ANDROID_REQUIRE=1`). It attaches
  to the WebView over raw CDP on the page target (`e2e/cdp.mjs`, ADR 0054), not Playwright:
  the Android WebView refuses the browser-level commands `connectOverCDP` starts with.
- `apps/mobile/e2e/cdp.test.ts` (unit project): the driver against a fake DevTools endpoint
  (`node:http` serving `/json/list` and `/json`, a `ws` server answering the page socket, a
  jsdom document with `data-box` layout boxes and `elementFromPoint` over them): page-target
  selection (workers never, the preferred page over the first), socket URL on the forwarded
  port, id-correlated responses with events ignored, protocol errors, request timeout, close
  rejecting the pending requests, connect failure; `getByRole` (heading, button, link; name as
  substring, case-insensitive, `exact`, hidden excluded), chained scopes, innermost text
  match (the scope root included), `filter({ has })`, `first` / `nth`, `count`,
  `getAttribute`, `innerText`; `waitFor` resolving when the element becomes visible and
  timing out with the locator named; `click` as `mouseMoved` / `mousePressed` /
  `mouseReleased` at the box centre after `scrollIntoView`, strict-mode refusal, an
  intercepting overlay reported; `fill` through `Input.insertText` after focus and select-all,
  the native-setter fallback with `input` and `change`, `not_editable`; `connectPage` waiting
  for the target and giving up with `cdp.no_page_target`.
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

- The PC's daemon does not consume `target: "pc"` remote commands with `kind: "plan"` or
  `kind: "chat"` yet; scenario 9 passes against the fake service's simulated PC only. The
  runtime side needs a watcher like the cloud runner's `RemoteCommandWatcher` that runs the
  plan through the command registry (ADR 0030) and posts a human request for high-risk steps;
  `docs/status/BLOCKERS.md` carries the work item, and no gate row claims the phone gate
  until it lands.
- The service's `/me` does not send the human's `monthlyCap` yet (`humans.monthly_cap_usd_micro`
  exists in the schema); the phone's card says "the current cap" and treats a monthly change
  as high risk until the route carries it (`MeView.monthlyCap` is already accepted).
- The desktop has no "Settings → Devices → Add a phone" screen yet, so pairing starts with
  `POST /pairing/start` (admin) by hand or from the fake's `/__test/pair`; the QR should
  encode `buildPairingLink(serviceUrl, code, humanId)`.
- The change log lives on the phone (per install); the service has no device-facing change
  log route, so the desktop's log and the phone's are joined only through the remote command
  rows and `undoOf`.
- Push is the polling stand-in (`docs/status/BLOCKERS.md`, Firebase row); notices appear only
  while the app is open.
- The raw CDP driver (`e2e/cdp.mjs`) has run against the fake endpoint and jsdom only; its
  first run against the WebView is the next `android.yml` dispatch (BLOCKERS.md, emulator
  row). Two assumptions it makes about the WebView are untested here: `Input.insertText`
  commits like an IME (otherwise `fill` falls back to the native value setter and says so
  through the value check), and `Input.dispatchMouseEvent` coordinates are the layout
  viewport's CSS pixels (what `getBoundingClientRect` returns; the bundle's viewport meta is
  `width=device-width, initial-scale=1`, so no page scale applies). The driver covers the
  calls `smoke()` makes and nothing more: no keyboard shortcuts, no touch events, no frames,
  no screenshots.
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
- Voice on the phone (spec R.5, module O) is the phase 5 voice work; the Chat screen is text
  only and says so.
