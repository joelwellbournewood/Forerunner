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
| 8 | Full integration and release 1.0 | nine scenarios pass on Linux (three runs each on 2026-10-20, once more on e42c730 on 2026-10-23) and on Windows in CI (last green on both OS: run 97, before the merges of 2026-10-23; the run on e42c730 pending with its Linux job failed on two stale Postgres integration tests); the hosted emulator boots and launches the app (run 6), the raw-CDP attach merged and not dispatched; requirements 190 done, 33 in progress, 5 todo (S.32 merged from `wave/w2-s32-indicator` in c83a15d; D.16 `done` on `wave/w3-d16-slider`, reviewed and rebased onto cac6fee, merged in 443139a; D.4 done on its item branch, rebased onto 4ff4fb1, 2026-10-23; T.1 on `wave/w3-t1-mode-off`, built, rebased onto 38ae8cc, not merged); security suite green, the four review findings of 2026-10-21 closed (ADR 0052, 0084), the three triage P0s fixed, one P1 open; fifteen items merged on 2026-10-23, five of them independently reviewed with their findings open, ten unreviewed; release criteria not met, no release cut; build stopped at the credit limit on 2026-10-23 | gates.md § Phase 8 and § Release 1.0 criteria |

## Log

### 2026-10-23 (item w3-r2-devices rebased onto 38ae8cc)
- `wave/w3-r2-devices` rebased a third time, onto `origin/ccr-4d8a843c-1k9syk` at 38ae8cc
  (after the merges of w3-d4-specialist-settings, D.4, and w3-r5-phone, R.5). Conflicts in the
  UI's `client.ts`, `SettingsPage.tsx` and `fixtures.ts` (the base's model settings imports and
  `ModelSettingsSection` next to the branch's pairing view and `DevicesSection`; both sections
  render), `fake-daemon.ts` (the base's model settings types next to `PairingStartView`),
  apps.md (the `/settings` row holds the Devices section and D.4's Models section, both route
  lists), BLOCKERS.md (the branch's R.2 row next to the base's R.5 row) and this log; both
  sides kept (`docs/status/reviews/w3-r2-devices.md` `### Rebase onto 38ae8cc`). Current
  counts: UI suite 53 files / 360 tests (`settings-devices.test.tsx` 11, `settings.test.tsx`
  10, `settings-models.test.tsx` 8), runtime 138 files / 1276 unit tests passed and 1 skipped
  (`devices-routes.test.ts` 11), state-api 12 files / 163 (`desktop-devices.test.ts` 4);
  requirements 190 done, 33 in progress, 5 todo on the branch (the base 189 / 34 / 5). Not
  merged yet.

### 2026-10-23 (item w3-r2-devices rebased onto 4ff4fb1)
- `wave/w3-r2-devices` rebased again, onto `origin/ccr-4d8a843c-1k9syk` at 4ff4fb1 (after the
  merges of w2-l6-speak, w3-c5-specialist-approval, w3-d16-slider, w3-e4-recheck and
  w5-android-high-risk). Conflicts in the UI's `client.ts` (the base's speak imports next to
  the pairing body), apps.md (the `/settings` row holds the Devices section and the D.16
  slider; the `settings-devices` and `settings-slider` test rows both kept) and this log; both
  sides kept (`docs/status/reviews/w3-r2-devices.md` `### Rebase onto 4ff4fb1`). Current
  counts: UI suite 49 files / 334 tests (`settings-devices.test.tsx` 11, `settings.test.tsx`
  10), runtime 134 files / 1216 unit tests passed and 1 skipped (`devices-routes.test.ts` 11),
  state-api 12 files / 160 (`desktop-devices.test.ts` 4); requirements 189 done, 34 in
  progress, 5 todo on the branch (the base 188 / 35 / 5). Not merged yet.

