## title

The daemon serves the Performance view from the Run rows: time to first token and total time per mode against target

## requirements

D.7, D.19 (D.8 to D.15 targets)

## adr

none

## brief

BLOCKERS.md row D.7, D.19 the Performance view served by the daemon: **partly built**: runs record `ttft_ms` and `duration_ms` (`packages/runtime/test/executor.test.ts`, `packages/critic/test/run-row.test.ts`), chat measures its first token (`apps/ui/test/chat.test.tsx`) and the Performance page shows every mode against its target (`apps/ui/test/performance.test.tsx`), against the fake daemon only: `GET /performance` is a proposed route (ADR 0037) the daemon does not serve. Stand-in: the UI names the missing route; the live measurements sit in `gates.md`, 'Response-time targets'. Needed: the daemon's `/performance` view built from the Run rows per mode; then D.7 and D.19 `done`. Spec D.7: 'Effort rule: the lowest effort that passes the task's checks. Each mode has a response-time target that the UI measures and shows (D.8 to D.15).' D.19: 'Each run records time to first token and total time. The Performance view shows these per mode against target.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read apps/ui/src/pages/PerformancePage.tsx and apps/ui/test/performance.test.tsx (the shape the page expects from GET /performance and the fake daemon's version in apps/ui/test), apps/ui/src/api (the mirrored schema for the route), packages/runtime/src/daemon/views.ts (how other views are built from store rows) and api-types.ts, the run rows (packages/state: run table with ttft_ms, duration_ms, the mode / purpose column or what tells a run's mode: chat, routing, planning, coder, researcher, critic tier 1/2/3; if no mode column exists, derive it from the run's agent kind / specialist / phase and record the derivation), the ladder's targets per mode (ladder.ts: D.8 to D.15 numbers) and the conversation agent's first-token measurement (is a chat turn a run row? if not, record its timing where chat turns are stored so the view includes it). Build: GET /performance (per mode: n, median and p90 ttft and total, the target, met/not met, the window (last 7 days by default, ?days=), the last measurement time), served from the store with the same shape the page mirrors; the page's 'route not available' state goes away; the D.7 effort rule half: the view also shows per mode the effort in force (from the ladder and the project's offset) so 'the lowest effort that passes' is visible; keep the fake daemon in apps/ui/test in sync. Tests: packages/runtime/test/performance-view.test.ts (seeded run rows across modes -> medians, p90 by nearest rank, targets, window), a daemon route test, apps/ui/test/performance.test.tsx against the real shape. Docs: runtime.md (daemon views), apps.md.

## paths

packages/runtime/src/daemon/views.ts, server.ts, api-types.ts, apps/ui/src/pages/PerformancePage.tsx, apps/ui/src/api, tests
