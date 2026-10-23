# Notifications

Desktop, email, Telegram and Signal notifications with quiet hours, a daily digest, dedupe,
retry and channel fallback, plus urgent alerts read aloud (the `voice` channel, ADR 0063). Code: `packages/runtime/src/notifications/` (exported from
`src/notifications/index.ts` and the package root). ADR 0017 records the channel fallback order
and what counts as urgent; ADR 0031 records the SSE event shape the desktop shell shows as a
toast; ADR 0038 records how the daemon wires the module. The wiring itself lives in
`src/daemon/compose.ts` (channels, notifier, producers), `src/daemon/server.ts` (routes, the
`notification` SSE frame), `src/wiring/notification-ports.ts` (the audited preference writes and
the email sender over the agent email capability) and `src/notifications/config.ts` (the
channel configuration); see "Wiring" below and `runtime.md`, "Notifications".

## Purpose

Spec build order phase 5: "Notifications: desktop, email, Telegram or Signal, quiet hours."
Module K QoL: "desktop notifications, tray menu." Module R: "Push for approvals, finished
sessions, budget warnings and messages, with quiet hours." Module E: "Session end: ... notify
human." Module O: "the answer comes back through the inbox or a notification." Module J: human
requests arrive in one inbox and the human learns about them. Scenario 1: "a summary and
questions arrive by morning."

Requirement IDs covered (`docs/requirements.md`): **R.6** (the notification system itself:
approvals, finished sessions, budget warnings, messages, quiet hours), **K.8** (the "desktop
notifications" clause; the tray menu is the shell's, ADR 0031), **E.5** (the "notify human"
clause, through `producers.sessionEnded`), **O.8** (the "or a notification" clause, through
`producers.peerMessage` and `producers.requestOpened`), **J.3** (the human is told when a
request opens and whether it blocks), **S.8** (the human is told what the kill switch stopped),
**F.2** (`requires_ack` messages to a human raise a `peer_message`), **U.2** (the human's
`notify_prefs` column holds the preferences).

Every rule is enforced in code, never by prompt text: an unknown human is
`ForerunnerError("not_found")`, a malformed notification or preference patch is
`ForerunnerError("validation")`, quiet hours and the digest are decided by `isQuietAt` and
`digestState` on the `Clock`, and a kind whose channel list is empty is never sent. Every
delivery attempt appends an `audit_log` row (`tool: notify.<channel>`), and a notification that
names a session appends a `notification` event to that session's log.

## How it works

### Kinds and urgency (`types.ts`)

