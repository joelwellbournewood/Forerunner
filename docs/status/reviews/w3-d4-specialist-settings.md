# w3-d4-specialist-settings

Item: per-agent and per-specialist settings (spec D.4): max tokens and speed mode from the
effort table, temperature only where the provider accepts it. ADR 0072.

## Build report

Branch `wave/w3-d4-specialist-settings`, starting commit `1219933`: the earlier attempt's
`wip:` snapshot, whose parent `82a6295` is an ancestor of the named base `e2bfb1e` (the base's
three later merges, w3-b5-reasons, w3-o4-voice-prefs and w4-stale-docs, are not on this branch
and were not merged in; the integration step brings them together). The snapshot's three
files (the provider capability type, the effort-table columns, the adapter's `speed`) were
kept, corrected and finished. The patch is `1219933..HEAD`, nine commits.

### What was built

- **Effort table** (`packages/runtime/src/models/ladder.ts`): every mode carries `maxTokens`,
  `speedMode` and `timeoutMs` beside tier, effort and target, with the numbers the code used
  before (chat 400 tokens and 30 s, planning 16000 and 5 min, coding and research 4096 and
  30 min, critic 8192, its tier-1 target and 10-minute deep review; `standard` everywhere).
  `specialistMode(name)` names the row a specialist's defaults come from. The intake's
  constants now read the table.
- **Specialist frontmatter** (`registry/types.ts`, `registry/proposals.ts`): optional
  `max_tokens` (1 to 128000), `speed_mode` (`standard | fast`), `temperature` (0 to 1);
  `timeout_minutes` capped at 1440. Absent keys fall back to the table. Proposals write only the
  keys they name. `specialistSpecFrom` copies them onto the executor's `SpecialistSpec`.
- **Provider capability flags** (`provider/types.ts`): `ModelProvider.capabilities?:
  { acceptsTemperature, fastMode }`, `providerCapabilities()` with the defaults (neither). The
  Anthropic adapter declares no temperature and fast mode on an API key only, and sends
  `speed: "fast"` with the beta header `fast-mode-2026-02-01` (D.20's parameter and header,
  exported as `ANTHROPIC_FAST_MODE_BETA` so the two branches do not collide on a name) for an
  Opus id on an API key. The testenv `FakeProvider` takes `capabilities` in its options.
- **Resolution** (`models/run-settings.ts`, browser-safe): `resolveRunSettings` orders the
  effort table in force, the specialist file and the agent's `model_config` override
  (`modes.planning`, `modes.text_chat`, `specialists.<name>`; keys `tier`, `effort`,
  `max_tokens`, `speed_mode`, `timeout_minutes`, `temperature`), returning values, sources and
  defaults; temperature only when the provider accepts one. `parseAgentModelConfig` ignores a
  malformed document whole. `decideSpeed` composes a fast preference with the project's
  `fast_mode` leave (the D.20 key, read only), the Opus rung, the loop driver with an API-style
  source, the provider's `fastMode` flag and a fast-mode price.
- **Honoured in runs**: the loop (`agent/loop.ts`) sends `max_tokens` from the run, a
  `temperature` only to a provider that accepts one and `speed` only to one with fast mode; the
  executor (`session/executor.ts`) resolves per run (rung into `startingTier`, the agent's
  effort as the table's base before the risk rules, max tokens, the timeout for the brief, run
  token, sandbox lease and driver, temperature, speed with the fast price via the new
  `fastModePricing` dep and a `{ speed: "fast" }` artifact on the Run row, a warning naming the
  reason when fast is not applied); the intake (`session/intake.ts`) and the chat
  (`conversation/agent.ts`) run at the principal's planning and chat settings.
- **Write path**: `model.settings.set` (`packages/commands/src/commands/model-settings.ts`)
  changes one field of the principal's `model_config` (null back to the default), validated,
  with a change card (medium for a rung, an effort, or fast), a change log row and an undo; the
  human's own principal only, the critic refused, an unknown specialist `not_found`, a
  temperature refused where the provider accepts none. Ports `CommandPorts.modelSettings`
  wired in `compose.ts`.
- **Daemon route**: `GET /settings/models` (`DAEMON_ROUTES.modelSettings`, schema
  `ModelSettingsView` in `api-types.ts`, builder `daemon/model-settings-view.ts`): provider
  flags, the effort table, the principal's planning and chat modes, the critic's review modes
  (read-only), every runnable specialist; `temperature` present only when the flag is true.
- **UI** (`apps/ui/src/pages/ModelSettingsSection.tsx`, `SettingsPage.tsx`, `api/client.ts`):
  Settings → "Models per agent and specialist": Model, Effort, Max tokens, Speed mode, Timeout
  per agent mode and specialist with each value's source and default; a Temperature column
  only when the provider accepts one; a click opens the shared change dialog (selects for the
  lists, a "default" entry) running `model.settings.set`; the route-missing state on an older
  daemon. The fake daemon serves the route and the command (`acceptsTemperature` option).
- **Docs**: ADR 0072 (indexed); adding-a-specialist.md, adding-a-provider.md (the capability
  flag), runtime.md, commands.md, apps.md, testing.md; requirements.md D.4 `done` with its
  tests; BLOCKERS.md D.4 row (built, the D.20 residual) and V.1 counts; PROGRESS.md log entry,
  milestone counts and handover item 3.

### Tests that prove it

- `packages/runtime/test/registry.test.ts` (34 tests, 4 new): the three keys parse and stay on
  the definition; unset in the ten repository specialists so the table's row applies; each
  out-of-range value reported with its field; a proposal round-trips them.
- `packages/runtime/test/run-settings.test.ts` (12, new): the resolution order with sources and
  defaults, an adopted effort, temperature only with the flag, `model_config` parsing,
  `decideSpeed` per condition, the `fast_mode` key, the default flags, the settings view.
- `packages/runtime/test/run-settings-runs.test.ts` (12, new): the loop's max tokens (and 4096
  default), temperature only to a `FakeProvider` declaring it, speed only to one with fast
  mode; the executor's table defaults, the file's max tokens and temperature, the agent's
  override of rung, effort, max tokens and timeout, a malformed config warned, fast sent and
  priced at the fast row (6x for the same tokens) and standard with the reason without the
  project's leave, off Opus, without a price, on a provider without fast mode; an agent's
  `speed_mode` turning fast on and off.
