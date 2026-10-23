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

## Review

Reviewer: independent review stage (`w3-d7-performance`, REVIEW AND FIX), starting commit
`61adc32`, base `ccr-4d8a843c-1k9syk` at `f1948dd` (not merged in).

**Verdict: revise. Score: 72/100.** The route, the view, the page and the fake daemon are
there and they match each other. The tests pass: 36 tests in the four runtime files, 255 UI
tests, and typecheck and lint are clean. But on realistic failure paths the figures are
wrong. A Run row that never reached a model counts as a response-time sample, so a refused
critic call "meets" the 30 s target in 3 ms. The new intake Run row also drops the prompt
version that D.5 (`done`) requires of every run.

### Requirements checked

- D.19 "each run records time to first token and total time": executor and critic rows
  (unchanged), the intake call's new Run row, `chat.reply` `ttftMs` and `durationMs`. Met.
  The intake row breaks D.5 (finding 2).
- D.19 "the Performance view shows these per mode against target": `GET /performance` from
  the store, eight modes, n, p50 and p90 by nearest rank, target, met, `lastAt`. Met, but
  failed runs skew the figures (finding 1).
- D.7 "each mode has a response-time target that the UI measures and shows": the page shows
  every mode with its target, the "route not available" state is gone, and the client
  validates with the runtime schema. Met.
- D.7 effort rule, "the effort in force from the ladder and the project's offset": the table
  in force and the offset where the code applies it (critic). The risk-tier raise is not
  shown (finding 3).
- The window: 7 days by default, `?days=`, capped at 90, 400 and 404. Met, but `days` parsing
  is loose (finding 4).
- Ownership: only rows on sessions of the install's human's agents count. Verified in
  `performance-view.test.ts`, where Bob's run and chat turn are excluded. No privacy
  regression; the route sits behind the bearer token (401 test).
- The fake daemon is kept in sync: the fixture parses with the runtime schema, and 400 and
  404 behave as the daemon does. Met.
- Docs: runtime.md and apps.md describe the view. apps.md still lists the data routes as
  proposed (finding 6).
- Status rows: requirements D.7 and D.19 are `done` and the counts (185/38/5) were verified by
  grep. The BLOCKERS row and the PROGRESS entry are present.
- Semantic conflicts with the base: a throwaway merge of `origin/ccr-4d8a843c-1k9syk` in a
  worktree conflicts textually in `contracts.ts`, `contracts.test.ts` and `apps.md`. With
  those resolved, typecheck passes, the UI has 42 files / 262 tests passing and the 4 runtime
  files have 36 passing. One drift remains (finding 5).

### Findings

1. **medium**, `packages/runtime/src/daemon/views.ts:801` (Run rows) and `:714` (`chat.reply`):
   a Run row counts as a measurement whenever it carries `duration_ms`. Some runs never reach
   a model but still carry it:
   - the executor's `endRunWithError`, on a refused lease or a missing vault secret, writes
     outcome `error` with a duration of a few ms and no `ttft_ms`;
   - a budget refusal before the call;
   - an intake call that throws before the driver.

   These rows count as samples with a near-zero total. The total median is pulled down, and
   for the total-kind targets (critic tier 1, planning, routing) they count as "within
   target". Chat replies with no first token are treated the same way. The view already
   excludes a registry reply with no model call, so the rule is inconsistent.

   *Verified* with a throwaway test (deleted): one critic run of 45 s plus one `error` run of
   3 ms with no `ttft_ms` gives `totalP50Ms: 3` and `withinTargetShare: 0.5` for critic
   tier 1.

   *Fix:* a Run row or chat turn is a measurement when it has a first token, or when it timed
   out (a real over-target). Add a regression test.

   Resolution: fixed in df2a693. `isMeasurement` keeps a Run row only when it has `ttft_ms` or
   timed out, and `eventSample` does the same for chat turns (`ttftMs`, or `outcome: "timeout"`).
   The new test in `performance-view.test.ts`, "what counts as a measurement", seeds an error
   run, a budget-refused run, a failed intake row, a timed-out run and failed or timed-out
   chat turns. It failed before the fix and passes now.
2. **medium**, `packages/runtime/src/session/intake.ts:745`: the intake call's new Run row
   writes `prompt_version: ""`. D.5 (`done`) says every run stores model, version, settings
   and prompt version. The executor and the critic store theirs. The PM prompt comes from the
   registry (`registry.principals.get("project-manager")`), and that entry has a
   `promptVersion` that compose does not pass on.

   *Verified* by reading the code. `intake.test.ts` asserts specialist, model, effort, timing
   and cost on the row, but not `prompt_version`, so the empty value passes.

   *Fix:* pass the PM prompt's version into `IntakeService`, store it, and use a named
   built-in version when there is no registry prompt. Assert it in `intake.test.ts`.

   Resolution: fixed in 73b3437. Compose passes `registry.principals.get("project-manager").promptVersion`,
   and the row stores it, or `INTAKE_BUILTIN_PROMPT_VERSION` on the built-in line.
   `intake.test.ts` checks the registry version on the approved path and the built-in version
   in a new test. Both failed before the fix.
