## title

Known issues closed: a replayed phone plan envelope runs once; the executor's attempt rung reads the project's critic ceiling

## requirements

R.4, V.3 (scenario 9 todo), H.4 (critic ceiling), V.4 (known issues)

## adr

none

## brief

Two open Known issues from docs/maintainers/testing.md 'Scenarios' and the gates: (1) tests/e2e/scenarios/09-phone.scenario.test.ts line 452, it.todo: 'a plan envelope the outbox replays (same device and clientId) runs once' (a replayed envelope, same device and clientId, is not deduped by the route or the watcher; the 'phone command replay dedupe' was mentioned as landed in a later wave: check whether the state service's POST /remote/commands or the daemon's RemoteCommandWatcher already dedupes by (device, clientId); if yes, replace the it.todo with the passing test; if not, build the dedupe at the route (the second POST returns the first command's id and status, no second row) and at the watcher (defence in depth), then the test). (2) testing.md Known issues: 'The task executor's own rung for the third attempt (tierForAttempt) uses the executor's ceiling dependency, which the daemon composition does not set from the project's critic_ceiling; the critic's follow-up hands a task at the ceiling to the human before that attempt runs, which is why the harness never sees a run above the ceiling, but the executor should read the project row too (runtime package).' Build: the executor reads the project's critic_ceiling per run (compose.ts no longer passes a static ceiling, or passes a reader), with a test that a project ceiling of 1 keeps the third attempt at tier 1. Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read tests/e2e/scenarios/09-phone.scenario.test.ts (the todo and the surrounding world helpers), services/state-api/src/routes (remote commands POST, the envelope with clientId), packages/runtime/src/remote (RemoteCommandWatcher), the state repo for remote commands (a unique index on device_id + client_id is the clean dedupe: a migration in packages/state with pnpm docs:schema), packages/runtime/src/session/executor (tierForAttempt, ceiling) and compose.ts. Tests: the scenario test (run with pnpm exec vitest run --project e2e tests/e2e/scenarios/09-phone.scenario.test.ts), services/state-api/test/routes.test.ts for the route dedupe, packages/runtime/test/executor.test.ts for the ceiling. Docs: testing.md (Known issues rows closed), state-service.md, runtime.md, data-model.md (generated) + migrations.md if a migration is added.

## paths

tests/e2e/scenarios/09-phone.scenario.test.ts, services/state-api/src/routes, packages/runtime/src/remote, packages/runtime/src/session/executor.ts, packages/runtime/src/daemon/compose.ts, tests
