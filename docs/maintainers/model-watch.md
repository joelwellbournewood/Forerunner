# Model watch and estimate learning

The weekly model watch (spec D, phase 7) and the estimate-versus-actual learning that feeds the
planner (spec I, phase 7). Code: `packages/runtime/src/models/` (`watch.ts`, `price-list.ts`,
`settings.ts`, `eval-runner.ts`, `watch-cli.ts`, `watch-routes.ts`; `ladder.ts` holds the
built-in ladder and effort table) and `packages/runtime/src/estimates/` (`model.ts`, `view.ts`).
Everything is exported from `@forerunner/runtime` (`src/index.ts`; `settings.ts` as the
`modelSettings` namespace). ADR 0019 records the recommendation thresholds and the estimate
model's constants; ADR 0029 records how the daemon wires both; ADR 0089 records that paid evals
need the human's consent (the fresh-install incident of 2026-10-26).

## Purpose

Spec D: "Weekly model watch: checks provider model lists and pricing, runs the eval set on new
candidates, proposes a switch with measured quality and cost deltas. Human approves." and "The
model watch also tests lower effort levels on the eval set, since a cheaper effort that passes
is a free saving." Spec M: "Connector and model updates surface in the same updates screen."
Spec I: "Estimate before every run; actual recorded after. Estimate error tracked per specialist
and task type." Build order phase 7: "Weekly model watch with eval-based recommendations" and
"Estimate-vs-actual learning feeding the planner".

Rules enforced in code, never only by prompt text:

