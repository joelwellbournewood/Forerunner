# 0040 — Live-model harness: spend ledger, caps in code, what runs live and how

Date: 2026-10-20
Status: accepted

## Context

The spec's build order puts live models behind three gates: the phase 1 "same session once on
a subscription and once on an API key with correct usage recorded" and "text chat first token
under 1 s median", the phase 3 critic calibration ("catches at least 80% of seeded defects and
passes at least 90% of clean work"), and the response-time table of module D (D.8 to D.15).
Every other test runs on the fake provider. The humans provided one Anthropic API key with
100 USD of credit, in the build box's `.env.build` (never committed), and no subscription token.
The spec's budget rules (I.1, I.5) say every cap is enforced in code before each call with a
warning at 80%, and COST.md must carry every live spend. The spec leaves open where the live
tests live, how the budget is remembered across runs and machines, what a "run" is, how a
registry specialist written for the Agent SDK's `cc:*` tools runs on the in-process loop
driver, and what to do with a call that fails or is aborted after it was billed.

## Decision

1. **One package, opt-in, never in CI.** `tests/live` (`@forerunner/live`) has its own vitest
   config and scripts: `test` (every live case `it.skipIf`'d with a visible reason) and
   `test:live` (`--mode live` sets `FORERUNNER_LIVE=1`). The root `vitest.config.ts` and
   `ci.yml` do not include it; `FORERUNNER_LIVE` is never set in CI.
2. **The budget is a committed ledger plus caps enforced before every call.**
   `tests/live/spend.json` holds one row per live model call (`date, run, model, tokensIn,
   tokensOut, cacheRead, cacheWrite, usd[, note]`), priced from `@forerunner/billing`'s table.
   A `MeteredProvider` wraps the real provider: before a call it takes a reservation sized by
   the billing package's conservative estimate (whole input at the input price plus `max_tokens`
   at the output price); the call starts only if the ledger total plus the calls in flight plus
   the estimate stay under `FORERUNNER_LIVE_BUDGET_USD` (default 100) **and** the run's rows
   plus in flight plus the estimate stay under `FORERUNNER_LIVE_RUN_CAP_USD` (default 15, never
   above the budget). A refused call throws `budget_exceeded` naming the reason and the ledger
   total; nothing is sent. A warning line prints once at 80% of either cap. The reported usage
   is appended after every call, also after an error or an abort (then with a `note`, and
   `0/0` tokens when the provider reported none: the Anthropic adapter yields usage only on
   `message_end`, so an aborted call's billed input tokens are not visible to the harness; the
   per-run cap's margin covers that). *Amended 2026-10-23 (item w4-metered-aborted):* the
   adapter now reports the input side on `message_start` and the metered provider records it
   for a call cut off before `message_end`; what stays outside the ledger is a call stopped
   before the message opened and the unreported output tokens of a killed call (testing.md,
   "Live runs" and Known issues). A call is `aborted` whenever the run's signal fired before it
   settled.
3. **A run is one vitest invocation.** The run id is minted once in `vitest.config.ts` and handed
   to every file through `FORERUNNER_LIVE_RUN`; files run sequentially in path order, so the
   per-run cap spans phase 1, the timing table and the calibration together and the ledger is
   written by one worker at a time.
4. **The real runtime, real wiring.** The phase 1 half composes through `composeRuntime` (the
   daemon's one wiring) with `AnthropicMessagesProvider` behind the metered gate, the
   workspace id as the `anthropic-workspace-id` default header, an in-memory SQLite store, a
   `MemoryVault` holding the key by its usual name (so the billing source is an `api_key`
   source and runs charge it, as on a real install), the testenv `FakeGitHost` behind
   `GitHubHost` (clones and pushes over git smart HTTP with a classic token), the process
   sandbox stand-in and `startServices: false`. Every live call also leaves an audit row
   (`live.model_call`, allowed or refused) in the store.
5. **The coder runs on the built-in file tools from a patched registry copy.** The registry
   names Claude Code tools (`cc:Read`, ...) for the Agent SDK driver; `LoopTaskExecutor` offers
   a specialist only the tools whose names match its allowlist, so a registry specialist on the
   loop driver has no tools. The harness copies the registry to its temp root and rewrites the
   coder's frontmatter: `allowed_tools: read_file, write_file, list_dir`, `max_budget_usd 0.5`,
   `max_turns 12`, `timeout_minutes 5`, `requires_sandbox false`; the prompt body is unchanged
   and the prompt version records the new hash. The gap itself (no `cc:` to built-in mapping in
   the daemon's loop path) is a runtime follow-up, not hidden here.
6. **What the phase 1 live half proves.** Three small tasks on a seeded repository, Sonnet for
   the coder and the tier 1 critic, Haiku for text chat, under a task cap (0.40 USD), a session
   cap (3 USD), the run cap and the budget; the kill switch repeated live (stop within 2 s,
   measured in wall time, the aborted call settled in the ledger). The subscription half is
   recorded as pending until a `claude setup-token` exists.
7. **Calibration subset first, full set only under the cap.** The phase 3 live run reviews a
   10-task subset of the coder set (10 clean + 10 seeded reviews) at tier 1 with a 120 s review
   timeout (the 30 s target is reported, never enforced, so a slow review is counted by its
   verdict, not as a timeout); the full 40-task run (80 reviews) runs only when the subset's
   measured cost per review times 80 times a 1.5 safety factor fits the run's remaining
   allowance. The e2e world's session budget is the hooks' hard cap underneath the metered
   gate.
8. **Timing rows come from measurements only.** Ten short requests per tier with
   `max_tokens 16` through the adapter's streaming give median and p90 of time to first token
   and total time; the critic's review durations and the coder runs' durations come from the
   phase 3 and phase 1 runs. gates.md carries the table with the spec targets; a row the harness
   cannot measure (voice first audio, tier 2/3 critic, research) says so instead of guessing.

## Consequences

- No live call can start without passing the gate in code; the ledger is the memory of spend
  across machines and sessions and is reviewed like any other committed file (numbers only;
  the secret scan runs over it).
- A run that fails mid-way still leaves its rows: COST.md is updated from the ledger, never
  from estimates.
- The harness's registry copy means the live coder's prompt version differs from the
  repository's by its hash; the evidence records which.
- The aborted-call blind spot (input tokens billed but not reported) is a known under-count,
  bounded by the per-run cap; a future adapter change surfacing `message_start` usage closes it.
- The subscription half of the phase 1 gate stays pending (BLOCKERS.md).

## Alternatives considered

- **Live cases inside `tests/e2e` behind `FORERUNNER_E2E_LIVE`.** Rejected: the budget state
  (ledger, run cap, run id) needs its own config and sequencing, and the e2e project's thirty
  minute timeouts and fake-provider world would mix two concerns.
- **A budget kept only in memory per process.** Rejected: it forgets between runs and
  machines; the ledger is what makes the 100 USD total enforceable.
- **Enforcing the cap in the runtime's hooks only.** The hooks cap a session; the live budget
  spans sessions, the timing requests and the calibration world, so the gate sits in the
  provider, which every driver goes through. The hooks still run underneath.
- **Mapping `cc:*` tools to built-ins inside the harness.** Rejected: that mapping belongs in
  the runtime (one place, tested), not in a test package; the copy keeps the change visible.
- **Adapting the ladder to the provider's model list automatically.** Rejected: the model watch
  is the way a rung changes; the first live test asserts the ladder's ids exist and fails
  loudly otherwise.
