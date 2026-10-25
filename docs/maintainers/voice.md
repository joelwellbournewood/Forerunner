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
src/providers/local/faster-whisper.ts  STT via python/fr_stt.py (JSON lines checked by a zod schema)
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
7. **Stop.** `stop()` is immediate in every state (O.9): a capture still listening is closed; a
   turn waiting for its final transcript ends without a model call (`turn_end` with
   `entry: null` and latency `interrupted: true`, no `converse()`, no TTS); a reply being
   generated or played is aborted like a barge-in. Input is ignored until `start()`.

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
(Windows); an explicit `python` option overrides. A candidate that spawns but never runs
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
`unavailable` as usual. The runtime fills the list from the panel (below), so off means off.

### Which provider is preferred (spec O.4)

The runtime decides `preferred` per side (`packages/runtime/src/voice/providers.ts`,
`resolveVoicePreferences`), read afresh at every `GET /voice/status` and every session start,
so a toggle in the Extensions panel applies at the next voice session without a restart:

1. **Environment override.** `FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS` name a provider
   that wins over the panel for that side; every enabled row for the side is reported as
   `overridden by FORERUNNER_VOICE_TTS=<name>`.
2. **The `voice-*` rows.** Each built-in voice catalog entry names the providers it stands
   for (`voice: { stt: [...], tts: [...] }`, in order of preference; `voice-local` names
   faster-whisper, kokoro and piper). Rows that need a key (the cloud ones) are considered
   before the local row, then by name. Per side the first enabled row whose provider's own
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
   never excluded (free, private, the policy's default): switching `voice-local` off removes
   the preference only. A provider the environment or an enabled row put in force is never
   excluded by another row that stands for it.
4. **Nothing chosen.** The registry's policy above picks.

`GET /voice/status` carries the result as `preferences: { stt, tts, skipped }` (each preference
with the row's `providers`; `excluded` stays inside the daemon, the providers' status rows carry
its reason); the Extensions panel shows the pair in force above the capabilities and a badge on
every voice row (in force, preferred but fallen back with the registry's reason, or not in force
with the reason).

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
| Open | `POST /voice/sessions { projectId?, language?, mode? }` | 201 `VoiceSessionView` (`id`, `conversationSessionId`, providers, `pending`); 503 `unavailable` with the reason when nothing can run |
| Listen | `GET /voice/sessions/:id/events` with `Accept: text/event-stream` (`?token=` allowed, `?afterSeq=` to resume) | SSE `voice.event` frames (`VoiceEventView`): the loop's `state`, `turn_start`, `transcript_partial`, `transcript_final`, `model_delta`, `sentence`, `audio` (base64 16-bit PCM with `sampleRate`, `channels`: the shell plays it), `speaking_start`, `speaking_end`, `barge_in`, `turn_end`, `error`, plus `voice.first_audio` (first audio with how long after the end of the turn), `voice.readback` (approval needed: the card read back, `pending.id`), `voice.approval` (the decision with the exact line), `voice.answer`, `voice.turn` (done: the turn's record with the latency stages) and `voice.stopped`; `heartbeat` every 15 s. Without the SSE accept header the same route answers the kept frames as JSON (audio frames are never kept) |
| Speak (push-to-talk) | `POST /voice/sessions/:id/press { pressed: true }`, then one `POST /voice/sessions/:id/audio` per captured chunk (JSON `{ pcm (base64 int16 LE), sampleRate, channels, timestampMs }` or the raw bytes as `application/octet-stream` with `?sampleRate=&channels=&timestampMs=`), then `{ pressed: false }` | the loop's turn: STT, the agent, TTS; a press while the agent speaks is the barge-in. In `open_mic` mode the shell streams audio continuously and never presses |
| Type (no microphone) | `POST /voice/sessions/:id/text { text }` | the same turn through the same loop (`TextTurnStt`: the line is the final transcript), answered with `VoiceTurnView` once the turn has ended; refused (409) while a capture is open |
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

1. `pnpm voice:run check`: Node, Python (`FORERUNNER_PYTHON` first, then the lookup above),
   and the daemon's own registry (`buildVoiceRegistry` over an empty vault, so only local
   providers can be picked) with every provider's status row and reason, the pair the daemon
   would pick, and the install commands for what is missing (a venv under the home with
   `pip install faster-whisper kokoro`; kokoro 0.9.4 needs Python 3.10 to 3.12). It installs
   nothing. Exit 1 when either side has no local provider.
