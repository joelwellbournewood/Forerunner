# Forerunner — Build Spec and Plan

Oct 19, 2026 · @J

## How to use this doc

Give this whole doc to the build agent, together with a budget and the items in the human checklist below. It is the complete spec for Forerunner. The agent builds everything, tests it internally, and ships release 1.0.

**Build prompt (give this to the build agent first):**

> You are the build agent for Forerunner. Build the complete software suite in this spec, test it yourself, fix what fails, and ship release 1.0. Work autonomously and at high effort until every release criterion in the Build agent manual is met. There are no partial releases and no human test periods. Humans get progress reports along the way and the finished product at 1.0. The manual says how to work, the Build order says in what sequence, and the Feature spec says what to build. Enforce limits (budget, permissions, autonomy) in code, never only in prompts. Nothing is hardcoded to one org, account or host. This is a clean build from an empty repository. There is no earlier code, org, install or data to reuse or migrate; everything is created by you. Decide anything this spec leaves open yourself, record it as an ADR in `docs/decisions/`, and keep going. Every build runs on Windows and Linux, with an Android client. Every change updates the maintainer docs in the same PR.

**Scope:** every feature in this doc is in release 1.0 and must work with every other. The build order sets the sequence of work. It does not cut anything.

## Build agent manual

How the build agent works from an empty start to release 1.0, without a human in the loop.

### Human checklist (before the agent starts)

The humans provide these once, in the vault or a local `.env.build` that is never committed. Anything missing does not block work: the agent uses the stand-in, logs it in `docs/status/BLOCKERS.md`, and tests the real thing when it arrives.

| Item | Needed for | If missing, use |
| --- | --- | --- |
| Build budget (CHF) and a provider-side spend limit | Pacing all work | Agent stops and asks; this one is required |
| Anthropic API key | Live model tests, evals, scenarios | Required |
| Claude subscription token (`claude setup-token`) | Testing subscription billing | Fake billing source; mark real test pending |
| A GitHub org or account for Forerunner's own repos, with a GitHub App or fine-grained PAT | Repos, PRs, releases | Local Gitea; release built but not published |
| Postgres host (Supabase or other) | Shared state in production | Local Postgres container |
| Cloudflare API token | Deploy features | Fake Cloudflare API |
| Mailbox for each agent (domain or Gmail) | Real email tests | Local mail server with DKIM |
| Voice keys (Deepgram, Cartesia or ElevenLabs) | Cloud voice option | Local faster-whisper and Kokoro only |
| Windows code-signing certificate | Signed Windows installer | Unsigned installer, noted in release notes |
| Android keystore | Signed APK | Agent generates one and stores it in the vault |
| Cloud runner host | Hosted runner | Docker image published, deployment documented |
| One-line contact rule (email or GitHub issue) | Progress reports | GitHub issue in the Forerunner repo |

### The work loop

Repeat until release:

1. Read state: `AGENTS.md`, `docs/status/PROGRESS.md`, `docs/requirements.md`, `BLOCKERS.md`, `gates.md`, `COST.md`, recent git log.
2. Pick the next unblocked requirement in build order. If the current milestone is blocked, take the next unblocked item anywhere.
3. Write a short plan and failing tests first.
4. Implement. Run unit and integration tests for Windows and Linux.
5. Send the change to a separate critic sub-agent that has not seen your reasoning, at the task's risk tier.
6. Fix its findings. Merge through a PR when CI is green.
7. Update docs, requirement status, progress and cost.

Never idle. If blocked, build the stand-in, work on something else, or improve tests. Run the full regression suite at every milestone and at least daily.

### First steps

1. Run phase 0 in the Build order.
2. Write `docs/requirements.md`: give every bullet in the Feature spec a stable ID in order (A.1, A.2 … R.n) with its milestone. Do not wait for confirmation.
3. Create `docs/status/PROGRESS.md`, `gates.md`, `BLOCKERS.md`, `COST.md` and `reports/`.

### Decisions

Decide yourself, write an ADR, continue. Contact humans only for:

- a required item from the checklist that has no stand-in
- spending beyond the build budget
- irreversible actions on real outside accounts: deleting real repos, emailing real third parties, public app-store or package-registry releases
- legal or licensing choices

While waiting for an answer, keep working on everything else.

### Budget pacing

- Track all spend in `docs/status/COST.md`, by milestone and by model.
- Rough split: building 60%, testing and live evals 20%, critic reviews 10%, reserve 10%.
- Use high effort and strong models for architecture, security, hard debugging and final review. Use cheaper models and lower effort for routine sub-agent work that passes its checks.
- Forecast total spend at every milestone. If the forecast exceeds the budget, cut cost (models, effort, duplicate work), never scope, and tell the humans with the forecast.

### Progress reports

At each milestone, and at least weekly, write `docs/status/reports/<date>.md` and send a short summary by the contact rule: what is done, what is next, blockers, spend against budget, forecast to 1.0. Reports never ask humans to test anything.

### Internal test environment

The agent proves everything itself. Every real dependency has a stand-in so tests are repeatable, and the real thing is tested too when its credential exists.

| Real thing | Internal stand-in |
| --- | --- |
| Two humans | Scripted simulated users driving the UI (Playwright), the Android app (emulator) and natural-language requests |
| Two PCs | Two full installs in separate containers or VMs, plus Windows and Linux CI runners |
| Time passing | A simulated clock for schedules, claims, budget resets, overnight runs and "4 weeks of use" |
| GitHub | Local Gitea for integration; real org with `fr-test-` repos for final checks |
| Model provider | Fake provider with recorded replies for deterministic tests; live Claude for evals and scenarios |
| Email | Local mail server with DKIM signing, including spoofed and forwarded mail |
| Voice | Synthesised speech clips fed to STT; time to first audio measured |
| Android phone | Android emulator in CI |
| Shared state | Local Postgres container |
| Cloud runner | The same Docker image, run headless |

### Testing rules

- Unit tests run with the fake provider and no network.
- Integration tests run against the stand-ins on Windows and Linux.
- End-to-end scenario tests (Build order, milestone 8) run with live models inside the testing share of the budget.
- Bugs: reproduce with a failing test, fix, keep the test, write the root cause in the PR.
- Flaky tests are bugs. Fix them, never retry them away.

### Release 1.0 criteria

1.0 ships only when all of these hold:

1. Every requirement in `requirements.md` is done, with a test.
2. Every milestone check in the Build order passes on the final build.
3. All nine end-to-end scenarios pass on Windows and Linux (the phone scenario on the Android emulator), three runs in a row.
4. No open P0 or P1 bugs. P2 bugs are listed as known issues.
5. Security suite passes: prompt injection, secret scanning, dependency audit, permission and autonomy enforcement.
6. Response-time targets in Feature spec D are met.
7. A scripted fresh install on clean Windows and Linux VMs completes setup in under 15 minutes.
8. The docs handover test passes.
9. `gates.md` has evidence for every item above: command, date, result, CI link.

### Release steps

Tag `v1.0.0`. Build signed artefacts: Windows MSI, Linux AppImage and .deb, Android APK, cloud runner image, state service. Publish a GitHub Release in the Forerunner repo with checksums, changelog, user guide and setup guide. Push the runner image to the GitHub container registry. Send release notes by the contact rule. Do not publish to app stores or public registries without a human go.

### Definition of done (per change)

CI green on Windows and Linux. New behaviour has tests that fail without it. Lint and types clean. Docs and requirement status updated. Never weaken a test or check to make it pass.

