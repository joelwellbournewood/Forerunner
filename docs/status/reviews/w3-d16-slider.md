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

## Review

Reviewer: independent adversarial review (stage REVIEW AND FIX), 2026-10-23. Branch
`wave/w3-d16-slider` reviewed at 9c0cb72 against `origin/ccr-4d8a843c-1k9syk` (f1948dd; the
branch's merge base is 82a6295, f1948dd is 59 commits ahead of it).

Verdict: **revise**. Score: 74/100 (as built at 9c0cb72; every finding below carries its
resolution).

The core wiring is right and proven on the composed daemon: the executor, the conversation agent
and the intake read `speed_quality_offset` from the project row when the work starts, the
static `effortOffset` dependency is gone, and a move through `POST /commands/execute` changes
the next chat turn, planning session and work session without a restart
(`effort-offset.test.ts`, 7 tests green; restoring `agent.ts`, `executor.ts` and `intake.ts`
makes the chat, voice, planning and run cases fail). The settings spec, the effect sentence in
both directions and the Settings slider are in place and tested. What is wrong is at the
edges: the slider now pushes specialists past the `max_effort` their registry entry declares,
and two of the runtime claims (voice takes `voice_chat`, the researcher takes `researcher`) are
not proven by any test.

Requirements checked:

- D.16 "every default effort shifts up or down one step", per mode:
  - chat (`text_chat`): met, read per turn (`agent.ts:276`), proven on the daemon.
  - voice (`voice_chat`): built (`agent.ts:277`, every voice-bridge turn has
    `source: "voice"`, `bridge.ts:779`; the text fallback route takes the same
    `converseTurn`), but not proven (finding 1).
  - planning: met, per intake session (`intake.ts:627`). The intake is the only
    planning-mode model call in the runtime: every `modelIdFor` / `driver.run` caller was
    checked (agent, intake, executor, critic, eval runner).
  - coder: met, per run (`executor.ts:396`), proven by Run rows.
  - researcher: built, not proven (finding 2).
  - critic t1 / t23: met, unchanged (`criticSettingsOf`, capped at the registry's
    `max_effort`); t1 proven on the daemon, t23 in `packages/critic/test/model.test.ts`.
  - routing: no consumer exists; `modeEffort("routing", …)` is ready. Not a defect.
- "the executor reads the project row per run, not a static value": met (`executor.ts:281`
  loads the row per `execute`; `LoopTaskExecutorDeps.effortOffset` removed; `compose.ts` only
  has a comment).
- "chat and voice read it per turn; planning per session": met (above).
- The slider respects the registry's effort caps (`adding-a-specialist.md:57`: "never above
  `max_effort`"): **not met** for specialists (finding 3).
- "the settings card is a slider with the effect sentence both ways in the change log": met
  (`settings.ts` `SPEED_QUALITY_EFFECT`, `speed-quality.test.ts`; `SettingsPage.tsx`
  `SliderInput`, `settings-slider.test.tsx`). Follows ADR 0051 item 4.
- The fake daemon mirrors the daemon for the slider: the refusal text differs (finding 4).
- "the Performance view is unaffected": met (no change under `apps/ui/src/pages/Performance*`
  or the `/performance` contracts).
- Docs: runtime.md, commands.md and apps.md describe the build. runtime.md needs the
  `max_effort` cap once finding 3 is fixed. requirements.md D.16 `done` with the tests listed;
  counts 184 / 39 / 5 match the table (`grep -c`). BLOCKERS.md and PROGRESS.md say "review
  pending" and need the review's outcome.
- Security and privacy: nothing new reaches model context or logs. The agent reads only the
  turn's active project row. The `GET /settings` row exposes a value the human already owns.
- Semantic conflict with the base: none. A throwaway merge of 9c0cb72 with f1948dd (discarded
  worktree) conflicted only textually in `docs/maintainers/apps.md` (the test list). On the
  merged tree, `pnpm typecheck` passed, `effort-offset.test.ts` with `packages/commands/test`
  passed (11 files, 140 tests), and `settings-slider` with `settings` in apps/ui passed (2 files,
  11 tests).
- The build report's header names the base as `e2bfb1e`; the task names f1948dd. The export
  base is the starting commit, so this is a stale note only.

Findings:

1. **medium**, `packages/runtime/test/effort-offset.test.ts:207-221` (with `:41-42`).
   - "a voice turn runs at voice_chat's effort" cannot fail if voice turns use the chat
     mode: the built-in `voice_chat` and `text_chat` defaults are both `low`, so the expected
     efforts are identical.
   - Verified by mutation: with `agent.ts:277` changed to always `"text_chat"`, the file still
     passes, 7 of 7.
   - Fix: run the voice and chat cases on a table in force where the two modes differ (a
     `models.json` effort override for `voice_chat`). Then a voice turn that took the chat
     default fails the test.

2. **low**, `packages/runtime/src/session/executor.ts:396-401`, `effort-offset.test.ts`.
   - The executor's `researcher` branch and the coder's tier-2+ rule under a live slider are
     not tested from a project row. Only the pure `effortForTask` call is.
   - Verified by mutation: with the mode expression replaced by `"coder"`, `effort-offset`,
     `executor` and `ladder` still pass (3 files, 17 tests).
   - Fix: an executor-level test that runs a researcher task and a tier-2 coder task at -1, 0
     and +1, moving the project row between runs of the same executor.

3. **medium**, `packages/runtime/src/session/executor.ts:396-401`,
   `packages/runtime/src/daemon/compose.ts:785-797`.
   - The slider pushes specialists above their registry `max_effort`.
   - `adding-a-specialist.md:57` says the runtime raises effort "by tier … and the project
     slider, never above `max_effort`". The critic honours its cap (`pickCriticModel`
     `maxEffort`), but `SpecialistSpec` does not carry `max_effort` and the executor never caps.
   - Before this item the offset was always 0, so the highest a specialist reached was `high`
     (the tier-2 coder), which is every specialist's `max_effort` except science-evaluator's.
   - Now, at quality:
     - the researcher (default `high`, max `high`) runs at `xhigh`;
     - a tier-2 coder (max `high`) runs at `xhigh`;
     - writer-marketing, designer, tester and reviewer at tier 2 (mapped to the coder mode,
       max `high`) run at `xhigh`.
   - The result is more cost than the registry allows, and the critic and the specialists
     follow different rules.
   - Verified by reading `evals/registry/specialists/*/specialist.md` (`max_effort: high` for
     9 of 10) and `effortForTask("researcher", 1, 1)` = `xhigh`.
   - Fix: `SpecialistSpec.maxEffort` from the registry's `max_effort`, applied by the executor
     after the slider. A test proves the researcher at quality stays at `high`, and a spec with
     a higher cap still moves up.
   - The principals are not affected under the built-in table: chat and voice at +1 reach
     `medium`, the conversation agent's cap, and planning at +1 reaches `xhigh`, below the
     project manager's `max`.

4. **low**, `apps/ui/test/fake-daemon.ts:1724`.
   - The fake refuses every invalid slider value with "Too big: expected number to be <=1",
     including -2.
   - The daemon refuses -2 with "speed_quality_offset: Too small: expected number to be >=-1"
     (verified with a throwaway `settings.set` test in `packages/commands/test`, deleted).
   - A UI test against the fake would therefore show a message the real daemon never sends.
   - Fix: the fake gives each refusal the daemon's text, and a UI test covers the -2 refusal.
