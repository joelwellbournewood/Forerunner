# w3-o4-voice-prefs

Item: the voice providers chosen in the Extensions panel are the ones the daemon uses
(requirement O.4). The build commits are `75d55d3` (code) and `b6c601d` (docs) on
`wave/w3-o4-voice-prefs`. No separate build report was filed in this directory; the build's
own summary is in those commit bodies.

## Review

Verdict: accept

Score: 78

Scope reviewed: `git diff origin/ccr-4d8a843c-1k9syk...HEAD`, which covers runtime voice
preferences, sessions, the extension registry and catalog, the voice package registry, the
UI Extensions page and client, and the maintainer docs. Before reviewing I merged the base
branch: it was one commit ahead (`82a6295`, the APK verifier, unrelated) and merged cleanly.

Checks I ran:
- `pnpm typecheck`: clean.
- `pnpm exec vitest run --project unit packages/runtime/test/voice-route.test.ts packages/runtime/test/voice-preferences.test.ts packages/runtime/test/extensions-catalog.test.ts packages/voice/test`: 16 files, 215 tests passed.
- `pnpm exec vitest run --project unit packages/runtime/test packages/voice/test`: 128 files, 1183 passed, 1 skipped.
- `pnpm --filter @forerunner/ui test`: 254 passed.
- `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk`: ok (25 files).
- `node scripts/check-paths.mjs`: ok.
- `biome check` on the changed files: clean.

What meets the brief:
- The preferences come from the enabled `voice-*` rows. Each catalog entry carries a `voice`
  field, and the code reads them through `ExtensionRegistry.enabledCatalogEntries` and
  `voiceExtensionRows`.
- One STT and one TTS provider are in force at a time. Every other row gets a visible reason.
- A cloud row whose key has no value is skipped, and the reason names the reference.
- The environment variables override the panel, and the docs say so.
- When nothing is chosen, the registry's policy picks.
- Preferences are read again at every status read and every session start, so a toggle
  applies at the next session without a restart.
- The panel shows the pair in force plus a badge on each voice row.
- All four test cases the brief names are in `voice-route.test.ts`.
- `voice.md`, `extensions.md`, `runtime.md` and `apps.md` describe the code as built.

Findings:

1. **medium**: switching a cloud row off in the panel does not stop that provider being used,
   and the panel gives no reason.
   - Where: `packages/runtime/src/voice/providers.ts:122-176` (`resolveVoicePreferences` only
     looks at enabled rows) together with `packages/voice/src/registry.ts:191-200` (the policy
     falls back to any cloud provider whose key is in the vault).
   - What is wrong: suppose the human installs `voice-deepgram`, stores the key, then switches
     the row off, and no local STT is available. The next session still sends microphone audio
     to Deepgram (`policy: "cloud"`). `preferences.stt` is null and `skipped` is empty, so
     neither the card nor the row badge says why. The catalog row is the grant: its scope reads
     "send voice audio to Deepgram for transcription" and its domain is `api.deepgram.com`. The
     same happens when only `voice-local` is enabled, its providers fail to start, and a cloud
     key exists. The human chose local, yet audio or text goes to the cloud. That fallback
     already existed on the base branch. What is new is that the panel now claims to be where
     the choice is made, so an "off" that does not mean off is a privacy surprise. `voice.md`
     does not mention it.
   - How verified: a throwaway composed-runtime test, since deleted. It registered fake STT
     plus Deepgram with a key in the vault, installed and approved `voice-deepgram`, then
     toggled it off. `GET /voice/status` returned `stt: {name: "deepgram", policy: "cloud"}`
     with `preferences: {stt: null, tts: null, skipped: []}`, and `POST /voice/sessions`
     returned 201.
   - Smallest fix: pass the names of the cloud providers whose `voice-*` row is installed but
     disabled into `SelectInput` as an `excluded` list, so the policy skips them. Report them
     in the status as "switched off in Extensions". Add a case to `voice-route.test.ts`
     ("a switched-off cloud row is not used by the fallback"). Alternatively, if the fallback
     is intended, state it in `voice.md` (Known issues) and show it on the row badge.

2. **low**: the `voice-local` row shows "preferred for TTS, not in force" while one of its own
   providers is in force.
   - Where: `packages/runtime/src/voice/providers.ts:145` and
     `apps/ui/src/pages/ExtensionsPage.tsx:82`.
   - What is wrong: line 145 prefers the first registered provider (`kokoro`, which
     `buildVoiceRegistry` always registers) without checking it is available. If kokoro does
     not import but Piper is configured, the registry notes "preferred kokoro unavailable" and
     the local policy picks `piper`. `voiceBadges` compares the pick only with
     `preferred.name`, so the row the human enabled is flagged with a warning even though
     their choice (local TTS) is in force.
   - How verified: read through `buildVoiceRegistry` (kokoro is registered unconditionally,
     piper only with a model path), `select()` in `packages/voice/src/registry.ts:177-193`, and
     `voiceBadges`.
   - Smallest fix: in `voiceBadges`, count the badge as in force when the pick is any provider
     the row stands for. That means exposing the row's provider list (for example
     `providers: string[]` on `VoicePreferenceView`). Or let the registry take an ordered
     `preferred` list per side.

3. **low**: a narrowed secret grant makes a cloud row look keyless and still lets it be used.
   - Where: `packages/runtime/src/voice/providers.ts:134` and `:228`.
   - What is wrong: the key check uses the row's granted `permissions.secrets` rather than the
     provider's own reference (`VOICE_SECRET_REFS`). If the human removes `deepgram_api_key`
     from the grant (a narrowing, applied at once), the row sorts as if it needed no key and
     is still preferred. If the key is in the vault, the daemon reads and uses it although the
     grant no longer lists it.
   - How verified: read through `updatePermissions`, where narrowing applies with no approval.
     `voice.md` (Known issues) documents only the half where the key is missing, not this one.
   - Smallest fix: when a cloud row's grant does not include its provider's secret, skip it
     with the reason "key not granted".

4. **low**: removing a voice row does not refresh the voice card straight away.
   - Where: `apps/ui/src/pages/ExtensionsPage.tsx:549`.
   - What is wrong: `upsert` calls `voice.reload()` but `drop` does not. After removing an
     enabled voice row, the card and badges are stale until the daemon's `extension.changed`
     frame bumps the version.
   - How verified: read the code.
   - Smallest fix: call `voice.reload()` in `drop` as well.

5. **low**: one UI test asserts a state the daemon cannot produce.
   - Where: `apps/ui/test/extensions.test.tsx`, the test "says which voice provider is in force
     and why a voice row is not".
   - What is wrong: the test toggles `ext_voice_deepgram`, which switches it off, then has the
     fake daemon report that same row skipped for "no value for secret:deepgram_api_key". The
     real daemon only lists enabled rows, so a switched-off row never gets a skip reason. The
     test proves the reload after a toggle, not a reachable state.
   - How verified: compared with `enabledCatalogEntries` (it lists only installed and enabled
     rows).
   - Smallest fix: trigger the reload with a non-toggle change (a permissions update or an
     `extension.changed` dispatch), or make the fixture show a different row skipped.
