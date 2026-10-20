import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SESSION_OVERRIDE_KEY } from "@forerunner/commands";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAEMON_ROUTES,
  VoiceAnswerView,
  VoiceEventView,
  VoiceSessionView,
  VoiceStatusView,
  VoiceTurnView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { VOICE_APPROVAL_AUDIT_TOOL, VOICE_SESSION_AUDIT_TOOL } from "../src/voice/bridge.ts";
import {
  type AudioChunk,
  DeepgramStt,
  FakeStt,
  type FakeSttScript,
  FakeTts,
  VoiceProviderRegistry,
} from "../src/voice/pkg.ts";
import { VOICE_SECRET_REFS } from "../src/voice/providers.ts";
import { encodePcm } from "../src/voice/views.ts";

/**
 * The daemon's voice routes (spec O, Q.4; ADR 0048) on the composed runtime with the voice
 * package's fake providers and the fake model provider, every delay on the simulated clock:
 * a text turn runs through the loop and lands as a reply event and a `voice.turn` row; a
 * risky command is read back and needs the yes, a wrong answer does nothing and a yes (or a
 * tap) applies it through the registry; first-audio latency is measured per stage; voice
 * reports unavailable with the reason when no provider pair is configured.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const jsonList = async (r: Response): Promise<Json[]> => (await r.json()) as Json[];
const STATUS_REPLY = "The session on PharmaWatch completed. One pull request is open.";
const STEP_MS = 50;
const FRAME_MS = 20;

/** Let every pending microtask and I/O callback run (the store's queries, the provider). */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Step the simulated clock until `p` settles (the loop's STT, model and TTS delays run on it). */
async function drive<T>(clock: SimulatedClock, p: Promise<T> | T, limitMs = 60_000): Promise<T> {
  let done = false;
  const tracked = Promise.resolve(p).then(
    (v) => {
      done = true;
      return v;
    },
    (e: unknown) => {
      done = true;
      throw e;
    },
  );
  let spent = 0;
  while (!done && spent < limitMs) {
    await settle(24);
    await clock.advance(STEP_MS);
    spent += STEP_MS;
  }
  return tracked;
}

/** A tone the fake STT accepts as speech, in 20 ms frames at 16 kHz. */
function speechFrames(ms: number): AudioChunk[] {
  const rate = 16000;
  const perFrame = Math.round((FRAME_MS / 1000) * rate);
  const frames: AudioChunk[] = [];
  for (let start = 0; start < Math.round((ms / 1000) * rate); start += perFrame) {
    const pcm = new Int16Array(perFrame);
    for (let i = 0; i < perFrame; i++) {
      pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * (start + i)) / rate) * 12000);
    }
    frames.push({ pcm, sampleRate: rate, channels: 1, timestampMs: (start / rate) * 1000 });
  }
  return frames;
}

