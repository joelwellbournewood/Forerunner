# 0021 — Desktop control: platform adapters, gate placement and screenshot handling

Date: 2026-10-20
Status: accepted

## Context

The spec gives desktop control (module L, "Browser and desktop control", the platform table)
four rules: off by default, a per-app allowlist, screenshots logged, autonomy 3 or more, plus
a visible on-screen indicator while active. The platform table names "UI Automation API" for
Windows and "X11 full support; Wayland limited to what the portal allows" for Linux, and says
nothing about which programs do the work, how the allowlist identifies an application, where
the gate sits relative to the runtime hooks, or what a screenshot may reach. Facts that decide
it:

1. The runtime's hooks decide per tool from an action class and the token; they cannot know
   which application a keystroke lands in. The hooks' autonomy table makes `non_routine`
   actions free at level 3, the same number the spec gives desktop control.
2. Forerunner runs processes through `@forerunner/platform`'s `run()` with argv arrays; a
   shell string is forbidden everywhere (AGENTS.md). Both PowerShell's `-Command` and
   `sh -c` would be shell strings carrying the model's text.
3. PowerShell `-File` parses an argument that starts with `-` as a parameter name even when
   the script declares positional parameters.
4. A human who alt-tabs during a session moves the keyboard focus; a keystroke sent "to the
   editor" then lands in whatever is in front.
5. A whole-screen capture shows every application, including ones the allowlist excludes; a
   capture of a window's screen rectangle still shows whatever overlaps it.
6. Native Wayland compositors expose no window list or synthetic input outside the portal
   APIs; xdotool and wmctrl work through XWayland only.
7. wmctrl prints `WM_CLASS` as `instance.Class` joined by a dot; GTK applications put a dotted
   app id in both halves. `/proc/<pid>/comm` is cut to 15 characters by the kernel.
8. `xdotool type` sends one keystroke per `--delay` (12 ms): 20 000 characters take 240 s,
   far past a fixed 30 s process timeout, which would cut the text after a tenth of it.

## Decision

**Gate placement.** `DesktopGate` is checked in code inside every tool, before any process
starts: kill state, revocation, the extensions registry's `enabled` flag (off by default),
`autonomy >= 3`, a target window, and the allowlist for every window the action reaches. It
runs in `beforeCall` and again inside the controller's `perform`, so the gate holds whoever
calls the tool, and it runs after the runtime hooks, which already applied the token and the
autonomy table. A human's approval of a tool call at level 2 does not open the desktop: the
spec's "always requires autonomy 3+" is a floor, not an approval class.

**Allowlist identity.** An application is its executable base name (without directory or
`.exe`) or its window class (`WM_CLASS` on X11, the Win32 class). Titles are never matched:
they are content an application chooses. On Linux the executable is the base name of
`/proc/<pid>/exe`, with the 15-character `comm` only as a fallback for processes whose link is
unreadable. A class entry matches the whole `WM_CLASS` pair or one of its halves; for a pair
whose halves mirror each other (a GTK app id) the split is in the middle, so a fragment such
as `org` never unlocks every `org.*` application. The allowlist is per human, kept outside the
model's reach (a settings file or the daemon's store), edited through the routes by the
signed-in human it belongs to: another human's id answers 403, and resume after a revoke needs
a signed-in human too, while revoke stays open to any caller because it only narrows. The only
in-session widening is a blocking human request to allow one application for that session,
through a port the module defines; the gate forgets it on revoke.

**Target is the active window, read each time.** Type, key, click and screenshot act on the
window the adapter reports active at that moment, and the gate checks that window. A focus
change by the human to an application outside the allowlist refuses the next action instead of
typing into it.

