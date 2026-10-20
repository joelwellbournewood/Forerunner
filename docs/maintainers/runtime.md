# Runtime

`packages/runtime`: the orchestrator. Agent drivers, enforcement hooks, budget accounting,
capability tokens, kill switch, model ladder, delegation briefs, injection scanning, sessions.

## Purpose

Every model call and tool call Forerunner makes passes through this package. "A prompt can ask;
only code can allow" lives here. ADR 0004 explains the two drivers; ADR 0007 the sandboxes.

## How it works

### Authority: capability tokens (`src/enforcement/token.ts`)

A run gets a `SignedToken`: HMAC-signed claims (allowed tools, allowed path roots, allowed
domains, granted secret names, run budget, depth and max depth, autonomy level, expiry). The
model only ever sees the token id. `TokenIssuer.derive` builds a sub-agent token that can only
narrow the parent (intersection of lists, min of budgets, depth + 1, depth cap enforced).
`revoke`/`revokeWhere` are used by the kill switch.

### Enforcement hooks (`src/enforcement/hooks.ts`)

| Hook | Checks, in order |
| --- | --- |
| `beforeModelCall(ctx, estimate)` | token valid and not revoked, kill state, session wall clock, run deadline, step cap, run cap, session cap with 80% finish-current and review reserve, outer caps (task, project, month, plan share) via `CapsPort` |
| `afterModelCall(ctx, usage, usd)` | records spend in `SessionBudget` and the ledger |
| `beforeToolCall(ctx, tool, input)` | token/kill, step, tool allowlist, zod schema, path containment for `pathFields`, domain allowlist for `domainFields`, autonomy decision (may ask `ApprovalPort`; pending pauses the run), secret-ref resolution for granted names only; denials are audited |
| `afterToolCall(ctx, tool, input, result)` | redacts resolved secrets, wraps untrusted output in the data envelope and scans it for injection, audits |

The per-session accounting is `SessionBudget` (`src/enforcement/budget.ts`): run and session
caps, step cap, wall clock, the 80% rule and the review reserve (default 20%). The estimate
before a call is conservative: full input at input price plus `max_tokens` at output price.

### Autonomy (`src/enforcement/autonomy.ts`)

Action classes map to decisions per level 0–4. `destructive`, `financial`, `credential`,
`permission_change` and `capability_grant` need a human at every level. Level 0 proposes only,
level 1 runs routine work after plan approval, level 2 frees routine reversible work, level 3
also merges reviewed PRs and deploys to staging, level 4 everything else.

### Kill switch (`src/enforcement/killswitch.ts`)

Registered runs (abort controllers) and child processes are stopped, tokens revoked and claims
frozen through a callback; the test proves 40 runs and 3 processes stop in under 2 s. A stopped
scope stays frozen (new registrations abort at once) until `resume()`.

### Drivers

`LoopAgentDriver` (`src/agent/loop.ts`) runs the tool loop over any `ModelProvider`
(`src/provider/types.ts`): estimate → `beforeModelCall` → stream → cost → `afterModelCall` →
for each tool use: `beforeToolCall` → execute with per-tool timeout → `afterToolCall`. Outcomes:
`completed`, `timeout` (partial text kept), `budget_exceeded`, `step_cap_exceeded`, `killed`,
`needs_human` (approval pending), `max_turns`, `error`. Events stream to the live session view.
`SdkAgentDriver` (`src/agent/sdk.ts`) wraps the Claude Agent SDK with the same hooks.

**Specialist tools on each driver (`src/registry/tools.ts`, ADR 0043).** The registry names
Claude Code tools (`allowed_tools: cc:Read, cc:Edit, cc:Bash, ...`) for the SDK driver, which
offers that tool set as is. The loop driver offers Forerunner's tools, so each driver maps the
names its own way and the choice is made in `composeRuntime` next to the driver it builds
(`specialistDriver`, "loop" today; the SDK driver has no session path yet). `specialistSpecFrom(
registry, { driver, tools, commands, onDropped })` turns a runnable entry into the executor's
`SpecialistSpec`; the options are required, a call without a driver is a `validation` error,
and an executor built elsewhere (the cloud runner) takes `RuntimeApp.specialists`, never the
registry's names by omission. On "sdk" the `cc:` names stay as written; on "loop" `loopToolsFor` replaces
them with the built-ins (`CLAUDE_CODE_TOOL_EQUIVALENTS`: `cc:Read`, `cc:NotebookRead` →
`read_file`; `cc:Write`, `cc:Edit`, `cc:MultiEdit`, `cc:NotebookEdit` → `write_file`;
`cc:Glob`, `cc:Grep`, `cc:LS` → `list_dir`; `cc:Bash` → `run_command`), resolved against
`toolsForRun().names()` at every lookup (a bridged extension tool passes through while it is
registered; only the table's own entries map, so `cc:constructor` is an unknown name). The cap
holds: nothing is added that the entry did not name, `cc:Read` never yields `write_file`, and
`cc:Bash` yields `run_command` only when the entry has `requires_sandbox: true` or the
composition sandboxes every command (the daemon does: it always wires a `RunSandboxPort`, the
executor pins `run_command` to the run's lease and a lease the port refuses ends the run before
any command, so `composeRuntime` passes `commands: () => true`). `cc:WebFetch`,
`cc:WebSearch`, `cc:Task`, `cc:TodoWrite`, an unknown `cc:Foo`, a bridged tool that has gone,
or a command runner the policy refuses are dropped, never silently: `droppedToolAudit` writes
one `registry.tool_unmapped` audit row per specialist and tool (`allowed: false`,
`input_summary: "<specialist>: <tool>"`, the reason in `denied_reason`), for every runnable
entry at compose (awaited before the first run) and for a drop a later run start discovers.
`LoopTaskExecutor` derives the run token from the spec's `allowedTools`, so the hooks check the
names the driver calls and a call outside the grant is `tool_not_allowed` with its own row.
`RuntimeApp.specialistDriver` and `RuntimeApp.specialists` expose the choice and the mapped
specs; the model watch's eval runner uses the same `loopToolsFor` (commands only with a sandbox
port) and logs its drops. Tests: `test/registry-tools.test.ts`, `test/cc-tools-wiring.test.ts`.

### Context layer (`src/context/`, ADR 0003)

Requirements covered: N.1 (compression proxy, toggle per project, savings measured), N.2
(stable prefixes and `cache` marks for prompt caching), I.7 (savings shown separately; the
money side is in `billing.md`).

**Native baseline (always on).** `collapseLogs` (CRLF, ANSI, trailing spaces, progress bars,
repeated lines), `elideDenseLines` (minified/base64 lines), `dedupWithinBlock` and
`CrossTurnDedup` (repeated windows inside a block and across earlier tool results of the same
transcript, always keeping the earliest occurrence), `truncateWithErrors` (head/tail with error
lines and test summaries kept). `ContextPipeline` is one per session (settings, token counter,
the original-block store, the measurement records); `pipeline.beginRun({ maxChars })` gives a
`RunCompressor` for one transcript, and `compressToolResult(text, tool, bypass)` on it applies
the transforms to the live zone only (the newest tool result), never grows a block, records
tokens before/after and the transforms used, and honours per-tool profiles (`read_file` 16k cap,
diffs skip dedup). The cross-turn index belongs to the run compressor, never to the session: a
`[same as tool result #k lines a-b]` reference can only name the k-th tool result of the same
transcript (k is transcript-relative), and the index registers a result *as sent* (after
truncation and under the loop's hard character cap, `CrossTurnDedup.fold` then `remember`), so
the lines a reference names are lines the model has. Two runs of one session sharing the
pipeline never reference each other's results. `pipeline.compressToolResult` without a run is a
one-block run of its own (no cross-turn references). `pipeline.mark()` / `pipeline.savings(since)`
measure one run inside a session (`PipelineSavings`: tokens before/after, saved, distinct
transforms, records).

**Originals (`originals.ts`).** The original of every changed block is written, after
`redact()`, to `join(appDirs().cache, "context", <sessionId>, <hash>.txt)` (`ContextOriginals` →
`SessionOriginals.write/read/list`, `originalHash` = 12 hex chars of SHA-1), so the log view can
show it and a retry can re-expand it; `CompressionRecord.original` carries the hash. The
`truncate` marker names the hash (`[... N lines omitted; original <hash>]`) only when the
pipeline has a store and the write succeeded; without a store, or when the write failed, the
marker is bare, so it never points at nothing. There is no session retention mechanism yet:
`ContextOriginals.prune(now, maxAgeMs)` deletes session directories older than 30 days
(`originalsMaxAgeMs`) when the manager starts, and `remove(sessionId)` deletes one session's
directory. `cache-layout.ts` keeps the prefix
stable: compacted tool schemas, `layoutSystem` order (registry prompt → project brief →
instructions → pinned lessons), `assertStablePrefix` rejects timestamps, UUIDs, JWTs and hashes in
the system prompt, `volatilePreamble` puts them in the first user message. `fitToBudget` is the
greedy retrieval-under-budget helper used by memory.

**Where it runs.** `LoopAgentDriver` begins a run compressor on the session's pipeline
(`RunRequest.context`; without one the run gets a private native pipeline) with the run's hard
cap (`maxToolResultChars`, 60k) and compresses every tool result before it joins the transcript,
emits a `context_compressed` run event per compressed result (numbers only, never
content), passes `compression` through on the `ModelRequest`, and returns
`RunResult.context` (`RunContextStats`). Compression never throws into the loop (a failing
transform leaves the result as produced and emits a warning) and the budget hook counts the
request after compression, so savings lower spend but cannot bypass a cap. The per-call bypass
`compression: "off"` (`RunRequest` and `ModelRequest.compression`) leaves tool results
byte-identical: the critic, evals and the model watch use it.

**Per project (`settings.context`, section 4 of the ADR).** `contextSettingsFrom(project.settings)`
reads `{ compression: "off" | "native" | "headroom" (default "native"), maxToolResultTokens,
toolProfiles }` with the defaults in code; malformed input falls back to the defaults. `off`
disables every transform except the cache layout; `headroom` means native plus the proxy when it
is available, never silently off.

**Headroom proxy (`headroom.ts`, optional, never a dependency).** `HeadroomPort` is the seam:
`probe()` (`GET /health` on `FORERUNNER_HEADROOM_URL`, else `http://127.0.0.1:${FORERUNNER_HEADROOM_PORT ?? 8787}`,
500 ms through the `Clock`; available only for `{ status: "healthy", ready: true }`) and
`tokensSaved(projectId)` (`GET /stats` → `projects[id].tokens_saved`, null when unreachable).
`HeadroomAdapter` is the real one: it tells `not_installed` (no `headroom` on PATH) from
`not_running` and `unhealthy` (wedged or not ready) and rejects a non-loopback URL with
`validation` because the proxy sees the credential (`headroomFromEnv` turns that into a
`NoHeadroom` port with the reason). `selectCompression(policy, port)` turns the policy into the
effective mode: `native` and `off` never probe; `headroom` probes and degrades to native with a
`notice` (never silent). `managedHeadroomArgv` / `ManagedHeadroomProcess` cover
`FORERUNNER_HEADROOM_MANAGED=1` (`headroom proxy --host 127.0.0.1 --mode cache --no-ccr
--lossless --no-cache`, logs to `<logs>/headroom.log`, stopped on daemon close and, through
`bindKillSwitch(kill)`, on a global kill-switch stop; a scoped stop of one agent or session
leaves the shared proxy alone). Routing: `AnthropicMessagesProvider.viaProxy(url,
headroomHeaders(projectId))` sends the same credential through the proxy with
`X-Headroom-Project`; `headroomSdkEnv` gives an SDK subprocess `ANTHROPIC_BASE_URL` and
`ANTHROPIC_CUSTOM_HEADERS`, and `SessionContext.sdkEnv` holds it for the session (null unless the
proxy is in use) so a caller of `SdkAgentDriver.run({ env })` routes through the proxy exactly
when the in-process loop would. A provider without `viaProxy` (the fake) keeps `headroom_used`
false.

**Per session (`manager.ts`).** `ContextManager.forSession(sessionId, projectId)` resolves the
project's settings, probes once when the policy is `headroom`, creates the session's pipeline
(with its originals directory when `originalsDir` is configured; `composeRuntime` passes
`join(dirs.cache, "context")`) and remembers the proxy's `tokens_saved` baseline. While the
session is open and the policy is `headroom`, a timer on the session's `Clock`
(`clock.setTimeout`, `HEADROOM_REPROBE_MS` = 60 s, rescheduled after each probe) re-probes
without any task having to start: a proxy that died drops the session to native with one notice
and `sdkEnv` null; one that came back is used again from the next run on, silently. `endSession`
cancels the timer and returns the pipeline totals and the `/stats` delta; `close()` cancels every
timer on daemon close. `originalsFor(sessionId)` is the log view's handle on the stored originals. `SessionRunner` calls it at start (emitting
`context.headroom_unavailable` once when Headroom was asked for and is not usable) and at end
(`session.headroom_saved_tokens`, plus `compressionSavedTokens` / `headroomSavedTokens` /
`headroomUsed` on `session.ended`). `LoopTaskExecutor` runs each task with the session's pipeline
and the proxied provider when selected, and records `tokens_before_compression`,
`tokens_after_compression`, `context_transforms` and `headroom_used` on the Run row through the
run repo. `composeRuntime` wires `headroomFromEnv(env)` (or `opts.headroom` in tests), the
manager (settings from the project row) and a `CostLedger` over the store that the cost view
uses to price the savings (`costView(store, filter, chfPerUsd, rt.costLedger)`).

