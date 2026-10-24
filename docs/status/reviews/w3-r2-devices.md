# w3-r2-devices: Settings → Devices on the desktop (R.2)

Item `w3-r2-devices`, stage BUILD, branch `wave/w3-r2-devices`. The base is
`ccr-4d8a843c-1k9syk` at e2bfb1e. The starting commit for this run is 88e4235: the earlier
attempt's uqr pin (908957c) and its unverified `wip:` snapshot of the daemon side (88e4235).

## Build report

### What was built

Spec R.2: "Pairing: scan a QR code from the desktop app. Each device gets its own key, listed
in Settings → Devices, and can be revoked at once." Before this run the service had the routes
and `state-client.ts` had `devices()`, but the desktop `SettingsPage` had no Devices section.

**Daemon (`packages/runtime/src/devices/`).** This finishes the `wip:` snapshot. That
snapshot did not compile: `server.ts` used `createDeviceRoutes` without importing it. It also
had no zod shapes and no tests.

- `types.ts` holds the zod schemas `DaemonDeviceView`, `DeviceListView`,
  `StartPairingBody`, `PairingStartView`, `RevokeDeviceView` and `DEVICES_ROUTES`. The file
  imports only zod. It is re-exported through `daemon/api-types`, and its three routes are
  spread into `DAEMON_ROUTES`, so the UI validates against the daemon's own schemas without
  a mirror.
- `manager.ts` (`DeviceManager`, exposed as `rt.devices`) does three things:
  - **list**: calls the service's `GET /devices?humanId=` and filters the result to the
    human again. This install's own device is marked `current`. Without a service URL the
    list comes from the shared store.
  - **start a pairing**: calls `POST /pairing/start`. It returns the code, its expiry, the
    service URL and `fr://pair?u=&c=&h=`, the same link format that `buildPairingLink` and
    `parsePairingPayload` in `apps/ui/src/mobile/pairing.ts` use. Without a service it fails
    as `unavailable`.
  - **revoke**: calls `POST /devices/:id/revoke`, or revokes the row in the store when no
    service is configured. It refuses this install's own device, and it checks ownership
    before calling the revoke route.
  - **Audit rows:** `devices.pairing_start` (never contains the code) and `devices.revoke`.
- **Admin token:** read from the vault on every call under
  `FORERUNNER_STATE_API_ADMIN_TOKEN_REF` (default `secret:state_api_admin`). The service URL
  comes from `FORERUNNER_STATE_API_URL`. The token never reaches the app, as ADR 0009
  requires: only the desktop runtime (admin) starts pairings and revokes. A missing token, a
  refused token or an unreachable host gives 503 `unavailable` with the status in
  `details`. The token and the response body are never included.
- `routes.ts` defines `GET /devices`, `POST /devices/pairing` (201) and
  `POST /devices/:id/revoke`. They are mounted in `server.ts` behind the bearer check.

**UI (`apps/ui`).**

- `client.ts` has three new methods, `devices()`, `startPairing()` and `revokeDevice()`,
  over `DAEMON_ROUTES`. The daemon is the path here, not `state-client.ts`, because that
  client holds a phone's device token and the service's pairing/start and revoke routes are
  admin-only.
- `components/QrCode.tsx` uses uqr 0.1.2 (pinned by the earlier attempt; no QR library
  existed in the workspace). It encodes with ECC M and a quiet zone of 4 modules, and draws
  the code as one SVG `<path>`, so no markup is injected.
- `lib/clock.ts` adds `UiClock`, `systemClock`, `useNow` and `formatCountdown`. This is the
  UI's injectable clock, so tests can step the countdown.
- `pages/DevicesSection.tsx`, mounted in `SettingsPage.tsx`:
  - **Pair a phone** shows the QR of the link, the code as `K7QX-2MPA`, the service URL, the
    link as text and the expiry counting down. When the code expires, the QR and code are
    removed and **Start a new pairing** appears. **Done** reloads the list.
  - **Device list:** name, kind and platform, paired at, last seen. This install is marked
    "this device" and has no Revoke button. Revoked devices sit under a collapsed
    "Revoked (n)".
  - **Revoke** opens a confirmation that says the revocation is immediate. On confirm the
    device leaves the active list at once, a note appears and the list reloads. If revoking
    fails, the error shows in the dialog and the device stays listed.
  - **Errors:** `pairingAvailable: false` disables the button and says what to configure. A
    503 is shown as a banner with Retry. A daemon without the routes shows the route-missing
    state (ADR 0037) for `GET /devices`, or for `POST /devices/pairing` alone.