| Rule | Where | Error |
| --- | --- | --- |
| Nothing changes the ladder, an effort default or a price without a human's recorded `adopt` answer. `ModelWatch.applyAdoption` is the only code path that writes `pricing.json` or `models.json`; it refuses any other decision or an answer without `by`. | `watch.ts` `applyAdoption` | `approval_required` |
| A price is never assumed. A model on neither the pricing table nor the fetched price list is reported as unpriced, not evaluated and never recommended; the eval runner refuses an unpriced model before its first call (`pricingFor` → `costOf` throws). | `diffModels`, `LoopEvalRunner.run` | `validation` |
| No paid eval without the human's consent (ADR 0089): a run evaluates only when asked (`run({ evals: true })`, `fr models watch --evals`, `POST /run { evals: true }`), after an `evaluate` answer on a pending or reminded report, or when `human.notify_prefs.model_watch.run_evals` is true. Default off. An `adopt` ("yes", "ok", "approve") never starts a paid run. Otherwise the report lists what it would have run in `evals_deferred` and no eval reaches the runner. | `ModelWatch.run`, `resolve` | `validation` for an `evaluate` on a report not pending or reminded |
| Paid runs are single-flight: while one runs, another paid run joins it (same promise, same report). The paid-or-free decision is serialised in call order. | `ModelWatch.run` (`paidRun`, `decisions`) | |
| One watch run spends at most `evalBudgetUsdMicro` on evals (default 5 USD). The check runs before every eval; later evals are skipped and the report says so. The monthly cap, kill switch and audit hooks apply to each eval call as to any run (the runner issues a token per task, owned by the human, so every ledger row counts in the human's month). | `guardEvalBudget`, `LoopEvalRunner` | `budget_exceeded` |
| Eval work is new work under the caps: before every eval task the runner checks the human's outer caps (`LoopEvalRunnerDeps.caps`, the daemon's `DynamicCaps`, the task's budget as the estimate) with the eval source's billing (`LoopEvalRunnerDeps.billing`: kind, and for a subscription the plan share and cap, so the plan level is checked); past the 80% line or at the cap no task starts. A run that ends `budget_exceeded` ends the set only when a re-check of the outer caps no longer allows; a task over its own budget fails that task. A cap stop or a kill ends the watch run's remaining evals without calling the runner. | `LoopEvalRunner.run` (`checkOuterCaps`), `ModelWatch.run` (`halted`) | `budget_exceeded` |
| Eval commands never execute on the host: the model's `run_command` and the grader's `command_exit0` checks run in a sandbox lease over the task's work directory with no egress. A lease in the process stand-in (`engine: "process"`) is refused before any model call unless `model_watch.allow_process_sandbox` is true (default off). | `LoopEvalRunner` | `not_supported` (`details.reason: "process_sandbox_not_allowed"`); see `sandbox.md` |
| A stopping daemon stops the watch: `RuntimeApp.close()` aborts `ModelWatchDeps.signal` and awaits `ModelWatch.settled()` first; the signal reaches every eval run (`RunRequest.signal`), no eval starts after it and no report is written. | `ModelWatch.run`, `compose.ts` `close()` | `killed` |
| Every outward step appends an `audit_log` row: `model_watch.price_list`, `model_watch.eval` (one per eval, with its cost), `model_watch.report`, `model_watch.request`, `model_watch.decision`, `model_watch.write_pricing`, `model_watch.write_settings`. | `ModelWatch.audit` | |
| Settings documents are validated on read and round-tripped through their parser before an atomic write (temp file + rename); a hand-edited typo fails loudly instead of changing a model by accident. | `settings.ts` | `validation` |

## How it works

### What runs weekly

`scheduleModelWatch(scheduler, { timezone, everyMinutes?, enabled?, agentId? })` adds one
`Schedule` to the session `Scheduler` (`src/session/triggers.ts`): id `model-watch-weekly`,
pseudo agent id `model-watch` (`MODEL_WATCH_AGENT_ID`), kind `every`, `WEEK_MINUTES` (10080),
`persist: true`: the time of the last run is kept in the scheduler's fired store
(`<data dir>/scheduler-fired.json`), so a restarted daemon waits out the week instead of
running at its first tick. A fresh install runs the watch at its first tick. That run is the
baseline run (below): it records the provider listings, runs no eval and asks nothing.
The scheduler fires its `start` callback with a `StartRequest` for that agent id;
`isModelWatchRequest(req)` is true for it and the orchestrator's `startSession` routes it to
`ModelWatch.run()` instead of starting a session (`compose.ts`). The same `run()` backs
`fr models watch` and `POST /model-watch/run`.

One run (`ModelWatch.run({ signal?, evals? })`; `evals: true` is an explicit "run
evaluations", `false` never evaluates, unset asks `ModelWatchDeps.autoEvals`, which the daemon
answers from `model_watch.run_evals` and which is off when absent):

1. **Inputs.** `effectiveConfig()` = built-in ladder and effort table (`builtinModelConfig()`,
   or `deps.baseConfig`) with `<config>/models.json` applied (`applyModelSettings`);
   `effectivePricing()` = `deps.pricing` (default `BUILTIN_PRICING`) merged with
   `<config>/pricing.json` (`mergePricing`). The `PriceListSource` is fetched; a failure is
   recorded in `report.price_list.error` and `skipped`, never thrown. Every registered
   `ModelProvider` not in `ignoreProviders` is asked `listModels()`; a failing provider lands in
   `report.providers[].error`.
2. **Diffs** (`diffModels`, `diffPrices`, pure and exported):
   - *baseline* (ADR 0089, amendment of 2026-10-26): a provider's first successful listing is
     its baseline. `readModelWatchBaselines(store)` reads the stored ones; a provider listed
     without one is recorded by `recordModelWatchBaseline` once the report is stored, named in
     `report.baseline_providers`, and none of its models is new in that run. A run in which
     every listed provider is recorded is a *baseline run*: no eval (even with the opt-in), no
     request, `decision: "nothing_to_decide"`, a `skipped` line saying so. Later runs compare
     against the baseline, which never moves. A provider registered later gets its own
     baseline on its first listing; the others still report news in that run.
   - *known*: a model in the provider's baseline, or one the install's own price table already
     prices (`deps.pricing`, `BUILTIN_PRICING` in the daemon; a row in `<config>/pricing.json`
     does not count), is not news. `diffModels` takes this as its `known(provider, id)`
     argument and skips such models: they are neither new nor unpriced and never candidates.
     The incident behind this: a fresh install's first run listed ten Anthropic models the
     built-in table priced but the ladder did not use, called them all new, planned candidate
     evals for them, and opened "Model watch <date>: 10 new, 0 retired, 0 repriced, 0
     unpriced" in the inbox.
   - *new*: listed by a provider, on no ladder rung for that provider, and not known. Priced from the table
     first (`price_origin: "table"`), else from the price list (`"price_list"`; cache prices
     default to `CACHE_READ_SHARE` / `CACHE_WRITE_SHARE` of the input price when the list omits
     them), else `"none"` and the model is also listed under `unpriced`.
   - *retired*: a rung model of that provider that the provider no longer lists
     (`rung_affected: true`). Only reported; the rung is not changed.
   - *repriced*: for every model the price list and the table both know, each of the four
     price fields whose change is at least `repriceMinDeltaPct` (0.5%). Each repricing becomes
     a `pricing_proposal` row (`source: "list"`, `as_of` from the list).
3. **Evals** through the `EvalRunnerPort` (`run({ specialist, provider, model, effort, pricing,
   signal }) → { total, passed, failed, needsModel, passRate, costUsdMicro, durationMs }`). Every
   eval is costed with the effective table plus the proposal (`evalPricing`), so a candidate's
   cost delta compares the latest known prices on both sides. One observation per
   `(specialist, provider, model, effort)`; a repeat is served from the run's cache.
   - *Baseline* per eval target (`DEFAULT_EVAL_TARGETS`: coder on mode `coder`, researcher on
     mode `researcher`): the rung model of the mode's default tier on the eval provider
     (`deps.evalProvider`, else the first listed provider with ladder entries) at the mode's
     default effort.
   - *Lower effort* (spec D.21): the same model one effort step below the mode's default
     (`effortBelow`; a mode already at `low` has no probe).
   - *Candidate*: every priced new model, on every target, against the rung model of the tier
     the provider assigns it, at the mode's default effort. A candidate whose tier has no rung
     model on its provider is skipped.
   The budget guard runs before each eval; a skipped eval is an observation with
   `skipped_reason` (`budget_exceeded: ...`, `validation: ...`, `not_supported: ...` for a
   refused process stand-in, a provider error) and never feeds a recommendation. After a
   `budget_exceeded` or `killed` from the runner every later eval of the run is skipped with
   that reason and never reaches the runner. An abort of the run's signal ends the run with
   `killed` and no report.
   *Without consent* each of these evals is only planned: it is listed in
   `evals_deferred.planned` (`{ specialist, mode, provider, model, tier, effort, role }`), the
   runner is never called, nothing lands in `evals`, and no switch or lower-effort
   recommendation can follow.
4. **Recommendations** (`recommendSwitch`, `recommendLowerEffort`, pure; thresholds in ADR 0019):
   - `switch_model` (rung X on provider P from A to B): across the targets with usable pairs,
     the lowest per-target pass-rate delta must not fall below `-qualityTolerancePoints` (0),
     and either the summed eval cost is at least `minCostSavingPct` (10%) lower, or the mean
     delta is at least `minQualityGainPoints` (5 points) better and the cost at most
     `maxCostIncreasePct` (25%) higher. Text: `Switch rung sonnet on anthropic from A to B:
     quality +a points, cost -b%`.
   - `lower_effort` (mode Z from E to E-1): the lower effort's pass rate is at least the
     baseline's (minus the tolerance) and its cost at least `minEffortSavingPct` (5%) lower.
     Text: `Lower effort for mode coder from medium to low: passes 100% at -c% cost`.
   - `reprice` (model M): every repricing from step 2, always proposed, never applied without
     the human.
   Observations from sets smaller than `minEvalTasks` (3) never earn a recommendation.
5. **Report, persistence, decision.** The `ModelWatchReport` (zod, below) is persisted, audited
   and, when it holds a recommendation, a proposal row or a withheld eval on a new candidate,
   put to the human through the approval port (options `adopt, evaluate, ignore, remind` when
   evals were withheld, else `adopt, ignore, remind`). Withheld lower-effort probes alone never
   raise a request, and a candidate the human ignored on an earlier report that withheld its
   evals is not asked about again, nor is its new price row (`ignoredDeferredCandidates`, the
   last 200 reports). A report with nothing to decide gets `decision: "nothing_to_decide"` and no
   request.

### Report format

`ModelWatchReportSchema` (`watch.ts`):

```json
{
  "version": 1,
  "id": "<newId>",
  "generated_at": "2026-10-19T06:00:00.000Z",
  "price_list": { "source": "url:prices.example.test", "as_of": "2026-10-19", "models": 3, "error": null },
  "providers": [{ "name": "anthropic", "listed": [{ "id": "claude-sonnet-5-5", "tier": "sonnet" }], "error": null }],
  "diff": {
    "new_models": [{ "provider": "anthropic", "id": "claude-sonnet-6", "tier": "sonnet", "priced": true, "price_origin": "price_list", "price": { "input_per_mtok_usd": 1.5, "output_per_mtok_usd": 7.5, "cache_read_per_mtok_usd": 0.15, "cache_write_per_mtok_usd": 1.875, "as_of": "2026-10-19", "source": "list" } }],
    "retired_models": [{ "provider": "anthropic", "id": "claude-opus-5-5", "tier": "opus", "rung_affected": true }],
    "repriced": [{ "model": "claude-sonnet-5-5", "changes": [{ "field": "input_per_mtok_usd", "before": 3, "after": 2.4, "delta_pct": -20 }] }],
    "unpriced": [{ "provider": "anthropic", "id": "claude-mystery", "tier": "opus" }]
  },
  "evals": [{ "specialist": "coder", "mode": "coder", "provider": "anthropic", "model": "claude-sonnet-5-5", "tier": "sonnet", "effort": "medium", "role": "baseline", "total": 20, "passed": 19, "failed": 1, "needs_model": 0, "pass_rate": 0.95, "cost_usd_micro": 39600, "duration_ms": 1200, "skipped_reason": null }],
  "recommendations": [
    { "id": "switch-1", "kind": "switch_model", "provider": "anthropic", "rung": "sonnet", "from": "claude-sonnet-5-5", "to": "claude-sonnet-6", "quality_delta_points": 0, "min_quality_delta_points": 0, "cost_delta_pct": -46.97, "evidence": ["coder: 20/20 passed at medium vs 20/20 on claude-sonnet-5-5; cost -46.97%"], "text": "Switch rung sonnet on anthropic from claude-sonnet-5-5 to claude-sonnet-6: quality +0 points, cost -46.97%" },
    { "id": "lower-effort-1", "kind": "lower_effort", "mode": "coder", "specialist": "coder", "provider": "anthropic", "model": "claude-sonnet-5-5", "from": "medium", "to": "low", "pass_rate": 1, "baseline_pass_rate": 1, "cost_delta_pct": -37.88, "evidence": ["..."], "text": "Lower effort for mode coder from medium to low: passes 100% at -37.88% cost" },
    { "id": "reprice-1", "kind": "reprice", "model": "claude-sonnet-5-5", "changes": [{ "field": "input_per_mtok_usd", "before": 3, "after": 2.4, "delta_pct": -20 }], "text": "Reprice claude-sonnet-5-5: input_per_mtok_usd 3 -> 2.4 (-20%)" }
  ],
  "pricing_proposal": { "claude-sonnet-5-5": { "input_per_mtok_usd": 2.4, "as_of": "2026-10-19", "source": "list", "notes": "model watch: price list ... as of 2026-10-19" }, "claude-sonnet-6": { "...": "full row for a new model" } },
  "eval_cost_usd_micro": 85200,
  "eval_budget_usd_micro": 5000000,
  "evals_deferred": null,
  "baseline_providers": [],
  "skipped": ["eval coder on claude-x at medium: budget_exceeded: ..."],
  "summary": "Model watch 2026-10-19: 2 new, 1 retired, 1 repriced, 1 unpriced model(s). 3 eval run(s) for USD 0.0852. 3 recommendation(s): ..."
}
```

`evals_deferred` is `null` when the evals ran (and on reports written before ADR 0089; the
schema defaults it). Without consent it is `{ "reason": "paid evals need the human's consent:
...", "planned": [{ "specialist": "coder", "mode": "coder", "provider": "anthropic", "model":
"claude-sonnet-5-5", "tier": "sonnet", "effort": "medium", "role": "baseline" }, ...] }` and
`evals` is empty; `proposalSteps` adds an "Evaluations not run" line with the count, the
run's budget and that only "evaluate" runs them (adopt applies the price rows only), `summarizeReport` a sentence, `formatModelWatchReport` one `planned` line each.

`baseline_providers` names the providers whose listing this run recorded as their baseline
(empty on later runs; the schema defaults it on older reports). A baseline run's summary reads
`Model watch <date>: baseline recorded for anthropic (14 model(s)); 0 new, ...`.

`pricing_proposal` has exactly the shape `<config>/pricing.json` accepts (`PricingOverrides`
in `@forerunner/billing`): repricings carry only the changed fields, new models a full row.
`formatModelWatchReport(report, health?)` renders the one-screen text the CLI prints;
`summarizeReport` the one-paragraph summary; `proposalSteps` the lines of the inbox card.

### Where a report is persisted

A report is one `release` row (`packages/state/src/schema.ts`): `channel = "model_watch"`
(`MODEL_WATCH_CHANNEL`), `release_version = report.id` (the table's unique index is
`(channel, release_version)`), `changelog = summary`, `artifacts = [report]`,
`health = ModelWatchHealth`, `status` `draft` → `published` on creation → `installed` after an
adopt. `ModelWatchHealth` is `{ decision: "pending" | "nothing_to_decide" | "adopted" |
"evaluate" | "ignored" | "remind", request_id, decided_at, by, applied[], remind_at }`.

Why `release` and not `queue_item`: a queue item belongs to a project and a human and is
consumed by the next session, while a model watch report is install-wide, has a lifecycle
(proposed, decided, installed) and is exactly what the updates screen lists (spec M.5:
"model updates surface in the same updates screen"). The updates module reads the channel
through `ModelWatchUpdates` in `daemon/server.ts` (`update/screen.ts`, `deps.modelWatch`), the
`UpdatesPage` reads `GET /model-watch/reports` and `/reports/latest`. No schema change was
needed. `reportFromRelease`, `healthOf` and `summaryFromRelease` are the only readers of the
row's JSON columns; a row whose artifact does not parse as a report is `validation`.

Baselines are `release` rows too, on their own channel so the updates screen never lists them:
`channel = "model_watch_baseline"` (`MODEL_WATCH_BASELINE_CHANNEL`), `release_version` = the
provider name (the unique index makes it one per provider), `status: "installed"`,
`artifacts = [{ provider, models: [{ id, tier }], report_id }]`. `recordModelWatchBaseline`
writes one only when none exists and returns quietly when a racing run wrote it first. An
unreadable baseline row is logged and read as an empty baseline, so that provider's models
are compared with the ladder and the price table only and are never silenced. To re-baseline
a provider, delete its row; the next run records the listing again.

### How a human adopts a change

The approval port is `ModelWatchApprovalPort { ask(req) → { status: "answered", answer } |
{ status: "pending", requestId } }`. Production uses `StateModelWatchApprovals`, which inserts a
`human_request` of kind `decision`, options `["adopt", "ignore", "remind"]` (with `"evaluate"`
after `"adopt"` when the report withheld its evals), non-blocking, risk
`medium`, `steps` = `proposalSteps(report)` and `change_card.key = "model_watch:<reportId>"`
(`MODEL_WATCH_REQUEST_PREFIX`), and answers "pending". Tests use a fake that answers at once.

The loop closes in one of three ways, all ending in `ModelWatch.resolve(reportId, answer)`:

- the inbox: the human answers the request; `syncPendingAnswers()` reads every published
  `model_watch` release whose health is `pending`, parses the request's answer with
  `answerFromHumanRequest` (`"adopt" | "yes" | "approve"`, `"ignore" | "no" | "reject"`,
  `"remind" | "later" | "next week"`, `"evaluate" | "run evaluations" | "run evals"`, as a
  string or `{ decision | choice | answer, adopt? }`)
  and resolves it. The daemon's `syncApprovals()` calls it at compose and after every inbox
  answer; `POST /model-watch/sync` and `fr` one-shots call it on demand;
- the updates screen: `POST /model-watch/reports/:id/answer { decision, adopt?, by }`; `by`
  (the human id) is required by the route schema, so an answer without a human is a 400 before
  the watch sees it;
- the CLI and tests: `watch.resolve(id, { decision, by, adopt? })`.

`resolve`:

- `adopt` (needs `by`; `adopt: [ids]` restricts it to those recommendations, an unknown id is
  `validation`): writes the pricing rows (the chosen repricings, the price rows of the chosen
  new models, and on an unrestricted adopt every proposal row) merged over the existing
  overrides and validated with `mergePricing` before the write; then the ladder rungs of the
  chosen switches and the efforts of the chosen lower-effort recommendations into
  `models.json`, with a `history` entry `{ at, report_id, by, changes[] }`. The release becomes
  `installed`, `health.applied` lists each change in words. A report cannot be adopted twice.
  Last, when `ModelWatchDeps.onAdopted` is set, it is called once with
  `{ reportId, by, applied, pricing, config }`: the pricing table (`effectivePricing()`) and
  the ladder/effort config (`effectiveConfig().config`) now in force, so the daemon can swap
  what it loaded at compose without a restart. The call is audited as `model_watch.reload`;
  a hook that throws is logged, audited with `allowed=false`, and the adoption stands (the
  files are already written; a restart applies them).
- `evaluate` (needs `by`, else `approval_required`; only on a `pending` or `remind` report,
  else `validation`, so a second answer never starts a second run): records the decision,
  writes nothing, audits `model_watch.evals_requested` and calls
  `ModelWatchDeps.onEvalsRequested({ reportId, by })`; the daemon starts `run({ evals: true
  })` in the background (joining a paid run already in flight), which produces a new report
  with the evidence and asks again. An `adopt` never starts a paid run, including on a report
  whose evals were withheld: it applies the rows and stops. A throwing hook is logged; the
  decision stands.
- `ignore`: records the decision; nothing is written.
- `remind`: records the decision and `remind_at = now + 7 days`. There is no separate timer:
  the next weekly run produces a fresh report and asks again as long as the diff still holds.

### The settings documents

| File | Written by | Read by | Shape |
| --- | --- | --- | --- |
| `<config>/pricing.json` | `applyAdoption` through `ModelSettingsStore.writePricingOverrides` | `loadPricing` in `@forerunner/billing` at compose (`billing.md`), `ModelWatch.effectivePricing()` | `PricingOverrides`: model id → partial price row with `as_of` (billing's parser) |
| `<config>/models.json` | `applyAdoption` through `writeModelSettings` | `ModelWatch.effectiveConfig()`; the orchestrator at compose (see Known issues) | `{ version: 1, updated_at, ladder: { <tier>: { <provider>: <model id> } }, efforts: { <mode>: <effort> }, history: [...] }` (`ModelSettingsSchema`), only the rungs and modes that differ from the built-ins |

`FileModelSettingsStore({ configDir?, env?, nowIso })` is the production store (default
directory `appDirs(env).config`; `pricing.json` at `pricingOverridesPath(env)` when no
directory is given); `MemoryModelSettingsStore` counts writes for tests.
`applyModelSettings(settings, base)` returns the effective `{ ladder, modeDefaults }`;
`modelIdFor(tier, provider, ladder)` and `effortForTask(mode, riskTier, offset, modeDefaults)`
in `ladder.ts` take that result, so a consumer that is handed the effective config honours an
adopted change without any other code.

### Price list sources (`price-list.ts`)

`PriceListSource { name; fetch(signal?) → PriceList }` where a price list is
`{ as_of: "YYYY-MM-DD", source?, models: { "<model id>": { input_per_mtok_usd,
output_per_mtok_usd, cache_read_per_mtok_usd?, cache_write_per_mtok_usd?, notes? } } }`
(`PriceListSchema`, strict; ids are canonicalised with `canonicalModelId`, a duplicate after
canonicalisation is `validation`).

| Source | Use |
| --- | --- |
| `FetchPriceListSource({ url, fetch?, timeoutMs? })` | Production when `FORERUNNER_PRICE_LIST_URL` (`PRICE_LIST_URL_ENV`, read by `priceListUrlFromEnv`) names an http(s) URL. Network failures and non-2xx are `unavailable` (retryable on 5xx), a bad document `validation`. No provider publishes this format; an install points it at a JSON document it maintains (a file on any HTTPS host or object store). |
| `UnconfiguredPriceListSource` | Production when no URL is set: every fetch is `unavailable` naming the variable, the report says so, and every model outside the pricing table is unpriced. Nothing is guessed. |
| `FixturePriceListSource(list)` | Tests and installs that pin prices by hand. |

**Fast-mode variants (spec D.20, ADR 0057).** The Opus fast-mode rate has its own price rows
named for the variant (`claude-opus-5-5-fast`, `claude-opus-4-6-fast`; `billing.md`), so the
watch reads the variant's rate like any other row: a price list that names
`claude-opus-5-5-fast` produces a repricing of that row alone (`diffPrices`) and an adoption
writes it to `<config>/pricing.json`, which the executor's fast-mode pricing and the Settings
texts read through the table in force. A variant is never a provider listing (the provider
lists the base id), so `diffModels` neither proposes nor retires it; the evals run the
standard speed. `test/fast-mode.test.ts` pins the repricing.

### The eval runner (`eval-runner.ts`, ADR 0029)

`LoopEvalRunner` implements `EvalRunnerPort` inside the runtime (`@forerunner/evals` depends on
the runtime, so the daemon cannot import it; `ComposeOptions.evalRunner` injects an
evals-backed runner where one exists, and the unit tests drive `runEvalSet` from
`@forerunner/evals` on the fake provider through the same port). It reads the specialist's eval
set directory (`SpecialistDef.evalSetDir`, the files of `evals/registry/evals/<specialist>/`,
20 tasks each for coder and researcher) with a tolerant copy of the task schema
(`EvalTaskLite`), writes `setup.files` into a work directory under `<cache>/model-watch`, runs
the brief through the loop driver with the specialist's prompt, a token of its own (depth 0,
the task's budget, the work directory as the only path, no domains, no secrets, only the loop
driver's equivalents of the specialist's `allowed_tools`, `CLAUDE_CODE_TOOL_EQUIVALENTS`),
`compression: "off"`, then writes `grader_files` and grades the mechanical checks
(`file_exists`, `file_contains`, `regex`, `json_path`, `command_exit0` inside the sandbox
lease). A `rubric` check without a failing mechanical check is `needs_model` and counts
neither as pass nor as fail; `pass_rate = passed / (passed + failed)`. `maxTasks` bounds a set.

The runner runs only runnable registry entries (`not_found` otherwise), with one exception:
`EvalRunInput.candidate`, the specialist approval gate's input (spec C.5, ADR 0071). It names
a pending proposal's `SpecialistDef`, which must be `location: "proposed"` and carry the name
asked for (`validation` otherwise); the run then uses that definition's prompt, limits, tools
and eval set instead of the registry's entry, so a proposal is evaluated without ever being
runnable anywhere else. `SpecialistApprovals` (`src/registry/approval.ts`, runtime.md) is the
only caller; `specialist-approval.test.ts` covers both refusals.

### CLI and routes

`registerModelWatchCli(program, () => ({ watch, out? }))` adds `fr models watch [--evals]
[--json]` (run now, print the report and whether a decision is open; `--evals` is the explicit
"run evaluations", without it the run is the free check unless the opt-in is on) and `fr models report [--id <id>]
[--list] [--json]` (latest, one, or the list newest first). The orchestrator passes a thunk that
composes the runtime (`cli/main.ts`).

`createModelWatchRoutes({ watch })` is a Hono sub-app the daemon mounts at `/model-watch`
(`api-types.ts` lists the paths): `GET /reports?limit=`, `GET /reports/latest`,
`GET /reports/:id` (404 when unknown), `POST /run` (`{ evals?: boolean }`, empty body allowed;
400 malformed), `POST /reports/:id/answer` (`{ decision: adopt | evaluate | ignore | remind,
adopt?, by }`; 400 malformed, 403 `approval_required`), `POST /sync`.

### The human's settings (ADR 0089)

`human.notify_prefs.model_watch = { run_evals?: boolean, allow_process_sandbox?: boolean }`,
read by `modelWatchSettingsOf` (anything missing or malformed is off) at every run and every
eval lease, so a change applies without a restart. It is the `settings.set` key `model_watch`
(`commands.md`; global, medium risk, undoable). `run_evals` makes every run evaluate without
asking; `allow_process_sandbox` lets eval tasks that run commands use the process stand-in on
a machine without Docker or Podman; turning it on is high risk (`SettingSpec.riskFor`), so
`settings.set` needs the device to confirm. The daemon also reads the eval source's billing at
every eval task (`evalBilling` in `compose.ts`: `planUsageOf` for a subscription).

### Estimate learning (`estimates/model.ts`)

`EstimateModel implements EstimatePort { estimate(task) → EstimateResult }`:

- **Key**: `(specialist, kind)`; `kind` defaults to `tier<risk_tier>` (`kindOfTask`; spec I
  tracks error "per specialist and task type", and size and risk travel together in the task
  model). `kindOf` in the options replaces it. A task without a specialist is keyed as `coder`
  (`defaultSpecialist`), which is what `StaticPlanner` assumes.
- **Sample**: `observe({ specialist, kind, estimateUsdMicro, actualUsdMicro, estimateWallMs,
  actualWallMs, at, taskId? })`. Per sample the cost and wall ratios `actual / estimate` are
  clamped to `[0.1, 10]` (`SAMPLE_RATIO_MIN/MAX`) so one runaway or aborted run cannot dominate.
  The state per key is an exponentially weighted mean of `ln(ratio)` for cost and wall
  (`alpha` 0.3; the first sample sets it), an EW mean of the residual `|ln ratio - mean|`
  (dispersion), an EW mean of `|ratio - 1|` (the error shown to humans) and the count `n`.
  Samples with a non-positive estimate or no actual at all are ignored (`observe` returns false).
- **Estimate**: base cost = the task's own `est_cost_usd_micro` when > 0, else the cold start;
  base wall = the cold start. Multiplier = `clamp(exp(mean · w), 0.25, 4)` with
  `w = n / (n + shrinkage)` (`shrinkage` 5), so few samples barely move the figure.
  `confidence = min(1, w · exp(-residual))`: grows with samples, shrinks with dispersion, 0
  without data. `basis` is `learned` (n > 0), `task_estimate`, `registry_default` or
  `fallback`; `samples`, `costRatio` and `wallRatio` are returned for the UI.
- **Cold start**: the registry's `max_budget_usd × coldStartBudgetShare` (0.5) and
  `timeout_minutes × coldStartTimeoutShare` (0.5) for the specialist (`defaults(specialist)`
  option; compose passes the registry), else `fallbackUsdMicro` (0.5 USD) and `fallbackWallMs`
  (20 min).
- **Persistence**: there is no estimate table. The samples are the finished `task` rows
  (`FINISHED_TASK_STATUSES`: `done`, `failed`, `cancelled`) that have at least one finished
  `run` (`outcome` not `running`): actual cost from the `cost_ledger` breakdown by `task_id`
  (the truth for caps) or, without ledger rows, the sum of the runs' `cost_usd_micro`; actual
  wall time the sum of the runs' `duration_ms` (retries count); the estimate from
  `task.est_cost_usd_micro`, else the cold start (so registry defaults get calibrated too);
  the sample time `task.updated_at`. `EstimateModel.fromStore(store, options)` folds them at
  start; `refresh(store)` folds tasks finished since. The fold is bounded by a cursor (the
  newest finish time seen) and an overlap window (`foldOverlapMs`, default 15 minutes,
  `DEFAULT_FOLD_OVERLAP_MS`): the store query is `status IN (finished) AND updated_at >=
  cursor - window` (hand-written through the repo's public `where`/`rows`, ordered by
  `updated_at, id`), the run listing goes in chunks of 500 ids, the ledger breakdown is bounded
  by `from = oldest fresh task's created_at - window` (a task's ledger rows are recorded after
  the task exists), and the model remembers only the ids finished inside the window, pruned
  after every fold. A rebuild and an incremental refresh give the same state and a refresh
  never counts a task twice; neither the query nor the memory grows with the install's history.
  The window also covers clock skew between writers of a shared store and a task row that is
  finished in the store a little after its live observation. `toJSON()` / `fromJSON()`
  (snapshot version 2; older versions are refused) exist for a caller that wants to cache the
  fold.
- **One sample derivation for both feeds**: `sampleForTask(task, { usdMicro, wallMs, at })`
  builds the sample the fold uses, and `observeTask(task, actuals)` is the live feed for the
  runner's `task.finished` hook: same estimate base (`task.est_cost_usd_micro` or the cold
  start, never the figure the planner already corrected), same kind, same cold-start wall
  estimate; it also remembers the task id so a `refresh()` inside the window skips it. The
  base matters: observing the actual against the plan item's *learned* figure measures the
  residual after correction and feeds the correction back into itself, so the ratio settles
  near the square root of the real overrun (the test pins it: 1.85 learned versus below 1.55
  looped on a 2x history) and the state after a restart disagrees with the state learned live.