- `packages/runtime/test/anthropic-provider.test.ts` (7, 2 new): the adapter's flags per
  credential; `speed` and the beta header on an API key and an Opus id only.
- `packages/runtime/test/conversation.test.ts` (16, 1 new): a chat turn at the table's 400 and
  low, then at the principal's `modes.text_chat` override, no temperature to the fake.
- `packages/runtime/test/model-settings-routes.test.ts` (5, new, through `composeRuntime` and
  the daemon app): the route, the view with the ten specialists, a UI change in the change log
  and undone, a pending rung change, refusals, the temperature flag both ways.
- `packages/commands/test/model-settings.test.ts` (4, new): set, undo, reset, risks, refusals,
  the temperature port.
- `apps/ui/test/settings-models.test.tsx` (7, new): values with sources and defaults, the
  temperature column hidden and shown by the provider's flag, a change through the dialog
  posting `model.settings.set` with source `ui`, the speed select with a medium card, the
  parameter mapping, the route-missing state.

### Commands run and results (2026-10-23, on the build box, Node 22, pnpm 10.28)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | exit 0 (node packages and apps) |
| `pnpm lint` | exit 0; 59 warnings, all pre-existing (the 5 in files this item touched are on lines it did not write: `noNonNullAssertion` in `anthropic.ts:126` and the old adapter tests) |
| `pnpm exec vitest run --project unit packages/runtime/test` | 117 files passed, 1020 tests passed, 1 skipped |
| `pnpm exec vitest run --project unit packages/commands/test` | 10 files, 134 tests passed |
| `pnpm exec vitest run --project unit testenv/test` | 10 files, 142 tests passed |
| `pnpm --filter @forerunner/ui test` | 43 files, 259 tests passed |
| `pnpm exec vitest run --project unit scripts/closeout-docs.test.ts` | 19 passed, 1 todo (ADR template and index) |
| `node scripts/docs-check.mjs --base 1219933` (the starting commit) | `docs-check: ok (44 files)` (38 before the report and the status rows were committed) |
| `node scripts/docs-check.mjs` (no base) | cannot diff against `origin/main` (no such ref in this clone), "nothing to check"; hence the run with `--base` above |
| `node scripts/link-check.mjs` | `link-check: ok (107 files)` |
| `git apply --check` of the exported patch on a clean worktree of `1219933` | applies cleanly |
| `pnpm check` | exit 0: lint, lint:paths (993 files ok), typecheck, unit tests (273 files, 2713 passed, 4 skipped, 1 todo), docs:check (same `origin/main` note), docs:links (106 files ok), secrets:scan (clean, 1417 files) |

