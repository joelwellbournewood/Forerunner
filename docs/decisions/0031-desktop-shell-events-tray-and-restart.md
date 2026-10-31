# 0031 — Desktop shell: its own `/events` subscription, tray behaviour, restart handling, deep links

Date: 2026-10-20
Status: accepted

Amended 2026-10-31 by ADR 0094 (U-018): Quit stops the daemon and everything it started; the
first close to the tray says that Forerunner keeps running.

## Context

ADR 0026 makes the desktop shell (`apps/desktop`, Tauri 2) attach to one `fr daemon` per
install and inject the daemon address and token into the UI. It leaves open how the shell
learns about notifications and daemon state (the UI already subscribes to `GET /events` with
`EventSource`), what the tray does and enables, how "Update and restart" is supervised when
the runtime's restart constant (86, ADR 0029) differs from the number ADR 0026 wrote down
(75), how `fr://` deep links reach the UI without UI changes, and where per-install window
state lives.

## Decision

1. **The shell subscribes to `GET /events` from Rust** (`reqwest`, token in the
   `Authorization` header), independently of the UI's own `EventSource`. Reasons: OS
   notifications must arrive while the window is hidden in the tray (a hidden webview may be
   throttled and the UI's polling fallback would never raise one); the token never enters a
   URL (`?token=` exists for browsers only, ADR 0025); the tray learns `inbox.changed` and
   `restart.requested` from the same source. Two streams per install are cheap for the daemon.
   The stream client has a 60 s read timeout (heartbeats come every 15 s) and reconnects with
   exponential backoff capped at 15 s; a `/health` probe every 10 s refreshes the tray and
   detects a daemon that went away.
2. **`notification` events are shown as received.** The daemon's notification module decides
   channels and quiet hours; the shell shows an OS notification for every `notification` SSE
   event whose data has a non-empty `title` (`body`, `level` and a UI `route` are optional;
   titles are cut at 200 and bodies at 1000 characters; a `route` is kept only when it is a
   known UI route). Until the daemon emits that event name, nothing is shown: the shell never
   invents notifications from `session.event` lines.
3. **Tray menu** (tauri `tray-icon`): Open, "Kill switch: stop everything", Resume, Pause
   email / Resume email (one item that toggles), Update and restart, Quit. Every item's text
   and enabled flag is derived in one pure function (`state::tray_view`) from facts the daemon
   reported: the kill switch needs `/health` to answer and `killActive: false`; Resume needs
   `killActive: true`; the email item needs the daemon to have answered
   `GET /agents/<principal>/email/settings` with 200, the GET of `emailRouteTable()` in
   `packages/capabilities/src/email/routes.ts` (a 404 disables it and the item says why, since
   a menu item has no tooltip; a shell test reads that file's source so a rename there fails
   the test); Update needs a reachable daemon and no update in flight. The
   kill switch and the update confirm with a native dialog. Left-click on the icon opens the
   window. Closing the window hides it to the tray; Quit ends the shell and leaves the daemon
   running; the shell never kills the daemon. *(Superseded by ADR 0094: Quit stops the daemon.)*
4. **Restart contract as the shell applies it.** The exit code that means "relaunch" is the
   `exitCode` in `<runtime>/restart.json`; when the file carries none, 86 and 75 are both
   accepted. A restart-code exit without the file, or any other non-zero code, is a crash
   (dialog with the daemon log path, no relaunch). Per request the shell relaunches once; a
   relaunched build that rolls back (`reason: "rollback"`) gets one more relaunch into the
   previous version; a third consecutive restart-exit before the daemon has been healthy for
   30 s gives up with a dialog. The relaunch launches the version `current.json` names when
   `<data>/versions/<version>/` holds a runnable install (ADR 0015), else the install directory
   as before. Before relaunching, the shell waits 3 s for a user service (ADR 0026) to bring a
   fresh `daemon.json` so two daemons never start. A relaunched daemon has a new token, so the
   main window is rebuilt with a new initialization script (the UI's per-install storage
   survives; the page reloads).
   For a daemon the shell did not start (a user service's, or one left from an earlier shell)
   there is no exit code to observe. The shell watches it instead, whether the request came
   from the tray or from the UI (announced as `restart.requested` on `/events`): `/health`
   every second for at most 90 s, and the daemon counts as gone only on a definitive signal
   (`restart::external_daemon_gone`): a pid the OS reports dead after any missed probe; a pid
   reported alive is waited for, however many probes it misses, because staging an update
   (download, verify, unpack) makes the daemon slow before it exits; where the OS gives no pid
   signal (Windows), three consecutive misses together with the `restart.json` the daemon
   writes right before exiting, or ten misses on their own. A single missed probe never
   relaunches: a second `fr daemon` beside a slow one would leave two processes writing
   `daemon.json`. Once gone, the contract above runs with the exit code the request names
   (a crash without a code when it left none); `restart.json` is removed only when a relaunch
   is decided.
5. **Attach order and the `fr` entry.** `fr` is located, in order: the staged version of
   `current.json`, `FORERUNNER_INSTALL_DIR`, `<config>/install.json`
   (`{ "schema": 1, "installDir": "...", "node"?: "..." }`, to be written by `fr setup`),
   `fr` on `PATH` (`fr.exe`, `fr.cmd`, `fr.bat` on Windows). An install directory runs as
   `node <dir>/node_modules/tsx/dist/cli.mjs <dir>/packages/runtime/src/cli/main.ts daemon`,
   never through `pnpm` or a shell. A `daemon.json` whose pid is known to be dead (Linux
   `/proc`) is stale and skipped without a probe; otherwise `/health` with a 1.5 s timeout
   decides. A `daemon.json` that does not point at loopback `http://` is refused.
   A daemon the shell spawned counts as up when `daemon.json` is fresh and answers `/health`.
   Fresh is "not the file that was there before": a different `pid` or `startedAt` than the
   file on disk before the spawn (else the last file attached to; any file when there was
   none). Equality with the spawned pid is accepted but never required, because the pid in
   the file is the shell's grandchild: `tsx`'s CLI runs the script in a child node process
   and `fr.cmd` runs under `cmd.exe`. Requiring pid equality would leave a cold start waiting
   60 s next to a healthy daemon and then report that it did not start.
6. **Injection is origin-guarded.** The initialization script sets the frozen, non-writable
   `window.__FORERUNNER__` only when the document's origin is the app's own
   (`tauri://localhost`, `http(s)://tauri.localhost`, the dev server); the main window's
   navigation policy refuses every other origin and opens `http(s)` links in the OS browser.
   The token therefore never reaches a remote page even if the UI navigates.
7. **Deep links** use the scheme `fr`, registered for Windows and Linux through the deep-link
   plugin (bundler config plus `register_all()` at start for AppImage and dev builds) with the
   single-instance plugin forwarding a second launch to the running shell. `fr://<route>` maps
   to the UI route `/<route>` for the routes the UI has (`open`, `inbox`, `projects/<id>[/<tab>]`,
   `sessions/<id>`, `settings`, `memory`, `extensions`); segments allow `A-Z a-z 0-9 . _ ~ -`
   only, query and fragment are dropped. The UI is navigated with `history.pushState` plus a
   `popstate` event, which React Router follows, so no UI code is shell-specific.
8. **Per-install state of the shell** lives under the same directories as the runtime:
   `<config>/install-id` (UUID, mode 0600), `<config>/window-state.json` (size, position,
   maximized; the position is applied only when it still lands on a monitor),
   `<logs>/daemon-shell.log` (the daemon's stdout and stderr when the shell started it) and
   `<logs>/desktop-shell.log` (the shell's own log). Dark mode is the UI's own toggle
   (ADR 0025); the shell sets no theme.

## Consequences

- Notifications and the tray work with the window closed, and the token appears in exactly
  one place outside the daemon: the initialization script of the app's own window.
- The restart budget is enforced in the shell, so a build that boots and dies cannot loop:
  the human gets one dialog with the log path.
- The daemon's notification module (phase 5) has a fixed event shape to emit; the email tray
  item lights up the day the daemon mounts the email routes, without a shell change.
- Two subscriptions per install; a daemon change in the SSE frame names needs the Rust parser
  updated as well as the UI's (`sse.rs` mirrors `apps/ui/src/api/sse.ts`).

## Alternatives considered

- Subscribing through the webview and a Tauri command: simpler, but silent while hidden and
  it would put the token in a URL.
- tauri-plugin-window-state: its file sits in Tauri's own app directory, shared by every
  install on the machine; a 40-line JSON under `<config>` is per install.
- A stable daemon port and token so the window never needs rebuilding: `fr daemon` only
  accepts `--port`; the token is the daemon's to generate.
- Treating 75 alone as the restart code (the ADR 0026 text): the runtime exits with 86 and
  writes the code into `restart.json`; following the file is the only choice that stays
  correct if the constant moves again.
- Judging a spawned daemon's `daemon.json` by pid equality with the child: definitive when it
  matches, but it never matches through `tsx` or `fr.cmd`; reading the parent pid from
  `/proc/<pid>/stat` would fix Linux only. The changed-file rule plus `/health` works on both
  platforms and for a user service's daemon alike.
- Treating one missed `/health` probe as the external daemon's exit: fast, but a daemon that
  is staging an update misses probes while it is still alive, and relaunching beside it would
  start a second daemon.