### 2026-10-23 (item w3-r2-devices rebased onto cac6fee)
- `wave/w3-r2-devices` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee). Conflicts in the
  daemon's `compose.ts` and `server.ts` (the base's git host watcher and runner unlock routes
  next to the branch's `DeviceManager` and `/devices` routes), the UI's `client.ts`,
  `SettingsPage.tsx` (the base's fast-mode card next to the Devices section), `fake-daemon.ts`
  and `fixtures.ts`, apps.md, runtime.md, CHANGELOG and this log; both sides kept
  (`docs/status/reviews/w3-r2-devices.md` `## Rebase`). Current counts: UI suite 47 files /
  310 tests (`settings-devices.test.tsx` 11, `settings.test.tsx` 10), runtime 129 files /
  1143 unit tests passed and 1 skipped (`devices-routes.test.ts` 11), state-api 12 files /
  160 (`desktop-devices.test.ts` 4); requirements 186 done, 37 in progress, 5 todo on the
  branch. Not merged yet.

### 2026-10-23 (item w3-r2-devices reviewed and fixed, R.2)
- Independent review of `wave/w3-r2-devices` (`docs/status/reviews/w3-r2-devices.md`,
  verdict revise, 72/100, seven findings). Fixed on the branch: the daemon's calls to the
  state service time out (`DEVICE_SERVICE_TIMEOUT_MS`, 15 s) instead of holding the app;
  a lost phone whose row is in the daemon's store is revoked there when the service is down,
  hung or refuses the token (`via: "store"`); every revocation from Settings writes the
  `change_log` row the registry's `device.revoke` writes (source `ui`, irreversible); the
  Devices section re-reads the list while a code is live and closes the pairing when the
  phone appears; a loopback service URL in the QR is warned about; the state-service.md
  test table holds its new row. Left to the merge: the textual conflicts with the base in
  `fixtures.ts`, apps.md and runtime.md. R.2 stays `done` on the branch.

### 2026-10-23 (item w3-r2-devices built: Settings → Devices on the desktop, R.2)
- Branch `wave/w3-r2-devices`, continuing the earlier attempt's uqr pin and its unverified
  `wip:` snapshot of the daemon side. The daemon gained `GET /devices`, `POST /devices/pairing`
  and `POST /devices/:id/revoke` (`packages/runtime/src/devices/`, shapes in
  `devices/types.ts` through `daemon/api-types`): it asks the state service for a pairing code
  and revokes through it with the admin token from its vault, which never reaches the app
  (ADR 0009; no new ADR, the brief named none). The desktop `SettingsPage` has a Devices
  section: Pair a phone shows the QR of the `fr://` link, the typed code and the expiry
  counting down on an injectable `UiClock`; the list shows name, kind, paired at, last seen
  and this device; Revoke asks, then removes the device at once; a daemon without the routes
  shows the route-missing state (ADR 0037). Tests: `apps/ui/test/settings-devices.test.tsx`
  (8; 11 after the review), a Devices case in `apps/ui/test/settings.test.tsx`, `packages/runtime/test/devices-routes.test.ts`
  (7; 11 after the review), `services/state-api/test/desktop-devices.test.ts` (4, the real service routes end to
  end). R.2 moves to `done` (184 done, 39 in progress, 5 todo on this branch at the build; 186 / 37 / 5
  after the rebase onto cac6fee); the BLOCKERS.md
  row says what is left (a web-link button, a live list refresh) and the report is
  `docs/status/reviews/w3-r2-devices.md`. Not reviewed, not merged.

### 2026-10-23 (item w3-d7-performance rebased onto 38ae8cc)
- `wave/w3-d7-performance` rebased onto `origin/ccr-4d8a843c-1k9syk` (38ae8cc, after the merges
  of w3-d4-specialist-settings (D.4, ADR 0072) and w3-r5-phone (R.5, ADR 0080)). Conflicts in
  `models/ladder.ts` (the base's `specialistMode` next to `INTAKE_RUN_SPECIALIST`),
  `session/intake.ts` imports (the base's `DEFAULT_CEILING`, `effortWithOffset` next to
  `INTAKE_RUN_SPECIALIST`), the UI fixtures' imports (`ModelSettingsView` next to
  `PerformanceView`), runtime.md (the phone's push-to-talk paragraph next to the Performance
  view section), BLOCKERS (the base's D.4 row, the branch's D.7/D.19 row) and this file; both
  sides kept (`docs/status/reviews/w3-d7-performance.md`, `## Rebase (onto 38ae8cc)`). Two
  follow-ups against the base's code: the branch's intake Run row tests reused the project
  names of the base's D.4 intake tests (duplicate name, 500), renamed; and the view's effort in
  force now starts from the principal's D.4 effort setting where one is set (`effortSource`),
  as the intake, the chat and the executor take it. Current counts: runtime unit 139 files /
  1281 passed, 1 skipped (`performance-view.test.ts` 10, `performance-route.test.ts` 4,
  `intake.test.ts` 16); UI 52 files / 353 tests (`performance.test.tsx` 9); requirements 191
  done, 32 in progress, 5 todo. Not merged yet.
### 2026-10-24 (item w3-t1-mode-off rebased onto 38ae8cc)
- `wave/w3-t1-mode-off` rebased onto `origin/ccr-4d8a843c-1k9syk` (38ae8cc, after the merges
  of w3-d4-specialist-settings (D.4) and w3-r5-phone (R.5)). Conflicts in the ADR index (0080
  next to 0081), BLOCKERS (twice: R.5 and V.1 next to T.1), this log (three times: the base's
  entries, the item list's R.5 and T.1 clauses, the phase 8 row), apps.md (the `/settings` row
  with the base's Models section, the email page row with the branch's ADR 0081 clause), the
  command ports (`modelSettings` next to `emailMode`) and the daemon's command ports in
  `compose.ts` (the same); both sides kept (`docs/status/reviews/w3-t1-mode-off.md` `## Rebase
  onto 38ae8cc`). Requirements on the rebased branch: 190 done, 33 in progress, 5 todo of
  228. Current counts: capabilities 36 files / 393 tests, commands 12 / 173, cloud-runner
  9 / 64, runtime 137 / 1267 (1 skipped), UI 52 / 349 unit tests passed. Not merged yet.

### 2026-10-24 (item w3-t1-mode-off rebased onto 4ff4fb1)
- `wave/w3-t1-mode-off` rebased again onto `origin/ccr-4d8a843c-1k9syk` (4ff4fb1, after the
  merges of w2-l6-speak, w3-c5-specialist-approval, w3-d16-slider, w3-e4-recheck and
  w5-android-high-risk). Conflicts in this log (twice: the base's entries and the phase 8 row
  next to the branch's), commands.md (the test list: the base's `summary.speak` and
  `voice_alerts` cases and forty-four intent phrases next to the ADR 0081 `email.mode.set`
  cases), the command ports (`speak` next to `emailMode`), the daemon's command ports in
  `compose.ts` (the `speak` port next to `emailMode`) and apps.md (the `/settings` row with the
  base's D.16 slider, the email page row with the branch's ADR 0081 clause); both sides kept
  (`docs/status/reviews/w3-t1-mode-off.md` `## Rebase onto 4ff4fb1`). Requirements on the
  rebased branch: 189 done, 34 in progress, 5 todo of 228. Current counts: capabilities 36
  files / 393 tests, commands 11 / 168, cloud-runner 9 / 64, runtime 133 / 1207 (1 skipped),
  UI 48 / 323 unit tests passed. Not merged yet.

### 2026-10-24 (item w3-t1-mode-off rebased onto cac6fee)
- `wave/w3-t1-mode-off` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee). Conflicts in
  BLOCKERS (K.8, L.3, T.1 and V.1), this log, commands.md (the test list), the command ports
  (`requestAnswered` and `pricingTable` next to `emailMode`) and the daemon's command ports in
  `compose.ts` (`requestAnswered` and `memory` next to `emailMode`); both sides kept
  (`docs/status/reviews/w3-t1-mode-off.md` `## Rebase`). Requirements on the rebased branch:
  186 done, 37 in progress, 5 todo. Current counts: capabilities 36 files / 393 tests,
  commands 10 / 152, cloud-runner 9 / 64, runtime 128 / 1134 (1 skipped), UI 46 / 299 unit
  tests passed. Not merged yet.

