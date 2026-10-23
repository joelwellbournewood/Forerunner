## title

The inbox is re-checked before the session-end writes

## requirements

E.4

## adr

none

## brief

BLOCKERS.md row E.4 inbox re-check before the session-end writes: **partly built** (requirements close-out 2026-10-20): the inbox is re-checked at the top of every task iteration, so a message that lands during a task is delivered and read before the next task is claimed (`packages/runtime/test/closeout-sessions.test.ts`, `packages/runtime/test/session.test.ts`); step 4 of `packages/runtime/src/session/runner.ts` (task states, project `summary_cache`, handoff messages to peers, the note to the human) runs with no re-check, so a stop that lands during the last task is not read before those writes. Needed: a `recheckInbox` before the session-end writes in runner.ts step 4, asserted with a `requires_ack` stop sent during the last task (read before the handoff and the summary cache are written, `read_at` set on the message); then E.4 `done`. Spec E.4: 'Inbox re-checked between every task and before any write to shared state.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read packages/runtime/src/session/runner.ts (recheckInbox, step 4, the stop/pause message handling of O.9 remote-pause) and the tests named. Build: call recheckInbox before the step-4 writes; a stop read there ends the session as stopped with a handoff that says what was and was not written (the stop reason named), a pause defers nothing at the end (the session is ending anyway) but is acknowledged, an ordinary message is delivered and read (read_at) and summarised in the handoff; the writes themselves stay one transaction where they are today. Tests in closeout-sessions.test.ts or session.test.ts: a requires_ack stop sent during the last task is read before the handoff and the summary cache are written (read_at set, handoff names it, task states consistent); a message during the last task appears in the handoff. Docs: runtime.md (sessions).

## paths

packages/runtime/src/session/runner.ts, tests
