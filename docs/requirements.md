# Requirements

Every requirement of Forerunner 1.0 with a stable ID, the build-order phase where it is first
built, its status, and the test that proves it. This file is the single checklist behind release
criterion 1 ("every requirement done, with a test"). It is read by machines as well as humans:
the CI gate check (`scripts/gates-verify`), the docs handover test and the build agent's work loop
all parse the tables below, so keep the column layout exactly as it is.

## ID scheme

- The letter is the module. `A` to `R` are the eighteen modules of the Feature spec in
  `docs/spec/forerunner-spec.md`, in the spec's order. `S` is the "Security, permissions and
  email" section (rules that apply everywhere, the vault, agent email, browser and desktop
  control). `T` is "Email commands". `U` is the Data model (record envelope and versioning, the
  entities, claims). `V` is the Release 1.0 criteria from the Build agent manual.
- The number is the order of appearance inside that section. Nested bullets and the rows of
  tables that state testable behaviour get their own IDs right after their parent (for example
  the autonomy levels J.6 to J.10, the email modes S.16 to S.20, the response-time rows D.8 to
  D.15). A parent row that only introduces its children is done when all of its children are done.
- IDs are stable: never renumber, never reuse. New requirements are appended at the end of their
  module (the spec changes only by PR with an ADR); a changed requirement keeps its ID and the ADR
  is cited in its Test column.
- The requirement text is the spec's bullet, lightly shortened. Every testable clause is kept.
  When text and spec disagree, the spec wins.

## Columns

| Column | Meaning |
| --- | --- |
| ID | Stable identifier, see above |
| Requirement | What must hold, from the spec |
| Milestone | Build-order phase (0 to 8) in which work on the requirement first lands: 0 Foundations, 1 Single agent, 2 Two agents, 3 Critic and quality loop, 4 Memory and docs, 5 Human experience and voice, 6 Capabilities, 7 Self-improvement and model economics, 8 Integration and release. Later phases may complete remaining clauses (for example A.3: GitHub import in phase 1, ZIP and folder import in phase 5) |
| Status | One of `todo` (not started), `in progress` (work merged but not every clause tested), `done` (every clause implemented, the Test column names a test that fails without the behaviour, and that test passes in CI on Windows and Linux) |
| Test | Repo-relative path of the test(s) that prove the requirement, separated by `;` when there are several. Empty until the requirement is `done` or `in progress` with a partial test |

Status is changed only in the PR that merges the behaviour (see "Definition of done" in
`AGENTS.md`). Marking a row `done` without a test path is a CI failure.

## A. Projects and onboarding

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| A.1 | Create a project from the dashboard: name, goal, paste-in brief of any length, file uploads, link repo. | 1 | done | apps/ui/test/home.test.tsx; packages/runtime/test/daemon.test.ts; packages/runtime/test/data-routes.test.ts; packages/runtime/test/closeout-projects.test.ts |
| A.2 | PM agent turns the brief into docs, milestones, tasks and a first-session plan, then shows it for approval. | 1 | todo | |
| A.3 | Import from ZIP, local folder or existing GitHub repo. The original is preserved untouched; migration runs on a branch. | 1 | in progress | packages/runtime/test/data-import.test.ts; packages/runtime/test/data-routes.test.ts; packages/runtime/test/data-wiring.test.ts |
| A.4 | Source discovery: the user connects any sources (GitHub orgs or accounts, chosen repos, local folders; other git hosts later). A scan lists what is there, proposes a project for each repo or folder, detects an existing Forerunner install, and never creates duplicates. Sources can be added, rescanned or removed at any time. | 1 | todo | |
| A.5 | Guided setup wizard: each credential request says what, why, exact scopes, where to click, and how it will be verified. Validates on paste. | 0 | done | packages/runtime/test/setup-validators.test.ts; packages/runtime/test/cli.test.ts; packages/runtime/test/closeout-setup.test.ts |
| A.6 | Every project has a cached one-screen summary (goal, stage, last session, next 3 steps, open questions, spend), refreshed at session end and readable aloud. | 1 | done | packages/runtime/test/session.test.ts; apps/ui/test/project.test.tsx; packages/runtime/test/daemon.test.ts; packages/runtime/test/closeout-sessions.test.ts; packages/runtime/test/closeout-projects.test.ts |

## B. Tasks, milestones and workflow

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| B.1 | Projects hold stages, milestones and tasks with dependencies and priorities. | 1 | done | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; apps/ui/test/project-tabs.test.tsx |
| B.2 | Each task has an outcome, acceptance criteria, risk tier, budget and owner. | 1 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| B.3 | Workflow: draft → ready → claimed → in progress → in review → done. Side exits: needs human, failed, cancelled. | 1 | done | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/state/test/schema.test.ts; apps/ui/test/tasks.test.tsx |
| B.4 | A task cannot close with open findings or failed required checks. | 3 | done | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/critic/test/followup.test.ts; packages/runtime/test/loop-critic.test.ts; packages/runtime/test/loop-routes.test.ts |
| B.5 | Every change to plan, task or milestone is versioned with author and reason. | 1 | in progress | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| B.6 | Small-project mode: one milestone, flat task list, critic tier 0 by default. | 1 | done | packages/runtime/test/small-project.test.ts; packages/commands/test/small-project.test.ts; apps/ui/test/small-project.test.tsx |
| B.7 | A clear task log per project: filterable table of every task and run with who did it, cost, verdict, and links to PR and review. | 1 | done | apps/ui/test/tasks.test.tsx; packages/runtime/test/daemon.test.ts; apps/ui/test/project-tabs.test.tsx |

## C. Agents and specialists

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| C.1 | Principal agents are PMs: they plan, write task briefs, pick specialists, integrate results, and own coherence. | 1 | done | packages/runtime/test/registry.test.ts; packages/runtime/test/session.test.ts; packages/runtime/test/executor.test.ts; packages/runtime/test/brief.test.ts; packages/runtime/test/closeout-sessions.test.ts |
| C.2 | Delegation brief template is enforced (goal, context links, constraints, acceptance criteria, budget, risk tier); briefs missing fields are rejected by the runtime. | 1 | done | packages/runtime/test/brief.test.ts; packages/runtime/test/executor.test.ts |
| C.3 | Starting specialists: coder, tester, reviewer, researcher, science evaluator, designer, writer/marketing, data analyst, migration specialist, ops/deploy. | 1 | done | packages/runtime/test/registry.test.ts |
| C.4 | Specialists are files in `forerunner-registry`: role prompt, default model and effort, allowed tools, max budget, eval set. | 1 | done | packages/runtime/test/registry.test.ts; evals/test/eval-sets.test.ts; packages/runtime/test/cc-tools-wiring.test.ts; packages/runtime/test/registry-tools.test.ts |
| C.5 | PM can propose a new specialist; it goes live only after human approval and passing its eval set. | 3 | in progress | packages/runtime/test/registry.test.ts |
| C.6 | Sub-agents can spawn sub-agents, capped by depth (default 2) and by the parent's remaining budget. | 1 | done | packages/runtime/test/token.test.ts; packages/runtime/test/executor.test.ts; packages/runtime/test/closeout-executor.test.ts; packages/runtime/test/closeout-sessions.test.ts |
| C.7 | Solo mode: one principal agent, no peer. Paired mode: two or more peers. | 1 | done | packages/runtime/test/session.test.ts; packages/capabilities/test/phase2-gate.integration.test.ts; packages/runtime/test/closeout-sessions.test.ts |

