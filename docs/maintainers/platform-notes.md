# Platform notes

Windows 10/11 and Linux (Ubuntu 22.04+, Fedora) are first class. macOS is best effort. Android
10+ is a client only. This file lists where the two desktop platforms differ and how
`@forerunner/platform` hides it.

## Purpose

`packages/platform` is the only package allowed to know about OS differences. Everything else
imports from it: `paths` (join, toPosix, appDirs, safeSegment), `shell` (run, killTree, which),
`clock` (SystemClock, SimulatedClock), `os` (currentPlatform, osFacts), `log` (Logger with
redaction), `ids`, `errors`.

## How it works

| Concern | Windows | Linux | Where |
| --- | --- | --- | --- |
| App directories | `%APPDATA%\forerunner\config`, `%LOCALAPPDATA%\forerunner\{data,cache,logs}` | XDG: `~/.config/forerunner`, `~/.local/share/forerunner`, `~/.cache/forerunner`, `~/.local/state/forerunner/logs` | `paths.appDirs` (override: `FORERUNNER_HOME`) |
| Path separators | `\` | `/` | `paths.join`, `toPosix`, `fromPosix`; CI greps for hand-built paths |
| Line endings | normalised to LF on write | LF | `paths.normalizeNewlines`, `.gitattributes` |
| Spawning | `.cmd` shims (npm, pnpm, npx, tsx) go through `cmd.exe /d /s /c` with argv passed verbatim | direct exec | `shell.spawnProcess` |
| Killing a tree | `taskkill /T /F` | `kill -9 -pgid`, fallback to pid | `shell.killTree` |
| Finding binaries | `where` | `command -v` | `shell.which` |
| Keychain | Credential Manager | libsecret (GNOME Keyring, KWallet) | `vault` (see security.md) |
| Display server | win32 | wayland or x11 from env | `os.osFacts` (desktop control limits on Wayland) |
| Shell for user scripts | PowerShell | sh | `scripts/*.ps1` and `*.sh` pairs |

## How to change it

Add the OS-specific branch inside `packages/platform`, export a neutral function, and add a test
that exercises both branches by passing `platform`/`env` explicitly (see `test/paths.test.ts`).

## Tests

`packages/platform/test/*.test.ts` run on both CI runners. Path tests pass `platform` explicitly
so Windows behaviour is checked on Linux too and the other way round.

## Known issues

- `shell.killTree` on Linux only kills the process group when the child was started detached;
  otherwise it falls back to the direct pid. The runtime starts sandboxes detached.
- Wayland: desktop control is limited to what the xdg-desktop-portal allows.
