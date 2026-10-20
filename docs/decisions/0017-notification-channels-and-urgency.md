# 0017 — Notifications: channel fallback order and what counts as urgent

Date: 2026-10-20
Status: accepted

## Context

The spec asks for "desktop, email, Telegram or Signal, quiet hours" (build order phase 5),
"push for approvals, finished sessions, budget warnings and messages, with quiet hours" (R) and
"desktop notifications, tray menu" (K). It leaves open which notifications may break quiet
hours, what happens when a channel fails, what "channels enabled per kind" means when the human
has set nothing, whether a daily digest exists and what it bundles, and how the Telegram bot
token is handled. `docs/maintainers/notifications.md` describes the module; this ADR records
the choices that are not forced by the spec.

## Decision

1. **Three urgencies, fixed per kind, raisable by the producer and never lowerable.**
   `urgent`: `kill_switch`, `injection_flagged`, `budget_stop`, `request_blocking`. Each means
   work has stopped or cannot continue without the human (spec S "always needs a human",
   scenarios 5 and 6, the kill switch), so waiting for the morning would defeat the purpose.
   `normal`: `request_opened`, `session_ended`, `email_command_received`, `daily_digest`.
   `info`: `critic_verdict`, `update_available`, `peer_message`. A producer may raise an
   item (a critic `escalate` or `human` verdict and a `requires_ack` message are `normal`) but
   never lower one, so no caller can turn a kill switch into a digest line.
2. **Quiet hours hold `normal` items and never `urgent` ones.** The window is wall-clock time
   in the human's zone (`notify_prefs.timezone`, else `human.timezone`, else UTC), may span
   midnight, and is evaluated with the scheduler's `localParts` so sessions and notifications
   agree on "night". Held items are sent one by one when the window ends.
3. **The daily digest bundles `info` items and whatever is still held at the digest time.**
   It goes out once per local day at `digest_time`; without a digest time, `info` items are
   sent like `normal` ones. A digest time that already passed when a human's first item arrives
   (daemon restart, first use) counts as sent for that day, so a restart never fires a stray
   digest; the items wait for the next one. An empty day sends no digest.
4. **Fallback order `desktop → telegram → signal → email`, preferred channel first.** The
   order is fastest-to-notice first and slowest last. The human's `notify_channel` moves to the
   front (`"push"`, the Android client, means desktop until the push service exists). An
   explicit per-kind list in `notify_prefs.channels` replaces the default order entirely, and an
   empty list disables the kind. The notifier tries the channels in order, skips the ones that
   are not configured for this human (recording the reason), retries a failing channel three
   times with exponential backoff (500 ms, doubling, capped at 5 s, on the `Clock`), treats a
   `retryable: false` answer (missing tool, missing address, rejected payload) as "move on now",
   and stops at the first delivery. `failed` means every tried channel failed; `no_channel`
   means nothing was configured.
5. **Dedupe by key, ten minutes, for what reached the human.** The same `(human, dedupeKey)`
   within the window is recorded as `deduped` and not sent. Only a notification that was
   delivered, or is still held for quiet hours or the digest, occupies the window: one whose
   every tried channel failed (`failed`) or that had no channel to try (`no_channel`) releases
   it at once, so the producer may send it again (the window is reserved before the send so a
   concurrent duplicate is still deduped). Producers choose stable keys (`request:<id>`,
   `session:<id>:ended`, `update:<version>`, `kill:<scope>`).
6. **Every attempt is audited; every decision is observable.** One `audit_log` row per channel
   attempt (`notify.<channel>`), a `notification` event on the session when the notification
   names one, and a `record` on the in-process bus for UIs. Test notifications are audited too
   but never enter the dedupe window or the recent list.
7. **Secrets by reference, text through redaction.** The Telegram bot token is
   `secret:telegram_bot_token`, resolved through the secrets port at send time; the request URL
   that carries it is never logged and every reason string passes through the resolver's
   redaction. Desktop toasts run through `run()` with argv arrays; on Windows the user text
   reaches PowerShell through environment variables so no text is ever part of a script.
8. **Queues are in memory for 1.0.** Held and digest items are lost on a daemon restart; the
   records they point at (requests, messages, sessions) are in the inbox, so the human misses a
   push, not information. Persisting the queue is a follow-up and is listed as a known issue.

## Consequences

- A human who sets nothing gets desktop toasts (or the OS notifier) and, with the agent email
  capability on, email as the fallback; Telegram and Signal need an address and are skipped
  until then, with the reason shown in the settings screen.
- Scenario 1 works as written: the night's `session_ended` and `request_opened` items are held
  until the window ends and arrive in the morning, `critic_verdict` lines wait for the digest,
  while a `budget_stop` or an `injection_flagged` wakes the human.
- Changing what is urgent, or the fallback order, is a change to `KIND_URGENCY` or
  `CHANNEL_NAMES` plus a superseding ADR, not a per-call decision.
- The Android client's own push arrives later without a schema change: `notify_channel:
  "push"` and the per-kind lists are already stored.

## Alternatives considered

- Letting producers set urgency freely: a bug in a producer could silence a kill switch.
  Fixed defaults with raise-only overrides keep the floor in code.
- Sending to every enabled channel at once: noisy and costly (email per toast); first
  delivery wins, with the order under the human's control.
- Persisting the queue in the state store now: adds a table and a migration for a loss that
  only costs a push; deferred.
- Treating `request_opened` as urgent: non-blocking requests are the common case and would
  make quiet hours meaningless; blocking ones are urgent.
- A Telegram token in configuration files: against the vault rule (spec "Secrets by
  reference"); the reference is the only thing the module holds.
