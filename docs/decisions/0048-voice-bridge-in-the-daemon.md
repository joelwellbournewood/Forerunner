# 0048 — The voice bridge in the daemon: one loop for audio and typed lines, the `/voice` routes, providers by reference, what is recorded

Date: 2026-10-20
Status: accepted

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
   card waits for. A line the rules refuse (a question, a qualifier, a deferral, an ambiguous
   late affirmative) never reaches the agent: the bridge speaks "I did not take that as a yes."
   and the read-back again, and the card stays pending. A negation goes to the agent, whose
   own "no" handling cancels the card. A spoken yes is forwarded as the exact line when the
   agent's own `isYes` accepts it, else as the canonical "yes", so the change log keeps the
   words the parser understood.
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
   `application/octet-stream` with the format in the query), `POST /voice/sessions/:id/text`
   (answers with the finished turn), `POST /voice/sessions/:id/answer { answer: tap|no }` and
   `GET /voice/sessions/:id/events` (JSON after a seq, or SSE `voice.event` frames). The frames
   are the loop's events plus the bridge's: `voice.first_audio` (first audio, measured from
   the detected end of the turn and from the final transcript), `voice.readback` (approval
   needed: the card read back), `voice.approval` (the decision with the line), `voice.answer`
   (a tap or a no) and `voice.turn` (done: the turn's record with its latency report). Audio
   frames are live only and never replayed on a resume; every other frame is numbered and
   kept (1000 per session) so `afterSeq` resumes a dropped stream. A playback chunk is handed
   to a `pacedSink` on the clock (the shell plays what the `audio` frames carry; the loop's
   "speaking" state and the barge-in follow the chunk durations), replaceable at compose.
4. **A tap is a tap.** `POST .../answer { answer: "tap" }` confirms the pending card through
   `CommandLoop.confirm(id, { kind: "tap", source: "voice" })`, so the registry's policy
   applies (a medium-risk card confirms, a high-risk one still needs the paired device and the
   result says so); `"no"` cancels. The bridge forgets the card; the agent's own copy is
   dropped at its next line (a bare "yes" after a tap answers a card that is no longer pending
   and is reported as such). A spoken yes is a turn, not this route.
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
   stopped session still answers `GET` and refuses input with `validation`. Nothing ties a
   voice session to a running work session: what is said reaches the agent through the
   conversation agent as before.

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
  read-back with a refused question and an applied yes, a tap, an audio turn with every
  latency stage measured on the simulated clock, the SSE stream, stop, and the unavailable
  reasons (no provider; a cloud key present but no TTS) with the key never in the body.

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
