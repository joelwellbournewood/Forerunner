# 0057 — Opus fast mode per project: the speed parameter on the same model id, variant price rows named `<id>-fast`, API-only sources

Date: 2026-10-23
Status: accepted

## Context

Spec D.20: "Opus fast mode (research preview, API only, priced separately) can be enabled per
project for urgent work." Before this change there was no flag; urgent work raised the ceiling
or the budget by hand (BLOCKERS.md row D.20). Open points:

- **How a request asks for fast mode.** The Anthropic Messages API offers fast mode as a
  request parameter, `speed: "fast"` on the Opus model (here `claude-opus-5-5`), not as a
  separate model id; the SDK in the lockfile (`@anthropic-ai/sdk` 0.135) types it on
  `MessageCreateParams` and notes that some models want the `fast-mode-2026-02-01` beta header
  with any `speed` value. The response's `usage.speed` reports the speed used.
- **How it is priced apart.** Every cost in Forerunner comes from one table keyed by model id
  (`packages/billing/src/pricing.ts`); the ledger, the cost views, the estimates and the model
  watch all read it by the run's model id. A parameter is invisible to all of them.
- **What the fast-mode prices are.** The provider publishes fast mode as a research preview at
  six times the standard rate (Opus 4.6: USD 30 / 150 per million input / output tokens against
  5 / 25), with the prompt-caching multipliers applying on top. The repository's provider
  reference (cached 2026-10-06) prices Opus 5.5 at 4 / 20 with cache reads at 0.2; it carries
  no separate fast-mode figure for 5.5.
- **Which runs and which sources.** "API only": a Claude subscription (the Agent SDK path with
  the OAuth token, ADR 0044) and plan credits are not the API. Runs: specialists, the critic,
  intake planning, the conversation agent and model watch evals all call models.

## Decision

1. **The parameter, on the same model id.** `ModelRequest.speed?: "standard" | "fast"` and an
   optional provider capability `ModelProvider.fastMode`. The Anthropic adapter sets
   `fastMode = true` and maps `speed: "fast"` onto the Messages API body parameter of the same
   name with the `anthropic-beta: fast-mode-2026-02-01` header (`FAST_MODE_BETA`); without the
   field it sends neither. The model id on the wire stays the base id (`claude-opus-5-5`). A
   provider without the capability is never asked.
2. **The variant is a model id of its own everywhere Forerunner records a run.** The variant is
   named `<canonical base id>-fast` (`FAST_MODE_SUFFIX`, `fastModeVariantId`). The loop driver
   takes `RunRequest.speed`, sends it on every call and records the variant in
   `RunContext.model` (so every ledger row) and in `run_start`; the executor writes the variant
   as the Run row's `model` and prices the run from the variant's row. The ledger's
   `allocation().byModel`, the cost views, the per-call estimate before each call and the
   model watch's repricing therefore show and price the variant apart with no special case.
   `tierOfModel` places a variant on its base model's rung so the retry ladder is unaffected.
3. **The pricing rows, in the one place prices live.** `BUILTIN_PRICING` gains
   `claude-opus-4-6-fast` at the published research-preview list price (30 / 150, cache reads
   3, writes 37.5: the caching multipliers on top; `source: "list"`) as the anchor, and
   `claude-opus-5-5-fast` at six times every price of the `claude-opus-5-5` row (24 / 120,
   cache reads 1.2, writes 30), marked `source: "assumed"` because it is derived from the
   published multiplier rather than read off a 5.5 price list. Both rows' notes say
   "research-preview rate" (`FAST_MODE_RATE_NOTE`). A human or the model watch corrects them
   through `<config>/pricing.json` like any row; an override of the variant leaves the
   standard row alone.
4. **The setting.** `project.settings.fast_mode`, a boolean, off by default (only a literal
   `true` turns it on), changed through `settings.set` with key `fast_mode` at medium risk
   (it raises what every Opus call of the project costs, so a yes is needed). Its `effect`
   (ADR 0051 item 4) says both ways what changes and what it costs: on, "Opus runs of this
   project on an API key are requested in fast mode (research preview) at USD 24 / 120 per
   million input / output tokens instead of USD 4 / 20, a 6x surcharge; a subscription ignores
   it (API only)"; off, back to the standard rate and the surcharge stopping. The daemon lists
   `project.fast_mode` per project in `GET /settings` with both sentences priced from the table
   in force, and the Settings page shows them on an Opus fast mode card with a toggle that runs
   the same command.
