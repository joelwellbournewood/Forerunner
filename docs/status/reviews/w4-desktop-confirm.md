# Review: w4-desktop-confirm

Branch `wave/w4-desktop-confirm`, reviewed at 438d1d7 against `origin/ccr-4d8a843c-1k9syk`
(b1804e3; the branch's merge base is 049ed52, `git merge-tree` with b1804e3 is clean).

## Review

Verdict: **revise**. Score: 78/100 (as built at 438d1d7; every finding below is resolved).

The core fix is right and proven on the real daemon: a daemon with its services on a `sqlite:`
store registers its own `desktop` device row (`compose.ts` `registerDevice = services || ...`),
`GET /me` names it as `desktopDeviceId`, the settings screen sends that id, the registry's
policy checks it like any paired device, and the shell's install id is refused as an unknown
device with the card kept (`loop-routes.test.ts` "a solo daemon's own desktop device"). A
phone still needs the biometric and a web or runner device is still refused
(`security-commands.test.ts`, `security-command-actor.test.ts` green). What is wrong is around
the edges: the UI fake and one UI test prove a path the real daemon refuses, the status line
promises the same thing, the audit row of the id-less mapping says `allowed: true` whatever
happened, and the "foreign id" claim of the daemon test is only an unknown id.

Requirements checked:

- BLOCKERS P1 / J.3, Q.5: a high-risk change from the desktop app performs on a solo install:
  met (`loop-routes.test.ts` solo describe, composed with services on, `sqlite::memory:`).
- "register the desktop device row unconditionally (it needs no shared store)": met for the
  daemon (services on); one-shots and the cloud runner (`startServices: false`,
  `services/cloud-runner/src/runner.ts:397`) still register none, which is intended and tested.
- "expose its id on `GET /me`": met (`server.ts:483`, `api-types.ts` `HumanView.desktopDeviceId`).
- "`SettingsPage`/`ChangeCardDialog` send it": met; `SettingsPage` is the only caller of
  `confirmCommand` in `apps/ui/src` (`ChangeCardDialog.tsx` renders `CommandResult` and
  delegates the answer to the page).
- "a foreign id still refused": only partly proven (finding 4).
- "map a missing/`desktop` id to the daemon's own device for older shells with an audit note":
  built (`server.ts:1195-1216`); the audit note is inaccurate (finding 3).
- "the fake daemon refuses an unknown id like the real one; update every UI test that relied on
  the permissive fake": met for unknown ids; the fake is still more permissive than the real
  daemon when `/me` names no row, and it does not map `desktop` (findings 1, 2).
- Q.4 card shown and kept on refusal: met (`settings.test.tsx` refusal case keeps the pending card).
- Security-command tests (web or runner device needs the second factor): green
  (`packages/commands/test`, 18 files / 183 tests together with `services/cloud-runner/test`).
- Docs: apps.md, runtime.md, commands.md updated; apps.md repeats the wrong no-row claim
  (finding 1).
- Semantic conflict with the base: none found; the base moved from 049ed52 to b1804e3 (voice
  preferences, B.5 reasons, APK verifier), `git merge-tree --write-tree HEAD
  origin/ccr-4d8a843c-1k9syk` is clean and neither side touches the confirm route or the
  device registration.

Findings:

1. **medium**, `apps/ui/test/fake-daemon.ts:2023`, `apps/ui/test/settings.test.tsx:228`,
   `apps/ui/src/pages/SettingsPage.tsx:226` and `:460`, `docs/maintainers/apps.md:158`,
   `:251`, `:354`. When `/me` names no desktop row (`desktopDeviceId: null`), the fake answers an
   id-less device confirmation with its fixture row and performs the change, and the test
   "confirms without a device id when the daemon named none, and the fake answers for this PC
   like the daemon does" asserts that. The real daemon names null exactly when it has no row,
   and then refuses the id-less answer: verified with a throwaway test in the `core loop
   routes` describe (`startServices: false`, no row): `POST /commands/:id/confirm
   {answer:"device"}` answered `409 {"code":"conflict","message":"deviceId is required: this
   daemon has no desktop device row to answer for"}`. The settings status line says "no device
   row registered by the daemon: high-risk changes are confirmed as this PC", which is the same
   false promise, and the page comment ties the id-less answer to "an older daemon" (an older
   daemon requires `deviceId`, so it would refuse too). The real id-less case, `/me` not loaded
   or failed while the daemon has its row, has no UI test. Fix: the fake refuses an id-less
   answer when its `/me` names no row (409 `conflict` with the daemon's message); the status
   line says high-risk changes cannot be confirmed on this PC; the UI test for a null row
   expects the daemon's error and no change; a new UI test with `/me` failing posts the
   id-less answer and the change performs; comment and apps.md corrected.
   Resolution: fixed in 910a91b: the fake answers a null-row id-less confirmation with the daemon's 409 and message, the status line and comment say what happens, `settings.test.tsx` covers both the null row (refused, nothing changed) and `/me` not loaded (id-less answer performs), and apps.md says the same.

2. **low**, `apps/ui/test/fake-daemon.ts:2023`. The daemon route treats the literal `desktop`
   (what the old settings screen sent without an install id) as this PC (`server.ts:1195`); the
   fake refuses it as an unknown device, so the fake and the daemon disagree on a body the old
   UI really sent. Verified by reading both branches and by `client.test.ts`'s fake run (no
   case for `desktop`). Fix: the fake maps `desktop` like the route; a client test proves it.
   Resolution: fixed in 910a91b: the fake maps an id-less or `desktop` answer to its row (when `/me` names one), and `client.test.ts` confirms a high-risk change with `deviceId: "desktop"`.

3. **low**, `packages/runtime/src/daemon/server.ts:1203-1216`. The `daemon.confirm_device`
   audit row is appended before the confirmation runs, always `allowed: true`, so a mapped
   answer for a card that does not exist, has expired, or is refused (a revoked row) is logged
   as allowed. Verified with a throwaway assertion in the solo describe: `confirm("no-such-pending",
   {answer:"device"})` returned `refused` and the audit log gained a third
   `daemon.confirm_device` row with `allowed: true` and `pendingId: "no-such-pending"`. Fix: the
   route writes the row after the registry answered, `allowed` true only when the answer was
   accepted (done, partial or cancelled), else `denied_reason` the registry's code and reason,
   and the result summary names the outcome; the solo test asserts the refused case.
   Resolution: fixed in e76a3fc: the audit row is written after the registry's answer and carries its outcome (`allowed: false`, `denied_reason` `<code>: <reason>` with the registry's "no pending" reason for a card that does not exist), asserted in `loop-routes.test.ts`.

