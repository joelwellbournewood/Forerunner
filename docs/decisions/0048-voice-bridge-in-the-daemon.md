# 0048 — The voice bridge in the daemon: one loop for audio and typed lines, the `/voice` routes, providers by reference, what is recorded

Date: 2026-10-20
Status: accepted (items 1, 3, 4 and 7 revised the same day after the critic's review: the
registry as the one source of truth for the pending card, sample rate bounds, `afterSeq`
validation, stopped sessions dropped)

## Context

Spec O asks for a voice loop (push-to-talk or open mic, first audio under 1.2 s, each stage
measured and shown), spec O.7 for a read-back of anything above routine with a wait for "yes"
and spoken approvals logged with the transcript line, and spec Q for one command registry
behind chat, voice, the UI and the phone. ADR 0012 put the loop, the providers, the latency
anchors and the spoken approval rules into `@forerunner/voice` and left the conversation agent
to the runtime, injected as `converse(transcript, signal)`. Until this ADR the only bridge
between the loop and the agent lived in `tests/e2e/src/scenario-voice.ts` (scenario 3): the
daemon had no voice route, so no shell could reach the loop, and `docs/maintainers/testing.md`
listed that as a known issue. The spec leaves open where the bridge lives, how a shell without
audio capture takes part, how the loop's events reach a shell, which providers the daemon
composes and how a missing one is reported, and what a voice session leaves in the store.

## Decision

1. **The bridge lives in the runtime** (`packages/runtime/src/voice/bridge.ts`, `VoiceBridge`),
   composed by `composeRuntime` from the conversation agent, the command registry and the
   voice loop, and the scenario's copy stays untouched until the scenario is pointed at it.
   The bridge is the only `converse` port: the agent parses the line, composes the change card
   and files it; the bridge decides, with `expectYes()`, whether a spoken line is the yes the
   card waits for or a plain "no" (the registry's own reading of a typed or spoken reply:
   no, nope, cancel, stop, nein, non, abbrechen). **With a card pending the agent is not
   called at all.** A line the rules refuse (a question, a qualifier, a deferral, a
   hesitation, an ambiguous late affirmative) gets "I did not take that as a yes." and the
   read-back again, and the card stays pending. A yes is carried out by the bridge through the
   registry itself, `CommandLoop.confirm(id, { kind: "yes", by: human, source: "voice" })`,
   a "no" through `cancel`: the same path a tap takes, so the registry's outcome (status,
   sentence, change log id, undo token) is known, spoken in the agent's wording
   (`spokenOutcome`) and recorded on the decision; the change log keeps the words of the
   request that composed the card. **The registry's pending list is the one source of truth
   for what waits** (`CommandLoop.pending(humanId)`): the bridge's copy of the card follows it
   at every answer, so a card tapped in the UI, answered by email or expired is refused by the
   registry with the reason and forgotten by the session, and a line that is no answer to a
   card the registry no longer holds is a plain line. The conversation agent's per-human copy
   is never consulted: any typed line drops it, and the first version of this bridge, which
   forwarded the spoken yes to the agent as a chat "yes", diverged from it in both directions
   (a `/chat` line between the read-back and the spoken yes sent the yes to the model as plain
   chat while the audit row said it was approved). For a line it answered itself the bridge
   writes the `chat.human`, `chat.confirmed` / `chat.cancelled` and `chat.reply` rows the
   agent would have written, so the conversation transcript reads the same either way.
2. **One loop for audio and typed lines.** A typed line (shells without audio capture, the
   approvals web page) does not take a second path: `TextTurnStt` wraps the selected STT
   provider and, for the next turn only, returns a session whose final transcript is the
   typed line (`finalTranscriptMs` 0), opened and closed by the bridge as a push-to-talk
   press and release with no audio. The converse port, the approval rules, the sentence
   pipeline into TTS, the events and the rows are the same as for a spoken line; a typed line
   while the agent speaks is a barge-in like a press. The bridge refuses a text turn while a
   capture is open or a transcript is awaited (`validation`), never queues it.
