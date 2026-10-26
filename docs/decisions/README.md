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
| 0028 | Critic independence and verdict rules in code; amended 2026-10-26: at effort max the verdict ends the run and the first call's cap (8192 to 24000) is sized from the review's budget left, and a captured verdict is never reported as a later refusal (D.15 live run of 2026-10-25) |
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
| 0044 | The subscription session path: both sources seeded from the vault (the fake row disabled beside a real one), `BillingRouter.pick` per task in the executor (runner, the agent's owner, the plan share from the ledger), a subscription run on the Agent SDK driver with the OAuth token read by reference, "subscription" ledger rows with the plan share and the plan level in the caps, the plan allowance as a setup input with a default, `cc:Bash` withheld on the SDK path unless opted in, the format-checked setup token, driver errors redacted before the store |
| 0045 | Phase 5 gate harness: the daemon's own Hono app over an install of the scenario world as "the UI" (fields the week never opens are loud `absent` stand-ins), the app's own parser, card builder and the state service's signed routes with the biometric assertion as "the emulator", the fake STT and TTS on the simulated clock as "the audio devices", seven simulated days from the installs' schedulers with the PC polling every ten simulated seconds, one comparison of the change log entries across voice, chat and the settings route (the UI column built from the settings form's fields), four runtime findings pinned by assertions and open as follow-up items RT-P5-1 to RT-P5-4 |
| 0046 | Phase 7 gate harness: Forerunner as a stand-in repository with the request through the conversation agent's model path and the module doc in the PR, the release built from `main` by the harness through the publish job's steps, two updaters on two homes over the one shared `release` table whose `rolled_back` row is what refuses the broken build on the second install, the model watch on `@forerunner/evals` over the real coder tasks with a probe driver that writes the reference solution on PASS, the weekly scheduler ticked by hand |
| 0047 | Daemon wiring of the sandboxed browser, agent email and the injection notification: capability tools present per run start (the `browser` row, the email settings row) and enforced per call, Chromium or the static reader decided at compose, the binding from the run token, `settings.browser.allowedDomains` into the session grant and the union-then-cap hook for registry entries, one set of email ports for the tools and the notifier, one `injection.flagged` audit row and one urgent notification per run and tool with the rules and never the passages, the catalog naming the real tools |
| 0048 | The voice bridge in the daemon: `VoiceBridge` over the conversation agent and the registry as the one `converse` port, typed lines through the same loop (`TextTurnStt`), the `/voice` routes and the SSE frames (first audio, read-back, approval, answer, turn), a spoken yes or no and a tap carried out by the registry itself with the registry's pending list as the one source of truth for the card and its outcome on the decision, providers by secret reference with no fake in production and `unavailable` with the reason, `voice.turn` and `voice.approval` rows plus audit rows, audio never stored unless turned on, stopped sessions dropped after a grace period |
| 0049 | Sign-off answers: applied only when the card's review is the task's latest (a stale one skipped and recorded), accept resolving the findings up to that review and closing the task along the graph's own edges in one transaction; the undo of a `session.start` names the scheduler's start id, an ended start refused and marked irreversible without reaching the kill switch, a running one stopped as its session only; a phone's start gets its id from the PC's watcher, recorded in the remote row's result, a row still being picked up refused for the moment |
| 0050 | Audit log export: one module behind `GET /audit/export` on the daemon and the state service and `fr audit export`; pages of 500 through `store.auditLog.list` streamed as JSON lines or RFC 4180 CSV with a formula guard; rows as stored (summaries redacted at write time, no raw parameters); the owner scope (the human's rows and their agents', install-level rows on the install only, another human's agent not found); limits checked before any read; the file named by the server |
| 0051 | Small-project mode: the new task's default tier chosen in one runtime function by every creation path and never by the critic; the plan writer (`POST /projects/:id/plan`) writing one milestone and a flat list under the flag, joining the project's open milestone on a later plan, phases after the existing milestones otherwise, dependencies first, caps and cycles refused before any write; the card carrying the mode and the default tier for a UI that computes neither; the settings card and sentence carrying the key's effect |
| 0052 | Always-human approvals: one answer admits one call, spent by the durable port as it is handed out; the row keyed on the raw canonical input |
| 0053 | Plan approval: the approved plan's identity, the filing session's end, and who starts the follow-up |
| 0054 | Android emulator smoke over raw CDP on the WebView's page target |
| 0055 | PM intake: one proposal in the inbox, written only on approval |
| 0056 | Source discovery: source kinds, duplicate keys and how an existing install is told |
| 0057 | Opus fast mode per project: the speed parameter on the same model id, variant price rows named `<id>-fast`, API-only sources |
| 0058 | Project docs: in the repository by pull request, the status doc rewritten per session |
| 0059 | Cross-project promotion in the loop: who reviews a proposal and when, the offer rule, what an accepted offer does |
| 0060 | Monthly jobs: the scheduler's monthly kind, where the calibration and handover reports live, and the stuck-place rule |
| 0061 | Quick chat retrieval: docs and lessons under measured budgets; recording a stated lesson |
| 0062 | Merge after an accepting review: an unattended `merge_pr` call behind the hooks, the checks rule in the tool, and what is never merged automatically |
| 0063 | Read aloud: the speaker, the `summary.speak` command and the voice alert rule |
| 0064 | Global hotkey: CommandOrControl+Shift+Space by default; the chord a per-install shell preference in `<config>/hotkey.json`, not a daemon setting; one grammar in the shell and the UI checked against one case file; a press toggles the push-to-talk turn (release ignored); the `forerunner://hotkey` and `forerunner://hotkey-changed` events and the `hotkey_status` / `hotkey_set` commands granted to the main window only; a refused chord keeps the working one and is reported, never a crash; the main window allows the microphone for its own pages only |
| 0065 | Shared secrets: wrapped to the named agents' install keys, both humans approve, served by reference |
| 0066 | Settings -> Capabilities -> Email: the capability's routes on the daemon, a page per agent, the full-discretion confirmation as the page's own step, the command audit read from the shared state |
| 0067 | The desktop-control indicator in the shells: a banner above every page of the app naming the agent, the app and the session with "Stop desktop control" (`POST /desktop/revoke`), a tray title, tooltip and item from the same frame, `desktopControl` on `GET /desktop/status` re-read on every (re)connect, a fresh `on` when the named app or session changes |
| 0068 | Runner unlock card: the device auto-answers only inside the window it set, the biometric prompt still runs, a key bridge returns only the wrapped answer (the daemon on the desktop, the Keystore store on Android) |
| 0069 | GitHub repository import: the worktree layout, the migration branch rule and the token path |
| 0071 | The specialist approval gate: the pass threshold (10 decided tasks at 90%), the approval eval budget, results recorded in `proposal.json`, a one-line promotion, applied once by its own human |
| 0072 | Settings per agent and specialist (spec D.4): the effort table's max tokens, speed mode and timeout columns, optional frontmatter keys, overrides on the agent row's `model_config` through `model.settings.set`, provider capability flags (`acceptsTemperature`, `fastMode`), and a speed preference that goes fast only with the project's `fast_mode` leave (D.20), the Opus rung, an API-style source and a fast-mode price |
| 0075 | CI results and PR comments start sessions: a poller over the git host (no webhook receiver), event keys in a persisted cursor saved before the start (at most once, a per-PR baseline first poll), the agent's own text by its login and a hidden mark, quiet hours defer, the comment quoted as data and flagged, never in the request |
| 0078 | What you say during a live session: the message kind and where the next task reads it |
| 0080 | The phone contributes: uploads idempotent by clientId, review verdicts under the biometric rule, push-to-talk relayed to the PC's voice loop |
| 0081 | Email commands need a sending mode other than off: the settings store refuses them at off, switching to off turns them off with an audit row and a notification, the watcher does not start at off |
| 0082 | Install identity on a shared store: an install names its human; the store's first row is never it |
| 0083 | Private memory next to a shared state: a local SQLite index routed by scope, and the Postgres adapter's refusal |
| 0084 | Email routes: a mount that identifies humans without an identity port fails closed per request, and an owner-check refusal is an audited 403 that stands without its row |
| 0085 | Android push from the state service: FCM HTTP v1 with the service account by reference, the four kinds to every device with a token, the human's quiet hours, dead tokens cleared with an audit row, a visible no-op unconfigured; the app's Firebase wiring waits for a project |
| 0086 | A high-risk answer on a phone that cannot confirm: every failure of the biometric step is a refusal with the platform's reason, bounded at 45 s in the shell and 60 s in the UI; the capability names `biometric:allow-status` and `biometric:allow-authenticate`; the emulator runner forwards the WebView console as `webview:` lines |
| 0087 | The emulator driver's click guard: a pointer, mouse or click event that lands outside the measured element is stopped before the page sees it and the click is sent again (`cdp.click_missed`, `cdp.click_lost`); the runner waits for Home's list and each screen's heading and prints `page:` lines after a failure; amended 2026-10-25 with the layout-settle wait and the fallback ladder (shifted mouse click, tap, `element.click()`) after run 40013402240 |
| 0088 | A hooks approval answered after its session ended: matched by task and key across the agent's sessions, consumed once by the call it was asked for, acted on once by a follow-up start (`StartRequest.approvalRequestId`) the daemon's `syncLateApprovals` and the cloud runner's inbox trigger share a mark for; a refused late answer consumed and recorded on the task; a session's end syncs |
| 0089 | Model watch: paid evals run only with the human's consent (an explicit "run evaluations", an `evaluate` answer on a pending report, or the opt-in `model_watch.run_evals`, default off; an adopt never spends; paid runs single-flight); the weekly schedule's last run survives a restart; eval tasks start nothing past the human's 80% month line; no eval command in the process stand-in without `model_watch.allow_process_sandbox` (high risk); a stopping daemon aborts the watch (fresh-install incident of 2026-10-26) |
| 0089 | Voice profiles: none, cpu or gpu, installed into a managed venv per profile with pinned requirements, verified on the profile's device with a loud CPU fallback, chosen in `fr setup`, switched from Settings (a daemon route with progress) and `fr voice install/remove`; `fr_stt.py` makes the pip-installed CUDA libraries loadable |
| 0091 | The chat turn's budget: three first-call estimates, at least USD 0.05 and at most USD 0.25 (`CHAT_TURN_BUDGET_CEILING_USD_MICRO`); a configured budget is used as given; a first call that does not fit is refused before anything is spent, with a reply that says to ask with less pasted text or switch to a cheaper model |
