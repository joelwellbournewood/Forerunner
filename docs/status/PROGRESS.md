# Progress

Updated by the build agent at every milestone and at least daily. Newest first.

## Milestone status

| Phase | Name | Status | Gate evidence |
| --- | --- | --- | --- |
| 0 | Foundations | CI green on both OS (first at run 39352102564; on the integrated branch after the 41 merges of 2026-10-23 and 2026-10-24: run 125 on 422d9c0; on the final code head a76e259 of 2026-10-25: run 151, https://github.com/joelwellbournewood/Forerunner/actions/runs/40198201562); fresh install timed on fresh runners (2026-10-20: Linux 89 s, Windows 200 s; 2026-10-25: Linux 258 s, Windows 494 s, run 40195327081) | gates.md § Phase 0 |
| 1 | Single agent that does real work | gate passed on the fake provider and live on both billing sources (API key in full; the subscription session through the Agent SDK driver, ADR 0044); kill under 2 s live (49 ms); the API-key half probed again on the new key on 2026-10-23 (4 of 5 cases, kill 129 ms; the harness's classification of the aborted call is fixed by w4-metered-aborted, merged in cf22a14, the live-model gate on 422d9c0 on 2026-10-24 passed every live case, 56 passed and 5 skipped, USD 2.44 over 242 calls) | gates.md § Phase 1 |
| 2 | Two agents, one project | gate passed on the fake provider (two agents, five sessions each, claims, peer feed, PR flow, human requests); state service with device auth, realtime, receipts, decision log, GitHub Projects mirror, approvals web fallback done; the gate's 48-hour offline clause recorded on 2026-10-25 from the state service's integration test (two installs joined by the service, one offline for 48 simulated hours, against Postgres locally and in CI) | gates.md § Phase 2 |
| 3 | Critic and quality loop | gate passed live (40 of 40 seeded defects caught, 40 of 40 clean submissions accepted after ADR 0042); reviews tab done; the two gate rows folded into one on 2026-10-25 | gates.md § Phase 3 |
| 4 | Memory, docs and learning | gate harness passed on the fake provider (four simulated weeks, retrieval under budget, consolidation applied only as approved, no cross-human lesson); memory UI done | gates.md § Phase 4 |
| 5 | Human experience and voice | gate harness passed on the fake provider (simulated week through the daemon API and the phone routes, 29 voice turns, nine settings changes with one change log, 8 phone answers: 5 accepted, 3 of them with the biometric, 3 refused without it; the four runtime findings RT-P5-1 to RT-P5-4 closed, ADR 0049) on Linux and on Windows in CI (runs 144 and 151 of 2026-10-25); the Android emulator half passed on 2026-10-25: the raw-CDP smoke (ADR 0054; ADR 0087 amended by `w8-android-nav-settle`, which found the WebView's input path landing lower than the page's coordinates once the page is longer than the viewport and added the layout-settle wait, the in-page hit test and the shifted-click fallback) attaches, pairs by code, passes the signed approval, the high-risk refusal without the biometric, R.5's Reviews, Upload and Chat voice turn, scenario 9 and the change log's Undo through the real WebView in five consecutive `android.yml` runs on successive heads (40182115934, 40183122342, 40185240435, 40195655038, 40198266359), the last on the final code head a76e259; the real-audio half pending (no devices on the build box); the Settings → Capabilities → Email page (ADR 0066), PM intake (ADR 0055) and what you say during a live session (ADR 0078) landed 2026-10-23 and were independently reviewed and fixed on 2026-10-25; the global hotkey (O.1), Read aloud and spoken alerts (L.6), the chat's docs and lessons (J.1, O.2), the phone's uploads, reviews and push-to-talk (R.5, done), Settings → Devices (R.2) and the speed-versus-quality slider (D.16) merged 2026-10-23 and 2026-10-24 | gates.md § Phase 5 |
| 6 | Capabilities | injection suite, live revocation, overnight cloud-runner session, emailed task and spoofed email passed on the fake provider and the in-process mail server; live halves pending a real mailbox and host | gates.md § Phase 6 |
| 7 | Self-improvement and model economics | gate harness passed on the fake provider (a plain-language UI change ships as a signed update, a broken release rolls back on one install and the other never takes it, a model-watch run proposes a switch the human adopts); on Windows in CI runs 144 and 151 of 2026-10-25 | gates.md § Phase 7 |
| 8 | Full integration and release 1.0 | nine scenarios pass on Linux (three runs each on 2026-10-20, once more on e42c730, 422d9c0 and the final code head a76e259 on 2026-10-25) and in CI on both OS (run 151 on a76e259, https://github.com/joelwellbournewood/Forerunner/actions/runs/40198201562; runs 131 and 144 earlier the same day); the Android emulator smoke passes the whole phone side in five consecutive runs (phase 5 row); 41 items merged on 2026-10-23 and 2026-10-24 and 19 more on 2026-10-25 (the seven handover items, the triage re-read's fixes, the ten independent reviews of the first-wave items with their fixes), every item with its file under `docs/status/reviews/`; requirements 210 done, 16 in progress, 2 todo of 228; the live-model gate passed on 422d9c0 on 2026-10-24 (56 live cases passed, 5 skipped, USD 2.44 over 242 calls; not re-run on a76e259: no live key in the build container); security suite green in CI on a76e259, 0 P0 and 0 P1 after the triage re-read (`docs/status/reports/triage-2026-10-25.md`), nine security findings fixed by the day's reviews; fresh install re-timed (Linux 258 s, Windows 494 s); release criteria 3, 4, 7 and 8 met on the final code head, 1, 2, 5, 6 and 9 not; no release cut | gates.md § Phase 8 and § Release 1.0 criteria |

## Log

### 2026-10-30 (1.0.1 prepared: the installers carry the runtime, the app sets itself up)
- The first real user installed the 1.0.0 MSI, found it needed a daemon, ran
  `fresh-install.ps1` on a ZIP of the default branch (722 commits behind 1.0.0), and the 1.0.0
  app attached to a 0.1.0 daemon: "GET /me does not match the contract: desktopDeviceId". The
  human asked for an install that needs no PowerShell, keys pasted in the app, and everything
  up to date.
- Default branch `claude/forerunner-1-0-build-o53s04` fast-forwarded to `adb7c2a` (v1.0.0 plus
  the handover) on the human's word, so "Download ZIP" is current.
- ADR 0092 on `claude/optimistic-einstein-zj5xx2`:
  - the MSI, AppImage and `.deb` carry Node, the runtime's sources and their production
    dependencies (`scripts/build-runtime-payload.mjs`, run by `beforeBuildCommand`;
    `scripts/runtime-payload-smoke.mjs` in `desktop.yml` and `release.yml`);
  - the shell runs that bundle ahead of `install.json` and replaces a daemon older than it;
  - the installed runtime seeds its registry into `<data>/registry`;
  - the app's setup assistant (`/setup`) takes the keys by paste through `runSetup`;
  - the GitHub hint is "Commit statuses: read" (handover item 4 below, done);
  - version 1.0.1 with its CHANGELOG section.
- Evidence:
  - cargo test 100 and clippy clean;
  - unit tests 3626 passed;
  - UI tests 495 passed. The `mobile-upload` load flake already listed below hit once here and
    once in CI. Its cause: the harness's 40 ms poll also flushes the outbox and sent a third copy
    during the lost-answer step. That test now turns the poll off and passes under two
    concurrent full UI runs;
  - a `.deb` built and installed here and run under Xvfb against a 0.1.0 stand-in daemon: the
    shell stopped it and the bundled runtime answered in 5 s;
  - screenshots of the assistant against the bundled daemon.

  Windows evidence: `desktop.yml` run 40982952184 on c2d154d, green on windows-latest and
  ubuntu-22.04. It ran:
  - the UI and Playwright tests;
  - cargo fmt, clippy and tests;
  - `tauri build` (MSI; AppImage and `.deb`);
  - the bundled runtime started from `src-tauri/runtime/` (`runtime-payload-smoke.mjs`).

  That run needed three fixes found on the way, each red on the released code too or
  Windows-only:
  - four Playwright specs behind their fixtures;
  - clippy's dead-code error on `linux_display_missing` on Windows;
  - `pnpm deploy` gluing a temp dir on C: onto the D: workspace path.

  The payload now ships the lockfile's versions: `inject-workspace-packages` instead of
  `--legacy`.
- Open:
  - tag `v1.0.1` (the human's go; `release.yml` builds and publishes);
  - "Update and restart" on the desktop still stages the installer file, so installing the new
    MSI over the old one is the update path (`updates.md` Known issues);
  - the installed MSI has not been run on a real Windows desktop yet.

### 2026-10-25 (the 2026-10-24 handover worked through: seven items, the triage re-read, ten independent reviews with their fixes, the emulator smoke passing, no release cut)
- Base: `ccr-4d8a843c-1k9syk` at 647eb16 (the 41 merged items) plus the maintainer's
  `build-item.yml` from the default branch; integration branch `ccr-af5a431d-jc9xqj`, final code
  head a76e259 (19 item merges and 12 direct commits). Items were built and reviewed in parallel
  git worktrees by sandbox agents (one per item, each with its own Postgres database) and merged
  by the orchestrating session, which resolved the conflicts (mostly the same Known issues
  paragraphs in `docs/maintainers/runtime.md`, kept from both sides), ran the checks and wrote
  the status files from the rows the agents returned; every item has a file under
  `docs/status/reviews/`.
- Handover items 1, 4, 5, 7 and 8 done; items 2, 3 and 6 stay with the human or the final build:
  1. Android emulator: `w8-android-nav-settle` (ADR 0087 amendment) diagnosed run 40013402240's
     miss as the WebView's input path landing lower than the page's coordinates once the page is
     longer than the viewport, not the layout race; the driver now waits for the layout to settle,
     measures, hit-tests and arms its guard in one in-page call right before the mouse events,
     and after three guarded misses falls back to a mouse click shifted by the offset the page
     reported, then a touch tap, then `element.click()`, each announced as a `click fallback:`
     line (`apps/mobile/e2e/cdp.test.ts`, 36 tests). `android.yml` then passed the whole smoke
     five times on five successive heads (runs 40182115934, 40183122342, 40185240435,
     40195655038 and 40198266359 on a76e259): every click past the first screen went through the
     shifted-mouse step with the same nine offsets each run (20 to 207 px per screen), none
     through a tap or `element.click()`, so the smoke drives the real input path. gates.md phase 5
     emulator row and scenario 9's Android column filled; R.5 and V.3 done.
  4. Open review findings: O.4's five (`w8-o4-voice-findings`: a switched-off cloud voice row is
     excluded from the fallback), the late hooks approval of J.7 and S.6 (`w8-late-approval`,
     ADR 0088: matched by task and key across the agent's sessions, consumed once, the daemon
     and the cloud runner share the mark), B.5's four and w4-stale-docs' three lows plus the
     duplicate-paragraph sweep (`w8-low-findings-docs`), the C.5 proposal tool
     (`w8-c5-propose-tool`, ADR 0071 point 8: `specialist.propose`, model tool
     `specialist_propose`). Then the ten first-wave items merged without a review were each
     reviewed adversarially and fixed on their branch, every fix with a test that failed first
     (verdicts 58 to 76; 70 findings: 63 fixed, one low left open, the tray's stale pause state
     after a pause made elsewhere, and six documented as limits or resolved as not a defect):
     w2-a4-sources (70), w4-private-memory (72), w2-s13-shared-secrets (74), w4-install-identity
     (62), w2-email-page (58), w4-android-signing (60), w2-a2-intake (70), w2-g6-promotion (76),
     w3-o9-chat-to-inbox (62), w2-g5-docs (62); their open lines are BLOCKERS.md "Reviews of
     2026-10-25" and their ADR amendments are dated 2026-10-25 (0015, 0052, 0055, 0056, 0058,
     0059, 0065, 0066, 0071, 0078, 0082, 0083, 0087).
  5. A.3 GitHub import finished from its WIP branch (`w3-a3-import`, ADR 0069: clone under the
     install's data directory onto `forerunner/migration-<date>`, the default branch never
     written, the token by reference and scoped to the origin); P.7 and P.11 docs
     (`w3-docs-p7-p11`: `adding-a-connector.md` filled, `security.md` describes the injection
     suite); the triage re-read's small fixes (`w8-small-fixes`: the startup checklist diffs
     against the last ended session, reserved `forerunner.*` secret names refused on every grant
     and reference path with the new code `secret_reserved`, `fr vault set`, the `mcp-github`
     entry's secret name, six stale doc lines). A.4's install marker is written with the G.5 doc
     set (`w2-g5-docs`), so A.4 and G.5 are done too.
  7. Package `test` scripts run vitest from the workspace root on their own test directory,
     pinned by `scripts/package-test-scripts.test.ts` (they found no files before).
  8. Duplicate passages swept (one real duplicate merged in testing.md; the rest were not
     duplicates).
- Also: the phase 2 "offline 48 hours" gate row was stale (the state service's integration
  test has covered it since the service landed and passes against Postgres); the phase 3 gate's
  two rows folded into one; the phase 5 and 7 harness rows record their Windows runs;
  `scripts/dev-postgres.sh` fixed on the root path (SQL through stdin); the fresh install timed
  again on fresh runners (Linux 258 s, Windows 494 s, run 40195327081); V.4 re-read: 0 P0, 0 P1,
  the P2 list in `docs/status/reports/triage-2026-10-25.md`; `.claude/worktrees/` ignored after
  a `git add -A` had committed the agents' worktree gitlinks (removed again in 345f087).
- Security findings fixed by the day's reviews (each with a failing test first, CHANGELOG
  "Security"): a private lesson's text reached the shared Postgres through the weekly
  consolidation's approval request; a shared-secret proposal naming `forerunner.install_wrap_key`
  wrapped this install's private key to a peer; a revoked device kept its wrapped shared-secret
  copies and a recipient's daemon could revoke the owner's grant; the GitHub token followed a
  `Link` page to another origin; an email mode change from the Settings page skipped the
  high-risk card and a cross-human agent could make it; a line or a "stop" from another human
  reached this human's live session, and a "stop" with other words in the sentence was
  forwarded as data; a `v*` tag without the keystore secret published a development-signed APK
  (now the tag fails without `ANDROID_KEYSTORE_BASE64`); the docs clone's token was not scoped
  to the repository's origin; cross-project lesson offers ignored the ownership rule on a shared
  store.
- CI on a76e259: run 151 green on both OS (https://github.com/joelwellbournewood/Forerunner/actions/runs/40198201562); runs 131 and 144 green earlier; run 129
  (the paths lint on a new test) and run 139 (an unhandled socket error on Windows) red and
  fixed by the next commit. Full local check on a76e259 in gates.md "Release 1.0 criteria".
  `pnpm gates:verify`: 36 of 39 checks passed, 0 of 9 criteria "passed" (the criteria rows use
  met/not met), requirements 210 done, 16 in progress, 2 todo. Load-induced flakes seen under
  the parallel agents and not reproduced alone: `monthly-jobs-wiring.test.ts`,
  `context.test.ts`, the UI's `mobile-inbox`, `mobile-pairing` and `mobile-upload` tests.
- Build spend: about 8.9 million agent tokens over about nineteen sandbox agents on the
  subscription; no USD figure; nothing charged to an API key (COST.md).

### Where to pick up (handover of 2026-10-27, after the v1.0.0 release)
v1.0.0 is released (tag on 5b4c267, `release.yml` run 40494452844, signed manifest verified).
It shipped with known gaps the human accepted; `docs/release/1.0.0-tested.md` is the honest
record of what was tested live, against stand-ins only, or not at all. Supersedes the
handovers below where they differ.

Open for 1.0.x / 1.1, in order:
1. Close the test pull request #2 on the repository (left by the V.8 re-run).
2. Handover on a PC without a sandbox: the agent cannot run the check command, the critic
   sends the change back and the retry ladder spends about three more attempts. Go straight
   to the human when shell is withheld and a check criterion cannot be verified; fix the
   handover report's wording ("the change was not made") and print the sent-back count.
3. Email live check (L.3): `scripts/email-live.ts` is written and passes offline (local
   branch `email-live`, commit 4ceee86, adds `Mailbox.verify()`); needs an independent review,
   then the human's mailbox (Gmail with 2-Step Verification and an app password; his new
   Google account could not enable 2FA yet, GMX sign-up failed).
4. Done on 2026-10-30 (ADR 0092): the setup wizard's GitHub check listed "Workflows: read"; it
   now lists "Commit statuses: read" (`packages/runtime/src/setup/validators.ts`).
5. Android versionCode ignores the pre-release part (rc.3, rc.4 and 1.0.0 share 1000000).
6. Voice first audio misses 1.2 s (GPU 1.4 to 2.1 s; the model's first token is the largest
   stage); the STT helper crash 0xC0000005 is diagnosable now but its cause is unproven.
7. Cloud runner on Claude Managed Agents (the human's wish); push notifications with a real
   Firebase project (R.6, K.8).
8. The human's GitHub token for V.8 has admin rights and expires after 7 days; revoke it when
   no longer needed.

### Where to pick up (handover of 2026-10-25 night, the cloud session)
Written 2026-10-25 ~22:20 UTC by a cloud session working the evening handover below (code head
50af41b; CI CI run 40239631674 on 50af41b green on ubuntu-latest and windows-latest with gitleaks, the dependency audit and the runner image (https://github.com/joelwellbournewood/Forerunner/actions/runs/40239631674)). It supersedes that handover where they differ. Every code change below
was written test-first, had its maintainer doc in the same commit and was independently
reviewed before the push (verdicts in the log entry under it).

Done tonight:
- **The manual update check (the human's decision):** nothing asks the release feed on its own;
  `GET /updates` is local state, `POST /updates/check` is the "Check for updates" button; the
  tray item is "Updates…" and only opens the screen; installing stays the "Update and restart"
  click. The project's feed `github:joelwellbournewood/Forerunner` and update key
  `26fae7f48427e5eb` are the built-in defaults (overridable; a broken `update.json` turns updates
  off). ADR 0015 amendment.
- **rc.1:** `push-rc1.cmd` tagged 7e95e39; `release.yml` run 40229971920 built and signed the
  Windows and Linux desktop bundles, the Android APK and the runner image, then failed in the
  publish job (download-artifact also fetched docker/build-push-action's build record, which
  failed to download). Fixed in d8e3fb4 (named downloads, no record upload). No GitHub Release
  exists for rc.1. Also fixed before the next tag: SHA256SUMS covers the signed manifest and
  never itself, the broken manual dispatch is gone, and the app's version is one committed
  value checked against the tag in every build job (it was 0.1.0 everywhere; it is now
  `1.0.0-rc.2`; `scripts/release-version.mjs`).
- **Live tests written, offline dry runs green, not yet run live:** `live-5-chat-cache` (D.9:
  one warm-up and six composed chat turns on Haiku, cache reads asserted; the composed prefix
  was already cached and byte-stable, so the 1156 ms median was four cold single samples),
  `live-6-researcher` (D.13) and `live-7-critic-tiers` (D.15, with a probe of effort `max`
  before any tier review). Expected about USD 1, ceiling about USD 3.
- **FCM, the app half (ADR 0085 point 9, amended):** built in only when `google-services.json`
  is present (CI writes it from the secret `GOOGLE_SERVICES_JSON_BASE64`); the token at pairing
  and on refresh, the four kinds on two channels, links limited to app paths. Compiled only by
  CI's Android job; never run on a device.
- **Helpers for the human's runs:** `scripts/handover-live.ts` (V.8 on a dedicated install; the
  handover job's stuck-place rule no longer counts the merge that autonomy 2 leaves to a human,
  ADR 0060 amendment), `scripts/voice-run.ts` (check and report) and the voice panel now plays
  the reply audio (nothing played it before).

Launchers in the human's folder (`.git/info/exclude`), in this order:
1. `push-rc2.cmd`: tags 50af41b as `v1.0.0-rc.2`; then watch `release.yml` and record it.
2. `run-timings.cmd`: live-5, live-6, live-7 under the caps (USD 10 per run, 80 in all); commits
   the ledger after both secret scans; copy the printed lines into gates.md.
3. `r1-android.cmd`: downloads the rc.2 APK, checks its signer, installs and launches it on the
   emulator or a phone (R.1); `FROM_TAG` for an update over an earlier release.
4. `voice-run.cmd`: ten push-to-talk turns plus a warm-up; prints `VOICE RESULT`.
5. `v8-handover.cmd`: needs `FORERUNNER_GITHUB_TOKEN` in `.env.build` first; opens real PRs.

Still open for v1.0.0 (gates.md "Release 1.0 criteria"): the rc.2 release run (criteria 3 and
5's tagged run); the live D.9, D.13 and D.15 figures (criterion 6); real audio (criterion 2,
D.8; Linux still needs a machine with audio); the V.8 live run; R.1 on a device; the Firebase
service account and the device check (R.6, K.8); a mailbox (L.3) and a runner host (S.12);
then the status pass; in the commit to tag, `node scripts/release-version.mjs --set 1.0.0` and
the CHANGELOG heading `[1.0.0-rc.2] - 2026-10-25` renamed to `[1.0.0] - <tag date>` (it already
carries the P2 list of `docs/status/reports/triage-2026-10-25.md`); and the human's word for
`v1.0.0`. Rotate the keys after the release.

### 2026-10-25 night (manual update checks, rc.1's release run, live timing tests, FCM app half, helpers for the human's runs)

Commits d8e3fb4 to 50af41b on `ccr-af5a431d-jc9xqj`, each test-first with its maintainer doc,
and each independently reviewed before the push: the manual check db54fcd (76, revise) and its
fixes 58f4d7c; the version stamping d36c154 (62, revise: the Windows step ran under pwsh, the
daemon read an uncommitted version) and its fixes b425531 (86) and fccd7ef; the D.13/D.15 tests
01019c1 (85) and 8ca9f4f; the FCM app half c829a02 (82) and 2c1d98c; the chat cache guard
e48133a (88) and 68d0fc1 (92); the V.8 helper e45788a with 654b06a (86) and 9b178ba (90);
voice-run and the panel's reply playback 766909d/2eb8d55 (79), b1e65fc (78) and 77d100d. Full
local check on b1e65fc (Postgres 16 via `scripts/dev-postgres.sh`): `pnpm check` (lint, paths, typecheck, 316 unit files with 3334 passed and 4 skipped, docs check, links, secret scan) exit 0; `pnpm test:integration` 8 files passed, 1 skipped, 85 tests passed; the nine scenarios and the phase harnesses (`--project e2e tests/e2e/scenarios`) 13 files passed; `@forerunner/ui` 56 files passed; `@forerunner/live` (offline) 11 files passed, 4 skipped, 61 tests; `@forerunner/approvals-web` passed; the desktop shell `cargo test --lib` 91 passed, clippy and fmt clean. CI: CI run 40239631674 on 50af41b green on ubuntu-latest and windows-latest with gitleaks, the dependency audit and the runner image (https://github.com/joelwellbournewood/Forerunner/actions/runs/40239631674);
`android.yml` dispatched on fccd7ef, run 40238080672 (https://github.com/joelwellbournewood/Forerunner/actions/runs/40238080672), passed: the FCM Kotlin and Gradle wiring compile and `PushLinksTest` runs. Again on the code head 50af41b: run 40239663025 (https://github.com/joelwellbournewood/Forerunner/actions/runs/40239663025), passed.
No requirement moved to done (every remaining row needs a live run, a device or a credential).

### Where to pick up (handover of 2026-10-25 evening, the session on the human's PC)
Written 2026-10-25 ~18:10 UTC by the session that worked `docs/status/runbook-release-local.md`
(head 7e95e39; CI run 40216729473 green). It supersedes the handover below where they differ.

Done today: the live suite on the human's Windows PC under the human's caps (USD 10 per run,
USD 80 in all), every file passing (run `2026-10-25T15:54:57.065Z`, 60 of 61; live-4 after its
harness fix `2026-10-25T17:27:00.112Z`, 5 of 5), ledger 77b3fd8 (1,107 rows, USD 11.131482);
the critic calibration live again (10/10 and 40/40 both ways); D.20 confirmed live and the
Opus 5.5 fast price corrected to the published 8 / 40 (9f86bd4, b7f73cb); release.yml fixed so
the update manifest is actually signed and the notes report signing truthfully (a787fd9,
3f93dcf, e46c881, bb054b3); the release signing keys generated on the human's PC
(`.release-keys/`, git-ignored there) and set as repository secrets (ANDROID_KEYSTORE_*,
TAURI_SIGNING_*, UPDATE_SIGNING_KEY; WINDOWS_CERTIFICATE deliberately unset, the MSI ships
unsigned); Firebase project `forerunner-f29da` with the Android app registered. Every code
change was independently reviewed before it was pushed (verdicts 72->90, 84, 90).

How a session works with this human's machine (learned today):
- Keys, tokens and passwords never pass through a session: the human types them into
  `.env.build` (git-ignored) or a console; scripts read them from files or stdin.
- The cloud workspace cannot push git tags (proxy 403) or set Actions secrets; the desktop
  app's Linux shell on the PC cannot reach GitHub and kills every process when a command
  returns (3 min max); computer use cannot type into terminals. So anything long, any tag
  push and anything with the key runs as a `.cmd` launcher in the human's Forerunner folder
  (`C:\Users\Domino\Forerunner`), logging to a `.log` the session reads; launchers are
  listed in `.git/info/exclude` there, not committed. Existing: `run-live.cmd`,
  `finish-live.cmd`, `set-secrets.cmd`, `push-rc1.cmd`.
- The human's decision of 2026-10-25: no automatic update check; an Updates menu entry and a
  "Check for updates" button only; installs stay a human click; the project's update public
  key `T4+qibk62TL/GuTszYxLstqgKDPTgNIYtXFAaJTwXaA=` (key id `26fae7f48427e5eb`) built in as
  the default trusted key so friends' fresh installs accept official releases. Not started in
  code; investigated: opening the Updates page queries the feed (`apps/ui/src/pages/UpdatesPage.tsx`
  calls GET /updates on mount; `packages/runtime/src/update/screen.ts` `composeUpdatesView`
  defaults `checkFeed` to true and calls `manager.check()`); nothing else checks on its own
  (daemon start, tray, scheduler, checklist; `updateAvailable` has no caller; `autoCheck` in
  `update/config.ts` is read nowhere). A fresh install has no feed (empty in-memory feed) and no
  trusted keys, so it can neither find nor verify a release: it needs the built-in key and the
  default feed `github:joelwellbournewood/Forerunner`. Plan: GET /updates local state only, a new
  POST /updates/check (`DAEMON_ROUTES`, the UI client) behind the button "Check for updates"
  (keep testid `updates-check`); `checkFeed` default false; `autoCheck` default false, still
  parsed; `DEFAULT_TRUSTED_KEYS` and the default feed in `config.ts`, injectable, an explicit
  `trustedKeys` replacing the default; tests first (`apps/ui/test/updates.test.tsx`,
  `update-screen.test.ts`, `wiring.test.ts`, the phase 7 gate's GET-based checks,
  `update-verify.test.ts`); docs updates.md, apps.md, setup-guide.md, ADR 0015 amendment.

Open for v1.0.0 (gates.md "Release 1.0 criteria"; the human tags v1.0.0 only in words):
1. The human runs `push-rc1.cmd` (tags 7e95e39 as `v1.0.0-rc.1`); watch `release.yml`, fix what
   fails on this branch, record the run in gates.md phase 0 / criteria 3 and 5.
2. Finish, review and merge the manual update check (above); then a new rc if release.yml
   or the app changed.
3. D.13 (a researcher session) and D.15 (tier 2 and 3 Opus critic reviews): no live test
   covers them; write them in `tests/live` (offline dry runs first), run them through a launcher
   under the human's caps, copy the figures into gates.md's response-time table.
4. D.9: the composed chat turn's first token, four samples 641/807/1505/2453 ms, median
   1156 ms over the 1 s target; try caching the tool definitions (prompt caching) with a test,
   then measure live through a launcher; else the human decides.
5. Human-dependent: real-audio voice run (Windows: ten push-to-talk turns; Linux needs a
   machine with audio), the Firebase service account (then build the app's FCM wiring, R.6 and
   K.8, ADR 0085 point 9), a dedicated mailbox with an app password (L.3; S.12 needs a runner
   host), R.1 on the emulator or a phone with the signed rc APK, V.8 handover through a
   launcher (`fr setup --non-interactive` reads the `FORERUNNER_*` names of `.env.build`; a
   separate `--profile`; project from `fr sources add github_repo`; settings.handover.enabled
   via the daemon's `PUT /projects/:id/settings`; autonomy 2 via `autonomy.set`).
6. Release paperwork: CHANGELOG `[1.0.0]` with the P2 list of
   `docs/status/reports/triage-2026-10-25.md`; requirement rows to done with their tests; the
   nine criteria; COST.md; CI green on the final head; then ask the human for the v1.0.0 tag
   and rotate the keys after it.
7. Known flake: scenario 2's sent-log read (testing.md Known issues).

### Where to pick up (handover)
Written 2026-10-25 by the orchestrating session after the day's 19 merges; it replaces the
handover of 2026-10-24. The code is at a76e259; the rules stand: a failing test first, the
maintainer doc in the same change, an independent review before the merge, the requirement row
and its BLOCKERS.md row updated at integration, nothing marked passed without command, date,
result and link. The operational order for a session on the human's own PC is
`docs/status/runbook-release-local.md`.
1. **Human-only items.** Revoke and re-issue the API key pasted into the build session of
   2026-10-23 and the key and subscription token of 2026-10-20 (BLOCKERS.md key rows; the
   repository is public, `pnpm secrets:scan --logs` before every push). Then provide: a new
   subscription token for `live-4-subscription`; a real mailbox and host for the phase 6 live
   halves (S.12's unlock on a real runner host with it); real audio devices for the phase 5
   real-audio row and D.8; a Firebase project for R.6's Android wiring; the Android release
   keystore secrets `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD` (since 2026-10-25
   a `v*` tag refuses to build without them, ADR 0015 amendment, even for a desktop-only
   release); the real-device checks the merged items left (S.32's banner and tray on Windows and
   Linux, O.1's hotkey and microphone in a real desktop window, R.2's pairing against a real
   daemon and state service).
2. **Live, on the build box with the live key (never in CI).** The live-model gate on the final
   build (`pnpm --filter @forerunner/live test:live`; last on 422d9c0, not re-run on a76e259
   because the build container of 2026-10-25 had no key), `live-4-subscription` once the token
   exists, one fast-mode call (D.20), the monthly handover on Forerunner's own repository
   (`fr jobs handover <project> --force`, V.8), D.8, D.13 and D.15 timings, and the run's timing
   figures copied into gates.md's response-time table (V.6). Record every run in COST.md and
   gates.md with its ledger total; the phase 1 "first token" row and the phase 8 "re-run on the
   final build" row move with it.
3. **The release.** gates.md "Release 1.0 criteria": 3, 4, 7 and 8 are met on a76e259; 1 needs
   the 18 open requirement rows (all of them item 1 or 2 above, plus the module R rows R.1 and
   R.6 and P.13's ADR row); 2 needs the three pending gate rows (item 2 and the audio devices);
   5 is met on the code head and waits for the tag's own run; 6 needs D.8, D.13 and D.15; 9
   follows. Tag `v1.0.0` only when every criterion reads met; `release.yml` builds Windows,
   Linux and Android artefacts, writes the changelog section from `CHANGELOG.md` (copy the P2
   list of `docs/status/reports/triage-2026-10-25.md` "Release notes: known issues" into the
   `[1.0.0]` section first) and signs the update manifest with `UPDATE_SIGNING_KEY`. The final
   tag's CI run replaces run 151 in phase 0 and criteria 3 and 5. `build-item.yml`'s default
   base branch still names `ccr-4d8a843c-1k9syk`; point it at the integration branch or the
   default branch when this branch merges.
4. **Residuals the reviews left** (BLOCKERS.md "Reviews of 2026-10-25", each a Known issues
   line): the cloud runner's own private memory index in hybrid and cloud-only mode (split from
   the PC's, unencrypted on the runner host) until the spec's encrypted cloud slot is built; the
   tray's stale email pause state (an `email.paused` frame); `/chat` without an idempotency key;
   several late approvals bundled into one cloud start name only the first; a cloud voice
   provider with no `voice-*` row is still the fallback when its key is in the vault; a failed
   automatic intake leaves no doc set until re-run; the UI's import form not wired to the GitHub
   source; the PR executor's GitOps without `auth.origin`. Tests that flake only under heavy
   parallel load (`monthly-jobs-wiring.test.ts`'s settle race first) deserve a small item.
5. **The Android system image.** The API 30 `aosp_atd` image's Chromium 83 WebView drops
   Tailwind v4's cascade layers, so the screens render unstyled on the emulator and every click
   needs the shifted-mouse fallback; a `google_apis` API 34 image renders the app styled but its
   boot did not finish in 10 minutes on the 2-core runner (raise the boot timeout or the runner
   size). The smoke passes either way; this is a P2.

### 2026-10-23 and 2026-10-24 (27 reviewed items merged; the review process; three rebase rounds; status pass)
- After the fifteen merges of the morning (next entry), 27 more items were built, reviewed and
  merged into `ccr-4d8a843c-1k9syk` between 12:56 UTC on 2026-10-23 and 00:13 UTC on
  2026-10-24 (`git log --merges --format='%s' origin/ccr-4d8a843c-1k9syk | grep wave/`), 41
  items in all for the build day. Each has its review file under `docs/status/reviews/<item>.md`
  (build report, review with findings and resolutions, rebase records, what was left open).
  The per-item build, review and rebase entries the branches wrote into this log while they
  were open are folded into this entry; their detail is in those files.
- What merged, in merge order:
  - early afternoon: w3-b5-reasons (B.5, afa97b0), w3-o4-voice-prefs (O.4, b1804e3),
    w4-stale-docs (the triage's 20 stale Known issues entries, e2bfb1e), w4-desktop-confirm (the
    triage P1, c713755), w5-review-findings (the wave-1 review findings, a5525cd), w2-j9-merge
    (J.9, ADR 0062, 576fe26);
  - late afternoon: w4-metered-aborted (the live harness's aborted call, cf22a14),
    w2-s12-unlock-card (S.12, ADR 0068, 9f71e01), w2-monthly-jobs (H.7, P.15, ADR 0060,
    be9bc25), w2-d20-fastmode (D.20, ADR 0057, 22982fa), w2-chat-memory (J.1, O.2, ADR 0061,
    8875c59), w2-s32-indicator (S.32, ADR 0067, c83a15d), w3-e1-triggers (E.1, ADR 0075,
    7818e65), w4-fcm-sender (R.6 service side, ADR 0085, cac6fee);
  - evening: w2-l6-speak (L.6, ADR 0063, 78f610e), w3-c5-specialist-approval (C.5, ADR 0071,
    764621f), w3-d16-slider (D.16, 443139a), w3-e4-recheck (E.4, ef744a5),
    w5-android-high-risk (ADR 0086, 4ff4fb1), w3-d4-specialist-settings (D.4, ADR 0072,
    aa497bf), w3-r5-phone (R.5, ADR 0080, 38ae8cc), w6-android-inbox (ADR 0087, bc10bc8);
  - night: w3-d7-performance (D.7, D.19, 92cfcd7), w3-t1-mode-off (T.1, ADR 0081, abe3bb0),
    w3-misc-replay-ceiling (scenario 9's replay, the executor's ceiling, 95097ae), the
    body-parser override for the dependency audit (e4f702f), w3-r2-devices (R.2, 646ee74) and
    w2-o1-hotkey (O.1, ADR 0064, 422d9c0). The ADR index rows the merges brought without a row
    were added centrally (f1948dd, fd883ed, 9cd67ba).
- The review process: every item ran as a chain of sandbox sessions on its `wave/<id>` branch.
  A build session (or, for the items the credit stops of the morning had cut off, a session
  that continued from the branch's `wip:` snapshot) wrote the code, the tests, the maintainer
  docs, the ADR and the build report, and returned the requirement and status rows to the
  integrator instead of editing the status files. An independent adversarial review session
  then traced the change from its real callers, proved each defect with a throwaway test or a
  mutation, gave a verdict and a score, and fixed every finding on the branch with a test that
  fails without the fix, or recorded it as not a defect. Three items were accepted as built
  (w3-b5-reasons 86, w3-o4-voice-prefs 78, w4-stale-docs 92); 24 were sent back (scores 62 to
  80) and fixed in the same stage. The 27 reviews raised 149 findings, twelve of them high (in
  w2-l6-speak, w2-monthly-jobs, w2-o1-hotkey (two), w2-s32-indicator (two),
  w3-c5-specialist-approval, w3-d4-specialist-settings, w3-e1-triggers, w3-r5-phone,
  w3-t1-mode-off and w4-fcm-sender), all fixed before the merge; 7 were resolved as not a defect
  and 13 stayed open (twelve findings of the three accepted items and one part of a C.5
  finding), each
  one line in BLOCKERS.md "Open review findings of 2026-10-23".
- The three rebase rounds: the head moved under the open branches, so each was rebased commit
  by commit (never merged with the base) and its conflicts resolved by keeping both sides, each
  resolution listed in the item's review file (w2-s32-indicator was rebased onto 22982fa before
  its merge). Round 1 onto cac6fee (after the late-afternoon merges): w3-c5-specialist-approval,
  w3-d16-slider, w3-e4-recheck, w5-android-high-risk, w3-d4-specialist-settings,
  w3-d7-performance, w3-r2-devices, w3-r5-phone, w3-t1-mode-off, w3-misc-replay-ceiling and
  w2-o1-hotkey. Round 2 onto 4ff4fb1 (after the evening's first five merges):
  w3-d4-specialist-settings, w3-d7-performance, w3-r2-devices, w3-r5-phone, w3-t1-mode-off,
  w3-misc-replay-ceiling and w2-o1-hotkey (w6-android-inbox was built on 4ff4fb1). Round 3 onto
  38ae8cc (after D.4 and R.5): w3-d7-performance, w3-t1-mode-off, w3-misc-replay-ceiling and
  w3-r2-devices; the last two open branches, w3-r2-devices and w2-o1-hotkey, were rebased once
  more onto 95097ae before their merges. Where a rebase met changed code it also reconciled the
  meaning, with tests: D.4's settings composed with D.20's `decideFastMode` and D.16's slider
  (ADR 0072 amendments), the Performance view's effort in force following the slider and the
  D.4 overrides, the specialist approval gate comparing the D.4 keys.
- CI on the merged heads: run 121 on bc10bc8 and run 125 on 422d9c0 green on both OS with the
  dependency audit, gitleaks and the runner image (gates.md phase 0); run 122 on 95097ae failed
  in the dependency audit only, fixed by e4f702f. Android: `android.yml` runs 40000764444 (on
  4ff4fb1) and 40013402240 (on bc10bc8) attach, pair and sign, and fail at the bottom-nav click
  on the API 30 image (BLOCKERS.md "Android emulator smoke").
- Live: the live-model gate ran on the final head 422d9c0 on 2026-10-24 (run
  `2026-10-24T00:19:35.074Z`): 8 test files passed and 1 skipped, 56 live cases passed and 5
  skipped, USD 2.44 over 242 calls under the per-run cap, the call the kill switch cut off
  recorded `aborted`; ledger `tests/live/spend.json` committed in bd32dda (USD 8.49 of 200).
  CI run 125 of the same head (https://github.com/joelwellbournewood/Forerunner/actions/runs/40044376081)
  is green on both OS.
- Status pass (item w7-status-pass, 2026-10-24, `docs/status/reviews/w7-status-pass.md`): the
  merges had left the status documents to this pass. Requirements 203 done, 21 in progress,
  4 todo of 228 (from 183 / 40 / 5 after the morning's merges; B.5, D.20, H.7, J.1, J.9, L.6,
  O.1, O.2, O.4 and P.15 set to `done` on the tests their reviews name); BLOCKERS.md closes 21
  rows with their review file and merge commit and lists the open findings; gates.md, COST.md
  (about USD 230 of Managed Agents sessions and about USD 85 of Claude Code runs on GitHub
  Actions for the day) and CHANGELOG.md (one Unreleased entry per item) follow; the passages
  where a merge kept both sides of a paragraph are merged into one (commands.md, apps.md,
  runtime.md, adding-a-provider.md, this file, BLOCKERS.md).

### 2026-10-23 (fifteen bounded items merged; wave 1 reviewed, its fix stage and waves 2 to 4 stopped at the credit limit; triage; live probe on the new key)
- Base b31c2e5 (the handover of 2026-10-21). Fifteen items were built on `wave/<id>` branches
  and merged (`git log b31c2e5..HEAD --merges`). Wave 1, the handover's item 1: always-human
  approvals spent per call and keyed on the raw input (S.6, S.1, J.8, J.10; ADR 0052); the
  email routes fail closed without an identity port and the log's key-name rule and
  `URL_USERINFO` are fixed (S.4, S.15; ADR 0084); the independent review of B.6 applied (the
  milestone placement, the email task's default tier); an approved plan starts the session it
  was filed for (J.6, J.7; ADR 0053); the Android smoke over raw CDP (ADR 0054). Wave 4, the
  triage's P0s: install identity on a shared store (F.1, U.2, U.3; ADR 0082), private memory
  next to a shared state (G.1, G.3, S.1, S.10; ADR 0083), the signed and verified Android
  release APK (R.1, M.3). Wave 2: PM intake (A.2; ADR 0055), source discovery (A.4; ADR 0056,
  migration 0003), project docs by pull request (G.5; ADR 0058), cross-project promotion (G.6;
  ADR 0059), shared secrets (S.13; ADR 0065, migration 0004), the Settings → Capabilities →
  Email page (S.15, S.28, S.29, T.14; ADR 0066). Wave 3: what you say during a live session
  (O.9; ADR 0078). Requirements 183 done, 40 in progress, 5 todo (from 172 / 48 / 8); the
  Unreleased section of `CHANGELOG.md` carries one entry per item.
- Integration (the commits after the merges; the merge bodies say what was resolved): the
  shared-secrets migration renumbered 0003 → 0004 because the sources item shipped 0003 first
  (the schema test proves v1 + v2 + v3 + v4 equals the generator); the phase-5 gate daemon
  stand-in gained the merged daemon's `RuntimeApp` members; the G.5 scaffold is deferred when
  a project is created with `intake: true`, the intake replaces untouched scaffold
  placeholders, and a session that only filed its plan skips the status write; the ADR index
  rows 0052 to 0084 added centrally (c98eda2). Full check green on e42c730 on the Linux box
  (the paragraph above the criteria table in gates.md: lint, paths, types, 2672 unit tests,
  UI 252, approvals-web 57, live 42, injection 59 of 59, the nine scenarios, docs and secret
  checks, cargo 68); the `integration` project cannot run there (no Postgres).
- Review state: only the five wave-1 items were independently reviewed (w1-approvals accept
  86, w1-email-identity-log accept 88, and-cdp accept 80, w1-b6-review revise 72,
  w1-plan-approval revise 68); the session's credits ran out before the fix stage that
  follows a review. The findings (three high: the project card names a cancelled milestone
  as next; a plan approved by chat or voice starts nothing on a local store; the daemon and
  the cloud trigger can start one approved plan twice; and the medium ones) are fixed on
  `wave/w5-review-findings`, one line per finding in BLOCKERS.md "Open review findings of
  2026-10-23". The other ten items are builder-verified only (their tests, typecheck, docs).
- Credit stops: waves 2b, 3 and 4 were cut mid-wave. Built but not merged (pushed to origin):
  `wave/w2-l6-speak` (3 commits, the builder interrupted before its report, state unknown),
  `wave/w3-b5-reasons` (2 commits, unfinished), `wave/w4-desktop-confirm` (1 commit,
  unfinished, the triage P1). WIP snapshots (uncommitted work saved as a `wip:` commit,
  unreviewed, unverified): `wave/w2-monthly-jobs`, `wave/w2-o1-hotkey`, `wave/w3-a3-import`,
  `wave/w3-o4-voice-prefs`, `wave/w4-metered-aborted`. Not started: w2-chat-memory (J.1,
  O.2), w2-j9-merge (J.9), w2-d20-fastmode (D.20), w2-s32-indicator (S.32), w2-s12-unlock-card
  (S.12), w4-stale-docs, w4-fcm-sender (R.6 service side) and the wave-3 items
  w3-c5-specialist-approval, w3-d4-specialist-settings, w3-d7-performance, w3-d16-slider,
  w3-e1-triggers, w3-e4-recheck, w3-docs-p7-p11, w3-r2-devices, w3-r5-phone, w3-t1-mode-off,
  w3-misc-replay-ceiling; each was named on its requirement row in BLOCKERS.md. All of these
  but w3-a3-import and w3-docs-p7-p11 were built, reviewed and merged later the same day and
  overnight (the entry above). Build cost in COST.md (wave 1 and 2a and the triage agent
  measured, the stopped waves not; the later sessions' spend in "Build spend of 2026-10-23 and
  2026-10-24").
- Live: the human provided a new API key and workspace (`.env.build`,
  `FORERUNNER_LIVE_BUDGET_USD=200`, per-run cap 15 USD unchanged). One probe of the phase 1
  file on it, run `2026-10-23T09:49:08.123Z`: USD 0.1170, ledger USD 6.0479 of 200
  (1b3de7e); 4 of 5 cases passed (3 coder tasks with tier 1 reviews, the chat turn); the kill
  switch stopped the session in 129 ms with the claims released, but the metered provider
  recorded the call aborted mid-flight as `ok` with no usage, so the `aborted` assertion
  failed: a harness classification defect (item w4-metered-aborted, WIP on its branch). The
  key and the subscription token of 2026-10-20 still have to be revoked.
- Triage (criterion 4): `docs/status/reports/triage-2026-10-23.md` (962cb18) classified every
  known issue: 3 P0, 1 P1, 163 P2, 20 stale entries, the rest design notes. The three P0s are
  fixed and merged the same day (install identity, private memory, Android signing); the P1
  (a high-risk confirmation from the desktop app) is partly built on
  `wave/w4-desktop-confirm` and not merged; the 20 stale entries are not yet edited
  (w4-stale-docs not built). Criterion 4 is still not met.
- Android: the raw-CDP attach is merged but `android.yml` was not dispatched, so it has not
  met the hosted emulator; the release APK signing and the apksigner check in the workflows
  are merged and not yet exercised in a run. The phase 5 emulator row stays pending.
- Repository and CI: `joelwellbournewood/Forerunner` is a public repository on GitHub
  (`visibility: public` by the REST API on 2026-10-23), so the secret scan and the
  credentials-only-in-`.env.build` rule matter for every push; `ci.yml` now runs by hand and
  on pushes to `ccr-**` branches (ccf9504), so the release branch has runs again: run 95 on
  962cb18 Linux green, Windows red on one pwsh test timeout
  (fixed by 2f8fbd9); run 97 on a5b8823 green on both OS (before the merges); run 98 on
  1d849c8 (mid-merge) red on the missing ADR index rows (fixed by c98eda2); run 99 on
  c98eda2 red on both OS in the integration step on two Postgres tests the merges left stale
  (`migrations.integration.test.ts` expects `applied [2]`, now `[2, 3, 4]`; the conformance
  "keeps private lessons private" case seeds an `agent_private` row on Postgres, refused since
  ADR 0083); run 100 on e42c730 pending at the time of writing, its Linux job already failed
  on the same step. Nothing was recorded as passed on those runs; 049ed52 fixed the two tests the same day
  (green on both OS, gates.md phase 0).

### 2026-10-21 (security fixes landed, audit export, small-project mode, sign-off follow-up; build stopped at the credit limit)
- Security: the 45 findings pinned by the review's `it.fails` tests are fixed in the state service,
  the store, the commands, the platform log, the runtime hooks, the SDK driver, the tokens, the
  daemon, the vault, the browser, email and Cloudflare; no expected-failure marker remains. The
  independent review of the fixes accepted the daemon/vault and capabilities surfaces (88, 78)
  and sent the state-service (78) and runtime-hooks (70) surfaces back with medium findings
  (listed under "Where to pick up"); their fix stage was interrupted when the credits ran out.
- S.9 audit log export (daemon route, state-service route, `fr audit export`, UI button) built,
  reviewed and accepted (88). The sign-off and session.start undo follow-up built, reviewed,
  fixed and accepted. B.6 small-project mode built with its tests; its independent review did
  not complete before the stop.
- Android: the hosted runner now boots the emulator (52 s) after the disk clean-up and builds,
  installs and launches the debug APK (run 6); the WebView attach failed on a CommonJS import
  shape (fixed in 6542a3f) and then, in run 7, on the WebView refusing Playwright's
  browser-level CDP connection; the raw-CDP attach is the next step ("Where to pick up").
- Requirements 172 done, 48 in progress, 8 todo. Progress report 6 posted to the contact issue.

### 2026-10-20 (requirements close-out, security review, runtime follow-ups; build stopped for budget)
- Requirements close-out over all 22 sections: every in-progress row verified against the code
  and its tests; 170 done, 49 in progress, 9 todo of 228 (from 160 / 57 / 11). Fourteen new
  close-out tests pin the rows that moved. Each remaining gap is a `BLOCKERS.md` row that says
  "missing in code", "partly built" or "docs gap" with the stand-in in use.
- Integrated security review in three surfaces (state service and clients; runtime, vault and
  tokens; capabilities and runners): 17 adversarial test files, 185 tests, 42 of them
  `it.fails` markers that pin an open finding with its attack path and proposed fix in the test.
  The fix stage was stopped for budget after the first surface's fixes started; the markers
  stay until the fixes land.
- Runtime follow-ups from the phase 5 week: an accepted tier 3 sign-off closes the task
  (`syncSignoffAnswers`); the undo of `session.start` stops the started session; registry
  commands reach the model path through the daemon's tools; a UI change names its source;
  the peer rollback wording names the shared state; the answer route writes the decision log.
  Two of three items reviewed and accepted (85, 88); the third's fix was cut off by the stop.
- Android: four dispatches of `android.yml` built the APK and the emulator exited at once for
  lack of disk space on the runner after the Tauri build (the verbose run 4 named it); the
  workflow now frees the disk first. The emulator rows stay pending until a dispatch passes.
- CI green on both OS at runs 84 and 85. Release criteria table filled in `gates.md`: not
  met, no release cut. Progress report 5 posted to the contact issue.

### 2026-10-20 (subscription path live, gate harnesses 5 and 7, daemon capabilities wired)
- Snapshots 692a8fe/6c9919e (per-task billing source and the Agent SDK session path, ADR 0044;
  the live subscription half: three tasks through a real Claude Code subprocess on the
  subscription, plan share recorded; SDK kill ends at the abort), 0057e53 (Android workflow on
  an API 30 test image after the hosted emulator never booted on API 34; desktop workflow green
  on both OS). CI green at run 82. Phase 5 and 7 gate harnesses (ADR 0045, 0046) and the
  runtime-gaps wave (browser and email tools in the daemon with the injection notification, ADR
  0047; a voice bridge and routes, ADR 0048; phone command replay dedupe) in the next snapshot.
- Running: requirements close-out (five section groups), the four runtime defects the phase 5
  harness pinned. Next: the security review wave, Windows and Android scenario rounds, release
  artefacts and criteria.
- The user funds the remaining build with about 320 USD from 19:50 UTC.

### 2026-10-20 (phase 3 gate passes live, nine scenarios, remote commands and sync gate landed)
- Snapshots 984ed45 (live harness, ADR 0040), 612ec33 (remote commands owner filter and PC
  pickup, pause as graceful stop, presence heartbeat, install record and schema sync gate, ADR
  0041), 9ceecb6 (nine scenarios on the fake provider, critic evidence and escalate default per
  ADR 0042, Claude Code tool names per driver per ADR 0043, integer run-row milliseconds, queue
  consume scoped per human, periodic claim renewal); ADR 0010 written. CI green on both OS at
  run 75. Progress report 4 posted.
- Live: phase 1 API-key half passed in full (run 18:58 UTC: 3 of 3 tasks, accept 93 to 95,
  kill 49 ms); phase 3 gate passed on the re-run (40 of 40 caught, 40 of 40 clean accepted,
  USD 2.32); ledger USD 5.86 of 100. Subscription token received; the Agent SDK session path
  and the live subscription half are being built (ADR 0044).
- Requirements 109 done / 106 in progress / 13 todo; milestone rows 25 of 30 passed.

### 2026-10-20 (live model runs, wiring passes, phase 3 and 4 harnesses landed)
- Credits restored (API key with a workspace id for live runs, build credits). Snapshots since
  the last report: voice and sandbox fixes, reviews of model watch, desktop control, data assets
  and sandbox applied, notifications and Cloudflare wired (ADR 0038), adopted model settings,
  desktop control and data assets wired (ADR 0039, c8c709b), workspace-scoped key support in
  setup and the daemon, phase 3 and 4 gate harnesses on the fake provider in CI, cloud runner on
  Hono with the billing router, release workflow signs an update manifest when the key secret is
  present. CI green on both OS at run 67.
- First live model run (ADR 0040, `tests/live`, USD 2.66 of the 100 cap): phase 1 API-key half
  passed (3 PRs, kill switch 28 ms), response-time table measured (Haiku first token median
  687 ms), critic tier 1 timing met (100 reviews, max 13.7 s). Phase 3 live gate failed on the
  pass rate (clean work accepted 37.5%, catch 100%); fix wave running. Bugs found live: fractional
  `ttft_ms` into an integer column (run rows lost), registry `cc:*` tools unmapped on the loop
  driver, queue items never consumed. All in the fix wave.
- Running: remote command owner filter and PC pickup, install record and sync gate, nine
  scenario harnesses (world and scenarios 1, 4, 5 done), live harness review.

### 2026-10-20 (core loop, Android, cloud runner, UI phase 2 landed; credits out again)
- Snapshots 3f9b436 (cloud runner, phase 6 gate rows), 2560623 (core loop closed per ADR 0036,
  Android app per ADR 0032, UI phase 2 pages, notifications, Cloudflare, update and extension
  review fixes) plus CI timing fixes; CI green on both OS at run 54. Progress report 3 posted.
- Requirements 100 done / 111 in progress / 17 todo. Still unwired: notifications, Cloudflare,
  model-watch settings, desktop control, data assets; reviews pending for model watch, desktop
  control, data assets, sandbox; voice fix pass cut off.
- Every wave stopped on the account credit limit a second time at about 15:00 UTC; the
  resumed round used 10.7M sub-agent tokens (COST.md).

### 2026-10-20 (approvals web and desktop shell landed)
- Credits restored; the four cut-off waves resumed with a note to continue from their partial
  files (core loop, UI phase 2, phase 3 and 4 gate harnesses; desktop shell fixes and Android;
  cloud runner and approvals web fixes; notifications, Cloudflare and the update and extension
  critics).
- Snapshot 9f367b3: approvals web (46 tests, ADR 0034), desktop shell (ADR 0031), update CLI
  (`fr update manifest|sign`) and extension cost helpers, ADR 0009/0024 amendments, ADR 0026
  restart code reconciled with the runtime (86). CI gained the UI and approvals-web test step
  and failed once on timing only (daemon test setup on Windows, first SSE event wait on
  Linux); both waits lengthened in the next commit, which also carries the shell and
  approvals fix passes (68 cargo tests with fmt and clippy clean; 49 approvals tests).

### 2026-10-20 (waves 2 and 4a landed)
- Snapshots: email and browser capabilities (8367764); daemon wiring of extensions, updates,
  model watch, estimates, mirror and sandboxes, context savings per ADR 0003, requirement
  statuses 72 done / 128 in progress / 28 todo (42c69b3); critic, memory, commands and the
  state service after tier-2 review (b29605d). CI green on both OS for each.
- Started: desktop shell and Android app (wave 4b), cloud runner and approvals web (wave 4c).
  Injection suite still building; notifications, Cloudflare, desktop control, data assets
  resume next.

### 2026-10-20 (snapshot after the usage-limit stop)
- Every background build wave stopped on an account usage limit at about 02:20 UTC (reset
  05:10 UTC); finished agents were kept, cut-off agents resume with a note to continue from
  their partial files.
- Phase 0 gate complete: fresh install timed on fresh runners (Linux 89 s, Windows 200 s,
  run 39357536106). Phase 2 local gate passed (two agents, five sessions each, no duplicate
  task, no lost commit, every handoff acknowledged); the offline-48-hours half waits for the
  state service sync.
- Snapshot committed: phase-1 UI, shared state service, extensions registry, GitHub Projects
  mirror, sandbox adapters, signed updates, model watch and estimates, sandboxed browser
  (commit 5c031bd). Daemon gained the UI conventions of ADR 0025, the peer feed, the decision
  log; the runner gained message receipts and peer overlap detection.
- Resumed: critic, memory, commands, email, browser, injection suite. Started: wiring of the
  new modules into the daemon and CLI, context-savings leftovers of ADR 0003, requirements
  status pass.

### 2026-10-20 (daemon and waves 2-3)
- Local daemon API (ADR 0011): composition root, Hono server on 127.0.0.1 with a bearer token
  in `daemon.json`, SSE streams, `fr daemon`; smoke-tested end to end with the fake provider.
- Snapshot of finished agent work: specialist registry and eval sets, voice pipeline (ADR 0012),
  testenv mail server and GitHub stand-in. CI green on both OS (run 39355978010).
- Peer activity feed and overlap detection in the session runner; PR executor reports changed
  files for it.
- Waves in flight: phase-1 UI, state service, critic, memory, commands (wave 2); email,
  browser, injection suite (3a); updates, extensions, notifications, Cloudflare (3b); model
  watch and estimates, GitHub Projects mirror, desktop control, data assets (3c).
- Progress report 2 posted to the contact issue.

### 2026-10-20 (later)
- Sessions: startup checklist, state brief, planner, claims, executor, scheduler, state ports.
  Conversation agent (notes, draft tasks, request answers, session control with read-back
  confirmation). Billing wired into the enforcement ports. Capabilities: git host contract,
  GitHub adapter, local git operations, PR task executor with rebase-before-PR and conflict
  escalation, in-memory git host. Phase 1 gate test passes on the fake provider.
- First fully green CI run on Windows and Linux (run 39352102564). Wave 1 snapshot committed
  (state, vault, billing, fake provider, requirements, ADRs).
- Android: SDK 34, NDK 27 and Rust targets installed; `tauri android init` generated the
  project; the debug APK build fails in Gradle (being diagnosed).

### 2026-10-20
- `@forerunner/runtime` core: capability tokens, enforcement hooks (budget, steps, wall clock, kill,
  tool allowlist, paths, domains, autonomy, secrets, injection wrapping, audit), session budget with
  the 80% rule and review reserve, kill switch (40 runs + 3 processes stopped under 2 s in test),
  in-process agent loop, Anthropic Messages adapter, Agent SDK driver, model ladder and retry
  ladder, brief validation, context compression baseline (ADR 0003), setup validators, `fr` CLI
  (setup, status, doctor, kill, dirs) with a cross-process kill file. 100+ unit tests.
- Shared UI scaffold (`apps/ui`), Tauri desktop and Android shells, approvals web skeleton.
  Desktop shell passes `cargo check` on Linux. Android SDK, NDK and Rust targets installed in the
  build box.
- Parallel wave 1 in progress (state, vault, billing, testenv provider/mail/git host, scripts,
  requirements, ADRs 0002/0003); wave 1b in progress (specialist registry and eval sets, voice,
  sandboxes). `docs/requirements.md` written: 228 requirements with IDs A.1–V.9.
- Progress report 1 posted to the contact issue (joelwellbournewood/Forerunner#1).

### 2026-10-19
- Repository created from empty. Monorepo scaffold, `@forerunner/platform` (paths, shell runner,
  simulated clock, redacting logger) with tests. ADR 0001 (stack). Local Postgres 16 and a
  Docker daemon are available in the build container; Tauri Linux system libraries installed.
- Human checklist reviewed: no build budget, no Anthropic API key, no subscription token, no
  Cloudflare token, no mailboxes, no voice keys, no signing certificate, no cloud host were
  provided. All logged in `BLOCKERS.md` with the stand-in in use. GitHub access to
  `joelwellbournewood/Forerunner` exists (push). Work continues with stand-ins.
