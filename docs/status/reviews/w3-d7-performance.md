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

### Commands run and results (2026-10-23, output copied from the terminal)

The output below is what the commands printed, after stripping the ANSI colour codes.
Vitest's per-test lines and the runtime's log lines are filtered out with `grep`, and the
filters are named. Every command was run on the final tree of this branch. The trailer fix
was a message-only rewrite of my own seven commits (`git filter-branch --msg-filter` over
`42b41f6..HEAD`; no rebase, no base merged); it left the tree unchanged, at `9be2868`.

**Commits in the patch** (`git log --oneline 42b41f6..HEAD`, trailer
`Claude-Build: managed-agent w3-d7-performance build` on each). These are the seven commits;
the report revision adds one more on top:

```
df2b96a status: the build report of w3-d7-performance
7a92e1c status: D.7 and D.19 done; the Performance view blocker row records what was built
305b0b8 docs: runtime.md and apps.md describe the daemon's Performance view
e3322bd ui: the Performance e2e spec checks the window and that no route is missing
ceace9b ui: the Performance page reads the daemon's GET /performance shape
85d6233 runtime: GET /performance serves the Performance view from the Run rows and the turns
6774d71 runtime: the intake call writes a Run row and chat replies carry their total time
```

**Typecheck**

```
$ pnpm typecheck

> forerunner@0.1.0 typecheck /workspace/repo
> tsc -p tsconfig.node.json --noEmit && pnpm -r --filter "./apps/*" --if-present typecheck

Scope: 4 of 21 workspace projects
apps/approvals-web typecheck$ tsc -p tsconfig.json --noEmit
apps/mobile typecheck$ echo 'no TypeScript in the mobile shell; see @forerunner/ui'
apps/desktop typecheck$ echo 'no TypeScript in the desktop shell; see @forerunner/ui'
apps/ui typecheck$ tsc -p tsconfig.json --noEmit
apps/mobile typecheck: no TypeScript in the mobile shell; see @forerunner/ui
apps/desktop typecheck: no TypeScript in the desktop shell; see @forerunner/ui
apps/desktop typecheck: Done
apps/mobile typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
exit=0
```

**Lint**: no errors. The 59 warnings are all in files this patch does not touch, and the
patch's own files have no diagnostics at all.

```
$ pnpm lint
    197 │   });
    198 │ });
  

The number of diagnostics exceeds the limit allowed. Use --max-diagnostics to increase it.
Diagnostics not shown: 39.
Checked 1160 files in 2s. No fixes applied.
Found 59 warnings.
exit=0

$ pnpm exec biome check <the 19 .ts/.tsx files this patch changes>
Checked 19 files in 121ms. No fixes applied.
exit=0
```

**Runtime unit tests, the whole package** (filtered with `grep -E "Test Files|Tests |Duration|FAIL"`)

```
$ pnpm exec vitest run --project unit packages/runtime/test
 Test Files  116 passed (116)
      Tests  994 passed | 1 skipped (995)
   Duration  82.57s (transform 7.27s, setup 0ms, import 121.39s, tests 106.11s, environment 14ms)
exit=0
```

**The tests of this item** (filtered to the per-file lines and the summary)

```
$ pnpm exec vitest run --project unit packages/runtime/test/performance-view.test.ts packages/runtime/test/performance-route.test.ts packages/runtime/test/intake.test.ts packages/runtime/test/conversation.test.ts
 ✓  unit  packages/runtime/test/performance-route.test.ts (3 tests) 320ms
 ✓  unit  packages/runtime/test/conversation.test.ts (15 tests) 489ms
 ✓  unit  packages/runtime/test/intake.test.ts (11 tests) 1152ms
 ✓  unit  packages/runtime/test/performance-view.test.ts (7 tests) 160ms
 Test Files  4 passed (4)
      Tests  36 passed (36)
exit=0
```

**The new route test fails without the route**: the starting commit's `server.ts` was
restored temporarily and then put back.

