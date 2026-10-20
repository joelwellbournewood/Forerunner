# 0030 — Command registry: risk resolution, confirmations, change log and undo

Date: 2026-10-20
Status: accepted

## Context

Spec module Q asks for one command registry behind buttons, palette, API, chat, voice and
email; a change card before any change; confirmation by a three-level risk table; bespoke
requests as one card; every change spelled out and logged with a one-click undo; and limits
that still hold in conversation. It leaves open where the active project lives, how a risk is
computed when it depends on state, how a "yes" is tied to a pending change across chat, email
and the phone, what a change log row holds for a plan of several commands, how a temporary
change reverts after a restart, and how commands reach the PC from a phone.

## Decision

1. **Risk is a function of parameters and state, resolved by the executor.** A command gives a
   static risk or `risk(params, ctx)` with `maxRisk` for the tool spec and the command table.
   `budget.set` is medium within the human's monthly hard ceiling (`human.monthly_cap_usd_micro`,
   the billing default CHF 150 when unset) and high above it or when the ceiling itself is
   raised; lowering the ceiling is medium. `autonomy.set` is medium for one step, high for
   more, low for no change. `request.answer` carries the request's own risk.
2. **An agent never raises its own limits without a human.** Commands flagged `limit`
   (`budget.set`, `autonomy.set`, `capability.grant`, `email.mode.set`) need a human's yes when
   the actor is an agent, whatever the risk, and only a human's answer counts.
3. **A pending confirmation is a HumanRequest plus an in-memory closure.** The request (kind
   `approval`, the card, the decision, an `FR-` email token, a ten-minute expiry on the Clock)
   is what the inbox, the phone and an email show; the closure is what runs. Medium accepts a
   typed or spoken yes (the runtime's `isYes`), a tap or the email token. High accepts only a
   device confirmation from a non-revoked device of the same human, with `biometric: true` on a
   phone; a chat or email yes is refused and the request stays open. An answer counts only
   from the human the change is for: another human's yes, tap or token is refused, and a
   device answer that names another human is refused even on the owner's device. An email
   answer is accepted only against a pending change's token, never pre-supplied on the
   settings-screen path. One answer runs a change once (a second answer while the first is
   checked is refused), and the decision is made again on the current state when the answer
   arrives: a stricter decision refuses the answer and the human asks again. A restart drops
   closures; the human asks again.
4. **The active project is stored per human** in `human.notify_prefs.active_project` with a
   ten-entry history for "go back"; the executor context carries it, and a `project.switch`
   earlier in a composed plan makes later steps apply to the new project.
5. **One change log row per request, also for a plan.** `commands` holds every command with its
   parameters; `before` and `after` are single values for one command and arrays for a plan.
   Rollback on a failing step is attempted in reverse; a successful rollback logs nothing and
   refuses, a failed one logs the kept steps with a note (`partial`).
6. **Undo is state-based first.** Each command's `undo(params, before, after)` works from the
   row, so undo and the scheduled revert survive a restart (`resumeScheduled`); the closure
   from the run is used while it exists. A revert at the end of a window marks the row
   `expired` and logs an irreversible revert row with `revert_of`; a manual undo marks it
   `undone` and logs an `undo` row. Only the human the change was made for may undo or
   revert it; agents and other humans are refused.
7. **Phone and web clients control sessions through `remote_command`.** When the context's
   device is a phone or web client, `session.start` and `session.stop` enqueue a remote command
   for the PC or the cloud runner instead of calling the runtime ports; undo fails the row while
   pending.
8. **Money on cards is CHF, stored in USD micro-units with the CHF figure beside it**
   (session override, session cap, project budget, monthly cap), formatted by the billing
   formatter without a trailing `.00`.
9. **Intent parsing is deterministic first, model second, and never for content.** Patterns in
   English and German cover the spec phrases with times read in the human's time zone
   (tonight and tomorrow end at 06:00); what they do not understand goes to a model port whose
   output is validated against the registry; text carrying the data envelope or marked as
   content is refused with `injection_suspected`.

## Consequences

- Every settings change by voice, chat or the UI produces the same change log row apart from
  `source` and `words_used` (phase 5 gate test).
- The settings screen shows the card from `plan()` and passes a tap as the confirmation; it
  cannot bypass the policy because the executor re-runs it.
- A high-risk change from the desktop app still needs a device confirmation; the desktop is
  itself a paired device, so the app confirms with its own device id.
- The pending-confirmation closure is the one piece of in-memory state; the trade-off is noted
  in the maintainer doc.

## Alternatives considered

- **Risk as a static column only.** Rejected: the spec's own examples ("within the hard
  ceiling", "by one step") depend on the current value.
- **Serialising the pending run into the HumanRequest** so a restart can finish it. Deferred:
  it would re-run `plan()` on a possibly changed state; asking again is safer and cheap.
- **Closures only for undo.** Rejected: undo and reverts must survive a restart.
- **Calling the runtime's session ports from the phone's context.** Rejected by spec R: the
  phone has no runtime; commands go through the state service.
