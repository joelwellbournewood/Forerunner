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
| Critic catches at least 80% of seeded defects and passes at least 90% of clean work on the eval set | harness passed on the fake provider (re-run 2026-10-20 after ADR 0041 on critic@1.1.0+9e712bfa: 3 passed, 1 skipped, 20 s); **live run 2026-10-20 FAILED the pass half** on critic@1.0.0 (below); the fix is ADR 0041 (the runner's checks rendered as `PASS (required)` lines the prompt says to rely on, the task's fixtures as source files, a confidence floor at 0.6 on all-green required checks with nothing medium or above) and the **live re-run on critic@1.1.0 is pending**: it needs the build box's key and the `tests/live` harness, neither of which is in this checkout | fake provider: `pnpm exec vitest run --project e2e tests/e2e/scenarios/phase3-gate.integration.test.ts` (`calibrate()` over the real `evals/registry/evals/{coder,researcher}` sets, 20 tasks each, with a scripted critic that judges from the diff it is given). Live: `pnpm --filter @forerunner/live test:live` (`tests/live`, ADR 0040; key from the build box's `.env.build`, spend in `tests/live/spend.json`, 15 USD per-run cap in code) | 2026-10-20 | Live, `calibrate()` at tier 1 on `claude-sonnet-5-5`, critic@1.0.0, run `2026-10-20T17:07:09Z`: 10-task coder subset `defects caught 10/10 (100%), clean accepted 7/10 (70%, gate 90% FAIL)`, USD 0.53; full set (20 coder + 20 researcher) `defects caught 40/40 (100%, gate 80% ok), clean accepted 15/40 (37.5%, gate 90% FAIL)`, USD 2.01, 80 reviews in 850 s (median 10.4 s per review, under the 30 s target). Every miss: the model accepted at confidence 0.5 with findings low (grade 80 to 88) and rule 3 of ADR 0028 escalated it; every accepted clean review reported 0.9; seeded variants all `revise` at grades 3 to 35. Causes from the critic's summaries: coder tasks (005, 006, 007, 011, 012, 016, 017) "correct against all five criteria by reading" while the runner's checks had passed; all 20 researcher tasks "the fixture text was not provided". Fake provider after ADR 0041: 40 clean reviewed, 40 accepted; 40 seeded reviewed, 40 caught from the diff, every seeded review carried its task's marker line in `+++ b/<file>`, every review carried the task's unchanged fixtures under `## Source files (data)`, nothing persisted, report written and the gate evaluated true | pending: the e2e vitest project is not in ci.yml; local fake-provider run 2026-10-20 (3 passed, 1 skipped); live re-run pending on the build box |
| Escalation never exceeds the ceiling | **passed** (fake provider, end to end; unit tests as before) | `pnpm exec vitest run --project e2e tests/e2e/scenarios/phase3-gate.integration.test.ts` ("escalation never exceeds the ceiling": a session whose critic keeps returning revise, at `critic_ceiling` sonnet and opus); `packages/critic/test/followup.test.ts`; `packages/runtime/test/loop-critic.test.ts` | 2026-10-20 | ceiling sonnet: improve brief, split or change specialist, then `needs_human` at attempt 3 with one blocking request naming the ceiling; 3 coder and 3 critic runs all on fake-sonnet, no `nextTier: opus`; 3 reviews and 3 findings with one fingerprint persisted, pattern in `FindingRepo.repeated(3)`, critic-scope lesson recorded; audit rows for every tool call, none denied. Ceiling opus: third failure escalates to opus (fourth run on fake-opus), fourth verdict to the human, never fable | pending: the e2e vitest project is not in ci.yml; local run 2026-10-20; CI unit step for the package tests |

## Phase 4 — Memory, docs and learning

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| Repeat-finding rate drops over 4 simulated weeks on the eval projects | **passed** (fake provider, end to end, with a no-memory control) | `pnpm exec vitest run --project e2e tests/e2e/scenarios/phase4-gate.integration.test.ts` (28 simulated days, two projects shaped after the eval sets, Alice and Bob, one session each per day, scripted specialist and critic, real runner, executor, critic loop, memory loop and weekly consolidation; `runFourWeeks` in `tests/e2e/src/four-weeks.ts`; the with-memory run once in `beforeAll`, each test stands alone under `-t`) | 2026-10-20 | with memory: 56 sessions, 336 tasks, 364 task reviews, 28 findings, 14 repeats; weekly repeat rate 11.1%, 4.3%, 2.0%, 0.0% (8/72, 4/92, 2/102, 0/98), 0 tasks to the human, 14 private and 14 critic (pattern) lessons, 4 consolidation rounds answered from the inbox (0 proposals each: duplicates merge on write), 728 audit rows, 0 denied. Control without memory: 46.2%, 48.8%, 49.5%, 50.0% (322 repeats over 658 reviews), 0 lessons | pending: the e2e vitest project is not in ci.yml; local run 2026-10-20 (2 passed, 45 s; both files together 5 passed, 1 skipped, 76 s) |
| Memory loaded per session stays under the set token budget | **passed** (fake provider, end to end; unit tests as before) | same four-week run: project settings `memory_token_budget: 600`, `task_memory_token_budget: 300`; the runner's `memory.loaded` count, an independent `estimateTokens` count of the lessons section of every planner brief and of every specialist brief the fake provider saw; `packages/memory/test/retrieval.test.ts`; `packages/runtime/test/loop-memory.test.ts` | 2026-10-20 | 56 sessions: max 597 of 600 tokens, every session at or under the budget; 364 specialist briefs: max 264 of 300, every brief at or under the task budget; 0 `memory.over_budget` drops; the budgets were approached (over half used), not idle | pending: the e2e vitest project is not in ci.yml; local run 2026-10-20; CI unit step for the package tests |

## Phase 5 — Human experience and voice

Filled in as the phase is reached.

## Phase 6 — Capabilities

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| Injection suite passes | **passed** (fake provider) | `pnpm test:injection` (`evals/`: forty-plus hostile pages and emails plus clean controls through the extraction, command-gate and loop paths) | 2026-10-20 | every injection denied by the hooks and reported, no control flagged | CI run 39401060101, both OS |
| Every capability can be revoked live from the panel | **passed** (unit); panel pending UI phase 2 | `packages/runtime/test/extensions-gate.test.ts`, `extensions-registry.test.ts` (revocation closes the connection and the gate refuses the next call) | 2026-10-20 | live revocation in code | CI unit step |
| Cloud runner completes an overnight session while both PCs are off | **passed** (local: fake provider, local Postgres); real host pending | `FORERUNNER_TEST_PG=… pnpm vitest run --project integration services/cloud-runner` (`runner.integration.test.ts`: 8 simulated hours, no desktop online) | 2026-10-20 | 2 tasks done, runs and ledger on the human's API-key source, subscription skipped on a shared runner, key absent from the shared state; phone kill stops a session within 2 s | CI integration step |
| An emailed task is acknowledged within 1 minute and completed in the cloud | **passed** (local: testenv mail server); real mailbox pending | `pnpm vitest run --project unit services/cloud-runner` (`email-watch.test.ts`: push and 5-minute poll delivery, each message handed over once; `inbox-trigger.test.ts`, `runner.test.ts`: the task starts a cloud session) | 2026-10-20 | 51 tests pass | CI unit step |
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