3. **low**, `packages/runtime/src/daemon/views.ts` (`modes` map) against `models/ladder.ts:96-98`:
   "the effort in force" shows one effort per mode, but `effortForTask` raises the coder to
   `high` at risk tier 2 and above, and critic tier 2/3 to `max` at risk tier 3. A tier-2
   coding task runs at `high` while the page says `medium`. The spec's effort rule cannot be
   seen on exactly the tasks where it changes.

   *Verified* by reading `effortForTask`. No test covers the view's effort on a risky task.

   *Fix:* add the raised effort per mode (`riskEffort`, `riskTierFrom`) with the offset
   applied as for `effort`. Show it on the page and in the fixture. Test it in the view, route
   and UI tests.

   and UI tests.

   Resolution: fixed in 494bb8a. `PerformanceModeView` gains `riskEffort` and `riskTierFrom`
   (`riskEffortOf`, from `effortForTask`, with the offset applied as for `effort`). The page's
   `effortLabel` shows "medium; high from risk tier 2", and the fixture and docs follow. The
   view, route and UI tests assert it, including an adopted table where the coder is already
   at high (`riskEffort` null).
4. **low**, `packages/runtime/src/daemon/server.ts:1250` and `apps/ui/test/fake-daemon.ts:2417`:
   `days` is parsed with `Number()`, so `?days=0x10` is read as a 16-day window, `1e1` as 10
   days, and `" 7"` and `7.0` as 7. The documented contract is "a positive integer".

   *Verified* with `node -e` on the same expression: all four are accepted.

   *Fix:* accept decimal digits only, in the daemon and in the fake. Extend the 400 cases in
   `performance-route.test.ts` and in `client.test.ts`.

   `performance-route.test.ts` and in `client.test.ts`.

   Resolution: fixed in 15725da. The daemon and the fake daemon accept `/^[0-9]+$/` only. The
   route test refuses `0x10`, `1e1`, `%207`, `7.0` and `+7` and accepts `007`, and the client
   test checks the fake. The route test failed before the fix.
5. **low**, `apps/ui/test/client.test.ts:253` and the following lines: the "missing route"
   example was moved from `performance` to `milestones`. The base branch now serves
   `milestones` (its `contracts.test.ts` lists `milestones` and `changeMilestone` as served,
   and it moved its own missing-param example to `docs`). After a merge, the test would be
   proving "route missing" with a route the daemon serves. It still passes only because the
   fake's `missingRoutes` forces a 404.

   *Verified* with the throwaway merge described above (passes, but on a served route).

   *Fix:* use `docs`, which stays proposed on both branches.

   *Fix:* use `docs`, which stays proposed on both branches.

   Resolution: fixed in 63b9c9a. The test uses `docs` and asserts that it is in
   `PROPOSED_ROUTES` and not in `DAEMON_ROUTES`, so the test fails loudly once `docs` is
   served. A repeat of the throwaway merge with the base after all fixes gives typecheck
   clean, UI 42 files / 262 tests passed and runtime 4 files / 38 tests passed. The three
   textual conflicts (`contracts.ts` header comment, `contracts.test.ts` served list,
   `apps.md`) remain for the integrator; each is a union of both sides.
6. **low**, `docs/maintainers/apps.md:109-110`: the client paragraph this branch rewrote still
   lists `dataAssets`, `registerDataAsset` and `removeDataAsset` among the proposed routes.
   The `contracts.ts` header (also rewritten here) and `contracts.test.ts` say they are
   served, so the doc and the code disagree.

   *Verified* by reading `contracts.test.ts:80-90`, which lists them as served.

   *Fix:* list them with the served routes.

   *Fix:* list them with the served routes.

   Resolution: fixed in 0fd80f8. The client paragraph and the proposed-routes note list the
   data asset routes as served. The client tests' description names the `docs` missing-route
   example and the `days` cases.

### After the fixes

All six findings are fixed on the branch. b1397e8 is Biome formatting of two test files, and
the status rows are updated in the commit after it. Checks on the final tree: `pnpm typecheck`
exit 0; `pnpm lint` exit 0 (59 warnings, all in files this item does not touch); runtime unit
tests 116 files / 996 passed, 1 skipped; the four item files 38/38; UI 42 files / 255 tests;
`node scripts/docs-check.mjs --base <start>` ok (18 files) and `--base origin/ccr-4d8a843c-1k9syk`
ok (27 files); `pnpm check` exit 0 (unit 271 files / 2685 passed, 4 skipped, 1 todo).