- **Wiring** (compose.ts, ADR 0029): `EstimateModel.fromStore(store, { defaults })` with the
  registry; `new StaticPlanner(500_000, estimates)` prices every plan item through
  `planEstimateUsdMicro(port, task)` before `cutPlanToBudget` cuts the plan to the work budget
  (spec E.3); `SessionRunner.onTaskFinished` feeds the model live (see Known issues: compose
  still calls `observe` with the plan item's figure; the intended call is
  `estimates.observeTask(task, { usdMicro: result.costUsdMicro, wallMs: durationMs, at:
  clock.nowIso() })`). The daemon does not call `refresh()`: it folds at start and learns live.
  `EstimatePort` is the seam: any planner that takes it gets the learned figures.
- **Accuracy view** (`estimates/view.ts`, `GET /costs/estimates`, the Performance page):
  `estimateAccuracyView(model, nowIso, { recentLimit? })` →
  `{ generated_at, overall: { samples, mean_abs_error_pct, bias_pct, within_25_pct_share },
  rows: [{ specialist, kind, samples, cost_ratio, wall_ratio, mean_abs_error_pct, confidence,
  last_sample_at }], recent: [{ task_id, specialist, kind, estimate_usd_micro,
  actual_usd_micro, error_pct, estimate_wall_ms, actual_wall_ms, at }] }` (zod, mirrored in
  `apps/ui/src/api/contracts.ts`). `bias_pct` positive means estimates run low.

