# 0004 — Agent drivers: Claude Agent SDK for live runs, in-process loop for everything testable

Date: 2026-10-20
Status: accepted

## Context

The spec says the orchestrator is "built on the Claude Agent SDK" and that limits must be
enforced in code. Unit tests must run with a fake provider and no network. The SDK drives the
Claude Code engine in a subprocess: it gives subscription login (`CLAUDE_CODE_OAUTH_TOKEN`),
`maxBudgetUsd`, `maxTurns`, `effort`, hooks (`PreToolUse`, `PostToolUse`, `Stop`, ...),
subagents and MCP servers. It cannot run against a fake model.

## Decision

Two drivers behind one `AgentDriver` contract, both routed through the same
`EnforcementHooks`:

| Driver | Used for | Model access |
| --- | --- | --- |
| `LoopAgentDriver` (`packages/runtime/src/agent/loop.ts`) | all unit and integration tests, the conversation agent, specialists that need only Forerunner tools (state, git host API, browser, email MCP servers) | any `ModelProvider`: the fake provider, the Anthropic Messages adapter, future vendors |
| `SdkAgentDriver` (`packages/runtime/src/agent/sdk.ts`) | coding, testing and ops specialists that need the Claude Code tool set inside a sandboxed worktree; subscription billing | Claude Agent SDK; `env` carries exactly one credential chosen by the billing router |

Enforcement is identical: `beforeModelCall` (kill state, wall clock, steps, run/session caps,
outer caps from billing) and `beforeToolCall` / `afterToolCall` (tool allowlist, path
containment, domain allowlist, autonomy decision with approval requests, secret injection,
untrusted-output wrapping, audit). In the SDK driver the hooks are attached as `PreToolUse`
(deny with reason), `PostToolUse` (wrap and audit) and `Stop`; `maxBudgetUsd` and `maxTurns`
are set from the capability token as a second layer, and the subprocess is registered with the
kill switch so a stop kills its process tree.

A run's authority is a signed `CapabilityToken` (HMAC, key held by the runtime process). The
model sees only the token id. Sub-agent tokens are derived and can only narrow.

## Consequences

- Every limit has a test in `packages/runtime/test/` that proves the block happens before the
  call (overspend, steps, depth, tool, path, domain, secret, autonomy, kill within 2 s).
- Live SDK behaviour (usage reporting on subscription vs API key) is verified by an integration
  test that runs only when a credential is present; its result is recorded in `gates.md`.
- The fake provider must emit realistic streams so TTFT, timeouts and aborts are testable
  without network; `SimulatedClock` drives latency.

## Alternatives considered

- SDK only: no deterministic tests, every CI run would need credentials and money.
- Own loop only: loses subscription login and the mature Claude Code tool set for coding work.
