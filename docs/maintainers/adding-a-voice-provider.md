# Adding a voice provider

How to add an STT or TTS provider to `packages/voice` so it shows up in the Extensions panel,
takes part in the default selection policy and is covered by tests without a network or a
model download. Read `voice.md` first for the contracts and the loop.

## Purpose

A provider is one class implementing `SttProvider` or `TtsProvider` from `src/types.ts`. The
loop, the registry and the UI never know which one is behind the interface. Three rules carry
over from the rest of Forerunner:

1. Keys are secret references, resolved through the injected `SecretResolver` at connect time,
   sent only in headers, never logged (the logger redacts, but do not rely on it: keep them out
   of messages and URLs).
2. Processes are spawned with argv arrays through `@forerunner/platform` (`spawnProcess`,
   `run`, `which`, `killTree`); paths through `join`/`fileURLToPath`; never a shell string.
3. `isAvailable()` never throws and gives a reason a person can act on ("python3: import kokoro
   failed: ModuleNotFoundError", "no API key configured for secret:deepgram_api_key").

## How it works

### STT

```ts
export class MyStt implements SttProvider {
  readonly name = "my-stt";          // unique, shown in Extensions, used by `preferred`
  readonly kind = "cloud" as const;  // "local" | "cloud" | "fake" drives the selection policy
  async isAvailable(): Promise<Availability> { ... }
  start(opts: SttStartOptions): SttSession { return new MySession(this, opts); }
}
```

A session owns one utterance:

- `push(chunk)`: convert with `wav.toMono16(chunk, rate)` and send; buffer until the transport
  is open (Deepgram does this with `buffered`).
- `endOfSpeech()`: ask the service for the finalised transcript (Deepgram sends
  `{"type":"Finalize"}`, the faster-whisper helper gets the `endOfSpeech` frame) and arm a
  timeout on the injected `Clock` so a lost answer still yields a final from what you have.
- `events`: an `AsyncQueue<SttEvent>`; push `partial` events as they come, then exactly one
  `final` (set `atMs: clock.monotonic()`; the loop measures `finalTranscriptMs` from it) or one
  `error`, then `close()` the queue.
- `close()`: idempotent; close the transport, close the queue.

### TTS

```ts
export class MyTts implements TtsProvider {
  readonly name = "my-tts";
  readonly kind = "local" as const;
  async isAvailable(): Promise<Availability> { ... }
  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<AudioChunk> { ... }
}
```

- Yield `AudioChunk`s as soon as bytes arrive (`wav.bytesToPcm` handles odd byte boundaries;
  keep a carry buffer like ElevenLabs does). `timestampMs` is the running sample count divided by
  the rate. Chunks of about 100 ms let playback start early.
- Honour `opts.signal`: stop sending, close the socket or kill the process, and return (do not
  throw) when it aborts. The loop aborts on barge-in and expects the generator to finish within
  one chunk. Check the signal before allocating anything (ids, queue entries): the loop can call
  `synthesize()` for a sentence that was cancelled while it was queued, and an early return
  must leave nothing behind (`KokoroTts.pendingRequests` is asserted in the tests). With the
  fetch transport, passing the signal to `fetch` makes the body reader reject with `AbortError`
  once it fires: wrap the body loop in `try/catch`, return when `opts.signal?.aborted`, rethrow
  otherwise (`elevenlabs.ts`; `cloud.test.ts` drives a body that rejects on abort). A provider
  that keeps the loop waiting after the abort delays the end of the turn; the loop guards the
  next turn against that tail, but the provider's work keeps running meanwhile.
- Throw only for a real failure. A thrown error from `synthesize()` fails the whole turn: the
  loop aborts the model stream and playback, emits `error` and ends the turn.
- Report the real sample rate per chunk. The loop does not resample output; the shell does.
- `voice`, `speed`, `language` are optional hints; map them to the vendor's parameters
  (Cartesia takes speed labels, Piper `--length_scale`, ElevenLabs `voice_settings.speed`).

### Local helpers

If the engine is a Python package, follow `faster-whisper.ts` / `kokoro.ts`: a long-lived
helper process started lazily, framed stdin (`framing.ts`), JSON lines or binary frames on
stdout, a `ready` message before the first request, `dispose()` that sends the close frame and
`killTree`s after a grace period. Pass the provider's `clock` to `HelperProcess` (and use it for
the ready timeout): the grace timer runs on it, so a test with a `SimulatedClock` controls when
the kill fires (`test/local-helpers.test.ts`, "HelperProcess"). Nothing outside
`packages/platform` calls the global `setTimeout`. Probe availability with `probePythonModule("<module>")`
(it tries the interpreter candidates in order and skips the Windows Store alias that only
prints "Python was not found"). Put the helper script in `packages/voice/python/` with its
protocol in the docstring, keep it `py_compile`-clean (the test runs it), and give it a
`--selftest` flag that prints `ready` without loading a model. Validate what the helper sends
with a zod schema (`HelperMessageSchema` in `faster-whisper.ts`): `nullish()` fields, unknown
keys ignored, a line that does not fit logged and dropped, never delivered as a transcript.

