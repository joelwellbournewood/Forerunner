# 0080 — The phone contributes: uploads, PR and critic review, push-to-talk relayed to the PC

Date: 2026-10-23
Status: accepted

## Context

Spec R.5: "Contribute: chat and voice with your agent (module O). Natural-language control
(module Q). Add notes, tasks and ideas. Upload photos, files and documents to a project.
Review PRs and critic findings, comment, approve or reject. Answer human requests." Quick
chat, natural-language control, notes and answering requests were built and tested on the
phone; the state service had the upload route (`POST /projects/:id/uploads`, multipart, a
size cap, the file under the service's data directory) and the review routes (`GET /reviews`,
`/reviews/:id/comment`, `/reviews/:id/approve|reject`). The phone had no upload screen, no
review screen, and a text-only Chat (`docs/status/BLOCKERS.md`, row R.5).

Open points:

- How a file picked offline survives until the phone reconnects, given that the action
  outbox (`POST /sync/outbox`) is JSON with a 256 KiB body cap and a resend after a lost
  answer must not store a second copy.
- What the Android shell offers for picking files: no picker command, no share target.
- Which rule a review verdict follows when it answers a high-risk approval.
- How a voice turn on the phone reaches module O's loop, which runs on the PC (ADR 0048),
  and what the phone does when it cannot record.

## Decision

1. **Uploads: signed multipart, idempotent by `clientId`, a separate queue.** The phone
   builds the multipart body itself (`multipartBody` in `apps/ui/src/api/state-client.ts`)
   so the bytes it signs are the bytes it sends (the device signature covers the body's
   SHA-256, ADR 0009). Every upload carries a fresh `clientId` form field; the service keeps
   it in the asset's `sample` and answers a second upload under the same id from the same
   human with the asset it already made (200), never a second file. 8 to 100 letters, digits
   or dashes; anything else is 400. A file picked while the service is unreachable goes to
   `UploadQueue` (`apps/ui/src/mobile/uploads.ts`), not the action outbox: it is flushed
   first on reconnect, file by file to the same route, a 4xx drops it with a notice, a
   transport failure keeps it. The queue persists to browser storage up to 2 MiB in total
   and holds larger files in memory (lost if the app closes, and the screen says it is
   queued, not saved). The list route also returns `maxBytes`, so the phone shows the cap
   before the human picks a file and refuses a larger one before a byte leaves.
2. **The picker is the web file input.** One input for any file and one for a photo
   (`accept="image/*" capture="environment"`, which the Android WebView opens as the
   camera). The shell has no file-picker or share-target command; adding one is a follow-up
   that hands bytes to the same `MobileController.uploadFile`. Progress is shown by phase
   (reading, sending, uploaded or queued): `fetch` has no upload progress events.
3. **Reviews: the verdict answers the task's approval at the version the phone saw, and a
   high-risk one needs the biometric flag in the signature.** The Reviews screen lists the
   project's reviews with the PR and every finding. Approve / Reject send the comment as the
   body and the open approval request's version (`requestVersion`, from the inbox); when that
   request is high risk the phone runs the biometric prompt first and only its assertion puts
   `biometric=1` into the signed string, the same rule as a high-risk answer in the inbox
   (ADR 0032 item 3, ADR 0045 item 2), and the service enforces it through `answerRequestAs`
   (`confirm:high`). Verdicts and comments are not queued offline: a verdict answers a
   versioned request (a stale one is a 409) and a high-risk one needs a live signature.
