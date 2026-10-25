# Changelog

All notable changes to Forerunner are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`scripts/release-notes.mjs <tag>` turns the section for a tag into the GitHub Release body, so
every release needs a `## [x.y.z] - YYYY-MM-DD` section here before the tag is pushed. Entries
go under Added, Changed, Deprecated, Removed, Fixed or Security.

## [Unreleased]

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
