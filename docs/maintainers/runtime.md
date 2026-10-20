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

### Conversation agent (`src/conversation/agent.ts`)

The fast channel for text and voice (spec O): Haiku at low effort, a stable cached system
prompt (project summaries) and a volatile first message (time, active project, unread count,
open requests, running sessions). Tools: take a note into the next-session queue, create a
draft task, answer a human request, start a session (budget above the confirm threshold is
read back and waits for "yes"; "no" cancels), stop sessions at once (kill switch), hand real
work to the principal agent through the inbox, switch the active project. Each turn runs
through the loop driver with its own small budget and a token at autonomy 4 (the human is
giving instructions); the run is registered as protected so scoped and global stops never
cut the human's channel. Transcripts are events on a per-agent conversation session; spoken
confirmations are logged with the words used.

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
| GitHub Projects mirror (`@forerunner/capabilities`) | `ProjectsMirror` over the store, the vault (`githubHostForSecretRef` resolves `settings.github_mirror.secret_ref`, default `secret:github_token`) and `DaemonMirrorApprovals` (compose.ts): the daemon's `MirrorHumanPort`, which files the approval request like `HumanRequestMirrorPort`, reuses an open one for the same project, reports which request a project waits on and wakes on `syncApprovals()` instead of waiting for the next poll; an injected `gitHost` (tests) short-circuits `hostFor`. | The scheduler's `start` is `mirrorStartHandler(mirror, startSession)`; `refreshMirrorSchedules()` registers an `every` schedule per project whose settings enable the mirror, at compose and from `PUT /projects/:id/settings`. `RuntimeApp.mirrorSync()` runs one now and answers with the run, or with the approval request as soon as the mirror asks (the run goes on in the background and finishes when the inbox answers it; a second call joins the run). |
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
the specialist's `allowed_tools` (`loopToolNamesFor`: `cc:Read` → `read_file`, `cc:Write`,
`cc:Edit`, `cc:MultiEdit`, `cc:NotebookEdit` → `write_file`, `cc:Glob`, `cc:Grep`, `cc:LS` →
`list_dir`, `cc:Bash` → `run_command`; Forerunner names pass through; anything else is
dropped), so a researcher eval is never offered `run_command`. Nothing an eval runs executes on
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
`PeerFeedView`) and `GET /projects/:id/decisions` (the decision log, `DecisionView[]`), and
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
the route is unauthenticated but loopback-only); `/events` also streams `extension.changed` and
`restart.requested`. Each sub-app keeps its module's error mapping.

### Remote commands from the phone (`src/daemon/remote-watcher.ts`, ADR 0032)

Spec R.4 and scenario 9: the phone enqueues a `remote_command` with `target: "pc"` through the
shared state service, and the PC daemon picks it up "in seconds". `RemoteCommandWatcher` is the
daemon's consumer. It polls `GET /remote/commands/pending?target=pc` on the configured service
with the runtime's admin token (`HttpRemoteCommandQueue`: bearer, `X-Forerunner-Schema`,
`X-Forerunner-Install`) every `FORERUNNER_REMOTE_POLL_MS` (500 ms, at least 100), executes
what it took and reports `POST /remote/commands/:id/complete|fail` with a result the phone
shows; going through the service rather than the store means the pick-up and the result reach
the phone's realtime stream at once. Every command ends with an audit row
(`daemon.remote_command`, `allowed` false with the `denied_reason` on a refusal).

**Configuration.** `FORERUNNER_STATE_API_URL` (or `stateApiUrl` in `config.json`) names the
service; the admin token comes from `FORERUNNER_STATE_API_ADMIN_TOKEN` or the vault secret
`state_api_admin_token` (`SECRET_NAMES.stateApiAdmin`). Without a URL the watcher is off and
compose logs "remote command watcher off: no state service configured" once; a URL without a
token is a warning and the watcher stays off. `ComposeOptions.stateApi` injects both (tests);
`null` forces it off. `/health.remoteCommands` reports `{ enabled, handled, waiting }`.
`FORERUNNER_STATE_SCHEMA` (or `ComposeOptions.stateSchema`) names the Postgres schema the
daemon shares with the service.

