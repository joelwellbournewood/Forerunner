# Billing

`packages/billing`: billing sources, routing between them, the pricing table, the cost ledger
with its CHF view and plan-usage view, hard caps with the 80/100 rule and the review reserve,
and estimate-versus-actual tracking. ADR 0008 records the money decisions.

## Purpose

Every model call is paid by exactly one billing source of the human who owns the agent, is
priced in USD micro-units, converted to CHF at the day's rate, and written to the cost ledger.
The runtime asks `CapChecker` before each call whether the human's caps allow it. A prompt may
ask for budget; only this code and the runtime hooks can grant it.

## How it works

### Sources (`src/sources.ts`)

| Kind | What it is | Ledger kind | Cost in the ledger |
| --- | --- | --- | --- |
| `subscription` | Claude Pro/Max/Team login or `claude setup-token` token in the vault | `subscription` | Estimated API-equivalent (`usd_micro`) plus `plan_usage_share` (0..1) |
| `plan_credits` | Monthly API credits claimed into a Console org; used through that org's key | `plan_credits` | Exact, from the pricing table |
| `api_key` | Console API key in the vault | `api` | Exact, from the pricing table |
| `fake` | The test provider | `api` | Exact, from the pricing table |

`BillingSource` fields: `id`, `kind`, `humanId`, `label`, `credentialRef` (a secret *name*,
validated by `assertCredentialRef`, which rejects anything shaped like a token and never echoes
the value), `enabled`, `priority` (lower first within a kind), `limits`
(`monthlyUsdMicro`, `planShareCap`, `personalRunner`). `BillingSourceProbe.status(source)` returns
`{ available, planUsageShare?, monthSpentUsdMicro?, reason? }`; `FakeProbe` is the test double,
the live probe lands with the Agent SDK driver wiring.

### Routing policy (`src/router.ts`)

`BillingRouter.pick({ humanId, agentId, runner, purpose, modelTier })` returns
`{ source, status, reason, skipped }` or throws `ForerunnerError("unavailable")` whose
`details.skipped` lists every source and why it was not used.

Two rules are invariants, not policy: a source is only ever used for its owner's agent (another
human's subscription is skipped with code `other_human`, even if it is the only source), and a
disabled source is never used. Everything else is data in `RoutingPolicy`:

| Field | Default | Meaning |
| --- | --- | --- |
| `planShareCap` | 0.95 | Subscription skipped when `planUsageShare >= cap` (`source.limits.planShareCap` overrides) |
| `subscriptionOnCloudRunner` | `personal_runner_only` | `never`, `personal_runner_only` (needs `limits.personalRunner === true`), `always` |
| `preference` | session/interactive/chat/critic: subscription, plan_credits, api_key, fake; batch: api_key, plan_credits, subscription, fake | Kinds in order per purpose; a kind not listed is never used for that purpose |
| `kindsForTier` | none | Optional allowlist of kinds per model tier (e.g. `{ fable: ["api_key", "plan_credits"] }`) |

Order of evaluation per source: owner, enabled, purpose preference, tier allowlist, cloud-runner
rule, probe status, plan share cap, monthly limit. Survivors sort by preference rank, then
`priority`, then id. Skip codes: `other_human`, `disabled`, `purpose`, `tier`, `cloud_runner`,
`unavailable`, `plan_share`, `monthly_limit`.

### Pricing (`src/pricing.ts`)

`BUILTIN_PRICING` is keyed by canonical model id (`canonicalModelId` strips `anthropic.`,
dated suffixes, `-v1:0`, `-latest`, `[1m]`). Each row has `input_per_mtok_usd`,
`output_per_mtok_usd`, `cache_read_per_mtok_usd`, `cache_write_per_mtok_usd`, `source`
(`list` | `assumed` | `override`), `as_of` and optional `notes`. Cache defaults follow the price
list: reads 10% of input, writes 125% (models with a different list price for reads carry it
explicitly). `costOf(usage, model)` returns `usd_micro = tokens * price_per_mtok`, rounded
half-up once; an unknown model throws `ForerunnerError("validation")`, never a silent zero.
`estimateUsdMicro` is the conservative pre-run estimate (full input plus `max_tokens` at output
price). `cacheSavingsUsdMicro` values cache reads at the full input price.

**Overrides without a release:** `loadPricing()` merges `<appDirs().config>/pricing.json`
(`FORERUNNER_HOME` honoured) over the built-in table. A known model may be partially
overridden (the row is then marked `source: "override"`); a new model needs all four prices and
`as_of`. A malformed file throws so a typo cannot silently zero a price. Example:

```json
{
  "claude-sonnet-5-5": { "input_per_mtok_usd": 2.5, "as_of": "2026-11-03" },
  "claude-new-model": {
    "input_per_mtok_usd": 1, "output_per_mtok_usd": 5,
    "cache_read_per_mtok_usd": 0.1, "cache_write_per_mtok_usd": 1.25,
    "as_of": "2026-11-03", "notes": "added by the model watch"
  }
}
```

### CHF conversion (`src/rates.ts`, `src/money.ts`)

Amounts are integers in micro-units (`usdMicro`, `chfMicro`, `fromCents`, `formatChf`,
`formatUsd` with two decimals). Rounding is half-up, ties away from zero, everywhere.
`RateSource.quote(dateIso)` gives `{ chfPerUsd, requestedDate, rateDate, origin, fetchedAt }`.
`FrankfurterRateSource` fetches `https://api.frankfurter.app/latest?from=USD&to=CHF` (or
`/<date>` for past days), caches each day's rate in `<appDirs().cache>/rates-usd-chf.json`
(atomic write, newest 400 days kept) and never throws for lack of network: `origin` is
`frankfurter` (live), `cache` (today's cached value), `fallback` (newest cached day on or before
the requested one) or `default` (`DEFAULT_CHF_PER_USD = 0.80`, only when the cache is empty).
`FixedRateSource(rate)` is for tests and pinned rates. The ledger stores `rate_chf_per_usd`
with every entry, so CHF totals never move after the fact.

### Ledger and the plan-usage view (`src/ledger.ts`, `src/sink.ts`)

`CostLedger.record({ usage, model, source, scope, specialist?, planUsageShare?, occurredAt?,
tokensBeforeCompression?, tokensAfterCompression?, usdMicroActual? })` prices the run (a
provider-reported `usdMicroActual` wins), converts at the rate for `occurredAt`, sets `kind`
from the source kind and writes through `LedgerSink.record`. It returns
`{ entry, rate, estimated }`; `estimated` is true for subscription entries, which the UI labels
"plan usage, est. API-equivalent" and shows next to `plan_usage_share`. `totals(filter)` sums any
combination of human, project, session, task, run and time window with a per-kind split;
`monthTotals(humanId)` uses the UTC calendar month. `allocation({ projectId }, outcomeLookup)`
groups by specialist, model and task with runs, tasks, accepted/rejected/open counts,
`successRate` (accepted over decided) and `costPerAcceptedTaskUsdMicro`.

**Savings (ADR 0003 section 3; requirement I.7).** `savings(filter | sessionId)` returns a
`SavingsReport` computed at read time from the Run rows, never from ledger rows: `cost_ledger`
stays spend-only and nothing in it is netted. Three lines are kept apart: `compression`
("estimated": `tokens_before_compression - tokens_after_compression` x the model's input price,
`compressionSavingsUsdMicro`), `cache` ("measured": `cache_read_tokens` x (input price - cache
read price), `cacheSavingsUsdMicro`, with `usdMicroAtFullPrice` / `usdMicroPaid` and the
`cacheWriteTokens` beside it because writes cost 1.25x) and `headroom` (the proxy's own count
from `session.headroom_saved_tokens`, tokens only because a session spans models). Each run is
rounded half-up once in USD micro (ADR 0008) and converted to CHF at `rate_chf_per_usd` of the
run's own ledger entry (`cost_ledger.run_id`; a run without an entry is quoted for its day), then
the integers are summed. `byProject`, `bySpecialist` and `byModel` allocate the same fields
(`SavingsBucket`), `transforms` counts how often each context transform fired, `unpricedRuns`
counts runs whose model has no price row (tokens shown, money honestly zero). A price correction
changes past savings figures, never past spend; that is why savings are not ledger entries.

