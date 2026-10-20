# Desktop control

> Status: built (phase 6). The gate, the Linux and Windows adapters, the indicator port, the
> controller, six `ToolSpec`s, the allowlist store and the routes are in
> `packages/capabilities/src/desktop/`. Wiring into the daemon (compose, extensions panel,
> kill switch, the shells' on-screen banner) is the orchestrator's step; this file covers the
> module. ADR 0021 records the adapter choices.

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

## Files

| File | What it holds |
| --- | --- |
| `types.ts` | `WindowInfo`, `DesktopAction`, `DesktopRunBinding` (enabled, autonomy, allowlist, screenshotsToModel, tokenId), `DesktopBindingResolver`, `DesktopDenyReason`, `DESKTOP_MIN_AUTONOMY` |
| `gate.ts` | `DesktopGate` (`checkStatic`, `check`, `revoke`, `resume`), `desktopDenial`, `isDesktopDenial` |
| `allowlist.ts` | entry format, `windowAllowed`, `appMatches`, zod schemas, `MemoryAllowlistStore`, `FileAllowlistStore` |
| `approvals.ts` | `DesktopApprovalPort` (allow an app for this session), `HumanRequestDesktopApprovals` (production), `FakeDesktopApprovals` |
| `indicator.ts` | `Indicator` port, `RecordingIndicator`, `LogIndicator` (fallback), `CompositeIndicator` |
| `keys.ts` | key grammar (`parseKey`), `validateText`, limits |
| `adapters/types.ts` | `DesktopAdapter` contract, `Runner`, `Which`, click validation |
| `adapters/linux.ts` | `LinuxDesktopAdapter` (xdotool, wmctrl, import / scrot / gnome-screenshot), `linuxArgv`, `detectLinuxTools`, `parseWmctrlLine` |
| `adapters/windows.ts` | `WindowsDesktopAdapter` (PowerShell scripts as files), `WINDOWS_SCRIPTS`, `windowsArgv`, `escapeSendKeys`, `toSendKeys` |
| `adapters/fake.ts` | `FakeDesktopAdapter`: records calls, `hold()`/`release()` to simulate a slow desktop, writes a tiny PNG |
| `adapters/detect.ts` | `detectAdapter()`: platform, display server, the adapter or what is missing |
| `controller.ts` | `DesktopController`: binding, gate, indicator, audit, serialisation, revoke, kill switch and registry attachment, screenshots |
| `tools.ts` | the six `DesktopToolSpec`s, `registerDesktopTools` |
| `routes.ts` | `createDesktopRoutes`: status, allowlist get/put, revoke, resume |

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
allowance is an allowlist edit in Settings, never something the model can do.

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

## Platform tools needed

Nothing is installed by Forerunner; `detectAdapter()` reports what is missing and the status
route shows it.

**Linux (X11, or XWayland inside a Wayland session)**

| Tool | Used for |
| --- | --- |
| `xdotool` | active window, focus (`windowactivate --sync`), typing (`type --clearmodifiers --delay N -- <text>`), keys (`key --clearmodifiers -- <combo>`), clicks (`mousemove --sync X Y click N`) |
| `wmctrl` | window list with pid and class (`wmctrl -l -p -x`); the executable comes from `/proc/<pid>/comm` |
| one of `import` (ImageMagick), `scrot`, `gnome-screenshot` | screenshots of one window (`import -window <id>`, `scrot --focused`, `gnome-screenshot --window`); detection prefers them in that order |
| `DISPLAY` | must be set; without it there is no adapter |

Under Wayland the tools reach XWayland windows only; native Wayland windows cannot be listed
or controlled (the spec's "limited to what the portal allows"); detection adds a note.

**Windows 10/11**

`powershell.exe` (Windows PowerShell 5.1, present on every supported Windows) or `pwsh`. The
adapter writes its five scripts (`WINDOWS_SCRIPTS`) once into a private directory under the
temp dir and runs `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
<script> <args>`. The scripts use `Get-Process` plus `user32` (`GetForegroundWindow`,
`GetClassName`) for the window list, `WScript.Shell.AppActivate` with a `SetForegroundWindow`
fallback for focus, `System.Windows.Forms.SendKeys.SendWait` for typing and keys, `user32`
(`SetCursorPos`, `mouse_event`) for clicks and `System.Drawing` (`CopyFromScreen` of the
window rectangle from `GetWindowRect`) for screenshots. Text, key strings and paths reach the
script base64-encoded, so a value starting with `-` can never be read as a parameter and
nothing is ever spliced into script text. The Windows key cannot be sent through SendKeys
(`not_supported`). The spec's platform table names the UI Automation API; ADR 0021 records why
1.0 ships the PowerShell path and how UI Automation slots in later.

## Indicator

`Indicator { on(reason), off() }` is the port the shells implement with a visible banner or
overlay (the desktop app's window and tray, the approvals web page). The controller turns it
on before the first action of a burst (after the gate passed, before the adapter acts), keeps
it on while actions queue, and turns it off: after `indicatorIdleMs` (default 1500 ms) with no
further action, at once on `endRun(runId)` when nothing else is active, and at once on
`revoke()`, a kill-switch stop or the registry disabling the capability.
`desktop-controller.test.ts` asserts the order (`indicator:on` before the first adapter
action, `indicator:off` last). `LogIndicator` is the fallback when no shell is attached;
`CompositeIndicator` fans out to several.

## Screenshots

`desktop_screenshot` captures the active (allowed) window only, never the whole screen, so
other applications' content stays out of the file. The PNG goes to
`desktopScreenshotDir(agentId)` = `<data>/desktop/<safeSegment(agent)>/screenshots/
<timestamp>-<run>-<seq>[-<label>].png` (the orchestrator may pass another sandbox dir), checked
with `isInside` before writing. Every screenshot is an audit row with its path (tool
`desktop_screenshot`). The bytes never enter git (the directory is under the app data dir,
not a worktree) and reach the model only when the call set `includeInContext: true` *and* the
binding's `screenshotsToModel` is true; otherwise the tool returns the path and says the image
was withheld.

## Audit

Every action, allowed or refused, is one `AuditPort` row: `tool` `desktop_<kind>`, who
(session, run, agent, human, token id), a bounded `inputSummary` (never the typed text, only
its length), `resultSummary` (focused window, screenshot path, ...), `allowed`, and
`deniedReason` as `<code>: <message>`. Revocations are audited on the interrupted and dropped
runs; the routes audit allowlist changes (`desktop_allowlist`), revoke and resume.

## Wiring (the orchestrator's part)

```ts
const detection = await detectAdapter();
const controller = new DesktopController({
  adapter: detection.adapter ?? new FakeDesktopAdapter(),   // or refuse with detection.missing
  binding: async (ctx) => ({
    enabled: await registry.isEnabled("capability", "desktop-control"),
    autonomy: project.autonomy_level,
    allowlist: await allowlist.get(ctx.humanId),
    screenshotsToModel: task.wantsScreenshots && claims.allowScreenshots,
    tokenId: claims.id,
  }),
  indicator: new CompositeIndicator([shellBanner, new LogIndicator()]),
  audit: statePorts.audit,
  clock,
  kill,
  approvals: new HumanRequestDesktopApprovals(store.humanRequest),
});
controller.attachKillSwitch(kill);
controller.attachExtensionRegistry(registry);   // disabled/removed -> revoke, enabled -> resume
registerDesktopTools(registry, controller);
app.route("/", createDesktopRoutes({ controller, allowlist, clock, audit, detect: detectAdapter }, new Hono()));
```

The catalog entry `desktop-control` in `packages/runtime/src/extensions/catalog.json` must
list the six tool names above so the panel shows them and `revokeLive` revokes tokens that
carry them. `DesktopController.endRun(runId)` belongs in the run's teardown.

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
  no port refuses), allowlist matching and parsing, the memory and file stores,
  `HumanRequestDesktopApprovals` against a `sqlite::memory:` store (one blocking request per
  app, yes approves, no denies).
- `desktop-adapters.test.ts`: detection with a fake `which()` on Linux (missing tools,
  DISPLAY, Wayland note), Windows (powershell) and macOS; Linux argv construction (no shell,
  the text one argument after `--`), wmctrl parsing, id mapping, the full sequence through an
  injected runner, validation before any process; Windows argv (`-File <temp script>`,
  base64 arguments, scripts on disk unchanged by input, never `-Command`), SendKeys escaping
  and key mapping, JSON parsing, script directory lifecycle.
- `desktop-controller.test.ts`: indicator on/off order and idle timeout, off on `endRun`, off
  and refusal on revoke, live revoke interrupting an in-flight action and dropping a queued
  one, kill switch stop and frozen state, registry disable/enable, the gate matrix never
  reaching the adapter, active-window change refused, focus of unknown or disallowed apps,
  human approval through the port, screenshots under the sandbox dir with the path logged and
  the image withheld unless allowed and asked, an audit row per action, hidden windows,
  serialisation.
- `desktop-tools.test.ts`: six tools registered with risk high and `beforeCall`, strict
  schemas, `beforeCall` refusing at autonomy 2 without touching the adapter, `execute` gated
  too, the six tools end to end on the fake adapter, and behind `EnforcementHooks` with a real
  token (level 3 runs; level 2 with a human's approval of the tool call still refused).
- `desktop-routes.test.ts`: status, allowlist get/put with validation and audit, signed-in
  human required when the daemon identifies one, revoke and resume, error statuses.

No integration test drives a real desktop: CI runners have no display. A manual check on each
platform is `fr` -> Extensions -> enable desktop control at autonomy 3, then `desktop_focus`
on an allowlisted editor and `desktop_type`; the banner must be visible while it types.

## Known issues

- Native Wayland windows are out of reach (XWayland only); a portal-based adapter
  (`xdg-desktop-portal` RemoteDesktop/Screenshot) is the way in and would be a fourth adapter.
- Windows uses SendKeys and `mouse_event`, which UAC-elevated windows ignore; the UI
  Automation API (`System.Windows.Automation`) can replace SendKeys for text in a later ADR.
- The extension catalog entry still lists the old tool names (`desktop.screenshot`, ...); it
  must be updated to the six `desktop_*` names when the orchestrator wires the module.
- `desktop_list_windows` returns titles of allowlisted windows as untrusted content; the
  injection scan wraps them like any tool output.

## Requirements covered

L.4 (off by default, per-app allowlist, screenshots logged, autonomy 3+), S.32 (off by
default, autonomy 3+, app allowlist, visible on-screen indicator). Related: J.9 (level 3
Trusted is the floor), S.6 (allowing a new app is a permission change a human answers), S.8
(kill switch stops desktop actions and revokes), the phase 6 gate "every capability can be
revoked live from the panel" (`revoke()`, `attachExtensionRegistry`, `POST /desktop/revoke`).
