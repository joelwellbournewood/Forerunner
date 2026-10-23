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
