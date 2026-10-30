# Changelog

All notable changes to Forerunner are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`scripts/release-notes.mjs <tag>` turns the section for a tag into the GitHub Release body, so
every release needs a `## [x.y.z] - YYYY-MM-DD` section here before the tag is pushed. Entries
go under Added, Changed, Deprecated, Removed, Fixed or Security.

Problems and their status, released or not, are tracked in
[`docs/status/UPDATE-LOG.md`](docs/status/UPDATE-LOG.md). Each fix under `[Unreleased]` names its
`U-NNN` entry there.

## [Unreleased]

## [1.0.4] - 2026-10-30

Fixes for what the first sessions with 1.0.3 found. Install 1.0.4 over 1.0.3; your settings and
data stay. Each fix names its entry in `docs/status/UPDATE-LOG.md`.

Tasks you clicked Claim on in 1.0.3 go back to ready by themselves at the start of your next
session. Tasks a 1.0.3 plan gave to "ops", "writer" or a similar name run with the right
specialist.

### Fixed

- Clicking Claim on a task took it out of every session's plan for good ("Nothing to plan: no
  task is ready"). Claiming is the agent's job, so the Tasks tab no longer offers Claim or
  Start; the next session puts tasks claimed that way back to ready and works on them (U-013).
- A planned task failed at once with "specialist ops is not in the registry". The planner's
  names for specialists now run the specialist they mean; a name that means none waits for you
  and lists the specialists instead of failing (U-014).
- "add a task: ..." in Chat was not understood without a model for Chat. It creates a ready
  task (U-015).
- "Make this a task" in Chat (the button and the phrase) made a draft that no session worked
  on. It makes a ready task (U-016).
- A session whose tasks all failed looked fine: the notification now counts failed tasks, the
  session review no longer grades it 100, and the review shows once in the log. Project setup
  no longer plans tasks that ask you something; it records the choice in the first decision
  doc for you to read before approving (U-017).

## [1.0.3] - 2026-10-30

Fixes for what the first days with 1.0.2 found. Install 1.0.3 over 1.0.2; your settings and data
stay. Each fix names its entry in `docs/status/UPDATE-LOG.md`.

A voice install made with 1.0.2 keeps working where it is. To move it next to Forerunner (and off
C:), choose the profile again in Settings → Voice; the old copy is removed once the new one works.

### Fixed

- Start session showed "daemon response for POST /sessions does not match the contract". The
  session now opens, or the dialog says it is queued behind a running one (U-003).
- The project page's Next session panel and Docs tab showed "Route not available": both work
  now (U-004, U-005).
- Import on the Data tab failed; it uses the import the app's service has and says what came in
  and where it went (U-006).
- "Not available in this version" no longer sends you to Updates for something no version
  has (U-007).
- A session with no ready task ended at once without saying why. The Start dialog now says so
  first and how to give your agent work, and so does the session's summary (U-009).
- Voice packages and models (about 8 GB for the GPU profile) always went to C:. They now go
  into a `dependencies` folder inside the folder Forerunner is installed in, with pip's cache
  and temporary files. They fall back to your data folder, with the reason in Settings → Voice,
  when that folder cannot be written (U-011).

### Changed

- Moving a task or editing a milestone no longer requires a typed reason; left empty, the app
  records what changed (U-010).

### Added

- A test runs the app's own client against the real background service, so a screen and the
  service can no longer drift apart unnoticed (U-008).

## [1.0.2] - 2026-10-30

Fixes 1.0.1 on Windows: the app now starts wherever it is installed. Install 1.0.2 over 1.0.1;
your settings and data stay.

### Fixed

- On Windows, 1.0.1 showed "The Forerunner daemon did not start: fr daemon exited with code 1".
  The app handed Node the folder of its own runtime in Windows' extended form
  (`\\?\D:\AGENT\Forerunner\...`), and Node cannot start a script named that way
  ("EISDIR: illegal operation on a directory, lstat 'D:'"). The app now always passes the
  plain form, for any drive, folders with spaces or non-English letters, and network shares.

### Added

- `forerunner-desktop --self-test`: starts the app's background service the way a normal launch
  does, without a window, and reports whether it came up. Before every release, CI installs the
  real installers and runs it from several folders:
  - Windows: the default `Program Files` folder; `D:\AGENT\Forerunner`; `D:\My Apps\Forerünner Ä`;
    a long path. Each install folder is read-only for the test. A start over a network share and
    from a mapped network drive is tested and reported too.
  - Linux: the `.deb` from the read-only `/usr/lib`; the AppImage from a folder with spaces and
    non-English letters.

  A release is not published unless every one of these folders starts.

## [1.0.1] - 2026-10-30

Installing Forerunner is now one download: the app carries everything it needs and sets itself
up. No PowerShell, git, Node.js or source code on the PC (ADR 0092).

### Added

- The installers carry the runtime. The MSI, AppImage and `.deb` include Node.js, the runtime
  and its dependencies, so the app starts its own background service on a new PC.
  `scripts/build-runtime-payload.mjs` builds it before every `tauri build`, and
  `scripts/runtime-payload-smoke.mjs` starts it in CI on Windows and Linux. The installers are
  larger: about 200 MB instead of 4 to 80 MB, mostly Node.js and the Claude Agent SDK's binary.
- Setup assistant in the app. A new install opens it on first start:
  - your name and time zone;
  - the Claude API key or subscription token;
  - the GitHub token, with a button that opens GitHub's token form with Forerunner's
    permissions already filled in.

  Each key is checked the moment it is pasted, with the same checks as `fr setup`, and kept in
  the OS credential store; it is never shown again. The daemon restarts once to use the new
  keys. Settings → Accounts and keys opens the assistant again. Daemon routes: `GET /setup`,
  `POST /setup/{profile,anthropic,github,finish}`.