describe("voice routes on the composed daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  let sessionId = "";
  let conversationSessionId = "";
  const clock = new SimulatedClock("2026-11-03T08:00:00Z");
  const scripts: FakeSttScript[] = [];
  const stt = new FakeStt({
    clock,
    scripts: (turn) => scripts[turn] ?? { final: "" },
    finalDelayMs: 300,
  });
  const tts = new FakeTts({ clock, firstChunkLatencyMs: 200, chunkMs: 100, chunks: 2 });
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    req(path, { method: "POST", body: JSON.stringify(body) });
  const events = async (id: string, afterSeq = 0) =>
    (await jsonList(await req(`/voice/sessions/${id}/events?afterSeq=${afterSeq}`))).map((e) =>
      VoiceEventView.parse(e),
    );
  const eventRows = async (type: string) =>
    (await rt.store.event.list(conversationSessionId))
      .filter((e) => e.type === type)
      .map((e) => e.payload as Json);

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-voice-routes-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new FakeProvider({
        replies: [
          textReply(STATUS_REPLY, {
            when: { lastUserIncludes: "status" },
            times: Number.POSITIVE_INFINITY,
          }),
          textReply("Noted.", { times: Number.POSITIVE_INFINITY }),
        ],
        clock,
        latency: "none",
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: { stt, tts },
    });
    ({ app, token } = createDaemonApp(rt));
    const p = await rt.store.project.insert({
      name: "PharmaWatch",
      goal: "Watch pharma news",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
    projectId = p.id;
  });
  afterAll(async () => {
    await rt?.close();
  });

  it("names the routes and reports the fake providers as available", async () => {
    for (const key of [
      "voiceStatus",
      "startVoiceSession",
      "voiceSession",
      "stopVoiceSession",
      "voicePress",
      "voiceAudio",
      "voiceText",
      "voiceAnswer",
      "voiceEvents",
    ])
      expect(DAEMON_ROUTES).toHaveProperty(key);
    const status = VoiceStatusView.parse(await json(await req("/voice/status")));
    expect(status.available).toBe(true);
    expect(status.stt).toMatchObject({ name: "fake-stt", kind: "fake", policy: "fake" });
    expect(status.tts).toMatchObject({ name: "fake-tts", kind: "fake", policy: "fake" });
    expect(status.sessions).toBe(0);
    expect(status.modes).toEqual(["push_to_talk", "open_mic"]);
    expect((await req("/voice/sessions/nope")).status).toBe(404);
  });

  it("a text turn produces the reply events and a voice.turn row on the conversation session", async () => {
    const started = await post("/voice/sessions", { projectId, language: "en" });
    expect(started.status).toBe(201);
    const view = VoiceSessionView.parse(await json(started));
    sessionId = view.id;
    conversationSessionId = view.conversationSessionId;
    expect(view).toMatchObject({ state: "idle", turn: 0, mode: "push_to_talk", language: "en" });
    expect(view.providers.stt.name).toBe("fake-stt");
    // The session's start is an audit row naming the providers, never any audio.
    const startRows = (await rt.store.auditLog.list({ tool: VOICE_SESSION_AUDIT_TOOL } as never))
      .map((r) => JSON.parse(r.input_summary) as Json)
      .filter((r) => r.id === sessionId);
    expect(startRows).toEqual([
      expect.objectContaining({ action: "start", stt: "fake-stt", tts: "fake-tts" }),
    ]);

    const turn = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "What is the status?" }),
        ),
      ),
    );
    expect(turn).toMatchObject({
      turn: 1,
      source: "text",
      said: "What is the status?",
      heard: STATUS_REPLY,
      pending: null,
      approval: null,
      interrupted: false,
      audioStored: false,
      error: null,
    });
    expect(turn.reply?.reply).toBe(STATUS_REPLY);
    // Two sentences, each synthesised and played (two fake chunks per sentence).
    expect(tts.calls.map((c) => c.text)).toEqual([
      "The session on PharmaWatch completed.",
      "One pull request is open.",
    ]);
    expect(turn.audioChunks).toBe(4);
    // A text turn has no audio to transcribe: the transcript is final at once.
    expect(turn.latency.finalTranscriptMs).toBe(0);
    expect(turn.latency.withinTarget).toBe(true);

    // The loop's events, numbered, with the bridge's own: first audio and the done turn.
    const seen = await events(sessionId);
    const types = seen.map((e) => e.type);
    for (const t of [
      "turn_start",
      "transcript_final",
      "model_delta",
      "sentence",
      "speaking_start",
      "voice.first_audio",
      "speaking_end",
      "turn_end",
      "voice.turn",
    ])
      expect(types).toContain(t);
    expect(types).not.toContain("audio"); // audio frames are live only, never replayed
    expect(types).not.toContain("voice.readback");
    const firstAudio = seen.find((e) => e.type === "voice.first_audio")?.data as Json;
    expect(firstAudio.withinTarget).toBe(true);
    expect(Number(firstAudio.sinceTurnEndMs)).toBeGreaterThanOrEqual(200);
    expect(Number(firstAudio.sinceTurnEndMs)).toBeLessThanOrEqual(1200);
    const done = seen.find((e) => e.type === "voice.turn")?.data as { record: Json };
    expect(done.record.heard).toBe(STATUS_REPLY);
    const lastSeq = seen.at(-1)?.seq ?? 0;
    expect(await events(sessionId, lastSeq)).toEqual([]);

    // Session history (spec O.5, O.10): the chat turn with its source and the voice.turn row.
    const human = await eventRows("chat.human");
    expect(human.at(-1)).toMatchObject({ text: "What is the status?", source: "voice" });
    const rows = await eventRows("voice.turn");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turn: 1,
      source: "text",
      said: "What is the status?",
      heard: STATUS_REPLY,
      audioStored: false,
      pendingId: null,
    });
    expect((rows[0]?.latency as Json | undefined)?.withinTarget).toBe(true);
    const after = VoiceSessionView.parse(await json(await req(`/voice/sessions/${sessionId}`)));
    expect(after).toMatchObject({ state: "idle", turns: 1, pending: null });
    expect(after.lastTurn?.said).toBe("What is the status?");
  });

  it("a risky command needs the read-back: a wrong answer does nothing, a yes applies it", async () => {
    const ask = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "Give it 20 francs tonight." }),
        ),
      ),
    );
    const card = ask.pending;
    expect(card).toMatchObject({ decision: "needs_yes", commands: ["budget.set"] });
    expect(card?.readback).toContain("Say yes to confirm");
    // He heard the whole read-back, once, and nothing else; nothing ran.
    expect(ask.heard).toBe(card?.readback);
    expect(ask.reply?.actions).toEqual([]);
    expect(ask.approval).toBeNull();
    const seenAsk = await events(sessionId);
    const readback = seenAsk.filter((e) => e.type === "voice.readback" && e.turn === 2);
    expect(readback).toHaveLength(1);
    expect((readback[0]?.data as { pending: Json } | undefined)?.pending.id).toBe(card?.id);
    const pendingBefore = await jsonList(await req("/commands/pending"));
    expect(pendingBefore.map((p) => p.id)).toEqual([card?.id]);
    const session = VoiceSessionView.parse(await json(await req(`/voice/sessions/${sessionId}`)));
    expect(session.pending?.id).toBe(card?.id);

    // A question is not a yes: the card stays, the read-back repeats, the agent is not called.
    const callsBefore = (rt.provider as FakeProvider).calls.length;
    const wrong = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "Yes, but what does it cost?" }),
        ),
      ),
    );
    expect(wrong.approval).toMatchObject({
      approved: false,
      blockedBy: "question",
      line: "Yes, but what does it cost?",
      method: "spoken",
      pendingId: card?.id,
      commands: ["budget.set"],
    });
    expect(wrong.reply).toBeNull();
    expect(wrong.heard).toBe(`I did not take that as a yes. ${card?.readback}`);
    expect(wrong.pending?.id).toBe(card?.id);
    expect((rt.provider as FakeProvider).calls).toHaveLength(callsBefore);
    expect((await jsonList(await req("/commands/pending"))).map((p) => p.id)).toEqual([card?.id]);
    const project = await rt.store.project.mustGet(projectId);
    expect(project.settings[SESSION_OVERRIDE_KEY]).toBeUndefined();
    expect((await rt.store.changeLog.list()).some((c) => c.source === "voice")).toBe(false);

    // A yes applies the change through the registry: the change log names the words used.
    const yes = VoiceTurnView.parse(
      await json(
        await drive(clock, post(`/voice/sessions/${sessionId}/text`, { text: "Yes, go ahead." })),
      ),
    );
    expect(yes.approval).toMatchObject({
      approved: true,
      line: "Yes, go ahead.",
      method: "spoken",
    });
    expect(yes.pending).toBeNull();
    expect(yes.reply?.actions.map((a) => a.kind)).toEqual(["budget.set"]);
    expect(await jsonList(await req("/commands/pending"))).toEqual([]);
    const changed = await rt.store.project.mustGet(projectId);
    expect(changed.settings[SESSION_OVERRIDE_KEY]).toBeDefined();
    const change = (await rt.store.changeLog.list()).find((c) => c.source === "voice");
    expect(change?.words_used).toBe("Give it 20 francs tonight.");

    // Spoken approvals are logged with the exact line (spec O.7): the rows and the audit log.
    const approvals = await eventRows("voice.approval");
    expect(approvals.map((a) => [a.line, a.approved, a.blockedBy])).toEqual([
      ["Yes, but what does it cost?", false, "question"],
      ["Yes, go ahead.", true, null],
    ]);
    const audits = (await rt.store.auditLog.list({ tool: VOICE_APPROVAL_AUDIT_TOOL } as never)).map(
      (r) => JSON.parse(r.input_summary) as Json,
    );
    expect(audits.map((a) => a.line)).toEqual(["Yes, but what does it cost?", "Yes, go ahead."]);
    expect((await eventRows("voice.turn")).map((r) => r.pendingId)).toEqual([
      null,
      card?.id,
      card?.id,
      null,
    ]);
  });

  it("a tap answers the read-back through the registry without a spoken yes", async () => {
    const ask = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "Give it 25 francs tonight." }),
        ),
      ),
    );
    expect(ask.pending?.commands).toEqual(["budget.set"]);
    const missing = await post(`/voice/sessions/nope/answer`, { answer: "tap" });
    expect(missing.status).toBe(404);
    const answered = VoiceAnswerView.parse(
      await json(await post(`/voice/sessions/${sessionId}/answer`, { answer: "tap" })),
    );
    expect(answered).toMatchObject({ pendingId: ask.pending?.id, answer: "tap" });
    expect(answered.result.status).toBe("done");
    expect(answered.approval).toMatchObject({ method: "tap", approved: true, line: "" });
    expect(await jsonList(await req("/commands/pending"))).toEqual([]);
    const session = VoiceSessionView.parse(await json(await req(`/voice/sessions/${sessionId}`)));
    expect(session.pending).toBeNull();
    // Without a card, a tap is refused and nothing is written.
    const again = await post(`/voice/sessions/${sessionId}/answer`, { answer: "tap" });
    expect(again.status).toBe(404);
    const approvals = await eventRows("voice.approval");
    expect(approvals.at(-1)).toMatchObject({ method: "tap", approved: true, status: "done" });
    const seen = await events(sessionId);
    expect(seen.filter((e) => e.type === "voice.answer")).toHaveLength(1);
  });

  it("an audio turn: press, chunks, release; every latency stage measured on the clock", async () => {
    // The fake STT's script for the next capture it opens (text turns never reach it).
    scripts[stt.sessions.length] = {
      partials: [{ atAudioMs: 100, text: "What" }],
      final: "What is the status?",
    };
    const before = VoiceSessionView.parse(await json(await req(`/voice/sessions/${sessionId}`)));
    const pressed = VoiceSessionView.parse(
      await json(await post(`/voice/sessions/${sessionId}/press`, { pressed: true })),
    );
    expect(pressed.state).toBe("listening");
    const frames = speechFrames(400);
    for (const [i, frame] of frames.entries()) {
      clock.tickMonotonic(FRAME_MS);
      const sent =
        i % 2 === 0
          ? await post(`/voice/sessions/${sessionId}/audio`, {
              pcm: encodePcm(frame),
              sampleRate: frame.sampleRate,
              channels: frame.channels,
              timestampMs: frame.timestampMs,
            })
          : await req(
              `/voice/sessions/${sessionId}/audio?sampleRate=${frame.sampleRate}&channels=1&timestampMs=${frame.timestampMs}`,
              {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: Buffer.from(encodePcm(frame), "base64"),
              },
            );
      expect(sent.status).toBe(200);
    }
    const bad = await req(`/voice/sessions/${sessionId}/audio?sampleRate=abc`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(4),
    });
    expect(bad.status).toBe(409);
    // The release comes 20 ms after the last frame: the push-to-talk end of turn.
    clock.tickMonotonic(20);
    const released = VoiceSessionView.parse(
      await json(await post(`/voice/sessions/${sessionId}/press`, { pressed: false })),
    );
    expect(released.state).toBe("transcribing");
    const turnNo = released.turn;
    const done = await drive(
      clock,
      (async () => {
        for (;;) {
          const v = VoiceSessionView.parse(await json(await req(`/voice/sessions/${sessionId}`)));
          if (v.turns > before.turns && v.state === "idle") return v;
          await settle(4);
        }
      })(),
    );
    const turn = done.lastTurn;
    expect(turn).toMatchObject({
      turn: turnNo,
      source: "audio",
      said: "What is the status?",
      heard: STATUS_REPLY,
    });
    const l = turn?.latency;
    if (!l) throw new Error("no latency report");
    expect(l.endOfTurnMs).toBe(20);
    expect(l.finalTranscriptMs).toBe(300);
    expect(l.modelFirstTokenMs).not.toBeNull();
    expect(l.firstAudioMs).toBeGreaterThanOrEqual(200);
    expect(l.totalToFirstAudioMs).toBe(
      (l.endOfTurnMs ?? 0) +
        (l.finalTranscriptMs ?? 0) +
        (l.modelFirstTokenMs ?? 0) +
        (l.firstAudioMs ?? 0),
    );
    expect(l.withinTarget).toBe(true);
    expect(l.stages.total.targetMs).toBe(1200);
    const seen = (await events(sessionId)).filter((e) => e.turn === turnNo);
    expect(seen.some((e) => e.type === "transcript_partial")).toBe(true);
    const firstAudio = seen.find((e) => e.type === "voice.first_audio")?.data as Json;
    // Measured from the release (the end of the turn as detected); the report's total adds
    // the end-of-turn detection itself, the 20 ms between the last frame and the release.
    expect(firstAudio.sinceTurnEndMs).toBe((l.totalToFirstAudioMs ?? 0) - (l.endOfTurnMs ?? 0));
    expect(firstAudio.withinTarget).toBe(true);
    const row = (await eventRows("voice.turn")).find((r) => r.turn === turnNo);
    expect(row).toMatchObject({ source: "audio", said: "What is the status?" });
    expect((row?.latency as Json | undefined)?.endOfTurnMs).toBe(20);
  });

  it("streams the events over SSE and stops at once", async () => {
    const ac = new AbortController();
    const res = await app.request(`/voice/sessions/${sessionId}/events?token=${token}&afterSeq=0`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    // The replay of what happened so far, then the live frames of a new turn.
    const before = VoiceSessionView.parse(await json(await req(`/voice/sessions/${sessionId}`)));
    const next = before.turn + 1;
    const turnDone = drive(
      clock,
      post(`/voice/sessions/${sessionId}/text`, { text: "Note that." }),
    );
    let text = "";
    while (!text.includes(`"type":"voice.turn","turn":${next}`)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect((await turnDone).status).toBe(200);
    expect(text).toContain(`"type":"turn_start","turn":${next}`);
    expect(text).toContain("event: voice.event");
    expect(text).toContain('"type":"audio"');
    expect(text).toContain('"pcm":"');
    expect(text).toContain('"type":"turn_start"');
    ac.abort();

    const stopped = VoiceSessionView.parse(
      await json(await post(`/voice/sessions/${sessionId}/stop`, {})),
    );
    expect(stopped.state).toBe("idle");
    expect(stopped.endedAt).not.toBeNull();
    const refused = await post(`/voice/sessions/${sessionId}/text`, { text: "Hello?" });
    expect(refused.status).toBe(409);
    expect(VoiceStatusView.parse(await json(await req("/voice/status"))).sessions).toBe(0);
    const stopRows = (await rt.store.auditLog.list({ tool: VOICE_SESSION_AUDIT_TOOL } as never))
      .map((r) => JSON.parse(r.input_summary) as Json)
      .filter((r) => r.id === sessionId && r.action === "stop");
    expect(stopRows).toHaveLength(1);
    // Nothing of what was said or played is in the audit log.
    for (const r of await rt.store.auditLog.list({} as never, { limit: 10_000 })) {
      expect(r.input_summary).not.toContain(STATUS_REPLY);
      expect(r.input_summary).not.toContain('"pcm"');
    }
  });
});

