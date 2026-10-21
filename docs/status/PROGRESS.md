# Progress

Updated by the build agent at every milestone and at least daily. Newest first.

## Milestone status

| Phase | Name | Status | Gate evidence |
| --- | --- | --- | --- |
| 0 | Foundations | CI green on both OS (run 39352102564); fresh-install timing pending the install scripts | gates.md § Phase 0 |
| 1 | Single agent that does real work | gate passed on the fake provider and live on both billing sources (API key in full; the subscription session through the Agent SDK driver, ADR 0044); kill under 2 s live (49 ms) | gates.md § Phase 1 |
| 2 | Two agents, one project | gate passed on the fake provider (two agents, five sessions each, claims, peer feed, PR flow, human requests); state service with device auth, realtime, receipts, decision log, GitHub Projects mirror, approvals web fallback done | gates.md § Phase 2 |
| 3 | Critic and quality loop | gate passed live (40 of 40 seeded defects caught, 40 of 40 clean submissions accepted after ADR 0042); reviews tab done | gates.md § Phase 3 |
| 4 | Memory, docs and learning | gate harness passed on the fake provider (four simulated weeks, retrieval under budget, consolidation applied only as approved, no cross-human lesson); memory UI done | gates.md § Phase 4 |
| 5 | Human experience and voice | gate harness passed on the fake provider (simulated week through the daemon API and the phone routes, 29 voice turns, nine settings changes with one change log, 8 phone answers: 5 accepted, 3 of them with the biometric, 3 refused without it; the four runtime findings RT-P5-1 to RT-P5-4 closed, ADR 0049); the Android emulator and real-audio halves pending (no emulator boots on the hosted runner) | gates.md § Phase 5 |
| 6 | Capabilities | injection suite, live revocation, overnight cloud-runner session, emailed task and spoofed email passed on the fake provider and the in-process mail server; live halves pending a real mailbox and host | gates.md § Phase 6 |
| 7 | Self-improvement and model economics | gate harness passed on the fake provider (a plain-language UI change ships as a signed update, a broken release rolls back on one install and the other never takes it, a model-watch run proposes a switch the human adopts) | gates.md § Phase 7 |
| 8 | Full integration and release 1.0 | nine scenarios pass on Linux (three runs each) and on Windows in CI; the hosted emulator boots and launches the app (run 6), its tests pending run 7; requirements 172 done, 48 in progress, 8 todo; security suite green (45 findings fixed, 4 medium review findings open); release criteria not met, no release cut; build stopped at the credit limit on 2026-10-21 | gates.md § Phase 8 and § Release 1.0 criteria |

## Log

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
  shape, fixed in 6542a3f; run 7 decides the emulator rows.
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
In this order, each item a wave of its own with the snapshot procedure in `AGENTS.md`:
1. Apply the open security-review findings (medium, from the review of 2026-10-20/21):
   - `packages/platform/src/log.ts`: the key-name rule is case-inconsistent (`SECRET_KEY_NAME`
     is case-insensitive, `KEY_SUFFIX` is not), so `PRIVATE_KEY`-style names slip through; and
     `URL_USERINFO` needs a non-empty user, so `redis://:password@host/0` is not masked.
   - `packages/runtime/src/wiring/state-ports.ts` and `enforcement/hooks.ts`: the always-human
     approval consumption lives only in `ctx.approvals`; the durable `StateApprovals` port still
     answers "approved" for an identical later request, and its key is computed from the
     redacted input, so two inputs that redact alike share a key. Consume the durable row and
     key on the raw canonical input.
   - Finish the independent review of B.6 small-project mode (its tests pass; the critic stage
     was interrupted) and apply what it finds.
2. Close the requirement rows marked "missing in code" in `BLOCKERS.md` (A.2, A.4, B.6 is done,
   D.20, G.5, G.6, H.7, J.1, J.7, J.9, L.6, O.1, R.6, S.13, S.15/S.29) and then the "partly
   built" rows; each needs code, a test and its maintainer doc.
3. Android: read run 7 of `android.yml`; when the emulator tests pass, record the phase 5
   emulator row and scenario 9's Android run, then re-run every gate on the final build and
   fill the phase 8 "re-run" row.
4. Severity triage of the Known issues sections (V.4), then the release: tag `v1.0.0`
   (`release.yml` builds Windows, Linux and Android artefacts, writes the changelog section and
   signs the update manifest with `UPDATE_SIGNING_KEY`).
Credentials: the API key and the subscription token used for the live runs must be revoked
and re-issued; the ledger `tests/live/spend.json` carries every live call (USD 5.93).

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
