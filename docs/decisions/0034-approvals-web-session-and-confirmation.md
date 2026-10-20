# 0034 — Approvals web: session from a one-time link, per-tab device key, re-entered code for high-risk answers, chat as a remote command

Date: 2026-10-20
Status: accepted

## Context

Spec K.8 asks for "a web fallback for approvals" next to the Android app; module J for one
inbox of human requests with context, why, options and the blocking flag; module R makes the
phone's approvals the model: multiple-choice answers, `confirm:high` with biometrics for
high-risk ones. ADR 0009 gives the web page the same device model as the phone (an Ed25519
key, a scoped session token, signed mutations, `confirm:high` only with a signed biometric
flag) and ADR 0024 says the state service serves the page. A browser has none of what the
phone shell provides: no OS keystore, no biometric prompt, no pairing screen with a QR scanner,
and it must open from a link the human receives. The spec leaves open how the page gets its
token, where the key lives, what replaces the biometric step and how quick chat reaches the
PC when the page cannot run anything.

## Decision

1. **The link carries a one-time code in the URL fragment.** The desktop runtime issues the
   link: `POST /pairing/start { humanId, kind: "web", scopes, ttlSeconds }` (ADR 0009) and
   `<service url>/<page path>#code=<code>`. A fragment is never sent to a server, so the code
   stays out of access logs, proxies and referrers; the page never accepts a code from the
   query string, and it removes the fragment with `history.replaceState` before anything else
   runs, so a reload or a copied address cannot replay it. Codes are the service's: eight
   characters, ten minutes, single use.
2. **The page exchanges the code itself** (`POST /pairing/complete`, the public route) with a
   fresh WebCrypto Ed25519 key and the proof `sign("pair:<code>")`, exactly as the phone does.
   The token the service returns is the device's session token with the scopes the issuer
   chose (`confirm:low` in the task's words: every scope on the token is a low-risk one).
3. **Key and token share the tab's life.** Both live in `sessionStorage` only (the private key
   as a JWK next to the token): never a cookie, never `localStorage`, never a log line, and
   nothing survives closing the tab. A browser has no keystore the page could use, and a key
   that outlives the token would be a liability without a benefit. The device row stays on
   the service until the desktop revokes it or its token expires (30 days); `Settings →
   Devices` lists it as `web`. Tests assert the token is absent from `document.cookie`,
   `localStorage`, console output, every request URL and the address bar.
4. **High risk on the web is a re-entered fresh code, not a biometric flag.** The page never
   sets `X-Biometric-Assertion` and always signs `biometric=0`; the service must keep refusing
   a biometric flag from a `web` device. For a request whose `risk` or change-card risk is
   `high`, the page asks the service for a challenge, the service sends a fresh code through
   the human's notification channel (push to the paired phone, the desktop app, or email),
   and the human types it in:
   - `POST /confirm/challenge { requestId }` (signed, scope `write:approvals`) →
     `201 { challengeId, expiresAt, channel }`; `channel` is plain words for the screen.
   - `POST /requests/:id/answer { version, answer, confirmation: { challengeId, code } }`
     (signed). A valid, unused, unexpired code for that request grants `confirm:high` for that
     one answer. Wrong, used or expired → `403 confirmation_invalid`. Codes are eight
     characters without look-alikes, ten minutes, single use, five attempts, and the challenge
     route is rate limited like pairing.
   The state service does not have the route yet (it refuses a high-risk web answer with
   `403 biometric_required`). The page handles the missing route by name (`404 not_found` on
   the challenge) and tells the human to confirm from the phone or the desktop app; the fake
   service used by the page's tests implements the contract above so the screens are built
   and tested against it. The link's own code is never accepted as a confirmation code.
5. **Quick chat is a `chat` remote command.** The page enqueues
   `POST /remote/commands { target: "pc", command: "chat", params: { projectId, text } }`;
   the PC daemon picks it up like any remote command (ADR 0024, ADR 0026), has the
   conversation agent answer it read-only (module O: no actions from this path) and completes
   it with `result: { reply }`; the page shows the reply when the command's change event or
   its poll reports `done`, and a failure's `result` in plain words. The service's command
   enum (`start | pause | stop | kill`) gains `chat`; until it does, the page shows the
   service's `validation` refusal as "does not relay chat yet". Chat needs `write:remote`,
   which the web default scope set does not include: the issuer adds it when the human should
   be able to chat and stop work from the web; without it the screen is disabled and says why.
6. **The kill switch is the `kill` remote command** with `params: { scope: "all" }` to every
   runner that is present: `pc` when a PC is online, `cloud` when a session runs on the cloud
   runner; after a confirm dialog. It is enabled when either is there (work running only on
   the cloud runner can be stopped from the web); nothing is queued for an offline PC, which
   would otherwise execute a stale kill when it next came up. Each target is its own request,
   so a refusal for one never hides the other's status. The page shows pick-up and outcome as
   they arrive, and fetches each command once right after subscribing to the feed, since the
   events can precede the subscription and the feed does not poll in live mode.
7. **"A PC is online" is derived, not declared.** Any of: a `desktop` device seen in the last
   five minutes, a session running or paused on the `pc` runner, or a remote command a runner
   touched in the last five minutes. Chat is disabled, with the reason, when none holds; the
   kill switch when neither a PC nor the cloud runner is present (item 6). The daemon should
   register itself as a `desktop` device and bump
   `last_seen` while it runs so the first signal becomes the normal one.
8. **Realtime without a query token.** `EventSource` cannot send headers and the service takes
   no `?token=`, so the page reads `GET /events` with `fetch` and a stream reader, resumes with
   `Last-Event-ID`, and falls back to polling (every 5 s, retrying the stream every 30 s).
   Nothing depends on the stream: screens reload on every poll and the inbox screen reports
   its own counts to the header.
9. **Routes in memory.** The page is two screens (Inbox, Chat); a `MemoryRouter` keeps the
   service free to mount `dist/` at any path and keeps the fragment for the code.

## Consequences

- One contract for devices: the service sees a `web` device that signs like a phone; nothing
  in `services/state-api` had to change for the page to read and answer low-risk requests.
- Two service additions are needed for the full page and stay under Known issues in
  `docs/maintainers/apps.md` until done: the `/confirm/challenge` route with the confirmation
  check in `answerRequestAs`, and `chat` in `REMOTE_COMMANDS` plus the daemon's pick-up of
  remote commands (none is consumed today).
- A high-risk answer from the web costs one extra round trip and a notification; that is
  the point.
- A tab is a device: a human with three tabs has three device rows until they expire or are
  revoked. Acceptable for 1.0; a later version may let a tab reuse a key stored in IndexedDB
  behind WebAuthn.

## Alternatives considered

- **Cookie session set by the service** when it serves the page: simpler, but it makes the
  page's requests unsigned and indistinguishable from a CSRF, and it would need a second auth
  path in the service. Rejected.
- **Token in the link** instead of a code: the token would sit in browser history, logs and
  referrers. Rejected; the code is single use and short lived, the token never leaves the
  tab.
- **WebAuthn / passkeys for the high-risk step**: the right long-term answer (ADR 0009 says
  so); the browser prompt would give the service a verifiable assertion instead of a code.
  Deferred: it needs registration UI and a service verifier; the re-entered code works today
  with the notification channel the phone already uses.
- **Chat through the daemon API** from the web page: the daemon binds 127.0.0.1 only (ADR
  0026) and the page may be anywhere. Rejected.
- **`HashRouter`**: it would own the fragment the code travels in. Rejected.
