# w2-d20-fastmode — Opus fast mode per project (D.20)

## Build report

Branch `wave/w2-d20-fastmode`. The branch was at 82a6295 (`/tmp/start-sha`), which is behind
the base `origin/ccr-4d8a843c-1k9syk` (b1804e3), so the base was merged first; that merge was a
fast-forward. My five commits sit on b1804e3: bcdba52 (billing), 9a317bf (runtime), 9cbc38e
(commands), 6c47c6b (ui), 7b91f3e (docs and ADR 0057), then the commit that adds this report.

### What was built

Spec D.20: "Opus fast mode (research preview, API only, priced separately) can be enabled per
project for urgent work."

- **The setting.** `project.settings.fast_mode` is a boolean and off by default; only a literal
  `true` turns it on. It is changed through `settings.set` with key `fast_mode`, at medium risk
  because it raises what every Opus call of the project costs, so the human must say yes. Its
  `effect` sentence (ADR 0051 item 4) gives the result and the surcharge both ways. On: "Opus
  runs of this project on an API key are requested in fast mode (research preview) at USD 24 /
  120 per million input / output tokens instead of USD 4 / 20, a 6x surcharge; a subscription
  ignores it (API only)". Off: "... go back to the standard speed at USD 4 / 20 ...; the
  fast-mode surcharge (6x, USD 24 / 120) stops". (`packages/commands/src/commands/settings.ts`,
  text from `packages/runtime/src/models/fast-mode.ts`.)
- **The decision per run.** After the billing pick, `LoopTaskExecutor` calls `decideFastMode`
  (`packages/runtime/src/models/fast-mode.ts`). The result is one of three:
  - `off`: the flag is off, or the run is not on the Opus rung. Nothing changes and nothing is
    written.
  - `ignored`, checked in this order: a `subscription` or `plan_credits` source ("API only",
    `fastModeBillable`); the Agent SDK path, which has no speed parameter; a provider without
    `fastMode`; an Opus id with no `<id>-fast` price row.
  - `applied`.

  Applied or ignored, the executor writes one `model.fast_mode` audit row. An ignored run also
  gets a warning in the session log.
- **The parameter.** `ModelRequest.speed` and `ModelProvider.fastMode` were added. The Anthropic
  adapter sets `fastMode = true` and sends `speed: "fast"` on the unchanged model id
  (`claude-opus-5-5`) with `anthropic-beta: fast-mode-2026-02-01`. Without the field it sends
  neither. (`packages/runtime/src/provider/{types,anthropic}.ts`.)
- **Records and prices.** The loop driver (`RunRequest.speed`) records the variant
  `claude-opus-5-5-fast` in `RunContext.model`, so every ledger row carries it, and in
  `run_start`. The executor writes the variant on the Run row and prices the run from the
  variant's row, so both the estimate before each call and the actual cost use the variant's
  rate. `tierOfModel` places a variant on the Opus rung, so the retry ladder is unchanged. The
  daemon now passes `pricingFor(modelId)` over the price table in force. Every loop run is
  therefore priced at its own rung; before this change every loop run was priced at the sonnet
  rung.
- **Price rows** (`packages/billing/src/pricing.ts`, the one place prices live):
  - `claude-opus-4-6-fast` is the published research-preview list price (30 / 150 per million
    tokens, six times 5 / 25).
  - `claude-opus-5-5-fast` is 24 / 120, with cache reads at 1.2 and cache writes at 30: six times
    every price of the `claude-opus-5-5` row. It is marked `source: "assumed"`.
  - Both rows' notes say "research-preview rate".
  - New helpers: `fastModeVariantId`, `fastModeBaseId`, `isFastModeVariant`, `fastModeBillable`,
    `FAST_MODE_SUFFIX`, `FAST_MODE_RATE_NOTE`.

  Because the run's records name the variant, the ledger, `allocation().byModel`, the cost
  views, the estimates and the model watch's `diffPrices` all show it separately from the
  standard rows.
- **The daemon and the UI.**
  - `GET /settings` lists `project.fast_mode` for each project. The row's value is the flag and
    its description is `fastModeDescription(the price table in force)`: what the flag is, plus
    "On: ..." and "Off: ...".
  - The Settings page has an "Opus fast mode" card with that description, each project's state,
    and a Turn on / Turn off button. The button runs `settings.set` through the same change card
    that chat and voice use, so the card shows the effect and the surcharge for the direction
    chosen. (`apps/ui/src/pages/SettingsPage.tsx`; the fake daemon mirrors the daemon.)
- **Docs.** `billing.md`, `runtime.md`, `adding-a-provider.md`, `commands.md`, `apps.md` and
  `model-watch.md` were updated. ADR `docs/decisions/0057-opus-fast-mode.md` records three
  decisions: the parameter, the pricing rows and the API-only rule.

### Tests that prove it

- `packages/runtime/test/fast-mode.test.ts` (16 tests):
  - Flag on: the Opus call carries `speed: "fast"` on `claude-opus-5-5`. The Run row and the
    ledger row name `claude-opus-5-5-fast` at 6x the standard cost. The estimate is at the
    variant's rate, `run_start` names the variant, and the audit row says "applied".
  - Flag off (unset or `false`): nothing changes and there is no audit row.
  - A sonnet run with the flag on: nothing changes.
  - A subscription source: the run takes the SDK path at the standard model with a
    "subscription" ledger row. The audit row says "ignored (API only)" and a warning is emitted.
  - Plan credits: ignored as API only.
  - No billing port: fast mode is applied.
  - A missing variant row: ignored, with the reason.
  - Unit checks: the pure decision, `fastModeOf`, the effect text both ways from the price table
    in force, `tierOfModel` on a variant, the model watch repricing the variant row, and the
    Anthropic adapter's wire form (an injected fetch, with and without `speed`).
