# Progress

Updated by the build agent at every milestone and at least daily. Newest first.

## Milestone status

| Phase | Name | Status | Gate evidence |
| --- | --- | --- | --- |
| 0 | Foundations | CI green on both OS (run 39352102564); fresh-install timing pending the install scripts | gates.md § Phase 0 |
| 1 | Single agent that does real work | gate passed on the fake provider (10 tasks via PRs, overspend blocked, kill under 2 s); daemon API, `fr daemon` and the phase-1 UI (home, project tabs, live session, inbox, settings, chat) done and tested against a fake daemon; live subscription/API checks blocked on credentials | gates.md § Phase 1 |
| 2 | Two agents, one project | local half of the gate passed (two agents, five sessions each); state service with device auth and realtime, receipts, decision log, GitHub Projects mirror done; offline-48-hours half pending the sync test | gates.md § Phase 2 |
| 3 | Critic and quality loop | critic service (tiers, findings, verdicts, calibration), eval sets, retry ladder built and unit-tested; gate needs a live model (blocked on credentials); reviews tab pending | gates.md § Phase 3 |
| 4 | Memory, docs and learning | memory package (three scopes, retrieval under budget, consolidation, promotion) built and unit-tested; four-week simulation and memory UI pending | |
| 5 | Human experience and voice | voice pipeline, natural-language commands with change cards and undo built; notifications, Android app, desktop shell, imports in progress | |
| 6 | Capabilities | extensions registry with live revocation, sandboxed browser, agent email with the five modes and email commands, sandboxes, context savings done; injection suite, Cloudflare, desktop control, cloud runner in progress | |
| 7 | Self-improvement and model economics | signed updates with staged install and rollback, model watch, estimate learning built and wired; Forerunner-as-a-project and the update-and-restart shell side pending | |
| 8 | Full integration and release 1.0 | not started | |

## Log

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
