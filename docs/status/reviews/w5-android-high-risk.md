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
(ADR 0085, Consequences).

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

**Docs.** ADR 0085 (and its index row). `docs/maintainers/apps.md` (Android app: the "phone
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