### Where truth lives

This doc is saved as `docs/spec/forerunner-spec.md`. Precedence: a human instruction, then this spec, then ADRs, then existing code. Diagrams illustrate; the text is authoritative. The spec changes only by PR with an ADR.

### Never

Hardcode org names, user paths, path separators or secrets. Skip a platform. Merge to main without green CI. Mark a check passed without evidence.

### Repository layout

```
forerunner/
  AGENTS.md, CLAUDE.md
  apps/desktop/          Tauri 2 + React app (Windows, Linux)
  apps/mobile/           Android build of the same UI
  apps/approvals-web/    web fallback for approvals and chat
  packages/runtime/      orchestrator, hooks, budget, depth, autonomy
  packages/commands/     command registry, intent parsing, change cards, change log
  packages/state/        schema, migrations, SQLite and Postgres adapters
  packages/billing/      subscription and API routing, cost ledger
  packages/memory/       lessons, retrieval, consolidation
  packages/critic/       reviews, findings, tiers
  packages/voice/        STT, TTS, voice activity detection
  packages/capabilities/ browser, email, desktop control (MCP servers)
  packages/vault/        keychain and encrypted store
  packages/platform/     paths, shell runner, OS differences
  services/state-api/    shared state service
  services/cloud-runner/ headless runner image
  testenv/               stand-ins: fake provider, mail server, Gitea, simulated users, clock
  evals/                 golden task sets
  tests/e2e/             the nine scenarios
  docs/spec/ docs/maintainers/ docs/decisions/ docs/status/
```

Specialists, prompts and skills live in the separate `forerunner-registry` repo.

## Glossary

| Term | Meaning |
| --- | --- |
| Human | A person using Forerunner, such as J or his collaborator |
| Principal agent | A human's persistent project-manager agent (Alice, Bob) |
| Specialist | A sub-agent with one role, called by a principal agent for a task |
| Conversation agent | The fast agent that handles live text and voice chat for a principal |
| Critic | The independent reviewer of tasks and sessions |
| Session | One working period of a principal agent, with its own budget |
| Run | One specialist call inside a session |
| Task | A unit of work with acceptance criteria and a risk tier |
| Claim | A time-limited lock showing which agent is working on a task |
| Risk tier | 0 to 3. Sets critic depth and approval needs |
| Autonomy level | 0 to 4. Sets what an agent may do without asking |
| Gate | The checks that must pass before the next build phase |
| Lesson | One unit of memory: private, critic or shared |
| Source | A connected git org, account, host or local folder |
| Billing source | Subscription, plan API credits, or API key |
| Effort | The model setting that trades depth for speed and cost |
| Command | One typed action in the registry, used by buttons, chat, voice and email alike |
| Change card | The summary shown before a change: what, old to new, scope, duration, impact, undo |
| Active project | The project that commands apply to when none is named; always shown in the header |
| Device | A paired PC or phone with its own key, revocable at any time |

## Product summary

Forerunner gives each person a persistent AI project manager that plans work, delegates it to cheaper specialist agents, gets it independently checked, and stays inside a hard budget. Two or more people's agents can share projects through GitHub without merging identities or memories.

**Who uses it:** J and one collaborator first. Built so a third person, or a solo user, can join without redesign.

**What a good day looks like:** You drop a few notes into a project before bed. Your agent wakes on schedule, reads its inbox, syncs, sees the other agent's changes, plans within its CHF budget, delegates, gets the work reviewed, opens PRs, and leaves you a short summary and two multiple-choice questions. You answer from your phone.

**Core principles**

1. **Collaboration first.** Agents are peers. Neither is master.
2. **One source of truth.** Shared state lives in one place and every agent reads it before acting.
3. **Asynchronous by default.** Nothing assumes the other agent or human is online.
4. **Manage, don't do.** The principal agent plans and delegates. Specialists execute.
5. **Evidence over claims.** A task is done when the critic has evidence, not when an agent says so.
6. **Limits live in code.** Budgets, permissions and autonomy are enforced by the orchestrator, not by prompt wording.
7. **Adjustable autonomy.** From "ask me everything" to "just do it", set per user and per project. Say it or click it: every control works by conversation or by hand, and every change is spelled out.
8. **Fast when talking, thorough when working.** Conversation uses fast models and low effort and answers in about a second. Background work uses the effort the task needs.
9. **Everything visible, everything reversible.** Every action is logged and attributed. Destructive actions need approval.
10. **Cheap by design.** Smallest capable model, lowest effort that passes, compressed context, retrieval instead of loading everything.
11. **Runs anywhere.** Windows and Linux are first-class. macOS is a bonus, not a target.
12. **Self-hosting and self-documenting.** Forerunner is developed as a project inside Forerunner, behind tests and a human-approved update, with docs a new agent can follow.

## Design decisions and risks

Four things decide whether this works: who runs the agent when nobody is at the PC, where shared state lives, how the system is protected from its own agents, and how quality is measured. The safeguards and choices below answer them.

### Safeguards built in

| Gap | Why it matters | Fix |
| --- | --- | --- |
| No scheduler or trigger model | "Agents are not running 24/7" is stated, but nothing says what starts a session | Session triggers: manual, scheduled, inbox event, CI event, budget reset |
| Shared state on GitHub alone | Issues and files are slow, rate-limited and race-prone for task state and messages | Small shared state service (Postgres) as source of truth for tasks, messages, locks, costs. Git stays the source of truth for code and docs |
| No threat model | Agents with browser, email, PC control, keys and self-update form a large attack surface | Prompt-injection rules, capability tokens, sandboxing, kill switch, audit log (see Security) |
| No eval harness | "Critic grades over time" means nothing without a fixed benchmark | Golden task set per specialist, re-run on every model or prompt change |
| Critic grading itself | One model family grading its own family inflates scores | Critic uses a different model, or at least a different prompt and no access to the worker's reasoning |
| No kill switch | A runaway loop or bad update needs a hard stop | Global and per-session stop, in UI and tray, that terminates all child processes |
| No backup or export | Memory and project state are the product's value | Nightly encrypted backup, one-click export of everything to plain files |
| No notifications | Humans miss approval requests | Push, email and Telegram/Signal options, with quiet hours |
| Currency and pricing | Budgets in USD, user thinks in CHF | Budgets shown in CHF, converted at a daily rate, raw USD kept in the ledger |
| Prompt and skill versioning | Specialist prompts will change constantly | Prompts and skills stored as versioned files, every run records the version used |
| Time zone and identity of messages | Two people, possibly different zones | All timestamps UTC in storage, local in UI, every record has an author agent and human |

### Design choices

- **GitHub issues as the inbox → a message table in the shared state service, mirrored to GitHub for visibility.** Issues work for humans but give no delivery receipts, no atomic claims and tight rate limits.
- **Temperature as a setting → effort and model tier as the settings.** Current Claude models reject a non-default temperature, top\_p or top\_k with an error. Effort (low to max) now controls thinking depth, speed and cost. Temperature is kept only for other providers that support it.
- **"Escalate one or two levels" → a defined model ladder** (Haiku → Sonnet → Opus → Fable; Mythos is not publicly available) with a per-project ceiling and a per-escalation cost cap.
- **Self-modifying UI → UI changes ship as normal releases.** Agents open a PR to the Forerunner repo; the human installs it like any update. No live hot-patching.
- **Critic on everything → critic depth by risk tier.** Tier 0 tasks get automated checks only. This cuts review cost by most of its volume.
- **Email "at its own discretion" → discretion inside user-set rules.** Kept as asked, with options in the Security section.

