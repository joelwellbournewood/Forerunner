# Android emulator run (module R)

`run.mjs` next to this file is what CI runs inside the emulator job
(`.github/workflows/android.yml`, `pnpm --filter @forerunner/mobile test:emulator`). It builds
the debug APK when no *debug* APK exists (a release APK left by the workflow's artefact build
does not count: its WebView has remote debugging off), boots an emulator when none is
attached, installs the app, starts the fake shared state service on the host, and drives the
WebView over raw Chrome DevTools Protocol on its page target (`cdp.mjs`, ADR 0054): pair by
code, approve a request, refuse a high-risk answer without a biometric assertion, then
scenario 9 ("switch to the game, give it 15 francs until tomorrow and start a session on my
PC": one change card, confirm, the simulated PC starts the session, the change log shows the
entry, Undo sends the inverse plan). Without `adb`, a device, an AVD, or (with `--no-build`) a debug APK, it prints
`SKIP: <reason>` and exits 0 after cleaning up; CI sets `FR_ANDROID_REQUIRE=1` so every one of
those skips fails there, which keeps the job from going green on install-and-launch alone.

```
node apps/mobile/e2e/run.mjs                 # build a debug APK if there is none, boot if needed, smoke
node apps/mobile/e2e/run.mjs --build         # always rebuild the debug APK first
node apps/mobile/e2e/run.mjs --no-build --apk <file.apk>   # a release APK here: SKIP (FAIL under FR_ANDROID_REQUIRE=1)
node apps/mobile/e2e/run.mjs --avd fr-34 --keep   # boot this AVD, leave the app installed
FR_ANDROID_REQUIRE=1 node apps/mobile/e2e/run.mjs # a skip is a failure (CI)
```

Environment: `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) with `platform-tools` and `emulator`,
`NDK_HOME`, the Rust Android targets, Java 17. `FR_ANDROID_AVD` names the AVD to boot,
`FR_ANDROID_TARGET` the Rust target for `--build` (default `x86_64`, the emulator's ABI),
`FR_STATE_PC_MS` how fast the fake PC picks commands up (default 300 ms).

## The same steps by hand

SDK, NDK and targets (once):

```
sdkmanager "platform-tools" "emulator" "platforms;android-34" "build-tools;34.0.0" \
  "ndk;27.2.12479018" "system-images;android-34;google_apis;x86_64"
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
```

Build the UI bundle and the debug APK (the Tauri CLI runs Gradle; `--target` limits the
Rust ABIs it compiles):

```
pnpm --filter @forerunner/ui build
pnpm --filter @forerunner/mobile tauri android build --apk --debug --target x86_64
# Gradle directly, after the CLI generated gen/android once (all four ABIs):
cd apps/mobile/src-tauri/gen/android && ./gradlew :app:assembleDebug
# the APK: apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

A release APK (`tauri android build --apk`) is signed with the keystore
`scripts/android-keystore.mjs` provides (generated when no `ANDROID_KEYSTORE_BASE64` secret
is set, see `docs/status/BLOCKERS.md`); its WebView has remote debugging off, so the smoke
cannot run against it: `run.mjs` builds a debug APK next to it unless `--no-build` is set,
and with `--no-build` it skips (fails in CI). The workflow's release build is the uploaded
artefact; the emulator step builds its own debug APK (x86_64 only, a few minutes on top).

Emulator:

```
avdmanager create avd -n fr-34 -k "system-images;android-34;google_apis;x86_64" --device pixel_7
emulator -avd fr-34 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
```

Fake state service on the host, reachable from the device as `http://127.0.0.1:8788`
(`adb reverse` works for the emulator and for a USB phone; the emulator alone could also use
`http://10.0.2.2:8788`):

```
FAKE_STATE_PORT=8788 FAKE_STATE_ADMIN_TOKEN=<any string> FAKE_STATE_PC_MS=300 \
  pnpm exec tsx apps/ui/test/fake-state-service.ts
adb reverse tcp:8788 tcp:8788
curl -s -X POST -H "Authorization: Bearer <any string>" http://127.0.0.1:8788/__test/pair \
  -H "Content-Type: application/json" -d '{"humanId":"human_j","kind":"phone"}'   # -> {"code":"..."}
```

Install, launch, pair:

```
adb install -r -t apps/mobile/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n app.forerunner.mobile/.MainActivity
# type http://127.0.0.1:8788 and the code on the pairing screen, or open the deep link the desktop QR encodes:
adb shell am start -W -a android.intent.action.VIEW \
  -d "fr://pair?u=http%3A%2F%2F127.0.0.1%3A8788&c=<code>" app.forerunner.mobile
```

WebView DevTools (debug builds only; `run.mjs` does this and attaches `cdp.mjs` to the page):