## D. Models: selection, configuration, monitoring

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| D.1 | Model ladder per provider, ranked by capability and cost; tasks get a starting rung from their tier. | 1 | done | packages/runtime/test/ladder.test.ts; packages/runtime/test/registry.test.ts |
| D.2 | Retry policy: 1st failure → improve brief and add context; 2nd → split task or change specialist; 3rd → escalate one rung, if under the ceiling; then human. | 3 | done | packages/runtime/test/ladder.test.ts; packages/critic/test/followup.test.ts; packages/runtime/test/loop-critic.test.ts; tests/e2e/scenarios/phase3-gate.integration.test.ts |
| D.3 | Escalation ceiling and per-escalation cost cap set per project. | 3 | done | packages/runtime/test/ladder.test.ts; packages/critic/test/model.test.ts; packages/runtime/test/loop-critic.test.ts; tests/e2e/scenarios/phase3-gate.integration.test.ts |
| D.4 | Settings per agent and specialist: model, effort, max tokens, speed mode, timeout, with the defaults from the effort table (D.8 to D.15). Temperature appears only for providers that accept it. | 1 | in progress | packages/runtime/test/registry.test.ts; packages/runtime/test/anthropic-provider.test.ts |
| D.5 | Every run stores model, version, settings and prompt version. | 1 | done | packages/runtime/test/executor.test.ts; packages/state/test/suite.ts; packages/runtime/test/loop.test.ts; packages/critic/test/run-row.test.ts |
| D.6 | Weekly model watch: checks provider model lists and pricing, runs the eval set on new candidates, proposes a switch with measured quality and cost deltas. Human approves. | 7 | done | packages/runtime/test/model-watch.test.ts; packages/runtime/test/wiring.test.ts; apps/ui/test/updates.test.tsx; packages/runtime/test/model-config-wiring.test.ts; tests/e2e/scenarios/phase7-gate.integration.test.ts |
| D.7 | Effort rule: the lowest effort that passes the task's checks. Each mode has a response-time target that the UI measures and shows (D.8 to D.15). | 1 | in progress | packages/runtime/test/ladder.test.ts; packages/runtime/test/model-watch.test.ts; apps/ui/test/chat.test.tsx; apps/ui/test/performance.test.tsx |
| D.8 | Voice chat: default Haiku 5.5, effort low, first audio under 1.2 s. | 5 | in progress | packages/voice/test/loop.test.ts; packages/voice/test/latency.test.ts; tests/live/test/live-2-timing.live.test.ts |
| D.9 | Text chat: default Haiku 5.5 (Sonnet 5.5 if the question needs it), effort low, first token under 1 s. | 1 | in progress | packages/runtime/test/conversation.test.ts; packages/capabilities/test/phase1-gate.integration.test.ts; apps/ui/test/chat.test.tsx; tests/live/test/live-2-timing.live.test.ts; tests/live/test/live-1-phase1.live.test.ts |
| D.10 | Routing, triage, summaries: default Haiku 5.5, effort low, response under 3 s. | 1 | in progress | packages/runtime/test/ladder.test.ts; tests/live/test/live-2-timing.live.test.ts |
| D.11 | Session planning (PM): default Sonnet 5.5 (Opus 5.5 on large projects), effort high, response under 60 s. | 1 | in progress | packages/runtime/test/ladder.test.ts; packages/runtime/test/registry.test.ts; tests/live/test/live-2-timing.live.test.ts; tests/live/test/live-1-phase1.live.test.ts |
| D.12 | Coding specialist: default Sonnet 5.5, effort medium (high at tier 2+), time set by task budget and timeout. | 1 | done | packages/runtime/test/ladder.test.ts; packages/runtime/test/registry.test.ts; packages/runtime/test/executor.test.ts; tests/live/test/live-1-phase1.live.test.ts; tests/live/test/live-4-subscription.live.test.ts |
| D.13 | Research specialist: default Sonnet 5.5 or Opus 5.5, effort high, time set by task budget and timeout. | 3 | done | packages/runtime/test/registry.test.ts; packages/runtime/test/ladder.test.ts |
| D.14 | Critic tier 1: default Sonnet 5.5, effort medium, response under 30 s. | 3 | in progress | packages/runtime/test/ladder.test.ts; packages/critic/test/model.test.ts; tests/live/test/live-3-phase3.live.test.ts |
| D.15 | Critic tier 2 and 3: default Opus 5.5, effort high or max, time set by task budget. | 3 | in progress | packages/runtime/test/ladder.test.ts; packages/critic/test/model.test.ts |
| D.16 | Each project has a speed-versus-quality slider that shifts every default effort up or down one step. | 5 | in progress | packages/runtime/test/ladder.test.ts; packages/critic/test/model.test.ts |
| D.17 | Every run has a wall-clock timeout. On timeout it stops cleanly, saves partial output, and the PM decides what next. | 1 | done | packages/runtime/test/loop.test.ts; packages/runtime/test/closeout-executor.test.ts; packages/runtime/test/closeout-sessions.test.ts |
| D.18 | All replies stream. Long runs show progress events, never a silent spinner. | 1 | done | packages/runtime/test/conversation.test.ts; packages/runtime/test/loop.test.ts; apps/ui/test/session.test.tsx |
| D.19 | Each run records time to first token and total time. The Performance view shows these per mode against target. | 1 | in progress | packages/runtime/test/conversation.test.ts; apps/ui/test/chat.test.tsx; apps/ui/test/performance.test.tsx; packages/runtime/test/executor.test.ts; packages/runtime/test/loop.test.ts; packages/critic/test/run-row.test.ts |
| D.20 | Opus fast mode (research preview, API only, priced separately) can be enabled per project for urgent work. | 1 | todo | |
| D.21 | The model watch also tests lower effort levels on the eval set, since a cheaper effort that passes is a free saving. | 7 | done | packages/runtime/test/model-watch.test.ts; tests/e2e/scenarios/phase7-gate.integration.test.ts |

## E. Sessions

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| E.1 | Session triggers: manual start, schedule, new message or human answer, CI result, PR comment, verified email from the owner (module T). | 1 | in progress | packages/runtime/test/session.test.ts; packages/runtime/test/daemon.test.ts; packages/capabilities/test/email-commands.test.ts; services/cloud-runner/test/inbox-trigger.test.ts; services/cloud-runner/test/email-watch.test.ts; tests/e2e/scenarios/01-good-day.scenario.test.ts; tests/e2e/scenarios/02-email-task.scenario.test.ts |
| E.2 | Fixed startup checklist run by code, not the model: version check, git fetch, pull shared state, inbox, open human requests, critic findings, budget, diff since last session. Output is a compact state brief handed to the agent. | 1 | done | packages/runtime/test/session.test.ts; packages/runtime/test/loop-memory.test.ts; packages/runtime/test/runner-queue.test.ts; packages/runtime/test/checklist-queue.test.ts |
| E.3 | Agent writes a session plan with cost estimate before acting. Plans over budget are cut before starting. | 1 | done | packages/runtime/test/session.test.ts |
| E.4 | Inbox re-checked between every task and before any write to shared state. | 2 | in progress | packages/runtime/test/session.test.ts; tests/e2e/scenarios/01-good-day.scenario.test.ts; tests/e2e/scenarios/04-collision.scenario.test.ts; packages/runtime/test/closeout-sessions.test.ts |
| E.5 | Session end: update docs, task states, memory, project summary and cost ledger; send handoff message to peer; notify human. | 1 | done | packages/runtime/test/session.test.ts; packages/runtime/test/acks.test.ts; packages/runtime/test/loop-memory.test.ts; packages/runtime/test/loop-critic.test.ts; packages/runtime/test/notifications.test.ts; packages/runtime/test/notifications-channels.test.ts; packages/runtime/test/notifications-wiring.test.ts |

## F. Collaboration, messaging and sync

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| F.1 | Inbox per agent and per human. Messages are typed and structured. | 2 | done | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; services/state-api/test/routes.test.ts |
| F.2 | Receipts: delivered, read, acted on. Unacknowledged `requires_ack` messages resurface at the sender's next session. | 2 | done | packages/runtime/test/acks.test.ts; packages/state/test/suite.ts; services/state-api/test/routes.test.ts |
| F.3 | Realtime push when both are online; polling fallback. | 2 | done | services/state-api/test/realtime.test.ts; apps/ui/test/sse.test.ts |
| F.4 | Claim-before-work on every task. Claims expire. | 2 | done | packages/runtime/test/session.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/capabilities/test/phase2-gate.integration.test.ts |
| F.5 | Code changes only via branches and PRs. Agent rebases before PR; conflicts it cannot resolve become a human request. | 2 | done | packages/capabilities/test/pr-executor.test.ts; packages/capabilities/test/git.test.ts; packages/capabilities/test/phase1-gate.integration.test.ts |
| F.6 | Peer awareness: at startup and between tasks, the agent reads a short "what the other is doing" feed (active claims, open PRs, last handoff). Overlap detection on files and tasks triggers a message before work starts. | 2 | done | packages/runtime/test/peers.test.ts; packages/runtime/test/daemon.test.ts; apps/ui/test/project-tabs.test.tsx; tests/e2e/scenarios/04-collision.scenario.test.ts; packages/runtime/test/session.test.ts |
| F.7 | Handoff note at every session end: done, in flight, blocked, next. | 1 | done | packages/runtime/test/session.test.ts; packages/runtime/test/peers.test.ts; packages/runtime/test/acks.test.ts; tests/e2e/scenarios/04-collision.scenario.test.ts; tests/e2e/scenarios/08-handover.scenario.test.ts; packages/runtime/test/closeout-sessions.test.ts |

