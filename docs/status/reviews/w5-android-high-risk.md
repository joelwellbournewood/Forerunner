# w5-android-high-risk

Item: Android emulator smoke: a high-risk request confirmed on a phone without biometric
enrolment must show the refusal, and the runner must surface WebView errors.
Branch `wave/w5-android-high-risk`, starting commit c8dca9a (the `wip:` snapshot of an
earlier attempt on top of 82a6295; base `ccr-4d8a843c-1k9syk` at e2bfb1e). Stage BUILD.

## Build report

### What was built

**Diagnosis (from the code; no emulator here).** `android.yml` run 39952987240 clicked
Confirm on the `req_cap` card and never saw `m-request-error`. Each candidate in the brief,
checked against the code and the vendored sources of tauri-plugin-biometric 2.4.0 and
tauri 2.12.4 (`cargo fetch`):

| # | Candidate | Finding | Test |
| --- | --- | --- | --- |
| 1 | `status()` on an emulator without enrolment | The Kotlin `status` resolves `{ isAvailable: false, biometryType: 1, error: "Biometrics not enrolled.", errorCode: "biometryNotEnrolled" }`; the shell answered `asserted: false` with that reason, and the old `shellBiometric` turned it into `null`, so the refusal showed but without the reason. Ruled out as the cause; the reason is now kept (shell: `refusal_from_status`, with an `errorCode` fallback for the result codes the plugin leaves without text; UI: `BiometricRefusedError`). | `mobile-inbox.test.tsx` "candidate 1" (null port; real `shellBiometric` over a mocked bridge); `mobile-shell-signer.test.ts` "candidate 1"; Rust `a_status_without_biometrics_is_a_refusal_that_says_why` |
| 2 | `authenticate()` rejects with an object or string | The old `shellBiometric` caught everything as `null` (refusal shown). But the controller turned a rejection's reason into text with `String(error)`, so a plugin `{ message }` object read "[object Object]" (a real defect the new test caught). Fixed with `failureText`. | "candidate 2" (plugin object, string, `Error`, synchronous throw); Rust `an_authentication_error_is_not_confirmed_with_the_plugins_words` |
| 3 | The call never settles | Nothing bounded the wait: `assertHighRisk` awaited the port forever, and the shell called the plugin's blocking `run_mobile_plugin` on an async worker, where a lost answer or a panic leaves the invoke pending forever. This is the only candidate that explains "no refusal at all" from the app's side. Fixed with two bounds: the shell's `biometric::wait_bounded` (45 s, also turns a panic into a refusal) inside the UI's `biometricTimeoutMs` (60 s); a late success is dropped. | "candidate 3" (never settles, ended by the bound; the 60 s default is under the smoke's 180 s; a late success sends nothing); Rust `a_platform_call_that_never_answers_or_panics_is_refused_in_bounded_time` |
| 4 | Missing test id, or the card re-rendered or removed | Ruled out: `ErrorBanner` carries `m-request-error`, the card is keyed by request id, and nothing clears `inbox` or `stage` during a reload. | "candidate 4" (the same card node keeps the same refusal through `loadInbox`, `refresh` and three poll cycles); every case checks the runner's locator (the `m-request` holding `m-request-high` has exactly one `m-request-error`) |
| 5 | Plugin not registered or not permitted | Ruled out: `lib.rs` registers the plugin; the shell's own Rust calls skip the ACL, and the UI calls only the app command `assert_biometric` (allowed: `build.rs` has no app manifest); `biometric:default` is `["allow-authenticate", "allow-status"]` in 2.4.0. The capability now names both permissions anyway, and an IPC permission error is shown, not swallowed. | "candidate 5" (permission-error string through the real `shellBiometric`); Rust `the_plugin_is_registered_and_permitted_for_the_main_window_on_mobile` |

So the root cause from the app's side is candidate 3, a biometric step with no bound. The
other explanation the code allows, a CDP click that never reached the scrolled-to Confirm
button, is outside the app. The new `webview:` lines tell the two apart on the next run
(ADR 0086, Consequences).

**Code.**
- `apps/ui/src/mobile/store.tsx`: `assertHighRisk` races the port against
  `biometricTimeoutMs` (`BIOMETRIC_TIMEOUT_MS` = 60 s). Every outcome other than a ticketed
  assertion that arrives in time is a `biometric_required` refusal with `details.reason`.
  It logs `forerunner: high-risk answer: asking ...` and `... refused on the phone: <reason>`
  to the console.
- `apps/ui/src/api/state-signing.ts`: `BiometricRefusedError` and `failureText`. The port
  contract now says a port may also reject.
- `apps/ui/src/mobile/shell-bridge.ts`: `shellBiometric.assert` keeps the shell's reason and
  the IPC's error text.
- `apps/ui/src/api/state-client.ts`: `describeStateError` shows the reason: "This answer needs
  a biometric confirmation (Biometrics not enrolled.)."
- `apps/mobile/src-tauri/src/biometric.rs`: `PROMPT_LIMIT`, `refusal_from_status`,
  `outcome_from_auth`, `wait_bounded`. `commands.rs`: the mobile `prompt()` runs the plugin
  calls through `spawn_blocking` + `wait_bounded`, and `assert_biometric` logs the outcome
  without the ticket.
- `apps/mobile/src-tauri/capabilities/mobile.json`: `biometric:allow-status` and
  `biometric:allow-authenticate`, named explicitly.
- `apps/mobile/e2e/cdp.mjs`: `forwardPageConsole`, `formatConsoleEvent`, `formatException`,
  `remoteObjectText`. `run.mjs` turns forwarding on right after the attach, on the same
  page session (`Runtime.enable`, `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`,
  lines prefixed `webview:`).
- `run.mjs` expectations are unchanged. The expectation (refusal naming the biometric step,
  nothing sent, within 180 s) was right. The new bounds (45 s / 60 s) satisfy it. The only
  other change is that scenario 3's PASS line now prints the refusal text.

**Docs.** ADR 0086 (and its index row). `docs/maintainers/apps.md` (Android app: the "phone
that cannot confirm" paragraph, the file map, Tests, Known issues). `docs/maintainers/testing.md`
(the runner's `webview:` lines). `apps/mobile/e2e/README.md`. The `docs/status/BLOCKERS.md`
emulator row (the run, the fix, the next step). A `docs/status/PROGRESS.md` log entry.
Requirement rows R.5, R.7 and V.3 are unchanged: their status cannot change before an
emulator run passes.

**The earlier `wip:` commit (c8dca9a)** held most of the UI half: the bounded wait, the
reasoned refusal, `BiometricRefusedError`. It was kept and verified. Its one broken test
(the shell-signer test expecting `null` for a reasoned refusal) was updated to the new
contract. The object-rejection defect described under candidate 2 was fixed.

### Which tests prove it

- `apps/ui/test/mobile-inbox.test.tsx`: 9 new tests, one per candidate, plus the enrolled
  happy path. The test is signed with the assertion's flag, and the existing
  simulated-prompt happy path is still green.
- `apps/ui/test/mobile-shell-signer.test.ts`: 2 new tests for the shell port's shapes, and one
  updated for the new contract.
- `apps/mobile/e2e/cdp.test.ts`: 5 new tests for `forwardPageConsole` against the fake
  DevTools endpoint. Its `Runtime.enable` hooks the jsdom page's console the way Chrome
  reports it.
- `apps/mobile/src-tauri/src/biometric.rs`: 4 new Rust tests (status mapping, auth mapping,
  bounded wait for a call that hangs or panics, capability and registration).
- Without the change: the candidate 2 object case failed on the `wip:` code
  ("[object Object]"); the candidate 3 cases hang on the pre-`wip:` code; the cdp tests
  import functions that did not exist; the Rust tests call functions that did not exist.

### Commands run and results (on the final tree)

Summary first, then the verbatim output of each command below.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | exit 0 (output below) |
| `pnpm lint` | exit 0, 59 warnings, the same 59 as on the starting commit; none in touched files (output below) |
| `pnpm --filter @forerunner/ui test` | 42 test files, 263 tests passed |
| `pnpm exec vitest run --project unit apps/mobile/e2e` | 1 test file, 22 tests passed |
| `pnpm --filter @forerunner/ui exec playwright test e2e/mobile-` (chromium installed for it) | 5 passed (mobile-inbox, mobile-pairing ×2, mobile-remote ×2) |
| `cd apps/mobile/src-tauri && cargo test` (after installing libwebkit2gtk-4.1-dev / libgtk-3-dev) | 30 passed (lib), 0 failed |
| `cargo clippy --all-targets -- -D warnings` / `cargo fmt --check` | clean / clean |
| `node scripts/docs-check.mjs` and `node scripts/docs-check.mjs --base c8dca9a` | `docs-check: ok (19 files)`, exit 0, both |
| `pnpm check` | exit 0: lint, lint:paths, typecheck, `pnpm test` 269 files / 2678 passed, 4 skipped, 1 todo; docs:check; docs:links ok; secrets:scan clean |
| `git apply --check` of the exported patch on a clean checkout of c8dca9a | `APPLY_OK`, exit 0 (output below) |
| `pnpm --filter @forerunner/mobile exec vitest run e2e/cdp.test.ts` (the hint's command) | finds no files (the root config's projects do not match from that cwd), so it proves nothing; the root `--project unit` run above is the evidence |

About `node scripts/docs-check.mjs` with no `--base`: the script diffs against `origin/main`,
and `origin` has no `main` branch (`git ls-remote --heads origin main` is empty). Without that
ref the script prints "cannot diff against origin/main ... nothing to check" and exits 0,
which checks nothing. So I pointed the local ref at the starting commit
(`git update-ref refs/remotes/origin/main c8dca9a`). The plain invocation then checks
exactly this item's range, and it reports `ok (19 files)`, the same as `--base c8dca9a`.

**`pnpm typecheck`**

```
$ pnpm typecheck

> forerunner@0.1.0 typecheck /workspace/repo
> tsc -p tsconfig.node.json --noEmit && pnpm -r --filter "./apps/*" --if-present typecheck

Scope: 4 of 21 workspace projects
apps/approvals-web typecheck$ tsc -p tsconfig.json --noEmit
apps/mobile typecheck$ echo 'no TypeScript in the mobile shell; see @forerunner/ui'
apps/ui typecheck$ tsc -p tsconfig.json --noEmit
apps/desktop typecheck$ echo 'no TypeScript in the desktop shell; see @forerunner/ui'
apps/mobile typecheck: no TypeScript in the mobile shell; see @forerunner/ui
apps/mobile typecheck: Done
apps/desktop typecheck: no TypeScript in the desktop shell; see @forerunner/ui
apps/desktop typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
[exit 0]
```

**`pnpm lint`** (the last lines; the 59 warnings are all in files this item does not touch;
`pnpm exec biome check` on the touched files prints "No fixes applied" with no diagnostics)

```
$ pnpm lint
  

The number of diagnostics exceeds the limit allowed. Use --max-diagnostics to increase it.
Diagnostics not shown: 39.
Checked 1158 files in 1911ms. No fixes applied.
Found 59 warnings.
[exit 0]
```

**Tests** (the summary lines of each run)

```
$ pnpm --filter @forerunner/ui test (summary lines)
 Test Files  42 passed (42)
      Tests  263 passed (263)
$ pnpm exec vitest run --project unit apps/mobile/e2e (summary lines)
 Test Files  1 passed (1)
      Tests  22 passed (22)
$ cd apps/mobile/src-tauri && cargo test (lib result)
test result: ok. 30 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.36s
```

**Docs check**

```
$ node scripts/docs-check.mjs
docs-check: ok (19 files).
[exit 0]
$ node scripts/docs-check.mjs --base c8dca9a
docs-check: ok (19 files).
[exit 0]
```

**Patch export and `git apply --check` against a clean checkout of the starting commit.**
I exported with `git format-patch --stdout c8dca9a..HEAD > /mnt/session/outputs/w5-android-high-risk.patch`
and checked it in a fresh detached worktree of c8dca9a (zero changed files before the check):

```
$ git worktree add --detach /tmp/verify c8dca9a && cd /tmp/verify && git status --short | wc -l
0
$ git apply --check /mnt/session/outputs/w5-android-high-risk.patch && echo APPLY_OK
APPLY_OK
[exit 0]
```

I ran this check on the series before this report commit, and again on the final exported
patch after it, with the same output. `git log --oneline c8dca9a..HEAD` lists only this
item's six commits. Every commit ends with the trailer
`Claude-Build: managed-agent w5-android-high-risk build`. The first export used `BUILD`; the
six commit messages were reworded in place with `git filter-branch --msg-filter` over
c8dca9a..HEAD. Nothing was rebased onto or merged from another branch, and the trees are
unchanged (`git diff` between the old and new HEAD is empty).

### What is left open and why

- **The emulator run.** There is no emulator or Android SDK here. The fix is proved in unit
  tests that reproduce each candidate, not on a device. Next step: merge, then dispatch
  `android.yml`. On `PASS: Android emulator smoke complete`, record the phase 5 emulator row
  and scenario 9's Android run in gates.md, then revisit R.5, R.7 and V.3.
- **The Android-only Rust (`prompt()` / `platform_prompt()` in `commands.rs`) was not
  compiled.** No Android target is installed, and the hint said not to spend turns on it. It
  uses only APIs read from the vendored sources: `tauri::async_runtime::spawn_blocking`
  (awaits to `tauri::Result<T>`), `Status.error_code`, `AppHandle: Clone + Send`. Its first
  compile is the next `android.yml` run.
- **The cause of run 39952987240 is not confirmed on a device.** If scenario 3 fails again,
  the `webview:` lines say why. No "asking the biometric prompt" line means the CDP click
  missed the button below the fold (the driver's coordinate assumption, apps.md Known
  issues). A refusal line with no visible error means a locator problem.

## Review

Independent adversarial review of the build above (stage REVIEW AND FIX), on the branch at
66b3d28, against the brief and against the base branch `ccr-4d8a843c-1k9syk` at f1948dd
(the branch forks from 82a6295; the base has moved on by 0387401 and others since).

Verdict: **revise**. Score: **76/100**. The UI half does what the brief asks and is well
tested; the console forwarding works; but the forwarding is placed where it collides with the
base's typed CDP driver (a merge breaks `pnpm typecheck`), the new bound leaves the simulated
prompt dialog open behind the refusal, and a few docs claim more than the code or Chrome do.

### Requirements checked

- [x] Each brief candidate (1 status not available, 2 `authenticate` rejection shapes, 3 a
  call that never settles, 4 test id / re-render, 5 plugin not registered or not permitted)
  has a test that drives `InboxScreen` with a port behaving that way and asserts the refusal
  names "biometric" and that no `/requests/req_cap/answer` call is made
  (`apps/ui/test/mobile-inbox.test.tsx`; ran: 42 files / 263 tests pass).
- [x] A bounded wait ends in the refusal (UI `BIOMETRIC_TIMEOUT_MS` 60 s, shell
  `PROMPT_LIMIT` 45 s), both inside the smoke's 180 s; a late success is dropped.
- [x] Happy path (enrolled, prompt passes, answer signed with the assertion) still green,
  both the simulated-prompt test and the new port-driven one.
- [x] Adapter (`shellBiometric`), Rust registration (`lib.rs`) and capability
  (`capabilities/mobile.json` naming `biometric:allow-status` and
  `biometric:allow-authenticate`) checked against the vendored sources of
  tauri-plugin-biometric 2.4.0 (`BiometricPlugin.kt` `status` resolves
  `{ isAvailable: false, biometryType, error: "Biometrics not enrolled.", errorCode:
  "biometryNotEnrolled" }`; `models.rs` `Status`) and tauri 2.12.4 (`run_mobile_plugin`
  blocks on `rx.recv()`).
- [x] `run.mjs` expectation left unchanged, with the reason stated (ADR 0086 item 6).
- [x] Runner forwards `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` after
  `Runtime.enable` on the session it already holds, prefixed `webview:`, with tests in
  `apps/mobile/e2e/cdp.test.ts` (ran: 1 file / 22 tests pass).
- [x] Docs: apps.md mobile section, testing.md, e2e README, ADR 0086 and its index row,
  BLOCKERS emulator row, PROGRESS entry; R.5 / V.3 unchanged (their status cannot change
  before an emulator run passes): correct.
- [ ] Merges cleanly in meaning with the base branch: no (finding 1).
- [ ] Refusal leaves the screen in a usable state on every port: not for the simulated prompt
  (finding 2).
- [x] Security / privacy: the console lines and the logcat line carry reasons only, never the
  ticket, key or token (`grep console. apps/ui/src` finds only the three new
  `forerunner: high-risk answer` lines); the capability grants nothing beyond
  `biometric:default`.

### Findings

1. **medium**: `apps/mobile/e2e/cdp.mjs:914-1030`, `apps/mobile/e2e/cdp.test.ts:19-21`,
   `apps/mobile/e2e/run.mjs:43`. Semantic conflict with the base. The forwarding functions
   were added to `cdp.mjs` and imported from it, but the base's 0387401 ("the CDP driver
   evaluates without eval ...") gave `cdp.mjs` a typed declaration file `cdp.d.mts` and
   dropped the `@ts-expect-error` on that import. After a merge, `cdp.d.mts` does not declare
   `forwardPageConsole`, `formatConsoleEvent` or `formatException`, so `pnpm typecheck`
   fails. Verified: in a scratch worktree, `git merge origin/ccr-4d8a843c-1k9syk` conflicts
   in `cdp.test.ts`, `run.mjs`, `docs/decisions/README.md` and `docs/maintainers/apps.md`;
   after keeping both sides, `tsc -p tsconfig.node.json` reports
   `cdp.test.ts(22,3): error TS2305: Module '"./cdp.mjs"' has no exported member
   'formatConsoleEvent'` and the same for the other two names. Fix: move the forwarding into
   its own module with its own declaration file, so neither side's `cdp.mjs` nor
   `cdp.d.mts` has to change. Then re-run the merge check.
   Resolution: fixed in b90ed52. `forwardPageConsole` and its formatters moved to
   `apps/mobile/e2e/webview-console.mjs`, typed by `webview-console.d.mts` (a structural
   client type, so it fits both the untyped and the typed `CdpClient`), and `cdp.mjs` is back
   to the fork point. Re-run of the scratch merge with the base: `cdp.mjs` and `cdp.test.ts`
   merge cleanly; what is left is one import line in `run.mjs`, the ADR index row and the
   apps.md Tests paragraph, all textual. With those resolved, `tsc -p tsconfig.node.json`
   reports nothing in `apps/mobile`, and `vitest run --project unit apps/mobile/e2e` passes
   on the merged tree (1 file, 25 tests).
2. **medium**: `apps/ui/src/mobile/store.tsx:781-822` (with the simulated prompt at
   `store.tsx:357-379`). The new bound refuses the answer but leaves a pending simulated
   prompt open. In the web and test build (`biometric: "prompt"`), when
   `biometricTimeoutMs` runs out, the card shows the refusal while
   `m-biometric-dialog` stays on screen. A later tap on its Confirm silently issues a
   ticket that nothing redeems, and nothing is sent. The human sees a refusal and an open
   "confirm" dialog at the same time. Verified with a throwaway test (simulated prompt,
   `biometricTimeoutMs: 300`): after `m-request-error` appeared,
   `queryByTestId("m-biometric-dialog") !== null` was `true`, and clicking
   `m-biometric-confirm` posted nothing (test deleted afterwards). Fix: on any refusal of
   the step, dismiss a pending simulated prompt. Test: the dialog is gone once the refusal
   shows.
   Resolution: fixed in 4750717. `assertHighRisk` resolves a pending simulated prompt as
   cancelled on every refusal. The new test "candidate 3, simulated prompt: the bound closes
   the open dialog with the refusal" fails without the change (`expected <div role="dialog"
   …> to be null`) and passes with it; it also proves that a second Confirm opens a fresh
   dialog that sends the signed answer.
3. **low**: `docs/decisions/0086-high-risk-refusal-on-a-phone-that-cannot-confirm.md`
   (Consequences) and `docs/maintainers/apps.md` (Known issues). The real-device
   counterpart of finding 2 is not documented. When `wait_bounded` gives up after
   `PROMPT_LIMIT`, the plugin's `BiometricActivity` stays on screen: tauri-plugin-biometric
   2.4.0 has no cancel command (`BiometricPlugin.kt` has only `status` and `authenticate`),
   and the platform thread stays blocked in `run_mobile_plugin` until the human closes the
   prompt. A touch after the bound does nothing; the phone has already refused. Verified by
   reading `BiometricPlugin.kt` / `BiometricActivity.kt` and `biometric.rs`
   `wait_bounded`. Fix: say so in the ADR and the Known issues.
   Resolution: fixed in 4750717. ADR 0086 (Consequences) and apps.md (Android app, Known
   issues) now state it. There is no code fix without a cancel command in the plugin.
4. **low**: `apps/mobile/e2e/cdp.test.ts:683`, `docs/maintainers/apps.md:1051`. Both say
   Chrome reports nothing from before `Runtime.enable` ("the page's console goes nowhere
   (Chrome reports nothing either)"; "nothing before enable"). V8 does the opposite: its
   `V8RuntimeAgentImpl::enable` replays the console messages and exceptions it kept for the
   context group. So the runner also prints what the app logged before the attach, which is
   useful, but the docs and the test's comment describe it wrongly. Fix the comment and the
   doc. The fake keeps its simpler behaviour, and the comment says so.
   Resolution: fixed in b90ed52. The test comments, apps.md (Tests), the e2e README and
   ADR 0086 item 5 now say V8 replays the earlier messages on enable, and that the fake
   does not.
5. **low**: `apps/mobile/e2e/cdp.mjs:971-979`. `formatConsoleEvent` appends the call site
   to the last line of the joined text. When an argument has a multi-line description (an
   `Error` with its stack), the location lands at the end of the stack's last line, after the
   other arguments. The test pins that output (`cdp.test.ts:709`: `"webview:       at send
   (...) 42 null undefined Object (http://tauri.localhost/assets/index.js:1:4121)"`). A
   `grep 'webview: \[error\]'` then shows the message without its location. Fix: put the
   call site on the head line. Test: the error case has the location on its first line.
   Resolution: fixed in b90ed52. `formatConsoleEvent` puts the location on the first line
   (`withLocation`). The cdp test now expects `"webview: [error] Error: boom
   (http://tauri.localhost/assets/index.js:1:4121)"` as the head line, which the old
   formatter did not produce.
6. **low**: `docs/status/BLOCKERS.md:21` (Android emulator row). The row contradicts
   itself. Its new head says the attach works on the real WebView (run 39952987240). The
   retained "Earlier" text still says the driver "has not met a real WebView yet:
   `android.yml` was not dispatched on 2026-10-23", and it counts `cdp.test.ts` at 17 tests
   (22 now). Verified by reading the row. Fix: reword the retained history so it is past
   tense and true.
   Resolution: fixed in 90639ef. The retained text says the driver was tested only against
   the fake (17 tests then, 22 now) until run 39952987240, its first real WebView run. The
   row names `webview-console.mjs`.

### Verification after the fixes

Run on the final tree (counts as printed):

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0. It reports 59 warnings, the same as on the starting commit, none in
  touched files.
- `pnpm --filter @forerunner/ui test`: 42 test files, 264 tests passed (263 before, plus
  the simulated-prompt case).
- `pnpm exec vitest run --project unit apps/mobile/e2e`: 1 test file, 22 tests passed.
- `cd apps/mobile/src-tauri && cargo test --lib`: 30 passed, 0 failed. The Rust code is
  unchanged in this stage.
- `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` and `--base 82a6295`:
  `docs-check: ok (21 files)`. Without `--base`, the script finds no `origin/main` and checks
  nothing.
- `pnpm check`: exit 0. That covers lint, lint:paths, typecheck, `pnpm test` (269 files,
  2678 passed, 4 skipped, 1 todo), docs:check, docs:links and secrets:scan.
- Scratch merge with `origin/ccr-4d8a843c-1k9syk` (f1948dd), not committed: see finding 1.
