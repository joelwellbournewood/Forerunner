# Desktop control

> Status: built and wired (phase 6). The gate, the Linux and Windows adapters, the indicator
> port, the controller, six `ToolSpec`s, the allowlist store and the routes are in
> `packages/capabilities/src/desktop/` (exported as the `desktop` namespace of
> `@forerunner/capabilities`); the daemon composes them (`runtime.md` "Desktop control",
> ADR 0039). The shells render the `desktop.indicator` frame on `/events` (ADR 0067): a banner
> above every page of the app and a tray state in the desktop shell.
> This file covers the module; ADR 0021 records the adapter choices.

## Purpose

Spec module L ("Desktop control: off by default. Per-app allowlist. Screenshots logged. Always
requires autonomy 3+"), the security section "Browser and desktop control" ("Desktop control
is off by default, needs autonomy 3+, an app allowlist, and shows a visible on-screen
indicator while active"), the platform table ("Desktop control: UI Automation API | X11 full
support; Wayland limited to what the portal allows"), "Rules that apply everywhere" (content
is data, capability tokens, kill switch, audit log, always-human actions) and the phase 6 gate
("Every capability can be revoked live from the panel").

Everything the model can do on the desktop goes through six tools behind the runtime's
enforcement hooks and, inside each tool, through `DesktopGate`, which is checked in code
before every action. A prompt may ask; only code can allow.

## What it can do

| Tool | Action class | What it does |
| --- | --- | --- |
| `desktop_list_windows` | `read` | windows of allowlisted applications: id, executable, window class, title; other applications are only counted |
| `desktop_focus { app }` | `non_routine` | bring a window of an allowed application to the front, by executable or window class (never by title) |
| `desktop_type { text }` | `non_routine` | type into the active window (newline = Enter; control characters refused) |
| `desktop_key { key }` | `non_routine` | press `Return`, `ctrl+s`, `alt+F4`, `shift+Tab`, ... (grammar in `keys.ts`) |
| `desktop_click { x, y, button? }` | `non_routine` | click at screen coordinates |
| `desktop_screenshot { label?, includeInContext? }` | `non_routine` | PNG of the active allowed window into the agent's sandbox directory; returns the path |

Every tool is `risk: "high"` and has the gate in `beforeCall` (the runtime or the orchestrator
may call it before `execute`); `execute` runs the gate again inside the controller, so the gate
holds whoever calls the tool. `non_routine` is free at autonomy 3 in `decideAutonomy`, the
same floor the gate enforces, so the hooks and the gate agree; at level 2 a human's "yes" to
the tool call still does not open the desktop (`desktop-tools.test.ts` proves it).

Actions are serialised (one keyboard, one mouse). Type, key, click and screenshot act on the
window that is active *now*, read from the adapter before each action: when the human
alt-tabs to an application outside the allowlist, the next keystroke is refused, not typed
into the wrong window.

Typing is done in chunks of at most `TYPE_CHUNK_CHARS` (2000) characters, one process per
chunk, each with a timeout that scales with its length (`typingBudgetMs`: twice the keystroke
time plus 5 s, never under 30 s). A fixed 30 s limit would cut 20 000 characters at 12 ms each
after a tenth of them. The signal is checked between chunks and passed to every process, and
`desktop_type`'s tool timeout is the budget for `MAX_TEXT_LENGTH`, so the runtime's limit and
the adapter's agree. When typing is cut short (tool timeout, revoke, kill) the error and the
audit row say `typed N of M characters, then ...` (`details.typedChars`), so partial input is
never silent.

## Files

