# 0088 — A hooks approval answered after its session ended: matched by task and key, consumed once by the call it was asked for, and acted on once by a follow-up start the daemon and the cloud runner share a mark for

Date: 2026-10-25
Status: accepted

## Context

Spec S.6 names the actions that always need a human; J.7 says an assisted agent acts after
approval. The enforcement hooks hold such a tool call behind a `human_request` row
(`StateApprovals`, ADR 0052: the row keyed on the SHA-256 of the canonical raw input, an
always-human "yes" spent as it is handed out). The review of w5-review-findings left one
finding open (BLOCKERS.md, "Open review findings of 2026-10-23"): the port matched rows by
`session_id` only, and nothing resumes a session, so an answer given after the filing session
ended was never consumed. The run that asked had ended `needs_human`, the task went
`needs_human` (which no session plans), the session moved on and ended; every later session
that re-planned the task filed a new question and paused again. Fail-closed, but the task
never progressed and the human was asked the same thing again. ADR 0052's third consequence
and runtime.md's Known issues recorded that behaviour.

Three things had to be decided: how a later session finds the answer, who makes that later
session happen (and exactly once, with the cloud runner's inbox trigger producing starts from
the same answered rows), and what a refusal does.

## Decision

1. **The port matches by task and key across the agent's sessions.** `StateApprovals.request`
   reads the session's own approval rows and, when the call names a task, the rows of that
   task filed by the same agent for the same human (`task_id`, `author_agent`, `human_id`),
   newest first, and applies the rules of ADR 0052 to them unchanged: an open row keeps the
   call pending with no second row, a "no" denies, an always-human "yes" is handed out once
   and marked spent (`consumedAt`, `consumedByRun`), any other "yes" holds. Another input is
   another key; another task, another agent's row and a row addressed to another human never
   match. Within one session the key alone still names the call (two tasks of one session
   asking the same thing share one question, as before). A run that names no task sees only
   its own session's rows.
2. **The daemon starts the follow-up, once, by the ADR 0053 pattern.** `syncLateApprovals`
   (`src/session/late-approval.ts`, run from `RuntimeApp.syncApprovals`: the answer route, the
   `request.answer` command, the approvals poll, compose time, and now also when a session
   ends) scans the human's answered blocking approvals whose card is a hooks approval
   (`isToolApprovalRequest`: `tool`, `actionClass` and the key `<tool>:<sha256>`), filed by
   this agent for a task, whose session has ended (`stopped`, `completed`, `failed`, `killed`)
   and whose answer the session did not use: for an always-human class the row is unspent
   (`consumedAt` absent, whenever the answer came); for any other class, whose "yes" is never
   spent, the answer came after the session's `ended_at`; a "no" likewise. Per row, once:
   - "yes", task `needs_human`: the card is claimed (`markAnswer`: `applied_at`,
     `outcome: "starting"`, a write conditional on the row's version), the task goes
     `needs_human -> ready` with the reason `approval answered (request <id>): <tool>` by the
     human, the scheduler is asked for one `message` start of the project carrying
     `StartRequest.approvalRequestId`, and the scheduler's answer (`started`, `queued`,
     `deferred`) and `start_id` are recorded. The follow-up plans the task; its re-made call
     finds the answer by task and key and runs. Task `ready`: the same without the move.
   - "yes", task `done`, `cancelled` or `failed`: `task_moved_on`, nothing starts; the row
     stays the task's answer should a rework re-make the call.
   - "yes", task `claimed`, `in_progress` or `in_review`: nothing yet; another session has the
     task and the port consumes the answer there if the call is re-made. The next sync looks
     again.
   - "no": `refused`; nothing starts, the task records the refusal (`reason: human refused
     <tool> (request <id>)`, `author_human`) and stays `needs_human`; the row goes on denying
     that call for the task (ADR 0052 decision 4, extended to the task).
   - A start the port throws on, or that fails after the scheduler took it (`runner.start`
     rejecting in the background), is `start_failed` with the error, one audit row and one
     warning to the human (`reportLateStartFailure`, called by `reportingPlanStartFailures`
     for a request carrying `approvalRequestId`; "once" is `failure_reported_at`). The task
     stays `ready` and the answer stands for the next session.
   Every outcome is one audit row `session.late_approval` (ids, tool, class, outcome; never
   the input). `syncApprovals()` returns it as `late: { started, refused, skipped }`; a CLI
   one-shot (`startServices: false`) starts nothing, as for plans.
