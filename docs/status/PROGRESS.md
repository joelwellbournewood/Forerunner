# Progress

Updated by the build agent at every milestone and at least daily. Newest first.

## Milestone status

| Phase | Name | Status | Gate evidence |
| --- | --- | --- | --- |
| 0 | Foundations | CI green on both OS (run 39352102564); fresh-install timing pending the install scripts | gates.md § Phase 0 |
| 1 | Single agent that does real work | gate passed on the fake provider and live on both billing sources (API key in full; the subscription session through the Agent SDK driver, ADR 0044); kill under 2 s live (49 ms); the API-key half probed again on the new key on 2026-10-23 (4 of 5 cases, kill 129 ms; the harness's classification of the aborted call is open, item w4-metered-aborted) | gates.md § Phase 1 |
| 2 | Two agents, one project | gate passed on the fake provider (two agents, five sessions each, claims, peer feed, PR flow, human requests); state service with device auth, realtime, receipts, decision log, GitHub Projects mirror, approvals web fallback done | gates.md § Phase 2 |
| 3 | Critic and quality loop | gate passed live (40 of 40 seeded defects caught, 40 of 40 clean submissions accepted after ADR 0042); reviews tab done | gates.md § Phase 3 |
| 4 | Memory, docs and learning | gate harness passed on the fake provider (four simulated weeks, retrieval under budget, consolidation applied only as approved, no cross-human lesson); memory UI done | gates.md § Phase 4 |
| 5 | Human experience and voice | gate harness passed on the fake provider (simulated week through the daemon API and the phone routes, 29 voice turns, nine settings changes with one change log, 8 phone answers: 5 accepted, 3 of them with the biometric, 3 refused without it; the four runtime findings RT-P5-1 to RT-P5-4 closed, ADR 0049); the Android emulator and real-audio halves pending: the hosted emulator boots and launches the app (run 6), the raw-CDP attach is merged (ADR 0054) and not yet dispatched; the Settings → Capabilities → Email page (ADR 0066), PM intake (ADR 0055) and what you say during a live session (ADR 0078) landed 2026-10-23 | gates.md § Phase 5 |
| 6 | Capabilities | injection suite, live revocation, overnight cloud-runner session, emailed task and spoofed email passed on the fake provider and the in-process mail server; live halves pending a real mailbox and host | gates.md § Phase 6 |
| 7 | Self-improvement and model economics | gate harness passed on the fake provider (a plain-language UI change ships as a signed update, a broken release rolls back on one install and the other never takes it, a model-watch run proposes a switch the human adopts) | gates.md § Phase 7 |
| 8 | Full integration and release 1.0 | nine scenarios pass on Linux (three runs each on 2026-10-20, once more on e42c730 on 2026-10-23) and on Windows in CI (last green on both OS: run 97, before the merges of 2026-10-23; the run on e42c730 pending with its Linux job failed on two stale Postgres integration tests); the hosted emulator boots and launches the app (run 6), the raw-CDP attach merged and not dispatched; requirements 184 done, 39 in progress, 5 todo (S.32 on `wave/w2-s32-indicator`, built, not merged); security suite green, the four review findings of 2026-10-21 closed (ADR 0052, 0084), the three triage P0s fixed, one P1 open; fifteen items merged on 2026-10-23, five of them independently reviewed with their findings open, ten unreviewed; release criteria not met, no release cut; build stopped at the credit limit on 2026-10-23 | gates.md § Phase 8 and § Release 1.0 criteria |

## Log

### 2026-10-23 (item w5-android-high-risk: the high-risk refusal on a phone without biometrics; the runner shows the WebView console)
- `android.yml` run 39952987240 (82a6295) attached to the real WebView, paired and approved,
  then saw no refusal after Confirm on the high-risk card. Built on
  `wave/w5-android-high-risk` (ADR 0085, not merged): every failure of the biometric step is a
  refusal with the platform's reason in bounded time (shell 45 s, UI 60 s); the capability
  names `biometric:allow-status` and `biometric:allow-authenticate`; `run.mjs` forwards the
  page's console and uncaught exceptions as `webview:` lines. Tests: `apps/ui` 42 files /
  272 tests, `apps/mobile/e2e/cdp.test.ts` 22, `cargo test` 30. R.5, R.7 and V.3 keep their
  status until the emulator run passes; the BLOCKERS.md emulator row names the next step
  (merge, dispatch `android.yml`). Report: `docs/status/reviews/w5-android-high-risk.md`.

### 2026-10-23 (item w2-s32-indicator rebased onto 22982fa)
- `wave/w2-s32-indicator` rebased onto `origin/ccr-4d8a843c-1k9syk` (22982fa). Conflicts in
  the UI's fake daemon (the base's runner keys and fast mode next to the branch's desktop
  state), the ADR index (0067 and 0068), runtime.md, BLOCKERS (S.12 and S.32) and this log;
  both sides kept (`docs/status/reviews/w2-s32-indicator.md` `## Rebase`). Current counts:
  UI suite 46 files / 298 tests (`desktop-indicator.test.tsx` 11), `cargo test` 74 passed,
  capabilities 383 and runtime 1098 unit tests passed. Not merged yet.