## How to change it

- **Thresholds.** `WatchThresholds` (`DEFAULT_WATCH_THRESHOLDS`, ADR 0019); `ModelWatchDeps.
  thresholds` overrides any subset, every value must be a finite number ≥ 0. Changing a default
  is a new ADR, and the maths tests in `model-watch.test.ts` pin the current numbers.
- **Eval targets.** `ModelWatchDeps.evalTargets` (`{ specialist, mode }`); the specialist needs
  a registry entry with `eval_set`, the mode a row in `MODE_DEFAULTS`. Adding a specialist with
  an eval set (`adding-a-specialist.md`) and listing it here is all it takes.
- **A new recommendation kind.** Add its zod schema to `RecommendationSchema`, a pure
  `recommendX` rule with tests, the step in `run()`, what adopting it writes in
  `applyAdoption`, its line in `proposalSteps` and `formatModelWatchReport`, and the
  `UpdatesPage` rendering.
- **A new provider.** Implement `listModels()` on the `ModelProvider` (`adding-a-provider.md`)
  with the tier the provider's docs assign each model; add its rung ids to `DEFAULT_LADDER` and
  its prices to `BUILTIN_PRICING` (or the price list). The watch needs nothing else.
- **When evals run.** `ModelWatchDeps.autoEvals` (the standing opt-in), `run({ evals })`
  (one run) and `onEvalsRequested` (consent on a report). Running evals without one of them is
  a change of ADR 0089, not a default to flip.
