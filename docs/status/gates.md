# Gates

Evidence for every milestone check and every release criterion: the command, the date, the
result and the CI link. A gate without evidence is not passed.

Status words: **passed** (evidence attached), **pending** (not yet run), **blocked** (needs a
missing item, see BLOCKERS.md), **failed** (with the failing evidence and the fix task).

## Phase 0 — Foundations

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| CI green on Windows and Linux | pending | `.github/workflows/ci.yml` | | | |
| Scripted fresh install on clean Windows and Linux VMs under 15 minutes | pending | `scripts/fresh-install.ps1`, `scripts/fresh-install.sh` in `.github/workflows/fresh-install.yml` | | | |
| Keys never appear in logs (automated scan) | pending | `pnpm secrets:scan --logs` | | | |

## Phase 1 — Single agent

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| One agent plans and completes 10 tasks via PRs without exceeding any cap | pending | `pnpm test:integration -- phase1` | | | |
| Deliberate overspend blocked by code | pending | `packages/runtime/test/enforcement.budget.test.ts` | | | |
| Kill switch stops everything within 2 s | pending | `packages/runtime/test/killswitch.test.ts` | | | |
| Same session once on subscription and once on API key with correct usage | blocked | needs tokens | | | |
| Text chat first token under 1 s median | blocked | needs API key | | | |

## Phases 2–7

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
| 7 | Fresh install < 15 min on both | pending | |
| 8 | Docs handover test passes | pending | |
| 9 | This file has evidence for all of the above | pending | |
