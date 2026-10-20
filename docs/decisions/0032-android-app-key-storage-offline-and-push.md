# 0032 — Android app: one bundle under `/m`, Keystore-wrapped device key, remote plan envelope, offline scope, push stand-in

Date: 2026-10-20
Status: accepted

## Context

Spec module R asks for a Tauri 2 Android app that shares the desktop React UI, pairs by QR
with its own revocable key, reads and writes the shared state service directly, works
offline and queues actions, controls sessions on the PC, answers requests with biometrics for
high-risk ones, gets push notifications, and keeps every secret and all private memory off
the phone. ADR 0009 fixed the device model (Ed25519 key, scoped session token, signed
mutations, `confirm:high` only with the biometric flag inside the signature), ADR 0024 the
service the phone talks to, ADR 0026 that the phone never reaches a PC's daemon, ADR 0030 the
command registry, risk levels, change cards and undo on the PC. The spec leaves open where
the key lives on Android, how the shared bundle becomes a phone app, what one combined
request looks like on the wire, what exactly works offline, and what to do about push when
no Firebase project exists (`docs/status/BLOCKERS.md`).

## Decision

1. **One bundle, mounted under `/m`.** `apps/ui` renders `MobileApp` when the shell injects
   `platform: "android"` or the page is opened under `/m` (`App.tsx`, `isMobileShell`). The
   shell serves the bundle at `/`, so the router's basename is `/` there and `/m` in a
   browser (`mobileBasename`). The phone screens (`src/mobile/`) use the state service client
   (`api/state-client.ts`, `api/state-sse.ts`), never the daemon client. Outside the Tauri
   shell the same screens run with a WebCrypto key, browser storage and a dialog that says it
   is a simulated biometric prompt (the Settings screen names both as fallbacks); that is how
   the Playwright phone specs run without an emulator.
2. **The device key is an Ed25519 seed made in Rust and stored wrapped by the Android
   Keystore.** The Keystore cannot hold Ed25519 keys before API 33 and the app supports API
   29+, so `apps/mobile/src-tauri/src/keystore.rs` generates the seed (`ed25519-dalek`),
   writes it to the app's private files with mode 0600, and wraps it through the Kotlin
   `KeystorePlugin` (`gen/android/app/src/main/java/app/forerunner/mobile/KeystorePlugin.kt`):
   one AES-256-GCM key generated inside the Keystore, StrongBox-backed when the phone has
   one, never exportable; a wrapped value is `IV || ciphertext || tag`. The session token the
   service issues goes through the same store (`secure_store_*` commands). The seed exists in
   plain form only in process memory while the shell signs; it never crosses the IPC bridge
   (the UI sees the public key and signatures only), never appears in logs (`Debug` redacts)
   and never leaves the phone. Desktop builds of the shell (dev runs, `cargo test`) use the
   identity wrapper and report `secure_store: "file"` so the UI can say so. "Forget this
   device" deletes the files; revocation is the desktop's (`POST /devices/:id/revoke`, admin
   only), and a revoked device is refused on its next request.
3. **Signing happens in the UI against a `DeviceSigner` port; the biometric flag is bound
   to a one-time ticket the shell issues.** `state-signing.ts` builds the canonical string
   exactly as `services/state-api/src/auth/crypto.ts` does
   (`METHOD\npath?query\nsha256(body)\ntimestamp\nbiometric=0|1`); `ShellSigner` signs through
   the `device_key_sign` command in the shell, `WebCryptoSigner` elsewhere. The signed
   timestamp is strictly increasing per client so two identical mutations in one millisecond
   never share a signature (the service accepts a mutation signature once, ADR 0009
   amendments). The biometric flag enters the string only from a `BiometricAssertion` that a
   `BiometricPort` produced, and that is enforced, not a convention: a successful
   `assert_biometric` (tauri-plugin-biometric, `asserted: true` only after Android's prompt
   succeeded) issues a random one-time ticket that the shell keeps (`biometric::TicketBook`:
   one outstanding ticket, 120 s, replaced by the next prompt) and returns it inside the
   assertion; `device_key_sign` signs a string whose last line is `biometric=1` only when the
   call presents that ticket, and consumes it with the signature. UI code that fabricates
   `{ asserted: true }` gets `biometric ticket missing` from the shell (and from `ShellSigner`
   before the IPC), a guessed ticket gets `unknown or already used`, a second use of a real
   assertion is refused too; `biometric=0` strings and the pairing proof never need a ticket.
   The client turns the refusal into `biometric_required` and sends nothing. Outside the shell
   the simulated dialog says `method: "simulated"` and draws its ticket from
   `WebCryptoSigner.tickets`, which applies the same rule, so the unit and Playwright specs
   exercise it. A high-risk answer is never queued offline, because its flag must be inside
   the signature of the request that carries it.
