# 0085 — A high-risk answer on a phone that cannot confirm: every failure of the biometric step is a refusal, in bounded time, with the platform's reason; the emulator runner shows the page's console

Date: 2026-10-23
Status: accepted

## Context

`android.yml` run 39952987240 (commit 82a6295, API 30-class x86_64 emulator, no fingerprint
enrolled) attached to the WebView, paired and approved a request, then failed scenario 3:
after Confirm on the high-risk card (`req_cap`), `m-request-error` never appeared within
180 s (`matches: 0, visible: 0`). The job log had no page output, so the cause could not be
read off the run.

What the code did before this change (ADR 0032 item 3 for the ticket rule):

- `MobileController.assertHighRisk` awaited `BiometricPort.assert` with no bound and turned
  only a resolved `null` into the `biometric_required` refusal.
- `shellBiometric.assert` invoked `assert_biometric`, mapped `asserted: false` to `null` (the
  shell's reason, "Biometrics not enrolled.", was dropped) and caught every IPC rejection
  as `null`.
- `assert_biometric` called tauri-plugin-biometric 2.4.0's `status()` and `authenticate()` on
  an async worker. Both are `run_mobile_plugin` calls that block on a channel until the
  Kotlin plugin answers (`tauri-2.12.4/src/plugin/mobile.rs`); a panic inside an async
  command leaves the UI's invoke pending forever.

Reading the vendored sources (`tauri-plugin-biometric-2.4.0`): on a phone without enrolment
the plugin's `status` resolves `{ isAvailable: false, biometryType: 1, error: "Biometrics not
enrolled.", errorCode: "biometryNotEnrolled" }`; every Kotlin exception is caught by
`PluginManager.dispatchPluginMessage` and becomes a rejection; the shell's own Rust calls are
not subject to the capability ACL, and the UI calls only the app command `assert_biometric`
(all app commands are allowed: `build.rs` declares no app manifest). So candidates 1, 2 and 5
of the brief end in the refusal on the old code as well (a `null`), and candidate 4 does not
happen (the card keeps its key and its state across reloads; tested). The only path that
explains "no refusal at all" from the UI's side is a biometric step that never settles
(candidate 3), or a click that never reached the button; neither can be told apart without
the page's console, which the runner did not show.

Open points: how long the phone waits for the platform; what counts as a refusal; what the
refusal says; where the bound lives (UI, shell, both); how the next run shows the cause.

## Decision

1. **Every outcome of the biometric step other than a ticketed assertion that arrived in time
   is a refusal.** `null`, a rejection of any shape (a string, an `Error`, a plugin's
   `{ message, code }` object), a synchronous throw, a malformed outcome (`asserted` not
   `true`, no ticket) and a timeout all become `StateApiError("biometric_required", ...,
   403, { reason })`; the screen shows "This answer needs a biometric confirmation
   (<reason>)." under the `m-request-error` test id inside the request's card, and nothing is
   sent. A success that arrives after the limit is dropped; its ticket expires unused in the
   shell (120 s).
2. **Two bounds, the shell's inside the UI's.** The UI races the port against
   `MobileEnv.biometricTimeoutMs` (default `BIOMETRIC_TIMEOUT_MS` = 60 s). The shell runs the
   plugin calls on a blocking thread behind `biometric::wait_bounded` with `PROMPT_LIMIT` =
   45 s: a timeout, or a thread that panicked, answers `asserted: false` with a reason, so the
   UI normally shows the shell's words. 45 s is enough to read the prompt and touch the
   sensor; both stay well inside the smoke's 180 s wait.
3. **The refusal keeps the platform's reason.** The shell maps a not-available status to the
   plugin's text, else its `errorCode`, else a generic line (`refusal_from_status`), and an
   `authenticate` error to "not confirmed: <plugin's words>" (`outcome_from_auth`).
   `shellBiometric` rejects with `BiometricRefusedError(<reason>)` for a reasoned
   `asserted: false` and with "the shell's prompt failed: <IPC error text>" for a rejected
   invoke (`failureText`). Reasons are never sensitive (no ticket, no key, no token).
4. **The capability names the two commands.** `capabilities/mobile.json` lists
   `biometric:allow-status` and `biometric:allow-authenticate` rather than `biometric:default`
   (the same set in 2.4.0), so a change of the plugin's default cannot drop them; a Rust test
   pins them, the `main` window, the plugin registration and the command registration.
5. **The emulator runner forwards the page's console.** `forwardPageConsole` (`cdp.mjs`) sends
   `Runtime.enable` on the page session the smoke already holds and prints every
   `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` as `webview: [level] ...` lines;
   the controller logs both ends of the biometric step (asked, passed or refused with the
   reason) and the shell logs the outcome to logcat without the ticket. Diagnostics never fail
   the smoke.
6. **`run.mjs`'s expectation stays.** A phone without enrolment must refuse with a message
   naming the biometric step and send nothing; that is what the smoke asserts, and it was
   right.

## Consequences

- A phone without biometrics, a cancelled prompt, a plugin or permission failure and a prompt
  that never answers all end with a visible refusal on the card within 60 s at most; the
  human can retry with the same buttons.
- If scenario 3 still fails on the next `android.yml` run, the `webview:` lines say which
  path ran: no "asking the biometric prompt" line means the click never reached the button
  (the CDP driver, not the app); an "asking" line followed by a refusal line means the
  refusal rendered and the locator missed it; an exception line names the throw.
- `BiometricPort.assert` may now reject (`BiometricRefusedError`) as well as return `null`;
  ports and tests written for "never throws" still work, because the controller treats both
  alike.
- The shell's `prompt()` and `platform_prompt()` are compiled only for Android and iOS; this
  build box has no Android target, so their first compile is the next `android.yml` run.
