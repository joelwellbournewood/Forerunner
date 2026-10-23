# 0063 — Read aloud: the speaker, the `summary.speak` command and the voice alert rule

Date: 2026-10-23
Status: accepted

## Context

Spec A.6 wants every project's one-screen summary "readable aloud" and spec L.6 "TTS for
summaries and alerts, STT for voice notes, pluggable provider". Until this ADR the voice
package had `splitSentences` and the provider registry (ADR 0012), the daemon had the voice
loop for conversation turns (ADR 0048), and the UI's "Read aloud" button used the browser's
Web Speech API, which the Linux webview often has no voices for. Nothing read the summary
through the registry's TTS and nothing spoke an alert. The notification module (ADR 0017)
has a fallback chain that stops at the first delivery and a quiet-hours rule that holds
`normal` items and never `urgent` ones. The spec leaves open how a spoken alert relates to
that chain, when speech is appropriate, what a read-aloud leaves in the store, and whether
reading a summary needs a model credential.

## Decision

1. **One speaker in the daemon, no model call.** `SpeakSessions` (`packages/runtime/src/voice/
   speak.ts`) reads a text through the TTS provider the registry's policy picks at that
   moment (the same `pickTts` the voice sessions use), sentence by sentence through
   `splitSentences`, one sentence synthesised ahead of playback as the voice loop does. It
   needs no STT and no model credential: a machine with Kokoro, Piper or a cloud key reads
   its summaries aloud before `fr setup` has a model key. Playback takes the voice loop's
   path: `audio` frames (16-bit PCM, base64, the loop's frame shape) stream to the player on
   `GET /speak/:id/events`; the daemon's sink only paces them on the clock. Playback holds
   until the first stream subscribed or a grace period (1.5 s) passed, because audio frames
   are live only and the player attaches after the request. **One voice**: a new utterance
   cancels the one in flight, and starts are serialised, so of two overlapping requests the
   later always wins and nothing talks over itself. A cancel is immediate and resolves once
   the utterance ended.
1a. **The app window is the player.** The desktop sidecar shows toasts but plays no audio, so
   the UI in the window plays the frames through Web Audio. Where it can, its `/events` stream
   declares `?speech=play`, and the daemon counts those streams (`speechPlayers`). Every
   utterance is announced on `/events` as `speak.started` with `player`. `requester` means
   the Read aloud button that asked follows it itself. `any` means every speech player plays
   it (an alert, `summary.speak` by chat). With no speech player attached, nothing claims to
   have spoken: the voice channel skips and `summary.speak` answers with the text.
2. **The routes read the summaries the screen shows and nothing else.** `POST /projects/:id/
   speak` reads the project's cached one-screen summary (the `spoken` text of
   `GET /projects/:id/summary`, now built once in `@forerunner/commands`
   `spokenProjectSummary` for the view and the command), `POST /sessions/:id/speak` reads a
   session's summary. Another human's project (one whose members do not include this human's
   agent, that is not shared with this human and that this human did not author) or session
   (one whose agent another human owns) is refused as `forbidden`, as the inbox and requests
   are (ADR 0041 item 4). The text is echoed in the view so the screen shows what is read.
3. **What is recorded.** One `voice.speak` row on the human's conversation session per
   utterance (subject, source, state, the text as heard, the unspoken rest, counts, the
   provider; never audio) and one `voice.speak` audit row (counts and the provider; never the
   text). No audio is ever stored by the speaker; `storeAudio` is the voice loop's.
4. **`summary.speak` is a registry command** (spec Q: nothing is UI-only), low risk, no
   confirmation, not reversible ("nothing to undo; stop the playback in the app"), with the
   phrases "read me the summary [of X] [aloud]", "summary", "lies mir die Zusammenfassung
   [von X] vor". Another human's project is refused by the same `ownsProject` rule as the
   route's (it lives in `@forerunner/commands`). By chat or from the UI it speaks through the daemon's `speak` port and its
   sentence echoes the text; in a voice session the sentence *is* the summary, so the loop
   that answers the human speaks it and no second voice starts; without a usable provider the
   text is the reply ("Voice is unavailable (reason). Summary of X: ...") so the request
   always answers. The change log row carries whether it was spoken and by which path.
