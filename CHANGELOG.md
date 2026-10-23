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
  comment or review, the comment quoted as data and flagged when instruction-like; the git
  host port reads every page of PR comments with `since` and lists reviews (E.1; ADR 0075).
- Settings → Capabilities → Email: the capability's routes on the daemon, a page per agent
  with the mode picker and the full-discretion confirmation, pause and resume from the tray,
  the command audit (S.15, S.28, S.29, T.14, L.3; ADR 0066).
- What you say during a live session reaches the principal agent at its next task boundary
  (O.9, O.2, E.4; ADR 0078).

### Changed

- An approved plan starts the session it was filed for, bound to the plan the human saw; the
  filing session ends `stopped` instead of `paused` (J.6, J.7, E.1; ADR 0053).
- The Android emulator smoke attaches to the WebView over raw CDP on the page target instead
  of Playwright's browser-level connection (R.1, R.2, R.5, V.3; ADR 0054).

### Fixed

- Small-project mode: the one milestone is placed after the milestones on file, and a task
  created by email takes the project's default critic tier (B.6; the review of ADR 0051).

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
