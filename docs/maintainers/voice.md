# Voice

`packages/voice` (`@forerunner/voice`): streaming STT, streaming TTS, voice activity detection,
the voice loop (push-to-talk and open mic, sentence-by-sentence TTS, barge-in) and per-turn
latency measurement. Spec: module O (real-time conversation), D.8 (voice chat response target),
L.6 (TTS for summaries and alerts, STT for voice notes), platform table (audio), checklist row
"Voice keys". ADR: `docs/decisions/0012-voice-pipeline.md`.

## Purpose

- Let a person talk to their agent with first audio back in under 1.2 s, measured per turn and
  per stage, with local providers by default (free, private) and cloud providers when keys exist.
- Keep the conversation agent out of this package: the loop takes a `converse(transcript, signal)`
  function that returns model text deltas. The runtime's conversation agent (module O.2) is
  injected; this package never calls a model.
- Keep device IO out of this package: the Tauri shell owns WASAPI (Windows) and
  PipeWire/PulseAudio (Linux) and exchanges PCM chunks with the loop.

## How it works

### Layout

```
src/types.ts          AudioChunk, SttProvider/SttSession/SttEvent, TtsProvider, Vad, AudioSink
src/vad.ts            EnergyVad: energy + zero-crossing rate, hangover, deterministic framing
src/sentences.ts      SentenceSplitter: incremental sentence boundaries for streaming text
src/loop.ts           VoiceLoop: modes, STT turn, converse, TTS pipeline, barge-in, transcript
src/latency.ts        LatencyReport, targets, buildLatencyReport, formatLatencyReport, median
src/approval.ts       expectYes(), spokenApprovalRecord(): spoken approvals with the exact line
src/registry.ts       VoiceProviderRegistry: register, select by name, default policy + reason
src/store.ts          AudioStore: WAV per turn under <data>/voice/<session>/, off by default
src/wav.ts            WAV encode/decode, resample, downmix, synth/silence/noise, chunkify
src/queue.ts          AsyncQueue used by every session and the pipeline
src/providers/fake.ts             FakeStt, FakeTts (scripted, Clock-driven), ScriptedVad
src/providers/local/python.ts     find an interpreter, probe `import <module>` without throwing
src/providers/local/framing.ts    length-prefixed frames shared with the Python helpers
src/providers/local/helper-process.ts  long-lived helper subprocess (argv array, killTree)
src/providers/local/faster-whisper.ts  STT via python/fr_stt.py
src/providers/local/kokoro.ts          TTS via python/fr_tts.py
src/providers/local/piper.ts           TTS via the `piper` binary (--output-raw)
src/providers/cloud/transport.ts  injected WebSocket factory and streaming HTTP; SecretResolver
src/providers/cloud/deepgram.ts   streaming STT over wss://api.deepgram.com/v1/listen
src/providers/cloud/cartesia.ts   streaming TTS over wss://api.cartesia.ai/tts/websocket
src/providers/cloud/elevenlabs.ts streaming TTS over POST /v1/text-to-speech/{voice}/stream
python/fr_stt.py, python/fr_tts.py  bundled helpers (faster-whisper, Kokoro)
```

### Contracts

- `AudioChunk { pcm: Int16Array | Buffer; sampleRate; channels; timestampMs }`. 16-bit signed
  little-endian. Anything can be pushed; STT and the VAD downmix and resample to 16 kHz mono
  (`wav.toMono16`). TTS chunks carry the provider's own rate (Kokoro 24 kHz, Piper 22.05 kHz,
  Cartesia/ElevenLabs as requested); the shell's playback path resamples if it must.
- `SttProvider.start({sampleRate, language?, signal}) -> SttSession { push, endOfSpeech, events,
  close }`. `events` yields `partial` transcripts, then exactly one `final` (with `atMs`,
  optional `startMs/endMs/language/confidence`) or one `error`, then ends.
- `TtsProvider.synthesize(text, {voice?, speed?, sampleRate?, language?, signal}) ->
  AsyncIterable<AudioChunk>`. Must stop promptly on `signal`.
- `Vad.push(chunk) -> VadEvent[]` (`speech_start {atMs}`, `speech_end {atMs, endOfTurnMs,
  speechMs}`), `reset()`, `speaking`.