| File | What it holds |
| --- | --- |
| `types.ts` | `WindowInfo`, `DesktopAction`, `DesktopRunBinding` (enabled, autonomy, allowlist, screenshotsToModel, tokenId), `DesktopBindingResolver`, `DesktopDenyReason`, `DESKTOP_MIN_AUTONOMY` |
| `gate.ts` | `DesktopGate` (`checkStatic`, `check`, `revoke`, `resume`), `desktopDenial`, `isDesktopDenial` |
| `allowlist.ts` | entry format, `windowAllowed`, `appMatches`, `splitWmClass`, zod schemas, `MemoryAllowlistStore`, `FileAllowlistStore` |
| `approvals.ts` | `DesktopApprovalPort` (allow an app for this session), `HumanRequestDesktopApprovals` (production), `FakeDesktopApprovals` |
| `indicator.ts` | `Indicator` port, `RecordingIndicator`, `LogIndicator` (fallback), `CompositeIndicator` |
| `keys.ts` | key grammar (`parseKey`), `validateText`, limits, the typing budget (`typingBudgetMs`, `chunkText`, `TYPE_CHUNK_CHARS`) |
| `adapters/types.ts` | `DesktopAdapter` contract (`onProgress` for chunked actions), `Runner`, `Which`, click validation |
| `adapters/linux.ts` | `LinuxDesktopAdapter` (xdotool, wmctrl, import / scrot / gnome-screenshot), `linuxArgv`, `detectLinuxTools`, `parseWmctrlLine`, `readLinuxExe` |
| `adapters/windows.ts` | `WindowsDesktopAdapter` (PowerShell scripts as files), `WINDOWS_SCRIPTS`, `windowsArgv`, `escapeSendKeys`, `toSendKeys` |
| `adapters/fake.ts` | `FakeDesktopAdapter`: records calls, `hold()`/`release()` to simulate a slow desktop, writes a tiny PNG |
| `adapters/detect.ts` | `detectAdapter()`: platform, display server, the adapter or what is missing |
| `controller.ts` | `DesktopController`: binding, gate, indicator, audit, serialisation, revoke, kill switch and registry attachment, screenshots |
| `tools.ts` | the six `DesktopToolSpec`s, `registerDesktopTools` |
| `routes.ts` | `createDesktopRoutes`: status, allowlist get/put (a human's own list only), revoke (open), resume (signed-in human) |

## The gate

`DesktopGate.check(action, ctx)` refuses, in this order, with `ForerunnerError` whose
`details.gate` is `"desktop"` and `details.reason` one of `DesktopDenyReason`:

| Condition | Reason | Code |
| --- | --- | --- |
| the run's signal is aborted or the kill switch froze the agent or session | `killed` | `killed` |
| `revoke()` was called (panel toggle, extension removed) and `resume()` was not | `revoked` | `tool_not_allowed` |
| the capability is not enabled: `binding.enabled` is false (the default) | `disabled` | `tool_not_allowed` |
| `binding.autonomy < 3` | `autonomy` | `autonomy_insufficient` |
| an action other than `list_windows` has no window to act on | `no_target` | `tool_not_allowed` |
| a target window's application is not on the human's allowlist and no human allowed it for this session | `app_not_allowed` | `tool_not_allowed` |

The platform's error codes have no `permission` code; the closest stable ones are used and the
reason is in `details`. `checkStatic` is the first four rows; the controller runs it before it
touches the desktop (nothing is listed, focused or queued when the capability is off), then
resolves the targets and runs the full `check`.

`binding` comes from the orchestrator's `DesktopBindingResolver(ctx)` per tool call:
`enabled` from the extensions registry's `desktop-control` row (the registry owns the flag; off
by default; enabling is "granting a new capability", always a human), `autonomy` from the
project, `allowlist` from the store for `ctx.humanId`, `screenshotsToModel` only when the task
asked for images and the token allows them, `tokenId` for the audit rows.

The only human decision inside the module is "allow this application for the rest of this
session?" (`DesktopApprovalPort`). Widening permissions always needs a human, so the gate never
allows an app on its own; without a port it refuses. `HumanRequestDesktopApprovals` opens one
blocking `human_request` (kind `approval`, risk `high`, `change_card.key =
desktop_allow_app:<exe>|<class>`) per app and session and answers `pending` until the human
answers; `yes` is remembered by the gate for that session only, `revoke()` clears it. Permanent
allowance is an allowlist edit in Settings, never something the model can do: the card's last
step says "add it in Settings under Desktop control: allowed applications", the heading of the
app's allowlist section (`DESKTOP_ALLOWLIST_CONTROL` in the daemon's `api-types.ts`, U-060), which
reads and writes the list through `GET`/`PUT /desktop/allowlist/:humanId`.

