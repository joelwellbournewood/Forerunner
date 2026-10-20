# 0041 — PC remote commands: the owner filter in the store, the daemon's watcher, the desktop presence row

Date: 2026-10-20
Status: accepted

## Context

ADR 0032 item 4 made the phone send ONE remote command with `target: "pc"` carrying a plan
of module-Q commands (or a quick chat), and ADR 0033 items 8b and 9 recorded three follow-ups
the cloud runner left to `packages/state` and `packages/runtime`: `RemoteCommandRepo.pickUp`
was keyed on the target only, so on a shared state another human's phone could hand a runner
a command it then had to refuse; the PC daemon had no consumer for `target: "pc"` rows, so a
plan from the phone stayed `pending` against the real stack (only the UI's fake state service
simulated a PC); and the daemon did not heartbeat a `desktop` device row, so the runner's
PC-wins rule saw a working PC only through an active session. The gate harness review also
found that `composeRuntime` built `LoopTaskExecutor` without a ceiling, so the retry ladder
escalated under the default ceiling (opus) whatever the project's `critic_ceiling` said.

The spec leaves open where the owner filter lives and whether it hides a revoked device; how
the daemon reaches the shared state for these rows; what the phone's tap on its own change
card is worth once the PC re-plans the request on the real state; how an answer given in the
inbox reaches the executor's in-memory pending card (ADR 0030 item 3); which device the plan
runs as on the PC; when the watcher runs at all; how the daemon's device row is identified
across restarts; and what `pause` means on a PC.

## Decision

