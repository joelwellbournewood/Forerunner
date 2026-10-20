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
- Streams emit `message_start`, `text_delta`, `thinking_delta`, `tool_use_start/delta/end`,
  `message_end` with `usage`, or `error` with a stable code (`provider_auth`,
  `provider_rate_limit`, `provider_error`) and a `retryable` flag. `collectStream` turns a stream
  into a `ModelResponse` with time to first token and duration, both rounded to whole
  milliseconds (the Run row stores them in integer columns; `performance.now()` is fractional).
- Effort is a first-class request field; temperature is only honoured by providers that accept it
  (Anthropic adapters drop it).

## How to change it

1. Create `packages/runtime/src/provider/<vendor>.ts` implementing `ModelProvider` with an injected
   `fetch` (or client) so it can be tested with canned responses, never by hitting the network.
2. Map the vendor's streaming events onto `StreamEvent`; map HTTP errors onto the three codes.
3. Add the vendor's model ids to `DEFAULT_LADDER` in `models/ladder.ts` under its provider name and
   its prices to `packages/billing/src/pricing.ts` (unknown models are refused, never priced at zero).
4. Register it in the provider registry where the runtime is wired, behind a billing source kind.
5. Add it to the Extensions panel catalogue entry with the credential it needs (vault name).
6. Tests: request mapping (effort, caching flags, no temperature when unsupported), streamed
   response collection, error mapping, tier classification. See `test/anthropic-provider.test.ts`.

## Tests

`packages/runtime/test/anthropic-provider.test.ts` is the template.

## Known issues

- The Claude Agent SDK driver is Anthropic-only; other vendors run through the in-process loop.
