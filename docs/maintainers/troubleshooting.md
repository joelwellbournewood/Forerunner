# Troubleshooting

Common failures on a developer machine, a fresh install or a CI runner, with the cause and the
fix. Each entry: symptom, cause, fix. Add an entry whenever a failure cost someone more than ten
minutes; link the entry from the error message when the code can.

## Purpose

`pnpm fr doctor` reports the prerequisites (Node, git, pnpm, container engine, vault, config)
and is the first thing to run. `pnpm fr status` shows the directories and which secret names
exist. This file covers what those two cannot fix on their own.

## How it works

### 1. `pnpm install --frozen-lockfile` fails with `ERR_PNPM_OUTDATED_LOCKFILE`

**Symptom.** CI or `fresh-install` stops at the install step; the message names a package whose
specifier in a `package.json` is not in `pnpm-lock.yaml`.
**Cause.** A dependency was added or changed without updating the lockfile (or the lockfile was
edited by hand). CI always uses `--frozen-lockfile`.
**Fix.** Locally run `pnpm install` (no flag) with the same pnpm version
(`corepack prepare pnpm@<version in package.json> --activate`), commit `pnpm-lock.yaml`, rerun.
Never commit a lockfile produced by a different pnpm major.

### 2. `ExperimentalWarning: SQLite is an experimental feature`

**Symptom.** Node prints the warning on every start of the CLI, the tests or the daemon.
**Cause.** `node:sqlite` is marked experimental in Node 22. `@forerunner/state` installs a
filter (`silenceSqliteExperimentalWarning()`) when it opens a database; anything that imports
`node:sqlite` before that, or a tool that spawns Node without going through the state package,
still prints it.
**Fix.** Harmless. To silence it in a script, run Node with `--no-warnings=ExperimentalWarning`
(Node 22.13+) or open the store through `@forerunner/state` first. Do not set `NODE_NO_WARNINGS=1`
globally; it hides deprecations the tests rely on.

### 3. Integration tests fail: `ECONNREFUSED 127.0.0.1:5432` or `FORERUNNER_TEST_PG is not set`

**Symptom.** `pnpm test:integration` skips every Postgres test with a visible reason, or fails
connecting.
**Cause.** No Postgres on port 5432, or the test database/password is not the one the tests
expect (`postgres://postgres:forerunner@localhost:5432/forerunner_test`).
**Fix (Linux).** `bash scripts/dev-postgres.sh` starts one (Docker `forerunner-pg`, else the
local cluster through `pg_ctlcluster`/`systemctl`/`pg_ctl`), creates the database, sets the
password and prints the `export FORERUNNER_TEST_PG=…` line. `--status` only checks.
**Fix (Windows).** `pwsh -File scripts/dev-postgres.ps1` does the same with Docker Desktop or
the `postgresql*` Windows service / `pg_ctl` (`$env:PGBIN`, `$env:PGDATA`); if the preinstalled
server has another superuser password, set `$env:PGPASSWORD` first. Then set
`$env:FORERUNNER_TEST_PG` as printed. The CI job on `windows-latest` uses the runner's
preinstalled server exactly this way (`.github/workflows/ci.yml`).

### 4. Tauri build on Linux: `Package webkit2gtk-4.1 was not found` / `javascriptcoregtk-4.1`

**Symptom.** `cargo check` or `tauri build` fails in `pkg-config` with a missing `.pc` file.
**Cause.** The WebKitGTK and GTK development packages are not installed; the fresh-install
script only installs them with `--with-desktop`.
**Fix.** `bash scripts/fresh-install.sh --non-interactive --with-desktop`, or directly:
Ubuntu/Debian `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev
libayatana-appindicator3-dev librsvg2-dev patchelf libasound2-dev libxdo-dev build-essential
libssl-dev`; Fedora `sudo dnf install -y webkit2gtk4.1-devel gtk3-devel
libappindicator-gtk3-devel librsvg2-devel patchelf alsa-lib-devel libxdo-devel openssl-devel`.
Ubuntu 22.04 is the oldest supported release (`webkit2gtk-4.1` is not on 20.04).

### 5. Headless Linux: `OS keyring unavailable, falling back to the encrypted file vault`

**Symptom.** `fr setup`, the tests or the runner log a WARN with a DBus error
(`DBUS_SESSION_BUS_ADDRESS` not set, `org.freedesktop.secrets` missing) and continue.
**Cause.** The Secret Service (GNOME Keyring, KWallet) needs a session bus and a running
daemon; containers, SSH sessions and CI runners have neither.
**Fix.** Nothing to fix for CI, the cloud runner or tests: the vault uses
`appDirs().config/vault.<profile>.json` encrypted with a device key (`security.md`). On a desktop
without a keyring daemon, install and unlock one (`gnome-keyring-daemon --start`, or
`secret-tool` to check), or pin the file backend with `FORERUNNER_VAULT_BACKEND=file`. Secrets
written to one backend are not visible from the other; pick one before running `fr setup`.

### 6. Fake git host tests: `git-http-backend not found`

**Symptom.** Integration tests that clone from or push to the fake git host fail at start with
this message, or git reports `fatal: unable to access … 502`.
**Cause.** The stand-in serves repositories through git's own `git-http-backend` CGI program,
which lives next to git's other helpers (`git --exec-path`), not on `PATH`. Minimal git
installs (Alpine `git` without `git-daemon`, some Windows portable builds) leave it out.
**Fix.** Install a full git: Ubuntu/Debian `apt-get install git` (the helper is in the main
package), Alpine `apk add git git-daemon`, Fedora `dnf install git-core`, Windows the Git for
Windows installer (`C:\Program Files\Git\mingw64\libexec\git-core\git-http-backend.exe`). Check
with `ls "$(git --exec-path)" | grep http-backend`.

