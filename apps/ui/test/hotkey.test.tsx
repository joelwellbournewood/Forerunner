import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../src/routes.tsx";
import { buildCommands } from "../src/shell/commands.ts";
import {
  DEFAULT_CHORD,
  formatChord,
  type HotkeyBridge,
  HotkeyContext,
  type HotkeyPress,
  type HotkeyStatus,
  hotkeyBridgeFor,
  parseChord,
} from "../src/shell/hotkey.ts";
import {
  type CapturedChunk,
  type CaptureFactory,
  floatToPcmBase64,
  type MicCapture,
  VoiceCaptureContext,
} from "../src/shell/voice-capture.ts";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, type Harness, postedCalls, renderApp } from "./helpers.tsx";
import cases from "./hotkey-chords.json";
import { createMobileHarness, renderMobile } from "./mobile-helpers.tsx";

/** A desktop shell stand-in: records `set`, emits presses and status changes on demand. */
function fakeBridge(initial: Partial<HotkeyStatus> = {}) {
  let status: HotkeyStatus = {
    chord: DEFAULT_CHORD,
    defaultChord: DEFAULT_CHORD,
    registered: true,
    error: null,
    ...initial,
  };
  const pressListeners = new Set<(p: HotkeyPress) => void>();
  const changeListeners = new Set<(s: HotkeyStatus) => void>();
  const sets: string[] = [];
  let refuseWith: string | null = null;
  const bridge: HotkeyBridge = {
    available: true,
    unavailableReason: null,
    status: () => Promise.resolve(status),
    set: (chord) => {
      sets.push(chord);
      if (refuseWith) return Promise.reject(new Error(refuseWith));
      status = { ...status, chord, registered: true, error: null };
      return Promise.resolve(status);
    },
    onPress: (cb) => {
      pressListeners.add(cb);
      return () => pressListeners.delete(cb);
    },
    onChanged: (cb) => {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
  };
  return {
    bridge,
    sets,
    refuse(message: string | null) {
      refuseWith = message;
    },
    press(state: HotkeyPress["state"] = "pressed") {
      act(() => {
        for (const cb of pressListeners) cb({ chord: status.chord, state });
      });
    },
    change(next: Partial<HotkeyStatus>) {
      status = { ...status, ...next };
      act(() => {
        for (const cb of changeListeners) cb(status);
      });
    },
    listeners: () => pressListeners.size,
  };
}

/** A microphone stand-in: start hands out a chunk at once, stop is recorded. */
function fakeCapture() {
  const log: string[] = [];
  const factory: CaptureFactory = (): MicCapture => ({
    async start(onChunk: (c: CapturedChunk) => void) {
      log.push("start");
      onChunk({
        pcm: floatToPcmBase64(new Float32Array([0, 0.5, -0.5])),
        sampleRate: 16000,
        channels: 1,
        timestampMs: 0,
      });
      onChunk({
        pcm: floatToPcmBase64(new Float32Array([0.25])),
        sampleRate: 16000,
        channels: 1,
        timestampMs: 0.19,
      });
    },
    stop() {
      log.push("stop");
    },
  });
  return { factory, log };
}

function renderDesktop(
  route: string,
  bridge: HotkeyBridge,
  capture: CaptureFactory,
  harness: Harness = createHarness(),
) {
  const utils = render(
    <HotkeyContext.Provider value={bridge}>
      <VoiceCaptureContext.Provider value={capture}>
        <AppProvider client={harness.client} store={harness.store}>
          <MemoryRouter initialEntries={[route]}>
            <AppRoutes />
          </MemoryRouter>
        </AppProvider>
      </VoiceCaptureContext.Provider>
    </HotkeyContext.Provider>,
  );
  return { ...utils, ...harness };
}

describe("hotkey chord grammar (shared with the desktop shell)", () => {
  it("uses the shared default", () => {
    expect(cases.default).toBe(DEFAULT_CHORD);
    expect(parseChord(DEFAULT_CHORD)).toMatchObject({ ok: true, canonical: DEFAULT_CHORD });
  });

  it("accepts every shared case with the shell's canonical form", () => {
    for (const c of cases.accepted) {
      const r = parseChord(c.input);
      expect(r, c.input).toMatchObject({ ok: true, canonical: c.canonical });
      expect(parseChord(c.canonical), c.canonical).toMatchObject({ canonical: c.canonical });
    }
  });

  it("refuses every shared case for the shell's reason, with its message", () => {
    for (const c of cases.refused) {
      const r = parseChord(c.input);
      expect(r.ok, c.input).toBe(false);
      if (!r.ok) {
        expect(r.reason, c.input).toBe(c.reason);
        expect(r.message.length).toBeGreaterThan(0);
      }
    }
    const fn = parseChord("Ctrl+Fn");
    expect(fn.ok ? null : fn.message).toBe('"Fn" is not a key or modifier this shell knows');
    // Object prototype names are not modifiers.
    expect(parseChord("constructor+A")).toMatchObject({ ok: false, reason: "unknown-token" });
  });

  it("formats the chord for the platform", () => {
    expect(formatChord(DEFAULT_CHORD, "linux")).toBe("Ctrl+Shift+Space");
    expect(formatChord(DEFAULT_CHORD, "windows")).toBe("Ctrl+Shift+Space");
    expect(formatChord("Alt+Super+1", "windows")).toBe("Alt+Win+1");
    expect(formatChord("Alt+Super+1", "linux")).toBe("Alt+Super+1");
    expect(formatChord(DEFAULT_CHORD, "macos")).toBe("Cmd+Shift+Space");
  });

  it("is available only inside the desktop shell", () => {
    expect(hotkeyBridgeFor({ platform: "linux" }, true).available).toBe(true);
    expect(hotkeyBridgeFor({ platform: "windows" }, true).available).toBe(true);
    const browser = hotkeyBridgeFor({ platform: null }, false);
    expect(browser.available).toBe(false);
    expect(browser.unavailableReason).toMatch(/desktop app/);
    const android = hotkeyBridgeFor({ platform: "android" }, true);
    expect(android.available).toBe(false);
    expect(android.unavailableReason).toMatch(/android/);
  });
});

describe("the palette's talk entry", () => {
  it("is listed with the hotkey as its hint when the shell provides the action", () => {
    const harness = createHarness();
    const run = vi.fn();
    const base = {
      state: harness.store.getState(),
      navigate: () => {},
      setActiveProject: () => {},
      setTheme: () => {},
      toggleKill: () => {},
      openNewProject: () => {},
      openShortcuts: () => {},
    };
    expect(buildCommands(base).some((c) => c.id === "action.talk")).toBe(false);
    const talk = buildCommands({
      ...base,
      openConversation: run,
      hotkeyLabel: "Ctrl+Shift+Space",
    }).find((c) => c.id === "action.talk");
    expect(talk?.hint).toBe("Ctrl+Shift+Space");
    talk?.run();
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("Settings: global hotkey", () => {
  it("says unavailable in a browser", async () => {
    renderApp("/settings");
    const field = await screen.findByTestId("hotkey-unavailable");
    expect(field.textContent).toMatch(/^unavailable/);
    expect(field.textContent).toMatch(/desktop app/);
    expect(screen.queryByTestId("hotkey-input")).toBeNull();
  });

  it("says unavailable on the Android app's Settings screen, with the chat as the way to talk", async () => {
    const h = await createMobileHarness();
    renderMobile("/settings", h);
    await screen.findByRole("heading", { name: "Settings" });
    const row = screen.getByTestId("m-hotkey");
    expect(within(row).getByText("unavailable")).toBeInTheDocument();
    expect(row.textContent).toMatch(/desktop-app feature/);
    expect(row.textContent).toMatch(/Chat/);
  });

  it("shows the current chord, validates with the shell's grammar and sends the canonical chord", async () => {
    const user = userEvent.setup();
    const shell = fakeBridge();
    const harness = createHarness();
    renderDesktop("/settings", shell.bridge, fakeCapture().factory, harness);
    const current = await screen.findByTestId("hotkey-current");
    expect(current.textContent).toContain("Ctrl+Shift+Space");
    expect(within(current).getByTestId("hotkey-registered").textContent).toBe("active");

    const input = screen.getByTestId("hotkey-input");
    await user.clear(input);
    await user.type(input, "Shift+A");
    expect(screen.getByTestId("hotkey-invalid").textContent).toMatch(/needs a modifier/);
    expect(screen.getByTestId("hotkey-apply")).toBeDisabled();

    await user.clear(input);
    await user.type(input, "ctrl+alt+t");
    expect(screen.queryByTestId("hotkey-invalid")).toBeNull();
    expect(screen.getByTestId("hotkey-preview").textContent).toBe("Will register Ctrl+Alt+T");
    await user.click(screen.getByTestId("hotkey-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("hotkey-saved").textContent).toBe("Saved: Ctrl+Alt+T"),
    );
    expect(shell.sets).toEqual(["Control+Alt+T"]);
    expect(screen.getByTestId("hotkey-current").textContent).toContain("Ctrl+Alt+T");

    // Reset goes back to the default chord.
    await user.click(screen.getByTestId("hotkey-reset"));
    await waitFor(() => expect(shell.sets).toEqual(["Control+Alt+T", DEFAULT_CHORD]));
  });

  it("shows the shell's refusal and a registration failure reported as an event", async () => {
    const user = userEvent.setup();
    const shell = fakeBridge();
    renderDesktop("/settings", shell.bridge, fakeCapture().factory);
    await screen.findByTestId("hotkey-current");
    shell.refuse("Control+Alt+Delete could not be registered: HotKey already registered");
    const input = screen.getByTestId("hotkey-input");
    await user.clear(input);
    await user.type(input, "Ctrl+Alt+Delete");
    await user.click(screen.getByTestId("hotkey-apply"));
    expect(await screen.findByText(/HotKey already registered/)).toBeInTheDocument();
    expect(screen.queryByTestId("hotkey-saved")).toBeNull();

    shell.change({ registered: false, error: "HotKey already registered" });
    await waitFor(() =>
      expect(screen.getByTestId("hotkey-registered").textContent).toBe("not registered"),
    );
    expect(screen.getByTestId("hotkey-error").textContent).toBe("HotKey already registered");
  });
});

describe("hotkey press: the conversation and a push-to-talk turn", () => {
  it("opens the conversation, starts a voice turn on the first press and sends it on the second", async () => {
    const shell = fakeBridge();
    const mic = fakeCapture();
    const harness = createHarness();
    harness.daemon.state.nextVoiceLine = "what is next on atlas";
    renderDesktop("/", shell.bridge, mic.factory, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    expect(screen.queryByTestId("conversation")).toBeNull();

    shell.press();
    expect(await screen.findByTestId("conversation")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    expect(mic.log).toEqual(["start"]);
    const started = postedCalls(harness, "/voice/sessions");
    expect(started).toHaveLength(1);
    expect(started[0]?.body).toMatchObject({ mode: "push_to_talk" });
    const session = [...harness.daemon.state.voiceSessions.keys()][0] ?? "";
    expect(postedCalls(harness, `/voice/sessions/${session}/press`).map((c) => c.body)).toEqual([
      { pressed: true },
    ]);
    await waitFor(() =>
      expect(postedCalls(harness, `/voice/sessions/${session}/audio`)).toHaveLength(2),
    );
    expect(postedCalls(harness, `/voice/sessions/${session}/audio`)[0]?.body).toMatchObject({
      sampleRate: 16000,
      channels: 1,
    });

    // A release of the chord does nothing (a press toggles; ADR 0064).
    shell.press("released");
    expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/);

    shell.press();
    await waitFor(() =>
      expect(screen.getByTestId("conversation-human").textContent).toContain(
        "what is next on atlas",
      ),
    );
    expect(mic.log).toEqual(["start", "stop"]);
    expect(postedCalls(harness, `/voice/sessions/${session}/press`).map((c) => c.body)).toEqual([
      { pressed: true },
      { pressed: false },
    ]);
    const agent = screen.getByTestId("conversation-agent");
    expect(agent.textContent).toContain('you asked "what is next on atlas"');
    expect(agent.dataset.via).toBe("voice");
    expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Press Ctrl\+Shift\+Space/);

    // A third press starts the next turn in the same voice session.
    shell.press();
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    expect(postedCalls(harness, "/voice/sessions")).toHaveLength(1);
  });

  it("focuses the text input when voice is unavailable, and the text goes to the same agent", async () => {
    const user = userEvent.setup();
    const shell = fakeBridge();
    const mic = fakeCapture();
    const harness = createHarness({
      voice: { available: false, reason: "no speech-to-text provider is configured" },
    });
    renderDesktop("/", shell.bridge, mic.factory, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    // The chat needs the identity (/me, /agents) the bootstrap loads.
    await waitFor(() => expect(harness.store.getState().me).not.toBeNull());

    shell.press();
    const reason = await screen.findByTestId("voice-reason");
    expect(reason.textContent).toContain("no speech-to-text provider is configured");
    expect(screen.getByTestId("voice-phase").textContent).toBe("Voice unavailable");
    await waitFor(() => expect(screen.getByTestId("conversation-input")).toHaveFocus());
    expect(mic.log).toEqual([]);
    expect(postedCalls(harness, "/voice/sessions")).toHaveLength(0);

    await user.type(screen.getByTestId("conversation-input"), "status please{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("conversation-agent").textContent).toContain(
        'you asked "status please"',
      ),
    );
    expect(screen.getByTestId("conversation-agent").dataset.via).toBe("text");
  });

  it("falls back to typing when the window cannot capture audio", async () => {
    const shell = fakeBridge();
    const harness = createHarness();
    renderDesktop("/", shell.bridge, () => null, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    shell.press();
    expect((await screen.findByTestId("voice-reason")).textContent).toMatch(/cannot capture audio/);
    await waitFor(() => expect(screen.getByTestId("conversation-input")).toHaveFocus());
    expect(postedCalls(harness, "/voice/sessions")).toHaveLength(0);
  });

  it("closing the conversation stops the capture and the voice session", async () => {
    const user = userEvent.setup();
    const shell = fakeBridge();
    const mic = fakeCapture();
    const harness = createHarness();
    renderDesktop("/", shell.bridge, mic.factory, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    shell.press();
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    const session = [...harness.daemon.state.voiceSessions.keys()][0] ?? "";
    await user.click(
      within(screen.getByTestId("conversation")).getByRole("button", { name: "Close" }),
    );
    await waitFor(() =>
      expect(postedCalls(harness, `/voice/sessions/${session}/stop`)).toHaveLength(1),
    );
    expect(mic.log).toEqual(["start", "stop"]);
    expect(screen.queryByTestId("conversation")).toBeNull();
  });

  it("unmounting the shell stops the capture and the voice session", async () => {
    const shell = fakeBridge();
    const mic = fakeCapture();
    const harness = createHarness();
    const { unmount } = renderDesktop("/", shell.bridge, mic.factory, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    shell.press();
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    const session = [...harness.daemon.state.voiceSessions.keys()][0] ?? "";
    unmount();
    await waitFor(() =>
      expect(postedCalls(harness, `/voice/sessions/${session}/stop`)).toHaveLength(1),
    );
    expect(mic.log).toEqual(["start", "stop"]);
  });

  it("closing while the microphone is still starting turns it off and ends the session", async () => {
    const user = userEvent.setup();
    const shell = fakeBridge();
    const log: string[] = [];
    let grant: () => void = () => {};
    // The microphone prompt is still open when the human closes the panel.
    const factory: CaptureFactory = () => ({
      start: () => {
        log.push("start");
        return new Promise<void>((resolve) => {
          grant = resolve;
        });
      },
      stop: () => {
        log.push("stop");
      },
    });
    const harness = createHarness();
    renderDesktop("/", shell.bridge, factory, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    shell.press();
    await waitFor(() => expect(log).toEqual(["start"]));
    const session = [...harness.daemon.state.voiceSessions.keys()][0] ?? "";
    await user.click(
      within(screen.getByTestId("conversation")).getByRole("button", { name: "Close" }),
    );
    await act(async () => {
      grant();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(log).toEqual(["start", "stop"]);
    expect(postedCalls(harness, `/voice/sessions/${session}/stop`)).toHaveLength(1);
    expect(harness.daemon.state.voiceSessions.get(session)?.view.endedAt).not.toBeNull();
    expect(screen.queryByTestId("conversation")).toBeNull();
  });

  it("closing before the session exists ends the session that starts afterwards", async () => {
    const user = userEvent.setup();
    const shell = fakeBridge();
    const mic = fakeCapture();
    const harness = createHarness();
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = harness.client.startVoiceSession;
    harness.client.startVoiceSession = async (body) => {
      await gate;
      return original(body);
    };
    renderDesktop("/", shell.bridge, mic.factory, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    shell.press();
    await screen.findByTestId("conversation");
    await user.click(
      within(screen.getByTestId("conversation")).getByRole("button", { name: "Close" }),
    );
    await act(async () => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const sessions = [...harness.daemon.state.voiceSessions.values()];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.view.endedAt).not.toBeNull();
    expect(mic.log).toEqual([]);
    expect(postedCalls(harness, `/voice/sessions/${sessions[0]?.view.id}/press`)).toHaveLength(0);
  });

  it("the release waits until every captured chunk reached the daemon, in order", async () => {
    const shell = fakeBridge();
    let emit: (chunk: CapturedChunk) => void = () => {};
    const factory: CaptureFactory = () => ({
      start: async (onChunk) => {
        emit = onChunk;
      },
      stop: () => {},
    });
    const harness = createHarness();
    const calls: string[] = [];
    const audio = harness.client.voiceAudio;
    let delay = 60;
    harness.client.voiceAudio = async (id, chunk) => {
      // Earlier chunks take longer: parallel posts would arrive out of order.
      const wait = delay;
      delay -= 20;
      await new Promise((resolve) => setTimeout(resolve, wait));
      calls.push(`audio@${chunk.timestampMs}`);
      return audio(id, chunk);
    };
    const press = harness.client.voicePress;
    harness.client.voicePress = async (id, pressed) => {
      calls.push(`press:${pressed}`);
      return press(id, pressed);
    };
    renderDesktop("/", shell.bridge, factory, harness);
    await waitFor(() => expect(shell.listeners()).toBe(1));
    shell.press();
    await waitFor(() =>
      expect(screen.getByTestId("voice-phase").textContent).toMatch(/^Listening/),
    );
    const pcm = floatToPcmBase64(new Float32Array([0.1, 0.2]));
    for (const timestampMs of [0, 85, 170]) {
      emit({ pcm, sampleRate: 48000, channels: 1, timestampMs });
    }
    shell.press();
    await waitFor(() => expect(screen.getByTestId("conversation-human")).toBeInTheDocument());
    expect(calls).toEqual(["press:true", "audio@0", "audio@85", "audio@170", "press:false"]);
    const session = [...harness.daemon.state.voiceSessions.values()][0];
    expect(session?.view.lastTurn?.audioChunks).toBe(3);
  });

  it("encodes captured samples as 16-bit little-endian PCM", () => {
    const b64 = floatToPcmBase64(new Float32Array([0, 1, -1]));
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
  });
});
