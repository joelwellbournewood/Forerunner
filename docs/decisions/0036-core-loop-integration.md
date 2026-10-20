# 0036 — The core loop closed: critic tiers and the retry ladder as wired, memory budgets, where lessons are recorded, commands as the only way to change state

Date: 2026-10-20
Status: accepted

## Context

Phase 3 of the build order ends with "the core loop is now complete and every later phase
builds on it". The three packages existed and were unit-tested on their own (`@forerunner/critic`,
ADR 0028; `@forerunner/memory`, ADR 0027; `@forerunner/commands`, ADR 0030) but nothing ran
them: the session runner left every reviewed task in `in_review` for "a later reviewer", the
brief carried no lessons and nothing recorded any, and the conversation agent changed state
through ad-hoc tools of its own. The spec fixes the rules (H, G, Q, B.4, D.2, D.3, E.5) and
leaves the wiring open: which tier reviews what, how the ladder's rung is chosen for a run,
how many tokens memory may take, who records which lessons, and how chat, voice, the UI and
the phone share one change log. This ADR records those decisions as the runtime now enforces
them (`packages/runtime/src/loop/`).

Note on the number: 0034 was the number reserved for this task; a parallel task published
`0034-approvals-web-session-and-confirmation.md` under the same number before this file landed.
Both stay under 0034 (this one is "0034, core loop integration"); the README table is owned by
the index maintainer and lists the other one, so a reader coming from the table finds this file
through `docs/maintainers/runtime.md`, which links it. Renumbering is the index maintainer's
call (0036 is the next free number).

## Decision

### Critic (spec H, B.4, D.2, D.3)

1. **Every task above tier 0 is reviewed at its own tier right after its run**, in the same
   session, before anything else happens to it. `SessionRunner` hands the finished task to
   `CriticPort.reviewTask` (`CriticLoop` over `CriticService`): tier = `task.risk_tier`; the
   project's `critic_ceiling` and `speed_quality_offset` come from the project row; the
   evidence is the diff of the task's worktree (`GitDiffPort`: `origin/HEAD...HEAD` plus the
   uncommitted diff, cut at 200k characters with the file list kept), the changed files, the
   project's `settings.checks` (argv commands, run by the critic at tiers 2 and 3), the
   specialist's final report as claims, and at tier 2+ the standard-doc drift of the worktree
   (`checkDocDrift`) as a non-required check. The critic's own run spends from the session
   budget through the ordinary hooks and its token is derived from the session token.
2. **Tier 0 keeps the mechanical path**: automated checks only, no critic call. The task closes
   when the checks passed; the store still refuses the close while a finding is open and the
   runner reports that (`task.blocked_by_findings`, `SessionResult.blockedByFindings`) instead
   of working around it.
2a. **A close refused over open findings ends with the human, not in limbo.** On both blocked
   paths (tier 0, and an accept while a finding of another review is still open) the runner
   files one blocking request per task (`session/findings.ts`, `change_card.key =
   "findings:blocked"`, options `rework` / `accept` / `cancel`, reused while open; `high` risk
   when a finding is high or critical) and the task stays `in_review`, which later sessions
   never plan. The inbox answer is applied by `syncBlockedByFindings` from `syncApprovals()`:
   `rework` goes `failed -> ready` (attempt + 1; the open findings become constraints of the
   next brief through `retryConstraints`), `accept` resolves the open findings against the run
   that produced the work and closes the task, `cancel` cancels it; an answer outside the
   options or a task that moved on is recorded as skipped. The alternative, an automatic
   `failed -> ready`, was rejected: at tier 0 nobody would ever verify the rework against the
   finding and the task would loop.
3. **The verdict moves the task through the state workflow** (`applyVerdict`): accept resolves
   the findings against the run and closes (`in_review -> done`; `findings_open` from the store
   keeps it in review and is surfaced); revise goes `failed -> ready`, which counts the attempt;
   escalate follows the retry policy from the attempt count; human opens the blocking sign-off
   request. A revise after the ladder's last rung ends with the human too, so a task cannot
   loop through revisions forever (`retryAction(attempt, currentTier, ceiling) === "human"`).
