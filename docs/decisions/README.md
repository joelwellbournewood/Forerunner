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
| 0013 | Agent email: settings and sent log storage, the verification chain for email commands |
| 0014 | Sandboxed browser: policy enforcement points and what the browser never does |
| 0015 | Updates: pointer-file install layout and the trust model for signed releases |
| 0016 | How MCP tools map to ToolSpecs and action classes |
| 0024 | State service shape: direct Postgres for runtimes, a thin service for devices, realtime, remote commands and the mirror |
| 0025 | UI conventions over the daemon API: config source, SSE auth, chat stream frames, open shapes |
| 0026 | Daemon lifecycle: one `fr daemon` per install, shells attach to it |
| 0027 | Memory package parameters: embedder width, frontmatter keys, consolidation thresholds, scope grants |
| 0028 | Critic independence and verdict rules in code |
| 0029 | Daemon wiring of the phase 6 and 7 modules: extensions, updates, model watch, estimates, mirror, sandbox |
| 0030 | Command registry: risk resolution, confirmations, change log and undo |
| 0031 | Desktop shell: its own `/events` subscription, tray behaviour, restart handling, deep links |
| 0033 | Cloud runner: the vault unlock protocol and the PC-wins precedence rule |
| 0034 | Approvals web: session from a one-time link, per-tab device key, re-entered code for high-risk answers, chat as a remote command |