## G. Memory, documentation and learning

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| G.1 | Three memory scopes: private agent memory, critic memory, shared lessons. Plus project docs in git. Never mixed. | 4 | done | packages/memory/test/scopes.test.ts; packages/runtime/test/loop-memory.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/memory.test.tsx |
| G.2 | Memory unit is a Lesson with source, tags, confidence and usage count. | 4 | done | packages/memory/test/record.test.ts; packages/memory/test/files.test.ts; packages/memory/test/retrieval.test.ts; packages/memory/test/closeout-memory.test.ts; apps/ui/test/memory.test.tsx |
| G.3 | Retrieval by relevance (tags + vector search), capped at a token budget per session. | 4 | done | packages/memory/test/retrieval.test.ts; packages/runtime/test/loop-memory.test.ts; tests/e2e/scenarios/phase4-gate.integration.test.ts |
| G.4 | Weekly consolidation job merges duplicates, flags contradictions, retires unused lessons. Changes are shown to the human for review. | 4 | done | packages/memory/test/consolidation.test.ts; packages/runtime/test/loop-memory.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/memory.test.tsx; tests/e2e/scenarios/phase4-gate.integration.test.ts |
| G.5 | Standard project doc set: `README`, `docs/overview.md`, `architecture.md`, `status.md`, `decisions/` (ADRs), `runbook.md`, `data.md`, `testing.md`. PM keeps them current; critic checks drift. | 4 | in progress | packages/memory/test/docs.test.ts; packages/critic/test/docs-drift.test.ts; packages/runtime/test/loop-critic.test.ts; apps/ui/test/project-tabs.test.tsx |
| G.6 | Cross-project sharing: lessons tagged as general are promoted to the shared store after critic approval and offered to other projects. | 4 | in progress | packages/memory/test/promotion.test.ts |
| G.7 | Reference design: aerovato/operator-memory, studied in sprint 1 with an ADR on what to adopt. | 0 | done | packages/memory/test/retrieval.test.ts; packages/memory/test/closeout-memory.test.ts |

## H. Critic

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| H.1 | Independent reviewer: a different model, or at least a clean context with no access to the worker's reasoning. | 3 | done | packages/critic/test/critic.test.ts; packages/runtime/test/loop-critic.test.ts |
| H.2 | Risk tiers set review depth: 0 = automated checks only, 1 = light read, 2 = full review with tests run, 3 = deep review plus human sign-off. | 3 | done | packages/critic/test/critic.test.ts; packages/critic/test/tier0.test.ts; packages/critic/test/rules.test.ts; packages/runtime/test/loop-critic.test.ts; packages/runtime/test/signoff-answer.test.ts; packages/runtime/test/approvals-poll.test.ts |
| H.3 | Output: grade 0–100, confidence, findings with severity, verdict, evidence links. | 3 | done | packages/critic/test/critic.test.ts; packages/critic/test/schema.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/reviews.test.tsx |
| H.4 | Low confidence never becomes accept. It becomes escalate or human. | 3 | done | packages/critic/test/rules.test.ts; packages/critic/test/critic.test.ts; packages/critic/test/evidence.test.ts |
| H.5 | Findings are tracked to resolution. Repeat findings across sessions are flagged as patterns and turned into lessons. | 3 | done | packages/critic/test/critic.test.ts; packages/critic/test/fingerprint.test.ts; packages/state/test/suite.ts; packages/runtime/test/loop-critic.test.ts; apps/ui/test/reviews.test.tsx; tests/e2e/scenarios/phase4-gate.integration.test.ts |
| H.6 | Session-level review grades plan quality, cost efficiency and honesty of the summary to the human. | 3 | done | packages/critic/test/session-review.test.ts; packages/runtime/test/loop-critic.test.ts |
| H.7 | Calibration: the critic grades the golden eval set monthly so drift is visible. | 3 | in progress | packages/critic/test/calibration.test.ts; tests/e2e/scenarios/phase3-gate.integration.test.ts; tests/live/test/live-3-phase3.live.test.ts |

## I. Budget and cost

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| I.1 | Hard caps at month, project, session, task and run level, enforced by the runtime before each call. Caps apply to API spend in CHF and to subscription usage as a share of the plan's limit. | 1 | done | packages/billing/test/caps.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/billing-ports.test.ts; packages/runtime/test/subscription-path.test.ts; tests/live/test/live-4-subscription.live.test.ts |
| I.2 | Step cap and wall-clock cap per session. | 1 | done | packages/runtime/test/budget.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/loop.test.ts |
| I.3 | Estimate before every run; actual recorded after. Estimate error tracked per specialist and task type. | 1 | done | packages/billing/test/estimates.test.ts; packages/runtime/test/estimates.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/wiring.test.ts; apps/ui/test/performance.test.tsx |
| I.4 | 15 to 25% of the session budget reserved for review and fixes by default. | 1 | done | packages/runtime/test/budget.test.ts; packages/billing/test/caps.test.ts |
| I.5 | At 80% of a cap: finish the current task, no new work. At 100%: stop and ask. | 1 | done | packages/billing/test/caps.test.ts; packages/runtime/test/budget.test.ts; packages/runtime/test/session.test.ts; tests/e2e/scenarios/05-budget.scenario.test.ts |
| I.6 | Allocation view: spend by specialist, model, task and project; success rate and cost per accepted task. | 1 | done | packages/billing/test/ledger.test.ts; packages/state/test/suite.ts; apps/ui/test/project.test.tsx; apps/ui/test/project-tabs.test.tsx |
| I.7 | Token savings from compression and caching shown separately. | 6 | done | packages/billing/test/ledger.test.ts; packages/runtime/test/views.test.ts; packages/runtime/test/executor-context.test.ts; apps/ui/test/project.test.tsx |

## J. Human interaction

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| J.1 | Quick chat per project: read-only by default, fast model plus project summary and docs search. Voice works here too (module O). A "make this a task" button turns a chat message into a draft task. | 1 | in progress | packages/runtime/test/conversation.test.ts; apps/ui/test/chat.test.tsx; apps/approvals-web/test/chat.test.tsx |
| J.2 | Next-session queue: notes, tasks, corrections, ideas, each with priority and type. Voice notes supported. | 5 | done | packages/state/test/suite.ts; services/state-api/test/routes.test.ts; packages/runtime/test/conversation.test.ts; apps/ui/test/project-tabs.test.tsx; packages/runtime/test/runner-queue.test.ts; packages/runtime/test/checklist-queue.test.ts; packages/commands/test/commands.test.ts; packages/commands/test/intent.test.ts |
| J.3 | Human requests: one inbox across projects. Each has context, why it matters, options (multiple choice when possible), and whether it blocks work. | 2 | done | services/state-api/test/routes.test.ts; packages/state/test/suite.ts; apps/ui/test/inbox.test.tsx; apps/approvals-web/test/inbox.test.tsx; packages/runtime/test/notifications-wiring.test.ts; tests/e2e/scenarios/phase5-gate.integration.test.ts; packages/runtime/test/signoff-answer.test.ts; packages/runtime/test/approvals-poll.test.ts |
| J.4 | Answered decisions go to the Decision log and are never asked again unless superseded. | 2 | done | packages/runtime/test/decisions.test.ts; packages/runtime/test/daemon.test.ts; services/state-api/test/routes.test.ts; packages/state/test/suite.ts; apps/approvals-web/test/inbox.test.tsx; apps/ui/test/project-tabs.test.tsx |
| J.5 | Autonomy levels per project (J.6 to J.10), enforced in code. | 5 | done | packages/runtime/test/autonomy.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/session.test.ts |
| J.6 | Level 0 Advisor: plans and proposes only. | 5 | done | packages/runtime/test/session.test.ts; packages/runtime/test/autonomy.test.ts |
| J.7 | Level 1 Assisted: acts after approval of each plan. | 5 | in progress | packages/runtime/test/autonomy.test.ts; packages/runtime/test/closeout-autonomy.test.ts |
| J.8 | Level 2 Standard: routine reversible actions free, everything else approved. Default. | 5 | done | packages/runtime/test/autonomy.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/loop.test.ts |
| J.9 | Level 3 Trusted: also merges reviewed PRs and deploys to staging. | 5 | in progress | packages/runtime/test/autonomy.test.ts; packages/capabilities/test/cloudflare-client.test.ts; packages/capabilities/test/cloudflare-deploy.test.ts; packages/capabilities/test/cloudflare-hooks.test.ts; packages/capabilities/test/cloudflare-tools.test.ts; packages/capabilities/test/cloudflare-wiring.test.ts |
| J.10 | Level 4 Autopilot: everything except destructive, financial and credential actions. | 5 | done | packages/runtime/test/autonomy.test.ts; packages/runtime/test/hooks.test.ts; packages/capabilities/test/cloudflare-wiring.test.ts |