## Rebase

2026-10-23: the branch (start f8fb6a4, merge base 82a6295) was rebased with
`git rebase origin/ccr-4d8a843c-1k9syk` onto cac6fee (181 base commits ahead of the merge
base). All 19 commits replayed; the base was not merged into the branch. Conflicts and their
resolution (the commit being replayed first):

1. 0f4a2ce agent.ts imports: base added AgentRow import; branch added wholeMs value import -> kept both
2. 501362e apps/ui/src/api/contracts.ts header comment listing proposed routes: base had removed milestones (served) and still listed "data assets and imports, project docs, performance"; branch removed performance. Base had also since served data assets (dataAssets in DAEMON_ROUTES). Resolved to the routes still in PROPOSED_ROUTES: "the next-session queue, imports, project docs".
3. 501362e apps/ui/test/contracts.test.ts served-route list: base added milestones, changeMilestone; branch added performance -> kept all three.
4. 33328fb docs/maintainers/apps.md, client paragraph: base moved milestones/changeMilestone to the served list and kept performance among the proposed; branch moved performance out with its `performance(filter?)` description. Merged: served list carries milestones, changeMilestone and the data asset routes (base serves them, see contracts.test.ts; the branch's later fix 6336000 says the same), proposed list is queue, enqueue, dismissQueueItem, importProject, docs, doc, plus the branch's performance sentence.
5. 33328fb apps.md, fake-daemon paragraph: base added milestones with POST /milestones/:id behaviour; branch added the GET /performance behaviour. Merged both; "served read-only" now lists decisions, the peer feed and docs.
6. 33328fb apps.md, known-gaps proposed-routes bullet: base said milestones are served since B.5 with the Plan tab fallback; branch said performance left the list. Merged: both sentences, plus the data assets as served (branch fix 6336000 applied here already).
7. 33328fb docs/maintainers/runtime.md, Ladder paragraph: base added the fast-mode tierOfModel sentence (ADR 0057); branch added INTAKE_RUN_SPECIALIST. Kept both.
8. fabb930 CHANGELOG.md, Unreleased/Added: base added the E.1 CI-and-PR-comment triggers entry; branch added the Performance view entry. Kept both entries (base first, then the branch's).
9. fabb930 docs/status/PROGRESS.md, Log: base added the entries for w2-s32-indicator (rebase, review, build), w2-s12-unlock-card, w3-e1-triggers and w4-fcm-sender; branch added its build entry. Kept all; the branch's entry first (newest).
10. fabb930 PROGRESS.md, "Next" item list: base annotated w4-fcm-sender ("built on its branch, review and merge pending"); branch annotated w3-d7-performance. Merged both annotations into the one list item.
11. 6336000 apps.md, client paragraph and proposed-routes bullet: the branch's fix (data asset routes served) was already folded in at conflict 4/6 together with the base's milestones; took that merged text (milestones stays served, as on the base).

Afterwards one follow-up commit: the `contracts.ts` header names milestones among the routes
that were proposed first and are now served, and this log, PROGRESS.md (rebase entry, the
item list, the requirement counts) carry the current figures.

Checks on the rebased tree: `pnpm typecheck` exit 0; `pnpm lint` exit 0 (59 warnings, none
an error); `pnpm exec vitest run --project unit packages/runtime/test` 130 files / 1144
passed, 1 skipped (`performance-view.test.ts` 8, `performance-route.test.ts` 3,
`intake.test.ts` 12, `conversation.test.ts` 23); `pnpm exec vitest run --project integration
packages/runtime/test` 1 file / 4 tests skipped (Docker sandbox, no daemon); `pnpm --filter
@forerunner/ui test` 46 files / 301 tests (`performance.test.tsx` 7, `client.test.ts` 17,
`contracts.test.ts` 8); `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok.
Requirements after the rebase: 187 done, 36 in progress, 5 todo.

## Rebase (onto 4ff4fb1)

2026-10-23: the branch (start 093d5b9, merge base cac6fee) was rebased with
`git rebase origin/ccr-4d8a843c-1k9syk` onto 4ff4fb1 (73 base commits ahead of the merge base:
the merges of w2-l6-speak, w3-c5-specialist-approval, w3-d16-slider, w3-e4-recheck and
w5-android-high-risk). All 20 commits replayed; the base was not merged into the branch.
Conflicts and their resolution (the original commit being replayed first):

1. 030a22a `packages/runtime/src/session/intake.ts` imports: the base imports `capEffort`,
   `modeEffort`, `speedQualityOffsetOf` (the D.16 slider), the branch `INTAKE_RUN_SPECIALIST`.
   One import with all of them. The branch's intake Run row wrote `effort: planning.effort`
   (the table's); against the base's code the call now runs at `effort` (the slider's shift,
   held at the project manager's `max_effort`), so the row stores that value.
2. fbe8ad0 `packages/runtime/src/daemon/views.ts` imports: the base added
   `spokenProjectSummary` (Read aloud), the branch `ForerunnerError`. Kept both.
3. 7788694 `docs/maintainers/runtime.md`: the base added the "Read aloud" paragraph where the
   branch added the "Performance view" section. Kept both, the base's first. The Ladder
   paragraph (`INTAKE_RUN_SPECIALIST`) and the base's new slider paragraph merged on their own.
4. 773dc7c `docs/status/PROGRESS.md`, Log: the base added the entries of w3-d16-slider (rebase,
   review, build), w3-e4-recheck (rebase, review, build) and w5-android-high-risk (rebase,
   build and review); the branch its build entry. Kept all, the branch's entry first.
   "Next" item list: the base's lines are kept verbatim (they hold two copies of the same
   items, left by an earlier merge on the base); the branch's annotation of w3-d7-performance
   is merged into both mentions.
5. 5551130 `packages/runtime/src/daemon/compose.ts`: the base passes the intake
   `maxEffort` (project manager's `max_effort`), the branch `promptVersion`. Kept both.
   `intake.ts` `IntakeDeps`: both fields with their doc comments. The intake Run row: the
   base-shaped `effort` (conflict 1) with the branch's `prompt_version`.
6. 093d5b9 `docs/status/PROGRESS.md` item list: the same lines as conflict 4; the annotation
   became the branch's "built, reviewed and fixed ... rebased" in both mentions (updated to
   4ff4fb1 in the status commit after the rebase).

What merged without a textual conflict but no longer matched the base's code, fixed in two
follow-up commits:

- **The effort in force.** The branch showed the project's offset on the critic tiers only
  (`OFFSET_MODES`), because before D.16 nothing else read it. The base's slider (w3-d16-slider)
  now shifts every mode's effort (executor per run, conversation agent per turn, intake per
  planning session, critic per review) and each consumer holds it at the registry's
  `max_effort`. `OFFSET_MODES` now lists every mode with a run (routing has none);
  `effort` is `capEffort(modeEffort(...))` as the consumers compute it, with the caps from
  `effortCapsOf(rt.registry)` shown per mode as the new `maxEffort`; `riskEffort` is capped the
  same way. The BLOCKERS residual "the offset reaches only the critic tiers until D.16" closed.
- **The effort a measurement records.** The branch's `chat.reply` row wrote `textChat.effort`
  (the table's); the base's agent computes the turn's effort from the slider and the cap. The
  row stores that `effort` now, so a sample's effort is the one the turn ran at.
- **Chat turns per project.** The base's `daemon/conversation-session.ts` opens the agent's one
  conversation session without a project (for voice and speech), and the conversation agent
  keeps the session of the first turn; the view scoped chat turns by the session's
  `project_id`, so a project's view lost its chat turns (found by the new `effort-offset.test.ts`
  assertion). The reply row now carries the turn's `projectId` and the view scopes a reply by it.
- **apps.md** (base, slider section): "The Performance view is untouched: it shows response
  times per mode, not the slider" became the sentence that it shows the effort the slider
  yields, without moving it. The fake daemon applies the slider position Settings left in its
  state; the fixture carries `maxEffort`.

Tests added for these: `performance-view.test.ts` (the slider in every mode, the registry caps,
a lower cap, chat turns scoped by their own project; 9 tests), `performance-route.test.ts`
(the slider at -1 and the shipped caps per mode on the composed daemon), `intake.test.ts` (the
Run row's effort at +1 and under a cap; fails with the table's effort), `effort-offset.test.ts`
(a typed chat turn's effort per slider position is the view's, for the mode and the sample),
`conversation.test.ts` (the reply row's `projectId`), `apps/ui/test/performance.test.tsx`
(the fake daemon's slider and the cap in the title; 8 tests).

Checks on the rebased tree: `pnpm typecheck` exit 0; `pnpm lint` exit 0 (59 warnings, none
an error, none in the branch's files); `pnpm exec vitest run --project unit
packages/runtime/test` 135 files / 1219 passed, 1 skipped; `pnpm exec vitest run --project
integration packages/runtime/test` 1 file / 4 tests skipped (Docker sandbox, no daemon);
`pnpm --filter @forerunner/ui test` 48 files / 326 tests; `node scripts/docs-check.mjs --base
origin/ccr-4d8a843c-1k9syk` ok. Requirements after the rebase: 190 done, 33 in progress,
5 todo.