No test needed a re-run for a timeout under load. The runtime's only integration file
(`sandbox.integration.test.ts`) is untouched by this item and was not run (it wants a
container engine).

### Left open, and why

- **Fast mode is inert in production until D.20 merges.** A run goes fast only with a
  fast-mode price (a run is never priced from a guess); the price table has no fast row before
  D.20, so the daemon passes no `fastModePricing` and a `speed_mode: fast` preference runs
  standard with a per-run warning naming the reason. ADR 0072 point 6 states the integration:
  D.20's `decideFastMode` stays the one place that makes a run fast, its `enabled` becomes
  "project `fast_mode` on and the run's resolved speed mode `fast`", its price row feeds
  `fastModePricing`; `ModelRequest.speed` and `SpeedMode` are the same on both branches. The
  BLOCKERS row carries this residual.
- **The critic** keeps its review-tier rules (spec H): the screen shows its two modes
  read-only; its 8192-token cap equals the table's row but is still the critic package's own
  default, not read from the table (the critic package was outside this item's paths).
- **The Agent SDK path** takes the rung, effort and timeout; it has no per-call output cap or
  speed parameter to pass.
- **Planning and chat never go fast** (no fast-mode price on those paths either).
- Independent review and the merge are the next stages.

## Review

Reviewer: independent adversarial review (managed agent), 2026-10-23, of `1219933..a4a4e61`
on `wave/w3-d4-specialist-settings` against the brief, the spec (D.3, D.4, D.8 to D.15, the
"Model ladder" open decision), ADR 0072 and the base `ccr-4d8a843c-1k9syk` at `f1948dd`.

Verdict: **revise**. Score: **68/100**. The resolution order, the capability flags, the speed
composition with D.20 and the write path are sound and well tested; but a model override is
priced at the table's rung (the budget hooks under-estimate an Opus chat turn 40-fold), two
realistic paths let a setting step over a limit the rest of the runtime keeps (a specialist's
`max_effort`, the ladder ceiling), and the branch does not merge cleanly with the base.

### Requirements checked

- [x] `max_tokens`, `speed_mode`, `temperature` in the specialist frontmatter, validated, optional,
  defaults from the effort table per mode (`registry/types.ts`, `ladder.ts`, `registry.test.ts`).
- [x] Provider capability flag for temperature (`ProviderCapabilities.acceptsTemperature`, plus
  `fastMode`); the Anthropic adapter declares none and never sends one; the fake declares either.
- [x] The loop's per-call `max_tokens` honoured from the run; `temperature` sent only when accepted;
  `speed` sent only to a provider with fast mode (`run-settings-runs.test.ts`).
- [x] Speed mode composable with D.20: the same parameter `speed`, the same beta header, the same
  API-only rule, `project.settings.fast_mode` read only, stated in ADR 0072 point 6.
- [x] Per-agent overrides in `model_config` with the same keys, written by `model.settings.set`
  with a card, a change log row and an undo, own principal only.
- [x] Settings UI shows model, effort, max tokens, speed mode, timeout per agent mode and
  specialist with defaults and sources; temperature column only when the flag is true.
- [~] Effort per specialist: the override ignores the specialist's `max_effort` (finding 1).
- [~] Model per agent: the principal's mode override ignores the ladder ceiling (finding 2).
- [x] Docs: adding-a-specialist.md, adding-a-provider.md, runtime.md, apps.md, commands.md,
  testing.md, ADR 0072 indexed; requirements D.4 `done`; BLOCKERS and PROGRESS rows.
- [ ] A changed model is priced as that model (finding 6).
- [~] Merge with the base: textual conflicts in five files (finding 5).
- Ran: `pnpm typecheck` (exit 0); the eight D.4 test files (7 runtime/commands files, 90 tests
  passed); a trial merge of the base into a throwaway worktree, conflicts resolved as a union,
  `pnpm typecheck` exit 0 and 16 files / 206 tests passed (D.4 files, executor, loop-merge,
  conversation, all of packages/commands).

### Findings

1. **medium**: `packages/runtime/src/session/executor.ts:458` (effort), `packages/commands/src/
   commands/model-settings.ts:114`, `apps/ui/src/pages/ModelSettingsSection.tsx` (`OPTIONS.effort`).
   A specialist's `max_effort` is never applied: an agent override `specialists.coder.effort: max`
   (coder's file says `max_effort: high`) is accepted by `model.settings.set`, offered by the
   UI's select, and sent to the provider as `effort: "max"`. `adding-a-specialist.md` says the
   runtime raises effort "never above `max_effort`", and the view even ships `maxEffort` unused.
   Verified with a throwaway executor test (`modelConfig: { specialists: { coder: { effort:
   "max" } } }` → `provider.calls[0].request.effort === "max"`, passed). Needed: the executor
   clamps the run's effort at the file's `max_effort` (with a warning), the command refuses an
   effort above it, the UI lists only the efforts up to it; tests for each.
   Resolution: fixed in cf20e96: the executor caps the run at `SpecialistSpec.maxEffort` (from the file's `max_effort`, wired in `specialistSpecFrom`) after the risk rules, the slider and the override, with a warning; `resolveRunSettings` and the view show the capped value; `model.settings.set` refuses a higher override through the new `maxEffort` port; the UI's effort list stops there (`run-settings-runs.test.ts` "never runs a specialist above its max_effort", fails without the fix with `expected 'max' to be 'medium'`; `run-settings.test.ts`, `packages/commands/test/model-settings.test.ts`, `model-settings-routes.test.ts`, `settings-models.test.tsx` "offers a specialist's effort only up to its max_effort").
2. **medium**: `packages/runtime/src/session/intake.ts:636`, `packages/runtime/src/conversation/
   agent.ts:281`, `packages/runtime/src/models/run-settings.ts` (`resolveRunSettings`). The
   principal's `modes.planning.tier` / `modes.text_chat.tier` override is used as is: `fable` (the
   top rung, above the default ceiling Opus; spec "Model ladder: top tier only by explicit
   project setting", D.3) is accepted by the command and becomes the intake's and the chat's
   model, while a specialist override is capped by `startingTier` under the project ceiling.
   Verified with a throwaway test (`resolveRunSettings({ mode: "planning", override: { tier:
   "fable" } }).tier === "fable"`, passed) and by reading both call sites (`modelIdFor(tier, …)`,
   no ceiling). Needed: the agent modes capped at the ceiling (the project's for the intake, the
   default for the chat), the screen showing the rung that runs; tests.
   Resolution: fixed in 5c779ac: `resolveRunSettings` takes a `ceiling`; the intake passes the project's (`projectCeiling` port, wired to `critic_ceiling` in compose, default Opus), the chat `DEFAULT_CEILING`, and the view shows the agent modes capped (`intake.test.ts` "keeps the principal's planning rung under the project's ceiling" and `conversation.test.ts` "never runs above the default ceiling", both fail without the fix; `run-settings.test.ts` resolver and view cases).
3. **low**: `docs/maintainers/adding-a-specialist.md:57`, `docs/decisions/0072-...md` point 4. The
   doc says nothing about `default_effort` not being a run's base: since before this item the
   executor takes the effort table row (so the model watch's adopted effort applies), and the new
   screen shows e.g. data-analyst at "medium, effort table" while its file says `default_effort:
   high`. A maintainer reading the field table expects the file's value. Verified by reading
   `effortForTask` and `grep default_effort packages/runtime/src` (only `specialistSpecFrom` copies
   it; nothing reads `SpecialistSpec.defaultEffort`). Needed: state it in the field table and the
   ADR (the spec D.4 asks for defaults from the effort table, so the behaviour stays).
   Resolution: fixed in cf20e96: the `default_effort`/`max_effort` row of adding-a-specialist.md now says a run starts from the effort table's row (spec D.4, the model watch's adoption applies there), that `default_effort` is validated and shown only, and how `max_effort` caps; ADR 0072's amendment (547a0db) repeats it.
4. **low**: `apps/ui/test/fake-daemon.ts:1723` (the `model.settings.set` fake) and
   `apps/ui/test/settings-models.test.tsx` ("changes a specialist's max tokens"). The fake's
   sentence is "Set the max_tokens of the coder specialist …" but the daemon's command says "Set
   the max tokens per call of …" (`MODEL_SETTING_LABELS`), so the UI test asserts a sentence the
   real daemon never produces. Verified by comparing the two strings with
   `packages/commands/test/model-settings.test.ts`. Needed: the fake uses the command's labels.
   Resolution: fixed in 0ec99b2: the fake's `model.settings.set` uses the command's field labels and the UI test asserts "Set the max tokens per call of the coder specialist for Alice from the default to 8000. Undo.", the sentence `packages/commands/test/model-settings.test.ts` asserts for the real command.
5. **low**: `packages/commands/src/types.ts:95`, `packages/runtime/src/daemon/compose.ts:2113`,
   `apps/ui/test/fake-daemon.ts:142`, `docs/maintainers/runtime.md` (Known issues, first entry),
   `docs/maintainers/apps.md:350`. Each addition sits at the same anchor where the base added
   something (`requestAnswered`, `me`, the B.5 known issue, the `settings` test list), so
   merging into `ccr-4d8a843c-1k9syk` stops on five conflicts. No semantic conflict: the union
   typechecks and the tests pass (trial merge above). Needed: move the additions to anchors the
   base did not touch and prove a trial merge is conflict-free.
   Resolution: fixed in 18ac91e and 57a5270: the port, its wiring, the fake's option, the known issue and the test entry moved to other anchors (same content); a trial merge of `origin/ccr-4d8a843c-1k9syk` into the fixed HEAD in a throwaway worktree reported "Automatic merge went well", then `pnpm typecheck` exit 0 and 16 files / 206 tests passed (the D.4 files, intake, conversation, executor, packages/commands); the merge was aborted, nothing of the base is on the branch.
6. **high**: `packages/runtime/src/daemon/compose.ts:1698` (intake pricing), `:2175` (chat
   pricing), `:1578` (executor pricing), with `session/intake.ts:636`, `conversation/agent.ts:281`,
   `session/executor.ts` (the loop run's `pricing`). The run's model now follows the agent's
   `tier` override, but its `RunPricing` does not: the intake is priced at the table's planning
   rung, the chat at the table's text_chat rung, a specialist's loop run at the sonnet rung. A
   human who sets chat to Opus from Settings gets every chat turn's pre-call estimate (the budget
   hook's `beforeModelCall`) and its recorded cost at the Haiku price; the turn budget and the
   ledger are 40 times too low. Verified: `pricingFor(...).estimate(10000, 16000)` is 9000 for
   `claude-haiku-5-5`, 180000 for `claude-sonnet-5-5`, 360000 for `claude-opus-5-5` (throwaway
   test), and the three compose closures read `modelConfig.get().modeDefaults.<mode>.tier` or the
   literal `"sonnet"`, never the run's model. Needed: every loop run priced by the model it
   calls (a `pricingFor(modelId)` port on the intake, the chat and the executor, wired in
   compose), with tests that fail when a changed rung is priced at the default one.
   Resolution: fixed in 8497291: the executor, the intake and the chat take `pricingFor(modelId)`, wired in compose to `livePricing(provider, () => model)` over the price table in force; `model-settings-routes.test.ts` "prices a chat turn as the rung the human chose" (composed daemon, provider named `anthropic`: a turn after `model.settings.set` to Opus costs `pricingFor("claude-opus-5-5")`, fails without the compose change with `expected 350 to be 14000`), plus unit tests in `run-settings-runs.test.ts`, `conversation.test.ts` and `intake.test.ts` that fail without the port.

### After the fixes

All six findings fixed; verdict for the fixed branch: accept. Checks on the fixed HEAD:
`pnpm typecheck` exit 0; `pnpm lint` exit 0 (59 warnings, the pre-existing count);
`pnpm exec vitest run --project unit packages/runtime/test` 117 files, 1030 passed, 1 skipped;
`packages/commands/test` 10 files, 135 passed; `testenv/test` 10 files, 142 passed;
`pnpm --filter @forerunner/ui test` 43 files, 260 passed; `node scripts/docs-check.mjs --base
origin/ccr-4d8a843c-1k9syk` ok (46 files); `node scripts/link-check.mjs` ok (107 files).

## Rebase

Stage REBASE, 2026-10-23: `wave/w3-d4-specialist-settings` (start `21ca992`) rebased with
`git rebase origin/ccr-4d8a843c-1k9syk` onto the release head `cac6fee`, which had merged,
since the branch's base `82a6295`, among others D.20 Opus fast mode (`22982fa`, ADR 0057),
w2-chat-memory, w2-s32-indicator, w2-s12-unlock-card, w3-e1-triggers and w4-fcm-sender. No
merge of the base; the series is the branch's commits replayed, two fixups squashed into the
commits whose resolution they repair, and two new commits (the tests against D.20's names, the
docs after the rebase).

### Conflicts and how each was resolved

| Commit (original) | File | Resolution |
| --- | --- | --- |
| `1219933` wip | `models/ladder.ts` | both imports: D.20's `canonicalModelId, fastModeBaseId` and D.4's `SpeedMode` |
| `1219933` wip | `provider/types.ts` | one `SpeedMode` (same type on both sides) documented for D.4 and D.20; D.20's `ModelProvider.fastMode` kept as the one fast-mode flag; D.4's `capabilities` narrowed to `ProviderDeclaredCapabilities { acceptsTemperature }`, `providerCapabilities(p)` returns `{ acceptsTemperature, fastMode: p.fastMode === true }`; the `speed` doc merged |
| `1219933` wip | `provider/anthropic.ts` | doc comment merged; D.20's `FAST_MODE_BETA` import kept and the wip's duplicate constant dropped; D.4's API-key-and-Opus gate (`fastModeApplies`) kept on D.20's `params.speed`; `fastMode` became a getter (`true` on an API key, D.20's tests construct with one) |
| `583cd5d` flags | `provider/anthropic.ts` | `ANTHROPIC_FAST_MODE_BETA` → D.20's `FAST_MODE_BETA`; `capabilities` returns `{ acceptsTemperature: false }` beside the `fastMode` getter. Not conflicted, adapted: the testenv `FakeProvider` sets `fastMode` from `capabilities.fastMode` in its options (an own field, so D.20's `Object.assign(provider, { fastMode: true })` still works) |
| `432a9b7` honour | `agent/loop.ts` | D.20's `recordedModel` (variant on the Run row and `run_start`) kept with D.4's `temperature` and the drop of `speed` for a provider without `fastMode` |
| `432a9b7` honour | `session/executor.ts` | imports of both; **D.20's `decideFastMode` is the one decision**: it takes the new optional `speedMode` (only when the file or the agent set one, `explicitSpeedMode`); D.4's `decideSpeed`, `projectAllowsFastMode` and `fastModePricing` removed; pricing D.20's `loopPricing(runModel, fast)`; `temperature` and `maxTokensPerCall` kept; a `fast` preference the project or the rung does not grant warns via `speedPreferenceNote`; the `{ speed: "fast" }` artifact follows `fast.kind === "applied"`. Not conflicted, adapted: `models/fast-mode.ts` (`speedMode` input, `standard` → ignored with its reason) and `models/run-settings.ts` (`explicitSpeedMode`, `speedPreferenceNote`, `PROJECT_FAST_MODE_KEY` kept equal to `FAST_MODE_SETTING`) |
| `434db1a` command | `commands/index.ts` | both commands exported and registered (`memory.record`, `model.settings.set`) |
| `434db1a` command | `commands/types.ts` | both command names; ports `requestAnswered`, `pricingTable` (base) and `modelSettings` (D.4); both imports (a lost comment opener fixed in a squashed fixup) |
| `434db1a` command | `daemon/compose.ts` | ports `requestAnswered`, `memory` (base) and `modelSettings` (D.4) |
| `e4eba79` UI | `SettingsPage.tsx` | D.20's `FastModeCard` and D.4's `ModelSettingsSection`, in that order |
| `e4eba79` UI | `test/fake-daemon.ts` | options `me` and `acceptsTemperature`, state `runnerKeys`, `fastMode`, `desktop` and `modelSettings`, `acceptsTemperature` (a lost comment opener fixed in a squashed fixup) |
| `55f1e54` docs | `adding-a-provider.md` | the base's stream and fast-mode paragraphs and D.4's capability flags in one list (flags read through `providerCapabilities`, fast mode = D.20's `fastMode`); steps renumbered 1 to 8 with both the temperature flag and the optional fast mode; both test paragraphs; both known issues |
| `55f1e54` docs | `apps.md` | the fast-mode card paragraph and the model-settings paragraph; the monthly-jobs and the D.4-field sentences in one bullet; the base's longer `settings` test entry then `settings-models` |
| `55f1e54` docs | `commands.md` | the `memory.record` and `model.settings.set` rows and paragraphs; `fast-mode.test.ts` and `model-settings.test.ts` in one sentence; count set to the real 11 files / 155 tests |
| `55f1e54` docs | `runtime.md` | the base's `tierOfModel` sentence kept; the D.4 speed paragraph rewritten for the D.20 composition; both test paragraphs; the base's known issues kept and the D.4 one rewritten (no "until D.20 lands") |
| `7fff9e7` status | `decisions/README.md` | 0067, 0068, 0072, 0075 in number order |
| `7fff9e7` status | `BLOCKERS.md` V.1 | one row with both clauses (S.32 and D.4), counts re-read from requirements.md: 186 / 37 / 5 |
| `7fff9e7` status | `PROGRESS.md` | phase 8 row with both clauses; both sides' log entries; handover item 3 with both sides' item notes |
| `f3e4080` finding 6 | `daemon/compose.ts` | the executor's `pricingFor` is D.20's (`pricingForProvider` over the table in force, the variant included), the same intent; D.4's intake and chat `pricingFor` (not conflicted) kept |
| `f3e4080` finding 6 | `session/executor.ts` | one `pricingFor` dep (same name and shape on both sides) with both docs; `pricing: this.loopPricing(runModel, fast)` |
| `f3e4080` finding 6 | `test/conversation.test.ts` | setup options `docs`, `retrieval`, `prompt` (base) and `agentDeps` (D.4); deps spread last |
| `f3e4080` finding 6 | `runtime.md` | the pricing paragraph naming both wirings, then the D.20 speed paragraph |
| `34e6c46` findings 1, 3 | `session/executor.ts` | the fast decision as above, then D.4's `max_effort` cap |
| `34e6c46` findings 1, 3 | `apps.md` | the base's `settings` entry, `settings-models` (8) |
| `7843076` finding 5 | five files | **skipped**: a pure move of D.4 additions away from the base's anchors to make a merge conflict-free; after the rebase the union already sits in place, so the commit had nothing left to do |
| `581bb0c` finding 5 | `runtime.md` | the reconciled D.4 known issue moved beside the model-settings one, as the commit intended |
| `1df8dae` status | `PROGRESS.md` | handover item 3 with both sides' notes |

### After the rebase

- `pnpm typecheck` exit 0 (run before any formatter); `pnpm lint` exit 0 (59 warnings, none
  new).
- `pnpm exec vitest run --project unit packages/runtime/test`: 131 files, 1180 passed, 1
  skipped (`fast-mode.test.ts` 16 and `fast-mode-wiring.test.ts` 2 of D.20 among them,
  `run-settings.test.ts` 16, `run-settings-runs.test.ts` 15, `anthropic-provider.test.ts` 11,
  `model-settings-routes.test.ts` 6, `registry.test.ts` 34, `conversation.test.ts` 26,
  `intake.test.ts` 13).
- `packages/commands/test` 11 files, 155 passed; `packages/critic/test` 14 files, 116 passed;
  `packages/billing/test` 10 files, 92 passed; `testenv/test` 10 files, 142 passed;
  `pnpm --filter @forerunner/ui test` 47 files, 306 passed.
- `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok.
- No base test was changed. Intermediate commits of the series do not all typecheck (the
  test files of `b6030de` and the review commits still name `decideSpeed` until the
  "tests, ui: the D.4 speed tests against D.20's decideFastMode" commit); the head does.