Not adopted for 1.0 (ADR 0003): JSON array thinning and old-turn summarisation (phase 4), ML and
AST compression, CCR, output shaping. The Extensions-panel entry for installing Headroom is not
wired yet (see Known issues).

### Command line and setup (`src/cli/main.ts`, `src/setup/`)

`pnpm fr -- <command>` (installed as `fr`): `setup` (guided or `--non-interactive`; each
credential is explained with what, why, scopes, where to click and how it is verified, validated
on paste through `src/setup/validators.ts`, then stored in the vault by name; `config.json`
never holds a secret), `status` (directories, config, secret names only), `doctor`
(prerequisites), `kill` (writes a kill request file), `dirs`, `daemon`. The kill request file
in the runtime directory is polled by `KillFileWatcher` in every running runtime, so the CLI,
the tray and the app can stop sessions across processes on both platforms.

Every `setup` run also writes the install record `<config>/install.json`
(`src/setup/install-record.ts`, ADR 0026): `{ schema: 1, installDir, node? }`, where
`installDir` is the checkout this process runs from (derived from `import.meta.url`, so a
staged version directory records itself) and `node` is `process.execPath`; nothing in it is
configured or hardcoded. The desktop shell (`apps/desktop/src-tauri/src/install.rs`) reads it
after `current.json` and `FORERUNNER_INSTALL_DIR` to find `fr` without `pnpm` or `PATH`.
`parseInstallRecord` mirrors the shell's rules (schema must be 1, `installDir` non-empty,
`node` optional, an empty string counts as absent) and the write is atomic (temp file, fsync,
rename). `cli.test.ts` covers the written record and the parser.

`buildProgram(deps)` builds the commander program (tests inspect it; the module parses
`process.argv` only when it is the entry point). The module commands registered on it:

| Command | Backed by | Notes |
| --- | --- | --- |
| `fr update check\|apply\|rollback\|status\|health\|keygen\|sign` | `registerUpdateCli` with `composeUpdateManager({ runningVersion })` | A manager of its own over the configured store; no daemon needed. `apply` stages the release and asks for a restart (a CLI cannot relaunch the app). |
| `fr models watch\|report` | `registerModelWatchCli` over the composed runtime's `modelWatch` | Runs the weekly model watch now, lists reports. |
| `fr mirror sync\|enable\|disable` | `registerMirrorCli` over the composed runtime's `store` and `mirror` | One-way GitHub Projects mirror. |

Commands that need the whole product compose it once through `composeRuntime` (the same
wiring as the daemon) with `startServices: false`, a one-shot: the composed objects exist but no
connector is started, the scheduler never ticks and the kill-file watcher is off; a `postAction`
hook closes it. `fr daemon` composes with the services on, keeps the runtime open and closes it
on SIGINT/SIGTERM or a restart request through a bounded shutdown (`EXIT_DEADLINE_MS`, 8 s):
the server's `stop()` ends the SSE streams and closes the connections, the store is closed,
and the process exits with the requested code even if a step hangs.

### Sessions (`src/session/`, `src/wiring/state-ports.ts`)

`SessionRunner.start` owns one working period (spec E): it creates the session row, runs the
startup checklist as code (`checklist.ts`: version check, git fetch, shared-state pull, inbox,
open human requests, open critic findings, budget, diff since the last session, ready and
claimed tasks, peer claims, next-session queue) and renders a `StateBrief` under 2,000 tokens
(`brief.ts`, lists shrink until it fits). The `Planner` port produces a `SessionPlan`
(`StaticPlanner` = ready tasks by priority; a model planner uses the principal prompt); plans
over the work budget (cap minus the review reserve) are cut before starting. Autonomy 0 and
unapproved level 1 turn the plan into a HumanRequest and pause. Execution claims each task
(atomic, renewed every ttl/6), transitions it to in progress, runs the `TaskExecutor`
(`LoopTaskExecutor`: validated brief, derived narrower token, specialist prompt and model from
the registry, Run row recorded), then moves it to done (tier 0 with checks passed), in review,
needs human or failed; the inbox is re-checked between tasks and a human "stop" ends the
session; at 80% of the budget or a mid-task cap no new task starts. Session end writes the
project summary cache, sends a handoff (requires ack) to the project's peers
(`settings.members` or agents that touched the project), notifies the human and records the
session summary, handoff and spend. `triggers.ts` is the scheduler (daily, weekdays, every N
minutes in the human's time zone; message, CI, PR comment, email, remote and manual requests;
one active session per agent; quiet hours defer non-manual triggers). `state-ports.ts` adapts
the store to the enforcement ports: ledger rows with CHF at the day's rate, audit rows, and
approvals as HumanRequests whose "yes"/"no" answers resolve the pending tool call.

**The next-session queue (spec J.2).** The checklist reads the project's `queued` items
(`store.queue.pending`, priority first) into `brief.queue.items` with each row's `id` and
`version`; the renderer prints kind, priority and text only. Right after the `session.brief`
event and before the plan, `SessionRunner.consumeQueue` marks exactly those items consumed
(`status: consumed`, `consumed_by_session` = this session) in one `store.transaction` with one
audit row `queue.consumed` (`QUEUE_CONSUMED_AUDIT_TOOL`: the session and the item ids consumed
and skipped, never the text) and a `queue.consumed` event (`ids`, `count`, `skipped`). Every
item goes through `QueueRepo.consume(id, version, sessionId)`, so the workflow graph
(`queued -> consumed`; a dismissed item is never consumed) and the version the checklist read
are both checked in the store: an item the human dismissed or edited in the UI while the
checklist ran (git fetch, sync and memory recall sit between the read and the consume) is
skipped with its reason (`validation`, `version_conflict`, `not_found`), left as it is and
named in the audit row, the event carries a warning, and an edited note reaches the next
session once more with its new text; any other store error fails the session. An item
enqueued after the checklist read the queue is not in the brief and stays queued for the next
session. A session that fails before its brief is written (the checklist throws) consumes
nothing. The decisions the spec leaves open are these: the consume happens in the runner once
the brief exists rather than in the checklist (a checklist that is only rendered, as in tests
and the conversation agent, must not consume), a moved item is skipped and reported rather
than failing the session, and the audit kind is `queue.consumed`. Tests:
`runner-queue.test.ts` (two sessions on one project: three notes before the first, one left
while it plans, the first brief lists three and they are consumed by session one, the second
brief lists only the fourth; dismissed before and during; edited during; a checklist that
throws consumes nothing; no items, no row), `checklist-queue.test.ts` (id and version on the
items, consumed and dismissed out, ids not rendered), and the state suite's queue tests on
both dialects (version conflict, dismissed never consumed, rollback inside a transaction).
Requirements: J.2, E.2.

