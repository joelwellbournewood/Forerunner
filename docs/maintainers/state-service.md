# State service

`services/state-api`: the thin HTTP service in front of the shared Postgres. Device pairing
and auth, the realtime channel, remote commands, the phone and approvals-web API, the
one-way GitHub mirror and the health / schema check. ADR 0009 (device identity and auth)
and ADR 0024 (service shape, mirror details) record the decisions; ADR 0011 the view
shapes it reuses.

## Purpose

Spec Architecture item 3: "Postgres plus a thin API. Holds tasks, messages, receipts, claims,
decisions, cost ledger, critic reviews. Realtime channel pushes inbox events." The runtime on
each PC and the cloud runner talk to Postgres directly through `@forerunner/state`
(`openStore` with a `postgres://` URL over TLS), so claims, receipts and version checks stay
in SQL. The service exists for (a) devices that must not hold database credentials (phone,
approvals web), (b) realtime fan-out, (c) remote commands, (d) the GitHub mirror and (e)
health, version and migration checks.

Requirements covered (ids from `docs/requirements.md`): F.1, F.2, F.3, F.4 (claims expire
while an install is away; the service exposes them), M.6 (schema compatibility check), R.2
(pairing, per-device keys, revoke at once), R.3 (reads and writes the shared state directly;
offline queue through the outbox contract and `/sync/outbox`; a replayed remote command is
enqueued once), R.4 (remote control: commands through the service, enqueued once per device
and envelope `clientId`, picked up atomically; live session log), R.5 (notes, tasks, ideas,
uploads, review comment / approve / reject, answer requests), J.4 (an answered `decision`
request writes the project's decision-log row, as the daemon's route does, with the device
and the request in its rationale), R.7 (scoped session tokens, no
secrets on the phone, biometric for high-risk confirmations, revoke from desktop), R.8 (the
service never runs agents), Q.8 (high-risk confirmation needs a paired device with
biometrics), U.17 to U.19 (claims; the 48-hour test exercises expiry and re-claim), S.4 and
S.2 (redacting logs; mirrored comments are quoted as data), Source-of-truth rules (one-way
mirror, status and comments sync back), phase 2 gate (48 simulated hours offline).

## How it works

### Layout

