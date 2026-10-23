# w2-s32-indicator

Item: desktop control shows a visible on-screen indicator while active: a banner in the app
and a tray state (requirement S.32; context S.30, S.31). ADR 0067. Branch
`wave/w2-s32-indicator`.

## Build report

### Starting point

The branch `wave/w2-s32-indicator` on origin was at `82a6295` with no commits of its own.
`git merge-base --is-ancestor origin/ccr-4d8a843c-1k9syk HEAD` failed, so I ran
`git merge --no-edit origin/ccr-4d8a843c-1k9syk`. It fast-forwarded to `b1804e3`, the base
the task names, with no conflicts. My work starts at `b1804e3`: `/tmp/start-sha` holds it, and
the patch is `b1804e3..HEAD`. The build commits are:

- `262a6bb` desktop: the status view names what the indicator shows, and the banner follows the app
- `6cfc32c` ui: a desktop-control banner at the top of every page while an agent controls the desktop
- `cff3a77` desktop: the tray shows desktop control while active and stops it
- `281ef28` docs: ADR 0067, the indicator in the apps, desktop-control and runtime docs; S.32 done
- (this report)

### What was built

1. **Daemon view** (`packages/capabilities/src/desktop/controller.ts`,
   `packages/runtime/src/daemon/api-types.ts`). `DesktopController.status()` now returns
   `desktopControl: { active, app, sessionId, agentId, since }`. The daemon serves it as
   `GET /desktop/status`, behind the bearer token. While control is off every name is null.
   I left `/health` unchanged because it is unauthenticated. `api-types.ts` gained the schemas
   the shells parse: `DesktopIndicatorEventData` (the frame, which is now the type in
   `DaemonSseEvent`), `DesktopControlView`, `DesktopStatusView` and `DesktopRevokeView`.
   `DAEMON_ROUTES.desktopStatus` describes the new field. The brief's paths named
   `views.ts`, but no change was needed there: the status route was the right existing view
   (ADR 0067 point 1).
2. **Truthful names** (controller). While the indicator is on, the controller sends a
   fresh `on` only when the application becomes known or changes, or when another session or
   agent acts. A burst that keeps acting on the same app sends nothing more, so the existing
   on/off order tests still pass unchanged. `at` keeps the time the indicator first turned on.
3. **UI banner** (`apps/ui/src/shell/DesktopControlBanner.tsx`, rendered by `Shell.tsx`).
   - **Placement:** the first child of the window, above the header and outside the scrolling
     `<main>`. It is on every page and stays through navigation.
   - **Look:** white on red with a yellow rule, `role="alert"`, `aria-live="assertive"`.
   - **Content:** "Desktop control active", the agent's name, the app ("the desktop" until
     the controller names one) and the session as a link to `/sessions/:id`.
   - **Stop:** "Stop desktop control" posts `POST /desktop/revoke` with
     `{ reason: "stopped from the desktop control banner" }`. Afterwards an amber line offers
     "Resume desktop control" (`POST /desktop/resume`). If the stop fails, the banner stays
     and shows the error.
4. **UI state and reconnect** (`apps/ui/src/api/sse.ts`, `api/client.ts`, `store/store.ts`,
   `store/context.tsx`).
   - `desktop.indicator` is a parsed `/events` frame and sets `desktopControl` in the store.
   - `refreshDesktopControl` re-reads `GET /desktop/status` at bootstrap, every time the
     stream reaches `sse` (the first open and every reopen), and on `extension.changed`.
   - In polling mode the poller turns the status into a frame (`indicatorFromStatus`).
   - `AppProvider` takes an optional `streamOptions` prop so tests can inject an EventSource.
   - The client has new `desktopStatus`, `desktopRevoke` and `desktopResume` methods.
