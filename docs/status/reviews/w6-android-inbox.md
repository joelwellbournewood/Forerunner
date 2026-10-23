# w6-android-inbox: no request cards in the Android inbox after pairing (run 40000764444)

Branch `wave/w6-android-inbox`, from `origin/ccr-4d8a843c-1k9syk` at 4ff4fb1. ADR 0087.

## Build report

### Answer in short

The inbox is fine. The click on "Inbox" never reached the nav. In run 40000764444 the
runner's click on the bottom nav's "Inbox" landed on Home's project section, so the route
stayed `/`, the inbox screen never mounted, and `m-request` had 0 matches. Nothing was
logged because nothing failed inside the page. It happened because:

- The emulator (`android.yml`: API 30, `aosp_atd`) ships a Chromium 83-class WebView, and an
  ATD image never updates it. The app's stylesheet is Tailwind v4. Tailwind v4 puts every
  rule inside cascade layers (`@layer`), which need Chrome 99, so Chromium 83 drops them all.
  The page is unstyled: `m-nav` is `position: static` and sits in the flow right under
  Home's project list.
- The "Projects" heading appears as soon as the phone is paired, but `/projects` answers
  after it. The runner clicked "Inbox" straight after the heading. The CDP driver read the
  nav item's box (stable, hit test on it). Then the project list arrived and pushed the nav
  down, and the mouse events went to the old point, which was now inside Home's section.

This is a race in suspect 3's area, the driver. It is **older than 82a6295**: 82a6295's
driver loses it too, and run 39952987240 passed that step by timing. It is not a regression
from 0387401 (see the numbers below).

### Suspects of the brief, one by one