**The Run row.** `LoopTaskExecutor` inserts the task's Run row as `running` before the driver
starts (model, effort, prompt version, billing source, depth) and patches it with the result
afterwards: tokens, cost, `ttft_ms`, `duration_ms`, outcome, `timed_out`, the context numbers
and the artifacts; a driver that throws closes it as `error` with the reason. `ttft_ms` and
`duration_ms` are INTEGER columns and the store refuses a fraction, while `performance.now()`
differences carry one, so every millisecond measurement is rounded where it is produced
(`LoopAgentDriver`: `wholeMs` on each call's first-token time and on the run and tool
durations) and again at the write (`wholeMs` on the patch): a Run row is always written with
whole numbers. The first live run (ADR 0040) found the gap: a fractional `ttft_ms` was refused,
the error swallowed, and every coder run stayed `running` with cost 0. A Run row the store
still refuses never stops the session: the result reaches the runner, and the failure is an
`error` line through the runtime logger plus an audit row `run.persist_failed`
(`RUN_PERSIST_FAILED_AUDIT_TOOL`: the run, session, agent and human ids, the stage `end` or
`error`, the store's message; never the prompt, the brief or the report), so a run history that
disagrees with the cost ledger is traceable. Tests: `executor.test.ts`, `loop.test.ts`.

### Decision log (`src/wiring/state-ports.ts`, `DecisionLog`)

Answered decisions are recorded per project and never asked again unless superseded (spec
J). `DecisionLog.ask()` opens a request of kind `decision` only when the project has no
current answer to the same question (matching is case- and whitespace-insensitive through
`decision.question_normalised`); otherwise it returns the recorded decision and opens nothing.
The daemon's answer route calls `recordAnswer()` for every answered decision request; a
different answer to the same question supersedes the older row, the same answer is a no-op.
`GET /projects/:id/decisions` lists the current decisions for the UI.

### Message receipts (spec F)

Every message carries delivered, read and acted-on timestamps. The runner marks what the brief
shows as delivered and read at session start and between tasks. An ack-required handoff,
warning, decision or info message is acted on by being read into the plan; an ack-required
question or request is acted on only when this agent has replied to it (`reply_to`), checked
at session end. Messages this agent sent that nobody acted on resurface at its next session
as an `inbox.unacknowledged` event and as a count in the brief.

### Peer awareness (`src/session/peers.ts`)

At startup and again before every task the runner builds a peer feed from the store: for each
peer on the project (the project's `settings.members`, else every principal that touched it)
its active claims, open pull requests, last handoff and the files it has in flight. Files come
from two places: the `in_flight_files` map every handoff carries (filled from the PR executor's
`changedFiles`) and `task.files` events of the peer's running sessions. The feed is appended to
the planner's brief (`peers.feed` event) and `detectOverlap` compares the planned task against
it: a claim, an open PR or an in-flight entry of an online peer for the same task skips the task
(`task.skipped` with reason `peer_in_flight`) and a path hint in the task text that meets a file
the peer has in flight sends a `warning` message before work starts and continues. Each
(peer, kind, task) triple is reported once per session.

The feed also carries the shared store's `schemaVersion` and, given the sync gate
(`PeerFeedInput.schemaSync`, the runner's `SessionRunnerDeps.schemaSync`), hands it to the
gate first and is refused (`unavailable`) while sync is paused; `SessionRunner.start` asks the
gate before the session row exists. Spec M's "compatible version before sync resumes" is
enforced there and in `compose.ts` (`updates.md`, "The wired gate"): the scheduler's `start`
asks the gate for a session and for a scheduled mirror run alike, while the model watch and
the memory consolidation, local jobs, are routed before the gate and keep running on a paused
install.

### The core loop: critic, memory and commands (`src/loop/`, [ADR 0036, core loop integration](../decisions/0036-core-loop-integration.md))

Phase 3 of the build order closes the loop: a task's run is reviewed by the critic at its
tier, the verdict moves it through the state workflow and the retry ladder, lessons flow in
at session start and out at session end, and every change by chat, voice, the UI or the phone
runs the same command. The runner, the executor and the conversation agent reach the three
packages only through the ports in `src/loop/ports.ts` (`CriticPort`, `MemoryPort`,
`ConversationCommands`); `src/loop/critic.ts`, `memory.ts` and `commands.ts` implement them
over `@forerunner/critic`, `@forerunner/memory` and `@forerunner/commands`, and `compose.ts`
wires them (`RuntimeApp.critic`, `memory`, `commands`, `criticAgent`). Tests run the runner
with fakes of the ports (`test/loop-memory.test.ts`) and with the real implementations on the
fake provider (`test/loop-critic.test.ts`, `test/conversation.test.ts`, `test/loop-routes.test.ts`,
`test/loop-commands.test.ts`).

**Critic (`CriticLoop`, spec H, B.4, D.2, D.3).** After `TaskExecutor.execute` returns
`done` or `in_review` for a task above tier 0, the runner moves it to `in_review` and calls
`reviewTask` with the task, the session token and budget, the plan item and the result. The
loop assembles the evidence (the diff from the task's worktree through `GitDiffPort`, or the
executor's `changedFiles`; the project's `settings.checks` as argv commands the critic runs at
tiers 2 and 3; the standard-doc drift at tier 2+ as a non-required check; the final report as
claims; the attempt and the specialist as artifacts), runs `CriticService.review` at
`task.risk_tier` with the project's `critic_ceiling` and `speed_quality_offset` (read from the
project row), and applies the verdict with `applyVerdict`:

| Verdict | What the runner sees | Task |
| --- | --- | --- |
| accept | `decision: "accepted"`, the earlier findings resolved against the run | `done` (`SessionResult.completed`) |
| accept with a foreign open finding | `decision: "blocked_by_findings"` (the store threw `findings_open`), `task.blocked_by_findings` event with the blocking request's id | stays `in_review` (`blockedByFindings`) until the human answers the request |
| revise | `decision: "revise"`, `attempt + 1`, a `request` message to the owner | `ready` (`retried`) |
| escalate | `decision: "retry"` with `retry` = `improve_brief` / `split_or_change_specialist` / `escalate` (`nextTier` under the ceiling), or `human` after the ladder | `ready` or `needs_human` |
| human, or revise after the last rung | `decision: "human"` with the blocking sign-off request | `needs_human` |

The retry ladder is derived from `task.attempt` (counted by the store on `failed -> ready`;
a run never counts itself): `LoopTaskExecutor` puts the open findings and the rung into the
brief's constraints (`retryConstraints`) and runs attempt 3 one model rung up when the
ceiling allows (`tierForAttempt`). Tier 0 tasks keep the mechanical path (checks only, no
critic); the store still refuses to close one with an open finding and the runner surfaces
it. Both blocked paths end with the human (`src/session/findings.ts`): the runner files one
blocking request per task (`change_card.key = "findings:blocked"`, options `rework` /
`accept` / `cancel`, reused while open) and `syncBlockedByFindings`, run from
`RuntimeApp.syncApprovals()` after every inbox answer, applies it: `rework` goes
`failed -> ready` with the findings as the next brief's constraints, `accept` resolves the
open findings against the run and closes the task, `cancel` cancels it; the card records
`applied_at` and the outcome. At session end `reviewSession` runs the critic's honesty, plan and cost checks on the
stored summary (tier 0 by default, `SessionRunnerDeps.sessionReviewTier`), persisted as a
review with `session_id` set; `critic.session_review` carries the grade and a `human` verdict
as an escalation. Lesson proposals (repeat findings) are recorded in critic memory through the
memory port. Events: `critic.review_started`, `critic.verdict`, `critic.review_failed`
(the task stays in review), `critic.session_review`, `task.blocked_by_findings`.

**Memory (`MemoryLoop`, spec G, E.5, N.4).** At session start the runner asks `recall` with
the state brief as the query under `settings.memory_token_budget` (default
`DEFAULT_MEMORY_TOKEN_BUDGET`, 1,500 tokens); the block joins the planner's brief as data
after the peer feed. The grant is issued from the agent kind (`grantFor`): a principal reads
its own private scope and shared, the critic reads critic and shared, a specialist nothing.
The budget is enforced in code twice (the package cuts to it, the runner drops a block over
it: `memory.over_budget`). `LoopTaskExecutor` loads lessons for the task text under
`settings.task_memory_token_budget` (default 400) into the specialist's brief, tagged with
the specialist's name. At session end `record` stores, in the agent's private memory, the
`Lesson: ...` lines of the specialists' reports (`lessonsFromReport`), the critic findings
the rework resolved (the finding row's description and required action), and the decisions
the human answered since the last session; the package merges near duplicates. Every
candidate first passes the injection gate (`src/session/lessons.ts`, `screenLessons`: the
general scanner plus lesson rules for a shell pipe, an order to skip a guard, an operator's
note, a standing order, a direct address, a URL to execute); the executor, the runner, the
critic loop and `MemoryLoop.record` itself all run it, a rejected candidate is never stored,
`memory.lessons_rejected` names its rules, `memory.recorded` counts it (`rejected`,
`quarantined`), and the human gets a `warning` message quoting it. Weekly consolidation is a
scheduler entry (`scheduleMemoryConsolidation`, `MEMORY_CONSOLIDATION_AGENT_ID`;
`startSession` routes it to `memory.propose()`): a report-only run per scope files one
approval request (`change_card.key = "memory:consolidation"`, options `apply`/`skip`);
`syncApprovals()` re-reports each scope and applies an answered one with `apply: true` only
when the same lessons would still be merged, flagged and retired (`sameProposals`); a drifted
scope is marked `stale` on the card and proposed again. The memory views (`list`, `edit`,
`pin`, `remove`) back the daemon's `/memory` routes and stop at the human boundary: a private
scope or row of another human's agent answers `not_found`; `remove` retires the row and
deletes its file. Events: `memory.loaded`, `memory.over_budget`, `memory.load_failed`,
`memory.recorded`, `memory.lessons_rejected`, `memory.record_failed`.

**Commands (`CommandLoop`, spec Q).** The registry (`defaultRegistry`), the executor and the
intent parser behind one object. `contextFor(turn)` builds the `CommandContext` for every
caller: the human as actor, the principal, the active project (`activeProjectOf`), the
human's time zone, the paired device, the conversation session for the activity event, and
the source (`chat` for text and the phone, `voice` for voice). The conversation agent calls
`parse` (deterministic; `matched: "none"` means the model answers), `compose` (one card, one
change log row for a combined request), `tools` (the command tools for the model path),
`confirmByText` and `undo`; the daemon calls `execute`, `confirm`, `cancel`, `pending`,
`changeLog` and `undo`. `start()` persists the command table and re-arms the reverts of
temporary changes after a restart; `stop()` cancels the timers. `sessionCapFromSettings` is
how the scheduler's `startSession` reads the cap the registry wrote (a temporary override
while its window is open, else `session_cap_usd_micro`), so a session started by the
scheduler honours "give it 20 francs tonight" (spec Q.12). `sessionCommandPorts` builds the
registry's `startSession` and `kill` ports over the scheduler and the kill switch:
`session.start` answers `{ outcome: started | queued | deferred }` (the session id is never
known synchronously), and its undo (a kill of the agent's scope with
`SESSION_START_UNDO_REASON`) drops a waiting request (`Scheduler.cancelPending`) instead of
stopping the session the agent is running; a start that ran is stopped as before.

### Conversation agent (`src/conversation/agent.ts`)

The fast channel for text and voice (spec O, J, Q): Haiku at low effort, a stable cached
system prompt (project summaries) and a volatile first message (time, active project, unread
count, open requests, running sessions). It has no tools of its own: what the human says is
parsed into commands first (no model call), a combined request becomes one change card read
back in the reply (`pendingConfirmation` with the commands and whether a yes or the paired
device confirms), a plain "yes"/"ja" or "no" answers the card without a model call, "undo"
undoes the latest undoable change, the parser's questions (an ambiguous project, a budget
without a time) are asked with options (`question`), text that is data (the envelope) is
refused without a model call, and only a sentence no pattern understands goes to the model,
which is offered the registry's command tools and nothing else. Every change lands in the
change log with the words used and the undo token (`actions[].undoToken`). Each model turn
runs through the loop driver with its own small budget and a token at autonomy 4 (the human
is giving instructions; the registry's confirmation policy guards by risk); the run is
registered as protected so scoped and global stops never cut the human's channel.
Transcripts are events on a per-agent conversation session (`chat.human`, `chat.reply`,
`chat.confirmed`, `chat.cancelled`, and the executor's `change` events). Without a command
port the chat is read-only.

### Local daemon (`src/daemon/`, ADR 0011)

`compose.ts` is the composition root: `composeRuntime()` opens the store and vault under
`appDirs()`, builds the token issuer, kill switch, hooks, loop driver, provider registry
(Anthropic when a credential is in the vault, the fake provider under `--provider fake`,
otherwise a provider that fails every call with `provider_auth`), the specialist registry,
the session runner, scheduler and conversation agent, and returns a `RuntimeApp` with a
`close()`. It also bootstraps identity on first run (one human, one principal agent) and seeds
the billing source from the vault. `DynamicCaps` turns a human's monthly cap and a project's
budget into per-call caps so the cap checker never runs with stale limits. There is exactly
one wiring: the daemon, the CLI and the tests all go through it (ADR 0029).

**Modules composed (phases 6 and 7).** In order, each with its ports filled from what exists
already:

| Module | Construction in `compose.ts` | Enforced where |
| --- | --- | --- |
| Extensions (`src/extensions`, spec K.6, L.5) | `ExtensionRegistry` over `store.extension` and `store.auditLog`, the built-in catalog plus `FORERUNNER_EXTENSION_CATALOG_URL`, `HumanRequestExtensionApprovals`, `DefaultMcpConnectorFactory` (tests inject an in-memory one), `SecretResolver` over the vault, the `TokenIssuer` as revoker, `chfPerUsd`, `ledgerCost` (ledger rows whose `specialist` is `extension:<id>`). `registry.start()` reconnects enabled connectors at compose (when `startServices` is on); `close()` closes them. | `DaemonHooks extends GatedEnforcementHooks`: the gate refuses a disabled, pending, removed or errored extension's tool before any other check, and books a bridged tool call's `costUsdMicro` on its extension in `afterToolCall` (see "Extension cost" below: bridged MCP calls carry none, so the column reads 0 today). `toolsForRun()` builds a run's `ToolRegistry` from the file tools plus `registry.bridgedTools()` at run start (revocation shows at the next run; the gate covers runs in flight); the session grant lists the bridged names. |
| Sandbox (`src/sandbox`, ADR 0007) | `detectSandboxEngine` once (tests pass `sandboxDetection`), `DetectingSandboxPort` as the executor's `RunSandboxPort`: `createSandbox` per run with only the worktree mounted and the run token's `allowedDomains` as the egress allowlist (none → disconnected); egress decisions are audit rows (`sandbox.egress`). | `LoopTaskExecutor` replaces `run_command` with one that executes inside the lease (`withSandboxedCommands`) and destroys the sandbox after the run; a lease the port refuses (or a driver that throws) closes the Run row as `outcome: "error"` with its duration and the reason in `artifacts`, so no run stays `running`. Tier 2+ refuses the process stand-in unless the project setting `allowProcessSandbox` is on (factory). The model watch's eval runner takes the same port (below). `/health.sandbox` reports `{ kind, available, engine, reason }`. |
| Estimates (`src/estimates`, spec I.3) | `EstimateModel.fromStore(store)` with registry defaults for the cold start; `StaticPlanner(500_000, estimates)` prices plan items; `SessionRunner.onTaskFinished` feeds actual cost and wall time back (`observe`). | `GET /costs/estimates` serves the accuracy view (`EstimateAccuracyView`). |
| GitHub Projects mirror (`@forerunner/capabilities`) | `ProjectsMirror` over the store, the vault (`githubHostForSecretRef` resolves `settings.github_mirror.secret_ref`, default `secret:github_token`) and `DaemonMirrorApprovals` (compose.ts): the daemon's `MirrorHumanPort`, which files the approval request like `HumanRequestMirrorPort`, reuses an open one for the same project, reports which request a project waits on and wakes on `syncApprovals()` instead of waiting for the next poll; an injected `gitHost` (tests) short-circuits `hostFor`. | The scheduler's `start` is `mirrorStartHandler(gatedMirror, startSession)`, where `gatedMirror.sync` asks the schema sync gate (`updates.md`) before `mirror.sync`, so a scheduled run on a paused install is refused with `unavailable` like a manual one; `refreshMirrorSchedules()` registers an `every` schedule per project whose settings enable the mirror, at compose and from `PUT /projects/:id/settings`. `RuntimeApp.mirrorSync()` runs one now and answers with the run, or with the approval request as soon as the mirror asks (the run goes on in the background and finishes when the inbox answers it; a second call joins the run). |
| Model watch (`src/models`, spec D.6, D.21) | `ModelWatch` over the provider registry, `BUILTIN_PRICING` plus `<config>/pricing.json` and `<config>/models.json` (`FileModelSettingsStore`), `FetchPriceListSource` when `FORERUNNER_PRICE_LIST_URL` is set, else `UnconfiguredPriceListSource` (reports "no price list configured", invents nothing), `LoopEvalRunner` (below) and `StateModelWatchApprovals`. `scheduleModelWatch` registers the weekly run; `startSession` routes `isModelWatchRequest` to `modelWatch.run()`. | Routes under `/model-watch`; answers from the inbox are applied by `syncApprovals()`. |
| Updates (`src/update`, spec M) | `composeUpdateManager({ store, dirs, clock, humanId, runningVersion, restarter })` over the daemon's own store (the `store` option was added for this; the CLI leaves it out and opens one). A malformed `update.json` is logged and ignored. | `GET /updates`, `GET /updates/status`, `POST /updates/apply`, `POST /updates/rollback` with `RegistryConnectorCatalog` (connector versions from the extension catalog) and `ModelWatchUpdates` (the latest report as new models, deprecations, price changes and recommendations). `fr daemon` runs `updates.healthCheck()` once the server listens. |

`syncApprovals()` (extension grants and model watch decisions) runs at compose and after
every `POST /requests/:id/answer`, so an answer in the inbox takes effect at once.

**Eval runner (`src/models/eval-runner.ts`).** `@forerunner/evals` depends on this package, so
the daemon cannot import it. `LoopEvalRunner` reads the specialist's eval set (the same task
files, tolerant schema), writes each task's fixture files into a work directory under
`<cache>/model-watch`, runs the specialist through the loop driver with a token of its own
(depth 0, the task's budget, only the work directory allowed, `compression: "off"`) and grades
the mechanical checks (`file_exists`, `file_contains`, `regex`, `json_path`, `command_exit0`);
`rubric` checks count as "needs model". The token allows only the loop driver's equivalents of
the specialist's `allowed_tools` (`loopToolsFor` from `src/registry/tools.ts`, the same table
as the task path, see "Specialist tools on each driver" above; `run_command` only when the
runner holds a sandbox port; every dropped name logged), so a researcher eval is never offered
`run_command`. Nothing an eval runs executes on
the host: the runner takes the daemon's `RunSandboxPort` and opens one lease per eval task
(synthetic task `eval:<id>`, the work directory as the worktree, no egress, the brief's risk
tier) whenever the specialist may run commands or the task has a `command_exit0` check; the
model's `run_command` is `withSandboxedCommands` over that lease and the grader's commands run
inside it too (they execute what the model wrote); the lease is destroyed before the work
directory is removed. Without a sandbox port `run_command` is not offered and command checks
count as errors. A model with no price in the effective table throws before any call; the
watch records it as skipped. Every model call passes the daemon's hooks, so the monthly cap,
the kill switch and the audit log apply. `ComposeOptions.evalRunner` replaces it (the
evals-backed runner, a fake in tests).

**Extension cost.** `recordCost` books a bridged tool call's `result.costUsdMicro` on the
extension row, and bridged MCP calls report no price of their own (extensions.md), so a
connector's cost column reads 0 until a capability module charges through the cost ledger with
`specialist = extension:<id>` (then `ledgerCost` adds it). Pricing the tokens of a tool result
onto the connector was not done: those tokens are already billed to the model call that reads
them.

**Restart contract (`src/daemon/restart.ts`).** "Update and restart" never spawns anything:
`DaemonRestarter` writes `<runtime>/restart.json` (`{ schema: 1, reason, targetVersion,
fromVersion, requestedAt, pid, exitCode }`), emits `restart` on the runtime's events and ends
the process with `RESTART_EXIT_CODE` (86). `fr daemon` installs an `exit` that stops the
server and closes the store first, bounded by `EXIT_DEADLINE_MS`. The stop is bounded because
an attached shell holds `GET /events` open for as long as it runs and `server.close()` alone
waits for every response: `RunningDaemon.stop()` first ends every open SSE stream (each handler
registers a closer with `createDaemonApp`'s `closeStreams`), then closes the server while
sweeping keep-alive sockets that went idle (`closeIdleConnections`) and, after `STOP_TIMEOUT_MS`
(3 s), closes whatever is still open (`closeAllConnections`); it always returns. `/events`
streams `restart.requested` (`{ reason, targetVersion, fromVersion, exitCode }`) before that,
so the UI can show "restarting". A shell that supervises the daemon (desktop sidecar, Android
service, wrapper script) treats exit code 86 as "relaunch into the version `current.json`
names" and removes the request file; any other exit code is a crash. Tests inject `exit`, read
the file with `readRestartRequest`, and prove `stop()` returns with a stream open.

**Notifications (`src/notifications`, spec R.6, E.5, O.8, S.8; ADR 0017, ADR 0038;
`notifications.md` has the module).** `composeRuntime` builds the channels in the fallback
order of ADR 0017 and one `Notifier` per runtime, exposed as `RuntimeApp.notifier` with the
bound producer hooks as `RuntimeApp.notifications`:

| Channel | Built from | Configured when |
| --- | --- | --- |
| desktop | `DesktopChannel` with `shellsConnected: () => rt.shells.count()` (`ShellPresence`, `src/daemon/shells.ts`: the `/events` streams that show toasts, see below) and `osFallback: osNotifierEnabled(env, config)`; only when the background services run (`startServices !== false`), since a CLI one-shot or the cloud runner has no desktop | always; delivered to an attached shell as the SSE event `notification`, else to `notify-send` / a PowerShell toast when the OS notifier is on |
| telegram | `TelegramChannel` over `opts.notifications.fetch ?? fetchImpl ?? globalThis.fetch`, the `SecretResolver` over the vault, `telegramTokenRef` and `telegramApiBase` from the config, wrapped in `SecretCheckedChannel` (`src/wiring/notification-ports.ts`), which asks the vault whether the token *exists* (`vault.has`, never the value) before every prefs view, test send and dispatch | the human's `telegram_chat_id` is set and the token is in the vault (otherwise "bot token not set (secret telegram_bot_token)" in the settings view and the channel is skipped, not failed); the bot token is resolved by reference at send time and never logged |
| signal | `SignalChannel({ account: config.signalAccount })` with the platform's `run`/`which` | an account is configured and the human's `signal_number` is set; `signal-cli` on PATH |
| email | `EmailChannel(notificationEmailPort(...))` (`src/wiring/notification-ports.ts`): the agent's own mailbox under `EmailPolicy.send` as the agent, or `null` when the agent has no mailbox configured at compose | the port exists and an address resolves (`notify_prefs.email` or `human.email`) |

Configuration keys (`config.json`, `notifications` block; `src/notifications/config.ts`):
`signalAccount` (`FORERUNNER_SIGNAL_ACCOUNT`), `telegramTokenRef` (`FORERUNNER_TELEGRAM_TOKEN_REF`,
default `secret:telegram_bot_token`; a value instead of a reference is refused),
`telegramApiBase` (`FORERUNNER_TELEGRAM_API_BASE`). `FORERUNNER_OS_NOTIFY` (`1`/`0`) overrides
`osNotifierEnabled`, which is otherwise on for a set-up install (a `config.json` exists) and off
for a bare one, so a test composition never spawns an OS notifier. The human's preferences and
quiet hours are `human.notify_prefs` (`prefs.ts`); `AuditedNotificationHumans` is the notifier's
human port and appends one `audit_log` row (`notify.prefs`, the keys that changed, never the
values) per preference write, which is a plain settings write, not a command-registry change
card (ADR 0038 point 5). `notifier.start()` runs when the services run and `close()` stops it.

Producers are bound to the real sources in `compose.ts`: `store.humanRequest.insert` is wrapped
once, so every request this human receives (the hooks' approvals, the extension registry, the
mirror, the Cloudflare deployer, the critic, the updater) raises `requestOpened` (urgent when
blocking) and `inbox` on the bus; `startSession` reports the runner's result through
`sessionEnded` (a budget stop becomes `budget_stop`); `KillSwitch.onStop` passes the report and
the reason to `killSwitch`; the restarter's `restart` event raises `updateApplied` for an update
or a rollback; `critic.verdict` and `critic.session_review` bus events with `escalation: true`
and no `humanRequestId` raise `criticVerdict` at normal urgency, with the session id (and the
task id, grade and summary when the payload lacks them) from the review row `reviewId` names,
so the delivery is logged on that session like the session-end one. Failures to notify are
logged (`notification not sent`) and never fail the producing operation. Routes, mounted at the
root behind the bearer token and listed in `DAEMON_ROUTES`: `GET|PUT /notifications/prefs`,
`POST /notifications/test`, `GET /notifications/recent?limit=`, `GET /notifications/pending`.
`/events` writes every desktop delivery as `notification` `{ id, kind, title, body, level,
route, humanId, projectId }` (ADR 0031 point 2) to every open stream, but only a stream that
shows the frame as a toast counts as an attached shell for the channel's OS fallback
(`isShellStream`, `src/daemon/shells.ts`): one that declares `?client=shell` or
`X-Forerunner-Client: shell` is a shell, one that declares anything else (`client=ui`) is not,
and an undeclared stream counts only when its bearer token came in the `Authorization` header,
which no browser `EventSource` can send. So the desktop sidecar (reqwest, header) counts, while
the React UI's own stream, the phone's web view and a browser tab (`?token=`) do not, and a
blocking request with only those open still reaches `notify-send`. `server.ts` attaches a
qualifying stream to `rt.shells` for its lifetime. To add a channel, see `notifications.md`
("How to change it") and add one constructor line here; to add a producer, call
`rt.notifications.<hook>` where the fact is known.

**Cloudflare deploys (`@forerunner/capabilities` `cloudflare`, spec J.9, J.10, S.5, S.6, S.9;
ADR 0035, ADR 0038; `cloudflare.md` has the module).** `composeRuntime` registers
`cloudflare_plan`, `cloudflare_deploy`, `cloudflare_dns_upsert` and `cloudflare_verify_token`
into the daemon's built-in `ToolRegistry` (`registerCloudflareTools` with
`cloudflareToolDeps({ projects: store.project, vault, approvals:
HumanRequestCloudflareApprovals(store.humanRequest, clock), audit: store.auditLog, clock,
fetchImpl })`), so every run token lists them and the daemon's hooks and the extension gate
apply as to any tool: a production deploy below autonomy 4 and a staging deploy below 3 become
blocking `human_request` approvals (the hooks' card says `deploy_staging`, the deployer files
its own `deploy_production` card, ADR 0035 point 3), money is a one-shot answer at every level,
and every call and every outward action is an audit row. The deployer reads
`project.settings.cloudflare` per call and resolves the token by reference from the vault. The
catalog entry `cloudflare` (`src/extensions/catalog.json`) names the four tools and the classes
`read`, `deploy_staging`, `deploy_production`, which the gate checks against the installed row
once the extension is added from the panel. Routes (`server.ts`, structural handlers adapted to
Hono, in `DAEMON_ROUTES`): `GET /cloudflare/projects/:projectId/settings` (settings with the
secret by reference, scope) and `GET /cloudflare/projects/:projectId/token` (`verifyToken()`:
status, expiry, scopes, warnings). No configuration key: the account, zones, secret reference
and API base are per project.

**Adopted model settings (`src/wiring/model-config.ts`, spec D.6, D.21; ADR 0019, ADR 0039;
`model-watch.md` has the module).** The ladder and effort table in force are one
`EffectiveModelConfigHolder` per process: `readEffectiveModelConfig` reads
`<config>/models.json` through `FileModelSettingsStore` at compose and applies it to
`builtinModelConfig()` (`applyModelSettings`). Every consumer reads `holder.get()` at the
start of a run or a turn, never once: `LoopTaskExecutor` (`modelConfig` dep) passes
`ladder` to `modelIdFor` and `modeDefaults` to `effortForTask`, `ConversationAgent`
(`modelConfig` dep) takes the `text_chat` tier, effort and response target from it,
`CriticLoop` (`modelConfig` dep) hands the critic package `ladder` and `modeDefaults` as
accessors over the holder, read at every review's pick (`pickCriticModel`) and when the rung
a failed run sat on is looked up for the retry ladder, and the pricing closures of the
executor, the chat and the critic (`livePricing` and the critic's `pricing` in `compose.ts`)
price the rung in force from the pricing table in force (`loadPricing` of
`<config>/pricing.json` over the built-ins). `ModelWatch.onAdopted` swaps both in place (`holder.adopt`, the table), so after a
human's "adopt" in the inbox, the updates screen or `fr models` the next session runs the
adopted rung at the adopted effort and the next chat turn uses the adopted chat rung, with no
restart; the audit row `model_watch.reload` records the hand-over. A `models.json` that does
not parse is ignored in favour of the built-ins with one `audit_log` row
(`model_settings.read`, `allowed=false`, the file name and the parser's message, never the
document's content) and a warning; a parsing file with overrides leaves one `allowed=true` row.
`RuntimeApp.modelConfig()` and `RuntimeApp.pricingTable()` expose both; the `CostLedger`
keeps the table it was built with until the next start (it prices savings views, not calls).
The old hardcoded chat and session model names are gone: the rung lookup on the tables in
force decides (`rungModelFor` in `compose.ts` is `modelIdFor` on the ladder in force, called
per run by the pricing closures and the chat; a provider the ladder does not know throws
there as in the executor, so `ladder.ts` stays the one source of model ids).

**Desktop control (`@forerunner/capabilities` `desktop`, spec L.4, S.32; ADR 0021, ADR 0039;
`desktop-control.md` has the module).** `composeRuntime` builds one `DesktopController` per
daemon and registers the six `desktop_*` tools (`registerDesktopTools`) into the built-in
`ToolRegistry` next to the file and Cloudflare tools, so every run token lists them and the
hooks (allowlist, `read`/`non_routine` classes, autonomy, audit) and the extension gate apply
as to any tool; the gate inside each tool then decides on the binding
`desktopBindingResolver` (`src/wiring/desktop-ports.ts`) resolves per call: `enabled` from the
`desktop-control` extension row read by name (installed, enabled, neither pending nor errored;
off until a human adds it from the catalog and approves it in the inbox), `autonomy` from the
run's project's `autonomy_level` (the human's `default_autonomy` without a project), the
human's allowlist from `FileAllowlistStore` at `<config>/desktop-allowlist.json` behind
`GuardedAllowlistStore` (a file that is not JSON or not an allowlist is `validation` naming
the file on every tool call and on the routes, with one `desktop_allowlist.read` audit row
per refused read and a warning, never `internal` carrying the parser's message; the next
call reads the file again, so a fix needs no restart), and `screenshotsToModel: false` (the
runtime does not forward image artifacts). The adapter is
`detectAdapter()` once at compose; a machine without a usable desktop gets
`UnavailableDesktopAdapter`, whose every action refuses with `not_supported` naming what is
missing (after the gate, so the refusal is an audit row like any denial; never a fake adapter
in production). The indicator is `CompositeIndicator([BusIndicator, LogIndicator])`:
`BusIndicator` emits `desktop.indicator` `{ on, agentId, sessionId, runId, humanId, app,
message, at }` on the runtime bus and `/events` streams it to every shell, which shows its
banner while `on` is true. The kill switch (`attachKillSwitch`) and the extension registry
(`attachExtensionRegistry`: a toggle off or a removal revokes live, a toggle on resumes) are
attached; the executor's `run_end` event calls `controller.endRun` so the indicator goes off
with the run. The approval port for "allow this application for this session" is
`HumanRequestDesktopApprovals` over `store.humanRequest` (a blocking request in the inbox).
Screenshots go to `<data>/desktop/<agent>/screenshots`. Routes (`server.ts`,
`desktopRouteTable` adapted to Hono, in `DAEMON_ROUTES`): `GET /desktop/status` (controller
status plus detection), `GET|PUT /desktop/allowlist/:humanId` (the daemon's human only; another
id answers 403; a write is one audit row), `POST /desktop/revoke` (open to any caller),
`POST /desktop/resume` (the daemon's human). The catalog entry `desktop-control` names exactly
the six tools with the classes `read` and `non_routine`, which the gate checks against the
installed row and `revokeLive` uses to revoke the tokens that carry them. `ComposeOptions.desktop`
injects the adapter, detection, allowlist store and an extra indicator (tests use
`FakeDesktopAdapter` and `MemoryAllowlistStore`); `RuntimeApp.desktop` exposes the controller,
the allowlist store and detection; `close()` stops the controller.

**Files and data (`src/data`, spec L.1, A.3, K.2, U.4; ADR 0039; `data.md` has the module).**
`composeRuntime` builds `DataAssets` with `projectsRoot = <data>/projects` (`FORERUNNER_HOME`
honoured through `dirs`; `ComposeOptions.data` overrides the root and the limits) and
`DataImporter` over it, and registers `data_list`, `data_describe`, `data_sample` and
`data_register` (`registerDataTools`) into the built-in `ToolRegistry`, so they run behind the
hooks like any tool: their untrusted output is wrapped and scanned, `data_sample` above the
cap is refused by the schema before the tool runs, and `data_register` for a path outside the
run's allowed roots or a URI asks the human through the hooks' own `StateApprovals`
(`capability_grant`, a blocking request in the inbox) and fails with `approval_required` until
the answer. `server.ts` mounts `createDataRoutes({ assets, importer, actor: () => ({ humanId }) })`
at the root (`GET /projects/:id/data`, `POST /projects/:id/data` JSON or multipart,
`POST /projects/:id/data/import`, `GET /data/:id`, `GET /data/:id/sample`, `DELETE /data/:id`,
all in `DAEMON_ROUTES`, the shapes the UI's data tab and the CLI import target); the daemon's
human is the actor, so a delete always has one and removal never goes through a tool.
`worktreeFor` is not set: the daemon's worktrees are per task and the data dir lies outside
them (ADR 0039 point 12). `RuntimeApp.data` exposes the registry and the importer.

`server.ts` is the HTTP surface the desktop, Android and web shells talk to. Hono, bound to
`127.0.0.1` only; every request carries `Authorization: Bearer <token>` compared with
`timingSafeEqual`. The token is written to `<runtime dir>/daemon.json` (mode 0600) together
with the base URL, so a shell on the same machine finds the daemon without configuration.
Routes follow `DAEMON_ROUTES` in `api-types.ts`; response shapes are the zod views in the
same file (`ProjectCard`, `TaskView`, `SessionView`, `EventView`, `InboxView`, `CostView`,
...) so the UI and the daemon share one contract. `views.ts` maps store rows to those views
and renders money in CHF at the day's rate. Streams use server-sent events: `/events` for
the live feed (session events, inbox, session and project changes, a heartbeat) and
`/sessions/:id/events` for one session, with `afterSeq` to resume. Errors map
`ForerunnerError` codes to status codes (not found 404, validation and conflicts 409 or 400,
permission 403); the body is `{ error, code, details }` with secrets redacted.

Beyond the route table of ADR 0011 the daemon serves `GET /projects/:id/peers` (the peer feed,
`PeerFeedView`), `GET /projects/:id/decisions` (the decision log, `DecisionView[]`), the core
loop's data (below: the Reviews tab, the memory views, the commands and the change log), and
follows the UI conventions of ADR 0025: CORS for local and Tauri origins only, the bearer
token accepted as `?token=` on the two EventSource routes and nowhere else, `/chat/stream`
frames `token` (`{text}`), `reply` and `error`, a 409 with code `conflict` on a stale version,
and `{killActive}` from the kill routes.

`tools.ts` holds the file and shell tools a session gets (`read_file`, `write_file`,
`list_dir`, `run_command`), each declaring its action class and path fields so the hooks can
enforce containment. `fr daemon [--provider fake] [--port N]` starts the server; `fr status`
reads `daemon.json` and reports health.

**Mounted routes beyond ADR 0011** (all in `DAEMON_ROUTES`, all behind the bearer check):
the Extensions panel sub-app (`GET /extensions`, `GET /extensions/catalog`,
`GET|DELETE /extensions/:id`, `POST /extensions`, `POST /extensions/:id/toggle|approve|deny`,
`PUT /extensions/:id/permissions`), the updates screen (`GET /updates`, `GET /updates/status`,
`POST /updates/apply`, `POST /updates/rollback`), the model watch under `/model-watch`
(`GET /reports`, `GET /reports/latest`, `GET /reports/:id`, `POST /run`,
`POST /reports/:id/answer`, `POST /sync`), `GET /costs/estimates`,
`PUT /projects/:id/settings` (merges a settings patch with a version check and refreshes the
mirror schedules) and `POST /projects/:id/mirror/sync` (200 `MirrorRunView` with the run's
counts, or 202 `MirrorSyncPendingView` `{ pending: true, projectId, requestId }` while the
human decides; the request never blocks on the approval, the run finishes in the background
once `POST /requests/:id/answer` approves it and `project.changed` follows). `/health` gained
`sandbox` and `extensions: { enabled, pending }` (`sandbox.reason` is the engine probe's text;
the route is unauthenticated but loopback-only); `/events` also streams `extension.changed`,
`restart.requested`, `notification` and `desktop.indicator`. The desktop control routes
(`GET /desktop/status`, `GET|PUT /desktop/allowlist/:humanId`, `POST /desktop/revoke`,
`POST /desktop/resume`) and the Data tab routes (`GET|POST /projects/:id/data`,
`POST /projects/:id/data/import`, `GET /data/:id`, `GET /data/:id/sample`, `DELETE /data/:id`)
are mounted as described above. The notification routes (`GET|PUT /notifications/prefs`,
`POST /notifications/test`, `GET /notifications/recent`, `GET /notifications/pending`) and the
Cloudflare panel routes (`GET /cloudflare/projects/:projectId/settings|token`) are mounted the
same way (see "Notifications" and "Cloudflare deploys" above). Each sub-app keeps its module's
error mapping.

**Core loop routes (ADR 0036, all in `DAEMON_ROUTES`).** Reviews tab (spec K.2):
`GET /projects/:id/reviews` and `GET /tasks/:id/reviews` answer `ReviewsView` (every review
with its findings, the open finding count, verdict counts, the grade trend oldest first and
the average grade; `views.ts#reviewsView`). Memory views (spec K.5): `GET /memory/scopes` (one
view per principal, the critic and shared, with counts), `GET /memory?scope=&agentId=&q=&tag=&status=`
(`MemoryView`; `agentId` is required for `agent_private`), `PUT /memory/lessons/:id`
(text, tags, confidence, pinned; the lint rules apply), `POST /memory/lessons/:id/pin`,
`DELETE /memory/lessons/:id` (all four answer 404 for another human's agent or private row),
`GET /memory/consolidation` (`ConsolidationProposalView[]`) and
`POST /memory/consolidation/run` (report only; files the approval request; the inbox answer
applies it through `syncApprovals`, which also applies the `rework`/`accept`/`cancel` answers
of tasks blocked by findings). Commands (spec Q): `GET /commands` (the registry),
`POST /commands/parse` (nothing runs), `POST /commands/execute` (one or several commands as one
change card and one change log row; `confirm: "tap"` is the settings-screen path after the
card was shown), `GET /commands/pending`, `POST /commands/:id/confirm` (`yes`, `no`, `tap`, or
`device` with `deviceId` and `biometric`; a chat yes on a high-risk card is refused), `POST
/commands/:id/cancel`, `GET /changes?projectId=&undoable=` (`ChangeLogView[]`) and
`POST /changes/:id/undo`. Results are `CommandResultViewSchema`; `/me.activeProjectId` is the
registry's record. `ChatReplyView.pendingConfirmation` carries the commands and the decision,
`actions[].undoToken` the change log id while undoable, and `question` the parser's question.

**Remote control of the PC (`src/remote/`, spec R.4, R.8, Q.12; ADR 0032 item 4, ADR 0033
items 8b and 9, [ADR 0041](../decisions/0041-pc-remote-commands-owner-filter-and-presence.md)).**
On a shared state the daemon is the consumer of the phone's `target: "pc"` remote commands
and the PC the cloud runner's PC-wins rule looks for. `composeRuntime` builds, when
`remoteCommandsEnabled(env, stateUrl, services, opts.remote?.enabled)` says so (never without
the background services; then the option, then `FORERUNNER_REMOTE_COMMANDS` `1`/`0`, else on
for every state URL that is not `sqlite:`), exposed as `RuntimeApp.remote`:

| Piece | What it does | Enforced where |
| --- | --- | --- |
| `registerDesktopDevice` | one `device` row of kind `desktop` per install for the human: the public key (a random identifier, never used to authenticate) is kept in `<config>/desktop-device.json`; the row under that key is reused (same human, not revoked), else a non-revoked row of the human named `FORERUNNER_DEVICE_NAME` (default the host name), else a fresh one | the row is what the phone can address a command to (`targetDeviceId`) |
| `DesktopPresence` | stamps the row's `last_seen` at start and every `FORERUNNER_PRESENCE_HEARTBEAT_MS` (default 60 000; the runner's window `FORERUNNER_RUNNER_PC_ONLINE_MS` is 3 min) | `services/cloud-runner/src/presence.ts` reads it: a desktop seen within the window keeps the runner off the agent's schedules |
| `RemoteCommandWatcher` | polls `store.remoteCommand.pickUp("pc", { deviceId, agentId })` every `FORERUNNER_REMOTE_POLL_MS` (default 500 ms; the daemon reads the shared Postgres directly, ADR 0024, so no service client is involved): the store hands over only rows whose issuing device belongs to the human who owns this agent (first line); `authorize` loads the issuing device and refuses an unknown, revoked or foreign one (`failed`, `forbidden: ...`, audit row) without acting (second line). Then: a `kind: "plan"` envelope runs through `CommandLoop.compose` as the PC (source `phone`, the daemon's desktop row as the context device, so the registry's session commands call the ports instead of enqueueing another remote command); low risk acts, the phone's tap (`confirmedAt`, counted by `isFreshTap` only within the card's own life, `DEFAULT_TAP_MAX_AGE_MS` = 10 min, plus 2 min of clock skew; a tap the outbox replayed from long ago leaves the card `needs_yes` for the inbox) answers a medium card, a high-risk card stays a `human_request` (`needs_device`) and the row completes with `status: "pending"` and the `pendingId`; a `kind: "chat"` envelope is one `ConversationAgent.chat` turn (`failed`, `provider_auth` without a model credential); plain `kill` (stop everything and freeze), `stop` (the agent's runs, freeze lifted), `start` (freeze lifted, `scheduler.request` with `trigger: "remote"`), `pause` (the registry's `session.pause`, whose daemon ports in `src/wiring/session-ports.ts` make it the graceful stop: the row reads `paused` at once and, for a session registered with the kill switch in this process, the agent gets a `pause: <reason> (session <id>)` message that the runner reads between tasks, so the task in flight finishes, no new one starts and the runner closes the session with its handoff, `paused -> stopped`, `stop_reason: stopped_by_message`, the remaining tasks in `handoff.next`; a session running elsewhere gets the status only; the undo, `resumeSession`, withdraws the unread message and puts a `paused` row back to `running`, and a closed session stays closed), and the registry's own `session.*` rows; a start or scope naming another agent is refused. `syncAnswered` (every drain) applies inbox answers to the cards still pending in the executor: an approval confirms a `needs_yes` card as a tap and a `needs_device` card as a device confirmation naming the daemon's desktop row with `biometric: false` (the state service enforced the signature and `confirm:high` on the phone's answer; the daemon's route is the human at the PC), a rejection cancels, another human's answer is ignored; an approval the executor refuses (this daemon's desktop row revoked, the risk rose since the card was shown) is not counted as applied: it is warned once, audited (`allowed: false`, input `kind: "card"` with the pending id, the decision and the command names) and the dead card is cancelled so no drain repeats it (`stats.refusedCards`), while a `version_conflict` (another answer in flight) is simply retried on the next drain. Every row ends `done` or `failed` with a result the phone reads back plus one `audit_log` row `daemon.remote_command` naming the command, the device and the plan's command names, never the parameters. A kill reaches the kill switch within one poll, so a session stops within 2 s of the tap. | the command registry's policy (ADR 0030), the kill switch, the scheduler; `RemoteCommandRepo.pickUp`'s owner filter in `packages/state` (`ownerHumanId` / `agentId`: a subquery on `device.owner_human_id`, through `agent` for the agent, both dialects) |

Both stop with `close()`. The project's escalation ceiling is wired here too: `makeLoop` passes
`projectCeiling: (settings) => criticSettingsOf(settings).ceiling` to `LoopTaskExecutor`, so
`tierForAttempt` escalates the third retry under the project's `critic_ceiling` (a project capped
at sonnet never runs opus) instead of the ladder's default ceiling.

### Specialist registry (`src/registry/`)

The loader for `forerunner-registry` content: specialist, principal and critic definitions as
Markdown with front matter (model defaults, effort, tool allowlist, budget defaults, eval set),
validated with zod, with a prompt version hash recorded on every run. `proposals.ts` writes a
proposed specialist as a pull-request-ready file instead of editing the registry in place, so
every new specialist goes through review. The composition root turns registry entries into
`SpecialistSpec`s for the executor, mapping their Claude Code tool names for the driver in use
(`tools.ts`, see "Specialist tools on each driver" under Drivers, ADR 0043). See
`adding-a-specialist.md` for the file format and the golden eval sets under `evals/registry/`.

### Models (`src/models/ladder.ts`)

Ladder haiku → sonnet → opus → fable, ceiling opus by default; mode defaults and response
targets from spec table D; effort offset from the project slider; retry ladder
(improve brief → split/change specialist → escalate under ceiling → human).

### Briefs (`src/brief.ts`)

`validateBrief` rejects any delegation missing goal, context links, constraints, acceptance
criteria, budget, risk tier or specialist with `brief_incomplete` and the list of issues.

### Injection (`src/injection/scan.ts`)

`wrapUntrusted` puts external content in a data envelope and lists instruction-like passages;
`scanForInjection` scores rules (ignore-previous, identity change, exfiltration asks, approval
bypass, hidden text, markdown image exfil, ...). Flagged content raises an event and a note to
the human; it is never acted on.

## How to change it

- New limit: add the check to the hook, a `ForerunnerError` code in platform, and a test in
  `test/hooks.test.ts` that proves the block happens before the call.
- New tool: implement `ToolSpec` (schema, action class, risk, `pathFields`/`domainFields`,
  `untrusted` output flag) and register it; the allowlist in tokens decides who may call it.
- New autonomy rule: edit the `FREE_AT` table and `test/autonomy.test.ts`.
- New driver or provider: implement `ModelProvider` (see `adding-a-provider.md`).

## Tests

`packages/runtime/test/*.test.ts` (unit, fake provider, no network): tokens, autonomy, kill
switch timing, budget rules, context transforms (golden cases, idempotence, FATAL-at-line-67,
bare truncate marker without a store and named marker with one, stable-prefix lint, bypass,
project settings, run-scoped savings with references that name sent lines of the same
transcript), the context layer end to end
(`headroom.test.ts`: adapter against an in-process `node:http` proxy that is absent, unhealthy,
wedged, healthy or dies mid-session, URL validation, selection never silent, managed argv and
process; `context-proxy.test.ts`: a global kill-switch stop kills the managed proxy and a scoped
stop does not, `SdkAgentDriver.run({ env })` carries `headroomSdkEnv` into the subprocess;
`context-manager.test.ts`: probe once, timer-driven re-probe every 60 s without a task start,
recovery without a second notice, timer cancelled at session end and by `close()`, `/stats`
delta, originals written after `redact()` under the hash the marker names, unchanged blocks
store nothing, pruning by age, no store means no marker; `loop-context.test.ts`: compressed live
zone keeps the FATAL line, `context_compressed` event, byte-identical `"off"` bypass, two runs
on one session pipeline measured separately and never referencing each other's results, a
cross-turn reference names an existing result of the same transcript by its transcript number
and only lines that were sent; `executor-context.test.ts`: Run row
fields and `headroom_used` with a proxyable versus a plain provider, cost view priced from the
Run rows; `session-context.test.ts`: `headroom_saved_tokens` on the session and the
`context.headroom_unavailable` event; `views.test.ts`: cost view savings money), Anthropic adapter mapping, SDK driver options and hooks, sessions (checklist and brief size, planning, claims, collisions, budget stop, kill, advisor mode, concurrency, scheduler; the next-session queue consumed per brief in `runner-queue.test.ts` and `checklist-queue.test.ts`), executor (brief, derived token, Run row; a fractional first-token time and duration stored as integers on the real store; a refused Run row write as a `run.persist_failed` audit row and a log line that name the run and never the prompt), receipts (acked by reading, acked by reply, resurfacing), decisions (ask once, record, supersede, approvals ignored), peers (hints, overlap rules, feed from the store, overlap message and skip through the runner), daemon (auth, projects and tasks with a 409 on a bad transition, chat and inbox, sessions, events and kill, costs, SSE with the restart event, `stop()` returning while `/events` is held open on a real socket), wiring (`wiring.test.ts`: extensions from catalog to a refused tool, model watch report and inbox decision, updates screen, mirror sync answering 202 then running on the inbox answer, estimates accuracy, sandboxed `run_command`, a refused lease closing the Run row, the eval runner keeping the model's command in the sandbox lease and offering only the specialist's tools, CLI registration and one-shot composition; `cc-tools-wiring.test.ts`: the composition on a registry copy whose coder names `cc:Read`, `cc:Edit`, `cc:Glob`, the executor's spec carrying `read_file`, `write_file`, `list_dir` with the registry untouched, one task through the `LoopTaskExecutor` with `read_file` and `write_file` allowed and `run_command` refused by the hooks, the audit rows of each, and a `cc:WebFetch` dropped at compose with one `registry.tool_unmapped` row per specialist and tool; `registry-tools.test.ts`: the table entry by entry, an unknown `cc:Foo` dropped with its reason and its audit row, the command gate, unavailable and bridged names, order and duplicates, the "sdk" and no-option branches keeping the names as written; `notifications-wiring.test.ts`: the notifier and its producers on the real sources through the daemon, the prefs routes and their audit row, the `notification` SSE frame, quiet hours through the route, the Telegram token never leaving the vault's reach, the email channel over the agent mailbox; `packages/capabilities/test/cloudflare-wiring.test.ts`: the Cloudflare tools and routes through the daemon's hooks, gate and bearer token; `model-config-wiring.test.ts`: `models.json` applied at compose to the chat rung, a session on the built-in rung and effort, the model watch proposing a switch and a lower effort on a fake eval runner, the human's adopt through the inbox swapping the tables so the next session runs the adopted rung at the adopted effort and the critic reviews on the adopted rung without a restart, a malformed file ignored with an audit row and its content kept out of the log; `packages/capabilities/test/desktop-wiring.test.ts`: the six desktop tools behind the daemon's hooks and gate, off until installed, the allowlist and status routes, an app outside the allowlist refused and put to the human, an allowlisted app run through the fake adapter with the indicator on the bus and as the `desktop.indicator` frame on `/events` (on with the app, off at `endRun`), a panel toggle revoking live; `desktop-wiring.test.ts` (runtime): the guarded allowlist file, a file that is not JSON or not an allowlist answering `validation` naming the file on the routes and on every tool call with a `desktop_allowlist.read` audit row and the parser's snippet kept out of the error, the audit log and the log, a fixed file read at the next call; `data-wiring.test.ts`: a folder import through the daemon route in the registry and the project's listing, the data tools behind the hooks, a zip-slip archive refused whole, a path outside the run's roots refused as a capability grant), hooks (overspend, steps, wall clock, kill, allowlist, schema,
paths, domains, secrets, autonomy, injection), ladder, brief, loop driver (completion, overspend
blocked, step cap, kill mid-run, timeout with partial output, inline denials, needs-human pause,
injection flagged, whole-millisecond first-token time and durations, `wholeMs`), remote control
of the PC (`remote-watcher.test.ts`: the store never hands another human's command over and a
row forced through is refused and audited, a revoked device refused visibly, a low-risk plan
acting through the registry with the audit row naming commands only, the phone's tap answering
a medium card and a card without it waiting for the inbox's yes, a tap replayed from long ago
leaving the card `needs_yes` while one inside the window still counts (`isFreshTap` pinned to
the executor's `PENDING_TTL_MS`), a high-risk step filing a change card that the inbox's
approval applies as the desktop row with `biometric: false` and a rejection cancels while
another human's answer is ignored, an approval the executor refuses (desktop row revoked) not
applied but warned, audited and dropped with nothing repeated on later drains, a refused plan
and a malformed envelope ending `failed`, a kill from the phone stopping a registered run within
one 500 ms poll on the simulated clock, the plain verbs and the registry's own `session.*` rows,
a start or stop for another agent refused, pause through the registry, chat as one conversation
turn run as the PC and `provider_auth` without a model; `remote-pause.test.ts`: the pause ports
over the store and the kill switch's registry, the message body round trip and the runner's
stop-word match, a registered session marked `paused` with the message and nothing aborted, a
session elsewhere by status only, the undo withdrawing the message of that session alone and a
closed session left closed, `session.pause` and its undo through the registry;
`remote-presence.test.ts`: the desktop row registered once and reused through the identity file
or by name, never revoked or another human's, `last_seen` stamped at start and on every
interval and no more after `stop()`; `remote-wiring.test.ts`: the composed daemon registering
its desktop row and heartbeating it on the interval, `remoteCommandsEnabled`, a project ceiling
of sonnet never escalating the third retry to opus while the default ceiling does, a kill from
the phone stopping a running session within 2 s, a pause from the phone ending a running
two-task session at the task boundary (the task in flight finishes, the second never starts,
`stopped_by_message` with the second task in `handoff.next`), both stopping with `close()`;
`executor-ceiling.test.ts`: `projectCeiling` on the executor).

## Requirements covered by the daemon wiring

K.6 and L.5 (extensions reachable from the daemon, revoked live), S.7 (task commands in a
sandbox with only the worktree and the token's domains), I.3 (estimate error tracked and fed
back to the planner), D.6 and D.21 (weekly model watch scheduled, decided in the inbox), M.3,
M.4 and M.5 (updates screen, apply, rollback, restart contract, health check on start), S.9
(every outward action of these modules is an audit row). Test: `test/wiring.test.ts`.
C.4, S.1 and S.3 for specialist tools on the loop driver (the registry's `cc:` names mapped
to the built-ins the token carries, nothing widened, every dropped name an audit row, ADR
0043). Tests: `test/cc-tools-wiring.test.ts`, `test/registry-tools.test.ts`,
`services/cloud-runner/test/runner.test.ts` (the cloud runner's executor on `rt.specialists`).
R.6, E.5, O.8, S.8 and K.8's desktop notifications (the human is told about requests, finished
sessions, budget stops, kill switch, updates and escalations, with quiet hours, through the
channels the daemon wires). Test: `test/notifications-wiring.test.ts`. J.9, J.10, S.5, S.6 and
S.9 for Cloudflare deploys (staging and production through the daemon's hooks and approvals,
the token's scopes through the panel routes, every action audited). Test:
`packages/capabilities/test/cloudflare-wiring.test.ts`. D.6 and D.21's "human approves" and
M.5's model updates (an adopted switch or lower effort takes effect on the next session, chat
turn and critic review without a restart; a malformed settings file never changes a model).
Test: `test/model-config-wiring.test.ts`. L.4 and S.32 (desktop control off by default, the
per-app allowlist, autonomy 3+ and screenshots logged, all through the daemon's hooks, gate and
routes; the indicator as the `desktop.indicator` frame on `/events`; an allowlist file that
does not read refusing every action as `validation` naming the file). Tests:
`packages/capabilities/test/desktop-wiring.test.ts`, `test/desktop-wiring.test.ts`. L.1, A.3
(ZIP and folder), K.2's Data tab
and U.4's data assets (import, listing, describe and sample through the daemon; the data tools
behind the hooks; a path outside the run's roots as a capability grant). Test:
`test/data-wiring.test.ts`. D.5 and D.19 for the Run row (every specialist run stores model,
effort, prompt version, tokens, cost, first-token time and total time, as whole milliseconds;
a row the store refuses is an audit row and a log line, never silent). Tests:
`test/executor.test.ts`, `test/loop.test.ts`. R.4 and R.8 for the PC (the phone's `target:
"pc"` commands picked up within one 500 ms poll and executed on the PC through the command
registry, the scheduler and the kill switch, a kill within 2 s; the phone only controls), Q.12
(the phone's plan with the same enforcement as the settings screen), Q.8 (a high-risk step
stays a card the phone confirms with its biometric through the state service), S.9 and S.14
(one audit row per command; only the human's own devices reach this PC, in the store and in
the watcher), D.3 (the project's ceiling caps the retry ladder). Tests:
`test/remote-watcher.test.ts`, `test/remote-pause.test.ts`, `test/remote-wiring.test.ts`,
`test/remote-presence.test.ts`, `test/executor-ceiling.test.ts`, `packages/state/test/suite.ts`
(the owner filter on both dialects).

## Known issues

- The SDK driver's live behaviour is only verified when a credential is present (see
  `gates.md`); without one the integration test skips with a visible reason.
- Connector cost reads 0 (see "Extension cost"); a weekly eval of a tier 2+ task on an install
  without a container engine fails as `error` because the process stand-in is refused for it,
  exactly as for a task run.
- Headroom: `headroom.integration.test.ts` against a real proxy (`FORERUNNER_TEST_HEADROOM_URL`)
  and the Phase 6 replayed eval gate (>= 30 % savings on tool-heavy transcripts) are not written
  yet; the Extensions panel entry and `fr context install-headroom` are not wired. No session
  path uses `SdkAgentDriver` yet, so `SessionContext.sdkEnv` has no live caller (the driver
  accepts it; the in-process loop routes through `viaProxy`). The ADR's "proxy dies mid-run"
  path (`provider_error`, retry without the proxy) is not implemented: the 60 s re-probe drops
  the session to native for the next run, the failing call is retried by the ordinary retry
  policy.
- Context originals: there is no session retention mechanism, so stored originals are pruned by
  age (30 days) when the daemon starts, not with a session's data. A failed write leaves the
  block compressed with a bare marker; the log view then has nothing to expand.
- Context follow-ups (ADR 0003 section 3): `CostView` has no "Saved by Headroom" line and no
  probe status (Headroom tokens exist only in `SavingsReport.headroom`; needs an api-types and
  UI change). The `context_compressed` run event reaches SSE but is not stored as a session
  event, so the stored session log has no per-call numbers; whether to persist it through the
  session event store is undecided.
- Path containment resolves symlinks only when the target exists; the sandbox adapter mounts
  only the worktree so escapes cannot reach the host anyway.
- Notifications: the email sender is resolved once at compose from the agent's email settings
  row, so a mailbox configured while the daemon runs takes effect at the next start; the
  `peerMessage`, `emailCommandReceived` and `injectionFlagged` producers have no daemon source
  yet (ADR 0038 point 2); held and digest queues are in memory (ADR 0017 point 8); the
  `update_applied` notification is sent while the process is exiting, so a slow channel may
  not finish before the restart.
- Shell detection: the desktop shell (`apps/desktop/src-tauri/src/daemon.rs`, `open_events`)
  sends the token in the `Authorization` header and no `client` declaration, so it is counted by
  the undeclared-stream rule of `shells.ts`. Once the shell sends `?client=shell` (or the
  header), that rule can go and only declared shells will count.
- Cloudflare: the session grant's domain allowlist is unchanged (the tools declare no domain
  fields); a bridged tool that should reach `api.cloudflare.com` would need the grant extended.
- Model settings: the `CostLedger` keeps the pricing table it was built with until the next
  start (savings views only; calls are priced from the table in force); an adopt answered in a
  CLI one-shot (`fr models watch` composes its own runtime) reaches a running daemon at its
  next start, answers in the inbox or the updates screen apply at once.
- Desktop control: the shells do not render the `desktop.indicator` frame yet (the log line is
  the visible indicator until they do); `screenshotsToModel` is always false because the
  runtime does not forward image artifacts; the module's audit rows carry no token id
  (`ToolExecutionContext` has none), the hooks' rows for the same call do; `/health` does not
  report desktop availability (`GET /desktop/status` does).
- Data: `worktreeFor` is unset (per-task worktrees, the data dir outside them), so the
  gitignore guard runs only for callers that pass a worktree; the UI's data tab registers by
  locator only and no `fr` command targets the import route yet, so imports go through
  `POST /projects/:id/data/import` from a client.
- Remote control: a pause reaches only a session running in this process (the runner reads
  the pause message between tasks; a session on the cloud runner gets the row's status until
  that runner honours it), a pause message the runner never read because the task in flight was
  the last one is consumed at the next session's start like any unread message, and an undo
  after the runner already read the message does not keep the session going; a pending
  high-risk card is dropped by a daemon restart (ADR 0030 item 3) and the human asks again; `/health` does not report the watcher or
  the presence row (`RuntimeApp.remote` does); the cloud runner's watcher does not pass the
  owner filter to `pickUp` yet (one option in `services/cloud-runner/src/remote.ts`); no
  end-to-end test drives the real phone client through the state service to the daemon yet
  (the watcher is covered against the store, which is what the service writes).
