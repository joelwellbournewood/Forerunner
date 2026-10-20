# 0033 — Cloud runner: the vault unlock protocol and the PC-wins precedence rule

Date: 2026-10-20
Status: accepted

## Context

The spec's "Secrets vault" table gives the cloud runner an encrypted blob whose key is held by
the human's device: "Human approves unlock per runner start, or sets an auto-unlock window".
ADR 0006 built the blob (`EncryptedFileVault`, key not on the runner) and ADR 0026 said the
runner "unlocks its vault blob with the key the human's device releases", but neither said how
the key travels through the shared state without ever being stored there, what "per runner
start" and "auto-unlock window" mean in code, or what a runner does when it forgets the key.

The hybrid run mode ("PC when on, cloud runner when off") needs a rule for who runs the agent's
schedules when both the PC daemon and the runner can see the same shared Postgres. The spec
leaves open how the runner knows that a PC is on, and whether email tasks and remote commands
follow the same rule. `@forerunner/billing` was not a dependency of the runner service when this was written (it is now, and the runner uses `BillingRouter.pick`), and
the daemon's `composeRuntime` starts its own scheduler, kill-file watcher and connectors, so the
runner also had to decide how much of the daemon's composition it reuses.

## Decision

### Unlock protocol (`services/cloud-runner/src/vault-unlock.ts`)

1. **The key is wrapped to a one-time runner key.** On every unlock the runner generates an
   X25519 key pair, a 32-byte nonce and a challenge id, and files a `human_request` of kind
   `credential`, `risk: "high"`, `blocking: true`, whose `change_card` is the challenge
   (`kind: "runner_vault_unlock"`, version 1, runner id, challenge id, runner public key,
   nonce, `expiresAt` ten minutes ahead by default). High risk means the phone requires the
   biometric confirmation ADR 0009 gives high-risk answers.
2. **The device answers with ciphertext only.** `answerUnlockChallenge(card, vaultKey)` (the
   same module; the desktop app and the phone call it) derives
   `HKDF-SHA256(X25519(devicePriv, runnerPub), salt = nonce, info = "forerunner-runner-unlock:v1:<challengeId>")`
   and encrypts the 32-byte vault key with AES-256-GCM, AAD `"<runnerId>:<challengeId>"`. The
   answer carries the device's ephemeral public key, iv, ciphertext and tag, optionally an
   `autoUnlockUntil`. Both key pairs are discarded after one use.
