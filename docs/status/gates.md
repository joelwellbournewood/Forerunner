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

## Phases 5–7

Filled in as each phase is reached.

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