- **The price list.** Point `FORERUNNER_PRICE_LIST_URL` at a document in the format above;
  `ModelWatchDeps.priceList` takes any `PriceListSource`.
- **Report storage.** `MODEL_WATCH_CHANNEL`, `reportFromRelease`, `healthOf`,
  `summaryFromRelease` and `releaseFor` are the only places that know the row shape.
- **The estimate key or constants.** `EstimateModelOptions` (`alpha`, `shrinkage`, `kindOf`,
  cold-start shares, fallbacks, `recentLimit`); the clamps are exported constants. A different
  key (say task size) is a `kindOf` function; the fold needs no change because `sampleFromTask`
  calls it.
- **Applying adopted settings** (wired, ADR 0039; `runtime.md` "Adopted model settings"):
  `compose.ts` reads `models.json` into an `EffectiveModelConfigHolder`
  (`src/wiring/model-config.ts`, `readEffectiveModelConfig`), hands `() => holder.get()` to
  `LoopTaskExecutor` (`modelConfig` dep: `ladder` to `modelIdFor`, `modeDefaults` to
  `effortForTask`), to `ConversationAgent` (`modelConfig` dep: the `text_chat` row) and to
  `CriticLoop` (`modelConfig` dep: `ladder` and `modeDefaults` as accessors the critic
  package reads at every review's pick, `critic_t1` on the sonnet rung and `critic_t23` on
  opus, and the rung a failed run sat on for the retry ladder), and passes `onAdopted` to
  `new ModelWatch(...)`, which swaps the holder and the pricing table the run, chat and
  critic pricing closures read. A new consumer of a rung or an effort takes the holder's
  getter, never `DEFAULT_LADDER` or `MODE_DEFAULTS`. A malformed file is ignored with an audit
  row (`model_settings.read`, `allowed=false`) and the built-ins are used.
  `packages/runtime/test/model-config-wiring.test.ts` proves an adopted `models.json` changes
  the model and effort a session picks, the chat rung a turn uses and the rung the critic
  reviews on, with no restart.
