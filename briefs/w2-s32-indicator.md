## title

Desktop control shows a visible on-screen indicator while active: a banner in the app and a tray state

## requirements

S.32 (S.30, S.31 context)

## adr

0067

## brief

BLOCKERS.md row S.32 the on-screen desktop-control indicator: **partly built**: the controller turns the indicator on before the first action and off after the last (`packages/capabilities/test/desktop-controller.test.ts`) and the daemon streams `desktop.indicator` to every shell on `/events` (`desktop-wiring.test.ts`); no desktop shell or UI component renders the banner yet. Stand-in: the event on the bus plus the `LogIndicator` line; the human sees every action in the audit and the session log. Needed: a banner in `apps/ui` and a tray state that read `desktop.indicator` and stay visible while `on`, tested in `apps/ui/test` and `state.rs`; then S.32 `done`. Spec S.32: 'Desktop control is off by default, needs autonomy 3+ and an app allowlist, and shows a visible on-screen indicator while active.'

## hints

Read packages/runtime/test/desktop-wiring.test.ts and the daemon's /events stream (the `desktop.indicator` event shape and who emits it), apps/ui/src/shell (the SSE subscription, the shell layout where a persistent banner belongs, the existing toast/notice components) and its tests, apps/desktop/src-tauri/src/state.rs, tray.rs and sse.rs (the shell's own /events subscription of ADR 0031 and how tray items reflect state, with the testable state module). The desktop shell compiles here: use CARGO_TARGET_DIR=/home/user/Forerunner/apps/desktop/src-tauri/target from your worktree's apps/desktop/src-tauri for cargo fmt --check, cargo clippy --all-targets -- -D warnings and cargo test. Build: (1) apps/ui: a persistent, unmissable banner (top of the window, every page, high contrast, with the app and the session named, a 'Stop desktop control' button calling the existing stop/kill route) shown while the latest desktop.indicator event is on and hidden when off; survives navigation; shows again after reconnect (the UI re-reads the state from a daemon view on reconnect: add `desktopControl: { active, app, sessionId }` to an existing status/view route if none carries it); (2) the desktop shell: the tray title/tooltip and a tray item 'Desktop control: active (<app>)' from the same event, cleared on off, in state.rs with a unit test; (3) the Android/approvals shells only show the banner through the shared UI if they subscribe to /events (if not, leave them: the control runs on the PC). Tests: apps/ui/test/desktop-indicator.test.tsx (event on -> banner with names, off -> gone, reconnect -> state re-read, stop button calls the route), state.rs tests. Docs: apps.md, desktop-control.md (the indicator section), runtime.md if a view changes.

## paths

apps/ui/src/shell, apps/desktop/src-tauri/src/state.rs, tray.rs, packages/runtime/src/daemon/views.ts, tests