**Linux adapter: xdotool + wmctrl + one screenshot tool, X11/XWayland.** `wmctrl -l -p -x`
gives ids, pids and classes; `/proc/<pid>/exe` (then `comm`) the executable; `xdotool` focus,
typing, keys and clicks with the model's text as one argument after `--`; `import -window
<id>`, `scrot --focused` or `gnome-screenshot --window` (first found, in that order) for the
capture. No tool is installed by Forerunner; detection reports what is missing. Wayland is
served only through XWayland, with a note; a portal adapter is a later addition, not a change
to this one.

**Typing in bounded chunks with a timeout that scales.** Both adapters type at most 2000
characters per process and give each process `typingBudgetMs(chars)` (twice the keystroke time
plus 5 s, at least 30 s); the signal is checked between chunks, and `desktop_type`'s tool
timeout is the budget for the longest text its schema admits, so the runtime's limit and the
adapters' agree. An interrupted typing action reports how many characters reached the
application (`typed N of M characters`) in its error and audit row. A single long process with
a fixed timeout was rejected: it types part of the text and then dies with nothing recorded.

**Windows adapter: PowerShell scripts as files, values as base64 arguments.** Five fixed
scripts (`Get-Process` plus `user32` for windows and the foreground window, `AppActivate` with
a `SetForegroundWindow` fallback, `SendKeys.SendWait`, `SetCursorPos`/`mouse_event`,
`System.Drawing` of the window rectangle) are written once to a private temp directory and run
with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path> <args>`. Text, key
strings and paths are base64 arguments decoded inside the script, so no value can start with
`-` or be spliced into script text. This deviates from the spec table's "UI Automation API":
the build order asked for this path, SendKeys and `mouse_event` cover the six actions on every
supported Windows without extra modules, and `System.Windows.Automation` is reachable from the
same script mechanism when a later ADR wants element-level control. Consequence: windows of
UAC-elevated processes ignore the input (they would ignore UI Automation from a non-elevated
daemon too).

**Screenshots capture the active window's screen region and stay out of the model by
default.** The capture is the active allowed window's rectangle on screen, never the whole
screen; overlapping windows are included, since `import -window`, `scrot --focused` and
`CopyFromScreen` read the screen rather than the window's backing store. It is saved under
`<data>/desktop/<agent>/screenshots/` (never a worktree) and logged with its path. The image
bytes go into the tool result only when the call asked and the run's binding says the token
allows it, and the result says they are in the artifact rather than that the model sees them,
because the runtime does not forward image artifacts yet.

**Indicator and live revocation.** The indicator is a port the shells implement; the
controller turns it on before the first action and off after the last (idle timeout, run end)
or at once on revoke. Revocation (`revoke()`, the panel's toggle through the registry's events,
a kill-switch stop) aborts the in-flight action's process, drops queued actions, and the gate
refuses until `resume()`.

## Consequences

- Six tools, all `risk: "high"`, `read` for listing and `non_routine` for the rest, so the
  runtime's table and the gate agree on 3 as the floor.
- Tests need no desktop: adapters take an injected runner and `which()`, and a fake adapter
  records calls and can hold an action so a revoke can interrupt it.
- The extension catalog's tool names must match the six `desktop_*` tools for the panel and
  `revokeLive` to cover them (the orchestrator's wiring step).
- Native Wayland and elevated Windows processes are documented limits, not silent failures:
  detection and the error messages say so.

## Alternatives considered

- **Node native modules (robotjs, nut.js, @nut-tree)**: binary dependencies per platform and
  Node ABI, no window class information, and a second place to audit for how input reaches the
  OS. Rejected for 1.0; the argv path keeps every action visible in the audit log as a command.
- **`powershell -Command "<script with values>"`**: a shell string with the model's text in it.
  Rejected by the repository rule.
- **Whole-screen screenshots**: simpler, but they leak every other application; rejected.
  Capturing the window's own backing store (`xwd -id`, `PrintWindow`) would also exclude
  overlapping windows but is not available through the chosen tools; a later adapter change.
- **Matching the allowlist by title**: lets any page or document named like an allowed app
  unlock it; rejected.
- **A portal (xdg-desktop-portal) adapter for Wayland**: right in principle, but it needs a
  D-Bus session, user consent dialogs per session and a screencast pipeline; deferred to its
  own ADR.