| File | Role |
| --- | --- |
| `src/main.ts` | `pnpm state-api`: env, admin token, store open, migration check, LISTEN bridge, HTTP server, SIGINT/SIGTERM |
| `src/app.ts` | `createApp(deps)`: middleware chain and route registration; used by tests and main |
| `src/config.ts` | `readConfig(env)`: every `FORERUNNER_*` setting with its default |
| `src/auth/crypto.ts` | Ed25519 keys, canonical signed string, token hashing, pairing codes |
| `src/auth/tokens.ts` | `SessionTokenStore`: hashed scoped tokens, 30-day expiry, revoke per device |
| `src/auth/pairing.ts` | `PairingService`: one-time codes, proof of key possession, device row |
| `src/auth/principal.ts` | `authenticate()`: admin (with its install id) or device, signature window, replay check, revocation; `requireScope`, `requireSigned` |
| `src/auth/replay.ts` | `ReplayGuard`: a signed mutation's signature is accepted once inside the window, keyed on the signature's bytes (`replayKey`) so another base64 spelling of the same bytes is the same replay |
| `src/auth/scopes.ts` | the scope list and per-kind defaults |
| `src/ratelimit.ts` | token bucket per device / admin install / client address, bounded and swept |
| `src/realtime.ts` | `ChangeBus` (buffer, resume), `PostgresNotifier` (LISTEN/NOTIFY), `ChangePoller` (2 s fallback; resolves the human an event concerns, for `session` and `event` rows the session's agent's owner) |
| `src/sse.ts` | one SSE loop: initial batch, wake on push, poll, heartbeat, abort; `stillAllowed` re-checked before every flush (`deviceStillActive`: a revoked device's stream ends) |
| `src/routes/*.ts` | health, devices and pairing, projects / tasks / decisions / queue / uploads, inbox and requests, remote commands, sessions and live log, `/events`, costs, reviews, `/sync/outbox` |
| `src/views.ts` | row to view mapping (`ProjectCard`, `TaskView`, `MessageView`, ... from ADR 0011) |
| `src/http.ts` | the route context, principal and body parsing; `agentName`, the agent names the session and message views show, cached per store for `AGENT_NAME_TTL_MS` (30 s) on the store's clock, so an agent renamed in the desktop app's Settings (U-025, `POST /agents/:id/rename` on the daemon) shows on the phone within 30 s without a restart (`routes.test.ts`) |
| `src/mirror/github.ts` | `GitHubMirror`: push tasks and milestones to issues, pull comments and closes |
| `src/mirror/scheduler.ts` | `MirrorScheduler`: one pass over every active project on the clock; started by `main.ts` |
| `src/outbox.ts` | the client outbox contract, `MemoryOutbox`, `flushOutbox`, the service's `IdempotencyStore` |
| `src/state-file.ts` | `JsonState` (atomic JSON files under `<data>/state-api/`) |
| `src/errors.ts` | `ApiError`, `ForerunnerError` code to HTTP status mapping |
| `src/push/fcm.ts` | `FcmSender`: FCM HTTP v1 (`POST <api>/v1/projects/<project>/messages:send`) with an OAuth2 access token minted from the service account (RS256 JWT, `node:crypto` only), cached until a minute before expiry; retries 5xx / 429 / network errors / 10 s timeouts with doubling backoff (Retry-After honoured), re-mints once on 401, reports FCM's 404 with errorCode `UNREGISTERED` as `unregistered` (a 404 without it is a failure); `parseServiceAccount` |
| `src/push/fanout.ts` | `PushFanout`: the change bus to push for the four kinds (approval, finished session, budget warning, message), quiet hours, held notices, token invalidation with an audit row, `status()` for `/health` |

### Request pipeline

Request id → CORS (only when `FORERUNNER_STATE_API_CORS_ORIGIN` names the approvals web
origin; otherwise no CORS headers at all) → body limit (256 KB JSON, upload cap on
`/projects/:id/uploads`) → authentication → rate limit → schema check → route.

Rate limits are token buckets: one per device (`FORERUNNER_STATE_API_RATE_LIMIT`, 60/min),
one per admin install (ten times that; the runtime and the cloud runner send
`X-Forerunner-Install: <id>` so one chatty install cannot starve the others, and share one
`default` bucket without it), and one per client address for the unauthenticated
`POST /pairing/complete` (one sixth). The client address is the socket's; `X-Forwarded-For`
is used only when `FORERUNNER_STATE_API_TRUST_PROXY=1` declares a reverse proxy, because any
client can set that header. Bucket maps are bounded (10,000 public keys, least recently used
evicted) and idle buckets are swept on every change-poller tick. Errors are
`{ code, message, details }`: `not_found` 404, `version_conflict` / `claim_conflict` /
`findings_open` 409, `validation` 400, `forbidden` 403, `unauthorized` / `bad_signature` 401,
`biometric_required` 403, `rate_limited` 429 with `Retry-After`, `payload_too_large` 413,
`schema_mismatch` 409. 5xx bodies carry no detail; the access log is at debug level and
never includes headers (the platform logger redacts anyway).

### Pairing flow (spec R.2)

1. Desktop (admin token): `POST /pairing/start { humanId, kind: "phone" | "web", scopes?, name?, ttlSeconds? }`
   → `{ code, expiresAt, qr: { v, code, humanId, kind } }`. The desktop shows the QR with the
   service URL. Codes live ten minutes in the service's memory and are single use. The
   desktop app never holds the admin token: its Settings → Devices section asks its daemon
   (`POST /devices/pairing`, runtime.md "Settings -> Devices"), which calls this route with
   the token from its vault and hands the app the code, the expiry and the
   `fr://pair?u=<service>&c=<code>&h=<human>` link the QR encodes. The daemon's
   `GET /devices` and `POST /devices/:id/revoke` call `GET /devices?humanId=` and step 4 the
   same way: when this service cannot be reached (or does not answer within 15 s,
   or refuses the token), the daemon revokes a row it has in its own store (the same Postgres
   in hybrid mode) there instead, which this service's per-request device check honours.
2. Phone: generates an Ed25519 key pair in its keystore, then
   `POST /pairing/complete { code, publicKey, proof: sign("pair:<code>"), name, platform, pushToken? }`
   → `201 { deviceId, humanId, kind, token, expiresAt, scopes, schemaVersion }`. The token is
   shown once; the service stores its SHA-256 only. A public key can pair once.
3. From then on: `Authorization: Bearer <token>`; mutations add `X-Device-Signature`
   (Ed25519 over `METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0|1`) and
   `X-Device-Timestamp` (±5 minutes). A mutation signature is accepted once: the same
   signed request sent again inside the window is refused (`401 bad_signature`, "replayed"),
   so a retry must sign again with a fresh timestamp (the outbox makes the retry itself
   idempotent). The guard remembers the signature's bytes, not the header text: Node decodes
   base64 leniently, so the same signature re-sent without padding, in the base64url alphabet
   or with whitespace inside is refused as the same replay (`replayKey` in `src/auth/replay.ts`).
   Signed reads are not replay-checked. `GET /me` shows the principal, scopes and expiry (and
   the install id for admin callers).
4. Push token (spec R.6, ADR 0085): the `pushToken` of step 2 is stored on the device row
   (`device.push_token`), trimmed; a blank one is stored as none. FCM rotates registration tokens, so the app sends the new one with
   `PUT /devices/:id/push-token { pushToken: string | null }`, signed like every device
   mutation; only the device itself (or the desktop's admin token) may set it, `null` stops
   push to the device, every change is a `push.token_set` audit row (who set it and whether a
   token is registered, never the token) and a `device.changed` event. Device views carry
   `pushRegistered`, never the token.
5. Lost phone: desktop `POST /devices/:id/revoke` → `DeviceRepo.revoke` plus token deletion
   plus `SecretGrantRepo.dropBlobsForDevice` (a lost PC install's shared-secret copies leave
   the grant rows, ADR 0065 amendment of 2026-10-25);
   the next request of that device is refused (`401 unauthorized`), and an open `GET /events`
   or `GET /sessions/:id/events` stream of that device ends on its next wake: `sseLoop` runs
   the stream's `stillAllowed` check (`deviceStillActive` in `src/sse.ts`, one device-row read)
   before every flush, so nothing published after the revocation reaches the device.

### Scopes

| Scope | Grants | Phone default | Web default |
| --- | --- | --- | --- |
| `read` | every GET, `/events`, `/sessions/:id/events`, `/costs` (own human only) | yes | yes |
| `write:inbox` | `POST /messages` (as one of the human's agents), `POST /messages/:id/receipt` | yes | yes |
| `write:queue` | `POST /projects/:id/queue`, `POST /projects/:id/uploads` | yes | yes |
| `write:remote` | `POST /remote/commands` | yes | no |
| `write:approvals` | `POST /requests/:id/answer`, `POST /reviews/:id/{comment,approve,reject}`, `POST /tasks/:id/transition`, `POST /projects/:id/decisions` | yes | yes |
| `confirm:high` | answering a request with `risk: "high"` (or a high-risk change card); never on a token, granted per request when signed **and** `X-Biometric-Assertion: 1` is inside the signature | per request | per request |

The shell is responsible for the biometric prompt: it sets the flag only after the platform
biometric API succeeded for that action. Admin callers hold every scope and do not sign.

### Routes

| Route | Notes |
| --- | --- |
| `GET /health` | public: `version`, `schema { code, applied, state: current/pending/ahead }`, `compatibleSchemaVersion`, `time`, realtime and mirror status, `push { mode: fcm\|polling, enabled, reason, projectId, holding, counters { sent, failed, held, invalidated, expired }, lastError }` (see Push) |
| `GET /me` | principal, scopes, expiry |
| `GET /devices?humanId=`, `GET /devices/:id`, `POST /devices/:id/revoke` | devices see their own human's; revoke is admin and also drops the shared-secret copies wrapped to the device from every open grant (`dropSharedBlobsForDevice`, one `secret.blobs_dropped` audit row; spec S.13); views say `pushRegistered` |
| `PUT /devices/:id/push-token { pushToken: string \| null }` | signed; the device itself or admin (another device 403, unknown 404, revoked 409); stores or clears the FCM token, `push.token_set` audit row, `device.changed` |
| `GET /projects`, `GET /projects/:id`, `GET /projects/:id/milestones` | `ProjectCard` with spend, budget, waiting count, health, next milestone, latest critic grade |
| `GET /projects/:id/tasks?status=&limit=&offset=`, `GET /tasks/:id`, `POST /tasks/:id/transition { version, to, reason }` | workflow graph and version check from `TaskRepo.transition` |
| `GET /inbox?humanId=|agentId=&unreadOnly=1`, `GET /messages/:id`, `POST /messages`, `POST /messages/:id/receipt { state: delivered|read|acted }` | receipts are monotonic, first wins, and come only from the addressee (the human, or the owner of the agent addressed): the sender's device may read its message but never acknowledge it, so a `requires_ack` handoff cannot be self-acknowledged |
| `GET /requests?humanId=&projectId=`, `GET /requests/:id`, `POST /requests/:id/answer { version, answer }` | 409 on a stale version; an answer an open structured card cannot act on (none of its options, for a card whose answer must be one: a sign-off, findings, plan, intake, specialist, model watch or other approval card; U-034) is a 400 `validation` whose message ends "Choose one of: …" with the options as the card shows them (`details.options`), and the request stays open; `answerRequestAs` runs the runtime's `assertAnswerAccepted` (`@forerunner/runtime/wiring/request-answers`), the daemon's own check, so the phone's Inbox, its offline queue (`/sync/outbox`, where it is the action's `rejected` result) and the approvals page refuse alike, and a decision, an info request or a credential still take free text; the options in every request view are `optionLabel`'s (an old row's object option shows as "Approve" / "Deny", the desktop's buttons, not its JSON); a device reads and answers only requests addressed to its human; a request with no human (`human_id` null) belongs to the runtime (admin) and is 403 for devices. Spec J ("every human decision is logged with who, what, when, from which device"): `answerRequestAs` writes the same decision-log entry the daemon's answer route writes (`DecisionLog.recordAnswer` from `@forerunner/runtime/wiring/state-ports`), so the outbox's `request.answer` and the review approve / reject path get it too: an answered request of kind `decision` with a project becomes a `decision` row (`question` the request's `why`, `chosen` the answer, `decided_by` and `author_human` the device's human or `runtime`, `created_at` the time), written in one store transaction with the answer (`ctx.store.transaction`), so a failed decision write leaves the request open at its version and the client's retry succeeds instead of meeting a 409 on an answered row with no decision whose rationale names the source and the request (`decisionRationale`: `request <id> answered from device <id> (<kind>) through the state service`, or `from the runtime (install <X-Forerunner-Install>)`), since the row has no device column; a different answer to the same question supersedes the older row, the same answer adds nothing; approvals, credentials and info requests write nothing; `decision.changed` goes on the change feed with the `requestId` |
| `GET /projects/:id/decisions?all=1`, `POST /projects/:id/decisions { question, options, chosen, rationale, supersedes? }` | `supersedes` must name a decision of the same project: another project's id is `404 not_found` here and `400 validation` in `DecisionRepo.supersede` (the second line), so no caller retires a decision of a project through another project's route |
| `GET /projects/:id/queue`, `POST /projects/:id/queue { kind, text, priority, transcript? }` | notes, tasks, ideas for the next session |
| `GET /projects/:id/uploads`, `POST /projects/:id/uploads` (multipart `file`, optional `kind`, optional `clientId`) | `data_asset` row; file under `<data>/uploads/<project>/<asset id>-<safe name>`; metadata only in responses. The list carries `maxBytes` (the cap, `FORERUNNER_STATE_API_UPLOAD_MAX_BYTES`, 25 MiB by default) so the phone shows it before a file is picked; over it is 413 `payload_too_large` with `details.maxBytes`. A `clientId` (8 to 100 letters, digits or dashes; anything else is 400) is kept in the asset's `sample` and makes the upload idempotent per human (ADR 0080): the phone's upload queue resends a file under the same id after a lost answer and gets the asset already made (200), never a second copy |
| `POST /remote/commands { target: pc|cloud, targetDeviceId?, command: start|pause|stop|kill, params }`, `GET /remote/commands`, `GET /remote/commands/:id` | the phone's view of its commands; a device's POST whose `params.clientId` it sent before answers 200 with the first row and creates nothing, a different body under that id is 409 ("Remote control" below). The params are opaque here: the phone's `plan`, `chat` and `voice` envelopes (ADR 0032, ADR 0080) are read by the PC. A `voice` envelope with a recorded turn carries up to 5 s of 16 kHz PCM in base64 (about 213 KB), sized to stay under the 256 KiB JSON body cap; the PC drops the audio from the row once the turn ran |
| `GET /remote/commands/pending?target=&deviceId=&humanId=&agentId=` (admin) | atomic pick-up (`RemoteCommandRepo.pickUp`): 200 with the command or 204; `humanId` restricts it to commands from that human's devices and `agentId` to commands for that agent (the runner passes its own) |
| `POST /remote/commands/:id/complete|fail { result }` (admin) | |
| `GET /sessions?agentId=&projectId=&status=`, `GET /sessions/:id` | `SessionView` with the current task; a device sees only sessions of its own human's agents (summaries and handoff text are that human's notes), `agentId` of another human is 403; admins see every session |
| `GET /sessions/:id/events?afterSeq=` | JSON page, or SSE with `Accept: text/event-stream` (`session.event`, `session.changed`, heartbeat; `Last-Event-ID` = seq) |
| `GET /events` | SSE change feed, see Realtime |
| `GET /costs?projectId=&humanId=&from=&to=` | `CostView`; devices only for their own human |
| `GET /audit/export?agentId=&sessionId=&from=&to=&format=jsonl\|csv&humanId=` | spec S.9, ADR 0050: the audit log as a file download, streamed in pages of 500 through the daemon's export module (`@forerunner/runtime/daemon/audit-export`; `runtime.md`, "Audit log export"), JSON lines or RFC 4180 CSV with the summaries as stored; a device gets the rows naming its human or one of its human's agents (never the install-level rows that name nobody), another human's agent or an unknown one is 404 `not_found`, another human's `humanId` is 403; an admin reads the whole log, or one human's rows with `humanId`; a bad format, timestamp or inverted window is 400 before anything streams; `Content-Disposition` names the file after the clock |
| `GET /reviews?taskId=|projectId=`, `GET /reviews/:id` | reviews with findings, task title and PR URL |
| `POST /reviews/:id/comment { body, fromAgentId? }` | message to the task's owner or claimant from the human's principal agent |
| `POST /reviews/:id/approve|reject { body?, requestVersion? }` | the answer to the caller's open approval request on the task first (a high-risk one needs `confirm:high`, the biometric flag; a stale `requestVersion` is 409), then the decision message (requires ack); a refused answer sends no message, and another human's approval on a shared project is left for them (`answeredRequestId: null`). The answer is the request's own option for the verdict, exactly the text its Inbox button sends (U-027, `reviewVerdictOption` in `@forerunner/runtime/wiring/request-answers`): approve is the option that accepts the work (`accept` on a sign-off or findings card, `yes` on a tool approval, `approve`), reject the one that sends it back (`revise`, `rework`, else `reject`, `deny`, `no`; never `cancel`); a request without options takes the verdict's word (`approve` reads as yes, `reject` as no); a request with no option for the verdict is left open for the Inbox (`answeredRequestId: null`). The comment goes in the message only. Before U-027 the answer was `{ decision, comment, reviewId }`, which no reader reads: sign-offs and findings cards ended `unrecognized_answer` and tool approvals were denied (`test/review-verdict.test.ts` answers each card through the route and runs the runtime's sync) |
| `GET /secrets/wrap-keys?agentIds=a,b` (admin) | spec S.13, ADR 0065: the installs a secret shared with these agents must be wrapped to (non-revoked devices of each agent's owner that registered a `wrap_public_key`; phones never); public keys only |
| `POST /secrets/shared { ownerHumanId, name, kind?, why?, agentIds, blobs: [{ agentId, deviceId, blob }] }` (admin) | the owner's install files a grant with the value already wrapped per install (`@forerunner/runtime/secrets/shared-grants`, `proposeSharedGrant`): a reserved name (`forerunner.*`, the install wrapping key) is `403 secret_reserved` before any row; every blob must be a `WrappedSecret` for a non-revoked device of that agent's owner with a wrapping key, every named agent needs one; one `human_request` of kind `approval`, risk `high`, with a `shared_secret_grant` change card per other human whose agent is named (announced on the change feed); with nobody to ask the grant is active at once; 201 `{ grant, requestIds }`, never a blob in a response |
| `POST /requests/:id/answer` on a shared-secret card | the answer and the grant move in one transaction (`applySharedGrantAnswer`): the last required yes activates the grant (its `secret_ref` mirror gets `scope: "shared"` and the agents), a no cancels it, drops the blobs and withdraws the other humans' cards (announced); risk `high` means a device answers signed with the biometric assertion |
| `GET /secrets/shared?humanId=`, `GET /secrets/shared/:id` | grants as `SharedGrantView` (counts, never blobs); a device sees the grants its human owns or must approve, another human's grant is 404 |
| `GET /secrets/shared/blob?name=&agentId=&deviceId=` (admin) | the wrapped copy for one agent on one install: active grants only, the named agent only, the device the copy was wrapped for only, else `403 secret_not_granted` with an audit row; a device principal is `403 forbidden` (spec R.7: a phone never holds a secret); every serve is a `secret.blob_served` audit row naming the install (`X-Forerunner-Install`) |
| `POST /secrets/shared/:id/revoke` | the owner's install (admin) or the owner's own signed device ends a grant (pending or active): blobs dropped, open cards withdrawn, the other humans' agents removed from the `secret_ref` mirror (the owner's own agents stay: S.14's local grant); another human's device is 403 (and so is the daemon's own revoke route for a grant its human does not own); idempotent |
| `POST /sync/outbox { actions: [{ clientId, kind, payload, createdAt }] }` | the offline queue; per-action `applied` / `duplicate` / `rejected` |

Views are the daemon's (`packages/runtime/src/daemon/api-types.ts`): money is USD micro-units
plus CHF micro-units; ledger sums carry exact CHF, USD-only figures (budgets, estimates) are
converted at the latest ledger rate, else `FORERUNNER_CHF_PER_USD`, else 0.

### Realtime (spec F.3)

`ChangeBus` holds the last 2,000 events with a process-local `seq`. `GET /events` sends
`ready`, replays events after `Last-Event-ID` (or `resync` when the id is older than the
buffer), then pushes `<table>.changed` events (`message`, `human_request`, `task`, `milestone`,
`project`, `session`, `remote_command`, `queue_item`, `decision`, `review`, `finding`,
`device`) and `session.event`, each `{ seq, type, at, humanId, projectId, sessionId, payload
{ id, version, ... }, origin }`. A device sees events whose `humanId` is its human or null
(project-wide); admins see everything. Heartbeat every 15 s. `session.changed` and
`session.event` carry the owner of the session's agent as `humanId` (`ChangePoller.describe`
resolves it through the session row and caches it per session), so one human's devices never
see the session ids, agent ids, statuses or event names of another human's sessions, as
`GET /sessions/:id` already refuses them (one human's working notes). A device stream ends
once its device is revoked (see the pairing flow, step 4).

Three sources feed the bus: (1) the service's own writes (`announce()` in routes); (2)
`PostgresNotifier`: every local event is `pg_notify`'d on `forerunner_changes[_<schema>]`
and a dedicated `LISTEN` client ingests what other instances publish (own origin and
already-seen `(table, id, version)` are dropped; the connection reconnects with backoff);
(3) `ChangePoller`: every 2 s, rows with `updated_at` (or `created_at` for `event`) at or
after a per-table high-water mark are announced, so writes the runtimes make directly to
Postgres are seen too. No triggers; `packages/state` is unchanged. Realtime is best effort:
the session log stream and the inbox fetch from the database on every wake or poll.

### Push to Android (spec R.6, ADR 0085)

`PushFanout` (`src/push/fanout.ts`) subscribes to the change bus, so it sees the service's
own writes, other instances' (NOTIFY) and the poller's view of what the runtimes wrote
directly. Four kinds become a push, each once per key:

| Kind | Raised by | Urgency (ADR 0017) |
| --- | --- | --- |
| `approval` | `human_request.changed` with status `open` and a `human_id` | `request_blocking` urgent, `request_opened` normal |
| `session` | `session.changed` to `completed`, `failed` or `stopped` (not a budget stop) | `session_ended` normal |
| `budget` | read like the runtime's `sessionEnded` producer (`sessionNotices`): a session that ended with `handoff.stop_reason` `budget_exceeded` (the runner's budget stop, usually below the cap because the hook refuses the crossing call) or stopped / failed at its cap is the stop; `budget_finish_current` (new work stopped at 80 %) or spend at `BUDGET_WARNING_SHARE` of the cap on a row that records spend while running is the warning, sent before the session's end notice | warning normal, stop `budget_stop` urgent |
| `message` | an unread message from another human's agent to the human or the human's agent; from the human's own agent only when it needs them (`question`, `request`, `warning` or `requires_ack`, the attention rule of `peerMessage`), so the plain `info` summary every session ends with does not buzz a second time | `peer_message` info |

Each notice goes to every non-revoked device of the human with a `push_token`
(`DeviceRepo.pushTargets`), once per distinct token: an app install that paired twice holds
one token on two rows and is sent to once, and a dead token is cleared from every row holding it. Quiet hours are the human's own (`human.notify_prefs`, read with
`resolvePrefs` and decided by `isQuietAt` from `@forerunner/runtime/notifications/prefs`, the
same rule the desktop notifier uses): urgent kinds go through; the others are held in memory
(at most `MAX_HELD`, 1,000; the oldest dropped with a warning) and sent by `flushHeld`, which
runs on every poller tick, once the human's window is over; each held item is re-read first,
and a request answered or a message read meanwhile is dropped (counted as `expired`). Payloads are data-minimal: a
generic title and body, and `data { kind, id, link, projectId? }` for the app's deep link;
request reasons, message text and project names never go through Google. Urgent notices are
sent with Android priority `HIGH`, the rest `NORMAL`. `android.notification.channel_id` names
the app's channel for the kind (`channelForKind`: `attention` for approval and budget,
`updates` for session and message; the ids `PushLinks.kt` creates), so a notification the
system tray shows in the background lands on the same channel as one the app posts.

`FcmSender` (`src/push/fcm.ts`) posts one message per token. FCM's 404 with the `FcmError` code
`UNREGISTERED` means the token is dead (a 404 without that code, from a wrong
`FORERUNNER_FCM_API_URL`, a path or a proxy, is an ordinary failure and keeps every token): the fan-out clears `push_token` (unless the device sent a new
one in between) and writes a `push.token_cleared` audit row (device id, platform, the FCM
code). Every request (token endpoint and FCM) is bounded by a 10 s timeout (`timeoutMs`): a
stalled connection is aborted and retried, so it cannot hang the fan-out, the held-notice
flush or shutdown. 5xx, 429, network errors and timeouts are retried up to four attempts with 0.5 s doubling
backoff, capped at 30 s, `Retry-After` honoured; another 4xx fails at once. A failure is
logged with the HTTP status and FCM's error code only and shown as `lastError` in `/health`.

The service account comes by reference only: `FORERUNNER_FCM_SERVICE_ACCOUNT_REF` names a
vault secret holding the service-account JSON, which `main.ts` resolves like the admin token
(`resolvePushSender`). Without the reference push is a visible no-op: `/health` says
`push { mode: "polling", enabled: false, reason: "FCM not configured ..." }` and the app's
change feed raises the notices in-app (ADR 0032 item 6). A reference that resolves to
nothing or to a file that is not a service account (missing field, a key that is not PEM)
also leaves push off, with that reason in `/health` and a warning in the log: push is
optional, so the service still starts. Neither the key, the access token nor a registration
token appears in config, logs, `/health`, audit rows or responses (tested).

### Remote control (spec R.4)

The phone enqueues a `remote_command` (issuer = its device). The PC daemon and the cloud
runner talk to the shared Postgres directly (ADR 0024) and pick up with
`RemoteCommandRepo.pickUp(target, { deviceId, agentId })` every 500 ms (`packages/runtime`
`RemoteCommandWatcher` for `pc`, `services/cloud-runner` for `cloud`); a runtime that goes
through the service instead polls `GET /remote/commands/pending?target=pc&deviceId=<its device
id>` (or wakes on a `remote_command.changed` event). Either way the oldest pending command
addressed to it or to nobody is taken atomically; with `ownerHumanId` or `agentId` the store
takes only commands whose issuing device belongs to the human who owns the runtime's agent
(ADR 0033 item 8b, ADR 0041), so another human's command stays pending for their own runtime.
The runtime reports `complete` or `fail` with a result the phone can show (the daemon's
watcher writes the row directly; the poller announces the change). Two pickers never get the
same command (tested). On the PC, `stop` and `kill` go through the kill switch (the task in
flight is aborted) and `pause` is the graceful stop (the row reads `paused` at once, the task
in flight finishes, the session closes at the next task boundary with its handoff; `runtime.md`,
`src/wiring/session-ports.ts`).

**Once per tap (idempotency).** The phone's outbox POSTs an envelope until it is acknowledged,
and a lost answer makes it send the same envelope again: directly, or as a `remote.enqueue`
action of `POST /sync/outbox` under the same `clientId` (the app's `sendPlan` queues a failed
POST under the envelope's own id). `enqueueRemoteCommandOnce` (`src/routes/remote.ts`)
therefore runs a device's enqueue through the same `IdempotencyStore` as the outbox, keyed on
`idempotencyKeyOf(principal)` (the device id; `src/outbox.ts`) and the envelope's
`params.clientId`: the first POST is 201; a repeat returns the first row with 200, creates no
row and announces nothing; the outbox's replay reports `duplicate` with the first row's id,
and the reverse order (queued offline, then posted directly after the reconnect) reads the
queued row back, because both routes store the same record (`remoteEnqueueResult`: id,
version, status and a SHA-256 fingerprint of target, target device, command and params with
object keys sorted). The same clientId with a different body is 409 `version_conflict`
(`details.commandId` names the earlier command), as is a clientId the outbox already spent on
another action; a `clientId` that is not a string of 1 to 200 characters is 400. Admin callers
and commands without a clientId are enqueued every time, as before. The record lives a week
(`IDEMPOTENCY_TTL_MS`, `idempotency.json`), so a copy older than that, or one that reaches a
second service instance with its own file (Known issues), still becomes a second row: the
daemon's `RemoteCommandWatcher` refuses that row as a duplicate from its audit rows
(`runtime.md`, "one tap acts once"), which is why the limit is enforced on both sides. Tests:
`test/remote.test.ts` (the route: repeat, outbox replay, reverse order, a different body, another
device) and, end to end, the second case of scenario 9
(`tests/e2e/scenarios/09-phone.scenario.test.ts`: the same envelope posted twice answers 200
with the first row and creates none, and a copy written into the store past the service is the
watcher's `duplicate`; one change log row, one session start).

### GitHub mirror

`GitHubMirror` (`src/mirror/github.ts`) needs a `GitHost` (`GitHubHost` from
`@forerunner/capabilities` with a token resolved by reference, or `MemoryGitHost` in tests)
and a repo. `push(projectId)`: every task becomes an issue (title; body with outcome,
acceptance criteria, status, tier, milestone, PR; labels `fr:task`, `fr:tier-N`,
`fr:status:<status>`, `fr:milestone:<slug>`; closed when done or cancelled); every milestone
becomes an issue labelled `fr:milestone` listing its criteria and task issues. The mapping
(task id → issue number, content hash, last comment id) is `mirror.json`; unchanged content
makes no call, and an issue reopened on GitHub is closed again. `pull(projectId)`: new
comments become `info` messages from the system agent `github-mirror` (created on first use,
owned by the configured or first human) to the task's owner or claimant, quoted line by line
and marked as data; an issue closed on GitHub moves the task to `done` when the workflow
allows it, else to `cancelled` when allowed, else nothing. `MessageRow.mirrored_url` makes
comment import idempotent. Configure with `FORERUNNER_MIRROR_REPO=owner/name` and
`FORERUNNER_MIRROR_TOKEN_REF` (a vault name; the runner injects it as
`FORERUNNER_SECRET_<NAME>`, exactly like the admin token) and optionally
`FORERUNNER_MIRROR_API_URL` for GitHub Enterprise or a stand-in host. `main.ts` then builds a
`GitHubHost` with the resolved token, a `GitHubMirror` whose mapping is `mirror.json` under the
service state directory, and a `MirrorScheduler` that runs one pass (`sync` for every active
project, paused and archived ones skipped) every `FORERUNNER_MIRROR_INTERVAL_MS` (default
60 s), the first pass one interval after start. A project whose sync fails is logged and
counted in the pass report; the others and the loop continue. `GET /health` reports
`mirror { enabled, repo }`. A missing token reference or a malformed repo refuses to start; no
repo means the mirror is off. The runtime's own GitHub Projects V2 mirror
(`ProjectsMirror` in `@forerunner/capabilities`, scheduled by the daemon per project) is a
separate, board-shaped mirror; the two are configured independently (ADR 0024).

### Offline story (phase 2 gate)

- Solo mode: local SQLite, no service.
- Paired mode, online: the PC works on Postgres directly; the service pushes.
- Paired mode, Postgres unreachable: the PC stays read-only on its last state brief, makes
  no claims or transitions, and queues outbound messages, receipts, answers, notes and remote
  commands in an `Outbox` (`src/outbox.ts`). On reconnect `flushOutbox` posts batches to
  `POST /sync/outbox`; `clientId`s are remembered for a week (`idempotency.json`) so a retry
  after a lost response applies nothing twice; rejected actions (4xx) are dropped by the
  client, transport failures keep the queue. The store is bounded: at most
  `IDEMPOTENCY_MAX_PER_KEY` (5,000) records per device or admin install and
  `IDEMPOTENCY_MAX_RECORDS` (50,000) in all, the oldest dropped first, so a device sending
  fresh ids at its rate limit cannot grow the file without bound (a retry older than that
  horizon is applied again, which the routes' own checks keep harmless). Its claims lapse after 30 minutes
  (`TaskRepo.expireClaims`), so nothing on the other PC waits for it. The returning install
  reads the inbox and acknowledges `requires_ack` handoffs.
- The phone: the same contract with a keystore-backed outbox.

The Postgres integration test runs 48 simulated hours with one install working hourly
(claims, transitions, messages) while the other is silent, then checks the silent one sees all
48 messages, acknowledges the four handoffs, cannot re-claim finished work, and flushes its
outbox with no errors on either side.

### Deploy

- Image: the runner image (`services/cloud-runner/Dockerfile`) with `CMD ["pnpm", "state-api"]`;
  `FORERUNNER_HOME=/data` holds `state-api/*.json` and `uploads/`, so mount a volume there.
- Fly.io: `fly launch` with the Dockerfile, a Fly Postgres (or any managed Postgres) and a
  volume mounted at `/data`; set the secrets below with `fly secrets set`; expose port 8788
  (`FORERUNNER_STATE_API_HOST=0.0.0.0`). One machine for 1.0 (pairing codes and the SSE
  buffer are per instance).
- VPS: Docker with `--restart unless-stopped`, a volume at `/data`, a reverse proxy that
  terminates TLS and passes `Last-Event-ID` and long-lived responses (disable proxy
  buffering for `/events`).
- Local: `pnpm state-api` with `FORERUNNER_STATE_URL=sqlite:<path>` for a single-machine trial.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORERUNNER_STATE_URL` | required | `postgres://...` (TLS) or `sqlite:<path>` |
| `FORERUNNER_STATE_SCHEMA` | connection default | Postgres schema |
| `FORERUNNER_STATE_API_HOST` / `_PORT` | `127.0.0.1` / `8788` | bind address |
| `FORERUNNER_STATE_API_ADMIN_TOKEN` or `_ADMIN_TOKEN_REF` | required (one of) | shared secret for runtimes; the ref names a vault secret injected as `FORERUNNER_SECRET_<NAME>` by the runner |
| `FORERUNNER_STATE_API_CORS_ORIGIN` | off | approvals web origin |
| `FORERUNNER_STATE_API_TRUST_PROXY` | off | `1` when a reverse proxy sets `X-Forwarded-For` (used for the pairing rate limit only) |
| `FORERUNNER_STATE_API_RATE_LIMIT` | 60 | requests per minute per device |
| `FORERUNNER_STATE_API_BODY_LIMIT` / `_UPLOAD_MAX_BYTES` | 256 KB / 25 MB | body caps |
| `FORERUNNER_STATE_API_TOKEN_TTL_MS` / `_SIGNATURE_WINDOW_MS` | 30 days / 5 min | auth windows |
| `FORERUNNER_STATE_API_POLL_MS` / `_HEARTBEAT_MS` | 2000 / 15000 | realtime timers |
| `FORERUNNER_STATE_API_MIGRATE` | unset | `1` applies pending migrations on start (an empty database is always migrated; a newer database refuses to start) |
| `FORERUNNER_CHF_PER_USD` | ledger rate | fallback conversion for USD-only figures |
| `FORERUNNER_MIRROR_REPO` / `_TOKEN_REF` / `_INTERVAL_MS` / `_API_URL` | off | GitHub mirror: `owner/name`, vault name of the token, pass interval (60 s), API base URL (api.github.com) |
| `FORERUNNER_FCM_SERVICE_ACCOUNT_REF` | off | Android push: vault name of the Firebase service-account JSON (injected as `FORERUNNER_SECRET_<NAME>`); unset = push off, visible in `/health` |
| `FORERUNNER_FCM_PROJECT_ID` / `FORERUNNER_FCM_API_URL` | the account's `project_id` / `https://fcm.googleapis.com` | Firebase project override and FCM API base URL (a stand-in in tests) |

## How to change it

- New route: add it to the matching `src/routes/*.ts`, call `requireScope` (and
  `requireSigned` for mutations), validate the body with zod through `parseBody`, write
  through the store repositories, `announce()` the row, return a view from `src/views.ts`.
  Add the happy path and the 403 / 404 / 409 cases to `test/routes.test.ts` and the route to
  the table above.
- New scope: `src/auth/scopes.ts` (list and defaults), the table above, ADR 0009 if the
  meaning of an existing scope changes.
- New realtime table: add it to `WATCHED` in `src/realtime.ts` with its change column and
  the human derivation in `describe()`.
- Moving the JSON state into Postgres: implement `JsonState` over a table in a migration
  (ADR 0005 process) and swap the constructor calls in `main.ts`.
- Mirror fields: `renderTaskIssue` / `renderMilestoneIssue`; the content hash changes, so
  the next push updates every issue once.
- Client-side outbox implementations implement `Outbox` and call `flushOutbox` with a sender
  that posts to `/sync/outbox`; new action kinds go into `OUTBOX_ACTION_KINDS`,
  `routes/sync.ts` and the client.

## Tests

`pnpm vitest run --project unit services/state-api/test` (SQLite in memory, simulated clock):

| File | Covers |
| --- | --- |
| `auth.test.ts` | canonical signature, scopes, pairing (single use, proof, expiry), token expiry, revocation within one request, signature window both ways, replayed mutation refused (re-signed retry and signed reads pass; guard swept after the window), query string inside the signature, scope 403s, high-risk needs signed + biometric (a forged flag is a signature failure), admin token (no prefix match), rate limit 429 and recovery, admin bucket per `X-Forerunner-Install`, `X-Forwarded-For` trusted only behind a declared proxy, bucket cap / sweep / poller tick, schema mismatch 409, CORS only for the configured origin, 413 |
| `routes.test.ts` | health, 404 shape, project cards, task list / get / transition (409, 400 illegal, 404), inbox and receipts (monotonic, first wins, other humans 403, the sender's device cannot receipt a message to another human or agent while it may still read it, also through the outbox), sessions scoped to the device's human's agents, unaddressed requests 403 for devices, agent inbox, requests (answer, 409, 404; the decision-log entry of an answered `decision` request with who, what, when, the device and the request id in the rationale, listed by the service and on the change feed; nothing for an approval; a different answer through the outbox supersedes the first; the runtime's answer logged as `runtime` with its install; the answer and the decision entry are one write: a decision write made to fail (`DecisionLog.prototype.recordAnswer` spied) answers 500 and leaves the request open at its version with no decision row and nothing on the change feed, and the re-signed retry writes both), decisions and supersede, queue, costs (own human only), reviews (comment → message, approve → request answered), sessions and the JSON event page, an agent renamed in the store shown under its new name once the cached name expires (U-025), uploads (metadata only, safe name, cap, missing file, written under the harness temp dir; a `clientId` upload applied once, the re-signed resend answering 200 with the same asset and one file on disk, the list reporting `maxBytes`, a malformed `clientId` 400) |
| `remote.test.ts` | enqueue, atomic pick-up (two pickers, one wins on SQLite; the Postgres race is in the integration test), per-device addressing, complete / fail lifecycle, device cannot pick up, validation; once per device and envelope `clientId`: a re-signed repeat is 200 with the first row and the store gains nothing, the outbox's `remote.enqueue` replay of the same id is `duplicate` with that row, the reverse order reads the queued row back, a different body is 409 naming the earlier command, another device's same id is its own row, commands without a clientId and admin callers unchanged, a malformed clientId 400; a phone's 5 s push-to-talk envelope (ADR 0080) is accepted under the JSON body cap and one twice as long is 413 |
| `realtime.test.ts` | `ChangeBus` buffer / resume / dedupe / filter, poller `onTick`; over a real server with `fetch` and a `ReadableStream` reader: event after a write, per-human filtering, polling fallback for direct store writes, `Last-Event-ID` resume, `resync` when the id fell out of a one-entry buffer, heartbeat on the simulated clock, session log stream with `afterSeq`, 401, public limiter keyed by the socket over a real server |
| `mirror.test.ts` | rendering, idempotent push, label and state updates, comment sync back (quoted, once, marker ignored), close sync back (done when allowed, cancelled otherwise, ignored with open findings), reopen on GitHub is undone; `MirrorScheduler` on the simulated clock (active projects only, unchanged second pass, stop), a failing project reported without stopping the others |
| `outbox.test.ts` | `flushOutbox` ordering, rejection, transport failure; `IdempotencyStore` persistence, TTL and `run()` under overlapping calls; `/sync/outbox` batch, duplicates, two batches in flight with one clientId apply once, scope per action, end to end |
| `security-state-api.test.ts` | the security review's attacks, each from a real input: a replayed mutation under another base64 spelling of the same signature (refused), a signature over another body / path / method, skew, pairing and token misuse, ownership on every route (another human's inbox, requests, costs, sessions; a decision of another project cannot be superseded through this project's route), revocation (tokens gone, the key cannot pair again, an open change feed ends instead of streaming on), the change feed never carries another human's private events (messages, requests, remote commands, `session.event` / `session.changed` of another human's agent; `Last-Event-ID` resume filtered the same way), input bounds (body size, batch size, the idempotency store capped per device), per-device rate limits, the remote command flow |
| `main.test.ts` | config defaults and validation, admin token by env or reference, `startService` boot / health / stop, refuses a newer schema; mirror wiring from `FORERUNNER_MIRROR_*` with the token by reference (`/health`, a pass on the interval against `MemoryGitHost`, `runOnce`, stops with the service), refuses a missing token reference or a malformed repo |
| `push.test.ts` | spec R.6 against a fake OAuth token endpoint (verifies the RS256 JWT, its claims and the grant type) and a fake FCM HTTP v1 endpoint (bearer, project, scripted per token), both real loopback HTTP (`fake-google.ts`): one minted access token reused, 5xx retried with doubling backoff and given up after four attempts, Retry-After on 429, no retry on 400, a stalled connection aborted after the timeout and retried, `UNREGISTERED` reported once, a 404 without the code (wrong URL, proxy page) a failure that keeps the token, token endpoint 5xx retried and a 401 re-minted, the sender built by `resolvePushSender` from the reference and env; the pairing `pushToken` stored and never served; a blank pairing token stored as none and a padded one trimmed; `PUT /devices/:id/push-token` (unsigned 401, another device 403, empty 400, clear, admin, 404, a revoked device 409, audit rows without the token); each of the four kinds sent to every device of the human with a token (not to tokenless devices or other humans), once, data-minimal; budget stop urgent and own-agent notes not pushed; a budget stop as the runner writes it (below the cap, `stop_reason`) urgent through quiet hours and `budget_finish_current` as warning plus end; a session end and its `info` summary buzz once while the own agent's question and another human's message are pushed; quiet hours hold a normal request, an urgent one goes through, the held one goes out at the end of the window (`/health` holding); one token on two rows sent once and cleared from both; the unregistered token cleared with a `push.token_cleared` audit row and push resuming after a refresh; a final failure counted in `/health`; no key, access token or registration token in any log line (debug level), `/health` or audit row; no service account = no request and `mode: polling` with the reason; a bad reference or key leaves push off with the reason, not the content |
| `audit-export.test.ts` | spec S.9: a phone's export holds its human's rows and their agents' rows only (JSON lines in time order, the download headers), CSV with the header and the formula guard, filters by agent / session / window (`to` exclusive), another human's agent and an unknown one 404, another human's `humanId` 403 and its own accepted, 401 without a token, the narrowest device (`read` only) may export, bad format / timestamp / window 400, the admin's whole log and one human's rows by `humanId` or `agentId`, 1003 rows streamed through three `list` calls capped at the page size |
| `desktop-devices.test.ts` | spec R.2 from the desktop's side: the runtime's `DeviceManager` (what the daemon's `/devices` routes call) against this app's real routes with the admin token, the daemon on its own local store so everything comes from the service: a pairing whose `fr://` link (`u`, `c`, `h`) carries a ten-minute code the phone completes with its own key, the new phone listed and this desktop `current`, another human's phone not listed, the audit row without the code or the token; the revocation immediate (one token dropped, the phone's next `/me` 401, the list shows it revoked); this desktop's own device refused, another human's and an unknown id `not_found` (the other human's phone still works); no admin token makes no call, a wrong one is `unavailable` with the 401 |
| `shared-secrets.test.ts` | spec S.13 on two profiles with two humans (Ada's and Bob's installs as `HttpSharedSecretService` clients over `app.request`, their phones as signed devices): wrap targets (installs with a key only, phones 403, unknown agent 404), propose (the grant pending with one blob, Bob's inbox shows the `shared_secret_grant` card, Ada's inbox nothing, both humans list the grant and a third cannot, nothing served while pending), validation (a device cannot propose; a blob for another human's install, a malformed blob, a bad name, an unknown agent, a named agent without a copy), approval (unsigned 401, without biometric 403 `biometric_required`, Ada's phone 403 on Bob's card; Bob's signed biometric yes activates it and the `secret_ref` mirror; the blob served to Bob's install for Bob's agent and refused for Alice, for Ada's install, for Bob's phone id, for another name, and to a device principal; Bob's install resolves the value by reference and caches nothing), refusal (cancelled, blobs dropped, nothing served, a fresh proposal afterwards), revoke (Bob's phone 403, Ada's phone unsigned 401 then signed 200, the runtime too, a pending grant's card withdrawn, idempotent after a re-sign), a revoked install (the desktop's `POST /devices/:id/revoke` of Bob's PC drops its blob from the active grant and writes `secret.blobs_dropped`; the service refuses to serve it, Bob's laptop still resolves, the next proposal does not target it and a blob made for it is 400; a second revoke drops nothing more), a second Bob install re-shared for; every store table and every response body scanned for the value in every encoding |

`pnpm vitest run --project integration services/state-api/test` with `FORERUNNER_TEST_PG`:
`state-api.integration.test.ts` runs two service instances on one Postgres schema
(LISTEN/NOTIFY delivery across instances, polling fallback), races two instances for one
remote command five times (exactly one 200 per round: `RemoteCommandRepo.pickUp` relies on
Postgres re-checking the predicate after the row lock) and the 48-hour offline scenario.
Skipped visibly without the variable. Unit tests never write outside a per-harness temp
directory (`helpers.ts` sets `uploadsDir` and `serviceStateDir`; `close()` removes it). The
harness seeds its milestone with a reason and Ada as author: a new milestone is a plan change
the store's B.5 insert guard refuses without them.

## Known issues

- `TaskRow` has no `mirrored_url` column (only `message` has one), so the task → issue
  mapping lives in `mirror.json` rather than on the row; a migration adding
  `task.mirrored_url` would let the UI link to the issue.
- The `GitHost` contract has no milestone endpoints, so milestones are mirrored as labelled
  issues and the "board" is the `fr:status:*` labels. `GitHost` is gaining a GitHub Projects
  V2 API (`ensureProject`, `ensureFields`, `upsertItem`, `setItemFields`, ...); once
  `MemoryGitHost` implements it, `GitHubMirror.push` can add every task issue to a project
  with a Status field. The mirror depends only on the `MirrorHost` pick (issues and issue
  comments), so that change is additive.
- Pairing codes, the SSE resume buffer and the replay guard are per instance; several
  instances need sticky sessions. Session tokens, idempotency keys and the mirror mapping are
  JSON files, so they are per instance too unless the volume is shared; two instances with
  the mirror enabled against one repo would create duplicate issues, so enable it on one, and
  a remote command the phone replays to the other instance becomes a second row (the daemon's
  watcher refuses it from its audit rows, so it never acts twice).
- The mirror has no "sync now" route yet; `StartedService.mirror.runOnce()` exists for an
  embedder, and a pass runs at most every `FORERUNNER_MIRROR_INTERVAL_MS`.
- Signed mutations are single use, which means a client library that resends a cached
  request verbatim on timeout gets `401`; the outbox client re-signs every attempt.
- Push notices held for quiet hours live in the instance's memory: a restart inside the
  window drops them (the app's change feed and inbox still show the items), and with several
  instances each one fans out what its bus sees, so enable push on one instance (like the
  mirror). The "sent once" keys are per instance as well.
- The Android app's Firebase wiring (google-services.json, `firebase-messaging`, a
  `FirebaseMessagingService`, `KeystorePlugin.info` returning `fcmToken`) waits for a
  Firebase project (`docs/status/BLOCKERS.md`); until then no device sends a `pushToken` and
  the service's push stays idle even when configured.
- `cost_ledger` is not polled (sums are computed on request); a `cost_ledger.changed`
  event exists in the type union for a future opt-in.
- Shared secrets (spec S.13, ADR 0065 §4): every install presents the same admin token (ADR
  0009, ADR 0024), so the service cannot tell which human's install proposes
  (`ownerHumanId` is the body's), answers a card as admin (`assertRequestOwner` restricts
  devices only) or revokes (attributed to the owner); `X-Forerunner-Install` is advisory and
  names the caller in the audit rows. An install is trusted with the store it writes directly;
  the confidentiality boundary is the wrapping (a blob opens only on the install it was made
  for), and the device paths (phones, the approvals web) are the ones the service enforces.
