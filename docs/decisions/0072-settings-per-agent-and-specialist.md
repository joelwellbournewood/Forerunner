# 0072 — Settings per agent and specialist: the effort table's D.4 columns, the agent row's overrides, provider capability flags, and a speed preference composed with the project's fast-mode leave

Date: 2026-10-23
Status: accepted

## Context

Spec D.4: "Settings per agent and specialist: model, effort, max tokens, speed mode, timeout,
with the defaults from the effort table (D.8 to D.15). Temperature appears only for providers
that accept it." Before this change the model tier, effort, timeout (`timeout_minutes`) and
max turns were per specialist in the registry frontmatter; `max_tokens` was a constant per call
site (the loop's 4096, the intake's 16000, the chat's 400, the critic's 8192); there was no
speed mode; temperature was never sent by the Anthropic adapter, but nothing let a screen or
the loop know which providers accept one. The agent row's `model_config` column existed and was
always `{}`. Spec D.20 (Opus fast mode per project, "API only, priced separately") is being
built on another branch (`wave/w2-d20-fastmode`, ADR 0057 there) with the request parameter
`speed: "fast"`, the beta header `fast-mode-2026-02-01`, a `fast_mode` project setting and a
fast-mode price row. Open points: where the defaults for max tokens, speed mode and timeout
live; where a per-agent and a per-specialist override is stored and who may change it; how a
provider says what it accepts; and how a specialist's speed preference and the project's
fast-mode switch combine without either branch breaking the other.

## Decision

1. **The effort table carries the D.4 columns.** `ModeDefault` (`models/ladder.ts`) gains
   `maxTokens`, `speedMode` and `timeoutMs` per mode, with the numbers the code already used:
   voice and chat 400 tokens and 30 s, routing 1024 and 30 s, planning 16000 and 5 min,
   coding and research 4096 and 30 min, critic tier 1 8192 and its 30 s target, tiers 2 and 3
   8192 and 10 min; `speedMode` is `standard` in every row (fast is asked for, never assumed).
   Making them settings changed no run. The model watch's adopted efforts flow through the
   same table (`EffectiveModelConfig.modeDefaults`), so a default shown is the default in force.
2. **Specialist frontmatter gains three optional keys**: `max_tokens` (1 to 128000),
   `speed_mode` (`standard | fast`) and `temperature` (0 to 1); `timeout_minutes` gains an upper
   bound (1440). Absent means "the table's row of the specialist's mode" (`specialistMode`:
   the researcher the research row, everyone else the coding row), never a copied number, so a
   change to the table reaches every specialist that did not opt out. The loader reports a bad
   value with the file and the field; a proposal writes only the keys it names.
3. **Overrides live on the agent row, not in the registry.** `agent.model_config` is
   `{ modes?: { planning?, text_chat? }, specialists?: { <name>: … } }`, each entry the same
   optional keys (`tier`, `effort`, `max_tokens`, `speed_mode`, `timeout_minutes`,
   `temperature`). The principal's `modes` apply to its own runs (the intake's planning call,
   the chat turns that speak for it); `specialists` to the specialists it delegates to. A
   registry file is shared content with a prompt version; a human's preference is not, so it
   never forces a new version. Other top-level keys are kept for later features. A document
   that does not validate is ignored whole with a warning on the run, never applied half-way.
   The critic's model and effort stay with its review tiers (spec H, `pickCriticModel`); the
   screen shows them read-only.
4. **One resolver, one order.** `resolveRunSettings` (`models/run-settings.ts`, browser-safe)
   returns the value in force, its source (`table`, `specialist`, `agent`) and the default
   without the override, for the executor, the intake, the chat and the settings view alike.
   Effort keeps the table's risk rules (coding at tier 2+ high): an agent's effort replaces the
   table's base, not the rule.
5. **Provider capability flags.** `ModelProvider.capabilities?: { acceptsTemperature,
   fastMode }`, read through `providerCapabilities()` (absent: neither). The loop sends
   `temperature` only when `acceptsTemperature` and `speed` only when `fastMode`; the settings
   view carries a temperature only when the flag is true (absent, not null, otherwise) and the
   UI has no column; `model.settings.set` refuses to store a temperature the provider would
   drop. The Anthropic adapter declares `acceptsTemperature: false` and `fastMode` true on an
   API key, false on a subscription token. The testenv `FakeProvider` takes either in its
   options so tests cover both kinds of provider.
