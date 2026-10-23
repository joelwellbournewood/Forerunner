# w3-d7-performance

Item: the daemon serves the Performance view from the Run rows: time to first token and total
time per mode against target. Requirements D.7, D.19 (targets D.8 to D.15). Branch
`wave/w3-d7-performance`, starting commit `42b41f6` (the earlier attempt's `wip:` snapshot of
`api-types.ts`, kept and reshaped), base `ccr-4d8a843c-1k9syk` at `e2bfb1e` (not merged in).
No ADR: the brief calls for none; the decisions (mode derivation, which modes the offset
reaches) are recorded in `docs/maintainers/runtime.md`.

## Build report

### What was built

- **`GET /performance?projectId=&days=`** on the daemon (`packages/runtime/src/daemon/server.ts`),
  listed in `DAEMON_ROUTES.performance`, answering `PerformanceView`
  (`packages/runtime/src/daemon/api-types.ts`). Bearer token as every route; `days` defaults to
  7, is capped at 90, anything but a positive integer is 400 (`validation`, `bad_query`); an
  unknown project is 404.
- **`performanceView(store, opts)`** in `packages/runtime/src/daemon/views.ts`, built from the
  store at request time:
  - sources: Run rows created in the window with `ttft_ms` or `duration_ms` (executor, critic,
    and the intake call), `chat.reply` rows with `ttftMs`/`durationMs` (not the registry's
    no-model replies, not voice replies), `voice.turn` rows with
    `latency.totalToFirstAudioMs` (first audio, what the 1.2 s target measures);
  - mode derivation (`runMode`; the run table has no mode column): `critic` by the tier of the
    Review row whose evidence names `run:<id>`, else by the model's rung (opus+ is tier 2/3);
    `intake` → planning; `researcher` → researcher; any other specialist → coder (as
    `effortForTask` does); chat → text_chat; voice → voice_chat;
  - scope: sessions of the install's human's agents only, optionally one project;
  - per mode, in the effort table's order: samples, p50 and p90 by nearest rank
    (`nearestRank`) of first token and total time, the target and its kind from the table in
    force (`rt.modelConfig()`), within-target share, `met` (p90 of the targeted figure ≤
    target; null without a numeric target or sample), `lastAt`; `recent` (20 newest, with
    source run/chat/voice); window `days`/`from`;
  - D.7 effort half: `tier`, `baseEffort` (table in force, so a model-watch adoption shows),
    `effort` shifted by the project's `speed_quality_offset` where the code applies it today
    (`OFFSET_MODES`: critic tiers; `offsetApplied` per mode), `effortOffset` on the view.
- **What feeds it:** the intake call now writes a Run row (`specialist: "intake"`,
  `INTAKE_RUN_SPECIALIST` in `models/ladder.ts`; tokens, cost, ttft, duration; written in
  `finally`, a refused row is logged) (`session/intake.ts`); the conversation agent's
  `chat.reply` row now carries `durationMs`, `model`, `effort`, `source` (`conversation/agent.ts`).
- **UI** (`apps/ui`): the client reads the route from `DAEMON_ROUTES` and validates with the
  runtime `PerformanceView` (the proposed mirror and `PROPOSED_ROUTES.performance` removed from
  `contracts.ts`); `PerformancePage` shows p50/p90, the effort in force (`effortLabel`), the
  last measurement, a window select (1/7/30/90 days → `?days=`), recent measurements with
  source; the "route not available" state is gone (a failure is an error with retry). The fake
  daemon serves the runtime shape with the window, the project, 400 and 404; the fixture is
  the real shape; the Playwright spec checks the window.
- **Docs:** `docs/maintainers/runtime.md` (Performance view section, Models note),
  `docs/maintainers/apps.md` (page row, client, fake daemon, tests, proposed routes);
  `docs/requirements.md` D.7 and D.19 → `done` with the new tests; `docs/status/BLOCKERS.md`
  row "D.7, D.19 the Performance view served by the daemon" → built, with residuals;
  `docs/status/PROGRESS.md` log entry and plan list; `CHANGELOG.md` Unreleased entry.

