# Progress

Updated by the build agent at every milestone and at least daily. Newest first.

## Milestone status

| Phase | Name | Status | Gate evidence |
| --- | --- | --- | --- |
| 0 | Foundations | CI green on both OS (run 39352102564); fresh-install timing pending the install scripts | gates.md § Phase 0 |
| 1 | Single agent that does real work | gate passed on the fake provider (10 tasks via PRs, overspend blocked, kill under 2 s); live subscription/API checks blocked on credentials; minimal UI pages pending | gates.md § Phase 1 |
| 2 | Two agents, one project | not started | |
| 3 | Critic and quality loop | not started | |
| 4 | Memory, docs and learning | not started | |
| 5 | Human experience and voice | not started | |
| 6 | Capabilities | not started | |
| 7 | Self-improvement and model economics | not started | |
| 8 | Full integration and release 1.0 | not started | |

## Log

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
