## title

R.6 service side: the state service sends Android push notifications through FCM HTTP v1 with the service account by reference; the app registers its token at pairing

## requirements

R.6 (push for approvals, finished sessions, budget warnings and messages, with quiet hours); K.8

## adr

0084

## brief

BLOCKERS.md row 'Firebase project for FCM (Android push, spec R.6)': missing: no Firebase project, no google-services.json, no service account. Stand-in: visible polling (ADR 0032 item 6): `apps/mobile/src-tauri/src/push.rs` `configured(token)` returns `PollingPush` while the Kotlin `KeystorePlugin.info` hands over no `fcmToken`; the UI's change feed raises in-app notices with quiet hours; Settings says `polling — FCM not configured`. The wiring ADR 0032 item 6 lists: google-services.json and firebase-messaging in build.gradle.kts, a FirebaseMessagingService that posts the notification and forwards the payload to the WebView, KeystorePlugin.info returning fcmToken, the token sent at pairing as `pushToken` (`device.push_token` exists), the state service sending through FCM HTTP v1 with the service account by reference. Build ONLY the halves that need no Firebase project and cannot break the Android build: (1) the state service's push sender: an `FcmSender` using FCM HTTP v1 (`POST https://fcm.googleapis.com/v1/projects/<project>/messages:send` with an OAuth2 access token minted from the service-account JSON (RS256 JWT, node:crypto only) referenced by a secret name, never a value in config or logs), called by the service's notification fan-out for the four kinds (approval, finished session, budget warning, message) to every device of the human with a `push_token`, honouring the human's quiet hours (the existing rule), with retries/backoff on 5xx, token invalidation on 404/UNREGISTERED (clear the device's push_token with an audit row), and a `PollingPush`-style no-op when no service account is configured; (2) the pairing route accepting `pushToken` and storing it on the device row, and a `PUT /devices/:id/push-token` for refreshes, signed like other device routes; (3) tests against a fake FCM endpoint and a fake OAuth token endpoint in services/state-api/test (send for each kind, quiet hours deferral, unregistered token cleared, no secret in any log line, unconfigured = no-op with a visible reason in /health); (4) the Android app half stays the documented stand-in: do NOT add firebase-messaging or google-services.json to the Gradle build (it would fail without the project); update the BLOCKERS text in your blockersUpdate to say the service side is done and only the app's Firebase wiring waits for the project. Docs: state-service.md, notifications.md, apps.md (mobile push), security.md (the service account by reference). ADR 0084. Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read services/state-api/src (routes, the device row and pairing, how notifications fan out to devices today, the realtime/SSE path), packages/state device schema (`push_token`), apps/ui/src/mobile/push.ts and pairing.ts (what the app would send), docs/decisions/0032 item 6, docs/decisions/0017 (urgency and quiet hours). Keep every existing route test green.

## paths

services/state-api/src, packages/state/src, tests