### 2026-10-24 (item w3-t1-mode-off reviewed and fixed)
- Independent review of the T.1 build (`docs/status/reviews/w3-t1-mode-off.md`, `## Review`):
  verdict revise, three findings, all fixed on the branch. High: `email.mode.set` (chat,
  voice, the phone, the agent's `email_mode_set` tool) wrote the settings row past the store,
  so a change to off kept commands on with no audit row or notification; the daemon now hands
  it to the settings store through `CommandPorts.emailMode` (ADR 0081 amended), the card says
  commands go off and the undo turns them back on. Low: a running cloud-runner watcher stands
  down with the reason in `/health` when commands go out of force under it; the email page's
  commands toggle follows the stored value and the mode note says commands went off.

### 2026-10-23 (item w3-t1-mode-off: T.1 done, ADR 0081)
- Email commands at sending mode off, one reading decided, enforced and tested (ADR 0081):
  commands need a sending mode other than off. The settings store refuses turning them on at
  off with a plain message (400 on the daemon's `PUT`; the settings page of wave/w2-email-page
  reads the same validation), a mode change to off turns them off with an `email.settings`
  audit row and an `email_commands_off` notification to the owner, the gate obeys nothing at
  off and the runner's `EmailWatch.start` refuses to start at off with the reason in the log
  and the health status. Replies to the owner stay allowed in every mode where commands can be
  on. T.1 `done` (requirements after the rebase onto cac6fee: 186 done, 37 in progress, 5
  todo); its BLOCKERS row resolved; email.md, cloud-runner.md, notifications.md and runtime.md updated. The B.6
  residual was left to wave/w1-b6-review as the brief says. Build report:
  `docs/status/reviews/w3-t1-mode-off.md`.
### 2026-10-23 (item w3-misc-replay-ceiling rebased onto 38ae8cc)
- `wave/w3-misc-replay-ceiling` rebased onto `origin/ccr-4d8a843c-1k9syk` (38ae8cc), which had
  since merged w3-d4-specialist-settings (D.4) and w3-r5-phone (R.5). Conflicts in
  requirements.md (D.3 next to D.4, R.4 next to R.5: the base's D.4 and R.5 rows and the
  branch's D.3 and R.4 test lists), this log (the base's D.4 and R.5 entries next to this
  item's; the "Next" line with both clauses) and the executor's ladder import (D.4's
  `specialistMode` and mode names next to `projectCeilingOf`); both sides kept
  (`docs/status/reviews/w3-misc-replay-ceiling.md`, "Third rebase"). Current counts: runtime
  137 files / 1268 passed, 1 skipped; cloud-runner 9 files / 62 passed; state-api 11 files /
  159; scenario 9 2 passed, no todo; e2e 13 files / 25 passed, 1 skipped. Not merged yet.

### 2026-10-23 (item w3-misc-replay-ceiling rebased onto 4ff4fb1)
- `wave/w3-misc-replay-ceiling` rebased onto `origin/ccr-4d8a843c-1k9syk` (4ff4fb1). Conflicts
  in this log (the base's w3-d16-slider, w3-e4-recheck and w5-android-high-risk entries next
  to this item's) and in the executor's ladder import (the base's `capEffort` and
  `speedQualityOffsetOf` next to `projectCeilingOf`); both sides kept
  (`docs/status/reviews/w3-misc-replay-ceiling.md` `## Rebase`). Current counts: runtime 133
  files / 1208 passed, 1 skipped; cloud-runner 9 files / 62 passed; state-api 11 files / 156;
  scenario 9 2 passed, no todo. Not merged yet.

### 2026-10-23 (item w3-misc-replay-ceiling built on its branch)
- Two Known issues of `docs/maintainers/testing.md` closed (R.4, V.3 scenario 9's `it.todo`,
  H.4 and D.3 the critic ceiling, V.4 the known-issues list). The code was already in place
  from the runtime-gaps wave: `POST /remote/commands` enqueues a device's envelope once per
  `clientId` (`enqueueRemoteCommandOnce`) and `RemoteCommandWatcher` refuses a replayed
  envelope as a `duplicate`; `composeRuntime` passes `projectCeiling` so the executor reads
  the project's `critic_ceiling` at every run. What the item adds is the proof: scenario 9's
  todo is now a passing case (the envelope posted twice, a copy past the service, one change
  log row, one session start), and `executor-ceiling.test.ts` / `remote-wiring.test.ts` pin a
  haiku (tier 1) ceiling keeping the third attempt at haiku and the ceiling re-read per run.
  Each test was shown to fail with the dedupe or the ceiling read removed. Report:
  `docs/status/reviews/w3-misc-replay-ceiling.md`. Reviewed the same day (verdict revise, five
  findings, all fixed on the branch): the cloud runner's executor ignored the project's
  ceiling (the executor now reads `critic_ceiling` itself when no reader is passed), the
  replay case was order-dependent, the V.4 blockers edit conflicted with the base, two docs
  overstated and the build report cited commits not on the branch.

### 2026-10-23 (item w3-d4-specialist-settings rebased onto 4ff4fb1)
- `wave/w3-d4-specialist-settings` rebased onto `origin/ccr-4d8a843c-1k9syk` (4ff4fb1), which
  had since merged w2-l6-speak (L.6), w3-c5-specialist-approval (C.5), w3-d16-slider (D.16),
  w3-e4-recheck (E.4) and w5-android-high-risk. Conflicts in the intake, the chat and the
  executor (D.16's slider and `max_effort` cap next to D.4's resolved effort: the agent's
  effort is the base the slider shifts, then the cap; a spoken turn keeps `voice_chat`), the
  command ports and compose (`speak` next to `modelSettings`), the daemon's imports, the UI's
  Settings dialog (D.16's slider next to D.4's select) and fake daemon, five maintainer docs,
  the ADR index, BLOCKERS and this file; both sides kept
  (`docs/status/reviews/w3-d4-specialist-settings.md`, "Rebase onto 4ff4fb1"). The approval
  gate (C.5) now compares the D.4 keys before a promotion; two branch tests were moved to the
  base's current names (D.16's slider instead of the removed `effortOffset`, the fixture's
  settings count). ADR 0072 has a second rebase amendment. Requirements 189 done, 34 in
  progress, 5 todo of 228. Counts: runtime 136 files / 1256 passed, 1 skipped; commands 12 /
  171; critic 14 / 116; billing 10 / 92; testenv 10 / 142; UI 49 / 330. Not merged yet.
### 2026-10-23 (item w3-r5-phone, review and fix: verdict revise, eight findings, seven fixed)
- Review in `docs/status/reviews/w3-r5-phone.md` (`## Review`). Fixed: a review verdict now
  answers the caller's approval before it messages the agent (a refused high-risk or stale
  verdict told the agent "Approved"), and leaves another human's approval alone; the phone
  reads the inbox afresh before a verdict and resends with the biometric after
  `biometric_required`; the PC drops a relayed recording from the shared row on every
  outcome and refuses a voice turn older than 2 min; the 5 s cap is a duration bound; the
  Upload screen warns when a queued file is held in memory only; the emulator smoke opens
  Reviews, Upload and the Chat voice turn. R.5 stays `in progress` until the emulator run.

### 2026-10-23 (item w3-r5-phone rebased onto 4ff4fb1)
- `wave/w3-r5-phone` rebased onto `origin/ccr-4d8a843c-1k9syk` (4ff4fb1). Conflicts in
  `compose.ts` (the base's read-aloud `SpeakSessions` next to the branch's `VoiceRelay`), the
  phone store (the base's `BIOMETRIC_TIMEOUT_MS` next to the branch's upload queue key; a
  high-risk review verdict now gets the base's bounded refusal), runtime.md (the Read aloud
  and push-to-talk paragraphs) and this log; both sides kept
  (`docs/status/reviews/w3-r5-phone.md`, `## Rebase` onto 4ff4fb1). Current counts: UI suite
  51 files / 340 tests (`mobile-upload`, `mobile-reviews`, `mobile-voice` 18), runtime 134
  files / 1214 unit tests passed, 1 skipped (`voice-relay` 9), state-api 11 files / 159,
  `cdp.test.ts` 25. R.5 stays `in progress` (the emulator run). Not merged yet.

### 2026-10-23 (item w3-r5-phone rebased onto cac6fee)
- `wave/w3-r5-phone` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee). Conflicts in the
  phone store (the base's runner unlock window key next to the branch's upload queue key),
  apps.md (the screen list and Known issues), requirements.md (R.5 and R.6 in one hunk) and
  this log; both sides kept (`docs/status/reviews/w3-r5-phone.md` `## Rebase`). Current
  counts: UI suite 49 files / 316 tests (`mobile-upload` 5, `mobile-reviews` 7,
  `mobile-voice` 6), runtime 129 files / 1141 unit tests (`voice-relay` 9), state-api 11
  files / 159. R.5 stays `in progress` (the emulator run). Not merged yet.

