# 0096 — A built-in extension added in the panel is confirmed there, on this PC's device, with no Inbox card

Date: 2026-10-31
Status: accepted

## Context

U-026: Add on an entry of the Extensions panel's catalog filed a request, and the grant waited
for a blocking, high-risk Inbox card. The person had just clicked Add after reading the entry, so
the card repeated a decision with no new information, and the panel showed the extension as
"waiting for your approval" while the Inbox asked the same question a second time.

The card was there for two reasons that still hold:

- Spec §Security puts "grant a capability" in the high-risk row of the confirmation table:
  "Change card, then confirmation in the app on a paired device, with biometric on the phone. A
  chat or email yes alone is not enough", and lists granting a new capability among the actions
  that always need a human, at any autonomy level.
- Some grants are not the person's own click: an extension added from a URL is reviewed only
  after it was started once (its real tools are learned then, ADR 0016); widening an
  extension's permissions is a grant of something new; an agent may propose one.

How a high-risk change is confirmed elsewhere on this PC (ADR 0030): the settings screen shows
the change card, and "Confirm on this device" sends a device answer
(`POST /commands/:id/confirm { answer: "device", deviceId }`); the daemon answers an answer that
names no device with its own desktop row and checks the row with the command registry's
`ConfirmationPolicy` at `needs_device` (a desktop of the same human, not revoked; a phone only
with its biometric; a web page or a runner never). Before this change the panel's Approve was a
plain POST with the daemon's bearer token, a weaker bar than that, and the Inbox card on the
desktop was answered the same way.

The owner chose the action in `docs/status/UPDATE-LOG.md` (U-026): Add on a built-in entry opens a
confirmation in the panel with the change card (tools, secrets, domains, scopes, risk); Confirm
grants it with no Inbox card; Cancel adds nothing; the Inbox keeps the grants the person did not
just see.

## Decision

1. **Where a pending row is decided is recorded on it** (`config.confirmIn`, `ExtensionView.confirmIn`):
   `panel` or `inbox`. Rows from before have none and read as `inbox`.
2. **Only a built-in catalog entry added from the panel is decided in the panel.**
   `POST /extensions { catalogId, confirmIn: "panel" }` installs it as before (a built-in
   connector is started once without its secrets to list its tools, ADR 0016) and returns the
   pending row with its review, but files no Inbox card. A remote catalog entry asks in the
   Inbox whatever the body says (it is not trusted that far); a URL cannot ask for the panel (the
   body is refused, 400); a widening (`updatePermissions`) is `inbox`; anything an agent proposes
   goes through the Inbox as before.
3. **The panel shows the change card and asks for the confirmation of the high-risk row.** The
   dialog lists the step, the risk, the review's summary, every tool with its action class and
   risk, and the tools, action classes, domains, paths, secrets and scopes of the grant. Confirm
   sends `POST /extensions/:id/approve { answer: "device", deviceId }` with `/me`'s
   `desktopDeviceId` (none: the daemon uses its own desktop row). The daemon checks it exactly
   like a change card's device answer (`confirmGrantOnDevice` in `server.ts`:
   `ConfirmationPolicy.check("needs_device", ...)` against the device row), audits every answer
   as `extensions.confirm_device` (allowed or with the refusal), and only then calls
   `registry.approve`. A refusal is 403 `approval_required` with the policy's reason, shown in the
   dialog; the row keeps waiting.
4. **A plain yes is not enough for a row decided in the panel.** `POST .../approve` without the
   device answer is refused (403, "granted in the Extensions panel with Confirm on this device").
   A mount without the device check (`confirmOnDevice` absent) refuses a device answer with 503
   instead of skipping it. The panel's Approve on any pending row (from a URL, a widening) opens
   the same dialog and sends the device answer, which is checked for those rows too; the Inbox
   card of such a row is unchanged.
5. **A built-in connector that needs its secret to start** (its secret-free discovery failed)
   is confirmed in the panel twice: first the discovery start with the secrets it names
   ("Start it once on this device"), then, with the tools it listed, the grant. Neither step files
   a card.
6. **Cancel adds nothing.** Cancel (or closing the dialog) on an Add calls
   `POST /extensions/:id/deny`, which deletes the fresh row; nothing was granted, started with a
   secret, or filed. A row left waiting (the app closed with the dialog open) stays in the panel
   with Approve and Deny and no Inbox card; Approve opens the same confirmation.

## Consequences

- The person decides an Add once, where they made it, at the bar the spec sets for a high-risk
  change, and the panel's confirmation is stronger than the Approve button was before (a
  device answer checked by the confirmation policy, audited).
- The Inbox still carries every grant the person did not just see; `syncApprovals` never
  touches a panel row (it has no request).
- The phone has no Extensions panel; a grant it should confirm still arrives as an Inbox card
  with its biometric rule.
- The fake daemon (`apps/ui/test/fake-daemon.ts`) now makes every catalog add wait, as the real
  registry does; before, it enabled a capability at once.

## Alternatives considered

- **Run the grant as a `capability.grant` command** through `/commands/execute`. Rejected: a
  pending high-risk command is itself an Inbox card (`approve on device` / `reject`), which is what
  the owner asked to remove, and that command writes the old string-array permissions directly,
  bypassing the registry's review, ownership checks and connector start.
- **Preview first, insert on Confirm** (nothing written before the confirmation). Rejected for
  now: the review shown would come from one discovery run and the grant from another, so what was
  shown might not be what is enforced; inserting the pending row keeps the shown grant the granted
  one, and Cancel deletes it.
- **Keep a plain Approve for panel rows.** Rejected: the spec asks for a confirmation on a paired
  device for this row of the table, and the commands path already has one on this PC.