### 2026-10-23 (item w2-s32-indicator reviewed and fixed)
- Independent review of `wave/w2-s32-indicator` (`docs/status/reviews/w2-s32-indicator.md`
  `## Review`): verdict revise, 72. Three findings, all fixed on the branch:
  1. In the UI, a status re-read answered before a newer `desktop.indicator` frame overwrote
     it and hid the banner for the whole burst. The store now orders frames and reads
     (`desktopOrder`).
  2. The tray had the same race (`ShellState::begin_desktop_read` / `apply_desktop_read`).
  3. The "stopped" line followed any revoke, the Extensions panel's included, and missed a
     tray stop. It now follows stops only, and the end of control re-reads the status.

  ADR 0067 points 4 to 6 are amended. Tests: `desktop-indicator.test.tsx` 11 (from 9), two
  more `store.test.ts` cases, `cargo test` 74 (from 73). Not merged yet.

### 2026-10-23 (item w2-s32-indicator: the desktop-control indicator in the shells, S.32)
- Built on `wave/w2-s32-indicator` from b1804e3 (ADR 0067); builder-verified, not yet
  independently reviewed or merged. `apps/ui`: `DesktopControlBanner` above the header on
  every page while the latest `desktop.indicator` frame is on (white on red, `role="alert"`,
  the agent, the app and the session linked, "Stop desktop control" = `POST /desktop/revoke`,
  then "Resume desktop control"), hidden on off; the store re-reads `GET /desktop/status` at
  bootstrap, on every reopened `/events` stream, on `extension.changed` and in polling.
  Daemon: `GET /desktop/status` carries `desktopControl { active, app, sessionId, agentId,
  since }` (schemas in `api-types.ts`) and the controller sends a fresh `on` when the named app
  or session changes. Desktop shell: the tray's tooltip line, icon title, `Desktop control:
  active (<app>)` item and "Stop desktop control" from the same frame, cleared on off, re-read
  on every reopened stream (`state.rs`, `sse.rs`, `actions.rs`). S.32 `done`: requirements 184
  done, 39 in progress, 5 todo. Tests: `apps/ui/test/desktop-indicator.test.tsx` (9), UI suite
  43 files / 265 tests, `cargo test` 73 passed, capabilities and runtime suites green
  (`docs/status/reviews/w2-s32-indicator.md`). Open: the Android app and the approvals web page
  show no indicator (they do not read the PC daemon's `/events`), no overlay while the window
  is hidden, the manual check on a real desktop and the Windows run of the Rust tests.

### 2026-10-23 (item w2-s12-unlock-card, review and fix: docs/status/reviews/w2-s12-unlock-card.md)
- The daemon's `POST /runner-unlock/wrap` takes `{ requestId }` and wraps only to the challenge on
  a stored, open unlock request of this human (it trusted a card from the body: a key-export
  oracle for any holder of the daemon token). The auto-unlock runs app-wide (desktop Shell,
  phone MobileShell), not only on the inbox screen. `fr runner-key import|status|remove` puts a
  runner's vault key where the daemon reads it (the documented `pnpm fr` stand-in did not
  exist). Tests: runtime `runner-unlock-routes`, `runner-key-cli`; ui `unlock-card`,
  `mobile-unlock`. Open as before: one unlock on the real host; a key import on the phone.

### 2026-10-23 (item w2-s12-unlock-card: the cloud runner unlock card, S.12, ADR 0068)
- The desktop and Android inboxes render a runner's vault-unlock challenge as the unlock card
  (runner, project, filing time, challenge age; Unlock once / allow for 1, 8, 24 h / clear the
  window / Deny). The device side of the protocol moved to `@forerunner/vault`
  (`runner-unlock.ts`, WebCrypto, no imports), shared by the runner, the daemon and the web
  views; the daemon wraps the key from the OS keyring on the desktop (`/runner-unlock/*`), the
  phone wraps it from the Keystore-wrapped secure store; auto-answer inside the window the
  device set (the phone's biometric prompt still runs); read-only without a keyring or the
  key, approvals web included. Tests: cloud-runner `vault-unlock` (WebCrypto answers against
  the real runner), runtime `runner-unlock-routes`, ui `unlock-card` and `mobile-unlock`,
  approvals-web `inbox`. Open: one unlock on the real host; a key import screen (BLOCKERS S.12).
### 2026-10-23 (item w3-e1-triggers: CI results and PR comments start sessions)
- E.1 `done` on `wave/w3-e1-triggers` (review pending): `GitHostWatcher`
  (`packages/runtime/src/session/githost-watcher.ts`) polls the git host on the daemon's clock
  (`FORERUNNER_GITHOST_POLL_MS`, a minute) for the open PRs of the install's agent and fires
  `ci` (a failed, timed-out, cancelled or action-required check once per check run id, with the
  check name and conclusion in the reason; a green head once per sha) and `pr_comment` (a
  comment or review by anyone but the agent's own login) through `Scheduler.requestStart`. The
  comment is quoted as data in the agent's inbox (the brief shows it), scanned for injection,
  flagged and reported (`injection.flagged`, notification); the request and the
  `githost.trigger` audit row carry author and place only. Dedupe keys live in a cursor file
  saved before the start (at most once, across restarts, a baseline first poll); quiet hours
  defer; a refused start is audited, not thrown. The git host port reads every page of PR
  comments with `since` and lists reviews; the fake host honours `since`. ADR 0075 (polling,
  not webhooks; the dedupe rule). Tests: `githost-watcher.test.ts` (13),
  `githost-wiring.test.ts` (5), `githost-feedback.test.ts` (3). Report:
  `docs/status/reviews/w3-e1-triggers.md`.
- Review of w3-e1-triggers (verdict revise, six findings, all fixed on the branch): the agent's
  own text is its token's login plus a hidden mark the port appends (`AGENT_TEXT_MARKER`), so
  the human's comments under their own PAT fire `pr_comment`; the baseline is per PR, so a
  transient error in the first poll never fires a PR's history; the excerpt in the inbox is a
  JSON string with the envelope's markers neutralised; review line comments are read
  (`listPullRequestReviewComments`, fake host `GET|POST /pulls/:n/comments`) and fire
  `pr_comment`; a draft review fires once submitted; the runtime.md Known issues bullet moved
  clear of the base's. Tests: `githost-watcher.test.ts` (18), `githost-feedback.test.ts` (4).
### 2026-10-23 (w4-fcm-sender: the state-service half of Android push, R.6)
- Built on `wave/w4-fcm-sender`, not yet reviewed or merged. The state service sends Android
  push through FCM HTTP v1 (`services/state-api/src/push/`): an OAuth2 access token minted
  from the service account (RS256 JWT, `node:crypto`), the account named by
  `FORERUNNER_FCM_SERVICE_ACCOUNT_REF` and resolved like the admin token, never a value in
  config or logs; the change bus fans out approvals, finished sessions, budget warnings (80 %
  and the cap) and messages to every device of the human with a `push_token`, holding normal
  kinds through the human's quiet hours (the runtime's `isQuietAt` rule) and sending them
  when the window ends; 5xx / 429 retried with backoff; a 404 / `UNREGISTERED` token cleared
  with a `push.token_cleared` audit row; without a service account a visible no-op
  (`/health` `push.mode: "polling"` with the reason). Pairing stores `pushToken`;
  `PUT /devices/:id/push-token` (signed) takes refreshes. ADR 0085 (the brief said 0084,
  which was already taken). Tests: `services/state-api/test/push.test.ts` (17) against fake
  OAuth and FCM endpoints over loopback HTTP; the DeviceRepo push-token case in
  `packages/state/test/suite.ts`. R.6 and K.8 stay `in progress`: the Android app's Firebase
  wiring (google-services.json, firebase-messaging, the messaging service, `fcmToken`) waits
  for a Firebase project (BLOCKERS.md, FCM row). Report: `docs/status/reviews/w4-fcm-sender.md`.
- Reviewed (verdict revise, nine findings, all resolved on the branch): the budget push now
  reads the runner's `stop_reason`, held notices are re-read at the end of quiet hours, only
  FCM's `UNREGISTERED` clears a token, requests time out, the own agent's `info` summary no
  longer double-buzzes, one token on two rows is sent once, a blank pairing token is none.
  `push.test.ts` 25 tests. Review: `docs/status/reviews/w4-fcm-sender.md`, `## Review`.

### 2026-10-23 (fifteen bounded items merged; wave 1 reviewed, its fix stage and waves 2 to 4 stopped at the credit limit; triage; live probe on the new key)
- Base b31c2e5 (the handover of 2026-10-21). Fifteen items were built on `wave/<id>` branches
  and merged (`git log b31c2e5..HEAD --merges`). Wave 1, the handover's item 1: always-human
  approvals spent per call and keyed on the raw input (S.6, S.1, J.8, J.10; ADR 0052); the
  email routes fail closed without an identity port and the log's key-name rule and
  `URL_USERINFO` are fixed (S.4, S.15; ADR 0084); the independent review of B.6 applied (the
  milestone placement, the email task's default tier); an approved plan starts the session it
  was filed for (J.6, J.7; ADR 0053); the Android smoke over raw CDP (ADR 0054). Wave 4, the
  triage's P0s: install identity on a shared store (F.1, U.2, U.3; ADR 0082), private memory
  next to a shared state (G.1, G.3, S.1, S.10; ADR 0083), the signed and verified Android
  release APK (R.1, M.3). Wave 2: PM intake (A.2; ADR 0055), source discovery (A.4; ADR 0056,
  migration 0003), project docs by pull request (G.5; ADR 0058), cross-project promotion (G.6;
  ADR 0059), shared secrets (S.13; ADR 0065, migration 0004), the Settings → Capabilities →
  Email page (S.15, S.28, S.29, T.14; ADR 0066). Wave 3: what you say during a live session
  (O.9; ADR 0078). Requirements 183 done, 40 in progress, 5 todo (from 172 / 48 / 8); the
  Unreleased section of `CHANGELOG.md` carries one entry per item.
- Integration (the commits after the merges; the merge bodies say what was resolved): the
  shared-secrets migration renumbered 0003 → 0004 because the sources item shipped 0003 first
  (the schema test proves v1 + v2 + v3 + v4 equals the generator); the phase-5 gate daemon
  stand-in gained the merged daemon's `RuntimeApp` members; the G.5 scaffold is deferred when
  a project is created with `intake: true`, the intake replaces untouched scaffold
  placeholders, and a session that only filed its plan skips the status write; the ADR index
  rows 0052 to 0084 added centrally (c98eda2). Full check green on e42c730 on the Linux box
  (the paragraph above the criteria table in gates.md: lint, paths, types, 2672 unit tests,
  UI 252, approvals-web 57, live 42, injection 59 of 59, the nine scenarios, docs and secret
  checks, cargo 68); the `integration` project cannot run there (no Postgres).
- Review state: only the five wave-1 items were independently reviewed (w1-approvals accept
  86, w1-email-identity-log accept 88, and-cdp accept 80, w1-b6-review revise 72,
  w1-plan-approval revise 68); the session's credits ran out before the fix stage that
  follows a review. The findings (three high: the project card names a cancelled milestone
  as next; a plan approved by chat or voice starts nothing on a local store; the daemon and
  the cloud trigger can start one approved plan twice; and the medium ones) are fixed on
  `wave/w5-review-findings`, one line per finding in BLOCKERS.md "Open review findings of
  2026-10-23". The other ten items are builder-verified only (their tests, typecheck, docs).
- Credit stops: waves 2b, 3 and 4 were cut mid-wave. Built but not merged (pushed to origin):
  `wave/w2-l6-speak` (3 commits, the builder interrupted before its report, state unknown),
  `wave/w3-b5-reasons` (2 commits, unfinished), `wave/w4-desktop-confirm` (1 commit,
  unfinished, the triage P1). WIP snapshots (uncommitted work saved as a `wip:` commit,
  unreviewed, unverified): `wave/w2-monthly-jobs`, `wave/w2-o1-hotkey`, `wave/w3-a3-import`,
  `wave/w3-o4-voice-prefs`, `wave/w4-metered-aborted`. Not started: w2-chat-memory (J.1,
  O.2), w2-j9-merge (J.9), w2-d20-fastmode (D.20), w2-s32-indicator (S.32), w2-s12-unlock-card
  (S.12), w4-stale-docs, w4-fcm-sender (R.6 service side) and the wave-3 items
  w3-c5-specialist-approval, w3-d4-specialist-settings, w3-d7-performance, w3-d16-slider,
  w3-e1-triggers, w3-e4-recheck, w3-docs-p7-p11, w3-r2-devices, w3-r5-phone, w3-t1-mode-off,
  w3-misc-replay-ceiling; each is named on its requirement row in BLOCKERS.md. Build cost in
  COST.md (wave 1 and 2a and the triage agent measured, the stopped waves not).
- Live: the human provided a new API key and workspace (`.env.build`,
  `FORERUNNER_LIVE_BUDGET_USD=200`, per-run cap 15 USD unchanged). One probe of the phase 1
  file on it, run `2026-10-23T09:49:08.123Z`: USD 0.1170, ledger USD 6.0479 of 200
  (1b3de7e); 4 of 5 cases passed (3 coder tasks with tier 1 reviews, the chat turn); the kill
  switch stopped the session in 129 ms with the claims released, but the metered provider
  recorded the call aborted mid-flight as `ok` with no usage, so the `aborted` assertion
  failed: a harness classification defect (item w4-metered-aborted, WIP on its branch). The
  key and the subscription token of 2026-10-20 still have to be revoked.
- Triage (criterion 4): `docs/status/reports/triage-2026-10-23.md` (962cb18) classified every
  known issue: 3 P0, 1 P1, 163 P2, 20 stale entries, the rest design notes. The three P0s are
  fixed and merged the same day (install identity, private memory, Android signing); the P1
  (a high-risk confirmation from the desktop app) is partly built on
  `wave/w4-desktop-confirm` and not merged; the 20 stale entries are not yet edited
  (w4-stale-docs not built). Criterion 4 is still not met.
- Android: the raw-CDP attach is merged but `android.yml` was not dispatched, so it has not
  met the hosted emulator; the release APK signing and the apksigner check in the workflows
  are merged and not yet exercised in a run. The phase 5 emulator row stays pending.
- Repository and CI: `joelwellbournewood/Forerunner` is a public repository on GitHub
  (`visibility: public` by the REST API on 2026-10-23), so the secret scan and the
  credentials-only-in-`.env.build` rule matter for every push; `ci.yml` now runs by hand and
  on pushes to `ccr-**` branches (ccf9504), so the release branch has runs again: run 95 on
  962cb18 Linux green, Windows red on one pwsh test timeout
  (fixed by 2f8fbd9); run 97 on a5b8823 green on both OS (before the merges); run 98 on
  1d849c8 (mid-merge) red on the missing ADR index rows (fixed by c98eda2); run 99 on
  c98eda2 red on both OS in the integration step on two Postgres tests the merges left stale
  (`migrations.integration.test.ts` expects `applied [2]`, now `[2, 3, 4]`; the conformance
  "keeps private lessons private" case seeds an `agent_private` row on Postgres, refused since
  ADR 0083); run 100 on e42c730 pending at the time of writing, its Linux job already failed
  on the same step. Nothing was recorded as passed on today's runs; the fix is handover item 1.

### 2026-10-21 (security fixes landed, audit export, small-project mode, sign-off follow-up; build stopped at the credit limit)
- Security: the 45 findings pinned by the review's `it.fails` tests are fixed in the state service,
  the store, the commands, the platform log, the runtime hooks, the SDK driver, the tokens, the
  daemon, the vault, the browser, email and Cloudflare; no expected-failure marker remains. The
  independent review of the fixes accepted the daemon/vault and capabilities surfaces (88, 78)
  and sent the state-service (78) and runtime-hooks (70) surfaces back with medium findings
  (listed under "Where to pick up"); their fix stage was interrupted when the credits ran out.
- S.9 audit log export (daemon route, state-service route, `fr audit export`, UI button) built,
  reviewed and accepted (88). The sign-off and session.start undo follow-up built, reviewed,
  fixed and accepted. B.6 small-project mode built with its tests; its independent review did
  not complete before the stop.
- Android: the hosted runner now boots the emulator (52 s) after the disk clean-up and builds,
  installs and launches the debug APK (run 6); the WebView attach failed on a CommonJS import
  shape (fixed in 6542a3f) and then, in run 7, on the WebView refusing Playwright's
  browser-level CDP connection; the raw-CDP attach is the next step ("Where to pick up").
- Requirements 172 done, 48 in progress, 8 todo. Progress report 6 posted to the contact issue.

### 2026-10-20 (requirements close-out, security review, runtime follow-ups; build stopped for budget)
- Requirements close-out over all 22 sections: every in-progress row verified against the code
  and its tests; 170 done, 49 in progress, 9 todo of 228 (from 160 / 57 / 11). Fourteen new
  close-out tests pin the rows that moved. Each remaining gap is a `BLOCKERS.md` row that says
  "missing in code", "partly built" or "docs gap" with the stand-in in use.
- Integrated security review in three surfaces (state service and clients; runtime, vault and
  tokens; capabilities and runners): 17 adversarial test files, 185 tests, 42 of them
  `it.fails` markers that pin an open finding with its attack path and proposed fix in the test.
  The fix stage was stopped for budget after the first surface's fixes started; the markers
  stay until the fixes land.
- Runtime follow-ups from the phase 5 week: an accepted tier 3 sign-off closes the task
  (`syncSignoffAnswers`); the undo of `session.start` stops the started session; registry
  commands reach the model path through the daemon's tools; a UI change names its source;
  the peer rollback wording names the shared state; the answer route writes the decision log.
  Two of three items reviewed and accepted (85, 88); the third's fix was cut off by the stop.
- Android: four dispatches of `android.yml` built the APK and the emulator exited at once for
  lack of disk space on the runner after the Tauri build (the verbose run 4 named it); the
  workflow now frees the disk first. The emulator rows stay pending until a dispatch passes.
- CI green on both OS at runs 84 and 85. Release criteria table filled in `gates.md`: not
  met, no release cut. Progress report 5 posted to the contact issue.

### Where to pick up (handover)
In this order, each item a wave of its own with the snapshot procedure in `AGENTS.md`: a
failing test first, the maintainer doc in the same change, an independent review before the
merge, the requirement row and its BLOCKERS.md row updated at integration.
1. CI is green on 049ed52 on both OS (https://github.com/joelwellbournewood/Forerunner/actions/runs/39950018548);
   fix the open review findings of wave 1 (BLOCKERS.md row "Open review findings of
   2026-10-23"). CI, done in 049ed52: the two Postgres tests
   the merges left stale, `packages/state/test/migrations.integration.test.ts` (expects
   `applied [2]`, now `[2, 3, 4]` and version 4) and the conformance case "keeps private
   lessons private" in `packages/state/test/suite.ts` (seeds an `agent_private` row on
   Postgres, refused since ADR 0083: seed it on SQLite only or assert the refusal as the
   sibling case does); push and record the green run on both OS. The review findings are
   fixed on `wave/w5-review-findings` (BLOCKERS.md section "Open review findings of
   2026-10-23"); merge it after its own review, then re-review w1-b6-review and
   w1-plan-approval on the merged code. The branch's own independent review
   (`docs/status/reviews/w5-review-findings.md`, revise 80) found two more defects, fixed on
   the branch (a cloud plan start failing in the background spent the approval silently; the
   Cloudflare port's own approval card showed a resolved secret). One point found while fixing
   stays open there: a hooks approval answered after its session ended is never reused (J.7 /
   S.6 follow-up).
2. Finish the partly built branches, each with its tests, maintainer doc and review:
   `wave/w4-desktop-confirm` (the triage P1, 1 commit), `wave/w3-b5-reasons` (B.5, 2 commits),
   `wave/w2-l6-speak` (L.6, 3 commits, state unknown: read the diff before building on it);
   then the WIP snapshots `wave/w4-metered-aborted` (the live harness's aborted-call
   classification, needed before item 5), `wave/w2-monthly-jobs` (H.7, P.15),
   `wave/w2-o1-hotkey` (O.1), `wave/w3-a3-import` (A.3), `wave/w3-o4-voice-prefs` (O.4); a
   `wip:` commit is unreviewed and unverified, so start from its diff, not its claims.
3. Build the unbuilt items one at a time, each with an independent review before the merge
   (the BLOCKERS.md row of each names the gap and the fix): w2-chat-memory (J.1, O.2),
   w2-j9-merge (J.9), w2-d20-fastmode (D.20), w2-s32-indicator (S.32; built and reviewed on
   its branch 2026-10-23, the findings fixed, awaiting the merge), w2-s12-unlock-card (S.12), w4-fcm-sender (R.6, the service side), w3-c5-specialist-approval (C.5),
   w2-j9-merge (J.9), w2-d20-fastmode (D.20), w2-s32-indicator (S.32), w2-s12-unlock-card
   (S.12), w4-fcm-sender (R.6, the service side; built on its branch 2026-10-23, review and
   merge pending), w3-c5-specialist-approval (C.5),
   w3-d4-specialist-settings (D.4), w3-d7-performance (D.7, D.19), w3-d16-slider (D.16),
   w3-e1-triggers (E.1), w3-e4-recheck (E.4), w3-docs-p7-p11 (P.7, P.11), w3-r2-devices (R.2),
   w3-r5-phone (R.5), w3-t1-mode-off (T.1), w3-misc-replay-ceiling (scenario 9's replay
   `it.todo`, the executor's ceiling rung). Then an independent review of each of the ten
   items merged on 2026-10-23 without one (w4-install-identity, w4-private-memory,
   w4-android-signing, w2-a2-intake, w2-g5-docs, w2-g6-promotion, w2-a4-sources,
   w2-email-page, w2-s13-shared-secrets, w3-o9-chat-to-inbox), applying what they find.
4. The 20 stale doc entries of the triage report (section "Already fixed": the code is right,
   the Known issues bullet is not): edit each bullet (item w4-stale-docs), then re-read the
   triage against the items above and confirm no P0 or P1 remains (V.4).
5. Android dispatch and the live gate re-run. Dispatch `android.yml` (the emulator job runs
   the raw-CDP smoke, `pnpm --filter @forerunner/mobile test:emulator`, and the apksigner
   check); on `PASS: Android emulator smoke complete` record the phase 5 emulator row and
   scenario 9's Android run in gates.md. Live: from `tests/live`, with `ANTHROPIC_BASE_URL`
   unset and `FORERUNNER_LIVE_BUDGET_USD` as set in `.env.build` (200), the key in
   `FORERUNNER_ANTHROPIC_KEY` and the workspace in `FORERUNNER_ANTHROPIC_WORKSPACE_ID`, run
   `pnpm --filter @forerunner/live test:live` (the phase 1, timing and phase 3 files; add
   `tests/live/test/live-4-subscription.live.test.ts` once a new subscription token exists);
   fix the aborted-call classification first (item 2) or the kill case fails on the harness
   again; record every run in COST.md and gates.md with its ledger total.
6. CI evidence on both OS: a green `ci.yml` run on the final build on `ubuntu-latest` and
   `windows-latest` (the nine scenarios and the security files run there), linked from
   gates.md phase 0 and criteria 3 and 5; `desktop.yml` on Windows for the shell; then every
   earlier gate re-run on the final build and the phase 8 "re-run" row filled.
7. Severity triage follow-up and the release: re-classify what the items above closed, the
   P2 list into the release notes, then tag `v1.0.0` only when every row of the criteria
   table in gates.md reads met (`release.yml` builds Windows, Linux and Android artefacts,
   writes the changelog section and signs the update manifest with `UPDATE_SIGNING_KEY`).
Credentials: the API key and the subscription token used on 2026-10-20 must be revoked and
re-issued (the key of 2026-10-23 is the live one, in `.env.build`); the ledger
`tests/live/spend.json` carries every live call (USD 6.05 of 200).

### 2026-10-20 (subscription path live, gate harnesses 5 and 7, daemon capabilities wired)
- Snapshots 692a8fe/6c9919e (per-task billing source and the Agent SDK session path, ADR 0044;
  the live subscription half: three tasks through a real Claude Code subprocess on the
  subscription, plan share recorded; SDK kill ends at the abort), 0057e53 (Android workflow on
  an API 30 test image after the hosted emulator never booted on API 34; desktop workflow green
  on both OS). CI green at run 82. Phase 5 and 7 gate harnesses (ADR 0045, 0046) and the
  runtime-gaps wave (browser and email tools in the daemon with the injection notification, ADR
  0047; a voice bridge and routes, ADR 0048; phone command replay dedupe) in the next snapshot.
- Running: requirements close-out (five section groups), the four runtime defects the phase 5
  harness pinned. Next: the security review wave, Windows and Android scenario rounds, release
  artefacts and criteria.
- The user funds the remaining build with about 320 USD from 19:50 UTC.

### 2026-10-20 (phase 3 gate passes live, nine scenarios, remote commands and sync gate landed)
- Snapshots 984ed45 (live harness, ADR 0040), 612ec33 (remote commands owner filter and PC
  pickup, pause as graceful stop, presence heartbeat, install record and schema sync gate, ADR
  0041), 9ceecb6 (nine scenarios on the fake provider, critic evidence and escalate default per
  ADR 0042, Claude Code tool names per driver per ADR 0043, integer run-row milliseconds, queue
  consume scoped per human, periodic claim renewal); ADR 0010 written. CI green on both OS at
  run 75. Progress report 4 posted.
- Live: phase 1 API-key half passed in full (run 18:58 UTC: 3 of 3 tasks, accept 93 to 95,
  kill 49 ms); phase 3 gate passed on the re-run (40 of 40 caught, 40 of 40 clean accepted,
  USD 2.32); ledger USD 5.86 of 100. Subscription token received; the Agent SDK session path
  and the live subscription half are being built (ADR 0044).
- Requirements 109 done / 106 in progress / 13 todo; milestone rows 25 of 30 passed.

### 2026-10-20 (live model runs, wiring passes, phase 3 and 4 harnesses landed)
- Credits restored (API key with a workspace id for live runs, build credits). Snapshots since
  the last report: voice and sandbox fixes, reviews of model watch, desktop control, data assets
  and sandbox applied, notifications and Cloudflare wired (ADR 0038), adopted model settings,
  desktop control and data assets wired (ADR 0039, c8c709b), workspace-scoped key support in
  setup and the daemon, phase 3 and 4 gate harnesses on the fake provider in CI, cloud runner on
  Hono with the billing router, release workflow signs an update manifest when the key secret is
  present. CI green on both OS at run 67.
- First live model run (ADR 0040, `tests/live`, USD 2.66 of the 100 cap): phase 1 API-key half
  passed (3 PRs, kill switch 28 ms), response-time table measured (Haiku first token median
  687 ms), critic tier 1 timing met (100 reviews, max 13.7 s). Phase 3 live gate failed on the
  pass rate (clean work accepted 37.5%, catch 100%); fix wave running. Bugs found live: fractional
  `ttft_ms` into an integer column (run rows lost), registry `cc:*` tools unmapped on the loop
  driver, queue items never consumed. All in the fix wave.
- Running: remote command owner filter and PC pickup, install record and sync gate, nine
  scenario harnesses (world and scenarios 1, 4, 5 done), live harness review.

### 2026-10-20 (core loop, Android, cloud runner, UI phase 2 landed; credits out again)
- Snapshots 3f9b436 (cloud runner, phase 6 gate rows), 2560623 (core loop closed per ADR 0036,
  Android app per ADR 0032, UI phase 2 pages, notifications, Cloudflare, update and extension
  review fixes) plus CI timing fixes; CI green on both OS at run 54. Progress report 3 posted.
- Requirements 100 done / 111 in progress / 17 todo. Still unwired: notifications, Cloudflare,
  model-watch settings, desktop control, data assets; reviews pending for model watch, desktop
  control, data assets, sandbox; voice fix pass cut off.
- Every wave stopped on the account credit limit a second time at about 15:00 UTC; the
  resumed round used 10.7M sub-agent tokens (COST.md).

### 2026-10-20 (approvals web and desktop shell landed)
- Credits restored; the four cut-off waves resumed with a note to continue from their partial
  files (core loop, UI phase 2, phase 3 and 4 gate harnesses; desktop shell fixes and Android;
  cloud runner and approvals web fixes; notifications, Cloudflare and the update and extension
  critics).
- Snapshot 9f367b3: approvals web (46 tests, ADR 0034), desktop shell (ADR 0031), update CLI
  (`fr update manifest|sign`) and extension cost helpers, ADR 0009/0024 amendments, ADR 0026
  restart code reconciled with the runtime (86). CI gained the UI and approvals-web test step
  and failed once on timing only (daemon test setup on Windows, first SSE event wait on
  Linux); both waits lengthened in the next commit, which also carries the shell and
  approvals fix passes (68 cargo tests with fmt and clippy clean; 49 approvals tests).

### 2026-10-20 (waves 2 and 4a landed)
- Snapshots: email and browser capabilities (8367764); daemon wiring of extensions, updates,
  model watch, estimates, mirror and sandboxes, context savings per ADR 0003, requirement
  statuses 72 done / 128 in progress / 28 todo (42c69b3); critic, memory, commands and the
  state service after tier-2 review (b29605d). CI green on both OS for each.
- Started: desktop shell and Android app (wave 4b), cloud runner and approvals web (wave 4c).
  Injection suite still building; notifications, Cloudflare, desktop control, data assets
  resume next.

### 2026-10-20 (snapshot after the usage-limit stop)
- Every background build wave stopped on an account usage limit at about 02:20 UTC (reset
  05:10 UTC); finished agents were kept, cut-off agents resume with a note to continue from
  their partial files.
- Phase 0 gate complete: fresh install timed on fresh runners (Linux 89 s, Windows 200 s,
  run 39357536106). Phase 2 local gate passed (two agents, five sessions each, no duplicate
  task, no lost commit, every handoff acknowledged); the offline-48-hours half waits for the
  state service sync.
- Snapshot committed: phase-1 UI, shared state service, extensions registry, GitHub Projects
  mirror, sandbox adapters, signed updates, model watch and estimates, sandboxed browser
  (commit 5c031bd). Daemon gained the UI conventions of ADR 0025, the peer feed, the decision
  log; the runner gained message receipts and peer overlap detection.
- Resumed: critic, memory, commands, email, browser, injection suite. Started: wiring of the
  new modules into the daemon and CLI, context-savings leftovers of ADR 0003, requirements
  status pass.

### 2026-10-20 (daemon and waves 2-3)
- Local daemon API (ADR 0011): composition root, Hono server on 127.0.0.1 with a bearer token
  in `daemon.json`, SSE streams, `fr daemon`; smoke-tested end to end with the fake provider.
- Snapshot of finished agent work: specialist registry and eval sets, voice pipeline (ADR 0012),
  testenv mail server and GitHub stand-in. CI green on both OS (run 39355978010).
- Peer activity feed and overlap detection in the session runner; PR executor reports changed
  files for it.
- Waves in flight: phase-1 UI, state service, critic, memory, commands (wave 2); email,
  browser, injection suite (3a); updates, extensions, notifications, Cloudflare (3b); model
  watch and estimates, GitHub Projects mirror, desktop control, data assets (3c).
- Progress report 2 posted to the contact issue.

### 2026-10-20 (later)
- Sessions: startup checklist, state brief, planner, claims, executor, scheduler, state ports.
  Conversation agent (notes, draft tasks, request answers, session control with read-back
  confirmation). Billing wired into the enforcement ports. Capabilities: git host contract,
  GitHub adapter, local git operations, PR task executor with rebase-before-PR and conflict
  escalation, in-memory git host. Phase 1 gate test passes on the fake provider.
- First fully green CI run on Windows and Linux (run 39352102564). Wave 1 snapshot committed
  (state, vault, billing, fake provider, requirements, ADRs).
- Android: SDK 34, NDK 27 and Rust targets installed; `tauri android init` generated the
  project; the debug APK build fails in Gradle (being diagnosed).

### 2026-10-20
- `@forerunner/runtime` core: capability tokens, enforcement hooks (budget, steps, wall clock, kill,
  tool allowlist, paths, domains, autonomy, secrets, injection wrapping, audit), session budget with
  the 80% rule and review reserve, kill switch (40 runs + 3 processes stopped under 2 s in test),
  in-process agent loop, Anthropic Messages adapter, Agent SDK driver, model ladder and retry
  ladder, brief validation, context compression baseline (ADR 0003), setup validators, `fr` CLI
  (setup, status, doctor, kill, dirs) with a cross-process kill file. 100+ unit tests.
- Shared UI scaffold (`apps/ui`), Tauri desktop and Android shells, approvals web skeleton.
  Desktop shell passes `cargo check` on Linux. Android SDK, NDK and Rust targets installed in the
  build box.
- Parallel wave 1 in progress (state, vault, billing, testenv provider/mail/git host, scripts,
  requirements, ADRs 0002/0003); wave 1b in progress (specialist registry and eval sets, voice,
  sandboxes). `docs/requirements.md` written: 228 requirements with IDs A.1–V.9.
- Progress report 1 posted to the contact issue (joelwellbournewood/Forerunner#1).

### 2026-10-19
- Repository created from empty. Monorepo scaffold, `@forerunner/platform` (paths, shell runner,
  simulated clock, redacting logger) with tests. ADR 0001 (stack). Local Postgres 16 and a
  Docker daemon are available in the build container; Tauri Linux system libraries installed.
- Human checklist reviewed: no build budget, no Anthropic API key, no subscription token, no
  Cloudflare token, no mailboxes, no voice keys, no signing certificate, no cloud host were
  provided. All logged in `BLOCKERS.md` with the stand-in in use. GitHub access to
  `joelwellbournewood/Forerunner` exists (push). Work continues with stand-ins.
