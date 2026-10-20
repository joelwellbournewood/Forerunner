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
| 0017 | Notifications: channel fallback order and what counts as urgent |
| 0019 | Model watch: recommendation thresholds and the estimate model |
| 0021 | Desktop control: platform adapters, gate placement and screenshot handling |
| 0024 | State service shape: direct Postgres for runtimes, a thin service for devices, realtime, remote commands and the mirror |
| 0025 | UI conventions over the daemon API: config source, SSE auth, chat stream frames, open shapes |
| 0026 | Daemon lifecycle: one `fr daemon` per install, shells attach to it |
| 0027 | Memory package parameters: embedder width, frontmatter keys, consolidation thresholds, scope grants |
| 0028 | Critic independence and verdict rules in code |
| 0029 | Daemon wiring of the phase 6 and 7 modules: extensions, updates, model watch, estimates, mirror, sandbox |
| 0030 | Command registry: risk resolution, confirmations, change log and undo |
| 0031 | Desktop shell: its own `/events` subscription, tray behaviour, restart handling, deep links |
| 0032 | Android app: one bundle under `/m`, Keystore-wrapped device key, remote plan envelope, offline scope, push stand-in |
| 0033 | Cloud runner: the vault unlock protocol and the PC-wins precedence rule |
| 0034 | Approvals web: session from a one-time link, per-tab device key, re-entered code for high-risk answers, chat as a remote command |
| 0035 | Cloudflare deploys: plan before deploy, staging first, production above autonomy level 3 only with a change card |
| 0036 | Core loop integration: critic, memory and commands inside the session runner and the conversation agent |
| 0037 | UI screens: proposed routes, the "route not available" state, mirrored schemas, charts and the settings command path |
| 0038 | Daemon wiring of notifications and Cloudflare deploys: producers on the real sources, shell detection and the OS notifier, preference writes, the email sender, tools behind the hooks and gate, structural routes |
| 0039 | Daemon wiring of adopted model settings, desktop control and data assets: the tables in force swapped on adopt, the desktop binding and the unavailable adapter, the indicator as a bus event, data under the install's data dir |
| 0040 | Live-model harness: the committed spend ledger, the live budget and per-run cap enforced before every call, one vitest invocation as a run, the real runtime behind the metered provider, the coder on the built-in tools from a patched registry copy, calibration subset first |
| 0041 | PC remote commands: the owner filter in `pickUp`, the daemon's `RemoteCommandWatcher` for `target: "pc"` (plans through the registry as the PC, inbox answers applied to pending cards), the heartbeated `desktop` device row, the project ceiling on the executor |
| 0042 | Critic: an escalate needs a named ground checked in code (a critical or high finding, a recorded limit, an item the evidence lists as unavailable, or low confidence), else the verdict the findings justify with an audit row; the evidence carries the input files, the diff in full up to the cap, the runtime's checks as verified, and a closing "Evidence not available" section; `medium` confidence above the H.4 line |
| 0043 | Claude Code tool names in the registry, mapped per driver: the registry keeps `cc:` names, the composition root picks the driver and maps them, the loop driver's table, `run_command` only under a sandbox promise, every dropped name an audit row |
| 0044 | Next-session queue items reach the agent of the human who queued them: `pending` and the count filtered by the agent's owner in the checklist, `consume` refusing another human's item (`validation`, `other_human`) and the runner skipping it, a project-wide note a different kind with its own ADR |
