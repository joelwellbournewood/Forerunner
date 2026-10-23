# Cloud runner

`services/cloud-runner`: the headless runner for the hybrid and cloud-only run modes. It runs
the same runtime as the desktop daemon (ADR 0026) against the shared Postgres state, unlocks
its encrypted vault blob with a key the human's device releases through the shared state,
runs the agent's schedules and inbox triggers while no PC daemon is online, honours the kill
switch from the shared state and watches the agent mailbox for email commands. ADR 0033 records the unlock
protocol and the precedence rule; ADR 0006 the vault blob; ADR 0013 and `email.md` the email
command chain it reuses.

## Purpose

Spec Architecture "Run modes": *Hybrid — PC when on, cloud runner when off — overnight and
scheduled sessions* and *Cloud only — server or headless use*. "Secrets vault": *Cloud runner —
encrypted blob, key held by the human's device — human approves unlock per runner start, or
sets an auto-unlock window*; *a subscription token ... on a cloud runner is used only by its
owner's agent*. "Email commands: tasks by email, run in the cloud": checking by push or
five-minute polling, acknowledgement within a minute, billing on the runner with the human's
own source. Build order phase 6: "Cloud runner for hybrid mode, with vault unlock flow"; gate
"Cloud runner completes an overnight session while both PCs are off. An emailed task is
acknowledged within 1 minute and completed in the cloud; a spoofed or forwarded email is
ignored." Phase 8 scenarios 1 (the good day: a scheduled session runs at night) and 2 (email
task with both PCs off).

