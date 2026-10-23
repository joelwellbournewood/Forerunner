# w4-fcm-sender

## Build report

Item: w4-fcm-sender, stage BUILD, branch `wave/w4-fcm-sender`. Requirements R.6 and K.8.
ADR 0085 (the brief named 0084; that number was already taken on the base branch by
"Email routes fail closed without identity", so this ADR is the next free number and says
so in its header). Starting commit: `b9c4f1d` (the earlier attempt's `wip:` snapshot on top
of `59c6f47`, which added `DeviceRepo.setPushToken` / `pushTargets` and their store-suite
case; both kept).

### What was built

1. **FCM HTTP v1 sender** (`services/state-api/src/push/fcm.ts`, from the wip snapshot,
   reviewed and finished): `FcmSender` posts
   `POST <api>/v1/projects/<project>/messages:send` with a bearer access token minted from
   the service account through the OAuth2 JWT-bearer grant (RS256 JWT signed with
   `node:crypto`, `iss` client email, `aud` the account's `token_uri`, scope
   `firebase.messaging`, one hour), cached until a minute before expiry, re-minted once on a
   401. 5xx, 429 and network errors are retried (four attempts, 0.5 s doubling backoff capped
   at 30 s, `Retry-After` honoured); other 4xx fail at once; 404 / `UNREGISTERED` is reported
   as `unregistered`. `parseServiceAccount` now also checks the private key parses as PEM, so
   a bad account shows at start; its errors name the field, never the content.
2. **Fan-out** (`services/state-api/src/push/fanout.ts`): `PushFanout` subscribes to the
   change bus and raises at most one notice per key for the four kinds (approval: open
   `human_request` for the human, blocking = urgent; session: completed / failed / stopped;
   budget: 80 % of the cap while running (normal) or stopped at the cap (urgent); message:
   unread message to the human, or to the human's agent from another human's agent). Each goes
   to every non-revoked device of the human with a `push_token`. Quiet hours: the human's
   `notify_prefs` through the runtime's `resolvePrefs` / `isQuietAt` with ADR 0017 urgency;
   urgent goes through, the rest is held and flushed on the first poller tick after the window.
   A dead token is cleared with a `push.token_cleared` audit row. Payloads are data-minimal
   (generic title/body, `data { kind, id, link, projectId? }`).
3. **Service wiring**: `config.ts` (`FORERUNNER_FCM_SERVICE_ACCOUNT_REF`,
   `FORERUNNER_FCM_PROJECT_ID`, `FORERUNNER_FCM_API_URL`), `main.ts` `resolvePushSender`
   (the account by reference through the same `SecretResolver` as the admin token; no
   reference, an empty reference or a bad file = push off with a visible reason, the service
   still starts), `app.ts` (`AppDeps.push`, the fan-out started with the app, flushed on every
   poller tick, stopped on close; CORS allows PUT), `GET /health` `push { mode: fcm|polling,
   enabled, reason, projectId, holding, counters, lastError }`.
4. **Token routes**: `POST /pairing/complete` already accepted and stored `pushToken` (kept,
   now tested). New `PUT /devices/:id/push-token { pushToken: string | null }`: signed, the
   device itself or admin (another device 403, unknown 404, revoked 409, empty 400), a
   `push.token_set` audit row without the token, a `device.changed` event. Device views carry
   `pushRegistered`, never the token.
5. **Android app**: unchanged, the documented stand-in. No `firebase-messaging`, no
   `google-services.json`, no Gradle change.
6. **Docs**: ADR 0085 (+ index row, a pointer in ADR 0032 item 6); `state-service.md`
   (layout, pairing step 4, routes, a "Push to Android" section, env vars, tests, known
   issues), `notifications.md` (how Android push relates to the notifier, the `"push"`
   channel note), `apps.md` (mobile push: what the service does now and what waits),
   `security.md` (service-side credentials by reference, the service account);
   `device.push_token` description in `packages/state/src/schema.ts` and the regenerated
   `data-model.md`; `requirements.md` R.6 and K.8 cite `push.test.ts` (both stay
   `in progress`: the app half is not built); `BLOCKERS.md` FCM row says the service side is
   done and only the app's Firebase wiring waits for the project (K.8 row too); `PROGRESS.md`
   log entry and the handover list.

### Tests that prove it