describe("voice unavailable", () => {
  const clock = new SimulatedClock("2026-11-03T08:00:00Z");
  const KEY = ["dg", "_", "live", "_", "0123456789abcdef0123456789abcdef"].join(""); // not-a-secret
  const compose = async (registry: VoiceProviderRegistry, vault: MemoryVault) => {
    const home = mkdtempSync(join(tmpdir(), "fr-voice-none-"));
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      provider: new FakeProvider({ replies: [], clock, latency: "none" }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: { registry },
    });
    const { app, token } = createDaemonApp(rt);
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    return { rt, req };
  };

  it("reports the reason when no provider is configured and refuses a session with 503", async () => {
    const { rt, req } = await compose(new VoiceProviderRegistry(), new MemoryVault());
    try {
      const status = VoiceStatusView.parse(await json(await req("/voice/status")));
      expect(status.available).toBe(false);
      expect(status.reason).toContain("no STT provider available");
      expect(status.stt).toBeNull();
      expect(status.statuses).toEqual({ stt: [], tts: [] });
      const started = await req("/voice/sessions", { method: "POST", body: "{}" });
      expect(started.status).toBe(503);
      expect(await json(started)).toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("no STT provider available"),
      });
    } finally {
      await rt.close();
    }
  });

  it("a cloud provider with its key in the vault shows the reference, never the value", async () => {
    const vault = new MemoryVault();
    await vault.set("deepgram_api_key", KEY);
    const registry = new VoiceProviderRegistry().registerStt(
      new DeepgramStt({
        apiKeyRef: VOICE_SECRET_REFS.deepgram,
        resolveSecret: async (ref) => (await vault.get(ref.replace(/^secret:/, ""))) ?? undefined,
        clock,
      }),
      { secretRef: VOICE_SECRET_REFS.deepgram },
    );
    const { rt, req } = await compose(registry, vault);
    try {
      const res = await req("/voice/status");
      const body = await res.text();
      expect(body).not.toContain(KEY);
      const status = VoiceStatusView.parse(JSON.parse(body));
      expect(status.available).toBe(false);
      expect(status.reason).toContain("no TTS provider available");
      expect(status.statuses.stt).toEqual([
        expect.objectContaining({
          name: "deepgram",
          kind: "cloud",
          available: true,
          secretRef: VOICE_SECRET_REFS.deepgram,
          secretConfigured: true,
        }),
      ]);
    } finally {
      await rt.close();
    }
  });
});