### 2026-10-23 (item w3-r5-phone: the phone uploads, reviews and talks; R.5 built, emulator run open)
- Branch `wave/w3-r5-phone` on the `wip:` snapshot 34bfcdb (the upload route's `clientId`
  idempotency and `maxBytes` in the list, kept). ADR 0080. The phone gains an Upload screen
  (file or camera photo, name, project, the cap shown and checked, signed multipart, phase
  progress, an offline upload queue resent under the same `clientId`), a Reviews screen (the
  project's critic reviews with PR and findings; comment; approve / reject answering the
  task's approval at its version, high risk only after the biometric prompt) and push-to-talk
  on Chat (5 s of 16 kHz PCM, or the typed line in the shell, as a `kind: "voice"` remote
  command; the reply shown and spoken). The PC's `RemoteCommandWatcher` runs the voice
  envelope through `VoiceRelay` over the daemon's voice sessions (one held per phone, so a
  spoken yes answers the last read-back) and drops the audio from the shared row. Both
  screens are in the nav. R.5 stays `in progress` until the emulator run (BLOCKERS.md, R.5).
  Build report: `docs/status/reviews/w3-r5-phone.md`.
### 2026-10-23 (item w6-android-inbox built on `wave/w6-android-inbox`, review pending)
- Android emulator smoke, scenario 2 (`android.yml` run 40000764444 on 4ff4fb1: 0 `m-request`
  cards after pairing): the four suspects of the brief are ruled out (the unlock card gates
  nothing and makes no service call, the high-risk store changes leave pairing, refresh and
  the sync loop alone, the phone sends no push token); the cause is a click race in the CDP
  driver that predates 82a6295. The API 30 emulator's Chromium 83-class WebView drops the
  app's Tailwind v4 rules (cascade layers), so the bottom nav sits in the flow under Home's
  project list; the runner's "Inbox" click was measured before `/projects` answered and
  landed on Home once the list pushed the nav down. Reproduced in a Chromium 83 browser
  stand-in with slow shell IPC (82a6295's driver 8 of 20 runs failed, 4ff4fb1's 4 of 20,
  the fix 0 of 20; the full `smoke()` 10 of 10). Fix (ADR 0087): the driver's click guard
  stops events that land outside the measured element and retries the click
  (`cdp.click_missed`, `cdp.click_lost`); the runner waits for Home's list and each screen's
  heading, prints `webview engine:` and, after a failure, `page:` lines. Tests:
  `apps/mobile/e2e/cdp.test.ts` (32 after the review, seven new). Open: the app's layout on a pre-99 WebView.
  Report: `docs/status/reviews/w6-android-inbox.md`.