## Allowlist format

The allowlist is per human (`DesktopAllowlistStore.get(humanId)`), a list of entries:

```
"code"                                plain string: matches executable or window class
"exe:notepad"                         executable only (base name, no directory, no .exe)
"class:Navigator.firefox"             window class only
{ "exe": "firefox" }                  object form; every field set must match
{ "windowClass": "Gimp", "note": "image edits" }
```

Matching is case-insensitive. Executables compare by base name without `.exe`
(`C:\Program Files\Microsoft VS Code\Code.exe` is `code`). Window classes compare against the
X11 `WM_CLASS` pair `instance.Class` (either half or the whole) or the Win32 class name. Titles
are never matched: they are application content, and a page titled "code" must not unlock the
browser. `FileAllowlistStore` keeps `<config>/desktop-allowlist.json` as `{ "<humanId>":
[entries] }`; `MemoryAllowlistStore` is for tests. The routes validate with `AllowlistSchema`
(at most 200 entries, each needs `app`, `exe` or `windowClass`).

wmctrl joins the pair with a dot, so a dotted half is ambiguous. `splitWmClass` resolves it:
GTK applications report their app id in both halves (`org.gnome.Nautilus.Org.gnome.Nautilus`),
and when the segments mirror each other the split is in the middle, so `class:org.gnome.Nautilus`
matches and a fragment such as `org` or `gnome` does not (a short plain entry never unlocks
every `org.*` application). Any other pair with a dotted half (`foo.bar.Baz`) matches either
half of the first-dot split or of the last-dot split, since wmctrl does not say which half
holds the dot. The whole string always matches.

