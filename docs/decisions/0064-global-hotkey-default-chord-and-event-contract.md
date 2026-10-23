# 0064 — Global hotkey: the default chord, where it is kept and the event contract

Date: 2026-10-23
Status: accepted

## Context

Spec O.1: "Talk to your agent at any time, by text or voice: in the app, from a global hotkey,
or from the phone approvals page." Text chat, the daemon's `/voice` routes and the phone's
quick chat existed; no shell registered a global hotkey (`docs/status/BLOCKERS.md`). The
desktop shell (`apps/desktop/src-tauri`) talked to the UI only through the injected
`window.__FORERUNNER__` and `eval` of small scripts (deep links); it exposed no IPC command.
Open points: which chord by default, where the chosen chord lives, how the shell and the UI
agree on what a valid chord is, what a press means for a push-to-talk turn, and how the shell
tells the UI about a press and about a chord the OS refuses.

## Decision

1. **Default chord `CommandOrControl+Shift+Space`** (Ctrl+Shift+Space on Windows and Linux).
   Space is the push-to-talk key people expect; Ctrl+Shift+Space is not bound by Windows or
   by the GNOME and KDE defaults (Ctrl+Space and Super+Space switch input sources there,
   Alt+Space opens the window menu), and it is easy to press with one hand.
2. **The chord is a per-install shell preference in `<config>/hotkey.json`** (`{ "chord" }`),
   not a daemon setting. The shell must register before the UI loads and while the daemon is
   down (the shell lives in the tray without it); the daemon's settings are per human and
   follow the human to other machines, where the chord may be taken. The window state lives
   beside it for the same reason (ADR 0031). Consequently a chord change is not a command of
   the registry and writes no change log row: it changes no agent behaviour.
3. **One grammar, two implementations, one case file.** `hotkey.rs::parse_chord` (the shell
   validates before it registers) and `apps/ui/src/shell/hotkey.ts::parseChord` (Settings
   validates before it asks) both run every case of `apps/ui/test/hotkey-chords.json` with the
   same canonical form or the same reason code. The grammar is a strict subset of what
   tauri-plugin-global-shortcut parses (a Rust test feeds every canonical chord to the
   plugin's parser), so `hotkey_set` can fail only at the OS. A chord needs a modifier other
   than Shift unless its key is F1–F24: a bare letter or Shift+letter would swallow typing in
   every other application. `CommandOrControl` may not be combined with Control or Super (it
   means one of them).
4. **A press toggles the voice turn; the release is ignored.** The first press shows and
   focuses the window, opens the conversation panel and starts a push-to-talk turn (session in
   `push_to_talk` mode, `press { pressed: true }`, microphone chunks); the next press (or the
   panel's Send) ends it (`press { pressed: false }`). Hold-to-talk on a global chord is
   unreliable: X11 auto-repeat produces press/release pairs while held, and the human may
   release the modifiers before the key. Without voice (no provider or model credential, a 503,
   a denied microphone) the panel says why and focuses the text input (`/chat/stream`).
5. **The event contract.** The shell emits to the main window only:
   `forerunner://hotkey` with `{ chord, state: "pressed" }` after `show_main`, and
   `forerunner://hotkey-changed` with `{ chord, defaultChord, registered, error }` after a
   change or a failed registration. The UI calls `hotkey_status` and `hotkey_set { chord }`
   (same status object; a refusal rejects with the shell's message). The two commands are
   declared in `build.rs`'s app manifest, so they need a permission, granted to the main
   window only (`capabilities/hotkey.json`); the plugin's own JS commands are granted to no
   window. A failed registration (chord taken; on Linux no X display) is logged, kept for
   Settings and emitted, never a crash. A change registers the new chord before releasing the
   old one, so a refused chord leaves the working one in place; another spelling of the hotkey
   the OS already holds for us (same plugin id, e.g. `Control+Shift+Space` for the default on
   Windows and Linux) is adopted and saved without a second registration.
6. **The shell answers the main window's microphone request.** The conversation panel records
   with `getUserMedia({ audio })`. WebKitGTK denies a permission request nobody handles, so
   without a handler the hotkey could never start a voice turn on Linux, and WebView2 would
   prompt on top of the press. The main window allows the microphone for its own pages only
   (the page it loaded last is on an app origin), denies it elsewhere, denies the camera and
   leaves every other kind to the webview (`media.rs`). The UI opens the microphone only on a
   press or a Talk click and closes it at the end of the turn or when the panel closes,
   including a turn that was still starting.

## Consequences

- O.1's hotkey half is in code: the shell part is unit-tested in `hotkey.rs` (grammar, state
  machine, file, payloads), the UI part in `apps/ui/test/hotkey.test.tsx`. The plugin calls and
  the window focus are exercised only by a real desktop run.
- The UI now has a voice control (the conversation panel) using the daemon's `/voice` routes;
  it shows a turn's reply as text and does not play the TTS audio frames yet.
- The microphone needs no webview prompt in the desktop app; the OS's own microphone privacy
  settings (Windows) still apply.
- Two installs on one machine (different `FORERUNNER_HOME`) each try to register their chord;
  the second gets "not registered" and can pick another chord.
- A pure Wayland session without XWayland has no hotkey (reported as such); a desktop-portal
  registration would be the next step.

## Alternatives considered

- **A `hotkey` key in the daemon's settings (`settings.set`)**: rejected for the reasons in 2;
  it would also make the shell depend on a reachable daemon to register at all.
- **The UI's browser storage**: the shell cannot read it before the window exists.
- **`eval` of a script into the window instead of events and commands**: works for a press but
  gives Settings no way to ask for a change and get an answer; IPC with explicit permissions is
  narrower than an eval channel.
- **Hold-to-talk (press starts, release sends)**: see 4; the panel's Send and a second press
  give the same control without depending on release events.
- **Leave the microphone to the webview's default**: denied outright on Linux (WebKitGTK), a
  prompt per window on Windows; the hotkey's voice turn would not work on Linux.
- **Allow every permission kind for the main window**: wider than the UI needs; only the
  microphone is used.
- **Alt+Space or Ctrl+Space as the default**: taken by the window menu and by input-source
  switching on common desktops.