## K. Interface

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| K.1 | Home: all projects as cards with stage, next milestone, health, spend vs budget, waiting-on-you count, latest critic grade. | 1 | done | apps/ui/test/home.test.tsx; packages/runtime/test/daemon.test.ts |
| K.2 | Project page tabs: Summary, Plan (milestone timeline + dependency graph), Tasks/log, Docs, Reviews, Costs, Data, Chat. | 1 | done | apps/ui/test/project.test.tsx; apps/ui/test/project-tabs.test.tsx; apps/ui/test/reviews.test.tsx; packages/runtime/test/data-routes.test.ts; packages/runtime/test/data-wiring.test.ts |
| K.3 | Live session view: readable event stream, current task and specialist, step count, running cost vs cap, escalations highlighted. Raw output behind a toggle. | 1 | done | apps/ui/test/session.test.tsx |
| K.4 | Inbox: human requests and agent messages, sorted by blocking first. | 2 | done | apps/ui/test/inbox.test.tsx; packages/runtime/test/daemon.test.ts; packages/state/test/suite.ts |
| K.5 | Memory: separate views for Alice, Bob, Critic and Shared lessons. Search, edit, delete, pin. | 4 | done | packages/runtime/test/loop-memory.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/memory.test.tsx |
| K.6 | Extensions panel: every connector, MCP server, skill, specialist, capability and model provider. Status, permissions, cost, version, toggle, remove, add from catalog or URL. | 6 | done | packages/runtime/test/extensions-routes.test.ts; packages/runtime/test/extensions-registry.test.ts; apps/ui/test/extensions.test.tsx |
| K.7 | Settings: global, per human, per agent, per project. Every setting shows its scope. | 1 | done | apps/ui/test/settings.test.tsx; packages/runtime/test/daemon.test.ts |
| K.8 | QoL: command palette, keyboard shortcuts, dark mode, desktop notifications, tray menu, Android app (module R) plus a web fallback for approvals. Active project always shown in the header. | 5 | in progress | apps/ui/test/shell.test.tsx; apps/approvals-web/test/shell.test.tsx; apps/approvals-web/test/app.test.tsx; apps/desktop/src-tauri/src/state.rs; apps/desktop/src-tauri/src/sse.rs; apps/desktop/src-tauri/src/dirs.rs; packages/runtime/test/notifications.test.ts; packages/runtime/test/notifications-channels.test.ts; packages/runtime/test/notifications-wiring.test.ts |

## L. Capabilities

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| L.1 | Files and data: upload, link folders, register large datasets by path or URI. Agents see metadata and samples, not whole files. Large data never goes into git; use LFS, R2 or the original location. | 5 | done | packages/runtime/test/data-assets.test.ts; packages/runtime/test/data-import.test.ts; packages/runtime/test/data-tools.test.ts; packages/runtime/test/data-routes.test.ts; packages/runtime/test/data-wiring.test.ts; services/state-api/test/routes.test.ts; packages/state/test/suite.ts; apps/ui/test/project-tabs.test.tsx |
| L.2 | Browser: Playwright with an isolated profile per agent. Site allowlist and blocklist. No purchases or credential entry without approval. | 6 | done | packages/capabilities/test/browser-profile.test.ts; packages/capabilities/test/browser-policy.test.ts; packages/capabilities/test/browser-guards.test.ts; packages/capabilities/test/browser-tools.test.ts; packages/capabilities/test/browser.integration.test.ts |
| L.3 | Email: follows the rules and user options of module S (agent email) and module T (email commands). | 6 | in progress | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-commands.test.ts |
| L.4 | Desktop control: off by default. Per-app allowlist. Screenshots logged. Always requires autonomy 3+. | 6 | done | packages/capabilities/test/desktop-gate.test.ts; packages/capabilities/test/desktop-controller.test.ts; packages/capabilities/test/desktop-tools.test.ts; packages/capabilities/test/desktop-routes.test.ts; packages/capabilities/test/desktop-wiring.test.ts; packages/runtime/test/desktop-wiring.test.ts |
| L.5 | Connectors: MCP servers installed from a catalog or URL, each reviewed and permissioned on install. | 6 | done | packages/runtime/test/extensions-registry.test.ts; packages/runtime/test/extensions-mcp.test.ts; packages/runtime/test/extensions-catalog.test.ts; apps/ui/test/extensions.test.tsx |
| L.6 | Voice: TTS for summaries and alerts, STT for voice notes. Pluggable provider. | 5 | in progress | packages/voice/test/sentences.test.ts; packages/voice/test/registry.test.ts |

## M. Self-improvement and updates

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| M.1 | Forerunner is a project in Forerunner. Feature requests and bugs go into its task list like any other. | 7 | done | tests/e2e/scenarios/phase7-gate.integration.test.ts |
| M.2 | Changes go through PR, tests in Docker, critic tier 2+, human approval. | 7 | done | packages/runtime/test/sandbox-container.test.ts; packages/capabilities/test/pr-executor.test.ts; packages/critic/test/critic.test.ts; tests/e2e/scenarios/phase7-gate.integration.test.ts |
| M.3 | Release channel: signed builds published to GitHub Releases. App shows "Update available", changelog, "Update and restart". | 7 | done | packages/runtime/test/update-verify.test.ts; packages/runtime/test/update-screen.test.ts; packages/runtime/test/update-install.test.ts; apps/desktop/src-tauri/src/restart.rs; apps/desktop/src-tauri/src/state.rs; apps/ui/test/updates.test.tsx; packages/runtime/test/update-githost.test.ts; tests/e2e/scenarios/phase7-gate.integration.test.ts |
| M.4 | Staged install, health check on restart, automatic rollback on failure. Config, memory and data untouched by updates. | 7 | done | packages/runtime/test/update-install.test.ts; apps/desktop/src-tauri/src/restart.rs; apps/desktop/src-tauri/src/daemon.rs; apps/ui/test/updates.test.tsx; packages/runtime/test/update-health.test.ts; tests/e2e/scenarios/07-bad-update.scenario.test.ts; tests/e2e/scenarios/phase7-gate.integration.test.ts |
| M.5 | Connector and model updates surface in the same updates screen. | 7 | done | packages/runtime/test/update-screen.test.ts; packages/runtime/test/wiring.test.ts; apps/ui/test/updates.test.tsx; packages/runtime/test/model-config-wiring.test.ts; tests/e2e/scenarios/phase7-gate.integration.test.ts |
| M.6 | Shared state schema changes use versioned migrations; both apps must be on a compatible version before sync resumes. | 2 | done | packages/state/test/schema.test.ts; services/state-api/test/auth.test.ts; services/state-api/test/main.test.ts; packages/runtime/test/update-screen.test.ts; packages/runtime/test/sync-gate.test.ts |

## N. Token efficiency

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| N.1 | Context compression proxy (Headroom or similar), toggle per project, savings measured. | 6 | done | packages/runtime/test/headroom.test.ts; packages/runtime/test/context.test.ts; packages/runtime/test/context-manager.test.ts; packages/runtime/test/session-context.test.ts; packages/runtime/test/executor-context.test.ts |
| N.2 | Prompt caching for stable system prompts and project briefs. | 1 | done | packages/runtime/test/context.test.ts; packages/runtime/test/anthropic-provider.test.ts |
| N.3 | State brief instead of raw history at session start. | 1 | done | packages/runtime/test/session.test.ts |
| N.4 | Retrieval over memory and docs with a token budget. | 4 | done | packages/memory/test/retrieval.test.ts; packages/runtime/test/context.test.ts; packages/runtime/test/loop-memory.test.ts; tests/e2e/scenarios/phase4-gate.integration.test.ts |
| N.5 | Cheap model for summaries, routing and quick chat. | 1 | done | packages/runtime/test/conversation.test.ts; packages/runtime/test/ladder.test.ts; packages/runtime/test/closeout-cheap-model.test.ts; packages/runtime/test/session.test.ts |