6. **Speed mode is a preference; the project's leave and the price decide (composition with
   D.20).** A run goes fast only when all hold (`decideSpeed`): the resolved speed mode is
   `fast`; the project allows fast mode, read from `project.settings.fast_mode === true`, the
   key D.20 owns and writes (this change only reads it); the rung is Opus; the driver is the
   loop with no source or an API-style one (subscription and plan credits are "API only", D.20's
   rule); the provider declares `fastMode`; and a fast-mode price exists for the model
   (`fastModePricing`, then used to price the run; a run is never priced from a guess). The
   request carries `speed: "fast"`, the parameter name D.20 uses, and the Anthropic adapter adds
   the same beta header and repeats the API-key and Opus checks. Otherwise the run is standard
   and the session log names the reason. Until D.20's price row is wired the daemon passes no
   `fastModePricing`, so fast preferences stay standard in production and say so. **When the
   two branches meet**: D.20's per-project decision (`decideFastMode`, the variant id on the
   Run row, its pricing and audit row) stays the one place a run is made fast; its `enabled`
   input becomes "the project's `fast_mode` is on **and** the run's resolved speed mode is
   `fast`", and the effort table's `standard` default means a project that turns fast mode on
   must also name which agents or specialists go fast (the urgent work D.20 is for) — the
   human opts in twice, once for the permission and once for the work, and neither switch alone
   spends the surcharge. `ModelRequest.speed` and `SpeedMode` are the same type on both
   branches; the provider flag D.20 calls `fastMode` is `capabilities.fastMode` here.
7. **The write path is the command registry.** `model.settings.set { agent?, mode? |
   specialist?, field, value }` writes one field of the principal's `model_config` (null
   removes it), with a change card (medium for a non-null rung or effort and for fast, low
   otherwise), a change log row and an undo, from the settings screen, chat or voice alike
   (spec Q.1, ADR 0037 point 4). Only the human's own principal is changed; an unknown
   specialist is `not_found`. The daemon serves `GET /settings/models` (in `DAEMON_ROUTES`,
   schema `ModelSettingsView` in `api-types.ts`), and the UI's Settings page has a "Models per
   agent and specialist" section over it.

## Consequences

- Every per-call output cap and run timeout is now a setting with a visible default and a
  source; tests assert the request's `max_tokens`, `temperature` and `speed` per case.
- The model watch can later adopt max tokens or speed defaults the same way it adopts efforts
  (`models.json`), without touching agents or specialists.
- A fast preference is inert until D.20's price row exists, and visibly so (a warning per run).
- The Agent SDK path takes rung, effort and timeout but has no per-call output cap or speed
  parameter; the critic's output cap and model are not overridable per agent. Both are named
  in runtime.md's known issues.
- The commands package imports the schemas by deep path (`@forerunner/runtime/models/
  run-settings`), because the runtime imports commands and its index is half-initialised at
  that point.

## Amendment (independent review, 2026-10-23)

The review of this item (`docs/status/reviews/w3-d4-specialist-settings.md`) added three rules
the settings must keep, so no override steps over a limit the rest of the runtime keeps:

- **A run is priced as the model it calls.** The executor, the intake and the chat take a
  `pricingFor(modelId)` port (the daemon: the price table in force), so an agent's `tier`
  override reaches the budget hooks' estimate and the recorded cost; before, the intake and the
  chat were priced at the table's rung and a specialist's loop run at the sonnet rung.
- **A specialist never runs above its `max_effort`.** The executor caps the effort after the
  table's risk rules, the project slider and the agent's override (warning when the cap bites);
  `model.settings.set` refuses a higher override (`CommandPorts.modelSettings.maxEffort`); the
  view and the screen show and offer only what can run. The file's `default_effort` stays
  validated but is not a run's base: spec D.4 names the effort table as the default (point 4).
- **The rung stays under the ladder ceiling.** `resolveRunSettings` takes a `ceiling`; the intake
  passes the project's (`critic_ceiling`, default Opus), the chat the default ceiling, as the
  executor already did through `startingTier`. The top rung needs the explicit project setting
  (spec "Model ladder", D.3), never only an agent's preference.