`services/state-api/test/push.test.ts` (17 tests), against `test/fake-google.ts`: a fake OAuth
token endpoint (verifies the RS256 signature with the account's public key, the grant type,
`iss`, `aud`, `scope`, lifetime) and a fake FCM HTTP v1 endpoint (bearer must be the last
minted token, project must match, scripted responses per registration token), both real HTTP
on 127.0.0.1.

- Sender: one access token minted and reused; 5xx retried with doubling backoff and given up
  after four attempts; Retry-After on 429; no retry on 400; UNREGISTERED reported once;
  token-endpoint 5xx retried and a 401 re-minted; the sender built by `resolvePushSender` from
  the reference and the env vars sends; bad account JSON / key rejected naming the field only.
- Routes: pairing stores `pushToken`, the view says `pushRegistered` without the token;
  `PUT /devices/:id/push-token` unsigned 401, other device 403, empty 400, set, clear, admin,
  404, audit rows without the token.
- Send for each kind: approval, budget warning, finished session and message each reach both
  of the human's token-holding devices and no tokenless device or other human; sent once;
  request reasons and message text never on the wire; budget stop is urgent (`HIGH`);
  own-agent messages not pushed.
- Quiet hours deferral: a normal request inside the window is held (`/health` holding 1), an
  urgent blocking request goes through, the held one goes out on the tick after the window.
- Unregistered token cleared: `push_token` null, `push.token_cleared` audit row naming the
  device and `UNREGISTERED`, not the token; `/health` invalidated 1; no further sends until a
  refresh, then delivery to the new token.
- Failure visible: a final 503 failure counted with `lastError` in `/health`.
- No secret in any log line: every log record at debug level, the `/health` body and every
  audit row are scanned for the private key body, `PRIVATE KEY`, every minted access token and
  every registration token (including an FCM error body that echoes the token).
- Unconfigured = no-op: no request reaches the fake, `/health` `push { mode: "polling",
  enabled: false, reason: "FCM not configured ..." }`; a reference resolving to nothing or to
  a bad key leaves push off with the reason, without the content.

`packages/state/test/suite.ts` "push targets are the human's active devices holding a token;
a cleared token drops out" (from commit `59c6f47`, run by `sqlite.test.ts`; the Postgres run
of the same suite needs `FORERUNNER_TEST_PG`).

### Commands run and results (2026-10-23, this sandbox)

Output pasted as printed (ANSI colours stripped; long vitest logs cut to the per-file lines
and the totals). `pnpm install --frozen-lockfile` finished with `Done in 7.6s using pnpm
v10.28.0`.

```
$ pnpm typecheck

Scope: 4 of 21 workspace projects
apps/approvals-web typecheck$ tsc -p tsconfig.json --noEmit
apps/desktop typecheck$ echo 'no TypeScript in the desktop shell; see @forerunner/ui'
apps/mobile typecheck$ echo 'no TypeScript in the mobile shell; see @forerunner/ui'
apps/ui typecheck$ tsc -p tsconfig.json --noEmit
apps/desktop typecheck: no TypeScript in the desktop shell; see @forerunner/ui
apps/mobile typecheck: no TypeScript in the mobile shell; see @forerunner/ui
apps/mobile typecheck: Done
apps/desktop typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
exit 0
```

```
$ pnpm lint
Diagnostics not shown: 39.
Checked 1162 files in 2s. No fixes applied.
Found 59 warnings.
exit 0
```

The 59 warnings are all from before this item; `pnpm exec biome check services/state-api packages/state`
prints `Checked 101 files ... No fixes applied.` with no diagnostics.

```
$ pnpm exec vitest run --project unit services/state-api/test
 ✓  unit  services/state-api/test/auth.test.ts (25 tests) 953ms
 ✓  unit  services/state-api/test/routes.test.ts (19 tests) 1152ms
 ✓  unit  services/state-api/test/realtime.test.ts (12 tests) 845ms
 ✓  unit  services/state-api/test/push.test.ts (17 tests) 750ms
 ✓  unit  services/state-api/test/shared-secrets.test.ts (7 tests) 621ms
 ✓  unit  services/state-api/test/audit-export.test.ts (7 tests) 726ms
 ✓  unit  services/state-api/test/remote.test.ts (7 tests) 517ms
 ✓  unit  services/state-api/test/main.test.ts (7 tests) 343ms
 ✓  unit  services/state-api/test/outbox.test.ts (7 tests) 322ms
 ✓  unit  services/state-api/test/mirror.test.ts (9 tests) 228ms
 ✓  unit  services/state-api/test/security-state-api.test.ts (31 tests) 7503ms
 Test Files  11 passed (11)
      Tests  148 passed (148)
```