### 2026-10-23 (item w3-d7-performance rebased onto 4ff4fb1)
- `wave/w3-d7-performance` rebased onto `origin/ccr-4d8a843c-1k9syk` (4ff4fb1, after the merges
  of w2-l6-speak, w3-c5-specialist-approval, w3-d16-slider, w3-e4-recheck and
  w5-android-high-risk). Conflicts in `session/intake.ts` (the base's slider effort and
  `maxEffort` next to the branch's intake Run row and `promptVersion`), `compose.ts` (both intake
  deps), `views.ts` imports (the base's `spokenProjectSummary` next to the branch's
  `ForerunnerError`), runtime.md (the base's Read aloud and slider paragraphs next to the
  Performance view section) and this log; both sides kept. The base's D.16 slider now reaches
  every mode, so the view's effort in force follows it everywhere a run reads it, held at the
  registry's `max_effort` (`maxEffort`); the intake Run row and the chat reply row store the
  effort the call ran at, and a chat turn is scoped by its own `projectId`
  (`docs/status/reviews/w3-d7-performance.md`, second `## Rebase` section). Current counts:
  runtime unit 135 files / 1219 passed, 1 skipped (`performance-view.test.ts` 9,
  `performance-route.test.ts` 3, `intake.test.ts` 13, `effort-offset.test.ts` 11); UI 48 files
  / 326 tests (`performance.test.tsx` 8); requirements 190 done, 33 in progress, 5 todo. Not
  merged yet.