3. **Routes** (`server.ts`, `DAEMON_ROUTES`, bearer token; the stream also takes `?token=`):
   `GET /voice/status`, `POST /voice/sessions`, `GET /voice/sessions/:id`,
   `POST /voice/sessions/:id/stop`, `POST /voice/sessions/:id/press { pressed }`,
   `POST /voice/sessions/:id/audio` (JSON with base64 16-bit PCM, or raw bytes as
   `application/octet-stream` with the format in the query; `sampleRate` 8000..192000 and
   1..8 channels, else `validation`: the loop resamples to 16 kHz and a chunk declared at
   1 Hz would be expanded sixteen thousand times), `POST /voice/sessions/:id/text` (answers
   with the finished turn and, when the line answered a card, the registry's `outcome`),
   `POST /voice/sessions/:id/answer { answer: tap|no }` and `GET /voice/sessions/:id/events`
   (JSON after a seq, `validation` when `afterSeq` is not a non-negative number, or SSE
   `voice.event` frames). The frames are the loop's events plus the bridge's:
   `voice.first_audio` (first audio, measured from the detected end of the turn and from the
   final transcript), `voice.readback` (approval needed: the card read back, again after a
   refused answer while the registry still holds it), `voice.approval` (the decision with the
   line and the registry's `status` and `reason`), `voice.answer` (the registry's result of a
   spoken yes or no, a tap or a no) and `voice.turn` (done: the turn's record with its latency
   report). Audio frames are live only and never replayed on a resume; every other frame is
   numbered and kept (1000 per session) so `afterSeq` resumes a dropped stream. A playback chunk is handed
   to a `pacedSink` on the clock (the shell plays what the `audio` frames carry; the loop's
   "speaking" state and the barge-in follow the chunk durations), replaceable at compose.
4. **A tap is a tap.** `POST .../answer { answer: "tap" }` confirms the pending card through
   `CommandLoop.confirm(id, { kind: "tap", source: "voice" })`, so the registry's policy
   applies (a medium-risk card confirms, a high-risk one still needs the paired device and the
   result says so); `"no"` cancels. The registry decides: a card it no longer holds is refused
   with the reason and the bridge forgets it, a card it keeps (a tap on a high-risk card) is
   read back again. The agent's own per-human copy is dropped at its next typed line (a bare
   "yes" typed right after any voice answer reaches `confirmByText` on a card that is no
   longer pending and is reported as "Not done"; nothing runs twice; a `pendingFor` /
   `dropPending` on `ConversationAgent` is the fix, outside this change). A spoken yes is a
   turn, not this route.
5. **Providers by reference, none probed at compose** (`providers.ts`): the local helpers
   `faster-whisper` and `kokoro` always, `piper` when `FORERUNNER_PIPER_MODEL` names a model,
   and the cloud providers `deepgram`, `cartesia`, `elevenlabs` behind
   `secret:deepgram_api_key`, `secret:cartesia_api_key`, `secret:elevenlabs_api_key` with the
   voice ids from `FORERUNNER_CARTESIA_VOICE` / `FORERUNNER_ELEVENLABS_VOICE`. The registry's
   policy of ADR 0012 picks when a session starts or the status is read; `hasSecret` asks the
   vault whether the reference has a value, never the value. **No fake provider in
   production**: a machine without a helper and without a key gets `GET /voice/status
   { available: false, reason }` and a 503 `unavailable` with the same reason on a start,
   never a loop that transcribes nothing. Without a model credential the reason is the one
   `/chat` gives. The preferred names come from `FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS`
   until the Extensions panel's `voice-*` entries carry the choice. Tests inject the fake
   providers through `ComposeOptions.voice`.
