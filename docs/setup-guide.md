# Forerunner setup guide

How to install Forerunner on Windows or Linux, get through the first run, pair your phone, know
where your data lives, and remove it again. This guide is attached to every release. Sections
marked "coming in this release" describe features whose final shape lands with a later
milestone of the 1.0 build; the steps there are the ones already in place.

## What you need

- A PC with Windows 10/11 (64-bit) or Linux (Ubuntu 22.04 or newer, Debian 12, Fedora 39 or
  newer). macOS is best effort and not covered here.
- An Anthropic API key or a Claude subscription (`claude setup-token`), for the models.
- A GitHub account with a fine-grained personal access token for the repositories your agent
  will work on. The first-run wizard tells you the exact scopes and where to click.
- Optional: Docker Desktop (Windows) or Docker/Podman (Linux) so coding tasks run in a sandbox.
  Without it, Forerunner still works; tasks run in a process sandbox with fewer guarantees.

## Install on Windows

1. Download `Forerunner_<version>_x64_en-US.msi` and `SHA256SUMS.txt` from the release page.
2. Optional but recommended: check the download. In PowerShell,
   `Get-FileHash .\Forerunner_<version>_x64_en-US.msi -Algorithm SHA256` and compare with the
   line in `SHA256SUMS.txt`.
3. Run the MSI. If the release notes say the installer is unsigned (no code-signing certificate
   was available for that release), SmartScreen shows "Windows protected your PC": choose
   "More info", then "Run anyway". A signed release does not show this.
4. Forerunner starts from the Start menu. It needs the WebView2 runtime, which Windows 11 has
   and the installer adds on Windows 10.

Developer install from source (also what our CI times on a clean machine):

```powershell
git clone <your fork or the repository URL> forerunner
cd forerunner
pwsh -File scripts\fresh-install.ps1 -NonInteractive   # or: powershell -ExecutionPolicy Bypass -File ...
```

It installs Node.js 22 (winget or Chocolatey) and pnpm if missing, installs dependencies, runs
the checks and creates the application folders. It prints every step with its time; the whole
run must stay under 15 minutes.

## Install on Linux

**AppImage (any distribution).** Download `forerunner_<version>_amd64.AppImage` and
`SHA256SUMS.txt`, verify with `sha256sum -c SHA256SUMS.txt --ignore-missing`, then
`chmod +x forerunner_*.AppImage && ./forerunner_*.AppImage`. No installation step; move the
file where you like. The AppImage needs `libfuse2` on some distributions
(`sudo apt-get install libfuse2`).

**Debian / Ubuntu package.** `sudo apt-get install ./forerunner_<version>_amd64.deb` installs
the app, its desktop entry and the WebKitGTK dependencies. Remove with
`sudo apt-get remove forerunner`.

**Fedora.** Use the AppImage (an RPM is not part of this release).

Developer install from source:

```bash
git clone <your fork or the repository URL> forerunner
cd forerunner
bash scripts/fresh-install.sh --non-interactive          # add --with-desktop to build the app itself
```

The script uses `apt` or `dnf` (whichever exists) to add Node.js 22 when it is missing, and
`sudo` only for that. Everything else is installed under your user.

## First run

The first start opens the setup wizard (the same thing as `pnpm fr setup` from a source
checkout). It never asks for something without saying what it is for:

1. **You.** Your name and time zone (used for the daily schedule and summaries).
2. **GitHub.** A fine-grained token. The wizard lists the exact permissions (contents, pull
   requests, issues, metadata) and the repositories to allow, with a link to the page where you
   create it. It checks the token the moment you paste it and tells you which repositories it can
   reach. Nothing is stored until the check passes.
3. **Models.** Your Anthropic API key or subscription token, verified the same way. You can set
   both; routing prefers the subscription and falls back to the key.
4. **Budget.** The monthly cap and the per-session cap (defaults CHF 150 and CHF 5). These are
   enforced by the program, not by the agent: a session that would exceed them stops.
5. **Where to work.** Connect sources: GitHub organisations or accounts, chosen repositories,
   local folders. A scan proposes a project per repository (coming in this release: import of
   ZIP files and folders).