### 2026-10-23 (item w3-d7-performance rebased onto cac6fee)
- `wave/w3-d7-performance` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee). Conflicts in
  the conversation agent's imports (the base's `AgentRow` next to the branch's `wholeMs`), the
  UI contracts header and served-route test (the base's milestones next to the branch's
  performance), apps.md (client, fake daemon and proposed-routes paragraphs), runtime.md
  (Ladder: fast mode and `INTAKE_RUN_SPECIALIST`), CHANGELOG (E.1 and D.7/D.19) and this log;
  both sides kept (`docs/status/reviews/w3-d7-performance.md` `## Rebase`). Current counts:
  runtime unit 130 files / 1144 passed, 1 skipped (`performance-view.test.ts` 8,
  `performance-route.test.ts` 3); UI 46 files / 301 tests (`performance.test.tsx` 7);
  requirements 187 done, 36 in progress, 5 todo. Not merged yet.

### 2026-10-23 (item w3-d7-performance reviewed and fixed on its branch)
- Independent review of the Performance view build: verdict revise, six findings, all fixed
  on `wave/w3-d7-performance` (`docs/status/reviews/w3-d7-performance.md`, `## Review`):
  runs and chat turns that never reached a model no longer count as response-time samples
  (a timeout still does); the intake call's Run row stores its prompt version (D.5); the view
  and the page name the effort a risky task raises a mode to (`riskEffort`); `?days=` takes
  decimal digits only; the client's missing-route test uses a route still proposed; apps.md
  lists the data asset routes as served. D.7 and D.19 stay `done`.

### 2026-10-23 (item w3-d7-performance built on its branch: the daemon serves the Performance view)
- `GET /performance?projectId=&days=` is served by the daemon from the store (D.7, D.19):
  per mode the samples, p50 and p90 by nearest rank of first token and total time against the
  mode's target (D.8 to D.15), met or not, the last measurement and the effort in force from
  the effort table and the project's offset; from the Run rows (executor, critic, and the
  intake call, which now writes one), the chat replies (now with their total time) and the
  voice turns of the window, the install's human's agents only. The UI page and the fake
  daemon use the runtime shape; the proposed mirror and the "route not available" state are
  gone. D.7 and D.19 `done` (requirements 185 done, 38 in progress, 5 todo on this branch).
  Report: `docs/status/reviews/w3-d7-performance.md`. Awaiting the independent review.

### 2026-10-23 (item w3-d16-slider rebased onto cac6fee)
- `wave/w3-d16-slider` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee). Conflicts in the
  daemon's `/settings` rows (the base's handover and Opus fast-mode rows next to the slider's
  row), the executor (the base's fast-mode routing next to the slider's offset and the
  `max_effort` cap), the UI's fake daemon (runner keys, fast mode and desktop state next to
  the slider state; the fast-mode and slider `settings.set` cards as two branches), apps.md,
  commands.md (the `settings.set` row and the `SettingSpec.effect` paragraph name both
  `fast_mode` and `speed_quality_offset`) and this log; both sides kept
  (`docs/status/reviews/w3-d16-slider.md` `## Rebase`). Current counts: runtime 129 files /
  1143 passed, 1 skipped (`effort-offset.test.ts` 11), commands 11 files / 153
  (`speed-quality.test.ts` 3), critic 14 files / 116, UI 47 files / 301
  (`settings-slider.test.tsx` 3); requirements 186 done, 37 in progress, 5 todo. Not merged yet.

### 2026-10-23 (item w3-d16-slider reviewed and fixed on `wave/w3-d16-slider`)
- Independent review of the D.16 build (`docs/status/reviews/w3-d16-slider.md`, `## Review`):
  verdict revise, 74/100, four findings, all fixed on the branch. The slider no longer lifts a
  specialist, the conversation agent or the intake above its registry `max_effort` (the
  researcher at quality stays at high; the critic already capped). `effort-offset.test.ts`
  now tells voice from chat on an adopted table and runs the researcher and the tier-2 coder
  from the project row. The UI's fake daemon refuses an off-scale position in the daemon's
  words. D.16 stays `done`; the BLOCKERS.md row is dropped when the branch merges.

### 2026-10-23 (item w3-d16-slider built on `wave/w3-d16-slider`, review pending)
- D.16 speed-versus-quality slider: every mode's effort is the default shifted one step by the
  project's `speed_quality_offset`, read from the project row per run (executor), per turn
  (chat, voice), per planning session (intake) and per review (critic); `compose.ts` passes no
  static offset. `settings.set` takes -1 / 0 / +1 with the effect in the card and the change
  log sentence both ways; Settings shows a three-stop slider (speed / balanced / quality).
  Tests: `packages/runtime/test/effort-offset.test.ts` (composed daemon, each mode at each
  position, a move applies to the next turn, session or run), `packages/commands/test/
  speed-quality.test.ts`, `apps/ui/test/settings-slider.test.tsx`. D.16 `done` on this branch
  (requirements 186 done, 37 in progress, 5 todo after the rebase onto cac6fee); BLOCKERS.md row D.16 says built, review
  pending. Report: `docs/status/reviews/w3-d16-slider.md`.