### 7. `Cannot connect to the Docker daemon` / `docker: command not found`

**Symptom.** Sandboxed tasks, `dev-postgres`, the sandbox tests or `fr doctor` report no
container engine.
**Cause.** Docker is not installed, the daemon is stopped, or the user is not in the `docker`
group (Linux) / Docker Desktop is not running (Windows).
**Fix.** Linux: `sudo systemctl start docker` and `sudo usermod -aG docker $USER` (log out and
in), or use rootless Podman (`podman` is detected the same way). Windows: start Docker Desktop
(WSL 2 backend) or Podman Desktop. Without any engine the runtime uses the process sandbox
stand-in (ADR 0007) and tests that need a daemon skip with a visible reason; CI records that in
the job summary.

### 8. Windows: `ENAMETOOLONG`, `Filename too long` or `EPERM` deep inside `node_modules`

**Symptom.** `pnpm install`, `git checkout` or a Tauri build fails on a path longer than 260
characters.
**Cause.** Windows path length limit; pnpm's content-addressed store and Rust target
directories nest deeply.
**Fix.** Enable long paths once: `git config --global core.longpaths true` (the fresh-install
script does this) and, as administrator,
`New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`
then reboot. Keep the checkout short (`C:\src\forerunner`, not under OneDrive). pnpm 10 uses
`C:\Users\<you>\AppData\Local\pnpm\store` by default; `pnpm config set store-dir C:\pnpm-store`
shortens it further.

### 9. PowerShell: `scripts\fresh-install.ps1 cannot be loaded because running scripts is disabled`

**Symptom.** Double-clicking or `.\scripts\fresh-install.ps1` fails with an execution-policy
error.
**Cause.** Windows PowerShell 5.1 defaults to `Restricted`; downloaded files also carry the
"mark of the web".
**Fix.** Run through the interpreter with a per-invocation policy:
`powershell -ExecutionPolicy Bypass -File scripts\fresh-install.ps1 -NonInteractive` (or
`pwsh -File …`, PowerShell 7 defaults to `RemoteSigned`). For a permanent change:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` and `Unblock-File scripts\*.ps1`. Both
`.ps1` files run under 5.1 and 7.

### 10. Behind a proxy or a corporate CA: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `ECONNRESET`, 407

**Symptom.** `pnpm install`, `corepack`, `git clone`, Rust's `cargo`, `apt-get` or the model
provider call fails with a TLS or proxy error; curl works in the browser but not in the shell.
**Cause.** Traffic must go through an HTTP proxy and/or the proxy re-signs TLS with a private
CA that Node, git and cargo do not trust by default.
**Fix.** Set `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` for the session (never commit them) and
point every tool at the CA bundle: Node and pnpm `NODE_EXTRA_CA_CERTS=/path/ca-bundle.crt`
(or `pnpm config set cafile …`), git `git config --global http.sslCAInfo /path/ca-bundle.crt`,
cargo `CARGO_HTTP_CAINFO=…`, apt `Acquire::https::Proxy` in `/etc/apt/apt.conf.d/`, Java
(`keytool`, Gradle) `JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStore=…` or import the CA into the
JDK's `cacerts`. Do not disable verification (`strict-ssl=false`, `GIT_SSL_NO_VERIFY`): the
secret scan and the security suite treat that as a finding. The runtime forwards the same
variables to sandboxes and the model provider client.

### 11. Installed app check: `upgrade with Forerunner running: msiexec exit 3010` (or 1603, or "still running from the install folder")

**Symptom.** The Windows installed-app check (`scripts/installed-check.ps1`, U-066) fails after
the self-test passed: the reinstall or the uninstall with Forerunner running ends with exit
3010 (files were in use; Windows wants a restart) or 1603, the step "the stop step failed", or
a process from the install folder is still listed afterwards.
**Cause.** The MSI's stop step (`apps/desktop/src-tauri/wix/stop-running.wxs`, run before
`InstallValidate`) did not end what runs from the install folder: its PowerShell failed (the
MSI log `upgrade-<n>.log` / `uninstall-<n>.log` under `RUNNER_TEMP\fr-installed-check` holds
`WixQuietExec64:` lines with the command and its output), the step did not run at all (no
`Doing action: StopRunningForerunner`), or a process holds a file it does not end.
**Fix.** Read the `WixQuietExec64` lines of that log first. A change to the step's script is
made in the `.wxs`, with every `[`, `]`, `{` and `}` of the PowerShell written `[\[]`, `[\]]`,
`[\{]`, `[\}]` (Windows Installer formats the property once); `scripts/msi-stop-running.test.ts`
formats it as Windows Installer does and fails on a reference it does not expect, and on Windows
runs it against real processes. Locally: install the MSI, start Forerunner, then
`msiexec /i <msi> REINSTALL=ALL REINSTALLMODE=amus /qn /l*v upgrade.log` and look for
`StopRunningForerunner` in the log.

## How to change it

Add entries at the end with the next number; keep the symptom line copyable from a terminal so
search finds it. When a fix is scriptable, put it in `scripts/` and reference it here instead
of pasting commands twice. Entries that stop applying are deleted, not kept "for history".

## Tests

The scripts referenced here are tested in `scripts/*.test.ts` (see `release.md`, "Tests").
`pnpm docs:links` checks the links in this file. There is no test for the prose; the handover
test (scenario 8) is where a missing entry shows up.

## Known issues

- Entries 2, 5 and 7 describe behaviour that depends on packages owned by other areas
  (`state`, `vault`, `runtime` sandbox); keep them in step with `security.md` and `runtime.md`.
- Proxy settings for the Tauri Android build (Gradle's `gradle.properties`
  `systemProp.https.proxyHost`) are not covered yet.
