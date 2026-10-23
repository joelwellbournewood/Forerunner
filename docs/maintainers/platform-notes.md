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
`authorization`, `cookie`, any `*_key` / `*-key` / bare `key` in any case (`private_key`,
`PRIVATE_KEY`, `Private_Key`, `SIGNING_KEY`, the env-style names of a dumped `process.env`),
and the camel-case `*Key` / `*KEY` after a lower-case letter or digit (`vaultKey`,
`signingKEY`), except a public key (`public_key`, `PublicKey`), which is an identifier; a word
that merely ends in "key" (`monkey`, `MONKEY`) is not a credential, which is why the
camel-case form needs that case switch before the suffix, and why an all-capitals name with
no separator (`PRIVATEKEY`, `DEPLOYKEY`) is not matched by name (see Known issues). The two
rules are pinned by
`test/security-log-critic.test.ts` (verified 2026-10-23: `PRIVATE_KEY`, `Private_Key`,
`signingKEY`, `redis://:password@host/0` and `amqp://:pw@h` are masked; `public_key` and
`monkey` stay). There is no depth at which data passes in clear: a cycle is cut with
`[Circular]` and a subtree deeper than 64 levels becomes `[TRUNCATED]`. Sinks are isolated:
one that throws never stops the others or the caller. `pnpm secrets:scan` checks the
repository and the logs afterwards.

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
of a connection string with an empty user (`redis://:password@host/0`, `amqp://:pw@h`),
upper-case `*_KEY` names, the key-name rule in every case (`PRIVATE_KEY`, `Private_Key`,
`signingKey`, `signingKEY`) with the public-key exception and the plain words (`monkey`,
`MONKEY`) that stay.

## Known issues

- `isSecretKeyName` has no rule for an all-capitals key name with no separator (`PRIVATEKEY`,
  `SIGNINGKEY`, `DEPLOYKEY`): nothing tells such a name from `TURKEY` or `HOTKEY`, so only the
  value-shape patterns (a PEM block, a known token prefix, a long base64 run next to the word
  "key") catch its value; `APIKEY` is matched by `SECRET_KEY_NAME`. Write env names with the
  underscore (`PRIVATE_KEY`). A rule for the bare form would mask every plain word in
  capitals, which `security-log-critic.test.ts` pins as staying.
- `shell.killTree` on Linux only kills the process group when the child was started detached;
  otherwise it falls back to the direct pid. The runtime starts sandboxes detached.
- Wayland: desktop control is limited to what the xdg-desktop-portal allows.
