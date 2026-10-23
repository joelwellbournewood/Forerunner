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
`revoke`/`revokeWhere` are used by the kill switch. `issue` refuses an `expiresAt` that does
not parse as a time, and `verify` and `claimsForRun` read one that still slips in as already
expired (compared as NaN it counted as "never expires" before; `test/security-tokens.test.ts`).

### Enforcement hooks (`src/enforcement/hooks.ts`)

| Hook | Checks, in order |
| --- | --- |
| `beforeModelCall(ctx, estimate)` | token valid and not revoked, kill state, session wall clock, run deadline, step cap, run cap, session cap with 80% finish-current and review reserve, outer caps (task, project, month, plan share) via `CapsPort` |
| `afterModelCall(ctx, usage, usd)` | records spend in `SessionBudget` and the ledger |
| `beforeToolCall(ctx, tool, input)` | token/kill, step, tool allowlist, zod schema, path containment for `pathFields` (`pathInsideRoot`: inside a root as written and once the symlinks of the path's existing part are resolved, so a committed `link -> ~/.ssh/id_ed25519` or a linked directory in the worktree is refused for reads and writes alike, and a link that cannot be resolved counts as outside), domain allowlist for `domainFields`, autonomy decision (may ask `ApprovalPort`; the key an approval is remembered under is `tool:<SHA-256 of the canonical input>`, `approvalKeyFor`, the same function `StateApprovals` writes into `change_card.key`; an approval of an always-human class (`ALWAYS_HUMAN`) admits one call and is taken out of `ctx.approvals` as it is used, so the resume path re-makes the paused call once and every further identical delete, purchase or send asks again, while any other approval holds for the run; pending pauses the run; skipped for a tool with `gate: "registry"`, a command of the command registry whose executor confirms by risk itself, so the change card is the one approval and the hooks file no second request), secret-ref resolution for granted names only; denials are audited, a call on a revoked, expired or forged token or after a stop too (the row carries the token's own id and run, unverified, spec S.9) |
| `afterToolCall(ctx, tool, input, result)` | redacts resolved secrets, wraps untrusted output in the data envelope and scans it for injection, audits. Every audit summary the hooks write (input and result, on the allow, deny and pending paths) is scrubbed first: the run's resolved secret values in every encoding (`SecretsPort.redact`), then the platform's credential shapes as a last line for a value the model obtained elsewhere and pasted into a later input, with `secret:<name>` references kept, since the name is what the audit is meant to carry |

The per-session accounting is `SessionBudget` (`src/enforcement/budget.ts`): run and session
caps, step cap, wall clock, the 80% rule and the review reserve (default 20%). The estimate
before a call is conservative: full input at input price plus `max_tokens` at output price.
Every estimate and spend must be a non-negative safe integer of USD micro-units: `precheck`
and `record` refuse NaN, infinity, a fraction and a negative with `validation` (a NaN recorded
once made every later cap comparison false, which switched the session's hard cap off for
good), and the limits are checked with negated comparisons so a NaN cap, step cap, deadline
or reserve share is refused at construction.

### Autonomy (`src/enforcement/autonomy.ts`)

