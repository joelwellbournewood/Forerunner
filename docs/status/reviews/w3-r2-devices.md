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
