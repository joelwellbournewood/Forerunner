# 0052 — Always-human approvals: one answer admits one call, spent by the durable port as it is handed out; the row keyed on the raw canonical input

Date: 2026-10-23
Status: accepted

## Context

Spec S.6 names the actions that always need a human, at every autonomy level: deleting repos
or data, force-pushing, spending or sending money, sharing secrets, changing permissions,
granting a capability, entering passwords. The hooks (`packages/runtime/src/enforcement/
hooks.ts`) hold such a call until `ApprovalPort.request` answers "approved", and the security
review of 2026-10-20 fixed the in-memory half: an approval of an always-human class is taken
out of `ctx.approvals` as it is used, so the resume path re-makes the paused call once and the
next identical call asks again. The review of the fixes (2026-10-21) found the durable half
open: the daemon's and the cloud runner's port is `StateApprovals`, which answers from the
`human_request` row, and an answered row answered "approved" for every later identical request
of the session, so one "yes" to `delete_repo` admitted the same delete again in a later run.
The same review found the row's key computed from the card's copy of the input, where strings
are cut at 2000 characters for display, so two inputs that display alike (two script bodies
that differ after the cut) shared one row and one answer. Open points: where the consumption
is recorded, when it is recorded (as the answer is handed out, or after the call ran), what the
key is computed from, and what happens to the other classes.

## Decision

1. **The port spends the answer.** `StateApprovals.request` hands out a "yes" to an
   always-human class (`ALWAYS_HUMAN`, by the request's or the row's action class) once and
   marks the row spent in the same optimistic update (`change_card.consumedAt`,
   `change_card.consumedByRun`; the envelope's `version` and `updated_at` move with it; the
   row's status stays `answered`, since `answered` is terminal in the request workflow and the
   answer itself is not changed). The next identical request files a new row and returns
   "pending". A `version_conflict` on the update means another consumer took the answer
   between the read and the write; the loser files afresh. No new port method: "approved"
   already means "run this call" and for these classes it now means it once, which is what
   the hooks' in-memory rule says too (`ctx.approvals`). The Cloudflare and browser ports
   already spend their one-shot rows this way; this makes the hooks' port agree with them.
2. **Spent when handed out, not after the call.** The row is marked before the call runs, so
   a call that is then refused for another reason (a secret not granted) or fails (network)
   has used its answer and the human is asked afresh. One extra question after a failure is
   the right cost for the classes that always need a human; marking after the call would let
   a crash between the admission and the record admit the call twice.
3. **The key is the raw input's.** `ApprovalRequest` carries `key`, the hooks' SHA-256 of
   the canonical raw input (`approvalKeyFor`), computed before the input is cut for the card;
   `change_card.key` is that key and `change_card.input` stays the cut copy for display. The
   port computes the key itself only when a caller passes none, from an `input` that must then
   be raw (the data tools do). The Cloudflare port, which reuses the hooks' row for a staging
   deploy, hashes the raw input for that lookup too; its own card keeps the cut copy.
4. **Other classes keep holding.** A "yes" to a class the autonomy level makes approvable
   (`merge_pr` at level 2, say) holds for the run (`ctx.approvals`) and, through the row, for
   the session; a "no" denies for the session. A withdrawn or expired row holds nothing: the
   next request files a new one (before, it kept the call pending for ever with no row to
   answer). An open row for the key keeps the call pending, whichever older rows exist, so a
   session never carries two open questions for one call.

## Consequences

- An always-human action runs exactly as many times as a human said yes, across runs and
  restarts of the daemon or the cloud runner. The resume path still works: the first re-made
  call after the answer is admitted, in the same run or a later one of the session.
- A row written before this change under the display-copy key no longer matches an input
  whose strings were cut; the human is asked once more, which fails closed.
- ~~Approvals are still matched within one session, and no production path re-makes a paused
  call in its own session (...) A call answered after its session ended is therefore never
  consumed (...) keying the lookup on the task as well, or resuming the paused session, is
  open with the J.7 item.~~ Replaced by [ADR 0088](0088-late-hooks-approval-consumed-by-the-task.md)
  (2026-10-25): the port also matches the rows of the call's task filed by the same agent for
  the same human in its earlier sessions, and the daemon's `syncLateApprovals` (shared mark
  with the cloud runner's inbox trigger) puts the task back to `ready` and starts the session
  whose re-made call consumes the answer once. The one-shot rule of the first bullet is
  unchanged.
- Tests: `packages/runtime/test/approvals-durable.test.ts` (the former critic scratch file,
  its `it.fails` now passing) and the long-input case in
  `packages/capabilities/test/cloudflare-tools.test.ts`.

## Amendment (2026-10-23, review of w5-review-findings)

- A tool that files its own approval card (the Cloudflare deployer's port) never shows the
  input it executes with: that input has the call's `secret:` references resolved. The hooks
  return, beside `approvalKey`, their display copy of the parsed input
  (`ToolCallDecision.approvalInput`: references unresolved, long strings cut, the same copy
  their own card shows); the agent loop hands both to the tool in its context
  (`ToolExecutionContext.approvalKey`, `approvalInput`), and the Cloudflare port shows
  `displayInput` on its card. Rejected alternative: scrubbing the resolved input with the
  run's resolver (`SecretsPort.redact`) inside the port, which would need the resolver in the
  capability and would show `[REDACTED]` where the human should see which secret is bound.

## Amendment (2026-10-25, ADR 0088)

- The third consequence above is superseded: a hooks approval answered after its session
  ended is consumed by the next session of the same task (the row matched by `task_id` and
  key, for the same agent and human) and that session is started by the answer itself
  (`syncLateApprovals`; the cloud runner's trigger shares the mark). The "match across the
  sessions of a task" alternative below was taken there, bounded to the task's rows filed by
  the same agent for the same human, with the session's own rows still read first.

## Alternatives considered

- **A `consume(key)` method on `ApprovalPort`, called from `afterToolCall`.** Rejected: it
  marks the row after the call, so a crash in between admits twice; every port and fake would
  need the method; and the in-memory rule already treats "approved" as single-use for these
  classes, so the port's answer is the right place.
- **Spend the row only when `afterToolCall` reports success.** Rejected for the same reason
  and because a failed delete is not a reason to admit a second attempt without a human.
- **Pass the raw input to the port and let it cut the copy for the card.** Rejected: every
  port and fake would receive inputs of any size (a file write's whole text) and each would
  need the cutting; a key beside the cut copy keeps the row small and the contract explicit.
- **Match approvals across the sessions of a task.** Out of scope here: the row has no task
  binding the hooks can rely on for every call, and the paused-session resume belongs to the
  J.7 item.
