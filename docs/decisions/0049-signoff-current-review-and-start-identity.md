# 0049 — Sign-off answers apply to the task's current review and close along the graph; the undo of a `session.start` is tied to the start's identity

Date: 2026-10-20
Status: accepted

## Context

The phase 5 gate harness (ADR 0045) pinned two runtime findings about the critic's sign-off
and the undo of `session.start`: an accepted tier 3 sign-off was applied to nothing
(RT-P5-1), and the undo of a `session.start` whose session had ended froze the kill switch
until Resume (RT-P5-2). The first fixes closed the gate's assertions but the critic's review
of them found two gaps. The sign-off sync applied an answered `critic:signoff` request
whenever its task was `needs_human`, without asking whether the request was the task's
current sign-off, and resolved every open finding of the task: a request left open while the
task was reviewed again (the human moves it on from the UI, the next session reviews it and
files a new sign-off) could close the task and resolve the later review's findings. The undo
was keyed by agent: the port remembered the last start it made per agent and answered
"running" whenever the scheduler's active start was that entry, so the undo of an earlier
start whose session had ended, made while a later start of the same agent ran, stopped the
later session and marked the earlier row undone.

Facts the fix has to live with: the scheduler starts the runner in the background, so
`session.start` never knows the session id when it writes its change log row; the scheduler
runs one session per agent and keeps the newest waiting request, and a queued request keeps
its identity when the queue drains; the task workflow (`packages/state/src/workflow.ts`) has
no `needs_human -> done` edge, its only exits being `ready` and `cancelled`; the store
refuses to close a task while any finding of it is open (`findings_open`, spec B.4); and the
critic resolves the findings of earlier reviews only on its own accept, so the retry
ladder's last rung (three revises, then the human) leaves every rung's findings open.

## Decision

1. **A start has an identity: the scheduler's log entry id.** `Scheduler.requestStart`
   answers with its entry; the entry's `id` names the start from the request through the
   queue (queued or deferred, then started when the queue drains, under the same id) to its
   end, and `Scheduler.activeStart(agentId)` and `pendingStart(agentId)` answer with the
   entry that carries it. `sessionCommandPorts().startSession` returns it as `startId`
   (`SessionStartOutcome`), `session.start` writes it into its change log row
   (`after.start_id`), and the undo passes it back in the kill scope (`KillScope.startId` in
   `@forerunner/commands`). The runtime's kill switch never sees it: the port strips it
   before `KillSwitch.stop`.