- Every provider has `name`, `kind: "local" | "cloud" | "fake"` and
  `isAvailable(): Promise<{ok, reason}>` which never throws.
- `AudioSink.play(chunk, signal)` resolves when the chunk has been handed to the device;
  `stop()` flushes on barge-in. The default `pacedSink(clock)` sleeps the chunk's duration (no
  device, used by tests and by the cloud runner).

### A turn

```
mic PCM ──push()──▶ [VAD] ──speech_start──▶ stt.start()  ──push──▶ STT ──partial──▶ UI
                     │                                                 │
                     └─speech_end (open mic) / pressEnd() (PTT) ──▶ endOfSpeech() ──final──▶
converse(transcript, signal) ──deltas──▶ SentenceSplitter ──sentence i──▶ tts.synthesize(i)
                                                                      └──▶ AudioSink.play ──▶ speaker
```

1. **Capture.** `pressStart()` (PTT) or a VAD `speech_start` (open mic) opens an STT session.
   Open mic keeps a 300 ms pre-roll so the first syllable is not lost. Partials are forwarded as
   `transcript_partial` events.
2. **End of turn.** `pressEnd()` or `speech_end` (200 ms of silence after speech, configurable).
   The loop calls `endOfSpeech()` and waits for the final (timeout `sttFinalTimeoutMs`, 10 s).
3. **Reply.** `converse(transcript, signal)` streams deltas into the `SentenceSplitter`. Each
   completed sentence goes to TTS at once. The pipeline synthesises sentence *i+1* while
   sentence *i* plays (`prefetchSentences`, default 1) and plays strictly in order.
4. **Barge-in.** While the agent thinks or speaks, mic audio still runs through the VAD. A
   `speech_start` (or `pressStart()` in PTT) aborts TTS and the model stream through one
   `AbortSignal`, calls `sink.stop()`, records the assistant entry as `interrupted: true` with
   `text` = sentences whose playback started and `unspokenText` = the rest, and immediately opens
   the next capture with the pre-roll. A `converse()` that ignores its signal cannot hold the
   loop: the model stream is raced against the abort.
5. **Failure.** If `converse()` throws (for example a budget hook killing the model call), a
   TTS call fails or playback fails, the loop aborts the same `AbortSignal` at once: the model
   stream, every pending TTS call and the sink stop, so a paid model stream never runs on after
   its turn has failed. The turn ends only once all three workers (model, synthesis, playback)
   have finished: `error`, then `speaking_end` if audio had started, then `turn_end`, then state
   `idle`. No event of a turn other than that idle transition is emitted after its `turn_end`.
   The assistant entry keeps what was heard (`interrupted: true`, `unspokenText` = the rest);
   the latency report's `interrupted` flag stays false (that flag means a human cut in).
6. **Transcript.** `loop.transcript` holds `{turn, role, text, at, audioStored}` entries; the
   runtime writes them into session history (O.10). An assistant entry is written only when
   something was heard (a completed turn with text, or at least one sentence whose playback
   started); when a turn is cut short before that, `turn_end` carries `entry: null` and
   `unspokenText`, so session history never gets an empty assistant line. Audio is never stored
   unless `storeAudio: true` (see below).

### Latency budget (O.5, D.8)

Every turn produces a `LatencyReport`; each stage has `ms`, `targetMs` and `withinTarget`, and
the total equals the sum of the four stages so the UI can show where time goes.