5. **Tray** (`apps/desktop/src-tauri/src/sse.rs`, `state.rs`, `tray.rs`, `events.rs`,
   `actions.rs`).
   - **Input:** `sse::DesktopIndicator` parses the frame and the status object. It trims
     names, drops control characters and caps them at 80 characters.
   - **State:** `ShellState.desktop` holds a `DesktopControl`, updated by `apply`.
   - **What `tray_view` shows while on:**
     - the tooltip's first line, `DESKTOP CONTROL ACTIVE: <app> (session <id>)`;
     - the icon title, `Desktop control active (<app>)`;
     - the item `Desktop control: active (<app>)`, which opens the window;
     - an enabled "Stop desktop control" item, which posts `POST /desktop/revoke`.
   - **Off** clears all of it.
   - **While the daemon is unreachable**, the last report stays on screen, marked "last
     reported", and stop is disabled.
   - **Reconnect:** `actions::probe_desktop` re-reads `GET /desktop/status` each time the
     shell's `/events` stream opens.
6. **Android and approvals web: no change.** Neither subscribes to the PC daemon's
   `/events` (approvals web reads the state service's feed through `StateClient`). Desktop
   control runs on the PC, so the brief says to leave them. Recorded in ADR 0067 point 7.
7. **Docs.**
   - ADR `docs/decisions/0067-desktop-control-indicator-in-the-shells.md`, plus its index row.
   - `docs/maintainers/desktop-control.md`: the Indicator section rewritten with a table of
     what each shell shows; Tests and Known issues updated.
   - `docs/maintainers/apps.md`: the client, realtime, state, shell, tests, tray, events and
     how-to-change sections, and the cargo last-run line.
   - `docs/maintainers/runtime.md`: the status view, the frame, the tests and the known issue.
   - Status files: `docs/requirements.md` S.32 → `done` with its tests; the
     `docs/status/BLOCKERS.md` S.32 row rewritten (what was built, what is left) and the V.1
     counts updated; a `docs/status/PROGRESS.md` log entry, the phase-8 counts and the
     handover list.

### Tests that prove it

- **`apps/ui/test/desktop-indicator.test.tsx`** (new, 9 tests). The `/events` EventSource
  is a stand-in wired to the fake daemon's listeners. The fake's `setDesktopControl` emits
  the frame the way `BusIndicator` does. The tests cover:
  - no banner while control is off;
  - an `on` frame showing the banner above the header, high contrast, naming the agent
    ("Alice's agent"), the app and the session with its href;
  - `off` hiding the banner, with no "stopped" line;
  - an app that becomes known updating the banner, and "the desktop" without one;
  - the banner staying through navigation to six pages and the session link;
  - **reconnect:** the stream drops; an `on` missed during the outage shows after the
    reopen, and an `off` missed during a second outage hides it;
  - the banner shown at start-up from the bootstrap read;
  - the stop button posting `/desktop/revoke` with its reason and never `/kill`, the banner
    hiding, and resume posting `/desktop/resume`;
  - a failed stop keeping the banner and showing the error;
  - polling mode reading the indicator from the status view.

  I checked the reconnect test against a broken build: with the re-read on `sse` disabled,
  that test fails (1 failed, 8 passed).
- **`apps/ui/test/sse.test.ts`:** `desktop.indicator` parsed on (with names) and off; a
  malformed frame is dropped.
- **`packages/capabilities/test/desktop-controller.test.ts`** (2 new tests):
  - `status().desktopControl` on (app, session, agent, since) and all-null after the idle
    off;
  - the fresh `on` rules: `list_windows` then `focus code` sends 2 `on`s with the same `at`;
    the same app sends nothing more; `focus firefox` sends a third; another session sends a
    fourth without carrying the previous app over; `endRun` sends the off.
- **`packages/capabilities/test/desktop-wiring.test.ts`:** composes the daemon and reads
  `/events`. While the frame is on, `GET /desktop/status` (parsed with the runtime's
  `DesktopStatusView`) answers the same app, session, agent and since. After `endRun` it
  answers nulls. The frame parses with `DesktopIndicatorEventData`.
- **`packages/capabilities/test/desktop-routes.test.ts`:** the status includes
  `desktopControl` with everything off.
- **`apps/desktop/src-tauri/src/state.rs`** (3 new tests): the tray view on (title,
  tooltip first line, item, stop enabled, the rest of the menu unchanged) and cleared on off;
  "the desktop" without an app, and a new `on` replacing the names; the last report kept but
  not stoppable while the daemon is unreachable.
- **`sse.rs`** (1 new test): frame on and off; names dropped from an off frame; malformed
  frames refused; control characters stripped and the cap applied; the status view's
  `desktopControl` read the same way.
- **`actions.rs`** (1 new test): `/desktop/status`, `/desktop/revoke` and
  `desktopControl.active` checked against the capability's TypeScript source at compile time.

### Commands run and results (2026-10-23, Linux)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | clean (every package and app) |
| `pnpm lint` | 0 errors, 59 warnings; the same 59 are on the base, and `biome check` on every changed file is clean |
| `pnpm exec vitest run --project unit packages/capabilities/test` | 35 files, 380 tests passed |
| `pnpm exec vitest run --project integration packages/capabilities/test` | 3 files, 21 passed, 1 skipped (a Postgres case) |
| `pnpm exec vitest run --project unit packages/capabilities/test/desktop-controller.test.ts packages/capabilities/test/desktop-routes.test.ts packages/capabilities/test/desktop-wiring.test.ts` | 3 files, 33 tests passed |
| `pnpm exec vitest run --project unit packages/runtime/test` | 116 files, 1001 passed, 1 skipped |
| `pnpm exec vitest run --project integration packages/runtime/test` | 1 file (sandbox), 4 tests skipped: no sandbox engine here |
| `pnpm --filter @forerunner/ui test` | 43 files, 265 tests passed (256 at the base; 9 new) |
| `pnpm --filter @forerunner/ui exec vitest run test/desktop-indicator.test.tsx test/sse.test.ts` | 2 files, 16 tests passed |
| `cd apps/desktop/src-tauri && CARGO_TARGET_DIR=/home/user/Forerunner/apps/desktop/src-tauri/target cargo fmt --check` | clean |
| `… cargo clippy --all-targets -- -D warnings` | clean |
| `… cargo test` | 73 passed, 0 failed (68 before; 5 new) |
| `node scripts/docs-check.mjs --base b1804e3` | ok (27 files) |
| `pnpm check` (lint, paths, typecheck, unit tests, docs, links, secret scan) | exit 0; unit: 271 files, 2696 passed, 4 skipped, 1 todo; check-paths ok; link-check ok; secret-scan clean. Its `docs:check` step has no `origin/main` in this clone and says "nothing to check", so I ran it with `--base` above |

The cargo commands needed the WebKitGTK and AppIndicator development packages. I installed
them with `apt-get` (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev`). The target directory did not exist yet, so the first build created it.

### Left open, and why

- **The Android app and the approvals web page show no indicator.** They do not read the PC
  daemon's `/events`, and the control happens on the PC screen, where the window and the
  tray are. The brief says to leave them (ADR 0067 point 7).
- **No always-on-top overlay while the window is hidden in the tray.** The tray's title and
  tooltip are the indicator then. Windows shows no tray title, so there it is the tooltip
  and the menu item. An overlay window would be a later desktop-shell change; it is noted in
  the ADR's consequences and in the desktop-control.md Known issues.
- **No manual check on a real desktop, and no Windows run of the Rust tests.** CI runners
  have no display, and `desktop.yml` does not run `cargo test` (apps.md Known issues). The
  BLOCKERS row names the manual check as the re-test.
- **S.32 is marked `done` on Linux evidence only, without a CI run on both OSes.** That is
  short of the requirements file's strict definition, which needs CI green on Windows and
  Linux; the item's merge into the integrated branch and its CI run complete it.
- **No independent review yet.** The item still needs one before it is merged.
