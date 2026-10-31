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
src/providers/local/helper-process.ts  long-lived helper subprocess (argv array, killTree); describeHelperExit; StderrTail (a crash's last 40 stderr lines)
src/providers/local/faster-whisper.ts  STT via python/fr_stt.py (JSON lines checked by a zod schema; one crash mid-utterance retried)
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
  `stop()` flushes on barge-in. `pacedSink(clock, aheadMs = PACED_SINK_AHEAD_MS)` (300 ms) has
  no device: it keeps a play-head (where the chunks handed over so far end) and resolves once
  the play-head is at most `aheadMs` beyond now, like a device with that much buffer; a chunk
  that comes after the play-head passed (TTS slower than real time) restarts it from now, and
  `stop()` resets it. The daemon's bridge and `/speak` use it with the 300 ms lead, so the
  window's player gets the first 300 ms of a reply at once and the rest at real time. It used
  to sleep each chunk's duration from the moment the previous sleep woke, which fell behind by
  the timer's lateness on every chunk (a loaded event loop, Windows timers): the frames
  reached the player slower than real time even with a fast TTS, and its queue ran dry inside
  words (`test/paced-sink.test.ts`). The loop's own default, with no `sink` passed (its tests,
  the e2e scenario), is `pacedSink(clock, 0)`: each chunk at its place on the play-head.
- `AudioSink.drain?(signal)` resolves once what was handed over has played out (`pacedSink`:
  sleeps to its play-head; at once on the abort or after `stop()`). The loop's play worker and
  the speaker's (`packages/runtime/src/voice/speak.ts`) await it after the last chunk unless
  aborted, so `speaking_end`, `turn_end` and `speak.done` come when the audio has played, not
  up to 300 ms early: the `/speak` player closes its output on `speak.done`, and a turn that
  ended early left the window playing a tail the daemon no longer knew about (a press then
  found no reply to barge in on). During the drain the loop is still `speaking`, so a press
  barges in. Tests: `test/paced-sink.test.ts`, `test/loop.test.ts` ("the turn ends only once
  the sink's play-head has played out"), `packages/runtime/test/speak-route.test.ts` ("the end
  of an utterance waits for its audio").

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
   completed sentence goes to TTS at once. Synthesis is sequential and runs ahead of playback:
   sentence *i+1* is requested as soon as sentence *i* has been fully synthesised and handed to
   playback (`prefetchSentences`, default 1, caps how far synthesis may run beyond the sentence
   playing), so with any faster-than-real-time TTS the synthesis of *i+1* overlaps the playback
   of *i*. Playback is strictly in order.
4. **Barge-in.** In open mic, mic audio keeps running through the VAD while the agent thinks or
   speaks, and a `speech_start` is the barge-in. In push-to-talk the press is the barge-in: mic
   audio arriving without a press (room noise, speaker echo without AEC) is ignored, so no
   capture can open that only a release could end. A barge-in aborts TTS and the model stream
   through one `AbortSignal`, calls `sink.stop()`, records the assistant entry as
   `interrupted: true` with `text` = the sentences whose playback started and `unspokenText` =
   the sentences that never started plus the splitter's pending remainder (taken from the
   sentence list, not from character offsets, so model output that separates sentences with
   newlines or double spaces is cut at the right place), and immediately opens the next capture
   with the pre-roll. A `converse()` that ignores its signal cannot hold the loop: the model
   stream is raced against the abort. The interrupted turn winds down in the background; when
   its TTS is slow to honour the abort, its tail runs after the next turn has started and then
   touches nothing of that turn: every state transition checks it belongs to the current turn,
   and the late assistant entry is slotted into the transcript in turn order.
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
7. **A press while the last turn transcribes.** An STT provider serves one session at a time
   (the faster-whisper helper drops the session in flight when a new one starts), so a
   push-to-talk press in `transcribing` is queued (`pressQueued`), never dropped: once that
   turn's final lands, the turn keeps the words, calls no model and ends as cut short
   (`barge_in` with `spokenText: ""`, `turn_end` with `entry: null`, latency
   `interrupted: true` and `continued: true`), and the queued capture opens (`turn_start` of the
   next turn). The human was not done talking: the words are carried into the next turn, whose
   model call gets them and its own words as one line (`transcript_final.carried
   { turn, text }`; its transcript entry and its `voice.turn` row's `said` keep its own words);
   a next turn with nothing said answers the carried words alone; a chain of such presses
   carries all of them, capped at `MAX_CARRIED_CHARS` (2000, the most recent words, cut at a
   word); `stop()` drops what is carried. The carry is owned by the turn the press opens
   (`forTurn`): only that turn's model call takes it, and it is dropped when that turn fails
   or ends without a final (an STT error or timeout), so it never reaches a later, unrelated
   turn. A press withdrawn before the cut (a release, the cap or an aborted request while the
   user audio is written) leaves the turn to be answered with its own words, nothing carried;
   one withdrawn after the cut drops the carry. A `stop()` while the user audio is written ends
   the turn there (cut short, no model call, O.9), and `respond()` itself refuses to call the
   model once the loop is stopped. The `voice.turn` row and `VoiceTurnView` carry
   `continued` (the cut turn) and `carriedFrom` (the turn whose words the next one got). An empty transcript, an STT failure or
   timeout opens the capture too; a release before it opened cancels it; `stop()` drops it.
   The daemon's press route waits for it (`VoiceBridge.pressAndWait`, at most
   `VOICE_PRESS_WAIT_MS` (3 s) on the clock, and no longer than the request: past either the
   press is withdrawn, `cancelQueuedPress()`, and the route answers the session as it is) and
   answers once the new turn listens, so a shell can tell a press that counted (a newer turn,
   `listening`) from one that did not.
8. **Stop.** `stop()` is immediate in every state (O.9): a capture still listening is closed; a
   turn waiting for its final transcript ends without a model call (`turn_end` with
   `entry: null` and latency `interrupted: true`, no `converse()`, no TTS); a reply being
   generated or played is aborted like a barge-in. Input is ignored until `start()`.
