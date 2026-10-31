# 0094 — Quit stops the background service; the installer stops what runs from the install folder

Date: 2026-10-31
Status: accepted (amends ADR 0026 and ADR 0031)

## Context

ADR 0026 and ADR 0031 kept the daemon running after the desktop shell ended: closing the window
hid it to the tray, and Quit ended the shell only ("Quit (the daemon keeps running)"). The shell
never stopped the daemon, except for one older than the runtime the app carries (ADR 0092).

Since ADR 0092 the daemon is the bundled `node.exe` under `<install>\runtime`. While it runs,
Windows refuses to replace or delete those files. In 1.0.4 the owner could not delete the
install folder or install the next version over it after "closing" Forerunner (U-018).

The owner was told what a daemon that outlives the window gives: sessions continue, scheduled
work runs, the phone app and email commands reach the PC, and the next start is faster. The
owner chose: the close button keeps the app in the tray, and Quit stops everything.

## Decision

- **Close** still hides the window to the tray, and the shell and daemon keep running. The
  first close shows a notification saying so and how to stop it (marker `<config>/tray-hint-shown`).
- **Quit Forerunner** (the tray item) stops the daemon and everything it started, then ends the
  shell:
  - while a session runs, it asks first ("Quit and stop" or Cancel) and suggests closing the
    window instead;
  - it posts `POST /shutdown`. The daemon stops every run and the processes those runs started
    (as the kill switch does, but it writes no `kill.json`, so the next start is not stopped),
    answers 202, then closes the server and the runtime and exits 0. Exit 0 means "stopped on
    purpose" to every supervisor, so nothing restarts it;
  - when `/health` still answers 15 s later, or the daemon has no `/shutdown` (1.0.4 and
    older), the shell ends the process tree: the pid in `daemon.json` and the pid it spawned,
    with `taskkill /T /F` on Windows and `kill -TERM` elsewhere. Pids are ended only while the
    daemon still answers, so a stale `daemon.json` never ends an unrelated process.
  - It stops a daemon the shell did not start (a user service's) as well: Quit means stop.
- **The Windows installer**, before `InstallValidate` (the files-in-use check), on upgrade and
  on uninstall, ends every process whose executable is under `[INSTALLDIR]`
  (`apps/desktop/src-tauri/wix/stop-running.wxs`, linked through `componentRefs`). This covers
  an older version that is still running, the 1.0.4 daemon included. It is an immediate custom
  action (it runs as the person installing) with `Return="ignore"`, so it never fails an install.
  It targets only the install folder, never every `node.exe`.

## Consequences

- After Quit, nothing of Forerunner runs: the folder can be deleted and a new version
  installed. Sessions, schedules, phone commands and email commands wait until it is opened
  again.
- People who want the agent working in the background close the window instead of quitting.
  The first-close notice and the Quit question say so.
- `POST /shutdown` is a new daemon route (`DAEMON_ROUTES.shutdown`). It needs the bearer token,
  and an embedded daemon without an `onShutdown` refuses it with 409.

## Alternatives considered

- The close button quits everything: the simplest model, but it would end long sessions every
  time someone closes the window. Not chosen by the owner.
- Keep the daemon running and only stop it during installs: the folder still could not be
  deleted, and people would still not know it runs.
- WiX `util:CloseApplication` by image name: it ends every `node.exe` on the machine, including
  the person's own Node programs.

## Amendment (2026-10-31, U-062): Quit ends the process the shell started, whatever its state

Quit ended nothing when no daemon answered: during the first start (the splash, before
`daemon.json` exists) and while the daemon hung, the process the shell had started kept running,
and a second launch, a deep link or the hotkey during Quit could show a window on the dying
daemon or start a new one.

- The process the shell started (`child_pid`) is ended with everything under it even when there
  is no `daemon.json` or `/health` does not answer: `taskkill /T /F` on Windows, `kill -s TERM`
  to its process group elsewhere (`KILL` after 5 s). That pid is the shell's own child, recorded
  only while the shell holds its `Child` and cleared once it was reaped, so it cannot name an
  unrelated process. A pid read from `daemon.json` is still ended only while the daemon answers.
  After the daemon stopped, Quit waits up to 10 s for that child to end, then ends its tree.
- While Quit runs nothing attaches, starts a daemon or shows a window (`ShellState.quitting` is
  checked by `show_main`, `bootstrap` and `attached`); a start that raced Quit ends the child it
  just spawned, and an error dialog of an interrupted start is only logged.
- A second launch during Quit (a deep link included) is remembered: once the daemon has stopped
  the app restarts (`request_restart`) instead of exiting. The link itself is not carried over;
  the restarted app opens at its start page.
