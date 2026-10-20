# 0029 — Daemon wiring of the phase 6 and 7 modules

Date: 2026-10-20
Status: accepted

## Context

The extensions registry, the signed updater, the model watch, the estimate model, the GitHub
Projects mirror and the sandbox adapters were built as modules with ports. The product has to
work through one process: the daemon the shells attach to (ADR 0026) and the `fr` command line.
Four points were left open by the modules' own docs and had to be decided while wiring them:

1. how "Update and restart" ends the daemon without spawning a shell;
2. where the model watch's eval runner comes from, given that `@forerunner/evals` depends on
   `@forerunner/runtime` and the daemon lives in the runtime package;
3. how a bridged tool call's cost reaches the extension row, and what `ledgerCost` queries;
4. how the executor reaches a sandbox without the session layer depending on the daemon.

## Decision

1. **Restart contract.** `DaemonRestarter` (`src/daemon/restart.ts`) writes
   `<runtime>/restart.json` (`schema`, `reason`, `targetVersion`, `fromVersion`,
   `requestedAt`, `pid`, `exitCode`), emits `restart` on the runtime's event emitter and ends
   the process with exit code **86** (`RESTART_EXIT_CODE`). `fr daemon` stops the HTTP server
   and closes the store before exiting, under a deadline (`EXIT_DEADLINE_MS`, 8 s): the
   shells hold `GET /events` open for as long as they run, so `RunningDaemon.stop()` ends the
   open SSE streams itself, sweeps idle keep-alive sockets while the server closes and closes
   the remaining connections after `STOP_TIMEOUT_MS` (3 s); the process exits with the code
   even if a step hangs. `/events` carries `restart.requested` first. Whatever supervises the
   daemon (desktop sidecar, Android service, a wrapper script) relaunches into the version
   `current.json` names on exit code 86 and removes the request file; every other exit code
   is a crash. The daemon never spawns a shell or a successor process. The `exit` function is
   injectable so tests record the code. The health check of the new build runs in `fr daemon` once the server
   listens (`updates.healthCheck()`), not in `composeRuntime`, because the probe reaches the
   daemon through `daemon.json`.

2. **Eval runner.** The runtime gets its own `LoopEvalRunner` (`src/models/eval-runner.ts`)
   that reads the registry's eval task files with a tolerant schema, runs each task through
   the loop driver on the composed provider with a token of its own (depth 0, the task's
   budget, only the work directory allowed, only the loop driver's equivalents of the
   specialist's `allowed_tools`, `compression: "off"`) and grades the mechanical checks;
   rubric checks count as "needs model". An eval never executes anything on the host: the
   runner takes the daemon's `RunSandboxPort`, opens one lease per task over the work
   directory (no egress, the brief's risk tier) and runs both the model's `run_command` and
   the grader's `command_exit0` checks inside it; without a port `run_command` is not offered
   and command checks are errors. `@forerunner/evals` stays the authoritative
   schema and grader (and the critic's calibration); `ComposeOptions.evalRunner` lets a
   composition that has it inject the evals-backed runner. A model without a price in the
   effective table throws before any call, so the watch records it as skipped rather than
   costing a run by guessing.

3. **Extension cost.** `DaemonHooks` (in `compose.ts`, not in `hooks.ts`) extends
   `GatedEnforcementHooks` and, after a bridged tool call, books `result.costUsdMicro` on the
   extension row through `registry.recordCost`. `ledgerCost` sums the cost ledger's
   `specialist` bucket named `extension:<id>`: a capability module that charges through the
   ledger names its extension that way. No new ledger column.

4. **Sandbox port.** `LoopTaskExecutor` takes a `RunSandboxPort` (`src/session/executor.ts`)
   and a `toolsFor()` factory. With a worktree and a port it opens one lease per run,
   replaces `run_command` with one that executes inside the lease (argv arrays, the sandbox's
   own timeout and output caps) and destroys the sandbox afterwards. A lease the port refuses
   (a tier 2+ task with no engine) closes the Run row as `error` before the error reaches the
   runner, so no run stays `running`. The daemon's port
   (`src/daemon/sandbox-port.ts`) is `createSandbox` with only the worktree mounted and the
   run token's `allowedDomains` as the egress allowlist; detection is probed once at compose
   and `/health` reports `sandbox: { kind, available, engine, reason }`.

5. **Manual mirror sync never blocks on the human.** The daemon's mirror approval port
   (`DaemonMirrorApprovals` in `compose.ts`) files the request like `HumanRequestMirrorPort`
   but reports which request a project waits on, reuses an open one and wakes on an inbox
   answer. `RuntimeApp.mirrorSync()` races the run against that signal, so
   `POST /projects/:id/mirror/sync` answers 202 `{ pending, projectId, requestId }` as soon as
   the mirror asks; the run finishes in the background after the answer and `project.changed`
   follows. A short port timeout was rejected: it would withdraw the request the human is
   about to answer.

Also fixed in passing: `composeUpdateManager` takes the daemon's open `store` so one process
holds one connection; `StaticPlanner` takes an `EstimatePort`; `SessionRunner` reports
`onTaskFinished` so actual cost and wall time feed the estimate model; session runs on the
fake provider are priced per token (they used to fail on an unpriced model id).

## Consequences

- One composition root for the daemon, the CLI and the tests (`composeRuntime`); the CLI's
  `models` and `mirror` commands compose the runtime and close it after the action, `update`
  composes only the update manager.
- The shells have a precise contract to implement (exit code 86 plus `restart.json`); until
  they do, `fr update apply` stages and asks the user to restart.
- Evals run by the daemon cover the mechanical checks only; rubric-graded tasks do not count
  towards a recommendation's pass rate until the critic grades them.
- Revocation of a bridged tool shows in a run's registry at the next run start; runs in flight
  are refused by the gate on their next tool call.

## Alternatives considered

- Spawning the next daemon from the current one: rejected, the daemon never spawns shells and
  would hold the SQLite file open across the handover.
- Importing `@forerunner/evals` from the runtime: a package cycle; rejected.
- An extension column on the cost ledger: a schema change for a value the extension row
  already counts; rejected for now.
- Mounting the sandbox in the daemon's tools (`run_command` on the host when no engine):
  rejected, the executor would not know which runs were sandboxed.