## O. Real-time conversation

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| O.1 | Talk to your agent at any time, by text or voice: in the app, from a global hotkey, or from the phone approvals page. | 5 | in progress | packages/runtime/test/conversation.test.ts; packages/runtime/test/daemon.test.ts; packages/runtime/test/voice-route.test.ts; packages/runtime/test/remote-watcher.test.ts; apps/approvals-web/test/chat.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| O.2 | A dedicated conversation agent answers. It runs on a fast model at low effort with a small cached context (project summaries, inbox, open requests, current session state). It speaks for your principal agent and writes to the same memory and logs. | 5 | in progress | packages/runtime/test/conversation.test.ts; packages/runtime/test/closeout-conversation.test.ts |
| O.3 | Voice loop: push-to-talk hotkey, or open mic with voice activity detection. Streaming STT; reply streamed sentence by sentence into streaming TTS. You can interrupt it mid-sentence by speaking. | 5 | done | packages/voice/test/loop.test.ts; packages/voice/test/vad.test.ts; packages/voice/test/sentences.test.ts; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| O.4 | Pluggable voice providers: local by default where the machine can manage it (faster-whisper for STT, Kokoro or Piper for TTS; free and private); cloud option for the lowest latency (Deepgram for STT, Cartesia or ElevenLabs for TTS). Chosen in the Extensions panel. | 5 | in progress | packages/voice/test/registry.test.ts; packages/voice/test/local-helpers.test.ts; packages/voice/test/cloud.test.ts; packages/voice/test/availability.test.ts; packages/runtime/test/voice-route.test.ts; packages/runtime/test/extensions-catalog.test.ts |
| O.5 | Latency budget: end of turn about 0.2 s, final transcript about 0.3 s, model first token about 0.5 s, first audio about 0.2 s. Target under 1.2 s to first audio. Each part is measured and shown. | 5 | done | packages/voice/test/latency.test.ts; packages/voice/test/loop.test.ts; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| O.6 | What it can do: answer questions, take notes into the next-session queue, create draft tasks, answer human requests, and start, pause or stop sessions. | 5 | done | packages/runtime/test/conversation.test.ts; packages/runtime/test/closeout-conversation.test.ts; packages/runtime/test/remote-pause.test.ts; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| O.7 | What needs a confirm step: approving anything above routine, and starting work over a set cost. It reads back the action and estimated cost and waits for "yes". Spoken approvals are logged with the transcript line. | 5 | done | packages/voice/test/approval.test.ts; packages/voice/test/loop.test.ts; packages/runtime/test/conversation.test.ts; tests/e2e/scenarios/phase5-gate.integration.test.ts; tests/e2e/scenarios/03-voice.scenario.test.ts |
| O.8 | Handoff: if a question needs real work, it says so, queues it for the principal agent, and the answer comes back through the inbox or a notification. | 5 | done | packages/runtime/test/closeout-conversation.test.ts; packages/runtime/test/conversation.test.ts; packages/runtime/test/session.test.ts; packages/runtime/test/notifications-wiring.test.ts; packages/runtime/test/notifications.test.ts |
| O.9 | During a live session, what you say reaches the principal agent at the next step boundary. Stopping is immediate. | 5 | in progress | packages/runtime/test/session.test.ts; packages/runtime/test/remote-pause.test.ts; packages/runtime/test/remote-wiring.test.ts; packages/runtime/test/closeout-conversation.test.ts; packages/runtime/test/conversation.test.ts; packages/runtime/test/voice-route.test.ts |
| O.10 | Transcripts are kept in session history. Audio is not stored unless turned on. | 5 | done | packages/voice/test/loop.test.ts |

## P. Maintainer documentation

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| P.1 | `AGENTS.md` at the repo root, with `CLAUDE.md` pointing to it: build, test and run commands for Windows and Linux, code layout, conventions, and the rules from the build prompt. | 0 | done | scripts/closeout-docs.test.ts |
| P.2 | `docs/maintainers/`, one file per area (P.3 to P.12). | 0 | in progress | scripts/closeout-docs.test.ts; scripts/docs-check.test.ts |
| P.3 | `architecture.md`: components, data flow, the diagram source. | 0 | done | scripts/closeout-docs.test.ts |
| P.4 | `data-model.md`: generated from the schema on every build. | 0 | done | packages/state/test/schema.test.ts |
| P.5 | `runtime.md`: hooks, budget, depth, autonomy and permission enforcement. | 1 | done | scripts/closeout-docs.test.ts |
| P.6 | `billing.md`: billing sources and routing, and what to change when provider rules change. | 1 | done | scripts/closeout-docs.test.ts |
| P.7 | `adding-a-specialist.md`, `adding-a-connector.md`, `adding-a-provider.md`, `adding-a-voice-provider.md`. | 1 | in progress | scripts/closeout-docs.test.ts |
| P.8 | `platform-notes.md`: Windows and Linux differences and known issues. | 0 | done | scripts/closeout-docs.test.ts |
| P.9 | `release.md`: signing, staged rollout, rollback. | 0 | done | scripts/closeout-docs.test.ts |
| P.10 | `migrations.md`: schema and memory-format migrations. | 0 | done | scripts/closeout-docs.test.ts; packages/state/test/schema.test.ts |
| P.11 | `security.md`: threat model and the injection test suite. | 1 | in progress | scripts/closeout-docs.test.ts |
| P.12 | `troubleshooting.md`: common failures and fixes. | 0 | done | scripts/closeout-docs.test.ts |
| P.13 | ADRs in `docs/decisions/` for every non-obvious choice. A changelog for every release. | 0 | in progress | scripts/closeout-docs.test.ts; scripts/release-notes.test.ts |
| P.14 | Docs stay true: CI fails a PR that changes a module without touching its doc, unless the PR says "docs: none needed" with a reason. Schema docs are generated. A link checker runs. The critic checks doc drift at tier 2+. | 0 | done | scripts/docs-check.test.ts; scripts/closeout-docs.test.ts; packages/state/test/schema.test.ts; packages/critic/test/docs-drift.test.ts |
| P.15 | Handover test: monthly, a fresh agent with only the repo and docs makes a small seeded change. Where it gets stuck becomes a docs task. | 8 | in progress | tests/e2e/scenarios/08-handover.scenario.test.ts |

## Q. Natural-language control

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| Q.1 | One command registry: every action is a typed command with parameters, validation, a risk level and an undo (`project.switch`, `budget.set`, `autonomy.set`, `session.start`, `capability.grant`, `specialist.add`, and so on). Buttons, the command palette, the API, chat, voice and email all call these, so nothing is chat-only and nothing is UI-only. | 5 | done | packages/commands/test/registry.test.ts; packages/runtime/test/conversation.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/settings.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts; packages/runtime/test/loop-commands.test.ts |
| Q.2 | Understanding: the conversation agent turns what you say into one or more commands ("Work on the supplement site now and give it 20 francs tonight" becomes `project.switch` plus a temporary `budget.set` that reverts at 06:00). If something is unclear, it asks one short question with options. | 5 | done | packages/commands/test/intent.test.ts; packages/runtime/test/conversation.test.ts |
| Q.3 | Context: there is always an active project, shown in the header on every screen. "Switch to PharmaWatch", "go back" and "what was I doing on the game?" work. Commands without a named project apply to the active one, and the confirmation says so. | 5 | done | packages/commands/test/commands.test.ts; packages/runtime/test/conversation.test.ts; packages/runtime/test/loop-routes.test.ts |
| Q.4 | Change card: before any change, it shows a card and says it out loud in voice mode: what changes, old value → new value, scope (this session, this project, everything), how long (until reverted, until a time, permanent), cost or risk impact, and how to undo. | 5 | done | packages/commands/test/change-card.test.ts; packages/runtime/test/conversation.test.ts; apps/ui/test/settings.test.tsx |
| Q.5 | Confirmation by risk: every command confirms according to its risk level (Q.6 to Q.8). | 5 | done | packages/commands/test/confirmation.test.ts; packages/runtime/test/conversation.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/settings.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| Q.6 | Low risk (switch project, rename, reorder tasks, add a note): acts at once, then states what it did, with undo. | 5 | done | packages/commands/test/executor.test.ts; packages/runtime/test/conversation.test.ts; apps/ui/test/client.test.ts |
| Q.7 | Medium risk (raise a budget within the hard ceiling, change autonomy by one step, start a costly session): change card, then a "yes", a tap, or an email reply. | 5 | done | packages/commands/test/executor.test.ts; packages/runtime/test/conversation.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/settings.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| Q.8 | High risk (raise the monthly hard ceiling, grant a capability, change email mode, delete anything, change permissions): change card, then confirmation in the app on a paired device, with biometric on the phone. A chat or email "yes" alone is not enough. | 5 | done | services/state-api/test/auth.test.ts; apps/approvals-web/test/inbox.test.tsx; packages/runtime/test/conversation.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/settings.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts; tests/e2e/scenarios/09-phone.scenario.test.ts |
| Q.9 | Bespoke requests: if no single command fits, the agent builds a plan from existing commands and shows it as one change card. If no commands can do it, it offers to create a Forerunner task to add the feature. | 5 | done | packages/commands/test/executor.test.ts; packages/commands/test/scenario.test.ts; packages/runtime/test/conversation.test.ts |
| Q.10 | Spelled out every time: every change made by conversation is posted to the activity log and the project chat as a plain sentence with Undo (for example "Raised tonight's session budget for PharmaWatch from CHF 5 to CHF 20, until 06:00. Undo."). The other human sees changes that affect shared projects. | 5 | done | packages/commands/test/executor.test.ts; packages/commands/test/commands.test.ts; packages/runtime/test/conversation.test.ts; apps/ui/test/changes.test.tsx |
| Q.11 | Change log: every change has who asked, the words used, the commands run, before and after values, and a one-click undo while it is still reversible. | 5 | done | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/commands/test/executor.test.ts; packages/runtime/test/loop-routes.test.ts; packages/runtime/test/loop-commands.test.ts; apps/ui/test/changes.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| Q.12 | Limits still hold: conversation changes go through the same enforcement as the settings screen. The agent cannot raise its own limits without your confirmation, and it never treats text from web pages, files or other people's email as a request. | 5 | done | packages/runtime/test/conversation.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/injection.test.ts; evals/test/injection.test.ts; packages/commands/test/intent.test.ts; packages/runtime/test/loop-routes.test.ts; apps/ui/test/settings.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts |

## R. Android app

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| R.1 | Build: Tauri 2 Android target sharing the desktop React UI and TypeScript packages. Signed APK for sideloading, plus a Play Store internal track later. Updates through the same release channel. | 5 | in progress | apps/mobile/src-tauri/src/dirs.rs; apps/mobile/src-tauri/src/config.rs; apps/mobile/e2e/run.mjs; scripts/android-keystore.test.ts; packages/runtime/test/update-install.test.ts |
| R.2 | Pairing: scan a QR code from the desktop app. Each device gets its own key, listed in Settings → Devices, and can be revoked at once. | 5 | in progress | apps/ui/test/mobile-pairing.test.tsx; apps/ui/test/state-client.test.ts; apps/ui/e2e/mobile-pairing.spec.ts; apps/mobile/src-tauri/src/config.rs; services/state-api/test/auth.test.ts; packages/state/test/suite.ts |
| R.3 | Sync: reads and writes the shared state service directly. Works offline and queues actions until it reconnects. | 5 | done | apps/ui/test/mobile-store.test.ts; apps/ui/test/state-sse.test.ts; apps/ui/test/mobile-remote.test.tsx; apps/ui/test/state-client.test.ts; services/state-api/test/outbox.test.ts |
| R.4 | Remote control: start, pause and stop sessions on your PC or on the cloud runner. Commands go through the state service, and the PC or runner picks them up in seconds. Watch the live session log. | 5 | done | apps/ui/test/mobile-remote.test.tsx; apps/ui/test/mobile-change-card.test.ts; apps/ui/e2e/mobile-remote.spec.ts; apps/ui/test/state-client.test.ts; services/state-api/test/remote.test.ts; services/state-api/test/realtime.test.ts; services/cloud-runner/test/remote.test.ts; services/cloud-runner/test/runner.test.ts; packages/runtime/test/remote-watcher.test.ts; packages/runtime/test/remote-pause.test.ts; packages/runtime/test/remote-wiring.test.ts; packages/runtime/test/remote-presence.test.ts; packages/state/test/suite.ts; apps/ui/test/mobile-session.test.tsx; apps/ui/test/mobile-changes.test.tsx; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| R.5 | Contribute: chat and voice with your agent (module O). Natural-language control (module Q). Add notes, tasks and ideas. Upload photos, files and documents to a project. Review PRs and critic findings, comment, approve or reject. Answer human requests. | 5 | in progress | apps/ui/test/mobile-chat.test.tsx; apps/ui/test/mobile-inbox.test.tsx; apps/ui/test/mobile-intent.test.ts; apps/ui/test/mobile-store.test.ts; apps/ui/e2e/mobile-inbox.spec.ts; services/state-api/test/routes.test.ts; tests/e2e/scenarios/phase5-gate.integration.test.ts |
| R.6 | Notifications: push for approvals, finished sessions, budget warnings and messages, with quiet hours. | 5 | in progress | apps/ui/test/mobile-settings.test.tsx; apps/ui/test/mobile-store.test.ts; apps/ui/test/mobile-inbox.test.tsx; apps/mobile/src-tauri/src/push.rs; packages/runtime/test/notifications.test.ts; packages/runtime/test/notifications-channels.test.ts; packages/runtime/test/notifications-wiring.test.ts |
| R.7 | Security: biometric unlock for the app and for high-risk confirmations. No secrets or private memory stored on the phone; it uses scoped session tokens. Lost phone: revoke from desktop. | 5 | done | apps/ui/test/state-signing.test.ts; apps/ui/test/mobile-inbox.test.tsx; apps/ui/test/mobile-store.test.ts; apps/ui/test/mobile-settings.test.tsx; apps/ui/e2e/mobile-inbox.spec.ts; apps/mobile/src-tauri/src/keystore.rs; apps/mobile/src-tauri/src/commands.rs; services/state-api/test/auth.test.ts; apps/ui/test/mobile-shell-signer.test.ts; tests/e2e/scenarios/phase5-gate.integration.test.ts; tests/e2e/scenarios/09-phone.scenario.test.ts |
| R.8 | Heavy work stays off the phone: agents run on the PC or the cloud runner. The phone controls, contributes and reviews. | 5 | done | apps/ui/test/mobile-remote.test.tsx; apps/ui/test/mobile-chat.test.tsx; services/state-api/test/remote.test.ts; services/cloud-runner/test/runner.integration.test.ts; packages/runtime/test/remote-watcher.test.ts; packages/runtime/test/remote-wiring.test.ts |