Sources: `RunSource.listRuns(filter)` and `SessionSource.listSessions(filter)` (optional
`CostLedgerOptions.runs` / `.sessions`); the runtime's `StateLedgerStore` implements both over
the state store (a session filter reads the session's runs; other filters go through the
matching ledger entries' `run_id` / `session_id`). Without a `RunSource` the ledger entries stand
in (`entriesAsRuns`, one run per `run_id`, cache tokens summed), which is what the in-memory
tests use. The daemon's cost view (`costView` in `packages/runtime/src/daemon/views.ts`) shows
`savings.compressionTokens` / `cacheTokens` and the two money pairs from this report.

`LedgerSink` / `LedgerQuery` are the only storage the package needs; `InMemoryLedger`
implements both. The state adapter maps them to `CostLedgerRepo.record` / `.sum` / list with
the same column names (`LedgerFilter` matches `CostFilter`, `LedgerSum` matches `CostSum`).

### Caps (`src/caps.ts`, `src/defaults.ts`)

`Caps = { monthUsdMicro, projectUsdMicro?, sessionUsdMicro, taskUsdMicro?, runUsdMicro?,
reserveShare (0.15..0.25, default 0.2), planShareCap (default 0.95) }`. Defaults come from
`capsFromChf({}, rate)`: CHF 150 per human per month and CHF 5 per session, converted at the
day's rate when the caps are built. `CapChecker.check(scope, estimateUsdMicro, { phase })`
sums the ledger per level the scope names (month by human and UTC month, project, session,
task, run) and adds the estimate:

| Projected spend | Decision | Meaning for the runtime |
| --- | --- | --- |
| below 80% of every cap | `allow` | proceed |
| at or above 80% of any cap | `finish_current` | finish the current task, start no new work |
| at or above 100% of any cap | `stop` | stop and ask the human |

Thresholds compare integers (`projected >= roundHalfUp(cap * 0.8)`), so 79.9% allows and 80.0%
does not. The **review reserve**: in phase `work`, session spend plus estimate above
`sessionCap * (1 - reserveShare)` yields `finish_current` even below 80%; phase `review` may use
the reserve. **Plan usage**: with `planUsageShare` for a subscription source, 80% of
`planShareCap` yields `finish_current` and reaching it yields `stop`. The result names the level
with the worst decision (tightest ratio on ties), `spent`, `cap`, `remaining`, `ratio`, a
human-readable `message` and every measured level. The check is pure given the ledger and the
clock.

### Estimates (`src/estimates.ts`)

`EstimateTracker.record(specialist, taskType, estimate, actual)` keeps `(actual - estimate) /
max(estimate, 1)` clamped to [-1, 10]. `errorStats(specialist, taskType?)` gives `n`,
`meanAbsErrorRatio` and `bias`; `suggestedMultiplier` is `1 + bias * n / (n + 3)` clamped to
[0.5, 3], which the planner applies to its next estimate. `toJSON` / `fromJSON` persist it.

## How to change it

- **Provider rule change** (subscription allowed on cloud, plan credits order, a new cap):
  edit `DEFAULT_ROUTING_POLICY` in `src/router.ts`, or pass a `RoutingPolicy` when constructing
  the router. Add a test in `test/router.test.ts` for the new rule. Nothing else changes.
- **A price changed or a model launched:** write `<config>/pricing.json` (model watch or human)
  and, when confident, update `BUILTIN_PRICING` with the `as_of` date. Keep the loud banner.
- **New source kind:** extend `BillingSourceKind`, `ledgerKindFor`, the schema in
  `src/sources.ts` and every `preference` list; the state package's `BILLING_KINDS` and
  `COST_KINDS` must agree.
- **Thresholds:** `FINISH_CURRENT_AT`, `STOP_AT`, `DEFAULT_RESERVE_SHARE`, the reserve range
  and `DEFAULT_PLAN_SHARE_CAP` are constants; `CapChecker` accepts per-instance thresholds.
- **Another currency:** `money.ts` is currency-agnostic; `rates.ts` would need a second pair
  and the ledger a column.

## Tests

`pnpm vitest run --project unit packages/billing` (8 files, 77 tests, no network): money
rounding and formatting; rate fetch, cache, fallback and default flag with an injected fetch;
pricing math including cache tokens, unknown model, id normalisation and overrides; source
validation and the credential-shaped `credentialRef` rejection; every routing rule and the
cross-human invariant; ledger record, totals, month window, allocation and savings with the
in-memory sink, plus savings from Run rows through a `RunSource` (ADR 0008 half-up rounding at
the 0.5 micro boundary, CHF at each run's own rate, allocation by project / specialist / model,
transform counts, Headroom session totals, `entriesAsRuns` folding); cap boundaries (79.9 / 80 /
100%), every level, the reserve, plan share and determinism; the estimate tracker and the CHF
defaults. All time comes from `SimulatedClock`. The runtime's `views.test.ts` and
`executor-context.test.ts` prove the cost view prices a compressed run through the state store.

## Known issues

- `cost_ledger` carries no compression columns by design (ADR 0003): `savings()` reads the Run
  and Session rows. The `tokensBeforeCompression` / `tokensAfterCompression` fields on
  `LedgerEntry` are kept for the in-memory sink and are not written by the state adapter.
- Haiku 5.5's second price tier above 100K prompt tokens is not modelled; costs there are
  under-estimated by up to 5x until a tiered price row exists.
- 5.5-generation prices were taken from the provider reference cached on 2026-10-06. The model
  watch must confirm them weekly; `as_of` says when a row was last confirmed.
- The live `BillingSourceProbe` (plan usage from the subscription, spend from the Console) is
  not in this package; routing uses whatever the probe reports.
