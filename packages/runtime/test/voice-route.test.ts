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
  CartesiaTts,
  DeepgramStt,
  ElevenLabsTts,
  FakeStt,
  type FakeSttScript,
  FakeTts,
  VoiceProviderRegistry,
} from "../src/voice/pkg.ts";
import { VOICE_PREFERENCE_ENV, VOICE_SECRET_REFS } from "../src/voice/providers.ts";
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
    // A resume point that is not a number is refused, never a silent empty replay.
    expect((await req(`/voice/sessions/${sessionId}/events?afterSeq=abc`)).status).toBe(409);
    expect((await req(`/voice/sessions/${sessionId}/events?afterSeq=-1`)).status).toBe(409);

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

    // A yes applies the change through the registry itself (no model call): the registry's
    // outcome is on the decision and its sentence is what he hears; the change log names the
    // words used.
    const yes = VoiceTurnView.parse(
      await json(
        await drive(clock, post(`/voice/sessions/${sessionId}/text`, { text: "Yes, go ahead." })),
      ),
    );
    expect(yes.approval).toMatchObject({
      approved: true,
      line: "Yes, go ahead.",
      method: "spoken",
      status: "done",
      reason: null,
    });
    expect(yes.pending).toBeNull();
    expect(yes.reply).toBeNull();
    expect(yes.outcome).toMatchObject({ status: "done", commands: ["budget.set"] });
    expect(yes.outcome?.changeLogId).toBeDefined();
    expect(yes.heard).toBe(yes.outcome?.sentence);
    expect((rt.provider as FakeProvider).calls).toHaveLength(callsBefore);
    expect(await jsonList(await req("/commands/pending"))).toEqual([]);
    const changed = await rt.store.project.mustGet(projectId);
    expect(changed.settings[SESSION_OVERRIDE_KEY]).toBeDefined();
    const change = (await rt.store.changeLog.list()).find((c) => c.source === "voice");
    expect(change?.words_used).toBe("Give it 20 francs tonight.");
    // The transcript keeps the line and the outcome as the agent would have written them.
    expect((await eventRows("chat.human")).at(-1)).toMatchObject({
      text: "Yes, go ahead.",
      source: "voice",
    });
    expect((await eventRows("chat.confirmed")).at(-1)).toMatchObject({
      confirmationId: card?.id,
      words: "Yes, go ahead.",
      status: "done",
      commands: ["budget.set"],
    });
    expect((await eventRows("chat.reply")).at(-1)).toMatchObject({
      text: yes.heard,
      actions: ["budget.set"],
    });

    // Spoken approvals are logged with the exact line (spec O.7) and the registry's outcome:
    // the rows and the audit log.
    const approvals = await eventRows("voice.approval");
    expect(approvals.map((a) => [a.line, a.approved, a.blockedBy, a.status])).toEqual([
      ["Yes, but what does it cost?", false, "question", "pending"],
      ["Yes, go ahead.", true, null, "done"],
    ]);
    const audits = await rt.store.auditLog.list({ tool: VOICE_APPROVAL_AUDIT_TOOL } as never);
    expect(audits.map((r) => [(JSON.parse(r.input_summary) as Json).line, r.allowed])).toEqual([
      ["Yes, but what does it cost?", false],
      ["Yes, go ahead.", true],
    ]);
    expect(audits.map((r) => (JSON.parse(r.input_summary) as Json).status)).toEqual([
      "pending",
      "done",
    ]);
    expect((await eventRows("voice.turn")).map((r) => r.pendingId)).toEqual([
      null,
      card?.id,
      card?.id,
      null,
    ]);
    // The registry's result reaches the stream as a voice.answer frame like a tap's.
    const seenYes = await events(sessionId);
    const answered = seenYes.filter((e) => e.type === "voice.answer");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.data).toMatchObject({
      pendingId: card?.id,
      answer: "spoken",
      result: { status: "done" },
    });
  });

  it("a chat line between the read-back and the spoken yes does not lose the card: the registry decides", async () => {
    const ask = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "Give it 30 francs tonight." }),
        ),
      ),
    );
    const card = ask.pending;
    expect(card).toMatchObject({ decision: "needs_yes", commands: ["budget.set"] });
    // A typed line from the same human in the meantime: the conversation agent drops its own
    // copy of the card, the registry still holds it and so does the voice session.
    const chat = await post("/chat", {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      text: "What is the status?",
    });
    expect(chat.status).toBe(200);
    expect(((await json(chat)) as { reply: string }).reply).toBe(STATUS_REPLY);
    expect((await jsonList(await req("/commands/pending"))).map((p) => p.id)).toEqual([card?.id]);
    expect(
      VoiceSessionView.parse(await json(await req(`/voice/sessions/${sessionId}`))).pending?.id,
    ).toBe(card?.id);
    const changesBefore = (await rt.store.changeLog.list()).length;

    // The spoken yes answers the registry's card, so what the audit row says happened happened.
    const yes = VoiceTurnView.parse(
      await json(
        await drive(clock, post(`/voice/sessions/${sessionId}/text`, { text: "Yes, go ahead." })),
      ),
    );
    expect(yes.approval).toMatchObject({ approved: true, status: "done", pendingId: card?.id });
    expect(yes.pending).toBeNull();
    expect(yes.outcome?.status).toBe("done");
    expect(await jsonList(await req("/commands/pending"))).toEqual([]);
    const changes = await rt.store.changeLog.list();
    expect(changes).toHaveLength(changesBefore + 1);
    expect(changes.some((c) => c.words_used === "Give it 30 francs tonight.")).toBe(true);
    const audit = (await rt.store.auditLog.list({ tool: VOICE_APPROVAL_AUDIT_TOOL } as never)).at(
      -1,
    );
    expect(audit?.allowed).toBe(true);
    expect(JSON.parse(audit?.input_summary ?? "{}")).toMatchObject({
      pendingId: card?.id,
      status: "done",
    });
  });

  it("a card answered elsewhere is gone for the voice session too: nothing runs twice", async () => {
    const ask = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "Give it 35 francs tonight." }),
        ),
      ),
    );
    const card = ask.pending;
    expect(card?.commands).toEqual(["budget.set"]);
    // The UI taps the card while the voice session still shows it.
    const tapped = await post(`/commands/${card?.id}/confirm`, { answer: "tap" });
    expect(tapped.status).toBe(200);
    expect(((await json(tapped)) as { status: string }).status).toBe("done");
    const changesBefore = (await rt.store.changeLog.list()).length;
    // A spoken yes is refused by the registry (no such pending change), recorded as such, and
    // the voice session forgets the card; the change does not run a second time.
    const yes = VoiceTurnView.parse(
      await json(await drive(clock, post(`/voice/sessions/${sessionId}/text`, { text: "Yes." }))),
    );
    expect(yes.approval).toMatchObject({
      approved: true,
      status: "refused",
      pendingId: card?.id,
      reason: expect.stringContaining("no pending confirmation"),
    });
    expect(yes.heard).toMatch(/^Not done: /);
    expect(yes.pending).toBeNull();
    expect(yes.outcome?.code).toBe("not_found");
    expect((await rt.store.changeLog.list()).length).toBe(changesBefore);
    const audit = (await rt.store.auditLog.list({ tool: VOICE_APPROVAL_AUDIT_TOOL } as never)).at(
      -1,
    );
    expect(audit?.allowed).toBe(false);
    expect(JSON.parse(audit?.input_summary ?? "{}")).toMatchObject({ status: "refused" });
    // Without a card, a tap is 404; with a card cancelled elsewhere, a question is plain chat.
    expect((await post(`/voice/sessions/${sessionId}/answer`, { answer: "tap" })).status).toBe(404);
    const ask2 = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "Give it 40 francs tonight." }),
        ),
      ),
    );
    expect(ask2.pending?.commands).toEqual(["budget.set"]);
    expect((await post(`/commands/${ask2.pending?.id}/cancel`, {})).status).toBe(200);
    const plain = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${sessionId}/text`, { text: "What is the status?" }),
        ),
      ),
    );
    expect(plain.approval).toBeNull();
    expect(plain.pending).toBeNull();
    expect(plain.heard).toBe(STATUS_REPLY);
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
    expect(
      seen.filter((e) => e.type === "voice.answer" && (e.data as Json).answer === "tap"),
    ).toHaveLength(1);
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
    // A rate no capture device has is refused before the loop resamples it to 16 kHz (a chunk
    // declared at 1 Hz would be expanded 16000 times), in both bodies.
    const first = frames[0];
    if (!first) throw new Error("no frame");
    for (const rate of [1, 7999, 192_001]) {
      const lowJson = await post(`/voice/sessions/${sessionId}/audio`, {
        pcm: encodePcm(first),
        sampleRate: rate,
        channels: 1,
        timestampMs: 0,
      });
      expect(lowJson.status).toBe(409);
      const lowRaw = await req(`/voice/sessions/${sessionId}/audio?sampleRate=${rate}&channels=1`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(encodePcm(first), "base64"),
      });
      expect(lowRaw.status).toBe(409);
    }
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
    // The diagnostics split the first-audio stage (the real-audio run's report reads them).
    expect(l.ttsFirstByteMs).not.toBeNull();
    expect(row?.latency).toMatchObject({
      ttsFirstByteMs: l.ttsFirstByteMs,
      firstSentenceMs: l.firstSentenceMs,
    });
  });

  it("an EventSource reconnect resumes after its Last-Event-ID: nothing it saw is replayed", async () => {
    const seen = await events(sessionId);
    expect(seen.length).toBeGreaterThan(4);
    const mid = seen[Math.floor(seen.length / 2)]?.seq ?? 0;
    const last = seen.at(-1)?.seq ?? 0;
    // The browser reconnects to the URL it was given (`afterSeq` of the first subscription)
    // and sends the last frame id it received as Last-Event-ID; the later of the two wins.
    const ids = async (query: string, lastEventId?: string) => {
      const ac = new AbortController();
      const res = await app.request(`/voice/sessions/${sessionId}/events?token=${token}${query}`, {
        headers: {
          accept: "text/event-stream",
          ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
        },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no body");
      let text = "";
      while (!new RegExp(`^id: ${last}$`, "m").test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      ac.abort();
      return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    };
    const resumed = await ids("&afterSeq=0", String(mid));
    expect(resumed.length).toBeGreaterThan(0);
    expect(Math.min(...resumed)).toBe(seen.find((e) => e.seq > mid)?.seq);
    expect(resumed.every((id) => id > mid)).toBe(true);
    // A larger afterSeq than the header still wins; a header that is not a number is ignored.
    expect(Math.min(...(await ids(`&afterSeq=${mid}`, "1")))).toBeGreaterThan(mid);
    expect(Math.min(...(await ids(`&afterSeq=${mid}`, "abc")))).toBeGreaterThan(mid);
    // Without either, the whole buffer replays (the first subscription of a fresh panel).
    expect(Math.min(...(await ids("&afterSeq=0")))).toBe(seen[0]?.seq);
  });

  it("records the first audio the player heard on the turn's row, or as a voice.heard row once the row is written", async () => {
    const started = VoiceSessionView.parse(
      await json(await post("/voice/sessions", { projectId, language: "en" })),
    );
    const id = started.id;
    // A turn that has ended: its voice.turn row is written, so the figure is its own row.
    const typed = VoiceTurnView.parse(
      await json(
        await drive(clock, post(`/voice/sessions/${id}/text`, { text: "What is the status?" })),
      ),
    );
    const late = await post(`/voice/sessions/${id}/heard`, {
      turn: typed.turn,
      heardFirstAudioMs: 812.4,
    });
    expect(late.status).toBe(200);
    expect(await json(late)).toEqual({
      turn: typed.turn,
      heardFirstAudioMs: 812,
      recordedOn: "voice.heard",
    });
    // One figure per turn; an unknown turn, a bad figure and a missing token are refused.
    expect(
      (await post(`/voice/sessions/${id}/heard`, { turn: typed.turn, heardFirstAudioMs: 900 }))
        .status,
    ).toBe(409);
    expect(
      (await post(`/voice/sessions/${id}/heard`, { turn: 99, heardFirstAudioMs: 900 })).status,
    ).toBe(404);
    for (const bad of [-1, "fast", null, 3_600_001])
      expect(
        (await post(`/voice/sessions/${id}/heard`, { turn: typed.turn, heardFirstAudioMs: bad }))
          .status,
      ).toBe(409);
    expect(
      (
        await app.request(`/voice/sessions/${id}/heard?token=${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ turn: typed.turn, heardFirstAudioMs: 1 }),
        })
      ).status,
    ).toBe(401);

    // An audio turn: the player's figure arrives while the reply plays, before the row.
    scripts[stt.sessions.length] = { final: "What is the status?" };
    await post(`/voice/sessions/${id}/press`, { pressed: true });
    for (const frame of speechFrames(300)) {
      clock.tickMonotonic(FRAME_MS);
      await post(`/voice/sessions/${id}/audio`, {
        pcm: encodePcm(frame),
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        timestampMs: frame.timestampMs,
      });
    }
    const released = VoiceSessionView.parse(
      await json(await post(`/voice/sessions/${id}/press`, { pressed: false })),
    );
    const live = await post(`/voice/sessions/${id}/heard`, {
      turn: released.turn,
      heardFirstAudioMs: 1093,
    });
    expect(live.status).toBe(200);
    expect(await json(live)).toMatchObject({ recordedOn: "voice.turn" });
    await drive(
      clock,
      (async () => {
        for (;;) {
          const v = VoiceSessionView.parse(await json(await req(`/voice/sessions/${id}`)));
          if (v.turns > typed.turn && v.state === "idle") return v;
          await settle(4);
        }
      })(),
    );
    await drive(clock, settle(8));
    // Every voice session of the agent and project writes to the same conversation session,
    // and turn numbers restart per voice session: the rows name their voice session.
    const rows = (await rt.store.event.list(started.conversationSessionId)).filter(
      (e) =>
        (e.type === "voice.turn" || e.type === "voice.heard") &&
        (e.payload as Json).voiceSessionId === id,
    );
    expect(rows).toHaveLength(3);
    const latencyOf = (n: number): Json => {
      const row = rows.find((r) => r.type === "voice.turn" && (r.payload as Json).turn === n);
      if (!row) throw new Error(`no voice.turn row for turn ${n}`);
      return (row.payload as Json).latency as Json;
    };
    expect(latencyOf(released.turn).heardFirstAudioMs).toBe(1093);
    // The daemon-side figure stays beside it, unchanged.
    expect(latencyOf(released.turn).totalToFirstAudioMs).toEqual(expect.any(Number));
    expect(latencyOf(typed.turn).heardFirstAudioMs).toBeNull();
    expect(rows.filter((r) => r.type === "voice.heard").map((r) => r.payload as Json)).toEqual([
      { voiceSessionId: id, turn: typed.turn, heardFirstAudioMs: 812 },
    ]);
    expect(DAEMON_ROUTES).toHaveProperty("voiceHeard");
    expect((await post(`/voice/sessions/${id}/stop`, {})).status).toBe(200);
  });

  it("reply mode text: the reply streams as text with no TTS and no audio, the row records the mode, nothing is heard", async () => {
    const refused = await post("/voice/sessions", { projectId, replyMode: "loud" });
    expect(refused.status).toBe(409);
    const started = VoiceSessionView.parse(
      await json(await post("/voice/sessions", { projectId, language: "en", replyMode: "text" })),
    );
    expect(started.replyMode).toBe("text");
    const id = started.id;
    const ttsBefore = tts.calls.length;
    const typed = VoiceTurnView.parse(
      await json(
        await drive(clock, post(`/voice/sessions/${id}/text`, { text: "What is the status?" })),
      ),
    );
    expect(typed).toMatchObject({
      replyMode: "text",
      heard: STATUS_REPLY,
      audioChunks: 0,
      interrupted: false,
      unspokenText: null,
    });
    expect(typed.latency).toMatchObject({ firstAudioMs: null, totalToFirstAudioMs: null });
    expect(typed.latency.modelFirstTokenMs).not.toBeNull();
    // The TTS was never called: a text reply costs no synthesis.
    expect(tts.calls).toHaveLength(ttsBefore);
    const seen = (await events(id)).filter((e) => e.turn === typed.turn);
    const types = seen.map((e) => e.type);
    expect(types).toContain("model_delta");
    expect(types).toContain("sentence");
    for (const t of ["speaking_start", "speaking_end", "voice.first_audio"])
      expect(types).not.toContain(t);
    expect(seen.find((e) => e.type === "turn_end")?.data).toMatchObject({ replyMode: "text" });
    // The reply's text frames come before the turn's end, in seq order.
    expect(types.indexOf("model_delta")).toBeLessThan(types.indexOf("turn_end"));
    const shown = seen
      .filter((e) => e.type === "model_delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(shown).toBe(STATUS_REPLY);
    const rowOf = async (turn: number) =>
      (await rt.store.event.list(started.conversationSessionId))
        .filter((e) => e.type === "voice.turn" && (e.payload as Json).voiceSessionId === id)
        .map((e) => e.payload as Json)
        .find((r) => r.turn === turn);
    expect(await rowOf(typed.turn)).toMatchObject({ replyMode: "text", audioChunks: 0 });
    // Nothing was spoken, so nothing was heard: a heard figure for the turn is refused.
    expect(
      (await post(`/voice/sessions/${id}/heard`, { turn: typed.turn, heardFirstAudioMs: 500 }))
        .status,
    ).toBe(409);

    // The press carries the panel's choice: back to voice from this turn on.
    scripts[stt.sessions.length] = { final: "What is the status?" };
    const pressed = VoiceSessionView.parse(
      await json(await post(`/voice/sessions/${id}/press`, { pressed: true, replyMode: "voice" })),
    );
    expect(pressed.replyMode).toBe("voice");
    for (const frame of speechFrames(300)) {
      clock.tickMonotonic(FRAME_MS);
      await post(`/voice/sessions/${id}/audio`, {
        pcm: encodePcm(frame),
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        timestampMs: frame.timestampMs,
      });
    }
    const released = VoiceSessionView.parse(
      await json(await post(`/voice/sessions/${id}/press`, { pressed: false })),
    );
    const spoken = await drive(
      clock,
      (async () => {
        for (;;) {
          const v = VoiceSessionView.parse(await json(await req(`/voice/sessions/${id}`)));
          if (v.turns >= released.turn && v.state === "idle") return v;
          await settle(4);
        }
      })(),
    );
    expect(spoken.lastTurn).toMatchObject({ turn: released.turn, replyMode: "voice" });
    expect(spoken.lastTurn?.latency.totalToFirstAudioMs).toEqual(expect.any(Number));
    expect(tts.calls.length).toBeGreaterThan(ttsBefore);
    await drive(clock, settle(8));
    expect(await rowOf(released.turn)).toMatchObject({ replyMode: "voice" });

    // The text route takes it too, and the session keeps the last choice.
    const again = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${id}/text`, { text: "Note that.", replyMode: "text" }),
        ),
      ),
    );
    expect(again.replyMode).toBe("text");
    const view = VoiceSessionView.parse(await json(await req(`/voice/sessions/${id}`)));
    expect(view.replyMode).toBe("text");
    // The recent turns, oldest first: a shell that missed a turn (a barge-in while it polled,
    // no event stream) completes it from here, not only from lastTurn.
    expect(view.recentTurns.map((t) => [t.turn, t.replyMode])).toEqual([
      [typed.turn, "text"],
      [released.turn, "voice"],
      [again.turn, "text"],
    ]);
    expect(view.lastTurn?.turn).toBe(again.turn);
    expect(
      (await post(`/voice/sessions/${id}/press`, { pressed: true, replyMode: "loud" })).status,
    ).toBe(409);
    // The mode is the turn's, chosen when it starts: a release cannot change it.
    expect(
      (await post(`/voice/sessions/${id}/press`, { pressed: false, replyMode: "voice" })).status,
    ).toBe(409);
    expect(VoiceSessionView.parse(await json(await req(`/voice/sessions/${id}`))).replyMode).toBe(
      "text",
    );
    expect((await post(`/voice/sessions/${id}/stop`, {})).status).toBe(200);
  });

  it("reply mode text with a card pending: the read-back streams as text, the yes confirms, nothing is synthesised", async () => {
    const started = VoiceSessionView.parse(
      await json(await post("/voice/sessions", { projectId, language: "en", replyMode: "text" })),
    );
    const id = started.id;
    const ttsBefore = tts.calls.length;
    const ask = VoiceTurnView.parse(
      await json(
        await drive(
          clock,
          post(`/voice/sessions/${id}/text`, { text: "Give it 20 francs tonight." }),
        ),
      ),
    );
    const card = ask.pending;
    expect(card).toMatchObject({ decision: "needs_yes", commands: ["budget.set"] });
    expect(ask.replyMode).toBe("text");
    // The read-back reaches the panel as text: the turn's deltas carry it.
    const deltas = (await events(id))
      .filter((e) => e.turn === ask.turn && e.type === "model_delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(deltas).toContain(card?.readback ?? "(no card)");
    const yes = VoiceTurnView.parse(
      await json(
        await drive(clock, post(`/voice/sessions/${id}/text`, { text: "Yes, go ahead." })),
      ),
    );
    expect(yes.approval).toMatchObject({ approved: true, method: "spoken", status: "done" });
    expect(yes.pending).toBeNull();
    expect(yes.replyMode).toBe("text");
    expect(yes.heard).toBe(yes.outcome?.sentence);
    // Neither the read-back nor the registry's sentence went to the TTS.
    expect(tts.calls).toHaveLength(ttsBefore);
    expect((await post(`/voice/sessions/${id}/stop`, {})).status).toBe(200);
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

  it("a spoken 'stop' while a work session runs is the kill switch even with a card pending; with nothing running it stays the no it was (spec O.9, review finding 2 of w3-o9-chat-to-inbox)", async () => {
    const started = VoiceSessionView.parse(
      await json(await post("/voice/sessions", { projectId, language: "en" })),
    );
    const turn = async (text: string) =>
      VoiceTurnView.parse(
        await json(await drive(clock, post(`/voice/sessions/${started.id}/text`, { text }))),
      );
    // Nothing runs: "stop" answers the read-back as a plain no, through the registry, as before.
    const ask = await turn("Give it 20 francs tonight.");
    expect(ask.pending).toMatchObject({ commands: ["budget.set"] });
    const no = await turn("stop");
    expect(no.pending).toBeNull();
    expect(no.approval).toMatchObject({ approved: false, status: "cancelled" });
    expect(no.heard).toBe("Cancelled; nothing was changed.");
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
    // A work session of the agent runs (the row is what the agent and the kill switch read):
    // the same "stop" is the kill switch, whatever waits for a yes. The bridge hands the line
    // to the agent instead of answering the card: the card is cancelled, the stop runs, the
    // reply says both, and no approval decision is booked for it.
    const row = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      runner: "pc",
    });
    const live = await rt.store.session.start(row.id, row.version);
    const ask2 = await turn("Give it 20 francs tonight.");
    expect(ask2.pending).toMatchObject({ commands: ["budget.set"] });
    const stop = await turn("stop");
    expect(stop.approval).toBeNull();
    expect(stop.pending).toBeNull();
    expect(stop.reply?.actions.map((a) => a.kind)).toEqual(["session.stop"]);
    expect(stop.heard).toContain("cancelled");
    expect(stop.heard).toContain("Stopped");
    expect(await jsonList(await req("/commands/pending"))).toEqual([]);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(true);
    const cancelled = (await rt.store.event.list(started.conversationSessionId))
      .filter((e) => e.type === "chat.cancelled")
      .map((e) => e.payload as Json);
    expect(cancelled.at(-1)).toMatchObject({ words: "stop", stop: true, status: "cancelled" });
    rt.kill.resume();
    const current = await rt.store.session.mustGet(live.id);
    if (current.status === "running")
      await rt.store.session.setStatus(current.id, current.version, "killed");
    expect((await post(`/voice/sessions/${started.id}/stop`, {})).status).toBe(200);
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

describe("voice session eviction", () => {
  it("drops stopped sessions beyond the kept count and after the grace period", async () => {
    const clock = new SimulatedClock("2026-11-03T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-voice-evict-"));
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new FakeProvider({ replies: [], clock, latency: "none" }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: {
        stt: new FakeStt({ clock, scripts: () => ({ final: "" }) }),
        tts: new FakeTts({ clock }),
        keepStopped: 2,
        retainStoppedMs: 60_000,
      },
    });
    const { app, token } = createDaemonApp(rt);
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const started = await req("/voice/sessions", { method: "POST", body: "{}" });
        expect(started.status).toBe(201);
        const id = VoiceSessionView.parse(await json(started)).id;
        await clock.advance(1000);
        expect(
          (await req(`/voice/sessions/${id}/stop`, { method: "POST", body: "{}" })).status,
        ).toBe(200);
        ids.push(id);
      }
      // Two stopped sessions are kept for a late GET or stream; the oldest is gone.
      expect((await req(`/voice/sessions/${ids[0]}`)).status).toBe(404);
      for (const id of [ids[1], ids[2]]) {
        const view = VoiceSessionView.parse(await json(await req(`/voice/sessions/${id}`)));
        expect(view.endedAt).not.toBeNull();
      }
      // After the grace period nothing of them is kept.
      await clock.advance(60_001);
      expect((await req(`/voice/sessions/${ids[2]}`)).status).toBe(404);
      expect((await req(`/voice/sessions/${ids[1]}`)).status).toBe(404);
      expect(VoiceStatusView.parse(await json(await req("/voice/status"))).sessions).toBe(0);
    } finally {
      await rt.close();
    }
  });
});

describe("voice providers chosen in the Extensions panel", () => {
  /**
   * Spec O.4: the providers the daemon uses are the enabled `voice-*` rows of the panel, read
   * at every status read and session start (no restart), with the environment variables as
   * the documented override and a visible reason for every row that is not in force. The
   * registry has the fakes and the three cloud providers (never connected: no turn runs);
   * without a row the registry's own policy picks.
   */
  const clock = new SimulatedClock("2026-11-03T10:00:00Z");
  const keyOf = (name: string) =>
    [name, "_", "live", "_", "0123456789abcdef0123456789abcdef"].join(""); // not-a-secret
  const KEYS = {
    deepgram_api_key: keyOf("dg"),
    cartesia_api_key: keyOf("ct"),
    elevenlabs_api_key: keyOf("el"),
  };
  const vault = new MemoryVault();
  const env: NodeJS.ProcessEnv = {};
  const resolveSecret = async (ref: string) =>
    (await vault.get(ref.replace(/^secret:/, ""))) ?? undefined;
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const rows: Record<string, string> = {};
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  const post = (path: string, body: unknown) =>
    req(path, { method: "POST", body: JSON.stringify(body) });
  const status = async () => {
    const body = await (await req("/voice/status")).text();
    for (const value of Object.values(KEYS)) expect(body).not.toContain(value);
    return VoiceStatusView.parse(JSON.parse(body));
  };
  /** Install a built-in voice entry and say yes in the inbox, as the panel does. */
  const enable = async (catalogId: string) => {
    const added = await post("/extensions", { catalogId });
    expect(added.status).toBe(202);
    const id = String((await json(added)).id);
    const request = (
      await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })
    ).find((r) => (r.change_card as { extensionId?: string } | null)?.extensionId === id);
    if (!request) throw new Error(`no grant request for ${catalogId}`);
    const answered = await post(`/requests/${request.id}/answer`, {
      version: request.version,
      answer: "approve",
    });
    expect(answered.status).toBe(200);
    expect((await json(await req(`/extensions/${id}`))).enabled).toBe(true);
    rows[catalogId] = id;
    return id;
  };

  beforeAll(async () => {
    for (const [name, value] of Object.entries(KEYS)) await vault.set(name, value);
    const home = mkdtempSync(join(tmpdir(), "fr-voice-prefs-"));
    env.FORERUNNER_HOME = home;
    const registry = new VoiceProviderRegistry()
      .registerStt(new FakeStt({ clock, scripts: () => ({ final: "" }) }))
      .registerStt(
        new DeepgramStt({ apiKeyRef: VOICE_SECRET_REFS.deepgram, resolveSecret, clock }),
        { secretRef: VOICE_SECRET_REFS.deepgram },
      )
      .registerTts(new FakeTts({ clock }))
      .registerTts(
        new CartesiaTts({
          apiKeyRef: VOICE_SECRET_REFS.cartesia,
          resolveSecret,
          clock,
          voice: "test-voice",
        }),
        { secretRef: VOICE_SECRET_REFS.cartesia },
      )
      .registerTts(
        new ElevenLabsTts({
          apiKeyRef: VOICE_SECRET_REFS.elevenlabs,
          resolveSecret,
          voice: "test-voice",
        }),
        { secretRef: VOICE_SECRET_REFS.elevenlabs },
      );
    rt = await composeRuntime({
      env,
      dirs: appDirs({ env }),
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
    ({ app, token } = createDaemonApp(rt));
  });
  afterAll(async () => {
    await rt?.close();
  });

  it("without a voice row the registry's policy picks and the status says nothing is preferred", async () => {
    const s = await status();
    expect(s.available).toBe(true);
    expect(s.stt).toMatchObject({ name: "deepgram", kind: "cloud", policy: "cloud" });
    expect(s.tts).toMatchObject({ name: "cartesia", kind: "cloud", policy: "cloud" });
    expect(s.preferences).toEqual({ stt: null, tts: null, skipped: [] });
  });

  it("an enabled voice row is the preferred provider at the next status read and session, without a restart", async () => {
    const id = await enable("voice-elevenlabs");
    const s = await status();
    expect(s.tts).toMatchObject({ name: "elevenlabs", policy: "preferred" });
    expect(s.tts?.reason).toBe('"elevenlabs" selected in Extensions (voice-elevenlabs)');
    expect(s.preferences.tts).toEqual({
      name: "elevenlabs",
      source: "extension",
      extensionId: id,
      extension: "voice-elevenlabs",
      providers: ["elevenlabs"],
    });
    expect(s.preferences.stt).toBeNull();
    expect(s.preferences.skipped).toEqual([]);
    expect(s.statuses.tts.find((p) => p.name === "elevenlabs")?.selected).toBe(true);
    expect(s.statuses.tts.find((p) => p.name === "cartesia")?.selected).toBe(false);
    // The session opened now runs on the panel's choice; its audit row names it.
    const started = await post("/voice/sessions", {});
    expect(started.status).toBe(201);
    const view = VoiceSessionView.parse(await json(started));
    expect(view.providers.tts).toMatchObject({ name: "elevenlabs", policy: "preferred" });
    expect(view.providers.stt).toMatchObject({ name: "deepgram", policy: "cloud" });
    const startRow = (await rt.store.auditLog.list({ tool: VOICE_SESSION_AUDIT_TOOL } as never))
      .map((r) => JSON.parse(r.input_summary) as Json)
      .find((r) => r.id === view.id);
    expect(startRow).toMatchObject({ action: "start", stt: "deepgram", tts: "elevenlabs" });
    expect((await post(`/voice/sessions/${view.id}/stop`, {})).status).toBe(200);
  });

  it("two rows for one side: one is in force and the other says why not; a toggle applies next", async () => {
    const cartesiaId = await enable("voice-cartesia");
    let s = await status();
    expect(s.tts).toMatchObject({ name: "cartesia", policy: "preferred" });
    expect(s.preferences.tts).toMatchObject({ name: "cartesia", extensionId: cartesiaId });
    expect(s.preferences.skipped).toEqual([
      {
        extensionId: rows["voice-elevenlabs"],
        extension: "voice-elevenlabs",
        side: "tts",
        provider: "elevenlabs",
        reason: '"cartesia" (voice-cartesia) is preferred; one TTS provider is in force at a time',
      },
    ]);
    // Off in the panel: the other row is in force at the next read, nothing restarted, and
    // the switched-off row says so (its provider is out of the policy's reach too, below).
    expect((await post(`/extensions/${cartesiaId}/toggle`, { enabled: false })).status).toBe(200);
    s = await status();
    expect(s.tts).toMatchObject({ name: "elevenlabs", policy: "preferred" });
    expect(s.preferences.skipped).toEqual([
      {
        extensionId: cartesiaId,
        extension: "voice-cartesia",
        side: "tts",
        provider: "cartesia",
        reason: "switched off in Extensions",
      },
    ]);
    expect(s.statuses.tts.find((p) => p.name === "cartesia")).toEqual({
      name: "cartesia",
      kind: "cloud",
      available: false,
      reason: "switched off in Extensions",
      secretRef: VOICE_SECRET_REFS.cartesia,
      selected: false,
    });
    const started = await post("/voice/sessions", {});
    expect(started.status).toBe(201);
    const view = VoiceSessionView.parse(await json(started));
    expect(view.providers.tts.name).toBe("elevenlabs");
    expect((await post(`/voice/sessions/${view.id}/stop`, {})).status).toBe(200);
  });

  it("a cloud row without its key is skipped with the reference as the reason; the key back makes it preferred", async () => {
    const id = await enable("voice-deepgram");
    expect((await status()).stt).toMatchObject({ name: "deepgram", policy: "preferred" });
    await vault.delete("deepgram_api_key");
    let s = await status();
    // Not local, no cloud key: the registry's policy falls back to the fake; the row says why.
    expect(s.stt).toMatchObject({ name: "fake-stt", policy: "fake" });
    expect(s.preferences.stt).toBeNull();
    expect(s.preferences.skipped).toEqual([
      {
        extensionId: id,
        extension: "voice-deepgram",
        side: "stt",
        provider: "deepgram",
        reason: "no value for secret:deepgram_api_key; store the key with fr setup",
      },
      expect.objectContaining({
        extension: "voice-cartesia",
        reason: "switched off in Extensions",
      }),
    ]);
    expect(s.statuses.stt.find((p) => p.name === "deepgram")).toMatchObject({
      available: false,
      secretRef: VOICE_SECRET_REFS.deepgram,
      secretConfigured: false,
    });
    await vault.set("deepgram_api_key", KEYS.deepgram_api_key);
    s = await status();
    expect(s.stt).toMatchObject({ name: "deepgram", policy: "preferred" });
    expect(s.preferences.stt).toMatchObject({ name: "deepgram", extensionId: id });
    expect(s.preferences.skipped.map((p) => p.extension)).toEqual(["voice-cartesia"]);
  });

  it("the environment variables override the panel and the status says so", async () => {
    env[VOICE_PREFERENCE_ENV.tts] = "fake-tts";
    let s = await status();
    expect(s.tts).toMatchObject({ name: "fake-tts", kind: "fake", policy: "preferred" });
    expect(s.tts?.reason).toBe(`"fake-tts" set by ${VOICE_PREFERENCE_ENV.tts}`);
    expect(s.preferences.tts).toEqual({
      name: "fake-tts",
      source: "env",
      extensionId: null,
      extension: null,
      providers: ["fake-tts"],
    });
    // Rows sort by name: the switched-off cartesia row first, then the overridden one.
    expect(s.preferences.skipped).toEqual([
      expect.objectContaining({
        extension: "voice-cartesia",
        reason: "switched off in Extensions",
      }),
      expect.objectContaining({
        extension: "voice-elevenlabs",
        side: "tts",
        reason: `overridden by ${VOICE_PREFERENCE_ENV.tts}=fake-tts`,
      }),
    ]);
    // The STT side is untouched by a TTS override.
    expect(s.stt).toMatchObject({ name: "deepgram", policy: "preferred" });
    delete env[VOICE_PREFERENCE_ENV.tts];
    s = await status();
    expect(s.tts).toMatchObject({ name: "elevenlabs", policy: "preferred" });
  });

  it("a row whose providers this daemon does not register is reported, not silently ignored", async () => {
    const id = await enable("voice-local");
    const s = await status();
    // Cloud rows win over the local one; the local row says so for STT, and for TTS that
    // none of its providers is registered here would be the reason without the cloud row.
    expect(s.stt).toMatchObject({ name: "deepgram", policy: "preferred" });
    expect(s.preferences.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId: id,
          extension: "voice-local",
          side: "stt",
          reason: expect.stringContaining('"deepgram" (voice-deepgram) is preferred'),
        }),
        expect.objectContaining({
          extensionId: id,
          side: "tts",
          reason: expect.stringContaining('"elevenlabs" (voice-elevenlabs) is preferred'),
        }),
      ]),
    );
    await post(`/extensions/${rows["voice-elevenlabs"]}/toggle`, { enabled: false });
    const alone = await status();
    expect(alone.preferences.tts).toBeNull();
    expect(alone.preferences.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId: id,
          side: "tts",
          provider: null,
          reason: "none of kokoro, piper is registered in this daemon",
        }),
      ]),
    );
    // Nothing chosen for TTS, and both cloud TTS rows are switched off: the policy must not
    // reach for their keys (off means off), so the fake is what is left.
    expect(alone.preferences.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extension: "voice-cartesia",
          reason: "switched off in Extensions",
        }),
        expect.objectContaining({
          extension: "voice-elevenlabs",
          reason: "switched off in Extensions",
        }),
      ]),
    );
    expect(alone.tts).toMatchObject({ name: "fake-tts", policy: "fake" });
    expect(alone.statuses.tts.filter((p) => p.kind === "cloud").map((p) => p.reason)).toEqual([
      "switched off in Extensions",
      "switched off in Extensions",
    ]);
  });

  it("a switched-off cloud row is not used by the fallback: no audio reaches the provider and the row says why", async () => {
    // Review finding 1 of w3-o4-voice-prefs. The only STT providers here are the fake and
    // Deepgram, whose key stays in the vault: before this fix, switching the row off left the
    // policy free to send the microphone to Deepgram with no reason shown anywhere.
    const deepgramId = rows["voice-deepgram"];
    if (!deepgramId) throw new Error("no voice-deepgram row");
    expect((await status()).stt).toMatchObject({ name: "deepgram", policy: "preferred" });
    expect((await post(`/extensions/${deepgramId}/toggle`, { enabled: false })).status).toBe(200);
    const s = await status();
    expect(s.stt).toMatchObject({ name: "fake-stt", policy: "fake" });
    expect(s.preferences.stt).toBeNull();
    expect(s.preferences.skipped).toEqual(
      expect.arrayContaining([
        {
          extensionId: deepgramId,
          extension: "voice-deepgram",
          side: "stt",
          provider: "deepgram",
          reason: "switched off in Extensions",
        },
      ]),
    );
    // The status row says the same and the key was not even looked at (no secretConfigured).
    expect(s.statuses.stt.find((p) => p.name === "deepgram")).toEqual({
      name: "deepgram",
      kind: "cloud",
      available: false,
      reason: "switched off in Extensions",
      secretRef: VOICE_SECRET_REFS.deepgram,
      selected: false,
    });
    // A session started now runs on the fake; its audit row names no cloud provider.
    const started = await post("/voice/sessions", {});
    expect(started.status).toBe(201);
    const view = VoiceSessionView.parse(await json(started));
    expect(view.providers.stt).toMatchObject({ name: "fake-stt", policy: "fake" });
    const startRow = (await rt.store.auditLog.list({ tool: VOICE_SESSION_AUDIT_TOOL } as never))
      .map((r) => JSON.parse(r.input_summary) as Json)
      .find((r) => r.id === view.id);
    expect(startRow).toMatchObject({ action: "start", stt: "fake-stt" });
    expect((await post(`/voice/sessions/${view.id}/stop`, {})).status).toBe(200);
    // Back on: preferred again at the next read, no restart.
    expect((await post(`/extensions/${deepgramId}/toggle`, { enabled: true })).status).toBe(200);
    expect((await status()).stt).toMatchObject({ name: "deepgram", policy: "preferred" });
  });

  it("a cloud row whose grant no longer lists its key is skipped as not granted and never read", async () => {
    // Review finding 3 of w3-o4-voice-prefs: the human narrowed the row's secrets (applied at
    // once, no approval). The key is still in the vault; the row is the grant, so the daemon
    // neither prefers the provider nor falls back to it, and does not read the key.
    const deepgramId = rows["voice-deepgram"];
    if (!deepgramId) throw new Error("no voice-deepgram row");
    const narrowed = await rt.extensions.updatePermissions(deepgramId, { secrets: [] });
    expect(narrowed.permissions.secrets).toEqual([]);
    expect(narrowed.enabled).toBe(true);
    const s = await status();
    expect(s.stt).toMatchObject({ name: "fake-stt", policy: "fake" });
    expect(s.preferences.stt).toBeNull();
    expect(s.preferences.skipped).toEqual(
      expect.arrayContaining([
        {
          extensionId: deepgramId,
          extension: "voice-deepgram",
          side: "stt",
          provider: "deepgram",
          reason: "key not granted: secret:deepgram_api_key is not in the row's permissions",
        },
      ]),
    );
    expect(s.statuses.stt.find((p) => p.name === "deepgram")).toEqual({
      name: "deepgram",
      kind: "cloud",
      available: false,
      reason: "key not granted in Extensions",
      secretRef: VOICE_SECRET_REFS.deepgram,
      selected: false,
    });
    const started = await post("/voice/sessions", {});
    expect(started.status).toBe(201);
    const view = VoiceSessionView.parse(await json(started));
    expect(view.providers.stt.name).toBe("fake-stt");
    expect((await post(`/voice/sessions/${view.id}/stop`, {})).status).toBe(200);
  });
});
