# 0081 — Email commands need a sending mode other than off: the settings store refuses them at off, switching to off turns them off with an audit row and a notification, the watcher does not start at off

Date: 2026-10-23
Status: accepted

## Context

The spec's modes table says mode **Off** sends nothing ("Agent can send: Nothing"). Its email
commands section says commands are "a separate toggle from the sending modes" and "Replies to
you are always allowed" (T.1). The two meet at mode off with commands on, and the code read
them differently:

- `EmailPolicy.checkSend` refuses every send at mode off, the reply to the owner included
  (`email-policy.test.ts`, "allowed in every mode except off").
- `EmailWatch.start` (cloud runner) and `EmailCommandGate` read only the command toggle, so an
  owner who left commands on at mode off had commands obeyed and tasks started while the
  acknowledgement, the approval-by-reply and the completion summary were all refused. A task
  ran on the owner's money and the owner heard nothing.

Two readings resolve it: (a) let the reply to the owner through at mode off while commands are
on, or (b) commands cannot be on at mode off. BLOCKERS row T.1 asked for an ADR picking one.

## Decision

Reading (b): **at mode off the mailbox sends nothing, so email commands cannot be on at mode
off.** "Replies to you are always allowed" holds in every sending mode where commands can be
on: read only, draft only, allowlist and full discretion, with the send caps at zero and
without an approval ticket (already proved by `closeout-email-commands.test.ts`). The rule
lives in the store/policy layer, `EmailSettingsStore` (`packages/capabilities/src/email/types.ts`),
which every writer goes through (the daemon's `PUT /agents/:id/email/settings`, the settings
page that reads the same validation, the runner):

1. **Turning commands on at mode off is refused.** `update` throws `ForerunnerError("validation",
   COMMANDS_NEED_SENDING_MODE)` with `details: { reason: "commands_need_sending_mode", issues:
   ["commands.enabled"] }` when the merged result is mode off with commands on and the patch
   sets `commands.enabled: true` while commands were not in force. Nothing is written. The
   daemon answers 400 with that message, so the page shows the plain sentence: "Email commands
   need a sending mode other than off: ... Choose a sending mode first (read only is enough to
   reply to you), then turn commands on."
2. **Switching the mode to off with commands on turns commands off in the same write.** The
   other command settings (registered address, marker, caps) are kept, so turning commands on
   again later is one switch. The page sending its whole form (mode off, commands still ticked)
   is this case, not a refusal. The store then writes one `email.settings` audit row
   (`allowed = true`, `input_summary` `{ action: "commands_switched_off", reason: "mode_off",
   modeBefore, modeAfter: "off" }`, `result_summary` `{ status: "commands_off", reason:
   "mode_off" }`, `human_id`/`author_human` the human who changed the mode) and calls the
   `onCommandsSwitchedOff` listeners; the daemon binds one that sends the owner an
   `email_commands_off` notification (urgency normal, link `/settings`). A failing audit store
   or listener is a warn line and never undoes the write.
3. **A row stored before this rule (commands on at mode off) is not in force.**
   `emailCommandsActive(config)` (toggle on **and** mode not off) is what the gate reads, so
   such a row obeys nothing (`disabled`); the next write over it turns commands off as in 2.
4. **The runner's watcher does not start at mode off.** `EmailWatch.start` reports
   `{ state: "disabled", reason: EMAIL_WATCH_MODE_OFF_REASON }` ("the sending mode is off:
   email commands need a sending mode other than off, ...") in its `status` (and so in the
   runner's health view) and logs `email watch not started` with that reason.
5. `EmailPolicy.checkSend` is unchanged: mode off refuses every send, the owner's reply
   included. The spec's modes table stands as written.

## Consequences

- No task can start from an email the agent cannot answer; the owner never pays for a run
  they were not told about.
- The settings page (wave/w2-email-page) needs no rule of its own: it shows the 400's message
  and re-reads the settings after a mode change.
- An owner who turns the mode off loses commands until they pick a mode again; they are told
  at once (notification) and the audit trail says why.
- Read only becomes the smallest mode that allows commands: the agent can then reply to the
  owner and nobody else.

## Alternatives considered

- **Reading (a), the reply to the owner goes out at mode off while commands are on.** Keeps the
  toggles fully independent, but makes "Off: sends nothing" false and gives mode off a hidden
  sending path that depends on a second switch. Rejected as the less safe reading; read only
  already gives exactly "reply to the owner only".
- **Refuse the mode change to off while commands are on.** Makes the owner hunt for a second
  switch when they want the mailbox quiet now (the tray's one-click intent). Rejected: turning
  off must always work.
- **Only the watcher refuses; the settings may hold both.** Leaves a stored state that looks on
  and does nothing, and the daemon-side gate would still need its own check. Rejected; the
  watcher check stays as defence in depth for rows from before the rule.
