# Forerunner setup guide

How to install Forerunner on Windows or Linux, get through the first run, pair your phone, know
where your data lives, and remove it again. This guide is attached to every release. Sections
marked "coming in this release" describe features whose final shape lands with a later
milestone of the 1.0 build; the steps there are the ones already in place.

## What works and what doesn't yet

Version 1.0.0 was released with known gaps. Read
[docs/release/1.0.0-tested.md](release/1.0.0-tested.md) before you rely on a part of it. In
short:

- Email, the cloud runner and push notifications pass their tests against stand-ins only. They
  were never run with a real mailbox, a real host or a real Firebase project.
- Voice was tested on Windows only, and the first spoken word comes later than the 1.2 s target.
- Since 1.0.1 the installers carry the runtime and the app sets itself up (no terminal). The
  installed `.deb` was run against a fresh home and against an old background service left
  running; the MSI is built and its runtime started in CI, but running the installed MSI on a
  real Windows desktop has no recorded test yet.
- The Android app was installed, updated from rc.3 to rc.4 and launched on one real phone.
  Pairing and approvals were tested only on an emulator, on code from before rc.4.

## What you need

- A PC with Windows 10/11 (64-bit) or Linux (Ubuntu 22.04 or newer, Debian 12, Fedora 39 or
  newer). macOS is best effort and not covered here.
- An Anthropic API key or a Claude subscription (`claude setup-token`), for the models.
- A GitHub account with a fine-grained personal access token for the repositories your agent
  will work on. It needs **Contents: read and write** and **Pull requests: read and write** on
  those repositories (details in First run, step 2).
- Optional: Docker Desktop (Windows) or Docker/Podman (Linux) so coding tasks run in a sandbox.
  Without it, Forerunner still works; tasks run in a process sandbox with fewer guarantees.
- Optional, for talking to your agent by voice on this PC (Windows x64 or Linux x86_64; not
  ARM): Python 3.12 (not 3.11 or older, not 3.13 yet), and for the fast option an NVIDIA
  graphics card with a current driver. Windows:
  `winget install -e --id Python.Python.3.12`. Debian/Ubuntu:
  `sudo apt-get install -y python3.12 python3.12-venv`.
- Optional, for email tasks and the agent's own email: a mailbox dedicated to the agent with
  IMAP and SMTP access and an **app password** (see "Email" below).

## Install on Windows

