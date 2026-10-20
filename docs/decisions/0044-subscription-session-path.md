# 0044 — The subscription session path: per-task billing source, the driver that follows it, what a subscription run records

Date: 2026-10-20
Status: accepted

## Context

The spec's phase 1 check reads "the same session runs once on a subscription and once on an
API key with correct usage recorded", its billing section says "prefer subscription, fall back
to API when the plan limit is hit or the work runs on the cloud runner", and its security
section says a subscription token "belongs to one person and is never granted to the other
person's agent". ADR 0004 put subscription billing on the Agent SDK driver (`SdkAgentDriver`,
`CLAUDE_CODE_OAUTH_TOKEN` in the subprocess environment); ADR 0043 made the registry name
Claude Code tools and each driver map them, and left the SDK branch as a seam ("compose sets
`specialistDriver` to 'sdk' for it and nothing else changes").

Until this ADR the daemon built one billing source (a subscription row when the vault held
the OAuth token, else an API-key row, else a fake one), never called `BillingRouter.pick`,
and ran every task through the in-process `LoopAgentDriver` on the Messages provider. A vault
with both credentials registered only the subscription, and the subscription's token went to
the Messages API as a bearer token rather than to the Agent SDK. The spec leaves open where the
per-task choice is made, how the driver follows it, how a subscription run is accounted when
the provider reports no plan usage, and what the SDK subprocess may do outside a sandbox.

## Decision

1. **Both sources exist when both credentials exist.** `seedBillingSources`
   (`packages/runtime/src/wiring/billing-pick.ts`) runs at every compose: a `subscription`
   row (`credential_ref: anthropic_subscription_token`, priority 1, `limits.planShareCap`
   0.95, `limits.planUsdMicro` the plan allowance of item 8) when the vault has the OAuth
   token, an `api_key` row (`credential_ref: anthropic_api_key`, priority 2) when it has the
   key, each once (a row whose `credential_ref` names the secret is kept, enabled or not), and
   a `fake` row only when nothing else exists. A credential added by `fr setup` after the
   first start is seeded at the next compose. **The fake row never serves beside a real
   source**: once a real source is enabled, an earlier `fake` row is disabled at compose, and
   `RouterTaskBilling` withholds a `fake` candidate (skipped `unavailable`) whenever a non-fake
   source exists, so a subscription at its cap and an API key at its monthly limit end in "no
   billing source available" rather than real work on the Messages provider booked to a row
   that is no credential.
2. **The pick is per task and lives in the executor.** `LoopTaskExecutor` takes a
   `TaskBillingPort` (`src/session/billing.ts`); the daemon's implementation,
   `RouterTaskBilling`, calls `BillingRouter.pick` once per task with the session's runner
   (`pc` for the daemon), purpose `session`, the run's starting tier, and this install's policy
   (`pcRoutingPolicy`: the package default; a personal runner, the PC by default, may use a
   subscription off the PC). Two inputs are decided before the router runs: the agent's owner
   (the agent row, else the token's owner claim) against the daemon's human, where a
   subscription is withheld for another human's agent and reported as skipped `other_human`
   (the router's own invariant, applied one step earlier so the API key can still serve that
   agent); and the plan share, read by `VaultLedgerProbe` from the month's ledger rows of the
   source (`MAX(plan_usage_share)`, else the month's "subscription" spend over
   `limits.planUsdMicro`), so a plan at or above the cap skips the subscription (`plan_share`)
   and the API key is picked. The pick is written on the Run row (`billing_source_id`) and as
   an audit row `billing.pick` (`BILLING_PICK_AUDIT_TOOL`: the task, run, agent, tier, source,
   kind and driver in `input_summary`; the router's reason with every skip in
   `result_summary`; `allowed: true`). Without a billing port (the cloud runner's executor)
   every run is billed to the executor's `billingSourceId` on the loop driver, as before.
3. **The driver follows the source.** A `subscription` pick runs through `SdkAgentDriver`
   with `credential: { kind: "oauth_token" }`; everything else runs through `LoopAgentDriver`
   on the Messages provider. There is one executor with two drivers behind one normalised
   result (`DriverOutcome`): the brief, the memory recall, the retry ladder, the derived token,
   the Run row (`running` before, patched after, `error` on a throw, `run.persist_failed` when
   the store refuses), the whole-millisecond timings, the critic afterwards and the lessons are
   the same code on both paths. The SDK Run row's `provider` is `anthropic-sdk`; its artifacts
   carry the SDK session id and the SDK's own list-price figure (`sdk_cost_usd_micro`) beside
   the ledger's per-call estimate. `RuntimeApp.specialists(name, driver?)` resolves the
   registry entry in the form of the driver the pick named: "sdk" keeps the `cc:` names as
   written, "loop" maps them (ADR 0043). This amends ADR 0043's consequence that compose would
   flip `specialistDriver` for the subscription path: the default stays "loop" and the per-task
   choice is the executor's. The session grant lists the `cc:` names next to the loop tools so
   a derived run token can carry them (a derived token only narrows).
4. **The credential is read at run time, by reference.** `credentialFor(source, vault)` runs
   inside the executor's try block, the value goes into the driver's request and from there into
   the subprocess environment (`scrubEnv` first), and no field of the executor, the Run row, an
   audit row or a log line holds it. The test asserts the token is absent from all three.
5. **What a subscription run records.** The hooks' per-call ledger rows carry `kind:
   "subscription"` (`RunContext.billing.kind`, `LedgerEntry.kind`) and `plan_usage_share`
   from the run's closure (`planShareAfter`: the month's rows before the run plus what the
   session budget has booked on this run, over the allowance; without an allowance the share
   the pick saw). `usd_micro` is the API-equivalent at list price from the pricing table in
   force ("plan usage, est."), so `SessionBudget` and every cap level treat it as the ledger
   says (billing.md): it counts against the session, task and run caps and the month cap as
   spend. The plan level is added on top: `EnforcementHooks.beforeModelCall` passes the run's
   billing facts to the caps port and `DynamicCaps` hands `planUsageShare` and the source's
   `planShareCap` to `CapChecker`, so at 80% of the cap the session finishes the current task
   and at the cap it stops, before the next model call, on the SDK path as on the loop path.
   The SDK's own figure is not a ledger row (the per-call rows are the accounting; the figure
   is kept on the Run for comparison).
6. **The SDK subprocess is not a sandbox.** `cc:Bash` would run where the subprocess runs,
   the host, and no `RunSandboxPort` lease covers it, so the executor withholds `cc:Bash` from
   the SDK run's token (an audit row `registry.tool_unmapped`, reason `commands_not_allowed`,
   like ADR 0043 item 5) unless the composition opts in (`billing.hostCommands`,
   `FORERUNNER_SDK_HOST_COMMANDS=1`), which puts a warning on the run. The other Claude Code
   tools get `ToolSpec`s for the hooks (`src/agent/cc-tools.ts`): the file tools carry
   `pathFields` and the token's only path is the worktree (or the run's own directory under
   `<worktrees>/sdk-runs/<runId>` when the task has none), `WebFetch` carries `domainFields`,
   the editing tools are `routine_reversible`, so the allowlist, path, domain and autonomy
   checks run as `PreToolUse` on this path too.
7. **Setup.** `fr setup --subscription-token` (or `FORERUNNER_SUBSCRIPTION_TOKEN`, or the
   interactive prompt when the Anthropic step did not already store one) checks the format
   (`sk-ant-oat…`, no whitespace, a plausible length; `validateSubscriptionTokenFormat`) and
   stores the value as `anthropic_subscription_token`. No request is made at setup: a live
   check through the Agent SDK belongs to the live harness. The API-key path is unchanged; a
   `sk-ant-oat…` pasted there is still validated against `/v1/models` as before. The summary
   names the sources the next start registers (`report.sources`, "Billing sources:" line),
   with the plan allowance and its origin.
8. **The plan allowance is a first-class input with a default, never an env-only afterthought.**
   The provider reports no plan usage to the Agent SDK, so the plan share is an estimate over
   an allowance (`limits.planUsdMicro`: USD of API-equivalent usage per UTC month), and without
   one `CapChecker` has no plan level at all. `src/setup/plan-allowance.ts` resolves it, most
   explicit first: `fr setup --plan-usd-monthly`, `FORERUNNER_PLAN_USD_MONTHLY`, the fourth
   interactive question (asked once a subscription source exists and nothing else set it),
   `config.json`'s `subscription.planUsdMonthly` (what the human gave is written there; it is
   not a secret), else `DEFAULT_PLAN_USD_MONTHLY` (USD 50: the price of a mid plan, low on
   purpose so an unconfigured install stops subscription work and asks early rather than
   late). A bad flag or environment value is a `validation` error before any credential is
   stored. `composeRuntime` resolves the same chain (`billing.planUsdMonthly` option, the
   environment, the config) and seeds the subscription row with it; a human-set allowance
   updates the row's `limits.planUsdMicro` at the next compose, the default only fills a row
   that has none (a value edited on the row stands). The setup summary and the compose log say
   which allowance applies and where it came from (`describePlanAllowance`), and
   `RuntimeApp.billing.planAllowance` exposes it. The live harness checks the plan level with
   a real token (BLOCKERS.md, the subscription row).
9. **Error messages are redacted before the store.** A driver's error message may quote what
   the subprocess or the provider said (a fake SDK that echoed its environment carried the
   OAuth token in `error.message`). The runtime log redacts on its own; the state store does
   not, so the executor passes the message through `redact()` before it becomes the task's
   `summary` (which the runner writes to the session log and the task transition) and before
   it enters the `error` artifact of a Run row closed by a throw, on both paths.

## Consequences

- A vault with both credentials bills the loop paths (the critic, chat, the model watch's
  evals) to the API key, which is what the Messages provider authenticates with
  (`RuntimeApp.billingSourceId`), and task runs to whichever source the router picks.
- `RuntimeApp.billing` exposes `sources()`, `pick` and the SDK driver; `ComposeOptions.sdkQuery`
  injects the SDK's `query` so a unit test never spawns Claude Code, `billing.probe` replaces
  the vault-and-ledger probe, `billing.personalRunner` and `billing.hostCommands` the policy
  flags.
- `CapsPort.check` takes `billing` in its options and `LedgerEntry` takes `kind` and
  `planUsageShare`; `AllowAllCaps`, `BillingCaps` and `MemoryLedger` ignore what they do not use.
- Every subscription row has an allowance (the default when nothing was set), so the plan
  level always exists; the default is an estimate and may stop subscription work before the
  real plan would (the API key takes over when there is one, else the session stops and asks
  with the cap's message). The human raises it with `fr setup --plan-usd-monthly`; a probe
  that reports a real share still wins (`MAX(plan_usage_share)`), so a provider-reported
  share replaces the estimate as soon as one exists.
- The session grant lists the `cc:` names only when the vault holds the OAuth token: a token
  of an install on the API key alone declares no tool its loop sessions cannot use.
- Tests: `packages/runtime/test/subscription-path.test.ts`. The live half of the phase 1 check
  (a real `claude setup-token` token through the Agent SDK) stays with the live harness and
  BLOCKERS.md.

## Alternatives considered

- **Pick once per session in compose** (as the cloud runner does per start). Rejected: the
  plan share moves during a session and the agent's owner differs per session; the spec says
  "routes each call", and a task is the unit the Run row and the audit log already have.
- **Flip `specialistDriver` to "sdk" at compose when a subscription exists.** Rejected: the
  same install must run on the API key when the plan is at the cap, and the critic and chat
  stay on the loop driver; a per-task lookup with the driver as an argument keeps one registry.
- **A second executor class for the SDK path.** Rejected: the Run row, the retry ladder, the
  memory block, the token derivation and the persist-failed audit would be copied; one
  executor with the driver call behind a normalised result keeps them in one place.
- **Record the SDK's `total_cost_usd` as the ledger row.** Rejected: it arrives at the end,
  after the caps have already decided on the per-call rows; the per-call rows at list price
  are the same basis and are what the caps enforce. The figure is kept on the Run.
- **Grant `cc:Bash` on the SDK path and warn.** Rejected by default (commands would run on the
  host outside any lease, against ADR 0043 item 4); the opt-in exists for the live harness and
  for an install that accepts it knowingly.
- **A live validation of the subscription token at setup.** Rejected: the only real check is
  a call through the Agent SDK, which costs plan usage and cannot run in a unit test; the
  format check stores the token and the first run proves it.
- **No default allowance (plan level only when the human sets one).** Rejected: a
  subscription seeded without the environment variable had no plan-level stop at all, which
  is the cap the spec names for subscription usage (I.1, I.5); a low default that stops early
  and says so is safer than none, and the input is asked for at setup so the default is the
  exception.
- **Derive the allowance from the human's monthly money cap.** Rejected: subscription rows
  already count against the month cap as spend, so a plan level at the same amount would be
  redundant; the allowance is a different quantity (what the plan covers) and gets its own
  input.
- **Keep the fake row enabled beside real sources.** Rejected: the router was never meant to
  pick it when a credential exists; with `BillingRouter.pick` in use it became a live
  candidate behind the subscription and the API key.