Credentials go into the operating system's credential store (Windows Credential Manager, or
GNOME Keyring / KWallet on Linux). They are never written to the configuration file, the
project repositories or the logs. You can re-run the wizard at any time from Settings or with
`fr setup`; skipped steps can be completed later.

Your agent then creates its first project plan from the brief you give it and shows the plan for
approval before it does anything.

## Pairing the phone (coming in this release)

The Android app (`forerunner-<version>.apk` on the release page) is installed by sideloading:
allow "Install unknown apps" for your browser or file manager, open the APK. Releases without a
distribution keystore are signed with a development key; Android shows the usual warning for
sideloaded apps.

Pairing: on the PC open Settings → Devices → "Pair a phone" and scan the QR code with the app.
Each phone gets its own key and token, listed under Devices, and can be revoked from the PC at
once (lost phone). The phone never holds your credentials or private memory; it talks to the
shared state service with a scoped token. From the phone you can chat and talk with your agent,
approve requests, add notes and tasks, start or stop sessions on your PC, and follow the live
session log.

## Where your data lives

| | Windows | Linux |
| --- | --- | --- |
| Settings, device identity, pairing | `%APPDATA%\forerunner\config` | `~/.config/forerunner` |
| Project state, memory, documents, audit log | `%LOCALAPPDATA%\forerunner\data` | `~/.local/share/forerunner` |
| Cache (compressed context, model lists, downloads) | `%LOCALAPPDATA%\forerunner\cache` | `~/.cache/forerunner` |
| Logs | `%LOCALAPPDATA%\forerunner\logs` | `~/.local/state/forerunner/logs` |
| Working copies for tasks | `%LOCALAPPDATA%\forerunner\worktrees` | `~/.local/share/forerunner/worktrees` |
| Credentials | Credential Manager, entries `forerunner-<profile>` | Keyring, service `forerunner-<profile>` |

Setting `FORERUNNER_HOME` moves all of it under one folder (used to run two installs on one
machine for testing). `fr dirs` prints the folders in use. Updates never touch these folders.

Your code and project documents live in git on the host you connected (GitHub), not in
Forerunner's folders; the shared state used by two people's agents lives in the state service
you point both installs at.

## Updating

Releases are published on GitHub. Forerunner never checks for updates on its own. Open
**Updates** in the sidebar and press **Check for updates**; if a newer release is out, the
screen shows "Update available" with its changelog and an **Update and restart** button. The
update is downloaded, its signature and checksum verified against the project's update key
(built into every install), installed, and rolled back automatically if the new version fails
its start-up health check. Nothing is installed until you press that button. A fork or a
private build points at its own releases and key with `FORERUNNER_UPDATE_FEED` and
`FORERUNNER_UPDATE_TRUSTED_KEYS` (or `update.json`, `docs/maintainers/updates.md`). You can also
install the new MSI / AppImage / `.deb` over the old one; your data stays.

## Uninstall

**Windows.** Settings → Apps → Forerunner → Uninstall (or `winget uninstall Forerunner`).
Then, if you want everything gone: delete `%APPDATA%\forerunner` and
`%LOCALAPPDATA%\forerunner`, and remove the `forerunner-*` entries in Credential Manager
(Control Panel → Credential Manager → Windows Credentials).

**Linux.** `sudo apt-get remove forerunner` for the `.deb`, or delete the AppImage. Then delete
`~/.config/forerunner`, `~/.local/share/forerunner`, `~/.cache/forerunner`,
`~/.local/state/forerunner`, and the `forerunner-*` entries in your keyring (Passwords and
Keys / Seahorse, or `secret-tool search service forerunner-default`).

Uninstalling the app does not revoke the GitHub token or the Anthropic key; revoke them on
those sites if you stop using Forerunner. Projects on GitHub are untouched.

## Getting help

- `fr doctor` lists the prerequisites it can check; `fr status` shows folders and which
  credential names exist (never the values).
- `docs/maintainers/troubleshooting.md` in the repository covers the common failures (proxy and
  CA bundles, Postgres, Docker, keyring on headless Linux, Windows path length, PowerShell
  execution policy).
- Logs are in the logs folder above and are safe to share: credentials are redacted before
  anything is written.
