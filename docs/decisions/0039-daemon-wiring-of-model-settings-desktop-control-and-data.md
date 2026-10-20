# 0039 — Daemon wiring of adopted model settings, desktop control and data assets

Date: 2026-10-20
Status: accepted

## Context

Three modules were built and reviewed with ports but not put into the one process the shells
attach to (`composeRuntime`, ADR 0029): the model watch's adopted settings (ADR 0019,
`model-watch.md`), desktop control (ADR 0021, `desktop-control.md`) and files and data
(`data.md`). Each module's doc named its wiring gap. Points neither doc decides:

1. where the ladder and effort table in force live in the process, how an adoption reaches a
   session that starts later without a restart, and what happens when `models.json` is
   malformed;
2. what the desktop gate's binding is built from in the daemon, what adapter a machine without
   desktop tools gets, how the on-screen indicator reaches the shells, who the routes bind the
   allowlist to, and how the capability's routes are mounted;
3. where project data lives on disk, who acts on the Data tab routes, how the data tools reach
   the hooks and the approval port, and whether the gitignore guard has a worktree to run on.

## Decision

### Model settings in force

1. **One holder per process.** `readEffectiveModelConfig` (`src/wiring/model-config.ts`)
   reads `<config>/models.json` through `FileModelSettingsStore` at compose and applies it to
   `builtinModelConfig()`; the result is an `EffectiveModelConfigHolder` whose `get()` every
   consumer calls at the start of a run or a chat turn, never once. `LoopTaskExecutor`
   (`modelConfig` dep) passes its `ladder` to `modelIdFor` and its `modeDefaults` to
   `effortForTask`; `ConversationAgent` (`modelConfig` dep) takes the `text_chat` tier, effort
   and target from it; `CriticLoop` (`modelConfig` dep) hands the critic package `ladder` and
   `modeDefaults` as accessors over the holder, read at every review's pick and when the rung
   a failed run sat on is looked up, so the tier-1 (sonnet) and tier-2/3 (opus) reviews move
   with the executor when a rung is adopted. `RuntimeApp.modelConfig()` exposes it.
2. **An adopt swaps the holder in place.** `ModelWatch.onAdopted` calls `holder.adopt(config)`
   and replaces the pricing table the run and chat pricing closures read
   (`RuntimeApp.pricingTable()`), so the next session runs the adopted rung at the adopted
   effort and is priced at the adopted rows without a restart. The `CostLedger` keeps the
   table it was built with (it prices savings views, not calls) until the next start.
3. **A malformed file never changes a model by accident.** A document that does not parse is
   ignored: one `audit_log` row (`model_settings.read`, `allowed=false`, the file name and the
   parser's message, never the document's content), one warning, and the built-in tables are
   used until the file is fixed or the watch rewrites it. A file with overrides that parses
   leaves one `allowed=true` row naming how many overrides were applied.
4. **The chat and executor model ids come from the ladder, not from a hardcoded name.** The
   old `defaultModelFor`/`chatModelFor` mapping was replaced by `modelIdFor` on the tables in
   force (`rungModelFor` in `compose.ts`, called per run by the pricing closures and the
   chat, never at compose). A provider the ladder does not know throws there, as it does in
   the executor: `ladder.ts` is the one source of model ids, and no string template names a
   model anywhere else.

### Desktop control

5. **The binding per tool call** (`desktopBindingResolver`, `src/wiring/desktop-ports.ts`):
   `enabled` is the `desktop-control` extension row read by name on every call (installed,
   `enabled`, neither pending nor errored; the same rule the extension gate applies), so the
   capability is off until a human installs and enables it in the panel and a toggle shows at
   the next call; `autonomy` is the run's project's `autonomy_level` (the human's
   `default_autonomy` when the run has no project, 0 when neither exists); the allowlist is the
   human's list from `FileAllowlistStore` at `<config>/desktop-allowlist.json` behind
   `GuardedAllowlistStore` (tests inject `MemoryAllowlistStore`): a hand-edited file that is
   not JSON or not an allowlist is a `validation` error naming the file on every tool call and
   on the routes, with one `desktop_allowlist.read` audit row per refused read and a warning,
   never `internal` carrying the parser's message (the file holds no secrets, but a parser's
   snippet is content, not a code); the tools fail closed and the next call reads the file
   again, so a fix needs no restart. `screenshotsToModel` is always false because the runtime
   does not forward image artifacts yet, so no token claims them.