4. **The ladder's rung is derived, never stored**: the attempt count the state workflow keeps
   (`task.attempt`, incremented on `failed -> ready`) is the only truth; a run does not count
   itself. `LoopTaskExecutor` turns it into the brief and the model: attempt 1 improves the
   brief (the open findings become constraints with their required actions), attempt 2 names
   "split or change specialist" in the brief, attempt 3 runs one rung up when
   `nextRung(current, ceiling)` allows it (`tierForAttempt`), otherwise the critic's follow-up
   has already handed the task to the human. Escalation never exceeds the project's
   `critic_ceiling` (the ladder's default `opus` when unset).
5. **Session review at tier 0 by default**: at session end the critic's deterministic honesty,
   plan and cost checks run on the stored summary (`CriticPort.reviewSession`); a model-backed
   session review is a per-install option (`SessionRunnerDeps.sessionReviewTier`), not the
   default, because the session has already paid for its task reviews. A `human` verdict is
   surfaced as an escalation event.
6. **Repeat findings become critic memory**: the critic's `lessonProposals` (a fingerprint seen
   in two sessions) are recorded through the memory port in scope `critic` with the critic
   agent as author; the critic never writes memory itself.
7. **A critic failure keeps the task in review**: a port that throws, or a review that ends with
   no verdict, never closes a task; the event `critic.review_failed` (or the conservative
   `escalate`) is the record.

### Memory (spec G, E.5, N.4)

8. **Budgets are per project settings with defaults in code**: the brief's lessons block is
   capped at `settings.memory_token_budget` (default 1,500 tokens, `DEFAULT_MEMORY_TOKEN_BUDGET`),
   a specialist's brief at `settings.task_memory_token_budget` (default 400,
   `DEFAULT_TASK_MEMORY_TOKEN_BUDGET`). The budget is enforced twice: the memory package cuts
   the selection to it, and the runner and the executor drop a block that still exceeds it
   rather than send it (`memory.over_budget`). The phase 4 gate "memory loaded per session stays
   under the set token budget" is therefore a code invariant, not a measurement.
9. **Scope grants are issued from the agent kind, in code** (`grantFor`): the principal reads
   its own private scope plus shared; the critic reads critic plus shared; a specialist reads
   nothing and gets only what the principal relays. Specialists' briefs get lessons through
   the principal's grant, ranked against the task text and tagged with the specialist's name.
10. **Lessons are recorded at session end, into the agent's private memory**, from three
    sources: lines a specialist spelled out as `Lesson: ...` in its final report (the brief asks
    for them; 20 to 2,000 characters), critic findings the rework resolved (the lesson text is
    the finding row's description and required action, so it says what was wrong and what
    fixed it), and decisions the human answered on the project since the last session (tagged
    `decision`, `human`). The memory package's near-duplicate merge keeps a repeated lesson
    single. Rejections are reported in `memory.recorded`, never fatal to the session.
