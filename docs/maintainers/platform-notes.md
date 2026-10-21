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

### Logging (`src/log.ts`)

`Logger` redacts before any sink sees a record (spec S.4 "logs are scanned and redacted").
`redact(text)` masks known credential shapes (Anthropic, GitHub, GitLab, Slack and AWS keys,
PEM private keys, `Bearer` tokens, `password=` / `token:` style assignments, long base64 next
to a secret-like word) and the password of a connection string (`scheme://user:password@host`
keeps scheme, user and host; the user may be empty, as in `redis://:password@host` or
`amqp://:password@host`). `redactDeep(data)` applies it to every string at any depth and
replaces the value under a secret-named key whatever its shape: `isSecretKeyName` matches
`secret`, `token`, `password`, `passwd`, `passphrase`, `credential(s)`, `api_key`,
`authorization`, `cookie`, and any `*_key` / `*-key` / `*Key` / bare `key` in any case
(`private_key`, `SIGNING_KEY`, `vaultKey`, the env-style names of a dumped `process.env`),
except a public key, which is an identifier; a word that merely ends in "key" (`monkey`) is
not a credential, which is why the camel-case form keeps its capital `K`. There is no depth at which data
passes in clear: a cycle is cut with `[Circular]` and a subtree deeper than 64 levels becomes
`[TRUNCATED]`. Sinks are isolated: one that throws never stops the others or the caller.
`pnpm secrets:scan` checks the repository and the logs afterwards.

## How to change it

Add the OS-specific branch inside `packages/platform`, export a neutral function, and add a test
that exercises both branches by passing `platform`/`env` explicitly (see `test/paths.test.ts`).

## Tests

`packages/platform/test/*.test.ts` run on both CI runners. Path tests pass `platform` explicitly
so Windows behaviour is checked on Linux too and the other way round. `log.test.ts` covers the
known shapes and the key-name rule; `security-log.test.ts` is the security review's set: a token
in the message, nested data, an array and an error string, a connection string's password,
other credential-like key names, a token nested deeper than eight levels, a throwing sink.
`security-log-critic.test.ts` holds the security critic's follow-ups on that fix: the password
of a connection string with an empty user, upper-case `*_KEY` names, the key-name rule in
every case with the public-key exception.

## Known issues

- `shell.killTree` on Linux only kills the process group when the child was started detached;
  otherwise it falls back to the direct pid. The runtime starts sandboxes detached.
- Wayland: desktop control is limited to what the xdg-desktop-portal allows.