- `packages/runtime/test/daemon.test.ts` (extended): the `/settings` fast-mode row is off by
  default, medium risk, has both effects with the rates, and reads `true` after the setting
  changes.
- `packages/billing/test/fast-mode-pricing.test.ts` (8 tests): the price rows, the variant
  naming, costs and estimates at the variant's rate, an override of the variant alone, the
  API-only rule, and the ledger and allocation listing the variant separately.
- `packages/commands/test/fast-mode.test.ts` (2 tests): the setting's spec, and the card and
  change-log sentences both ways, with the yes the medium risk requires.
- `apps/ui/test/fast-mode.test.tsx` (5 tests): the card text both ways, each project's state, no
  card without the rows, Turn on and Turn off through the change card, and the row mapped to
  `settings.set`.

Before the code existed, every new test failed. The runtime and billing files could not import
their modules. With `SettingsPage.tsx` stashed, 4 of the 5 UI tests failed.

### Commands run and results (2026-10-23, Linux sandbox, Node 22, pnpm 10.28)

- `pnpm install --frozen-lockfile`: done.
- `pnpm exec biome check --write <the 18 changed .ts/.tsx files>`, then a second check: no fixes
  applied. One warning remains (`noNonNullAssertion` at `provider/anthropic.ts:111`); it predates
  this branch.
- `node scripts/check-paths.mjs`: `check-paths: ok (992 files)`.
- `pnpm typecheck`: clean (the node project plus desktop, mobile, approvals-web and ui).
- `pnpm lint`: 0 errors (59 warnings, all predating this branch).
- `pnpm exec vitest run --project unit packages/billing/test`: 10 files, 92 tests passed.
- `pnpm exec vitest run --project unit packages/runtime/test`: 117 files, 1017 passed, 1 skipped.
- `pnpm exec vitest run --project integration packages/runtime/test/sandbox.integration.test.ts`:
  1 file skipped, 4 tests skipped (no container engine in the sandbox; unrelated to this item).
- `pnpm exec vitest run --project unit packages/commands/test`: 10 files, 132 tests passed.
- `pnpm --filter @forerunner/ui test`: 43 files, 261 tests passed.
- `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk`: `docs-check: ok (25 files)`.
- `pnpm docs:links`: `link-check: ok (108 files)`.
- `pnpm secrets:scan`: `secret-scan: clean (1418 files)`.
- `pnpm check`: lint, paths and typecheck passed. In the unit run, 273 of 274 files and 2719 of
  2720 tests passed (4 skipped, 1 todo). The one failure is `scripts/closeout-docs.test.ts`
  "every ADR ... is indexed in the README": it expects the index row for ADR 0057 in
  `docs/decisions/README.md`. This task forbids editing that file; the row is added centrally
  and is given below. With the row added locally, the test passed (19 passed, 1 todo), and the
  local change was then reverted.

README index row to add:
`| 0057 | Opus fast mode per project: the speed parameter on the same model id, variant price rows named `<id>-fast`, API-only sources |`

### Export

- `/mnt/session/outputs/w2-d20-fastmode.patch` applies to the starting commit 82a6295.
  `git format-patch` cannot replay the base's merge commits, so I did not export the branch's
  fast-forward history directly. Instead, the first patch in the series ("merge:
  origin/ccr-4d8a843c-1k9syk (b1804e3) ...") carries the base delta as one commit whose tree
  equals b1804e3, and my six commits follow it. `git apply --check` against a clean checkout of
  82a6295 passes. `git am` of the series reproduces the branch head's tree exactly.
- `/mnt/session/outputs/w2-d20-fastmode-from-base.patch` contains only my six commits
  (`b1804e3..HEAD`) and applies to the base b1804e3. `git apply --check` passes, and `git am`
  reproduces the same tree.

### What is left open, and why

- **No live call.** There is no API key in this sandbox, so the real API has not accepted
  `speed: "fast"` on `claude-opus-5-5` yet. The wire form is pinned against an injected fetch.
  The first live run should confirm that the API accepts the parameter and the beta header, and
  record the evidence in `gates.md`.
- **`claude-opus-5-5-fast` is derived, not listed.** It comes from the multiplier published for
  Opus 4.6 fast mode (`source: "assumed"`). The model watch, or a human, confirms or corrects it
  through `pricing.json`.
- **`usage.speed` is not read.** A fast request that the API served at the standard speed would
  still be recorded as the variant. That overstates the cost and never understates it.
- **Critic reviews stay at the standard speed.** This includes Opus reviews at tiers 2 and 3.
  So do intake planning, chat and model watch evals. The critic has no per-task billing pick,
  and its job is an independent check (ADR 0057).
- **The effect sentence uses the built-in prices.** The change card's effect sentence is priced
  from the built-in table, while the Settings row uses the table in force. They differ only after
  an override of an Opus or fast-mode row.
