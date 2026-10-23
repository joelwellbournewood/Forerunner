# 0054 — Android emulator smoke over raw CDP on the WebView's page target

Date: 2026-10-23
Status: accepted

## Context

The Android emulator smoke (`apps/mobile/e2e/run.mjs`; spec module R, the phase 5 gate's
"through the Android emulator", scenario 9) builds the debug APK, boots the emulator, starts
the fake shared state service and drives the app's screens. The hosted runner now gets that
far (android.yml runs 6 and 7: `PASS: installed and launched`, the WebView's DevTools socket
forwarded). The attach step used Playwright's `chromium.connectOverCDP` on the forwarded
port. Run 7 showed why that cannot work: the Android WebView exposes one DevTools socket per
page and answers page-level commands only; Playwright's browser-level connection starts with
`Browser.setDownloadBehavior` and the WebView refuses it with `Browser context management is
not supported`. There is no flag on the WebView side that changes this.

The smoke's UI steps are a short list of Playwright calls: `getByTestId`, `getByRole` with a
name (headings, buttons, a link), `getByText` inside a scope, `filter({ has })`, `first`,
`count`, `waitFor`, `click`, `fill`, `innerText`, `getAttribute` and one CSS `locator`. The
assertions on the fake service's recorded calls and state do not depend on the driver.

## Decision

1. **Raw CDP on the page target, no browser-level session.** `apps/mobile/e2e/cdp.mjs`
   reads `GET /json/list` (then `/json`) on the forwarded port, picks the page target the
   caller prefers (the smoke prefers the title "Forerunner" or a `tauri.localhost` URL, else
   the first `type: "page"` target; workers never qualify), rebuilds the socket URL on the
   forwarded host and port (Chrome fills `webSocketDebuggerUrl` from the request's Host
   header), and opens it with Node 22's global `WebSocket`. The client correlates responses
   by id, applies a timeout per request, rejects every pending request when the socket closes,
   and ignores events unless a listener asks. No domain is enabled: `Runtime.evaluate` and
   `Input.*` need none.
2. **The driver covers the smoke's calls and keeps their meaning.** `Page` and `Locator`
   carry the Playwright names the smoke uses so `smoke()` reads as before. Every lookup runs
   inside the page through `Runtime.evaluate` (`returnByValue`, `awaitPromise`) with the
   locator chain as JSON; nothing is cached between calls, so a React re-render never leaves
   a stale handle. Semantics follow Playwright where the smoke relies on them: role from the
   explicit `role` or the tag (h1-h6 heading, button and button-like inputs, `a[href]` link,
   textbox, and a few landmarks), accessible name from `aria-labelledby`, `aria-label`,
   labels, `value` or text, matched as a whitespace-normalised case-insensitive substring
   unless `exact`, hidden elements (`aria-hidden`, `hidden`, `display: none`,
   `visibility: hidden`) excluded; `getByText` picks the innermost element whose text
   matches and considers the scope root itself; chained locators search descendants;
   `filter({ has })` keeps elements with a matching descendant; actions are strict (several
   matches are refused at once); `waitFor` means visible (client rects and not
   `visibility: hidden`); `click` scrolls the element into view, reads its box twice one
   animation frame apart (a box still moving, a smooth scroll or a transition, is reported
   unstable and polled again), hit-tests the settled centre with
   `elementFromPoint` (the hit must be the element or inside it, retried until the timeout,
   then `cdp.click_intercepted` naming the element in the way) and sends `mouseMoved`,
   `mousePressed`, `mouseReleased` through `Input.dispatchMouseEvent`; `fill` focuses the
   field, selects its content and sends `Input.insertText`, then reads the value back and,
   when it did not follow, sets it through the native value setter and dispatches `input`
   and `change` so a React-controlled field updates either way. Errors are `CdpError` with a
   stable `cdp.*` code; the runner's `FAIL:` line carries the code and the details with the
   message.
   Nothing in the driver relies on `eval` or `new Function` inside the page: the bundle's CSP
   (`default-src 'self'`, no `'unsafe-eval'`, `src-tauri/tauri.conf.json`) refuses both on
   the WebView. `Locator.evaluate(fnSource)` splices the function's source into the
   `Runtime.evaluate` expression as a function expression and the page calls it on the
   element; every other input reaches the page as JSON data.
3. **Playwright leaves the emulator runner.** `run.mjs` no longer imports `@playwright/test`
   (the package stays in `apps/ui` for the browser specs). The runner depends on Node alone.
4. **Tested against a fake endpoint with a real DOM.** `cdp.test.ts` runs in the unit
   project: `node:http` serves `/json/list`, a `ws` server answers the page socket and
   `Runtime.evaluate` runs the driver's in-page code in a jsdom document that carries a
   layout stand-in (`data-box` boxes, `elementFromPoint` over them, clicks and inputs
   recorded, `requestAnimationFrame` running) and a CSP stand-in (the page's `eval` and
   `Function` refuse), so the query rules, strictness, waits, click and fill paths, timeouts,
   close handling and target selection are exercised rather than string-matched. `ws`,
   `@types/ws` and `jsdom` are devDependencies of `apps/mobile` for that test only;
   `e2e/cdp.d.mts` types the driver for the test and `e2e/jsdom.d.ts` declares the slice of
   jsdom it uses.

## Consequences

- The emulator job can attach to the WebView; the next `android.yml` dispatch is the first
  run of the driver against a real WebView, and two assumptions are checked there: that
  `Input.insertText` commits like an IME (the native-setter fallback covers a refusal, and
  the value check says which path ran) and that `Input.dispatchMouseEvent` coordinates are
  layout-viewport CSS pixels (the bundle's viewport meta is `width=device-width,
  initial-scale=1`, so no page scale applies).
- A new smoke step needs its locator kind in the driver: the supported set is test id, role
  with name, text, CSS, `has`, `nth`. Keyboard shortcuts, touch events, frames, screenshots
  and network interception are out of scope; add them to `cdp.mjs` with a case in
  `cdp.test.ts` when a step needs one.
- The browser version of the flow (`apps/ui/e2e/mobile-*.spec.ts`) stays on Playwright; the
  two share the same test ids and texts, so a UI change breaks both the same way.
- Accepted exception to AGENTS.md for this Node-only tooling (no workspace import in the
  emulator runner): `cdp.mjs` defaults its clock to `Date.now` and throws its own `CdpError`
  (stable `cdp.*` codes) instead of `ForerunnerError`; `run.mjs` owns the one `now` and
  passes it to `connectPage`.

## Alternatives considered

- **Playwright's `connectOverCDP` with the WebView's browser endpoint.** The WebView has no
  browser target and refuses browser-domain commands; Playwright has no page-only connect.
- **Android UI Automator / Espresso through adb.** Drives the WebView as opaque views;
  reaching the React tree needs the DevTools protocol anyway, and the toolchain would add
  Gradle test APKs and Java to the smoke.
- **`chrome-remote-interface` or `puppeteer-core` on the page target.** Puppeteer also opens
  a browser-level session; `chrome-remote-interface` would add a dependency for what is a
  hundred lines over the global `WebSocket`.
- **Asserting the exact expressions the driver sends.** Simpler test, but it would not catch
  a wrong role or text rule, which is where the smoke is most likely to fail; the jsdom
  stand-in runs the in-page code itself.
