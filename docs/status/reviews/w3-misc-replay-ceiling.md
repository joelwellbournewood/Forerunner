# w3-misc-replay-ceiling

Item: Known issues closed: a replayed phone plan envelope runs once; the executor's attempt
rung reads the project's critic ceiling. Requirements R.4, V.3 (scenario 9 todo), H.4 (critic
ceiling), V.4 (known issues). ADR: none (no decision was made: the code paths already existed).
Branch `wave/w3-misc-replay-ceiling`, starting commit c786f82 (base `ccr-4d8a843c-1k9syk` at
e2bfb1e plus two commits from an earlier attempt on this branch, kept).

## Build report

### What was found

Both gaps were already closed in code, landed with the runtime-gaps wave and not recorded in
the Known issues:

1. **Replay dedupe, at both lines.** `POST /remote/commands`
   (`services/state-api/src/routes/remote.ts`, `enqueueRemoteCommandOnce`) runs a device's
   enqueue through the outbox's `IdempotencyStore` keyed on (device, `params.clientId`): the
   repeat answers 200 with the first row's id and status and creates no row; a different body
   under the same clientId is 409. `RemoteCommandWatcher.replayOf`
   (`packages/runtime/src/remote/watcher.ts`) refuses an envelope whose (issuing device,
   clientId) it handled before (process memory, then the audit rows of the last 30 days) as
   `failed`, `status: "duplicate"`, `duplicateOf` the first row, before anything is composed.
   The idempotency store was used rather than a unique index on (device_id, client_id): the
   route already had it, it covers the `/sync/outbox` path under the same key, and the watcher
   covers a second service instance; no migration was needed.
2. **Ceiling read per run.** `LoopTaskExecutor` computes
   `ceiling = projectCeiling?.(project.settings) ?? ceiling` inside `execute`, from the project
   row it loads for that task, and `composeRuntime` (`packages/runtime/src/daemon/compose.ts`)
   passes `projectCeiling: (settings) => criticSettingsOf(settings).ceiling` and no static
   ceiling. So `tierForAttempt` on the third attempt is capped by the project's
   `critic_ceiling`.

So the work was the proof and the records, per the brief ("if yes, replace the it.todo with the
passing test").

### What was built

- `tests/e2e/scenarios/09-phone.scenario.test.ts`: the `it.todo` is now the case "a plan
  envelope the outbox replays (same device and clientId) runs once": the phone sends the
  envelope, posts the same envelope again (asserted 200, the first row's id, `pending`, no
  second row), a copy is written straight into the store past the service (a second service
  instance / restored backup), the PC watcher drains both: the first is `done` with the three
  commands, the copy `failed` as `duplicate` with `duplicateOf`, one allowed and one denied
  audit row; exactly one card answered, one change log row, one scheduler start, the task done,
  the override set. (Earlier attempt's commit 14594ad, kept.)
- `packages/runtime/test/executor-ceiling.test.ts`: a project ceiling of haiku (tier 1, the
  first rung) keeps the third attempt at haiku; the ceiling is read from the project row at
  every run (one executor, the settings changed between runs: opus, then haiku, then sonnet).
  `packages/runtime/test/remote-wiring.test.ts`: the same haiku cap through the composed
  daemon. (Earlier attempt's commit c786f82, kept; this attempt fixed its type error:
  `Record<string, unknown>` is not a `JsonObject`, so `pnpm typecheck` failed on it, commit
  b57f8cb.)
- Docs: `docs/maintainers/testing.md` (both Known issues bullets replaced by "Closed" records;
  scenario 9's table row and R.4 coverage name the replay case), `docs/maintainers/runtime.md`
  (the ceiling read per `execute`, the haiku and per-run tests), `docs/maintainers/state-service.md`
  (the tests of "Once per tap", including scenario 9). `docs/requirements.md`: R.4 names
  scenario 9; H.4 and D.3 name `executor-ceiling.test.ts` and `remote-wiring.test.ts` (statuses
  unchanged: V.3 still needs three runs per OS and the Android run, V.4 still has a P1 open).
  `docs/status/BLOCKERS.md` V.3 and V.4 rows and `docs/status/PROGRESS.md` (log entry, next-steps
  list) record the item as built, review pending.

### Tests that prove it, and that they fail without the behaviour

Mutation checks, each reverted after the run:

| Mutation | Result |
| --- | --- |
| executor ignores `projectCeiling` (`const ceiling = this.deps.ceiling`) | `executor-ceiling.test.ts` 3 failed (sonnet cap, haiku cap, per-run), `remote-wiring.test.ts` 1 failed |
| route skips the dedupe (`enqueueRemoteCommandOnce` always enqueues) | scenario 9 replay case failed: `expected 201 to be 200` |
| watcher's `replayOf` always returns null | scenario 9 replay case failed: `stats` has no `duplicates: 1` |

Unit tests of the route and watcher (already present): `services/state-api/test/remote.test.ts`
("a device's envelope is enqueued once per clientId ..."), `packages/runtime/test/remote-watcher.test.ts`
("two rows with the same clientId: one executed, the other failed as a duplicate and audited").

### Commands and results (2026-10-23, Linux sandbox)

- `pnpm install --frozen-lockfile`: done.
- `pnpm typecheck`: first run failed (`executor-ceiling.test.ts(103,44) TS2322`, from the earlier
  attempt); after b57f8cb exit 0.
- `pnpm lint`: exit 0 (59 warnings, none in touched files; 0 errors).
- `node scripts/docs-check.mjs --base $(cat /tmp/start-sha)`: `docs-check: ok (6 files).`;
  `--base e2bfb1e`: `docs-check: ok (9 files).`
- `pnpm exec vitest run --project unit packages/runtime/test`: 114 files passed, 986 tests passed,
  1 skipped.
- `pnpm exec vitest run --project unit services/state-api/test`: 10 files, 131 tests passed.
- `pnpm exec vitest run --project e2e tests/e2e/scenarios/09-phone.scenario.test.ts`: 1 file,
  2 tests passed.
- `pnpm exec vitest run --project e2e tests/e2e/scenarios`: 13 files passed, 25 tests passed,
  1 skipped, no todo left (before: 24 passed, 1 skipped, 1 todo).
- `pnpm check`: green. lint, lint:paths and typecheck clean; `pnpm test` 269 files passed,
  2675 tests passed, 4 skipped, 1 todo (the unrelated `scripts/closeout-docs.test.ts` P.7 todo);
  docs:check has no `origin/main` in this clone and checks nothing (run by hand above with
  `--base`); `link-check: ok (106 files)`; `secret-scan: clean (1407 files)`.

### Left open

- The watcher's lookup is per row, not a lock: two daemons of one human picking two copies at
  the same instant could both act. Already listed in runtime.md's Known issues; a store-level
  claim on (device, clientId) would close it and is a state schema decision, outside this item.
- The idempotency record lives a week in the service's `idempotency.json`, per instance; the
  watcher's 30-day audit lookup is the second line for older copies and other instances.
- V.3 and V.4 stay open for reasons outside this item (three runs per OS and the Android run;
  the P1 and the stale doc entries).
- Independent review of this item is pending.
