# 0032 — Remote commands from the phone to the PC daemon: envelopes, consumer, confirmations

Date: 2026-10-20
Status: accepted

## Context

Spec R.4 says the phone starts, pauses and stops sessions on the PC through the state service,
"and the PC or runner picks them up in seconds"; scenario 9 has the human say "switch to the
game, give it 15 francs until tomorrow and start a session on my PC" into the Android app, get
one change card, confirm, and watch the PC start. ADR 0024 gave the service the
`remote_command` rows and the pick-up route, ADR 0030 the command registry (item 7: from a
phone, `session.start` and `session.stop` become remote commands), ADR 0033 the cloud runner's
consumer for `target: "cloud"` and its owner check, ADR 0034 quick chat and the kill switch
from the approvals web as `chat` and `kill` remote commands. Nothing consumed `target: "pc"`:
the daemon had no watcher, the command registry was not wired into it, and the phone's plan
could only be simulated by a fake service's "PC".

Open points: what a phone puts into `params` so the PC can run a whole plan with one
confirmation; whether the daemon reads the shared store directly (as the runner does) or the
service's routes; how a plan the phone already confirmed is confirmed again on the PC without
trusting the phone's card; how a high-risk step reaches the paired device's biometric
confirmation when the command executor's pending change lives in the daemon's memory; what
`undoOf` means; and which PC takes a command when a human has several.

## Decision

1. **Two envelopes, version 1, plus the bare verbs.** `params` is either a plan,
   `{ v: 1, kind: "plan", plan: [{ name, params }, ...], wordsUsed, card?, clientId?, confirmedAt?,
   undoOf?, source? }`, whose steps are registry commands (`project.switch`, `budget.set`,
   `session.start`, `session.stop`, `note.add`, ...), or a quick-chat turn,
   `{ v: 1, kind: "chat", text, projectId?, clientId? }`. Anything else is a bare verb with the
   cloud runner's parameter shapes (`kill`, `stop`, `start`), the rows ADR 0030 item 7 enqueues
   (`session.start`, `session.stop`) or ADR 0034's `chat { text, projectId }`; the service's
   verb enum gains `chat`. A `v` the daemon does not know is refused, never read as a bare verb.
   The schemas are `packages/runtime/src/daemon/remote-envelope.ts`.
2. **The daemon consumes through the service, not the store.** `RemoteCommandWatcher`
   (`src/daemon/remote-watcher.ts`) polls `GET /remote/commands/pending?target=pc` with the
   runtime's admin token (`FORERUNNER_STATE_API_URL`, token from
   `FORERUNNER_STATE_API_ADMIN_TOKEN` or the vault secret `state_api_admin_token`) every
   `FORERUNNER_REMOTE_POLL_MS` (500 ms), and reports `complete` / `fail` the same way, so the
   pick-up and the result are announced on the phone's realtime stream. Without a configured
   service the watcher is off and the daemon says so once at compose; the phone cannot reach a
   PC without the service anyway. The daemon's own store is the same shared Postgres (ADR 0024),
   which is where it reads devices, requests and projects.
3. **Only the PC's human, as ADR 0033 item 8b.** The issuing device must exist, belong to the
   daemon's human and not be revoked; a command addressed to another device, and a `start`
   naming another agent, are refused. Refusals are `failed` with `forbidden: ...` and an audit
   row (`daemon.remote_command`), like every handled command.
