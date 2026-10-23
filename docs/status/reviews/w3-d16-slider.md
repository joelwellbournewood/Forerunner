# w3-d16-slider

Item: the speed-versus-quality slider moves every mode's effort one step and shows as a slider in
Settings (spec D.16, with D.7 as context). Stage: BUILD. Branch `wave/w3-d16-slider`, starting
commit `759e1b7` (the earlier attempt's `wip:` snapshot on top of `82a6295`). The base named for
the item is `ccr-4d8a843c-1k9syk` at `e2bfb1e`; I did not merge it in.

## Build report

### What was built

The earlier attempt's `wip:` snapshot held most of the runtime wiring. I read it, kept it, tested
it and finished it:

- **Runtime (`packages/runtime`)**
  - `models/ladder.ts`:
    - `EffortOffset` is the type for -1 / 0 / +1.
    - `speedQualityOffsetOf(settings)` reads the setting. Any value other than -1, 0 or +1 counts as balanced, which is also how the critic reads it.
    - `modeEffort(mode, offset, defaults)` takes a mode's effort from the table in force and moves it one step. The move stops at both ends of the effort scale.
  - `session/executor.ts`: the static `effortOffset` dependency is gone. That was the gap: `compose.ts` never supplied it. The effort now comes from the project row the executor loads on every run (coder, researcher).
  - `conversation/agent.ts`: each turn reads the active project's row.
    - A turn with `source: "voice"` uses `voice_chat`'s default effort. Every turn the voice bridge sends has that source.
    - A typed turn uses `text_chat`'s default.
    - The model rung does not change. Only the effort moves.
  - `session/intake.ts`: the planning effort is moved by the project's slider at each `propose`, i.e. once per planning session.
  - The critic already read `speed_quality_offset` before each review (`criticSettingsOf`) and is unchanged.
  - `daemon/server.ts`: `GET /settings` now has a `project.speed_quality_offset` row for each project, showing the value the modes read.
  - `daemon/compose.ts`: a comment states that the offset is not a dependency and names where each mode reads it.
- **Commands (`packages/commands`)**
  - `speed_quality_offset` now only accepts -1, 0 and +1. Before it accepted -2 to +2, but the runtime only ever moves one step.
  - It has an `effect` sentence, following the pattern of ADR 0051 item 4, built from `SPEED_QUALITY_EFFECT` and `speedQualityEffect`. The change card's new value and the change log sentence say what the new position does, in both directions. Example: "Set the speed-versus-quality slider for Game from 1 to -1: speed, every mode's default effort one step lower (faster and cheaper) from the next run, turn or planning session. Undo."
- **UI (`apps/ui`)**
  - `SettingsPage.tsx` gives the row `inputType: "slider"`, with `SPEED_QUALITY_POSITIONS` (speed -1, balanced 0, quality +1).
  - The change dialog shows `SliderInput`: a range input from -1 to +1 in steps of 1, the three stop names under it (each a button, with `aria-pressed`), what the chosen stop does, and the current position as a hint.
  - The table cell shows the position by name, e.g. "quality (+1)".
  - A move still runs one `settings.set` with `source: "ui"`, and the position is part of the words used.
  - The fake daemon mirrors the daemon's row, the effect sentence and undo.
  - The Performance view is not changed.
- **Docs**:
  - `runtime.md`: new paragraph "The speed-versus-quality slider" under Models, plus updated intake and adopted-settings passages.
  - `commands.md`: the table row, "Add a setting", and a new slider paragraph.
  - `apps.md`: the route row, the slider paragraph under "Commands from the UI", the test list and the how-to.
  - `requirements.md`: D.16 is `done` with its tests listed.
  - `BLOCKERS.md`: the D.16 row says built, review pending.
  - `PROGRESS.md`: a log entry, and the item is taken off the not-started list.
  - No ADR, as the brief says (`adr: none`).

### Tests that prove it

- `packages/runtime/test/effort-offset.test.ts` (7 tests).
  - Pure checks: reading the setting, junk values counting as balanced, every mode at each position, the table in force overriding the built-in table, and the coder's tier-2+ rule.
  - On the composed daemon (fake provider, fake STT and TTS, `sqlite::memory:`), the slider is moved through `POST /commands/execute` the way Settings moves it. For each position in the order 0, +1, -1:
    - a `/chat` turn runs at `text_chat`'s effort moved by the slider (low, low, medium);
    - a voice session's text turn runs at `voice_chat`'s (low, low, medium);
    - `/projects/:id/intake` runs at `planning`'s (medium, high, xhigh);
    - a work session's Run rows show the coder and the tier-1 critic at medium/high/low as the position says.
  - Every move takes effect on the next turn, session or run of the same project with no restart. A task the critic sent back and that runs again after the move also takes the new position.
  - `GET /settings` carries the slider for each project.
  - With the three source files restored to their pre-item versions, 4 of the 7 tests fail (chat, voice, planning, runs).
- `packages/commands/test/speed-quality.test.ts` (3 tests): only the three positions are accepted; the card's what, old and new values, risk and sentence; the sentence in each direction (unset→+1, +1→-1, -1→0); the change log rows; undo back to speed; +2 refused with nothing written.
- `packages/commands/test/small-project.test.ts`: its "plain sentence" example used to be the slider. It now uses `notify_channel`, a key with no effect sentence, so the test still checks the same thing.
- `apps/ui/test/settings-slider.test.tsx` (2 tests):
  - The row maps to a three-stop slider behind `settings.set`; out-of-range and fractional values are refused; unset reads as balanced.
  - End to end: the row reads "balanced (0)". Moving the range input to quality posts the body shown in the test, the result and the change log show the quality sentence, and the row then reads "quality (+1)". Clicking the speed stop posts the speed sentence. Undo goes back to quality.
- `apps/ui/test/settings.test.tsx`: updated for the extra fixture row. There are now 5 rows, and the project group holds both keys.

### Commands run and results (2026-10-23, Linux sandbox)

- `pnpm install --frozen-lockfile`: done.
- `pnpm typecheck`: exit 0 (the node packages and the four apps; output below).
- `pnpm lint`: exit 0, 59 warnings. The base had the same 59 warnings before my changes, so none are new (output below).
- `pnpm exec vitest run --project unit packages/runtime/test`: 115 files, 991 passed, 1 skipped (992).
- `pnpm exec vitest run --project unit packages/runtime/test/effort-offset.test.ts`: 1 file, 7 passed.
- `pnpm exec vitest run --project integration packages/runtime/test`: 1 file (`sandbox.integration.test.ts`), 4 skipped because no container engine is available. Not affected by this item.
- `pnpm exec vitest run --project unit packages/commands/test`: 10 files, 133 passed.
- `pnpm --filter @forerunner/ui test`: 43 files, 254 passed.
- `node scripts/docs-check.mjs --base 759e1b7`: ok (18 files). With `--base origin/ccr-4d8a843c-1k9syk`: ok (21 files). Without `--base`, it reports that there is no `origin/main` to diff against and exits 0.
- `pnpm check` (lint, lint:paths, typecheck, all unit tests, docs:check, docs:links, secrets:scan): exit 0. 271 files, 2683 passed, 4 skipped, 1 todo (2688); link-check ok (105 files); secret-scan clean (1410 files).

### Raw output of the gating checks

`pnpm typecheck` (exit 0), the last lines:

```
$ pnpm typecheck
> forerunner@0.1.0 typecheck /workspace/repo
> tsc -p tsconfig.node.json --noEmit && pnpm -r --filter "./apps/*" --if-present typecheck
Scope: 4 of 21 workspace projects
apps/desktop typecheck: Done
apps/mobile typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
typecheck exit 0
```

`pnpm lint` (exit 0). The same 59 warnings appear on the starting commit without my changes:

```
$ pnpm lint
> forerunner@0.1.0 lint /workspace/repo
> biome check .
Checked 1161 files in 2s. No fixes applied.
Found 59 warnings.
lint exit 0
```

`git apply --check` of the exported patch against a clean checkout of the starting commit:

```
$ git format-patch --stdout 759e1b7..HEAD > w3-d16-slider.patch
$ git worktree add /tmp/clean 759e1b7 && cd /tmp/clean
$ git apply --check w3-d16-slider.patch; echo "git apply --check exit $?"
git apply --check exit 0
$ git apply --stat w3-d16-slider.patch | tail -1
 19 files changed, 992 insertions(+), 51 deletions(-)
```

That run covered the five commits before this report update. I repeated the same check on the
final exported `/mnt/session/outputs/w3-d16-slider.patch`, which includes this commit, and it
also exited 0. The final run's output is appended to the exported copy of this report,
`/mnt/session/outputs/w3-d16-slider-report.md`. `git log --oneline 759e1b7..HEAD` lists only
this item's commits. Every commit ends with the trailer
`Claude-Build: managed-agent w3-d16-slider build`.

### Left open and why

- **No independent review yet.** The BLOCKERS.md row says "review pending" and should be dropped once a reviewer accepts the item.
- **The slider has no effect at the ends of the effort scale.**
  - Chat and voice default to low, so speed leaves them at low.
  - A mode at max stays at max under quality.
  - This follows from "one step" and is written down in `runtime.md` and in the blocker row.
- **Chat and voice have no typed phrase for the slider.** By chat or voice the slider is reached through `settings.set` only; `IntentParser` has no pattern for it. The brief did not ask for one.
- **Projects with an old value of ±2.** A project whose settings still hold -2 or +2 from the old schema is read as balanced by the runtime, as the critic already read it. The next move through `settings.set` writes a valid position.
- **`routing` mode has no consumer.** No code path makes a `routing`-mode model call today, so nothing applies the slider there. `modeEffort("routing", …)` is ready for when one exists.