- The fake daemon serves the three routes. A pairing's expiry is ten minutes after the
  fake's `now` option, which defaults to the wall clock. `pairingAvailable: false` simulates
  a daemon without a state service. New fixtures: `DEVICES` and `PAIRING`.

**Docs:**

- `docs/maintainers/apps.md`: the Settings row, the API client, the fake daemon, the tests
  and the known issues.
- `docs/maintainers/runtime.md`: a new section "Settings -> Devices", the tests, the
  requirements covered and the known issues.
- `docs/maintainers/state-service.md`: the pairing flow says the daemon proxies the admin
  routes, plus a row for the new test.
- `docs/requirements.md`: R.2 is now `done`, with the new tests.
- `docs/status/BLOCKERS.md`: the R.2 row says the item is built on this branch and lists
  what is still open.
- `docs/status/PROGRESS.md`: a new log entry, and the handover list notes the item is built.
- `CHANGELOG.md`: a new Added entry.
- No ADR: the brief named none, and the credential decision follows ADR 0009 (the desktop
  runtime holds the admin token).

### Tests that prove it

- `apps/ui/test/settings-devices.test.tsx` (new, 8 tests):
  - helpers: the code grouping, the countdown floor, and the QR path drawing exactly the
    encoded dark modules.
  - start a pairing:
    - the QR equals uqr's encoding of the link;
    - the phone's `parsePairingPayload` reads the link back to the code, service and human;
    - the code, the service and "in 10:00" are shown;
    - the countdown reads "0:30" and then expired on a stepped clock shared with the fake;
    - a new pairing can be started from the expired state.
  - the list: kind, platform, last seen, "this device" without Revoke, and the revoked device
    shown separately.
  - revoke: Cancel sends nothing. Confirm posts `/devices/dev_phone/revoke`, the phone leaves
    the list and the note appears.
  - a failed revoke keeps the device and shows the error.
  - route-missing for `GET /devices`, and for `POST /devices/pairing` alone.
  - no state service: pairing is off with what to set, and a 503 shows a banner with Retry.
- `apps/ui/test/settings.test.tsx` (new case): the whole app at `/settings` has the Devices
  section, pairing shows the QR and code, and revoking removes the phone. With
  `<DevicesSection />` removed from `SettingsPage.tsx`, this case fails (checked by hand:
  1 failed, 6 passed).
- `packages/runtime/test/devices-routes.test.ts` (new, 7 tests), against a stand-in of the
  service's admin routes:
  - 201 with the code, expiry and link; the admin bearer is sent but is not in the body; the
    audit row has no code.
  - 400 for a bad kind.
  - 503 without a service, without a token (no call is made), with a refused token, and with
    an unreachable host.
  - the list is filtered to the human, with this install marked `current`.
  - revoke goes through the service. This install's own device gets 400. Another human's
    device gets 404, and the revoke route is never called.
  - without a service: list and revoke go through the store; another human's device gets 403
    and an unknown id gets 404.
  - in the composed daemon: the `DAEMON_ROUTES` entries exist, the routes return 401 without
    the bearer, and a pairing uses the vault's token under the default reference and
    `FORERUNNER_STATE_API_URL`.
- `services/state-api/test/desktop-devices.test.ts` (new, 4 tests): `DeviceManager` against
  the **real** state-service app, with the daemon on its own local store:
  - pair → the phone completes the pairing with its own key, using the code from the `fr://`
    link → the phone is listed, this desktop is `current`, and another human's phone is not
    listed.
  - revoke drops one token, and the phone's next `/me` gets 401.
  - own, foreign and unknown devices are refused.
  - no token means no call is made; a wrong token is `unavailable` (401).