1. On the release page, under **Assets**, download `Forerunner_<version>_x64_en-US.msi`.
   (Not "Source code": that is the project's code, not the app.)
2. Double-click the MSI. If Windows shows "Windows protected your PC" (the installer is not
   code-signed yet), click **More info**, then **Run anyway**.
3. Open Forerunner from the Start menu. The first start takes up to a minute while the
   background service gets ready; later starts take a few seconds.

You can install it into any folder on any drive, including names with spaces or non-English
letters; each release is tested that way before it is published. (1.0.1 did not start on
Windows wherever it was installed; use 1.0.2 or later.)

That is all: the installer carries everything Forerunner needs, including its own Node.js. You
do not need PowerShell, git, Node.js or a copy of the source code. Windows 11 has the WebView2
runtime the window needs; on Windows 10 the installer adds it.

Optional: check the download first. In PowerShell,
`Get-FileHash .\Forerunner_<version>_x64_en-US.msi -Algorithm SHA256`, and compare the result
with the line in `SHA256SUMS.txt` on the release page.

**Installed an earlier version with the setup script?** Install the new MSI. When the app
starts, it stops the older background service that script left running and uses its own. Your
settings, keys and projects stay. You can delete the source folder afterwards.

## Install on Linux

**Debian / Ubuntu.** Download `Forerunner_<version>_amd64.deb`, then
`sudo apt-get install ./Forerunner_<version>_amd64.deb`. That installs the app, its menu entry
and the libraries it needs. Remove it with `sudo apt-get remove forerunner`.

**Any distribution (AppImage).** Download `Forerunner_<version>_amd64.AppImage`, make it
executable (`chmod +x Forerunner_*.AppImage`, or Properties → Permissions in your file manager)
and run it. Nothing is installed; move the file where you like. Some distributions need
`libfuse2` for AppImages (`sudo apt-get install libfuse2`).

**Fedora.** Use the AppImage; there is no RPM in this release.

Optional: verify the download with `sha256sum -c SHA256SUMS.txt --ignore-missing`.

## Developer install from source

Only for working on Forerunner itself. The installers above do not need it.

```bash
git clone <your fork or the repository URL> forerunner
cd forerunner
bash scripts/fresh-install.sh --non-interactive          # Windows: pwsh -File scripts\fresh-install.ps1 -NonInteractive
```

The script installs Node.js 22 and pnpm when they are missing, installs the dependencies, runs
the checks and creates the application folders; `pnpm fr setup` then asks for the keys in the
terminal and `pnpm --filter @forerunner/desktop tauri dev` runs the app from the checkout. CI
times this on clean machines; it must stay under 15 minutes.

## First run

The app opens the **setup assistant**. It takes about five minutes, and every key is checked
the moment you paste it:

1. **Welcome.** Your name and time zone (used for the daily schedule and summaries).
2. **Claude.** Choose how you pay for Claude:
   - **API key** (simplest): click **Get an API key**, sign in to the Claude Console, click
     "Create Key", copy it and paste it into the box (or click **Paste**). It starts with
     `sk-ant-api`.
   - **Claude subscription** (Pro or Max): on a computer with Claude Code signed in, run
     `claude setup-token` and paste the token it prints (`sk-ant-oat…`).

   You can add both; routing prefers the subscription and falls back to the key.
3. **GitHub.** Click **Create a token on GitHub**. GitHub opens its form for a fine-grained
   token with Forerunner's permissions already filled in. Under "Repository access", choose
   "Only select repositories" and pick the ones your agent may work in, then click
   "Generate token", copy it and paste it. It starts with `github_pat_`. The permissions:

   | Permission | Access | Why |
   | --- | --- | --- |
   | Contents | Read and write | Clone, create branches, push commits. Required: the check refuses a token without it. |
   | Pull requests | Read and write | Open, update and comment on pull requests. |
   | Issues | Read and write | Comments and the project mirror. |
   | Commit statuses | Read | CI results reported as commit statuses (read before a merge at autonomy level 3). |
   | Metadata | Read | Set by GitHub automatically. |

   Do not give admin rights; the check warns about them. CI-triggered sessions read check runs,
   which GitHub's fine-grained tokens may not reach on private repositories; this was not
   tested against GitHub.
4. **Done.** It shows what is connected. **Start using Forerunner** restarts the background
   service once so it uses the new keys (a few seconds).

You can skip a step and finish later from **Settings → Accounts and keys**, which opens the
assistant again; pasting a new key there replaces the old one. Until Claude is connected your
agent cannot start work.

**Budget.** The monthly cap and the per-session cap start at CHF 150 and CHF 5. They are
enforced by the program, not by the agent: a session that would exceed them stops. Change
them in Settings.

**Where to work.** In Settings → Sources, connect GitHub organisations or accounts, chosen
repositories or local folders; a scan proposes a project per repository. Or create a project
from Home.

**Voice (optional).** Settings → Voice installs speech on this PC:

   | Choice | Disk | Download | Trade-off |
   | --- | --- | --- | --- |
   | None | 0 GB | nothing | No local speech; voice works only with a cloud voice provider set up in Extensions. |
   | CPU | about 2.3 GB | about 1 GB | Works on any PC. Slow: on the one PC measured, about 4 s from releasing Talk to the first spoken word. |
   | GPU (NVIDIA) | about 8 GB | about 4.5 GB | Fastest replies: about 1.4 to 2.1 s on an RTX 3060. Needs an NVIDIA card and driver; if the card cannot be used, the CPU takes over and says why. |

   Both profiles need Python 3.12 on Windows x64 or Linux x86_64 (see "What you need"). The
   times are medians from a few turns on one Windows PC on 2026-10-26; the target is 1.2 s and
   neither profile meets it. Voice has not been tested on Linux.

Credentials go into the operating system's credential store (Windows Credential Manager, or
GNOME Keyring / KWallet on Linux). They are never written to the configuration file, the
project repositories or the logs. You can open the assistant again at any time from Settings
(or run `fr setup` from a source checkout); skipped steps can be completed later.

Your agent then creates its first project plan from the brief you give it and shows the plan for
approval before it does anything.

**Changing voice later.** Settings → Voice shows what is installed, on which device, and the
size of each choice; **Switch** installs the other one with its progress in the card (close any
voice conversation first). From a terminal: `fr voice install --cpu` or `--gpu`,
`fr voice remove` (turns local voice off and deletes its packages and models), and
`fr voice status`. The packages and models go into a `dependencies` folder inside the folder
Forerunner is installed in, for example `D:\AGENT\Forerunner\dependencies\voice`, so
installing Forerunner on another drive keeps the large GPU download (about 8 GB) off C: too.
pip's download cache and temporary files go there as well. When that folder cannot be written
(Forerunner in `C:\Program Files`, or the Linux `.deb`), they go to your data folder instead and
Settings → Voice says so; beside an AppImage they go into `Forerunner-dependencies` next to the
`.AppImage` file. Settings → Voice shows the folder. Nothing is installed into your system
Python. A voice install from before 1.0.3 keeps working where it is and moves at its next
install. If the GPU
check fails, `fr voice install --gpu` prints a `WARNING` with the reason and voice keeps working
on the CPU; after updating the NVIDIA driver, run it again.

