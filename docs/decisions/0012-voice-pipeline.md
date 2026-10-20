# 0012 — Voice pipeline: PCM contract, local helpers over stdio, latency anchors

Date: 2026-10-20
Status: accepted

## Context

Module O asks for a voice loop with push-to-talk or open mic, streaming STT, sentence-by-sentence
streaming TTS, barge-in, pluggable local and cloud providers, and a per-stage latency budget
"measured and shown". It leaves open where device IO lives, how the local Python engines are
driven from Node, how the four stages are anchored so they add up, what barge-in keeps, and what
"audio not stored unless turned on" means on disk. Unit tests must run without a network, a
model download or an audio device, on Windows and Linux.

## Decision

1. **Device IO is outside the package.** `@forerunner/voice` exchanges `AudioChunk`s (16-bit PCM,
   any rate and channel count) with the Tauri shell, which owns WASAPI / PipeWire-PulseAudio and
   implements `AudioSink`. The package resamples and downmixes to 16 kHz mono for STT and the VAD;
   it never resamples TTS output (the shell's playback path does).
2. **Local engines run as long-lived helper subprocesses over stdio**, spawned with argv arrays
   through `@forerunner/platform`: `python/fr_stt.py` (faster-whisper) and `python/fr_tts.py`
   (Kokoro) with a 5-byte length-prefixed frame format in, JSON lines or 9-byte frames out.
   Piper runs one process per sentence with `--output-raw`. The Node side is tested against
   node scripts that speak the same protocol, so the framing, lifetime and cancellation paths are
   covered on every machine; the real engines are an integration test gated on their presence.
3. **Latency anchors.** `endOfTurnMs` = last speech to detection (VAD hangover, or PTT last chunk
   to release); `finalTranscriptMs` = detection to STT final; `modelFirstTokenMs` = STT final to
   first delta; `firstAudioMs` = first delta to first audio chunk (so waiting for the first full
   sentence counts against the budget); the total is the sum of the four. Unreached stages are
   `null` and never "within target".
4. **Barge-in keeps what was heard.** A VAD `speech_start` (or `pressStart()`) while the agent
   speaks aborts TTS and the model stream through one `AbortSignal`; the assistant transcript
   entry is marked `interrupted` with `text` = sentences whose playback started and
   `unspokenText` = the rest; the next capture opens immediately with a 300 ms pre-roll. The model
   stream is raced against the abort so a `converse()` that ignores its signal cannot hold the loop.
5. **Selection policy** in `VoiceProviderRegistry`: the Extensions choice if available, else the
   first available local provider, else the first cloud provider whose secret reference has a
   value, else the fake provider; the reason is returned for the panel.
6. **Storage.** Transcripts are always handed to session history with `audioStored: false`.
   With `storeAudio: true` the loop writes one WAV per turn and side under
   `appDirs().data/voice/<session>/` next to a `RETENTION.md`; the user WAV is written in the
   background so disk IO never delays the model call.
7. **Spoken approvals** are decided by `expectYes()` (affirmatives in seven languages; any
   negation or stop word wins) and logged through `spokenApprovalRecord()` with the exact line.
8. **Cloud keys** are secret references resolved at connect time and sent only in headers; a
   Cartesia `keyInQuery` opt-in exists because its documented WebSocket auth is a query parameter.

## Consequences

- The conversation agent (O.2) stays in `packages/runtime` and is injected as
  `converse(transcript, signal)`; this package never calls a model.
- `test/loop.test.ts` proves with `SimulatedClock` that `totalToFirstAudioMs` equals the sum of
  the scripted delays, that barge-in stops audio within one chunk, and that sentence *i+1* is
  requested the moment sentence *i* starts playing.
- Live validation of Deepgram, Cartesia and ElevenLabs is pending keys (`BLOCKERS.md`); their
  tests replay documented message shapes through injected transports.

## Alternatives considered

- **Driving faster-whisper through a Python HTTP server**: more moving parts, port management,
  no gain over stdio for a single local client.
- **Measuring `firstAudioMs` from the sentence being sent to TTS**: isolates the vendor better
  (kept as `ttsFirstByteMs`) but leaves the sentence-accumulation gap unaccounted, so the four
  stages would not sum to the total the spec asks for.
- **Running the VAD in the shell**: would duplicate it per platform and make barge-in untestable
  here; the energy + zero-crossing detector is cheap enough to run on every chunk in Node.
- **Keeping generated-but-unspoken text as the assistant turn after a barge-in**: misleads the
  model's next turn about what the person actually heard; keeping it as `unspokenText` lets the
  runtime decide whether to mention it.