- **Feeding the model live from the runner**: `onTaskFinished: ({ task, result, durationMs })
  => estimates.observeTask(task, { usdMicro: result.costUsdMicro, wallMs: durationMs, at:
  clock.nowIso() })`; never `observe` with the plan item's figure (see Estimate learning).

## Tests

`pnpm vitest run --project unit packages/runtime/test/model-watch.test.ts
packages/runtime/test/estimates.test.ts` (fake provider with scripted PASS/FAIL replies,
`sqlite::memory:` store, `SimulatedClock`, the real `runEvalSet` from `@forerunner/evals`
behind the port, a temp directory for the file store; no network).

`model-watch.test.ts`: diff detection of new, retired, repriced and unpriced models; an
unpriced model is reported, never evaluated or recommended; the pure diff helpers (table beats
list, cache multipliers); the report validates against its schema with the expected costs and
deltas; `recommendSwitch` on a saving, on a quality gain within the cost ceiling, never on a
quality loss, a cost increase past the ceiling, a saving below the minimum or a set below
`minEvalTasks`; `recommendLowerEffort` needs the baseline pass rate and a saving and ignores
skipped observations; a candidate that passes the scripted set is recommended and one that
fails a task is not; a lower effort is recommended only when it passes the whole set; the
eval budget is enforced in code (later evals skipped with `budget_exceeded`, no provider call
made); a failing provider and a failing price list land in the report; pending (release
persisted, request opened, nothing written, ladder and effort unchanged); adopt (overrides and
settings written, release installed, every audit row present); `onAdopted` receives the
pricing and config in force after an adopt (audited `model_watch.reload`), is never fired by
ignore or remind, and a throwing hook leaves the files written and the release installed with
an `allowed=false` audit row; adopt with the file store
writes `pricing.json` and `models.json` that parse back; ignore and remind change nothing;
adopt is refused without a human (`approval_required`), cannot be applied twice, rejects
unknown ids, 404 for an unknown report; a partial adopt; nothing to decide opens no request;
the production port opens a `human_request` and `syncPendingAnswers` closes the loop; answer
parsing in several shapes; `FetchPriceListSource` (fetch, canonical ids, bad document, HTTP
failure, network failure, bad URL, env parsing) and `FixturePriceListSource`; the weekly
schedule fires once per week as a model watch request, and a daemon restarted within the week
(a new `Scheduler` over the same fired store) does not run it again; consent (ADR 0089): with
no opt-in a run calls no eval, lists the planned evals and offers `evaluate`, an opt-in that is
off stays off while `run({ evals: true })` evaluates, withheld lower-effort probes alone ask
nothing, `evaluate` writes nothing and calls `onEvalsRequested` (and needs `by`), an adopt of a
report that withheld its evals applies its rows and calls it too, `evaluate` answers parse, a
`budget_exceeded` from the runner ends the run's evals, an abort ends the run with `killed`,
no report and no further eval; `adopt` never starts a paid run and "yes", "ok", "approve" parse
as adopt; `evaluate` only on a pending or reminded report; paid runs are single-flight (a
scheduled paid run and two explicit runs started together give one run and one report); an
ignored candidate is not asked about again; a persisted last run in the future is clamped to
now; the baseline (ADR 0089, 2026-10-26): a fresh install's first run over ten models the
built-in table prices opens no request and the next week's run neither, the first run asks
nothing and runs no eval even with the opt-in and stores one baseline row apart from the
reports, a model listed after the baseline is the only news and opens one request, a model
the install's table knows is not news while one priced only by the price list is, a provider
registered later records its own baseline while the other still reports news (the shared
`world()` seeds the ladder as the fake provider's baseline, so the other tests run as an
install past its first run); `fr models watch|report`; the routes
(list, read, answer with `by`, 400 without it, 404); the file settings store; an adopted
`models.json` changes the rung `modelIdFor` picks and the effort `effortForTask` returns.

