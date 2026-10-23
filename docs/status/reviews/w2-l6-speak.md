# w2-l6-speak: TTS for summaries and alerts

The build is in commits `ac576a2` (commands), `d5d6350` (runtime, ADR 0063) and `f18c418` (UI).
`a99dc03` merges the base into the branch. No build report was committed on the branch.

## Review

Verdict: revise

Score: 62

Reviewed `git diff origin/ccr-4d8a843c-1k9syk...HEAD` (46 files) against the brief, as an
independent reviewer starting at `dc07c10`. These commands ran green on this branch:
- `pnpm typecheck` (clean)
- `pnpm exec vitest run --project unit packages/runtime/test/speak-route.test.ts packages/runtime/test/notifications-voice.test.ts packages/commands/test` (11 files, 159 tests passed)

A throwaway test, `packages/runtime/test/zz-throwaway.test.ts`, proved findings 2, 3 and 4.
It was run once and deleted.

Requirements checked:
- [x] `POST /projects/:id/speak` synthesises the cached one-screen summary sentence by sentence through the registry's TTS (`pickTts`), with no model call (`speak-route.test.ts`, FakeTts calls in order).
- [x] `POST /sessions/:id/speak` reads a session's summary.
- [x] The text is echoed in `SpeakView.sentences`.
- [x] Audio is streamed as the voice loop's `audio` frame over SSE (`GET /speak/:id/events`).
- [x] A cancel is immediate (`POST /speak/:id/cancel`).
- [x] Another human's project or session is refused with 403 `forbidden` (route).
- [x] Exactly one `voice.speak` event row and one `voice.speak` audit row per utterance. No audio and no text go into the audit row.
- [~] One voice at a time: this holds for sequential calls only (finding 3).
- [~] `summary.speak` is a registry command, low risk, needs no confirmation, and parses in English and German. By chat it is never audible (finding 1), and it skips the ownership rule the route has (finding 6).
- [x] `voice` channel enabled per human through `notify_prefs.voice_alerts` and the `voice_alerts` setting.
- [~] Urgent notifications are spoken (ADR 0017 urgency). In practice nobody hears them: no client plays the frames (finding 1).
- [x] Quiet hours skip the voice and the toast still goes (`notifications-voice.test.ts`).
- [x] Disabled means no voice row.
- [~] "Falls back to the next channel otherwise" holds only with the default chain. A per-kind list naming only `voice` falls back to nothing (finding 4).
- [~] A delivery row is logged for every attempt, but a TTS failure is logged as `delivered` (finding 2).
- [x] The channel never speaks a secret: it asserts with `redact`, and a test covers it.
- [~] The UI has a "Read aloud" button on the project summary and the session view, with tests. The Web Audio playback is untested (finding 7), and leaving the page does not cancel the daemon's utterance (finding 8).
- [~] Docs: voice.md, notifications.md, runtime.md, commands.md and apps.md were all touched. notifications.md, apps.md, the ADR and `lib/speech.ts` claim playback that does not exist (finding 1).
- [x] ADR 0063 written in the template's form.

Findings:

1. **high**: voice alerts and `summary.speak` by chat are never audible, yet they are recorded as spoken.
   - Where: `packages/runtime/src/daemon/compose.ts:1896-1914` (the `VoiceChannel` with `shellsConnected: () => shells.count()`) and `compose.ts:2145-2156` (the command's `speak` port).
   - What is wrong: the speaker's default sink is `pacedSink` (`packages/voice/src/loop.ts`), which only sleeps for each chunk's duration and produces no sound. The only player of `/speak/:id/events` is `apps/ui/src/lib/speech.ts`, and it runs only for an utterance the UI started itself through `ReadAloud`.
   - Nothing subscribes to `speak.started`: `apps/desktop/src-tauri/src/sse.rs` does not, and `apps/ui/src/api/sse.ts` drops the frame as an unknown event.
   - Effect on alerts: an urgent alert is "spoken" into the paced sink and recorded as `voice:delivered` "spoken: N sentence(s)…". The `notify.voice` audit row says `allowed: true`. The channel's precondition counts exactly the clients that cannot play: the Rust sidecar is a "shell", and the UI's EventSource is not.
   - Effect on chat: `summary.speak` typed in chat answers "Reading the summary of X aloud." and nothing is heard.
   - The docs say the opposite of the code:
     - `docs/maintainers/notifications.md:377-379` ("the daemon's paced sink and the UI's Web Audio playback do … so an alert is heard with the app window open")
     - `docs/maintainers/apps.md:412-413` ("heard only through the daemon's own sink")
     - ADR 0063 Consequences ("Humans who enable voice alerts hear `budget_stop`…")
     - `apps/ui/src/lib/speech.ts:12` ("the desktop shell, which plays the same frames")
   - Verified: read `pacedSink`. Grepped `apps/` for `speak.started` (no consumer) and for `AudioContext` (only `lib/speech.ts`). Read `parseDaemonEvent` and `DAEMON_EVENT_NAMES`. `notifications-voice.test.ts` passes only because it inspects `FakeTts.calls`, not whether any client played the frames.
   - Fix needed:
     - The UI's `/events` stream declares itself a speech player when it can play (`?speech=play`), and the daemon counts those streams.
     - The voice channel and the command port require a speech player attached; otherwise they skip with the reason, or fall back to text.
     - `speak.started` says who plays it (`player: "requester"` for the Read aloud routes, `"any"` otherwise), and the UI plays every `"any"` utterance.
     - Correct the four passages.
     - Tests: the daemon counts players and skips with no player; the UI plays a `speak.started` utterance.
   - Resolution: fixed in d0c24bd (daemon) and 6f0ab37 (UI). The daemon counts `?speech=play` streams (`rt.speechPlayers`). The voice channel skips with "no app window open to play speech" and the `summary.speak` port answers with the text when none is attached. `speak.started` carries `player`. The UI's `AppProvider` declares itself where it can play and plays every `player: "any"` utterance through `createSpeechAnnouncer`. The four passages are corrected. Proved by:
     - `notifications-voice.test.ts` ("the prefs route lists the channel; on, with a speech player attached…": skipped with only the sidecar attached, spoken once a `?speech=play` stream is attached)
     - `speak-route.test.ts` (the command answers with the text without a player)
     - `apps/ui/test/speech.test.tsx` ("the app declares itself a speech player on /events and plays a voice alert…")

2. **medium**: a TTS failure mid-alert is recorded as a delivered voice alert.
   - Where: `packages/runtime/src/daemon/compose.ts:1904-1912` and `packages/runtime/src/notifications/channels/voice.ts:98-104`, plus the copied adapter in `packages/runtime/test/notifications-voice.test.ts:128-138`.
   - What is wrong: `Utterance.done` resolves (it does not reject) with `state: "failed"` when the provider throws. The adapter maps only `cancelled` to `interrupted`, so `VoiceChannel.send` answers `{ ok: true, detail: "spoken: …" }`.
   - Verified: the throwaway test gave `SpeakSessions` a TTS whose `synthesize` throws "engine crashed". `done` resolved with `state: "failed"`, `error: { code: "provider_error" }`. Under this adapter that is a delivered row.
   - Fix needed: report the state and error through the port, and map `failed` to `{ ok: false }` with the redacted reason. The failure is retryable only when nothing was heard. Add a test with a throwing TTS behind the notifier.
   - Resolution: fixed in d0c24bd. `speakThrough` (shared by `compose.ts` and the test) reports the state and error. Only `done` is a delivery. `failed` is retried only while no audio was heard; once audio was heard it is `unavailable`. Proved by `notifications-voice.test.ts` ("a provider that fails mid-alert is not a delivery…" and "…fails after audio was heard is not retried…").

3. **medium**: "one voice at a time" does not hold for concurrent requests.
   - Where: `packages/runtime/src/voice/speak.ts:368-387` (`SpeakSessions.say`).
   - What is wrong: `this.current?.cancel()` runs after `await pickTts(...)`. `this.speaking` is set only after a second await (`sessionIdFor()`). Two overlapping `say()` calls both see `current === null` and both play to the end. Overlapping calls happen with two urgent notifications dispatched together through `notifyLater`, or an alert and a Read aloud press.
   - Verified: the throwaway test ran `Promise.all([say(a), say(b)])` on `FakeTts` and the simulated clock. It printed `F3 done done`: both utterances played to the end, neither was cancelled. `speak-route.test.ts:360` only covers calls made one after the other.
   - The voice loop (`VoiceSessions`) is not coordinated either: an alert can talk over an open voice conversation.
   - Fix needed: serialise the start of `say()` so the newest request cancels whatever started before it. Add a concurrent test. Skip voice alerts while a voice session is open, with the reason.
   - Resolution: fixed in d0c24bd. `SpeakSessions.say` chains its starts, so the later request always cancels the earlier. The voice channel's `busy` skips an alert while a voice session is open ("a voice conversation is open"). Proved by:
     - `speak-route.test.ts` ("two overlapping say() calls…"): it fails with the old `say`, which I checked by reverting it.
     - `notifications-voice.test.ts` ("an open voice conversation…")

4. **medium**: a per-kind list naming only `voice` drops the toast, contradicting ADR 0063 point 5.
   - Where: `packages/runtime/src/notifications/prefs.ts:184` and the test `packages/runtime/test/notifications-voice.test.ts:293-299`.
   - What is wrong: `channelsFor` filters `voice` out of an explicit list, so `channels: { budget_stop: ["voice"] }` leaves an empty chain and no desktop, Telegram, Signal or email attempt. The record is `delivered` only because of the announcer. With the voice skipped (quiet hours, nobody at the machine) the outcome is `no_channel` and the alert reaches nobody.
   - The ADR says voice "never replaces a delivery … the toast stays". The test asserts the opposite ("that is the delivery").
   - Verified: the throwaway test printed `F4 []` for `channelsFor("budget_stop", { channels: { budget_stop: ["voice"] } })`.
   - Fix needed: when an explicit list holds no chain channel, use the default chain. Change the test to expect the toast plus the voice row.
   - Resolution: fixed in d0c24bd. `channelsFor` gives the default chain for a list that names only `voice`. An empty list stays muted, as on the base. The test now expects `desktop:delivered` plus `voice:delivered`, and at night the toast plus `voice:skipped` instead of `no_channel`.

5. **low**: audio frames sent before the client subscribes are lost, so the start of a summary can be cut.
   - Where: `packages/runtime/src/voice/speak.ts` (`run`: audio is never buffered, and playback starts at once) and `apps/ui/src/lib/speech.ts:147` (subscribes after the `POST` returned, or after `speak.started` arrived).
   - What is wrong: synthesis and paced playback start before the route answers 201. A local TTS that returns its first chunk faster than the round trip plus the EventSource connect drops the first frames, so the first words are silent.
   - Verified: by reading the code. The SSE route test hides the race because the simulated clock does not move until the stream is attached.
   - Fix needed: hold playback until the first stream subscriber attaches, or until a short grace period on the clock has passed. Add a test.
   - Resolution: fixed in d0c24bd. `Utterance` holds playback until the first `subscribe` or `awaitListenerMs` (default 1.5 s on the clock). Synthesis runs meanwhile. Proved by `speak-route.test.ts` ("playback waits for the player's stream: a late subscriber still gets the first words"): the first frame a stream attached at 400 ms receives is sentence 0's chunk 0. I checked that it fails with the hold set to 0.

6. **low**: `summary.speak` lacks the ownership refusal the route has.
   - Where: `packages/commands/src/commands/summary.ts:69,85` (`resolveProject`).
   - What is wrong: `POST /projects/:id/speak` refuses another human's project with 403. "read me the summary of <their project>" on a shared state resolves it and reads it aloud, or returns it as text. That breaks the brief's "refused for another human's project".
   - Verified: by reading `resolveProject` (`shared.ts:50`), which matches every active or paused project, and `ownership.ts`, which lives in the runtime only.
   - Fix needed: move the `ownsProject` rule to `@forerunner/commands` and apply it in `plan` and `run`. Add a test.
   - Resolution: fixed in 85311cf. `ownsProject` lives in `packages/commands/src/ownership.ts` and the runtime re-exports it. `summary.speak` refuses another human's project, named or active, as `not_found` "…is not yours" before reading it. Proved by `commands.test.ts` ("refuses another human's project on a shared state…") and `speak-route.test.ts` (the command on the other human's project).

7. **low**: the UI's audio playback is untested.
   - Where: `apps/ui/src/lib/speech.ts` (`decodeFrame`, `play`, the EventSource branch).
   - What is wrong: jsdom has no EventSource or AudioContext, so the UI tests only exercise the polling fallback. PCM decoding, back-to-back scheduling and `speak.done` handling have no test, although `PlaybackOptions` takes an injectable `eventSource` and `audio`.
   - Verified: grepped `apps/ui/test` for `decodeFrame` and `playSpeech` (no hits).
   - Fix needed: a test feeding a fake EventSource two `audio` frames and `speak.done` into a fake `AudioOutput`.
   - Resolution: fixed in 6f0ab37. `apps/ui/test/speech.test.tsx` covers:
     - mono and stereo PCM decoded, buffers scheduled back to back, sentences followed, `speak.done`, `error` and a cancelled record
     - `decodeFrame` with an odd byte count
     - the announcer

8. **low**: navigating away from a page that is reading aloud leaves the daemon speaking.
   - Where: `apps/ui/src/components/ReadAloud.tsx:48-53`.
   - What is wrong: the unmount cleanup stops local playback but never calls `cancelSpeak`. The utterance runs on, holds the one-voice slot and writes a `done` row for text nobody heard.
   - Verified: by reading the code.
   - Fix needed: cancel the in-flight utterance on unmount, with a test.
   - Resolution: fixed in 6f0ab37. `ReadAloud` keeps the in-flight id in a ref and cancels it on unmount. Proved by `project.test.tsx` ("leaving the page while it reads stops the daemon too"). I checked that it fails without the cleanup.

9. **low**: a JSDoc comment is left orphaned at the end of `server.ts`.
   - Where: `packages/runtime/src/daemon/server.ts` (last line).
   - What is wrong: `conversationSessionId` moved to `conversation-session.ts`, but its doc comment stayed as the file's last line, attached to nothing.
   - Verified: `tail -3 server.ts`.
   - Resolution: fixed in d0c24bd: the line is deleted.

10. **medium**: semantic conflict with the base: the speaker ignores the voice provider preference the base now reads per session.
    - Where: `packages/runtime/src/voice/speak.ts` (`SpeakSessionsDeps.preferred`, fixed at compose) and `packages/runtime/src/daemon/compose.ts` (the `SpeakSessions` construction).
    - What is wrong: the base moved on after this branch merged it. `w3-o4-voice-prefs` (O.4) changed `VoiceSessions` to read the preferred providers through a `preferences()` getter at every start: the Extensions panel's enabled `voice-*` rows under the environment override. `VoicePreferences` became `{ stt, tts: VoicePreference | null, skipped }`. This branch's speaker took a fixed `preferred` at compose. Once merged, Read aloud and voice alerts would keep the compose-time TTS while the voice chat follows the panel. `pickTts` would also need the new shape.
    - Verified: a trial merge of `origin/ccr-4d8a843c-1k9syk` in a throwaway worktree, not committed and removed afterwards. It conflicts in `voice/sessions.ts` (`pick`, `selectInput`), `daemon/compose.ts` (imports and the `RuntimeApp` doc), `runtime.md` and `apps.md`.
    - Fix needed: give the speaker the same per-call `preferences` getter the base's voice sessions take, so the merge passes both the base's resolver. Add a test that a changed preference picks the other provider for the next utterance.
    - Resolution: fixed in 881da18 as far as this branch can go without merging the base, which the rules forbid. `SpeakSessions` takes `preferences: () => VoicePreferences | Promise<…>`, read at every `say()`, and compose passes the voice sessions' source. Proved by `speak-route.test.ts` ("is read at every utterance…").
    - Left for the merge: pass `SpeakSessions` the same getter as `VoiceSessions` (`fixedVoicePreferences` or `resolveVoicePreferences({ env, extensions: voiceRows, hasSecret, registered })`). In `pickTts`, read `preferred.tts?.name` (with `preferredBy`) instead of the string. The textual conflicts listed above are mechanical.