### 2026-10-23 (item w3-e4-recheck rebased onto cac6fee)
- `wave/w3-e4-recheck` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee). Conflicts in
  `runner.ts` (the base's `summarizeMerges` next to the branch's `summarizeEndInbox`; the
  summary and the handoff carry both the J.9 merges and the end inbox), BLOCKERS (E.1, S.12,
  S.32 as the base has them; the E.4 row the branch's with the base's O.9 clause) and this log;
  both sides kept (`docs/status/reviews/w3-e4-recheck.md` `## Rebase`). Current counts:
  runtime 128 files / 1140 unit tests passed (1 skipped), the E.4 block of
  `closeout-sessions.test.ts` 8. Not merged yet.

### 2026-10-23 (item w3-e4-recheck: independent review and fixes)
- Review of the E.4 build (`docs/status/reviews/w3-e4-recheck.md`, "## Review"): verdict
  revise, 72/100, four findings, all fixed on the branch: a pause read at the end of a session
  that ends `failed` no longer leaves the row `paused` (which refused every later session of
  the agent); a message read at the end is carried past a session that ends before its startup
  receipts (`handoff.carried_forward`); `after_stop` also accounts for the memory, lesson-warning
  and promotion writes; these status rows name the review. Three new cases in
  `closeout-sessions.test.ts` (eight in the E.4 block). E.4 stays `done`.

### 2026-10-23 (item w3-e4-recheck: the inbox is re-checked before the session-end writes)
- E.4 `done` on `wave/w3-e4-recheck` (builder-verified; an independent review is due before the
  merge): step 4 of `packages/runtime/src/session/runner.ts` re-checks the inbox before the
  status doc, the summary cache, the peers' handoffs, the note to the human and the session
  record are written. A stop or pause read there ends the session `stopped`
  (`stopped_by_message`) and `handoff.end_inbox` names it with what was and was not written
  (`after_stop`); an ordinary message is read and summarised in the handoff, and the next
  session's startup checklist carries it once into the brief (it would otherwise vanish from
  the unread list); a pause leaves the row `paused -> stopped`. Tests: `packages/runtime/test/closeout-sessions.test.ts` (five new
  cases); doc: runtime.md "The inbox before the session-end writes"; BLOCKERS.md E.4 row
  resolved. The requirement totals in the milestone table and gates.md criterion 1 move by one
  (E.4 in progress → done) at integration. Report: `docs/status/reviews/w3-e4-recheck.md`.
### 2026-10-23 (item w5-android-high-risk rebased onto cac6fee)
- `wave/w5-android-high-risk` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee). Conflicts
  in the mobile store (the base's runner unlock window next to the branch's biometric
  timeout), `run.mjs` and `cdp.test.ts` (the base's `describeFailure` and moved
  `connectPage` tests next to the branch's `webview-console.mjs` forwarding), apps.md, the
  ADR index and this log; both sides kept. The base had taken ADR 0085 (FCM push), so the
  branch's ADR is now 0086 (`docs/status/reviews/w5-android-high-risk.md` `## Rebase`).
  Current counts: UI suite 46 files / 310 tests, `cdp.test.ts` 25. Not merged yet.

### 2026-10-23 (item w5-android-high-risk: the high-risk refusal on a phone without biometrics; the runner shows the WebView console)
- `android.yml` run 39952987240 (82a6295) attached to the real WebView, paired and approved,
  then saw no refusal after Confirm on the high-risk card. Built on
  `wave/w5-android-high-risk` (ADR 0086, not merged): every failure of the biometric step is a
  refusal with the platform's reason in bounded time (shell 45 s, UI 60 s); the capability
  names `biometric:allow-status` and `biometric:allow-authenticate`; `run.mjs` forwards the
  page's console and uncaught exceptions as `webview:` lines. Tests (after the rebase onto
  cac6fee): `apps/ui` 46 files / 310 tests, `apps/mobile/e2e/cdp.test.ts` 25, `cargo test` 30
  (review stage; the base changed no Rust). R.5, R.7 and V.3 keep their
  status until the emulator run passes; the BLOCKERS.md emulator row names the next step
  (merge, dispatch `android.yml`). Report: `docs/status/reviews/w5-android-high-risk.md`.
- Review and fix (same branch): verdict revise (76), six findings, all fixed. The forwarding
  moved to `apps/mobile/e2e/webview-console.mjs` (typed by its own `.d.mts`) so a merge with
  the base's typed `cdp.mjs` type-checks; the bounded wait closes an open simulated prompt
  with the refusal; docs on V8's console replay, the platform prompt that outlives the
  shell's bound, and the BLOCKERS row corrected. Counts in the review file.

### 2026-10-23 (item w3-d4-specialist-settings rebased onto cac6fee)
- `wave/w3-d4-specialist-settings` rebased onto `origin/ccr-4d8a843c-1k9syk` (cac6fee), which
  had since merged D.20 (Opus fast mode, ADR 0057), chat memory, the indicator, the unlock card,
  the triggers and the FCM sender. Conflicts in the provider contract, the Anthropic adapter,
  the loop, the executor, compose, the command ports and registry, the UI's Settings page and
  fake daemon, five maintainer docs, the ADR index, BLOCKERS and this file; both sides kept
  (`docs/status/reviews/w3-d4-specialist-settings.md` `## Rebase`). The speed mode now
  composes with D.20's `decideFastMode` (ADR 0072, rebase amendment): one decision, D.20's
  price rows and audit rows, `speed_mode: standard` opting a run out of a fast-mode project,
  `fast` only with the project's leave. Requirements 186 done, 37 in progress, 5 todo of 228.
  Counts: runtime 131 files / 1180 tests, commands 11 / 155, critic 14 / 116, billing 10 / 92,
  testenv 10 / 142, UI 47 / 306. Not merged yet.

