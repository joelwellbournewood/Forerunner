# Runbook: finishing release 1.0 from a session on the human's PC

Written 2026-10-25 for a Claude Code session running on the human's own computer (Remote
Control or the desktop app) in a checkout of `ccr-af5a431d-jc9xqj` at c38dcd6 or later. It
orders the work that the cloud build of 2026-10-25 could not do because it needed the human's
accounts, keys or devices. `docs/status/PROGRESS.md` "Where to pick up" is the authoritative
list; this file is the operational order for it. Read `AGENTS.md` first.

Rules that apply to every step: secrets go into the git-ignored `.env.build` at the repository
root or into GitHub repository secrets, never into a commit, a log, a status file or a chat
message that is not needed; `pnpm secrets:scan` and `pnpm secrets:scan --logs` before every
push; nothing is marked passed in `docs/status/gates.md` without command, date, result and
link; a requirement row moves to `done` only with its test; every push keeps CI green; the
`v1.0.0` tag is pushed only when the human has said so in words.

## 1. Keys and tokens (first, because every live step needs them)

1. In the Anthropic Console, logged in by the human: create a new user-scoped API key in the
   project's workspace with a monthly spend cap (USD 50 is enough for everything below), and
   note the workspace id. Write them into `.env.build` under the names `tests/live/src/env.ts`
   reads (`FORERUNNER_ANTHROPIC_KEY`, `FORERUNNER_ANTHROPIC_WORKSPACE_ID`). Then revoke the two
   earlier keys named in `docs/status/BLOCKERS.md` (2026-10-20 and 2026-10-23).
2. Run `claude setup-token` and write the token into `.env.build` as
   `FORERUNNER_SUBSCRIPTION_TOKEN`; revoke the token of 2026-10-20.
3. A key or token read through a browser or a terminal is in this session's transcript. Keep
   the spend cap and rotate both again after the release; say so in BLOCKERS.md's key rows.

## 2. Live runs on the final build (criteria 2 and 6, V.6, V.8, D.20)

Commands and caps are in `docs/maintainers/testing.md` "Live tests" and `tests/live/README.md`.
Keep `FORERUNNER_LIVE_RUN_CAP_USD=15` and `FORERUNNER_LIVE_BUDGET_USD=200` (the ledger
`tests/live/spend.json` holds USD 8.49).

1. `pnpm --filter @forerunner/live test:live` on the current head: the phase 1 half, the
   timing file and the phase 3 calibration. Commit the ledger.
2. `live-4-subscription.live.test.ts` with the new token.
3. One fast-mode call (D.20, ADR 0057): confirm the API accepts the fast setting and the price
   the billing table assumes; record it in COST.md.
4. The monthly handover on Forerunner's own repository: `fr jobs handover <project> --force`
   with a project that points at this checkout (V.8).
5. The timings still unmeasured: D.8 (first audio, needs step 6), D.13 (a researcher run) and
   D.15 (tier 2 and 3 critic reviews). Copy every per-mode figure of the timing run into the
   response-time table in gates.md.
6. Record: COST.md live ledger paragraph; gates.md phase 1 "first token" row, phase 8 "live
   model" and "every earlier gate re-run" rows, criterion 6; requirements D.8 to D.15 and V.6
   to `done`; the BLOCKERS rows closed.

## 3. GitHub repository secrets for `release.yml` (criterion 5's tagged run, R.1)

With `gh auth login` done by the human, set each from a file or stdin, never from an argument:

1. Android: `keytool -genkeypair` as `docs/maintainers/release.md` shows, then
   `ANDROID_KEYSTORE_BASE64` (base64 of the `.jks`), `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEYSTORE_ALIAS`. Keep the keystore file outside the repository; losing it means a
   new signer for every later release.
2. Tauri updater: `pnpm tauri signer generate` for `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; put the public key into `plugins.updater.pubkey` of
   `apps/desktop/src-tauri/tauri.conf.json` (release.md "Update signatures").
3. `UPDATE_SIGNING_KEY` for the signed update manifest (release.md says how the manifest is
   signed and verified; generate the key pair the same way the tests do).
4. Windows Authenticode: `WINDOWS_CERTIFICATE` (a PFX, base64) and
   `WINDOWS_CERTIFICATE_PASSWORD`; a self-signed certificate is acceptable for 1.0 if the
   human has no code-signing certificate, and the release notes must say so.
5. `ANTHROPIC_API_KEY` only if `release.yml`'s steps need it (read the workflow); otherwise
   leave it unset.
6. Cut a pre-release tag `v1.0.0-rc.1` to exercise `release.yml` end to end (every platform
   builds, signs and publishes) before the real tag. Fix whatever fails, on this branch.

## 4. Firebase for Android push (R.6, K.8)

1. In the Firebase console, logged in by the human: a project, the Android app
   `app.forerunner.mobile`, its `google-services.json`, and a service account with the FCM
   HTTP v1 send role; the service-account JSON goes into the vault by reference, never into
   the repository (ADR 0085 names the secret and the state-service side that is already built).
2. Build the Android half (ADR 0085 point 9: `firebase-messaging`, the token registration, the
   four notification kinds), with a failing test first, the maintainer doc (`apps.md`), an ADR
   amendment and an independent review before the merge. Then R.6 and K.8 to `done`.

## 5. A real mailbox and host (phase 6 live halves, L.3, S.12)

1. A mailbox dedicated to the agent (IMAP and SMTP, an app password); configure it through the
   Settings → Capabilities → Email page so the mode change goes through its high-risk card.
2. Run the phase 6 live halves against it: the emailed task acknowledged within a minute and
   completed, the spoofed email refused; the cloud runner on a second machine (or this PC
   acting as the host) for the overnight session and for S.12's unlock from the desktop and the
   phone. Record the gates.md phase 6 rows and move L.3 and S.12.

## 6. Real audio (phase 5 real-audio row, D.8)

Run the voice loop in push-to-talk mode with the local providers on this PC's microphone and
speakers (`docs/maintainers/voice.md`), ten turns, and record the first-audio median and p90.
The gate asks for Windows and Linux; a Linux machine with audio is needed for the second half
(WSL has no audio device). If none exists, record the Windows half and leave the Linux half
pending; the release decision on criterion 2 is the human's.

## 7. Android on a real device or the local emulator (R.1)

`node apps/mobile/e2e/run.mjs` against the signed release APK of the `v1.0.0-rc.1` release on
the local emulator (Android Studio) or a phone with USB debugging, then an update through the
release feed. Record R.1's row with the output lines.

## 8. The release

1. Status pass: requirements rows to `done`, BLOCKERS rows closed, gates.md rows and the nine
   criteria (they may read `passed` only when every requirement is done; `pnpm gates:verify`
   enforces it), PROGRESS.md entry, COST.md, CHANGELOG `[1.0.0]` with the P2 list from
   `docs/status/reports/triage-2026-10-25.md` "Release notes: known issues".
2. CI green on the head; `pnpm check`; `pnpm gates:verify` clean.
3. With the human's explicit yes: tag `v1.0.0`, watch `release.yml`, record its run in gates.md
   phase 0 and criteria 3 and 5, and the final tag's CI run; then rotate the keys of step 1.
