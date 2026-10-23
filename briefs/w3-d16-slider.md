## title

The speed-versus-quality slider shifts every mode's effort one step and is a slider in Settings

## requirements

D.16 (D.7 context)

## adr

none

## brief

BLOCKERS.md row D.16 speed-versus-quality slider: **partly built**: `effortWithOffset` shifts an effort one step (`ladder.test.ts`) and the critic reads `speed_quality_offset` from the project settings (`packages/critic/test/model.test.ts`); the executor's `effortOffset` is a static dependency `compose.ts` never feeds from the project, the chat, voice and planning modes ignore it, and Settings exposes the raw key, not a slider. Stand-in: the settings key, honoured by the critic. Needed: compose reads the project's offset for every mode and Settings shows the slider; then D.16 `done`. Spec D.16: 'Each project has a speed-versus-quality slider that shifts every default effort up or down one step.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read packages/runtime/src/models/ladder.ts (effortWithOffset), the executor and compose.ts (effortOffset static dependency), the conversation agent (chat mode effort), the voice route (voice mode), the planner / intake rung (planning), the critic's model choice (packages/critic/src/model.ts reads speed_quality_offset), packages/commands/src/commands/settings.ts (the SettingSpec for speed_quality_offset; ADR 0051 item 4's effect sentence pattern) and apps/ui/src/pages/SettingsPage.tsx (how settings cards render by spec kind: add a slider kind with three positions speed / balanced / quality mapping to -1 / 0 / +1, or keep numeric with a range input and labels). Build: every mode's effort for a project's runs is computed from the ladder default shifted by the project's current offset at run time (the executor reads the project row per run, not a static value; chat and voice read it per turn; planning per session); the settings card is a slider with the effect sentence both ways in the change log; the Performance view (another builder serves it) is unaffected. Tests: packages/runtime/test/effort-offset.test.ts (each mode's effort with offset -1/0/+1 from the project row, a change applies to the next run/turn without restart), commands test for the sentence, apps/ui/test/settings-slider.test.tsx. Docs: runtime.md, commands.md, apps.md.

## paths

packages/runtime/src/daemon/compose.ts, packages/runtime/src/models/ladder.ts, packages/runtime/src/conversation, packages/commands/src/commands/settings.ts, apps/ui/src/pages/SettingsPage.tsx, tests