`estimates.test.ts`: cold start from the registry defaults scaled by the documented share, else
the fallback; a task's own estimate as the base; convergence on a simulated history (ratio
monotone toward 1.5, then forgetting on a regime change); confidence grows with samples and
falls with dispersion; per-key learning, clamps and unusable samples; snapshot round trip;
folding from task, run and `cost_ledger` rows (ledger wins, retries sum, open and run-less tasks
are not samples, refresh never double counts); cold-start calibration without a task estimate;
the planner through `EstimatePort` and `cutPlanToBudget`; the bounded refresh (the store query
carries `"updated_at" >= ?` and returns only the window plus the new task, the ledger breakdown
carries a `from` bound, the remembered id set stays within the window); live learning through
`observeTask` equals the fold after a restart while observing against the plan's corrected
figure settles well below the true ratio; a task observed live is not folded again by a
refresh inside the window; `sampleForTask` matches the fold's derivation; snapshot version 2
round-trips and version 1 is refused; the accuracy view (rows, overall error, bias, within-25%
share, schema, empty model).

`model-watch-boot.test.ts` (the daemon composed on a fresh FORERUNNER_HOME, its own
scheduler ticked by hand): the first tick and a restart 80 minutes later call no eval and
write one report between them, and a boot a week later writes exactly one more; the first
boot's free check over ten table-known models writes a "baseline recorded" report and opens no
request in the inbox; after the baseline run, `evaluate`
on a pending report runs the evals once (a second `evaluate` is refused and runs nothing) and
the `model_watch.run_evals` setting makes the scheduled run evaluate; `close()` while an eval is underway aborts it, the run ends
`killed` and `close()` returns.