3. **Refusals are explicit and audited.** A wrong key (the vault's check value fails), a
   tampered answer (AEAD), an answer to another challenge (`stale_challenge`), an answer after
   `expiresAt`, a malformed answer and a plain `deny` are each an `audit_log` row
   (`runner.unlock_refused` with the reason). Every refusal except `deny` files a fresh
   challenge; after three refusals, or the unlock timeout (24 h by default), the start fails.
   An expired challenge is withdrawn by the runner.
4. **The key never leaves process memory.** Only public keys, nonces and ciphertext reach the
   store; the plaintext lives in a `Buffer` that is zeroed after the vault took it;
   `redactKey` scrubs every encoding of it out of error text as a last line of defence. Tests
   capture every log line, audit row and request row and assert the key's base64, base64url,
   hex and byte-list forms are absent.
5. **Per runner start, or a window.** Without a window an approval lasts for the process
   lifetime and no copy of the key is kept. The auto-unlock window is
   `human.notify_prefs.cloud_runner.auto_unlock_until` (ISO-8601, settable by the device's
   answer, capped at seven days). While it is open the runner keeps a copy of the key and
   re-unlocks from it after an idle lock (`FORERUNNER_RUNNER_IDLE_LOCK_MS`) without asking; at
   the window's end (checked every `FORERUNNER_RUNNER_UNLOCK_TICK_MS`), or when the human
   shortens or clears it, the copy is zeroed, the vault is locked and the next need asks again.
   `FORERUNNER_RUNNER_UNLOCK=ask` ignores windows. The device-side rule is the mirror image:
   `shouldAutoAnswer(notifyPrefs, now)` lets the desktop or phone answer without prompting
   while the window is open.
6. **Forgetting means restarting.** The runtime hands credentials to the model provider at
   compose time, so locking the vault cannot take a key back from a running process. When the
   window ends the runner locks the vault, waits for the running session to finish and ends the
   process with exit code 75 (`RELOCK_EXIT_CODE`); the supervisor (`--restart unless-stopped`)
   starts a fresh process that must be unlocked again. Idle lock without a window end only
   locks the vault.

### Precedence: a PC daemon that is online wins (`src/presence.ts`)

7. The runner starts a scheduled, inbox-triggered (trigger `message`: a peer's unread message
   or the human's answer to a question a session asked) or unforced manual session only when
   no PC of the human is online. A PC is online when either (a) a non-revoked `device` row of
   the human with kind `desktop` has `last_seen` within `FORERUNNER_RUNNER_PC_ONLINE_MS` (three
   minutes), or (b) an active `session` row of the agent has runner `pc`. A schedule that fires
   while a PC is online is dropped for that firing (logged, counted in `/health`), never
   queued: the PC's own scheduler fired the same schedule. An inbox item is not dropped: no PC
   daemon watches the inbox between sessions, so the runner leaves it untouched and looks
   again after `FORERUNNER_RUNNER_PC_ONLINE_MS`; a PC session that read it in the meantime ends
   the matter. Each item triggers at most once, and nothing is checked while a session of the
   agent runs (it reads the inbox itself).
8. Email-triggered sessions and remote commands with target `cloud` always run on the runner:
   the runner is the one mailbox watcher (email.md: one watcher per mailbox) and the phone
   addressed it explicitly. The shared store's one-active-session-per-agent check still stops
   any overlap in either direction. The rule is checked twice for an inbox item (by the trigger
   before it asks and by the scheduler's start); a PC that appears in between makes the start
   report `skipped`, which the trigger treats as a deferral, so the item is never lost.
8b. **A remote command binds to the runner's human.** `remote_command.pickUp` is keyed on the
   target (and an optional target device), not on the issuer's owner, so on a shared state
   another human's device can enqueue `{ target: "cloud" }` and this runner takes the row.
   Before acting, `RemoteCommandWatcher.authorize` loads the issuing `device` and refuses
   (`failed`, `forbidden: ...`, audit row) one that is unknown, revoked or owned by another
   human; a `start` naming another agent is refused too, and `runSession` asserts the agent id
   once more. Everything a command reaches (the unlocked vault, the billing source) is this
   human's, so this is spec S.14 ("a subscription token ... is used only by its owner's agent")
   applied to the control path.
9. The runner registers itself as a `device` of kind `runner` named after `FORERUNNER_RUNNER_ID`
   and heartbeats `last_seen`; the PC daemon is expected to heartbeat its `desktop` row the same
   way (until it does, signal (b) is what keeps a working PC ahead of the runner).

### Composition (`src/runner.ts`)

10. The runner calls `composeRuntime` with `startServices: false` (no daemon scheduler, kill-file
    watcher or connector start) and the runner's vault, then builds its own `SessionRunner`
    (runner `cloud`, the runner's device id, a planner that limits an email session to its own
    task) over the daemon's executor stack with the billing source it chose, its own
    `Scheduler` fed from `project.settings.schedules`, an `InboxTrigger` (unread peer messages
    and answered session requests, polled every `FORERUNNER_RUNNER_INBOX_POLL_MS`; an approved
    plan request starts the session with `planApproved`), a `RemoteCommandWatcher` on
    `remote_command` rows with target `cloud` (kill within one 500 ms poll), the local
    kill-file watcher, the `EmailWatch` and a `node:http` health route on the loopback
    interface. Billing mirrors `BillingRouter`'s cloud rule in the service (the package is not
    a dependency): subscriptions only on a personal runner (`FORERUNNER_RUNNER_PERSONAL=1`) or
    when the source opted in with `limits.personalRunner`, never another human's source.
11. Schedules live in `project.settings.schedules` (`kind` daily / weekdays / every, `time`,
    `everyMinutes`, `timezone`, `enabled`, optional `agentId`), refreshed every tick; the
    daemon is expected to read the same key when it grows project schedules.

## Consequences

- The shared state can be read by every device and the state service without exposing the
  vault key; a captured answer is useless after its challenge (one-time key pair, AAD binds it
  to one runner and one challenge).
- A runner whose human never answers never runs: it keeps one open request, withdraws expired
  ones and exits after the timeout. Nothing in the runner can be configured to skip the unlock.
- The window is a human setting on the shared `human` row, so the phone and the desktop can
  show and change it; the runner only reads it (and writes it on the device's behalf when the
  answer carries one).
- Process restart as the way to forget the key is coarse but honest: the only place the key can
  live is process memory.
- The precedence rule depends on heartbeats; a PC whose daemon crashed without a heartbeat
  looks offline after three minutes and the runner takes over, which is the intended failover.
- Refusing in the runner stops the damage but not the misrouting: another human's command
  without a target device ends `failed` on this runner instead of reaching theirs. The proper
  fix is an owner filter in `RemoteCommandRepo.pickUp` (join `device.owner_human_id`, or a
  `human_id` column on `remote_command`), in `packages/state`; until it exists a device should
  set `targetDeviceId` to its own runner's device row.

## Alternatives considered

- **Sealing the key to the runner's long-term key** (a runner key pair persisted on disk): one
  leaked runner directory would then unwrap every past answer; the one-time pair costs nothing.
- **The human types the key or a passphrase into the runner's console**: there is no console on
  a headless runner, and it would move the secret through terminals and shell histories.
- **Deferring a schedule while the PC is online** (the scheduler's quiet-hours mechanism): the
  deferred firing would start a second session for the same schedule when the PC goes offline.
- **Routing every cloud session through the runtime's own scheduler and billing**: the daemon's
  composition hard-codes runner `pc` and the first billing source; a small session layer in
  the runner was less invasive than widening `ComposeOptions` while other modules are being
  wired into it.
- **A lease table for runners**: the `device` row with `last_seen` already is one, shared with
  the state service's heartbeat semantics (ADR 0009).
- **Trusting the state service to keep other humans' commands away**: it checks ownership only
  when a target device is named, and the runner reads Postgres directly (ADR 0024); the runner
  cannot assume every row in its queue went through that check.
- **Inbox triggers through the state service's realtime channel**: the runner talks to Postgres
  directly (ADR 0024); a 30 s poll of two indexed queries is well inside the latency a session
  start needs and adds no connection to keep alive.
