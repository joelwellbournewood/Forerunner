# 0085 — Android push: the state service sends through FCM HTTP v1 with a service account by reference; the app half waits for a Firebase project

Date: 2026-10-23
Status: accepted

Numbering: the build brief for this item (w4-fcm-sender) named this ADR 0084, but 0084 was
taken by "Email routes fail closed without identity" on the base branch before this item was
built; this ADR is the next free number.

## Context

Spec R.6 asks for "push for approvals, finished sessions, budget warnings and messages, with
quiet hours"; K.8 for desktop notifications, which the runtime's notifier delivers. ADR 0032
item 6 shipped Android push as a visible polling stand-in (`push.rs` `configured(token)`
returns `PollingPush`; the UI's change feed raises in-app notices with quiet hours) and listed
the FCM wiring for when a Firebase project exists. There is still no Firebase project, no
`google-services.json` and no service account (`docs/status/BLOCKERS.md`). Adding
`firebase-messaging` or the Google services plugin to the Gradle build without the project
breaks the Android build. The open points: which process sends the push, how its credential
is held, what it sends and when, what happens to a dead token, and what runs while nothing is
configured.

## Decision

1. **The state service sends the push, not the desktop daemon.** The phone pairs with the
   state service and every device row (`device.push_token`) lives there; the service already
   sees every change the four kinds depend on (its own writes, other instances through NOTIFY,
   the runtimes' direct writes through the change poller). `PushFanout`
   (`services/state-api/src/push/fanout.ts`) subscribes to the change bus and raises at most
   one notice per key: `approval` (a `human_request` opened for the human; blocking =
   urgent), `session` (a session of the human's agent completed, failed or stopped),
   `budget` (decided like the runtime's `sessionEnded` producer, from the runner's
   `handoff.stop_reason`: `budget_exceeded`, or a session stopped at its cap, is the urgent
   stop; `budget_finish_current`, new work stopped at 80 %, or 80 % of the cap on a row that
   records spend while it runs, is the normal warning; see "Review amendment") and `message` (an unread message to the human, or to the human's agent from another
   human's agent). Each goes to every non-revoked device of the human with a `push_token`.
2. **FCM HTTP v1, `node:crypto` only.** `FcmSender` (`src/push/fcm.ts`) posts
   `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send` with
   `Authorization: Bearer <access token>`. The access token is minted from the service account
   with the OAuth2 JWT-bearer grant (an RS256 JWT, `iss` the client email, `aud` the account's
   `token_uri`, scope `firebase.messaging`, one hour) and cached until a minute before it
   expires; a 401 re-mints once. No Google SDK: one dependency fewer, and the two requests are
   small enough to test against stand-ins.
3. **The service account by reference only.** `FORERUNNER_FCM_SERVICE_ACCOUNT_REF` names a
   vault secret holding the JSON; `main.ts` resolves it through the same `SecretResolver` as
   the admin and mirror tokens (`FORERUNNER_SECRET_<NAME>` injected by the runner). Config,
   logs, `/health`, audit rows and responses carry the reference name, the project id, HTTP
   statuses and FCM error codes; never the key, the access token or a registration token.
4. **Quiet hours are the human's own, decided by the runtime's rule.** The fan-out reads
   `human.notify_prefs` with `resolvePrefs` and asks `isQuietAt`
   (`@forerunner/runtime/notifications/prefs`), with ADR 0017's urgency per kind
   (`KIND_URGENCY`): urgent kinds go through; normal and info notices are held in memory and
   sent on the first poller tick after the window ends, unless the item was answered or read
   meanwhile (re-read at the flush). There is no push digest.
5. **Retries and dead tokens.** 5xx, 429 and network errors are retried up to four attempts
   with doubling backoff from 0.5 s (capped at 30 s, `Retry-After` honoured); other 4xx fail
   at once. FCM's 404 with the `UNREGISTERED` error code clears the device's `push_token`
   (a 404 without the code is a wrong URL or a proxy and only fails; unless
   the device registered a new one in between) and writes a `push.token_cleared` audit row.
   Failures are counted and the last one is shown in `/health`.
6. **Token registration.** `POST /pairing/complete` keeps its optional `pushToken`;
   `PUT /devices/:id/push-token { pushToken: string | null }` takes a refresh, signed like
   every device mutation, by the device itself or the desktop's admin token, with a
   `push.token_set` audit row. Device views say `pushRegistered`, never the token.
7. **Unconfigured is a visible no-op.** Without the reference (or when it resolves to nothing
   or to a file that is not a service account) nothing is sent, the service still starts, and
   `/health` reports `push { mode: "polling", enabled: false, reason }`. Push is optional;
   refusing to start would take inbox, approvals and remote control down for a missing
   convenience.
8. **Data-minimal payloads.** A generic title and body (`Approval needed (blocking)`,
   `Session finished`, `Budget warning`, `New message`) and
   `data { kind, id, link, projectId? }`; request reasons, message text and project names do
   not go through Google. The app opens `link` and reads the rest from the service.
9. **The Android half stays the stand-in.** No `google-services.json`, no `firebase-messaging`,
   no `FirebaseMessagingService` and no `fcmToken` from `KeystorePlugin.info` until a Firebase
   project exists; ADR 0032 item 6 lists that wiring unchanged.

## Consequences

- The day a Firebase project exists, only the app half is left: the Gradle files, the
  messaging service, `fcmToken` in `info`, and sending the token at pairing and on refresh.
  The service needs only `FORERUNNER_FCM_SERVICE_ACCOUNT_REF`.
- Held notices and the "sent once" keys are per instance and in memory: a restart inside a
  quiet window drops held notices (the inbox still shows the items), and push should be
  enabled on one instance when several run, like the GitHub mirror.
- A human with Android push and desktop notifications gets both; the desktop notifier treats
  `notify_channel: "push"` as desktop first, unchanged.
- The test suite carries stand-ins for Google's token endpoint and FCM
  (`services/state-api/test/fake-google.ts`), so the sender is exercised over real HTTP
  without a project.

## Alternatives considered

- **Send from the desktop daemon as another notifier channel.** Rejected: the daemon may be
  asleep with its PC when a cloud session finishes, it does not hold the device rows, and every
  install of a shared project would need the service account.
- **firebase-admin SDK.** Rejected: a large dependency tree for two HTTP calls; `node:crypto`
  signs RS256 and the error handling we need (status, `errorCode`) is in the response body.
- **Persist held notices in the store.** Deferred: it needs a table and a migration for a
  stand-in that has no live device yet; the items themselves are already persistent.
- **Refuse to start on a bad reference** (as the mirror does). Rejected for push (point 7):
  the mirror is something the operator asked for and acts on repositories; push is a
  convenience on top of a feed the app already polls.