### Fixed

- "daemon response for GET /me does not match the contract: desktopDeviceId" after installing
  1.0.0. The shell started whatever checkout an earlier `fr setup` had recorded in
  `install.json` (a 0.1.0 copy of the repository's stale default branch) and attached to any
  daemon that answered. The app now runs the runtime it carries ahead of `install.json`. When
  the background service already running is older than that runtime, the app stops it and
  starts its own.
- The GitHub permission list asked for "Workflows: read". It now asks for "Commit statuses:
  read", which is what Forerunner reads for CI results.
- The repository's default branch was 722 commits behind the 1.0.0 release, so "Download ZIP"
  gave a 0.1.0 copy. It now carries the released code.
- `fr setup` kept only the `config.json` keys it writes, dropping notification settings. It now
  keeps the others.

### Known issues

- On the desktop, "Update and restart" cannot replace the running build yet. It would stage
  the release's installer file, which holds no runnable runtime, so the update would roll back.
  The Updates screen therefore offers **Download the installer** for such a release: run it
  over the old version and your data stays (`docs/maintainers/updates.md`).

## [1.0.0] - 2026-10-26

First stable release. It is 1.0.0-rc.4 (ef18b5a) plus the git authentication fix below,
merged before the tag. The human chose to release with known gaps. What was tested live, what
only against stand-ins, and what not at all is in the test matrix:
[`docs/release/1.0.0-tested.md`](https://github.com/joelwellbournewood/Forerunner/blob/v1.0.0/docs/release/1.0.0-tested.md).

Installers: Windows MSI (unsigned), Linux AppImage and `.deb`, Android APK (sideloading).
The rc.4 publish run (`release.yml` run 40395549204) produced every one of them, the signed
manifest and `SHA256SUMS.txt`.

### Fixed

- Git over HTTPS sent the GitHub token as a bearer header, which GitHub's git endpoint refuses;
  it now uses Basic authentication. Found by the live docs handover run (V.8) on 2026-10-26.
  1.0.0 includes the fix (merged before the tag); it has no live run yet.

### Known gaps

Passes against stand-ins (the fake provider, the test mail server, the fake git host, the
hosted emulator) are weaker evidence than live runs. Real runs on 2026-10-26 found bugs the
stand-ins had passed over: the git bearer header above; paid model-watch evaluations that fresh
installs started unasked (about USD 13; fixed by the consent rules of ADR 0089 in rc.4); and
on a real phone, one versionCode shared by rc.3, rc.4 and 1.0.0 and a header under the status
bar (the header fix, ee056ae, is not confirmed on the phone).

- **Code tested:** the live suite, the tier 1 critic calibration and the emulator smoke ran on
  a76e259, 94 commits before rc.4. CI is green on the 1.0.0 code (run 40423095845); the V.8 re-run is the only live run on it.
- **Email:** tested only against the test mail server. Not tested with a real mailbox (L.3).
- **Cloud runner:** tested only in process. Not tested on a real host (S.12). Anthropic-hosted
  runs through Claude Managed Agents are planned for 1.1 (the human's wish, reported
  2026-10-26).
- **Push notifications:** tested only against fake FCM endpoints; the app polls. Not tested
  with a real Firebase project or on a device (R.6, K.8).
- **Voice:** works end to end on one Windows PC (CPU and NVIDIA GPU profiles), but first audio
  misses the 1.2 s target (GPU median 1383 ms, then 2139 ms, 4 turns each; CPU about 4 s). Not
  tested on Linux or with cloud voice providers.
- **GitHub:** git over HTTPS is fixed and confirmed live (the V.8 re-run of 2026-10-27 cloned,
  pushed and opened pull request #2). The handover still ends stuck: without a sandbox the
  agent cannot run the check command, so the critic sends the change back and the retry ladder
  spends up to about three more attempts before asking you. Workaround: Docker or Podman, or
  `FORERUNNER_SDK_HOST_COMMANDS=1` (commands then run unsandboxed). That run uses a token with admin rights, which the human chose to keep (reported 2026-10-26).
  Every other pull request in testing went to the fake git host.
- **Desktop app:** the installers were built and published, but no record shows the installed
  MSI, AppImage or `.deb` being run. No real Linux desktop session was tested. The MSI is
  unsigned.
- **Android:** installed and updated (rc.3 to rc.4) on a real phone. Pairing and approvals were
  tested on the emulator only.
- **Updates:** the desktop in-app updater was tested against the fake git host feed only.
- **Model watch:** no deliberate live run; tested on the fake provider. Its only live use was
  the unasked paid evaluations above.
- **Response times:** D.9, D.13 (one task) and D.15 (one clean and one seeded review per tier)
  met live. D.10, D.11 and D.14 met earlier and were not re-measured on the final code; D.11
  only because this build plans in code without a model call. D.8 (voice) not met.

### Known issues

No open P0 or P1 (severity triage of 2026-10-23, re-read on 2026-10-25:
`docs/status/reports/triage-2026-10-25.md`). The findings of 2026-10-26 (the last block below)
were not re-triaged. Every P2 below has a workaround; the maintainer docs' "Known issues"
sections carry the detail.

**Desktop app**

- Settings → Devices pairs phones only; the paired list refreshes on Done or Refresh and the pairing
  countdown follows the PC's clock. Workaround: Refresh; keep the PC clock in sync. [10]
- Pages for the project queue, docs and the import form show "route not available". Workaround:
  add notes in chat (`note.add`) or from the phone; import through `POST /projects/:id/data/import`
  or register data by locator. [12, 78, 152]
- An undo made from the Changes screen is logged with source `chat`. No workaround needed. [13]
- Extension permissions can be approved or denied, not narrowed or widened from the panel;
  a connector update is applied by remove-and-add. Workaround: deny and re-approve. [14, 15, 98]
- The Inbox reloads only when the blocking count changes. Workaround: Refresh. [16]
- Read aloud and spoken alerts play only while the app window is open; a browser tab stays
  silent until clicked; the conversation panel shows a voice reply as text. Workaround: keep the
  window open; read the text. [17, 18]
- Export audit log may do nothing on the Linux desktop shell. Workaround: `fr audit export`. [19]
- The fast-mode card shows an archived project by its id. [9]
- Clicking an OS notification does not open the window. Workaround: the tray or the window. [20]
- Global hotkey: unavailable in a pure Wayland session, delivered only while an X window has
  focus under some compositors, and a press before the window exists is not queued. Workaround:
  X11; press again once the window is up. [22, 23]
- The Linux tray icon needs an AppIndicator host (GNOME: the AppIndicator extension); the window
  and the daemon work without it. [24]
- Windows-only shell code has been built and tested on CI's `windows-latest` only. [21]
- The specialist and skill toggles in the Extensions panel do not yet reach the loader.
  Workaround: set the specialist's `status` in its file. [99]
- The desktop-control banner lives in the app window; while the window is hidden the tray title or
  tooltip is the indicator. [82]
- "Update available" notifications open Settings, not the Updates page. [124]

**Phone (Android) and approvals web page**

- A phone with an old WebView (and the API 30 emulator image, Chrome 83) renders the app
  unstyled. A phone needs a current Android System WebView. Workaround: update Android System
  WebView from the Play Store. [33]
- After the 45 s biometric bound the phone has refused the change but the system prompt stays on
  screen; a late touch confirms nothing. Workaround: dismiss it and tap Confirm again. [35]
- Push-to-talk in the Android app relays the typed line, and the reply is spoken by the phone's own
  synthesis. Workaround: open `/m` in a browser on the phone to record audio. [38]
- Uploads use the web file picker (no share target); queued uploads over 2 MiB in total are held
  in memory and lost if the app closes before they are sent; progress is shown by phase.
  Workaround: keep the app open until the upload is sent; upload again otherwise. [39]
- The phone treats a monthly-cap change as high risk because `/me` does not carry the cap yet. [30]
- The phone's change log is per phone; the desktop's and the phone's logs are joined only through
  the remote command rows. [32]
- Push notifications are a polling stand-in until a Firebase project exists; notices appear only
  while the app is open. (BLOCKERS.md, Firebase row)
- Approvals web page: high-risk answers and chat are not relayed yet ("does not relay chat yet");
  nothing issues the web link and the service does not serve the page's build. Workaround: the
  desktop or the phone; mount the `dist/` folder behind a proxy and start the pairing by the admin
  route. [26, 27, 28, 29]

**Agents, sessions and approvals**

- A plan approved while the agent is busy is `queued` in the scheduler's single slot; a later
  trigger replaces it and the plan is proposed again. [128]
- Open chat confirmations live in memory: a daemon restart drops them and a pending high-risk card;
  a restart also forgets scheduled starts, so an undo of such a start is a no-op. Workaround: ask
  again. [70, 134, 153]
- A bare "yes" typed right after a voice answer is reported "Not done"; nothing runs twice.
  Workaround: type the line again. [136]
- "and" inside a project name splits a typed sentence. Workaround: rename, or let the model parse
  it. [71]
- A line said during a live session reaches the agent after the task in flight; a long task delays
  it. [153]
- Sessions started from a subscription (Agent SDK path) cannot run shell commands or tests unless
  `FORERUNNER_SDK_HOST_COMMANDS=1`; flagged file content is not rewritten on that path and git over
  SSH is unavailable. Workaround: the API-key path; HTTPS remotes with a token. [138, 146]
- The subscription plan share is an estimate (default USD 50 a month) until a probe reports the
  real plan; it can stop subscription work early. Workaround: `FORERUNNER_PLAN_USD_MONTHLY`. [43]
- The critic reviews the diff with the project's checks listed as "not run" at tier 1; at tiers 2
  and 3 it runs only the checks passed to it; a few quality edges in its grading. [73, 74, 75, 76]
- Screenshots taken under desktop control never reach the model; audit rows of that module carry no
  token id; screenshots include overlapping windows. [81, 83, 84]
- Desktop control works through X11/XWayland only and Windows SendKeys are ignored by elevated
  windows. [79, 80]
- After an accepting review at autonomy level 3 the merge waits up to 10 minutes for CI; a
  repository whose CI runs only on push leaves the PR to you. [155]
- CI triggers read check runs only (not commit statuses), a reopened PR is not watched again,
  there is no webhook receiver, and a crash between the poll's cursor save and the start can lose
  that one event's inbox message (the PR still shows it). [150]
- Intake: a daemon that dies during the planning call leaves the intake session running until
  closed by hand; the PR path needs `git` and a host token; a re-run reuses the brief. [131]
- Project docs: the critic's docs-drift check may list `docs/status.md` before the session-end
  write; a project created from chat gets no doc scaffold. Workaround: create from the dashboard.
  [132]
- Source discovery marks nothing as an existing install until a marker is written by hand; GitLab
  and plain git remotes are refused. [133]
- Chat docs search is lexical with no index, reads the last checked-out clone, and the registry's
  chat prompt does not yet mention the docs. Workaround: ask in the doc's own words. [109]
- Memory: contradictions are detected by polarity words only; `fr memory check` and the start-time
  reconcile are not wired; lint-failing lessons are still served; usage is a hit count; the format
  migrator is a placeholder; `offerToProjects` is narrower for direct callers. [103–108, 110]
- The private memory index is unencrypted on disk (like the solo state store); the spec's encrypted
  backup is not built; it is a second schema whose cross-store supersede is refused. [101, 102]
- Fast mode: chat, intake and the model watch's evals never go fast; the critic's model settings
  follow its tiers; a fast request the API served at standard speed is still priced as fast (an
  over-statement); the Agent SDK path takes no speed or output cap. [1, 2, 151]
- A proposed specialist needs at least 10 mechanically checked tasks (rubric-only sets cannot pass
  yet); a promotion is reflected in the registry hash at the next start; no agent tool proposes a
  specialist yet. Workaround: `fr specialists approve`. [5, 6, 210]
- Only coder and researcher have eval sets; researcher grading relies on the rubric and the critic
  for oddly phrased wrong answers. [4, 8]
- Monthly jobs (critic calibration, handover test) have run on the fake provider only; their
  reports are per-install files; a run deferred by quiet hours is lost on a restart. Workaround:
  `fr jobs ... --force`. [156]
- Shared secrets reach an agent on its owner's PC only (the cloud runner has no wrapping key);
  there is no app screen for grants and `propose` is not a chat command. Workaround: the daemon's
  `/secrets/shared` routes. [154]
- The install's wrapping key is an ordinary vault entry; never grant `forerunner.install_wrap_key`
  to an extension or a run. [166]
- An approval card for a production Cloudflare deploy below level 3 is asked twice; custom domains
  are not attached. [64, 65]

**Email, notifications and the cloud runner**

- Email: one connection per operation; HTML-only mail through a small tag stripper; the per-email
  estimate is a constant plus words; the daily digest has no scheduler entry; sends held while paused
  are not resent on resume; a changed mode or mailbox takes effect at the next session or daemon
  start; a mode change from the Settings page has no undo (set it again); the private command marker
  stays in the sent log and audit rows; a refusal whose audit row could not be written is recorded
  only in the daemon log. [85–87, 89–94]
- A cloud command from a human with no cloud runner stays pending until cancelled; an email session
  for a busy agent fails at once instead of queueing; run one watcher per mailbox. [60, 61, 62]
- The cloud runner unlock card needs the runner's key on the answering device; there is no phone
  key-import screen yet. Workaround: `fr runner-key import` on the desktop. [63]
- Notifications: held and digest queues, the dedupe memory and the state service's quiet-hour push
  notices live in memory and are dropped by a restart (the inbox keeps the records); the desktop
  channel probes `notify-send`/`powershell` once per process; the email channel is resolved at
  start; Telegram is one-way and Signal needs `signal-cli` set up by hand; peer messages and email
  commands raise no notification of their own. Workaround: the inbox; restart the daemon after
  installing a notifier. [119–123, 171]

**Browser capability**

- Without Chromium only static pages are read; a Chromium that fails to launch is not demoted at
  run time (restart with it fixed). The block list is the project's and has no UI; the registry's
  researcher names Claude Code's web tools, which the loop path cannot map (name `browser_*`). [44,
  45, 46]
- A capability installed before the `browser_*`/`email_*` rename keeps its old tool names until
  removed and re-added from the catalog (1.0.0 is the first release, so no install is affected).
  [48]
- Redirects 307/308 are followed as GET; a read right after a blocked navigation may see Chromium's
  error page; downloads by URL cannot use page state; a purchase or password guard inside a tool
  call ends the call with `approval_required` and the model re-calls after the answer; a few
  extraction and hidden-text heuristics. [49–56]

**Billing, pricing and the model watch**

- Haiku 5.5's price tier above 100K prompt tokens is not modelled (an under-estimate of up to 5x on
  those calls; the cap check still runs per call); the `claude-opus-5-5-fast` price is assumed at six
  times standard; 5.5 prices date from 2026-10-06 until the weekly model watch confirms them. [40,
  41, 42]
- A model adopted from `fr models watch` on the command line reaches a running daemon at its next
  start (answers in the app apply at once); the cost estimate learns from the plan's figure rather
  than the base estimate; new models are unpriced until a row exists; lower-effort probes exist for
  coder and researcher only. [111–118]
- Connector (MCP) calls report no price; a weekly tier 2+ eval needs a container engine. [97, 140]
- Context compression: the Headroom proxy's panel entry, CLI and savings line are not wired; stored
  originals are pruned after 30 days. [141, 142, 143]

**Sandbox, security and updates**

- Node 22 `fetch` ignores proxy variables inside the allowlist sandbox (use `EnvHttpProxyAgent`);
  the gateway route falls back to `0.0.0.0` with a warning (prefer the sidecar); the sidecar needs
  `node` in the task image or `FORERUNNER_EGRESS_IMAGE`; a symlink planted between the walk and the
  open on Windows is not caught. [157–160]
- Linux without a Secret Service keeps the device key next to the data at 0600 (logged at startup);
  two processes on one file vault are not coordinated (use separate profiles). [163, 164]
- Updates: a release built without `UPDATE_SIGNING_KEY` is unsigned and no install takes it; an
  update that waits for an inbox answer is not re-issued by itself (retry after answering); the
  sync gate learns of a peer's migration lazily; Android updates go through the system installer;
  the Windows MSI is unsigned (BLOCKERS.md). [193–199]
- A connector closed by a global stop reconnects only when the registry restarts; a URL typed for
  a new connector is probed before approval. [95, 96]

**Collaboration and the state service**

- Several state-service instances need sticky sessions and a shared volume; run the GitHub mirror
  and push on one instance. [169]
- The GitHub Projects mirror: item index per process (run one mirror per project), milestones as
  labelled issues, no `task.mirrored_url` column, no "sync now" route, `cost_ledger` not polled.
  [57, 167, 168, 170, 172]
- The mirror's `secret_ref` can name any vault entry (it is only ever sent to the GitHub API);
  the session grant does not add `api.cloudflare.com`. [67, 69]
- Which human shares a project is read from the project's settings until the service exposes
  membership. [72]
- On an install created before 1.0.0 with an empty email, `fr setup --email` makes the next start
  create a second human; `fr doctor` warns. Workaround: `fr setup --human-id <id>`. [129]
- Revoking this PC's own desktop device row refuses high-risk confirmations until the daemon
  restarts. [130]
- Voice: faster-whisper re-transcribes partials; Cartesia opens one WebSocket per sentence; open mic
  without echo cancellation can barge in (use push-to-talk); stored audio has no cap or retention
  (keep storage off); a provider that ignores its abort delays the turn's end. [200–204]

**For maintainers (no user-visible effect)**

- Test hygiene: scenario worlds and helpers compose the daemon by hand; relative imports in the
  e2e project, the app's fake service and the voice package; scenario 6's own reader copy; the fake
  git host's REST-only board and real-time webhooks; no recorded provider traffic yet; the live
  harness's older `FORERUNNER_E2E_LIVE` path; phase 7 gate tests share one world; `newId` has no
  per-millisecond counter; a phone plan's change source is `chat`; the CI e2e step's name; scenario
  3's voice answer and the phone specs' pairing seam still to add; the CDP driver covers the smoke
  only and the CI Android job builds twice; DKIM/SPF verification runs with an injected verifier in
  tests; B.5's four low review findings (inserts need no reason, a stale comment, a shared test id, a
  missing dialog test). [3, 31, 34, 36, 37, 47, 58, 88, 137, 173–176, 178–180, 186, 187, 189–191,
  208]
