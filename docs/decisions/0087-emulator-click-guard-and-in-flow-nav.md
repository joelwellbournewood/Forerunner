# 0087 — The emulator driver's click guard: a click that lands on what moved under the point is stopped and sent again; the runner waits for Home's list and says which screen it was on

Date: 2026-10-23
Status: accepted

## Context

`android.yml` run 40000764444 (commit 4ff4fb1, API 30 `aosp_atd` x86_64 emulator) printed
`PASS: pairing by code`, then failed scenario 2 of `apps/mobile/e2e/run.mjs`:
`getByTestId("m-request").first() did not become visible in 180000 ms (matches: 0, visible: 0)
[cdp.timeout]`, with no `webview:` line. Run 39952987240 on 82a6295 had passed that step.

The suspects named in the item brief were checked one by one (build report in
`docs/status/reviews/w6-android-inbox.md`):

1. The unlock card (702bf9e, 7a55dba): the phone renders it only for a `credential` request
   whose change card parses as a challenge; nothing gates the list on it, the auto-answer
   does nothing without a challenge, and the phone makes no unlock call to the state service
   (the key comes from the shell's secure store, only for a challenge). Not the cause.
2. The high-risk refusal (9404bf0, 0ed3a36, fead3af) and its `store.tsx` changes: only the
   biometric step, the window record and `runnerKeys` changed; pairing, `refresh`,
   `loadInbox` and the sync loop are as on 82a6295. Not the cause.
3. The driver (0387401): the locator of `m-request` is unchanged and finds the cards
   whenever the inbox screen is open. The defect is in `click`, and it predates 0387401.
4. Push (93cd560, ebf3be0): the phone sends no `pushToken` and never calls
   `PUT /devices/:id/push-token`. Not the cause.

A browser stand-in of the emulator run (the production bundle under the Android injection,
the Tauri IPC answered by a stub, the fake state service as a child process over HTTP, the
real `cdp.mjs` and the smoke's steps) passes every time in a current Chromium. In Chromium 83
(the WebView generation an API 30 image ships, which an ATD image never updates) with the
shell's IPC slowed to 800 ms per call, it fails like the run: 8 of 20 runs with 82a6295's
driver, 4 of 20 with 4ff4fb1's. The page log shows why:

- The app's stylesheet is Tailwind v4, whose rules sit in cascade layers (`@layer`, Chrome
  99+). Chromium 83 drops them, so `m-nav` is `position: static`: the bottom nav sits in the
  flow under Home's project list instead of fixed to the bottom.
- The "Projects" heading shows as soon as the phone is paired; `/projects` answers after it.
  The runner clicks "Inbox" right away. The driver reads the nav item's box (stable, hit test
  on it), the project list lands and pushes the nav down, and the CDP mouse events go to the
  old point, now inside Home's section. The route stays `/`; nothing is logged; the inbox
  screen never opens, so `m-request` has 0 matches.

## Decision

1. **Click guard in the driver** (`cdp.mjs`, the model is Playwright's hit-target check).
   When `clickPoint` has a stable box whose centre hits the element, it arms a guard on
   `window` in the capture phase for `pointerdown`, `mousedown`, `pointerup`, `mouseup` and
   `click`. An event whose target is the element or inside it passes; any other is cancelled
   (`preventDefault`, `stopImmediatePropagation`) before every page listener and recorded.
   After the mouse events, `Locator.click` reads the record (`clickOutcome`, waiting up to
   1 s for the `click`) and disarms the guard. A miss is retried from a fresh measurement
   until the timeout, then `cdp.click_missed` names what was at the point. A click with no
   event at all is `cdp.click_lost` and is not retried (a late event could click twice). The
   guard disarms itself after 15 s if nobody reads it.
2. **The runner waits for the screen, not only the heading**: after pairing it waits for the
   first `m-project-card` before the nav click; after every navigation it waits for the
   screen's heading (`Inbox`, `Remote control`, `Change log`) before the screen's elements,
   so a failure names the step that did not happen.
3. **The runner says where the app was**: after the attach it prints the WebView's user agent
   (`webview engine: ...`); after a `FAIL:` it prints `page:` lines (URL, title, up to 20
   lines of the screen's text, `describePage`), read before the cleanups close the socket.
4. **Not changed here**: the app's CSS on a pre-99 WebView. Real phones update their WebView
   through the Play Store; the emulator image does not. Making the layout work there (a
   build-time flattening of the layers, or an emulator image with a current WebView in
   `android.yml`) is listed in `apps.md` Known issues and in `BLOCKERS.md`.

## Consequences

- A re-render between the measurement and the press can no longer send a click to another
  element: the misplaced events never reach the page, and the click is retried. Scenario 3's
  failure on 82a6295 ("a click that did not reach the scrolled-to Confirm button", ADR 0086)
  is in the same class and is covered by the same guard.
- In the Chromium 83 stand-in with the same slow IPC, the smoke's pairing and inbox steps
  passed 20 of 20 runs with the guard alone, and the whole `smoke()` of `run.mjs` passes.
  The emulator run itself is still to be dispatched; the cause is reasoned from the stand-in
  and the code, not observed on a device.
- The guard adds one `Runtime.evaluate` per click (two when the click event is late).
- Tests: `apps/mobile/e2e/cdp.test.ts` (the nav that moves between the measurement and the
  press: 82a6295's and 4ff4fb1's drivers click Home, the guard clicks Inbox; a page that never
  settles; a lost click; `describePage`; the runner's step order).
