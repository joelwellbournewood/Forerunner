# 0053 — Plan approval: the approved plan's identity, the filing session's end, and who starts the follow-up

Date: 2026-10-23
Status: accepted

## Context

Spec J.6 "Level 0 Advisor: plans and proposes only" and J.7 "Level 1 Assisted: acts after
approval of each plan". The session runner filed the plan of a level 0 or 1 session as a
blocking `approval` request keyed `plan:<session>` and ended the session `paused`; nothing
turned the answer into a run on the desktop daemon (`syncApprovals` applied extensions, model
watch, memory, findings and sign-offs only; the scheduler's `StartRequest` had no
`planApproved`). `SessionRepo.active` counts `paused` as active, so every later start of the
agent, including the cloud runner's inbox trigger carrying `planApproved: true`, was refused
with `claim_conflict` until a human killed the paused row. And `planApproved: true` named no
plan: once the row was closed, a start with the flag ran whatever was planned at that moment,
a task added after the approval included (BLOCKERS.md, "J.6 / J.7 plan approval starts
nothing"; `closeout-autonomy.test.ts`, two `it.fails`).

Three things had to be decided: what the human approves (the identity a start is bound to),
what becomes of the session that filed the plan, and which process turns the answer into a
start, exactly once.

## Decision

1. **The plan's identity is the session plus a hash of the task ids in order.**
   `planIdOf(sessionId, items)` = `plan:<session>#<sha256 hex over the task ids, one per
   line>` (`packages/runtime/src/session/plan-approval.ts`). The plan request's card carries it
   as `plan_id` beside the existing `key` (`plan:<session>`) and the plan itself. Membership and
   order count (a task added, removed or moved changes the id); the specialist, the estimate
   and the titles do not, since a re-priced plan over the same tasks is the plan the human
   read. A start carries the id as `StartRequest.planApproved` (a string, never a boolean on
   the scheduler's request); `SessionStartOptions.planApproved` takes the id or `true`, where
   `true` approves whatever is planned and is reserved for callers that are themselves the
   approver (the scenario harness, tests). The daemon and the cloud runner always bind.
2. **The runner verifies, never trusts.** It plans as always, then `planApprovalOf` compares:
   `approved` (the id's hash is the plan's, or `true`) runs with `planApproved: true` in the
   run token (re-issued after the check; until then the claim is false); `changed` or `none`
   at level 0 or 1 files the plan as a new request (its own `plan_id`; `superseded_plan_id`
   names the approval that no longer fits; the `why` says the tasks changed since the plan the
   human approved) and runs nothing, not even the approved subset. A forged or stale id is a
   `changed` plan. Level 0 keeps "plans and proposes only": the approval runs the follow-up
   (the request text promised "approve to run it as a new session"), and the hooks' level 0
   policy still asks for every action that changes state (`decideAutonomy` is unchanged), which
   the request text now says.
3. **The filing session ends `stopped`, `stop_reason: plan_awaiting_approval`, when it files.**
   Not `paused`: `paused` is the remote pause (`session.pause`, O.9/R.4; `paused -> running`
   on resume) and means "a session that will go on", which a plan-filing session never does;
   `active()` keeps counting it so a paused cloud session still blocks a second start.
   `stopped` is terminal (`ended_at`, the summary "The plan awaits your approval in the inbox;
   nothing ran.", the handoff), the critic's session review is skipped for it (no work to
   review), and `session.active` never sees it. The events are `session.plan_filed`
   (`requestId`, `planId`, `items`, `changed`, `approvedPlanId`) and, on the follow-up,
   `session.plan_approved` (`planId`, `approvedSessionId`, `items`); `session.paused` is no
   longer emitted by the runner.
4. **The daemon's `syncApprovals` starts the follow-up; the request records it.**
   `syncPlanApprovals({ store, clock, humanId, agentId, start })` scans the human's answered
   blocking approvals whose key starts with `plan:` and whose card has no `applied_at`
   (`unappliedAnswers`, shared with the sign-off and blocked-findings syncs), skips another
   agent's requests, and per request: `approve` with a `plan_id` marks the card
   (`applied_at`, `outcome: "starting"`) **before** asking the scheduler (`requestStart`, so
   the entry's `id` is the start's identity, ADR 0049), then records the scheduler's answer
   (`started`, `queued` or `deferred`) and `start_id`; `reject` records `rejected` and starts
   nothing (the tasks stay `ready`; the next session proposes them again); an answer outside
   the options is `unrecognized_answer`; a card without a `plan_id` (an earlier build's) is
   `unbound_plan` and never run as approved; a start the port throws on is `start_failed`
   with the error, the human gets a warning message, and the request is not retried. Every
   outcome is one audit row `session.plan_approval` (ids and the outcome, never the plan text).
   Marking first makes "at most one session per answered request" hold across the route, the
   poll and a restart; the window in which a start could be lost is the port's own throw,
   which is reported rather than retried. A filing session an earlier build left `paused`
   with `plan_awaiting_approval` is closed (`paused -> stopped`) before the start so the
   start is not refused. The step runs only while the services run (`startServices`): a CLI
   one-shot composes the runtime but starts no session. The cloud runner's inbox trigger does
   the same binding with the newest approved plan's `plan_id` (an older one in the same check is
   superseded and the runner asks again); it remembers the answer ids as before.

## Consequences

- J.7 closes: `closeout-autonomy.test.ts` (the two findings inverted and bound to the id, a
  removed task and a forged id, level 0 running its approved proposal),
  `plan-approval.test.ts` (the identity, the answer shapes, the sync's idempotency, rejection,
  unbound cards, a failing start, an old paused row, another agent's request, the real
  scheduler), `plan-approval-daemon.test.ts` (the answer route and the approvals poll start
  the plan once; a rejected plan starts nothing) and the cloud runner's
  `inbox-trigger.test.ts`. J.6's "approve to run it" holds.
- `RuntimeApp.syncApprovals()` returns `plans: { started, rejected, skipped }`;
  `StartRequest.planApproved?: string`; the cloud runner's `CloudStartRequest` and
  `InboxStartRequest` lose their boolean field. `session.test.ts`'s advisor case and the
  closeout tests read `stopped` where they read `paused`.
- Known limit: a plan start the scheduler answers `queued` (the agent is busy) holds the
  scheduler's single pending slot per agent, which a later trigger replaces (`triggers.ts`:
  "the newest request wins"); the approval is recorded as handed over, and the replaced plan is
  proposed again by the next session rather than run. Tracked in `runtime.md` Known issues.
- Approval of a plan that was cut to budget approves the cut plan; a follow-up with a different
  session cap that cuts differently is a changed plan and is asked again.

## Alternatives considered

- **Exclude `paused` from `SessionRepo.active`.** Frees the start but breaks the remote
  pause: a session paused on the cloud runner would no longer hold the agent, and the UI's
  "active" set includes `paused` by design.
- **Close the filing session only when the approval starts the follow-up.** Leaves a row
  `paused` that nothing resumes (a `resumeSession` would set it `running` with no process
  behind it) and blocks every other trigger in the meantime.
- **A bare boolean `planApproved` everywhere, with the request closed as the only check.**
  Runs whatever is planned at the time of the start; the second finding exactly.
- **Hash the whole plan (specialists, estimates, titles).** A re-priced or re-worded plan over
  the same tasks would be asked again although the human approved that work; the task ids in
  order are what the human decides on.
- **Record the started session id on the request.** The scheduler runs the start in the
  background, so the session id is not known when the request is marked; the start id is the
  same identity the command registry's undo uses (ADR 0049), and the follow-up's
  `session.plan_approved` event names the filing session, which is enough to join the two.
- **Start from the sync in a CLI one-shot too.** A process that exits after its command is no
  place to run a session; the daemon's compose-time sync and poll cover it.
