# w3-misc-replay-ceiling

Item: Known issues closed: a replayed phone plan envelope runs once; the executor's attempt
rung reads the project's critic ceiling. Requirements R.4, V.3 (scenario 9 todo), H.4 (critic
ceiling), V.4 (known issues). ADR: none (no decision was made: the code paths already existed).
Branch `wave/w3-misc-replay-ceiling`, starting commit c786f82 (base `ccr-4d8a843c-1k9syk` at
82a6295 plus two commits from an earlier attempt on this branch, kept).

## Build report

(Commit ids corrected at review, finding 5: the report first named ids from a local
history that was never pushed; each is replaced by the commit on the branch with the same
subject, and the base by the real merge base 82a6295.)

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
  ceefcd2.)
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
  attempt); after ceefcd2 exit 0.
- `pnpm lint`: exit 0 (59 warnings, none in touched files; 0 errors).
- `node scripts/docs-check.mjs --base $(cat /tmp/start-sha)`: `docs-check: ok (6 files).`;
  `--base 82a6295`: `docs-check: ok (9 files).`
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

### Commits and trailers

The exported series (`git log --oneline c786f82..HEAD`), every commit in the form
`area: what changed` with a body saying why and the trailer
`Claude-Build: managed-agent w3-misc-replay-ceiling build` (checked with
`git log --format='%h %(trailers:key=Claude-Build,valueonly)' c786f82..HEAD`: every line reads
`managed-agent w3-misc-replay-ceiling build`):

```
c6336f8 docs: the build report shows the apply check and the commit trailers
d16edf7 e2e, runtime: scenario 9 replays the plan envelope; the ceiling tests pin haiku and the per-run read
cfa0237 e2e, runtime: take back the earlier attempt's tests to re-land them under this build's trailer
79d6eba docs: build report for w3-misc-replay-ceiling
ceefcd2 runtime: the ceiling test types the project settings as JsonObject
8e8645b docs: requirements, blockers and progress record the replay and ceiling item
ae53f03 docs: the replay and ceiling Known issues are closed; maintainer docs name the tests
```

