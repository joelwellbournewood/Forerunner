# 0044 — Next-session queue items reach the agent of the human who queued them

Date: 2026-10-20
Status: accepted

## Context

A `queue_item` (spec J.2: notes, tasks, corrections and ideas for the next session) carries
`project_id` and `human_id` ("who queued it"). Until the scenario work the startup checklist
read the queue per project (`store.queue.pending(project.id)`) and `SessionRunner.consumeQueue`
consumed every item the brief carried, so on a shared project the first session of *any*
member's agent took the notes another human left. Scenario 1 ("The good day") showed it: J
leaves two notes at 00:30 Zurich for the morning; Bob (M's agent) is scheduled at 05:45 and
Alice (J's agent) at 06:00 on the same project, and Bob's session consumed J's notes while
Alice's brief carried none. The scenario was written to assert the clause on whichever
scheduled session consumed the notes and the finding was filed in `testing.md`.

The spec's model is one principal agent per person, with shared projects and no merged
identities or memories (`AGENTS.md`); the state service already answers `GET
/projects/:id/queue` to a device with that device's human's items only. Nothing in the spec
says a note on a shared project is for the project as a whole. The decision to take is
whether a queue item is for the agent of the human who queued it, or for whichever session on
the project comes first.

## Decision

1. **A queue item is for the agent of the human who queued it.** `human_id` is the item's
   addressee, not a provenance column. A session briefs and consumes the items of its agent's
   owner (`agent.owner_human_id`) on the project, and never a co-worker's, however the sessions
   are ordered. In scenario 1 the consumer is therefore Alice's 06:00 session, and the scenario
   names it.
2. **Enforced in code at both ends.** The checklist reads `store.queue.pending(projectId, {
   humanId })` and counts with the same filter, so the brief shows and the count names only the
   owner's items. `QueueRepo.consume(id, version, sessionId, { humanId })` refuses an item of
   another human with `ForerunnerError("validation")` and `details.reason = "other_human"`
   before any write; `consumeQueue` passes the owner, skips such an item with that reason
   (audit row and `queue.consumed` event, the item left `queued` for its own agent) and never
   fails the session over it, as for an item that moved while the checklist ran. The repo
   filter is the first line; the consume guard is the second, so a brief built without the
   filter (another checklist, a tampered brief) still cannot take a co-worker's note.
3. **A project-wide note is a different thing, not this one.** Spec J.2 has no such item; when
   one is wanted it is a new `kind` or an explicit flag on the row (for example
   `for_project: true`), briefed to every member's agent and consumed per agent, with its own
   ADR. Until then a human who wants every agent to see a note tells each co-worker, or writes
   a task, which is project-wide by design.
4. **Readers follow the same rule.** `note.add`'s change card counts the human's own queued
   items; the state service keeps filtering device reads by the device's human (admin
   principals see every row).

## Consequences

- J's notes reach J's agent whatever the morning order of the scheduled sessions; a
  co-worker's agent never sees them. Scenario 1 asserts Alice's session as the consumer and
  the Known-issue bullet is gone.
- A note left by a human who has no agent on the project waits until that human's agent runs a
  session there; nothing else consumes it. The UI shows it as queued.
- The store guard adds one comparison to `consume`; no migration, no schema change. The
  `(project_id, status, priority)` index still serves `pending`; the `human_id` filter is a
  row filter on the same rows.
- Tests: `runner-queue.test.ts` (two humans, two agents, one project: M's agent runs first and
  briefs and consumes M's note only, J's note stays queued and is consumed by J's agent's next
  session; a brief built without the filter skips the foreign item as `other_human`),
  `checklist-queue.test.ts` (items and count per human), the state suite (`pending` with
  `humanId`, `consume` refusing another human's item, on both dialects).

## Alternatives considered

- **First session on the project takes the note.** Simplest and what the code did; it breaks
  the one-agent-per-person model (M's agent acts on J's instruction without J's agent ever
  seeing it), makes the morning order decide who reads a note, and the summary J gets does
  not mention the notes J left.
- **Per project with a per-human opt-in.** The default would still hand a private note to a
  co-worker's agent; the spec's silence on project notes is not a reason to make them the
  default.
- **Filter only in the checklist.** One line less, but a brief built by any other path would
  consume a co-worker's note; the store guard is one comparison and makes the rule a store
  invariant, like the claim and the owner filter on remote commands (ADR 0041).
- **A `forbidden` error code for the guard.** The taxonomy has no such code and this is the
  only use; `validation` with `details.reason` keeps the runner's skip rule unchanged and the
  reason visible in the audit row.
