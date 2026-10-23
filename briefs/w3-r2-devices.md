## title

Settings -> Devices on the desktop: start a pairing with the QR, list the paired devices, revoke at once

## requirements

R.2 (R.3, S.x device keys context)

## adr

none

## brief

BLOCKERS.md row R.2 Settings -> Devices on the desktop: **partly built** (requirements close-out 2026-10-20): pairing by QR / `fr://` link / typed code with a per-device key, the service's device list and revoke-at-once are tested (`apps/ui/test/mobile-pairing.test.tsx`, `apps/ui/test/state-client.test.ts`, `services/state-api/test/auth.test.ts`); the desktop `SettingsPage` has no Devices section that starts a pairing (shows the QR) and lists or revokes devices, although `state-client.ts` exposes `devices()` and the service has the routes. Stand-in: pairing is started with the service's admin token (the `fr` CLI / the service's `pairing/start` route) and a device is revoked through the service. Needed: a Devices section in `apps/ui/src/pages/SettingsPage.tsx` (start pairing with the QR, list, revoke) over `state-client.ts`, with a `settings.test.tsx` case; then R.2 `done`. Spec R.2: 'Pairing: scan a QR code from the desktop app. Each device gets its own key, listed in Settings -> Devices, and can be revoked at once.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read apps/ui/src/api/state-client.ts (devices(), pairing start, revoke), apps/ui/src/mobile/pairing.ts and the QR rendering if one exists (a QR code needs an encoder: check node_modules for an existing qr library in the workspace before adding one; a small pure-TS QR encoder as a dependency is acceptable if none exists, pinned), the desktop SettingsPage.tsx and its tests, how the desktop app reaches the state service (the daemon's service token / the human's device; ADR 0009, 0024, 0025: which credential starts a pairing from the desktop: the daemon should proxy it so the admin token never reaches the UI: check what the daemon exposes), the fake daemon / fake state service in apps/ui/test. Build: a Devices section: start pairing (the daemon asks the service for a pairing code and the fr:// link; the UI renders the QR of the link plus the typed code with its expiry countdown on the Clock), the device list (name, kind, paired at, last seen, this device marked), revoke with confirmation (an immediate revocation: the service's revoke route; the list refreshes), errors shown with the route-unavailable state of ADR 0037. Tests: apps/ui/test/settings-devices.test.tsx (start -> QR and code shown, expiry; list; revoke calls the route and the device disappears; unavailable route), packages/runtime daemon route test if a proxy route is added. Docs: apps.md, runtime.md if the daemon changes, state-service.md if a route changes.

## paths

apps/ui/src/pages/SettingsPage.tsx, apps/ui/src/api/state-client.ts, packages/runtime/src/daemon, tests
