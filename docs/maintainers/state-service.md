# State service

`services/state-api`: the thin HTTP service in front of the shared Postgres. Device pairing
and auth, the realtime channel, remote commands, the phone and approvals-web API, the
one-way GitHub mirror and the health / schema check. ADR 0009 (device identity and auth)
and ADR 0013 (service shape) record the decisions; ADR 0011 the view shapes it reuses.

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
offline queue through the outbox contract and `/sync/outbox`), R.4 (remote control: commands
through the service, picked up atomically; live session log), R.5 (notes, tasks, ideas,
uploads, review comment / approve / reject, answer requests), R.7 (scoped session tokens, no
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
| `src/auth/principal.ts` | `authenticate()`: admin or device, signature window, revocation; `requireScope`, `requireSigned` |
| `src/auth/scopes.ts` | the scope list and per-kind defaults |
| `src/ratelimit.ts` | token bucket per device / admin / public |
| `src/realtime.ts` | `ChangeBus` (buffer, resume), `PostgresNotifier` (LISTEN/NOTIFY), `ChangePoller` (2 s fallback) |
| `src/sse.ts` | one SSE loop: initial batch, wake on push, poll, heartbeat, abort |
| `src/routes/*.ts` | health, devices and pairing, projects / tasks / decisions / queue / uploads, inbox and requests, remote commands, sessions and live log, `/events`, costs, reviews, `/sync/outbox` |
| `src/views.ts` | row to view mapping (`ProjectCard`, `TaskView`, `MessageView`, ... from ADR 0011) |
| `src/mirror/github.ts` | `GitHubMirror`: push tasks and milestones to issues, pull comments and closes |
| `src/outbox.ts` | the client outbox contract, `MemoryOutbox`, `flushOutbox`, the service's `IdempotencyStore` |
| `src/state-file.ts` | `JsonState` (atomic JSON files under `<data>/state-api/`) |
| `src/errors.ts` | `ApiError`, `ForerunnerError` code to HTTP status mapping |

### Request pipeline

Request id → CORS (only when `FORERUNNER_STATE_API_CORS_ORIGIN` names the approvals web
origin; otherwise no CORS headers at all) → body limit (256 KB JSON, upload cap on
`/projects/:id/uploads`) → authentication → rate limit → schema check → route. Errors are
`{ code, message, details }`: `not_found` 404, `version_conflict` / `claim_conflict` /
`findings_open` 409, `validation` 400, `forbidden` 403, `unauthorized` / `bad_signature` 401,
`biometric_required` 403, `rate_limited` 429 with `Retry-After`, `payload_too_large` 413,
`schema_mismatch` 409. 5xx bodies carry no detail; the access log is at debug level and
never includes headers (the platform logger redacts anyway).

### Pairing flow (spec R.2)

1. Desktop (admin token): `POST /pairing/start { humanId, kind: "phone" | "web", scopes?, name?, ttlSeconds? }`
   → `{ code, expiresAt, qr: { v, code, humanId, kind } }`. The desktop shows the QR with the
   service URL. Codes live ten minutes in the service's memory and are single use.
2. Phone: generates an Ed25519 key pair in its keystore, then
   `POST /pairing/complete { code, publicKey, proof: sign("pair:<code>"), name, platform, pushToken? }`
   → `201 { deviceId, humanId, kind, token, expiresAt, scopes, schemaVersion }`. The token is
   shown once; the service stores its SHA-256 only. A public key can pair once.
3. From then on: `Authorization: Bearer <token>`; mutations add `X-Device-Signature`
   (Ed25519 over `METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0|1`) and
   `X-Device-Timestamp` (±5 minutes). `GET /me` shows the principal, scopes and expiry.
4. Lost phone: desktop `POST /devices/:id/revoke` → `DeviceRepo.revoke` plus token deletion;
   the next request of that device is refused (`401 unauthorized`).

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
| `GET /health` | public: `version`, `schema { code, applied, state: current/pending/ahead }`, `compatibleSchemaVersion`, `time`, realtime and mirror status |
| `GET /me` | principal, scopes, expiry |
| `GET /devices?humanId=`, `GET /devices/:id`, `POST /devices/:id/revoke` | devices see their own human's; revoke is admin |
| `GET /projects`, `GET /projects/:id`, `GET /projects/:id/milestones` | `ProjectCard` with spend, budget, waiting count, health, next milestone, latest critic grade |
| `GET /projects/:id/tasks?status=&limit=&offset=`, `GET /tasks/:id`, `POST /tasks/:id/transition { version, to, reason }` | workflow graph and version check from `TaskRepo.transition` |
| `GET /inbox?humanId=|agentId=&unreadOnly=1`, `GET /messages/:id`, `POST /messages`, `POST /messages/:id/receipt { state: delivered|read|acted }` | receipts are monotonic, first wins; a device touches only messages to or from its human's agents |
| `GET /requests?humanId=&projectId=`, `GET /requests/:id`, `POST /requests/:id/answer { version, answer }` | 409 on a stale version |
| `GET /projects/:id/decisions?all=1`, `POST /projects/:id/decisions { question, options, chosen, rationale, supersedes? }` | |
| `GET /projects/:id/queue`, `POST /projects/:id/queue { kind, text, priority, transcript? }` | notes, tasks, ideas for the next session |
| `GET /projects/:id/uploads`, `POST /projects/:id/uploads` (multipart `file`, optional `kind`) | `data_asset` row; file under `<data>/uploads/<project>/<asset id>-<safe name>`; metadata only in responses |
| `POST /remote/commands { target: pc|cloud, targetDeviceId?, command: start|pause|stop|kill, params }`, `GET /remote/commands`, `GET /remote/commands/:id` | the phone's view of its commands |
| `GET /remote/commands/pending?target=&deviceId=` (admin) | atomic pick-up (`RemoteCommandRepo.pickUp`): 200 with the command or 204 |
| `POST /remote/commands/:id/complete|fail { result }` (admin) | |
| `GET /sessions?agentId=&projectId=&status=`, `GET /sessions/:id` | `SessionView` with the current task |
| `GET /sessions/:id/events?afterSeq=` | JSON page, or SSE with `Accept: text/event-stream` (`session.event`, `session.changed`, heartbeat; `Last-Event-ID` = seq) |
| `GET /events` | SSE change feed, see Realtime |
| `GET /costs?projectId=&humanId=&from=&to=` | `CostView`; devices only for their own human |
| `GET /reviews?taskId=|projectId=`, `GET /reviews/:id` | reviews with findings, task title and PR URL |
| `POST /reviews/:id/comment { body, fromAgentId? }` | message to the task's owner or claimant from the human's principal agent |
| `POST /reviews/:id/approve|reject { body?, requestVersion? }` | decision message (requires ack) plus the answer to the task's open approval request |
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
(project-wide); admins see everything. Heartbeat every 15 s.

Three sources feed the bus: (1) the service's own writes (`announce()` in routes); (2)
`PostgresNotifier`: every local event is `pg_notify`'d on `forerunner_changes[_<schema>]`
and a dedicated `LISTEN` client ingests what other instances publish (own origin and
already-seen `(table, id, version)` are dropped; the connection reconnects with backoff);
(3) `ChangePoller`: every 2 s, rows with `updated_at` (or `created_at` for `event`) at or
after a per-table high-water mark are announced, so writes the runtimes make directly to
Postgres are seen too. No triggers; `packages/state` is unchanged. Realtime is best effort:
the session log stream and the inbox fetch from the database on every wake or poll.

### Remote control (spec R.4)

The phone enqueues a `remote_command` (issuer = its device). The PC runtime polls
`GET /remote/commands/pending?target=pc&deviceId=<its device id>` every few seconds (or
wakes on a `remote_command.changed` event) and gets the oldest pending command addressed to
it or to nobody, atomically; the cloud runner does the same with `target=cloud`. It reports
`complete` or `fail` with a result the phone can show. Two pickers never get the same command
(tested).

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
`FORERUNNER_MIRROR_TOKEN_REF`; `main.ts` wires the mirror when both are set (scheduled every
`FORERUNNER_MIRROR_INTERVAL_MS`, default 60 s) — see Known issues for the current status.

### Offline story (phase 2 gate)

- Solo mode: local SQLite, no service.
- Paired mode, online: the PC works on Postgres directly; the service pushes.
- Paired mode, Postgres unreachable: the PC stays read-only on its last state brief, makes
  no claims or transitions, and queues outbound messages, receipts, answers, notes and remote
  commands in an `Outbox` (`src/outbox.ts`). On reconnect `flushOutbox` posts batches to
  `POST /sync/outbox`; `clientId`s are remembered for a week (`idempotency.json`) so a retry
  after a lost response applies nothing twice; rejected actions (4xx) are dropped by the
  client, transport failures keep the queue. Its claims lapse after 30 minutes
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
| `FORERUNNER_STATE_API_RATE_LIMIT` | 60 | requests per minute per device |
| `FORERUNNER_STATE_API_BODY_LIMIT` / `_UPLOAD_MAX_BYTES` | 256 KB / 25 MB | body caps |
| `FORERUNNER_STATE_API_TOKEN_TTL_MS` / `_SIGNATURE_WINDOW_MS` | 30 days / 5 min | auth windows |
| `FORERUNNER_STATE_API_POLL_MS` / `_HEARTBEAT_MS` | 2000 / 15000 | realtime timers |
| `FORERUNNER_STATE_API_MIGRATE` | unset | `1` applies pending migrations on start (an empty database is always migrated; a newer database refuses to start) |
| `FORERUNNER_CHF_PER_USD` | ledger rate | fallback conversion for USD-only figures |
| `FORERUNNER_MIRROR_REPO` / `_TOKEN_REF` / `_INTERVAL_MS` | off | GitHub mirror |

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
| `auth.test.ts` | canonical signature, scopes, pairing (single use, proof, expiry), token expiry, revocation within one request, signature window both ways, query string inside the signature, scope 403s, high-risk needs signed + biometric (a forged flag is a signature failure), admin token (no prefix match), rate limit 429 and recovery, schema mismatch 409, CORS only for the configured origin, 413 |
| `routes.test.ts` | health, 404 shape, project cards, task list / get / transition (409, 400 illegal, 404), inbox and receipts (monotonic, first wins, other humans 403), agent inbox, requests (answer, 409, 404), decisions and supersede, queue, costs (own human only), reviews (comment → message, approve → request answered), sessions and the JSON event page, uploads (metadata only, safe name, cap, missing file) |
| `remote.test.ts` | enqueue, atomic pick-up (two pickers, one wins), per-device addressing, complete / fail lifecycle, device cannot pick up, validation |
| `realtime.test.ts` | `ChangeBus` buffer / resume / dedupe / filter; over a real server with `fetch` and a `ReadableStream` reader: event after a write, per-human filtering, polling fallback for direct store writes, `Last-Event-ID` resume, heartbeat on the simulated clock, session log stream with `afterSeq`, 401 |
| `mirror.test.ts` | rendering, idempotent push, label and state updates, comment sync back (quoted, once, marker ignored), close sync back (done when allowed, cancelled otherwise, ignored with open findings), reopen on GitHub is undone |
| `outbox.test.ts` | `flushOutbox` ordering, rejection, transport failure; `IdempotencyStore` persistence and TTL; `/sync/outbox` batch, duplicates, scope per action, end to end |
| `main.test.ts` | config defaults and validation, admin token by env or reference, `startService` boot / health / stop, refuses a newer schema |

`pnpm vitest run --project integration services/state-api/test` with `FORERUNNER_TEST_PG`:
`state-api.integration.test.ts` runs two service instances on one Postgres schema
(LISTEN/NOTIFY delivery across instances, polling fallback) and the 48-hour offline scenario.
Skipped visibly without the variable.

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
- `main.ts` does not yet construct the mirror: it needs a `GitHubHost` whose token comes from
  the vault by reference, and the service has no vault dependency. The runtime (which has
  the vault) can host the mirror loop with `GitHubMirror` directly; wiring it into the
  service process is a follow-up once secret injection for services is decided.
- Pairing codes and the SSE resume buffer are per instance; several instances need sticky
  sessions. Session tokens and idempotency keys are JSON files, so they are per instance too
  unless the volume is shared.
- `cost_ledger` is not polled (sums are computed on request); a `cost_ledger.changed`
  event exists in the type union for a future opt-in.