4. **low**, `packages/runtime/test/loop-routes.test.ts:909` and `:951`. The test name says "a
   foreign id is refused", but the only refused id is `install-uuid-of-shell`, an id with no
   row. A real foreign id (another human's `desktop` row on the same store, the shared-store case
   the brief names: "on a shared store the id never matches") is never sent through the route.
   Verified by reading the test; the policy branch ("the device belongs to someone else") is
   only covered by `packages/commands` unit tests, not by the route. Fix: register a second
   human with a desktop row on the solo store, confirm with that id through the route, expect
   `approval_required` "the device belongs to someone else", the card still pending and the cap
   unchanged.
   Resolution: fixed in e76a3fc: the solo test now sends another human's desktop row through the route and asserts the refusal, the card kept and the cap unchanged.

5. **low**, `packages/runtime/src/remote/presence.ts:69-75`, `server.ts:483`. Revoking this
   PC's own desktop row (`device.revoke`, itself confirmed on that row) leaves
   `rt.remote.device` holding the revoked row: `/me` keeps naming it and every later high-risk
   confirmation from the desktop is refused "this device was revoked" until the daemon restarts
   and registers a fresh row.
   Resolution: not a defect: refusing a revoked row is ADR 0030's revocation rule
   (`confirmation.ts:60-64`), the refusal names the reason, and a restart registering a new row
   for an install whose row was revoked is `registerDesktopDevice`'s existing contract on shared
   stores since ADR 0041 (presence.ts: a revoked row under the known key is skipped, a fresh one
   registered); the behaviour is now written down in runtime.md Known issues.
