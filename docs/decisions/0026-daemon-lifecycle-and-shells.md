# 0026 — Daemon lifecycle: one `fr daemon` per install, shells attach to it

Date: 2026-10-20
Status: accepted

## Context

The runtime (sessions, enforcement, daemon API) is TypeScript on Node 22. The desktop shell is
Tauri (Rust), the Android app is Tauri for Android, the cloud runner is headless. The UI
(`apps/ui`) talks only to the local daemon API (ADR 0011) and expects the shell to inject the
daemon address and token as `window.__FORERUNNER__` (ADR 0025). The spec leaves open how the
Node runtime ships and who starts it.

## Decision

- **One daemon per install, started by the install, not bundled into the shell.** The fresh
  install (scripts/fresh-install.*) installs Node 22 and the repository; `fr daemon` is the
  runtime process. It binds 127.0.0.1 only and writes `<runtime dir>/daemon.json` (url, token,
  pid, version, startedAt) with mode 0600.
- **The desktop shell attaches.** On start it resolves the same app directories as
  `appDirs()` (FORERUNNER_HOME override, else the OS user directories), reads `daemon.json`,
  checks `GET /health`; if the file is missing or the health check fails it starts `fr daemon`
  itself (the `fr` entry of the install, found through `FORERUNNER_INSTALL_DIR`, the install
  record written by `fr setup`, or PATH; argv arrays, never a shell string) and waits for a
  fresh `daemon.json`. It then injects `window.__FORERUNNER__ = { daemonUrl, daemonToken,
  installId, platform, shellVersion }` through Tauri's initialization script before the UI
  loads. The token never appears in the shell's logs. The tray menu offers the kill switch,
  "pause email" and "Update and restart"; closing the window keeps the daemon running.
- **The Android app does not talk to the daemon.** It pairs with the shared state service
  (ADR 0009, ADR 0024) and sends remote commands (switch project, raise a budget, start a
  session on the PC) through it; the PC's daemon executes them. The UI build for Android uses
  the state service client instead of the daemon client for those screens.
- **The cloud runner runs the same runtime headless** (`services/cloud-runner`): it composes
  the runtime against the shared Postgres state, unlocks its vault blob with the key the
  human's device releases, and watches the agent mailbox for email commands.
- **Restart contract.** "Update and restart" writes `<runtime dir>/restart.json` and the daemon
  exits with the restart code; the shell (or the user service on a headless install) restarts it
  with the new `current.json` pointer (ADR 0015). The code is **86** (`RESTART_EXIT_CODE` in
  `packages/runtime/src/daemon/restart.ts`, ADR 0029) and `restart.json` carries it as
  `exitCode`, so a shell follows the file rather than a constant; the 75 this ADR first named
  was never implemented, and the desktop shell accepts both when the file carries none (ADR 0031). The user service is optional: `fr daemon --install-service`
  registers a systemd user unit on Linux and a Scheduled Task on Windows; both only run `fr
  daemon`.

## Consequences

- The shell is thin and the runtime is testable without Tauri; the UI already runs against the
  daemon through Playwright.
- A machine without the install cannot run the shell alone; the setup guide says so.
- The shells must mirror the app-directory logic in Rust; a test compares both against the
  same fixture environments.

## Alternatives considered

- Bundling Node as a Tauri sidecar: doubles the artefact size, complicates updates (two things
  to sign and roll back) and still needs the install's `node_modules`.
- Compiling the runtime to a single binary: not supported for the native SQLite and keyring
  dependencies on both OSes today.
