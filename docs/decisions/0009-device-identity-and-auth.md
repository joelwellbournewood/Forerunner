# 0009 — Device identity and auth for the state service: Ed25519 device keys, scoped tokens

Date: 2026-10-20
Status: accepted

## Context

The phone and the approvals web page read and write the shared state directly (spec R:
"reads and writes the shared state service directly"), but must never hold database
credentials, secrets or private memory (R.7). Each device needs its own key, listed in
Settings → Devices and revocable at once (R.2); a lost phone is revoked from the desktop.
High-risk confirmations (Q.8: raise the monthly hard ceiling, grant a capability, change
email mode, delete anything, change permissions) need biometrics on the phone, and a chat
or email "yes" alone is never enough. The desktop runtime and the cloud runner talk to
Postgres directly (ADR 0024) and use the service only for realtime, remote commands and
pairing, so they need a simpler credential.

## Decision

Two kinds of principal, resolved by `services/state-api/src/auth/principal.ts`:

| Principal | Credential | Who |
| --- | --- | --- |
| admin | `Authorization: Bearer <service admin token>` from `FORERUNNER_STATE_API_ADMIN_TOKEN` or a vault reference (`FORERUNNER_STATE_API_ADMIN_TOKEN_REF`), compared in constant time, never logged | desktop runtime, cloud runner |
| device | `Authorization: Bearer <session token>` plus, on every mutation, `X-Device-Signature` | phone, approvals web |

**Device identity.** Each device generates an Ed25519 key pair (`@noble/ed25519` with the
synchronous SHA-512 from `@noble/hashes`) in its OS keystore; only the public key reaches
the service and is stored on the `device` row (`public_key`, unique). Pairing is a one-time
code: the desktop (admin) calls `POST /pairing/start` with the human, the device kind
(`phone` or `web`) and optional scopes; the code (8 characters without look-alikes, ten
minutes, in service memory only) is shown as a QR with the service URL. The phone calls
`POST /pairing/complete` with the code, its public key and a proof (signature over
`pair:<code>`) and receives the device id and a **session token**: 32 random bytes,
URL-safe base64, shown once; the service keeps only its SHA-256 (in its JSON state,
`tokens.json`, ADR 0024) with the device id, the human, the scopes and a 30-day expiry.

**Scopes.** `read`, `write:inbox` (send, receipts), `write:queue` (notes, tasks, ideas,
uploads), `write:remote` (remote commands), `write:approvals` (answer requests, review
verdicts, task transitions, decisions). Phones get all five by default; the approvals web
page gets all but `write:remote`; `POST /pairing/start` may narrow the list. `confirm:high`
is never on a token: it is granted per request when the request is signed by the device key
**and** carries the biometric assertion flag. The shell is responsible for the biometric
prompt: it sets `X-Biometric-Assertion: 1` only after the platform biometric API succeeded
for this action, and the flag is inside the signed string so nobody but the key holder can
add it. Answering a human request whose `risk` (or change card risk) is `high` requires
`confirm:high`.

**Request signatures.** A device signs every mutation (and may sign reads):
`X-Device-Signature` is Ed25519 over the string
`METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0|1`, with the timestamp in
`X-Device-Timestamp` (ISO-8601 or epoch milliseconds) accepted within ±5 minutes of the
service clock. Unsigned mutations are refused with `bad_signature`.

**Revocation.** `POST /devices/:id/revoke` (admin) sets `device.revoked` through
`DeviceRepo.revoke` and deletes the device's tokens. Every request re-reads the device row
(one indexed lookup), so a revoked device is refused on its next request, within one request
of the revocation. `last_seen` is written at most once a minute.

**Rate limit.** A token bucket per device, 60 requests per minute by default (admin ten
times that, unauthenticated pairing completions one sixth), with `Retry-After` on 429.

## Consequences

- No secret ever lives on the phone except its own private key and a session token that
  grants only the listed scopes for 30 days; losing the phone means one click on the desktop.
- Session tokens are stored by the service, not in Postgres (no schema change in 1.0); a
  service that loses `tokens.json` forces every device to pair again, which is safe.
- Pairing codes are held in one service instance's memory. Several instances behind one
  load balancer would need sticky sessions for the pairing flow (not needed for 1.0).
- Admins are trusted peers: they do not sign requests and skip the biometric rule, because
  the runtime already enforces autonomy and approvals in its hooks before anything reaches
  the service.

## Alternatives considered

- JWTs signed by the service: self-contained but hard to revoke within one request without
  a denylist, which is the same lookup we do on the device row anyway.
- mTLS client certificates: strongest binding, but certificate management on Android and in
  the web page is heavy and the approvals web page could not use it.
- WebAuthn / passkeys for the biometric step: the right long-term answer for the web page;
  for 1.0 the shell's platform biometric prompt plus a signed flag is enough and works the
  same in the Tauri Android shell and the web fallback.

## Amendments (2026-10-20, from the review of the first build)

Recorded here rather than in a new ADR because they sharpen this decision without changing
it; the code and `docs/maintainers/state-service.md` follow these rules.

- **Replay.** A verified signature on a mutation is single use inside the five-minute window
  (`ReplayGuard`, per service instance): the identical signed request presented again is
  refused with `401 bad_signature`. A client retries by signing again with a fresh timestamp;
  `/sync/outbox` client ids keep the retry idempotent. Signed reads are not recorded, so a
  client may poll with one signature. The spec accepted the plain window; this closes the
  capture-and-resend case at no cost to honest clients.
- **Admin callers are split by install.** The runtime and the cloud runner send
  `X-Forerunner-Install: <id>` (1 to 64 characters of `A-Z a-z 0-9 . _ : -`); the admin rate
  limit bucket and the outbox idempotency space are keyed by it, so one chatty install cannot
  starve the others and client ids from different installs cannot collide. Without the
  header they share the `default` bucket. A malformed header is ignored, never an error.
- **Receipts come from the addressee only.** `delivered`, `read` and `acted` are the
  receiver's facts (spec F.2). A device may post a receipt only when the message is addressed
  to its human or to one of its human's agents; the sender's device may read the message
  (`GET /messages/:id`) but never acknowledge it. The runtime (admin) may receipt on behalf
  of any agent inbox it serves.
- **Devices act only for their own human, including requests and sessions.** A human request
  with no addressee (`human_id` null) is the runtime's to route and answer; devices get 403
  on it. `GET /sessions` and `GET /sessions/:id` are filtered to sessions of the device's
  human's agents, the same rule the live log route already applied: session summaries and
  handoff text are one human's working notes and are not project-wide. Task, milestone,
  decision and project views stay project-wide, as the spec's shared-project model needs.
- **Public rate limit key.** The unauthenticated pairing completion is limited per client
  address taken from the socket; `X-Forwarded-For` is honoured only when
  `FORERUNNER_STATE_API_TRUST_PROXY=1` declares a reverse proxy, since any client can set the
  header. Bucket maps are bounded and swept.
