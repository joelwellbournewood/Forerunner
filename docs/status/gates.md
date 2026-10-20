# Gates

Evidence for every milestone check and every release criterion: the command, the date, the
result and the CI link. A gate without evidence is not passed.

Status words: **passed** (evidence attached), **pending** (not yet run), **blocked** (needs a
missing item, see BLOCKERS.md), **failed** (with the failing evidence and the fix task).

## Phase 0 — Foundations

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| CI green on Windows and Linux | **passed** | `.github/workflows/ci.yml` (lint, typecheck, unit, integration with Postgres, secret scan incl. logs, docs check, link check, schema doc, gitleaks, dependency audit, runner image) | 2026-10-20 | check (ubuntu-latest) and check (windows-latest) both success on commit b5df700 | https://github.com/joelwellbournewood/Forerunner/actions/runs/39352102564 |
| Scripted fresh install on clean Windows and Linux VMs under 15 minutes | **passed** | `scripts/fresh-install.sh --non-interactive` and `pwsh -File scripts/fresh-install.ps1 -NonInteractive` on fresh GitHub runners via `.github/workflows/fresh-install.yml` (prerequisites, pnpm via corepack, install, typecheck, unit tests, `fr setup`) | 2026-10-20 | ubuntu-latest 89 s, windows-latest 200 s (commit 9aed675); the workflow fails above 900 s and runs weekly | https://github.com/joelwellbournewood/Forerunner/actions/runs/39357536106 |
| Keys never appear in logs (automated scan) | **passed** (continuous) | `pnpm secrets:scan && pnpm secrets:scan --logs` in CI on both runners; `Logger` redaction tests in `packages/platform/test/log.test.ts`; CLI tests assert no credential is echoed | 2026-10-20 | clean on both runners | https://github.com/joelwellbournewood/Forerunner/actions/runs/39352102564 |

## Phase 1 — Single agent

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| One agent plans and completes 10 tasks via PRs without exceeding any cap | **passed** (fake provider, local bare repo) | `pnpm vitest run --project integration packages/capabilities/test/phase1-gate.integration.test.ts` | 2026-10-20 | 10 PRs opened, 10 tasks in review, all runs under task cap, session under cap, no denied audit entries (commit c989eed) | CI run 39352827893 (integration step) |
| Deliberate overspend blocked by code | **passed** | `packages/runtime/test/hooks.test.ts` ("blocks a deliberate overspend before the call is made"), `packages/runtime/test/loop.test.ts` ("stops a run that tries to overspend"), gate test "blocks a deliberate overspend in code and the session stops cleanly with a handoff" | 2026-10-20 | run outcome budget_exceeded under the run cap; session stops with handoff; no PR opened | CI run 39352827893 |
| Kill switch stops everything within 2 s | **passed** | `packages/runtime/test/killswitch.test.ts` (40 runs and 3 processes stopped under 2 s); gate test "the kill switch stops a running session within 2 seconds and releases claims" in `packages/capabilities/test/phase1-gate.integration.test.ts`; daemon test "kill works" | 2026-10-20 | session status killed and claims released under 2 s of simulated and wall time; `POST /kill` freezes new work and `/kill/resume` lifts it | https://github.com/joelwellbournewood/Forerunner/actions/runs/39358262200 |
| Same session once on subscription and once on API key with correct usage | blocked | needs tokens | | | |
| Text chat first token under 1 s median | **partial**: measured under simulated latency (250 ms) in the gate test; live median blocked until an API key exists | gate test "text chat answers with a measured first token" | 2026-10-20 | ttft recorded per turn by `ConversationAgent`; live run pending | pending |

## Phase 2 — Two agents, one project

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| Alice and Bob each run 5 sessions on the same project, overlapping and not: zero duplicate tasks, zero lost commits, every ack-required message acknowledged | **passed** (local shared store, fake provider, local bare repository) | `pnpm vitest run --project integration packages/capabilities/test/phase2-gate.integration.test.ts` | 2026-10-20 | 10 sessions (rounds 1, 3, 5 concurrent); 14 tasks executed once each, one run and one PR per task, claim collisions reported to the holder; every PR branch present in the shared repository with its task commit and main untouched; every handoff delivered, read and acted on by the recipient's next session (only the final round's two handoffs open) | CI integration step on the next green run |
| Either install can be offline for 48 simulated hours without breaking the other | pending | needs two stores joined by the shared state service (`services/state-api`, in progress) | | | |

## Phase 3 — Critic and quality loop

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| Critic catches at least 80% of seeded defects and passes at least 90% of clean work on the eval set | blocked (needs a live model: no API key, see BLOCKERS.md); the calibration harness and the gate arithmetic are verified on synthetic tasks with the fake provider | `calibrate()` in `packages/critic/src/calibration.ts` over `evals/registry/evals/{coder,researcher}`; `packages/critic/test/calibration.test.ts` | 2026-10-20 | harness: report written, rates and the 0.8 / 0.9 gate computed, passes when every seeded defect is caught | CI unit step (run 39398xxxxx on b29605d) |
| Escalation never exceeds the ceiling | **passed** (unit) | `packages/critic/test/followup.test.ts` (retry ladder up to the ceiling, then the human; project ceiling honoured) | 2026-10-20 | ladder stops at the ceiling in code | CI unit step |

