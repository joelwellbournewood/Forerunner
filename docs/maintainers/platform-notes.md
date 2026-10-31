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
a new code is added to the union here. Recent ones: `provider_usage_limit` (ADR 0100), a
credential whose plan or account limit is reached (another credential may serve; distinct from
the short-lived `provider_rate_limit`); `identity_ambiguous` (ADR 0082), an
install on a state store holding several humans that names none of them;
`MEMORY_SCOPE_VIOLATION` (ADR 0083, spelled as ADR 0002 names it), a private-memory row about
to enter a shared store; and `secret_reserved` (ADR 0065, amended 2026-10-25), a reserved secret
name (`forerunner.*`, the install wrapping key) in a grant, a run token or a `secret:` reference,
which the daemon and the state service answer with 403.

**Network errors (`src/net-errors.ts`, U-053).** `describeNetworkError(e, secrets)` turns a
request that got no answer into words a person can act on. Node's fetch throws `TypeError("fetch
failed")` and keeps what happened in `cause`; the helper walks the cause chain, names the kind
(DNS `ENOTFOUND`/`EAI_*`, refused, timed out, offline, a certificate a proxy or antivirus put in
front, a proxy's refusal, a cut connection) and keeps the code and the innermost message,
`redact()`ed and with each of `secrets` cut out. An error about a header value (a credential with
a line break, which fetch quotes in full) is described without the value. Used by the setup
validators, the Messages adapter's connection errors and `GitHubHost`.

| Concern | Windows | Linux | Where |
| --- | --- | --- | --- |
| App directories | `%APPDATA%\forerunner\config`, `%LOCALAPPDATA%\forerunner\{data,cache,logs}` | XDG: `~/.config/forerunner`, `~/.local/share/forerunner`, `~/.cache/forerunner`, `~/.local/state/forerunner/logs` | `paths.appDirs` (override: `FORERUNNER_HOME`) |
| Path separators | `\` | `/` | `paths.join`, `toPosix`, `fromPosix`; CI greps for hand-built paths |
| Line endings | normalised to LF on write | LF | `paths.normalizeNewlines`, `.gitattributes` |
| Spawning | `.cmd`/`.bat` files and the bare shim names (npm, pnpm, npx, yarn, tsx, corepack, found as cmd finds them: the working folder, then `PATH` with `PATHEXT`; an `.exe` found first runs directly) go through `cmd.exe /d /s /c "<script> <args>"`, passed verbatim: the script's path escaped with `^`, each argument quoted with the C runtime's rules and its cmd metacharacters escaped with `^` twice (cmd's parse, then the batch file's own parse of `%*`), so `&`, `\|`, `%VAR%` and quotes arrive unchanged (U-068); an argument with a line break is refused | direct exec | `shell.spawnProcess`, `cmdArgv`, `escapeCmdArgument`, `resolveWindowsCommand` |
| Killing a tree | `taskkill /T /F` | `kill -9 -pgid`, fallback to pid | `shell.killTree` |
| A killed command's return | `run()` resolves at the child's `exit` once it killed it (time limit or abort), with the stdio streams destroyed, instead of waiting for `close`, which a grandchild holding the inherited pipes (git's remote helper) would keep open; a command that ends by itself still resolves at `close` with all its output | same | `shell.run` |
| Finding binaries | `where` | `command -v` | `shell.which` |
| A lock held for a process's lifetime | `<dir>\<name>` opened with an exclusive share mode (libuv `UV_FS_O_EXLOCK`, `0x10000000`): any other open is `EBUSY` | a listening Unix socket in the abstract namespace named after the lock file's real path and a random key in `<name>.key` (0600) (`EADDRINUSE` on a second bind); the file only records the holder's pid | `lock.acquireExclusiveLock` (U-065); macOS: an exclusive-create pid file, stale when its pid is gone |
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

### Locks (`src/lock.ts`)

`acquireExclusiveLock(dir, name)` gives one process a lock for as long as it runs; the
operating system releases it when the process ends, a crash or a kill included, so no recorded
pid has to be trusted and nothing is left behind (the daemon's one-per-data-folder lock, U-065).
A held lock is `ForerunnerError("unavailable")` with `details.reason` `"locked"` and the
lock file's path; `release()` is idempotent. The Linux socket is unreferenced (it never keeps
the process alive) and not inherited by children (Node opens sockets close-on-exec), so a tool
a daemon started cannot keep its lock after the daemon is gone; on Windows the handle is not
inherited either (libuv opens files non-inheritable). Linux names the socket by the real path
of the folder, so two spellings of one folder share a lock, and by a random key kept in
`<name>.key` (mode 0600, created once and exclusively, `lockKey`): an abstract socket has no
permissions, so a name another local user could work out from the path alone could be taken
by them first and keep this user's daemon from starting. A damaged key file is replaced. The
socket is per network namespace, which only matters inside containers.

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

`packages/platform/test/*.test.ts` run on both CI runners. `shell-cmd.test.ts` (U-068) pins
the cmd escaping as pure units (`a&b`, `%PATH%`, `x"y`, trailing backslashes, the script's
path, the line break refused, which commands go through cmd) and on Windows sends `a&b`,
`a|b`, `%PATH%`, `x"y`, `x"&calc` and more through a real `.cmd` in a folder named `R&D x`
that hands `%*` to node, as npm's shims do: every argument comes back unchanged. `lock.test.ts` takes a lock twice
in one process (refused until released), per folder and name, and across processes: a child
holds it, this process is refused, the child is killed, and the lock is free again. Path tests pass `platform` explicitly
so Windows behaviour is checked on Linux too and the other way round. `shell.test.ts` runs
node through `run()`: argv passed verbatim, the exit code, the output cap, the wall-clock limit,
and the limit holding while a grandchild that inherited the pipes lives on (`run()` returns at
the killed child's exit, not at the grandchild's). `log.test.ts` covers the
known shapes and the key-name rule; `security-log.test.ts` is the security review's set: a token
in the message, nested data, an array and an error string, a connection string's password,
other credential-like key names, a token nested deeper than eight levels, a throwing sink.
`security-log-critic.test.ts` holds the security critic's follow-ups on that fix: the password
of a connection string with an empty user (`redis://:password@host/0`, `amqp://:pw@h`),
upper-case `*_KEY` names, the key-name rule in every case (`PRIVATE_KEY`, `Private_Key`,
`signingKey`, `signingKEY`) with the public-key exception and the plain words (`monkey`,
`MONKEY`) that stay. `clock.test.ts` covers `SimulatedClock`: timers in order, timers scheduled by
timers, never backwards, and `nextTimerIn()` (how far away the next timer is, null when none;
tests that drive a composed runtime step the clock to the next timer and no further, and yield
real time while nothing is pending, so real IO is never overtaken by simulated time).

## Known issues

- `isSecretKeyName` masks an all-capitals key name with no separator (`PRIVATEKEY`,
  `SIGNINGKEY`) by failing closed, so a plain capitals word ending in KEY that is not on the
  `PLAIN_CAPS_KEY_WORD` list (`MONKEY`, `TURKEY`, `HOTKEY`, ...) has its value masked in logs
  too. That costs a log value, never a credential; add the word to the list when it matters.
- `shell.killTree` on Linux only kills the process group when the child was started detached;
  otherwise it falls back to the direct pid. The runtime starts sandboxes detached. A
  grandchild of a command `run()` killed at its limit (git's `git-remote-https`, say) may
  therefore outlive the command; the runner no longer waits for it, and the output such a
  grandchild writes after the kill is dropped.
- Wayland: desktop control is limited to what the xdg-desktop-portal allows.