9. **Text frames.** The reply's text is out before its audio: every delta is a `model_delta`
   event as it arrives, every finished sentence a `sentence` event (`index`, the same index
   the sentence's `audio` events carry as `sentenceIndex`) before it goes to TTS, and the
   human's words are `transcript_partial` events while the capture runs and one
   `transcript_final` before the model is called (`test/loop.test.ts`, "VoiceLoop reply
   text"). The daemon streams them all, numbered (`seq`); the panel builds its lines from them
   (`apps.md`). Through the daemon's bridge the deltas come from the conversation agent's
   `SentenceGate` (`runtime.md`): whole sentences, after an empty first piece that stamps the
   model's first token, so a reply streams sentence by sentence (in text mode too) and a reply
   cut off at `max_tokens` never shows its unfinished last sentence; the panel ignores the empty
   piece.

### Reply in text

`replyMode` (`"voice" | "text"`, default `voice`; `REPLY_MODES`) decides how a reply goes out.
`setReplyMode()` changes it from the next turn: a turn takes the mode when it starts (its
capture opens, `turn_start` carries it) and keeps it through its reply and its `turn_end`,
including a turn that ends without a reply (an empty transcript, a stop while transcribing),
so a switch while the human speaks or the reply runs never relabels that turn. In `text` the loop runs the model and the sentence splitter
as usual (the `model_delta` and `sentence` events) but no synthesis and no playback: the TTS
is never called (no CPU for it, and a local helper is not even started), no `audio`,
`speaking_start` or `speaking_end` event comes, the state goes `thinking` -> `idle`, and the
turn ends when the text is complete. The latency report has `modelFirstTokenMs` and no first
audio (`firstAudioMs`, `totalToFirstAudioMs`, `ttsFirstByteMs` null). `/performance` leaves
text replies out on purpose (`eventSample` returns null for a `voice.turn` row with
`replyMode: "text"`, whatever figures it holds): its voice row is `voice_chat`, first audio, and
a text reply has none; its first token is not sampled under another mode either (`text_chat`
is the typed chat's replies, which run at another effort), so text-reply turns have no
response-time figure on that page yet. A barge-in (a press, or
open-mic speech) stops the generation, as a typed stop does: the assistant entry keeps what was
generated (it was shown), `interrupted: true`, no `unspokenText`. `turn_end` carries
`replyMode`. The daemon's bridge takes the mode at the session start, with a press
(`pressed: true` only: a release carrying `replyMode` is refused, 409, since its turn's mode is
already fixed) and with a typed line (`POST /voice/sessions`, `…/press`, `…/text` with
`replyMode`; the session keeps the last one), takes each turn's mode from its `turn_start`,
writes it on the `voice.turn` row and the `VoiceTurnView`, and refuses a heard figure for a
text turn (409: nothing was spoken). A session the phone relay holds (`relay.ts`,
`replyModeLocked`) keeps spoken replies: the phone reads back what the PC said, so a reply mode
other than voice is refused on it. `VoiceSessionView.recentTurns` (only on
`GET /voice/sessions/:id`; the press, start and stop answers leave it out, and a chunk's
`POST …/audio` answers a lean `VoiceAudioAckView { id, state, turn, lastSeq }`) carries the last
`VOICE_RECENT_TURNS` (8) ended turns, so a shell without the event stream that missed one (a
barge-in while it waited) can still show it. `voice-run report` leaves text replies
out of both first-audio figures and says how many (below).

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
(Windows); an explicit `python` option overrides. With a voice profile installed (below) the
daemon passes the managed venv's interpreter as that option, unless `FORERUNNER_PYTHON` is set. A candidate that spawns but never runs
Python (the Microsoft Store `python` alias exits 9009 with "Python was not found") is skipped
and the next one tried (`interpreterDidNotRun`). Helpers are spawned with argv arrays through
`@forerunner/platform` `spawnProcess`, never a shell, and killed with `killTree` on dispose.
The STT helper's JSON lines are validated with a zod schema (`HelperMessageSchema`): unknown
keys are ignored, `null` stands for absent, and a line that does not fit is logged and dropped.

`VoiceProviderRegistry.selectStt/selectTts({preferred, hasSecret})` applies the default policy
**local if available, else cloud if its key is configured, else fake**, and returns `policy` and
a human-readable `reason` plus a status row per provider for the Extensions panel. `preferred`
is the panel's choice; when it is unavailable the reason says so and the policy continues.
`preferredBy` names where the choice came from for the reason (`"deepgram" selected in
Extensions (voice-deepgram)`, `"fake-tts" set by FORERUNNER_VOICE_TTS`); default "selected in
Extensions". `excluded` names providers the policy must not fall back to, each with the reason
its status row shows (`switched off in Extensions`, `key not granted in Extensions`): an
excluded provider is not probed, its secret is never asked for, and its status row is
`available: false` with that reason; with nothing else to pick the selection throws
`unavailable` as usual. Its message keeps each provider's own reason (U-075: `no STT provider
available: faster-whisper: local voice is off ...; deepgram: no value for
secret:deepgram_api_key`; before, only `no STT provider available`). The runtime puts what to do
first (`voiceUnavailableReason` in `packages/runtime/src/voice/sessions.ts`): `install voice in
Settings → Voice (<that message>)`, or, while an install runs (`VOICE_INSTALL_RUNNING_REASON`),
`wait for the voice install in Settings → Voice to finish (...)`. That is the reason of
`GET /voice/status` (Talk shows "voice is unavailable: <reason>. Type instead."), of a session
start's 503, and of `pickTts` (read aloud, the voice notification channel). The runtime fills the list from the panel (below), so off means off.

### Voice profiles and the managed install (ADR 0090)

Which local speech stack an install has is its **voice profile**, chosen in `fr setup`
(asked interactively; `--voice none|cpu|gpu` without asking), in Settings → Voice, or with
`fr voice install [--cpu|--gpu] [--python <path>]`, `fr voice remove` and `fr voice status`:

| Profile | STT | TTS | Disk (download) |
| --- | --- | --- | --- |
| `none` | no local STT (cloud only, with a key) | no local TTS | 0 |
| `cpu` | faster-whisper `--device cpu --compute-type int8` | Kokoro `--device cpu` | about 2.3 GB (about 1 GB) |
| `gpu` (NVIDIA) | faster-whisper `--device cuda --compute-type float16 --cpu-fallback` | Kokoro `--device cuda --cpu-fallback` | about 8 GB (about 4.5 GB) |

The sizes are measured (`install-types.ts` says how); the catalog with the trade-offs lives in
`VOICE_PROFILE_INFO` so the CLI question, the card and the daemon view say the same.

- **Where.** `packages/runtime/src/voice/install.ts` is the one installer. Everything it
  downloads goes under the dependencies folder (`packages/runtime/src/dependencies.ts`,
  `resolveDependenciesDir`; U-011 in `docs/status/UPDATE-LOG.md`):
  - `FORERUNNER_DEPENDENCIES_DIR` when set;
  - else `<install folder>/dependencies`, when the runtime is an installer's payload (the
    folder above the one holding `runtime.json`) and it can be written; beside an AppImage,
    `<folder of the .AppImage>/Forerunner-dependencies`;
  - else the data folder, with a note saying why (`folderNote` in `GET /voice/install`).

  Under it: a venv per profile, `voice/venv-cpu` / `venv-gpu`, the models in `voice/models`
  (the helpers' `HF_HOME`; the speech recognition model in its own plain folder
  `voice/models/faster-whisper/<model>`, `whisperModelDir`, U-024), pip's cache in `voice/pip-cache` (`PIP_CACHE_DIR`) and its
  temporary files in `voice/tmp` (`TMP`, `TEMP`, `TMPDIR`; removed after the install; 1.0.2
  unpacked the GPU wheels into `%TEMP%` on C:). `<config>/voice.json` holds the profile, what
  was installed (venv, interpreter, the requirements file's SHA-256) and what the last check
  verified per side (`device`, `computeType`, `fallback`). No `voice.json` means the profile was
  never chosen and the helpers run as before profiles (any Python, device `auto`). The helpers
  and `fr voice status` read an install where `voice.json` recorded it (`recordedVoiceRoot`:
  only a path of the installer's own shape, `.../voice/venv-cpu|gpu`, since its folders are
  deleted on a move or a remove), so a 1.0.2 install in `<data>/voice` keeps working. `fr setup`
  never moves a working install. An install from Settings or `fr voice install` builds in the
  dependencies folder and, once verified, removes the copies elsewhere. `fr voice remove`
  removes them from every place: now, recorded, and `<data>/voice`.
- **What** (all in `packages/voice/python`, every file pinned by sha256):
  `torch-<profile>.txt` is PyTorch alone (`2.11.0+cpu` / `+cu128`, the cp312 Windows and Linux
  x86_64 wheels), installed with `--no-deps --require-hashes` from its own index (`TORCH` in
  `install.ts`); `requirements-<profile>.txt` is a universal lock of `requirements-<profile>.in`
  from PyPI only, installed with `--no-deps --require-hashes --index-url https://pypi.org/simple`;
  the `.in` has the exact top-level pins, on gpu `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` at
  the versions torch 2.11.0+cu128 requires on Linux, the spaCy model by URL with `#sha256=`, and
  torch's own Requires-Dist (copied from its wheel metadata, since torch is installed without
  dependencies); `pip.txt` is pip itself; `build-tools.txt` is the lock's setuptools;
  `pin-metadata.json` is every pin's Requires-Python and whether PyPI has a wheel;
  `torch-requires.json` is torch's Requires-Dist per platform. Every pip run is
  `--only-binary :all:` except docopt (`SOURCE_BUILDS`, sdist only): setuptools from
  build-tools.txt is installed first and the lock runs with `--no-binary docopt
  --no-build-isolation`, so its build fetches nothing. Windows x64 and Linux x86_64 only: another OS
  is refused up front (`SUPPORTED_TARGETS`); the Python's `sysconfig.get_platform()` must be
  `win-amd64` or `linux-x86_64` (`SUPPORTED_PYTHON_PLATFORMS`, checked on the base interpreter
  and on a reused venv before any download); Node's architecture is only logged as a hint.
  Then `pip check`. The environment's `PIP_EXTRA_INDEX_URL` and `PIP_FIND_LINKS` are not passed
  to pip. The marker `<venv>/forerunner-voice.json` holds a hash over pip.txt, the torch file
  and the lock; a change to any reinstalls.
- **Updating the pins.** Edit `requirements-<profile>.in` (or `TORCH`, `PIP_VERSION` in
  `install.ts`; when torch changes, copy its new Requires-Dist into the `.in`), then
  `pnpm voice:lock` (`scripts/voice-lock.ts`; needs the network and uv, `pip install uv` or
  `UV=<path>`; Node's fetch behind a proxy needs `NODE_USE_ENV_PROXY=1`). It rewrites the torch
  files from the PyTorch index page, the locks with `uv pip compile --universal
  --generate-hashes --python-version 3.12` (torch dropped by an override whose marker cannot
  hold on 3.12) and `--exclude-newer` (the recorded `LOCK_EXCLUDE_NEWER`; it checks uv is
  `UV_VERSION`, so the same inputs give the same lock), the `.in`s' torch-dependencies block from
  the torch wheels' metadata (`torch-requires.json`), `pip.txt`, `build-tools.txt` and
  `pin-metadata.json` (a pin without a wheel outside `SOURCE_BUILDS` fails it).
  `test/voice-pins.test.ts` then checks
  the files offline: exact and hashed, no index options, torch only in its own file, every
  source pin in the lock, and every pin's Requires-Python admitting 3.12.
- **Steps** (each streams `VoiceInstallEvent`s: `step`, `log`, `progress`, `warning`, `error`,
  `result`): the NVIDIA GPU (`nvidia-smi --query-gpu=...`, on Linux also
  `/proc/driver/nvidia/version`); the venv, reused when its interpreter runs, made again when
  it does not, from Python 3.12 (numpy 2.5.4 needs it, kokoro 0.9.4 refuses 3.13) found in a
  fixed per-OS order: `py -3.12`, `python`, `python3` on Windows, `python3.12`, `python3`,
  `python` on Linux (none: the `winget` or `apt` line); the espeak-ng path check (below); pip,
  torch and the lock as above (`--progress-bar raw --resume-retries 5`) and `pip check`, unless
  the marker matches; `python/fr_voice_models.py` fetches faster-whisper's model and Kokoro-82M
  with the voice, with byte progress, skipping what is cached; then the check. The speech model
  (U-024) goes into the plain folder (`--whisper-dir`, `download_model(..., output_dir=...)`:
  real files, never the cache's `snapshots/<rev>/model.bin` links to blobs, which a later run
  skipped even when an interrupted run had left them broken). After the download the folder is
  checked (`model.bin` and `config.json` present, real files, not empty, the sizes the Hub
  lists); a broken one is deleted and fetched once more (a `retry` line, shown as a warning:
  "the speech recognition model was downloaded broken (<why>); fetched it once more") before the
  step fails with the reason. The sizes found are written to `forerunner-model.json` in the
  folder, and the model's copy in the old cache (`hub/models--Systran--faster-whisper-<model>`)
  is removed once the folder is good. Between steps and
  after each process the run checks its `AbortSignal`: a cancel kills the running process,
  records nothing and frees the lock.
- **The check** runs the real helpers: `fr_stt.py` on 0.5 s of silence (ready, then a final)
  and `fr_tts.py` on one sentence (ready, audio, done). Both report the device in their ready
  line/frame (`device`, STT also `compute_type`, and `fallback` when the CPU took over). On gpu
  the check runs without `--cpu-fallback`; a failure prints `WARNING: GPU check failed for
  speech recognition|speech (Kokoro): <error>`, checks the CPU instead, records the error as
  `fallback`, and ends with exit code 2 (0 done, 1 failed). A side whose check fell back then
  starts on the CPU at run time (no CUDA attempt at every start); `fr voice install --gpu`
  checks the GPU again.
- **Resumable, idempotent.** pip resumes interrupted downloads and keeps its cache; the marker
  and `voice.json` are written only after their step succeeded; running the install again
  finishes an interrupted one, and on an installed, unchanged profile only verifies (`fr setup`
  with the same answer does nothing at all). `<data>/voice/install.lock` keeps the CLI and the
  daemon from installing at once. No argument carries a secret.
- **Switching** builds the new venv beside the old one; the old one is deleted after the new
  one is verified (the daemon stops its helpers first; a venv a running daemon holds on Windows
  is left with a warning and removed at the next install). `none` deletes both venvs and the
  models.
- **At run time** `LocalVoice` (`packages/runtime/src/voice/local-profile.ts`) stands in the
  registry as `faster-whisper` and `kokoro` and builds the helpers from `voice.json` at every
  use (`localVoiceSettings`): the venv's interpreter, the devices above, `HF_HOME`, and
  `--model-dir <whisperDir>` (U-024). `fr_stt.py` loads the model from that folder when it
  holds one, and by name from the cache otherwise (an install from before keeps working); a
  folder `forerunner-model.json` says is broken (a link, a missing, empty or short file), or a
  model CTranslate2 answers "Unable to open file" for, is deleted and fetched once more into the
  folder (a stderr line says so; a model from the old cache is moved there the same way and its
  cache copy dropped) before the load fails with "model load failed: <why>". A change from
  the CLI or the card applies at the next voice session; the old helper processes are stopped.
  `none`, or a profile whose venv is missing, reports local voice unavailable with the command
  that turns it on, unless `FORERUNNER_PYTHON` is set: it wins in every case (with `none` or no
  venv the helpers then run as before profiles, with that interpreter and device `auto`).
  `voice.json` is written atomically (temporary file, then rename).
- **Live sessions.** `LocalVoice` counts the open STT sessions and the sentences in synthesis
  (`inUse()`); while any is in use a changed `voice.json` waits and the old helpers keep serving
  (new sessions too), and the swap happens at the first use after. While an install runs
  (`blocked`, wired in `compose.ts` to `VoiceInstallJobs.running`) new local sessions and new
  sentences, read-aloud included, are refused with the reason; cloud providers are not blocked.
  The install is refused while a voice session is open or `inUse()` is not zero. A swap
  retires the old pair: `FasterWhisperStt.retire()` / `KokoroTts.retire()` stop the helper and
  mark the provider so `ensureProcess()` rejects with `unavailable` "... provider was disposed
  (retired)" (`test/disposed-providers.test.ts`); a session holding the old provider gets an
  error instead of a helper respawned from the old venv. A `FasterWhisperStt` load that is
  still probing for an interpreter when it is retired or disposed spawns nothing once the
  probe returns: it rejects with `unavailable` if the provider is disposed or `ready` is no
  longer its own. The probed interpreter is cached in `pythonExe`, so later loads skip the
  probe. `dispose()` alone keeps its meaning
  (stop the current helper and end the open utterance; the next utterance may start a new
  helper), which the STT crash handling relies on. A
  session's use ends at its final or error even if its reader never leaves the loop, and
  `release()` resets a count still held (a session nobody read or closed) with a warning.
- **Settings → Voice** (`apps/ui/src/pages/VoiceSettingsCard.tsx`) reads `GET /voice/install`
  and switches through `POST /voice/install`, a background job of the same installer
  (`install-routes.ts`: one job at a time, 409 while a voice session is open), following
  `GET /voice/install/events` (SSE with the bearer header, or JSON). When the stream ends while
  the job still runs (a proxy, a sleeping laptop), or fails, the card opens it again from the
  last event it has, waiting 0.5 s doubling to 10 s (`reattachDelay`) and giving up after 8
  failures in a row; an error shown clears when events arrive again. **Cancel** calls
  `POST /voice/install/cancel`. `POST /voice/install/cancel` aborts the job (the daemon's shutdown does the same). The
  route was chosen over showing the CLI command because the installer already streams events;
  the card still shows the command.
- **CUDA libraries from wheels.** `fr_stt.py` `setup_cuda_libraries()` runs before
  faster_whisper is imported on any device but the CPU: Windows puts every
  `site-packages/nvidia/*/bin` through `os.add_dll_directory` and first on `PATH`
  (ctranslate2 loads `cublas64_12.dll` lazily with a plain `LoadLibrary`, and its bundled
  `cudnn64_9.dll` loads the cuDNN parts by name); Linux loads `libcublas*.so.12` and
  `libcudnn.so.9` by absolute path with `RTLD_GLOBAL` (`LD_LIBRARY_PATH` is read only at process
  start). A non-CPU device then warms the model with a silent transcription so a missing cuBLAS
  fails at load, where the fallback can still say so in the ready line.
- **espeak-ng path limit.** Kokoro's English G2P uses espeak-ng through `espeakng_loader`, which
  passes `<site-packages>/espeakng_loader/espeak-ng-data`; espeak-ng keeps 159 characters of it
  (229 on Windows) and otherwise exits on the first sentence with "Error processing file
  '/home/runner/work/espeakng-loader/.../phontab'". The installer refuses such a venv path
  before downloading (`ESPEAK_PATH_MAX`), naming `FORERUNNER_HOME`. Default data directories
  are around 105 characters.

### Which provider is preferred (spec O.4)

The runtime decides `preferred` per side (`packages/runtime/src/voice/providers.ts`,
`resolveVoicePreferences`), read afresh at every `GET /voice/status` and every session start,
so a toggle in the Extensions panel applies at the next voice session without a restart:

1. **Environment override.** `FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS` name a provider
   that wins over the panel for that side; every enabled row for the side is reported as
   `overridden by FORERUNNER_VOICE_TTS=<name>`.
2. **The `voice-*` rows.** Each built-in voice catalog entry names the providers it stands
   for (`voice: { stt: [...], tts: [...] }`, in order of preference): `voice-deepgram`,
   `voice-cartesia` and `voice-elevenlabs`. Local voice has no row since U-023: it is installed
   and chosen in Settings -> Voice, and the policy prefers it whenever no cloud row is on (the
   `voice-local` row of 1.0.4 is retired at the next start, `extensions.md`). The resolver
   still handles a row that stands for several providers or for local ones (rows that need a
   key are considered first, then by name). Per side the first enabled row whose provider's own
   key (`VOICE_SECRET_REFS`) is granted on the row and has a value in the vault, and one of
   whose providers is registered in this daemon, is in force; the preference carries every
   registered provider the row stands for (`providers`), so the panel counts the row in force
   when the registry picked any of them (Piper after a Kokoro that does not import). Every
   other row is listed in `preferences.skipped` with its reason: `switched off in Extensions`,
   `key not granted: secret:<name> is not in the row's permissions`, `no value for
   secret:<name>`, another row in force, none of its providers registered.
3. **Off means off.** A cloud provider whose installed row is switched off, or whose row no
   longer grants its key (a narrowing the human applied in the panel), goes on
   `preferences.excluded` for its side and the registry's fallback never reaches it: with no
   local provider the selection ends at `unavailable` (the fake in tests) rather than at a key
   in the vault, and the key is never read, not even for the probe. The local helpers are
   never excluded (free, private, the policy's default). A provider the environment or an enabled row put in force is never
   excluded by another row that stands for it.
4. **Nothing chosen.** The registry's policy above picks.

`GET /voice/status` carries the result as `preferences: { stt, tts, skipped }` (each preference
with the row's `providers`; `excluded` stays inside the daemon, the providers' status rows carry
its reason); Settings -> Voice shows the pair in force under the voice profile (U-023: one place
for voice; it re-reads on every `extension.changed` frame and after an install), and the
Extensions panel a badge on every cloud voice row (in force, preferred but fallen back with the
registry's reason, or not in force with the reason) with a line pointing to Settings -> Voice.

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

### How the shell reaches it

The loop is not driven by the shells directly: the daemon composes it once per voice session
(`packages/runtime/src/voice/`, [ADR 0048](../decisions/0048-voice-bridge-in-the-daemon.md);
`runtime.md`, "Voice" under the local daemon) over the conversation agent and the command
registry, and the shells talk to it over the daemon's `/voice` routes (`DAEMON_ROUTES` in
`packages/runtime/src/daemon/api-types.ts`, bearer token as for every route):

| Step | Route | What happens |
| --- | --- | --- |
| Can I talk? | `GET /voice/status` | `VoiceStatusView`: `available` with the STT and TTS provider the registry's policy picked and the reason, or `available: false` with the reason to show (no local helper and no key, or no model credential); every registered provider's status row with its key by reference only |
| Open | `POST /voice/sessions { projectId?, language?, mode?, replyMode? }` | 201 `VoiceSessionView` (`id`, `conversationSessionId`, providers, `replyMode`, `pending`); 503 `unavailable` with the reason when nothing can run. `replyMode: "text"`: every reply as text only ("Reply in text") |
| Listen | `GET /voice/sessions/:id/events` with `Accept: text/event-stream` (`?token=` allowed, `?afterSeq=` to resume) | SSE `voice.event` frames (`VoiceEventView`): the loop's `state`, `turn_start`, `transcript_partial`, `transcript_final`, `model_delta` (`{ text }`, each delta as the model generates it), `sentence` (`{ index, text }`, before its audio), `audio` (base64 16-bit PCM with `sampleRate`, `channels` and the `sentenceIndex` it belongs to: the shell plays it), `speaking_start`, `speaking_end`, `barge_in`, `turn_end` (with `replyMode`, the latency, the `entry` heard and `unspokenText`), `error`, plus `voice.first_audio` (first audio with how long after the end of the turn), `voice.readback` (approval needed: the card read back, `pending.id`), `voice.approval` (the decision with the exact line), `voice.answer`, `voice.turn` (done: the turn's record with the latency stages) and `voice.stopped`; `heartbeat` every 15 s. Without the SSE accept header the same route answers the kept frames as JSON (audio frames are never kept) |
| Speak (push-to-talk) | `POST /voice/sessions/:id/press { pressed: true, replyMode? }` (the mode applies from this turn's reply and stays), then one `POST /voice/sessions/:id/audio` per captured chunk (JSON `{ pcm (base64 int16 LE), sampleRate, channels, timestampMs }` or the raw bytes as `application/octet-stream` with `?sampleRate=&channels=&timestampMs=`), then `{ pressed: false }` | the loop's turn: STT, the agent, TTS; a press while the agent speaks is the barge-in. In `open_mic` mode the shell streams audio continuously and never presses |
| Type (no microphone) | `POST /voice/sessions/:id/text { text, replyMode? }` | the same turn through the same loop (`TextTurnStt`: the line is the final transcript), answered with `VoiceTurnView` once the turn has ended; refused (409) while a capture is open |
| Answer a read-back | say yes or no (a turn), or `POST /voice/sessions/:id/answer { answer: "tap" \| "no" }` | a spoken line is judged by `expectYes`: a yes is confirmed and a plain "no" (no, nope, cancel, nein, non, abbrechen; "stop" too while no work session of the agent runs, but with one running "stop" is the kill switch, spec O.9: the bridge hands it to the conversation agent, which cancels the card and stops the session, review of w3-o9-chat-to-inbox 2026-10-25) cancelled by the bridge through the registry itself with `source: "voice"`, exactly as a tap is, and the registry's sentence is spoken; a refused line (a question, a qualifier, a deferral, a hesitation) repeats the card. A tap confirms as a tap (a medium-risk card; a high-risk card still needs the paired device and the result says so), "no" cancels. The registry's pending list decides whether the card still waits: a card tapped in the UI, answered by email or expired is refused with the reason and forgotten by the session. The decision (`VoiceApprovalView`, the `voice.approval` frame) carries the registry's `status` and `reason`, the turn (`VoiceTurnView`) its `outcome` (the result with the sentence, change log id and undo token), and a `voice.answer` frame carries the same result for a spoken, tapped or cancelled answer |
| Read | `GET /voice/sessions/:id` | `VoiceSessionView` with `state`, `turn`, `pending`, `lastTurn`, `lastSeq` |
| Close | `POST /voice/sessions/:id/stop` | immediate in every state (O.9); input is refused afterwards |

### Read aloud: summaries and alerts (L.6, A.6; ADR 0063)

Outside a voice turn the daemon reads a text through the same registry's TTS with
`SpeakSessions` (`packages/runtime/src/voice/speak.ts`; the TTS preference is read at every
utterance, from the same source as the voice sessions': the Extensions panel's `voice-*` rows
under the environment override, spec O.4): `splitSentences` on the text, one
sentence synthesised ahead of playback, the loop's `audio` frame streamed to the player, the
sink paced on the clock; no STT and no model call, so it works without a model credential.
One voice at a time (a new utterance cancels the one in flight; starts are serialised, so two
overlapping requests never both play), a cancel is immediate. Playback holds until the first
stream subscribed or 1.5 s passed (`DEFAULT_AWAIT_LISTENER_MS`): audio frames are live only,
and the player attaches after the `POST` or the `speak.started` frame. Routes
(`DAEMON_ROUTES`): `POST /projects/:id/speak` (the cached one-screen summary, spec A.6),
`POST /sessions/:id/speak` (a session's summary), `GET /speak/:id`, `POST /speak/:id/cancel`,
`GET /speak/:id/events` (JSON after `afterSeq`, or SSE `speak.event` frames: every `sentence`
up front, `audio`, `speaking_start`, `speaking_end`, `error`, `speak.done`; `?token=`
accepted), plus a `speak.started` frame on `/events` (with `player`: `requester` for the
routes, `any` for an alert or `summary.speak`) so a speech player attaches and plays. What is
heard is what the app window plays through Web Audio (`apps.md`, "Speech player": its
`/events?speech=play` stream counts in `rt.speechPlayers`); the daemon's sink only paces the
frames and the desktop sidecar plays nothing. Another
human's project or session is refused (`forbidden`); a session without a summary is
`validation`; no usable TTS is 503 `unavailable` with the reason. Recorded: one `voice.speak`
row on the conversation session (the text as heard, never audio) and one `voice.speak` audit
row (counts and the provider, never the text). The same speaker is behind the `summary.speak`
command ("read me the summary", `commands.md`) and the `voice` notification channel, which
reads urgent alerts aloud on top of the toast when voice alerts are on, a speech player is
attached, no voice session is open and it is not quiet hours (`notifications.md`); both fall
back to text or a `skipped` row when no speech player is attached. `runtime.md` ("Read aloud") has the wiring;
the UI's button is in `apps.md`.

The UI's conversation panel (in a browser and in the desktop webview) captures with
`getUserMedia`, calls `press` and `audio`, and plays the `audio` frames of the session's event
stream through Web Audio (`apps/ui/src/shell/voice-playback.ts`, `apps.md`); the desktop shell
itself plays nothing natively. The Android app (`apps/mobile`) and the approvals web page
(`apps/approvals-web`) are not hooked up yet: they would capture, call `press` and `audio`,
play the `audio` frames, show the
`voice.readback` card with a Yes button that calls `answer`; a shell without capture (the web
page, a phone without microphone permission) calls `text` and plays or prints the reply. What
the bridge records is in `runtime.md` ("Voice"): `voice.turn` and `voice.approval` rows on the
conversation session, `voice.session` and `voice.approval` audit rows, never audio.

### What is stored

- Transcripts: always, as `TranscriptEntry` rows handed to session history (`audioStored: false`).
- Spoken approvals: `spokenApprovalRecord(turn, line, clock, subject, {language?})` logs the
  exact transcript line with the decision and, when refused, the reason (`blockedBy`) (O.7).
  `expectYes(line, {language?})` is conservative, because it gates above-routine actions and
  spending:
  - unambiguous affirmatives (yes, confirm, approve, go ahead, do it, jawohl, oui, d'accord,
    adelante, va bene, akkoord, ...) approve when they start within the first four words of
    the line or the whole line has at most five words; an affirmative buried late in a long
    line ("Everything about this plan is great and I approve") is refused as `ambiguous`;
  - words that also start instructions or acknowledgements (ok, sure, correct, fine, right, ja,
    genau, si, claro, vale, certo, oke, ...) approve only a line of at most three words
    ("Correct.", "That's right", "Fine by me"), so "Correct the budget first" is refused;
  - any negation, stop word or hesitation ("not", "wait", "maybe", "nein", "non", "nee",
    "a ver", ...) refuses (`negated`, `blockedBy: "negation"`);
  - a question refuses: a question mark, an interrogative lead ("is that", "what", "ist das",
    "est-ce", "es eso", "is dat", ...) or "what/which/how much/how many" (and their German,
    French, Spanish, Italian, Dutch forms) anywhere ("Sure, what is it exactly?");
  - a qualifier ("but", "aber", "mais", "pero", "ma", "maar", "mas") refuses ("Fine, but how
    much does it cost?");
  - a deferral, condition or hand-off refuses (`blockedBy: "deferral"`): "first", "tomorrow",
    "tonight", "after", "before", "until", "let me", "I need to", "ask", "check", "said",
    "wants", "my manager" and their German, French, Spanish, Italian, Dutch and Portuguese
    forms, so "Approve it after the review", "Let me confirm the number with Simone" and
    "Simone said yes" never pass;
  - words that are ordinary words in another language ("sim" is a SIM card in English, "dale"
    a name, "prima" is Dutch for fine and Italian for first) count as a yes only when they open
    the line ("Sim, pode." yes, "Replace the SIM" no) and never when the session `language` is
    known to be another one; as blockers they count anywhere unless the language rules them
    out ("Prima." is refused without a language and approved with `language: "nl"`).
  A refused line costs one repeated question; the agent reads the action back again.
- Audio: only with `storeAudio: true`. Then each turn's user and assistant PCM is written as
  `turn-NNNN-user.wav` / `turn-NNNN-assistant.wav` under `appDirs().data/voice/<session>/`
  (override `audioDir`), next to `RETENTION.md` which says the files are local, unsynced, unread
  by agents and safe to delete. Entries then carry `audioStored: true` and `audioFile`. The user
  WAV is written in the background so disk IO never delays the model call.

### Real-audio run (phase 5 gate, D.8)

The gate row "Voice first audio on real audio devices" needs push-to-talk turns spoken by a
human into a real microphone, with the local providers and the live Haiku model.
`scripts/voice-run.ts` (`pnpm voice:run <check|report>`) holds the two scripted halves; both
refuse to run without `FORERUNNER_HOME`, so the run has its own config, store and vault
profile (`--profile voice-run`) apart from the everyday install.

1. `pnpm voice:install --gpu` (or `--cpu`; without a flag the profile installed in the home,
   else gpu when nvidia-smi finds a GPU): the managed install above, in the run's home
   (`scripts/voice-install.ts`, which refuses without `FORERUNNER_HOME`). Exit 2 means the GPU
   check fell back to the CPU; the warning says why.
2. `pnpm voice:run check`: Node, Python (`FORERUNNER_PYTHON` first, then the lookup above), the
   GPU, the voice profile with the venv interpreter and the devices its check verified (`!!`
   and a note when the CPU stands in for the GPU), and the daemon's own registry
   (`buildVoiceRegistry` over an empty vault with `LocalVoice`, so the profile's helpers are
   probed and only local providers can be picked) with every provider's status row and reason,
   the pair the daemon would pick, and the install commands for what is missing (a venv under
   the home with `pip install faster-whisper kokoro`, or the managed install, which needs
   Python 3.12; kokoro 0.9.4 alone accepts 3.10 to 3.12). It installs nothing. Exit 1 when either side has no local
   provider.
3. `pnpm fr setup --non-interactive --profile voice-run` with `FORERUNNER_ANTHROPIC_KEY` in the
   environment, then `pnpm fr daemon --port 8787`. The UI reads the token from
   `<home>/runtime/daemon.json` and is started with `VITE_DAEMON_URL` and `VITE_DAEMON_TOKEN`
   (`pnpm --filter @forerunner/ui dev`, `http://localhost:1420`). A normal Chromium browser
   (Edge, Chrome) captures the microphone there: `localhost` is a secure context, the daemon's
   CORS allows local origins, and `voice-capture.ts` uses `getUserMedia`; the Tauri shell is
   not needed. Header **Talk** opens the panel; the panel's **Talk** starts a turn (the
   browser asks for the microphone once), **Send** ends it. The global hotkey exists only in
   the Tauri shell.
4. One warm-up turn, then ten. The helpers start on first use (the Whisper model loads on the
   first press, Kokoro on the first sentence, both download their weights the first time), so
   the first turn of a daemon is a cold start.
5. Stop the UI and the daemon (Ctrl+C), then `pnpm voice:run report --exclude-first 1`
   (`--since <iso>`, default the last 24 h; `--exclude-first <n>` leaves out the first n
   audio turns of the whole window, every voice session together in time order, so a run with
   two daemon starts and a warm-up after each passes 2): one line per `voice.turn` row with
   both first-audio figures and the stages it records (`endOfTurnMs`, `finalTranscriptMs`,
   `modelFirstTokenMs`, `firstAudioMs`, and the diagnostics `firstSentenceMs`,
   `ttsFirstByteMs`), then n, median (as `medianTotalToFirstAudio`) and p90 (by nearest rank,
   the rule `/performance` uses; `/performance` itself counts typed and warm-up turns too, so
   its p90 is over other turns) of each figure against `MODE_DEFAULTS.voice_chat` (1200 ms),
   leaving out turns replied in text (`replyMode: "text"` on the row, " reply=text" on its
   line, "[not counted: text reply, nothing spoken]", and a line with their count; they do not
   count towards `--exclude-first` either: nothing warmed the TTS),
   the stage medians and
   `VOICE RESULT: n=<n> median=<ms> p90=<ms> target=<ms> <met|not met> (<heard|daemon-side> first audio)`
   (met: the median within the target). The result is decided on the heard figure when any
   counted turn has one (turns without one are named and left out of it), and on the
   daemon-side figure, labelled so, when none has. Typed turns and turns without first audio
   are listed and left out. Exit 0 met, 2 not met, 1 refused.

Recorded where: the `voice.turn` rows on the conversation session in
`<home>/data/state.sqlite` (they hold `said` and `heard`; the report prints numbers, the
source and error codes only, never the text or a message), the `voice.session` audit rows, the
Haiku calls in the cost ledger; no audio unless `FORERUNNER_VOICE_STORE_AUDIO=1`. The human
hears the reply: the panel plays the session's `audio` frames through the browser's output
device. Two first-audio figures are recorded per turn:

- daemon-side, `latency.totalToFirstAudioMs`: the end of the turn as the loop detects it to
  the moment the daemon's paced sink takes the first TTS chunk. The SSE hop, decoding,
  scheduling and the output device come after it.
- heard, `latency.heardFirstAudioMs`: measured in the page by the panel's player
  (`apps/ui/src/shell/voice-playback.ts`, `apps.md`) from the press release the human made
  (Send, or the hotkey's second press) to the moment its first chunk of that turn's reply
  reaches the speaker: the chunk's scheduled start in context time mapped onto
  `performance.now()`, plus the context's `baseLatency` and the device's `outputLatency` (each
  where the browser reports it; a turn played while the context is suspended is not measured). Both ends are on the page's one clock, so no clock is compared with
  the daemon's. The reference is the release rather than the daemon's `turn_end` or first
  audio frame: those times are the daemon's clock and its own detection, and the release is
  what the human did; the figure therefore also includes posting the turn's last chunks and
  the release (the panel sends the release after them), which the daemon-side figure starts
  after. It includes the player's jitter buffer (a turn starts once 200 ms of audio is in hand,
  more after an underrun, up to 1 s; `apps.md`) and the 50 ms playback lead: it is read when
  the buffered audio is scheduled, since that is when the human starts hearing it. With a TTS
  faster than real time the buffer adds little: the daemon's sink hands the first 300 ms over
  at once, so the start target is in hand as soon as the TTS has produced 200 ms. With a TTS
  slower than real time it adds the time the TTS takes to produce 200 ms (more once the target
  grew), on top of `ttsFirstByteMs`. The player posts it once per turn
  (`POST /voice/sessions/:id/heard`); it lands on the turn's `voice.turn` row while the turn
  runs (the usual case: the reply's first chunk is heard long before the turn ends), or as a
  `voice.heard` row `{ voiceSessionId, turn, heardFirstAudioMs }` once the row is written (the
  event log is append-only), which the report joins by conversation session, voice session and
  turn. A window that plays nothing (no Web Audio) posts nothing and the report falls back to
  the daemon-side figure, saying so.

## How to change it

- New provider: see `adding-a-voice-provider.md`.
- VAD thresholds: `EnergyVad` options (`frameMs`, `energyThreshold`, `zcrMax`, `minSpeechMs`,
  `endOfTurnSilenceMs`). Keep `test/vad.test.ts` deterministic: build input with
  `wav.synth/silence/noise` and `chunkify`; events must not depend on chunk size.
- Sentence rules: `SentenceSplitter` holds the abbreviation list (English, German, French,
  Spanish, Italian, Dutch), the numeric-only abbreviations (`no`, `nr`, `vol`, `pp`, `fig`,
  `núm`, `pág`: an abbreviation only when a number follows, so "The answer is no." ends a
  sentence at once and "No. 5" does not) and the ellipsis/closing-quote/guillemet rules. Short
  ordinary words ("min", "max", "es", "ed", "ex") are deliberately not abbreviations: holding
  them back delays first audio. Add a case to `test/sentences.test.ts` with the
  streamed-vs-whole check.
- Latency targets: `DEFAULT_LATENCY_TARGETS` in `latency.ts`; the loop accepts `targets` for
  per-project overrides. Changing the stage anchors changes the spec's budget: ADR first.
- Loop behaviour: `VoiceLoop` options (`mode`, `replyMode`, `bargeIn`, `prefetchSentences`,
  `preRollMs`, `sttFinalTimeoutMs`, `storeAudio`). Every state transition emits a `state` event; add new
  events to `VoiceLoopEvent` rather than new callbacks.
- Helper protocol: `framing.ts` and the docstrings in `python/fr_stt.py` / `fr_tts.py` must
  stay identical; `test/local-helpers.test.ts` runs the Node side against
  `test/fixtures/fake_*_helper.mjs`, which speak the same protocol.

## Tests

`pnpm vitest run --project unit packages/voice` (246 tests, a few seconds, no network); the
speaker over the registry is `packages/runtime/test/speak-route.test.ts` and
`packages/runtime/test/notifications-voice.test.ts` (`FakeTts` on the simulated clock):

| File | Covers |
| --- | --- |
| `test/vad.test.ts` | burst + silence timing, 150 ms minimum, hangover, chunk-size independence, noise rejection, stereo |
| `test/sentences.test.ts` | streaming boundaries, abbreviations, numeric-only abbreviations ("No. 5" vs "The answer is no."), short ordinary words never held back, decimals, list markers, ellipses, quotes, newlines, ¿ ¡ « » |
| `test/wav.test.ts` | WAV round trip, validation errors, generators, chunkify, resample, downmix, byte views |
| `test/framing.test.ts` | frame encoding, split-frame reassembly, JSON lines with CRLF |
| `test/fake-providers.test.ts` | scripted partials/final with Clock delays, per-session scripts, abort |
| `test/latency.test.ts` | stage sums, over-target flags, null stages, custom targets, median |
| `test/approval.test.ts` | yes variants in seven languages, short ambiguous lines, negations and hesitation, questions and qualifiers refused (the critic's false positives), instructions with an affirmative word refused, deferrals and hand-offs refused in seven languages ("I need to confirm with my manager first", "Simone said yes"), an affirmative buried late in a long line refused, colliding words ("SIM", "Dale", "prima") gated on the line start or the session language, `blockedBy` and the exact line in the record |
| `test/registry.test.ts` | local -> cloud -> fake policy with reasons, preferred, excluded providers (not probed, the secret never asked for, never picked by the fallback, the status reason; `unavailable` when nothing else can serve), throwing probes, replace by name; nothing able to run: the `unavailable` message keeps each provider's own reason (U-075) |
| `test/availability.test.ts` | probes return `{ok:false}` for missing interpreter/module/binary/model/key; invalid module names never spawn; the Windows Store alias is recognised (`interpreterDidNotRun`, both OSes) and a stub that only prints "Python was not found" is skipped for the next candidate (stub run on Linux) |
| `test/local-helpers.test.ts` | faster-whisper, Kokoro and Piper Node sides against protocol-identical node stand-ins: streaming, resampling, errors, cancel (no leaked request on a pre-aborted call); `HelperProcess.stop()` grace kill timed on a `SimulatedClock` against a helper that ignores stdin closing; the fr_stt.py message schema (nulls, unknown keys, malformed lines); a helper that crashes once mid-transcription (`fixtures/crashing_stt_helper.mjs`) is restarted and the utterance gets its final with all of its audio, the crash logged as a warning with the code in hex and a cause, and a helper that crashes on the retry too fails the utterance with the hex code; a crash at the first audio frame, before the end of speech, retried with all of the audio; a helper that dies in the middle of a stdout line (`--partial-line`) with the retry still getting its final well inside a 3 s ready timeout; a disposed helper's late exit leaving the next utterance on a new helper untouched; `describeHelperExit` for 0xC0000005 (unsigned and signed), 0xC0000409, SIGSEGV, SIGKILL and exit code 1; a helper that writes 60 stderr lines before each of two crashes (`--stderr-lines`): both crash warnings carry the last 40 lines, and the utterance's error `details` carry the exit (`exitCode`, `exitCodeHex`), that tail, and the first crash's own as `firstCrash`; a Kokoro helper that crashes on a sentence (`CRASH`) fails it with the hex code and the tail in `details`, logged as a warning; `StderrTail` (lines split across chunks, the unfinished last line, the size cap) and a real `HelperProcess` keeping the last 40 of 45 lines; the retry's decode: after a CPU crash the retry's final is decoded greedy at temperature 0 and the same helper decodes the next turn as usual, after a GPU crash (`device: "cuda"`) the retry runs on a CPU `int8` helper and the next turn on a new `cuda` helper, each warning naming its `retryMode`; after the GPU crash's CPU retry a new `cuda` helper starts in the background (`--pid-file`) and serves the next turn without a fourth start; `retire()` during the CPU retry resolves only once that helper's process is gone; a barge-in 1.1 s into the CPU helper's load (`--cpu-ready-delay-ms`, 1.5 s ready timeout) leaves the new utterance's slower GPU helper (`--ready-delay-ms 600`) unfailed by the old timer and the CPU helper exited |
| `test/python-helpers.test.ts` | `py_compile` of both helpers and `--selftest` (skipped visibly when no Python) |
| `test/python-helper-crashes.test.ts` | the real `fr_stt.py` and `fr_tts.py` run as scripts against stub `faster_whisper` / `kokoro` modules that fault in native code (`ctypes.string_at(0)`), with `PYTHONFAULTHANDLER` unset: stderr carries faulthandler's header and the helper's frames (`_run`, `main`; `_pipeline`); and what `fr_stt.py` hands to native code: every transcription on the main thread, each on its own float32 array (no view of the utterance buffer) that later audio leaves unchanged; a decode frame making one utterance `beam_size=1, temperature=[0.0]` while the next, after a reset, decodes with `--beam-size` and faster-whisper's default temperatures; `parse_decode` refusing NaN, infinite and negative temperatures, empty or boolean lists, a beam size below 1 or not an integer, unknown keys and a non-object (skipped visibly without a Python with numpy) |
| `test/stt-device-fallback.test.ts` | `fr_stt.py`'s `Transcriber` against a stub `faster_whisper`: device `auto` falls back to the CPU at load and at the first transcription, an out-of-memory error keeps the GPU, an explicit device is kept |
| `test/disposed-providers.test.ts` | a retired `FasterWhisperStt` ends a new session with `unavailable` and a retired `KokoroTts` refuses a sentence, neither spawning its helper (a script that records whether it ran); `retire()` while the first utterance's interpreter probe runs (no `python` option, `FORERUNNER_PYTHON` set to node) ends the utterance with an error and spawns no helper after the probe; after `dispose()` alone a new utterance starts a new helper |
| `test/python-models.test.ts` | U-024, the real `fr_voice_models.py` and `fr_stt.py` against stand-in `faster_whisper` and `huggingface_hub` packages (no network): a `model.bin` downloaded as a link to nothing (where links can be made), empty or truncated is deleted and fetched once more (one `retry` line, two downloads, then a real file); a good download fetched once, recorded in `forerunner-model.json`, and 1.0.4's cache copy removed; still broken after the second fetch fails with the reason after two downloads only; `fr_stt.py --model-dir` loads the folder, fetches once more for a link to nothing or a short file and is ready, loads an install from before by name from its good cache with no download, moves a cache that cannot be opened into the folder (and drops it), and reports a folder still broken after one more fetch as `model load failed` (exit 4) without fetching again |
| `test/python-device.test.ts` | `setup_cuda_libraries()` on a fake site-packages: Windows `add_dll_directory` and `PATH` for every `nvidia/*/bin`, Linux cuBLAS and the cuDNN loader preloaded, nothing without the wheels; the gpu profile's `--cpu-fallback` (loud, at load when warmed, reported by `resolved_device()`), an explicit cuda without it raising; `fr_tts.py`'s `KokoroEngine` on cuda falling back with the reason, raising without `--cpu-fallback`, `auto` left to Kokoro; the warm-up sentence on cuda falling back loudly when synthesis fails there, the CPU never warmed |
| `test/cloud.test.ts` | Deepgram, Cartesia, ElevenLabs with fake transports replaying captured-shaped messages; keys only in headers, never in logs; ElevenLabs returns rather than throws when the abort makes the body reject |
| `test/paced-sink.test.ts` | `pacedSink` keeps to real time when its timer wakes 12 ms late on every chunk (no drift over 30 chunks, never more than its lead ahead); the first 300 ms handed over at once, then paced; a late chunk restarts the play-head from now; `stop()` resets it; `drain()` waits for the play-head, at once on the abort or after `stop()` |
| `test/loop.test.ts` | `stop()` while a turn with a queued press writes its user audio (audio storage on, a real disk write) calls no model; a carry owned by the next turn and dropped when that turn's STT times out (a later fresh turn gets only its own words), a press withdrawn while the user audio is written leaving the turn answered with its own words, the carry capped at `MAX_CARRIED_CHARS`; the words of a turn cut short by a queued press carry into the next turn's model call (each turn's transcript entry keeps its own words), answered alone when nothing more was said, dropped by `stop()`; a press while the last turn transcribes is queued (the final lands, that turn ends cut short without a model call, the new capture opens and runs), and still opens after an STT timeout, while `stop()` drops it; a turn keeps the mode it started with (a switch during the capture applies to the next turn; an empty transcript's `turn_end` reports its turn's mode); the reply's text before its audio (each `sentence` before its first `audio`, the deltas before that, the final transcript before the model); reply in text: no TTS call, no audio or speaking events, the turn ends with the text, no first audio; a press while the text streams stops the generation and keeps what was shown (no `unspokenText`); `setReplyMode` applies from the next reply; PTT turn where `totalToFirstAudio` equals the sum of scripted delays; pipelining order and overlap (chunks at once and spread over time); PTT and VAD barge-in within one chunk with a clean next turn; PTT ignores mic audio without a press while thinking and speaking; barge-in while thinking writes no empty assistant entry (`unspokenText` on `turn_end`); `unspokenText` with newline-separated model output; a TTS slow to honour its abort leaves the next turn's state alone and its entry lands in turn order; over-target flags; empty transcript; `stop()` while speaking and while transcribing (no model call, no TTS); spoken approval; STT error; converse ignoring its signal; failures: `converse()` throwing while audio plays (synthesis and playback aborted, `sink.stop()`, nothing but the idle transition after `turn_end`), throwing before audio (no late `speaking`), a failing TTS aborting the model signal with no further deltas; open-mic pre-roll and measured end of turn (200 ms in real time, 250 ms with a late chunk); audio storage on/off; an STT error's `details` (a crashed helper's stderr tail) on the turn's `ForerunnerError` |

Live validation of the cloud providers is **pending keys** (`docs/status/BLOCKERS.md`, row
"Voice keys"): the message shapes come from the vendors' public API documentation, not from
captured traffic. Local model runs (faster-whisper, Kokoro, Piper) are exercised through the
protocol stand-ins; a run with the real packages installed is an integration test to add when a
runner image has them (`*.integration.test.ts`, skipped visibly otherwise).

The voice profile's install, routes and CLI are tested in `packages/runtime/test`:
`voice-pins.test.ts` (the hashed pin files, every pin's Requires-Python, only docopt without a wheel and build-tools.txt matching the locks, the .in's torch block against the recorded wheel metadata, offline),
`voice-install.test.ts` (cpu and gpu installs, the platform refusal, the binary-only pip runs and the docopt source build, the GPU check
failing and falling back with exit 2, idempotency and resuming, a broken venv repaired, no
Python 3.12 (3.10 and 3.11 refused) with the winget/apt line, the torch-alone and PyPI-only
hashed pip runs, `pip check`, the environment's extra index dropped, cancelling, the lock file
named in a refusal, the atomic `voice.json`, the espeak-ng path limit, switching and removing,
the GPU detection and the setup question, U-024's plain model folder passed to the fetcher
(`--whisper-dir`) and the check (`--model-dir`) with a broken download fetched once more shown
as a warning, all with a fake process runner from `voice-install-helpers.ts`, whose
`modelsRetry` makes the fetcher report a retry), `voice-local-profile.test.ts` (what
`voice.json` means for the helpers' argv (`--model-dir` included, U-024), interpreter and
`HF_HOME`; rebuilt and stopped on a change; `FORERUNNER_PYTHON`
winning; a swap deferred while a session or a sentence is in use; refused while an install
runs), `voice-install-routes.test.ts` (the job, its replay as JSON and SSE, 409s, the cancel
route, a daemon stop cancelling a running install and local voice blocked meanwhile, the
daemon mount behind the token) and
`voice-install-cli.test.ts` (`fr voice install/remove/status`, `fr setup --voice` and the
question); the card in `apps/ui/test/settings-voice.test.tsx`; `pnpm voice:install` in
`scripts/voice-install.test.ts`; the lock generator's offline parts in
`scripts/voice-lock.test.ts`; the check's profile lines in `scripts/voice-run.test.ts`.

## Known issues

- U-024's fetch at run time (a model folder `fr_stt.py` cannot open) happens before the helper's
  ready line, inside `FasterWhisperStt`'s 120 s ready timeout: the base model fits on most lines,
  a large model on a slow one may not; Settings -> Voice's **Check again** fetches it with
  progress and no timeout. The real `download_model(output_dir=...)` has not been run on Windows
  yet (the tests use stand-ins); the owner's next install is that check.
- The gpu profile has not run on an NVIDIA GPU yet (2026-10-26): the CUDA path is covered by
  fake processes and stub modules, and the cpu profile was installed and checked for real on
  Linux (Python 3.12, the pinned packages, both models, both helpers through `LocalVoice`). The
  first `fr voice install --gpu` on the human's PC is the hardware check.
- On Windows the CUDA PyTorch wheel already carries `cublas64_12.dll` and the cuDNN 9 DLLs in
  `torch/lib`; the separate NVIDIA wheels (about 1.7 GB unpacked) duplicate them. Kept as
  specified (ADR 0090, Consequences); pointing `setup_cuda_libraries()` at `torch/lib` would
  save the space.
- A run-time CUDA fallback (the gpu profile's `--cpu-fallback`) is said on the helper's stderr
  and in its ready line; the daemon's provider logs helper stderr at debug level while the
  helper runs (only an abnormal exit brings its last lines up to a warning) and does not
  read the ready line's `fallback` yet, so the loud signal is the install check and
  `fr voice status` / Settings → Voice.

- faster-whisper's device `auto` picks CUDA wherever ctranslate2 sees an NVIDIA GPU, even when
  the CUDA libraries (cuBLAS, cuDNN) are not installed, and then fails at load or at the first
  transcription ("Library cublas64_12.dll is not found", the real-audio run of 2026-10-26).
  `fr_stt.py` falls back to the CPU (`int8`) once, with device `auto` only (an explicit
  `--device` is kept, unless `--cpu-fallback`) and not on an out-of-memory error of a working
  GPU, with a line on stderr (`test/stt-device-fallback.test.ts`, which runs the helper's
  `Transcriber` against a stub `faster_whisper`). To use the GPU: `fr voice install --gpu`
  (ADR 0090), which installs the CUDA 12 cuBLAS and cuDNN wheels and makes them loadable.

- faster-whisper can crash in native code. In the same run, on turn 5, `fr_stt.py` died
  mid-transcription with exit code 3221225477 (0xC0000005, an access violation, Windows, CPU
  device, `int8`) while the machine was under heavy CPU load from unrelated work; the turn
  failed with `provider_error` and the human's speech was lost, and the next turn worked on a
  fresh helper. The cause inside CTranslate2 is not known and nothing in the helper can catch it,
  so the Node side absorbs one crash: `FasterWhisperStt` keeps the utterance's audio frames in
  memory (`FasterWhisperSession.frames`, up to `STT_RETRY_AUDIO_BYTES`, two minutes of 16 kHz
  mono; a longer utterance is not retried), and when the helper exits while an utterance is open
  it restarts the helper and sends reset, the retry's decode options (greedy at temperature 0,
  on the CPU after a GPU crash; see the next entry), the same audio and the end of speech
  again, once. The
  session only sees the final (a second partial may arrive first). A second crash of the same
  utterance, a restart that fails, or an utterance too long to keep ends the session with
  `provider_error` naming the exit (`faster-whisper helper exited, exit code ... (0x...): <cause>
  (after one retry of the utterance)`). Every exit is logged with `code`, `codeHex` and a plain
  `cause` from `describeHelperExit` (`helper-process.ts`: Windows NTSTATUS crash codes such as
  0xC0000005 access violation, 0xC00000FD stack overflow, 0xC0000409 stack buffer overrun, and
  POSIX signals such as SIGSEGV and SIGKILL); a crash mid-utterance is a warning
  (`helper crashed mid-transcription; restarting it and retrying the utterance`). The crash may
  come before the end of speech: audio pushed after it is queued behind the replayed frames.
  Each helper process gets its own JSON line reader, so a helper that dies in the middle of a
  stdout line leaves no half line in front of the next helper's `ready` (that would not parse,
  and the retry would wait out the 120 s ready timeout). `dispose()` ends an utterance still open
  with `provider_error` ("faster-whisper helper stopped"); the exit and output of a helper already
  let go only log and touch neither the provider's state nor an utterance on a new helper.

- The access violation came back on the gpu profile (2026-10-26, Windows 11, RTX 3060, driver
  616.92, the pinned lock: faster-whisper 1.2.1, ctranslate2 4.8.3): the first utterance crashed
  with 0xC0000005, its retry on a fresh helper crashed again 2.5 s later and the turn failed;
  about 12 later utterances worked. No stack was kept, so the crash is now diagnosable:
  - `fr_stt.py` and `fr_tts.py` turn on `faulthandler` (all threads, to stderr) before anything
    loads native code. A fault writes "Windows fatal exception: access violation" (or "Fatal
    Python error: Segmentation fault") and every thread's Python frames to stderr. It names the
    Python frame that called into native code (`encode`, `generate_with_fallback`,
    `detect_language` in faster-whisper), not the native frames.
  - `HelperProcess` keeps the last 40 lines of the helper's stderr, at most 4000 characters
    (`StderrTail`). On any abnormal exit (non-zero code, signal) both providers log it with
    `stderrTail` at warn level and put it in the error's `details` with `exitCode`,
    `exitCodeHex`, `signal` and `cause`. For STT that is the `SttEvent` error's `details`, which
    the loop copies onto the turn's `ForerunnerError`; after a failed retry `firstCrash` holds
    the first crash's exit and tail. The stored `voice.turn` row and the event stream still
    carry only code and message.
  - Caveat: on Windows, faulthandler also reports an access violation that native code catches
    itself, so a traceback in stderr with no crash after it is not a crash.

  What the code reading established, proven against the real packages (faster-whisper 1.2.1
  and ctranslate2 4.8.3 installed on Linux, `import` plus a transcription, then `sys.modules`
  and the mapped libraries):
  - Silero VAD is not in play: the helper calls `transcribe(vad_filter=False)`, faster-whisper
    imports onnxruntime only inside its VAD model, and onnxruntime is never loaded.
  - torch is not loaded in the STT helper: ctranslate2 4.8 imports `converters` and `specs`, the
    modules that need torch, lazily, and faster-whisper never imports it. One OpenMP runtime is
    mapped (ctranslate2's libgomp on Linux; on Windows it is the libiomp5md.dll the
    ctranslate2 wheel ships and loads). So there is no second OpenMP runtime, and
    `KMP_DUPLICATE_LIB_OK` is neither set nor needed. Kokoro and torch run in their own process.
  - Buffers: each transcription gets a new float32 array (`bytes(buffered)`, then `astype`).
    Later audio never touches it, and `StorageView.from_array` keeps the array it wraps alive
    (checked with a weak reference).
  - Concurrency: every native call runs on the main thread, one at a time. The reader thread
    only reads stdin. `test/python-helper-crashes.test.ts` keeps both properties.

  Not established, so these are hypotheses:
  - The input. The retry replayed the same audio to a fresh process and crashed the same way,
    while the next utterance on another fresh process worked. That fits a fault that depends
    on the audio (for example a decode path only some audio reaches, such as the
    temperature-fallback sampling; see SYSTRAN/faster-whisper#71 for Windows crashes tied to
    temperatures above 0) better than a fault on a process's first call. If the input is the
    cause, retrying identical audio with identical settings cannot help, so the retry now
    decodes differently (below). Whether that avoids the fault is untested on real hardware;
    the traceback of the next crash says which call faults.

  The retry decodes differently (since this change). `replay()` sends a decode frame
  (`STT_IN.decode`, kind 4, JSON `STT_RETRY_DECODE` = `{"beam_size":1,"temperature":[0]}`) after
  the reset. `fr_stt.py` uses it for that utterance only, partials and final: greedy, temperature
  0 only, so faster-whisper never falls back to sampling at higher temperatures. The next reset
  or final clears it (`parse_decode` refuses unknown keys and bad values with an `error` line).
  When the helper that crashed ran on the GPU (its ready line's `device` starts with `cuda`; a
  helper that did not say counts by the configured `device`), the retry's helper runs on the CPU
  (`STT_RETRY_CPU`, `--device cpu --compute-type int8`) for that utterance only. It is stopped
  when the utterance ends, by its final, its error or a new utterance. That costs a CPU model
  load before the retry, and the GPU helper has to load again. So the GPU reload does not land
  on the next turn, the usual helper is started in the background as soon as the retry's
  helper is let go. dispose() and retire() skip this. If the next turn starts while it is still
  loading, its audio waits for it as usual. After a crash on the CPU the retry's helper stays
  for later turns, which decode as usual.
  Each helper has its own pending ready (`readyWaiters`). Letting the CPU helper go (`letGo`)
  rejects its ready if it was still loading, and a load timer acts only on the helper that is
  still current. A barge-in during the CPU helper's load therefore cannot fail the next
  helper's load. Stops of helpers let go outside dispose() are kept in `stopping`, and
  `dispose()` / `retire()` resolve only once every one of them has exited. A venv swap can
  then remove the venv safely. `parse_decode` accepts only finite temperatures >= 0 (Python's
  json reads `NaN` and `Infinity`). The crash warning names the mode: `retryMode` is
  `greedy at temperature 0` or `greedy at temperature 0 on the CPU (int8)`.
  `test/local-helpers.test.ts` checks both against the crashing stand-in, which records each
  final's device, compute type and decode options.
  - First call versus later calls. There is no first-call-only path to warm: the gpu warm-up
    already runs language detection, the full 30 s encoder and a greedy decode on silence.
    Each new process's first real utterance then runs the same calls as every later one (a
    beam-5 final, partials at beam 1), and the third process's first utterance worked. A warm-up
    on synthetic audio was not added. A warm-up "with VAD on" would load onnxruntime, which
    the helper otherwise never loads.
  - Mixed cuDNN: on Windows, ctranslate2 4.8.3 loads its own `cudnn64_9.dll` (9.10.2.21), which
    then loads the cuDNN parts from the pinned `nvidia-cudnn-cu12` (9.19.0.56). That mix is
    unchecked, but the GPU utterances after the crash worked and the CPU crash used no cuDNN.
  - Load from the Kokoro helper starting at the same time (both crashes fell in the first turn,
    the CPU crash happened under heavy load). Compare the timestamps of the Kokoro helper's
    start with the crash.

- The heard figure (review of b1e65fc, low findings left open): the hotkey's release is stamped
  in the render after the key event, so a hotkey turn reads low by that render and the IPC
  (Send is stamped in the click); a heard POST that lands between `finish()` and the
  `voice.turn` append is stored on the row and also as a `voice.heard` row (the report keeps
  the first); `voice-run report` orders rows by `created_at, id`, so a `voice.heard` row
  written in the same millisecond as its turn can sort first and be dropped; a previous turn's
  `turn_end` arriving after the next release leaves that turn unmeasured. None gives a wrong
  value; some samples can be missing or slightly low. Use Send (not the hotkey) for the
  real-audio run. Since the player's jitter buffer (2026-10-26) the figure includes the
  buffering (200 ms of audio in hand, up to 1 s after underruns); heard figures recorded
  before it leave out the time spent buffering and are not comparable.

- faster-whisper has no true incremental mode: partials re-transcribe the whole utterance every
  `partialIntervalMs` (1 s) and are skipped when newer audio is already queued. Final transcript
  latency for a 5 s utterance on CPU with the `base` model is around 300 to 600 ms; use
  `small`/GPU for better accuracy or Deepgram for the lowest latency.
- The real-audio run of 2026-10-26 (Kokoro on a Windows PC's CPU, `ttsFirstByteMs` 0.5 to
  1.1 s) played the reply with short cuts inside words. The likely cause, reasoned from the
  code rather than measured: `fr_tts.py` synthesises a whole Kokoro segment (a sentence, or a
  part of a long one) before it yields anything, then cuts it into 100 ms pieces, so a
  sentence reaches the daemon in one burst. A slow TTS therefore shows as pauses between
  sentences (or segments), not inside words. What put cuts inside words was the old paced
  sink: it released the burst one 100 ms piece per sleep, each sleep timed from the moment the
  previous one woke, and on Windows (timer granularity up to ~15.6 ms) with the CPU busy
  synthesising the next sentence each wake-up was late by a few ms. The pieces reached the
  window slower than real time; the player's 50 ms lead absorbed the first few, then every
  piece arrived after the previous one had ended, a gap of that lateness every 100 ms. Fixed
  by the play-head (`AudioSink` above), which releases the burst at once up to its 300 ms lead
  and then at real time without drift. The player's jitter buffer (`apps.md`, the panel's
  reply player: 200 ms in hand before a turn starts) is the safety net for network and
  main-thread jitter; its target grows only when audio runs dry inside a sentence (a Kokoro
  segment boundary in a long sentence, a TTS that streams slower than real time), not at the
  pause before a sentence. A TTS slower than real time still pauses between sentences; a GPU,
  Piper or a cloud TTS avoids that. Not yet confirmed by a second real-audio run.
- `spokenText` (on `barge_in`) and the interrupted entry's `text`/`unspokenText` are decided
  by the sentences whose playback *started at the daemon's sink*. The sink runs up to 300 ms
  ahead of real time and the window plays later still (its jitter buffer and lead, up to
  ~1.35 s after the target grew), so a sentence counted as spoken may not have been heard yet,
  or only its start: both can run ahead of what the human heard.
- Cartesia opens one WebSocket per sentence (simple, robust); reusing a connection with
  `context_id` continuation would save roughly 100 ms per sentence after the first.
- Cartesia's documented auth for WebSockets is the `api_key` query parameter; the header form is
  used by default to keep keys out of URLs. If a live test shows the header is rejected, set
  `keyInQuery: true` (the URL is then never logged at debug level either: the logger redacts).
- Open mic without echo cancellation can barge in on the agent's own voice; the shell decides
  per device (push-to-talk never barges in on mic audio, only on a press). The VAD's 150 ms
  minimum speech and the energy threshold are the only guards in open mic.
- Audio storage writes WAV at the capture rate (16 kHz mono) and the TTS rate; there is no
  size cap or automatic retention beyond the note.
- `expectYes()` refuses any line with "what"/"which" in it, so "Yes, do what you proposed" is
  not an approval, and any deferral word, so "Yes, do the first one" and "Yes, will do, ask
  Simone" are refused too; the agent asks again. Chosen on purpose (a false yes spends money).
  Without a session language, Dutch "Prima." is refused (Italian "prima" blocks it) and
  Portuguese "sim" counts only at the start of a line; pass `language` to lift that.
- A TTS provider that ignores its abort signal delays the end of a failed or interrupted turn
  until it returns; the turn's tail then runs beside the next turn without touching its state
  or ordering, but the provider's work (and a cloud provider's bill) continues meanwhile. The
  fake, local and cloud providers all honour the signal; the model stream is the only worker
  raced against the abort.
- The UI calls the `/voice` routes since O.1 (above, "How the shell reaches it": the
  conversation panel, `apps/ui/src/shell/ConversationPanel.tsx`, reads `client.voiceStatus()`
  and posts the frames `voice-capture.ts` captures through `client.voiceAudio()` to
  `POST /voice/sessions/:id/audio`; `apps/ui/src/mobile/voice.ts` captures the phone's;
  `apps.md`; the panel plays the voice session's `audio` frames, `voice-playback.ts`), but
  the shells do not play the `/speak/:id/events` frames: the UI plays them itself through Web
  Audio in the webview (`apps.md`); the desktop sidecar ignores the `speak.started` frame, so
  with the app window closed nothing is spoken (alerts are skipped, `summary.speak` answers
  with the text). The
  daemon's bridge is exercised by `packages/runtime/test/voice-route.test.ts` and scenario 3
  still carries its own copy (`tests/e2e/src/scenario-voice.ts`) until it is pointed at
  `VoiceBridge`. The conversation agent's own per-human copy of a pending card outlives a
  voice answer until its next typed line (`runtime.md`, "Known issues": a bare "yes" typed
  right after is reported as "Not done"; nothing runs twice).
- The exclusion follows the installed `voice-*` rows (switched off, or the key not granted). A
  cloud provider with no row at all, never installed or still pending the first yes, is still
  the policy's fallback when its key is in the vault (`fr setup` stored it): installing the
  row and switching it off is how a keyed provider is ruled out, and removing the row removes
  the exclusion with it. Making a never-installed provider unreachable would mean treating the
  catalog, not the row, as the grant; left as is and noted here.
- `fr doctor` does not report voice; `scripts/voice-run.ts check` and `GET /voice/status` do.
- A session already open keeps the providers it started with; a panel change applies to the
  next session only (by design: no provider swap mid-conversation).

## Requirements covered

| ID | Clause | Where | Test |
| --- | --- | --- | --- |
| O.3 | push-to-talk or open mic with VAD; streaming STT; sentence-by-sentence streaming TTS; interrupt mid-sentence | `loop.ts`, `vad.ts`, `sentences.ts` | `test/loop.test.ts`, `test/vad.test.ts`, `test/sentences.test.ts` |
| O.4 | local by default (faster-whisper, Kokoro or Piper), cloud option (Deepgram, Cartesia or ElevenLabs), chosen in Extensions | `providers/*`, `registry.ts`; the panel's choice: `packages/runtime/src/voice/providers.ts` (`resolveVoicePreferences`) | `test/registry.test.ts`, `test/local-helpers.test.ts`, `test/cloud.test.ts`, `test/availability.test.ts`, `packages/runtime/test/voice-preferences.test.ts`, `packages/runtime/test/voice-route.test.ts` ("voice providers chosen in the Extensions panel") |
| O.5 | latency budget per stage, under 1.2 s to first audio, each part measured and shown | `latency.ts`, `loop.ts` | `test/latency.test.ts`, `test/loop.test.ts` |
| O.7 | waits for "yes"; spoken approvals logged with the transcript line | `approval.ts` (the read-back and confirm step itself is the runtime's conversation agent) | `test/approval.test.ts`, `test/loop.test.ts` |
| O.1, O.7, O.9, Q.4, Q.5 (voice) | talk by voice or typed line through the daemon; the card read back and the wait for the yes with the line logged; stop at once; the same registry as chat | `packages/runtime/src/voice/` (`VoiceBridge`, `TextTurnStt`, `VoiceSessions`), the `/voice` routes | `packages/runtime/test/voice-route.test.ts` |
| O.10 | transcripts kept, audio not stored unless turned on | `loop.ts`, `store.ts` | `test/loop.test.ts` (audio storage) |
| D.8 | voice chat first audio under 1.2 s (measurement; the model choice is the runtime's) | `latency.ts` | `test/loop.test.ts` |
| L.6 | TTS for summaries and alerts, STT for voice notes, pluggable provider | `splitSentences()` + the registry's `TtsProvider` through `packages/runtime/src/voice/speak.ts` (the `/speak` routes, `summary.speak`, the `voice` notification channel; ADR 0063); any `SttProvider` (`note.add` keeps the transcript); `registry.ts` | `test/sentences.test.ts`, `test/registry.test.ts`, `packages/runtime/test/speak-route.test.ts`, `packages/runtime/test/notifications-voice.test.ts` |
| A.6 (readable aloud) | the one-screen summary read aloud | `POST /projects/:id/speak`, `summary.speak` | `packages/runtime/test/speak-route.test.ts`, `packages/commands/test/commands.test.ts` |
| P.7 | `adding-a-voice-provider.md` | this doc and `adding-a-voice-provider.md` | docs check |
| O.4 (local install) | the local stack chosen at install (none, cpu, gpu), switchable from Settings and the CLI, verified on its device (ADR 0090) | `packages/runtime/src/voice/install*.ts`, `local-profile.ts`, `python/requirements-*.txt`, `python/fr_voice_models.py`, `fr_stt.py` `setup_cuda_libraries` | `packages/runtime/test/voice-install*.test.ts`, `voice-local-profile.test.ts`, `test/python-device.test.ts`, `test/python-models.test.ts`, `apps/ui/test/settings-voice.test.tsx` |
| checklist "Voice keys" | keys missing -> local only; synthesised speech clips fed to STT in tests | `registry.ts` policy; `wav.synth` fixtures | `test/registry.test.ts`, `test/local-helpers.test.ts` |