5. **The voice channel announces; it never replaces a delivery.** `VoiceChannel` is an
   *announcing* channel (`Channel.announce`): the notifier runs it after the fallback chain,
   for `urgent` records only, on top of whatever the chain delivered (the toast stays: speech
   carries no link and vanishes). It never ends the chain and is listed last in
   `CHANNEL_NAMES`, so the chain's order of ADR 0017 is unchanged and a `voice` entry in a
   per-kind list or in `notify_channel` is ignored by the chain. It speaks only when the
   human turned voice alerts on (`notify_prefs.voice_alerts`, the `voice_alerts` setting), a
   speech player holds the event stream (point 1a: someone is at the machine and the window
   can play it), no voice conversation is open (it would talk over it) and it is **not quiet
   hours**. The urgency rule of ADR 0017 lets an urgent toast through the night, but a voice
   in a sleeping room is what quiet hours exist for. Otherwise the delivery row says why
   (`skipped`: "quiet hours", "no app window open to play speech", "a voice conversation is
   open"). Voice alerts off leaves no row at all, like a channel that is not wired. A test
   send speaks its test. Only an utterance that ended `done` is a delivery. One cut short by
   a newer one is `unavailable`. A provider failure is `failed`, and it is retried only while
   nothing was heard, because a retry repeats the whole alert. A per-kind list that names
   only `voice` gets the default chain, so the toast is never lost to it.
6. **Never a secret.** The spoken text is the title and body, which producers already
   redact. The channel asserts it: a text that changes under the platform's `redact` is
   refused (`unavailable`, "credential shape; not spoken"), not retried, and neither the
   text nor the match reaches the log, the delivery row or the audit row.

## Consequences

- "Read aloud" in the UI calls the daemon and plays the frames in the webview (Web Audio).
  The browser's own speech is the fallback only when the daemon answers 503, so a Linux
  webview without voices no longer disables the button.
- A `speak.started` frame on `/events` names every utterance, and the window's speech player
  plays those meant for any player. Audio playback by the native sidecar (with the window
  closed) remains the open item of `voice.md`. Until it lands, voice alerts are heard only
  while the app window is open, and a browser that blocks autoplay stays silent until it is
  clicked.
- Humans who enable voice alerts hear `budget_stop`, `request_blocking`, `kill_switch` and
  `injection_flagged` by day while the app window is open, with the toast still on screen.
  At night, or with the window closed, they get the toast only. Changing which kinds are spoken is a change to `KIND_URGENCY`
  (ADR 0017), not to the channel.
- Every spoken alert is two audit rows (`notify.desktop` or whichever channel delivered, and
  `notify.voice`) plus the speaker's `voice.speak` rows.

## Alternatives considered

- Voice as the first step of the fallback chain: the first delivery ends the chain, so a
  spoken alert would replace the toast and its link; a human away from the desk for a minute
  would miss the alert entirely. Rejected.
- Voice wrapping the desktop channel (toast plus speech as one delivery): one row for two
  things, a retry of a failed synthesis would re-toast, and the audit would not say which
  part worked. Rejected for two independent rows.
- Speaking every urgent alert whatever the hour, as the toast goes through: the point of
  quiet hours; rejected.
- Reading summaries through the voice loop (a synthetic "read me the summary" turn): needs
  a model credential and a conversation session, and the loop's barge-in and approval rules
  make no sense for a monologue. The speaker shares the loop's pipeline shape instead.
- Keeping the Web Speech button only: no provider choice, no audio on Linux webviews, and
  nothing recorded; kept only as the 503 fallback.