## S. Security, permissions and email

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| S.1 | All limits are enforced by the runtime in tool hooks. A prompt can ask; only code can allow. | 1 | done | packages/runtime/test/hooks.test.ts; packages/runtime/test/loop.test.ts; packages/runtime/test/extensions-gate.test.ts; packages/runtime/test/cc-tools-wiring.test.ts; packages/runtime/test/registry-tools.test.ts |
| S.2 | Content is data, not instructions: web pages, emails, repo files, issue comments and other agents' outputs can never grant permissions or change goals. Instructions found there are quoted to the human. | 1 | done | packages/runtime/test/injection.test.ts; packages/runtime/test/loop.test.ts; packages/runtime/test/hooks.test.ts; packages/capabilities/test/browser-extract.test.ts; services/state-api/test/mirror.test.ts; evals/test/injection.test.ts |
| S.3 | Capability tokens: each run gets a token listing its allowed tools, paths, domains, secrets and budget. The hook rejects anything outside it. | 1 | done | packages/runtime/test/token.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/executor.test.ts; packages/runtime/test/cc-tools-wiring.test.ts; packages/runtime/test/registry-tools.test.ts |
| S.4 | Secrets by reference: agents ask for `secret:github_pat`; the runtime injects it into the tool call. Values never enter model context, logs or git. Logs are scanned and redacted. | 1 | done | packages/vault/test/refs.test.ts; packages/vault/test/no-leak.test.ts; packages/runtime/test/hooks.test.ts; packages/platform/test/log.test.ts; scripts/secret-scan.test.ts |
| S.5 | Least privilege: GitHub fine-grained PAT or GitHub App scoped to the orgs and repos the user selects. Cloudflare token scoped to named zones and Workers. Each grant shows its scopes in the Extensions panel. | 0 | done | packages/runtime/test/setup-validators.test.ts; packages/runtime/test/extensions-registry.test.ts; packages/runtime/test/closeout-security.test.ts; apps/ui/test/extensions.test.tsx; packages/capabilities/test/cloudflare-client.test.ts; packages/capabilities/test/cloudflare-deploy.test.ts; packages/capabilities/test/cloudflare-hooks.test.ts; packages/capabilities/test/cloudflare-tools.test.ts; packages/capabilities/test/cloudflare-wiring.test.ts |
| S.6 | Always needs a human, at any autonomy level: deleting repos or data, force-pushing to main, spending real money, sharing secrets, changing permissions, granting a new capability, sending money, entering passwords on third-party sites. | 1 | done | packages/runtime/test/autonomy.test.ts; packages/runtime/test/hooks.test.ts; packages/capabilities/test/git.test.ts; packages/capabilities/test/browser-guards.test.ts; packages/capabilities/test/cloudflare-client.test.ts; packages/capabilities/test/cloudflare-deploy.test.ts; packages/capabilities/test/cloudflare-hooks.test.ts; packages/capabilities/test/cloudflare-tools.test.ts; packages/capabilities/test/cloudflare-wiring.test.ts |
| S.7 | Sandboxing: code runs in Docker with only the task's worktree mounted and a network allowlist. | 1 | done | packages/runtime/test/sandbox-container.test.ts; packages/runtime/test/sandbox-egress.test.ts; packages/runtime/test/sandbox-factory.test.ts; packages/runtime/test/sandbox.integration.test.ts |
| S.8 | Kill switch: tray and UI button stops all sessions for one agent or everyone, revokes run tokens, and freezes claims. | 1 | done | packages/runtime/test/killswitch.test.ts; packages/runtime/test/closeout-security.test.ts; packages/runtime/test/daemon.test.ts; packages/capabilities/test/phase1-gate.integration.test.ts; packages/runtime/test/cli.test.ts; apps/ui/test/shell.test.tsx; apps/desktop/src-tauri/src/state.rs; packages/runtime/test/notifications.test.ts; packages/runtime/test/notifications-channels.test.ts; packages/runtime/test/notifications-wiring.test.ts; packages/runtime/test/loop-commands.test.ts |
| S.9 | Audit log: append-only record of every tool call (who, what, when, cost, result). Exportable. | 1 | done | packages/state/test/suite.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/audit-export.test.ts; services/state-api/test/audit-export.test.ts; packages/runtime/test/audit-cli.test.ts; apps/ui/test/audit-export.test.tsx; apps/ui/test/download.test.ts; packages/capabilities/test/cloudflare-client.test.ts; packages/capabilities/test/cloudflare-deploy.test.ts; packages/capabilities/test/cloudflare-hooks.test.ts; packages/capabilities/test/cloudflare-tools.test.ts; packages/runtime/test/notifications-wiring.test.ts; packages/capabilities/test/cloudflare-wiring.test.ts |
| S.10 | Privacy between collaborators: your agent cannot read the other person's private memory, vault, local files or email. Shared means project data only. | 2 | done | packages/memory/test/scopes.test.ts; packages/state/test/suite.ts; packages/billing/test/router.test.ts; packages/vault/test/refs.test.ts; packages/runtime/test/hooks.test.ts; packages/runtime/test/token.test.ts; services/state-api/test/routes.test.ts; packages/capabilities/test/closeout-email.test.ts |
| S.11 | Vault, local app: OS keychain (macOS Keychain, Windows Credential Manager, libsecret), unlocked by OS login. | 0 | done | packages/vault/test/keyring.test.ts; packages/vault/test/open.test.ts |
| S.12 | Vault, cloud runner: encrypted blob, key held by the human's device. Human approves unlock per runner start, or sets an auto-unlock window. | 6 | in progress | packages/vault/test/file.test.ts; services/cloud-runner/test/vault-unlock.test.ts |
| S.13 | Vault, shared secrets (e.g. org deploy token): encrypted, readable by named agents only. Both humans approve the grant. | 2 | todo | |
| S.14 | The vault can hold API keys, subscription login tokens, passwords for agent-owned accounts and SSH keys. A subscription token belongs to one person and is never granted to the other person's agent; on a cloud runner it is used only by its owner's agent. It does not autofill the humans' own personal passwords. | 0 | done | packages/billing/test/router.test.ts; packages/billing/test/sources.test.ts; packages/vault/test/file.test.ts; packages/runtime/test/subscription-path.test.ts; tests/live/test/live-4-subscription.live.test.ts |
| S.15 | Each agent can get its own mailbox (for example `alice@your-domain.dev`), never the human's personal inbox. The human picks a mode in Settings → Capabilities → Email, per agent (S.16 to S.20). | 6 | in progress | packages/capabilities/test/email-settings.test.ts; packages/capabilities/test/email-routes.test.ts; packages/capabilities/test/closeout-email.test.ts |
| S.16 | Email mode Off: reads nothing, sends nothing. | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-tools.test.ts; packages/runtime/test/capabilities-wiring.test.ts |
| S.17 | Email mode Read only: reads its own mailbox, sends nothing. | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-tools.test.ts; packages/capabilities/test/closeout-email.test.ts; packages/runtime/test/capabilities-wiring.test.ts |
| S.18 | Email mode Draft only: reads its own mailbox; writes drafts that the human sends; every email is approved. | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-tools.test.ts; packages/capabilities/test/closeout-email.test.ts |
| S.19 | Email mode Allowlist: reads its own mailbox; sends freely to approved addresses and domains; new recipients need approval. | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/closeout-email.test.ts |
| S.20 | Email mode Full discretion: reads its own mailbox; sends to anyone, at its judgment; no approval, inside the limits S.22 to S.28. | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-tools.test.ts; packages/runtime/test/capabilities-wiring.test.ts |
| S.21 | The limits S.22 to S.28 stay on in every sending mode; each is adjustable. | 6 | done | packages/capabilities/test/closeout-email.test.ts; packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-settings.test.ts |
| S.22 | Daily send cap (default 20) and per-recipient cap (default 5 per day). | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-settings.test.ts; packages/capabilities/test/closeout-email.test.ts |
| S.23 | Blocked content: credentials, private memory, other people's personal data, financial commitments, legal agreements. | 6 | done | packages/capabilities/test/email-policy.test.ts |
| S.24 | Never signs up for paid services or accepts terms without approval. | 6 | done | packages/capabilities/test/email-policy.test.ts |
| S.25 | Inbound mail is untrusted. Links and attachments open only in the sandbox browser. Instructions in emails are never executed, only reported. | 6 | done | packages/capabilities/test/email-inbound.test.ts; packages/capabilities/test/email-commands.test.ts; packages/capabilities/test/email-tools.test.ts; packages/runtime/test/capabilities-wiring.test.ts; evals/test/injection.test.ts |
| S.26 | Every sent email is logged with a copy visible to the owner, and a daily digest is optional. | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-routes.test.ts; packages/capabilities/test/email-settings.test.ts |
| S.27 | Signature states it is an AI agent acting for the named human (on by default, can be turned off). | 6 | done | packages/capabilities/test/email-policy.test.ts; packages/capabilities/test/email-settings.test.ts |
| S.28 | One-click "pause email" in the tray. | 6 | in progress | packages/capabilities/test/email-routes.test.ts; packages/capabilities/test/email-policy.test.ts; apps/desktop/src-tauri/src/state.rs; apps/desktop/src-tauri/src/actions.rs |
| S.29 | Full discretion is available as requested. The setup screen explains plainly that the agent can then email strangers on your behalf. | 6 | in progress | packages/capabilities/test/email-settings.test.ts; packages/capabilities/test/email-policy.test.ts |
| S.30 | Browser runs in its own profile, never the human's main one. Logins for agent-owned accounts come from the vault. | 6 | done | packages/capabilities/test/browser-profile.test.ts; packages/capabilities/test/browser-tools.test.ts; packages/capabilities/test/browser.integration.test.ts |
| S.31 | Form submissions with personal data and accepting terms need approval below autonomy 4. Purchases always need approval. | 6 | done | packages/capabilities/test/browser-guards.test.ts; packages/capabilities/test/browser.integration.test.ts |
| S.32 | Desktop control is off by default, needs autonomy 3+ and an app allowlist, and shows a visible on-screen indicator while active. | 6 | in progress | packages/capabilities/test/desktop-gate.test.ts; packages/capabilities/test/desktop-controller.test.ts; packages/capabilities/test/desktop-tools.test.ts; packages/capabilities/test/desktop-wiring.test.ts; packages/runtime/test/desktop-wiring.test.ts |