```
$ (start commit server.ts restored) pnpm exec vitest run --project unit packages/runtime/test/performance-route.test.ts
     ✓ is in the route table and needs the bearer token 2ms
     × serves every mode from the store: a chat turn and the Run rows, per project, in the window 9ms
     × refuses a bad days with 400 and an unknown project with 404 2ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL   unit  packages/runtime/test/performance-route.test.ts > GET /performance on the daemon > serves every mode from the store: a chat turn and the Run rows, per project, in the window
AssertionError: expected 404 to be 200 // Object.is equality
 FAIL   unit  packages/runtime/test/performance-route.test.ts > GET /performance on the daemon > refuses a bad days with 400 and an unknown project with 404
AssertionError: expected 404 to be 400 // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

**Runtime integration tests.** Nothing ran: the only integration file in the package is the
sandbox one, and it skips when no container engine is reachable. This item does not touch
the sandbox, and there are no integration tests for the Performance view (it needs no
Postgres; its tests are unit tests over in-memory SQLite and the composed daemon).

```
$ pnpm exec vitest run --project integration packages/runtime/test
stderr | packages/runtime/test/sandbox.integration.test.ts
2026-10-23T14:35:55.858Z WARN  [sandbox:detect] no container engine reachable {"reason":"docker: failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory; podman: podman not on PATH"}
 ↓  integration  packages/runtime/test/sandbox.integration.test.ts (4 tests | 4 skipped)
 Test Files  1 skipped (1)
      Tests  4 skipped (4)
   Duration  526ms (transform 227ms, setup 0ms, import 376ms, tests 0ms, environment 0ms)
```

**UI tests** (filtered to the touched test files and the summary)

```
$ pnpm --filter @forerunner/ui test
 ✓ test/performance.test.tsx (7 tests) 573ms
 ✓ test/client.test.ts (17 tests) 219ms
 ✓ test/state-client.test.ts (12 tests) 350ms
 ✓ test/contracts.test.ts (8 tests) 66ms
 Test Files  42 passed (42)
      Tests  255 passed (255)
exit=0
```

**Docs check.** This clone has no `origin/main` (`git fetch origin main` answers "couldn't
find remote ref main"), so the bare command has nothing to diff against and checks nothing.
The script's own base setting, `DOCS_CHECK_BASE` or `--base`, runs the real check against the
starting commit and against the base branch, and both pass:

```
$ node scripts/docs-check.mjs
fatal: ambiguous argument 'origin/main...HEAD': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'
docs-check: cannot diff against origin/main (Command failed: git diff --name-only origin/main...HEAD
fatal: ambiguous argument 'origin/main...HEAD': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'
); nothing to check.
exit=0

$ DOCS_CHECK_BASE=42b41f6e793c3a4faaa04fb6ba5cd1d4361da470 node scripts/docs-check.mjs
docs-check: ok (26 files).
exit=0

$ node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk
docs-check: ok (26 files).
exit=0
```

**`pnpm check`** (filtered to the step headers and the results; the inner docs check hits the
same missing `origin/main` as above):

```
> pnpm lint && pnpm lint:paths && pnpm typecheck && pnpm test && pnpm docs:check && pnpm docs:links && pnpm secrets:scan
> biome check .
Checked 1160 files in 2s. No fixes applied.
Found 59 warnings.
> node scripts/check-paths.mjs
check-paths: ok (986 files).
> tsc -p tsconfig.node.json --noEmit && pnpm -r --filter "./apps/*" --if-present typecheck
> vitest run --project unit
 Test Files  271 passed (271)
      Tests  2683 passed | 4 skipped | 1 todo (2688)
> node scripts/docs-check.mjs
docs-check: cannot diff against origin/main (Command failed: git diff --name-only origin/main...HEAD
> node scripts/link-check.mjs
link-check: ok (106 files).
secret-scan: clean (1410 files).
exit=0
```

**Export and `git apply --check` against a clean checkout of the starting commit.** These
commands were run after this report was committed, so the patch they check contains this
report:

```
$ git format-patch --stdout 42b41f6e793c3a4faaa04fb6ba5cd1d4361da470..HEAD > /mnt/session/outputs/w3-d7-performance.patch
$ git worktree add /tmp/verify 42b41f6e793c3a4faaa04fb6ba5cd1d4361da470
$ cd /tmp/verify && git apply --check /mnt/session/outputs/w3-d7-performance.patch; echo "exit=$?"
exit=0
```

`git apply --check` prints nothing when the patch applies; the exit status 0 is the proof.
The patch then holds the eight commits `42b41f6..HEAD`, the seven above plus this report's
revision.

```
$ git log --oneline 42b41f6..HEAD | wc -l
8
```

The Playwright spec (`apps/ui/e2e/performance.spec.ts`) was updated but not run here, because
there is no browser on the box.

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
- **Runtime integration tests skipped**: the package's only integration file (the sandbox)
  needs Docker or Podman, and neither is on the box (output above). The Performance view has
  no integration test of its own: the brief asks for none, and it needs no Postgres.