6. **The tools are built-in tools of the daemon**, registered at compose next to the file and
   Cloudflare tools, so every run token lists them, the hooks (allowlist, action classes,
   autonomy, audit) and the extension gate apply as to any tool, and the registry loader knows
   their names. The catalog entry names exactly the six `desktop_*` tools with the classes
   `read` and `non_routine`, because the gate checks a tool's name and class against the
   installed row's permissions and `revokeLive` revokes the tokens that carry them.
7. **No desktop means refusal, not pretence.** `detectAdapter()` runs once at compose; when it
   finds no usable adapter (no display, missing tools, an unsupported platform) the controller
   gets `UnavailableDesktopAdapter`, whose every action throws `not_supported` naming what is
   missing. The gate still runs first, so a disabled capability or a low autonomy level is
   reported as such, and the refusal is an audit row like any other denial. A
   `FakeDesktopAdapter` is never installed in production.
8. **The indicator is a bus event.** `BusIndicator` emits `desktop.indicator` `{ on, agentId,
   sessionId, runId, humanId, app, message, at }` on the runtime bus; `/events` writes it to
   every stream, and a shell shows its banner while `on` is true. `LogIndicator` stays as the
   fallback line. The run's teardown is the executor's `run_end` event, on which the
   composition calls `controller.endRun`; the kill switch and the extension registry are
   attached so a stop or a panel toggle revokes live.
9. **Routes are adapted, not retyped** (as ADR 0038 point 8): `desktopRouteTable` handlers run
   behind the bearer token through a small adapter over Hono's context; the capabilities
   package keeps no Hono dependency. `humanFor` is the daemon's one human, so the allowlist and
   resume routes bind to that human and another human's id answers 403. The daemon's approval
   port for "allow this application for this session" is `HumanRequestDesktopApprovals` over
   `store.humanRequest`, so the request shows in the inbox and raises a notification like any
   other.

### Data assets

10. **Data lives under the install's data dir**: `DataAssets` with `projectsRoot =
    <data>/projects` (`FORERUNNER_HOME` honoured through `dirs`; `ComposeOptions.data` overrides
    it and the limits for tests). Nothing under it is a worktree.
11. **The tools are built-in tools behind the hooks**; `data_register`'s approval port is the
    hooks' own `StateApprovals`, so a path outside the run's allowed roots or a URI is a
    `capability_grant` human request in the inbox, and the data tools' untrusted output is
    wrapped and scanned by the hooks like any other tool output.
12. **The daemon's human acts on the routes.** `createDataRoutes` is mounted at the root with
    `actor: () => ({ humanId })`, so `DELETE /data/:id` always has a human and removal never
    goes through a tool. `worktreeFor` is not set: the daemon's worktrees are per task and
    cloned fresh from the repository, and the data dir lies outside them, so the gitignore
    guard has nothing to protect; it runs when a caller hands the importer a worktree.

## Consequences

- A human's "adopt" in the inbox or the updates screen changes what the next session and the
  next chat turn use, at once; the audit log's `model_watch.reload` row says the runtime took
  it. `fr models watch` composed as a one-shot reads the file at its own start.
- Desktop control is reachable from the panel: install from the catalog, enable, add
  applications to the allowlist in Settings, and at autonomy 3 the six tools work behind the
  hooks and the gate; everything else stays refused in code and audited.
- The Data tab's routes answer on the daemon; the CLI and the UI target the documented shapes.
- `RuntimeApp` grew `modelConfig`, `pricingTable`, `desktop` and `data`; `ComposeOptions` grew
  `desktop` and `data` seams for tests.

## Alternatives considered

- **Re-reading `models.json` at every run start** instead of a holder: a file read per run and
  a second parser path; rejected, the watch already hands over the tables it wrote.
- **Restart after adopt** (the documented workaround): rejected, the module built `onAdopted`
  for exactly this and a restart drops attached shells.
- **A `FakeDesktopAdapter` when detection fails** (the wiring snippet's placeholder): rejected,
  typing into nothing and reporting success is a lie in the audit log.
- **The token's autonomy claim as the gate's level**: rejected, the hooks already applied it
  and the gate's floor is the project's level the spec names; reading the project keeps the
  two layers independent.
- **Per-run registration of the desktop and data tools**: rejected for the reason in ADR 0038
  (the registry loader needs the names at compose and a run's token must list them).
- **A project-level worktree for the gitignore guard**: there is none in the daemon's model
  (worktrees are per task); building one for a guard that protects a directory outside it was
  not worth a new concept.
