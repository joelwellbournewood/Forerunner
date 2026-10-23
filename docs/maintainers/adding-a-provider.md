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
- Streams emit `message_start` (the answering model id and, when the vendor reports it as the
  message opens, `usage` with the input side of the bill: input, cache read and cache write
  tokens, output 0, so a call cut off before `message_end` still shows what its input cost),
  `text_delta`, `thinking_delta`, `tool_use_start/delta/end`, `message_end` with the full
  `usage`, or `error` with a stable code (`provider_auth`, `provider_rate_limit`,
  `provider_error`, and `aborted` when the request's `signal` fired) and a `retryable` flag. An
  adapter ends a stream whose `signal` fired with `error: aborted` whatever its client did (the
  Anthropic SDK exits its iterator without throwing after an abort, which would otherwise read
  as a complete `message_end`), unless the vendor's end-of-message event had already arrived:
  that message is complete and ends with `message_end` and its full usage. `collectStream` turns a stream into a `ModelResponse` with time
  to first token and duration.
- Effort is a first-class request field; temperature is only honoured by providers that accept it
  (Anthropic adapters drop it).
- Fast mode (spec D.20, ADR 0057): `ModelRequest.speed = "fast"` asks for the provider's fast
  mode on the same model id. Only a provider whose `fastMode` property is `true` ever receives
  it: the executor checks the property before it asks (a provider without it keeps every run
  standard and the executor writes a `model.fast_mode` audit row saying so). The Anthropic
  adapter sets `fastMode = true` and maps the field onto the Messages API's `speed: "fast"`
  body parameter with the `anthropic-beta: fast-mode-2026-02-01` header (`FAST_MODE_BETA`);
  without the field it sends neither. The run's records name the variant (`<id>-fast`), so a
  vendor that adds fast mode also adds the variant's price row in `@forerunner/billing`.

## How to change it

1. Create `packages/runtime/src/provider/<vendor>.ts` implementing `ModelProvider` with an injected
   `fetch` (or client) so it can be tested with canned responses, never by hitting the network.
2. Map the vendor's streaming events onto `StreamEvent`; map HTTP errors onto the three codes.
3. Add the vendor's model ids to `DEFAULT_LADDER` in `models/ladder.ts` under its provider name and
   its prices to `packages/billing/src/pricing.ts` (unknown models are refused, never priced at zero).
4. Register it in the provider registry where the runtime is wired, behind a billing source kind.
5. Add it to the Extensions panel catalogue entry with the credential it needs (vault name).
6. Fast mode is optional: leave `fastMode` unset, or set it to `true`, map `speed` onto the
   vendor's parameter and add `<id>-fast` price rows for the models that offer it.
7. Tests: request mapping (effort, caching flags, no temperature when unsupported, speed when
   offered), streamed
   response collection, error mapping, tier classification. See `test/anthropic-provider.test.ts`.

## Tests

`packages/runtime/test/anthropic-provider.test.ts` is the template; the fast-mode wire form
(`speed: "fast"` and the beta header with the field, neither without) is pinned in
`packages/runtime/test/fast-mode.test.ts` ("the Anthropic adapter's fast mode on the wire").

## Known issues

- The Claude Agent SDK driver is Anthropic-only; other vendors run through the in-process loop.
- The Agent SDK path does not carry `speed`: a run on it stays standard whatever the project's
  `fast_mode` says (in practice those are subscription runs, which are API-only-excluded anyway).
- The adapter does not read the response's `usage.speed`; a fast request the API served at the
  standard speed would still be recorded and priced as the variant (ADR 0057, consequences).