4. **Voice: one push-to-talk turn = one remote command of kind `voice`, run by the PC's
   voice sessions.** The phone records one turn (hold to talk, release to send) as 16 kHz
   mono 16-bit PCM and sends `{ v: 1, kind: "voice", projectId, clientId, audio: { pcm,
   sampleRate, channels, durationMs } }` through `POST /remote/commands`, the path quick chat
   takes (the approvals web relays chat the same way, ADR 0034). The PC's
   `RemoteCommandWatcher` hands the envelope to `VoiceRelay` (`packages/runtime/src/voice/
   relay.ts`), which runs it through the `VoiceSessions` behind the daemon's `/voice` routes:
   press, the recording as 20 ms frames, release, exactly as a shell would call
   `/voice/sessions/:id/press|audio`. The result carries the transcript (`said`) and the
   reply the PC's TTS spoke (`reply`); the phone shows both and speaks the reply with its
   own speech synthesis (the PC's audio does not travel back). One relay session is held
   per phone between turns so a spoken "yes" answers the card the previous turn read back;
   it is stopped after five idle minutes.
5. **A turn is at most 5 s of audio.** 5 s at 16 kHz is 160,000 bytes, about 213 KB in
   base64, which keeps the envelope under the service's 256 KiB JSON body cap with room for
   the rest. The phone releases a longer press for the human at 5 s and trims what it sends;
   the PC refuses a longer recording as a malformed envelope, checking the duration from the
   bytes, the rate and the channels (one 20 ms frame of slack) as well as the byte bound, so
   8 kHz audio cannot carry 10 s and a higher rate or a second channel fits fewer seconds. Longer turns are a follow-up
   (several commands per turn, or the audio as an upload the PC reads).
6. **Without a recorder, the typed line is the voice turn.** Where the page cannot record,
   the Chat screen's button is "Say it" and the envelope carries `transcript` instead of
   `audio`; the PC runs it through the same loop's text fallback (`/voice/sessions/:id/text`),
   so the read-back rules and the spoken reply are the same. The Android shell has no
   microphone command, so in the shell the recorder is absent and the typed line is used;
   a browser on the phone (`/m`) records through `getUserMedia` and an `AudioContext`
   (MediaRecorder gives compressed audio the PC's loop does not read). A refused microphone
   switches the screen to the typed line.
7. **No audio stays in the shared store, and a stale turn never runs.** The remote command
   row is the only place the recording passes through the service. Whatever happens to a
   `kind: "voice"` row the PC picked up (the turn ran or failed, the envelope was malformed,
   a replay, a device the PC refuses, a stale turn), the PC replaces the envelope's `audio`
   with `{ dropped: true, sampleRate, channels, bytes, durationMs }` before it records the
   result. A turn older than two minutes (`VOICE_RELAY_MAX_AGE_MS`) when the PC picks it up
   is refused as expired and never run: the phone has stopped waiting for its reply, and a
   spoken "yes" or "stop it" must not act hours later because the PC was offline. The audit
   row names the command, device and clientId, never the audio or the transcript.
   (Amended in the review of 2026-10-23: the drop used to happen only when the turn reached
   the voice port.)

## Consequences

- R.5 is built on the phone and the PC; the Android emulator run of the new screens is
  still open (BLOCKERS.md), so R.5 stays `in progress` until it ran.
- A voice turn from the phone is as slow as one PC poll (500 ms) plus the turn itself; the
  phone's reply arrives through the command's status, like quick chat.
- The service's upload route changed (the `clientId` field, `maxBytes` in the list); old
  phones that send no `clientId` keep the old behaviour.
- The audio sits in the shared store between the phone's post and the PC's pick-up: seconds
  while the PC is online, as long as the PC is off otherwise (it is dropped, unplayed, when
  the PC comes back). A service operator with database access could read it in that window.

## Alternatives considered

- **Uploads through `POST /sync/outbox` as base64.** Refused: the 256 KiB JSON cap, and the
  outbox's actions are small state changes, not files.
- **MediaRecorder (Opus/WebM) on the phone.** Refused: the PC's loop takes PCM and has no
  decoder; PCM keeps the phone's side and the PC's identical to the `/voice` routes.
- **Speech-to-text on the phone.** Refused: the providers, keys and latency accounting live
  on the PC (ADR 0012, ADR 0048); the phone would need its own credentials.
- **A new state-service route for voice.** Not needed: the remote command path already
  carries signed, idempotent, per-human commands the PC picks up, and the service does not
  have to understand the envelope.
- **A fresh voice session per turn.** Simpler, but a spoken "yes" would not answer the card
  the last turn read back.
