# 0067 — The desktop-control indicator in the shells: a banner on every page, a tray state, and the status view re-read on reconnect

Date: 2026-10-23
Status: accepted

## Context

Spec S.32: "Desktop control is off by default, needs autonomy 3+ and an app allowlist, and
shows a visible on-screen indicator while active." The gate, the allowlist and the autonomy
floor were built and tested (ADR 0021, ADR 0039). The controller turns the `Indicator` port on
before the first action of a burst and off after the last (`desktop-controller.test.ts`), and
the daemon's `BusIndicator` sends that as the `desktop.indicator` frame to every stream on
`GET /events` (`desktop-wiring.test.ts`). Nothing rendered the frame: the only visible
indicator was the `LogIndicator` warning line (`docs/status/BLOCKERS.md`, row S.32).

Open points:

- where the banner lives in `apps/ui` so it is visible on every page and cannot be scrolled
  away, and what it names;
- what "stop" calls: the kill switch (`POST /kill`, every session) or desktop control's own
  revoke (`POST /desktop/revoke`);
- how a shell that was disconnected when a frame went out learns the current state (an
  `EventSource` that reconnects, the UI in polling mode, the desktop shell reopening its own
  `/events` stream after a daemon restart): the frame is not replayed;
- which daemon view carries that state: `GET /health` is read on every (re)connect but is
  served without the bearer token, so it must not carry application names or session ids;
- what the desktop shell's tray shows, given that a Tauri menu item cannot be hidden;
- the frame names the application of the *first* action of a burst. When that action names
  no window (`desktop_list_windows`) the banner would say "the desktop" for the whole burst,
  and a later action on another application or for another session would keep a stale name;
- whether the Android and approvals-web shells need the banner.

## Decision

1. **The status view carries the indicator.** `DesktopController.status()` (served as
   `GET /desktop/status`, behind the bearer token) gains `desktopControl: { active, app,
   sessionId, agentId, since }`: `active` mirrors `indicatorOn`; the names are those of the
   last `on` and null while off (and `app` null while not known yet); `since` is when the
   indicator turned on. The runtime's `api-types.ts` defines the schemas the shells parse:
   `DesktopIndicatorEventData` (the frame), `DesktopControlView`, `DesktopStatusView` and
   `DesktopRevokeView`. `/health` is unchanged: it stays unauthenticated and nameless.
2. **A fresh `on` when the names change.** While the indicator is on, the controller sends
   another `on` only when what a banner names changed: the application became known or
   changed, or another session (or agent) acts. The same burst on the same application sends
   nothing more, so the on/off order the controller tests pin is unchanged. `at` keeps the
   time the indicator first turned on. Another session's frame does not carry the previous
   session's application over.
3. **The UI banner.** `apps/ui/src/shell/DesktopControlBanner.tsx` is rendered by `Shell`
   as the first child of the window, above the header and outside the scrolling `<main>`, so
   it is on every page and survives navigation. While the store's `desktopControl.active` is
   true it shows, high contrast (white on red with a yellow rule, `role="alert"`,
   `aria-live="assertive"`): "Desktop control active", the agent's name (from `/agents`, the
   id when unknown), the application ("the desktop" until named) and the session as a link to
   `/sessions/:id`, and a **Stop desktop control** button.
4. **Stop is desktop control's revoke, not the kill switch.** The button calls
   `POST /desktop/revoke` (the route the Extensions panel's revoke uses, open to any caller,
   fail-safe): the action in flight is interrupted, the queued ones dropped, the indicator goes
   off and further desktop actions are refused until resumed; the sessions keep running. The
   header's "Stop all" stays the kill switch. After a stop the store keeps `revoked` and a
   quieter amber line says desktop control is stopped, with **Resume desktop control**
   (`POST /desktop/resume`). A failed stop keeps the banner and says to use "Stop all" or the
   tray's kill switch.
5. **The UI re-reads the state on every (re)connect.** The store's `desktopControl` follows
   each `desktop.indicator` frame, and is re-read from `GET /desktop/status` at bootstrap,
   every time the `/events` stream reaches `sse` (first open and every reopen), on
   `extension.changed` (a panel toggle revokes or resumes) and on every poll in polling mode
   (the poller turns the status into the frame it stands for, `indicatorFromStatus`). A
   daemon without the desktop routes, or a failed read, leaves the store unchanged.
6. **The desktop shell's tray.** `ShellState.desktop` (`state.rs`, `DesktopControl`) is set
   from the shell's own `/events` subscription (ADR 0031) by `DesktopControl::apply`, and
   re-read with `actions::probe_desktop` (`GET /desktop/status`) every time that stream opens.
   `tray_view` derives: the tooltip's first line `DESKTOP CONTROL ACTIVE: <app> (session
   <id>)`, the icon title `Desktop control active (<app>)` (shown next to the icon by Linux
   app indicators; no-op elsewhere), an item `Desktop control: active (<app>)` (enabled; opens
   the window with the banner) and **Stop desktop control** (`POST /desktop/revoke`). Off
   clears all of it: the title is unset, the item reads `Desktop control: off` and both items
   are disabled (an item cannot be hidden, so it says off). While the daemon is unreachable
   the last report stays on screen, marked "last reported", with stop disabled: hiding it
   could hide control that is still going on. Names from the frame are trimmed, stripped of
   control characters and capped at 80 characters before they reach the tray.
7. **Android and approvals web are left as they are.** Desktop control runs on the PC the
   daemon runs on; the Android app and the approvals web page talk to the shared state
   service (and the approvals page's own `/events` of the state service), not the PC
   daemon's `/events`, so they never receive the frame. The banner in the desktop window and
   the tray are on the screen being controlled, which is where S.32 needs it.

## Consequences

- S.32 is `done`: the indicator is visible on the controlled screen in the window (every
  page) and in the tray while active, and gone when off, with tests on both sides
  (`apps/ui/test/desktop-indicator.test.tsx`, `state.rs` and `sse.rs` tests) and the status
  view tested through the composed daemon (`packages/capabilities/test/desktop-wiring.test.ts`).
- The banner is part of the app window. When the window is hidden in the tray the tray's
  title and tooltip are the visible indicator; a separate always-on-top overlay window is not
  built (a later change in the desktop shell if the tray proves too quiet).
- A shell attached to an older daemon without `desktopControl` fails the status parse and
  keeps what the frames said; the frames alone still drive the banner.
- `LogIndicator` stays as the fallback line in the daemon log.