### Commands run and results (2026-10-23, on this branch)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | exit 0 (tsc node packages + apps/desktop, approvals-web, ui) |
| `pnpm lint` | exit 0; 59 warnings, none in the files changed here |
| `pnpm exec vitest run --project unit packages/runtime/test` | 115 files passed; 991 tests passed, 1 skipped |
| `pnpm exec vitest run --project unit services/state-api/test` | 11 files passed; 135 tests passed |
| `pnpm --filter @forerunner/ui test` | 43 files passed; 261 tests passed |
| `pnpm exec vitest run --project unit packages/runtime/test/devices-routes.test.ts` | 1 file, 7 passed |
| `pnpm exec vitest run --project unit services/state-api/test/desktop-devices.test.ts` | 1 file, 4 passed |
| `cd apps/ui && pnpm exec vitest run --config vitest.config.ts test/settings-devices.test.tsx test/settings.test.tsx` | 2 files, 15 passed (8 + 7) |
| `node scripts/docs-check.mjs --base 88e4235` | `docs-check: ok` |
| `node scripts/docs-check.mjs --base e2bfb1e` | `docs-check: ok` |
| `git format-patch --stdout 88e4235..HEAD > /mnt/session/outputs/w3-r2-devices.patch`, then `git worktree add /tmp/verify 88e4235 && cd /tmp/verify && git apply --check /mnt/session/outputs/w3-r2-devices.patch` | exit 0, no output (the patch applies cleanly to a clean checkout of the starting commit); `git log --oneline 88e4235..HEAD` lists exactly this item's 5 commits (runtime, ui, docs, build report, and this report's patch-check row), and the exported patch holds 5 `From ` headers. Re-run on the final export, after the commit that added this row |
| `pnpm check` | exit 0: lint, `check-paths: ok (994 files)`, typecheck, unit tests 271 files with 2684 passed, 4 skipped and 1 todo, docs check (no `origin/main` in this clone, so nothing to diff), `link-check: ok (105 files)`, `secret-scan: clean (1417 files)` |

The integration projects were not run for the touched packages. Their only files,
`services/state-api/test/state-api.integration.test.ts` and
`packages/runtime/test/sandbox.integration.test.ts`, need Postgres or a sandbox engine and
are unchanged by this item.

### Left open, and why

- **"Send web link" (`kind: "web"`).** The daemon route accepts `kind: "web"`, but the
  approvals web reads its code from `<page url>#code=`. No page URL is configured anywhere
  (the service does not serve `apps/approvals-web/dist`), so the section pairs phones only.
  This is listed in apps.md and runtime.md Known issues.
- **Live list refresh.** The daemon does not pass the service's `device.changed` frames on
  to its own `/events`, so the list reloads on Done or Refresh, not the moment the phone
  completes the pairing.
- **First real run.** All tests use the fake daemon (UI), a stand-in of the service (runtime
  routes) or the in-process service (state-api). Running the section against a real daemon
  and service is what remains to check: set `FORERUNNER_STATE_API_URL`, put the admin token
  in the vault, pair a phone and revoke it. This is the re-test column of the BLOCKERS.md
  row.
- **Not reviewed and not merged.** The requirement and gate totals in `gates.md` belong to
  the integration step: R.2 is `done` on this branch, giving 184 done, 39 in progress and
  5 todo.

## Review

Independent adversarial review, stage REVIEW AND FIX, 2026-10-23. Reviewed the branch at
1e3ca53 (`git diff 82a6295...HEAD`, 7 commits) against the brief, the spec (R.2, Q) and the
base `ccr-4d8a843c-1k9syk` at f1948dd.

**Verdict: revise.** Score: 72/100. The section is there and works on the happy path (the QR
is the real `fr://` link the phone parses, the admin token stays in the daemon, the
real-service test proves the pairing and the immediate refusal). But a hung service freezes
the screen, a lost phone cannot be revoked while the service is down, and a revocation from
the button leaves no change-log entry, although the registry has a `device.revoke` command for
the same thing.

### Requirements checked

- [x] R.2 "scan a QR code from the desktop app": `DevicesSection` → `POST /devices/pairing` →
  service `POST /pairing/start`; the QR encodes `fr://pair?u=&c=&h=`, and
  `parsePairingPayload` reads it back (`settings-devices.test.tsx`).
- [x] "Each device gets its own key": the phone completes the pairing with its own key
  (`services/state-api/test/desktop-devices.test.ts`, against the real routes).
- [x] "listed in Settings → Devices": the list shows name, kind, paired at and last seen, with
  this install marked. Partly met: a newly paired phone appears only after Done or Refresh
  (finding 4).
- [~] "can be revoked at once": works through the service. Not met when the service is
  unreachable, even though the shared store could revoke (finding 2).
- [x] Brief: the admin token never reaches the UI. It is read from the vault per call and
  is not in any body or the audit (`devices-routes.test.ts`).
- [x] Brief: the typed code and its expiry countdown run on an injectable clock.
- [x] Brief: ADR 0037 route-missing state, for the list and for the pairing route alone.
- [x] Brief: `settings.test.tsx` case. The build report says removing `<DevicesSection />`
  fails it; I re-checked this by reading the code: the case finds `devices-section`.
