# 0019 — Model watch recommendation thresholds and the estimate model

Date: 2026-10-20
Status: accepted

## Context

Spec D asks for a weekly model watch that "checks provider model lists and pricing, runs the
eval set on new candidates, proposes a switch with measured quality and cost deltas" and "also
tests lower effort levels on the eval set, since a cheaper effort that passes is a free
saving"; the human approves. Spec I asks that the estimate error be "tracked per specialist and
task type" and phase 7 that the learning feed the planner. The spec does not say when a
measured delta is worth a proposal, how much a watch run may spend on evals, what "passes"
means for a lower effort, where a report lives, or how the estimate learning is modelled and
stored. These had to be fixed so that the rules are code the tests can pin, not judgement in a
prompt.

## Decision

### Recommendation thresholds (`DEFAULT_WATCH_THRESHOLDS` in `src/models/watch.ts`)

| Threshold | Value | Rule |
| --- | --- | --- |
| `qualityTolerancePoints` | 0 | A recommendation may never lose pass-rate points on any eval target: the lowest per-target delta decides, not the mean. |
| `minCostSavingPct` | 10 | A candidate at equal quality is proposed when the summed eval cost across targets is at least a tenth lower. |
| `minQualityGainPoints` | 5 | A pricier candidate is proposed when its mean pass rate is at least five points better ... |
| `maxCostIncreasePct` | 25 | ... and it costs at most a quarter more. |
| `minEffortSavingPct` | 5 | A lower effort is proposed when it passes at least as well as the baseline (tolerance 0) and costs at least 5% less. |
| `minEvalTasks` | 3 | Sets smaller than this produce observations but never recommendations. |
| `repriceMinDeltaPct` | 0.5 | A price change below this is noise; above it a repricing row is proposed. |
| `evalBudgetUsdMicro` | 5 USD | Hard cap on what one run spends on evals, checked before every eval; later evals are skipped and reported. |

Evals on both sides of a comparison are costed with the effective pricing table plus the
report's own proposal, so a candidate the price list prices is compared at the latest known
prices and a repricing changes the baseline's cost too. Repricings are always proposed and
never applied without the human; a model with no known price is never evaluated.

### Where a report lives

A report is a `release` row on channel `model_watch` with the report as its single artifact
and the decision state in `health`. The updates screen already lists releases (spec M.5), the
table has the lifecycle a proposal needs (`draft`, `published`, `installed`) and a unique
`(channel, release_version)` index for the report id. The proposal goes to the human as a
`human_request` of kind `decision` with the options `adopt`, `ignore`, `remind`; the answer is
read back by `syncPendingAnswers`. `remind` records `remind_at` a week out and relies on the
next weekly run to ask again rather than on a second timer.

### The estimate model (`src/estimates/model.ts`)

- Key: `(specialist, kind)`, `kind = tier<risk_tier>` unless a `kindOf` function is given.
  Risk tier is the one task attribute that both the planner and the eval briefs carry and that
  correlates with size; a finer key would split the few samples a personal install produces.
- Statistic: an exponentially weighted mean of `ln(actual / estimate)` for cost and for wall
  time, `alpha = 0.3`, per-sample ratios clamped to `[0.1, 10]`; the multiplier the planner
  sees is `clamp(exp(mean · n / (n + 5)), 0.25, 4)`. Log space makes a 2× overrun and a 2×
  underrun cancel; the shrinkage pseudo-count of 5 keeps one or two samples from moving a
  default; the clamps bound the damage of a bad streak.
- Confidence: `min(1, n / (n + 5) · exp(-residual))`, the residual being the EW mean of
  `|ln ratio - mean|`. It grows with samples and shrinks with dispersion; it is reported, not
  used to gate anything yet.
- Cold start: half the specialist's registry `max_budget_usd` and half its `timeout_minutes`;
  0.5 USD and 20 minutes when the specialist is unknown. The cold-start figure is also the
  estimate recorded for a task that had none, so the defaults themselves get calibrated.
