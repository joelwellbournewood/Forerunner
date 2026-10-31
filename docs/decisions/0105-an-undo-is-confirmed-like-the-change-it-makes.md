# 0105 — An undo is confirmed like the change it makes

Date: 2026-10-31
Status: accepted

## Context

U-057: Undo ran at once whatever it put back. Lowering the monthly cap needs a yes; raising it
needs this PC or the phone with biometric. Undoing the lowered cap raised it with one click and
no confirmation, and the same held for an email mode put back to a wider one. The owner
approved: undo evaluates the risk of the value it restores and goes through the same
confirmation as a forward change.

An undo usually takes back something just done, often to make it safer. Asking for a yes for
every undo of a medium-risk change (lowering a cap back, turning fast mode off) would add a
click where nothing widens.

## Decision

- A command may declare `undoRisk(params, before, after, ctx)`: the risk of putting `before`
  back on today's state. The executor takes the highest over the row's commands and runs the
  undo through the same `gate` as a forward change: `act`, a pending card (a yes or a tap), or
  the paired device. The card is an undo card (old and new value swapped) and lands in the
  Inbox like any other.
- The risk is the forward risk when the undo raises or widens, and low when it lowers or
  narrows: `budget.set` (a higher cap: the raise's risk), `email.mode.set` (a wider mode or
  commands back on: high), `autonomy.set` (a higher level: one step medium, more high),
  `settings.set` (the restored value's risk, except the safe side a key names with
  `narrows`), `model.settings.set` (the value's risk). A command without `undoRisk` undoes at
  once, as before.
- The confirmed undo re-reads the row and checks again whether it can work (`undoBlocked`,
  U-061) before it runs.
- The timed revert of a temporary change (a session budget until 06:00) is not a person's undo
  and runs on its own as before.

## Consequences

- Undoing a lowered monthly cap from Changes, the settings dialog or chat shows the card and
  waits for this PC; a chat yes is refused for it as for the raise. Undo in the safe direction
  stays one click.
- Chat's "undo" reads back a pending undo like any change, so a yes answers it.
- A pending undo does not survive a restart (its closure is gone), like any pending card; the
  next daemon expires the card and the row is still undoable.

## Alternatives considered

- The forward risk of the restored value always (also when it lowers): every undo of a
  medium change would ask for a yes, including undoing a raise of a cap, the safe direction.
- Undo always low (the old behaviour): the bug.
- Undo always the change's own risk: an undo of a high-risk narrowing (email to off) would need
  the device to widen it again, which is right, but an undo of a widening would too, which is
  the safe direction.