**Authorization (ADR 0033 item 8b, again).** The store's pick-up filters on the target only,
so on a shared state another human's phone can enqueue for "pc". Before anything runs the
watcher loads the issuing device and refuses one that is unknown, revoked or owned by another
human, a command addressed to another device (`target_device_id`; the daemon has no device row
of its own yet, see Known issues) and a `start` naming another agent. Refusals are `failed`
with `forbidden: ...`.

**What it runs** (`src/daemon/remote-envelope.ts` holds the zod schemas):

| `params` | Action | Result |
| --- | --- | --- |
| `{ v: 1, kind: "plan", plan: [{ name, params }], wordsUsed, card?, clientId?, confirmedAt?, undoOf?, source? }` | the plan through the command registry (below); `undoOf` runs `executor.undo` on that change-log row and ignores `plan` | `{ executed, changeLogId, undoOf, undoToken, sentence, status, sessionId?, confirmedBy? }` |
| `{ v: 1, kind: "chat", text, projectId?, clientId? }`, or the bare verb `chat { text, projectId? }` (ADR 0034) | `conversation.chat` with `source: "phone"` | `{ reply, actions, transcriptId, activeProjectId, ttftMs, pendingConfirmation? }`; `provider_auth` when no model credential exists |
| `kill { scope?: "all" \| { agentId?, sessionId? }, reason? }` | `KillSwitch.stop`; the daemon writes `kill.json` and emits `kill` on `/events` | `{ stoppedRuns, killedProcesses, revokedTokens, killDurationMs, killActive }` |
| `stop` / `session.stop { scope?: all \| agent \| session \| {...}, session?, agentId?, reason? }` | stop, then lift the freeze (the PC stays free to start new work) | `{ stoppedRuns, killedProcesses, killDurationMs }` |
| `start` / `session.start { agentId?, projectId?, budgetUsdMicro?, reason? }` | lifts the freeze and asks the scheduler (trigger `remote`) | `{ result: started \| queued \| deferred, sessionId }` |
| `pause` / `session.pause`, a plan step `session.pause` | refused: the runtime cannot pause a session yet | `failed`, `not_supported` |

A `v` the daemon does not know, or a malformed envelope, fails with `validation`; every
result carries `durationMs`; a failure's result is `{ error, code }`.