The earlier attempt's two commits (14594ad, c786f82) sit below the starting commit and carry
another build's trailer (`github-actions build-item`). The branch history cannot be rewritten
(no rebase, the starting commit is on origin), so cfa0237 takes their test changes back and
d16edf7 re-applies them unchanged (plus ceefcd2's typing fix): the scenario 9 replay case and
the ceiling tests now enter the repository through a commit carrying this build's trailer. The
tree after d16edf7 is byte-identical to the tree after 79d6eba (`git diff 79d6eba d16edf7`
prints nothing); after it, `executor-ceiling.test.ts` + `remote-wiring.test.ts` 2 files, 11
tests passed, scenario 9 1 file, 2 tests passed.

### Patch export and apply check

```
$ git format-patch --stdout $(cat /tmp/start-sha)..HEAD > /tmp/pre.patch    # start-sha = c786f82
$ git worktree add --detach /tmp/clean c786f82 && cd /tmp/clean
$ git rev-parse --short HEAD
c786f82
$ git apply --check /tmp/pre.patch; echo "git apply --check exit=$?"
git apply --check exit=0
$ grep -c '^From [0-9a-f]\{40\}' /tmp/pre.patch
6
```

That run covered the series up to d16edf7. The final export
(`git format-patch --stdout c786f82..HEAD > /mnt/session/outputs/w3-misc-replay-ceiling.patch`,
7 commits with this report's commit) is checked the same way after this commit; its output is
appended to the copy of this report in `/mnt/session/outputs/w3-misc-replay-ceiling-report.md`.

### Left open

- The watcher's lookup is per row, not a lock: two daemons of one human picking two copies at
  the same instant could both act. Already listed in runtime.md's Known issues; a store-level
  claim on (device, clientId) would close it and is a state schema decision, outside this item.
- The idempotency record lives a week in the service's `idempotency.json`, per instance; the
  watcher's 30-day audit lookup is the second line for older copies and other instances.
- V.3 and V.4 stay open for reasons outside this item (three runs per OS and the Android run;
  the P1 and the stale doc entries).
- Independent review of this item is pending.

## Review

Independent adversarial review, stage REVIEW AND FIX, 2026-10-23. Reviewed: the branch
`wave/w3-misc-replay-ceiling` at c6336f8 (`git diff origin/ccr-4d8a843c-1k9syk...HEAD`: tests
and docs only; the dedupe and the ceiling read already existed in the code the branch is based
on, merge base 82a6295), traced from the real callers (`composeRuntime`, the cloud runner's
`startCloudRunner`, the e2e worlds, `POST /remote/commands`, `RemoteCommandWatcher.run`).

Verdict: **revise**. Score: **62/100**.

Requirements checked:

- R.4 / V.3, scenario 9's `it.todo`: replaced by a passing case (route answers 200 with the
  first row, no second row; a copy past the service is the watcher's `duplicate`; one change
  log row, one start). Met, but the case is not self-contained (finding 3).
- Route dedupe (`services/state-api/src/routes/remote.ts` `enqueueRemoteCommandOnce`): the
  second POST returns the first row's id and status, no second row; concurrent copies are
  serialised by `IdempotencyStore.run`'s in-flight map; covered by
  `services/state-api/test/remote.test.ts`. Met.
- Watcher dedupe (`packages/runtime/src/remote/watcher.ts` `replayOf`): memory then audit rows
  (oldest first, so the first handler's id is found). Met.
- H.4 / D.3, "the executor reads the project's critic_ceiling per run": met for the daemon
  (`compose.ts` passes `projectCeiling`), NOT met for the cloud runner, whose executor is
  built without the reader (finding 1).
- V.4, Known issues rows closed in testing.md: closed, but the ceiling entry's claim is false
  for the cloud runner (finding 2).
- Maintainer docs, status rows: runtime.md, state-service.md, testing.md, requirements.md,
  BLOCKERS.md, PROGRESS.md updated; the BLOCKERS edit conflicts with the base (finding 4); the
  build report names commits that are not on the branch (finding 5).
- Security / privacy: nothing new; the scenario still asserts no key or token in any row.

### Findings

1. **medium**, `services/cloud-runner/src/runner.ts:466` (`makeLoop`), root in
   `packages/runtime/src/session/executor.ts:348`. The cloud runner builds its
   `LoopTaskExecutor` without `projectCeiling` (and without `ceiling`), so a task on its third
   attempt that a cloud session picks up climbs to opus even when the project's
   `critic_ceiling` is sonnet: exactly the case `executor-ceiling.test.ts` itself labels "what
   the daemon must not do". The executor only honours the project's ceiling when every
   composition remembers to pass the reader; the e2e worlds
   (`tests/e2e/src/scenario-world.ts`, `world.ts`, `scenario-handover.ts`,
   `scenario-capabilities.ts`) do not either. Verified with a throwaway test in
   `services/cloud-runner/test/runner.test.ts` (project settings `{ critic_ceiling: "sonnet" }`,
   a ready task at `attempt: 3`, `startSession({ force: true })`): the coder's run row read
   `fake-opus`. Test deleted afterwards.
2. **low**, `docs/maintainers/testing.md:1274` (the "Closed" ceiling entry) and
   `docs/maintainers/runtime.md:1472`. The entry says "a run above the ceiling cannot happen",
   and runtime.md calls the static `ceiling` "only the fallback"; with finding 1 both are false
   for the cloud runner's sessions. Verified by the same throwaway test.
3. **low**, `tests/e2e/scenarios/09-phone.scenario.test.ts:455` (the replay case). The case
   asserts, rather than establishes, its precondition (the sample project active, which only
   the first case's undo produces), so it cannot run alone: `pnpm exec vitest run --project
   e2e tests/e2e/scenarios/09-phone.scenario.test.ts -t replays` fails with `expected null to
   be '<sample project id>'`. A test whose result depends on another case's side effects
   proves less than its name claims.
4. **low**, `docs/status/BLOCKERS.md:60` (V.4 row). The base branch rewrote the same V.4 row
   after this branch forked (item w4-stale-docs), so integrating the branch conflicts:
   `git merge-tree --write-tree origin/ccr-4d8a843c-1k9syk HEAD` reports
   `CONFLICT (content): Merge conflict in docs/status/BLOCKERS.md`. The V.3 row (unchanged on
   the base) can carry the same note.
5. **low**, `docs/status/reviews/w3-misc-replay-ceiling.md` (Build report). The report names
   commits that are not on the branch (5d2270e, b57f8cb, 604918f, 478d320, 528d230, 8a61e40)
   and a base at e2bfb1e; `git merge-base --is-ancestor <sha> HEAD` fails for each, the real
   series is ae53f03..c6336f8 on merge base 82a6295. The evidence trail does not match the
   repository.