If the engine is a binary, follow `piper.ts`: one process per sentence is fine when start-up
is well under a second (the loop prefetches the next sentence); otherwise use the long-lived
helper pattern. Locate it with `which()` or an explicit path option, and support an
`argvPrefix` so tests can substitute a node script.

### Cloud services

Take the transport as an option (`ws?: WsFactory`, `http?: HttpStreamFn` from
`providers/cloud/transport.ts`) with the real one as the default. Build URLs with `URL` and
`searchParams`; never put the key in the URL unless the vendor allows nothing else, and then
behind an explicit option. Map HTTP 401/403 and auth messages to `ForerunnerError("provider_auth")`,
everything else to `provider_error` with `retryable` set sensibly.

### Registering

Wire the provider where the runtime builds the registry (the Extensions panel reads
`statusStt()`/`statusTts()` and writes `preferred`):

```ts
registry.registerStt(new MyStt({ apiKeyRef: "secret:my_stt_key", resolveSecret: vault.get, clock }),
  { secretRef: "secret:my_stt_key" });
```

`secretRef` lets the registry mark the row "no value for secret:..." before any probe and keeps
cloud providers out of the default policy until the key exists. Order of registration is the
tie-break order inside a kind. `excluded` on the selection input (the runtime fills it from the
panel: a `voice-*` row switched off, or one whose grant no longer lists the provider's key)
keeps a provider out of the policy altogether: it is not probed, its secret is never asked for,
and its status row carries the reason.

To make the provider choosable in the Extensions panel, give it a capability entry in
`packages/runtime/src/extensions/catalog.json` with `"voice": { "stt": ["my-stt"] }` (the name
the provider registers under) and, for a cloud provider, its key's name in
`permissions.secrets` plus its reference in `VOICE_SECRET_REFS`
(`packages/runtime/src/voice/providers.ts`): that is the key the runtime checks on the row's
grant and in the vault. Enabling the row makes it the preferred provider at the next voice
session; a row whose key has no value is skipped with the reason; a row switched off, or one
whose grant no longer lists the key, is skipped and the provider is excluded from the policy's
fallback (`voice.md`, "Which provider is preferred").

## How to change it

1. Add `src/providers/<local|cloud>/<name>.ts` and export it from `src/index.ts`.
2. Add tests (unit, no network):
   - availability `{ok:false}` with a clear reason when the engine or key is absent
     (`test/availability.test.ts`);
   - the happy path and the abort path against a fake transport (`test/helpers.ts` has
     `fakeWsFactory`, `FakeWsSocket`, `bytePieces`) or a protocol stand-in
     (`test/fixtures/*.mjs`);
   - an assertion that the key never appears in URLs, messages or captured log records
     (`Logger.setSinks` in `test/cloud.test.ts` shows how);
   - for a local engine, a `py_compile`/`--selftest` check of the helper.
3. Add a row to the providers table in `voice.md` and, if the engine needs a key, a line in
   `docs/status/BLOCKERS.md` saying live validation is pending that key.
4. Run `pnpm exec biome check --write packages/voice`, `pnpm typecheck`,
   `pnpm vitest run --project unit packages/voice`, `node scripts/secret-scan.mjs packages/voice`.

## Tests

`test/availability.test.ts`, `test/local-helpers.test.ts`, `test/cloud.test.ts` and
`test/registry.test.ts` are the templates. `FakeStt`/`FakeTts` in `src/providers/fake.ts`
show the minimum a provider must do for the loop, and `test/loop.test.ts` runs the whole loop
against them; a new provider does not need loop tests of its own.

## Known issues

- There is no recorded live traffic for the cloud vendors yet (keys pending); message shapes
  follow their public docs. When a key arrives, capture one session per vendor into
  `test/fixtures/` and replay it in `cloud.test.ts`.
- Availability results are cached per provider instance; call `refresh()` after an install.