10a. **Every lesson candidate passes the injection gate before memory** (`session/lessons.ts`,
    `screenLessons`). A specialist's report and the critic's proposals are model output over
    web pages, emails and repo files, so a planted `Lesson:` line would become a standing note
    for every later session. Each candidate runs through the general scanner
    (`injection/scan.ts`) plus lesson rules for shapes an observation never needs: a shell pipe
    to run, an order to skip a guard (hooks, budget, critic, sandbox), an operator's note, a
    standing order for every task, a direct address to the agent, a URL to execute. A general
    verdict, or a combined score of 4, drops the candidate. The gate runs in the executor
    (`lessons` of the result), in the runner before `record`, in the critic loop before the
    critic's proposals are recorded, and inside `MemoryLoop.record` itself, so no caller of the
    port can store one; the runner reports them (`memory.lessons_rejected`, `memory.recorded`
    `rejected`/`quarantined`) and quotes them to the human in a `warning` message, as every
    other injection hit is quoted. Legitimate wording ("always run the Windows job before
    merging", "tier 0 tasks skip the critic") stays under the score and is kept.
10b. **The memory views stop at the human boundary.** `MemoryLoop` is built with the human
    it serves; a private scope is listed, edited, pinned or removed only when the owning agent
    belongs to that human (`owner_human_id`), and another human's agent or row answers
    `not_found` (404) so the view neither shows nor confirms it. Critic and shared rows have no
    owner and stay editable. Spec G.1 ("never mixed") therefore holds in the views as it does
    in retrieval, also on a shared Postgres store.
11. **Weekly consolidation runs on the scheduler as a report** (`scheduleMemoryConsolidation`,
    every seven days, same mechanism as the model watch): every principal's private scope, the
    critic scope and the shared scope are consolidated with `apply: false`; the proposals go to
    the human as one approval request (`change_card.key = "memory:consolidation"`, options
    `apply` / `skip`, reused while one is open). The inbox answer is applied on the next
    `syncApprovals()` **only when the proposals still match**: each scope is re-reported first
    and applied with `apply: true` when the same lessons would be merged (same survivor),
    flagged and retired (`sameProposals`, ids not wording, so a changed hit count does not
    count as drift); a scope where lessons were added, edited or retired since the human read
    the list is left alone, marked `stale` on the card, and proposed again. The request's card
    keeps `applied_at` so it is handled once.
12. **Deleting a lesson from the view retires the row and removes its file**; the row stays
    for history (`superseded_by` links, findings that cite it). Editing rewrites the file from
    the row after the lint rules pass.

### Commands (spec Q, J, R)

13. **The conversation agent has no tools of its own**: what the human says is parsed into
    commands first (`IntentParser`, deterministic, no model call), a combined request is one
    change card through `CommandExecutor.compose`, and the model path, used only when no
    pattern matched, is offered the registry's command tools (`toToolSpecs`) and nothing else.
    A sentence no pattern understands goes to the model (`matched: "none"`), the parser's own
    questions (an ambiguous project, a budget without a time, a refused value) are asked as
    they are. Without a command port the chat is read-only (spec J.1).
14. **One `CommandContext` builder for every caller** (`CommandLoop.contextFor`): the actor is
    the human, the time zone is the human's row, the device is the paired device of the
    request, the source is `chat` for text and the phone, `voice` for voice; the daemon routes
    (`/commands/*`, `/changes/*`) build the same turn. The settings screen passes
    `confirm: "tap"` after showing the card; medium risk by chat or voice waits for a yes; high
    risk waits for the paired device (`/commands/:id/confirm { answer: "device" }`, biometric on a
    phone); a chat "yes" on a high-risk card is refused and the card stays open.
15. **The scheduler reads the registry's session cap** (`sessionCapFromSettings`): a temporary
    override written by `budget.set` ("give it 20 francs tonight") is honoured by a session the
    scheduler starts while its window is open, so conversation changes and the settings screen
    go through the same enforcement (spec Q.12).
16. **The command table is persisted and open windows are re-armed at every start**
    (`CommandLoop.start`), so a temporary change survives a restart and reverts on time.
17. **`session.start` reports what the scheduler did, and the undo of a start that only
    queued drops the request.** The scheduler cannot know the session id synchronously (the
    runner starts in the background), so the port returns `{ sessionId: undefined, outcome:
    started | queued | deferred }` (`sessionCommandPorts`, `loop/commands.ts`). The registry's
    undo then kills the agent's scope with the reason `undo of session.start`; the kill port
    recognises that reason and, when the agent has a waiting request (queued behind an active
    session or deferred by quiet hours), drops it (`Scheduler.cancelPending`) and stops nothing.
    A start that did run is stopped as before (the just-started session is the agent's active
    one), and `session.stop` reaches the kill switch unchanged. The coupling on the reason
    string is pinned by a test through the real registry. The change log sentence ("Started a
    session ...") is the registry's wording and reads the same for a queued start; the outcome
    is in the port result for callers that show it.

## Consequences

- The loop is closed with ports (`src/loop/ports.ts`): the runner, the executor and the
  conversation agent depend on `CriticPort`, `MemoryPort` and `ConversationCommands`, and the
  three packages are reached only from `src/loop/*.ts` and the composition root. Tests run the
  runner with fakes of the ports and the real implementations on the fake provider.
- `packages/runtime` now depends on `@forerunner/critic`, `@forerunner/memory` and
  `@forerunner/commands`, which depend on `@forerunner/runtime`; the cycle is of the same shape
  as the existing one with `@forerunner/capabilities` (values are read inside functions, never
  at module top level) and is checked by the package test suites running in both directions.
- A task above tier 0 costs one critic call per attempt out of the session budget; the review
  reserve (I.4) exists for it.
- The Reviews tab, the memory views and the change log are served by the daemon
  (`ReviewsView`, `MemoryView`, `ChangeLogView`, `CommandResultViewSchema`); the UI's contract
  mirror has to follow.
- `reviewsView` for a project loads the project's tasks and sessions and filters the review
  rows in memory; a `review.forProject` repository query (join on `task.project_id` /
  `session.project_id`) belongs in the state package when it is next touched.
- `PrTaskExecutor` (capabilities) spreads the inner executor's result, so `runId`, `worktree`,
  `finalReport` and the screened `lessons` reach the critic through it; only its no-changes
  branch returns a reduced shape without them.

## Alternatives considered

- Reviewing in a separate session ("a later reviewer"): rejected; the spec's loop is
  run -> review -> verdict -> ladder inside one working period, and a task left in review
  blocks the plan.
- Storing the ladder rung on the task: rejected; the attempt count already exists and two
  counters drift.
- Letting the critic write lessons directly: rejected (ADR 0028 independence, memory decides
  scope and storage).
- Keeping a few ad-hoc chat tools next to the registry: rejected; spec Q says nothing is
  chat-only, and a second path would have its own change log.