| Stage | Measured from -> to | Target | Notes |
| --- | --- | --- | --- |
| `endOfTurnMs` | last speech -> turn end detected | 200 ms | measured on the clock in both modes. Open mic: arrival of the chunk holding the last loud frame (the VAD's `speech_end.atMs` mapped back to its push time) -> `speech_end` reported, so the configured hangover **plus** capture and delivery delay; equals the 200 ms hangover only when chunks arrive in real time. PTT: last audio chunk -> release |
| `finalTranscriptMs` | turn end -> STT final | 300 ms | Deepgram `Finalize`; faster-whisper one pass over the utterance |
| `modelFirstTokenMs` | STT final -> first model delta | 500 ms | Haiku, low effort, cached context (runtime) |
| `firstAudioMs` | first delta -> first audio chunk | 200 ms | includes waiting for the first full sentence; `ttsFirstByteMs` isolates TTS |
| `totalToFirstAudioMs` | sum of the four | 1200 ms | the phase-5 gate measures the median per platform (`medianTotalToFirstAudio`) |

`formatLatencyReport()` prints the strip the UI shows. Unreached stages are `null` and never
count as within target. Timing comes from `Clock.monotonic()`, so `SimulatedClock` makes it exact
in tests (open-mic tests push chunks with `clock.tickMonotonic(chunkDurationMs)` before each one
to stand in for a device delivering in real time). The open-mic mapping needs
`AudioChunk.timestampMs` on one monotone capture timeline per stream; a timeline that restarts
clears the loop's push log, and a chunk no longer in the log (10 s of 20 ms chunks) falls back
to the hangover value.

### Providers and selection (O.4)

| Provider | Kind | Availability probe | Transport |
| --- | --- | --- | --- |
| `faster-whisper` | local STT | `python -c "import faster_whisper"` | `python/fr_stt.py` over stdin frames / JSON lines |
| `kokoro` | local TTS | `python -c "import kokoro"` | `python/fr_tts.py` over stdin/stdout frames |
| `piper` | local TTS | `piper` on PATH (or a given path) and the `.onnx` model | one process per sentence, `--output-raw` |
| `deepgram` | cloud STT | secret ref resolves | WebSocket (`ws`), key in `Authorization: Token` |
| `cartesia` | cloud TTS | secret ref resolves + voice id | WebSocket per sentence, key in `X-API-Key` (`keyInQuery` opt-in) |
| `elevenlabs` | cloud TTS | secret ref resolves + voice id | streaming HTTP, key in `xi-api-key` |
| `fake-stt`, `fake-tts` | fake | always | scripted, Clock-driven |

Python lookup: `FORERUNNER_PYTHON`, then `python3`/`python` (Linux) or `python`/`py`/`python3`
(Windows); an explicit `python` option overrides. Helpers are spawned with argv arrays through
`@forerunner/platform` `spawnProcess`, never a shell, and killed with `killTree` on dispose.

`VoiceProviderRegistry.selectStt/selectTts({preferred, hasSecret})` applies the default policy
**local if available, else cloud if its key is configured, else fake**, and returns `policy` and
a human-readable `reason` plus a status row per provider for the Extensions panel. `preferred`
is the panel's choice; when it is unavailable the reason says so and the policy continues.

Cloud keys are secret references (`secret:deepgram_api_key`) resolved through the injected
`SecretResolver` right before a connection. Values never go into URLs (unless Cartesia's
`keyInQuery` is set on purpose), log lines (`log()` redacts anyway) or error messages. Tests
assert the key is absent from URLs and from captured logs.

### Where device IO lives

Not here. The Tauri shell (`apps/desktop`) captures the microphone with WASAPI (Windows) or
PipeWire/PulseAudio (Linux), pushes `AudioChunk`s into `VoiceLoop.push()`, and implements
`AudioSink` over the output device (with echo cancellation where the OS offers it; without it,
open-mic barge-in can trigger on the agent's own voice, so the shell defaults to push-to-talk on
devices without AEC). The Android app uses the same loop over the phone's audio session. The
cloud runner has no device and uses `pacedSink`.

### What is stored

- Transcripts: always, as `TranscriptEntry` rows handed to session history (`audioStored: false`).
- Spoken approvals: `spokenApprovalRecord(turn, line, clock, subject)` logs the exact
  transcript line with the decision and, when refused, the reason (`blockedBy`) (O.7).
  `expectYes()` is conservative, because it gates above-routine actions and spending:
  - unambiguous affirmatives (yes, confirm, approve, go ahead, do it, jawohl, oui, d'accord,
    adelante, va bene, akkoord, sim, ...) approve a line of any length;
  - words that also start instructions or acknowledgements (ok, sure, correct, fine, right, ja,
    genau, si, claro, vale, certo, oke, ...) approve only a line of at most three words
    ("Correct.", "That's right", "Fine by me"), so "Correct the budget first" is refused;
  - any negation, stop word or hesitation ("not", "wait", "maybe", "nein", "non", "nee", ...)
    refuses (`negated`, `blockedBy: "negation"`);
  - a question refuses: a question mark, an interrogative lead ("is that", "what", "ist das",
    "est-ce", "es eso", "is dat", ...) or "what/which/how much/how many" (and their German,
    French, Spanish, Italian, Dutch forms) anywhere ("Sure, what is it exactly?");
  - a qualifier ("but", "aber", "mais", "pero", "ma", "maar", "mas") refuses ("Fine, but how
    much does it cost?").
  A refused line costs one repeated question; the agent reads the action back again.
- Audio: only with `storeAudio: true`. Then each turn's user and assistant PCM is written as
  `turn-NNNN-user.wav` / `turn-NNNN-assistant.wav` under `appDirs().data/voice/<session>/`
  (override `audioDir`), next to `RETENTION.md` which says the files are local, unsynced, unread
  by agents and safe to delete. Entries then carry `audioStored: true` and `audioFile`. The user
  WAV is written in the background so disk IO never delays the model call.

## How to change it

- New provider: see `adding-a-voice-provider.md`.
- VAD thresholds: `EnergyVad` options (`frameMs`, `energyThreshold`, `zcrMax`, `minSpeechMs`,
  `endOfTurnSilenceMs`). Keep `test/vad.test.ts` deterministic: build input with
  `wav.synth/silence/noise` and `chunkify`; events must not depend on chunk size.
- Sentence rules: `SentenceSplitter` holds the abbreviation list (English, German, French,
  Spanish, Italian, Dutch) and the ellipsis/closing-quote/guillemet rules. Add a case to
  `test/sentences.test.ts` with the streamed-vs-whole check.
- Latency targets: `DEFAULT_LATENCY_TARGETS` in `latency.ts`; the loop accepts `targets` for
  per-project overrides. Changing the stage anchors changes the spec's budget: ADR first.
- Loop behaviour: `VoiceLoop` options (`mode`, `bargeIn`, `prefetchSentences`, `preRollMs`,
  `sttFinalTimeoutMs`, `storeAudio`). Every state transition emits a `state` event; add new
  events to `VoiceLoopEvent` rather than new callbacks.
- Helper protocol: `framing.ts` and the docstrings in `python/fr_stt.py` / `fr_tts.py` must
  stay identical; `test/local-helpers.test.ts` runs the Node side against
  `test/fixtures/fake_*_helper.mjs`, which speak the same protocol.

## Tests

`pnpm vitest run --project unit packages/voice` (157 tests, about 2 s, no network):

| File | Covers |
| --- | --- |
| `test/vad.test.ts` | burst + silence timing, 150 ms minimum, hangover, chunk-size independence, noise rejection, stereo |
| `test/sentences.test.ts` | streaming boundaries, abbreviations, decimals, list markers, ellipses, quotes, newlines, ¿ ¡ « » |
| `test/wav.test.ts` | WAV round trip, validation errors, generators, chunkify, resample, downmix, byte views |
| `test/framing.test.ts` | frame encoding, split-frame reassembly, JSON lines with CRLF |
| `test/fake-providers.test.ts` | scripted partials/final with Clock delays, per-session scripts, abort |
| `test/latency.test.ts` | stage sums, over-target flags, null stages, custom targets, median |
| `test/approval.test.ts` | yes variants in seven languages, short ambiguous lines, negations and hesitation, questions and qualifiers refused (the critic's five false positives), instructions with an affirmative word refused, `blockedBy` in the record, exact line in the record |
| `test/registry.test.ts` | local -> cloud -> fake policy with reasons, preferred, throwing probes, replace by name |
| `test/availability.test.ts` | probes return `{ok:false}` for missing interpreter/module/binary/model/key; invalid module names never spawn |
| `test/local-helpers.test.ts` | faster-whisper, Kokoro and Piper Node sides against protocol-identical node stand-ins: streaming, resampling, errors, cancel (no leaked request on a pre-aborted call); `HelperProcess.stop()` grace kill timed on a `SimulatedClock` against a helper that ignores stdin closing |
| `test/python-helpers.test.ts` | `py_compile` of both helpers and `--selftest` (skipped visibly when no Python) |
| `test/cloud.test.ts` | Deepgram, Cartesia, ElevenLabs with fake transports replaying captured-shaped messages; keys only in headers, never in logs |
| `test/loop.test.ts` | PTT turn where `totalToFirstAudio` equals the sum of scripted delays; pipelining order and overlap; PTT and VAD barge-in within one chunk with a clean next turn; barge-in while thinking writes no empty assistant entry (`unspokenText` on `turn_end`); over-target flags; empty transcript; `stop()`; spoken approval; STT error; converse ignoring its signal; failures: `converse()` throwing while audio plays (synthesis and playback aborted, `sink.stop()`, nothing but the idle transition after `turn_end`), throwing before audio (no late `speaking`), a failing TTS aborting the model signal with no further deltas; open-mic pre-roll and measured end of turn (200 ms in real time, 250 ms with a late chunk); audio storage on/off |

Live validation of the cloud providers is **pending keys** (`docs/status/BLOCKERS.md`, row
"Voice keys"): the message shapes come from the vendors' public API documentation, not from
captured traffic. Local model runs (faster-whisper, Kokoro, Piper) are exercised through the
protocol stand-ins; a run with the real packages installed is an integration test to add when a
runner image has them (`*.integration.test.ts`, skipped visibly otherwise).

## Known issues

- faster-whisper has no true incremental mode: partials re-transcribe the whole utterance every
  `partialIntervalMs` (1 s) and are skipped when newer audio is already queued. Final transcript
  latency for a 5 s utterance on CPU with the `base` model is around 300 to 600 ms; use
  `small`/GPU for better accuracy or Deepgram for the lowest latency.
- Cartesia opens one WebSocket per sentence (simple, robust); reusing a connection with
  `context_id` continuation would save roughly 100 ms per sentence after the first.
- Cartesia's documented auth for WebSockets is the `api_key` query parameter; the header form is
  used by default to keep keys out of URLs. If a live test shows the header is rejected, set
  `keyInQuery: true` (the URL is then never logged at debug level either: the logger redacts).
- Open mic without echo cancellation can barge in on the agent's own voice; the shell decides
  per device. The VAD's 150 ms minimum speech and the energy threshold are the only guards here.
- Audio storage writes WAV at the capture rate (16 kHz mono) and the TTS rate; there is no
  size cap or automatic retention beyond the note.
- `expectYes()` refuses any line with "what"/"which" in it, so "Yes, do what you proposed" is
  not an approval; the agent asks again. Chosen on purpose (a false yes spends money).
- A TTS provider that ignores its abort signal can still delay the end of a failed or
  interrupted turn until it returns; the fake, local and cloud providers all honour it, and the
  model stream is the only worker raced against the abort.

## Requirements covered

| ID | Clause | Where | Test |
| --- | --- | --- | --- |
| O.3 | push-to-talk or open mic with VAD; streaming STT; sentence-by-sentence streaming TTS; interrupt mid-sentence | `loop.ts`, `vad.ts`, `sentences.ts` | `test/loop.test.ts`, `test/vad.test.ts`, `test/sentences.test.ts` |
| O.4 | local by default (faster-whisper, Kokoro or Piper), cloud option (Deepgram, Cartesia or ElevenLabs), chosen in Extensions | `providers/*`, `registry.ts` | `test/registry.test.ts`, `test/local-helpers.test.ts`, `test/cloud.test.ts`, `test/availability.test.ts` |
| O.5 | latency budget per stage, under 1.2 s to first audio, each part measured and shown | `latency.ts`, `loop.ts` | `test/latency.test.ts`, `test/loop.test.ts` |
| O.7 | waits for "yes"; spoken approvals logged with the transcript line | `approval.ts` (the read-back and confirm step itself is the runtime's conversation agent) | `test/approval.test.ts`, `test/loop.test.ts` |
| O.10 | transcripts kept, audio not stored unless turned on | `loop.ts`, `store.ts` | `test/loop.test.ts` (audio storage) |
| D.8 | voice chat first audio under 1.2 s (measurement; the model choice is the runtime's) | `latency.ts` | `test/loop.test.ts` |
| L.6 | TTS for summaries and alerts, STT for voice notes, pluggable provider | `splitSentences()` + any `TtsProvider`; any `SttProvider`; `registry.ts` | `test/sentences.test.ts`, `test/registry.test.ts` |
| P.7 | `adding-a-voice-provider.md` | this doc and `adding-a-voice-provider.md` | docs check |
| checklist "Voice keys" | keys missing -> local only; synthesised speech clips fed to STT in tests | `registry.ts` policy; `wav.synth` fixtures | `test/registry.test.ts`, `test/local-helpers.test.ts` |