6. **What is recorded.** On the conversation session's event log: `voice.turn` per turn
   (source, what was said and heard, chunks played, whether audio was stored, the pending card
   id, the latency stages) and `voice.approval` per decision (the exact line, approved,
   `blockedBy`, method `spoken` | `tap` | `no`, the card and its commands); the agent's own
   `chat.human` / `chat.reply` / `chat.confirmed` rows carry `source: "voice"`. In the audit
   log: `voice.session` on start (mode, language, providers) and stop, `voice.approval` per
   decision. Nothing of the audio and nothing played is in the audit log; audio is written
   only with `FORERUNNER_VOICE_STORE_AUDIO=1` (or `ComposeOptions.voice.storeAudio`), under
   `<data>/voice/<session>` next to the retention note of ADR 0012.
7. **Sessions.** At most four open voice sessions per daemon (`unavailable` beyond); a session
   ends with `/stop` (immediate in every state, spec O.9) or with the daemon's `close()`; a
   stopped session still answers `GET` and a late stream and refuses input with `validation`,
   until `VoiceSessions` drops it: at most eight stopped sessions are kept and none longer
   than ten minutes (`keepStopped`, `retainStoppedMs`), swept lazily on every access so no
   timer runs and the simulated clock decides in tests; a bridge keeps up to 1000 buffered
   frames and every turn's record, so a daemon open for weeks must not keep every session it
   ever opened. Nothing ties a voice session to a running work session: what is said reaches
   the agent through the conversation agent as before.

## Consequences

- The shells (desktop, Android, approvals web) can now reach the loop over the daemon; their
  hook-up is a later item (`voice.md`, "How the shell reaches it", says what they call).
  `tests/e2e/src/scenario-voice.ts` keeps its own bridge until scenario 3 is pointed at
  `VoiceBridge`.
- `@forerunner/voice` is not declared in `packages/runtime/package.json` (dependencies are
  pre-declared and the change could not add one), so `packages/runtime/src/voice/pkg.ts`
  reaches the package's sources by relative path, as the scenario did; declaring the
  dependency makes that file a one-line re-export.
- `packages/runtime/test/voice-route.test.ts` proves on the composed daemon with the fake
  providers and the fake model: a text turn's events and `voice.turn` row, a risky command's
  read-back with a refused question and a yes carried out by the registry with no model call
  (the status on the decision, the rows and the audit row, the `chat.*` rows), a `/chat` line
  between the read-back and the spoken yes with the card still carried out, a card tapped in
  the UI refused for the spoken yes and not run twice, a tap, an audio turn with every
  latency stage measured on the simulated clock, absurd sample rates and a non-numeric
  `afterSeq` refused, the SSE stream, stop, the unavailable reasons (no provider; a cloud key
  present but no TTS) with the key never in the body, and stopped sessions dropped.

## Alternatives considered

- **A second, text-only path for typed lines** (`/chat` with `source: "voice"`): would skip
  the loop's events, the TTS pipeline and the `voice.turn` row, so a shell without a
  microphone would get a different product and the approval rules would exist twice.
- **The shell runs the loop** (the daemon only serving `/chat`): puts the approval rules and
  the rows into three shells and keeps the e2e bridge as the only tested one.
- **Registering the fake providers in production as the last fallback** (ADR 0012's policy
  reads that way for tests): a user would get a loop that hears nothing and speaks silence.
- **Replaying audio frames on a resume**: audio is for the moment it was produced; a resumed
  stream gets the transcript and the turn record instead.
- **Confirming a tap through the agent as a chat "yes"**: keeps the agent's pending copy in
  step but records a tap as a typed yes in the change log and the audit row.
- **Forwarding the spoken yes to the agent as a chat "yes"** (the first version): the agent's
  per-human copy of the card and the bridge's diverged in both directions, the registry's
  outcome never reached the voice rows, and the audit row could claim a spoken approval that
  went to the model as plain chat. Exposing the agent's copy (`pendingFor` / `dropPending`)
  would keep two copies in step; reading the registry keeps one.
- **Cancelling on every negation `expectYes` flags**: "wait", "maybe" and "not now" are
  hesitations; cancelling the card on them would throw away a request the human is still
  thinking about. Only the registry's own "no" words cancel; the rest refuse and read back.
