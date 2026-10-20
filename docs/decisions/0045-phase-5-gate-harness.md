# 0045 — Phase 5 gate harness: what stands in for the emulator and the audio devices, how the week is driven

Date: 2026-10-20
Status: accepted

## Context

The phase 5 gate of the build order reads: "Simulated users run a full simulated week only
through the UI and the Android emulator, no terminal, answering approvals on the phone. Voice
replies reach first audio in under 1.2 s median on both platforms. Every settings change can
be made by voice, chat or the UI, and each produces the same change log entry. From the
Android app, a simulated user switches project, raises a budget and starts a session on his
PC." The build box has no Android emulator, no audio device and no live model budget for a
week of sessions; the scenario world (`tests/e2e/src/scenario-world.ts`, ADR 0010) runs the
real runner, executor, critic loop, memory loop, command registry, conversation agent, voice
loop, state service and remote watcher on the fake provider with a simulated clock. The spec
leaves open what counts as "through the UI" without a browser, what stands in for the
emulator and the microphone, how long a simulated week takes to run, and which of the
runtime's seams the harness may touch.

## Decision

1. **"Through the UI" is the daemon's own Hono app over the install.** `gate5-daemon.ts`
   builds a `RuntimeApp` from the install's parts (store, clock, tokens, kill switch, hooks,
   driver, providers, registry, scheduler, runner, executor, critic, memory, command loop,
   conversation agent, notifier, event bus, identity) and hands it to `createDaemonApp`
   (`packages/runtime/src/daemon/server.ts`), so the week calls the routes `apps/ui` calls
   with the bodies it sends (`/projects/:id/tasks`, `/inbox`, `/messages/:id/read`,
   `/commands/execute` then `/commands/:id/confirm` as the settings screen does, `/changes`,
   `/changes/:id/undo`, `/chat`, `/kill/resume`). `composeRuntime` binds an install to the
   store's first human (the reason the world assembles its two installs by hand), so this
   is a second hand assembly, one layer up. The fields the week never opens (the Extensions
   panel, updates, the model watch, Cloudflare, desktop control, the Data tab, costs, the
   mirror, the sandbox, the schema sync gate, the vault) are `absent` stand-ins: a route
   that reaches one fails with `unavailable` naming the field. A silent stub would hide a
   gap; a loud one is a failure the next change sees. The React screens themselves are not
   driven (no browser): what enters the daemon is what the screens send after a click.
2. **The emulator is the app's own code plus the state service's routes.** As in scenario 9:
   the sentence enters at the parser the Chat screen calls and the one card comes from the
   app's card builder (`apps/ui/src/mobile`, loaded at run time); the tap is the envelope's
   `confirmedAt`; the inbox is `GET /inbox` and an answer is `POST /requests/:id/answer`
   signed by the phone's device key (`gate5-phone.ts`), with the biometric assertion the
   shell adds after its prompt (`biometric=1` in the signed string and the
   `X-Biometric-Assertion` header) on a high-risk answer; the quick chat is the app's
   `kind: "chat"` envelope relayed to the PC. The Android screens are not driven; the
   emulator half of the gate stays a pending row in gates.md for the final build.
3. **The audio devices are the fake STT and TTS on the simulated clock.** The real
   `VoiceLoop` in push-to-talk mode with `FakeStt` (final transcript 300 ms after the
   release) and `FakeTts` (first chunk 200 ms after the first sentence), microphone frames
   pushed and playback chunks collected through the loop's ports (`scenario-voice.ts`). The
   latency reports are the measurement: the median of `totalToFirstAudioMs` over at least 20
   turns against the 1.2 s anchor. The model stage is the fake provider's zero-latency
   stream, so the fake-provider median proves the loop's accounting and the two fake stages
   at their anchors, not the model; the live first-token numbers of the response-time table
   (D.8) are substituted in gates.md to say where the real-audio run would land. The
   real-audio half on Windows and Linux stays a pending row.
