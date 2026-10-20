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

Baseline compression that is always available: `collapseLogs` (CRLF, ANSI, trailing spaces,
progress bars, repeated lines), `elideDenseLines` (minified/base64 lines), `dedupWithinBlock`
and `CrossTurnDedup` (repeated windows inside a block and across earlier tool results, always
keeping the earliest occurrence), `truncateWithErrors` (head/tail with error lines and test
summaries kept, original hash noted). `ContextPipeline.compressToolResult` applies them to the
live zone only (the newest tool result), records tokens before/after and the transforms used,
honours per-tool profiles (`read_file` 16k cap, diffs skip dedup) and a per-call bypass (the
critic and evals pass `"off"`). `cache-layout.ts` keeps the prefix stable: compacted tool
schemas, `layoutSystem` order (registry prompt → project brief → instructions → pinned lessons),
`assertStablePrefix` rejects timestamps, UUIDs, JWTs and hashes in the system prompt,
`volatilePreamble` puts them in the first user message. `fitToBudget` is the greedy
retrieval-under-budget helper used by memory. The Headroom proxy adapter lands with phase 6.

### Command line and setup (`src/cli/main.ts`, `src/setup/`)

`pnpm fr -- <command>` (installed as `fr`): `setup` (guided or `--non-interactive`; each
credential is explained with what, why, scopes, where to click and how it is verified, validated
on paste through `src/setup/validators.ts`, then stored in the vault by name; `config.json`
never holds a secret), `status` (directories, config, secret names only), `doctor`
(prerequisites), `kill` (writes a kill request file), `dirs`. The kill request file in the
runtime directory is polled by `KillFileWatcher` in every running runtime, so the CLI, the
tray and the app can stop sessions across processes on both platforms.

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
budget into per-call caps so the cap checker never runs with stale limits.

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
stable-prefix lint, bypass), Anthropic adapter mapping, SDK driver options and hooks, sessions (checklist and brief size, planning, claims, collisions, budget stop, kill, advisor mode, concurrency, scheduler), executor, receipts (acked by reading, acked by reply, resurfacing), decisions (ask once, record, supersede, approvals ignored), peers (hints, overlap rules, feed from the store, overlap message and skip through the runner), daemon (auth, projects and tasks with a 409 on a bad transition, chat and inbox, sessions, events and kill, costs, SSE), hooks (overspend, steps, wall clock, kill, allowlist, schema,
paths, domains, secrets, autonomy, injection), ladder, brief, loop driver (completion, overspend
blocked, step cap, kill mid-run, timeout with partial output, inline denials, needs-human pause,
injection flagged).

## Known issues

- The SDK driver's live behaviour is only verified when a credential is present (see
  `gates.md`); without one the integration test skips with a visible reason.
- Path containment resolves symlinks only when the target exists; the sandbox adapter mounts
  only the worktree so escapes cannot reach the host anyway.