4. **One combined request is one remote command carrying a plan.** The phone turns a
   sentence or the controls into module-Q commands (`mobile/intent.ts`, the phone-side
   subset of `packages/commands/src/intent.ts`: switch, go back, give / set budgets with a
   CHF amount and an until-time, raise the monthly cap, start / stop / pause, add a note;
   anything else is one short question with options), builds ONE change card for the whole
   plan (`mobile/change-card.ts`: parts in order, the highest risk and widest scope win, the
   earliest expiry gives the duration) and, after the tap, sends ONE `POST /remote/commands`
   with `target: "pc"`, the verb from `verbForPlan` (`kill` when every step is
   `session.stop` with `scope: "all"`, `stop` / `pause` for pure session control, else
   `start`) and `params`:

   ```
   { v: 1, kind: "plan", plan: [{ name, params }, ...], wordsUsed, card, clientId, confirmedAt, undoOf? }
   ```

   Quick chat is `{ v: 1, kind: "chat", text, projectId, clientId }` on the same route. The
   PC's daemon runs the plan through the command registry with the same enforcement as the
   settings screen (ADR 0030, spec Q.12); the phone's card is the human's preview, the
   executor re-plans against the real state, and a high-risk step comes back as a human
   request the phone answers with `confirm:high`. The preview's old values come from what
   the phone knows and never from constants: the projects' budgets, the human's monthly cap
   when `/me` carries `monthlyCap` (the service does not send it yet, so the card says "the
   current cap" and treats a monthly change as a raise, high risk, until then) and the CHF
   rate the project money pairs imply (`DEFAULT_CHF_PER_USD` only when no pair is known).
   Project names that contain a clause word ("Rock and Roll") are guarded before the
   sentence is split into clauses. The change log on the phone
   (`mobile/change-log.ts`, per install, 200 entries) records the words, the commands, the
   card, the PC's result and the inverse plan; Undo sends the inverse plan (reverse order:
   stop the started session, restore the budget, switch back) as a new plan with `undoOf`.
   The service keeps the remote command rows; a device-facing change-log route can replace
   the local log later without changing the screens.