4. **The card is never trusted; the registry decides again.** A plan runs through the same
   `CommandExecutor` the daemon now composes for the settings screen and the conversation agent
   (`defaultRegistry()`, persisted, with the daemon's live ports: scheduler start, kill switch,
   CHF rate). The watcher plans the composed card on the real state, asks the confirmation policy
   for the real risk and acts on that: low runs; medium takes the phone's `confirmedAt` as the
   human's tap (the device's signature on the enqueue is what makes it theirs) and otherwise
   files the executor's `needs_yes` request; high always files the executor's `needs_device`
   request. A waiting command stays `picked_up` until the request is answered, expires (the
   executor's ten minutes) or is withdrawn; then it completes or fails with the reason.
5. **The device answer travels through the request row.** The service, when a device answers a
   request that is a command confirmation (an approval whose card carries the executor's
   `decision`), stores `{ choice, kind: "device", by, device_id, biometric }`, the shape the
   executor writes for its own answers, and still demands the signed biometric flag for high
   risk (spec R.7). The daemon reads the row, hands the device and flag to
   `executor.confirmFromDevice`, and the policy enforces "a phone needs biometric" in code; a
   raw `yes` from the daemon's own answer route is enough for medium risk only. A refused answer
   (no biometric, revoked device, a risk that rose) fails the command and closes the pending
   entry so the human asks again with a fresh card.
6. **The plan runs as the PC, on the phone's behalf.** The command context carries no phone
   `deviceId` (that would make `session.start` enqueue another remote command) but a new
   `remoteDeviceId`, so the session the PC starts records the phone as its device with trigger
   `remote`. The scheduler's start is tracked: `session.started` now carries the session id and
   the daemon resolves `startSession` with it as soon as the runner recorded the row, so the
   command's result names the session the phone can watch.
7. **`undoOf` is the one-click undo.** A plan with `undoOf` runs `executor.undo` on that
   change-log row (the registry's own inverse of every logged step, for the human the change
   was made for) and ignores the plan array; the result names the new `undo` row and echoes
   `undoOf`.
8. **Results.** A plan completes with `{ executed, changeLogId, undoOf, undoToken, sentence,
   status, sessionId?, confirmedBy? }`, chat with `{ reply, actions, transcriptId, ... }`, the
   verbs with the cloud runner's shapes; every result carries `durationMs`; a failure's result
   is `{ error, code }`. `pause` and a plan step `session.pause` fail with `not_supported`
   until the runtime can pause a session (today only a plan awaiting approval pauses one).
9. **Which PC.** The watcher passes its device id to the pending route when the daemon has one;
   until the daemon registers a `desktop` device (BLOCKERS.md) it takes commands addressed to no
   device in particular and refuses, visibly, one addressed to a specific device.

## Consequences

- Scenario 9 runs against the real stack: the service on Postgres, the daemon on the same
  schema, a paired phone signing its requests (`services/state-api/test/pc-remote.integration.test.ts`).
  The Android app's own state client is not in this repository yet; the test's `PhoneClient` is
  the signed stand-in and defines the shapes it must speak.
- The command registry is now part of the daemon's composition, which `docs/maintainers/commands.md`
  asked for; `packages/runtime` depends on `@forerunner/commands` while `@forerunner/commands`
  keeps its type imports from the runtime, the same shape of workspace cycle that already
  exists between the runtime and the capabilities package.
- Realtime for the daemon is polling at 500 ms; a `remote_command.changed` subscription would
  cut the latency further but adds a long-lived connection and was not needed for the gate.
- Quick chat from the phone goes through the conversation agent with its usual tools and
  read-back confirmations; the result reports a pending confirmation the human answers with the
  next chat turn. ADR 0034's wish for a read-only answer from the web path is not implemented.

## Alternatives considered

- **Reading `remote_command` rows straight from Postgres**, as the cloud runner does: the phone
  would then learn of the pick-up only through the service's 2 s change poller, and the owner
  check would stay a second line behind nothing.
- **Trusting `confirmedAt` for high risk too.** Rejected: the biometric step must be a device
  signature the service verified, never a field a client fills in.
- **Running the plan with the phone's `deviceId` in the context.** The registry would enqueue
  `session.start` as yet another remote command for the PC, forever.
- **A new column for the answering device on `human_request`.** A migration for one field that
  only command confirmations need; the executor already records `device_id` and `biometric`
  inside `answer`, so the service writes the same shape.
- **Serialising the pending change into the request so a restart can finish it.** ADR 0030
  deferred it; the watcher fails the command instead and the human asks again.