3. **The cloud runner's inbox trigger shares the mark.** `markPlanAnswer` and
   `planAnswerApplied` move to `answer-mark.ts` as `markAnswer` and `answerApplied` (the old
   names stay as aliases). The trigger, which already started a `message` session on any
   answered session request, now skips a hooks approval whose card carries `applied_at`,
   calls `claimLateApproval` on each one it would act on before it asks for its session (the
   same decisions as the daemon: claim and move, refuse, moved on, wait, lost), names the
   first claimed request on the start (`approvalRequestId`), records the outcome on each
   claimed row after (`recordLateStart`) and releases a claim whose start was skipped for a PC
   that came online (`releaseLateClaim`; the task stays `ready` and the PC daemon's sync
   starts it). Two installs therefore never start one answer twice: whoever marks first acts.
4. **A session's end syncs.** `runSession` in compose.ts calls `syncApprovals` after the
   session result, so an answer that came while the session ran, for a call it had already
   moved past, is acted on at once rather than at the next answer, poll or restart. The
   result stands whatever the sync does.
5. **Level 0 and 1 follow-ups file their plan.** The follow-up is an ordinary start of the
   project; at those levels it files its plan for approval as every session does (ADR 0053),
   and the late answer is consumed when that plan runs. Two approvals, both fail-closed; the
   late start carries no plan id (a plan id is bound to the session that filed it).

## Consequences

- An always-human action a human said yes to runs exactly once, whether the answer came
  while the session ran or after it ended, and the human is not asked again for it. A late
  "no" is consumed too: the task records it and the call stays denied for the task.
- ADR 0052's consequence that a late answer is never reused is replaced by this ADR (its
  amendment points here); runtime.md's Known issues loses the bullet.
- `StartRequest.approvalRequestId` (optional) is the one schema-free change on the scheduler's
  request; the cloud runner's `CloudStartRequest` inherits it. `InboxTriggerDeps` gains
  `humanId` and its store pick `task` and `auditLog`. No database change: the marks live on
  `change_card`, the task move is an ordinary transition.
- A row consumed in its own session, a row answered before its session ended for a class that
  is not always-human, and a row whose session still runs are read by every sync and skipped
  without a write; the scan is the one `unappliedAnswers` already makes for plans.
- Known limits: several late approvals bundled into one cloud start name only the first on
  `approvalRequestId`, so a background failure of that start is reported on the first and the
  others keep the scheduler's answer (`started`); a late "yes" whose task is `in_review` waits
  until the review moves the task, which can be a human's sign-off; a sync that finds a task
  `needs_human` for another reason (a budget stop) and an unspent always-human "yes" for it
  starts the follow-up, which is right (the call was never made) but spends budget.
- Tests: `approvals-durable.test.ts` (the task-and-key lookup: consumed once by the next
  session, a different input / task / agent / human never matching, an open question of an
  ended session kept pending without a second row, a late no denying, a late non-always-human
  yes holding), `late-approval.test.ts` (the sync over the real runner and hooks: the
  follow-up consuming the answer once and finishing the task, the refusal recorded and the
  next session denied, an answer the session used and a running session left alone, the
  non-always-human lateness rule, moved-on and in-hand tasks, another agent's row, a row
  without a task, both start failures, the shared mark both ways),
  `late-approval-daemon.test.ts` (the answer route) and the cloud runner's
  `inbox-trigger.test.ts` (claim before the start, the daemon's mark honoured, a claim lost
  between read and claim, a refusal, a released claim).

## Alternatives considered

- **Resume the paused session.** `stopped` and `completed` are terminal in the session
  workflow; a resume would need a new status move, a runner that re-enters a finished
  session with its plan and budget, and the cloud runner's trigger to know about it. The
  follow-up start reuses what the scheduler, the runner and the trigger already do.
- **Key the port's lookup on the task only (drop the session).** A run that names no task
  (the conversation agent's tools, a session-level step) would lose its rows; and two tasks
  of one session asking the same call would file two questions where ADR 0052 files one. The
  session's rows come first, the task's are added.
- **Consume the late answer in the sync and skip the hooks.** The sync has no call to admit:
  the action runs inside a session, through the hooks, or not at all ("a prompt may ask; only
  code can allow"). The sync only makes the session happen.
- **Treat a late "no" as asked again next time.** A "no" answered in-session already denies
  for the session; a late one that merely vanished would make the task ask the same thing at
  its next session. Recording it on the task and keeping the denial is the honest reading of
  the answer; the human changes the task if they change their mind.
- **Mark rows the session used itself (`consumed_in_session`) so the scan skips them.** One
  extra write on every normal approval for a scan that already pages every answered blocking
  approval; skipped without a write instead.
- **Report background failures of a late start by request id on every claimed row of a
  bundled cloud start.** `StartRequest` names one request; a list would change the plan path's
  shape for an edge of an edge. Recorded as a known limit.