1. **The owner filter is SQL in `pickUp`, keyed on the runner's agent.** `pickUp(target, {
   deviceId?, ownerHumanId?, agentId?, now? })`: `ownerHumanId` adds `device_id IN (SELECT id
   FROM device WHERE owner_human_id = ?)`, `agentId` resolves the owner through `agent` in the
   same subquery, both on SQLite and Postgres, no migration (the subquery hits the device
   primary key; `remote_command` keeps its `(status, target, created_at)` index). Another
   human's row is never taken: it stays `pending` for that human's own runner instead of
   ending `failed` on the wrong one. A **revoked** device of the owner is still handed over, so
   the runner refuses it visibly (`failed`, `forbidden: revoked device`, audit row) rather than
   leaving the row pending for ever. The runner-side `authorize` stays as the second line.
2. **The daemon polls the store, not the service.** The daemon talks to the shared Postgres
   directly (ADR 0024), so `RemoteCommandWatcher` (`packages/runtime/src/remote/watcher.ts`)
   calls `store.remoteCommand.pickUp("pc", { deviceId: <its desktop row>, agentId })` every
   `FORERUNNER_REMOTE_POLL_MS` (500 ms), as the cloud runner does for `cloud`. The state
   service's `GET /remote/commands/pending` keeps its shape for runtimes that go through the
   service; it passes no owner (admin callers hold every scope).
3. **A plan runs through the command registry as the PC.** The watcher composes the plan's
   steps with `CommandLoop.compose` in a `CommandTurn` whose `source` is `phone` and whose
   `deviceId` is the daemon's own desktop row: the registry's `session.start` and
   `session.stop` therefore call the runtime ports instead of enqueueing another remote command
   (the phone's device id would route them back into this queue). The executor's policy
   decides (ADR 0030): a low-risk plan acts at once; a medium card is answered by the tap the
   phone recorded (`confirmedAt`, a `tap` by the human, as the settings screen's `confirm:
   "tap"`); a high-risk card stays a `human_request` with `decision: needs_device` and nothing
   changes. A `refused` or `cancelled` plan fails the row with the reason; a pending card
   completes the row with `status: "pending"`, the `pendingId`, the decision and the readback,
   so the phone's change log shows the PC handled it and the inbox shows the card to confirm
   with the biometric. A plan that contains `session.start` lifts a kill freeze first (the
   human asked for work explicitly, as the runner's `start` does).
4. **Inbox answers reach the pending card on the next drain.** The phone answers the card's
   `human_request` through the state service, which is the enforcement point for the device
   signature and, on a high-risk card, the biometric (`confirm:high`); the daemon's own
   `/requests/:id/answer` answers it for the human at the PC. Neither reaches the executor's
   closure, so `syncAnswered` reads the rows behind `commands.pending(human)`: an approval
   (the first option, a yes, `true`, or an object saying so) confirms a `needs_yes` card as a
   tap and a `needs_device` card as a device confirmation naming the daemon's desktop row
   (a non-revoked device of the same human, which the policy accepts without biometric; the
   authenticity of the answer is the service's or the daemon's bearer token); a rejection
   cancels it; a row answered by another human is ignored; rows the executor answered itself
   (they carry its `verdict`) are left alone. The executor re-resolves the risk before running
   (ADR 0030 item 3), so a card whose risk rose is refused and the human asks again.
5. **Plain verbs.** `kill` stops every run and freezes new work (`scope: "all"`, or a scope of
   this agent or one session); `stop` ends the agent's runs and lifts the freeze; `start` lifts
   the freeze and asks the scheduler (`trigger: "remote"`, the budget from the params); `pause`
   runs the registry's `session.pause` (the store status, as the settings screen does; the
   runner has no pause port yet). The registry's own remote rows (`session.start`,
   `session.stop`, `session.pause` with their parameter shapes) are handled by the same verbs.
   A `start` or scope naming another agent is refused. Every row ends `done` or `failed` with
   a result the phone reads back and one `audit_log` row (`daemon.remote_command`) that names
   the command, the device and the plan's command names, never the parameters.
6. **One `desktop` device row per install, heartbeated.** `registerDesktopDevice` keeps the
   row's public key (a random identifier; the daemon never authenticates with it) in
   `<config>/desktop-device.json`, reuses the row under that key (same human, not revoked),
   else a non-revoked row of the human with the same name (`FORERUNNER_DEVICE_NAME`, default
   the host name), else registers a fresh one. `DesktopPresence` stamps `last_seen` at start
   and every `FORERUNNER_PRESENCE_HEARTBEAT_MS` (60 s; the runner's window is 3 min by
   default), so the runner's `PcPresence` sees a working PC while the daemon runs and a crashed
   daemon looks offline after the window.
7. **On exactly when the state is shared.** `remoteCommandsEnabled(env, stateUrl, services,
   override)`: never without the background services (CLI one-shots, the cloud runner's
   composition); then `ComposeOptions.remote.enabled` (tests), then `FORERUNNER_REMOTE_COMMANDS`
   (`1`/`0`), else on for every state URL that is not `sqlite:` (a phone reaches the daemon
   only through the state service over a shared Postgres). Both the watcher and the heartbeat
   stop with `close()`.
8. **The executor reads the project's ceiling per run.** `LoopTaskExecutorDeps.projectCeiling`
   maps the task's project settings to a tier; the daemon passes
   `criticSettingsOf(settings).ceiling` (`critic_ceiling`, the same key the critic uses), so
   `tierForAttempt` escalates the third retry under the project's cap and a project capped at
   sonnet never runs opus. The static `ceiling` stays as the fallback.

## Consequences

- A command of another human can no longer be misrouted to this human's runner or PC; the
  cloud runner should pass `ownerHumanId` (or `agentId`) to `pickUp` too, which is a one-line
  change in `services/cloud-runner/src/remote.ts` outside this change.
- The phase-5 phone flow ("switch project, raise a budget, start a session on his PC") now
  has a consumer on the real stack; the fake state service's simulated PC stays for the UI
  specs. The gate row is recorded separately.
- A pending high-risk card from the phone is two rows the human sees: the remote command
  (`done`, result `pending`) and the inbox request; a daemon restart drops the executor's
  closure (ADR 0030 item 3), so the request expires and the human asks again.
- The watcher runs plans with the PC as the context device, so the change log row's device is
  the PC; the remote command row and the audit row keep the phone's device id.
- `pause` from the phone changes the session row's status only, as from the settings screen;
  a running in-process session keeps going until a pause port exists (known issue).

## Alternatives considered

- **A `human_id` column on `remote_command`** (ADR 0033): a denormalised copy the service and
  every enqueuer would have to fill; the subquery on the device's owner is one PK lookup per
  candidate row and needs no migration.
- **Filtering revoked devices in SQL**: the row would stay pending with no visible failure.
- **Keeping the remote row `picked_up` until the card is answered**: the mapping from card to
  row would live in memory and a restart would strand the row; the request row is the durable
  record of the open card, and the phone already shows requests.
- **Passing the phone's device id as the context device**: `session.start` would enqueue
  another remote command for the PC that the same watcher picks up, a loop with a change log
  row per hop.
- **Passing the phone's tap as the confirmation up front**: the executor refuses an answer that
  is not enough for the decision instead of filing the card, so a high-risk plan would end
  `refused` with no inbox request; composing first and confirming a `needs_yes` card with the
  tap files the request for high risk exactly as ADR 0032 expects.
- **Starting the watcher on every daemon, local SQLite included**: nothing can enqueue a row
  there; a device row and a 500 ms poll for nobody.