| # | Suspect | Finding | Evidence |
| --- | --- | --- | --- |
| 1 | `702bf9e`/`7a55dba`, the unlock card | Ruled out. `RequestCard` renders `UnlockCard` only for a `credential` request whose change card parses as a challenge (`unlockChallengeOf`). Nothing gates the list on unlock state. `useAutoUnlock` in `MobileShell` skips requests without a challenge. The phone makes no unlock call to the state service: the key comes from the shell's secure store, and only for a challenge. So the fake state service has no endpoint missing for this. | Code read; `apps/ui/test/mobile-unlock.test.tsx` and `mobile-inbox.test.tsx` pass (UI 48 files / 322 tests); a scratch test that pairs through the form, then navigates to Inbox (`inShell` false and true, live and polling) lists all three requests (not kept: it duplicates `mobile-pairing` + `mobile-inbox`) |
| 2 | `9404bf0`, `0ed3a36`, `fead3af`, `store.tsx` | Ruled out. `git diff 82a6295 4ff4fb1 -- apps/ui/src/mobile/store.tsx` touches only `assertHighRisk`, `BiometricRefusedError`, `answerUnlock`, `unlockWindowUntil` and `runnerKeys`. `pair`, `refresh`, `loadInbox`, `startStream` and `initialMobileState` are unchanged apart from the null window. | Diff read; the stand-in's network log shows `GET /me`, `/projects`, `/inbox` and `/events` all answered right after pairing |
| 3 | `0387401`, the CDP driver | **The cause, but not introduced there.** The locator `getByTestId("m-request").first()` and the visibility wait find the cards whenever the inbox screen is open (the stand-in's passing runs, `cdp.test.ts`). The defect is in `Locator.click`: between its box read and the CDP mouse events it never checked that the element was still under the point. 0387401's frame wait only moved the read; it did not open or close the race. | `cdp.test.ts` "never lets a click land on what moved under the point" fails on the base driver (`expected [ 'Projects' ] to deeply equal [ 'Inbox' ]`); stand-in failure rates below |
| 4 | `93cd560`, `ebf3be0`, push | Ruled out. `MobileController.pair` sends no `pushToken`, and nothing in `apps/ui/src` calls `PUT /devices/:id/push-token`. The fake state service (`apps/ui/test/fake-state-service.ts`) and its import `services/state-api/src/auth/crypto.ts` are byte-identical to 82a6295. | `grep -rn push-token apps/ui/src` (none); `git diff 82a6295 4ff4fb1 --stat -- apps/ui/test/fake-state-service.ts services/state-api/src/auth` (empty) |

### How it was proved without an emulator

A browser stand-in of the emulator run is kept in the session outputs
(`w6-android-inbox-standin/`), not in the repository. It runs:

- the production bundle (`vite build` with `TAURI_ENV_DEBUG=true TAURI_ENV_PLATFORM=android`,
  the APK's flags), served at `http://tauri.localhost/` with the shell's CSP from
  `tauri.conf.json`;
- `window.__FORERUNNER__` plus a `__TAURI_INTERNALS__` stub that answers the shell's commands
  (device key signing through a Node Ed25519 helper, secure store, `push_status`,
  `assert_biometric` "Biometrics not enrolled.", deep link), with an optional delay per IPC
  call;
- the fake state service as a child process over HTTP (`tsx apps/ui/test/fake-state-service.ts`,
  as `run.mjs` starts it);
- the real `cdp.mjs` with `forwardPageConsole`, attached to headless Chromium through
  `connectPage`, running the smoke's pairing and inbox steps, or with `FULL=1` the whole
  `smoke()` sliced out of `run.mjs`.

Results (IPC delay 800 ms unless noted; in a current Chromium 156 every run passed, which is why the
web tests and Playwright specs never saw it):

| Browser | Driver / runner | Runs | Failed |
| --- | --- | --- | --- |
| Chromium 156 | 4ff4fb1 driver, with and without the shell stub, no IPC delay | 5 | 0 |
| Chromium 83.0.4103.0 | 82a6295 driver | 20 | 8 |
| Chromium 83.0.4103.0 | 4ff4fb1 driver (base) | 20 | 4 |
| Chromium 83.0.4103.0 | fixed driver (this branch), base steps | 20 | 0 |
| Chromium 83.0.4103.0 | fixed driver + fixed `run.mjs`, the whole `smoke()` (all five steps) | 10 | 0 |

In the failing runs the in-page event log shows the press at `(65, 136)` on
`SECTION "ProjectsRefresh1 req…"` with the URL still `http://tauri.localhost/`. In the passing
runs it shows the press on `SPAN "Inbox1"` at `(68, 404)`. `getComputedStyle(m-nav).position`
is `static` in Chromium 83 and `fixed` in Chromium 156. The `/__test/log` shows the inbox was
served (`GET /inbox?humanId=human_j ... ok`) in the failing runs too.

### What was built

- `apps/mobile/e2e/cdp.mjs` adds the **click guard** (ADR 0087). After the stable-box hit
  test, `clickPoint` arms a capture-phase guard on `window` for `pointerdown`, `mousedown`,
  `pointerup`, `mouseup` and `click`. An event outside the measured element is cancelled and
  stopped before every page listener, and recorded. `Locator.click` then reads the record
  (`clickOutcome`, up to 1 s for the `click`) and disarms the guard.
  - A miss is measured and clicked again until the timeout, then fails as
    `cdp.click_missed` naming what was at the point.
  - A click with no event at all is `cdp.click_lost`, never retried.
  - It also adds `describePage(page)` (URL, title, up to 20 lines of `<main>` text).
  - `cdp.d.mts` declares both.
- `apps/mobile/e2e/run.mjs` changes:
  - after pairing, it waits for the first `m-project-card` before the nav click;
  - after each navigation it waits for the screen's heading (`Inbox`, `Remote control`,
    `Change log`);
  - after the attach it prints `webview engine: <user agent>`;
  - after a `FAIL:` it prints `page:` lines, read before the cleanups close the socket.
- Docs:
  - ADR 0087 and its index row;
  - `docs/maintainers/apps.md` (Android app: file list, `cdp.test.ts` coverage, a Known
    issue for the old WebView, and the run-39952987240 entry now noting the guard);
  - `apps/mobile/e2e/README.md`;
  - the emulator row in `docs/status/BLOCKERS.md`, whose status changed;
  - a `docs/status/PROGRESS.md` log entry.
  - `docs/requirements.md` is unchanged: R.1 stays `in progress` (the emulator run is still
    pending), and its evidence already lists `cdp.test.ts` and `run.mjs`.

### Tests that prove it

`apps/mobile/e2e/cdp.test.ts` is now 30 tests, 5 new:

- "never lets a click land on what moved under the point after it was measured (android.yml
  run 40000764444)": the run in the fake. An in-flow nav moves down on the first mouse event;
  the fake dispatches real pointer, mouse and click events at the point. On the base driver
  it **fails** with `expected [ 'Projects' ] to deeply equal [ 'Inbox' ]` (recorded:
  `Tests 3 failed | 25 passed (28)` with the three new click tests against the base
  `cdp.mjs`). With the fix, Home receives no event, the retry presses at `(50, 420)`, and
  Inbox gets the click.