### Tests that prove it

- `packages/runtime/test/performance-view.test.ts` (7 tests): nearest rank
  (`sorted[ceil(p/100·n)−1]`, odd/even/one/empty, input not mutated); mode derivation from
  specialist, review tier and rung; chat/voice event samples and what is skipped; seeded Run
  rows across every mode → medians, p90, targets, within-target share, met, lastAt; routing
  with no samples; the window (default 7, `days` 10 and 1, cap 90, a later now); other
  human's rows and other project's rows excluded; effort in force with offset +1 (critic
  medium→high, high→xhigh; coder/chat/voice/planning unchanged), an adopted table, all
  projects offset 0; recent newest first with source; unknown project `not_found`.
- `packages/runtime/test/performance-route.test.ts` (3 tests): the route on the composed
  daemon: in `DAEMON_ROUTES`, 401 without the token, a real `POST /chat` turn plus seeded runs
  appear per mode (text_chat, coder, critic_t1 met false at p90 41 s), the window via
  `?days=`, the project's offset −1 on the critic effort, 400 for `0`, `-3`, `1.5`, `week`,
  404 for an unknown project. Verified to fail (2 of 3) with the starting commit's
  `server.ts`.
- `packages/runtime/test/intake.test.ts` (extended): the intake call's Run row with
  specialist, model, effort, ttft, duration and cost.
- `packages/runtime/test/conversation.test.ts` (extended): the `chat.reply` row carries
  `ttftMs`, `durationMs`, `model`, `effort`, `source`.
- `apps/ui/test/performance.test.tsx` (7 tests): fixture parses with the runtime schema; p90
  against each target; effort label; every mode rendered with effort, share, bar, last; the
  window select reaches the fake daemon; a failure shows an error and no route-missing.
- `apps/ui/test/client.test.ts` (performance days/400/404 round trip; the missing-route
  example moved to `milestones`), `apps/ui/test/contracts.test.ts` (`performance` is served,
  not proposed).

### Commands run and results (2026-10-23)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | clean (node packages and the apps) |
| `pnpm lint` | 0 errors (59 warnings, the same count as before the change) |
| `pnpm exec vitest run --project unit packages/runtime/test` | 116 files passed; 994 tests passed, 1 skipped |
| `pnpm exec vitest run --project unit packages/runtime/test/performance-view.test.ts packages/runtime/test/performance-route.test.ts packages/runtime/test/intake.test.ts packages/runtime/test/conversation.test.ts` | 4 files, 36 tests passed |
| `pnpm exec vitest run --project integration packages/runtime/test` | 1 file, 4 tests skipped (sandbox: no container engine on the box) |
| `pnpm --filter @forerunner/ui test` | 42 files, 255 tests passed |
| `node scripts/docs-check.mjs --base 42b41f6` (and `--base origin/ccr-4d8a843c-1k9syk`) | ok (25 files) |
| `node scripts/docs-check.mjs` | no `origin/main` in this clone: "nothing to check" |
| `pnpm check` | exit 0: lint, typecheck, 271 test files / 2683 tests passed (4 skipped, 1 todo), secret scan clean |

The Playwright spec (`apps/ui/e2e/performance.spec.ts`) was updated but not run here (no
browser on the box).

### Left open and why

- **Routing mode has no samples**: no code path makes a routing/triage/summary model call
  that writes a Run row today; the row shows its 3 s target with no figures. When one exists,
  its Run row needs a specialist `runMode` maps to `routing`.
- **The offset reaches the critic only**: the executor's `effortOffset` is a static dependency
  and chat, voice and planning ignore the project's offset (D.16, item `w3-d16-slider`). The
  view reports that truthfully (`offsetApplied`); widen `OFFSET_MODES` when D.16 lands.
- **Voice total time**: a voice turn is reported to first audio (its target figure); its total
  time is not recorded in the `voice.turn` row, so the voice total columns stay empty.
- **Live figures**: D.8 to D.15 live measurements stay in `gates.md` ("Response-time
  targets"); those rows stay `in progress` per their own BLOCKERS row.