| Kind | Default urgency | Raised by | Deep link |
| --- | --- | --- | --- |
| `request_opened` | normal | `producers.requestOpened` for a non-blocking human request | `/inbox` |
| `request_blocking` | **urgent** | `producers.requestOpened` when `blocking` is true | `/inbox` |
| `session_ended` | normal | `producers.sessionEnded` from the session runner | `/sessions/<id>` |
| `budget_stop` | **urgent** | `producers.sessionEnded` when `stopReason === "budget_exceeded"` (or `producers.budgetStop`) | `/sessions/<id>` |
| `critic_verdict` | info (`escalate` and `human` verdicts: normal) | `producers.criticVerdict` | `/projects/<id>/reviews` or `/inbox` |
| `injection_flagged` | **urgent** | `producers.injectionFlagged` with an `InjectionReport` | `/sessions/<id>` or `/inbox` |
| `update_available` | info | `producers.updateAvailable` from the updater | `/settings` (the UI's `/updates` page once the shell lists that root) |
| `email_command_received` | normal | `producers.emailCommandReceived` from the email command handler | `/inbox` |
| `peer_message` | info (`requires_ack`, question, request, warning: normal) | `producers.peerMessage` from the inbox | `/inbox` |
| `kill_switch` | **urgent** | `producers.killSwitch` with the `KillReport` | `/sessions/<id>` when one session was stopped, else `/` |
| `daily_digest` | normal | the notifier itself (and `POST /notifications/test`) | `/inbox` |
| `critic_calibration` | normal | `producers.criticCalibration` from the monthly calibration job (ADR 0060): catch rate, pass rate, gate and drift; a failed run names its reason | `/sessions/<id>` or `/inbox` |
| `handover_report` | normal | `producers.handoverReport` from the monthly handover job (ADR 0060): stuck places, the docs task, the session's end | `/sessions/<id>` |

`urgencyOf(n)` is the kind's default raised (never lowered) by `n.urgency`. The four urgent
kinds (`URGENT_KINDS`) always go through: quiet hours do not hold them and the digest never
bundles them (ADR 0017). `normal` kinds are sent at once outside quiet hours and held inside
them. `info` kinds are bundled into the daily digest when one is configured, else sent like
`normal`.

A `Notification` is `{ kind, humanId, title, body, link, projectId?, sessionId?, dedupeKey,
urgency? }`. `link` is a UI route path (`/inbox`, `/sessions/<id>`, ...); channels that leave
the app turn it into `fr://<route>` (`deepLinkFor`, ADR 0031 point 7; `/` becomes `fr://open`).
A link must be a route the desktop shell opens (`/` or the roots in
`apps/desktop/src-tauri/src/deeplink.rs`: `inbox`, `projects/<id>[/<tab>]`, `sessions/<id>`,
`settings`, `memory`, `extensions`), otherwise the toast arrives without a route and the
`fr://` link is refused; a test mirrors that rule over every producer. `dedupeKey` is what makes
two notifications "the same" (`request:<id>`, `session:<id>:ended`, `update:<version>`, ...).

### Preferences (`prefs.ts`)

Stored as JSON in `human.notify_prefs`. Every field has a default, so `{}` is valid. Other
modules keep their own keys in the same object (the cloud runner's unlock setting, for example):
`readPrefs` validates each known key on its own and falls back to the default when a value is
malformed, `writePrefs` merges a validated patch and keeps every key it does not own.

```json
{
  "channels": { "budget_stop": ["telegram", "desktop"], "critic_verdict": [] },
  "quiet_hours": { "start": "22:00", "end": "07:00" },
  "timezone": null,
  "digest_time": "08:00",
  "telegram_chat_id": "123456789",
  "signal_number": "+41790000000",
  "email": null,
  "notify_channel": "desktop",
  "voice_alerts": false
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `channels` | Per kind, the enabled channels in preference order. Absent kind: the defaults below. Empty list: the kind is never sent (`no_channel`). | `{}` |
| `quiet_hours` | Local wall-clock window `HH:MM`–`HH:MM`; may span midnight; `start === end` means none. | `null` |
| `timezone` | IANA zone for quiet hours and the digest. `null` uses `human.timezone`; an unknown zone falls back to UTC. | `null` |
| `digest_time` | `HH:MM` local time of the daily digest; `null` disables the digest (info items go out at once). | `null` |
| `telegram_chat_id` | The chat the bot writes to. | `null` |
| `signal_number` | The human's own Signal number (recipient), E.164. | `null` |
| `email` | Address for the email channel; `null` uses `human.email`. | `null` |
| `notify_channel` | The single preferred channel the natural-language settings command writes; `"push"` is the Android client and currently means desktop first; `"voice"` is ignored by the chain (voice announces, below). | `null` |
| `voice_alerts` | Urgent notifications are read aloud through the voice provider on top of the toast while a desktop shell is attached and outside quiet hours (ADR 0063). Also the `voice_alerts` key of `settings.set` ("turn voice alerts on" in chat, the settings screen). | `false` |

`NotificationPrefsPatch` (zod, strict) is what `PUT /notifications/prefs` and
`Notifier.setPrefs` accept: unknown keys, `8:00`, an unknown zone, a non-E.164 number or a bad
address are refused with `validation`.

`channelsFor(kind, prefs)` gives the ordered channels of the fallback chain: the explicit
per-kind list when set, otherwise the preferred channel (`notify_channel`; desktop when unset
or `"push"`) followed by the rest in `CHANNEL_NAMES` order `desktop, telegram, signal, email`
(ADR 0017). `voice` is the fifth name but never a step of the chain (`CHAIN_CHANNELS`): it
announces (ADR 0063) and is dropped from lists and from `notify_channel`.

### Quiet hours and time zones

`isQuietAt(quiet, timezone, nowMs)` and `digestState(digestTime, timezone, nowMs)` use
`localParts` from `session/triggers.ts` (the scheduler's own wall-clock helper), so there is one
time-zone implementation in the runtime. Nothing in this module calls `Date.now()`; the
`Notifier` takes a `Clock`.

### The notifier (`notifier.ts`)

`new Notifier({ clock, channels, humans, audit, events?, emitter?, retry?, dedupeWindowMs?,
recentLimit? })`. `humans` is `HumanRepo` (`get`, `patch`), `audit` is `AuditLogRepo`,
`events` is `EventRepo` (optional; a fake in tests).

`notify(n)` resolves with a `NotificationRecord` `{ id, notification, urgency, outcome,
heldFor, deliveries, createdAt, resolvedAt }` once the notification is delivered, held, bundled
or deduped:

1. **Validate**: `humanId`, non-blank `title` and `dedupeKey` are required; the human must
   exist.
2. **Dedupe**: the same `(humanId, dedupeKey)` within `dedupeWindowMs` (default 10 minutes) is
   `outcome: "deduped"` and nothing is sent. The window is reserved here (a concurrent
   duplicate is deduped) and released again by the dispatch when nothing was delivered
   (`failed`, `no_channel`), so only a delivered or still held notification occupies it and a
   producer may re-send one that did not reach the human (ADR 0017 point 5).
3. **Route by urgency**: urgent → dispatched now; info with a `digest_time` → `heldFor:
   "digest"`; otherwise inside quiet hours → `heldFor: "quiet_hours"`; otherwise dispatched now.
4. **Dispatch**: the channels from `channelsFor` in order. A channel whose `configured(ctx)`
   returns a reason, or whose `accepts(n, ctx)` declines this one notification, is recorded as
   `skipped` (attempts 0) and not tried. A tried channel gets
   up to `retry.attempts` attempts (default 3) with exponential backoff on the clock
   (`baseMs` 500 doubling, capped at `maxMs` 5000); a `retryable: false` answer ends the
   attempts at once (`status: "unavailable"`). The first `delivered` stops the loop.
5. **Announce** (ADR 0063): for an `urgent` record, after the chain, every announcing channel
   (`Channel.announce`, today `voice`) that is configured for the human runs on top of the
   chain's delivery and never ends it: `accepts` declining is a `skipped` row with the
   reason, else one attempt sequence and its audit row. Off for the human means no row.
   Outcome: `delivered` (any row delivered, the announcer's included), `failed` (every tried
   channel failed) or `no_channel` (nothing to try).

`tick()` flushes what is due and `start(intervalMs = 60000)` runs it on the clock (returns the
stop function). Per human and per tick: when the digest is due (local time at or past
`digest_time`) and no digest went out today, the digest queue plus whatever is still held is
bundled into one `daily_digest` (at most `DIGEST_MAX_LINES` lines, the rest counted) and
dispatched; otherwise, outside quiet hours, the held items are dispatched one by one. A
`digest_time` that was already past when a human's first item arrived (for example after a
daemon restart) counts as sent for that day, so items wait for the next day's digest rather than
firing a stray one. Switching the digest off moves its queue to the quiet-hours rules. An empty
day sends no digest.

`recent({ humanId?, limit? })` lists resolved records newest first (in memory, `recentLimit`
default 200); `pending(humanId)` lists what is held. `getPrefs` / `setPrefs(humanId, patch)`
read and write the preferences and report each channel's status (wired in this daemon,
configured for this human, reason). `sendTest(humanId)` sends one test notification to every
configured channel, outside dedupe and quiet hours, and reports each delivery.

**Audit and events.** Every attempt on a channel is an `audit_log` row: `tool:
"notify.<channel>"`, `allowed` true on delivery, `human_id`, `session_id`, `input_summary:
"<kind>: <title> (<record id>)"`, `result_summary: "<status> after N attempt(s): <reason>"`,
`denied_reason` on failure. A notification with a `sessionId` appends an event of type
`notification` (`{ id, kind, humanId, title, urgency, outcome, deliveries }`) to that session.
The in-process `NotificationEmitter` emits `record` for every notifier decision and
`notification` for every desktop send.

### Channels (`channels/`)

`Channel { name; announce?; configured(ctx): string | null; accepts?(n, ctx): string | null;
send(n, ctx): Promise<ChannelResult> }` with `ChannelResult = { ok: true, detail } | { ok:
false, reason, retryable }`. Channels never decide routing, the digest or retries; `accepts`
is the one per-notification check a channel may make (the voice channel's quiet hours and
shell presence), recorded as `skipped` with the reason. `ctx` is `{ human: { id, name, email,
timezone }, prefs: ResolvedPrefs }`.

| Channel | Sends through | Configured when | Setup (what the human enters where) |
| --- | --- | --- | --- |
| `DesktopChannel({ emitter, shellsConnected?, platform?, run?, which?, appId?, osFallback? })` | Emits `notification` on the emitter; the daemon forwards it as the SSE event `notification` `{ id, kind, title, body, level, route, humanId, projectId }` and an attached shell shows the toast (ADR 0031). `id` is the `NotificationRecord` id, so a shell can match a toast with `GET /notifications/recent` (the notifier passes it as `ctx.recordId`; a test send has no record and uses its dedupe key). With no shell connected it falls back to the OS: `notify-send --app-name=Forerunner --urgency=<low\|normal\|critical> -- <title> <body>` on Linux, a PowerShell toast on Windows (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <constant script>`; title, body and AppUserModelID travel in `FORERUNNER_TOAST_TITLE`, `FORERUNNER_TOAST_BODY`, `FORERUNNER_TOAST_APP_ID`, never inside the script). Both through `run()` with argv arrays; tools are located with `which()` once per process. `osFallback: false` (what the daemon passes when `osNotifierEnabled` is off, ADR 0038) reports "no shell connected (OS notifier off)" instead, not retryable, so the notifier moves on. | always | Nothing. Install the desktop shell for toasts while the window is closed; otherwise `notify-send` (libnotify) on Linux. |
| `EmailChannel(port \| null)` | `port.sendEmail(to, subject, body)`; the agent email capability provides the port in production (its outbound policy applies), a fake in tests. Subject `[Forerunner] <title>`, body text plus `Open: fr://<route>`. | a port exists and an address resolves | Settings → Notifications → email (or leave empty to use the account email). Needs the agent email capability enabled. |
| `TelegramChannel({ fetch, secrets, tokenRef?, apiBase?, timeoutMs? })` | `POST <apiBase>/bot<token>/sendMessage` `{ chat_id, text, disable_web_page_preview: true }` over the injected `fetch`. The bot token is a secret reference (`secret:telegram_bot_token` by default) resolved through the secrets port at send time; the URL is never logged and every error text passes through the resolver's redaction (and `/bot…/` is stripped). 429 and 5xx are retryable, other 4xx not. Text cut at 4096. | `telegram_chat_id` is set | 1. Create a bot with @BotFather, store its token in the vault as `telegram_bot_token` (`fr secrets set telegram_bot_token`). 2. Open a chat with the bot, send `/start`. 3. Read the chat id (`https://api.telegram.org/bot<token>/getUpdates`, field `message.chat.id`) and enter it in Settings → Notifications → Telegram chat id. 4. "Send a test". |
| `VoiceChannel({ clock, speak, shellsConnected, maxChars? })` (announcing, ADR 0063) | Reads `spokenAlert(n)` (the title as a sentence, then the body, cut at 600 characters) through the `speak` port, the daemon's `SpeakSessions` over the voice provider registry (`voice.md`, "Read aloud"), and resolves when the utterance ended: `detail` "spoken: N sentence(s), M chunk(s) via <provider>". `accepts` declines a non-urgent notification, quiet hours (`isQuietAt` on the clock) and an empty desktop (`shellsConnected() === 0`). The text is asserted against the platform's `redact`: a credential shape is refused (`unavailable`, "credential shape; not spoken") and never reaches the log or the rows. No TTS provider is `unavailable` with the registry's reason; a provider error is retried like any channel. | `voice_alerts` is on | Settings: `voice_alerts` on (or "turn voice alerts on" in chat); a voice provider (Kokoro, Piper, or a Cartesia / ElevenLabs key, `voice.md`); the desktop app open. |
| `SignalChannel({ account, binary?, run?, which?, timeoutMs? })` | `signal-cli -a <account> send -m <text> -- <recipient>` through `run()` when `signal-cli` is on PATH; otherwise `unavailable`, not retried. `account` is the agent's registered sender number, from configuration. | an account is configured and `signal_number` is set | Install `signal-cli` (Java), register or link a sender number for the agent, configure it as the account, enter your own number in Settings → Notifications → Signal number, "Send a test". Not available until `signal-cli` is on PATH. |

### Routes (`routes.ts`)

`createNotificationRoutes({ notifier, actor })` returns a Hono sub-app the orchestrator mounts
at the daemon root (`actor()` names the human the daemon serves, ADR 0011):

| Route | Does | Returns |
| --- | --- | --- |
| `GET /notifications/prefs` | reads the preferences | `NotificationPrefsView` `{ prefs, resolved: { timezone, email }, channels: [{ name, available, configured, reason }] }` |
| `PUT /notifications/prefs` | validates a `NotificationPrefsPatch` and merges it | the same view; 400 `validation` with `details.issues` on bad input |
| `POST /notifications/test` | one test notification per configured channel | `{ deliveries: Delivery[] }` |
| `GET /notifications/recent?limit=` | this human's records, newest first (max 200) | `{ notifications: NotificationRecordView[] }` |
| `GET /notifications/pending` | what quiet hours and the digest hold | `{ held, digest }` |

An unknown human is 404; other `ForerunnerError`s keep their code.

### Producers (`producers.ts`)

Pure builders (one per kind, see the table above) and `bindProducers(notifier)`, which returns
the same functions bound to a notifier so the orchestrator hands the session runner, the human
request path, the kill switch, the critic, the updater, the email command handler and the inbox
one hook each: `hooks.sessionEnded(humanId, facts)`, `hooks.requestOpened(req, humanId)`,
`hooks.killSwitch(humanId, report, reason)`, ... Each resolves with the record.

### Configuration (`config.ts`)

`notificationConfigFrom(config, env)` merges the `notifications` block of `config.json`
(`signalAccount`, `telegramTokenRef`, `telegramApiBase`) with the environment, which wins:
`FORERUNNER_SIGNAL_ACCOUNT`, `FORERUNNER_TELEGRAM_TOKEN_REF`, `FORERUNNER_TELEGRAM_API_BASE`.
A malformed value falls back to the default (`secret:telegram_bot_token`,
`https://api.telegram.org`, no Signal account); a token value in place of a reference is
refused, never stored. The per-human addresses are preferences, not configuration.

### Wiring (what `composeRuntime` does, ADR 0038)

All of it is in `packages/runtime/src/daemon/compose.ts` ("Notifications") and
`server.ts`; `runtime.md` has the daemon-side view.

1. Channels, in the fallback order of ADR 0017: `DesktopChannel({ emitter, shellsConnected:
   () => rt.shells.count(), osFallback: osNotifierEnabled(env, config) })` and the announcing
   `VoiceChannel({ clock, shellsConnected, speak })` over `rt.speech` (ADR 0063) only when the
   background services run (a CLI one-shot or the cloud runner has no desktop);
   `TelegramChannel({ fetch, secrets: SecretResolver(vault), tokenRef, apiBase })` wrapped in
   `SecretCheckedChannel` (`src/wiring/notification-ports.ts`), whose `configured()` also says
   "bot token not set (secret <name>)" when the vault has no such name (`vault.has`, never the
   value; refreshed before every read of the human, so a token stored while the daemon runs
   counts at the next view or send);
   `SignalChannel({ account })`; `EmailChannel(port)` with the port from
   `notificationEmailPort` (`src/wiring/notification-ports.ts`): the agent's own mailbox under
   `EmailPolicy.send`, or `null` when the agent has no mailbox configured at compose.
2. `new Notifier({ clock, channels, humans: AuditedNotificationHumans, audit: store.auditLog,
   events: store.event, emitter })`; `notifier.start()` when the services run, stopped by
   `close()`. `AuditedNotificationHumans` is `store.human` whose `notify_prefs` writes append
   one `audit_log` row (`tool: notify.prefs`, the keys that changed, never the values).
3. The emitter's `notification` payloads are re-emitted on the runtime bus; every open
   `GET /events` stream subscribes and writes the SSE event `notification`. Only a stream that
   shows the frame as a toast counts for `shellsConnected` (`src/daemon/shells.ts`): one that
   declares `?client=shell` or `X-Forerunner-Client: shell`, or an undeclared one whose token
   came in the `Authorization` header (the desktop sidecar; a browser's EventSource cannot send
   headers). The UI's own stream, the phone and a browser tab (`?token=`) do not count, so the
   OS notifier still runs when only they are open.
4. `createNotificationRoutes({ notifier, actor })` is mounted at the daemon root; the routes are
   in `DAEMON_ROUTES` (`notificationPrefs`, `setNotificationPrefs`, `testNotification`,
   `recentNotifications`, `pendingNotifications`).
5. `bindProducers(notifier)` is exposed as `RuntimeApp.notifications` and called from the real
   sources: every `store.humanRequest.insert` for this human (`requestOpened`, blocking →
   urgent; the wrap also emits `inbox` on the bus), the runner's result in `startSession`
   (`sessionEnded`, a budget stop → `budget_stop`), `KillSwitch.onStop` (`killSwitch`, with
   the reason), the restarter's `restart` event (`updateApplied`), and `critic.verdict` /
   `critic.session_review` bus events with `escalation: true` and no `humanRequestId`
   (`criticVerdict` raised to normal; the session id comes from the review row `reviewId`
   names, so the delivery is logged on that session), and the loop's `injection_flagged` run
   event (`injectionFlagged`, with an `injection.flagged` audit row, ADR 0047).
   `peerMessage` and `emailCommandReceived` have no daemon source yet (Known issues).

### Android push from the state service (spec R.6, ADR 0085)

The phone is not a channel of this notifier: the daemon runs on the PC and the phone talks to
the shared state service. Push to Android is sent by the state service itself
(`services/state-api/src/push/`, `state-service.md`, "Push to Android") through FCM HTTP v1,
for the four kinds of R.6: approval (`request_opened` / `request_blocking`), finished session
(`session_ended`), budget (`budget_stop`, decided like `sessionEnded` by the runner's
`stop_reason`, plus an 80 % warning from `budget_finish_current` that has no runtime kind and
counts as normal) and message (`peer_message`). It reuses this module's rules rather than
copying them: `KIND_URGENCY` gives the urgency, and quiet hours are the human's
`notify_prefs` read with `resolvePrefs` and decided by `isQuietAt`, so a window set in
Settings holds the same notices on the desktop and on the phone; urgent kinds go through on
both. Normal and info push notices inside the window are held and sent when it ends (there is
no digest for push). Without a Firebase service account the service's push is a visible no-op
(`/health` `push.mode: "polling"`) and the Android app raises the same notices in-app from its
change feed (ADR 0032 item 6).

## How to change it

- **Add a kind**: append it to `NOTIFICATION_KINDS` and `KIND_URGENCY` in `types.ts` (the
  routes' zod enums, `readPrefs` and `channelsFor` follow the constant), write its builder in
  `producers.ts` with a stable `dedupeKey`, add it to the table above and to the routing-matrix
  test. If it should break quiet hours, supersede ADR 0017.
- **Add a channel**: implement `Channel` under `channels/`, add its name to `CHANNEL_NAMES`
  (position = fallback order, ADR 0017; an announcing channel goes after the chain and into
  `CHAIN_CHANNELS`'s exclusion), add the address field to `NotificationPrefs`,
  `NotificationPrefsPatch`, `DEFAULT_PREFS`, `readPrefs`/`writePrefs`/`toJson` and the views in
  `routes.ts`, make `configured()` return a human-readable reason, export it from
  `channels/index.ts`, add a fake to `test/notifications-helpers.ts` `defaultChannels` and tests
  for its payload and its failure reasons. Secrets are resolved at send time by reference, never
  stored on the channel. Then construct it in `compose.ts` next to the others (its configuration
  goes through `config.ts`, with a `FORERUNNER_*` override) and add a status line to
  `notifications-wiring.test.ts`.
- **Add a producer**: build the notification in `producers.ts`, add it to `bindProducers`, and
  call `rt.notifications.<hook>` from the place in `compose.ts` (or the module) where the fact
  is known; add a case to `notifications-wiring.test.ts` that asserts the record and its urgency.
- **Change retry or dedupe**: `DEFAULT_RETRY`, `DEFAULT_DEDUPE_WINDOW_MS` in `notifier.ts`
  (both overridable per `Notifier`).
- **Change the digest text**: `sendDigest` and `DIGEST_MAX_LINES` in `notifier.ts`.
- **Change the toast shape**: `NotificationEventPayload` in `emitter.ts` is what the desktop
  shell parses (`apps/desktop/src-tauri/src/sse.rs`, ADR 0031 point 2): keep `title`, `body`,
  `level`, `route`.
- **Change a deep link**: the link must stay a route the shell opens (`is_safe_route` in
  `apps/desktop/src-tauri/src/deeplink.rs`); the producers test mirrors that rule (`SHELL_ROOTS`)
  and fails for a link to a page the shell does not list, so update both together.

## Tests

`pnpm vitest run --project unit packages/runtime/test/notifications.test.ts
packages/runtime/test/notifications-channels.test.ts
packages/runtime/test/notifications-wiring.test.ts
packages/runtime/test/notifications-voice.test.ts` (fake channels, `sqlite::memory:` store,
`SimulatedClock`, no network; the Telegram tests use an injected `fetch`, the desktop and
Signal tests injected `run` and `which`, the voice tests the voice package's `FakeTts`).

- `notifications-voice.test.ts` (the voice channel over the notifier and the daemon, ADR
  0063): `spokenAlert`; an urgent notification spoken on top of the toast (the sentences
  through TTS in order, both delivery rows, `notify.voice` and `voice.speak` audit rows, the
  session event with both deliveries); quiet hours → the toast at once and voice `skipped`
  "quiet hours"; voice alerts off → no voice row and the settings view's reason; no shell →
  `skipped`; a normal notification never spoken, listed or not; an explicit list naming only
  voice still spoken and that is the delivery; a credential shape refused, not spoken, kept
  out of the rows and the log; no TTS provider → `unavailable`, not retried; a test send
  spoken; and, composed into the daemon: the prefs route listing the channel, `voice_alerts`
  through `PUT`, a blocking request spoken with a shell on `/events` and skipped once it is
  gone, a non-blocking one toasted only.

- `notifications-wiring.test.ts` (the module inside `composeRuntime` and the daemon, fake
  provider): the notifier and hooks on `RuntimeApp` and the routes in `DAEMON_ROUTES`;
  `osNotifierEnabled`; the prefs routes with every channel's status for this daemon, one
  `notify.prefs` audit row naming only the changed keys, 400 on bad input; a non-blocking
  human request → normal, delivered by the injected OS notifier (`notify-send` argv) with its
  `notify.desktop` audit row, a blocking one → urgent (`--urgency=critical`); an extension
  waiting for approval → urgent; with `GET /events` open by a shell (token in the header) the
  toast is the SSE event `notification` with `{ id, kind, title, body, level, route, humanId,
  projectId }` and no OS command runs; a UI-style stream (`?token=`, nothing declared) is no
  shell and the OS notifier still runs, `client=shell` declares one, `X-Forerunner-Client: ui`
  opts out, and `rt.shells.count()` returns to 0 when the streams close; a finished session →
  `session_ended` with the outcome, the `/sessions/<id>` link and a `notification` event in
  the session log; a critic escalation on the bus → normal, one with a `humanRequestId` →
  nothing extra, one whose review row names a session → logged on that session; the kill
  switch → urgent with the reason; Telegram with a chat id and no token in the vault → "bot
  token not set" in the prefs view, skipped (not failed) in a delivery and in a test send, no
  request sent, configured again once the token is stored; an
  applied update and a rollback → `update_applied`; quiet hours set through the route hold a
  normal item (visible in `/notifications/pending`), not an urgent one, and `tick()` flushes it
  once cleared; Telegram with a chat id and a token in the vault: the token reaches the request
  URL and never the record, the audit rows, the logs or the open requests; a test send reports
  every channel and stays out of the recent list; the email channel is "no email sender" without
  an agent mailbox and, once the agent's mailbox is configured (a second composition over the
  same store), sends a test notification to the human through `EmailPolicy` into a recording
  mailbox.

- `notifications.test.ts` (notifier): routing matrix over every kind; per-kind lists and the
  empty list; preferred channel and `"push"`; quiet hours hold and `tick()` flush at the window
  end; `start()` flushing on the clock; urgent bypass and the human's time zone; urgency raised
  not lowered; dedupe within and after the window; a `failed` or `no_channel` notification
  releasing the window while a delivered or held one keeps it; the record id reaching the
  channel (`ctx.recordId`) and matching `recent()`; the digest once per local day (and the
  restart rule); the digest bundling quiet-hours holds; no digest time; retry with backoff then
  fallback (500 ms, 1000 ms on the clock); non-retryable and throwing channels; `failed` vs
  `no_channel`; audit rows and the session event (real store); validation and `not_found`;
  `recent()` order and cap and the emitter; `sendTest`; `bindProducers`.
- `notifications-channels.test.ts`: tolerant `readPrefs` and merging `writePrefs`; the patch
  schema; `channelsFor`; `isQuietAt` across midnight and zones; `resolvePrefs`; desktop with a
  shell (payload with the record id, no command), Linux `notify-send` argv (with `--`), Windows PowerShell argv and
  environment (user text never in the script), missing tool and failed command; Telegram
  payload, token absent from logs and results, redacted API errors and retryability, thrown
  fetch errors, missing token or chat id, custom API base and token reference, text cut;
  Signal argv and unavailability; email port, subject, deep link and failures; routes
  (round-trip, 400s, other modules' keys kept, 404, recent, test, pending); every producer,
  including that each one links to a route the shell opens and `deepLinkFor("/")` is
  `fr://open`.

## Known issues

- Held and digest queues live in memory: a daemon restart drops them. The underlying records
  (human requests, messages, sessions) are still in the inbox, so nothing is lost, only the
  push. Persisting the queue is a follow-up.
- Dedupe memory is per process for the same reason.
- The desktop channel probes `notify-send` / `powershell.exe` once per process; a tool
  installed later needs a daemon restart.
- Telegram is one-way (no polling for replies). The Signal channel needs `signal-cli` and a
  registered sender number, which the setup wizard does not yet guide.
- `notify_channel: "push"` is treated as desktop first by this notifier: Android push is sent
  by the state service in addition, not as a fallback channel here (ADR 0085), and only once
  the app's Firebase wiring exists (`docs/status/BLOCKERS.md`); the Android client reads the
  same preferences.
- The voice channel awaits the whole utterance (a few seconds) inside the notifier's dispatch,
  so the record resolves after the alert was heard; producers that await `notify` wait that
  long. The desktop shell does not play the `/speak` frames yet; the daemon's paced sink and
  the UI's Web Audio playback do (`apps.md`), so an alert is heard with the app window open.
- The email sender is resolved once at compose from the agent's email settings row: a mailbox
  configured while the daemon runs takes effect at the next daemon start (the settings screen
  shows "no email sender" until then). Re-reading the row on a settings change is a follow-up.
- `peerMessage` and `emailCommandReceived` have builders and hooks but no daemon source yet
  (ADR 0038, point 2): messages to the human arrive through the state service and the email
  command handler runs on the cloud runner. Each needs one call on `RuntimeApp.notifications`
  where the fact is known. (`injectionFlagged` has its source since ADR 0047: `compose.ts`
  calls it on the loop's `injection_flagged` run event.)
- `update_available` links to `/settings` although the UI has a `/updates` page: the desktop
  shell's deep-link roots do not list `updates` yet. When they do, change the link in
  `producers.updateAvailable` and `SHELL_ROOTS` in the producers test together.
