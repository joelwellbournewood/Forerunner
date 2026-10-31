# 0098 — A Claude subscription token runs only in Claude Code: chat, intake, the critic and the model watch call it through the Agent SDK

Date: 2026-10-31
Status: accepted

## Context

U-048: an install whose only Claude credential is a subscription token (`claude setup-token`,
`sk-ant-oat…`) built the Messages adapter with that token as `authToken`, so chat, the PM intake,
the critic and the model watch sent it to `POST /v1/messages` as `Authorization: Bearer`. Task
runs already went through the Agent SDK (ADR 0044).

What the sources say, read on 2026-10-31:

- **Claude Code itself** (the native binary the Agent SDK 0.3.304 ships, version 2.1.304):
  for a subscriber it builds its Anthropic client with `authToken` and `apiKey: null` (so
  `Authorization: Bearer <token>` and no `x-api-key`) and adds the beta `oauth-2025-04-20`
  (`{ beta: oauth_auth, when: () => isClaudeAISubscriber() || … }`) to every Messages call. It
  also starts every system prompt with its own identity line. Without that beta header the API
  refuses a bearer OAuth token; whether it also checks the system prompt is decided on the
  server and cannot be read from the client.
- **Anthropic's terms** (code.claude.com/docs/en/legal-and-compliance, "Authentication and
  credential use"): OAuth authentication "is designed to support ordinary use of Claude Code and
  other native Anthropic applications"; developers building products "should use API key
  authentication"; Anthropic "does not permit third-party developers … to route requests through
  Free, Pro, Max, or Ultra plan credentials on behalf of their users"; this "does not … prevent
  an end user from signing in to the unmodified Claude Code binary with their own Claude
  subscription". The authentication page documents the `setup-token` token as
  `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code.

Copying Claude Code's header (and its identity line) into Forerunner's own adapter would make
Forerunner pass for Claude Code. That is not the documented use, and the server may refuse it
at any time.

## Decision

1. **The subscription token never leaves Forerunner except into Claude Code.** With an API key
   in the vault the Messages adapter runs on the key as before. With only the subscription
   token, compose builds `ClaudeCodeProvider` (`packages/runtime/src/provider/claude-code.ts`):
   every model call of chat, intake, the critic, the model watch and the monthly jobs is one
   `query()` of the Agent SDK, which runs the Claude Code binary unmodified with the token as
   `CLAUDE_CODE_OAUTH_TOKEN` in a scrubbed environment (`scrubEnv`). Claude Code authenticates
   as it does for any subscriber; Forerunner sets no auth header and no beta header.
2. **One call is one Claude Code turn, read up to the model's response.** The request's system
   prompt is the custom system prompt; `tools: []` (no Claude Code tool), the request's tools on
   an in-process MCP server (`forerunner`, `alwaysLoad`) that runs nothing, `allowedTools: []`
   with `permissionMode: "dontAsk"`, `maxTurns: 1`, `settingSources: []`,
   `persistSession: false`, an empty working folder under the cache. The raw stream events
   (`includePartialMessages`) map onto `StreamEvent` as the Messages adapter maps them; the
   `mcp__forerunner__` prefix is removed from a `tool_use`, and the subprocess is stopped at
   `message_stop`. The caller's loop runs the tool under its hooks, budgets and audit as before.
   Claude Code takes only user turns, so a call with earlier turns quotes them (tool calls and
   results included) in one user turn (`promptFor`).
3. **The token is read at every call**, so a token replaced in the app is used by the next call
   (U-049).
4. **The Messages adapter refuses a subscription token** (`SUBSCRIPTION_TOKEN_PREFIX`), and the
   setup check (`validateAnthropicKey`) checks a `sk-ant-oat…` value's format without a request
   (amends ADR 0044 item 7, which sent it to `GET /v1/models`).
5. The provider's `name` stays `anthropic` (the ladder and the pricing table are Anthropic's);
   `via: "claude-code"` says how it calls. Fast mode stays off (API only, spec D.20).

## Consequences

- A subscription-only install works for chat, intake and reviews, and the person's token only
  ever reaches the binary Anthropic documents it for.
- Each call starts a Claude Code subprocess: a chat reply on a subscription-only install comes
  later than on an API key (about the subprocess start, one to three seconds). With an API key
  in the vault the loop paths use the key, as before.
- A follow-up call after a tool call sees the conversation quoted in one user turn, not as
  native turns; the chat and the critic need at most one such call per turn.
- `listModels()` is empty for this provider (Claude Code lists no models for a subscription
  token): the model watch reports no new models until an API key exists.
- A live check with a real token stays with the live harness (BLOCKERS.md).
- Anthropic's text says products "should use API key authentication"; the owner may prefer to
  ask subscription users for an API key too. This ADR keeps the subscription path within the
  "unmodified Claude Code binary with their own Claude subscription" case.

## Alternatives considered

- **Add `anthropic-beta: oauth-2025-04-20` to the Messages adapter** (what Claude Code sends).
  Rejected: it routes plan credentials through Forerunner's own client, which the terms do not
  permit, and the server may require more of Claude Code's identity than a header.
- **Run chat, intake and the critic through `SdkAgentDriver` as whole agent runs.** Rejected:
  the driver serves Claude Code's tools, not Forerunner's (no MCP bridge for the command tools
  or `submit_review`), and each path would need its own result mapping; a provider keeps the
  loop driver, its hooks and every caller unchanged.
- **Keep a long-lived Claude Code session per run and answer its MCP calls with the loop's tool
  results.** Rejected for now: matching calls to sessions, closing sessions a loop abandons and
  the loop's own context changes make it fragile; the quoted transcript is enough for one
  follow-up call.