```
$ pnpm exec vitest run --project unit packages/state/test
 ✓  unit  packages/state/test/schema.test.ts (20 tests) 253ms
 ✓  unit  packages/state/test/security-store.test.ts (13 tests) 321ms
 ✓  unit  packages/state/test/sqlite-adapter.test.ts (6 tests) 59ms
 ✓  unit  packages/state/test/lesson-scope.test.ts (4 tests) 55ms
 ✓  unit  packages/state/test/closeout-data-model.test.ts (2 tests) 55ms
 ✓  unit  packages/state/test/sqlite.test.ts (52 tests) 1023ms
 Test Files  6 passed (6)
      Tests  97 passed (97)
```

```
$ pnpm exec vitest run --project integration services/state-api/test packages/state/test
 ↓  integration  packages/state/test/migrations.integration.test.ts (1 test | 1 skipped)
 ↓  integration  packages/state/test/postgres.integration.test.ts (52 tests | 52 skipped)
 ↓  integration  services/state-api/test/state-api.integration.test.ts (3 tests | 3 skipped)
 Test Files  3 skipped (3)
      Tests  56 skipped (56)
```

The integration files skip because there is no Postgres in the sandbox
(`FORERUNNER_TEST_PG` unset).

```
$ node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk
docs-check: ok (26 files).
exit 0
```

Without `--base` the script cannot diff against `origin/main`, which this clone does not
have, and checks nothing; that is why the base branch is passed explicitly.

`pnpm check` (lint, lint:paths, typecheck, unit tests, docs:check, docs:links,
secrets:scan), the summary lines from its log:

```
check-paths: ok (988 files).
 Test Files  270 passed (270)
      Tests  2691 passed | 4 skipped | 1 todo (2696)
docs-check: cannot diff against origin/main (...); nothing to check.
link-check: ok (106 files).
secret-scan: clean (1412 files).
EXIT 0
```

### Patch export and verification

The patch is the plain series of this item's commits on top of the starting commit
(`/tmp/start-sha` = `b9c4f1d4bcea424aa54bc5642cb71d516a66bb0e`, copied to
`/mnt/session/outputs/w4-fcm-sender.start`). It is exported after this report is committed,
then checked with `git apply --check` against a clean worktree of the starting commit:

```
$ git log --oneline $(cat /tmp/start-sha)..HEAD     # only this item's commits
$ git format-patch --stdout $(cat /tmp/start-sha)..HEAD > /mnt/session/outputs/w4-fcm-sender.patch
$ git worktree add /tmp/verify $(cat /tmp/start-sha)
$ cd /tmp/verify && git apply --check /mnt/session/outputs/w4-fcm-sender.patch && echo APPLY_OK
APPLY_OK
$ git worktree remove --force /tmp/verify
```

`git apply --check` prints nothing on success; `APPLY_OK` is printed only when it exits 0.
The first export (six commits, `b3802e7` to `e1d995b`) printed `APPLY_OK`. This revision
adds one commit (this report with the pasted output) and was exported and checked the same
way, again printing `APPLY_OK`; the exact transcript of that final run, with the commit
list, is in `/mnt/session/outputs/w4-fcm-sender-apply-check.txt`.

### Left open, and why

- The Android app half (google-services.json, `firebase-messaging`, a
  `FirebaseMessagingService`, `KeystorePlugin.info` returning `fcmToken`, sending the token at
  pairing and on refresh) needs a Firebase project; the brief forbids adding it to the Gradle
  build without one. R.6 and K.8 therefore stay `in progress`.
- Held quiet-hour notices and the "sent once" keys are in memory per instance (documented in
  ADR 0085 and state-service.md Known issues): a restart inside a window drops held notices,
  and push should be enabled on one instance when several run.
- No live FCM send was possible (no project, no service account); the sender is proven
  against the stand-ins only.
- The Postgres integration run of the store suite was not possible here (no Postgres).