5. **Which runs: every Opus rung of the project's specialist runs and critic reviews.** The
   executor decides per run, after the billing pick (`decideFastMode`): off unless the flag is on and the run's rung
   is Opus; then ignored, in this order, for a `subscription` or `plan_credits` source
   (`fastModeBillable`: API-style sources only, "API only"), for the Agent SDK path (it has no
   speed parameter), for a provider without `fastMode`, and for an Opus id whose `<id>-fast`
   row is missing (a run is never priced from a guess); otherwise applied. A run without a
   billing port is on the composition's API-style source and may go fast. The critic makes the
   same decision for every review whose pick lands on the Opus rung (tiers 2 and 3 by default)
   on the loop driver. Its source is the composition's loop source (`billingSourceId`), whose
   kind the daemon reads from the store at every review (`CriticDeps.fastMode`), so a
   subscription-billed critic is ignored as "API only". Speed does not change the model or
   the evidence, so the review stays independent. The conversation agent, intake planning and
   the model watch's evals do not run on Opus by default and do not read the flag.
6. **Every decision that touches a run is on record.** Applied or ignored, the executor (and,
   for a persisted review, the critic, with `specialist: "critic"` and the review tier) writes
   one `model.fast_mode` audit row on the run (task, project, run, tier, model, the variant
   when applied, source, kind, driver; the result "applied: ..." or "ignored (API only): ..."
   / "ignored: <reason>"), and an ignored decision is a warning on the session log. A flag that
   meets no Opus rung writes nothing.
7. **Each loop run is priced at its own model.** The daemon now passes the executor
   `pricingFor(modelId)` over the table in force; before, every loop run was priced at the
   sonnet rung whatever rung it ran on, which would have made the standard Opus figure the
   fast-mode surcharge is compared against wrong.

## Consequences

- The surcharge is visible wherever cost is: the Run row, the ledger, the allocation by model,
  the estimate before each call and the price rows the model watch reprices.
- A fast request that the API served at the standard speed would still be recorded and priced
  as the variant: the adapter does not read `usage.speed` yet. That over-states, never
  under-states, the cost; reading it is a follow-up in the adapter and the loop driver.
- Critic reviews at tiers 2 and 3 go fast with the project's specialist runs on an API-style
  source, so urgent work is not held up by a standard-speed review of a fast change. Intake
  planning, the conversation agent and the model watch's evals stay at the standard speed:
  they do not run on Opus by default.
- The change card's effect sentence is priced from the built-in table (`SettingSpec.effect`
  sees only the value), the Settings row from the table in force; they differ only after an
  override of an Opus or fast row.
- Loop runs on haiku or opus are now priced at their own rung on the daemon, which changes the
  figures of those runs (towards the right ones).
- `claude-opus-5-5-fast` is an estimate until the model watch confirms it; the research
  preview may change price or end, at which point the row is corrected or the flag ignored.

## Alternatives considered

- **A separate model id on the ladder or the wire** (`claude-opus-5-5-fast` sent as the model).
  The API has no such model; the id is ours. Keeping the base id on the wire and the variant
  id in our records gives the provider what it expects and our cost paths what they key on.
- **A multiplier applied at cost time instead of a row.** It would hide the rate from the
  table, the model watch and `pricing.json`, and every cost path would need to know about it.
- **A per-run speed column on the Run row and the ledger.** A schema change for a fact the
  model id already carries; every reader would have to combine two columns to price a row.
- **Routing a subscription run to an API key when the flag is on.** That changes who pays
  behind the human's back; the router's policy stays the human's, and the flag is ignored with
  a note instead.
- **Leaving critic reviews at the standard speed.** This was the first build's choice. It was
  reversed in review: the critic's source is a known row whose kind the API-only rule can
  read, and the spec routes every Opus rung of the project's runs, of which tier-2 and tier-3
  reviews are the largest share.