- Persistence: no table. The model is a deterministic fold over finished `task` rows with
  their `run` rows and the `cost_ledger` (ledger first, run cost as the fallback), rebuilt at
  start and extended incrementally; `toJSON` exists for a cache. The rows the fold reads are
  the ones the runtime already writes for caps and the allocation view, so the learning can
  never disagree with the ledger.

## Consequences

- A switch or a lower effort is proposed only with measured evidence on every eval target,
  and a quality regression anywhere blocks it; a human can still adopt a subset of a report.
- A watch run on an install with no price list configured proposes nothing for new models
  until a human adds a price row; the report says so.
- Five USD of evals per run bounds the weekly cost at roughly 20 USD a month plus manual runs;
  installs with larger eval sets raise the cap in `ModelWatchDeps.thresholds`.
- The estimate model moves slowly by design: after 5 identical samples the planner sees half
  the learned ratio, after 20 four fifths. A regime change (a new model after an adopt) is
  forgotten at the rate `alpha` sets, about ten samples.
- Changing a threshold or a constant is a new ADR; the tests pin the numbers.

## Alternatives considered

- **Mean quality instead of the per-target minimum.** Rejected: a candidate that is better at
  coding and worse at research would be proposed for both rungs.
- **A separate `model_watch_report` table.** Rejected: a schema change for rows the `release`
  table already models, and the updates screen would need a second reader.
- **`queue_item` for the report.** Rejected: queue items belong to a project and a human and
  are consumed by the next session; a model watch report is install-wide and has a lifecycle.
- **A second timer for `remind`.** Rejected: the weekly run is the reminder, and a timer that
  fires between runs would ask about a report whose diff may have changed.
- **Applying repricings automatically** (prices are facts, not choices). Rejected: a wrong
  price list would change every cap check; the human sees the delta first.
- **A regression on token counts or brief size for estimates.** Rejected for 1.0: too few
  samples per install; a ratio per key is explainable in the Performance view and converges
  on the simulated history. A richer model can replace it behind `EstimatePort`.
- **Persisting the estimate model in its own table.** Rejected: a fold over existing rows is
  always reproducible and cannot drift from the ledger; the fold is one query at start.

## Amendment 2026-10-20: one sample base, a bounded fold

Review of the first build found two things the decision above left implicit.

- **The sample's estimate is the raw base, never the planner's corrected figure.** A sample
  compares the actual with `task.est_cost_usd_micro` (or the cold start), the same base the
  multiplier is applied to. Observing the actual against the plan item's learned figure
  (base × ratio) measures the residual after correction and feeds the correction back into
  itself: with a constant overrun `R` the exponentially weighted mean settles at
  `ln R / (1 + w)`, so the planner sees about `√R` instead of `R`, and the state learned live
  disagrees with the fold after a restart. `EstimateModel.sampleForTask` is the single
  derivation; `observeTask` is the live feed and `refresh` the store feed, both through it.
- **The fold is bounded by a cursor and an overlap window** (`foldOverlapMs`, 15 minutes).
  A refresh asks the store for finished tasks with `updated_at >= cursor - window` and
  remembers only the ids inside that window; the run listing is chunked and the ledger
  breakdown bounded by the oldest fresh task's creation. Before, every refresh listed every
  finished task and the remembered id set grew with the install. The window is the trade-off:
  it covers clock skew between writers of a shared store and a task row finished shortly after
  its live observation, and a process that polls a shared store must refresh at least once
  per window to see every task finished elsewhere. Fifteen minutes is far longer than the gap
  between a run's end and the critic closing the task, and a window of ids is a few kilobytes.
  The snapshot format moved to version 2 (`folded` carries the finish time); nothing had
  persisted version 1.

## Amendment 2026-10-26: the eval budget bounds a run the human consented to

ADR 0089 changes when the evals run, not the thresholds. A watch run makes no paid eval
unless the human consented to it: an explicit "run evaluations", an `evaluate`
answer on a report whose evals were withheld (an adopt never starts a paid run), or the opt-in setting `model_watch.run_evals`
(default off). The 5 USD `evalBudgetUsdMicro` now caps that consented run. The consequence
above ("roughly 20 USD a month") holds only for an install that turned the opt-in on.
