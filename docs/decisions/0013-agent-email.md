# 0013 — Agent email: settings and sent log in existing tables, sender verification chain

Date: 2026-10-20
Status: accepted

## Context

The spec gives each agent a mailbox with five sending modes and limits that stay on, and a
separate email-command toggle with a private marker, per-email cost cap, daily task cap and an
email autonomy level. Everything the human adjusts must be stored per agent; every sent email
must be logged with a copy the owner can see; caps count sends per local day; thread replies
and approval replies must be matched to mail the agent sent; and the command gate must know
that a message really came from the owner's registered address. Schema v1 (ADR 0005) has no
email tables, and adding them means a migration in both SQL dialects and a `data-model.md`
regeneration for what is, in the end, configuration and an audit trail.

## Decision

1. **Settings live in the `extension` table.** One row per agent, `kind = "capability"`,
   `name = "email:<agentId>"`, `config = { settings, commands }` validated by a zod schema on
   every read and write (`EmailSettingsStore`). `enabled` mirrors "mode is not off or commands
   are on" and `permissions` carries `email:<mode>`, `email-commands` and `paused`, so the
   Extensions panel shows the grant like any other capability. Mailbox credentials are stored
   as `secret:<name>` references only; the schema refuses a value. The agent row's own settings
   JSON was not used because the email configuration is a capability grant with its own
   enabled flag and permissions, which is exactly what `extension` models.

2. **The sent log is the audit log.** Every sent email is an `audit_log` row with
   `tool = "email.send"`, `allowed = true`, the redacted full copy as JSON in `input_summary`
   (`AuditSentLog`). Blocked and refused sends are rows with `allowed = false`; drafts, queued
   sends, email commands, flagged inbound mail and settings changes use their own tool names.
   Daily caps, thread detection (`Message-ID`s of sent rows), approval-by-reply
   (`approvalRequestId` on the approval-request row) and the owner's "sent" view all read this
   one append-only table. No new table, no migration; the audit log is already exportable and
   already the record of every outward action the spec asks for.

   The same table is the idempotency key for commands: one `email.command` row per inbound
   Message-ID (per mailbox id when a message has none) per agent. A message that already has
   a row is refused as `duplicate` before any model call, task or session; a handled message
   is also marked seen in the mailbox. Cap checks and command handling run under an
   in-process per-agent lock, because check-then-act over an append-only log needs
   serialization that the log itself cannot give.

3. **Verification chain for commands.** A message is obeyed only when, in code and in this
   order: commands are enabled with a registered address; the From header has exactly one
   address and it is the registered one; an `AuthVerifier` reports DKIM pass for a domain
   aligned (relaxed) with the From domain and SPF pass; the subject carries the private marker
   or the message replies to a Message-ID in the sent log. Two production verifiers:
   `AuthResultsHeaderVerifier` reads the receiving host's `Authentication-Results` header and
   believes it only for a configured authserv-id (a sender can add its own forged header) and
   only when a claimed `dkim=pass` comes with a `DKIM-Signature` header on the message;
   `MailauthVerifier` re-verifies DKIM and SPF with `mailauth` for hosts that do not stamp
   results or are not known to strip foreign headers. The testenv server stamps the same
   header shape, so tests run the production verifier. Quoted and forwarded text is stripped
   before the owner's words are interpreted; an approval "yes"/"no" is a thread reply and
   passes the same chain.

4. **Approvals are `human_request` rows** (kind `approval`, `change_card.kind =
   "email_approval"` holding the draft and context) through a small `EmailApprovalPort`; a
   fake port answers at once in tests. An approval ticket can send at most once.

5. **Outbound SMTP is never plaintext in production.** `defaultSmtpFactory` uses implicit TLS
   when `secure` is set and otherwise nodemailer's `requireTLS` (STARTTLS mandatory), never
   `ignoreTLS`, whatever the host. The only plaintext transport is `loopbackSmtpFactory` for
   the testenv listener, which accepts the loopback interface and refuses every other host;
   `TestMailbox` defaults to it, `ImapSmtpMailbox` never uses it.

## Consequences

- No schema change for phase 6 email; the sent log is as durable and exportable as the audit
  log and is visible in the existing audit views.
- Reading caps means scanning the agent's `email.send` rows of the last 48 hours (90 days for
  threads); fine at the spec's volumes (tens of mails a day). A dedicated table with an index on
  `message_id` is the upgrade path if an agent ever sends thousands.
- A host whose `Authentication-Results` authserv-id is not configured makes every command fail
  closed (`dkim=none` with a reason); the fix is to list the authserv-id or switch to
  `MailauthVerifier`. Failing closed is the intended default.

## Alternatives considered

- Dedicated `email_settings` and `email_sent` tables: cleaner queries, but a migration in two
  dialects and a generated-doc change for configuration and an audit trail that existing tables
  already model. Deferred until volumes require it.
- Settings in `agent.settings` JSON: no enabled flag or permissions list for the Extensions
  panel, and the agent row is edited by other features (a version conflict magnet).
- Trusting the topmost `Authentication-Results` header unconditionally: simpler, but a sender
  can prepend one and a host that does not strip foreign headers would pass a spoof. Opt-in
  only (`trustedAuthservIds: []`).
- Marker only, no thread replies: simpler gate, but the spec's approval-by-reply and
  "which project?" answers need thread detection.