## T. Email commands: tasks by email, run in the cloud

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| T.1 | Email commands are a separate toggle from the sending modes (S.16 to S.20). Replies to the owner are always allowed. | 6 | in progress | packages/capabilities/test/closeout-email-commands.test.ts; packages/capabilities/test/email-commands.test.ts; packages/capabilities/test/email-policy.test.ts; services/cloud-runner/test/email-watch.test.ts |
| T.2 | Checking: the cloud runner watches the agent's mailbox with push (IMAP IDLE or Gmail push) where available, and polls every 5 minutes otherwise. Interval is adjustable. | 6 | done | packages/capabilities/test/email-mailbox.test.ts; services/cloud-runner/test/email-watch.test.ts |
| T.3 | Who it obeys: only mail that is from the owner's registered address, passes DKIM and SPF, and carries the owner's command marker. The marker is a private tag in the subject (for example `[FR-7k2q]`) or a reply in a thread the agent started. It can be rotated at any time. Each agent obeys only its own human. | 6 | done | packages/capabilities/test/email-commands.test.ts; packages/capabilities/test/email-auth.test.ts; packages/capabilities/test/email-inbound.test.ts; packages/capabilities/test/email-settings.test.ts; packages/capabilities/test/email-routes.test.ts |
| T.4 | Everything else is data: forwarded mail, mail from anyone else, and quoted text inside the owner's own mail are never treated as instructions. | 6 | done | packages/capabilities/test/email-commands.test.ts; packages/capabilities/test/email-inbound.test.ts |
| T.5 | What it does with the owner's mail (T.6 to T.9). | 6 | done | packages/capabilities/test/email-commands.test.ts |
| T.6 | A question: it answers by reply. | 6 | done | packages/capabilities/test/email-commands.test.ts |
| T.7 | A task: it picks the project (or asks which), creates the task, and runs a cloud session. | 6 | done | packages/capabilities/test/email-commands.test.ts; services/cloud-runner/test/runner.test.ts; services/cloud-runner/test/email-watch.test.ts; tests/e2e/scenarios/02-email-task.scenario.test.ts |
| T.8 | A note: it goes into the next-session queue. | 6 | done | packages/capabilities/test/email-commands.test.ts |
| T.9 | Attachments: saved to the project and opened only in the sandbox. | 6 | done | packages/capabilities/test/email-commands.test.ts; packages/capabilities/test/email-inbound.test.ts |
| T.10 | Acknowledgement: within a minute it replies with what it understood, the project, estimated cost and when it will start. When done, it sends a short summary with links to PRs, files and the session log. | 6 | done | packages/capabilities/test/email-commands.test.ts; services/cloud-runner/test/email-watch.test.ts; services/cloud-runner/test/runner.test.ts; tests/e2e/scenarios/02-email-task.scenario.test.ts |
| T.11 | Approvals by reply: anything above the email autonomy level is asked in a reply, and the owner answers "yes" or "no" by email. The same checks (T.3, T.4) apply to the answer. | 6 | done | packages/capabilities/test/email-commands.test.ts |
| T.12 | Limits: per-email cost cap (default CHF 5), daily cap on email tasks (default 10), and autonomy for email tasks (default level 2). All adjustable. | 6 | done | packages/capabilities/test/email-commands.test.ts; packages/capabilities/test/email-settings.test.ts; packages/capabilities/test/email-routes.test.ts; services/cloud-runner/test/runner.test.ts |
| T.13 | Billing: email tasks run on the cloud runner with the owner's own billing source: the subscription if the runner is personal, otherwise an API key. | 6 | done | packages/billing/test/router.test.ts; services/cloud-runner/test/presence-billing.test.ts; services/cloud-runner/test/runner.integration.test.ts |
| T.14 | Audit: every email command, its interpretation and its result are logged together and visible in the app. | 6 | in progress | packages/capabilities/test/email-commands.test.ts; packages/capabilities/test/email-routes.test.ts |

## U. Data model

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| U.1 | Every record carries `id`, `created_at`, `updated_at` (UTC), `author_agent`, `author_human` and `version` for optimistic concurrency. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.2 | Human: name, email, timezone, notify prefs, default autonomy. One per person. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.3 | Agent: name (Alice/Bob), owner human, model config, memory location. Principal PM agents; peers, no hierarchy. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.4 | Project: name, repo(s), stage, status, budget, autonomy level, summary cache, data assets. Forerunner itself is a project. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/state/test/closeout-data-model.test.ts; packages/runtime/test/data-wiring.test.ts; tests/e2e/scenarios/phase7-gate.integration.test.ts |
| U.5 | Milestone: project, name, success criteria, target date, status. Criteria are checkable statements. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.6 | Task: project, milestone, title, outcome, acceptance criteria, risk tier 0–3, status, `claimed_by`, `claim_expires`, `depends_on[]`, budget, `est_cost`, `actual_cost`. Status is one of draft, ready, claimed, in_progress, in_review, needs_human, done, failed, cancelled. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.7 | Run: task, specialist, model, effort, prompt version, billing source, tokens in/out, cost, time to first token, duration, outcome, artifacts. One per specialist call; retries are new runs. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/runtime/test/executor.test.ts; services/cloud-runner/test/runner.integration.test.ts; packages/runtime/test/subscription-path.test.ts; tests/live/test/live-4-subscription.live.test.ts |
| U.8 | Session: agent, trigger, plan, budget cap, step cap, spent, steps, start/end, summary. Groups runs and events. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; services/cloud-runner/test/runner.integration.test.ts |
| U.9 | Event: session, type, payload, cost. Feeds the live log. Append-only. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.10 | Message: from agent, to agent or human, project, task, type, body, `requires_ack`, `delivered_at`, `read_at`, `acted_at`, `reply_to`. Types: info, question, request, warning, decision, handoff. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.11 | Decision: project, question, options, chosen, decided_by, rationale, supersedes. Agents check here before asking again. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.12 | HumanRequest: project, task, kind (decision, credential, approval, info), why, exact steps, options, blocking?, answer. Shown in the inbox and dashboard. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.13 | Review: task or session, critic model, tier, grade 0–100, confidence, findings[], verdict, evidence links. Verdict: accept, revise, escalate, human. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.14 | Finding: review, severity, description, required action, status, `resolved_by_run`. Open findings block task close. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.15 | Lesson: scope (agent-private, critic, shared), text, source, tags, confidence, `last_used`, `hit_count`, `superseded_by`. The memory unit. | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.16 | Supporting tables: command (name, parameters schema, risk, undo), change_log (who, words used, commands, before and after, undo state), device (owner, platform, key, last seen, revoked), source (connected org, account, git host or folder, credential ref, last scan), cost_ledger (every API charge, USD and CHF), secret_ref (name, scope, granted_to, never the value), extension (connectors, MCP servers, skills, specialists, enabled, version), data_asset (path or URI, size, owner machine, projects), release (version, changelog, signature, status). | 0 | done | packages/state/test/schema.test.ts; packages/state/test/sqlite.test.ts; packages/state/test/suite.ts |
| U.17 | Claims prevent duplicate work: an agent sets `claimed_by` and `claim_expires` in one atomic update with a version check. | 0 | done | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/runtime/test/session.test.ts |
| U.18 | The holder renews the claim every few minutes while working; if renewals stop (default 30 minutes), the claim expires. | 2 | done | packages/state/test/sqlite.test.ts; packages/state/test/suite.ts; packages/runtime/test/session.test.ts; packages/runtime/test/closeout-claims.test.ts |
| U.19 | The other agent cannot start a claimed task, only message about it. | 2 | done | packages/runtime/test/session.test.ts; packages/state/test/suite.ts |

## V. Release 1.0 criteria

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| V.1 | Every requirement in this file is done, with a test. | 8 | todo | |
| V.2 | Every milestone check in the Build order passes on the final build. | 8 | todo | |
| V.3 | All nine end-to-end scenarios pass on Windows and Linux (the phone scenario on the Android emulator), three runs in a row. | 8 | in progress | tests/e2e/scenarios/01-good-day.scenario.test.ts; tests/e2e/scenarios/02-email-task.scenario.test.ts; tests/e2e/scenarios/03-voice.scenario.test.ts; tests/e2e/scenarios/04-collision.scenario.test.ts; tests/e2e/scenarios/05-budget.scenario.test.ts; tests/e2e/scenarios/06-injection.scenario.test.ts; tests/e2e/scenarios/07-bad-update.scenario.test.ts; tests/e2e/scenarios/08-handover.scenario.test.ts; tests/e2e/scenarios/09-phone.scenario.test.ts |
| V.4 | No open P0 or P1 bugs. P2 bugs are listed as known issues. | 8 | todo | |
| V.5 | Security suite passes: prompt injection, secret scanning, dependency audit, permission and autonomy enforcement. | 8 | in progress | packages/runtime/test/injection.test.ts; scripts/secret-scan.test.ts; packages/runtime/test/autonomy.test.ts; packages/runtime/test/hooks.test.ts; packages/capabilities/test/browser-extract.test.ts; evals/test/injection.test.ts |
| V.6 | Response-time targets in Feature spec D (D.7 to D.15) are met. | 8 | in progress | tests/live/test/live-2-timing.live.test.ts |
| V.7 | A scripted fresh install on clean Windows and Linux VMs completes setup in under 15 minutes. | 0 | done | scripts/fresh-install.test.ts |
| V.8 | The docs handover test passes. | 8 | in progress | tests/e2e/scenarios/08-handover.scenario.test.ts |
| V.9 | `docs/status/gates.md` has evidence for every item above: command, date, result, CI link. | 8 | todo | |

## Counts

| Module | Area | Count |
| --- | --- | --- |
| A | Projects and onboarding | 6 |
| B | Tasks, milestones and workflow | 7 |
| C | Agents and specialists | 7 |
| D | Models: selection, configuration, monitoring | 21 |
| E | Sessions | 5 |
| F | Collaboration, messaging and sync | 7 |
| G | Memory, documentation and learning | 7 |
| H | Critic | 7 |
| I | Budget and cost | 7 |
| J | Human interaction | 10 |
| K | Interface | 8 |
| L | Capabilities | 6 |
| M | Self-improvement and updates | 6 |
| N | Token efficiency | 5 |
| O | Real-time conversation | 10 |
| P | Maintainer documentation | 15 |
| Q | Natural-language control | 12 |
| R | Android app | 8 |
| S | Security, permissions and email | 32 |
| T | Email commands | 14 |
| U | Data model | 19 |
| V | Release 1.0 criteria | 9 |
| **Total** | | **228** |