4. **The week is seven simulated days on the clock, every session from a scheduler.** Monday
   2 November 2026 to Sunday 8 November 2026, Europe/Zurich (CET throughout). Alice (J) runs
   daily at 06:00, Bob (M) on weekdays at 05:45, on the installs' `Scheduler`s ticked by
   `advanceTo` in simulated minutes. The schedules are harness configuration
   (`world.schedule`): the daemon has no route for a daily session schedule yet. Each
   morning the humans create the day's task through their UIs (M's on the game project, so
   the two agents never plan the same ready task), the coder is scripted per task and the
   critic accepts (the rules in code still turn Tuesday's tier 3 accept into a sign-off);
   J reads the summary in the UI's inbox at 07:00. The afternoons carry the gate's clauses:
   Tuesday the sign-off answered on the phone, Wednesday the voice turns and the settings
   matrix, Thursday the phone's plan, Friday the phone's quick chat, Saturday a medium card
   answered in the phone's inbox instead of by a yes.
5. **The PC polls every ten simulated seconds during the week.** The daemon's
   `RemoteCommandWatcher` polls every 500 ms; over seven simulated days that is 1.2 million
   polls on an in-memory store and made the first run take a real minute per day. The week
   runs the watcher at 10 s (`WEEK_PC_POLL_MS`), still "within seconds" (spec R.4), and
   scenario 9 keeps the 500 ms proof. After a phone action the harness advances the clock by
   one poll and awaits the drain (`drainPc`), which is what the daemon's tick does.
6. **Three channels, one comparison.** Every settings change is made by voice (the spoken
   sentence through the loop, the spoken yes), by chat (`POST /chat`, a typed yes) and
   through the settings route (`POST /commands/execute` with the values the settings form
   holds, built by the harness from the form's fields, `uiFormParams`: the project, the CHF
   amount, the level, the mode, "tonight" resolved as the app's `endOfTonight`, never from
   what the spoken change resolved to, so the `commands` half of the comparison is real on
   the UI column too; then the tap), each undone through the same channel (the spoken or
   typed "undo", the Changes screen's undo). The change log entries are compared on `commands`
   (names and parameters), `before`, `after`, `scope`, `projectId`, `expiresAt`, `sentence`,
   `humanId` and `agentId`; `source`, `wordsUsed`, ids and timestamps differ by nature.
   High-risk cards (the email mode) are answered on the phone with the biometric on every
   channel; the harness first proves the answer without it is refused (403) and that a
   spoken or typed yes is refused by the registry.
7. **What the harness pins rather than fixes** (findings for the runtime, asserted so the
   fix is seen, and open as follow-up items): the daemon's command route carries no `ui`
   source (`CommandTurn.source` is `text | voice | phone`), so a settings-screen change is
   logged as `chat` (RT-P5-4); on the conversation's model path the hooks hold a high-risk
   command tool (`permission_change` is always-human) and file their own blocking request
   before the registry's device card can form, so the email mode by voice needs two phone
   answers and the chat round finds the first (RT-P5-3); an accepted critic sign-off is not
   applied to its task, which stays `needs_human` (RT-P5-1); the undo of a `session.start`
   whose session has ended still reaches the kill switch and freezes the agent until Resume
   is pressed in the UI (RT-P5-2). The ids are `PHASE5_RUNTIME_FOLLOW_UPS` in
   `gate5-week.ts`, sit on the pinning assertions and end the evidence file; the items in
   testing.md ("Gate harnesses", Known issues) name the runtime test each fixing PR writes
   first and the assertion it inverts, because a pin alone can be lost before the final
   build.

## Consequences

- `tests/e2e/scenarios/phase5-gate.integration.test.ts` runs in the `e2e` vitest project
  on both CI runners with the other scenario files; it needs no Postgres, Docker, emulator,
  audio device or network beyond the loopback interface, and finishes in under a minute.
- `gate5-daemon.ts` mirrors `RuntimeApp`; a field the daemon's routes start to read at
  construction has to be added there (or to the `absent` list), and `tsc` says which.
- The emulator and real-audio halves of the gate are pending rows in gates.md until the
  final build runs the Android scenario and the voice loop on real devices.
- The four findings in item 7 are follow-up items RT-P5-1 to RT-P5-4 in testing.md (Gate
  harnesses, Known issues), each with the runtime test to write first and the assertion
  that pins it; the two stand-ins (the emulator, the audio devices) are rows in
  `docs/status/BLOCKERS.md`.

## Alternatives considered

- **`composeRuntime` over the world's store.** It opens its own store from a URL and binds
  to the store's first human; the week needs two installs on one in-memory store and the
  state service over the same store. Rejected for the same reason the world assembles its
  installs by hand; a `store`/identity seam in `composeRuntime` would let both move to it.
- **Playwright against the built UI.** The scenario package has Playwright, but a browser
  run of seven days with the voice loop and the phone is a final-build matter (release
  criterion 3); the daemon's routes are the contract the UI tests already pin.
- **A fake `RemoteCommandWatcher` or a direct `drain()` without the clock.** Rejected: the
  production watcher on the clock is what the PC runs; only its poll interval is set for the
  week, and the drain after a phone action is the tick's own body.
- **Confirming the medium cards on the phone too.** The gate's third sentence is about the
  channels; a spoken and a typed yes are what voice and chat are. One medium card (Saturday)
  is answered in the phone's inbox to prove that path as well.
- **Skipping the email mode by voice and chat because the hooks hold it.** Rejected: the
  current path (hold, phone answer, ask again, card, phone biometric) is what a user meets
  today; the harness drives it and pins the double approval as a finding instead of
  declaring the clause unmet.
