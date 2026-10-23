## title

Per-agent and per-specialist settings: max tokens and speed mode from the effort table, temperature only where the provider accepts it

## requirements

D.4 (D.1 to D.3, D.7 to D.15 effort table context)

## adr

0072

## brief

BLOCKERS.md row D.4 per-specialist speed mode, max tokens and the temperature flag: **partly built**: model tier, effort, timeout (`timeout_minutes`) and max turns are per specialist (`registry/types.ts`); `max_tokens` is the loop's per-call default (4096), there is no speed mode, and temperature is never sent (`provider/anthropic.ts`) rather than shown only for providers that accept it. Stand-in: the loop's `maxTokensPerCall` default and the provider's no-temperature rule. Needed: `max_tokens` and `speed_mode` in the specialist frontmatter and the settings UI, a provider capability flag for temperature; then D.4 `done`. Spec D.4: 'Settings per agent and specialist: model, effort, max tokens, speed mode, timeout, with the defaults from the effort table (D.8 to D.15). Temperature appears only for providers that accept it.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read packages/runtime/src/registry/types.ts and the frontmatter parser (specialist.md frontmatter keys, validation), packages/runtime/src/models/ladder.ts (the effort table per mode: defaults for model, effort, and where max tokens / speed mode defaults belong per D.8 to D.15), the agent loop (maxTokensPerCall) and the provider contract (packages/runtime/src/provider/types.ts: add a capabilities field such as `acceptsTemperature`; the Anthropic adapter: temperature never sent, speed mode = the fast-mode request parameter that another builder is adding per project for D.20 on branch wave/w2-d20-fastmode: here speed_mode is the per-specialist 'fast | standard' preference; keep the two composable: a specialist's speed_mode fast only takes effect where the project allows it (coordinate by reading the same request parameter name 'speed' and the same API-only rule, state it in your ADR), the per-agent settings (model_config on the agent row; the adopted model settings of ADR 0039), and the settings UI (apps/ui SettingsPage / ExtensionsPage sections for agents and specialists; ADR 0037 route conventions; the daemon's routes serving and writing them). Build: max_tokens and speed_mode (and temperature where the provider's capability flag says so) in the specialist frontmatter with validation and defaults from the effort table per mode, honoured by the loop's per-call max tokens and by the provider request; per-agent overrides in model_config with the same keys; the settings UI shows model, effort, max tokens, speed mode, timeout per agent and specialist with the defaults from the table and shows temperature only for a provider whose capability flag is true (the fake provider in tests can declare either), writes through the existing settings path with the change log. Tests: registry.test.ts additions (frontmatter parse/validate/defaults), loop/provider tests (max tokens honoured, speed sent, temperature only when accepted), apps/ui/test/settings-models.test.tsx. Docs: adding-a-specialist.md, adding-a-provider.md (the capability flag), runtime.md, apps.md. ADR 0072.

## paths

packages/runtime/src/registry, packages/runtime/src/provider, packages/runtime/src/models/ladder.ts, apps/ui/src/pages, tests