### Biggest risks

1. **Scope.** This is three products in one: a PM agent, a collaboration layer, and a self-updating desktop app. Mitigation: build the core loop first, plug each phase into it, and test the whole system end to end at the final gate.
2. **Prompt injection** through web pages, emails and repo files, once agents can browse, read mail and act.
3. **Cost blowouts** from sub-agent trees. Spawn depth and spend must be capped in code.
4. **Two agents diverging.** Without strict claim-before-work, both will do the same task.
5. **Memory rot.** Unpruned memory gets contradictory and starts to hurt. Needs consolidation and human review.

## Architecture

Each person runs a local Forerunner app. All apps talk to one small shared state service and to GitHub. An optional cloud runner executes the same agent runtime when laptops are off.

&#91;embedded content: system architecture · two PCs, shared services\]

Alice's and Bob's installs are identical. The only difference is whose private memory and keys each holds, and those never leave that PC. Everything shared goes through the state service or GitHub.

### Run modes

| Mode | Agent runs on | Shared state | Use case |
| --- | --- | --- | --- |
| Solo local | Your PC | Local SQLite | One person, no collaborator |
| Paired local | Each PC | Shared state service | Default for J and friend |
| Hybrid | PC when on, cloud runner when off | Shared state service | Overnight and scheduled sessions |
| Cloud only | Cloud runner | Shared state service | Server or headless use |

The agent runtime is the same code in every mode. Only the storage adapter and the runner change.

### Components

1. **Desktop and Android apps.** Tauri 2 shell with one React UI for Windows, Linux and Android (module R). Desktop tray icon with status, kill switch and approval badge.
2. **Agent runtime (orchestrator).** TypeScript service built on the Claude Agent SDK. Holds the command registry that every UI action and every spoken or typed request goes through (module Q). Runs the principal agent, spawns specialists, enforces budget, depth, tools and autonomy in hooks. Provider adapter layer so non-Anthropic models can be added.
3. **Shared state service.** Postgres plus a thin API (Supabase or a small Hono server on Cloudflare/Fly). Holds tasks, messages, receipts, claims, decisions, cost ledger, critic reviews. Realtime channel pushes inbox events.
4. **Git hosts (configurable).** Source of truth for code, project docs and releases. Connect any number of GitHub orgs or personal accounts; GitLab and plain git remotes via the same adapter later. One repo per project, plus `forerunner` (the app) and `forerunner-registry` (specialists, prompts, skills, eval sets).
5. **Memory store.** Per-agent private memory, critic memory, shared lessons. Markdown files with frontmatter plus a local vector index. Private memory never leaves the owner's machine or their own encrypted cloud slot.
6. **Context layer.** Headroom (or similar) as a local proxy in front of model calls. Toggleable per project, savings shown in the cost view.
7. **Capability services.** Browser (Playwright, isolated profile), email (dedicated mailbox via IMAP/SMTP or Gmail API), desktop control (OS automation, off by default), voice (streaming STT and TTS, see module O). Each is an MCP server the orchestrator can grant or revoke.
8. **Secrets vault.** OS keychain locally, libsodium-encrypted store for the cloud runner. Agents request a secret by name; the runtime injects it into the tool call, never into model context.
9. **Sandbox.** Docker container per coding or test task. No host filesystem except the mounted worktree. Network allowlist per task.
10. **Updater.** Signed releases from GitHub, staged install, health check, automatic rollback.

### Model access and billing

Each human links one or more ways to pay for model calls. The runtime routes each call to an allowed source and records which one paid.

| Source | How it connects | Good for | Limits |
| --- | --- | --- | --- |
| Claude subscription (Pro, Max, Team) | Claude Code login, or a token from `claude setup-token`, stored in the vault | Interactive work and day-to-day sessions on a flat fee | Plan usage limits apply. Plans are for individual use: each person links only their own account, for their own agent |
| Plan API credits (Max, Team) | Claim credits into a Claude Console org, then use that org's API key | SDK and API work covered by the plan | Monthly credit amount set by the plan |
| Claude API key | Console API key in the vault | Overflow, cloud runner, batch jobs, exact cost tracking | Pay per token |
| Other providers | Adapter plus key | Later: cheap or specialised models | Per provider |

Routing rules, set per agent: prefer subscription, fall back to API when the plan limit is hit or the work runs on the cloud runner. Subscription usage has no per-token price, so the cost view shows it as plan usage, with an estimated API-equivalent cost for comparison. Because Anthropic's rules here changed several times in 2026, the billing adapter is isolated so a policy change means one module changes.

### Platform support

| Area | Windows 10/11 | Linux (Ubuntu 22.04+, Fedora) |
| --- | --- | --- |
| App shell | Tauri, MSI installer | Tauri, AppImage and .deb |
| Secrets | Windows Credential Manager | libsecret (GNOME Keyring or KWallet) |
| Sandboxes | Docker Desktop on WSL2, or Podman | Docker or Podman, rootless |
| Browser capability | Playwright Chromium | Playwright Chromium |
| Desktop control | UI Automation API | X11 full support; Wayland limited to what the portal allows |
| Audio | WASAPI | PipeWire or PulseAudio |
| Autostart and tray | Startup entry, system tray | XDG autostart, tray via AppIndicator |