### 2026-10-23 (item w3-d4-specialist-settings, REVIEW AND FIX)
- Independent review of the D.4 build: verdict revise (68/100), six findings, all fixed on the
  branch (`docs/status/reviews/w3-d4-specialist-settings.md`, ADR 0072 amendment): every loop
  run is now priced as the model it calls (the intake and the chat were priced at the table's
  rung after a `tier` override, an Opus chat turn at the Haiku price); a specialist never runs
  above its `max_effort` (executor cap, command refusal, screen options); the principal's
  planning and chat rungs stay under the ladder ceiling; the field table says `default_effort`
  is not a run's base; the UI fake speaks the daemon's sentence; the additions moved off the
  anchors the base extends, so a trial merge into the base is conflict-free. Merge pending.

### 2026-10-23 (item w3-d4-specialist-settings, BUILD: D.4 settings per agent and specialist)
- Built on `wave/w3-d4-specialist-settings` (ADR 0072), over the earlier attempt's `wip:`
  snapshot (the capability flags, the effort-table columns and the adapter's `speed`, kept and
  finished): max tokens, speed mode and timeout in the effort table; optional `max_tokens`,
  `speed_mode`, `temperature` in specialist frontmatter; per-mode and per-specialist overrides
  on the principal's `model_config` through the new `model.settings.set` command (card, change
  log, undo); `ModelProvider.capabilities` (`acceptsTemperature`, `fastMode`) read by the loop,
  the command and the settings view; the executor, the intake and the chat run at the resolved
  settings; `GET /settings/models` and the Settings section "Models per agent and specialist"
  with the temperature column only for a provider that accepts one. Speed mode composes with
  D.20: fast only with the project's `fast_mode` leave, the Opus rung, an API-style source and
  a fast-mode price (none wired before D.20, so inert and said per run). D.4 `done` in
  requirements.md (184 done, 39 in progress, 5 todo of 228); the BLOCKERS row keeps the D.20 residual. Review and merge pending. Report:
  `docs/status/reviews/w3-d4-specialist-settings.md`.

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
  w3-d4-specialist-settings, w3-d7-performance, w3-d16-slider,
  w3-c5-specialist-approval, w3-d4-specialist-settings, w3-d7-performance,
  w3-e1-triggers, w3-e4-recheck, w3-docs-p7-p11, w3-r2-devices, w3-r5-phone, w3-t1-mode-off,
  w3-misc-replay-ceiling; each is named on its requirement row in BLOCKERS.md.
  w3-c5-specialist-approval (C.5, ADR 0071) is built and reviewed on its branch (six review
  findings fixed, see its review), awaiting merge. Build cost in
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
   merge pending), w3-c5-specialist-approval (C.5; built on its branch with ADR 0071, reviewed
   with six findings fixed, awaiting merge, see its review in
   `docs/status/reviews/w3-c5-specialist-approval.md`),
   w3-d4-specialist-settings (D.4; built and reviewed on its branch 2026-10-23, its six review
   findings fixed, ADR 0072; rebased onto cac6fee and composed with D.20's `decideFastMode`: merge), w3-d7-performance (D.7, D.19; built, reviewed and
   fixed on its branch 2026-10-23, rebased onto 38ae8cc, awaiting the merge), w3-d16-slider (D.16),
   merge pending), w3-c5-specialist-approval (C.5),
   w3-d4-specialist-settings (D.4; built and reviewed on its branch 2026-10-23, its six review
   findings fixed, ADR 0072; rebased onto cac6fee and composed with D.20's `decideFastMode`: merge), w3-d7-performance (D.7, D.19; built, reviewed and
   fixed on its branch 2026-10-23, rebased onto 38ae8cc, awaiting the merge), w3-d16-slider (D.16:
   built on its branch, see below; its review is still to run),
   w3-e1-triggers (E.1), w3-e4-recheck (E.4), w3-docs-p7-p11 (P.7, P.11), w3-r2-devices (R.2;
   built and reviewed on its branch 2026-10-23, rebased onto 38ae8cc, merge pending),
   w3-r5-phone (R.5; built on its branch 2026-10-23, emulator run open), w3-t1-mode-off (T.1; built on its branch, ADR 0081, reviewed and fixed 2026-10-24, awaiting merge), w3-misc-replay-ceiling (scenario 9's replay
   `it.todo`, the executor's ceiling rung). Then an independent review of each of the ten
   w3-r5-phone (R.5; built on its branch 2026-10-23, emulator run open), w3-t1-mode-off (T.1), w3-misc-replay-ceiling (scenario 9's replay
   `it.todo`, the executor's ceiling rung; built and reviewed on its branch 2026-10-23, not merged). Then an independent review of each of the ten
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
