# w2-email-page

Item: Settings -> Capabilities -> Email (spec S.15, S.28, S.29, T.14; ADR 0066): the daemon
mounts the capability's seven email routes with `humanFor` and `identity`, the page picks a
mode per agent, warns about full discretion, pauses from the tray and lists the command
audit. Built on `wave/w2-email-page`, merged on 2026-10-23 in `ca1cd50` (3 commits, 17 files,
+2592/-59) without a review. Reviewed on 2026-10-25 on the integration head
`ccr-af5a431d-jc9xqj` (`894b76d`), with the later merges in place (ADR 0081 and its amendment,
ADR 0082, ADR 0084, the audit export).

## Review

Verdict: **revise**. Score: **58**.

What was checked: the brief (`briefs/w2-email-page.md`) clause by clause against the code on
the current head; the seven routes (`packages/capabilities/src/email/routes.ts`, mounted in
`packages/runtime/src/daemon/server.ts:507-531`), the five modes, the caps, the marker, pause
and resume from the tray (`apps/desktop/src-tauri/src/actions.rs:481-601`), the command audit
newest first (`emailCommandAudit`, `packages/capabilities/src/email/commands.ts:1290-1310`), the
page (`apps/ui/src/pages/EmailSettingsPage.tsx`) and its fake daemon; the tests of the item
run green on the head (`email-routes-wiring.test.ts` 8, `email-routes.test.ts` 5,
`security-email-routes-identity.test.ts` 5, `apps/ui` 388). Mutation checks: dropping the
`out.reverse()` of `emailCommandAudit` fails `email-commands.test.ts` "the command audit is
queryable, newest first" and the wiring test "GET sent lists ... newest first" (the "newest
first" claim is proved, and `AuditLogRepo.list` has no default limit, so the reverse-then-slice
is the newest rows, not the newest of a page). Every send path (the tools, the handler's
acknowledgement and completion, the notifier's channel, the digest, an approval resolved by
reply) runs `EmailPolicy.checkSend`, whose `paused` branch precedes `deliver`, so a paused
agent sends through no path. The owner check holds on all seven routes (403 `not_owner`, the
audited refusal of ADR 0084) and the daemon passes both ports. No mailbox value reaches a
response, a row or a log: the schema refuses values, the `email.settings` rows carry key
names only, the marker is shown to its owner alone. What follows is what is wrong.