Requirements covered (ids from `docs/requirements.md`): S.12 (vault, cloud runner: encrypted
blob, key held by the device, approval per start or an auto-unlock window), S.14 (a
subscription on a cloud runner is used only by its owner's agent: the billing choice refuses
another human's agent and uses a subscription only on a personal runner), S.8 (kill switch
from any device stops cloud sessions within 2 s), S.9 and T.14 (an audit row for every unlock
request, grant, refusal, lock, remote command and email command), S.4 (secrets by reference;
the key and the mailbox credentials never reach logs or the store), T.2 (IMAP IDLE push with a
configurable poll fallback), T.7 and T.10 (a task command starts a cloud session; the
acknowledgement goes out within a minute and the completion summary at the end), T.12 (the
per-email cap is the session's hard budget and the email autonomy level the session's level),
T.13 (the runner bills the human's own source: subscription on a personal runner, else an API
key), R.4 and R.8 (remote start / stop / kill picked up atomically from the shared state;
heavy work off the phone), E.1 (triggers: schedule, a peer's message or the human's answer in
the inbox, verified email from the owner), U.7 and
U.8 (sessions carry `runner: "cloud"` and the runner's device id).

## How it works

### Layout

| File | Role |
| --- | --- |
| `src/main.ts` | `pnpm runner` (the image's CMD): read the environment, start, stop on SIGINT / SIGTERM, exit 75 to forget the vault key |
| `src/config.ts` | `readRunnerConfig(env)`: every `FORERUNNER_*` setting, zod-validated, with its default; `describeConfig` for the start log (store credential redacted) |
| `src/vault-unlock.ts` | the unlock protocol: `RunnerVaultUnlock` (runner side), `answerUnlockChallenge` (node device side for scripts and tests), the audit tool names; the constants, `shouldAutoAnswer` and the WebCrypto `wrapVaultKey` come from `@forerunner/vault/runner-unlock` (ADR 0068) |
| `src/presence.ts` | `PcPresence`: the PC-wins rule over `device.last_seen` and `session.runner` |
| `src/inbox-trigger.ts` | `InboxTrigger`: a peer's unread message or the human's answer to a session's question asks for a `message` session (the PC rule applies) |
| `src/billing.ts` | `pickRunnerBillingSource`: the human's source for cloud sessions, decided by `BillingRouter` from `@forerunner/billing`; `runnerRoutingPolicy`, `VaultCredentialProbe` |
| `src/remote.ts` | `RemoteCommandWatcher`: `remote_command` rows with target `cloud` (kill, stop, start, pause refused), from the runner's human's devices only |
| `src/email-watch.ts` | `EmailWatch`: the email module composed around the agent's mailbox; the completion hook |
| `src/health.ts` | `createHealthApp` (the Hono app) and `startHealthServer` (`@hono/node-server`, loopback only), the readiness file |
| `src/runner.ts` | `startCloudRunner(deps)`: the composition root; `CloudRunner` (status, startSession, stop) |
| `Dockerfile` | the runner image (also the sandbox image); `.dockerignore` at the repository root applies |

### Configuration

Everything comes from the environment; nothing names an org, a host, a mailbox or a user
path. `FORERUNNER_HOME` sets the app directories as everywhere else (the image uses `/data`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORERUNNER_STATE_URL` | required | `postgres://...` shared state (TLS in deployments); `sqlite:<file>` for a single-machine trial |
| `FORERUNNER_STATE_SCHEMA` | connection default | Postgres schema (created if missing) |
| `FORERUNNER_RUNNER_ID` | `runner-<hostname>` | this runner's id: its `device` row name, the audit rows, the unlock challenge |
| `FORERUNNER_RUNNER_HUMAN` | the store's only human | human id or email the runner serves; required once the store holds several (`identity_ambiguous` otherwise; a selector naming nobody is `not_found`; ADR 0082) |
| `FORERUNNER_RUNNER_AGENT` | the human's first principal | agent id or name |
| `FORERUNNER_RUNNER_VAULT_PATH` | `<config>/vault.runner.json` | the encrypted blob (ADR 0006 file vault; the key is never on the runner) |
| `FORERUNNER_RUNNER_UNLOCK` | `window` | `window` honours the human's auto-unlock window; `ask` asks on every unlock |
| `FORERUNNER_RUNNER_UNLOCK_TIMEOUT_MS` | 24 h | how long a start waits for the human's answer |
| `FORERUNNER_RUNNER_UNLOCK_POLL_MS` | 2 000 | how often the open request is re-read |
| `FORERUNNER_RUNNER_UNLOCK_CHALLENGE_TTL_MS` | 10 min | a challenge's validity; an expired one is withdrawn and replaced |
| `FORERUNNER_RUNNER_UNLOCK_TICK_MS` | 30 000 | window check cadence |
| `FORERUNNER_RUNNER_IDLE_LOCK_MS` | 0 (off) | lock the vault after this long with no session; re-unlocks from the cache inside the window |
| `FORERUNNER_RUNNER_PERSONAL` | false | the runner serves one person: their subscription may pay for sessions |
| `FORERUNNER_RUNNER_MAIL_CHECK_MS` | 300 000 | poll interval for the mailbox (minimum 10 s); push is used when the host offers IDLE |
| `FORERUNNER_RUNNER_MAIL_PUSH` | true | false never opens the push (IDLE) connection: the watcher lists unseen mail at the poll interval only (`/health` reports `pushActive: false`) |
| `FORERUNNER_RUNNER_MAIL_VERIFIER` | `mailauth` | `mailauth` re-verifies DKIM and SPF with DNS; `header` trusts `Authentication-Results` from the listed hosts |
| `FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS` | (none) | comma-separated authserv-ids believed by the `header` verifier (required with it) |
| `FORERUNNER_RUNNER_HEALTH_HOST` / `_PORT` | `127.0.0.1` / 8787 | the health route; a non-loopback host (`isLoopbackHost`: 127.x, `localhost`, `::1`) is refused by the configuration, listed with the other issues; port 0 picks a free one |
| `FORERUNNER_RUNNER_READY_FILE` | `<runtime>/runner-ready.json` | written when ready, removed on stop |
| `FORERUNNER_RUNNER_PC_ONLINE_MS` | 180 000 | how recent a desktop's `last_seen` must be for the PC to count as online |
| `FORERUNNER_RUNNER_HEARTBEAT_MS` | 30 000 | the runner's own `device.last_seen` heartbeat and presence refresh |
| `FORERUNNER_RUNNER_COMMAND_POLL_MS` | 500 (max 2 000) | remote command and kill-file poll: a kill lands within one interval |
| `FORERUNNER_RUNNER_SCHEDULE_TICK_MS` | 30 000 | scheduler tick and schedule refresh |
| `FORERUNNER_RUNNER_INBOX_POLL_MS` | 30 000 | inbox trigger poll (new peer messages, answered session requests); 0 turns inbox triggers off, otherwise at least 1 000 |
| `FORERUNNER_RUNNER_SESSION_CAP_USD_MICRO` | 6 250 000 (CHF 5) | session cap when the project sets no `settings.session_cap_usd_micro` |
| `FORERUNNER_GITHUB_API_BASE` | `https://api.github.com` | the GitHub host for session grants |
| `FORERUNNER_VERSION` | 0.1.0 | reported by `/health` and recorded on sessions |

The runtime's own variables apply too (`FORERUNNER_REGISTRY_DIR`, `FORERUNNER_HEADROOM_*`,
`FORERUNNER_SANDBOX_ENGINE`, `FORERUNNER_CHF_PER_USD`, ...).

### Start sequence (`startCloudRunner`)

1. Open the shared store, resolve the human and the agent: the human through the runtime's
   `bindInstallHuman` (ADR 0082: `FORERUNNER_RUNNER_HUMAN` as an id or email, else the
   store's only human; several humans and no selector are `identity_ambiguous`, an empty
   store `not_found` "run the desktop setup first": the runner never creates a human), the
   agent among that human's principals by id or name, the first otherwise; register or find the runner's
   `device` row (kind `runner`, named after the runner id; its public key is an identifier
   persisted in `<config>/runner-device.json`, since runners authenticate to the state
   service with the admin token, ADR 0009) and stamp `last_seen`.
2. Unlock the vault (below). A start without the key never proceeds.
3. `composeRuntime({ startServices: false, vault, stateUrl, identity: { humanId }, ... })`:
   the runtime bound to the human of step 1 (`rt.identity.source` is `option`), the daemon's modules
   (provider from the vault credential, enforcement hooks, loop driver, registry, tools,
   sandbox port, context layer, estimates, extensions) without the daemon's scheduler,
   kill-file watcher or connector start. Then `extensions.start()` so bridged tools exist.
4. Choose the billing source (below), build the session stack: `LoopTaskExecutor` with that
   source inside `PrTaskExecutor` (as the daemon), a `SessionRunner` whose planner limits an
   email session to its own task, sessions recorded with `runner: "cloud"` and the runner's
   device id.
5. Start the scheduler (schedules from `project.settings.schedules`), the remote command
   watcher, the kill-file watcher, the inbox trigger, the email watch, the heartbeat and (when
   configured) the idle lock; open the health route; write the readiness file.

`stop()` reverses it and removes the readiness file. `main.ts` exits 0 after a signal, 1 when
the start fails (the reason is logged, never a credential), 75 (`RELOCK_EXIT_CODE`) when the
auto-unlock window ended and the runner is idle (below).

### Unlock flow

The vault file is `EncryptedFileVault` (ADR 0006) without its `vault.key`: the human's device
created the blob (or exported the key) and keeps the 32-byte key. `RunnerVaultUnlock.ensureUnlocked`:

1. Already unlocked: nothing. Locked with a cached key and an open window: `vault.unlock(cached)`.
2. Otherwise a challenge: a fresh X25519 key pair, a 32-byte nonce and a challenge id in a
   `human_request` (`kind: "credential"`, `risk: "high"`, `blocking: true`, options
   `unlock` / `deny`, `change_card` = the challenge, `UnlockChallengeCardSchema`). An audit
   row `runner.unlock_requested`.
3. The device answers (`answerUnlockChallenge(card, vaultKey, { autoUnlockUntil? })`): the
   key wrapped with X25519 + HKDF-SHA256 (salt = nonce, info bound to the challenge id) +
   AES-256-GCM (AAD = runner id + challenge id); the answer is public key, iv, ciphertext, tag.
   The desktop and Android inboxes render the request as the unlock card (ADR 0068, see
   apps.md): Unlock once, Unlock and allow for 1 / 8 / 24 h, Unlock and clear the window,
   Deny. The desktop daemon wraps the key from its vault (`POST /runner-unlock/wrap { requestId }`,
   the key under `cloud_runner_vault_key:<runner>`, the challenge read from the stored request), the phone from its Keystore-wrapped secure store
   (`runner-vault-key-<runner>`), both through `wrapVaultKey` in `@forerunner/vault`
   (`runner-unlock.ts`, WebCrypto, no dependencies), which also holds the constants and
   `shouldAutoAnswer`; this file re-exports them. `answerUnlockChallenge` (node:crypto) stays
   for scripts and the tests. `shouldAutoAnswer` over the window the device itself set says
   when it may answer without a choice (on the phone the biometric prompt still runs).
4. The runner polls the request (`clock.sleep`, so simulated clocks work), unwraps in memory,
   hands the key to the vault and zeroes it. `runner.unlock_granted` on success; on a refusal
   (`wrong_key`, `unwrap_failed`, `stale_challenge`, `expired`, `malformed`, `bad_device_key`,
   `denied`) a `runner.unlock_refused` row with the reason and, except for `deny`, a fresh
   challenge; three refusals or the timeout fail the start. An expired challenge is withdrawn.
5. Window: `human.notify_prefs.cloud_runner.auto_unlock_until` (ISO-8601). With policy
   `window` an open window keeps a copy of the key so an idle lock re-unlocks silently;
   `checkWindow` (every tick) forgets the copy, locks the vault and writes
   `runner.vault_locked` when the window ends or is shortened or cleared. The device may set
   the window with its answer (at most seven days ahead; `bad_window` otherwise). Without a
   window the approval lasts the process lifetime and no copy is kept. Policy `ask` ignores
   windows.
6. Forgetting: the runtime gave the model credential to the provider at compose time, so the
   runner cannot take it back from a live process. On a window end it locks the vault and,
   once no session is running, calls `onRestart`; `main.ts` exits 75 and the supervisor
   starts a fresh process that must be unlocked again.

Nothing of the key is ever logged: `Logger` redaction, `redactKey` on error text, and the
tests scan every log line and every store row for all encodings.

### Precedence: a PC daemon that is online wins

`PcPresence.check()` says the PC is online when a non-revoked `device` of the human with kind
`desktop` has `last_seen` within `FORERUNNER_RUNNER_PC_ONLINE_MS`, or when an active
`session` of the agent has `runner: "pc"`. A scheduled, inbox-triggered or unforced manual
session that fires while the PC is online is dropped for that firing with a log line and a
counter in `/health` (`schedulesSkipped`); the PC's own scheduler fired it. Inbox items are not
lost: `InboxTrigger` leaves them untouched while a PC is online and looks again after
`FORERUNNER_RUNNER_PC_ONLINE_MS` (below). Email-triggered sessions and remote commands with
target `cloud` always run on the runner. The shared store's
one-active-session-per-agent check stops any overlap in either direction. The runner heartbeats
its own `runner` device row every `FORERUNNER_RUNNER_HEARTBEAT_MS`.

Schedules are read from every active project's `settings.schedules` (members, when set, must
include the agent): `{ kind: "daily" | "weekdays" | "every", time: "HH:MM", everyMinutes,
timezone?, enabled?, agentId?, id? }`, validated by `ProjectScheduleSchema` and refreshed every
tick; the time zone defaults to the human's. As in the daemon's scheduler, a daily schedule
whose time already passed on the current local day fires at the first tick.

### Inbox triggers

Spec E: a new message or a human answer starts a session. No PC daemon watches the inbox
between sessions, so while the PC is off the runner does: `InboxTrigger` polls every
`FORERUNNER_RUNNER_INBOX_POLL_MS` (default 30 s; 0 turns it off) and asks the scheduler for a
session with trigger `message` when it finds

- an unread message addressed to the agent from another agent, created after the runner
  started (older ones are the next session's business), or
- a request a session filed (`session_id` set, `author_agent` the agent) that the human
  answered after the runner started. A plan approval (`change_card.key` `plan:<session>`)
  answered `approve` starts the session with `planApproved` set to the card's `plan_id`
  (`plan:<session>#<sha256 of the planned task ids in order>`, `runtime.md` "Plan approval",
  ADR 0053): the runner plans again and runs only while the plan is still that plan, else it
  files the changed plan as a new request and runs nothing, so a task added after the human
  looked never runs on the old approval. The newest approved plan in a check binds the start
  (an older one is superseded and proposed again by the runner); a plan card without a
  `plan_id` (an earlier build's request) starts a plain session that proposes the plan again. A
  rejected plan starts nothing. The runner's own unlock challenges and the email approvals have
  no `session_id` and never count, nor do another agent's requests.

Each item triggers at most once (ids are remembered until the message is read or the answer
leaves the 24 h look-back). A check waits while a session of the agent runs or the kill switch
holds it: the session reads and marks the inbox itself (checklist, re-checks between tasks),
so only what it did not read can trigger afterwards. The request names the project when every
item is about one project. While a PC is online the items stay for the PC and the next check
waits `FORERUNNER_RUNNER_PC_ONLINE_MS`. The PC rule is applied twice, by the trigger before it
asks and by the scheduler's start; a PC that appears between the two makes the start report
`skipped`, and the trigger treats that as a deferral (the items are remembered only once the
scheduler owns the request, so a dropped firing never loses them). `scheduler.request` itself
answers `started` before the start has looked at the PC, which is why the runner wraps it
(`requestDecided` in `runner.ts`) for the trigger and for `startSession`, which then answers
`deferred` for a skipped firing. The counters (`checks`, `triggered`, `deferred`, last reason)
are in `/health` under `inbox`.

### Sessions and billing

`pickRunnerBillingSource` asks `@forerunner/billing`'s `BillingRouter` (billing.md, "Routing
policy") with `{ runner: "cloud", purpose: "session", modelTier: "sonnet" }` over the human's
enabled sources (`stateSources` from the runtime, the daemon's lister) and the runner's vault
as the probe (`VaultCredentialProbe`: available when the credential is in the vault; fake
sources need none). The router's invariants hold (never another human's source, never a
disabled one) and its cloud rule is policy, `runnerRoutingPolicy(personal)`: on a shared
runner the package default `subscriptionOnCloudRunner: "personal_runner_only"` (a subscription
is used only when the source opted in with `limits.personalRunner: true`); on a personal runner
(`FORERUNNER_RUNNER_PERSONAL=1`, one person's runner) `"always"`, which the owner invariant
still bounds. A probe that reports `planUsageShare` or `monthSpentUsdMicro` gets the package's
plan-share and monthly-limit rules too. Preference for `session` work: subscription, plan
credits, API key, fake; ties by priority, then id. Skip codes are the router's
(`other_human`, `disabled`, `purpose`, `tier`, `cloud_runner`, `unavailable`, `plan_share`,
`monthly_limit`); the choice is made once per runner start and `/health` shows it. On top of
the router the module refuses an agent another human owns (a `validation` error). With no
usable source and the fake provider the runner seeds a fake source, as the daemon does; with a
real provider it refuses to start. Every run and ledger row of a cloud session carries that
source.

A session's cap is `project.settings.session_cap_usd_micro`, else
`FORERUNNER_RUNNER_SESSION_CAP_USD_MICRO`; an email session's cap is the per-email cap and its
autonomy the email autonomy level, both from the email command settings (T.12). Grants are the
daemon's: the file tools and bridged extension tools, the worktrees directory, the GitHub host,
the GitHub token when the vault holds one.

### Kill switch from the shared state

`RemoteCommandWatcher` picks up `remote_command` rows with target `cloud` (addressed to this
runner's device or to nobody) atomically every `FORERUNNER_RUNNER_COMMAND_POLL_MS`:

| Command | Effect |
| --- | --- |
| `kill` (`params.scope` `"all"` or `{ agentId?, sessionId? }`, `reason?`) | `KillSwitch.stop(scope)`: runs aborted, processes killed, tokens revoked, claims released; new sessions refused until a `start` |
| `stop` | stops the agent's runs, then lifts the freeze |
| `start` (`agentId?`, `projectId?`, `budgetUsdMicro?`, `reason?`) | lifts the freeze and asks the scheduler (trigger `remote`, forced past the PC rule) |
| `pause` | refused: `failed` with a reason |

Each command gets a `done` / `failed` result the device can read back and an audit row
`runner.remote_command`. The local `kill.json` (ADR 0011) is watched at the same cadence.

**Only the runner's human commands it.** Before a command runs, the watcher loads the issuing
`device` row: a device that does not exist, belongs to another human or is revoked gets
`failed` with `forbidden: ...` and an audit row (`allowed: false`, the reason in
`denied_reason`), and nothing is stopped or started. A `start` whose `params.agentId` is not the
runner's agent is refused the same way, and `runSession` asserts the agent id again before any
session exists, so no path (remote, inbox, email, manual) can run another agent on this human's
vault and billing source (S.14). `pickUp` is called with the runner's device and its human
(`ownerHumanId`, ADR 0041), so in a shared state another human's `{ target: "cloud" }` command
without a target device is never taken by this runner: it stays pending for that human's own
runner.

### Email watch

`EmailWatch` composes the email module as `email.md` "Ports to wire" shows: `EmailSettingsStore`,
`StoreIdentityLookup`, `AuditSentLog`, `HumanRequestApprovalPort`, `EmailPolicy`,
`EmailCommandGate` with the configured verifier, `ModelCommandClassifier` on the runner's
provider (haiku rung), `EmailCommandHandler` with the runner's `StartCloudSessionPort`. The
mailbox is `ImapSmtpMailbox` from the agent's settings; its credentials are secret references
resolved from the runner's vault at call time (`SecretResolver`). `watch()` uses IMAP IDLE
push when the host offers it and polls every `FORERUNNER_RUNNER_MAIL_CHECK_MS` regardless.
With `FORERUNNER_RUNNER_MAIL_PUSH=false` the watcher does not call `watch()` at all: its own
`pollOnly` loop lists the unseen messages at the interval (a catch-up sweep first) and hands
each over once; the handler marks a handled message seen, and one it could not mark is
remembered while it stays unseen.

A task command: the handler creates the task and calls the port; the runner starts the
session (runner `cloud`, cap = per-email cap, autonomy = email level, the planner limited to
that task), resolves as soon as the session row exists so the acknowledgement goes out at once,
and sends the completion summary (threaded under the original mail, with the PR link and cost)
when the session ends. A busy agent fails the start at once; the handler tells the human the
task waits for the next session. Email watch is skipped (with the reason in `/health`) when
commands are off, no address is registered, no mailbox is configured or no provider exists.

### Health and readiness

A Hono app (`createHealthApp` in `health.ts`) served by `@hono/node-server` on the loopback
interface (spec: "a health route on 127.0.0.1 (Hono)"; `startHealthServer` refuses any other
host with `isLoopbackHost`, after the configuration already did). `GET
http://127.0.0.1:<port>/health` answers the `RunnerStatus` JSON: runner id, version, uptime,
redacted store URL, human, agent, device id, vault state (`locked`, `unlockedUntil`,
`cachedKey`, `pendingRequestId`), billing source, provider, last presence verdict, active
sessions, `killActive`, schedule count, sessions started, schedules skipped, email watch state,
remote command stats, inbox trigger counters (`inbox`, null when off), `ready`; 500 with the
error message when the status function fails. `GET /ready` is 200 once everything started,
503 before. Any other path is 404, any method but GET or HEAD 405; every answer is JSON with
`cache-control: no-store`. The readiness file holds runner id, pid, health URL, ready time and
version.

### Docker

The image is the repository's `services/cloud-runner/Dockerfile` (also the sandbox image;
`ci.yml` builds it, `release.yml` pushes it, see release.md). The entry point is `pnpm runner`
(`tsx services/cloud-runner/src/main.ts`); `/data` is `FORERUNNER_HOME`. The `HEALTHCHECK`
polls `/ready`. A compose example (values are placeholders, nothing here is a real host):

```yaml
services:
  runner:
    image: ghcr.io/<owner>/forerunner-runner:<version>
    restart: unless-stopped            # exit 75 = key forgotten, start afresh
    environment:
      FORERUNNER_STATE_URL: postgres://forerunner:${PG_PASSWORD}@db.example.internal:5432/forerunner?sslmode=require
      FORERUNNER_RUNNER_ID: runner-eu-1
      FORERUNNER_RUNNER_HUMAN: j@example.test
      FORERUNNER_RUNNER_PERSONAL: "1"
      FORERUNNER_RUNNER_MAIL_VERIFIER: mailauth
    volumes:
      - runner-data:/data               # /data/config/vault.runner.json: the blob, never the key
volumes:
  runner-data: {}
```

Put the encrypted blob at `/data/config/vault.runner.json` (export it from the desktop: the
same file format as the local file vault, ADR 0006) and start the container; the desktop or
phone shows the unlock request.

The health route binds the container's own loopback interface by design (a non-loopback
`FORERUNNER_RUNNER_HEALTH_HOST` is refused), so there is no `ports:` entry: a published port
would never reach it from the host. The image's `HEALTHCHECK` polls `/ready` from inside, and
an external poller does the same through the container's network namespace, for example
`docker exec <container> node -e "fetch('http://127.0.0.1:8787/ready').then(r => process.exit(r.ok ? 0 : 1))"`
or a sidecar on `network_mode: "service:runner"`.

## How to change it

- **A new setting**: add it to `RunnerConfigSchema` and `readRunnerConfig` in `config.ts`, the
  table above and `config.test.ts`. Defaults live in the schema's constants, never in `main.ts`.
- **The unlock protocol**: bump `UNLOCK_PROTOCOL_VERSION`, keep `answerUnlockChallenge` and
  the runner's verifier in step, extend `vault-unlock.test.ts` with the new refusal; never let
  plaintext key material into a log line, a row or an error (`redactKey`, the no-leak assertion).
- **The precedence rule**: `PcPresence.check()` is the single place; a new signal (a lease
  table, a state-service presence endpoint) goes there with a test in `presence-billing.test.ts`.
- **Inbox triggers**: what counts is `InboxTrigger.check()` in `inbox-trigger.ts` (the plan
  request's shape and answer words come from `@forerunner/runtime`'s `plan-approval.ts`:
  `isPlanRequest`, `approvedPlanIdOf`, `planAnswer`, so the daemon and the runner agree), and nothing
  else starts a `message` session on the runner; a new source (CI results, PR comments) is a
  new filter there with a case in `inbox-trigger.test.ts`.
- **Billing**: a provider rule change is a change to `DEFAULT_ROUTING_POLICY` in the billing
  package (billing.md), which this service picks up unchanged; what "personal runner" means
  for the policy is `runnerRoutingPolicy` in `billing.ts`, and a deployment that wants another
  rule passes `policy` to `pickRunnerBillingSource`. A new source kind or skip code arrives
  through the package types. Keep `presence-billing.test.ts` asserting that the router is the
  one deciding.
- **The health route**: routes are added to `createHealthApp`; keep every answer JSON, keep
  the method guard and never put a credential or the store URL unredacted into the status.
- **A new remote command**: add it to `RemoteCommandWatcher.run` and `remote.test.ts`; the
  state service's `REMOTE_COMMANDS` names what the phone may send. `authorize` runs before
  every command and stays the one place that binds a command to the runner's human.
- **Email**: wiring changes belong in `EmailWatch`'s constructor; behaviour changes in the
  email module (`email.md`).

## Tests

Unit (`pnpm vitest run --project unit services/cloud-runner`, fake provider, in-memory or
file-backed SQLite, testenv mail server on 127.0.0.1, SimulatedClock):

| File | Covers |
| --- | --- |
| `config.test.ts` | defaults, required URL, every issue listed, overrides, lists and booleans, header verifier needs authserv-ids, inbox poll off with 0 and never under 1 s, no credential in the description (a password with a literal `@` included), a non-loopback health host listed with the other issues |
| `health.test.ts` | the Hono app in process (`/health`, `/ready` 503 then 200, 404, query strings, `cache-control: no-store`, HEAD allowed, other methods 405, a failing status function answered 500 with the message and none of its data) and over a loopback socket on a free port; `localhost` accepted, a non-loopback host refused before binding; close releases the port |
| `inbox-trigger.test.ts` | a peer's message triggers once (own notes, read and pre-start messages never; two projects give no project); waiting while a session runs; an answered session question, an approved plan carrying its `plan_id` as `planApproved`, a plan card without the id starting a plain session; a rejected plan, the unlock challenge and another agent's question ignored; two approved plans in one check (the newest binds); a PC online defers with a back-off; a start the scheduler skipped leaves the items for the next check; polling on the clock |
| `vault-unlock.test.ts` | challenge and answer against the real file vault; wrong key, tampered answer, stale challenge, expiry (withdrawn), deny; the key absent from every log line, audit row and request row; the window: cached re-unlock, forgetting at the end, shortened / cleared window, policy ask, window set by the answer, absurd window refused |
| `presence-billing.test.ts` | desktop seen / stale / revoked / other human / runner kind; active pc session; billing: shared vs personal runner, `personalRunner` opt-in, missing credential and disabled source skipped, other human's agent refused; the router decides (`BillingRouter.pick` called once with `runner: "cloud", purpose: "session"`, a `never` policy skips the subscription on a personal runner, `runnerRoutingPolicy` per runner kind, the plan-share rule falls back to the API key at the cap) |
| `remote.test.ts` | kill within one poll (runs aborted, freeze, result and audit rows), stop lifts the freeze, start resumes and asks the scheduler, pause refused, pc-targeted and other-runner commands untouched; another human's phone (start of its agent, kill) and a start naming another agent refused with `forbidden: ...`, the runner's run untouched |
| `email-watch.test.ts` | a valid command acknowledged within 60 s of simulated time (one simulated second per 50 ms of wall time) and a capped session started; a spoofed command ignored with no session, no reply and an audit row; completion threaded under the command; polling when the host has no push; `push: false` polling only although the host pushes (delivery at the interval, never twice); commands off |
| `identity.test.ts` | ADR 0082 on a file-backed SQLite store holding two humans: a runner naming none refused `identity_ambiguous` and one naming an unknown email `not_found`, nothing created either way; `FORERUNNER_RUNNER_HUMAN` as an email (case does not matter) serving that human and their own principal, the composed runtime bound to the same rows (`rt.identity`), the status naming them |
| `runner.test.ts` | the composed runner on a file-backed SQLite store: health route and readiness file, device row, billing source, schedules; a schedule left to a heartbeating PC and taken over once it is gone (session `runner: "cloud"`, task done, ledger rows under the runner's source); `startSession` answering `deferred` for a firing the PC rule skipped and `started` when forced; a peer's handoff starting a message-triggered cloud session that reads it and does the ready task, with no second session for the same handoff; an emailed task acknowledged within a minute, run as a capped cloud session (tier 1 tasks end `in_review`) with the completion mail |

Integration (`FORERUNNER_TEST_PG`, `pnpm vitest run --project integration services/cloud-runner`,
skipped visibly without it): `runner.integration.test.ts` unlocks the real blob through a
challenge the "device" answers in the shared Postgres, advances eight simulated hours with no
desktop device registered, and asserts the 02:00 schedule ran one cloud session that completed
two tasks on the fake provider, with every run and ledger row on the human's API-key source
(the subscription skipped on a shared runner) and the key absent from the shared state; then a
kill enqueued from a paired phone stops a running session within 2 s of simulated and wall
time and the task's claim is released.

The gate evidence for phase 6 ("overnight session while both PCs are off", "emailed task
acknowledged within 1 minute and completed in the cloud; a spoofed email ignored") is these
two files plus `email-watch.test.ts`, on the fake provider and the testenv mail server; the run
on a real host and a real mailbox is pending the items in `docs/status/BLOCKERS.md`.

## Known issues

- A `{ target: "cloud" }` command from a human who has no cloud runner stays `pending` for
  ever (no runner owns it); the phone shows it as pending until the human cancels it. Refusing
  it at enqueue needs the state service to know which humans run a cloud runner (ADR 0041).
- The PC daemon does not yet heartbeat a `desktop` device row; until it does, an active
  `session` with `runner: "pc"` is what keeps a working PC ahead of the runner, and a PC that
  is idle between sessions looks offline. The state service stamps `last_seen` for devices
  that talk to it (phones, web), not for the daemon.
- Locking the vault cannot take the model credential back from the composed provider; the
  runner restarts (exit 75) to forget the key. The GitHub token read at compose time has the
  same lifetime.
- Resolved 2026-10-23 (ADR 0082): `composeRuntime` no longer picks the first human; the
  runner passes `identity.humanId` and the composed runtime, its caps, approvals and
  `/health` are the served human's. A runner on a store with several humans must name one
  (`FORERUNNER_RUNNER_HUMAN`) or it refuses to start.
- An email session whose agent is busy fails at once (the human is told the task waits for the
  next session) instead of queueing behind the running session.
- Two runners for the same agent would both pass the handler's audit-row check for a brand-new
  message (email.md "Known issues"); run one runner per agent mailbox.
- The unlock card (ADR 0068) needs the runner's vault key on the answering device already:
  `cloud_runner_vault_key:<runner>` in the desktop's vault, `runner-vault-key-<runner>` in
  the phone's secure store. There is no import screen yet (the stand-in is `pnpm fr` / a
  script on the human's machine); a device without the key shows the card read-only. One
  unlock against a real runner host has not been run (BLOCKERS S.12).
