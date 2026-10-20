# 0038 — Daemon wiring of notifications and Cloudflare deploys

Date: 2026-10-20
Status: accepted

## Context

The notification module (ADR 0017, `packages/runtime/src/notifications`) and the Cloudflare
capability (ADR 0035, `packages/capabilities/src/cloudflare`) were built and reviewed as modules
with ports. Putting them into the one process the shells attach to (`composeRuntime`, ADR 0029)
left points open that neither module's doc decides: which real sources produce notifications and
where the hooks attach; how the desktop channel knows a shell is attached and whether the OS
notifier may run when none is (also during tests, which compose the whole runtime); where the
Telegram and Signal configuration lives; whether a preference write goes through the command
registry; how the agent mailbox becomes the email sender; how the Cloudflare tools reach the
hooks and the extension gate; and how routes written against a structural app surface are
mounted on the daemon's Hono app.

## Decision

1. **One notifier per runtime, on `RuntimeApp`.** `composeRuntime` builds the channels in the
   fallback order of ADR 0017 and exposes `notifier` and the bound producer hooks
   (`notifications`). The desktop channel exists only when the background services run
   (`startServices !== false`): a CLI one-shot or the cloud runner has no shell and no desktop.
   Telegram and Signal are always constructed and report "not configured" until the human's
   address (a preference) and, for Signal, the sender account (configuration) exist; the
   Telegram token stays a secret reference resolved through the vault at send time. The
   composition also checks that the token *exists* (`vault.has`, never the value) before every
   read of the human (`SecretCheckedChannel` in `wiring/notification-ports.ts`), so a chat id
   without a stored token reads "bot token not set" in the settings view and the channel is
   skipped rather than failing each send before the fallback.
2. **Producers attach to the real sources, not to the modules' internals.**
   - Every human request this human receives, whatever filed it (the hooks' `StateApprovals`,
     the extension registry, the mirror, the Cloudflare deployer, the critic's blocked-findings
     path, the updater), is one `insert` on `store.humanRequest`. The composition wraps that
     method once; a blocking request is urgent, the rest normal (ADR 0017), and the same wrap
     emits `inbox` on the runtime bus so an attached UI refreshes.
   - Session end: `startSession` awaits the runner's `SessionResult` and reports status, stop
     reason, counts and summary; a budget stop becomes the urgent `budget_stop` in the producer.
   - Kill switch: `KillSwitch.onStop` now passes the reason given to `stop()` with the report.
   - Update applied or rolled back: the restarter's `restart` event (emitted before the exit
     delay; delivery is best effort because the process is going down).
   - Critic escalations that filed no request of their own (`critic.verdict` or
     `critic.session_review` with `escalation: true` and no `humanRequestId`) come off the
     session bus and are raised to normal so they do not wait for the digest. The bus event
     carries no session id; the review row `reviewId` names does, so the composition reads it
     and the delivery is logged on that session like the session-end one.
   - Not wired in this change: `peerMessage` (messages to the human arrive through the state
     service, which has no insert hook in the daemon), `emailCommandReceived` (the command
     handler runs on the cloud runner) and `injectionFlagged` (the loop's injection event is a
     session event without a producer call yet). Listed as known issues in `runtime.md`.
3. **"A shell is attached" means an `/events` stream that shows the toast.** Every open
   stream receives the `notification` frame, but only the desktop sidecar turns it into an OS
   notification (ADR 0031); the React UI's own EventSource (inbox counts), the phone's web
   view and a browser tab show nothing. Counting listeners (the first version of this point)
   therefore recorded an urgent notification as delivered while nothing was shown whenever only
   those were open. The daemon now counts shells (`daemon/shells.ts`, `rt.shells`): a stream
   that declares `?client=shell` or `X-Forerunner-Client: shell` is one, a stream that declares
   anything else is not, and an undeclared stream counts only when its bearer token came in
   the `Authorization` header, which no browser EventSource can send; that last rule keeps
   today's desktop shell counted until it declares itself, after which it can go. The desktop
   channel's `shellsConnected` is that count. With no shell attached the channel falls back to the
   OS notifier only when `osNotifierEnabled`: on for a set-up install (a `config.json` exists),
   `FORERUNNER_OS_NOTIFY=0` turns it off and `FORERUNNER_OS_NOTIFY=1` on; tests pass
   `notifications.osNotifier`. A composition with `config: null` therefore never spawns
   `notify-send` or PowerShell, and `DesktopChannel` gained `osFallback: false` for that case.