Rules: paths go through one path module (no hardcoded `/` or `\`), line endings are normalised, shell commands go through a cross-platform runner, and CI runs the full test suite on both systems for every PR. Android (10+) is a client: it builds in CI, runs UI and sync tests on an emulator, and never runs agents locally.

### Source of truth rules

| Data | Lives in | Why |
| --- | --- | --- |
| Code, project docs, ADRs | Git | Review, history, PRs |
| Tasks, milestones, messages, claims, costs, reviews | Shared state service | Atomic updates, receipts, realtime |
| Private agent memory | Owner's machine (+ own encrypted backup) | Privacy, identity |
| Critic memory, shared lessons | Shared state service | Used by all agents |
| Secrets | Vault | Never in git or context |
| Large datasets | Where they sit, registered by path or URI | No copying of GBs |

GitHub Issues and Projects get a one-way mirror of tasks and milestones so the work is visible in GitHub too. Edits there sync back only for status and comments.

### Suggested stack

TypeScript end to end. Tauri + React + Tailwind for the app (one codebase for Windows and Linux). Claude Agent SDK for agents. Postgres (Supabase) for shared state. SQLite for solo mode and local cache. LanceDB or sqlite-vec for local vector search. Playwright for browsing. Docker for sandboxes. Vitest and Playwright for tests.

## Data model

Fourteen core entities cover the whole spec. Every record carries `id`, `created_at`, `updated_at` (UTC), `author_agent`, `author_human` and `version` for optimistic concurrency.

| Entity | Key fields | Notes |
| --- | --- | --- |
| Human | name, email, timezone, notify prefs, default autonomy | One per person |
| Agent | name (Alice/Bob), owner human, model config, memory location | Principal PM agents. Peers, no hierarchy |
| Project | name, repo(s), stage, status, budget, autonomy level, summary cache, data assets | Forerunner itself is a project |
| Milestone | project, name, success criteria, target date, status | Criteria are checkable statements |
| Task | project, milestone, title, outcome, acceptance criteria, risk tier 0–3, status, claimed\_by, claim\_expires, depends\_on\[\], budget, est\_cost, actual\_cost | Status: draft, ready, claimed, in\_progress, in\_review, needs\_human, done, failed, cancelled |
| Run | task, specialist, model, effort, prompt version, billing source, tokens in/out, cost, time to first token, duration, outcome, artifacts | One per specialist call. Retries are new runs |
| Session | agent, trigger, plan, budget cap, step cap, spent, steps, start/end, summary | Groups runs and events |
| Event | session, type, payload, cost | Feeds the live log. Append-only |
| Message | from agent, to agent or human, project, task, type, body, requires\_ack, delivered\_at, read\_at, acted\_at, reply\_to | Types: info, question, request, warning, decision, handoff |
| Decision | project, question, options, chosen, decided\_by, rationale, supersedes | Agents check here before asking again |
| HumanRequest | project, task, kind (decision, credential, approval, info), why, exact steps, options, blocking?, answer | Shown in the inbox and dashboard |
| Review | task or session, critic model, tier, grade 0–100, confidence, findings\[\], verdict, evidence links | Verdict: accept, revise, escalate, human |
| Finding | review, severity, description, required action, status, resolved\_by\_run | Open findings block task close |
| Lesson | scope (agent-private, critic, shared), text, source, tags, confidence, last\_used, hit\_count, superseded\_by | The memory unit |

Supporting tables: command (name, parameters schema, risk, undo), change\_log (who, words used, commands, before and after, undo state), device (owner, platform, key, last seen, revoked), source (connected org, account, git host or folder, credential ref, last scan), `cost_ledger` (every API charge, USD and CHF), `secret_ref` (name, scope, granted\_to, never the value), `extension` (connectors, MCP servers, skills, specialists, enabled, version), `data_asset` (path or URI, size, owner machine, projects), `release` (version, changelog, signature, status).

**Claims prevent duplicate work.** An agent sets `claimed_by` and `claim_expires` in one atomic update with a version check. The holder renews the claim every few minutes while working; if renewals stop (default 30 minutes), the claim expires. The other agent cannot start a claimed task, only message about it.

## Feature spec

Eighteen modules. Each lists what it must do.

### A. Projects and onboarding

- Create a project from the dashboard: name, goal, paste-in brief of any length, file uploads, link repo.
- PM agent turns the brief into docs, milestones, tasks and a first-session plan, then shows it for approval.
- Import from ZIP, local folder, or existing GitHub repo. Original is preserved untouched; migration runs on a branch.
- Source discovery: the user connects any sources (GitHub orgs or accounts, chosen repos, local folders, other git hosts later). A scan lists what is there, proposes a project for each repo or folder, detects an existing Forerunner install, and never creates duplicates. Sources can be added, rescanned or removed at any time.
- Guided setup wizard. Each credential request says what, why, exact scopes, where to click, and how it will be verified. Validates on paste.
- Every project has a cached one-screen summary (goal, stage, last session, next 3 steps, open questions, spend). Refreshed at session end. Readable aloud.

### B. Tasks, milestones and workflow

- Projects hold stages, milestones and tasks with dependencies and priorities.
- Each task has an outcome, acceptance criteria, risk tier, budget and owner.
- Workflow: draft → ready → claimed → in progress → in review → done. Side exits: needs human, failed, cancelled.
- A task cannot close with open findings or failed required checks.
- Every change to plan, task or milestone is versioned with author and reason.
- Small-project mode: one milestone, flat task list, critic tier 0 by default.
- A clear task log per project: filterable table of every task and run, who did it, cost, verdict, links to PR and review.

### C. Agents and specialists

- Principal agents are PMs. They plan, write task briefs, pick specialists, integrate results, and own coherence.
- Delegation brief template is enforced: goal, context links, constraints, acceptance criteria, budget, risk tier. Briefs missing fields are rejected by the runtime.
- Starting specialists: coder, tester, reviewer, researcher, science evaluator, designer, writer/marketing, data analyst, migration specialist, ops/deploy.
- Specialists are files in `forerunner-registry`: role prompt, default model and effort, allowed tools, max budget, eval set.
- PM can propose a new specialist. It goes live after human approval and passing its eval set.
- Sub-agents can spawn sub-agents, capped by depth (default 2) and by the parent's remaining budget.
- Solo mode: one principal agent, no peer. Paired mode: two or more peers.

### D. Models: selection, configuration, monitoring

- Model ladder per provider, ranked by capability and cost. Tasks get a starting rung from their tier.
- Retry policy: 1st failure → improve brief and add context. 2nd → split task or change specialist. 3rd → escalate one rung, if under the ceiling. Then human.
- Escalation ceiling and per-escalation cost cap set per project.
- Settings per agent and specialist: model, effort, max tokens, speed mode, timeout. Defaults are in the table below. Temperature appears only for providers that accept it.
- Every run stores model, version, settings and prompt version.
- Weekly model watch: checks provider model lists and pricing, runs the eval set on new candidates, proposes a switch with measured quality and cost deltas. Human approves.

#### Effort and response time

Effort trades depth for speed and cost. The rule is the lowest effort that passes the task's checks. Each mode has a response-time target the UI measures and shows.

| Mode | Default model | Effort | Response target |
| --- | --- | --- | --- |
| Voice chat | Haiku 5.5 | low | First audio under 1.2 s |
| Text chat | Haiku 5.5, Sonnet 5.5 if the question needs it | low | First token under 1 s |
| Routing, triage, summaries | Haiku 5.5 | low | Under 3 s |
| Session planning (PM) | Sonnet 5.5, Opus 5.5 on large projects | high | Under 60 s |
| Coding specialist | Sonnet 5.5 | medium, high at tier 2+ | Set by task budget and timeout |
| Research specialist | Sonnet 5.5 or Opus 5.5 | high | Set by task budget and timeout |
| Critic tier 1 | Sonnet 5.5 | medium | Under 30 s |
| Critic tier 2 and 3 | Opus 5.5 | high or max | Set by task budget |

- Each project has a speed-versus-quality slider that shifts every default effort up or down one step.
- Every run has a wall-clock timeout. On timeout it stops cleanly, saves partial output, and the PM decides what next.
- All replies stream. Long runs show progress events, never a silent spinner.
- Each run records time to first token and total time. The Performance view shows these per mode against target.
- Opus fast mode (research preview, API only, priced separately) can be enabled per project for urgent work.
- The model watch (above) also tests lower effort levels on the eval set, since a cheaper effort that passes is a free saving.

### E. Sessions

- Triggers: manual start, schedule, new message or human answer, CI result, PR comment, verified email from the owner (see Security → Email commands).
- Fixed startup checklist run by code, not the model: version check, git fetch, pull shared state, inbox, open human requests, critic findings, budget, diff since last session. Output is a compact state brief handed to the agent.
- Agent writes a session plan with cost estimate before acting. Plans over budget are cut before starting.
- Inbox re-checked between every task and before any write to shared state.
- Session end: update docs, task states, memory, project summary, cost ledger; send handoff message to peer; notify human.

### F. Collaboration, messaging and sync

- Inbox per agent and per human. Messages are typed and structured.
- Receipts: delivered, read, acted on. Unacknowledged `requires_ack` messages resurface at the sender's next session.
- Realtime push when both are online; polling fallback.
- Claim-before-work on every task. Claims expire.
- Code changes only via branches and PRs. Agent rebases before PR; conflicts it cannot resolve become a human request.
- Peer awareness: at startup and between tasks, agent reads a short "what the other is doing" feed (active claims, open PRs, last handoff). Overlap detection on files and tasks triggers a message before work starts.
- Handoff note at every session end: done, in flight, blocked, next.

### G. Memory, documentation and learning

- Three memory scopes: private agent memory, critic memory, shared lessons. Plus project docs in git. Never mixed.
- Memory unit is a Lesson with source, tags, confidence and usage count.
- Retrieval by relevance (tags + vector search), capped at a token budget per session.
- Weekly consolidation job merges duplicates, flags contradictions, retires unused lessons. Changes are shown to the human for review.
- Standard project doc set: `README`, `docs/overview.md`, `architecture.md`, `status.md`, `decisions/` (ADRs), `runbook.md`, `data.md`, `testing.md`. PM keeps them current; critic checks drift.
- Cross-project sharing: lessons tagged as general are promoted to the shared store after critic approval and offered to other projects.
- Reference design: aerovato/operator-memory. Study it in sprint 1 (the repo could not be read automatically for this doc).

### H. Critic

- Independent reviewer, different model or at least a clean context with no access to the worker's reasoning.
- Risk tiers set review depth: 0 = automated checks only, 1 = light read, 2 = full review with tests run, 3 = deep review plus human sign-off.
- Output: grade 0–100, confidence, findings with severity, verdict, evidence links.
- Low confidence never becomes accept. It becomes escalate or human.
- Findings are tracked to resolution. Repeat findings across sessions are flagged as patterns and turned into lessons.
- Session-level review grades plan quality, cost efficiency and honesty of the summary to the human.
- Calibration: critic grades the golden eval set monthly so drift is visible.

### I. Budget and cost

- Hard caps at month, project, session, task and run level. Enforced by the runtime before each call. Caps apply to API spend in CHF and to subscription usage as a share of the plan's limit.
- Step cap and wall-clock cap per session.
- Estimate before every run; actual recorded after. Estimate error tracked per specialist and task type.
- 15 to 25% of session budget reserved for review and fixes by default.
- At 80% of a cap: finish current task, no new work. At 100%: stop and ask.
- Allocation view: spend by specialist, model, task, project; success rate and cost per accepted task.
- Token savings from compression and caching shown separately.

### J. Human interaction

- **Quick chat** per project: read-only by default, fast model plus project summary and docs search. Voice works here too (module O). A "make this a task" button turns a chat message into a ready task (ADR 0093; was a draft task).
- **Next-session queue**: notes, tasks, corrections, ideas, each with priority and type. Voice notes supported.
- **Human requests**: one inbox across projects. Each has context, why it matters, options (multiple choice when possible), and whether it blocks work.
- Answered decisions go to the Decision log and are never asked again unless superseded.
- Autonomy levels per project:
  - 0 Advisor: plans and proposes only.
  - 1 Assisted: acts after approval of each plan.
  - 2 Standard: routine reversible actions free, everything else approved. Default.
  - 3 Trusted: also merges reviewed PRs and deploys to staging.
  - 4 Autopilot: everything except destructive, financial and credential actions.

### K. Interface

- **Home**: all projects as cards with stage, next milestone, health, spend vs budget, waiting-on-you count, latest critic grade.
- **Project page** tabs: Summary, Plan (milestone timeline + dependency graph), Tasks/log, Docs, Reviews, Costs, Data, Chat.
- **Live session view**: readable event stream, current task and specialist, step count, running cost vs cap, escalations highlighted. Raw output behind a toggle.
- **Inbox**: human requests and agent messages, sorted by blocking first.
- **Memory**: separate views for Alice, Bob, Critic, Shared lessons. Search, edit, delete, pin.
- **Extensions panel**: every connector, MCP server, skill, specialist, capability and model provider. Status, permissions, cost, version, toggle, remove, add from catalog or URL.
- **Settings**: global, per human, per agent, per project. Every setting shows its scope.
- QoL: command palette, keyboard shortcuts, dark mode, desktop notifications, tray menu, Android app (module R) plus a web fallback for approvals. Active project always shown in the header.

### L. Capabilities

- **Files and data**: upload, link folders, register large datasets by path or URI. Agents see metadata and samples, not whole files. Large data never goes into git; use LFS, R2 or the original location.
- **Browser**: Playwright with an isolated profile per agent. Site allowlist and blocklist. No purchases or credential entry without approval.
- **Email**: see Security for the rules and user options.
- **Desktop control**: off by default. Per-app allowlist. Screenshots logged. Always requires autonomy 3+.
- **Connectors**: MCP servers installed from a catalog or URL, each reviewed and permissioned on install.
- **Voice**: TTS for summaries and alerts, STT for voice notes. Pluggable provider.

### M. Self-improvement and updates

- Forerunner is a project in Forerunner. Feature requests and bugs go into its task list like any other.
- Changes go through PR, tests in Docker, critic tier 2+, human approval.
- Release channel: signed builds published to GitHub Releases. App shows "Update available", changelog, "Update and restart".
- Staged install, health check on restart, automatic rollback on failure. Config, memory and data untouched by updates.
- Connector and model updates surface in the same updates screen.
- Shared state schema changes use versioned migrations; both apps must be on a compatible version before sync resumes.

### N. Token efficiency

- Context compression proxy (Headroom or similar), toggle per project, savings measured.
- Prompt caching for stable system prompts and project briefs.
- State brief instead of raw history at session start.
- Retrieval over memory and docs with a token budget.
- Cheap model for summaries, routing and quick chat.

### O. Real-time conversation

- Talk to your agent at any time, by text or voice: in the app, from a global hotkey, or from the phone approvals page.
- A dedicated conversation agent answers. It runs on a fast model at low effort with a small cached context: project summaries, inbox, open requests, current session state. It speaks for your principal agent and writes to the same memory and logs.
- **Voice loop.** Push-to-talk hotkey, or open mic with voice activity detection. Streaming STT, reply streamed sentence by sentence into streaming TTS. You can interrupt it mid-sentence by speaking.
- **Pluggable voice providers.** Local by default where the machine can manage it: faster-whisper for STT, Kokoro or Piper for TTS. Free and private. Cloud option for the lowest latency: Deepgram for STT, Cartesia or ElevenLabs for TTS. Chosen in the Extensions panel.
- **Latency budget.** End of turn about 0.2 s, final transcript about 0.3 s, model first token about 0.5 s, first audio about 0.2 s. The target is under 1.2 s to first audio. Each part is measured and shown.
- **What it can do:** answer questions, take notes into the next-session queue, create draft tasks, answer human requests, and start, pause or stop sessions.
- **What needs a confirm step:** approving anything above routine, and starting work over a set cost. It reads back the action and estimated cost and waits for "yes". Spoken approvals are logged with the transcript line.
- **Handoff.** If a question needs real work, it says so, queues it for the principal agent, and the answer comes back through the inbox or a notification.
- **During a live session**, what you say reaches the principal agent at the next step boundary. Stopping is immediate.
- Transcripts are kept in session history. Audio is not stored unless turned on.

### P. Maintainer documentation

A future agent, or a new human, should be able to change any part of Forerunner from the docs alone.

- `AGENTS.md` at the repo root, with `CLAUDE.md` pointing to it: build, test and run commands for Windows and Linux, code layout, conventions, and the rules from the build prompt.
- `docs/maintainers/`, one file per area:
  - `architecture.md`: components, data flow, the diagram source
  - `data-model.md`: generated from the schema on every build
  - `runtime.md`: hooks, budget, depth, autonomy and permission enforcement
  - `billing.md`: billing sources and routing, and what to change when provider rules change
  - `adding-a-specialist.md`, `adding-a-connector.md`, `adding-a-provider.md`, `adding-a-voice-provider.md`
  - `platform-notes.md`: Windows and Linux differences and known issues
  - `release.md`: signing, staged rollout, rollback
  - `migrations.md`: schema and memory-format migrations
  - `security.md`: threat model and the injection test suite
  - `troubleshooting.md`: common failures and fixes
- ADRs in `docs/decisions/` for every non-obvious choice. A changelog for every release.
- **Docs stay true.** CI fails a PR that changes a module without touching its doc, unless the PR says "docs: none needed" with a reason. Schema docs are generated. A link checker runs. The critic checks doc drift at tier 2+.
- **Handover test.** Monthly, a fresh agent with only the repo and docs makes a small seeded change. Where it gets stuck becomes a docs task.

### Q. Natural-language control

Anything you can do in the app, you can also do by saying it, by text, voice or email, from desktop or phone. Anything you can say, you can also do manually and precisely. Both routes call the same commands, so nothing is chat-only and nothing is UI-only.

- **One command registry.** Every action is a typed command with parameters, validation, a risk level and an undo: `project.switch`, `budget.set`, `autonomy.set`, `session.start`, `capability.grant`, `specialist.add`, and so on. Buttons, the command palette, the API, chat, voice and email all call these.
- **Understanding.** The conversation agent turns what you say into one or more commands. "Work on the supplement site now and give it 20 francs tonight" becomes `project.switch` plus a temporary `budget.set` that reverts at 06:00. If something is unclear, it asks one short question with options.
- **Context.** There is always an active project, shown in the header on every screen. "Switch to PharmaWatch", "go back" and "what was I doing on the game?" work. Commands without a named project apply to the active one, and the confirmation says so.
- **Change card.** Before any change, it shows a card and says it out loud in voice mode: what changes, old value → new value, scope (this session, this project, everything), how long (until reverted, until a time, permanent), cost or risk impact, and how to undo.
- **Confirmation by risk.**

| Risk | Examples | How it confirms |
| --- | --- | --- |
| Low | Switch project, rename, reorder tasks, add a note | Acts at once, then states what it did, with undo |
| Medium | Raise a budget within the hard ceiling, change autonomy by one step, start a costly session | Change card, then a "yes", a tap, or an email reply |
| High | Raise the monthly hard ceiling, grant a capability, change email mode, delete anything, change permissions | Change card, then confirmation in the app on a paired device, with biometric on the phone. A chat or email "yes" alone is not enough |

- **Bespoke requests.** If no single command fits, the agent builds a plan from existing commands and shows it as one change card. If no commands can do it, it offers to create a Forerunner task to add the feature.
- **Spelled out every time.** Every change made by conversation is posted to the activity log and the project chat as a plain sentence, for example "Raised tonight's session budget for PharmaWatch from CHF 5 to CHF 20, until 06:00. Undo." The other human sees changes that affect shared projects.
- **Change log.** Every change has who asked, the words used, the commands run, before and after values, and a one-click undo while it is still reversible.
- **Limits still hold.** Conversation changes go through the same enforcement as the settings screen. The agent cannot raise its own limits without your confirmation, and it never treats text from web pages, files or other people's email as a request.

### R. Android app

A mobile app that syncs with everything and lets you run and contribute to projects from your phone.

- **Build.** Tauri 2 Android target sharing the desktop React UI and TypeScript packages. Signed APK for sideloading, plus a Play Store internal track later. Updates through the same release channel.
- **Pairing.** Scan a QR code from the desktop app. Each device gets its own key, listed in Settings → Devices, and can be revoked at once.
- **Sync.** Reads and writes the shared state service directly. Works offline and queues actions until it reconnects.
- **Remote control.** Start, pause and stop sessions on your PC or on the cloud runner. Commands go through the state service, and the PC or runner picks them up in seconds. Watch the live session log.
- **Contribute.** Chat and voice with your agent (module O). Natural-language control (module Q). Add notes, tasks and ideas. Upload photos, files and documents to a project. Review PRs and critic findings, comment, approve or reject. Answer human requests.
- **Notifications.** Push for approvals, finished sessions, budget warnings and messages, with quiet hours.
- **Security.** Biometric unlock for the app and for high-risk confirmations. No secrets or private memory stored on the phone; it uses scoped session tokens. Lost phone: revoke from desktop.
- **Heavy work stays off the phone.** Agents run on the PC or the cloud runner. The phone controls, contributes and reviews.

## Security, permissions and email

All limits are enforced by the runtime in tool hooks. A prompt can ask; only code can allow.

### Rules that apply everywhere

- **Content is data, not instructions.** Web pages, emails, repo files, issue comments and other agents' outputs can never grant permissions or change goals. Instructions found there are quoted to the human.
- **Capability tokens.** Each run gets a token listing its allowed tools, paths, domains, secrets and budget. The hook rejects anything outside it.
- **Secrets by reference.** Agents ask for `secret:github_pat`; the runtime injects it into the tool call. Values never enter model context, logs or git. Logs are scanned and redacted.
- **Least privilege.** GitHub fine-grained PAT or GitHub App scoped to the orgs and repos the user selects. Cloudflare token scoped to named zones and Workers. Each grant shows its scopes in the Extensions panel.
- **Always needs a human, at any autonomy level:** deleting repos or data, force-pushing to main, spending real money, sharing secrets, changing permissions, granting a new capability, sending money, entering passwords on third-party sites.
- **Sandboxing.** Code runs in Docker with only the task's worktree mounted and a network allowlist.
- **Kill switch.** Tray and UI button stops all sessions for one agent or everyone, revokes run tokens, and freezes claims.
- **Audit log.** Append-only record of every tool call: who, what, when, cost, result. Exportable.
- **Privacy between collaborators.** Your agent cannot read the other person's private memory, vault, local files or email. Shared means project data only.

### Secrets vault

| Where | Store | Unlock |
| --- | --- | --- |
| Local app | OS keychain (macOS Keychain, Windows Credential Manager, libsecret) | OS login |
| Cloud runner | Encrypted blob, key held by the human's device | Human approves unlock per runner start, or sets an auto-unlock window |
| Shared secrets (e.g. org deploy token) | Encrypted, readable by named agents only | Both humans approve the grant |

The vault can hold API keys, subscription login tokens, passwords for agent-owned accounts and SSH keys. A subscription token belongs to one person and is never granted to the other person's agent. On a cloud runner it is used only by its owner's agent. It does not autofill the humans' own personal passwords.

### Agent email

Each agent can get its own mailbox (for example `alice@your-domain.dev`). Never the human's personal inbox. The human picks a mode in Settings → Capabilities → Email, per agent:

| Mode | Agent can read | Agent can send | Approval |
| --- | --- | --- | --- |
| Off | Nothing | Nothing | n/a |
| Read only | Its own mailbox | Nothing | n/a |
| Draft only | Its own mailbox | Drafts that the human sends | Every email |
| Allowlist | Its own mailbox | Freely to approved addresses and domains | New recipients need approval |
| Full discretion | Its own mailbox | Anyone, at its judgment | None, inside the limits below |

Limits that stay on in every sending mode, each adjustable:

- Daily send cap (default 20) and per-recipient cap (default 5 per day).
- Blocked content: credentials, private memory, other people's personal data, financial commitments, legal agreements.
- Never signs up for paid services or accepts terms without approval.
- Inbound mail is untrusted. Links and attachments open only in the sandbox browser. Instructions in emails are never executed, only reported.
- Every sent email is logged with a copy visible to the owner, and a daily digest is optional.
- Signature states it is an AI agent acting for the named human (on by default, can be turned off).
- One-click "pause email" in the tray.

Full discretion is available as requested. The setup screen should explain plainly that the agent can then email strangers on your behalf.

### Email commands: tasks by email, run in the cloud

You can email your agent and it does the work on the cloud runner, even with your PCs off. This is a separate toggle from the sending modes above. Replies to you are always allowed.

- **Checking.** The cloud runner watches the agent's mailbox with push (IMAP IDLE or Gmail push) where available, and polls every 5 minutes otherwise. Interval is adjustable.
- **Who it obeys.** Only mail that is from your registered address, passes DKIM and SPF, and carries your command marker. The marker is a private tag in the subject (for example `[FR-7k2q]`) or a reply in a thread the agent started. You can rotate it any time. Each agent obeys only its own human.
- **Everything else is data.** Forwarded mail, mail from anyone else, and quoted text inside your own mail are never treated as instructions.
- **What it does with your mail.**
  - A question: it answers by reply.
  - A task: it picks the project (or asks which), creates the task, and runs a cloud session.
  - A note: it goes into the next-session queue.
  - Attachments: saved to the project and opened only in the sandbox.
- **Acknowledgement.** Within a minute it replies with what it understood, the project, estimated cost and when it will start. When done, it sends a short summary with links to PRs, files and the session log.
- **Approvals by reply.** Anything above the email autonomy level is asked in a reply, and you answer "yes" or "no" by email. The same checks apply to your answer.
- **Limits.** Per-email cost cap (default CHF 5), daily cap on email tasks (default 10), and autonomy for email tasks (default level 2). All adjustable.
- **Billing.** Email tasks run on the cloud runner with your own billing source: your subscription if your runner is personal, otherwise an API key.
- **Audit.** Every email command, its interpretation and its result are logged together and visible in the app.

### Browser and desktop control

- Browser runs in its own profile, never the human's main one. Logins for agent-owned accounts come from the vault.
- Form submissions with personal data and accepting terms need approval below autonomy 4. Purchases always need approval.
- Desktop control is off by default, needs autonomy 3+, an app allowlist, and shows a visible on-screen indicator while active.

## Build order

Nine milestones, in order. They are internal checkpoints for the build agent, not releases or test periods. Each ends with checks the agent runs itself in the internal test environment. Every feature ships in 1.0; the order exists only because later milestones build on earlier ones. Safety controls arrive with the capability they protect.

&#91;embedded content: build phases · 8 phases, 8 gates\]

### Phase 0 — Foundations

- Create the `forerunner` and `forerunner-registry` repos from empty. Confirm or change the suggested stack in `docs/decisions/0001-stack.md`.
- Study aerovato/operator-memory and Headroom; write one ADR each on what to adopt.
- Set up monorepo, CI on Windows and Linux runners, lint, tests, sandbox image (Docker and Podman), release signing. Write the first \`AGENTS.md\` and \`docs/maintainers/\` skeleton.
- Create shared state schema v1 and migrations. Solo SQLite adapter and Postgres adapter behind one interface.
- Vault wrapper over the OS keychain. Setup wizard for GitHub and Anthropic keys with scope validation.

**Gate:** CI green on Windows and Linux. A scripted fresh install on clean Windows and Linux VMs completes setup in under 15 minutes. Keys never appear in logs (automated scan).

### Phase 1 — Single agent that does real work

- Agent runtime on the Claude Agent SDK. Principal agent plus coder, tester, reviewer specialists from the registry.
- Hard caps in hooks: budget (session, task, run), steps, spawn depth, tool allowlist.
- Startup checklist and state brief. Session end handoff and summary.
- Projects, milestones, tasks with dependencies. Create project from brief. Import from GitHub repo.
- Billing adapter: Claude subscription login and API key, with routing rules. Cost ledger with CHF view and plan-usage view. Kill switch. Text chat with the agent on a fast model, streaming.
- Minimal UI: home, project page, task log, live session view, settings.

**Gate:** On a sample repo in the test environment, one agent plans and completes 10 tasks via PRs without exceeding any cap. A deliberate overspend attempt is blocked by code. Kill switch stops everything within 2 seconds. The same session runs once on a subscription and once on an API key with correct usage recorded. Text chat first token under 1 s median.

### Phase 2 — Two agents, one project

- Shared state service live. Realtime inbox with receipts. Polling fallback.
- Atomic claims with expiry. Peer activity feed. Overlap warnings.
- Branch and PR flow with rebase-before-PR. Conflict → human request.
- Human request inbox with multiple-choice answers. Decision log.
- One-way mirror of tasks to GitHub Projects.

**Gate:** Simulated Alice and Bob each run 5 sessions on the same project, overlapping and not. Zero duplicate tasks, zero lost commits, every ack-required message acknowledged. Either install can be offline for 48 simulated hours without breaking the other.

### Phase 3 — Critic and quality loop

- Critic service with risk tiers, separate model, findings tracking, verdicts.
- Task cannot close with open findings.
- Golden eval set per specialist (start with 20 tasks each for coder and researcher).
- Retry and escalation ladder with ceiling.
- Reviews tab, grade trend chart.

**Gate:** On the eval set, critic catches at least 80% of seeded defects and passes at least 90% of clean work. Escalation never exceeds the ceiling. **The core loop is now complete and every later phase builds on it.**

### Phase 4 — Memory, docs and learning

- Private memory per agent, critic memory, shared lessons. Retrieval with token budget.
- Standard doc set maintained by PM; critic checks doc drift.
- Weekly consolidation with human review.
- Memory views in UI with edit and delete.
- Cross-project lesson promotion.

**Gate:** Over 4 simulated weeks on the eval projects, the repeat-finding rate drops. Memory loaded per session stays under the set token budget.

### Phase 5 — Human experience and voice

- Real-time voice conversation (module O) with local and cloud voice providers, push-to-talk and barge-in. Next-session queue with priorities and voice notes. Effort slider and Performance view.
- Autonomy levels 0–4 enforced per project.
- Notifications: desktop, email, Telegram or Signal, quiet hours.
- Dependency graph and milestone timeline. Project summaries with TTS.
- Natural-language control (module Q) with change cards, risk-based confirmation and the change log. Android app (module R) with pairing, sync, remote control and push.
- ZIP and folder import. Large dataset registration.

**Gate:** Simulated users run a full simulated week only through the UI and the Android emulator, no terminal, answering approvals on the phone. Voice replies reach first audio in under 1.2 s median on both platforms. Every settings change can be made by voice, chat or the UI, and each produces the same change log entry. From the Android app, a simulated user switches project, raises a budget and starts a session on his PC.

### Phase 6 — Capabilities

- Extensions panel and MCP connector catalog.
- Sandboxed browser. Agent email with all five modes and limits. Email commands that start cloud sessions. Desktop control behind autonomy 3+.
- Cloudflare integration for deploys.
- Cloud runner for hybrid mode, with vault unlock flow.
- Context compression proxy, savings shown.
- Prompt-injection test suite run in CI against browser and email.

**Gate:** Injection suite passes. Every capability can be revoked live from the panel. Cloud runner completes an overnight session while both PCs are off. An emailed task is acknowledged within 1 minute and completed in the cloud; a spoofed or forwarded email is ignored.

### Phase 7 — Self-improvement and model economics

- Forerunner managed as a Forerunner project. UI change requests become PRs.
- Signed updates, "Update and restart", health check, automatic rollback.
- Weekly model watch with eval-based recommendations.
- Estimate-vs-actual learning feeding the planner.

**Gate:** A UI change requested in plain language ships as an update both users install, and a deliberately broken build rolls back on its own.

### Phase 8 — Full integration and release 1.0

- Every requirement in `docs/requirements.md` is implemented and marked done with a test.
- End-to-end scenarios run on the final build, on Windows, Linux and Android:
  1. **The good day.** Notes left at night, a scheduled session runs, the peer's changes are picked up, work is reviewed, PRs open, a summary and questions arrive by morning.
  2. **Email task.** J emails a task with both PCs off. The cloud runner acknowledges it, does it, and replies with results.
  3. **Voice.** J asks for status by voice, approves a request by voice, and hears the read-back.
  4. **Collision.** Both agents try to take the same task. One wins the claim, the other messages and moves on.
  5. **Budget.** A session hits its cap mid-task and stops cleanly with a handoff.
  6. **Injection.** A web page and an email both try to hijack an agent. Both are reported and ignored.
  7. **Bad update.** A broken release installs, fails its health check and rolls back.
  8. **Handover.** A fresh agent with only the repo and docs fixes a seeded bug.
  9. **From the phone, by talking.** On the Android app J says "switch to the game, give it 15 francs until tomorrow and start a session on my PC". He gets one change card, confirms, the PC starts, and the change log shows it with undo.
- Every earlier gate is re-run on the final build.

**Gate:** all nine scenarios pass on Windows and Linux, with the phone scenario on Android, every requirement is done, and `gates.md` holds the evidence. Then run the Release 1.0 criteria and the release steps in the Build agent manual.

## Starting point

Phases 0 to 3 build the core loop every other feature plugs into: two peer agents that share one real project, never duplicate work, stay under hard budgets, and only close tasks the critic has evidence for. It comes first because everything else depends on it, not because anything else is optional.

### First tasks

- [ ] Create the `forerunner` and `forerunner-registry` repos with CI for Windows, Linux and Android
- [ ] Write ADR 0001 confirming or changing the suggested stack
- [ ] Write ADRs for operator-memory and Headroom adoption
- [ ] Build the internal test environment first (testenv/): fake provider, local Postgres, Gitea, mail server, simulated clock, simulated users
- [ ] Check every item on the human checklist, verify scopes, and record what is missing in BLOCKERS.md with its stand-in
- [ ] Scaffold monorepo: `app/`, `runtime/`, `state/`, `registry/`, `docs/`
- [ ] Schema v1 for the 14 core entities with migrations and tests
- [ ] Budget and depth hooks with a test that proves an overspend is blocked
- [ ] Startup checklist as code, producing a state brief under 2,000 tokens
- [ ] Setup wizard: GitHub and Anthropic keys, scope check, keychain storage
- [ ] CI with lint, tests, secret scan, Docker sandbox build

* [ ] Prove the Agent SDK runs on Windows and Linux with both a subscription token and an API key, and record what each reports for usage
* [ ] Write `AGENTS.md` and the `docs/maintainers/` skeleton, with the docs check in CI

## Open decisions

Every open question has a default so the build never waits. The agent uses these unless a human changes them.

| Decision | Recommended default | Reason |
| --- | --- | --- |
| Final name | Forerunner (decided) | Fixed for this build |
| Shared state source of truth | Postgres for state, git for code and docs | Atomic claims and receipts need a database |
| Messaging | Message table + realtime, mirrored to GitHub | Receipts and speed; humans still see it in GitHub |
| Private memory storage | Owner's machine, encrypted backup to their own cloud slot | Keeps identities separate |
| Providers at launch | Anthropic first, adapter interface ready for others | One SDK, faster core loop; other providers plug into the adapter later. The critic gets independence from a different tier and a clean context, not a different vendor |
| Model ladder | Haiku → Sonnet → Opus → Fable, ceiling Opus by default | Top tier only by explicit project setting |
| Starting specialists | All ten in module C; build coder, tester, reviewer, researcher first | The core loop needs these; the other six from module C follow, each with an eval set |
| Default autonomy | Level 2 (Standard) | Routine reversible work runs, risky work asks |
| Mandatory critic review | Tier 2+: anything touching main, security, data, money, or science claims | Keeps cost down on trivial tasks |
| Grade calibration | 0–100 with confidence, anchored to the golden eval set | Comparable across task types |
| Budget enforcement | Runtime hooks before every call, plus provider-side spend limits | Two layers |
| Default monthly cap | CHF 150 per human, session cap CHF 5 | Adjust after the first month of real data |
| Log detail | Readable events by default, raw toggle | Matches the "no terminal" goal |
| Update distribution | Signed GitHub Releases, staged install, auto rollback | Standard and auditable |
| How much Forerunner controls its own development | Agents open PRs; humans approve every release | No silent self-modification |
| Scope | Everything in this spec, integrated | Phases set order, not scope |
| Agent email default | Draft only, Full discretion available per agent | Matches J's request with a safe start |
| Cloud runner host | Fly.io or a small VPS, Docker | Simple, cheap, same image as the sandbox |

More defaults:

| Decision | Recommended default | Reason |
| --- | --- | --- |
| Billing default | Subscription first, API key as fallback and for the cloud runner | Uses the flat fee you already pay |
| Voice stack | Local faster-whisper + Kokoro, Deepgram + Cartesia as the fast cloud option | Free and private by default, sub-second when needed |
| Chat model | Haiku 5.5 at low effort | Fastest current Claude model |
| Step cap per session | 200 steps | Stops loops without cutting real work short; tune after data |
| Claim expiry | 30 minutes without renewal | Long enough for slow tasks, short enough after a crash |
| Supported OS | Windows 10/11 and Linux (Ubuntu 22.04+, Fedora); macOS best effort | Matches the machines in use |

**Remaining defaults:** each human pays for their own agent's model use, and shared infrastructure costs are split evenly. The system supports any number of collaborators and is tested with two and three. Test projects are generated samples plus Forerunner itself. macOS is best effort.

## Sources

- [Headroom, context compression layer for AI agents](https://github.com/chopratejas/headroom)
- [Claude Agent SDK overview](https://agentpatterns.ai/tools/claude/agent-sdk/): budget caps, hooks, subagents
- [Subagent permissions and caps](https://dev.to/waxell/subagent-permissions-are-inherited-by-default-and-the-caps-live-inside-your-code-i): subagents inherit all tools unless restricted; budget has no default limit
- [aerovato/operator-memory](https://github.com/aerovato/operator-memory/tree/main): reference only, not read for this doc

* [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): as of the 7 October 2026 update, SDK and third-party apps can use subscription limits; Max and Team plans include monthly API credits
* [Subscription login for the Agent SDK](https://github.com/anthropics/claude-agent-sdk-python/issues/559): `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN`
* [Claude Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview): fastest model, effort parameter, non-default temperature rejected
* [What's new in Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5): effort controls depth, latency and cost; fast mode preview
* [Voice latency playbook](https://dograh.com/hub/blogs/speech-latency): where voice-agent latency goes and the sub-second budget