## Email (optional)

Email lets your agent send mail in the mode you choose and lets you send it tasks by email.
It has been tested only against a test mail server, never with a real mailbox. Try it with
care.

You need:

- A mailbox for the agent alone, not your own. It must allow IMAP and SMTP.
- An **app password** for that mailbox. Forerunner does not sign in with your normal password
  or through a browser login. Most providers create app passwords only when two-factor sign-in
  is on. Gmail, for example: turn on 2-Step Verification for the account, then create an app
  password in the Google account's security settings.
- TLS for sending. SMTP uses port 465 (TLS from the start) or 587 (STARTTLS, which Forerunner
  insists on). Forerunner never sends the password or a message in the clear.

Steps:

1. Store the app password in the vault: `fr vault set agent_imap_password` and paste it at the
   hidden prompt. Do the same for SMTP if it differs (`agent_smtp_password`). The name must not
   say token, API key or PAT; those names are kept for other credentials.
2. Open Settings → Capabilities → Email. Enter the address, the IMAP and SMTP hosts, ports and
   user, and the password references (`secret:agent_imap_password`). Never type the password
   itself there; the page refuses it.
3. Pick the sending mode. Anything beyond "off" asks you to confirm on your device.
4. For tasks by email, enter your own address under "My address". Tasks by email need a
   sending mode other than "off". Mail from any other sender,
   or mail whose DKIM signature fails or does not match the sender, is ignored and listed in the
   command audit.

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
| Voice packages and models (when installed) | `%LOCALAPPDATA%\forerunner\data\voice` | `~/.local/share/forerunner/voice` |
| Credentials | Credential Manager, entries `forerunner-<profile>` | Keyring, service `forerunner-<profile>` |

Setting `FORERUNNER_HOME` moves all of it under one folder (used to run two installs on one
machine for testing). `fr dirs` prints the folders in use. Updates never touch these folders.
With voice installed, keep `FORERUNNER_HOME` short (under about 75 characters on Linux): the speech
engine cannot read its data from a longer path, and `fr voice install` refuses it with the reason.

Your code and project documents live in git on the host you connected (GitHub), not in
Forerunner's folders; the shared state used by two people's agents lives in the state service
you point both installs at.

## Updating

Releases are published on GitHub. Forerunner never checks for updates on its own. Open
**Updates** in the sidebar and press **Check for updates**; if a newer release is out, the
screen shows "Update available" with its changelog and an **Update and restart** button. The
update is downloaded, its signature and checksum verified against the project's update key
(built into every install), installed, and rolled back automatically if the new version fails
its start-up health check. Nothing is installed until you press that button. A fresh install
follows the `stable` channel; release candidates (`v1.0.0-rc.N`) are published on `beta`, so to
be offered one set `FORERUNNER_UPDATE_CHANNEL=beta` (or `"channel": "beta"` in `update.json`). A fork or a
private build points at its own releases and key with `FORERUNNER_UPDATE_FEED` and
`FORERUNNER_UPDATE_TRUSTED_KEYS` (or `update.json`, `docs/maintainers/updates.md`). You can also
install the new MSI / AppImage / `.deb` over the old one; your data stays.

## Trying a build before it is released

Fixes collect on a development branch before a release is cut. You can install that build and
try the fixes first, so a release is only published once you have seen them work. You need to
be signed in to GitHub with access to the repository.

1. On GitHub, open the repository's **Actions** tab and choose **Desktop app** on the left.
2. Find a run for the branch (a run is started for every pull request; to start one, click
   **Run workflow**, pick the branch, and click the green **Run workflow** button). A run takes
   about 30 to 45 minutes.
3. Wait for a green check mark. A red run has no installers: something failed its tests, and
   nothing from it should be installed.
4. Open the run and scroll to **Artifacts**. Download `desktop-windows-latest` (the `.msi`) or
   `desktop-ubuntu-latest` (the `.AppImage` and `.deb`). It is a ZIP; extract it.
5. Quit Forerunner from the tray, then install the MSI over your current version, as for a
   release. Your settings, keys and projects stay.

A test build carries the version number of the last release (the next number is set only when
the release is cut), so the app shows that number. To go back, install the released MSI over
it. Every installer in a green run has been installed and started on clean Windows and Linux
machines by the run itself, but only you can tell whether a fix does what you asked; the
**Open and fixed, not released** table in `docs/status/UPDATE-LOG.md` lists what to try.

## Uninstall

**Windows.** Settings → Apps → Forerunner → Uninstall (or `winget uninstall Forerunner`).
The uninstaller (and an upgrade) stops Forerunner first if it is still running; you can also
right-click the tray icon and choose **Quit Forerunner** before.
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
