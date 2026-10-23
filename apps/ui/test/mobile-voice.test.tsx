import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fromBase64 } from "../src/api/state-signing.ts";
import {
  encodeTurn,
  type RecordedTurn,
  type Speaker,
  toRelayPcm,
  VOICE_RELAY_MAX_MS,
  type VoiceRecorder,
} from "../src/mobile/voice.ts";
import { createMobileHarness, postedCalls, renderMobile } from "./mobile-helpers.tsx";

/**
 * Push-to-talk on the Chat screen (spec R.5, O; ADR 0080). The recorder stands in for the
 * WebView's microphone (what `webRecorder` captures through getUserMedia), the speaker for
 * speech synthesis. A held button records, the release relays the turn to the PC as one
 * signed remote command of kind `voice` carrying 16 kHz PCM; the PC's reply is shown and
 * spoken. Without a recorder (the Android shell today) or with the microphone refused, the
 * typed line is relayed as the voice turn. A PC without voice fails visibly.
 */
function tone(ms: number): Int16Array {
  const n = Math.round((ms / 1000) * 16_000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin(i / 5) * 8000);
  return pcm;
}

function fakeRecorder(pcm: Int16Array, opts: { refuse?: boolean } = {}) {
  const log: string[] = [];
  const recorder: VoiceRecorder = {
    kind: "fake",
    async start() {
      log.push("start");
      if (opts.refuse) throw new Error("NotAllowedError: permission denied");
    },
    async stop(): Promise<RecordedTurn> {
      log.push("stop");
      return { pcm, sampleRate: 16_000, durationMs: Math.round((pcm.length / 16_000) * 1000) };
    },
    cancel() {
      log.push("cancel");
    },
  };
  return { recorder, log };
}

/** The params of the first remote command the phone posted. */
function sentParams(h: Parameters<typeof postedCalls>[0]): Record<string, unknown> {
  const call = postedCalls(h, "/remote/commands")[0];
  if (!call) throw new Error("nothing posted");
  return (call.body as { params: Record<string, unknown> }).params;
}

function fakeSpeaker() {
  const spoken: string[] = [];
  const speaker: Speaker = {
    speak: (t) => {
      spoken.push(t);
    },
    stop: () => {},
  };
  return { speaker, spoken };
}

