# Adding a model provider

Anthropic is the first provider (ADR 0001). Any other vendor plugs in behind the same contract.

## Purpose

`packages/runtime/src/provider/types.ts` defines `ModelProvider`: `listModels()`, `stream(req)`,
`complete(req)`, `countTokens(text)`. The request and stream shapes follow the Anthropic Messages
API so the Anthropic adapter (`provider/anthropic.ts`) is a thin mapping and the fake provider in
`testenv` can replace any vendor in tests.

## How it works

- `ProviderRegistry` (`provider/registry.ts`) holds providers by name. The model ladder
  (`models/ladder.ts`) maps each tier to a model id per provider; the billing router picks the
  source and credential.
- Anthropic has two adapters under the one name `anthropic` (ADR 0098): the Messages adapter
  (`provider/anthropic.ts`) for an API key, and `ClaudeCodeProvider` (`provider/claude-code.ts`)
  when the only credential is a Claude subscription token. That token is for Claude Code only,
  so the second adapter makes each call as one Claude Code turn through the Agent SDK and maps
  its raw stream events the same way; the Messages adapter refuses a `sk-ant-oat…` credential.
  A vendor whose consumer login is tied to its own client follows the same rule: run the
  vendor's client, never copy its headers.
- Streams emit `message_start` (the answering model id and, when the vendor reports it as the
  message opens, `usage` with the input side of the bill: input, cache read and cache write
  tokens, output 0, so a call cut off before `message_end` still shows what its input cost),
  `text_delta`, `thinking_delta`, `tool_use_start/delta/end`, `message_end` with the full
  `usage`, or `error` with a stable code (`provider_auth`, `provider_rate_limit`,
  `provider_error`, and `aborted` when the request's `signal` fired) and a `retryable` flag. An
  adapter ends a stream whose `signal` fired with `error: aborted` whatever its client did (the
  Anthropic SDK exits its iterator without throwing after an abort, which would otherwise read
  as a complete `message_end`), unless the vendor's end-of-message event had already arrived:
  that message is complete and ends with `message_end` and its full usage. `collectStream`
  turns a stream into a `ModelResponse` with time to first token and duration, and keeps the
  `message_start` usage, so the loop adds a cut-off call's input cost to the run before it
  rethrows the abort.
- Effort is a first-class request field. What a provider accepts beyond the common request is
  its **capability flags** (spec D.4, ADR 0072), read through `providerCapabilities(provider)`
  (it fills the defaults; read flags through it, never directly), which returns
  `ProviderCapabilities { acceptsTemperature, fastMode }` from two declarations:
  - `ModelProvider.capabilities?: ProviderDeclaredCapabilities` with `acceptsTemperature`: the
    provider takes a sampling temperature. The loop sends `ModelRequest.temperature` only when
    it is true; the settings screen (`GET /settings/models`) shows a temperature column only
    when it is true, and `model.settings.set` refuses to store a temperature otherwise. The
    Anthropic adapter says `false` (current Claude models reject one) and also never maps the
    field. A provider that declares nothing takes no temperature.
  - `ModelProvider.fastMode` (spec D.20, ADR 0057): see the next item.
- Fast mode (spec D.20, ADR 0057): `ModelRequest.speed = "fast"` asks for the provider's fast
  mode on the same model id. Only a provider whose `fastMode` property is `true` ever receives
  it: the executor checks the property before it asks (`decideFastMode`; a provider without it
  keeps every run standard and the executor writes a `model.fast_mode` audit row saying so),
  and the loop drops `speed` for a provider whose flag is not true (ADR 0072). The Anthropic
  adapter's `fastMode` is `true` on an API key and `false` on a subscription token (ADR 0072),
  and it maps the field onto the Messages API's `speed: "fast"` body parameter with the
  `anthropic-beta: fast-mode-2026-02-01` header (`FAST_MODE_BETA`) for an Opus model id only
  (`fastModeApplies`); without the field it sends neither. The run's records name the variant
  (`<id>-fast`), so a vendor that adds fast mode also adds the variant's price row in
  `@forerunner/billing`. A specialist's or agent's `speed_mode` (spec D.4) only narrows this:
  `standard` keeps a run of a fast-mode project standard, `fast` takes effect only where the
  project's flag allows it.

## How to change it

1. Create `packages/runtime/src/provider/<vendor>.ts` implementing `ModelProvider` with an injected
   `fetch` (or client) so it can be tested with canned responses, never by hitting the network.
2. Map the vendor's streaming events onto `StreamEvent` (with the input-side `usage` on
   `message_start` when the vendor reports it there); map HTTP errors onto the three error
   codes, and end a stream whose `signal` fired with `error: aborted` unless the vendor's
   end-of-message event had already arrived.
3. Add the vendor's model ids to `DEFAULT_LADDER` in `models/ladder.ts` under its provider name and
   its prices to `packages/billing/src/pricing.ts` (unknown models are refused, never priced at zero).
4. Declare `capabilities.acceptsTemperature` `true` only when the vendor accepts a temperature
   on the credential the adapter holds, and map `temperature` in `stream` only then; a value the
   vendor rejects must never reach it.
5. Register it in the provider registry where the runtime is wired, behind a billing source kind.
6. Add it to the Extensions panel catalogue entry with the credential it needs (vault name).
7. Fast mode is optional: leave `fastMode` unset, or set it to `true` (on the credentials that
   offer it), map `speed` onto the vendor's parameter and add `<id>-fast` price rows for the
   models that offer it.
8. Tests: request mapping (effort, caching flags, no temperature when unsupported, speed only
   where fast mode applies), the capability flags per credential, streamed response
   collection, error mapping, tier classification. See `test/anthropic-provider.test.ts`.

## Tests

`claude-code-provider.test.ts` covers the Claude Code adapter (a tool call handed over under its
own name and the stream stopped at the response, the quoted transcript, a missing or refused
token, the schema shape, and the Messages adapter and the setup check refusing a subscription
token). `packages/runtime/test/anthropic-provider.test.ts` is the template (11 tests; two for the flags:
no temperature and fast mode only on an API key, a proxied copy keeping them; `speed: "fast"`
and the beta header on an API key with an Opus id, nothing on a Sonnet id, a subscription token
or a request without `speed`; and the abort rule: the input-side `usage` on `message_start`,
`error: aborted` for an abort before the response and for the SDK's silent exit after an abort
mid-stream, a complete `message_end` kept when it came before the abort); the fast-mode wire form (`speed: "fast"` and the beta header
with the field, neither without) is also pinned in `packages/runtime/test/fast-mode.test.ts`
("the Anthropic adapter's fast mode on the wire"). `packages/runtime/test/run-settings-runs.test.ts`
proves the loop's side with the testenv `FakeProvider`, which takes `capabilities`
(`acceptsTemperature`, `fastMode`) in its options so a test can make it a provider that accepts
a temperature or has fast mode.

## Known issues

- The Claude Agent SDK driver is Anthropic-only; other vendors run through the in-process loop.
- The Agent SDK path does not carry `speed`: a run on it stays standard whatever the project's
  `fast_mode` says (in practice those are subscription runs, which are API-only-excluded anyway).
- The adapter does not read the response's `usage.speed`; a fast request the API served at the
  standard speed would still be recorded and priced as the variant (ADR 0057, consequences).
- The capability flags are static per adapter and credential. A vendor whose models differ (one
  accepts a temperature, the next does not) needs the flag per model; none does today.