5. **Offline scope.** The phone keeps, per install, the session record (ids, scopes, expiry;
   never the token, which is in the secure store), the active project, quiet hours, the
   change log and the outbox. While the service is unreachable the screens show the last
   loaded projects and inbox of this app run and the header says `offline`; answers to low
   and medium-risk requests, read receipts, notes and confirmed plans go to the outbox
   (`mobile/outbox.ts`, the client side of the service's `Outbox` contract) and are flushed
   through `POST /sync/outbox` on reconnect, where the client ids make retries idempotent and
   a queued plan's id is its change-log entry id. Not queued: pairing, high-risk answers (3.),
   quick chat and the kill switch, which all need the service now and say so. An auth loss
   (the desktop revoked the device, or the 30-day token expired) drops the token, the
   session record and the key (the service refuses a reused public key at pairing) but keeps
   the outbox and the change log: the notice counts the queued actions, the pairing screen
   repeats it, and `pair` flushes them under the new device; only "Forget this device"
   clears them. Sync status is `live` (SSE on `/events` with `Last-Event-ID` resume),
   `polling` (the stream failed; the inbox and pending commands are polled every 5 s, the
   stream retried every 30 s) or `offline` (polling fails too); Settings and the header show
   it.
6. **Push is a visible polling stand-in until FCM exists.** `push.rs` exposes one `PushPort`;
   `configured(token)` returns `FcmPush` only when the platform side handed over a
   registration token and `PollingPush` otherwise, and the UI's `push.ts` raises in-app
   notices for approvals, finished sessions, budget warnings and messages from the change
   feed, honouring quiet hours. Settings says `polling — FCM not configured`. The FCM wiring,
   when a Firebase project exists: `google-services.json` and the `firebase-messaging`
   dependency in `gen/android/app/build.gradle.kts`, a `FirebaseMessagingService` that posts
   the notification and forwards the payload to the WebView, `KeystorePlugin.info` returning
   `fcmToken`, the token registered at pairing as `pushToken` (`device.push_token` already
   exists in the schema), and the state service sending through FCM HTTP v1 with a service
   account resolved by reference. Nothing in the app depends on push: every screen reads the
   service itself.
7. **Pairing link and QR.** The desktop encodes `fr://pair?u=<service url>&c=<code>[&h=<human>]`
   in its QR; the barcode plugin or the camera app (deep link, scheme `fr`) hands it to the
   UI, which pre-fills the pairing form; a typed code and URL always work. The shell remembers
   `u` in `<config>/mobile.json` for the next launch and injects it as `stateUrl`.
8. **Emulator run.** `apps/mobile/e2e/run.mjs` drives a debug APK on an emulator through the
   WebView's DevTools socket with Playwright over CDP, against the same fake state service the
   browser specs use; it skips visibly without a device and fails on a skip only when CI asks
   (`FR_ANDROID_REQUIRE=1`). A release APK cannot carry the smoke (WebView debugging off), so
   the runner builds a debug APK when it finds only a release one (the workflow's artefact
   build) and, with `--no-build`, treats a release APK as a skip like any other, so the CI
   emulator job cannot pass on install-and-launch alone.

## Consequences

- No secret on the phone except its own wrapped seed and a 30-day scoped token; losing the
  phone is one click on the desktop and the shell can be reinstalled without touching the
  service. Tests assert the token and the seed never appear in the shell's injection script,
  the fake service's access log, errors or browser storage.
- Nobody but the key holder with a passed prompt can add the biometric flag: the shell
  (`commands.rs` tests), the web signer and the client (`state-signing.test.ts`,
  `state-client.test.ts`, `mobile-shell-signer.test.ts`) all refuse a fabricated assertion,
  and a real one signs exactly one request.
- The PC does the work and keeps the last word: the phone cannot raise a limit by itself, and
  a plan the registry refuses comes back as `failed` in the change log.
- Until the daemon consumes `pc` remote commands with `kind: "plan"`, the scenario passes
  only against the fake service's simulated PC; `docs/status/BLOCKERS.md` carries the
  runtime work item and `docs/maintainers/apps.md` lists it as a known issue; no gate row
  claims the phone gate until it lands.
- The fake service imports the real `auth/crypto.ts` by relative path, so the signing
  contract cannot drift silently; a workspace dependency on the service package would be
  cleaner once the UI's `package.json` may change.

## Alternatives considered

- Keystore-held Ed25519 (API 33+ only): would drop API 29 to 32 phones or need two code
  paths; wrapping with a Keystore AES key gives hardware protection of the seed at rest on
  every supported phone. Revisit when the minimum SDK reaches 33.
- `@noble/ed25519` inside the WebView with the seed in web storage: simple, but the seed
  would live in JavaScript memory and the WebView profile, which R.7 forbids on the phone.
  Kept only as the WebCrypto fallback outside the shell, where the tests run.
- One remote command per registry command: simpler on the wire, but scenario 9 needs ONE
  change card and ONE confirmation for a combined request, and three commands could be
  picked up out of order by two runners.
- Local notifications scheduled by the shell: still needs the app to be running; the in-app
  notices from the change feed cover the same categories until FCM wakes the app.