4. **Channel configuration lives in `config.json` under `notifications`** (`signalAccount`,
   `telegramTokenRef`, `telegramApiBase`), each overridable by `FORERUNNER_SIGNAL_ACCOUNT`,
   `FORERUNNER_TELEGRAM_TOKEN_REF`, `FORERUNNER_TELEGRAM_API_BASE`. A malformed value falls
   back to the default (a token value in place of a reference is refused, never stored). The
   per-human addresses are preferences in `human.notify_prefs`, not configuration.
5. **Preferences are settings, not limits.** `PUT /notifications/prefs` is a plain settings
   write with one `audit_log` row (`notify.prefs`) naming the keys that changed and never their
   values. Quiet hours, the digest time, chat ids and channel lists change neither spend, nor
   autonomy, nor what an agent may do, so they do not go through the command registry's change
   cards (ADR 0030); the natural-language `settings.set notify_channel` writes the same JSON.
6. **The email sender is the agent's own mailbox under the email policy.** At compose the
   agent's email settings row (`email:<agentId>`) is read; with a mailbox configured the
   channel's port opens `ImapSmtpMailbox` lazily and every send goes through `EmailPolicy.send`
   as the agent (`kind: "send"`), so the mode gate, the content rules, the caps and the sent log
   apply exactly as for any other outbound mail; a notification to the human's address passes
   in every mode but `off`. Any outcome other than `sent` is a channel failure and the notifier
   falls back. A mailbox configured later takes effect at the next daemon start (known issue).
7. **Cloudflare tools are built-in tools of the daemon.** `registerCloudflareTools` adds the
   four tools to the daemon's `ToolRegistry` at compose, with `store.project`, the vault,
   `HumanRequestCloudflareApprovals` over `store.humanRequest`, `store.auditLog` and the
   composition's `fetchImpl`. Every run token lists them with the other built-in tools, so the
   daemon's hooks (token allowlist, path fields, action classes, autonomy with `human_request`
   approvals, audit) and the extension gate apply as to any tool. The catalog entry
   `cloudflare` names exactly `cloudflare_plan`, `cloudflare_deploy`, `cloudflare_dns_upsert`,
   `cloudflare_verify_token` with the classes `read`, `deploy_staging`, `deploy_production`,
   because the gate checks a tool's name and class against the installed row's permissions;
   before the extension is installed the tools are governed by the hooks alone (the registry's
   tool index is built from installed rows). The token is resolved by the deployer from the
   vault by reference (`settings.cloudflare.secret_ref`), never through the run's granted
   secrets, and the run's domain allowlist is unchanged (ADR 0035 point 6).
8. **Structural routes are adapted, not retyped.** `cloudflareRoutes()` returns handlers over
   `{ req.param, json }`; `server.ts` mounts each with a two-line adapter over Hono's context.
   The capabilities package keeps no dependency on Hono. The notification routes are a Hono
   sub-app mounted at the root like the extensions and updates routes. Both sets are listed in
   `DAEMON_ROUTES`, and `/events` gained the `notification` frame (ADR 0031 point 2).

## Consequences

- A human is told about every request as it opens, woken for blocking ones, and gets the
  night's session summaries in the morning (scenario 1) without any module knowing which other
  module filed the request.
- `pnpm test` never shows an OS toast; a developer who runs `fr daemon` without `fr setup` gets
  none either unless `FORERUNNER_OS_NOTIFY=1`.
- Adding a producer is one call on `RuntimeApp.notifications` from the place the fact is known;
  adding a channel follows `notifications.md` plus one constructor line in `compose.ts`.
- The desktop shell shows toasts from today's daemon with no change on its side.
- A Cloudflare deploy from a session is approved through the inbox like any other action, and
  the Extensions panel can show the token's real scopes through the daemon.

## Alternatives considered

- A notifications table with a repository hook instead of wrapping `humanRequest.insert`: a
  schema change for a queue ADR 0017 already keeps in memory for 1.0; rejected for now.
- Routing preference writes through the command registry: the registry exists for changes that
  spend, widen or stop; a quiet-hours window is none of these.
- Probing `notify-send` in every composition: spawns processes in every test that composes the
  runtime and shows toasts on a developer's desktop during `pnpm test`; rejected.
- Registering the Cloudflare tools per run (`toolsForRun`) instead of at compose: the
  specialist registry loader needs the tool names at compose, and a run's token must list them.
- Making the capabilities package depend on Hono to mount its routes directly: the structural
  interface was chosen so capability modules stay framework-free (email routes do the same).
