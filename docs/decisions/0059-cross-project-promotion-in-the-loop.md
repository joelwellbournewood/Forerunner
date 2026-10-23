# 0059 — Cross-project promotion in the loop: who reviews a proposal and when, the offer rule, what an accepted offer does

Date: 2026-10-23
Status: accepted

## Context

Spec G.6: "lessons tagged as general are promoted to the shared store after critic approval
and offered to other projects." `packages/memory` had the mechanics (`proposePromotion`,
`promote`, `rejectPromotion`, `offerToProjects`, [ADR 0002](0002-operator-memory.md), [ADR
0027](0027-memory-package-parameters.md)) but no runtime code called them: nothing proposed,
nothing reviewed, nothing offered. Wiring it raised four questions the spec leaves open:
which agent reviews a proposal and at what moment, since the critic needs a session token and
a budget; what "offered to other projects" means in a model where a promoted lesson is global
(`project_id = null`) and already retrievable by every project; how a private lesson, which
the package refuses to propose without the human's approval of the exact text, enters the
flow; and how any of this stays inside one human when the state store is shared.

## Decision

1. **Who proposes.** `MemoryLoop.record` proposes every critic or project-level shared lesson
   it records that carries the `general` tag, at once and idempotently (the proposal row of
   the memory package, `status: proposed`). A private lesson is never proposed by the runtime:
   the human proposes it from the memory view (`POST /memory/lessons/:id/propose`), which tags
   it `general` when it is not (the human's own act on the exact text) and passes
   `humanApproval` with the owner agent as the proposer, so the package's rule stands. A
   proposal follows its origin through a near-duplicate merge (the re-recorded lesson
   supersedes the earlier row; the pending proposal is re-pointed and refreshed, not doubled).

2. **Who reviews and when.** The critic, at the end of every session of one of the human's
   principals, after the session's lessons are recorded and before the session review: at
   most `MAX_PROMOTION_REVIEWS_PER_SESSION` (5) pending proposals, each a tier-1 light read on
   the critic's own model through `CriticService.review` with a new subject kind
   `{ kind: "lesson", lessonId }`, under the session token (the critic's token copies its
   ids and budget, one tool) and a per-review cap of `PROMOTION_REVIEW_BUDGET_USD_MICRO`
   (USD 0.25). The evidence is the lesson text as an input file and as the claims, its tags,
   confidence and origin, and three fixed acceptance criteria (`PROMOTION_CRITERIA`: holds
   beyond its project, one actionable observation and not an instruction, no secret or
   personal data). The review row has no task and the token's session; a `human` verdict on a
   lesson files no sign-off request (there is no task to sign off). Only a completed review
   decides: `accept` promotes (the package verifies the accepting row), any other completed
   verdict retires the proposal with `rejected_by:<review>` in its source (the origin stays,
   the human can edit and propose again), a run that did not complete (limit, provider
   failure) leaves the proposal pending for the next session. A session reviews only the
   proposals made by this human's agents or by the human (`pendingProposals`); another human's
   proposals on a shared store are theirs to review.

3. **The offer rule.** On promotion the loop files one offer per other project of the same
   human whose tags overlap the lesson's (`offerToProjects` with an explicit project list;
   never the origin project; `general` alone never counts). A project is the human's when its
   `settings.members` names one of the human's principals, or when it declares no members (a
   single-human install). A project's tags are `settings.tags` plus the tags of the active
   lessons recorded about it in critic, shared and the human's own principals' private memory
   (tags only; no text leaves its scope). An offer is a non-blocking approval request
   (`change_card.key = "memory:offer"`, options `accept`/`dismiss`, risk low), so it is in the
   inbox and in the memory view alike; one per (lesson, project), never re-filed once answered.

4. **What an accepted offer does.** The promoted lesson is global and every project already
   retrieves it by relevance; accepting an offer makes it a standing note of that project: a
   pinned, project-level copy in shared memory (`source: promotion:<promoted id>;human:<id>`,
   authored by the human, written with `noDedup`), never into any private scope. Dismissing
   changes nothing but records the answer. Each is one audit row (`memory.offer_accepted`,
   `memory.offer_dismissed`). Consolidation never merges such a copy with its origin: the pair
   is excluded from the duplicate rule, and a copy that a third lesson would link into a group
   with its origin is left out of that group (a merge would keep the pinned copy and make it
   global, pinning the lesson for every project the human never accepted it for).

## Consequences

- The runner gains one step (`reviewPromotions`) and `SessionResult.promotions`; the ports
  gain optional methods (`CriticPort.reviewPromotion`, `MemoryPort.pendingPromotions`,
  `MemoryPort.resolvePromotion`) so fakes without them run as before and the step is skipped.
- A proposal costs one cheap model call per session end until it is decided; a proposal that
  keeps failing to review (a dead provider) stays pending and visible under "Waiting for the
  critic" rather than being lost. Events: `memory.promotion`, `memory.promotion_failed`.
- The critic package accepts a third subject kind; `validateInput`, the renderer's subject
  line and the sign-off rule know it. Nothing about task or session reviews changes.
- Offers answered in the inbox are applied by `syncOffers` (part of the daemon's
  `syncApprovals`) exactly as answers given on the memory page; the same audit row either way.
- A lesson promoted from critic memory leaves its critic origin active (the package's rule);
  the proposal row is the shared lesson.

## Alternatives considered

- Reviewing the proposal inside the critic loop at the moment the critic records the lesson
  (a review nested in a task review): rejected; it ties the decision to one task's review and
  would not cover proposals the human makes from the memory view.
- Reviewing immediately when the human proposes from the memory view: the daemon has no
  session token or budget at that moment; the next session end is at most one session away
  and the view says so.
- Accepting an offer as a plain (unpinned) project copy: it changes nothing observable, since
  the global lesson already applies, and consolidation would propose merging it every week.
  Rejected in favour of the pinned copy with the consolidation exclusion.
- A `lesson_offer` table: cleaner than a human request per offer, but a schema change for a
  record that is exactly an approval the human answers; the inbox already shows and answers it.
- Letting the runtime propose private lessons tagged `general` automatically: refused by the
  package and by ADR 0002 ("the owner human must approve the exact text before a private lesson
  leaves the machine"); kept.