```
adb shell pidof app.forerunner.mobile
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
curl -s http://127.0.0.1:9222/json/list # the page target; open its devtoolsFrontendUrl in Chrome
```

The attach is raw CDP, not Playwright: the Android WebView answers only page-level commands
on that socket and refuses the browser-level ones `connectOverCDP` starts with
(`Browser.setDownloadBehavior: Browser context management is not supported`, android.yml run
7). `cdp.mjs` reads `/json/list`, picks the page whose title is Forerunner (or whose URL is
`tauri.localhost`), opens its `webSocketDebuggerUrl` on the forwarded port with Node 22's
global `WebSocket`, and drives the DOM through `Runtime.evaluate` (queries by test id, role
and accessible name, text; waits; `innerText`, `getAttribute`, `count`),
`Input.dispatchMouseEvent` (clicks at the element's centre after a hit test) and
`Input.insertText` (fills, with a native-setter fallback that fires `input` and `change`).
The smoke's `smoke()` reads like the Playwright version because the driver keeps those
names and their meaning (strict single-element actions, visible waits). `cdp.test.ts` next to
it runs the driver against a fake DevTools endpoint (`node:http` + `ws` + jsdom with a layout
stand-in): `pnpm exec vitest run --project unit apps/mobile/e2e`.

Right after the attach, `run.mjs` calls `forwardPageConsole(client)` (`webview-console.mjs`)
on the same page session: `Runtime.enable`, then every `Runtime.consoleAPICalled` and
`Runtime.exceptionThrown` of the page is printed among the PASS lines (V8 first replays what
the page logged before the attach) as

```
webview: [info] forerunner: high-risk answer: asking the biometric prompt (60000 ms limit)
webview: [warn] forerunner: high-risk answer refused on the phone: Biometrics not enrolled. (http://tauri.localhost/assets/index-....js:1:4121)
webview: [exception] Uncaught TypeError: ... (url:line:col)
webview:       at ... (every line of a stack keeps the prefix)
```

so a failing step shows what the app said; a page that refuses `Runtime.enable` costs one
`webview: [runner] console forwarding unavailable: ...` line, never the smoke. The shell's
side of a high-risk answer is in logcat (`assert_biometric: asserted=... method=... reason=...`).
The attach also prints `webview engine: <user agent>`; after a `FAIL:` line the runner prints
what the page showed as `page:` lines (URL and title, then the screen's text), so a wait that
times out says which screen the app was on.

Clicks are guarded (ADR 0087): the driver measures the element, then a capture-phase guard in
the page lets through only the pointer, mouse and click events that land on it. When the
element moved in between (on the emulator's old WebView the app's stylesheet does not apply
and the bottom nav sits in the flow, so it moves when Home's list arrives: run 40000764444),
the misplaced events are stopped before the page sees them and the click is measured and
sent again. The guard stays up until the attempt's `click` has arrived, so release events
queued behind the CDP answer are stopped too; a click that navigates (the guard went with the
old document) counts as landed. `cdp.click_missed` (names what was at the point) and
`cdp.click_lost` (no event reached the page) are the failures.

Biometrics on the emulator (high-risk answers need the platform prompt, spec R.7): enrol a
fingerprint once under Settings → Security → Fingerprint (set a PIN first), then when the
prompt is on screen:

```
adb -e emu finger touch 1
```

Logs and cleanup:

```
adb logcat -s RustStdoutStderr:V Tauri:V forerunner:V
adb uninstall app.forerunner.mobile
adb reverse --remove tcp:8788
adb forward --remove tcp:9222
adb emu kill
```

## What the smoke asserts

| Step | Check |
| --- | --- |
| Pairing | `Pair this phone` → code from `/__test/pair` → `Projects` and Home's project list; one device row named from the form |
| Inbox | the nav opens the `Inbox` screen; the blocking request is first; Approve posts a signed answer without the biometric flag |
| High risk | Confirm on the high-risk request shows the biometric error and sends nothing (no enrolment on a fresh emulator: the shell answers `asserted: false, reason: "Biometrics not enrolled."` at once; a prompt that never answers is refused after 45 s by the shell and 60 s by the UI, inside the 180 s wait) |
| Scenario 9 | the sentence makes one card with three parts; nothing is sent before Confirm; one signed `POST /remote/commands` with `plan = [project.switch, budget.set, session.start]`; the simulated PC reports `done` and a running session on `proj_game` |
| Change log | one entry; Undo sends `[session.stop, budget.set, project.switch]` with `undoOf`; the original is `undone`; the session ends `killed` |

The browser version of the same flow (Playwright on a phone viewport, WebCrypto key and a
simulated biometric dialog instead of the shell) is `apps/ui/e2e/mobile-*.spec.ts`; it runs in
the normal CI matrix and needs no emulator.
