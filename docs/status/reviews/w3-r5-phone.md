# w3-r5-phone — R.5 on the phone: uploads, PR and critic review, voice relayed to the PC

## Build report

Item `w3-r5-phone`, stage BUILD, branch `wave/w3-r5-phone`. Starting commit `34bfcdb` (the
`wip:` snapshot of an earlier attempt, on top of base `82a6295`; the named base
`ccr-4d8a843c-1k9syk` is at `e2bfb1e` and was not merged in). ADR 0080
(`docs/decisions/0080-phone-uploads-reviews-and-voice-relay.md`). Requirements: R.5 (with R.3
for the offline upload queue, R.4's remote command path for voice, O for the voice loop).

### What the earlier attempt left

The `wip:` commit 34bfcdb changed `services/state-api/src/routes/projects.ts` (an upload's
`clientId` form field makes it idempotent per human; `GET /projects/:id/uploads` returns
`maxBytes`) with a test in `routes.test.ts`. I read it, ran it (20 of 20 in
`routes.test.ts`), kept it unchanged and built on it; its documentation is in this series
(`state-service.md`, ADR 0080).

### What was built

- **Upload screen** (`apps/ui/src/mobile/screens/UploadScreen.tsx`, nav "Upload"): pick a
  file (web file input) or take a photo (`accept="image/*" capture="environment"`), rename
  it, choose the project and the kind (photo / document / file, guessed from the type). The
  service's cap is shown before a file is picked and checked before a byte leaves. The file
  goes to `POST /projects/:id/uploads` as signed multipart with a fresh `clientId`
  (`StateClient.upload`, `multipartBody`: the bytes signed are the bytes sent). Progress is
  shown by phase (reading, sending, uploaded or queued). Offline, the file goes to
  `UploadQueue` (`apps/ui/src/mobile/uploads.ts`); the header counts it with the queued
  actions, and `flushOutbox` resends it under the same `clientId` on reconnect, so a lost
  answer never makes a second copy. The project's uploads are listed below the form.
- **Reviews screen** (`apps/ui/src/mobile/screens/ReviewsScreen.tsx`, nav "Reviews"): the
  project's critic reviews (`GET /reviews?projectId=`) with task, PR link, verdict, grade,
  tier, summary and every finding (severity, status, required action). The open approval on
  the review's task is shown as "waiting on you". Comment (`/reviews/:id/comment`), Approve
  and Reject (`/reviews/:id/approve|reject { body, requestVersion }`) answer that request at
  the version the phone saw. When the request is high risk, the biometric prompt runs first
  and the flag is signed in (ADR 0045 / ADR 0032 rule); a cancelled prompt sends nothing.
- **Push-to-talk on Chat** (`ChatScreen.tsx`, `apps/ui/src/mobile/voice.ts`): hold to talk
  (pointer or Space / Enter held), release to send. The recording is 16 kHz mono 16-bit PCM,
  at most 5 s; the screen releases a longer press itself. It is sent as one signed
  `POST /remote/commands` with `{ v: 1, kind: "voice", projectId, clientId, audio }`. The
  PC's transcript replaces the "Voice turn (n s)" bubble, and its reply is shown and spoken
  (`Speaker`, speech synthesis). When the page cannot record (the Android shell, which has no
  microphone command; or a refused microphone), the button is "Say it" and the typed line is
  relayed as `transcript`. A PC without voice is reported. `envFromGlobals` gives the browser
  a `webRecorder` (getUserMedia + AudioContext → 16 kHz PCM) and `webSpeaker`.
- **The PC side** (`packages/runtime/src/voice/relay.ts`, `src/remote/watcher.ts`,
  `src/daemon/compose.ts`): `VoiceEnvelope` (audio or transcript, exactly one; at most 5 s)
  in the `RemoteCommandWatcher`, which hands it to `VoiceRelay.turn`. That runs it through the
  daemon's `VoiceSessions` (the loop behind `/voice`): press, 20 ms frames, release; or the
  text fallback. One session is held per phone between turns, so a spoken "yes" answers the
  last read-back; it is stopped after 5 idle minutes and on close. A turn that does not end
  within 60 s fails with `timeout`. The result carries `said`, `reply`, `pending` and
  `approved`. Once the turn ran (or failed), the audio is dropped from the shared row
  (`{ dropped: true, ... }`). Replays are refused like plan and chat.
- **Fake state service** (`apps/ui/test/fake-state-service.ts`): the upload routes (cap,
  `clientId` idempotency, `maxBytes`), the review routes (comment, approve / reject that
  answer the task's approval, `biometric_required` for a high-risk one without the flag) and
  a simulated PC that answers voice turns (or fails them with `voiceUnavailable`).
- **Docs**: ADR 0080 plus its index row; `apps.md` (Android app: purpose, layout, the new
  "Uploads, reviews and voice" section, how to change, tests, known issues, with the stale
  "PC does not consume plan/chat" bullet corrected); `runtime.md` (the phone's push-to-talk,
  tests); `state-service.md` (the upload route's `clientId` and `maxBytes`, the voice envelope
  under the body cap, tests); `docs/requirements.md` R.5 (tests added; status stays
  `in progress`); `docs/status/BLOCKERS.md` R.5 row (built, emulator run open);
  `docs/status/PROGRESS.md` (log entry, handover item); `CHANGELOG.md` (Unreleased → Added).

### Tests that prove it

| File | What it proves | Count |
| --- | --- | --- |
| `apps/ui/test/mobile-upload.test.tsx` | Upload is in the nav. The cap is shown. A renamed PDF is signed as multipart to the chosen project, with its bytes, name, kind and `clientId` stored and listed. A camera photo is sent as kind photo. A file over the cap is refused before anything is posted (screen and controller). Offline, the file is queued ("1 queued"); after a lost answer and a resend it is stored exactly once. | 4 |
| `apps/ui/test/mobile-reviews.test.tsx` | Reviews is in the nav. It lists the project's reviews with the PR link and the findings, shows the waiting approval and switches project. A comment is posted signed. Approve with a comment answers the task's request at version 1. A high-risk Reject opens the prompt: cancel posts nothing, confirm posts with `biometric: true` and answers the request. The service refuses a high-risk verdict without the flag. | 5 |
| `apps/ui/test/mobile-voice.test.tsx` | Hold records and release relays signed 16 kHz PCM (bytes checked) as `kind: "voice"`. The transcript and the reply are shown, the reply is spoken once, and the audio is dropped from the row. A press is released at 5 s with exactly 160,000 bytes sent. Without a recorder, the typed line goes as `transcript`. A refused microphone switches to the typed line. A PC without voice is reported and nothing is spoken. Float to 16 kHz conversion and the envelope cap. | 6 |
| `packages/runtime/test/voice-relay.test.ts` | Watcher: audio reaches the voice port, the reply lands in the result, and the audio leaves the row (12,800 bytes recorded). A typed line becomes the transcript. Both, neither or an oversized envelope fail as malformed. A PC without voice fails `unavailable`. 20 ms framing. `VoiceRelay` on the composed runtime with fake STT / TTS: an audio turn is transcribed and answered. A typed line reuses the phone's session. A read-back is confirmed by a spoken "yes" in the next turn (`approved: true`). A second phone gets its own session. Invalid input is refused, and `close()` stops the sessions. | 7 |
| `services/state-api/test/remote.test.ts` (new case) | A 5 s voice envelope is accepted under the 256 KiB JSON body cap; twice that is 413. | 1 new (8 in file) |
| `services/state-api/test/routes.test.ts` (from the snapshot) | Upload with `clientId` applied once (200 on the resend, one file on disk), `maxBytes` in the list, a malformed `clientId` 400. | 1 (20 in file) |

Each new test fails without its behaviour: the screens, routes, envelope kind and relay do
not exist on the starting commit.

### Commands run and results (2026-10-23, Linux box)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 (59 warnings in the repository, none in the files of this series: `biome check` on the 18 changed TS/TSX files is clean) |
| `pnpm --filter @forerunner/ui test` | 45 test files, 267 tests passed |
| `pnpm exec vitest run --project unit packages/runtime/test` | 115 files passed; 991 tests passed, 1 skipped |
| `pnpm exec vitest run --project unit services/state-api/test` | 10 files, 133 tests passed |
| `pnpm exec vitest run --project integration packages/runtime/test services/state-api/test` | 2 files, 7 tests skipped (no Postgres, no container engine; skipped with their reasons) |
| `pnpm exec vitest run --project e2e tests/e2e/scenarios/09-phone.scenario.test.ts tests/e2e/scenarios/03-voice.scenario.test.ts` | 2 files; 2 passed, 1 todo |
| `pnpm exec vitest run --project e2e tests/e2e/scenarios/phase5-gate.integration.test.ts` | 1 file, 4 tests passed |
| `pnpm exec vitest run --project unit scripts/closeout-docs.test.ts` | 19 passed, 1 todo |
| `node scripts/docs-check.mjs --base 34bfcdb` | `docs-check: ok (28 files)` |
| `node scripts/link-check.mjs` | `link-check: ok (106 files)` |
| `pnpm check` | exit 0: lint, lint:paths (993 files), typecheck, unit tests (270 files; 2682 passed, 4 skipped, 1 todo), docs:check, docs:links, secret scan (clean, 1417 files). Its `docs:check` step diffs against `origin/main`, which this checkout lacks, so it skipped itself; the run against the starting commit is the line above. |

### Command output (excerpts, 2026-10-23)

`pnpm typecheck` (exit 0):

```
> forerunner@0.1.0 typecheck /workspace/repo
> tsc -p tsconfig.node.json --noEmit && pnpm -r --filter "./apps/*" --if-present typecheck
Scope: 4 of 21 workspace projects
apps/mobile typecheck: Done
apps/desktop typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
```

`pnpm lint` (`biome check .`, exit 0; the 59 warnings are in files this series does not touch):

```
Checked 1167 files in 2s. No fixes applied.
Found 59 warnings.
```

`pnpm exec biome check <the 18 TS/TSX files changed since 34bfcdb>`:

```
Checked 18 files in 101ms. No fixes applied.
```

`node scripts/docs-check.mjs --base 34bfcdb`:

```
docs-check: ok (28 files).
```

### Export and apply check

The patch is the series from the starting commit, verified on a clean worktree of that
commit:

```
$ git format-patch --stdout 34bfcdb..HEAD > /mnt/session/outputs/w3-r5-phone.patch
$ git worktree add /tmp/clean 34bfcdb
$ cd /tmp/clean && git apply --check /mnt/session/outputs/w3-r5-phone.patch && echo APPLY_OK
APPLY_OK
$ git worktree remove --force /tmp/clean
```

`git log --oneline 34bfcdb..HEAD` lists exactly the four commits of this series (runtime,
ui, docs, status), each ending with the trailer
`Claude-Build: managed-agent w3-r5-phone build`. The check was run on the final export,
after this report was committed.

### What is left open and why

- **The Android emulator run** of Upload, Reviews and push-to-talk. The build box has no
  Android SDK or emulator. The brief's order is "then the emulator run; then R.5 `done`",
  so R.5 stays `in progress`, and the BLOCKERS.md row says what the run must cover.
- **Audio from the Android shell.** The shell has no microphone command, and the WebView's
  `RECORD_AUDIO` permission request is not wired, so in the shell push-to-talk relays the
  typed line (ADR 0080 item 6). In a browser, `/m` records. The follow-up is in `apps.md`
  ("How to change it").
- **Native picker / share target.** The shell has neither; the web file and camera inputs
  are the stand-in.
- **Byte-level upload progress.** `fetch` has no upload progress events, so progress is
  shown by phase.
- **Queued uploads over 2 MiB in total** are held in memory and lost if the app closes
  before reconnecting. The screen and the docs say so.
- **The PC's spoken audio** does not travel back; the phone speaks the reply text with its
  own speech synthesis.
- **Turns longer than 5 s** are released at 5 s (the JSON body cap; ADR 0080 item 5).