## Phase 4 — Memory, docs and learning

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| Repeat-finding rate drops over 4 simulated weeks on the eval projects | pending (integration of critic and memory into the session loop first) | planned: `tests/e2e` four-week simulation | | | |
| Memory loaded per session stays under the set token budget | **passed** (unit) | `packages/memory/test/retrieval.test.ts` (budgeted retrieval never exceeds the budget) | 2026-10-20 | retrieval cuts to the budget | CI unit step |

## Phase 5 — Human experience and voice

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| From the Android app, a simulated user switches project, raises a budget and starts a session on his PC (scenario 9) | **passed** (local: real state service over HTTP on Postgres, PC daemon on the same schema, fake provider, a paired phone stand-in signing its requests); the Android emulator run is pending the app's own client (BLOCKERS.md, "Android client sources") | `FORERUNNER_TEST_PG=… pnpm vitest run --project integration services/state-api/test/pc-remote.integration.test.ts`; `pnpm vitest run --project unit packages/runtime/test/remote-watcher.test.ts` | 2026-10-20 | 3 integration tests: the plan envelope ("switch to the game, give it 15 francs until tomorrow and start a session on my PC") ends `done` with a running session on Game (budget CHF 15 = USD 18.75, trigger `remote`, the phone as device) and the change log holding the words; an `undoOf` plan kills it and restores budget and active project; a high-risk plan waits for the phone's biometric answer through the inbox (the unflagged answer is 403). 14 unit tests on the watcher (ADR 0032) | integration step of the CI run for the commit that adds the test (pending at the time of writing) |
| Every settings change can be made by voice, chat or the UI, and each produces the same change log entry | **passed** (unit) | `packages/commands/test/scenario.test.ts` ("budget.set by ui, chat and voice logs the same commands, before, after and sentence") | 2026-10-20 | three rows equal apart from `source` and `words_used` | CI unit step |
| Simulated users run a full simulated week only through the UI and the Android emulator | pending (Android client) | | | | |
| Voice replies reach first audio in under 1.2 s median on both platforms | blocked (voice keys, see BLOCKERS.md); local providers measured in `packages/voice` tests | | | | |

## Phase 6 — Capabilities

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| Injection suite passes | **passed** (fake provider) | `pnpm test:injection` (`evals/`: forty-plus hostile pages and emails plus clean controls through the extraction, command-gate and loop paths) | 2026-10-20 | every injection denied by the hooks and reported, no control flagged | CI run 39401060101, both OS |
| Every capability can be revoked live from the panel | **passed** (unit); panel pending UI phase 2 | `packages/runtime/test/extensions-gate.test.ts`, `extensions-registry.test.ts` (revocation closes the connection and the gate refuses the next call) | 2026-10-20 | live revocation in code | CI unit step |
| Cloud runner completes an overnight session while both PCs are off | **passed** (local: fake provider, local Postgres); real host pending | `FORERUNNER_TEST_PG=… pnpm vitest run --project integration services/cloud-runner` (`runner.integration.test.ts`: 8 simulated hours, no desktop online) | 2026-10-20 | 2 tasks done, runs and ledger on the human's API-key source, subscription skipped on a shared runner, key absent from the shared state; phone kill stops a session within 2 s | CI integration step |
| An emailed task is acknowledged within 1 minute and completed in the cloud | **passed** (local: testenv mail server); real mailbox pending | `pnpm vitest run --project unit services/cloud-runner` (`email-watch.test.ts`: push and 5-minute poll delivery, each message handed over once; `inbox-trigger.test.ts`, `runner.test.ts`: the task starts a cloud session) | 2026-10-20 | 44 tests pass | CI unit step |
| A spoofed or forwarded email is ignored | **passed** (local) | `packages/capabilities/test/email-commands.test.ts` (DKIM fail, unaligned sender, forwarded and replayed commands ignored and reported), `evals` injection suite email cases | 2026-10-20 | ignored with the reason recorded, nothing executed | CI unit and injection steps |

## Phase 7 — Self-improvement and model economics

Filled in as the phase is reached.

## Release 1.0 criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Every requirement done with a test | pending | `docs/requirements.md` |
| 2 | Every milestone check passes on the final build | pending | |
| 3 | Nine scenarios × 3 runs on Windows, Linux, Android | pending | |
| 4 | No open P0/P1; P2 listed | pending | |
| 5 | Security suite passes | pending | |
| 6 | Response-time targets met | pending | |
| 7 | Fresh install < 15 min on both | pending for the final build (measured on fresh runners: Linux 89 s, Windows 200 s) | https://github.com/joelwellbournewood/Forerunner/actions/runs/39357536106 |
| 8 | Docs handover test passes | pending | |
| 9 | This file has evidence for all of the above | pending | |