**Plans: the card is never trusted.** The daemon now composes the command registry
(`defaultRegistry()`, persisted into the `command` table, a `CommandExecutor` over the store)
with live ports: `startSession` through the scheduler, `kill` through the kill switch (a
scope other than "all" is followed by `resume()`), the CHF rate. `RuntimeApp.commands`,
`commandPorts` and `commandContext()` expose them; `resumeScheduled` re-arms temporary
changes at compose. For a plan the watcher builds a context for the PC's human (active project
from `human.notify_prefs`, the human's time zone, `source` from the envelope, `deviceId` null
and `remoteDeviceId` = the phone, so `session.start` starts here with the phone as the
session's device instead of enqueueing another remote command), plans the composed card on the
real state, asks `ConfirmationPolicy.decide` for the real risk and only then acts: low runs;
medium takes `confirmedAt` as the human's tap (the device signed the enqueue) and otherwise
files the executor's `needs_yes` request; high always files the executor's `needs_device`
request. A command whose plan is pending stays `picked_up` and is checked every poll (and at
once when `POST /requests/:id/answer` lands, through `remote.wake()`): the service records a
device's answer to a command confirmation as `{ choice, kind: "device", by, device_id,
biometric }`, the watcher hands device and flag to `executor.confirmFromDevice` (the policy
enforces "biometric on a phone" in code), a raw `yes` on the request is enough for medium risk
only, a rejection, an expired request (the executor's ten minutes) or a refused answer fails
the command and closes the pending entry so the human asks again. `session.started` events now
carry `sessionId`, and `RuntimeApp.startSession` resolves with it as soon as the runner recorded
the row, which is how a plan's result names the session the phone then watches.

### Specialist registry (`src/registry/`)

The loader for `forerunner-registry` content: specialist, principal and critic definitions as
Markdown with front matter (model defaults, effort, tool allowlist, budget defaults, eval set),
validated with zod, with a prompt version hash recorded on every run. `proposals.ts` writes a
proposed specialist as a pull-request-ready file instead of editing the registry in place, so
every new specialist goes through review. The composition root turns registry entries into
`SpecialistSpec`s for the executor. See `adding-a-specialist.md` for the file format and the
golden eval sets under `evals/registry/`.

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
`context.headroom_unavailable` event; `views.test.ts`: cost view savings money), Anthropic adapter mapping, SDK driver options and hooks, sessions (checklist and brief size, planning, claims, collisions, budget stop, kill, advisor mode, concurrency, scheduler), executor, receipts (acked by reading, acked by reply, resurfacing), decisions (ask once, record, supersede, approvals ignored), peers (hints, overlap rules, feed from the store, overlap message and skip through the runner), daemon (auth, projects and tasks with a 409 on a bad transition, chat and inbox, sessions, events and kill, costs, SSE with the restart event, `stop()` returning while `/events` is held open on a real socket, the remote watcher off without a state service), remote watcher (`remote-watcher.test.ts`, against a fake state service serving the three routes over the daemon's store: the scenario-9 plan ends `done` with the session started on the game with the phone as its device and the change log holding the words, `undoOf` stops it and restores budget and project, a lying card never lowers the risk (high risk files the device confirmation and waits; biometric answer completes, no biometric / rejection / expiry fail), a medium-risk plan waits for a yes from the inbox, registry refusals, chat envelope and verb, kill within one poll, stop lifts the freeze, start asks the scheduler, pause refused, another human's or a revoked device and a command addressed to another PC refused with the cloud queue untouched, a failing service retried, `readAnswer` shapes, and the whole thing through `composeRuntime` with a real session), wiring (`wiring.test.ts`: extensions from catalog to a refused tool, model watch report and inbox decision, updates screen, mirror sync answering 202 then running on the inbox answer, estimates accuracy, sandboxed `run_command`, a refused lease closing the Run row, the eval runner keeping the model's command in the sandbox lease and offering only the specialist's tools, CLI registration and one-shot composition), hooks (overspend, steps, wall clock, kill, allowlist, schema,
paths, domains, secrets, autonomy, injection), ladder, brief, loop driver (completion, overspend
blocked, step cap, kill mid-run, timeout with partial output, inline denials, needs-human pause,
injection flagged).

## Requirements covered by the daemon wiring

K.6 and L.5 (extensions reachable from the daemon, revoked live), S.7 (task commands in a
sandbox with only the worktree and the token's domains), I.3 (estimate error tracked and fed
back to the planner), D.6 and D.21 (weekly model watch scheduled, decided in the inbox), M.3,
M.4 and M.5 (updates screen, apply, rollback, restart contract, health check on start), S.9
(every outward action of these modules is an audit row). Test: `test/wiring.test.ts`.

## Known issues

- The SDK driver's live behaviour is only verified when a credential is present (see
  `gates.md`); without one the integration test skips with a visible reason.
- `LoopTaskExecutor` derives a run token with the registry's `allowed_tools` as written
  (`cc:` names for the SDK driver), so an in-process run of a registry specialist through the
  loop driver is offered no built-in file tool; only the eval runner maps them
  (`loopToolNamesFor`). Decide whether the executor should map the same way.
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
- Remote commands (ADR 0032): the daemon registers no `desktop` device row yet, so the watcher
  polls without a `deviceId` and refuses (visibly, `failed`) a command addressed to a specific
  device; the runtime cannot pause a session, so `pause` and `session.pause` from the phone fail
  with `not_supported`; the watcher polls (500 ms) instead of subscribing to the service's
  `remote_command.changed` events; quick chat from the phone runs the conversation agent with
  its usual tools, not the read-only turn ADR 0034 wished for the web. The settings screen still
  does not call `RuntimeApp.commands` (no daemon route for commands yet).
