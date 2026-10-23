# w2-l6-speak: TTS for summaries and alerts

No build report was committed on the branch. The work is in commits `ac576a2` (commands),
`d5d6350` (runtime, ADR 0063) and `f18c418` (UI), merged with the base at `a99dc03`.

## Review

Verdict: revise

Score: 62

Reviewed `git diff origin/ccr-4d8a843c-1k9syk...HEAD` (46 files) against the brief. Commands
run on this branch, all green: `pnpm exec vitest run --project unit packages/runtime/test`
(116 files, 1001 passed, 1 skipped), the targeted speak, notification and `packages/commands/test`
suites (14 files, 220 passed), `pnpm --filter @forerunner/ui test` (42 files, 255 passed),
`pnpm typecheck` (clean), `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` (ok),
`node scripts/check-paths.mjs` (ok). Two throwaway tests (findings 2 and 3) were written,
run and deleted.

What works: `POST /projects/:id/speak` and `POST /sessions/:id/speak` synthesise sentence by
sentence through the registry's TTS with no model call. The text is echoed. Cancel is
immediate. Another human's project or session is refused with 403. Exactly one `voice.speak`
event row and one audit row are written, with no audio. The UI's Read aloud button follows
its own utterance and plays the frames through Web Audio. The `summary.speak` command parses
in English and German. `voice_alerts` sits in `notify_prefs` and the settings command. The
voice channel's redaction assertion, quiet-hours skip and urgent-only rule are tested.

The second clause of L.6 is not met end to end: nothing makes a voice alert audible. The
delivery rows and the docs say it is.

Findings:

1. **high**: voice alerts and `summary.speak` by chat are never audible, yet they are recorded as spoken.
   - Where: `packages/runtime/src/daemon/compose.ts:1891-1914` (the `VoiceChannel` and its `speak` adapter), `packages/runtime/src/daemon/compose.ts:2188-2199` (the command's `speak` port), `packages/runtime/src/daemon/server.ts` (`onSpeak`, the `speak.started` frame).
   - What is wrong: the speaker's default sink is `pacedSink` (`packages/voice/src/loop.ts:800`), which only sleeps for each chunk's duration and produces no sound. The only consumer of `/speak/:id/events` is `apps/ui/src/lib/speech.ts`, and that runs only for an utterance the UI started itself with the Read aloud button. Nothing subscribes to `speak.started`: grep finds no consumer in `apps/desktop` (`src-tauri/src/sse.rs` handles `notification`, `restart.requested` and similar frames, not `speak.started`) and none in `apps/ui`.
   - Effect on alerts: an urgent alert goes to `SpeakSessions.say()`, plays silently into the paced sink, and is recorded as `voice:delivered` "spoken: N sentence(s)…". The `notify.voice` audit row says `allowed: true`. The channel's own gate, "a desktop shell holds the event stream (someone is at the machine to hear it)", counts exactly the Rust sidecar, which discards the frame.
   - Effect on chat: `summary.speak` typed in chat answers "Reading the summary of X aloud." and nothing is heard. The alert also cancels a Read aloud the UI is playing (one voice), so the one audible path is cut off in favour of a silent one.
   - The docs say the opposite of the code: `docs/maintainers/notifications.md:377-379` ("the daemon's paced sink and the UI's Web Audio playback do (`apps.md`), so an alert is heard with the app window open"), `docs/maintainers/apps.md:411-413` ("a spoken alert is heard only through the daemon's own sink") and ADR 0063 Consequences, line 75 ("Humans who enable voice alerts hear `budget_stop`…").
   - Verified: read `pacedSink`; grepped `apps/` for `speak.started`, `speakEvents` and `/speak/` (only `lib/speech.ts`, reached from `ReadAloud`, and the UI's fake daemon); read `sse.rs` `parse_daemon_event`. The daemon test `notifications-voice.test.ts:414` passes only because it inspects `FakeTts.calls`, not whether any client played the frames.
   - Smallest correct fix: in the UI's existing `/events` subscription, attach a player to every `speak.started` whose `source` is not `ui` (call `playSpeech(client, id)`; the webview already plays Web Audio), so alerts and chat-initiated reads play while the window is open. Make the voice channel's precondition "a client that plays speech is attached", not `shells.count()`. Until then, record the alert as `skipped`/`unavailable` ("no player attached") rather than `delivered`. Correct the three doc passages. If L.6's alert half cannot be closed here, return L.6 as in progress with this as the open point.

2. **medium**: a TTS failure mid-alert is recorded as a delivered voice alert.
   - Where: `packages/runtime/src/daemon/compose.ts:1911` and the copied adapter in `packages/runtime/test/notifications-voice.test.ts:128-138`.
   - What is wrong: `Utterance.done` resolves (it does not reject) with `state: "failed"` when the provider throws. The adapter maps only `cancelled` to `interrupted` and returns every other state as success, so `VoiceChannel.send` (`voice.ts:98-104`) answers `{ ok: true, detail: "spoken: 1 sentence(s), 0 chunk(s)…" }`.
   - Verified: a throwaway test wired `SpeakSessions` to a TTS whose `synthesize` throws "engine crashed", behind `VoiceChannel` and `Notifier`. The notification's `voice` delivery came back `delivered`. The test was deleted afterwards.
   - Smallest correct fix: return the record's state (or `error`) from the `speak` port, and in `VoiceChannel.send` map `failed` to `{ ok: false, reason: redact(error.message), retryable: true }`. Add a test with a throwing TTS.

3. **medium**: "one voice at a time" does not hold for concurrent requests.
   - Where: `packages/runtime/src/voice/speak.ts:368-387` (`SpeakSessions.say`).
   - What is wrong: `this.current?.cancel()` runs after `await pickTts(...)`, and `this.speaking` is set only after a second await (`sessionIdFor()`). Two `say()` calls that overlap (two urgent notifications dispatched together through `notifyLater`, or an alert and a Read aloud press) both see `current === null` and both play to the end. The voice loop's replies (`VoiceSessions`) are not coordinated with the speaker at all, so an alert can also talk over a voice turn.
   - Verified: a throwaway test ran `Promise.all([speech.say(a), speech.say(b)])` on `FakeTts` and the simulated clock. Both utterances ended `done`, neither `cancelled`. The test was deleted afterwards. The route test `speak-route.test.ts:360` only covers calls made one after the other.
   - Smallest correct fix: reserve the slot synchronously at the top of `say()`, for example a generation counter or a `this.pending` promise chain, so the newest request cancels whatever started before it. Add a concurrent-`say` test.

4. **medium**: a per-kind list naming only `voice` drops the toast for an urgent alert, contradicting ADR 0063 point 5.
   - Where: `packages/runtime/src/notifications/prefs.ts:184` and `packages/runtime/test/notifications-voice.test.ts:293-299`.
   - What is wrong: `channelsFor` filters `voice` out of an explicit list, so `channels: { budget_stop: ["voice"] }` leaves an empty chain and no desktop, Telegram, Signal or email attempt. The record's outcome is `delivered` only because of the announcer. With finding 1 nothing is heard, so the alert reaches nobody. With the voice skipped (quiet hours, no shell, voice alerts off) the outcome is `no_channel`. The ADR says voice "never replaces a delivery … the toast stays", and the test asserts the opposite ("that is the delivery"). The `PUT /notifications/prefs` schema accepts `voice` in a list because it is now in `CHANNEL_NAMES`.
   - Verified: read `channelsFor` and `dispatch`. The cited test asserts `["voice:delivered"]` with no chain row.
   - Smallest correct fix: when filtering `voice` leaves an explicit list empty, fall back to the default chain (or reject `voice` in per-kind lists in `NotificationPrefsPatch`). Change the test to expect the toast plus the voice row.

5. **low**: audio frames sent before the client subscribes are lost, so the start of a summary can be cut.
   - Where: `packages/runtime/src/voice/speak.ts:192-198` (audio is never buffered) and `apps/ui/src/lib/speech.ts:150-153` (subscribes after the `POST` returned).
   - What is wrong: `say()` starts synthesis and paced playback before the route answers 201. The UI opens `GET /speak/:id/events?afterSeq=0` only afterwards. A local TTS that returns its first chunk faster than the browser's round trip plus the EventSource connect drops the first frames, and the first words are silent. The SSE test (`speak-route.test.ts:280`) hides this: the simulated clock does not move until the stream is attached.
   - Verified: by reading the code. No timing test was written, because the simulated clock cannot show the race.
   - Smallest correct fix: hold playback until the first stream subscriber attaches or a short grace period passes, or keep the audio of the current sentence in the buffer for replay. Alternatively let the client open the stream before starting (`POST … { start: false }`, then a start call).

6. **low**: `summary.speak` lacks the ownership refusal the route has.
   - Where: `packages/commands/src/commands/summary.ts:85-95` (`resolveProject`, `packages/commands/src/commands/shared.ts:50`).
   - What is wrong: `POST /projects/:id/speak` refuses another human's project with 403, but "read me the summary of <their project>" on a shared state resolves any active project by name and reads it aloud, or returns it as text. This is not new exposure: `GET /projects/:id/summary` has no ownership check either. It is inconsistent with the brief's "refused for another human's project".
   - Verified: by reading `resolveProject` and the executor. No per-human gate exists for project-scoped commands.
   - Smallest correct fix: in `run`/`plan`, apply the same `ownsProject` rule (move it to a shared place, or pass it as a port) and throw `forbidden`.

7. **low**: the UI's audio playback is untested.
   - Where: `apps/ui/src/lib/speech.ts` (`decodeFrame`, `play`, the EventSource branch).
   - What is wrong: jsdom has no EventSource or AudioContext, so the UI tests only exercise the polling fallback and the button states. PCM decoding, sample-rate handling, back-to-back scheduling and the `speak.done`/`error` handling have no test, although `PlaybackOptions` already takes an injectable `eventSource` and `audio`.
   - Verified: read `project.test.tsx` and `session.test.tsx` and grepped `apps/ui/test` for `decodeFrame` and `playSpeech` (no hits).
   - Smallest correct fix: one test feeding a fake EventSource two `audio` frames and a `speak.done`, with a fake `AudioOutput`, asserting the decoded samples, the start times and `done === "done"`.

8. **low**: navigating away from a page that is reading aloud leaves the daemon speaking.
   - Where: `apps/ui/src/components/ReadAloud.tsx:48-53`.
   - What is wrong: the unmount cleanup stops local playback but never calls `cancelSpeak`. The daemon's utterance runs on, holds the one-voice slot and writes a `done` row for text nobody heard.
   - Verified: by reading the code.
   - Smallest correct fix: in the cleanup, call `client.cancelSpeak(current.id)` when an utterance is in flight.

9. **low**: a JSDoc comment is left orphaned at the end of `server.ts`.
   - Where: `packages/runtime/src/daemon/server.ts:1711`.
   - What is wrong: the function moved to `conversation-session.ts`, but its doc comment ("The principal's conversation session…") stays as the file's last line, attached to nothing.
   - Verified: by reading the file.
   - Smallest correct fix: delete the line.