Action classes map to decisions per level 0–4. `destructive`, `financial`, `credential`,
`permission_change` and `capability_grant` need a human at every level. Level 0 proposes only,
level 1 runs routine work after plan approval, level 2 frees routine reversible work, level 3
also merges reviewed PRs and deploys to staging, level 4 everything else. The one exception
to the hooks asking is a tool gated by the command registry (`ToolSpec.gate: "registry"`, set
by `CommandLoop.tools` on the conversation agent's model path): its always-human rule is the
registry's own (a high-risk command needs the paired device, ADR 0030), applied by the
executor when the tool runs, so the human answers one card instead of a hold and then the
card (RT-P5-3, testing.md). The decision is recorded here, no ADR number having been reserved
for the change: the alternative, the hooks asking first and the registry reusing the
answer, was rejected because the card is what the human reads back and the hold shows the
tool's raw input instead.

### Kill switch (`src/enforcement/killswitch.ts`)

Registered runs (abort controllers) and child processes are stopped, tokens revoked and claims
frozen through a callback; the test proves 40 runs and 3 processes stop in under 2 s. A stopped
scope stays frozen (new registrations abort at once) until `resume()`. The cross-process kill
file (`src/enforcement/killfile.ts`) goes through `parseKillRequest` before `KillFileWatcher`
acts on it: something that is not an object with a `requestedAt` is no request (ignored, like
unparseable JSON), and a scope that is neither `"all"` nor an object naming an agent or a
session is read as `"all"`, because the switch would stop every registration for such a scope
yet freeze nothing, so new work would start at once (fail closed).

### Shared secrets (`src/secrets/`; spec S.13, ADR 0065)

A secret in one human's vault, readable by named agents of the other human, with both
humans approving. The vault primitives are in `packages/vault/src/wrap.ts` (security.md);
this module holds the rules and the two sides.

- **`shared-grants.ts`, the store side**, used by the daemon directly and by the state
  service's `/secrets` routes (ADR 0024: both talk to the same tables). `proposeSharedGrant`
  validates the owner, the agents and every blob's install (a non-revoked device of that
  agent's owner with a `wrap_public_key`; the blob a `WrappedSecret`), writes the
  `secret_grant` row (pending; active at once when only the owner's agents are named) and
  one `human_request` per other human whose agent is named: kind `approval`, risk `high`,
  options `approve` / `deny`, a `shared_secret_grant` change card naming the grant, the
  secret, the owner and that human's agents. `applySharedGrantAnswer(tx, request, by)` runs
  inside the transaction that answered the card (the service's `answerRequestAs` and the
  daemon's `POST /requests/:id/answer` both do): a yes records the approval and the
  last required one activates the grant and mirrors it into `secret_ref` (`scope: "shared"`,
  the agents in `granted_to`); a no cancels it, drops the blobs and withdraws the other open
  cards. `revokeSharedGrant` is the owner's end at any time. `serveSharedBlob` is the only
  read that hands a blob out: an active grant of that name naming that agent, the copy
  wrapped for that device; anything else is `secret_not_granted` after a `secret.blob_refused`
  row. Audit rows: `secret.grant_proposed`, `secret.grant_approved`, `secret.grant_activated`,
  `secret.grant_refused`, `secret.grant_revoked`, `secret.blob_served`, `secret.blob_refused`
  and, on the resolving install, `secret.shared_resolved`; each names the grant, the secret,
  the agents and the install, never a value.
- **`resolver.ts`, the resolving side.** `SharedSecretVault` is the `Vault` the hooks'
  `SecretResolver` reads: this install's own vault first, then (bound once the daemon's
  device row exists) the wrapped copy the shared state serves for this agent on this install,
  unwrapped with the install's private key read from the vault at that moment. Nothing is
  written to the local vault or to disk; the string handed to the tool call is the only copy,
  as for a local secret, and `afterToolCall` redacts it from outputs the same way. The
  `grantedSecrets` rule of the hooks is unchanged: the names of the agent's active grants
  (`sharedSecretNamesFor`) join the session grant at every start, and a name the token does
  not grant is refused before this vault is asked. Two sources: `StoreSharedSecretService`
  (the daemon and the runner, over the store) and `HttpSharedSecretService` (an install that
  reaches the state through the service: `GET /secrets/shared/blob`, 403 and 404 are "nothing
  for you", anything else `unavailable`).
- **`propose.ts`, the owner's side.** `proposeSharedSecret({ vault, service, ownerHumanId,
  name, agentIds, why })` reads the value from this install's vault, lists the wrap targets
  (every install of every named agent's owner with a key; an agent without one is
  `validation`), wraps one blob per target and files the grant. The value leaves the function
  only inside the blobs.
- **In the daemon.** `composeRuntime` creates the install wrapping key in the vault
  (`ensureInstallWrapKey`) and registers it on the desktop device row (`registerDesktopDevice`
  takes `wrapPublicKey`; the row is registered whenever there is a shared state, or remote
  control was asked for explicitly), wires `SharedSecretVault` under the hooks' resolver with
  the `secret.shared_resolved` audit row, and exposes `rt.sharedSecrets` (`propose`, `revoke`,
  `list`, `names`). `routes.ts` mounts `POST /secrets/shared { name, agentIds, why?, kind? }`
  (201 `{ grant, requestIds, targets }`), `GET /secrets/shared` and
  `POST /secrets/shared/:id/revoke` on the daemon API for the app; no body carries a value.

### Drivers

`LoopAgentDriver` (`src/agent/loop.ts`) runs the tool loop over any `ModelProvider`
(`src/provider/types.ts`): estimate → `beforeModelCall` → stream → cost → `afterModelCall` →
for each tool use: `beforeToolCall` → execute with per-tool timeout → `afterToolCall`. Outcomes:
`completed`, `timeout` (partial text kept), `budget_exceeded`, `step_cap_exceeded`, `killed`,
`needs_human` (approval pending), `max_turns`, `error`. Events stream to the live session view.
`SdkAgentDriver` (`src/agent/sdk.ts`) wraps the Claude Agent SDK with the same hooks; a task
runs on it when its billing source is a subscription (see "Billing per task" below, ADR 0044).

**What the subprocess inherits and what it gets back (security review, `test/security-sdk.test.ts`).**
`scrubEnv` builds the subprocess environment (and the process sandbox's base environment): a
variable goes when its name is a credential's (the provider and store prefixes; `TOKEN`,
`SECRET`, `PASSWORD`, `CREDENTIAL`, `PRIVATE_KEY`, `API_KEY`, `ACCESS_KEY`, `COOKIE` anywhere;
`PASS`, `KEY`, `AUTH`, `DSN` as a whole segment, so `SMTP_PASS`, `SIGNING_KEY`, `BASIC_AUTH`,
`SENTRY_DSN` and `SSH_AUTH_SOCK` go while `PATHEXT` and `XAUTHORITY` stay), when its value
carries `user:password@` in a URL (a database or state URL is dropped; a `*_PROXY` keeps its
URL with the user-info cut out, since the subprocess reaches the API through it) or when the
platform's credential shapes find a token in the value under any name. Exactly the picked
credential is added afterwards. The hooks run as `PreToolUse` / `PostToolUse`: the Claude Code
specs (`src/agent/cc-tools.ts`) carry the path and URL fields and, for `Glob.pattern` and
`Grep.glob`, refuse a pattern with a `..` segment (also inside a brace list) or an absolute
prefix (`/`, `\\`, `C:`, `~`), since the SDK resolves it against `path` or the run directory
and the containment check on `path` alone would let it walk out. `PreToolUse` keeps the
model's input per `tool_use_id`, because `PostToolUse` reports the input the tool ran with,
which is the `updatedInput` with the resolved values; the audit row is written from the
model's input (`secret:<name>`). `PostToolUse` hands the redacted content back to the
subprocess as `updatedMCPToolOutput` for every `mcp__` tool and for the web tools (wrapped as
data and scanned); a repository read by the built-in `Read`, `NotebookRead` or `Grep` is marked
`repo_file`, scanned and flagged like the loop driver's `read_file`, though its text cannot be
rewritten from the hook. The executor redacts a run's final text (`redact`, the platform's
shapes) before it becomes the task summary, the final report and the lesson candidates, on the
success path as on the error path (ADR 0044 item 9).

**Specialist tools on each driver (`src/registry/tools.ts`, ADR 0043).** The registry names
Claude Code tools (`allowed_tools: cc:Read, cc:Edit, cc:Bash, ...`) for the SDK driver, which
offers that tool set as is. The loop driver offers Forerunner's tools, so each driver maps the
names its own way and the default is set in `composeRuntime` next to the drivers it builds
(`specialistDriver`, "loop"); per task the executor asks for the other form when the billing
pick names a subscription (ADR 0044). `specialistSpecFrom(registry, { driver, tools, commands,
onDropped })` turns a runnable entry into the executor's `SpecialistSpec` and returns a lookup
`(name, driver?)` whose second argument overrides the default for one call; the options are
required, a call without a driver is a `validation` error, and an executor built elsewhere
(the cloud runner) takes `RuntimeApp.specialists`, never the registry's names by omission. On
"sdk" the `cc:` names stay as written; on "loop" `loopToolsFor` replaces
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

**Billing per task and the SDK path (`src/session/billing.ts`, `src/wiring/billing-pick.ts`,
`src/agent/cc-tools.ts`; ADR 0044).** `LoopTaskExecutor` takes a `TaskBillingPort`; the
daemon's is `RouterTaskBilling`, which calls `BillingRouter.pick` once per task with the
session's runner (`pc`), purpose `session`, the run's starting tier, the install's policy
(`pcRoutingPolicy(personalRunner)`; `FORERUNNER_RUNNER_PERSONAL=0` says this PC is not the
human's own) and `VaultLedgerProbe` (available when the vault holds the credential; the plan
share from the month's ledger rows, `MAX(plan_usage_share)` or the month's subscription spend
over `limits.planUsdMicro`). The agent's owner (the agent row, else the token's owner claim)
is compared with the daemon's human first: another human's agent never sees the subscription
(withheld, reported as skipped `other_human`); the API key may serve it. The pick goes on the
Run row (`billing_source_id`) and into an audit row `billing.pick` (`BILLING_PICK_AUDIT_TOOL`:
task, run, agent, tier, source, kind and driver in `input_summary`, the router's reason with
every skip in `result_summary`). A `subscription` pick runs the task through `SdkAgentDriver`
with `credential: { kind: "oauth_token" }` read from the vault by the source's reference at
run start (`credentialFor`, inside the executor's try, held in no field), the registry's `cc:`
names as written (`specialists(name, "sdk")`), the same derived token, `SessionBudget`,
hooks, kill switch and critic; everything else runs through `LoopAgentDriver` as before. One
executor, two drivers behind one `DriverOutcome`: the brief, the memory block, the retry
ladder, the Run row (`provider: "anthropic-sdk"` on the SDK path; artifacts with the SDK
session id and its own list-price figure `sdk_cost_usd_micro`), the whole-millisecond timings,
`run.persist_failed` and the lessons are shared; a driver's error message goes through
`redact()` before it becomes the task's `summary`, and a thrown error's before it enters the
Run row's `error` artifact, since the store has no redaction layer of its own. The hooks get the run's billing facts
(`RunContext.billing`: `kind`, `planShareCap`, a `planUsageShare` closure fed by the session
budget's spend on the run, `planShareAfter`): `afterModelCall` writes "subscription" ledger
rows with `plan_usage_share`, `beforeModelCall` hands the share to the caps port, and
`DynamicCaps` adds the plan level to `CapChecker` (80% finish-current, the cap stops). The SDK
subprocess is no sandbox: `cc:Bash` is withheld from the SDK token with a
`registry.tool_unmapped` row unless `billing.hostCommands` (`FORERUNNER_SDK_HOST_COMMANDS=1`)
opts in, which warns on the run; the other Claude Code tools get `ToolSpec`s for the hooks
(`withClaudeCodeTools`: `pathFields` on the file tools, `domainFields` on `WebFetch`,
`routine_reversible` for edits), the token's only path is the worktree or the run's own
directory under `<worktrees>/sdk-runs/<runId>`, and the session grant lists the `cc:` names
(`claudeCodeToolNames`) when the vault holds the OAuth token, so a derived token can carry
them and an install on the API key alone declares none. Both sources are seeded from the
vault at compose (`seedBillingSources`: `subscription` for `anthropic_subscription_token` with
the plan allowance in force as `limits.planUsdMicro`, `api_key` for `anthropic_api_key`, a
`fake` row only when nothing else exists, and an earlier `fake` row disabled as soon as a real
source is enabled; `RouterTaskBilling` also withholds a `fake` candidate beside a real source,
skipped `unavailable`, so a subscription at its cap and an API key at its limit end in
`unavailable` rather than real work booked to a stand-in). The plan allowance
(`src/setup/plan-allowance.ts`, ADR 0044 item 8) is resolved most explicit first:
`ComposeOptions.billing.planUsdMonthly`, `FORERUNNER_PLAN_USD_MONTHLY`, `config.json`'s
`subscription.planUsdMonthly` (what `fr setup` recorded), else `DEFAULT_PLAN_USD_MONTHLY`
(USD 50), so the caps' plan level always exists; a human-set value updates the row at the next
compose, the default only fills a row that has none; `RuntimeApp.billing.planAllowance` and the
compose log say which applies (`describePlanAllowance`). `RuntimeApp.billingSourceId` is the
loop paths' source (the key when there is one, the one the Messages provider authenticates
with), `RuntimeApp.billing` exposes `sources()`, `pick`, the SDK driver and `hostCommands`;
`ComposeOptions.sdkQuery` injects the SDK's `query` so no test spawns Claude Code. Tests:
`test/subscription-path.test.ts` (the path, the seeding, the fake row withheld, the setup
questions and the allowance), `test/executor.test.ts` (the redacted error artifact).

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
on paste through `src/setup/validators.ts`, then stored in the vault by name; the questions in
order are the GitHub token, the Anthropic API key, the subscription token
(`--subscription-token`, `FORERUNNER_SUBSCRIPTION_TOKEN`; skipped when the Anthropic step
already stored a `sk-ant-oat…` token; format-checked only, no request, ADR 0044) and, once a
subscription source exists, the plan allowance (`--plan-usd-monthly`,
`FORERUNNER_PLAN_USD_MONTHLY`; a positive number of USD per month, else the default USD 50;
written to `config.json` as `subscription.planUsdMonthly` when given; a bad flag or
environment value is a `validation` error before any credential is stored); the summary's
"Billing sources:" line names the sources the next start registers and the allowance with its
origin; `config.json` never holds a secret), `status` (directories, config, secret names only), `doctor`
(prerequisites), `kill` (writes a kill request file), `dirs`, `daemon`, `audit export` (the
audit log to a file, in the table below). The kill request file
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
| `fr audit export [--agent <id>] [--session <id>] [--from <iso>] [--to <iso>] [--format jsonl\|csv] [--out <path>] [--force]` | `registerAuditCli` (`src/cli/audit.ts`) over the composed runtime's `store`, `clock` and `human`, `startServices: false` | Spec S.9, ADR 0050: the install's human's audit rows and their agents' (plus the install-level rows that name nobody) through the daemon's export module (`src/daemon/audit-export.ts`), paged, as JSON lines or CSV, the summaries as stored. Flags are checked before the runtime is composed; `--out` defaults to `forerunner-audit-<UTC stamp>.<format>` in the current directory (parent directories are created); an existing file is refused unless `--force`; another human's agent is `not_found`; prints `N rows written to <path> (<format>)`. |

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
(`LoopTaskExecutor`: validated brief, the billing source picked for the task and the driver
that follows it, derived narrower token, specialist prompt and model from the registry, Run
row recorded; ADR 0044), then moves it to done (tier 0 with checks passed), in review,
needs human or failed; the inbox is re-checked between tasks and a human "stop" ends the
session; at 80% of the budget or a mid-task cap no new task starts. Session end writes the
project summary cache, sends a handoff (requires ack) to the project's peers
(`settings.members` or agents that touched the project), notifies the human and records the
session summary, handoff and spend. `triggers.ts` is the scheduler (daily, weekdays, every N
minutes in the human's time zone; message, CI, PR comment, email, remote and manual requests;
one active session per agent; quiet hours defer non-manual triggers). `state-ports.ts` adapts
the store to the enforcement ports: ledger rows with CHF at the day's rate, audit rows, and
approvals as HumanRequests whose "yes"/"no" answers resolve the pending tool call (matched by
`change_card.key`, the hooks' SHA-256 key; a row written under the former 32-bit string hash
no longer matches, so such an approval is asked once more).

**Small-project mode and the plan writer (spec B.6, ADR 0051).** `src/session/project-plan.ts`
is where `project.small_project_mode` is read. `defaultRiskTier(project)` (0 with the flag,
else 1) is the one place a new task's tier is chosen when the task names none: the daemon's
`POST /projects/:id/tasks` (`riskTier` optional), the `task.create` command (`risk_tier`
optional) and the plan writer call it; the critic reviews at `task.risk_tier` and never reads
the flag, so a named tier stands and flipping the flag leaves existing tasks alone.
`applyProjectPlan(store, project, plan, author)`, served as `POST /projects/:id/plan`
(`ProjectPlanBody` to `PlanProjectView`), writes a plan (phases with their tasks, loose tasks,
one reason for every row) as milestone and task rows in one transaction: outside the mode a
milestone per phase after the project's existing ones (`order_index`) and the loose tasks under
none; in the mode exactly one milestone (the planned one when the plan names a single
milestone, else one named after the project with every phase's success criteria once each and
the latest target date), every task under it in plan order, and a later plan joins the
project's open milestone instead of adding one. `dependsOn` takes plan keys or ids of the
project's own tasks and the rows are written dependencies first; an unknown reference, a cycle,
a duplicate key, an empty plan or one over the caps (`MAX_PLAN_MILESTONES` 20,
`MAX_PLAN_TASKS` 200) is refused as `validation` (409 `conflict` on the route, ADR 0025) with
nothing written. Milestone target dates are calendar dates (`YYYY-MM-DD`). The project card
carries `smallProjectMode` and `defaultRiskTier` so the UI computes neither. Not yet on the
helper: the email command's task insert in `packages/capabilities` names tier 1 literally
(`BLOCKERS.md`). Tests: `small-project.test.ts`. Requirement: B.6.

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
starts (model, effort, prompt version, the billing source the task picked, depth) and patches
it with the result afterwards: tokens, cost, `ttft_ms`, `duration_ms`, outcome, `timed_out`,
the context numbers and the artifacts, on the loop path and on the SDK path alike (ADR 0044);
a driver that throws closes it as `error` with the reason. `ttft_ms` and
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
`test/loop-commands.test.ts`, `test/signoff-answer.test.ts`, `test/approvals-poll.test.ts`).

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
`applied_at` and the outcome. The sign-off ends with the human the same way
(`syncSignoffAnswers`, same file; phase 5 follow-up RT-P5-1): every `human` decision (a
tier 3 review, a `human` verdict, the ladder's last rung, filed by `CriticService`,
`applyVerdict` or the loop's ladder branch) carries a `change_card` keyed `critic:signoff`
(`signoffCard` in `@forerunner/critic`: the task, the review, the run, the review's finding
ids, the reason, `applied_at`), and `syncApprovals()` applies the answer of each answered one
once, and only when the request is the task's current sign-off (ADR 0049): a request whose
`review_id` is not the task's latest review (the human moved the task on from the UI without
answering, a later session reviewed it again and filed a new sign-off while the old one
stayed open in the inbox) is skipped as `stale` and touches nothing, so an old card never
closes the task or resolves a later review's findings. `accept` resolves the card's findings
and the task's other open findings up to the card's review (the rework's history: the critic
resolves earlier findings only on its own accept, so the ladder's last rung leaves them
open; `reviewedBefore`) against the run and closes the task (the task graph has no
`needs_human -> done` edge, so it re-enters the flow and closes through review,
`ready -> claimed -> in_progress -> in_review -> done`, in one store transaction with the
findings and the audit row, so every rule of the store holds and nothing observes the
intermediate states; a close the store still refuses over an open finding is recorded
`findings_open`), `revise` goes `ready -> failed -> ready` with the attempt counted and
the findings kept open, and the owner agent gets a `request` message with the request's
steps as required actions, `cancel` cancels; a task the human moved on in the meantime or an
answer outside the options is skipped and recorded on the card (`task_moved_on`,
`unrecognized_answer`). Each applied answer is one `critic.signoff` audit row (ids and the
outcome, never the text). Both syncs scan the human's answered blocking approvals
(`unappliedAnswers`: `kind: approval`, `status: answered`, `blocking: true`, newest first)
page by page to the last page, so an answer that sat behind hundreds of later answers
during a long downtime is still applied. At session end `reviewSession` runs the critic's honesty, plan and cost checks on the
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
the source (`SOURCE_OF`: `chat` for text and the phone, `voice` for voice, `ui` for the
settings screen's route calls). The conversation agent calls
`parse` (deterministic; `matched: "none"` means the model answers), `compose` (one card, one
change log row for a combined request), `tools` (the command tools for the model path, each
`gate: "registry"` so the hooks leave the confirmation to the executor, and each run with the
principal agent as actor, not the human: a command the model decides to call is recorded as
the agent's act, `author_agent` set and `author_human` null, and a `limit` command asks
whatever its risk, ADR 0030 item 2; the human stays `humanId`, whose yes confirms;
`security-command-actor.test.ts`), `confirmByText` and
`undo`; the daemon calls `execute`, `confirm`, `cancel`, `pending`, `changeLog` and `undo`. `start()` persists the command table and re-arms the reverts of
temporary changes after a restart; `stop()` cancels the timers. `sessionCapFromSettings` is
how the scheduler's `startSession` reads the cap the registry wrote (a temporary override
while its window is open, else `session_cap_usd_micro`), so a session started by the
scheduler honours "give it 20 francs tonight" (spec Q.12). `sessionCommandPorts` builds the
registry's `startSession` and `kill` ports over the scheduler, the kill switch and the
store's sessions: `session.start` answers `{ outcome: started | queued | deferred, startId }`
(the session id is never known synchronously; `startId` is the scheduler entry's id, one id
from the queue to the run, `Scheduler.requestStart`), which the registry keeps in the change
log row (`after.start_id`) and names in the undo's kill scope (`KillScope.startId`,
`@forerunner/commands`). The undo (a kill of the agent's scope naming the start, with
`SESSION_START_UNDO_REASON`) is answered by `startUndoState(agentId, startId)` for that
start and no other (phase 5 follow-up RT-P5-2, ADR 0049): `pending` (the scheduler's
`pendingStart` carries the id) drops the waiting request (`Scheduler.cancelPending`) instead
of stopping the session the agent is running; `running` (`Scheduler.activeStart` carries
the id) stops the session that start began as that session only (`kill.stop({ agentId,
sessionId })`, never the agent's scope, so the kill switch holds nothing else and the next
scheduled session runs), the row being the agent's active session of this install's runner
kind (`runner`, default `pc`; a cloud session of the agent in the shared store is never it)
with the start's trigger, begun at or after the start; `ended` (neither: the session ended,
the queue slot went to a newer request, or the row names no start) is a no-op that never
reaches the kill switch. A later start of the same agent, by hand, from the phone or by
schedule, is never mistaken for the one undone: the morning's start undone in the afternoon
while the afternoon's session runs is the no-op, and the afternoon's undo stops the
afternoon's session only. `CommandLoop.undo` asks the same `startUndoState` before the
executor: the undo of a change that is one `session.start` whose session ended is refused
with `SESSION_START_ENDED_REASON` ("the session this start began has already ended; there
is nothing to undo") and the row is marked `irreversible` (the Changes screen stops
offering it; no undo row is written); inside a composed change (the phone's "switch,
budget, start") the start part is the no-op and the rest is undone. A start made with a
phone's or web client's device id (the daemon's `POST /commands/execute` with `deviceId`)
is a remote row the PC's `RemoteCommandWatcher` runs, so its change log row has
`after.remote_command_id` and `after.start_id: null`; the watcher records the start's
identity in the row's result (`startId`, below) and the undo reads it there
(`session.start`'s undo names it in the kill scope): a `pending` row is failed by the
executor as before; a `picked_up` row (the PC is starting the session this instant) is
refused as in flight (`SESSION_START_IN_FLIGHT_REASON`, code `unavailable`) and stays
undoable; a `done` row is the start the result names (running: stopped as that session
only; ended: refused as above), and one whose result names no start (a runner that records
none, such as the cloud runner's watcher) is refused as `SESSION_START_UNKNOWN_REASON` and
marked irreversible, since its session cannot be found from here and nothing is stopped by
guesswork; a `failed` row never ran (`SESSION_START_NOT_RUN_REASON`).

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
is giving instructions; the registry's confirmation policy guards by risk, and because the
command tools are gated by the registry the hooks hold none of them: a high-risk command such
as `email_mode_set` forms its `needs_device` card on the first call, one request and one
answer, `test/conversation.test.ts`); the run is registered as protected so scoped and
global stops never cut the human's channel.
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
the billing sources from the vault (both when both credentials exist, ADR 0044). `DynamicCaps`
turns a human's monthly cap and a project's budget into per-call caps so the cap checker never
runs with stale limits, and adds the plan level for a subscription run from the billing facts
the hooks pass. There is exactly one wiring: the daemon, the CLI and the tests all go through
it (ADR 0029).

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

`syncApprovals()` (extension grants, model watch decisions, memory consolidations, the
blocked-findings answers and the critic sign-off answers) runs at compose and after every
`POST /requests/:id/answer`, so an answer in the inbox takes effect at once, and on the
approvals poll (`ComposeOptions.approvalsPollMs`, `FORERUNNER_APPROVALS_POLL_MS`,
`DEFAULT_APPROVALS_POLL_MS` = 5 s): an answer given on the phone or in the web approvals
lands in the shared state through the state service and reaches no route of this daemon, so
the poll applies it within seconds, the way the remote watcher picks up the phone's commands.
The poll runs only where answers can come from another device, the remote commands'
condition (`remoteCommandsEnabled`: shared state, services running); a daemon on a local
`sqlite:` store has no poll, its own answer route being the only answer path. The poll skips
while the schema sync gate is paused and stops with `close()`.

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

**Sandboxed browser and agent email (`@forerunner/capabilities` `browser` and `email`, spec
L.2, L.3, S.15 to S.31; ADR 0013, ADR 0014, [ADR 0047](../decisions/0047-daemon-wiring-of-browser-email-and-injection-notifications.md);
`browser.md` and `email.md` have the modules and their "How it is wired" sections).**
`composeRuntime` builds one `BrowserSessionManager` with `browserBindingResolver`
(`src/wiring/browser-ports.ts`: the run token's domains from `TokenIssuer.claimsForRun` (the
run's newest live token; a same-millisecond re-issue wins by issue order, `test/token.test.ts`)
as the allow list, the project's `settings.browser.blockedDomains` on top, the project's autonomy
level, the token id) and the eight `browser_*` tools in the mode `browserModeFor` decides at
compose (`ComposeOptions.browser.mode`, else `FORERUNNER_BROWSER_MODE`, else Chromium when
`resolveChromiumExecutable` finds one, else the static reader `staticBrowserTools`: the same
specs, navigate as an HTTP fetch through the same `SitePolicy` and hop cap, read through
`extractFromHtml`, the rest `not_supported`); `agentEmailPorts` (`src/wiring/email-ports.ts`)
builds the email capability's ports once (settings row, identity, sent log, approvals, policy,
the mailbox opened by reference from the vault on first use) for the four `email_*` tools and
the notifier's email channel alike. Neither set is in the built-in `ToolRegistry`: a
presence switch per capability (`CapabilityPresence`) decides whether `toolsForRun()` and the
session grant carry them, read at compose, at every session start (`startSession` calls
`rt.capabilities.refresh()` before the runner starts), on every extension event of the
`browser` row, and on demand: the browser's is the `browser` capability row installed and
enabled (added from the catalog, approved in the inbox, as desktop control), the email's is a
mailbox in the agent's settings row and a mode other than `off`. So the tools are absent, not
failing, when a capability is off or unconfigured, while a run in flight is covered per call:
the extension gate refuses the browser tools of a row toggled off, the registry revokes the
run tokens carrying them and the manager revokes its sessions (`extensions.onEvent`); the
email policy reads the mode on every call. The hooks apply as to any tool: `browser_navigate`
and `browser_download` carry `domainFields`, so a URL outside the run token is
`domain_not_allowed` before any request leaves; `email_send` is `external_send` and waits for
the human below autonomy 4; `browser_read`, `email_list` and `email_read` return untrusted
output that is wrapped and scanned. The project's site allowlist is
`settings.browser.allowedDomains` (`browserSettingsOf`): it joins the session grant's domains,
and because `derive` only narrows, `specialistSpecFrom`'s `extraDomains` hook adds the union
of every project's allowlist to a registry entry that names a browser tool (no other entry;
`allowed_domains: []` still means no network for a coder's sandbox), which the derived run
token caps to the session's project. A registry entry naming a capability tool while the
capability is off gets a `registry.tool_unmapped` row (`unavailable`) at compose like any
unregistered name (ADR 0043) and the tool once it is on; the registry's researcher names
`cc:WebFetch`, which has no loop equivalent, so it browses on the Agent SDK driver only. The
catalog entries `browser` and `email` (`src/extensions/catalog.json`) name the real tools and
classes (`read`, `routine_reversible`, `credential`; `read`, `routine_reversible`,
`external_send`). `RuntimeApp.capabilities` exposes the browser mode, manager and presence,
the email ports and presence, the allowlists in force and `refresh()`; `close()` closes the
browser sessions.

**Prompt injection reported (spec S.2, S.25; ADR 0047).** Every `injection_flagged` run event
(the hooks' `afterToolCall` scanned an untrusted tool result and wrapped it as data; both
drivers emit it through the executor's `onEvent`, which `makeLoop` puts on the runtime bus as
`run`) is, once per run and tool (`flaggedByTask`, cleared at `run_end`; a retry is a new run),
one audit row `injection.flagged` (`INJECTION_FLAGGED_AUDIT`, `allowed: true`: the content was
ignored, nothing was refused; the session, run, agent, human, the tool and source in
`input_summary`, the passage count, rules and score in `result_summary`) and one urgent
notification through `notifications.injectionFlagged` with the run's session and project.
The producer's body (`summarizeInjection`) names the origin, the source, the number of
passages and the rules with their counts, never the passages: they are in the tool call's own
audit row and the session log the notification links to. Failures to notify are logged, never
fail the run.

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
permission 403); the body is `{ error, code, details }` with secrets redacted. Numbers in list
queries (`?limit=`, `?afterSeq=`) go through one validator, `intQuery`, as the state service's
`intParam` does: anything but a non-negative integer is a 400 (`validation`, `reason:
"bad_query"`) before any store call, never a NaN that fails in SQL and comes back as a 500
carrying the driver's text. On a shared state the daemon acts as its own human only (ADR 0041
item 4, the way the state service forces a device's own human): `GET /inbox?humanId=` naming
another human, `POST /requests/:id/answer` on a request whose `human_id` is another human's,
and `POST /messages/:id/read` on a message whose addressee (its human, or the owner of the
agent it names; an agent the store cannot resolve is nobody's) is not the daemon's human all
answer 403 `{ code: "forbidden" }` and change nothing (`security-daemon.test.ts`).

Beyond the route table of ADR 0011 the daemon serves `GET /projects/:id/peers` (the peer feed,
`PeerFeedView`), `GET /projects/:id/decisions` (the decision log, `DecisionView[]`), the core
loop's data (below: the Reviews tab, the memory views, the commands and the change log), and
follows the UI conventions of ADR 0025: CORS for local and Tauri origins only (`isLocalOrigin`;
the opaque origin `null` of sandboxed iframes and `file://` pages is not one, CWE-942), the bearer
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
same way (see "Notifications" and "Cloudflare deploys" above), as is the audit log export
(`GET /audit/export`, next paragraph). Each sub-app keeps its module's error mapping.

**Audit log export (`src/daemon/audit-export.ts`, spec S.9, [ADR 0050](../decisions/0050-audit-log-export.md)).**
`createAuditRoutes({ store, clock, humanId })` serves
`GET /audit/export?agentId=&sessionId=&from=&to=&format=jsonl|csv` behind the bearer check (the
SSE `?token=` exception does not cover it): the query is parsed first (`parseAuditExportQuery`:
ids up to 200 characters, `from` and `to` ISO-8601 and `from <= to`, `format` an enum, blank
values absent; 400 `validation`), then the scope (`auditScopeFor`: the daemon's human, their
agents from `store.agent.forOwner`, install-level rows included; a requested `agentId` that is
not theirs is 404 `not_found` whether it is another human's or nobody's), then the headers
(`Content-Type` `application/x-ndjson` or `text/csv`, `Content-Disposition: attachment;
filename="forerunner-audit-<UTC stamp>.<format>"` from the clock, exposed through CORS so the
UI reads it cross-origin, `Cache-Control: no-store`) and the body as a chunked stream
(`hono/streaming`): `auditExportPages` reads `store.auditLog.list` with `limit:
AUDIT_EXPORT_PAGE_SIZE` (500) and a growing offset in the repository's `occurred_at, id` order
until a short page, `rowInScope` keeps a page's rows that name the human or one of their
agents (or nobody, on the install), and `writeAuditExport` serialises each page before the
next is read, so memory is bounded by one page whatever the log's size. A record is `id,
occurredAt, agentId, humanId, sessionId, runId, tokenId, tool, allowed, deniedReason,
costUsdMicro, inputSummary, resultSummary, recordedAt` (`AUDIT_EXPORT_COLUMNS`): the summaries
exactly as the hooks stored them (redacted and capped at write time; the export adds nothing
about the raw parameters), `recordedAt` the row's `created_at`. CSV is RFC 4180 (CRLF, header
first, quotes doubled) and `csvCell` prefixes a cell that starts with `=`, `+`, `-`, `@`, tab
or CR with an apostrophe before quoting (CSV injection: the summaries carry text from pages and
emails). A failure after the headers went out is logged and truncates the body. The state
service (`services/state-api/src/routes/audit.ts`) and `fr audit export` call the same
functions (`state-service.md`, Routes; "Command line and setup" above); the UI's button is in
`apps.md`.

**Voice (`src/voice/`, spec O, Q.4, Q.5; ADR 0012, [ADR 0048](../decisions/0048-voice-bridge-in-the-daemon.md);
`voice.md` has the loop and "How the shell reaches it").** `composeRuntime` builds one
`VoiceSessions` (`RuntimeApp.voice`) over the conversation agent, the command registry and a
`VoiceProviderRegistry`: in production `buildVoiceRegistry` registers the local helpers
(`faster-whisper`, `kokoro`, `piper` when `FORERUNNER_PIPER_MODEL` is set) and the cloud
providers by secret reference (`deepgram`, `cartesia`, `elevenlabs` behind
`secret:deepgram_api_key`, `secret:cartesia_api_key`, `secret:elevenlabs_api_key`; voice ids
from `FORERUNNER_CARTESIA_VOICE` / `FORERUNNER_ELEVENLABS_VOICE`), probes nothing at compose and
registers no fake; `ComposeOptions.voice` injects the fake providers (`stt`, `tts`), a whole
`registry`, a `sink`, `storeAudio`, latency `targets` and `maxSessions` (tests). A session
start selects the pair with the package's policy (local if available, else cloud with a key,
with `FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS` as the preferred names; `hasSecret` asks
the vault whether the reference has a value, never the value) and opens a `VoiceBridge`: the
real `VoiceLoop` with the bridge as its one `converse` port over `ConversationAgent.chat`
(`source: "voice"`), the spoken approval rules (`expectYes`) in front of a pending card, and
`TextTurnStt` so a typed line runs as a push-to-talk turn without audio through the same
loop, rules, TTS and rows. With a card pending the bridge answers the line itself, never the
agent: a refused line (a question, a qualifier, a deferral, a hesitation) repeats the
read-back; a yes is carried out through `CommandLoop.confirm(id, { kind: "yes", source:
"voice" })` and a plain "no" (the registry's own `confirmByText` reading: no, nope, cancel,
stop, nein, non, abbrechen) through `cancel`, exactly as a tap is, so the registry's outcome
(status, sentence, change log id, undo token) is spoken (`spokenOutcome`, the agent's
wording) and recorded. The registry's pending list (`CommandLoop.pending(humanId)`) is the
one source of truth for what still waits: the bridge's copy follows it at every answer (a
card tapped in the UI, answered by email or expired is refused with the reason and
forgotten; a line that is no answer to a gone card is a plain line), and the conversation
agent's per-human copy, which any typed line drops, is never consulted. For a line it
answered itself the bridge writes the `chat.human`, `chat.confirmed` / `chat.cancelled` and
`chat.reply` rows the agent would have written, so the transcript reads the same. Playback goes to `pacedSink` on the
clock; the shell plays the `audio` frames. Routes (`server.ts`, all in `DAEMON_ROUTES`):
`GET /voice/status` (`VoiceStatusView`: the picked providers and the reason, or
`available: false` with the reason: no helper and no key, or no model credential),
`POST /voice/sessions` (201 `VoiceSessionView`; 503 `unavailable` with the reason; at most
4 open sessions), `GET /voice/sessions/:id`, `POST /voice/sessions/:id/stop` (immediate),
`POST /voice/sessions/:id/press { pressed }`, `POST /voice/sessions/:id/audio` (JSON base64
PCM or `application/octet-stream` with the format in the query; `sampleRate` 8000..192000
and 1..8 channels, else `validation`, since the loop resamples to 16 kHz),
`POST /voice/sessions/:id/text { text }` (`VoiceTurnView` once the turn ended, with the
registry's `outcome` when the line answered a card; 409 while a capture is open),
`POST /voice/sessions/:id/answer { answer: tap|no }` (a tap confirms the card through
`CommandLoop.confirm` as a tap, "no" cancels; the registry's `status` and `reason` on the
decision; 404 without a card) and `GET /voice/sessions/:id/events` (JSON after `afterSeq`,
`validation` when it is not a non-negative number, or SSE `voice.event` frames with `?token=`
like the other EventSource routes: the loop's events, `voice.first_audio`, `voice.readback`
= approval needed, `voice.approval` (with `status`), `voice.answer` (the registry's result of
a spoken, tapped or cancelled answer), `voice.turn` = done, `voice.stopped`; audio frames
live only, 1000 other frames kept per session for a resume). Recorded: on the conversation
session `voice.turn` (source, said, heard, chunks, audio stored, pending card id, the
outcome's status, the latency stages) and `voice.approval` (the exact line, approved,
`blockedBy`, method, card, commands, the registry's `status` and `reason`) next to the
`chat.*` rows; in `audit_log` `voice.session` (start with mode, language and provider names;
stop) and `voice.approval` per decision (`allowed` only when the registry carried the answer
out; `denied_reason` otherwise). No audio and nothing played is in the audit log; audio is
written only with `FORERUNNER_VOICE_STORE_AUDIO=1` under `<data>/voice/<session>`. A stopped
session still answers `GET` and a late stream, then `VoiceSessions` drops it: at most
`keepStopped` (8) stopped sessions and none older than `retainStoppedMs` (10 min), swept on
every access with no timer (`ComposeOptions.voice.keepStopped` / `retainStoppedMs`).
`close()` stops every open session. The shells' hook-up is a later item (`voice.md`); `tests/e2e/src/scenario-voice.ts`
keeps its own bridge until scenario 3 is pointed at this one.

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
change card and one change log row; `source` is `text`, `voice`, `phone` or `ui`
(`CommandSourceBody`), the settings screen sends `ui` and the row is logged with it;
`confirm: "tap"` is the settings-screen path after the card was shown), `GET /commands/pending`, `POST /commands/:id/confirm` (`yes`, `no`, `tap`, or
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
| `RemoteCommandWatcher` | polls `store.remoteCommand.pickUp("pc", { deviceId, agentId })` every `FORERUNNER_REMOTE_POLL_MS` (default 500 ms; the daemon reads the shared Postgres directly, ADR 0024, so no service client is involved): the store hands over only rows whose issuing device belongs to the human who owns this agent (first line); `authorize` loads the issuing device and refuses an unknown, revoked or foreign one (`failed`, `forbidden: ...`, audit row) without acting (second line). Then: a `kind: "plan"` envelope runs through `CommandLoop.compose` as the PC (source `phone`, the daemon's desktop row as the context device, so the registry's session commands call the ports instead of enqueueing another remote command); low risk acts, the phone's tap (`confirmedAt`, counted by `isFreshTap` only within the card's own life, `DEFAULT_TAP_MAX_AGE_MS` = 10 min, plus 2 min of clock skew; a tap the outbox replayed from long ago leaves the card `needs_yes` for the inbox) answers a medium card, a high-risk card stays a `human_request` (`needs_device`) and the row completes with `status: "pending"` and the `pendingId`; a `kind: "chat"` envelope is one `ConversationAgent.chat` turn (`failed`, `provider_auth` without a model credential); plain `kill` (stop everything and freeze), `stop` (the agent's runs, freeze lifted), `start` (freeze lifted, `Scheduler.requestStart` with `trigger: "remote"`; the row's result is `{ kind: "start", result, startId }`, the scheduler entry's id being the start's identity the undo of the registry's remote `session.start` row acts on, ADR 0049), `pause` (the registry's `session.pause`, whose daemon ports in `src/wiring/session-ports.ts` make it the graceful stop: the row reads `paused` at once and, for a session registered with the kill switch in this process, the agent gets a `pause: <reason> (session <id>)` message that the runner reads between tasks, so the task in flight finishes, no new one starts and the runner closes the session with its handoff, `paused -> stopped`, `stop_reason: stopped_by_message`, the remaining tasks in `handoff.next`; a session running elsewhere gets the status only; the undo, `resumeSession`, withdraws the unread message and puts a `paused` row back to `running`, and a closed session stays closed), and the registry's own `session.*` rows; a start or scope naming another agent is refused. `syncAnswered` (every drain) applies inbox answers to the cards still pending in the executor: an approval confirms a `needs_yes` card as a tap and a `needs_device` card as a device confirmation naming the daemon's desktop row with `biometric: false` (the state service enforced the signature and `confirm:high` on the phone's answer; the daemon's route is the human at the PC), a rejection cancels, another human's answer is ignored; an approval the executor refuses (this daemon's desktop row revoked, the risk rose since the card was shown) is not counted as applied: it is warned once, audited (`allowed: false`, input `kind: "card"` with the pending id, the decision and the command names) and the dead card is cancelled so no drain repeats it (`stats.refusedCards`), while a `version_conflict` (another answer in flight) is simply retried on the next drain. Every row ends `done` or `failed` with a result the phone reads back plus one `audit_log` row `daemon.remote_command` naming the command, the device, the envelope's `clientId` and the plan's command names, never the parameters. One tap acts once: the state service already enqueues a device's envelope once per `clientId` (`state-service.md`, "Once per tap"), and as the second line `replayOf` refuses an envelope (plan or chat) whose (issuing device, `clientId`) this daemon handled before, found in this process's memory (`SEEN_MAX` pairs) or in an audit row of the last `duplicateWindowMs` (`DEFAULT_DUPLICATE_WINDOW_MS`, 30 days, longer than the service's seven-day record; the audit input of every handled envelope names its `clientId`, which is what the lookup reads): the row ends `failed` with `status: "duplicate"`, `code: "duplicate"`, the first row's id as `duplicateOf` and its own audit row, before anything is composed, so a copy that slipped past the service (two service instances, a restored backup, a row older than the service's week) never starts a second session or raises a budget twice (`stats.duplicates`). The lookup is per row, not a lock: two daemons of one human taking two copies at the same instant could both act (Known issues). A kill reaches the kill switch within one poll, so a session stops within 2 s of the tap. | the command registry's policy (ADR 0030), the kill switch, the scheduler; `RemoteCommandRepo.pickUp`'s owner filter in `packages/state` (`ownerHumanId` / `agentId`: a subquery on `device.owner_human_id`, through `agent` for the agent, both dialects) |

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

`shared-secret-resolver.test.ts` (spec S.13, ADR 0065; two installs on one store, each with
its own `MemoryVault` and wrapping key): the proposal wraps per named agent install, files the
pending grant and Bob's high-risk card with the `shared_secret_grant` change card, serves
nothing while pending and refuses an unknown agent, an agent without a keyed install, a
missing name and no agents; after Bob's yes Bobby's install resolves `secret:<name>` through
`beforeToolCall` (the tool gets the value, the model-facing input keeps the reference,
`afterToolCall` redacts the output, the hooks' audit rows carry the reference only, the local
vault holds only the install key, `secret.blob_served` names the agent and the install); local
first (the service is never asked); another agent, another install, a blob bound to another
device (`integrity`) and a token without the name are refused before any value moves; a
refusal cancels and drops the blobs, a revoke ends an active grant and the resolver fails
from then on, a pending grant's cards are withdrawn; every store table scanned for the value
in every encoding. `shared-secret-wiring.test.ts`: `composeRuntime` creates the install key
and registers it on the desktop row (reused on re-registration), the daemon's
`/secrets/shared` routes propose, list and revoke (400 on a bad body, 404 on an unknown
grant), the peer's approval through `applySharedGrantAnswer` lets the peer install resolve,
the active names join the session grant per agent, and the other way round: a grant Bob
proposes to Alice is answered through the daemon's own `POST /requests/:id/answer` (the grant
moves in the same write) and resolving through this install's vault writes
`secret.shared_resolved` without the value.

`small-project.test.ts` (spec B.6, ADR 0051): `defaultRiskTier` by flag; `shapeProjectPlan`
with the flag on (one milestone named after the project, the phases' criteria once each, the
latest date, every task under it in plan order, tier 0 unless named; a single planned milestone
kept as it is; a plan of loose tasks only) and off (a milestone per phase, loose tasks
unassigned, tier 1 unless named); `applyProjectPlan` on an in-memory store (one milestone row
and a flat list with dependencies resolved to ids and the reason and author on every row; a
second plan joining the open milestone; phases after existing milestones with the loose task
under none; dependants after dependencies whatever the plan order and a dependency on an
existing task; an unknown dependency, a cycle, another project's task, an empty plan and a
duplicate key refused with nothing written; the task cap); through `composeRuntime` and the
daemon: the card's `smallProjectMode` and `defaultRiskTier`, `POST /projects/:id/tasks`
without a tier (0 under the flag, 1 without, a named tier kept, an out-of-range tier refused),
`POST /projects/:id/plan` for a small and a phased project, the second plan reusing the
milestone, refusals as 409 `conflict` with nothing written and 404 for an unknown project.

`security-daemon.test.ts` and `security-command-actor.test.ts` (security review 2026-10-20,
ADR 0011, 0025, 0030, 0041): every route but `/health` needs the exact bearer (a prefix, a
suffix, a query token or a Basic header is 401; the query token only on the SSE GETs),
`daemon.json` is 0600 under the runtime dir and removed on stop, a foreign origin and the
opaque origin `null` get no CORS headers, the kill switch and its resume are audited as the
daemon's human, another human's request, message receipt and inbox are refused 403 and left
untouched, a malformed `?limit=` is a 400; on the model path every command tool is gated by
the registry with the command's static risk and class, the change log row of a command the
model calls names the agent (`author_agent`) and no human, a model-initiated `autonomy_set`
asks even when its risk would be low, and the human, project and device come from the turn,
never from keys in the model's input.

`closeout-security.test.ts` (requirements close-out 2026-10-20, spec S.5 and S.8, through
`composeRuntime` and the daemon routes on an in-memory store): a capability added from the
catalog carries its declared scopes in the review on the inbox card and, after the human's
yes, in the row `GET /extensions` and `GET /extensions/:id` serve to the panel, nothing wider
(S.5); `POST /kill` with `scope: { agentId }` stops that agent's registered runs, revokes its
run tokens, releases its task claims back to `ready`, freezes new registrations in its scope
and leaves the other agent's run, token and claim untouched; `scope: "all"` releases every
agent's claims; `/kill/resume` lifts the freeze and a revoked token stays revoked (S.8).

`closeout-claims.test.ts` (requirements close-out 2026-10-20, spec U.18, the session runner as
the claim holder on an in-memory store under the simulated clock): a session started without
`claimTtlMs` claims its task with the expiry 30 minutes out; the claim is renewed every five
minutes while the task runs, each renewal moving the expiry 30 minutes from then, and the peer's
claim is refused with the holder meanwhile; once the holder's renewals fail (its machine gone)
the claim holds for the rest of its 30 minutes and no longer: `expireClaims` returns the task to
`ready` with the reason `claim expired`, the peer's claim succeeds, and the lapsed holder's late
return cannot take the task back from the new holder.

`audit-export.test.ts` (spec S.9, ADR 0050): `csvCell` quoting and the formula guard, the record
shape and column order, the file name from the clock, the query (defaults, normalised window,
blank values dropped, bad format / timestamp / inverted window / over-long id refused as
`validation`), `auditExportPages` (limit and offset until a short page, no empty page yielded,
the default page size), `rowInScope` and `writeAuditExport` across pages with the count; the
sub-app over a sqlite store with two humans (JSON lines in time order with the download
headers, CSV with the header and the guard, filters by agent / session / window with `to`
exclusive, another human's agent and an unknown one 404, the same store seen as the other
human, 400s before anything streams, `list` called in pages of the configured size,
`auditScopeFor`); and mounted on the composed daemon (in `DAEMON_ROUTES`, 401 without the token,
with a wrong one and with `?token=`, `Access-Control-Expose-Headers` carries
`Content-Disposition`, only the install's rows, a foreign agent 404, CSV by session).
`audit-cli.test.ts`: `fr audit export` registered with its flags, JSON lines with the count line
and `startServices: false`, CSV with the header and the filters, the default file name from the
clock, a foreign agent `not_found`, a bad flag refused before anything is composed, an existing
file refused without `--force` and overwritten with it.

`security-hooks.test.ts`, `security-sdk.test.ts`, `security-tokens.test.ts` (security review
2026-10-20, spec S.1, S.3, S.4, S.6, S.9; every finding was fixed in the same change): every
traversal form, look-alike prefix and drive letter against the path roots; a committed symlink
out of the worktree refused for `read_file` and `write_file` through the hooks; IP literals in
every spelling, user-info, fragments and schemes against the domain allowlist; an approval for
one input not admitting a colliding input, the durable key collision resistant, an always-human
approval consumed by its first use; secrets by reference through a real resolver with the
output scrubbed in every encoding and a resolved value pasted into a later input kept out of
the audit log; one audit row per refusal, a revoked token's included; a NaN cost refused by the
budget with the cap still in force; a malformed kill request failing closed; on the SDK path
the parent's credentials never reaching the subprocess (by name and by URL user-info), a
traversing Glob/Grep pattern refused, the audit row of an MCP tool carrying the reference and
not the value, MCP output fed back redacted, a final report quoting the environment redacted;
token forging claim by claim, expiry (an unparseable one refused), revocation by the kill
switch and `derive` never widening.

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
`context.headroom_unavailable` event; `views.test.ts`: cost view savings money), Anthropic adapter mapping, SDK driver options and hooks, sessions (checklist and brief size, planning, claims, collisions, budget stop, kill, advisor mode, concurrency, scheduler; the next-session queue consumed per brief in `runner-queue.test.ts` and `checklist-queue.test.ts`), executor (brief, derived token, Run row; a fractional first-token time and duration stored as integers on the real store; a refused Run row write as a `run.persist_failed` audit row and a log line that name the run and never the prompt; a thrown error's message redacted before the Run row's `error` artifact), receipts (acked by reading, acked by reply, resurfacing), decisions (ask once, record, supersede, approvals ignored), peers (hints, overlap rules, feed from the store, overlap message and skip through the runner), daemon (auth, projects and tasks with a 409 on a bad transition, chat and inbox, sessions, events and kill, costs, SSE with the restart event, `stop()` returning while `/events` is held open on a real socket), wiring (`wiring.test.ts`: extensions from catalog to a refused tool, model watch report and inbox decision, updates screen, mirror sync answering 202 then running on the inbox answer, estimates accuracy, sandboxed `run_command`, a refused lease closing the Run row, the eval runner keeping the model's command in the sandbox lease and offering only the specialist's tools, CLI registration and one-shot composition; `cc-tools-wiring.test.ts`: the composition on a registry copy whose coder names `cc:Read`, `cc:Edit`, `cc:Glob`, the executor's spec carrying `read_file`, `write_file`, `list_dir` with the registry untouched, one task through the `LoopTaskExecutor` with `read_file` and `write_file` allowed and `run_command` refused by the hooks, the audit rows of each, and a `cc:WebFetch` dropped at compose with one `registry.tool_unmapped` row per specialist and tool; `registry-tools.test.ts`: the table entry by entry, an unknown `cc:Foo` dropped with its reason and its audit row, the command gate, unavailable and bridged names, order and duplicates, the "sdk" and no-option branches keeping the names as written; `notifications-wiring.test.ts`: the notifier and its producers on the real sources through the daemon, the prefs routes and their audit row, the `notification` SSE frame, quiet hours through the route, the Telegram token never leaving the vault's reach, the email channel over the agent mailbox; `packages/capabilities/test/cloudflare-wiring.test.ts`: the Cloudflare tools and routes through the daemon's hooks, gate and bearer token; `model-config-wiring.test.ts`: `models.json` applied at compose to the chat rung, a session on the built-in rung and effort, the model watch proposing a switch and a lower effort on a fake eval runner, the human's adopt through the inbox swapping the tables so the next session runs the adopted rung at the adopted effort and the critic reviews on the adopted rung without a restart, a malformed file ignored with an audit row and its content kept out of the log; `packages/capabilities/test/desktop-wiring.test.ts`: the six desktop tools behind the daemon's hooks and gate, off until installed, the allowlist and status routes, an app outside the allowlist refused and put to the human, an allowlisted app run through the fake adapter with the indicator on the bus and as the `desktop.indicator` frame on `/events` (on with the app, off at `endRun`), a panel toggle revoking live; `desktop-wiring.test.ts` (runtime): the guarded allowlist file, a file that is not JSON or not an allowlist answering `validation` naming the file on the routes and on every tool call with a `desktop_allowlist.read` audit row and the parser's snippet kept out of the error, the audit log and the log, a fixed file read at the next call; `data-wiring.test.ts`: a folder import through the daemon route in the registry and the project's listing, the data tools behind the hooks, a zip-slip archive refused whole, a path outside the run's roots refused as a capability grant; `voice-route.test.ts`: the voice routes on the composed daemon with the voice package's fake providers and the fake model, every delay on the simulated clock: a text turn's events (first audio, done) and its `voice.turn` row with `chat.human` carrying `source: "voice"`, a risky command read back as `voice.readback` and filed as a pending card, "Yes, but what does it cost?" refused as a question with the card kept and the agent not called, "Yes, go ahead." carried out by the registry with no model call, the registry's sentence spoken, `status: "done"` on the decision and its `chat.human` / `chat.confirmed` / `chat.reply` rows, both `voice.approval` rows and audit rows with the exact lines and the status (`allowed` false for the question), the `voice.answer` frame of the spoken yes, a typed `/chat` line between the read-back and the spoken yes with the card still carried out through the registry (the agent's copy gone, the registry's not), a card tapped in the UI refused for the spoken yes with the reason, not run twice and forgotten by the voice session, a question after a card cancelled in the UI answered as plain chat, a tap confirmed through the registry, an audio turn pushed as 20 ms frames (JSON and octet-stream) with the release 20 ms after the last frame giving `endOfTurnMs` 20, `finalTranscriptMs` 300, every stage within target and the total the sum of the four, a chunk declared at 1, 7999 or 192001 Hz refused in both bodies, `afterSeq=abc` and `-1` refused, the SSE stream replaying the kept frames then carrying the live `audio` frames, stop and the audit rows without any transcript or PCM, two compositions where voice is unavailable (no provider; Deepgram with its key in the vault but no TTS) answering the reason on `/voice/status` and 503 on a start with the key never in the body, and stopped sessions dropped beyond `keepStopped` and after `retainStoppedMs` on the simulated clock; `capabilities-wiring.test.ts`: the browser and email tools absent until the `browser` capability is approved in the inbox and the agent's email settings name a mailbox with a mode other than off, gone again at mode off and after a panel toggle, the catalog entries naming the real tools, `settings.browser.allowedDomains` into the session grant and the registry entry's run token, one scout session through `POST /sessions` in static browser mode: the page inside the allowlist read with the reader's rows beside the hooks', the collector outside the token refused before any request with its `tool_denied` event, the mail read, the stranger emailed in full discretion through the policy, three flagged reads as two `injection.flagged` rows and two urgent notifications (one per run and tool) carrying the rules and never the passage (nor the toast argv, nor the log), a read-only mode refusing `email_send` in the policy with its `email.send` row), hooks (overspend, steps, wall clock, kill, allowlist, schema,
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
and a malformed envelope ending `failed`, a replayed envelope acting once (two rows with one
clientId: the first executed, the second `failed` as a duplicate naming the first and audited,
one change log row; a new watcher refusing a third copy from the audit rows; a new clientId
running; the month-long audit window pinned and a copy older than it running again in a new
process; a replayed chat envelope one model turn), a kill from the phone stopping a registered run within
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
H.2 and J.3 for the critic sign-off answered from the inbox (accept closes the task with the
findings up to the card's review resolved against the run, revise counts the attempt and
keeps the findings open, cancel cancels; applied once with an audit row, only for the task's
current sign-off (a stale one is skipped and recorded), found however many later answers
sit in front of it; the daemon's approvals poll brings an answer given on another device
to the PC within seconds), Q.1 and Q.11 for the undo of `session.start` (the undo acts on
the start the row names: a start whose session ended is a no-op refused with the reason and
the row irreversible even while a later start of the agent runs; a running start stopped as
that session only, never a cloud session of the agent; a queued start that ran stopped under
its own id), S.8 for the kill switch holding only what the human stopped (an undo never
freezes the agent; the next scheduled session runs). Tests: `test/signoff-answer.test.ts`,
`test/approvals-poll.test.ts`, `test/loop-commands.test.ts`,
`tests/e2e/scenarios/phase5-gate.integration.test.ts` (Tuesday's sign-off on the phone closing
the task, Thursday's undo of the phone's plan leaving the kill switch open).
C.4, S.1 and S.3 for specialist tools on the loop driver (the registry's `cc:` names mapped
to the built-ins the token carries, nothing widened, every dropped name an audit row, ADR
0043). Tests: `test/cc-tools-wiring.test.ts`, `test/registry-tools.test.ts`,
`services/cloud-runner/test/runner.test.ts` (the cloud runner's executor on `rt.specialists`).
I.1 (the plan share cap enforced before every call on a subscription run), I.5 (80% and 100%
of the plan share), S.14 (a subscription token never used for another human's agent; read by
reference, never logged), U.7 (the Run row's billing source per task), A.5 (the subscription
token's request text and format check on paste, the plan allowance as a setup input with a
default) and the phase 1 check's subscription half
(a task on the subscription through the Agent SDK driver with the OAuth token and the `cc:`
names, "subscription" ledger rows with the plan share, the API key at the cap and for another
human's agent, the kill switch on an SDK run, the hooks on the SDK path; ADR 0044). Test:
`test/subscription-path.test.ts`.
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
registry, the scheduler and the kill switch, a kill within 2 s; the phone only controls), R.3
(an envelope the phone's outbox replays acts once on the PC: the watcher's duplicate rule
behind the service's idempotent enqueue), Q.12
(the phone's plan with the same enforcement as the settings screen), Q.8 (a high-risk step
stays a card the phone confirms with its biometric through the state service), S.9 and S.14
(one audit row per command; only the human's own devices reach this PC, in the store and in
the watcher), D.3 (the project's ceiling caps the retry ladder). Tests:
`test/remote-watcher.test.ts`, `test/remote-pause.test.ts`, `test/remote-wiring.test.ts`,
`test/remote-presence.test.ts`, `test/executor-ceiling.test.ts`, `packages/state/test/suite.ts`
(the owner filter on both dialects).
Q.5, Q.7 and Q.8 for a command on the conversation's model path (one change card and one
answer per change: the registry confirms by risk, a yes for medium, the paired device for
high, and the hooks hold no command tool; `test/conversation.test.ts`, `test/hooks.test.ts`),
Q.11 and Q.12 for the settings screen's route (`source: "ui"` on the change log row, the same
executor and policy as chat and voice; `test/loop-routes.test.ts`, `apps/ui/test/settings.test.tsx`,
`tests/e2e/scenarios/phase5-gate.integration.test.ts`).
O.1, O.3, O.5, O.7, O.9, O.10 and Q.4, Q.5 for voice through the daemon (a text or audio turn
through the one loop with every latency stage measured; a risky command read back and waiting
for the yes, a wrong answer doing nothing, a yes or a tap applied through the registry with
the words logged; stop at once; transcripts in session history and no audio stored; voice
unavailable with the reason when no provider is configured; ADR 0048). Test:
`test/voice-route.test.ts`.
L.2 and L.3 in the daemon (the browser tools and the email tools offered to a run only while
the capability is on, behind the hooks and the gate; the project's site allowlist in the
session grant and the run token; the static reader where no Chromium exists), S.2 and S.25
(every flagged read one audit row and one urgent notification to the human, the passages
never in the notification), S.3 (the run token binds the browser's policy), S.6 and K.6
(nothing offered until a human approves the capability; revoked live), S.9 (the reader's and
the policy's rows beside the hooks'), S.16, S.17, S.20, S.26 and S.27 (the modes, the sent log
and the signature through the daemon's tools). Test: `test/capabilities-wiring.test.ts`
(ADR 0047).

## Known issues

- A level 0 or 1 session that files its plan ends `paused`, which `session.active()` counts as
  active, so the agent cannot start again until a human closes it; the `plan:<session>` approval
  starts nothing on the desktop daemon (BLOCKERS.md, the J.6 / J.7 row).
- The task workflow has no `needs_human -> done` edge, so an accepted critic sign-off closes
  the task along the graph's own edges (`ready -> claimed -> in_progress -> in_review -> done`)
  in one store transaction (`syncSignoffAnswers`); a direct edge for a human's acceptance is a
  `packages/state` change (`workflow.ts`, the generated data-model doc) and would make the
  walk one transition (ADR 0049). The registry's `session.start` records no session id in
  its change log row (the scheduler starts the runner in the background) but the start's
  id, so "the session that start began" is the scheduler's active start with that id and
  its session row; an undo that lands in the instant between the scheduler's start and the
  runner's insert of the row stops nothing (a warning, `session-ports`) and the row is
  marked undone. A daemon restart forgets the scheduler's entries, so the undo of a start
  made before it is the no-op (`ended`), including one whose session the restarted daemon
  does not run anyway. `sessionCommandPorts` takes the install's runner kind (`runner`,
  default `pc`); `composeRuntime` passes none, so a cloud runner composing the daemon's
  command loop would match `pc` rows. A sign-off request left open when the human moves
  the task on from the UI stays open in the inbox until answered; its answer is then skipped
  as `stale` (nothing withdraws it when the next review files a new one).
- Commands: `POST /changes/:id/undo` takes no body, so its turn is `text` and an undo made
  from the Changes screen is logged with source `chat` while the settings screen's own
  changes are `ui` (RT-P5-4 closed the execute and parse routes only); a `source` on the undo
  route and the UI client's `undoChange` would close it. The command tools' `gate:
  "registry"` is set by `CommandLoop.tools`, not by `toToolSpecs` in `@forerunner/commands`,
  so a caller that builds command tools from the registry without the loop gets tools the
  hooks hold as before.
- Voice (ADR 0048): a spoken yes, a spoken "no", a tap or a "no" through the voice session
  answers the card in the registry (the one source of truth) and the bridge's copy follows
  the registry, but the conversation agent keeps its own per-human copy of the card until its
  next typed line: a bare "yes" typed into `/chat` right after a voice answer reaches
  `confirmByText` on a card that is no longer pending and is reported as "Not done" (nothing
  runs twice). The fix is a `pendingFor(humanId)` / `dropPending(humanId)` on
  `ConversationAgent` (`src/conversation`, another item). The other direction is handled: a
  typed line that drops the agent's copy while the voice session still shows the card does
  not lose it, the spoken yes goes to the registry (`test/voice-route.test.ts`). The
  Extensions panel's `voice-*` entries do not feed the preferred provider yet
  (`FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS` do), the shells do not call the `/voice`
  routes yet, and `@forerunner/voice` is reached by relative path from `src/voice/pkg.ts`
  because the dependency is not declared in `package.json`.
- The SDK driver's live behaviour is only verified when a credential is present (see
  `gates.md`); without one the integration test skips with a visible reason. The subscription
  path (ADR 0044) is covered on a fake `query`; a real `claude setup-token` token through the
  Agent SDK is the live harness's case and BLOCKERS.md's row. On the SDK path `cc:Bash` is
  withheld unless `FORERUNNER_SDK_HOST_COMMANDS=1`, so a subscription coder cannot run tests
  until the subprocess can be pointed into a sandbox lease; the plan share is an estimate (the
  month's subscription rows at list price over the allowance: the default USD 50 unless `fr
  setup --plan-usd-monthly` or `FORERUNNER_PLAN_USD_MONTHLY` set it), never the provider's own
  figure until a probe reports one, so it can stop subscription work before the real plan
  would, and the live harness checks the plan level with a real token (BLOCKERS.md, the
  subscription row); the cloud runner's executor passes no billing port and stays on the loop
  driver.
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
- Path containment (`pathInsideRoot`) resolves the symlinks of the part of a path that exists
  and refuses a link it cannot resolve; the built-in file tools' own second check
  (`src/daemon/tools.ts`, `inside()`) is still lexical, which is safe because the hooks run
  first on every call, but it should adopt `realPathOf` so the tools fail closed on their own
  too. A link created between the check and the read (a race inside the worktree) is not
  covered; the sandbox adapter mounts only the worktree so such an escape cannot reach the host.
- An approval of an always-human action is consumed per run (`ctx.approvals`), but
  `StateApprovals` answers from the durable row: an identical call in a later run of the same
  session finds the answered request and is approved without a new question. Consuming the row
  needs a `HumanRequestRepo` write (`packages/state`), not a runtime change.
- On the SDK path a built-in file tool's output (`Read`, `Grep`) is scanned and flagged but
  cannot be rewritten from the `PostToolUse` hook (the SDK applies `updatedMCPToolOutput` to
  MCP tools), so the subprocess sees the file as is. `scrubEnv` withholds `SSH_AUTH_SOCK` from
  the subprocess and the process sandbox, so a sandboxed command that needs git over SSH fails
  until a secret reference carries the credential.
- Notifications: the email channel is resolved once at compose from the agent's email settings
  row (`notificationEmailPort` answers null without a mailbox), so a mailbox configured while
  the daemon runs reaches the channel at the next start (the `email_*` tools pick it up at the
  next session start, ADR 0047); the `peerMessage` and `emailCommandReceived` producers have no
  daemon source yet (ADR 0038 point 2; `injectionFlagged` has one since ADR 0047); held and
  digest queues are in memory (ADR 0017 point 8); the `update_applied` notification is sent
  while the process is exiting, so a slow channel may not finish before the restart.
- Browser and email (ADR 0047): the browser mode is decided at compose, so a Chromium that
  exists but fails to launch is not demoted to the static reader at run time (the navigation
  fails with the launch error, audited); the daemon mounts no email settings routes, so the
  mode and the mailbox are changed through the capability's routes elsewhere, the CLI or the
  store; the critic and the conversation agent run the driver outside the executor and raise
  no `run` bus event, so a flagged read there is logged by the hooks but not notified; the
  per-agent browser block list is not read (the project's is); scenario 6 still wires its own
  research install instead of `composeRuntime` (`testing.md`).
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
  (the watcher is covered against the store, which is what the service writes); the replay
  rule reads audit rows per row rather than taking a lock, so two daemons of one human that
  pick up two copies of one envelope in the same instant could both act (a unique index on
  the issuing device and the envelope's `clientId` in `packages/state` would close it), and
  an audit row the store failed to write leaves only this process's memory of the pair.
- Shared secrets (spec S.13): the cloud runner registers no wrapping key on its `runner`
  device row yet (its vault is locked until the unlock protocol ran), so a shared secret
  reaches an agent on its owner's PC install; the app has no screen for `rt.sharedSecrets`
  (the daemon routes exist), and the owner's `propose` is not yet a registry command with a
  change card.