2. `pnpm fr setup --non-interactive --profile voice-run` with `FORERUNNER_ANTHROPIC_KEY` in the
   environment, then `pnpm fr daemon --port 8787`. The UI reads the token from
   `<home>/runtime/daemon.json` and is started with `VITE_DAEMON_URL` and `VITE_DAEMON_TOKEN`
   (`pnpm --filter @forerunner/ui dev`, `http://localhost:1420`). A normal Chromium browser
   (Edge, Chrome) captures the microphone there: `localhost` is a secure context, the daemon's
   CORS allows local origins, and `voice-capture.ts` uses `getUserMedia`; the Tauri shell is
   not needed. Header **Talk** opens the panel; the panel's **Talk** starts a turn (the
   browser asks for the microphone once), **Send** ends it. The global hotkey exists only in
   the Tauri shell.
3. One warm-up turn, then ten. The helpers start on first use (the Whisper model loads on the
   first press, Kokoro on the first sentence, both download their weights the first time), so
   the first turn of a daemon is a cold start.
4. Stop the UI and the daemon (Ctrl+C), then `pnpm voice:run report --exclude-first 1`
   (`--since <iso>`, default the last 24 h; `--exclude-first <n>` leaves out the first n
   audio turns of the whole window, every voice session together in time order, so a run with
   two daemon starts and a warm-up after each passes 2): one line per `voice.turn` row with
   both first-audio figures and the stages it records (`endOfTurnMs`, `finalTranscriptMs`,
   `modelFirstTokenMs`, `firstAudioMs`, and the diagnostics `firstSentenceMs`,
   `ttsFirstByteMs`), then n, median (as `medianTotalToFirstAudio`) and p90 (by nearest rank,
   the rule `/performance` uses; `/performance` itself counts typed and warm-up turns too, so
   its p90 is over other turns) of each figure against `MODE_DEFAULTS.voice_chat` (1200 ms),
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
  after. It includes the 50 ms playback lead. The player posts it once per turn
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
- Loop behaviour: `VoiceLoop` options (`mode`, `bargeIn`, `prefetchSentences`, `preRollMs`,
  `sttFinalTimeoutMs`, `storeAudio`). Every state transition emits a `state` event; add new
  events to `VoiceLoopEvent` rather than new callbacks.
- Helper protocol: `framing.ts` and the docstrings in `python/fr_stt.py` / `fr_tts.py` must
  stay identical; `test/local-helpers.test.ts` runs the Node side against
  `test/fixtures/fake_*_helper.mjs`, which speak the same protocol.

## Tests

`pnpm vitest run --project unit packages/voice` (187 tests, a few seconds, no network); the
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
| `test/registry.test.ts` | local -> cloud -> fake policy with reasons, preferred, excluded providers (not probed, the secret never asked for, never picked by the fallback, the status reason; `unavailable` when nothing else can serve), throwing probes, replace by name |
| `test/availability.test.ts` | probes return `{ok:false}` for missing interpreter/module/binary/model/key; invalid module names never spawn; the Windows Store alias is recognised (`interpreterDidNotRun`, both OSes) and a stub that only prints "Python was not found" is skipped for the next candidate (stub run on Linux) |
| `test/local-helpers.test.ts` | faster-whisper, Kokoro and Piper Node sides against protocol-identical node stand-ins: streaming, resampling, errors, cancel (no leaked request on a pre-aborted call); `HelperProcess.stop()` grace kill timed on a `SimulatedClock` against a helper that ignores stdin closing; the fr_stt.py message schema (nulls, unknown keys, malformed lines) |
| `test/python-helpers.test.ts` | `py_compile` of both helpers and `--selftest` (skipped visibly when no Python) |
| `test/cloud.test.ts` | Deepgram, Cartesia, ElevenLabs with fake transports replaying captured-shaped messages; keys only in headers, never in logs; ElevenLabs returns rather than throws when the abort makes the body reject |
| `test/loop.test.ts` | PTT turn where `totalToFirstAudio` equals the sum of scripted delays; pipelining order and overlap (chunks at once and spread over time); PTT and VAD barge-in within one chunk with a clean next turn; PTT ignores mic audio without a press while thinking and speaking; barge-in while thinking writes no empty assistant entry (`unspokenText` on `turn_end`); `unspokenText` with newline-separated model output; a TTS slow to honour its abort leaves the next turn's state alone and its entry lands in turn order; over-target flags; empty transcript; `stop()` while speaking and while transcribing (no model call, no TTS); spoken approval; STT error; converse ignoring its signal; failures: `converse()` throwing while audio plays (synthesis and playback aborted, `sink.stop()`, nothing but the idle transition after `turn_end`), throwing before audio (no late `speaking`), a failing TTS aborting the model signal with no further deltas; open-mic pre-roll and measured end of turn (200 ms in real time, 250 ms with a late chunk); audio storage on/off |

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
| checklist "Voice keys" | keys missing -> local only; synthesised speech clips fed to STT in tests | `registry.ts` policy; `wav.synth` fixtures | `test/registry.test.ts`, `test/local-helpers.test.ts` |
