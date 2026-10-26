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
- Running the installed MSI, AppImage or `.deb` has no recorded test. The scripted install
  from source was timed on fresh Windows and Linux CI runners, which have no desktop session.
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
2. **GitHub.** A fine-grained token (GitHub → Settings → Developer settings → Personal access
   tokens → Fine-grained tokens). Under "Repository access" pick only the repositories the
   agent may work in. Then set these repository permissions:

   | Permission | Access | Why |
   | --- | --- | --- |
   | Contents | Read and write | Clone, create branches, push commits. Required: the wizard's check refuses a token without it. |
   | Pull requests | Read and write | Open, update and comment on pull requests. Required, though the check does not test it. |
   | Issues | Read and write | Comments and the project mirror. The wizard asks for it. |
   | Commit statuses | Read | CI results reported as commit statuses (read before a merge at autonomy level 3). |
   | Metadata | Read | Set by GitHub automatically. |

   **CI results.** The wizard's list says "Workflows: read (to see CI results)". That line is
   wrong. GitHub's Workflows permission is for changing workflow files, and Forerunner does not
   need it. Forerunner reads CI results in two ways: check runs (for CI-triggered sessions) and
   the combined commit status (before a merge). GitHub's API documentation names "Checks: read"
   for check runs, but GitHub's list of fine-grained token permissions has no Checks entry. So
   CI-triggered sessions may not see check runs on a private repository with a fine-grained
   token. This was not tested against GitHub. "Actions: read" is not used by Forerunner.

   Do not give admin rights; the check warns about them. The wizard checks the token the moment
   you paste it and tells you which repositories it can reach and which permission is missing.
   Nothing is stored until the check passes.
3. **Models.** Your Anthropic API key or subscription token, verified the same way. You can set
   both; routing prefers the subscription and falls back to the key.
4. **Budget.** The monthly cap and the per-session cap (defaults CHF 150 and CHF 5). These are
   enforced by the program, not by the agent: a session that would exceed them stops.
5. **Where to work.** Connect sources: GitHub organisations or accounts, chosen repositories,
   local folders. A scan proposes a project per repository (coming in this release: import of
   ZIP files and folders).
6. **Voice.** Whether to install speech on this PC, and how:

   | Choice | Disk | Download | Trade-off |
   | --- | --- | --- | --- |
   | None | 0 GB | nothing | No local speech; voice works only with a cloud voice provider set up in Extensions. |
   | CPU | about 2.3 GB | about 1 GB | Works on any PC. Slow: on the one PC measured, about 4 s from releasing Talk to the first spoken word. |
   | GPU (NVIDIA) | about 8 GB | about 4.5 GB | Fastest replies: about 1.4 to 2.1 s on an RTX 3060. Needs an NVIDIA card and driver; if the card cannot be used, the CPU takes over and setup says why. |

   Both profiles need Python 3.12 on Windows x64 or Linux x86_64 (see "What you need"). The
   times are medians from a few turns on one Windows PC on 2026-10-26; the target is 1.2 s and
   neither profile meets it. Voice has not been tested on Linux.

   When an NVIDIA card is found, GPU is the default. The install runs right after with its
   progress on screen and checks that speech recognition and speech work on the chosen
   device; it takes a while on the first run. If it is interrupted, run it again: finished
   downloads are kept. Without asking: `fr setup --non-interactive --voice none|cpu|gpu`.

Credentials go into the operating system's credential store (Windows Credential Manager, or
GNOME Keyring / KWallet on Linux). They are never written to the configuration file, the
project repositories or the logs. You can re-run the wizard at any time from Settings or with
`fr setup`; skipped steps can be completed later.

Your agent then creates its first project plan from the brief you give it and shows the plan for
approval before it does anything.

**Changing voice later.** Settings → Voice shows what is installed, on which device, and the
size of each choice; **Switch** installs the other one with its progress in the card (close any
voice conversation first). From a terminal: `fr voice install --cpu` or `--gpu`,
`fr voice remove` (turns local voice off and deletes its packages and models), and
`fr voice status`. The packages live in your data folder (`voice/venv-cpu` or `voice/venv-gpu`)
with the models in `voice/models`; nothing is installed into your system Python. If the GPU
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