1. **[HIGH] A mode change from the page skips the confirmation its risk class requires, the
   change log and the undo; the raw `PUT` lets any token holder do the same.**
   `apps/ui/src/pages/EmailSettingsPage.tsx:180` (`ModePicker.save`) sends `PUT
   /agents/:agentId/email/settings { settings: { mode } }`, which the capability applies at
   once (`routes.ts:239-262`). The spec's "Confirmation by risk" table
   (`docs/spec/forerunner-spec.md:558`) puts "change email mode" in the High row: a change
   card, then confirmation in the app on a paired device; the registry's `email.mode.set` is
   `risk: "high"` (`packages/commands/src/commands/email.ts:158`), `needs_device`
   (`packages/commands/src/confirmation.ts:35`), and the phase 5 gate row "Every settings
   change can be made by voice, chat or the UI, and each produces the same change log entry"
   (`docs/status/gates.md:88`) was closed on exactly that: the email mode `needs_device` on all
   three channels, one change log entry, undo. On the page, off, read only, draft only and
   allowlist apply on a click with no confirmation at all; full discretion gets a browser
   dialog (no device, a tap is enough); none writes a change log row or offers Undo
   (`GET /changes` does not list it). The daemon side is the root: the `PUT` is served to the
   daemon's bearer (the phone's and the web's device tokens included) with no card, so a
   client that skips the dialog sets full discretion unconfirmed. Verified: the UI test
   `email-settings.test.tsx:133` "any other mode applies without a confirmation" and the
   wiring test `email-routes-wiring.test.ts:165` "PUT settings picks the mode" assert the
   bypass; the `PUT` handler (`routes.ts:246-258`) writes one `email.settings` audit row and
   never touches the registry or the change log, so `GET /changes` cannot list it. ADR 0066
   point 5 decided this on the premise "the registry's `settings.set` has no email key",
   which already overlooked `email.mode.set` (in the registry since the phase 5 gate,
   2026-10-20) and is doubly stale since ADR 0081's amendment wired that command to the
   capability's settings store. Smallest correct fix: the page runs `email.mode.set` through
   `POST /commands/execute` (the card, the device confirmation, the change log row, Undo),
   keeping the S.29 sentence under the option and in the confirmation dialog; the daemon's
   mount tells the route table that a mode change is the registry's (`modeChangeCommand:
   "email.mode.set"`), so a `PUT` whose `settings.mode` differs from the stored mode is a 400
   `validation` naming the command and nothing is written; ADR 0066 amended.

   Resolution: fixed in 184fb4e (the daemon side: `EmailRouteDeps.modeChangeCommand`, the
   daemon passing `"email.mode.set"`, a `PUT` that would change the mode answered 403
   `tool_not_allowed` with `reason: "mode_change_needs_command"` rather than the 400 proposed
   above, since the route refuses to apply a change its risk class forbids here, as an
   audited refusal with nothing written; `email-routes.test.ts` "with modeChangeCommand a PUT
   that changes the mode is refused" and `email-routes-wiring.test.ts` "PUT refuses a mode
   change and names email.mode.set", both failing without the option) and 656eebd (the page:
   Apply runs `email.mode.set` through `POST /commands/execute`, the dialog hosts the card
   with the S.29 sentence repeated, No cancels the card, the device answer sets the mode with
   the change log row and Undo, the fake daemon refuses a mode in a PUT; four cases of
   `email-settings.test.tsx` fail against the old page; ADR 0066 amended 2026-10-25).

2. **[HIGH] `email.mode.set` changes another human's agent.**
   `packages/commands/src/commands/email.ts:44` (`agentOf`): with `params.agent` set the
   command resolves `ctx.store.agent.get(p.agent)` and never compares `owner_human_id` with
   `ctx.humanId` (`memory.ts:85`, `model-settings.ts:95` and `device.ts:20` do). Through the
   daemon's `POST /commands/execute { commands: [{ name: "email.mode.set", params: { mode:
   "full_discretion", agent: <Bob's agent id> } }] }` and a device answer of their own, this
   install's human sets Bob's agent to full discretion; with `ports.emailMode` wired the write
   goes through `EmailSettingsStore.update`, which has no owner check either. Verified with a
   throwaway daemon test (composed runtime, a second human with a principal; the execute
   answered `pending`, the confirm `done`, and Bob's settings row read `mode:
   "full_discretion"`). The routes' owner check (S.15; the cross-human write of the
   2026-10-20/21 security review, ADR 0084) is thereby open again one door over, and the fix
   of finding 1 routes the page through this very command with `agent: agent.id`, so it must
   hold first. Smallest correct fix: `agentOf` refuses an agent whose `owner_human_id` is not
   `ctx.humanId` with `ForerunnerError("tool_not_allowed")` (plan, run and undo), tested in
   `packages/commands/test/commands.test.ts` and through the daemon in
   `email-routes-wiring.test.ts`.

   Resolution: fixed in df19c21: `ownAgent` refuses an agent whose `owner_human_id` is not the
   human's on plan, run and undo (`tool_not_allowed`, "not yours"); a name stays a lookup
   among the human's own agents, so another's agent by name is `not_found` (the test's first
   draft expected `tool_not_allowed` there and was corrected: the scoped lookup reveals
   nothing, which is right). `commands.test.ts` "email.mode.set refuses another human's agent"
   (the plan resolved before the fix) and the wiring test's "refuses another human's agent"
   now also through `email.mode.set`.

3. **[MEDIUM] Saving the mailbox form resets `secure`, `folder` and `draftsFolder` to the
   schema defaults.** `EmailSettingsPage.tsx:498-530` (`MailboxForm.submit`) sends `imap: {
   host, port, user, passwordRef }` and `smtp: { host, port, user, passwordRef }`;
   `mergeEmailConfig` (`packages/capabilities/src/email/types.ts:236-258`) replaces `mailbox`
   whole (only `allowlist` and `signature` merge one level deep), so `ImapConfigSchema`'s
   `secure: true`, `folder: "INBOX"`, `draftsFolder: "Drafts"` and `SmtpConfigSchema`'s
   `secure: false` overwrite whatever was stored. An SMTP configured `secure: true` on 465 (by
   the API, a script or the runner's setup) is saved back as `secure: false` on 465 when the
   owner only corrects a password reference, and the next send fails its TLS handshake; a
   mailbox watched in a dedicated folder is watched in INBOX. Verified with a throwaway test
   over `mergeEmailConfig` (stored `smtp.secure: true`, `imap.folder: "Agent"` -> after the
   page-shaped patch `secure: false`, `folder: "INBOX"`). Smallest correct fix: the form
   carries the stored values it has no field for (spread the stored `imap`/`smtp` under the
   fields), with a UI test that the PUT body keeps them.

   Resolution: fixed in 656eebd: `MailboxForm.submit` spreads the stored `imap` and `smtp`
   under the fields; `email-settings.test.tsx` "saving the mailbox keeps the stored secure,
   folder and drafts-folder values" (IMAP without TLS in a dedicated folder, SMTP over TLS on
   465, one reference changed; the PUT body and the fake's state keep all three; fails
   without the fix with the defaults in the body).

4. **[LOW] The tray's pause state goes stale after a pause or resume made elsewhere.**
   `probe_email` (`apps/desktop/src-tauri/src/actions.rs:501`) runs at start and when the
   daemon becomes reachable again (`events.rs:229`); nothing refreshes `email.paused` after
   the page or the phone flips it, and the daemon's pause and resume routes emit no `/events`
   frame. The tray then shows "Pause email" while sends are held (or "Resume email" while they
   are not), and the tooltip omits "email paused". A click still does the right thing (the
   routes are idempotent and the answer resyncs the state); no send goes out that should not.
   Smallest correct fix: the daemon emits an `email.paused` frame on `/events` after the two
   routes (and after a `PUT` that sets `paused`), the shell parses it in `sse.rs` and applies
   it in `events.rs` the way `desktop.indicator` is applied.

   Resolution: open (verified again on the current head: `probe_email` has two callers,
   `actions.rs:231` at start and `events.rs:229` on the reachable transition; no frame carries
   `paused`). Not fixed here: the fix is a daemon frame plus a shell change in
   `apps/desktop/src-tauri` with its `cargo test`, a cold Tauri build on a machine shared by
   several agents, out of proportion to a low finding whose click is idempotent. Recorded in
   apps.md's desktop Known issues (replacing the stale line of finding 6) and as a BLOCKERS
   line for a follow-up.

5. **[LOW] `GET /agents/:agentId/email/sent?since=` is passed to the store unparsed.**
   `routes.ts:268`: any string is compared with `occurred_at` as text and echoed back in the
   body, so `since=0` lists every copy ever written and `since=tomorrow` lists nothing with
   `since: "tomorrow"` in the answer. Not an injection (the repo binds it as a parameter);
   wrong output on a mistyped query. Smallest correct fix: parse it as a date and fall back to
   the seven-day default (echoing the value used), with a route test.

   Resolution: fixed in 2e297e6: `isoInstantQuery` accepts an ISO-8601 date-time only (V8's
   `Date.parse("0")` is the year 2000, so a shape check precedes the parse) and normalises
   it; `email-routes.test.ts` "GET sent returns the agent's sent log newest first" now covers
   `tomorrow`, `0` (the default, echoed) and a valid instant (honoured); the `emailSent`
   route description says so.

6. **[LOW] Docs and the ADR disagree with the code.** `docs/maintainers/apps.md:1003` (the
   desktop shell's Known issues) still says the daemon does not mount the email routes and the
   tray item reads "not available"; `apps.md:154-158` ("Commands from the UI") and
   `docs/maintainers/email.md:509-511` say the registry has no email setting and that an
   `email.mode` command is a later change, while `email.mode.set` exists and is wired
   (ADR 0081 amendment); ADR 0066 point 5 and its first alternative rest on the same false
   premise; `routes.ts:5` says the orchestrator does `createEmailRoutes(deps, new Hono())`
   while the daemon iterates `emailRouteTable`. Fix with finding 1: the sentences follow the
   code, ADR 0066 gets a dated amendment.

   Resolution: fixed in 184fb4e (`routes.ts` header, email.md's routes row, wiring paragraph
   and Known issues, runtime.md's mount and test paragraphs) and 656eebd (apps.md's page row,
   "Commands from the UI" paragraph and test list; the desktop Known-issues line replaced by
   finding 4's; ADR 0066 amendment dated 2026-10-25); commands.md's `email.mode.set` row in
   df19c21.

Not defects, checked and kept: the command audit and the sent log are newest first on the
full window (no default limit in `AuditLogRepo.list`); the owner check and its audited
refusal on every route; the pause flag on every send path; the marker and the credentials
stay out of responses, rows and logs; the five modes and their meanings on the page; the
route-unavailable state per card; the daemon's `humanFor` is the install's one human per
ADR 0082.
