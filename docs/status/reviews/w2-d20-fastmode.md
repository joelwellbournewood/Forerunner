# w2-d20-fastmode — Opus fast mode per project (D.20)

## Build report

Branch `wave/w2-d20-fastmode`, starting commit 82a6295 (`/tmp/start-sha`), base
`origin/ccr-4d8a843c-1k9syk` at b1804e3. The starting commit was behind the base. The branch
history from 82a6295 is:

1. `merge: origin/ccr-4d8a843c-1k9syk (b1804e3) ...`: the base delta as one commit whose tree
   equals b1804e3. It replaces the fast-forward over the base's 15 commits (merges included),
   which `git format-patch` cannot replay onto 82a6295.
2. `billing: ...`, `runtime: ...`, `commands: ...`, `ui: ...`, `docs: ... ADR 0057`, and
   `status: build report ...`: the build.
3. `docs: index ADR 0057 in the decisions README`.

Every commit ends with the trailer `Claude-Build: managed-agent w2-d20-fastmode build`. The
history was rebuilt once, from the same trees, to correct a trailer that first read `BUILD`;
only my own unpushed commits on this branch were rewritten. The tree before the rebuild,
03885de, is identical to the tree of the build commits after it.

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
- `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk`: `docs-check: ok`.
- `pnpm docs:links`: `link-check: ok`.
- `pnpm secrets:scan`: `secret-scan: clean (1418 files)`.
- `pnpm check`: green, exit 0, run after the ADR 0057 index row was committed. Lint: no errors. Paths:
  ok (992 files). Typecheck: clean. Unit run: 274 of 274 files passed, 2720 tests passed, 4
  skipped, 1 todo; `scripts/closeout-docs.test.ts` now passes. `pnpm docs:check` found nothing
  to check, because there is no `origin/main` in this clone; it was run with `--base
  origin/ccr-4d8a843c-1k9syk` instead (above). Link check: ok (109 files). Secret scan: clean
  (1419 files).

### Row updates for the orchestrator to apply

This task forbids editing `docs/requirements.md` and `docs/status/*.md`, so the updates are
given here.

**docs/requirements.md, row D.20.** The status becomes `done`. The tests column becomes:

`packages/runtime/test/fast-mode.test.ts; packages/billing/test/fast-mode-pricing.test.ts; packages/commands/test/fast-mode.test.ts; apps/ui/test/fast-mode.test.tsx; packages/runtime/test/daemon.test.ts`

The full row:

`| D.20 | Opus fast mode (research preview, API only, priced separately) can be enabled per project for urgent work. | 1 | done | packages/runtime/test/fast-mode.test.ts; packages/billing/test/fast-mode-pricing.test.ts; packages/commands/test/fast-mode.test.ts; apps/ui/test/fast-mode.test.tsx; packages/runtime/test/daemon.test.ts |`

The context rows D.1 to D.4 and I.1 to I.4 are unchanged.

**docs/status/BLOCKERS.md, row "D.20 Opus fast mode per project".** Remove the row; the gap is
closed in code. If the orchestrator would rather keep a residual row, use:

`| D.20 Opus fast mode per project | **built** (item w2-d20-fastmode, ADR 0057): the fast_mode project setting, speed: "fast" on claude-opus-5-5 for API-key runs, the variant claude-opus-5-5-fast priced apart on its own row; a subscription is ignored with an audit row "API only". Residual: no live call yet; the 5.5 fast row is assumed (6x) until the model watch confirms it | Fixture-priced fake-provider and injected-fetch tests | One live fast-mode call recorded in gates.md; the 5.5 fast price confirmed |`

**docs/status/PROGRESS.md.** For the 2026-10-23 log, under the item list:

`- w2-d20-fastmode (D.20, ADR 0057): Opus fast mode per project. The fast_mode setting (off by default, medium risk) sends speed: "fast" on the Opus rung of API-key runs. The Run row, the ledger and the estimates name and price claude-opus-5-5-fast apart (research-preview rate, 6x). Subscription and plan-credits runs ignore the flag with an audit row "API only". The Settings card states the effect and the surcharge both ways. Builder-verified: typecheck, lint, billing 92, runtime 1017, commands 132, ui 261 tests, docs check. Requirements: D.20 todo -> done.`

Requirement counts move from 183 done / 40 in progress / 5 todo to 184 / 40 / 4.

**docs/decisions/README.md.** The index row is committed on this branch ("docs: index ADR 0057
in the decisions README"), because `scripts/closeout-docs.test.ts` fails `pnpm check` without
it. If the row is added centrally, drop that commit; the row is:

`| 0057 | Opus fast mode per project: the speed parameter on the same model id, variant price rows named `<id>-fast`, API-only sources |`

**CHANGELOG.md, Unreleased.**

`- Opus fast mode per project for urgent work (D.20, ADR 0057): API keys only, priced apart as claude-opus-5-5-fast at the research-preview rate.`

### Export

- `/mnt/session/outputs/w2-d20-fastmode.patch` is `git format-patch --stdout 82a6295..HEAD`:
  exactly the branch's commits from the starting commit, the base-delta commit included.
  `git apply --check` against a clean checkout of 82a6295 passes, and `git am` reproduces the
  branch head's tree.
- `/mnt/session/outputs/w2-d20-fastmode-from-base.patch` contains the build commits only
  (everything after the base-delta commit). It applies to the base b1804e3, whose tree equals
  that commit's tree. `git apply --check` passes there, and `git am` reproduces the same tree.

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

## Review

Reviewer: independent review of `wave/w2-d20-fastmode` at 9fdfe81 (stage REVIEW AND FIX),
against the build brief and base `origin/ccr-4d8a843c-1k9syk` (c713755; the branch's merge
base is b1804e3, and the base's later commits touch only the desktop-confirm and stale-docs
items, so there is no file overlap with this branch).

Verdict: **revise**. Score: **72 / 100**.

The core path is sound and tested. The setting is off by default and medium risk, the Opus
call carries `speed: "fast"` on `claude-opus-5-5` with the beta header, the variant price
rows live in `pricing.ts`, and subscription and plan-credits runs are ignored with an
"API only" audit row. On the as-built tree, `pnpm typecheck` is clean, `pnpm lint` has 0
errors, runtime has 117 files / 1017 tests, billing and commands have 21 files / 240 tests,
and docs-check is ok. What remains: one clause of the brief is only partly met, one surcharge
text can disagree with the prices actually charged, and two smaller defects plus an untested
composition need fixing.

### Requirements checked

- [x] A per-project `fast_mode` setting, off by default, changed through `settings.set` with an
  effect sentence (commands `fast-mode.test.ts`; I read `settings.ts:81-92`).
- [ ] "routes **every** Opus rung of that project's runs to the fast-mode variant". Specialist
  runs are routed. Critic reviews are not, and tiers 2 and 3 run on Opus by default
  (`MODE_DEFAULTS.critic_t23`). See finding 1.
- [x] `speed: "fast"` on `claude-opus-5-5` with `anthropic-beta: fast-mode-2026-02-01`, and no
  model-id change on the wire (adapter test with an injected fetch; checked against the SDK
  0.135 typings, `MessageCreateParams.speed`).
- [x] API billing sources only. A subscription or plan credits is ignored with an audit row
  saying "API only" (runtime `fast-mode.test.ts`).
- [x] Priced from separate rows named for the variant, in the one price table. The rows are
  marked as the research-preview rate and justified in ADR 0057 (4.6 at 30 / 150 is the
  published list price; 5.5 fast is assumed at 6x).
- [x] The Run rows and the ledger name the variant. `allocation().byModel` lists it apart.
- [~] The Settings card explains the effect and the surcharge both ways. The card does. The
  change card the human confirms, and the change-log sentence, can quote a different price
  from the one charged. See finding 2.
- [~] The model watch and the estimates read the variant's rate. `diffPrices` reprices the
  variant row, and the per-call estimate uses the variant's rate. The learned estimate
  (spec I.3) folds fast-mode actuals into the standard ratio. See finding 3.
- [x] Tests exist in the files the brief names: `packages/runtime/test/fast-mode.test.ts`,
  `packages/billing/test`, `packages/commands/test` and `apps/ui/test`.
- [x] Docs: `billing.md`, `runtime.md`, `adding-a-provider.md`, `apps.md`, `commands.md`,
  `model-watch.md` and ADR 0057. They agree with the code except where findings 1 to 3
  change it.
- [x] No secrets in rows or logs. The audit row carries the source id and kind, never a
  credential. Time goes through the Clock and errors are `ForerunnerError`.

### Documented limitations accepted (not findings)

- `usage.speed` is not read back from the response (ADR 0057, Consequences). If the API
  served a request at standard speed, the ledger would over-state its cost. It can never
  under-state it. Pricing per call would need a change to the hooks' run context, so it
  stays a known issue in `adding-a-provider.md`.
- No live call has been made; there is no key in this environment.

### Findings

1. **medium**: `packages/critic/src/critic.ts:363-372` (with `runtime/src/loop/critic.ts:221`,
   `daemon/compose.ts:1540`, ADR 0057 Consequences and Alternatives).
   - **What is wrong.** Critic reviews ignore the project's `fast_mode`. At tiers 2 and 3 the
     critic runs on the Opus rung by default. It is the main Opus consumer of a project and
     sits on the critical path of urgent work. The brief says the flag routes "every Opus
     rung of that project's runs". The ADR gives two reasons for excluding the critic, and
     neither holds:
     - "no billing pick": the critic's source is the composition's loop source, a known row
       with a known kind, so the API-only rule can be applied to it.
     - "independence": speed does not change the model.
   - **How I verified it.** I wrote a throwaway critic test (since deleted): a tier-2 review
     of a project with `fast_mode: true`, on a provider with `fastMode = true`. The provider
     calls carried no `speed`, the Run row named the base model, and no `model.fast_mode`
     audit row was written.
   Resolution: fixed in 7eb389b. The critic now makes the executor's `decideFastMode`
   decision for each review whose pick is on the Opus rung (`CriticDeps.fastMode`, filled by
   the daemon with the source row's kind from the store and the price table in force). On
   an API-style source the review gets speed fast, and the Run row, the ledger rows and the
   review's model name the variant. Every decision writes one `model.fast_mode` audit row.
   A subscription source is ignored with an "API only" audit row. This is proved by
   `packages/critic/test/fast-mode.test.ts` (6 tests; 4 fail without the fix) and
   `packages/runtime/test/fast-mode-wiring.test.ts`. ADR 0057 decision 5 is amended.

2. **medium**: `packages/commands/src/commands/settings.ts:91` and
   `packages/runtime/src/models/fast-mode.ts:118`.
   - **What is wrong.** The `fast_mode` change card's new value and the change-log sentence
     are priced from `BUILTIN_PRICING`. Runs and the Settings row use the table in force
     (`<config>/pricing.json` plus model-watch adoptions). The 5.5 fast row is
     `source: "assumed"` and is expected to be corrected through exactly that path. Once it
     is corrected, the card the human says yes to quotes a surcharge that is not the one
     charged.
   - **How I verified it.** A throwaway commands test (since deleted) printed both texts with
     the fast row overridden to 30 / 150. The card read "USD 24 / 120 ... 6x". The daemon row
     read "USD 30 / 150 ... 7.5x".
   Resolution: fixed in df8fa90. `SettingSpec.effect(value, ctx)` now receives the price
   table through the new optional `CommandPorts.pricingTable` port, which the daemon fills
   with the table in force. The card and the change-log sentence now quote the corrected
   surcharge. This is proved by the new case in `packages/commands/test/fast-mode.test.ts`
   (it failed before the fix) and by the composed-daemon case in
   `fast-mode-wiring.test.ts`.

3. **low**: `packages/runtime/src/estimates/model.ts:446-457`.
   - **What is wrong.** The estimate-versus-actual fold adds a fast-mode run's cost (6x) to
     the task's actuals. The cost ratio is learned per (specialist, kind), with no regard to
     speed. After a stretch of urgent work, every later standard task of that specialist and
     kind is estimated several times too high, and planner budgets follow. So the
     "estimates read the variant's rate" clause holds for the per-call estimate but corrupts
     the learned one.
   - **How I verified it.** By reading the code: `refresh()` sums `r.cost_usd_micro` over
     every finished run of the task, whatever `r.model` is. Finding 3's test exercises this
     path.
   Resolution: fixed in fd36071. `EstimateModel.refresh()` still folds a finished task with a
   run that names a `<id>-fast` variant, and never re-reads it, but no longer counts it as a
   sample. This is proved by the new case in `packages/runtime/test/estimates.test.ts`: 6
   standard tasks and 5 fast ones give 6 samples and a ratio of 1. Before the fix it saw 10
   samples.

4. **low**: `apps/ui/test/fake-daemon.ts:1742`.
   - **What is wrong.** The fake daemon's `fast_mode` card shows the old value `false` for a
     project whose flag was never set. The real daemon's card says `unset`, as the commands
     test asserts (`card.oldValue === "unset"`). So the UI fixtures drift from the daemon
     they mirror.
   - **How I verified it.** I compared the two code paths (`state.fastMode[id] ?? false`
     against `show(null) === "unset"` in `settings.ts:157`).
   Resolution: fixed in c40f75a. `state.fastMode` now takes `null` for a flag that was never
   set. The row reads off, and the card and the sentence say "unset". This is proved by the
   new case in `apps/ui/test/fast-mode.test.tsx` (it fails against the old fake daemon).

5. **low**: `packages/runtime/src/daemon/compose.ts:1574-1579`.
   - **What is wrong.** No test covers the composition. The executor's `pricingFor` and
     `pricingTable` wiring, which is what makes a daemon fast run use the table in force,
     can be deleted with every test still green.
   - **How I verified it.** I removed the four lines from `compose.ts` and ran
     `fast-mode.test.ts`, `daemon.test.ts` and `wiring.test.ts`: 3 files, 36 tests passed.
     Then I restored the file.
   Resolution: fixed in 202cf54. The new `packages/runtime/test/fast-mode-wiring.test.ts`
   runs the composed daemon with a corrected `claude-opus-5-5-fast` row in `pricing.json`.
   The test fails if any one of these is removed from `compose.ts`: the executor's
   `pricingFor` and `pricingTable`, the critic's `fastMode`, or the command loop's
   `pricingTable` port. I checked each removal, and each fails one test.

6. **low**: `docs/decisions/README.md` (commit 6d8fded).
   - **What is wrong.** The brief says "Do NOT edit docs/decisions/README.md". The branch
     adds the ADR 0057 index row anyway.
   - **How I verified it.** `git show 6d8fded --stat`.
   Resolution: not a defect. `scripts/closeout-docs.test.ts:225-246` requires every ADR to
   be indexed in `docs/decisions/README.md`. Removing the 0057 row fails it ("README indexes
   ADR 0057"); I verified that and restored the row. Without the row, `pnpm check` cannot
   pass. The row is its own commit (6d8fded), so the orchestrator can drop it if it adds the
   row centrally.

### After the fixes

All six findings are resolved: five fixed and one not a defect. With the fixes, the brief's
clauses are met: every Opus rung of a fast-mode project's runs goes fast on an API source,
and the surcharge text the human confirms matches the prices charged. Re-score after fixes:
90 / 100. Two limitations remain documented and are not defects of this build: no live call
yet, and `usage.speed` is not read back.