- "fails naming what got the click when the element keeps moving away from the point":
  `cdp.click_missed` naming `<h1> "Projects"`, and no click received.
- "reports a click whose mouse events never reached the page": `cdp.click_lost`, one press
  only.
- "names the route and the title and lists the screen's text, capped": `describePage`.
- "run.mjs waits for Home's list before the nav click, checks each screen opened, and prints
  page: lines on a failure": the runner's step order.

### Commands run and results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm exec vitest run --project unit apps/mobile/e2e` (before the fix, new tests against the base driver) | 1 file, 3 failed / 25 passed (28) |
| `pnpm exec vitest run --project unit apps/mobile/e2e` (final) | 1 test file, 30 tests passed |
| `pnpm --filter @forerunner/ui test` (untouched, run as the inbox's own suite) | 48 test files, 322 tests passed |
| `pnpm --filter @forerunner/ui exec playwright test e2e/mobile-inbox.spec.ts e2e/mobile-pairing.spec.ts` (Chromium headless shell installed for it) | 3 passed |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 (59 warnings, none in the touched files) |
| `node scripts/docs-check.mjs --base 4ff4fb1` | `docs-check: ok (10 files)` |
| `pnpm check` | exit 0: `pnpm test` 295 files, 3014 passed, 4 skipped, 1 todo; link-check ok; secret-scan clean. Its `docs:check` step has no `origin/main` and checks nothing, hence the explicit run above |
| stand-in runs (table above) | as listed |
| `git log --oneline 4ff4fb1..HEAD` | exactly this item's commits (the code commit, the docs commit, this report and its export-check amendment); no merge of the base |
| `git format-patch --stdout 4ff4fb1..HEAD > /mnt/session/outputs/w6-android-inbox.patch` | the patch, one mail per commit above |
| `git worktree add /tmp/verify 4ff4fb1 && cd /tmp/verify && git apply --check /mnt/session/outputs/w6-android-inbox.patch` | exit 0, no output (the patch applies cleanly on a clean checkout of the starting commit 4ff4fb1); re-run after the last commit, the worktree removed afterwards |

### Left open, and why

- **The emulator run itself.** No emulator or KVM on the build box. The cause is reasoned from
  the code and proven in the Chromium 83 stand-in, not observed on the device. The next
  `android.yml` run shows it directly: `webview engine:` names the WebView version (below
  Chrome 99 confirms the stylesheet finding), and a failure now prints `page:` lines with the
  route.
- **The app's layout on a pre-99 WebView.** On the emulator every Tailwind rule is dropped,
  so the screens are unstyled. That does not fail the smoke any more, but it is not what a
  user sees on a phone with a current WebView. Real phones update their WebView through the
  Play Store. Two ways to fix it, both outside this item's brief and neither testable here:
  - move the emulator job to a `google_apis` API 34 image (current WebView); or
  - add a build step that flattens the cascade layers for old WebViews.
  Listed in apps.md Known issues and in the BLOCKERS emulator row.
- **The stand-in is not in the repository.** It needs a downloaded Chromium 83 snapshot and
  serves on port 80; it lives in the session outputs with this report.