describe("push-to-talk relayed to the PC", () => {
  it("records while held, relays the audio on release and speaks the PC's reply", async () => {
    const pcm = tone(250);
    const { recorder, log } = fakeRecorder(pcm);
    const { speaker, spoken } = fakeSpeaker();
    const h = await createMobileHarness({ env: { recorder, speaker } });
    renderMobile("/chat", h);
    await screen.findByRole("heading", { name: "Chat" });
    const ptt = await screen.findByTestId("m-ptt");
    expect(ptt).toHaveTextContent("Hold to talk");
    expect(screen.getByTestId("m-voice-mode")).toHaveTextContent("up to 5 s");

    fireEvent.pointerDown(ptt);
    await waitFor(() => expect(ptt).toHaveTextContent("Release to send"));
    expect(ptt).toHaveAttribute("aria-pressed", "true");
    expect(postedCalls(h, "/remote/commands")).toHaveLength(0);
    fireEvent.pointerUp(ptt);

    await waitFor(() => expect(postedCalls(h, "/remote/commands")).toHaveLength(1));
    expect(log).toEqual(["start", "stop"]);
    const [call] = postedCalls(h, "/remote/commands");
    expect(call).toMatchObject({
      signed: true,
      body: {
        target: "pc",
        command: "start",
        params: {
          v: 1,
          kind: "voice",
          projectId: "proj_pharma",
          audio: { sampleRate: 16_000, channels: 1, durationMs: 250 },
        },
      },
    });
    const params = sentParams(h);
    expect(params.transcript).toBeUndefined();
    expect(typeof params.clientId).toBe("string");
    // The bytes are the recording, 16-bit little-endian.
    const bytes = fromBase64((params.audio as { pcm: string }).pcm);
    expect(bytes.byteLength).toBe(pcm.length * 2);
    expect(new DataView(bytes.buffer).getInt16(2, true)).toBe(pcm[1]);

    const reply = "PC voice: you said (8000 bytes of audio).";
    await waitFor(() => expect(screen.getByTestId("m-chat-reply")).toHaveTextContent(reply), {
      timeout: 4000,
    });
    expect(screen.getByTestId("m-chat-reply")).toHaveAttribute("data-status", "done");
    // The bubble shows what the PC heard, and the reply was spoken once.
    await waitFor(() => expect(spoken).toEqual([reply]));
    expect(screen.getByTestId("m-chat-you")).toHaveTextContent("(8000 bytes of audio)");
    // The PC dropped the audio from the shared row once the turn ran.
    expect(h.service.state.remoteCommands[0]?.params.audio).toMatchObject({ dropped: true });
  });

  it("releases a press at the relay's limit and sends at most that much audio", async () => {
    const { recorder, log } = fakeRecorder(tone(7_000));
    const h = await createMobileHarness({ env: { recorder, speaker: null } });
    renderMobile("/chat", h);
    const ptt = await screen.findByTestId("m-ptt");
    fireEvent.pointerDown(ptt);
    // Never released by the human: the screen releases it at the limit.
    await waitFor(() => expect(postedCalls(h, "/remote/commands")).toHaveLength(1), {
      timeout: VOICE_RELAY_MAX_MS + 3000,
    });
    expect(log).toEqual(["start", "stop"]);
    const audio = sentParams(h).audio as { pcm: string; durationMs: number };
    expect(audio.durationMs).toBe(VOICE_RELAY_MAX_MS);
    expect(fromBase64(audio.pcm).byteLength).toBe((16_000 * 2 * VOICE_RELAY_MAX_MS) / 1000);
    expect(screen.getByTestId("m-chat-you")).toHaveTextContent("Voice turn (5.0 s)");
  }, 15_000);

  it("relays the typed line as the voice turn where the page cannot record", async () => {
    const { speaker, spoken } = fakeSpeaker();
    const h = await createMobileHarness({ env: { recorder: null, speaker } });
    const user = userEvent.setup();
    renderMobile("/chat", h);
    await screen.findByRole("heading", { name: "Chat" });
    expect(screen.queryByTestId("m-ptt")).toBeNull();
    expect(screen.getByTestId("m-voice-mode")).toHaveTextContent("No microphone here");
    const say = screen.getByTestId("m-ptt-typed");
    expect(say).toBeDisabled();
    await user.type(screen.getByTestId("m-chat-input"), "What is the status?");
    await user.click(say);
    await waitFor(() =>
      expect(postedCalls(h, "/remote/commands")[0]).toMatchObject({
        signed: true,
        body: {
          params: {
            v: 1,
            kind: "voice",
            transcript: "What is the status?",
            projectId: "proj_pharma",
          },
        },
      }),
    );
    const params = sentParams(h);
    expect(params).not.toHaveProperty("audio");
    const reply = "PC voice: you said What is the status?.";
    await waitFor(() => expect(spoken).toEqual([reply]), { timeout: 4000 });
    expect(screen.getByTestId("m-chat-reply")).toHaveTextContent(reply);
  });

  it("falls back to the typed line when the microphone is refused", async () => {
    const { recorder, log } = fakeRecorder(tone(100), { refuse: true });
    const h = await createMobileHarness({ env: { recorder, speaker: null } });
    renderMobile("/chat", h);
    fireEvent.pointerDown(await screen.findByTestId("m-ptt"));
    expect(await screen.findByTestId("m-chat-error")).toHaveTextContent(
      "The microphone is not available here",
    );
    expect(log).toEqual(["start"]);
    expect(screen.queryByTestId("m-ptt")).toBeNull();
    expect(screen.getByTestId("m-ptt-typed")).toBeInTheDocument();
    expect(postedCalls(h, "/remote/commands")).toHaveLength(0);
  });

  it("says so when the PC has no voice, and speaks nothing", async () => {
    const { speaker, spoken } = fakeSpeaker();
    const h = await createMobileHarness({
      env: { recorder: null, speaker },
      fake: { voiceUnavailable: true },
    });
    const user = userEvent.setup();
    renderMobile("/chat", h);
    await user.type(await screen.findByTestId("m-chat-input"), "hello");
    await user.click(screen.getByTestId("m-ptt-typed"));
    expect(
      await screen.findByTestId("m-chat-error", undefined, { timeout: 4000 }),
    ).toHaveTextContent("Your PC could not take the voice turn: voice is not available on this PC");
    expect(spoken).toEqual([]);
  });

  it("converts captured float audio to 16 kHz PCM and caps a turn's envelope", () => {
    const at48k = new Float32Array(48_000).fill(0.5);
    const pcm = toRelayPcm(at48k, 48_000);
    expect(pcm.length).toBe(16_000);
    expect(pcm[100]).toBe(Math.round(0.5 * 0x7fff));
    const env = encodeTurn({ pcm: tone(6_000), sampleRate: 16_000, durationMs: 6_000 });
    expect(env).toMatchObject({ sampleRate: 16_000, channels: 1, durationMs: VOICE_RELAY_MAX_MS });
  });
});
