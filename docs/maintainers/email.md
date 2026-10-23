# Agent email

> Status: implemented in `packages/capabilities/src/email/` (phase 6). The orchestrator wires
> the ports listed under "Ports to wire" and mounts the routes (ADR 0066); the cloud runner's
> mail watcher calls `Mailbox.watch` and `EmailCommandHandler.handle`; the Settings ->
> Capabilities -> Email page is `apps/ui/src/pages/EmailSettingsPage.tsx` (apps.md).

## Purpose

Spec: "Security, permissions and email" -> "Agent email" (five modes, the limits that stay on)
and "Email commands: tasks by email, run in the cloud"; module L "Email"; "Rules that apply
everywhere". Each agent gets its own mailbox, never the human's. The human picks a sending mode
per agent; a separate toggle lets the human email the agent tasks that run in the cloud. Every
limit is a check in code that throws or returns a non-sent outcome before anything leaves the
mailbox; prompt text never decides. Everything inbound is data.

## The modes (S.15-S.20, S.29)

| Mode | Reads | Sends | `EmailPolicy.checkSend` decision |
| --- | --- | --- | --- |
| `off` | nothing (`email_list`/`email_read` refuse) | nothing | `tool_not_allowed`, even to the human |
| `read_only` | own mailbox | nothing | `tool_not_allowed`, except replies to the registered human |
| `draft_only` | own mailbox | drafts the human sends | draft saved in the mailbox + HumanRequest "Send this email?"; sent only on yes |
| `allowlist` | own mailbox | freely to listed addresses and domains (`*.corp.test` covers subdomains) | new recipient -> HumanRequest; added to the allowlist and sent on yes, refused and logged on no |
| `full_discretion` | own mailbox | anyone | `send`, inside the limits below |

Replies to the registered human (every recipient is the human's address or
`commands.registeredHumanAddress`) are allowed in every mode except `off`, do not count against
the caps and skip the allowlist; they are still checked for credentials and secret references.
The default mode is `off`; the setup screen should say plainly that `full_discretion` lets the
agent email strangers.

### Commands need a sending mode other than off (T.1, ADR 0081)

At `off` the mailbox sends nothing, not even the acknowledgement of a command, so email
commands cannot be on at `off`. The rule lives in `EmailSettingsStore.update` (`types.ts`),
which every writer goes through: the daemon's `PUT` (and so the settings page), the runner,
and the command registry's `email.mode.set` (chat, voice, the phone, the agent's
`email_mode_set` tool), which the daemon wires to this store through `ports.emailMode`
(commands.md; a hand-built executor without the port applies the same rule and audit row
itself, without the notification):

- Turning commands on at `off` (the merged result is mode `off` with commands on, the patch
  sets `commands.enabled: true` and commands were not in force) throws
  `ForerunnerError("validation", COMMANDS_NEED_SENDING_MODE)` with `details.reason:
  "commands_need_sending_mode"`; nothing is written and the daemon answers 400 with that plain
  sentence, which the page shows.
- Switching the mode to `off` with commands on (including a form that still sends
  `commands.enabled: true`) turns commands off in the same write, keeps the other command
  settings, writes one `email.settings` audit row (`input_summary` `{ action:
  "commands_switched_off", reason: "mode_off", modeBefore, modeAfter: "off" }`, `result_summary`
  `{ status: "commands_off", reason: "mode_off" }`) when the store has an `audit` dep, and calls
  the `onCommandsSwitchedOff(listener)` listeners with an `EmailCommandsSwitchedOff` event
  (agent, human, mode before, time, one sentence for the owner). The daemon binds a listener
  that sends the owner an `email_commands_off` notification (`compose.ts`, notifications.md).
  A failing audit store or listener is a `warn` line and never undoes the write.
- `emailCommandsActive(config)` (toggle on and mode not `off`) is what the gate and the
  runner's watcher read, so a row stored before the rule (commands on at `off`) obeys nothing;
  the next write over it turns commands off as above.

So "replies to the owner are always allowed" holds in every mode where commands can be on;
`checkSend` keeps refusing everything at `off`.

## The limits that stay on (S.21-S.28)

All enforced in `policy.ts`, in this order, for every send (including approved drafts):

1. Recipients valid, subject present (`validation`).
2. Mode gate (`tool_not_allowed`).
3. Blocked content by rules (`detectBlockedContent`), then the optional model classifier
   (`ModelContentClassifier` through a `ModelProvider`; it adds judgement, not authority: an
   unparsable reply counts as "not blocked" and is logged). Classes: `credentials` (password/key
   patterns and anything `redact()` would hide), `secret_reference` (`secret:<name>`),
   `private_memory` (`[[private memory]]`, `<private>`, `agent_private`),
   `third_party_personal_data` (email addresses other than the recipients, the human and the
   agent; phone numbers; IBANs), `financial_commitment`, `legal_agreement`. A hit throws
   `tool_not_allowed` with `details.classes` and redacted excerpts; nothing is sent.
4. Paid sign-ups and terms acceptance (`PAID_SIGNUP`, `TERMS_ACCEPTANCE` rules) need a human:
   HumanRequest kind `paid_signup` / `terms_acceptance`, sent only on yes (S.24).