The allowlist is the per-human permission boundary the gate relies on, so the routes let a
signed-in human read and change only their own list (`GET`/`PUT /desktop/allowlist/:humanId`
answer 403 for another human's id) when the daemon identifies humans (`humanFor`).

## Platform tools needed

Nothing is installed by Forerunner; `detectAdapter()` reports what is missing and the status
route shows it.

**Linux (X11, or XWayland inside a Wayland session)**

| Tool | Used for |
| --- | --- |
| `xdotool` | active window, focus (`windowactivate --sync`), typing (`type --clearmodifiers --delay N -- <chunk>`, one process per chunk of at most 2000 characters), keys (`key --clearmodifiers -- <combo>`), clicks (`mousemove --sync X Y click N`) |
| `wmctrl` | window list with pid and class (`wmctrl -l -p -x`); the executable is the base name of `/proc/<pid>/exe` (`readLinuxExe`), with `/proc/<pid>/comm` as the fallback when the link is unreadable (another user's process): the kernel cuts comm to 15 characters, so `gnome-terminal-server` reads `gnome-terminal-` there and only the `exe` link matches `exe:gnome-terminal-server` |
| one of `import` (ImageMagick), `scrot`, `gnome-screenshot` | screenshots of the active window's screen region (`import -window <id>`, `scrot --focused`, `gnome-screenshot --window`); detection prefers them in that order |
| `DISPLAY` | must be set; without it there is no adapter |

Under Wayland the tools reach XWayland windows only; native Wayland windows cannot be listed
or controlled (the spec's "limited to what the portal allows"); detection adds a note.

**Windows 10/11**

`powershell.exe` (Windows PowerShell 5.1, present on every supported Windows) or `pwsh`. The
adapter writes its five scripts (`WINDOWS_SCRIPTS`) once into a private directory under the
temp dir and runs `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
<script> <args>`. The scripts use `Get-Process` plus `user32` (`GetForegroundWindow`,
`GetClassName`) for the window list, `WScript.Shell.AppActivate` with a `SetForegroundWindow`
fallback for focus, `System.Windows.Forms.SendKeys.SendWait` for typing (one process per chunk
of at most 2000 characters, escaped per chunk so no `{...}` token is cut) and keys, `user32`
(`SetCursorPos`, `mouse_event`) for clicks and `System.Drawing` (`CopyFromScreen` of the
window rectangle from `GetWindowRect`) for screenshots. Text, key strings and paths reach the
script base64-encoded, so a value starting with `-` can never be read as a parameter and
nothing is ever spliced into script text. The Windows key cannot be sent through SendKeys
(`not_supported`). The spec's platform table names the UI Automation API; ADR 0021 records why
1.0 ships the PowerShell path and how UI Automation slots in later.

## Indicator

`Indicator { on(reason), off() }` is the port the shells implement with a visible banner or
overlay. The controller turns it on before the first action of a burst (after the gate passed,
before the adapter acts), keeps it on while actions queue, and turns it off: after
`indicatorIdleMs` (default 1500 ms) with no further action, at once on `endRun(runId)` when
nothing else is active, and at once on `revoke()`, a kill-switch stop or the registry
disabling the capability. `desktop-controller.test.ts` asserts the order (`indicator:on`
before the first adapter action, `indicator:off` last). `LogIndicator` is the fallback line;
`CompositeIndicator` fans out to several.

While the indicator is on, the controller sends another `on` only when what a banner names
changed (ADR 0067): the application became known (the burst started with
`desktop_list_windows`, which names no window) or changed, or another session or agent acts.
The same burst on the same application sends nothing more; `at` keeps the time the indicator
first turned on; a new session's `on` does not carry the previous session's application.

`status()` (the body of `GET /desktop/status`) carries the indicator for a shell that missed
frames: `desktopControl: { active, app, sessionId, agentId, since }` (`DesktopControlState`;
names null while off, `app` null while not known). The runtime's `api-types.ts` has the
schemas the shells parse (`DesktopIndicatorEventData`, `DesktopControlView`,
`DesktopStatusView`, `DesktopRevokeView`).

What renders it (ADR 0067; `apps.md` has the details):

| Shell | What it shows while on | Where it learns it | Stop |
| --- | --- | --- | --- |
| `apps/ui` (the desktop window) | `DesktopControlBanner` above the header on every page: white on red, `role="alert"`, the agent's name, the app ("the desktop" until named) and the session as a link | each `desktop.indicator` frame; `GET /desktop/status` at bootstrap, on every (re)opened stream, on `extension.changed`, when control ends and on every poll; a read answered before a newer frame is dropped | "Stop desktop control" = `POST /desktop/revoke`; after any stop (not a panel revoke) "Resume desktop control" = `POST /desktop/resume` |
| `apps/desktop` tray | tooltip first line `DESKTOP CONTROL ACTIVE: <app> (session <id>)`, icon title `Desktop control active (<app>)`, item `Desktop control: active (<app>)` | the shell's own `/events` (`sse.rs` `DesktopIndicator`, `state.rs` `DesktopControl::apply`); `GET /desktop/status` on every (re)opened stream (`actions::probe_desktop`), dropped if a frame landed meanwhile | tray item "Stop desktop control" = `POST /desktop/revoke` |
| Android, approvals web | nothing: they read the state service, not the PC daemon's `/events`; control runs on the PC | — | — |

Off clears every trace: the banner goes, the tray title is unset, the item reads
`Desktop control: off` and the stop item is disabled. While the daemon is unreachable the tray
keeps the last report, marked "last reported", with stop disabled.

## Screenshots

`desktop_screenshot` captures the active allowed window's screen region, never the whole
screen. It is a region, not the window's own backing store: `import -window <id>`,
`scrot --focused` and `CopyFromScreen` of the `GetWindowRect` rectangle all read the screen,
so anything overlapping that rectangle (another application's popup, a password prompt) is in
the file. The PNG goes to `desktopScreenshotDir(agentId)` =
`<data>/desktop/<safeSegment(agent)>/screenshots/<timestamp>-<run>-<seq>[-<label>].png` (the
orchestrator may pass another sandbox dir), checked with `isInside` before writing. Every
screenshot is an audit row with its path (tool `desktop_screenshot`). The bytes never enter git
(the directory is under the app data dir, not a worktree) and reach the result only when the
call set `includeInContext: true` *and* the binding's `screenshotsToModel` is true; otherwise
the tool returns the path and says the image was withheld. When both flags allow it the PNG is
in `ToolResult.artifacts.image` (base64) and the content says so and names the path; it does
not claim the model can see it, because the runtime does not yet forward image artifacts to
the provider (see Known issues).

## Audit

Every action, allowed or refused, is one `AuditPort` row: `tool` `desktop_<kind>`, who
(session, run, agent, human, token id), a bounded `inputSummary` (never the typed text, only
its length), `resultSummary` (focused window, screenshot path, ...), `allowed`, and
`deniedReason` as `<code>: <message>`. Revocations are audited on the interrupted and dropped
runs; a typing action cut short carries `typed N of M characters` in its denial. The routes
audit allowlist changes (`desktop_allowlist`), revoke and resume (with the human who resumed).

## Wiring (the daemon, `packages/runtime/src/daemon/compose.ts` and `server.ts`; ADR 0039)

`composeRuntime` builds one controller per daemon and registers the six tools as built-in
tools, so every run token lists them and the runtime's hooks and extension gate apply before
the gate in each tool:

| Port | The daemon's implementation |
| --- | --- |
| `adapter` | `detectAdapter()` once at compose; when nothing usable is found, `UnavailableDesktopAdapter` (`src/wiring/desktop-ports.ts`), whose every action refuses with `not_supported` naming `detection.missing` (after the gate, so the refusal is audited like any denial). Never a fake adapter in production; tests inject `FakeDesktopAdapter` through `ComposeOptions.desktop.adapter`. |
| `binding` | `desktopBindingResolver`: `enabled` from the `desktop-control` extension row read by name on every call (installed, enabled, neither pending nor errored, the gate's own rule), `autonomy` from the run's project (`autonomy_level`; the human's `default_autonomy` without a project), `allowlist` from `FileAllowlistStore` at `<config>/desktop-allowlist.json` behind the runtime's `GuardedAllowlistStore` (a file that is not JSON or not an allowlist is `validation` naming the file on every tool call and route, one `desktop_allowlist.read` audit row per refused read, never `internal` with the parser's message; the next call reads the file again), `screenshotsToModel: false` (see Known issues). |
| `indicator` | `CompositeIndicator([BusIndicator, LogIndicator])`: the bus event `desktop.indicator` `{ on, agentId, sessionId, runId, humanId, app, message, at }`, streamed by `/events` to every shell, plus the log line. |
| `audit`, `clock`, `kill`, `approvals` | the hooks' `StateAudit`, the daemon clock and kill switch, `HumanRequestDesktopApprovals(store.humanRequest)` (a blocking request in the inbox, raised as a notification like any other). |
| teardown | `attachKillSwitch(kill)`, `attachExtensionRegistry(extensions)` (toggle off or remove revokes live, toggle on resumes), `endRun` on the executor's `run_end` event, `close()` on daemon close. |

The catalog entry `desktop-control` (`packages/runtime/src/extensions/catalog.json`) names
exactly the six `desktop_*` tools with the classes `read` and `non_routine`, so the panel shows
them, the extension gate checks a call against the installed row, and `revokeLive` revokes the
tokens that carry them. Routes are mounted in `server.ts` through `desktopRouteTable` with a
small adapter over Hono's context (no Hono dependency here), `humanFor` set to the daemon's one
human, `detect` to the compose-time detection and `audit` to the hooks' audit port; they are
listed in `DAEMON_ROUTES` (`desktopStatus`, `desktopAllowlist`, `setDesktopAllowlist`,
`desktopRevoke`, `desktopResume`). `RuntimeApp.desktop` exposes the controller, the allowlist
store and detection.

## How to change it

- New action: add the kind to `DESKTOP_ACTION_KINDS`, the adapter method to
  `adapters/types.ts` and the three adapters, a controller operation through `perform` (so
  the gate, indicator and audit apply), and a `DesktopToolSpec` with `risk: "high"` and
  `beforeCall`.
- New platform tool: extend `LinuxScreenshotTool` / `linuxArgv` or `WINDOWS_SCRIPTS`; keep
  values as arguments, never in script or command text; add the argv to the tests.
- Changing the floor: `DESKTOP_MIN_AUTONOMY` is one constant, but the spec says 3+, so an ADR
  comes first.
- Never let a title match the allowlist; never return screenshot bytes without both flags;
  never bypass `perform`.

## Tests

`packages/capabilities/test/desktop-*.test.ts` (unit, no desktop, no network):

- `desktop-gate.test.ts`: the matrix (disabled, autonomy 0-2 refused and 3-4 allowed, app not
  allowed with the allowed apps named, killed, revoked until resume, list_windows static-only,
  no target), the approval port (approved remembered per session, pending and denied refuse,
  no port refuses), allowlist matching and parsing including dotted GTK app ids (`splitWmClass`,
  fragments never match), the memory and file stores, `HumanRequestDesktopApprovals` against a
  `sqlite::memory:` store (one blocking request per app, yes approves, no denies) and the
  window title bounded to one line on the card.
- `desktop-adapters.test.ts`: detection with a fake `which()` on Linux (missing tools,
  DISPLAY, Wayland note), Windows (powershell) and macOS; Linux argv construction (no shell,
  the text one argument after `--`), wmctrl parsing, id mapping, the full sequence through an
  injected runner, validation before any process, typing in bounded chunks with a runner
  timeout that scales with the chunk (and never splits a surrogate pair), the signal honoured
  between chunks with progress reported, `/proc/<pid>/exe` before the 15-char comm (the own
  process on Linux, a fake proc dir elsewhere); Windows argv (`-File <temp script>`, base64
  arguments, scripts on disk unchanged by input, never `-Command`), chunked SendKeys with a
  scaled timeout, SendKeys escaping and key mapping, JSON parsing, script directory lifecycle.
- `desktop-controller.test.ts` (the panel revoke's reason, "desktop-control disabled in the
  Extensions panel", is pinned: the UI reads it to leave that revoke to the panel): indicator on/off order and idle timeout, off on `endRun`, off
  and refusal on revoke, live revoke interrupting an in-flight action and dropping a queued
  one, typing cut short (timeout or revoke) audited with `typed N of M characters` and the
  gate reason kept, kill switch stop and frozen state, registry disable/enable, the gate matrix
  never reaching the adapter, active-window change refused, focus of unknown or disallowed
  apps, human approval through the port, screenshots under the sandbox dir with the path logged
  and the image withheld unless allowed and asked, an audit row per action, hidden windows,
  serialisation; `status().desktopControl` naming the app, session, agent and start while on
  and all null when off; a fresh `on` only when the app becomes known or changes or another
  session acts (none for the same burst on the same app), `at` kept, no app carried across
  sessions.
- `desktop-tools.test.ts`: six tools registered with risk high and `beforeCall`, strict
  schemas, `desktop_type`'s timeout covering `MAX_TEXT_LENGTH`, `beforeCall` refusing at
  autonomy 2 without touching the adapter, `execute` gated too, the six tools end to end on the
  fake adapter, an allowed screenshot naming the artifact and path instead of claiming it was
  attached, and behind `EnforcementHooks` with a real token (level 3 runs; level 2 with a
  human's approval of the tool call still refused).
- `desktop-routes.test.ts`: status (with `desktopControl` off), allowlist get/put with validation and audit, signed-in
  human required when the daemon identifies one and bound to their own id (another human's id
  answers 403), resume refused anonymously while revoke stays open, revoke and resume, error
  statuses.

- `desktop-wiring.test.ts` (the module inside `composeRuntime` and the daemon, ADR 0039): the
  six tools registered as built-in tools and the catalog entry naming exactly them, the
  status and allowlist routes behind the bearer token (another human's list answers 403, a
  write is audited), off by default (the gate refuses `disabled` through the hooks and
  audits it, the adapter untouched), install and enable from the catalog through the inbox,
  an application outside the allowlist refused (`app_not_allowed`), audited and put to the
  human as a blocking request, an allowlisted application focused and typed into through the
  fake adapter with the indicator on the bus and the typed text absent from the audit row,
  a shell on `/events` receiving the indicator as the `desktop.indicator` frame (on with the
  app, agent, session and run at the first action; off at `endRun`) and `GET /desktop/status`
  answering the same state as `desktopControl` while on and nulls after off, both parsed with
  the runtime's `DesktopStatusView` / `DesktopIndicatorEventData`, autonomy 2 refused by
  the hooks and by the gate alike, a panel toggle revoking live and a toggle on resuming,
  revoke open to any caller and resume bound to the human.
- `packages/runtime/test/desktop-wiring.test.ts` (the allowlist file in the daemon): the
  guarded file store composed over `<config>/desktop-allowlist.json` with the unavailable
  adapter, a file that is not JSON answering `validation` naming the file on the allowlist
  routes and refusing every tool call the same way before the gate decides, one
  `desktop_allowlist.read` audit row per refused read with the parser's snippet kept out of
  the error, the audit log and the log, a fixed file read at the next call without a restart,
  a bad entry in a write reported as the body's error and a file that parses but is no
  allowlist refused as `validation` too.

No integration test drives a real desktop: CI runners have no display. A manual check on each
platform is `fr` -> Extensions -> enable desktop control at autonomy 3, then `desktop_focus`
on an allowlisted editor and `desktop_type`; the banner must be visible while it types.
The shells' side is tested in `apps/ui/test/desktop-indicator.test.tsx` (banner on, names,
off, navigation, re-read on reconnect and in polling, stop and resume) and in the desktop
shell's `state.rs`, `sse.rs` and `actions.rs` tests (tray view on, off, unreachable; frame and
status parsing; the routes and the status field checked against this module's source).

## Known issues

- Native Wayland windows are out of reach (XWayland only); a portal-based adapter
  (`xdg-desktop-portal` RemoteDesktop/Screenshot) is the way in and would be a fourth adapter.
- Windows uses SendKeys and `mouse_event`, which UAC-elevated windows ignore; the UI
  Automation API (`System.Windows.Automation`) can replace SendKeys for text in a later ADR.
- The runtime does not consume `ToolResult.artifacts` yet (only the type is declared), so an
  allowed screenshot's PNG does not reach the model even with both flags set; the tool says
  so. Forwarding image artifacts into the provider message builder is a runtime change, and
  until then the daemon's binding sets `screenshotsToModel: false` for every run (no token
  claims it).
- The banner is part of the app window: while the window is hidden in the tray, the tray's
  title (Linux app indicators only; Windows shows no title) and tooltip are the visible
  indicator. An always-on-top overlay window is not built (ADR 0067, Consequences).
- The Android app and the approvals web page show no indicator: they do not subscribe to the
  PC daemon's `/events` (ADR 0067 point 7).
- The binding's `tokenId` is empty: `ToolExecutionContext` carries no token id, so the
  module's audit rows name the session, run, agent and human but not the token; the hooks'
  own audit rows for the same call do.
- Screenshots are screen regions: an overlapping window is in the file. Capturing a window's
  own backing store (`xwd -id`, `PrintWindow` on Windows) would exclude it and is a later
  adapter change.
- `desktop_list_windows` returns titles of allowlisted windows as untrusted content; the
  injection scan wraps them like any tool output.

## Requirements covered

L.4 (off by default, per-app allowlist, screenshots logged, autonomy 3+), S.32 (off by
default, autonomy 3+, app allowlist, visible on-screen indicator). Related: J.9 (level 3
Trusted is the floor), S.6 (allowing a new app is a permission change a human answers), S.8
(kill switch stops desktop actions and revokes), the phase 6 gate "every capability can be
revoked live from the panel" (`revoke()`, `attachExtensionRegistry`, `POST /desktop/revoke`).
