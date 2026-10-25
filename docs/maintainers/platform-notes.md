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

**Errors (`src/errors.ts`).** Every package throws `ForerunnerError` with a stable `code`
from the `ErrorCode` union, so the UI, logs and tests match on the code, never the message;
a new code is added to the union here. The latest two: `identity_ambiguous` (ADR 0082), an
install on a state store holding several humans that names none of them, and `secret_reserved`
(ADR 0065, amended 2026-10-25), a reserved secret name (`forerunner.*`, the install wrapping
key) in a grant, a run token or a `secret:` reference; the daemon and the state service answer
it with 403.

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
`signingKEY`), and an all-capitals `*KEY` with no separator (`PRIVATEKEY`, `DEPLOYKEY`,
`SSH_HOSTKEY`), except a public key (`public_key`, `PublicKey`, `PUBLICKEY`), which is an
identifier; a word that merely ends in "key" (`monkey`) is not a credential, which is why the
camel-case form needs that case switch before the suffix. Nothing tells an all-capitals name
from a plain word in capitals, so that rule fails closed: only a short list of plain words
(`MONKEY`, `TURKEY`, `HOCKEY`, `DONKEY`, `JOCKEY`, `WHISKEY`, `HOTKEY`, `LACKEY`) stays and any
other capitals word ending in KEY is masked (review of 2026-10-23; it was left unmasked
before). The rules are pinned by
`test/security-log-critic.test.ts` (verified 2026-10-23: `PRIVATE_KEY`, `Private_Key`,
`signingKEY`, `PRIVATEKEY`, `DEPLOYKEY`, `redis://:password@host/0` and `amqp://:pw@h` are
masked; `public_key`, `PUBLICKEY`, `monkey` and `MONKEY` stay). There is no depth at which data passes in clear: a cycle is cut with
`[Circular]` and a subtree deeper than 64 levels becomes `[TRUNCATED]`. Sinks are isolated:
one that throws never stops the others or the caller. `pnpm secrets:scan` checks the
repository and the logs afterwards.

### Errors (`src/errors.ts`)

`ForerunnerError` carries a stable `code` from the `ErrorCode` union, `details` and `retryable`;
`isForerunnerError(e, code?)` matches on it. Codes are lower-case snake names except
`MEMORY_SCOPE_VIOLATION`, spelled as ADR 0002 names it: a private-memory row headed for a shared
store, thrown by `packages/state`'s `LessonRepo` on the Postgres dialect and by the memory
package's by-scope store (ADR 0083).

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

- `isSecretKeyName` masks an all-capitals key name with no separator (`PRIVATEKEY`,
  `SIGNINGKEY`) by failing closed, so a plain capitals word ending in KEY that is not on the
  `PLAIN_CAPS_KEY_WORD` list (`MONKEY`, `TURKEY`, `HOTKEY`, ...) has its value masked in logs
  too. That costs a log value, never a credential; add the word to the list when it matters.
- `shell.killTree` on Linux only kills the process group when the child was started detached;
  otherwise it falls back to the direct pid. The runtime starts sandboxes detached.
- Wayland: desktop control is limited to what the xdg-desktop-portal allows.