2. **The undo acts on that start and no other.** `startUndoState(agentId, startId)` is
   `pending` when the agent's waiting request carries the id (the undo drops it,
   `Scheduler.cancelPending`), `running` when the active start carries it (the undo stops
   the session that start began as `{ agentId, sessionId }`: the agent's active row of this
   install's runner kind with the start's trigger, begun at or after the start; never the
   agent's scope, so the kill switch holds nothing else), and `ended` otherwise, including
   for a row that names no start. A later start of the agent, by hand, from the phone or by
   schedule, is never the one undone.
3. **A start made from a phone has the same identity, recorded by the PC that runs it.**
   `session.start` with a phone's or web client's device id (the daemon's
   `POST /commands/execute` with `deviceId`, the state service's `session.start` rows) is a
   remote row, not a port call, so the change log row carries `after.remote_command_id` and
   `after.start_id: null`. The PC's `RemoteCommandWatcher` runs the row through the same
   scheduler (`start` is `Scheduler.requestStart`, `RemoteStartEntry`) and writes the
   entry's id into the row's result (`{ kind: "start", result, startId }`). The undo reads it
   there: `session.start`'s undo passes the result's `startId` in the kill scope, and
   `CommandLoop.undo` classes the row by the remote command's state: `pending` is left to
   the executor (which fails the row, as before); `picked_up` (the PC has taken it and not
   recorded its result yet) is refused as in flight (`SESSION_START_IN_FLIGHT_REASON`, code
   `unavailable`) and the row stays undoable; `done` is `startUndoState(agentId, startId)`
   with the recorded id, a result without one (a runner that records none: the cloud
   runner's watcher) being refused as `SESSION_START_UNKNOWN_REASON`, since its session
   cannot be found from here and nothing is stopped by guesswork; `failed` never ran
   (`SESSION_START_NOT_RUN_REASON`).
4. **The undo of an ended start is refused, not performed.** `CommandLoop.undo` asks the
   same `startUndoState` before the executor for a change that is one `session.start`
   without a session id and without a pending remote command: `ended` marks the row
   `irreversible` and answers `SESSION_START_ENDED_REASON` (or the remote row's reason
   above); no undo row is written. Inside a composed change (the phone's "switch, budget,
   start") the start part is the no-op and the rest is undone, so the row is `undone`.
5. **A sign-off answer applies only to the task's current sign-off.** `syncSignoffAnswers`
   skips an answered request as `stale` (recorded on its card, nothing touched, no audit row)
   when the card's `review_id` is not the task's latest review (`ReviewRepo.latestForTask`);
   a card without a review id is current while no review of the task is newer than the
   request. Every filing site (`CriticService.review`, `applyVerdict`, the loop's ladder
   branch) sets `review_id` through `signoffCard`.
6. **Accept resolves the findings up to the card's review, then closes along the graph.**
   The card's `finding_ids` and the task's other open findings whose review is the card's or
   an earlier one (`reviewedBefore`) are resolved against the card's run; a finding the walk
   cannot place (its review missing or newer than the card's) is left open and the store's
   `findings_open` refusal is recorded on the card as the outcome. The close walks the task
   graph's own edges inside one store transaction with the findings and the
   `critic.signoff` audit row, `ready -> claimed -> in_progress -> in_review -> done`, so
   every rule of the store holds and nothing observes the intermediate states.

## Consequences

- A change log row written before starts had an id matches nothing running: its undo is
  the no-op, refused as irreversible. A daemon restart forgets the scheduler's entries, so
  the undo of a start made before it is `ended` too, including a start whose session the
  restarted daemon does not run anyway.
- An undo that lands in the instant between the scheduler's start and the runner's insert
  of the session row stops nothing (a warning from `session-ports`) and the row is marked
  undone; the next scheduled session runs.
- The Changes screen shows an ended start as irreversible with the reason instead of an undo
  that changed nothing. A phone's start the PC is picking up at that instant is refused for
  the moment and stays undoable; the human taps again.
- A phone's start with `runner: cloud` is a remote row the cloud runner's own watcher
  (`services/cloud-runner`) runs; its result records no start id, so the undo of that row is
  refused as `SESSION_START_UNKNOWN_REASON` and marked irreversible: the PC's scheduler never
  knew that start, and the kill port stops nothing it cannot name. Giving the cloud runner's
  result an identity the PC can act on is a change of that service's remote watcher and of
  what a cloud session's stop from the PC means; not done here.
- A `RemoteCommandWatcher` whose `start` port answers the bare outcome (any caller other
  than `compose.ts` and the e2e PC helpers, which all pass `Scheduler.requestStart`) no
  longer compiles: `RemoteStartEntry` is the port's type.
- A stale sign-off request stays open in the inbox until answered; nothing withdraws it
  when the next review files a new one. A `findings_open` outcome consumes the answer and
  the task stays `needs_human`; the human moves it on from the UI.
- The sign-off request's `steps` list the card's findings; the earlier rungs' findings an
  accept also resolves are not shown in that request. Listing them is a change of the
  filing sites in `@forerunner/critic` and the loop's ladder branch.
- Tests: `packages/runtime/test/loop-commands.test.ts` (the start id on the port's answer and
  in the row; an ended start refused with nothing stopped while a later start of the agent
  runs, and that later start's undo stopping its session only, never a cloud session of the
  agent; a queued start that ran stopped under its own id; a scheduled session left alone;
  the composed plan; a phone's start as a remote row through the real `RemoteCommandWatcher`:
  the id recorded in the result, the running remote session stopped as that session only,
  an ended one refused, a picked-up row refused as in flight and still undoable, a done row
  without an id and a failed row refused as such, a pending row cancelled),
  `packages/runtime/test/remote-watcher.test.ts` (the plain `start`'s result carries the
  scheduler entry's id), `packages/runtime/test/signoff-answer.test.ts` (the card, accept,
  revise, cancel, the ladder's own sign-off, a moved-on task, a stale sign-off skipped with
  nothing resolved while the current review's accept closes the task, applied once, an
  answer behind a page of later answers, and a `findings_open` outcome when a later review's
  finding lands between the stale check and the close: the transaction rolled back, the
  card's own finding still open, no audit row, the answer consumed),
  `packages/runtime/test/approvals-poll.test.ts`, `packages/commands/test/registry.test.ts`
  (`after.start_id` and the kill scope), and the phase 5 harness
  (`tests/e2e/scenarios/phase5-gate.integration.test.ts`).

## Alternatives considered

- **Keying the undo by agent** (the first fix: the port's last start per agent against the
  scheduler's active start). Wrong as soon as a later start of the agent runs: the earlier
  row's undo stops the later session.
- **The session id in the change log row.** It is never known synchronously; waiting for
  the runner's insert would hold the command, and with it the chat turn or the phone's
  envelope, on the session's start. The start id is known the instant the request is made.
- **Marking the ended start's row `undone` with an undo row.** It writes a change that
  changed nothing and offers the human an undo that does nothing; the refusal with the
  reason tells them why there is nothing to undo.
- **Treating a phone's start the PC has run as `ended`** (the first fix: the remote row no
  longer pending, no start id, so `startUndoState(agentId, undefined)`). It marked the row
  irreversible with "already ended" while the remote-started session ran, and stopped
  nothing; before the start identity it had stopped the agent's whole scope. The id has to
  come from the PC that made the start.
- **Minting the start id in `session.start` and carrying it in the remote row's params** for
  the PC to pass to `Scheduler.requestStart`. It spares the undo a read of the result, but
  a device could then name an existing start's id on a raw remote `start` row and make the
  undo of that earlier row stop its new session; the scheduler minting the id and the
  watcher recording it keeps the identity on the side that runs the start.
- **Leaving a picked-up row to the executor.** The executor would kill `{ agentId }` without
  an id, stop nothing and mark the row undone an instant before the session starts; the
  refusal with "undo it again in a moment" keeps the row undoable for the next tap.
- **Resolving only the card's `finding_ids` and refusing the close otherwise.** The
  ladder's last rung files a card with the last review's findings while the earlier rungs'
  findings are still open (the critic resolves them only on its own accept), so every accept
  of a ladder-exhausted sign-off would be refused `findings_open` and the human stranded in
  `needs_human`. The stale check is what keeps a later review's findings out of reach; a
  current card's accept is the human's acceptance of the work as it stands, as the
  blocked-findings `accept` already is.
- **Resolving every open finding of the task** (the first fix). A stale card would resolve
  a later review's findings; with the stale check in place the two differ only for a
  finding whose review is missing or newer, which must block the close.
- **Checking that the request postdates the task's last entry into `needs_human`** instead
  of the review id. The card is about a review, and the review's identity does not depend
  on timestamps or on the task's history being replayed; the timestamp rule is kept as the
  fallback for a card without a review id.
- **A `needs_human -> done` edge in the workflow.** A `packages/state` change (`workflow.ts`,
  the generated data-model doc, the state suite) that would make the close one transition;
  the walk in one transaction gives the same guarantees today and the edge can replace it
  without changing the sync's contract.
