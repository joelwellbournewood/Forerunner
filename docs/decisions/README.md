# Architecture decision records

One file per non-obvious decision, numbered, never edited after acceptance except to mark it
superseded. The spec changes only by PR with an ADR.

Template:

```
# NNNN — Title

Date: YYYY-MM-DD
Status: accepted | superseded by NNNN

## Context
## Decision
## Consequences
## Alternatives considered
```

| ADR | Title |
| --- | --- |
| 0001 | Stack: TypeScript monorepo, pnpm, Vitest, Biome, Hono, Tauri 2, node:sqlite, pg |
| 0002 | What to adopt from aerovato/operator-memory |
| 0003 | What to adopt from Headroom |
| 0004 | Agent drivers: Claude Agent SDK for live runs, in-process loop for the fake provider |
| 0005 | Shared state schema: one TypeScript schema, two SQL dialects, versioned migrations |
| 0006 | Vault: OS keychain via @napi-rs/keyring with an encrypted file store fallback |
| 0007 | Sandbox: Docker/Podman adapter with a process sandbox stand-in when no daemon exists |
| 0008 | Money: USD micro-units in the ledger, CHF at a daily rate, plan usage as a share |
| 0009 | Device identity and auth for the state service: Ed25519 device keys, scoped tokens |
| 0010 | Test environment: fake provider with recorded replies, simulated clock, fake git host |
| 0011 | Local daemon API between the shells and the runtime |
| 0012 | Voice pipeline: PCM contract, local helpers over stdio, latency anchors |
