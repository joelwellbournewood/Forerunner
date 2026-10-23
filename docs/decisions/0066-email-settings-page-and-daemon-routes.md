# 0066 — Settings -> Capabilities -> Email: the capability's routes on the daemon, a page per agent, the full-discretion confirmation as the page's own step, the command audit read from the shared state

Date: 2026-10-23
Status: accepted

## Context

Spec S.15 says the human picks an email mode per agent in Settings -> Capabilities -> Email,
S.29 that full discretion is available and that the setup screen explains plainly that the
agent can then email strangers on the human's behalf, S.28 that the tray pauses email with one
click, and T.14 that every email command, its interpretation and its result are logged
together and visible in the app. The capability had the seven routes as a table
(`emailRouteTable`, `packages/capabilities/src/email/routes.ts`), the settings store, the
modes, the caps, the marker and the audit rows, all tested; but the daemon mounted none of the
routes, the tray's click ended in "Email pause failed", and `apps/ui` had no page. Open
points: where the page lives in the UI's route tree, whether a mode change goes through the
command registry's change card (the settings screen's path, ADR 0037 point 4) or the
capability's own route, how the full-discretion sentence is shown, which agents the page
lists, where the daemon gets the command audit from when the handler that writes it runs on
the cloud runner, and how the browser validates a shape that lives in a module it cannot
import.

## Decision

1. **The daemon mounts the capability's table.** `server.ts` iterates `emailRouteTable()` and
   adapts each handler to Hono's context, the way the desktop control routes are mounted,
   with `humanFor: () => rt.human.id` (the daemon's single human) and
   `identity: rt.capabilities.email.ports.identity`, so the owner check is in force: another
   human's agent on a shared state, and an unknown agent id, answer 403 `tool_not_allowed`
   before any read or write. `audit: rt.store.auditLog` records every change as an
   `email.settings` row by the daemon's human. The routes are listed in `DAEMON_ROUTES`
   (`emailSettings`, `updateEmailSettings`, `emailSent`, `pauseEmail`, `resumeEmail`,
   `rotateEmailMarker`, `emailCommands`); the tray's two routes are now served.
2. **The command audit is a reader over the audit log.** `emailCommandAudit({ auditLog,
   clock })` in `commands.ts` is the handler's `commandAudit` extracted: the handler delegates
   to it, and the daemon passes it as the routes' `commandAudit` without constructing an
   `EmailCommandHandler` (which needs the classifier, the cloud-session port and the mailbox).
   The rows are written by the runner that watches the mailbox and reach the daemon through
   the shared state.
3. **The contract lives in `api-types.ts`.** `EmailSettingsView`, `EmailSettingsPatchBody`,
   `EmailSentView`, `EmailCommandsView`, `EmailPausedView` and `EmailMarkerView` are the
   daemon's browser-safe copy of the capability's schemas (`AgentEmailConfigSchema` pulls
   `@forerunner/platform`), lenient where the capability validates (plain strings for
   addresses, domains, references and the marker) and never narrower.
   `packages/runtime/test/email-routes-wiring.test.ts` parses the daemon's answer with both
   and compares the key sets of `settings` and `commands`, so drift fails there before a
   screen. The UI imports the views from `@forerunner/runtime/daemon/api-types` like every
   other route's and keeps no mirror of its own.
4. **The page is `/settings/capabilities/email`,** reached from a "Capabilities" section on the
   Settings page (the spec's path, spelled out as a breadcrumb), one card per agent whose
   `ownerHumanId` is the signed-in human's (`GET /agents` filtered by `/me`), the principal
   first. Other humans' agents are not listed: the daemon would refuse them.
5. **A mode change goes through the capability's own `PUT`, not the command registry.** The
   registry's `settings.set` has no email key, the email routes already audit every change
   with the mode before and after, and the policy reads the row on the very next send, so the
   change is enforced and logged without a change-card round trip. The page therefore does
   not post `POST /commands/execute` for email. The one confirmation the spec asks for is
   the page's own step: the full-discretion sentence ("the agent can email strangers on your
   behalf …") is shown under the option before any change and repeated in a dialog that the
   human must answer with "Yes, let it email anyone on my behalf" before the `PUT` is sent;
   cancel sends nothing. Every other mode applies at once. Caps, signature, digest, the
   allowlist (shown only in allowlist mode), the mailbox (credentials as `secret:<name>`
   references; a value is the daemon's 400, shown as such) and the command settings are
   small forms over the same `PUT`; pause and resume, and the marker rotation, are their
   routes.
6. **Error bodies.** The capability routes answer `{ error: { code, message, details } }`
   where the daemon's own routes answer the body flat. The UI client reads both as a typed
   `ApiError`, so a 403 from the email routes shows the route's sentence, never "rejected the
   token".

## Consequences

- S.15, S.28, S.29 and T.14 are reachable end to end: the tray's click flips
  `settings.paused` and the next send through the policy is held
  (`email-routes-wiring.test.ts`); the page's picker, warning, pause, audit list and
  route-unavailable state are tested in `apps/ui/test/email-settings.test.tsx`.
- An email mode change is not a change-log row and has no `Undo`: its record is the
  `email.settings` audit row (and the sent copies that follow). Wrapping the `PUT` in an
  `email.mode` registry command, with a card and undo, is a later change to
  `packages/commands` that would keep the page's confirmation as the card's text.
- The daemon's single human is the signed-in human on every route; a daemon that one day
  identifies several humans per request passes the request's human instead of `rt.human.id`.
- The page lists the sent copies (S.26) beside the audit because the route exists and the
  spec's "copy visible to the owner" had no screen; the daily digest is still the scheduler's.

## Alternatives considered

- **Routing the mode change through `settings.set` and the change card.** Rejected for now:
  the registry has no email setting, the capability already audits and enforces the change,
  and the spec's confirmation is a sentence the human must read, which the page shows twice;
  the registry path stays open as the follow-up above.
- **A mirror of the email schema in `apps/ui/src/api/contracts.ts`** with the drift test in the
  UI, as ADR 0037 does for extensions and updates. Rejected: the UI package cannot resolve
  `@forerunner/capabilities` and adding the dependency is a lockfile change; the daemon's
  contract file is the right home for a shape the daemon serves, and the runtime test can
  import both sides.
- **Constructing an `EmailCommandHandler` in the daemon** for `commandAudit`. Rejected: the
  handler is the runner's and needs ports the daemon has no reason to build; the audit is a
  read over the audit log.
- **Listing every agent on the state, with the daemon's 403 per card.** Rejected: a card that
  can only say "not yours" is noise; the page lists what the daemon would let its human read.