`wiring.test.ts` (daemon): the first `POST /model-watch/run {}` on a fresh install is the
baseline run (no eval, no request), the next one makes no eval, no
ledger row and no `model_watch.eval` audit row and offers `evaluate`; `POST /model-watch/run
{ "evals": true }` on the fake provider with a repricing and an inbox decision, the researcher
evals run with one audit row each and the coder evals are refused the process stand-in
(`not_supported`); a process lease is refused before any model call and destroyed unless
`allowProcessSandbox` answers true; an eval's spend lands in the human's month in the ledger and
a month past its 80% line starts no eval task; the updates screen
listing the model watch entries; the eval runner keeping `run_command` inside the sandbox lease
and offering only the specialist's tools; estimates feeding `GET /costs/estimates`; the CLI
registration and one-shot composition.

## Known issues

- **An adopt reaches the daemon it was answered in.** `onAdopted` swaps the tables the
  daemon process holds (ADR 0039); a CLI one-shot (`fr models watch`) composes its own runtime
  and reads the files at its start, so an adopt answered there (`watch.resolve` in the CLI
  process) reaches a running daemon only at the daemon's next start; answers given in the
  inbox or the updates screen go through the daemon and apply at once. The
  `CostLedger` keeps the pricing table it was built with until the next start (it prices
  savings views, not calls); the critic, the executor and the chat price from the table in
  force.
- **`compose.ts` feeds the estimate model the plan item's figure.** Its `onTaskFinished`
  calls `observe` with `item.estimateUsdMicro`, which `StaticPlanner` already multiplied by
  the learned ratio, so the live ratio settles near the square root of the real overrun and
  disagrees with the fold after a restart (see Estimate learning). The fix is the one-line
  switch to `observeTask` in "How to change it"; the module side and its test are done.
- A task that finishes twice (failed, retried, done again) is two samples: the second fold
  sees the task with a later `updated_at` and the runs of every attempt summed. A live
  observation followed by a `refresh()` more than `foldOverlapMs` later, for a task whose row
  finished in the store after the window, would count it twice; the daemon never calls
  `refresh()` after start, so this is a limit for a process that polls a shared store (poll at
  least every `foldOverlapMs`).
- The baseline silences what a provider listed at the watch's first run for good. A model
  that was already listed then, but that the ladder did not use, is never a candidate later,
  not even in a `--evals` run. There is no way yet to put such a model to the evals: deleting
  the baseline row only records a new one at the next run. A command that names a model to
  test would close this. An install upgraded from before the baseline rule has no
  baseline row, so its first run after the upgrade is a baseline run and asks nothing that
  week. A model the human or an adopt priced in `pricing.json` but kept off the ladder stays
  news, since only the shipped table counts as known.
- `remind` is not a timer; the next weekly run re-proposes. A reminder for a report whose
  diff has disappeared by then is silently moot.
- Lower-effort probes exist only for modes that have an eval target (coder, researcher).
  Chat, routing, planning and critic modes have no eval set, so their efforts are never
  tested; a `lower_effort` recommendation names the mode, not the specialist.
- Only mechanical checks count. Rubric-graded tasks are `needs_model` and are left out of the
  pass rate until the critic grades them (ADR 0029).
- A candidate's tier is whatever its provider's `listModels()` assigns; the watch never
  re-tiers a model. A retired rung model is reported with its rung but no replacement is
  proposed unless a priced candidate on that tier passes the evals.
- The price list format is Forerunner's own. Without a configured URL the pricing table
  (`BUILTIN_PRICING` plus `pricing.json`) is the only source of prices and new models are
  unpriced until a human adds a row.
- The estimate model's wall-time base is always the cold start (tasks carry no wall estimate
  column); the learned wall ratio still calibrates it. The model is in memory and refolded from
  the store at every start: the first fold reads every finished task once (the cursor is
  empty), every later `refresh()` only the overlap window; `toJSON` is not persisted anywhere
  yet, so a start on a large install pays that one full read.
- Eval cost is charged to the install's billing source and counts toward the monthly cap like
  any run; the `evalBudgetUsdMicro` cap is per watch run, not per week across manual runs.
- Without the opt-in, lower-effort savings (spec D.21) are measured only when the human runs
  evaluations; the weekly report does not find them on its own (ADR 0089).
- On a machine without Docker or Podman the coder eval set does not run until the human sets
  `model_watch.allow_process_sandbox` or installs an engine; the researcher set has no command
  and still runs. The same switch governs the specialist approval gate's evals (ADR 0071).
- The factory still logs "sandbox: process (no container engine)" when it creates the refused
  lease; the eval then ends before any model call.
- `eval-runner-guards.test.ts` covers the runner alone: the plan level of a subscription in
  the caps check, an API source's kind, a task over its own budget failing only that task, and
  the refusal text of the process stand-in.
- Memory consolidation is also a weekly `every` schedule without `persist` and fires at the
  first tick of each daemon process. It makes no eval.

## Requirements covered

D.6 (weekly model watch: lists, prices, evals on candidates, switch proposals with quality and
cost deltas, human approves), D.21 (lower effort levels tested), D.7 in part (the lowest effort
that passes, measured on the eval set), M.5 (model updates in the updates screen), I.3
(estimate before every run, actual after, error per specialist and task type), E.3 in part
(learned estimates price the plan that `cutPlanToBudget` cuts). Tests:
`packages/runtime/test/model-watch.test.ts`, `packages/runtime/test/estimates.test.ts`,
`packages/runtime/test/wiring.test.ts`, `packages/runtime/test/model-config-wiring.test.ts`
(an adopted `models.json` changes the rung and effort of the next session and the chat rung
of the next turn without a restart; a malformed file is ignored with an audit row).