5. Paused (`settings.paused`, the tray's one-click pause): the send is held, not sent, and
   recorded as an `email.queued` audit row (S.28); the outcome is `status: "queued"`. Those
   rows are a record for the owner, not a retry queue: nothing is sent automatically after
   `POST .../resume` (the stored copy is redacted, so it could not be resent as written). The
   `email_send` tool tells the model so, and the caller sends again after the resume.
6. Daily send cap (default 20) and per-recipient daily cap (default 5) counted from the sent
   log for the current local day in the human's IANA time zone (`localDayKey`);
   `budget_exceeded` (S.22). The count and the send it allows are one step: `EmailPolicy.send`
   and `resolveApproval` run under a per-agent lock (`KeyedLock`), so concurrent sessions, the
   acknowledgement path and a tool call cannot all read "one below the cap" and all send.
7. Mode-specific approvals (table above).
8. Signature appended when on (default on; text `{agent} is an AI agent acting for {human}.
   ...`, placeholders filled from the identity) (S.27); sent; logged with the full copy
   (`email.send` audit row, `email_sent` session event) (S.26). `dailyDigest` sends the day's
   list to the human (`EmailPolicy.sendDailyDigest`, call it from a schedule).

A draft approved by the human goes through `checkSend` again with `ctx.approved`: the caps and
blocked-content rules still apply; an approval ticket can send at most once (replays are
refused with "approval already used").

## Email commands (T.1-T.14)

### The gate: who it obeys (`EmailCommandGate.evaluate`, T.3, T.4)

A message is a command only when all of these hold, checked in code in this order:

1. Commands are in force (`emailCommandsActive`: `commands.enabled` and the sending mode is not
   `off`, ADR 0081; `disabled` otherwise) and a `registeredHumanAddress` is set.
2. The From header names exactly one address and it is the registered address.
3. The `AuthVerifier` says DKIM passes for a domain aligned (relaxed DMARC alignment) with the
   From domain, and SPF passes.
4. The message's own Date header is no older than `maxCommandAgeMs` (7 days; `stale`
   otherwise): DKIM signatures carry no expiry, so a captured command replayed later from a
   host inside the owner domain's SPF is not obeyed again, whatever the dedupe window.
5. The subject carries the agent's private marker (`[FR-xxxx]`, `hasCommandMarker`) or the
   message's direct parent (`In-Reply-To`, else the last `References` entry) is a mail the
   agent sent to the registered human alone (a sent-log row with `toHuman`;
   `EmailCommandGate.threadParent`). An id further up the chain, or a mail the agent sent to
   a third party, is no thread: a stranger who received the agent's mail knows its Message-ID
   and could seed it into the References of a mail to the owner, whose reply to the stranger
   would otherwise pass here as a command.

Anything else is data: the handler writes an `email.command` audit row with `allowed = false`
and `denied_reason = "ignored: <reason>"` (`disabled`, `no_registered_address`,
`wrong_sender`, `dkim_fail`, `not_aligned`, `spf_fail`, `stale`, `no_marker`), sends nothing,
calls no model. Forwarded mail (From is the forwarder) fails rule 2; a stranger's mail the owner forwards
passes the gate but only the owner's own words survive `stripQuotedText` (quoted lines,
"On ... wrote:" and translations, "Original Message", "Forwarded message", Outlook header
blocks, everything after a hard cut). An email that is only quoted text yields the `empty`
outcome. Each agent reads its own settings row, so each obeys only its own human. Rotating the
marker (`EmailSettingsStore.rotateMarker`, `POST .../rotate-marker`) invalidates the old one at
once.

The verification chain (ADR 0013): the receiving host's `Authentication-Results` header is
believed only when its authserv-id is in `trustedAuthservIds` (`AuthResultsHeaderVerifier`),
and a claimed `dkim=pass` counts only when the message also carries a `DKIM-Signature` header
(a forged header on an unsigned message is refused even when it names the trusted id); hosts
that do not stamp results, or are not known to strip foreign `Authentication-Results` headers,
get `MailauthVerifier`, which re-verifies DKIM and SPF with `mailauth` (DNS);
`StaticAuthVerifier` is for tests of the gate's branches. The testenv server writes the same
header shape as Gmail and domain hosts, so the same verifier runs in tests.

### What it does (`EmailCommandHandler.handle`, T.5-T.10)

Order: gate -> flag injection (`email.inbound_flagged` audit row, warning log, never acted on)
-> ignored? -> paused? -> approval reply? -> empty? -> the owner's own words instruction-like?
(`flagged`: the passages are quoted back, nothing runs) -> classify with the model provider
(`ModelCommandClassifier`, strict JSON `{kind, project, title, summary, answer}`, the email
wrapped as untrusted data and the subject with the marker replaced by `[command marker]`;
unparsable -> `unclear` reply) -> act:

- `question`: answered by reply (T.6).
- `task`: project from the text (`pickProject`: exact or unique partial name, or the only
  active project) else a reply asking which (`task_needs_project`; the owner's threaded answer
  is a new command); daily email-task cap (`task_capped`, T.12); estimate
  (`estimateUsdMicro(taskEstimate(text), estimateModel)`) against the per-email cap
  (`effectivePerEmailCapUsdMicro`: CHF 5 at the day's rate, or an explicit USD cap) ->
  `task_over_cap` reply, no session; else a `task` row (`ready`, budget = cap, estimate,
  owner agent, `risk_tier` from the runtime's `defaultRiskTier(project)`: 0 in small-project
  mode, else 1, spec B.6 and ADR 0051, so an emailed task is reviewed like one created in the
  app) and `StartCloudSessionPort.start({ capUsdMicro, autonomyLevel, trigger: "email" })`
  (T.7). The acknowledgement reply carries what was understood, the project, the estimate and
  cap in CHF, when it starts, the autonomy level and the session log link; `ackLatencyMs`
  (clock now minus `receivedAt`) is recorded in the audit row, and the tests assert it is under
  60 s with the simulated clock (T.10).
- `note`: `queue_item` of kind `note` for the next session, acknowledged (T.8).
- Attachments: written under `projectDataDir(projectId, agentId)/inbox/<message id>/` with
  `safeSegment` names (`../../../etc/passwd` becomes `etc-passwd`), never opened here; the ack
  and the task say "open only in the sandbox" (T.9, S.25).

`onSessionCompleted({ sessionId, summary, prUrls, files, logUrl, costUsdMicro })` is the
completion hook the runner calls: a short summary with links, threaded under the original email
(T.10). `commandAudit(agentId)` returns the email, its interpretation and the result together,
newest first (T.14; `GET .../commands`).

### Handled once (idempotency)

A command costs money, so a message is acted on exactly once however often it is delivered
(runner restart, catch-up poll on `watch`, a second watcher, two concurrent deliveries):

- `handle` runs under a per-agent lock (`KeyedLock`): one command at a time per agent, which
  also makes the daily task cap check-and-start one step.
- Before acting it reads the `email.command` audit rows of the last 90 days
  (`dedupeWindowMs`, the gate's thread window: never shorter than the window in which a
  signed message is still accepted); a row with the same Message-ID (or, for a message without one, the same
  mailbox id stored as `mailboxId`) ends it with the `duplicate` outcome: no model call, no
  task, no session, no reply, no new audit row.
- When handling ends, success or failure, the message is marked seen through `mailboxFor`
  (`Mailbox.markSeen`), so `listUnseen`, the IDLE push and the poll never list it again. A
  failure to mark seen is logged; the audit row still stops a repeat.
- A failure inside handling (store, provider, mailbox) is recorded as an `email.command` row
  with `outcome: "error"` and `allowed = false` under the Message-ID and rethrown: the message
  gets one attempt, not one per poll, and the owner sees it in the command audit.

Subject lines, like bodies and excerpts, pass through `redact()` before they reach an audit
row or a session event.

### Approvals by reply (T.11)

`requestCommandApproval(agentId, { actionClass, why, ... })` decides with
`decideAutonomy(actionClass, { level: commands.autonomyLevel })`: `allow` returns at once;
otherwise a HumanRequest of kind `command_action` is created through the approval port and
`notifyApproval` emails the human ("Reply with yes or no as the first word"). The reply is a
thread reply, so it passes the full gate (sender, DKIM, SPF, thread); `handleApprovalReply`
parses the first words (`parseYesNo`), answers the ticket (`onApprovalAnswered` hook for the
runtime's own requests; `EmailPolicy.resolveApproval` for `send_email`, `new_recipient`,
`paid_signup`, `terms_acceptance`), and confirms by reply. A spoofed, forwarded or third-party
"yes" is ignored and the ticket stays open.

## How it works: files

| File | What |
| --- | --- |
| `types.ts` | zod schemas and defaults (`EmailSettingsSchema`, `EmailCommandSettingsSchema`, `MailboxConfigSchema` with secret references only), `EmailSettingsStore` (with the ADR 0081 rule: `COMMANDS_NEED_SENDING_MODE`, `onCommandsSwitchedOff`, the optional `audit` dep), `emailCommandsActive`, the port interfaces, `EmailDraft`, `SendOutcome` |
| `policy.ts` | `EmailPolicy` (`checkSend`, `send`, `resolveApproval`, `dailyDigest`, `sendDailyDigest`), `detectBlockedContent`, `recipientAllowlisted`, `applySignature`, `ModelContentClassifier` |
| `sent-log.ts` | `SentLog` over `audit_log` (`AuditSentLog`; `MemorySentLog` for tests), tool names `email.send`, `email.draft`, `email.queued`, `email.command`, `email.inbound_flagged`, `email.settings` |
| `inbound.ts` | `parseInboundEmail` (mailparser, `wrapUntrusted`, links and attachments as references), `saveAttachments`, `parseAuthResultsHeader`, `stripQuotedText`, `hasCommandMarker`, `isReplyToThread` |
| `auth.ts` | `AuthVerifier` port and the three verifiers |
| `mailbox.ts` | `Mailbox` interface, `ImapSmtpMailbox` (imapflow + nodemailer, IDLE push with a polling fallback, credentials resolved per call through `MailboxSecrets`, library errors scrubbed), `defaultSmtpFactory` (implicit TLS when `secure`, else `requireTLS`: STARTTLS mandatory, never `ignoreTLS`), `loopbackSmtpFactory` (plaintext, 127.0.0.1/::1/localhost only, refuses any other host; the `TestMailbox` default), `TestMailbox` over the testenv server, `pollLoop`, `buildOutboundRaw` |
| `locks.ts` | `KeyedLock`: in-process serialization per agent for the cap checks and command handling |
| `commands.ts` | `EmailCommandGate`, `EmailCommandHandler` (`handle` once per message, `duplicate`, `error` row), `emailCommandAudit` / `emailCommandRows` (the command audit for the UI as a reader over the audit log alone, `EmailCommandAuditRow`; the handler's `commandAudit` delegates to it, the daemon serves it without a handler), `ModelCommandClassifier`, `parseYesNo`, `pickProject`, `effectivePerEmailCapUsdMicro`, `defaultTaskEstimate` |
| `tools.ts` | `emailTools`/`registerEmailTools`: `email_send` (`external_send`, high; routes through `EmailPolicy`), `email_list` and `email_read` (`read`, low; `untrusted` output, references only, the owner's command marker replaced by `[command marker]` through `hideCommandMarker`), `email_draft` (`routine_reversible`, low) |
| `routes.ts` | `createEmailRoutes(deps, app)` / `emailRouteTable(deps)`; with `humanFor` and `identity` set, every route under `/agents/:agentId` refuses (403, `tool_not_allowed`, `details.reason: "not_owner"`) a signed-in human who is not the agent's owner; a mount with `humanFor` and no `identity` fails closed (403, `reason: "identity_port_missing"`, one error log line at construction); every refusal is an `email.settings` audit row with `allowed = false`, the reason as `denied_reason` (`EmailOwnerRefusal`) and `result_summary` `{ status: "refused", reason }`, and stands (403, one `warn` line) when that row cannot be written (ADR 0084); the daemon mounts the table with both (`packages/runtime/src/daemon/server.ts`, ADR 0066); the seven routes are in `DAEMON_ROUTES` and their views in `api-types.ts` |
| `ports.ts` | production adapters (`StoreIdentityLookup`, `HumanRequestApprovalPort`, `StoreEventSink`) and fakes (`StaticIdentity`, `FakeApprovalPort`, `FixedRate`, `MemoryEventSink`, `FakeCloudSessions`) |
| `money.ts` | micro-unit helpers mirroring `@forerunner/billing` (`chfToUsdMicro`, `formatUsdMicroAsChf`, `localDayKey`) |

## Settings storage and the sent log (ADR 0013)

- Settings: one `extension` row per agent, `kind = "capability"`, `name = "email:<agentId>"`,
  `config = { settings, commands }` (validated by `AgentEmailConfigSchema` on read and write;
  rows from older versions fall back field by field). `enabled` mirrors "mode is not off or
  commands are on"; `permissions` lists `email:<mode>`, `email-commands`, `paused` for the
  Extensions panel. Mailbox credentials are `secret:<name>` references; the schema refuses a
  value, and a name that says API key, token, PAT, client secret or private key
  (`INSTALL_CREDENTIAL_NAME_PATTERN`): the row also names the host the password is sent to, so
  a mailbox password is a secret created for the mailbox, never one of the install's own
  credentials. The row is created with defaults on first read so the marker is stable from
  the start.
- Sent log: `audit_log` rows with `tool = "email.send"` and `allowed = true`; `input_summary`
  is the redacted full copy as JSON (`kind`, `messageId`, `to`, `cc`, `subject`, `text`,
  `inReplyTo`, `references`, `mode`, `signature`, `toHuman`, `projectId`, `taskId`,
  `approvalRequestId`). Blocked and refused sends are `email.send` rows with `allowed = false`.
  Caps, thread detection and approval-by-reply all read this log (`AuditSentLog.recent`,
  `threadIds`, `byMessageId`, 48 h / 90 d windows).

## Ports to wire (orchestrator)

```ts
const settings = new EmailSettingsStore(store.extension, clock);
const identity = new StoreIdentityLookup(store.agent, store.human);
const sentLog = new AuditSentLog(store.auditLog, clock);
const approvals = new HumanRequestApprovalPort(store.humanRequest);
const mailboxFor = async (agentId) => new ImapSmtpMailbox({
  config: (await settings.get(agentId)).settings.mailbox!, secrets: new SecretResolver(vault),
  granted: grantedSecretNamesFor(agentId), clock,
});
const policy = new EmailPolicy({ settings, identity, sentLog, approvals, mailboxFor, clock,
  events: new StoreEventSink(store.event), classifier: new ModelContentClassifier(provider, cheapModel) });
const gate = new EmailCommandGate({ settings, sentLog, clock,
  verifier: new AuthResultsHeaderVerifier({ trustedAuthservIds: ["mx.google.com"] }) /* or await MailauthVerifier.create() */ });
const handler = new EmailCommandHandler({ gate, settings, identity, policy, approvals, clock,
  classifier: new ModelCommandClassifier(provider, cheapModel),
  store: { task: store.task, queue: store.queue, project: store.project, auditLog: store.auditLog },
  cloud: cloudRunnerPort, estimateUsdMicro: (est, model) => estimateUsdMicro(est, model, pricing),
  estimateModel: workingModel, rates: { chfPerUsd: (d) => rateSource.chfPerUsd(d) },
  projectDataDir: (projectId, agentId) => join(appDirs().data, "projects", projectId, "agents", agentId),
  events, onApprovalAnswered: runtimeApprovalHook,
  mailboxFor /* marks handled messages seen; without it only the audit-row check stops repeats */ });
registerEmailTools(registry, { policy, settings, identity, sentLog, mailboxFor, clock });
app.route("/", createEmailRoutes({ settings, sentLog, clock, audit: store.auditLog,
  commandAudit: (a, o) => handler.commandAudit(a, o), humanFor, identity }, new Hono()));
```

The routes' owner check (S.15: the mode is the human's to pick, per agent, for their own
agents): `humanFor` names the signed-in human of a request, `identity` resolves an agent's
owner. Three mount shapes exist and the table decides at construction which one it is:

| Mount | Owner check | Result |
| --- | --- | --- |
| neither `humanFor` nor `identity` | none (a single-user daemon identifies nobody) | every request served, `author_human` null |
| `humanFor` and `identity` | the signed-in human must be `identity.lookup(agentId).humanId` | 403 `tool_not_allowed`, `reason: "not_owner"` otherwise (an unknown agent, nobody signed in and another human's agent alike) |
| `humanFor` without `identity` | cannot be made | fails closed: 403 `tool_not_allowed`, `reason: "identity_port_missing"` on every route under `/agents/:agentId`, and one `error` log line at construction naming the fix |

A refusal never changes a row and is itself audited: an `email.settings` row with `allowed =
false`, `denied_reason` the reason (the stable code, the key to filter on), `input_summary`
`{ action, refused }` (`read_settings`, `update`, `read_sent`, `pause`, `resume`,
`rotate_marker`, `read_commands`), `result_summary` `{ status: "refused", reason }` (JSON,
like the `{ status: "blocked", reason }` of a blocked send, so a reader that parses the
column never throws on these rows), `human_id` and `author_human` the signed-in human,
`agent_id` the agent that was aimed at, so the owner of that agent sees the attempt in their
audit. The sent log and the command audit filter on their own tool names and never pick these
rows up. The refusal stands whatever the audit store does: when the row cannot be written the
request still answers 403 with its code and reason, and the gap is one `warn` line
(`owner-check refusal not audited`, with the agent, the action, the reason and the store's
message) rather than a 500 carrying that message to the UI. The fail-closed shape and the
per-request refusal (rather than a throw at construction) are ADR 0084; the daemon must pass
`identity` beside `humanFor` (`new StoreIdentityLookup(store.agent, store.human)`, as in the
snippet above), or every Settings -> Email and tray pause/resume call answers 403.

`StartCloudSessionPort.start` receives `humanId`, `capUsdMicro` and `autonomyLevel`; the cloud
runner picks the owner's billing source (subscription on a personal runner, else an API key,
T.13) and runs the session under the runtime hooks with that cap and level. `hono` is not a
dependency of this package: the routes are a table over a structural `EmailRouteApp`, and the
caller passes the Hono instance. The CLI needs no command of its own: pause/resume and marker
rotation are routes, and `fr` can call them through the daemon.

Outbound transport: `ImapSmtpMailbox` uses `defaultSmtpFactory`, which never sends the SMTP
password or a message in the clear. `smtp.secure = true` is implicit TLS (465); the default
(`secure = false`, port 587) sets nodemailer's `requireTLS`, so a server that does not offer
STARTTLS gets a `provider_error` and nothing else. Plaintext exists only in
`loopbackSmtpFactory` for the testenv listener on 127.0.0.1, which refuses any other host;
pass `createTransport` explicitly if a deployment really needs something else.

## How it is wired

`composeRuntime` (`packages/runtime/src/daemon/compose.ts`, ADR 0047) builds the ports once with
`agentEmailPorts` (`packages/runtime/src/wiring/email-ports.ts`): `EmailSettingsStore` over
`store.extension`, `StoreIdentityLookup`, `AuditSentLog`, `HumanRequestApprovalPort`, the
`EmailPolicy` with `StoreEventSink`, and `mailboxFor`, which opens `ImapSmtpMailbox` from the
settings in force on first use with the credentials by reference from the vault
(`notifications.mailboxFactory` is the test seam) and keeps it; `emailTools` over these ports
are the four `email_*` tools, and the notifier's `EmailChannel` (`notificationEmailPort`) sends
through the same policy and mailbox. The tools join a run's registry (`toolsForRun()`) and the
session grant only while the agent's settings row names a mailbox and the mode is not `off`
(`emailPresence`), re-read at every session start and by `rt.capabilities.refresh()`; the
mode, the caps, the blocked content, the approvals, the signature and the sent log are the
policy's on every call, so a mode changed under a running session refuses the next send with
`tool_not_allowed` and its `email.send` row. `email_send` is `external_send`, so the hooks
hold it for the human below autonomy 4 before the policy sees it; `email_list` and
`email_read` return untrusted output the hooks wrap and scan, and a flagged read is one
`injection.flagged` audit row and one urgent notification (runtime.md, "Prompt injection").
The catalog entry `email` names the four tools and the classes `read`, `routine_reversible`
and `external_send`; the agent's settings row (`email:<agentId>`) is the spec's own switch,
the catalog entry is the panel's. `RuntimeApp.capabilities.email` exposes the ports and the
presence switch. The email command watcher stays on the cloud runner.

The daemon mounts `emailRouteTable()` (ADR 0066; `server.ts`, adapted to Hono's context like
the desktop routes) over the same ports: `settings`, `sentLog` and `identity` from
`rt.capabilities.email.ports`, `audit: rt.store.auditLog`, `humanFor: () => rt.human.id` (the
daemon's single human is the signed-in human) and `commandAudit: emailCommandAudit({ auditLog,
clock })`. So `GET|PUT /agents/:agentId/email/settings`, `GET .../sent`, `POST .../pause`,
`POST .../resume`, `POST .../rotate-marker` and `GET .../commands` are served behind the
bearer check, another human's agent and an unknown id answer 403 before any read or write,
every change is one `email.settings` audit row, and the tray's click (`apps/desktop`,
"Pause email") flips `settings.paused` so the policy holds the very next send. The views the
routes serve (`EmailSettingsView`, `EmailSentView`, `EmailCommandsView`, `EmailPausedView`,
`EmailMarkerView`) are the daemon's browser-safe copy of the schemas here;
`packages/runtime/test/email-routes-wiring.test.ts` parses the daemon's answer with both and
compares the key sets, so a field added on one side fails there.

## How to change it

- New blocked class: add the rule list in `policy.ts`, extend `BlockedClass`, add a case to the
  "blocks ..." table in `email-policy.test.ts`. Never remove the credentials check from the
  reply-to-human path.
- New mode: extend `EMAIL_MODES`, add the branch in `checkSend` and a row to the mode matrix
  test. Modes are data; the decision stays in code.
- New command outcome: extend `CommandOutcome`, write the audit row with `outcome: "<name>"`
  (the UI and `tasksStartedToday` read `result.outcome`), reply to the human, add a test.
- Another verification source (e.g. Gmail API `authentication-results` JSON): implement
  `AuthVerifier`; keep the "exactly one From address" rule and alignment.
- Another mail host (Gmail API, JMAP): implement `Mailbox`; parse through `parseInboundEmail`
  so the untrusted wrapping and the attachment rules stay.
- Changing the quoted-text rules: change `inbound.ts` and `testenv/src/mail/commands.ts`
  together; `email-inbound.test.ts` asserts parity.

## Tests

Unit (`pnpm vitest run --project unit packages/capabilities/test/email-*.test.ts`, 8 files, 128 tests on
the testenv mail server with DKIM and SPF, an in-memory SQLite store and `SimulatedClock`):

- `email-settings.test.ts`: defaults, merge and validation, credential values refused, marker
  rotation, pause, allowlist additions, per-email cap derivation; ADR 0081: turning commands on
  at mode off refused with `COMMANDS_NEED_SENDING_MODE` and nothing written, commands accepted
  in every other mode, switching the mode to off turns them off with the `email.settings`
  `commands_switched_off` row and the listener told (also when the form still ticks commands),
  a row stored before the rule is not in force and the next write turns it off, a failing
  audit store or listener never undoes the switch-off.
- `email-policy.test.ts`: mode matrix for a stranger; replies to the human in every mode; daily
  cap with a day rollover in `Europe/Zurich`; per-recipient cap; concurrent sends cannot slip
  past the daily or per-recipient cap and a ticket answered twice at once sends once (fails
  without the per-agent lock); every blocked class; paid sign-up and terms approvals; model
  classifier; signature on/off; pause holds; full copy logged with an event; allowlist approval
  yes/no with replay refused; draft_only flow; limits hold for approved drafts; daily digest.
- `email-inbound.test.ts`: parsing, untrusted envelope, injection report, attachment references
  and saving with safe names, link extraction, quoted-text/marker/thread parity with testenv,
  `Authentication-Results` parsing.
- `email-auth.test.ts`: real signed mail passes; unsigned and bogus signatures fail; unaligned
  signature; SPF fail; forged header from an untrusted authserv-id; forged header naming the
  trusted authserv-id on an unsigned message refused (no `DKIM-Signature`); two From addresses;
  `MailauthVerifier` with an injected `authenticate`; `StaticAuthVerifier`.
- `email-mailbox.test.ts`: `TestMailbox` send/list/fetch/markSeen/draft, push watch, polling
  fallback on the clock; the production SMTP factory sets `requireTLS` and never `ignoreTLS`
  (any host, loopback included), the loopback factory refuses non-loopback hosts, and
  `ImapSmtpMailbox` with its default factory refuses the testenv listener that has no
  STARTTLS; `pollLoop`; `buildOutboundRaw`; `ImapSmtpMailbox` with fake IMAP/SMTP clients and
  the real `SecretResolver` over a `MemoryVault`: resolution at call time, not granted refused
  before any connection, no credential value in any captured log line, error message or JSON;
  IDLE push, poll fallback, reconnect, non-fatal catch-up.
- `email-tools.test.ts`: tool shapes and action classes; `email_send` through the policy in
  every mode; `email_read`/`email_list` untrusted output with references only and the flagged
  marker; `email_draft`.
- `email-routes.test.ts`: the seven routes over a fake app mounted the production way
  (`humanFor` and `identity`, every call as the owner): settings GET/PUT with audit and
  validation, pause/resume enforced by the policy, marker rotation invalidates the old marker,
  sent log newest first, command audit.
- `security-email-routes-identity.test.ts` (critic reproduction of the owner check, fixed
  2026-10-23): a mount with `humanFor` and no `identity` refuses (403, `identity_port_missing`)
  the cross-human write and every other route under `/agents/:agentId`, the human's own agent
  and an anonymous request included, logs the misconfiguration once at construction, changes
  nothing and audits each refusal; with `identity` the owner is served, the other human is
  refused (`not_owner`) on all seven routes with one audited refusal each naming the action
  and carrying `result_summary` `{ status: "refused", reason }`, and an unknown agent is
  refused too; a mount without `humanFor` applies no check; with an audit store whose
  `append` throws, both refusals stay 403 `tool_not_allowed` with their reason, nothing
  changes and the missing row is a `warn` line.
- `packages/runtime/test/email-routes-wiring.test.ts` (runtime, ADR 0066): the seven routes
  on the composed daemon behind the bearer check and listed in `DAEMON_ROUTES`; the daemon's
  view and the capability's schema agree on the key sets; `PUT` picks the mode and the mailbox
  (a credential value refused, references kept), the policy sends to a stranger at once, one
  `email.settings` row by the daemon's human; the tray's `pause` holds the next send through
  the policy as `queued` and `resume` releases it, with the `pause` and `resume` rows; the sent
  log and the command audit (rows written as the runner's handler writes them) newest first
  with the limit; `rotate-marker`; another human's agent and an unknown id refused with 403
  on every route and no settings row created; ADR 0081: `PUT` mode off over commands on turns
  them off with the `commands_switched_off` row and an `email_commands_off` notification to the
  owner, and `PUT` commands on at mode off is a 400 carrying `COMMANDS_NEED_SENDING_MODE`.
- `security-email.test.ts` (security review): every test is an attack from a real input and
  asserts what the code does with it: a forged `Authentication-Results` header naming the
  trusted host plus a bogus signature is data; a display name spelling the owner's address;
  a DKIM-valid copy from a host outside the owner's SPF; a stranger answering the agent's mail;
  a stranger-seeded `References` header does not turn the owner's reply to the stranger into a
  command (direct parent, `toHuman`); the owner's signed command replayed after 31 days is a
  `duplicate`; an approval reply that only quotes the request approves nothing; the
  per-recipient cap under case variation; allowlist look-alike domains; a credential in a draft
  never leaves and never reaches the audit copy; the private marker is not shown to the model
  through `email_read`; instruction-like stranger mail is wrapped, flagged and never acted on;
  a signed-in human gets 403 on another human's agent's settings; the install's own
  credentials cannot be named as a mailbox password; no credential value in place of a
  reference.
- `closeout-email.test.ts` (requirements close-out, 2026-10-20): a second human's agent lists
  and reads its own mailbox only (the tools bind the mailbox to the run's agent id, the schemas
  drop any mailbox or agent the model names, mode off reads nothing while the other mailbox has
  mail, one settings row per agent; S.10, S.15); in draft only, allowlist and full discretion
  the blocked-content rules and the daily and per-recipient caps hold and a changed cap takes
  effect at once, every refusal an `email.send` row (S.21); a fresh agent starts at 20 sends a
  day and 5 per recipient (S.22).
- `closeout-email-commands.test.ts` (requirements close-out, 2026-10-20, T.1): the command
  toggle and the sending mode are independent settings and independent gates (read only
  answers the owner's command while refusing a stranger; commands off in full discretion
  leaves the owner's marked mail as data: no model call, no reply, no session); the
  acknowledgement reaches the owner in read only, draft only, allowlist and full discretion
  with the daily and per-recipient caps at zero, logged as a reply to the human with no
  refused row and no approval ticket, while nothing to a stranger goes out in the same world.
- `packages/runtime/test/capabilities-wiring.test.ts` (runtime, ADR 0047): the tools absent
  until the settings name a mailbox with a mode other than off and gone again at mode off, a
  session through the daemon sending to a stranger in full discretion (signature on, one
  `email.send` row, one message in the fake mailbox), `email_send` in read-only mode refused
  by the policy with its `email.send` row `allowed: false` and nothing sent, an injected mail
  read through `email_read` flagged once as an `injection.flagged` row and an urgent
  notification carrying the rules and never the passage.
- `email-commands.test.ts`: the gate (marker, thread reply, spoofed DKIM, bogus signature, SPF
  fail, wrong sender, forwarded by another, forwarded by the owner, quoted command, missing
  marker, disabled, each agent obeys only its own human, nothing obeyed at sending mode off
  including a row stored before ADR 0081); the handler (question, task with ack
  under 60 s and the capped cloud session, the task's tier from the project's default (0 in
  small-project mode, else 1; B.6), watched mailbox end to end, ask-which-project then
  threaded answer, note, attachments never opened, per-email cap, daily task cap with rollover,
  injection flagged and not acted on (scenario 6), paused, unclear, completion summary, command
  audit, and `emailCommandAudit` over the audit log alone answering the handler's rows, the
  limit, and nothing for another agent); idempotency and serialization (the same message
  handled twice acts once and is marked seen, two concurrent deliveries act once, a watcher
  restart with catch-up replays nothing, the daily task cap holds under concurrent commands, a
  stranger's subject line is redacted in the audit rows); approvals by reply with the same
  checks, autonomy decided in code, policy approvals by reply sent once.

Phase 6 gate evidence ("an emailed task is acknowledged within 1 minute and completed in the
cloud; a spoofed or forwarded email is ignored"): `email-commands.test.ts` "gate scenario" and
"ignores a spoofed From" / "ignores mail from anyone else, including a forwarded copy". Scenario
2 (email task) and scenario 6 (injection by email) of phase 8 are covered at unit level by the
same file; the live e2e runs under `tests/e2e/`.

## Known issues

- `ImapSmtpMailbox` opens a connection per operation (and one long-lived IDLE connection per
  watch); hosts with low connection limits may want a pooled client.
- HTML-only mail is converted with a small tag stripper, not a full HTML-to-text renderer.
- The per-email estimate is a conservative constant plus words (`defaultTaskEstimate`); wire
  `taskEstimate` to the estimate tracker once the runtime exposes learned multipliers.
- `MailauthVerifier` needs DNS; it is only exercised with an injected `authenticate` in tests.
- The daily digest needs a scheduler entry (`EmailPolicy.sendDailyDigest`) that the
  orchestrator adds.
- The per-agent lock is in-process. Two runners watching the same mailbox at the same instant
  can both pass the audit-row check for a brand-new message; after the first finishes, the row
  and the seen flag stop every later delivery. Run one watcher per mailbox (the cloud runner
  does), or add an IMAP flag claim (`\Flagged` set-and-check) if several must share one.
- Sends held while paused are not resent on resume (see limit 5); the owner's record is the
  `email.queued` rows.
- The daemon picks a changed mode or mailbox up at the next session start (`emailPresence`:
  the tools join or leave the run), the policy at the next call; a session already running
  keeps the tools it was offered and the policy refuses the next send.
- The routes' owner check needs both `humanFor` and `identity`. A mount with `humanFor` alone
  no longer applies no check (the medium finding of the 2026-10-20/21 review): it fails closed
  and refuses every request under `/agents/:agentId` with `identity_port_missing`, so a daemon
  that forgets the identity port sees every Settings -> Email call fail with 403 and one
  `error` log line at startup rather than a silent cross-human write (ADR 0084). The daemon
  passes both (`server.ts`, ADR 0066); any other host of the table must too. A refusal whose
  audit row could not be written is still refused, but its only record is then the `warn`
  line, not a row the agent's owner sees in their audit.
- A mode change from the page is not a change-log row and has no undo: its record is the
  `email.settings` audit row (ADR 0066). Wrapping the `PUT` in an `email.mode` registry
  command is a later change to `packages/commands`.
- The private command marker is replaced only on the model-facing paths (`email_read`,
  `email_list`, the classifier's subject). The sent log, the `email.command` audit rows and the
  `source.subject` a cloud session is started with keep it; the first two are the owner's
  records, the last reaches the runner, which should not hand it to the session's model.
- The mailbox is opened once per daemon from the settings at that moment; a changed host or
  credential reference takes effect after a restart (the connection is kept, not re-read).
- An installed `email` capability row is not re-synced from the catalog: a row installed
  before the tool names were set to `email_*` keeps its old `permissions.tools`, so the
  extension gate does not recognise the daemon's `email_*` tools as the row's and a toggle-off
  revokes no run token by tool name; presence (`emailPresence`) still drops the tools at the
  next session start. Remove and re-add the capability from the catalog (`DELETE
  /extensions/:id`, then `POST /extensions` with the catalog id `email`) to refresh it; the
  same gap is listed for the browser in `browser.md`.

## Requirements covered

In the daemon (ADR 0047, `packages/runtime/test/capabilities-wiring.test.ts`): L.3, S.16 and
S.17 (off offers nothing, read only sends nothing: absent at run start, refused and audited
under a running session), S.20 (full discretion sends to a stranger inside the limits), S.25
(an inbound instruction is reported, never acted on), S.26 (the `email.send` row), S.27 (the
signature); (ADR 0066, `packages/runtime/test/email-routes-wiring.test.ts`): S.15 (the mode
per agent through the daemon's routes, the owner check), S.28 (the tray's pause route holds
the next send), S.29 (full discretion picked through the route), T.14 (the command audit
served newest first); the page itself is `apps/ui/test/email-settings.test.tsx` (apps.md).
In the module:
S.1, S.2, S.4 (mailbox credentials by reference, values scrubbed), S.6 (paid sign-ups, terms,
always-human classes through `requestCommandApproval`), S.9 (audit row per outward action),
S.15, S.16, S.17, S.18, S.19, S.20, S.21, S.22, S.23, S.24, S.25, S.26, S.27, S.28 (the flag
and the routes; the tray button is the app's), S.29 (available; the setup-screen text is the
app's), T.1, T.2, T.3, T.4, T.5, T.6, T.7, T.8, T.9, T.10, T.11, T.12, T.14. T.13 is the cloud
runner's (the port passes the human id so the runner can pick the billing source).

Requirements close-out (2026-10-20): S.16 to S.27 are `done` on the suites above plus
`closeout-email.test.ts`. S.15, S.28 and S.29 closed on 2026-10-23 (ADR 0066): the daemon
mounts the routes (`email-routes-wiring.test.ts`) and `apps/ui` has the Settings ->
Capabilities -> Email page with the mode picker per agent, the full-discretion sentence before
the change and in the confirmation, pause and resume, the limits, the allowlist, the mailbox
by reference, the marker and the lists (`apps/ui/test/email-settings.test.tsx`; ADR 0081 there:
the mode note says commands went off with a change to off, the commands toggle follows the
stored value, and turning commands on at Off shows the 400's sentence).

Email commands close-out (2026-10-20): T.3 to T.12 are `done` on `email-commands.test.ts`,
`email-auth.test.ts`, `email-inbound.test.ts`, `email-settings.test.ts`, `email-routes.test.ts`
and the cloud runner's `runner.test.ts` and `email-watch.test.ts` (the capped cloud session,
the acknowledgement within a minute, the completion in the thread). T.1 closed on 2026-10-23
(ADR 0081): commands need a sending mode other than off, enforced in the settings store
(`email-settings.test.ts`, `email-routes-wiring.test.ts`), the gate (`email-commands.test.ts`)
and the runner's watcher (`services/cloud-runner/test/email-watch.test.ts`), and the reply to
the owner goes out in every mode where commands can be on (`closeout-email-commands.test.ts`).
T.14 closed on 2026-10-23: the daemon serves `GET .../email/commands` from the shared state
(`emailCommandAudit`, `email-routes-wiring.test.ts`) and the page lists every command with
when, from, the interpretation, the result and the reason it was ignored, newest first
(`email-settings.test.tsx`).