- Live harness: a call killed before `message_start` and output before the disconnect stay outside
  the ledger; the pre-call estimate can undercount by its heuristic; a crash can leave a tmp ledger
  file; hooks' ledger rows carry no `specialist`; a `0/0` row for a subscription run that ended
  early; projected first audio over the 1.2 s anchor until measured on devices. [177, 181–185]
- Docs and ADRs: ADR 0007's older interface; the cloudflare force-push note; ADRs still to write for
  the specialist, mirror and harness decisions; requirement rows that do not list the shell's test
  modules; the Gradle proxy note; `@forerunner/platform` by relative path from `scripts/`; the
  desktop shell's missing `client` declaration; `gate: "registry"` set by the loop, not the spec
  builder; the file tools' second containment check still lexical (the hooks' real-path check runs
  first); the session handoff does not list lessons; `update_applied` sent while exiting; the
  daemon has no `notFound` handler and no daily-schedule route; the data routes' bounded limits.
  [7, 11, 25, 59, 66, 68, 77, 100, 125–127, 135, 139, 144, 147, 148, 149, 161, 162, 165, 188,
  192]
- Known issues lines a merge left behind after their fix (email routes mounted, `StateApprovals`
  one-shot, `tests/live` in CI, the daemon's voice routes, the Q requirement rows, the solo
  store's desktop row); corrected in the next docs pass. [209, 212]

**Added on 2026-10-25 night and 2026-10-26**

- Android push (FCM) is built but has not run on a device; without `google-services.json` in
  the build the app polls as before. Workaround: the inbox and approvals poll.
- Upgrading from a release candidate: a `.deb` or APK of 1.0.0 may not be offered over
  1.0.0-rc.N. dpkg ranks the candidate higher. On Android, rc.3, rc.4 and 1.0.0 all carry
  versionCode 1000000, because the code ignores the pre-release part of the version. R.1
  showed an APK with an equal code installs over a candidate (rc.4 over rc.3), so the code
  does not tell the builds apart. For the `.deb` (not tested): uninstall the candidate first.
- On rc.3 the Android app's header sat under the status bar. ee056ae pads the WebView below the
  status bar and above the navigation bar; the fix is not confirmed on a phone.
- The voice panel's heard-first-audio figure can be slightly low for hotkey turns and some
  turns can go unmeasured (`docs/maintainers/voice.md`). Workaround: use Send.
- Voice first audio misses the 1.2 s target: median 1383 ms and 2139 ms on the GPU profile
  (RTX 3060, two runs of 4 turns on 2026-10-26), about 4 s on the CPU profile. Workaround: the
  GPU profile where a card exists; text chat (first token median 682 ms).
- The speech-recognition helper crashed once with 0xC0000005 on Windows on a first utterance;
  the cause is not proven. It restarts and retries the utterance. Workaround: say it again.
- The setup wizard's GitHub check lists "Workflows: read (to see CI results)". The code reads
  commit statuses and check runs, not Actions: grant "Commit statuses: read" (setup guide).
  Workaround: follow the setup guide's permission table.

## [1.0.0-rc.4] - 2026-10-26

### Added

- Voice install profiles: none, CPU or GPU, chosen in `fr setup` and switchable from Settings ->
  Voice or `fr voice install|remove|status`; a managed Python 3.12 environment per profile with
  hashed, pinned packages, model download with progress, and a device check with a loud CPU
  fallback (ADR 0090).
- The voice panel shows the reply text as it is generated and the sentence being spoken; a
  Reply: Voice | Text switch (text replies skip speech entirely); pressing Talk interrupts.
- `fr models watch --evals --model <provider/id>` evaluates a named model, with consent and
  within the run budget.

### Changed

- Model watch: paid evaluations run only with the human's consent; the first run on an install
  records a quiet baseline; stale requests the baseline covers close at start (ADR 0089).
- The conversation agent mentions an open request at most once per conversation unless asked.
- Chat and voice replies: thinking off at low effort, a 1024-token cap, a reply cut at the cap
  ends on its last full sentence and is recorded as truncated; a per-turn budget of at most
  USD 0.25 when none is configured (ADR 0091).
- The critic at effort max reviews in one call sized to the budget left (ADR 0028).

### Fixed

- Voice playback cut-outs: a jitter buffer in the player and a drift-free paced sink.
- A crashed speech-recognition helper restarts and retries the utterance once with a
  different decode (on the CPU after a GPU crash), and leaves a traceback.
- Release workflow uploads only the installers (the rc.3 publish hit GitHub's upload limit).

## [1.0.0-rc.3] - 2026-10-26

### Added

- Monorepo scaffold, `@forerunner/platform`, CI on Windows and Linux, secret scan, docs check.
- Shared state schema v1 with SQLite and Postgres adapters, vault, billing sources and routing.
- Agent runtime: enforcement hooks, session budget, kill switch, `fr` CLI with the setup wizard.
- Fresh-install scripts for Windows and Linux, local Postgres helper, release tooling
  (release notes, Android keystore, gates verification, path lint).
- PM intake: a pasted brief becomes one proposal (docs, milestones, tasks, a first-session
  plan) in the inbox, written only on approval (A.2, A.1, J.3; ADR 0055).
- Source discovery: connect GitHub orgs, accounts, repositories and local folders, scan,
  one proposed project per source, existing-install and duplicate detection, accept, rescan,
  remove; `fr sources`; migration 0003 (A.4; ADR 0056).
- Project docs by pull request: the standard doc set scaffolded at project creation and
  `docs/status.md` rewritten at session end (G.5; ADR 0058).
- Cross-project promotion of `general` lessons through the critic at session end, offers
  and Share on the memory page (G.6; ADR 0059).
- Shared secrets wrapped to the named agents' install keys, approved by both humans, served
  by reference; migration 0004 (S.13, S.10; ADR 0065).
- CI results and PR comments start sessions: the daemon polls the git host for the agent's
  open PRs and fires the `ci` and `pr_comment` triggers once per check run, green head,
  comment, review line comment or review, the comment quoted as data and flagged when
  instruction-like; the human's comments fire even when the token is their own PAT (what the
  port writes carries a hidden agent mark); the git host port reads every page of PR comments
  with `since` and lists reviews and review line comments (E.1; ADR 0075).
- The daemon serves the Performance view (`GET /performance?projectId=&days=`) from the Run
  rows and the chat and voice turns: per mode p50 and p90 of first token and total time
  against target, met or not, and the effort in force (the project's speed-versus-quality
  slider in every mode it reaches, from the principal's D.4 effort setting where one is set,
  held at the registry's `max_effort`); the intake call writes a Run row and chat replies
  record their total time, effort and project (D.7, D.19).
- Settings → Devices on the desktop: pair a phone from the QR of the `fr://` link with the
  typed code and its expiry, list the paired devices, revoke one at once; the daemon's
  `/devices` routes keep the state service's admin token out of the app (R.2; ADR 0009).
- Settings → Capabilities → Email: the capability's routes on the daemon, a page per agent
  with the mode picker and the full-discretion confirmation, pause and resume from the tray,
  the command audit (S.15, S.28, S.29, T.14, L.3; ADR 0066).
- What you say during a live session reaches the principal agent at its next task boundary
  (O.9, O.2, E.4; ADR 0078).
- The phone contributes: an Upload screen (photos, files, documents; the cap shown, queued
  offline, idempotent by `clientId`), a Reviews screen (PRs and critic findings; comment,
  approve, reject, high risk behind the biometric prompt) and push-to-talk relayed to the PC's
  voice loop as a `kind: "voice"` remote command (R.5, R.3, O; ADR 0080).
- Opus fast mode per project for urgent work: API-key runs on the Opus rung, specialist and
  critic, are sent with `speed: "fast"` and priced apart as `claude-opus-5-5-fast`; a
  subscription ignores it with an audit row (D.20; ADR 0057).
- The quick chat searches the project's docs and the principal's lessons under measured token
  budgets and cites the paths; `memory.record` keeps a lesson the human states (J.1, O.2;
  ADR 0061).
- At autonomy level 3 the runtime merges a reviewed PR after an accepting review, once its
  checks and commit statuses pass, rebased when the base moved (J.9; ADR 0062).
- Read aloud and spoken alerts: the project and session summaries through the daemon's voice
  provider, `summary.speak`, and a voice channel for urgent notifications (L.6, A.6; ADR 0063).
- Monthly jobs: the critic calibration with its drift notice and the docs handover test on a
  fresh agent that files a docs task where it got stuck (H.7, P.15; ADR 0060).
- A global hotkey brings up the conversation and starts a push-to-talk turn; the chord is
  changed in Settings (O.1; ADR 0064).
- The voice providers enabled in the Extensions panel are the ones the daemon uses, read again
  at every voice session (O.4).
- Milestone and session plan changes carry author and reason; the Plan tab's milestone edit
  asks for one; migration 0005 (B.5).
- A desktop-control banner on every page and a tray state while an agent controls the
  desktop, with "Stop desktop control" (S.32; ADR 0067).
- The cloud runner unlock card in the desktop and Android inboxes with an auto-unlock window,
  and `fr runner-key` to put a runner's key where the daemon reads it (S.12; ADR 0068).
- A proposed specialist goes live only after the human approves it and its eval set passes;
  `fr specialists approve` (C.5; ADR 0071).
- Model, effort, max tokens, speed mode and timeout per agent and specialist in Settings and
  through `model.settings.set`; temperature only where the provider accepts one (D.4; ADR 0072).
- A speed-versus-quality slider per project that shifts every mode's effort one step, held at
  each registry entry's `max_effort` (D.16).
- The state service sends Android push through FCM HTTP v1 for approvals, finished sessions,
  budget warnings and messages, with quiet hours; the app's Firebase wiring waits for a
  project (R.6, K.8; ADR 0085).

- Import an existing GitHub repository into a project: cloned under the install's data dir onto
  `forerunner/migration-<date>`, the default branch never written, the token by reference and
  sent only to the repository's own origin, a re-import idempotent (A.3; ADR 0069).
- The PM proposes a specialist from a session with `specialist.propose` (`specialist_propose` on
  the model path): medium risk, the human's yes, then the C.5 approval card and eval gate; the
  proposal stays `runnable: false` in code until the gate passes; withdraw as the undo (C.5;
  ADR 0071 point 8).
- An always-human approval answered after its session ended is consumed once by a follow-up
  session of the task that the daemon and the cloud runner share a mark for; a refused late
  answer is consumed and recorded on the task (J.7, S.6; ADR 0088).
- `adding-a-connector.md` filled in and `security.md` describes the injection test suite; the
  docs close-out test asserts both (P.2, P.7, P.11).
- Per-package `test` scripts run vitest from the workspace root on the package's own test
  directory (they matched no files before); `scripts/package-test-scripts.test.ts` pins the shape.
- Android emulator driver: a layout-settle wait, the measurement, hit test and click guard in one
  in-page call before the mouse events, and a fallback ladder announced as `click fallback:` lines
  (shifted mouse click, touch tap, `element.click()`); the hosted emulator smoke passes end to end
  (ADR 0087 amendment).
- `fr vault set <name>` stores a connector secret from stdin or a hidden prompt, never from an
  argument, with one audit row; the shipped `mcp-github` entry references `secret:github_token`,
  the name `fr setup` stores.
### Changed

- Update checks are manual: opening Updates never asks the release feed; **Check for updates**
  does, and installing stays a separate **Update and restart** click. The tray item is
  "Updates…" and only opens the screen. Fresh installs know the project's release feed
  (`github:joelwellbournewood/Forerunner`) and trust its update key `26fae7f48427e5eb`; both
  can be replaced in `update.json` or the environment, and a broken `update.json` turns updates
  off instead of falling back (M.3; ADR 0015 amendment).
- The app's version is one committed value, equal to the tag: `scripts/release-version.mjs`
  writes it into every package and shell manifest (the MSI gets the numeric core), the release
  workflow refuses a tag whose commit carries another version, and the daemon, `fr` and the
  cloud runner report the root `package.json` version.
- An approved plan starts the session it was filed for, bound to the plan the human saw; the
  filing session ends `stopped` instead of `paused` (J.6, J.7, E.1; ADR 0053).
- The Android emulator smoke attaches to the WebView over raw CDP on the page target instead
  of Playwright's browser-level connection (R.1, R.2, R.5, V.3; ADR 0054).
- The inbox is re-checked once more before the session-end writes; a stop read there ends the
  session `stopped` and the handoff says what was and was not written (E.4).
- Email commands need a sending mode other than off: switching to off turns them off with an
  audit row and a notice, and the cloud runner's watcher stands down (T.1; ADR 0081).
- The Known issues entries the 2026-10-23 triage found already fixed are closed with their
  evidence (V.4).

- A cloud voice provider switched off in the Extensions panel is excluded from the registry's
  fallback ("switched off in Extensions"); a cloud row whose grant lost its key is skipped as
  "key not granted" and the vault is never asked; the `voice-local` badge counts any of its
  providers; removing a voice row reloads the voice card (O.4).
- A milestone insert, and a session insert that carries a plan, require a reason and an author
  like every other write (B.5).
- The milestone edit dialog's reason input is `data-testid="milestone-change-reason"`.
### Fixed

- `fr update manifest --version <v>` wrote no manifest: the program's own `--version` took the
  flag (rc.2's publish job, run 40243511397). Program options now count only before a
  subcommand.
- The release workflow's publish job downloads only the build artefacts (the Docker build
  record failed rc.1's run), `SHA256SUMS.txt` covers the signed manifest and never lists
  itself, and the broken manual dispatch trigger is gone.
- Small-project mode: the one milestone is placed after the milestones on file, and a task
  created by email takes the project's default critic tier (B.6; the review of ADR 0051).
- A high-risk change confirmed from the desktop app works on a solo install: the daemon
  registers its own desktop device row and `GET /me` names it (J.3, Q.5, Q.8; the triage P1).
- The live harness records a call the kill switch aborts as `aborted`, and a killed call's
  input tokens stay in the run's cost (ADR 0040 amendment).
- The emulator smoke's clicks are guarded: a click that lands on what moved under the point
  is stopped and sent again, and the runner waits for Home's list (R.1, V.3; ADR 0087).
- A high-risk answer on a phone that cannot confirm is refused with the platform's reason in
  bounded time, and the emulator runner shows the WebView's console (R.5, R.7; ADR 0086).
- Scenario 9's replayed envelope runs once, and the cloud runner's executor keeps a third
  attempt under the project's `critic_ceiling` (R.4, D.3, H.4, V.3).

- `scripts/dev-postgres.sh` set no password and created no database when root ran it with a
  `pg_ctlcluster` server (the SQL now arrives on stdin).
- The phase 2 gate's "offline for 48 simulated hours" clause points at the state service's test
  instead of a skipped placeholder.
- `shell.run()` returns when a killed child exits even if a grandchild keeps the inherited pipes
  open (a clone against a host that never answers no longer blocks the import).
- The startup checklist's "changed since last session" diff reads the last ended session; it read
  the session being started, so the list was always empty.
- Install identity: a recorded `config.json` humanId that names nobody in the configured store
  falls through to the configured email and is re-recorded, never to another human's row; the
  cloud runner's composed runtime is the runner's own agent; `fr doctor` never creates or
  migrates the store; a refused start closes the private memory index (review of
  w4-install-identity).
- Source discovery: a repository URL on another host is refused instead of being read as a GitHub
  source; one scan is bounded at 1,000 candidates; the 409 for another human's source names no
  row; `fr sources` validates kind and status (review of w2-a4-sources).
- Shared secrets: the `secret_ref` mirror keeps the owner's own local grant when a shared grant
  ends; a proposal and a revocation each run in one transaction (review of w2-s13-shared-secrets).
- The handover job checks the fresh agent's memory in the store the memory loop reads (review of
  w4-private-memory).
- Saving the mailbox form keeps the stored TLS, folder and drafts-folder values; the sent-log
  `since=` query takes an ISO instant only (review of w2-email-page).
- PM intake: a proposal with a dependency cycle is refused before it reaches the inbox and an
  approved proposal the writer refuses is recorded once instead of retried for ever; two installs
  apply one approval once; an intake session a dead daemon left running is closed at its deadline;
  a brief that embeds the intake's own markers stays data; a new brief while a proposal is open is
  refused with 409 (review of w2-a2-intake).
- The standard doc set is scaffolded on every project creation path (an accepted source proposal,
  chat and voice `project.create`) and after a rejected intake; the install marker
  `.forerunner/project.json` is written with the doc set so a scan recognises a repository
  Forerunner manages; the critic's drift check leaves `docs/status.md` to the PM (review of
  w2-g5-docs).
- The human is told why a cross-project promotion was declined; an accepted-offer copy cannot be
  proposed again (review of w2-g6-promotion).
- `keystore.properties` escapes non-ASCII as Gradle reads it; the secret keystore, password and
  alias are checked with `keytool` before the build; `release.yml`'s SDK setup names its packages
  (review of w4-android-signing).
### Security

- Always-human approvals: one answer admits one call, spent by the durable port as it is
  handed out and keyed on the raw canonical input (S.6, S.1, J.8, J.10; ADR 0052).
- Email routes fail closed when mounted without an identity port and an owner-check refusal
  is an audited 403; the log masks every key-name form and an empty-user connection string
  (S.4, S.15; ADR 0084).
- An install on a shared store binds to its own human by selector (`FORERUNNER_HUMAN`,
  `fr setup --email`, `config.json`), never to the store's first row, `identity_ambiguous`
  otherwise; `fr doctor` names the binding (F.1, S.4, U.2, U.3; ADR 0082).
- Private memory next to a shared state: a local SQLite index routed by scope; the Postgres
  adapter refuses an `agent_private` write with `MEMORY_SCOPE_VIOLATION` (G.1, G.3, S.1, S.10;
  ADR 0083).
- The Android release APK is signed from the keystore the build writes and verified with
  `apksigner` in the Android and release workflows (R.1, M.3).
- The wave-1 review findings: a Cloudflare approval card shows a `secret:` reference, never
  its value, and an approved plan starts once, under the cap the human saw, on every answer
  path and on the cloud runner (S.4, S.6, J.6, J.7, B.6; ADR 0052 and ADR 0053 amendments).
- Reserved `forerunner.*` secret names (the install's own wrapping key first) are refused on every
  grant, share and reference path with `secret_reserved`; a shared-secret proposal naming the
  wrapping key would have wrapped the install's private key to the peer.
- A private lesson's text no longer reaches the shared store through the weekly consolidation's
  approval request (ids only next to a shared state; ADR 0083 amendment).
- Revoking a device drops the shared-secret copies wrapped to it; only the owner's install can
  revoke a shared grant (the recipient's daemon got 403); revoked installs are refused on serve
  and never targeted again.
- The GitHub token is never sent to a `Link` page on another origin (the release upload origin is
  the one opt-in).
- An email mode change from the Settings page goes through `email.mode.set` (the high-risk card,
  this PC's device answer, the change log and undo); the daemon's `PUT` refuses a mode change
  (403, the command named); `email.mode.set` refuses another human's agent.
- A tagged release refuses to build without the Android release keystore secret and its verifier
  refuses a development-signed APK (ADR 0015 amendment).
- A "stop" said or typed during a live session is the kill switch even with other words in the
  sentence or a change card pending; `/chat` and `/chat/stream` refuse a body naming another human
  (403) and a line never reaches another human's live session (ADR 0078 amendment).
- Cross-project offers follow the repository's ownership rule on a shared store; a proposed lesson
  text is screened by the injection gate again (ADR 0059 amendment).
- The docs clone's token is scoped to the repository's origin (ADR 0069).

### Known issues

Moved to the `[1.0.0]` section, the list that shipped with 1.0.0.