- [~] Spec Q ("nothing is UI-only"; the change log records "every change made by conversation
  or UI"): the revoke button bypasses the change log (finding 3).
- [x] Docs and status: apps.md, runtime.md and state-service.md describe the routes;
  requirements R.2 is `done`; the BLOCKERS row says the work is built and lists what is open.
- [x] Base merge: `git merge-tree` shows textual conflicts only (finding 6). The base's new
  `/me.desktopDeviceId` reads the same `rt.remote.device` as the list's `current` flag, so
  the two agree.

### Findings

1. **medium**: `packages/runtime/src/devices/manager.ts:205-226` (`call`). Calls to the state
   service have no timeout. If the service accepts the connection and never answers (a hung
   process, a proxy that holds the request), `startPairing`, `list` and `revoke` stay pending
   until undici's 300 s headers timeout. During that time the UI shows "Starting…" or
   "Revoking…" with no way out. Verified with a throwaway test: a `fetch` that never
   resolves left `startPairing()` pending after 2 s, with no error. The test was deleted
   afterwards. Fix: abort each call after a bounded time and report it as `unavailable`,
   with a test.
   Resolution: fixed in 0f2d76c. Every admin call aborts after `DEVICE_SERVICE_TIMEOUT_MS` (15 s; `timeoutMs` in tests) and is reported as 503 `unavailable` "state service did not answer within … ms". A body cut off mid-read is reported the same way. Test: `devices-routes.test.ts` "gives up on a service that never answers…" (fails before the fix).
2. **medium**: `packages/runtime/src/devices/manager.ts:117-149` (`revoke`). When a service is
   configured, a revocation fails with 503 if the service is unreachable or answers 5xx,
   even when the device row is in the daemon's store. In hybrid mode that store is the same
   shared Postgres the service authenticates against, and the service reads the row on every
   request. So the spec's lost-phone case ("can be revoked at once", "Lost phone: revoke from
   desktop") fails for no reason. Verified with a throwaway test: a phone registered in the
   store, a service `fetch` that throws `fetch failed`. `revoke()` rejected `unavailable`
   and the row stayed `revoked: false`. Fix: when the service cannot be reached and the row is
   in the store, revoke it in the store and say so, with a test.
   Resolution: fixed in 0f2d76c. When the service call fails as `unavailable` and the row is in the daemon's store, the row is revoked there. The answer carries `via: "store"` and `serviceError`; the audit row and the app's note (3fa9d4f) say so. A 404 from the service itself, or a row only the service has, still fails. Tests: `devices-routes.test.ts` "revokes a lost phone in the shared store when the service is down, hung or refuses the token" and "does not touch the store when the service refuses…"; `settings-devices.test.tsx` "says so when the daemon revoked in the shared store…".
3. **medium**: `packages/runtime/src/devices/manager.ts:117-158`. A revocation from Settings →
   Devices writes an audit row but no `change_log` row. The schema describes the change log
   as "Every change made by conversation or UI", spec Q says nothing is UI-only, and the
   registry's `device.revoke` (high risk, `permission_change`) writes one for the same change
   made by chat or voice. So the change log is missing a permission change made from the
   settings screen, and the activity log does not record it. Verified with a throwaway test:
   after `revoke()` the store had `changeLog.list()` = 0 rows. Fix: the revocation records a
   `change_log` row (`device.revoke`, source `ui`, scope `global`, `irreversible`, before
   and after, the sentence), with a test.
   Resolution: fixed in 0f2d76c. `DeviceManager.revoke` now records the same `change_log` row the registry's `device.revoke` writes: commands, before and after, scope `global`, source `ui`, `irreversible`, the same sentence, and the daemon's agent. It writes one row per actual change (none for a repeat), both through the service and through the store. Test: `devices-routes.test.ts` "writes the change log row of device.revoke…" (fails before the fix).
4. **low**: `apps/ui/src/pages/DevicesSection.tsx:296` (`closePairing`, the only reload while
   a pairing is shown). When the phone completes the pairing, the section keeps showing the
   used QR and its countdown. The new phone appears only after the human clicks Done or
   Refresh. The brief's flow (start → QR → the device listed) relies on the human guessing
   that. Verified by reading the code: `useAsync` reloads only on `list.reload()`, which is
   called by Done, Refresh and after a revoke. The apps.md Known issues says the same. Fix:
   while a pairing is shown, poll the list; when a device paired after the start appears,
   close the panel and say it is paired, with a test.
   Resolution: fixed in 3fa9d4f. While a code is live, the section re-reads `GET /devices` every `pollMs` (3 s). When a device it did not have at the start appears, it closes the panel with "<name> is paired and listed below". Test: `settings-devices.test.tsx` "lists the phone and closes the pairing on its own…". With the interval stubbed out, that test fails (checked: 1 failed, 10 passed).
5. **low**: `packages/runtime/src/devices/manager.ts:112` and
   `apps/ui/src/pages/DevicesSection.tsx:87`. The QR encodes the daemon's own service URL. A
   daemon that reaches the service at a loopback address (`http://localhost:8787` from
   `pnpm state-api` on the same PC) produces a QR that no phone can use. The phone then fails
   with a network error and nothing explains why. Verified by reading the code: `serviceUrl`
   is passed through unchanged, and nothing checks it. Fix: the panel warns when the
   service host is loopback (`localhost`, `127.0.0.0/8`, `::1`), with a test.
   Resolution: fixed in 3fa9d4f. `isLoopbackUrl` detects `localhost`, `*.localhost`, `127.0.0.0/8` and `::1`. For such a URL, the pairing panel warns that a phone cannot reach it and says which variable to set. Test: `settings-devices.test.tsx` "warns that a phone cannot reach a loopback service URL in the QR".
6. **low**: `apps/ui/test/fixtures.ts`, `docs/maintainers/apps.md`, `docs/maintainers/runtime.md`.
   `git merge-tree --write-tree HEAD origin/ccr-4d8a843c-1k9syk` reports content conflicts in
   these three files: both sides append next to the same anchors. Every other shared file
   (`client.ts`, `SettingsPage.tsx`, `fake-daemon.ts`, `server.ts`, `compose.ts`,
   `api-types.ts`) auto-merges.
   Resolution: not a defect: these are textual conflicts in a series that must not merge the base (stage rule), and they are resolved at integration. `git merge-tree` shows that both sides add next to the same anchors (fixtures appended before `SOURCES`, doc rows and paragraphs). No semantic conflict: the base's `/me.desktopDeviceId` and this branch's `current` flag both read `rt.remote.device`, and every code file auto-merges.
7. **low**: `docs/maintainers/state-service.md:341`. The new `desktop-devices.test.ts` row
   comes after the blank line that ends the test table, so Markdown renders it as a stray
   paragraph of pipes. The base's `shared-secrets.test.ts` row has the same problem. Verified
   by reading the file: the line before the new row is blank, and the table ends at
   `audit-export.test.ts`. Fix: put the row inside the table.
   Resolution: fixed in 58c0dc5. The `desktop-devices.test.ts` row was moved into the table, and the stray blank line before the base's `shared-secrets.test.ts` row was removed, so both rows now render in the table.

## Rebase

Stage REBASE, 2026-10-23. `wave/w3-r2-devices` (344f0d4, 13 commits on 82a6295) rebased onto
`origin/ccr-4d8a843c-1k9syk` at cac6fee (181 base commits since 82a6295) with
`git rebase origin/ccr-4d8a843c-1k9syk`; no merge of the base. Every conflict kept both sides:

| Commit | File | Resolution |
| --- | --- | --- |
| wip (daemon side) | `packages/runtime/src/daemon/compose.ts` | the base's `githostWatcher` field, its `GitHostWatcher` construction and its return entry kept, the branch's `devices: DeviceManager` field (own doc comment), the `DeviceManager` construction and the `devices` return entry added after each |
| wip (daemon side) | `packages/runtime/src/daemon/server.ts` | the base's `createRunnerUnlockRoutes` mount kept, the branch's `createDeviceRoutes` mount after it |
| Devices section | `apps/ui/src/api/client.ts` | the base's desktop control and runner unlock view imports and type re-exports kept next to the branch's `DeviceListView` / `RevokeDeviceView` (sorted for Biome in a follow-up commit) |
| Devices section | `apps/ui/src/pages/SettingsPage.tsx` | the base's fast-mode card (`FAST_MODE_KEY`, `fastModeRows`, `fastModeToggle`, `FastModeCard`) kept; the page's doc comment is the branch's (K.7, Q.1, R.2); `<DevicesSection />` and `<FastModeCard />` both render |
| Devices section | `apps/ui/test/fake-daemon.ts` | `DesktopControlView` and `DaemonDeviceView` imports both kept; the base's `POST /milestones/:id` route kept before the branch's `/devices` routes |
| Devices section | `apps/ui/test/fixtures.ts` | the base's `VOICE_STATUS` fixture closed and kept, the branch's `DEVICES` and `PAIRING` after it |
| docs | `CHANGELOG.md` | the base's E.1 line and the branch's R.2 line both under Added |
| docs | `docs/maintainers/apps.md` | layout: `lib/` lists clock and runner-unlock, `components/` lists UnlockCard, RunnerAutoUnlock and QrCode; client paragraph: the desktop control routes and the device methods; fake daemon: the base's milestones route and the branch's devices sentence (in its review-fix wording) in one paragraph; `settings` test row merged into one row with both sides' clauses, `settings-devices` row kept; Known issues: both bullets |
| docs | `docs/maintainers/runtime.md` | Known issues: the base's fast-mode, chat-retrieval and B.5 bullets and the branch's Devices bullet |
| docs | `docs/status/PROGRESS.md` | the branch's entries above the base's newer log entries (w2-s32, w2-s12, w3-e1, w4-fcm) |

`docs/status/BLOCKERS.md`, `docs/requirements.md`, `docs/maintainers/state-service.md` and the
other code files merged without conflict. Requirement totals on the rebased branch: 186 done,
37 in progress, 5 todo (the base has 185 / 38 / 5; R.2 is the difference).

Checks after the rebase: `pnpm typecheck` exit 0; `pnpm lint` exit 0 (59 warnings, the base's);
`node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok; `pnpm --filter
@forerunner/ui test` 47 files / 310 tests passed (`settings-devices.test.tsx` 11,
`settings.test.tsx` 10); `pnpm exec vitest run --project unit packages/runtime/test` 129 files,
1143 passed, 1 skipped (`devices-routes.test.ts` 11); `pnpm exec vitest run --project unit
services/state-api/test` 12 files / 160 passed (`desktop-devices.test.ts` 4). The integration
files of both packages need Postgres and were skipped (2 files, 7 tests).

### Rebase onto 4ff4fb1

Stage REBASE, 2026-10-23 (second rebase). `wave/w3-r2-devices` (045cb9b, 15 commits on
cac6fee) rebased onto `origin/ccr-4d8a843c-1k9syk` at 4ff4fb1 (73 base commits since cac6fee:
the merges of w2-l6-speak, w3-c5-specialist-approval, w3-d16-slider, w3-e4-recheck and
w5-android-high-risk) with `git rebase origin/ccr-4d8a843c-1k9syk`; no merge of the base.
Every conflict kept both sides:

| Commit | File | Resolution |
| --- | --- | --- |
| Devices section | `apps/ui/src/api/client.ts` | the base's L.6 `SpeakBody`, `SpeakView` and `SpeakViewSchema` imports kept next to the branch's `StartPairingBody` (already in Biome's order) |
| docs (R.2 done) | `docs/maintainers/apps.md` | the `/settings` page row: the branch's row (the Devices section) with the base's D.16 clause (the three-stop slider for a project's speed-versus-quality row) inside the Change dialog clause, one row; the test list: the branch's `settings` clause (the Devices section in the whole app) and `settings-devices` row, then the base's `settings-slider` row |
| docs (R.2 done) | `docs/status/PROGRESS.md` | the branch's build entry above the base's newer log entries (w3-d16-slider, w3-e4-recheck, w5-android-high-risk rebases and reviews); in the "Next" list the base's lines (with its duplicated C.5 / D.4 / D.16 lines) kept and the branch's R.2 clause on the w3-r2-devices line |
| Devices review fixes | `docs/maintainers/apps.md` | the same `/settings` row again, now in the review-fix wording (the live list while pairing, the loopback warning, the store-fallback note) with the base's D.16 clause; the `settings-devices` row in its review-fix wording, the base's `settings-slider` row after it |

Merged without a conflict and checked by reading the result against the base's code:
`packages/runtime/src/daemon/compose.ts` (the base's speaker, specialist approval gate and
slider wiring untouched; `DeviceManager` built after the git host watcher and returned as
`devices`), `server.ts` (`createDeviceRoutes` mounted after the runner unlock routes),
`api-types.ts` (`...DEVICES_ROUTES` in `DAEMON_ROUTES`), `SettingsPage.tsx`
(`<DevicesSection />` before `<SourcesSection />` and the fast-mode card; the base's slider
dialog untouched), `apps/ui/test/fake-daemon.ts`, `fixtures.ts`, `settings.test.tsx`,
runtime.md, state-service.md, requirements.md, BLOCKERS.md and CHANGELOG. Requirement totals
on the rebased branch: 189 done, 34 in progress, 5 todo (the base has 188 / 35 / 5; R.2 is the
difference).

Checks after the rebase: `pnpm typecheck` exit 0; `pnpm lint` exit 0 (59 warnings, none in a
file the branch touches: `biome check` over the branch's 19 changed code files reports none);
`node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok (28 files);
`pnpm --filter @forerunner/ui test` 49 files / 334 tests passed (`settings-devices.test.tsx`
11, `settings.test.tsx` 10, `settings-slider.test.tsx` 3); `pnpm exec vitest run --project
unit packages/runtime/test` 134 files, 1216 passed, 1 skipped (`devices-routes.test.ts` 11);
`pnpm exec vitest run --project unit services/state-api/test` 12 files / 160 passed
(`desktop-devices.test.ts` 4). The branch adds no integration file; the packages' existing
integration files need Postgres and were not run.

### Rebase onto 38ae8cc

Stage REBASE, 2026-10-23 (third rebase). `wave/w3-r2-devices` (dac82c0, 16 commits on
4ff4fb1) rebased onto `origin/ccr-4d8a843c-1k9syk` at 38ae8cc (47 base commits since 4ff4fb1:
the merges of w3-d4-specialist-settings, D.4 / ADR 0072, and w3-r5-phone, R.5 / ADR 0080) with
`git rebase origin/ccr-4d8a843c-1k9syk`; no merge of the base. Every conflict kept both sides:

| Commit | File | Resolution |
| --- | --- | --- |
| Devices section | `apps/ui/src/api/client.ts` | the base's `ModelSettingsView` / `ModelSettingsViewSchema` imports kept next to the branch's `PairingStartView` / `PairingStartViewSchema` (Biome's order) |
| Devices section | `apps/ui/src/pages/SettingsPage.tsx` | both imports, `DevicesSection` before `ModelSettingsSection` (Biome's order); `<DevicesSection />` before `<SourcesSection />`, the base's `<ModelSettingsSection />` after the fast-mode card, both render |
| Devices section | `apps/ui/test/fixtures.ts` | the base's `ModelSettingsView` type import next to the branch's `PairingStartView` |
| docs (R.2 done) | `docs/maintainers/apps.md` | the `/settings` page row: the base's row (with D.4's **Models per agent and specialist** section and `GET /settings/models`) with the branch's **Devices** clause before the Sources clause and the three `/devices` routes appended to the route list; one row |
| docs (R.2 done) | `docs/status/BLOCKERS.md` | the branch's R.2 row and the base's R.5 row (built, emulator run open); the base's V.1 row kept (counts updated in the rebase doc commit) |
| docs (R.2 done) | `docs/status/PROGRESS.md` | the branch's build entry above the base's newer log entries (w3-d4 rebased onto 4ff4fb1, w3-r5-phone build, review and rebases); "Next" list: the branch's R.2 clause and the base's R.5 clause ("built on its branch 2026-10-23, emulator run open") on their lines |
| Devices review fixes | `apps/ui/test/fake-daemon.ts` | the base's `ModelSettingsView`, `ModelSettingValueView` type imports next to the branch's `PairingStartView` |
| Devices review fixes | `docs/maintainers/apps.md` | the same `/settings` row: the base's row with the branch's Devices clause in its review-fix wording (live list while pairing, loopback warning, store-fallback note) |
| docs after the review, Biome format, rebase onto cac6fee, rebase onto 4ff4fb1 | `docs/status/BLOCKERS.md` | each time the branch's R.2 row in that commit's wording, the base's R.5 row kept |
| rebase onto 4ff4fb1 | `docs/status/PROGRESS.md` | "Next" list: the branch's "rebased onto 4ff4fb1" R.2 clause and the base's R.5 clause |

Merged without a conflict and checked by reading the result against the base's code:
`packages/runtime/src/daemon/compose.ts` (the base's model settings view and voice relay wiring
untouched; `DeviceManager` built and returned as `devices`), `server.ts` (the base's
`GET /settings/models` and voice routes kept, `createDeviceRoutes` mounted), `api-types.ts`
(the base's model settings views and `...DEVICES_ROUTES` both in `DAEMON_ROUTES`),
runtime.md, state-service.md, requirements.md and CHANGELOG. The base's `settings-models`
route-missing case (which counts the fixture's settings rows) passes with the Devices section
on the page. Requirement totals on the rebased branch: 190 done, 33 in progress, 5 todo (the
base has 189 / 34 / 5; R.2 is the difference); BLOCKERS.md V.1 carries them.

Checks after the rebase: `pnpm typecheck` exit 0; `pnpm lint` exit 0 (59 warnings, none in a
file the branch touches: `biome check` over the branch's 19 changed code files reports none);
`node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok (28 files);
`pnpm --filter @forerunner/ui test` 53 files / 360 tests passed (`settings-devices.test.tsx`
11, `settings.test.tsx` 10, `settings-models.test.tsx` 8); `pnpm exec vitest run --project
unit packages/runtime/test` 138 files, 1276 passed, 1 skipped (`devices-routes.test.ts` 11);
`pnpm exec vitest run --project unit services/state-api/test` 12 files / 163 passed
(`desktop-devices.test.ts` 4); `--project integration` over both packages: 2 files / 7 tests
skipped (they need Postgres; the branch adds no integration file).

### Rebase onto 95097ae

Stage REBASE, 2026-10-24 (fourth rebase). `wave/w3-r2-devices` (e13f539, 17 commits on
38ae8cc) rebased onto `origin/ccr-4d8a843c-1k9syk` at 95097ae (the merges of w3-d7-performance,
D.7 / D.19; w3-t1-mode-off, T.1 / ADR 0081; and w3-misc-replay-ceiling) with
`git rebase origin/ccr-4d8a843c-1k9syk`; no merge of the base. Every conflict kept both sides:

| Commit | File | Resolution |
| --- | --- | --- |
| Devices section | `apps/ui/test/fixtures.ts` | the base's `PerformanceView` type import kept next to the branch's `PairingStartView` (Biome's order) |
| docs (R.2 done) | `CHANGELOG.md` | the base's Performance view line (D.7, D.19) and the branch's R.2 line both under Added |
| docs (R.2 done) | `docs/maintainers/apps.md` | the `/settings` row: the branch's row (the base did not change it); the `/settings/capabilities/email` row: the base's, with its ADR 0081 clause (the branch did not change it); the fake daemon paragraph: the branch's devices clause, then the base's "decisions, the peer feed and docs are served read-only" and its `GET /performance` sentence (the branch's "and performance" dropped, since the base serves performance with a window and a project now) |
| docs (R.2 done) | `docs/status/PROGRESS.md` | the branch's build entry above the base's newer log entries (w3-d7-performance, w3-t1-mode-off and w3-misc-replay-ceiling); "Next" list: the branch's R.2 clause and the base's T.1 clause ("built on its branch, ADR 0081, reviewed and fixed 2026-10-24, awaiting merge") on one line |
| Devices review fixes | `docs/maintainers/apps.md` | the same two places again in the review-fix wording: the branch's `/settings` row and the base's email row; the branch's devices clause (`pairing` overrides, `via: "store"`) with the base's performance sentence |
| rebase onto 4ff4fb1 | `docs/status/PROGRESS.md` | "Next" list: the branch's "rebased onto 4ff4fb1" R.2 clause and the base's T.1 clause |
| rebase onto 38ae8cc | `docs/status/BLOCKERS.md` | the base's T.1 row (resolved by ADR 0081); the V.1 row: the base's row with both sides' clauses (T.1 merged in abe3bb0, D.7 and D.19 merged in 92cfcd7, R.2 by this item) and the counts recounted from `docs/requirements.md` |
| rebase onto 38ae8cc | `docs/status/PROGRESS.md` | "Next" list: the branch's "rebased onto 38ae8cc" R.2 clause and the base's T.1 clause |

Merged without a conflict and checked by reading the result against the base's code:
`packages/runtime/src/daemon/compose.ts` (the base's ADR 0081 `emailMode` command port, its
`onCommandsSwitchedOff` listener and the intake's `promptVersion` untouched; `DeviceManager` built and returned as `devices`), `server.ts` (the
base's `GET /performance` route kept, `createDeviceRoutes` mounted), `api-types.ts` (the base's
Performance view shapes and `...DEVICES_ROUTES` both in `DAEMON_ROUTES`), `apps/ui/src/api/client.ts`,
`SettingsPage.tsx`, `apps/ui/test/fake-daemon.ts` (the base's `/performance` route and the
branch's `/devices` routes), runtime.md, state-service.md and requirements.md. The base's V.1
row said 190 / 33 / 5, which did not count D.7 and D.19; recounted from `docs/requirements.md`:
the base has 192 done, 31 in progress, 5 todo and the rebased branch 193 / 30 / 5 (R.2 is the
difference); V.1 carries the branch's numbers.

Checks after the rebase: `pnpm typecheck` exit 0; `pnpm lint` exit 0 (59 warnings, none in a
file the branch touches: `biome check` over the branch's 19 changed code files reports none);
`node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok (28 files);
`pnpm --filter @forerunner/ui test` 53 files / 366 tests passed (`settings-devices.test.tsx`
11, `settings.test.tsx` 10, `performance.test.tsx` 9, `settings-models.test.tsx` 8); `pnpm exec
vitest run --project unit packages/runtime/test` 140 files, 1297 passed, 1 skipped
(`devices-routes.test.ts` 11, `performance-route.test.ts` 4); `pnpm exec vitest run --project
unit services/state-api/test` 12 files / 163 passed (`desktop-devices.test.ts` 4);
`--project integration` over both packages: 2 files / 7 tests skipped (they need Postgres; the
branch adds no integration file).
