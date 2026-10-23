import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  type AgentRow,
  type DeviceRow,
  type HumanRow,
  type JsonObject,
  openStore,
  type StateStore,
} from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { CommandLoop, sessionCommandPorts } from "../src/loop/commands.ts";
import { RemoteCommandWatcher, VoiceEnvelope } from "../src/remote/index.ts";
import { Scheduler } from "../src/session/triggers.ts";
import { FakeStt, type FakeSttScript, FakeTts } from "../src/voice/pkg.ts";
import {
  toFrames,
  VOICE_RELAY_MAX_AGE_MS,
  VOICE_RELAY_MAX_PCM_BASE64,
  VoiceRelay,
  type VoiceRelayRequest,
  type VoiceRelayResult,
} from "../src/voice/relay.ts";

/**
 * The phone's push-to-talk turn relayed to the PC (spec R.5, O; ADR 0080). Part one: the
 * daemon's remote watcher takes a `kind: "voice"` envelope, hands the recording (or the
 * typed line) to the voice port, writes the PC's reply into the command's result and drops
 * the audio from the shared row; a malformed envelope and a PC without voice fail visibly.
 * Part two: `VoiceRelay` over the composed runtime's voice sessions with the fake STT and
 * TTS: a recorded turn is pushed as frames between press and release and comes back as the
 * transcript and the spoken reply, a typed line runs the text fallback, and one session is
 * held per phone so a spoken yes in the next turn answers the card the last one read back.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const STATUS_REPLY = "The session on PharmaWatch completed. One pull request is open.";

/** 16 kHz mono PCM of a tone the fake STT accepts as speech, base64. */
function tonePcm(ms: number, rate = 16_000): string {
  const n = Math.round((ms / 1000) * rate);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000);
  return Buffer.from(pcm.buffer).toString("base64");
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

async function drive<T>(clock: SimulatedClock, p: Promise<T>, limitMs = 60_000): Promise<T> {
  let done = false;
  const tracked = p.then(
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
    await clock.advance(50);
    spent += 50;
  }
  return tracked;
}

describe("the PC's watcher runs the phone's voice envelope", () => {
  let store: StateStore;
  let clock: SimulatedClock;
  let human: HumanRow;
  let agent: AgentRow;
  let phone: DeviceRow;
  let pc: DeviceRow;
  let commands: CommandLoop;
  let calls: VoiceRelayRequest[];

  beforeEach(async () => {
    clock = new SimulatedClock("2026-10-20T08:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    human = await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 0,
      locale: "en",
    });
    agent = await store.agent.insert({
      name: "Alice",
      owner_human_id: human.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    phone = await store.device.register({
      owner_human_id: human.id,
      name: "J's phone",
      platform: "android",
      public_key: ["pk-", "P".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
    pc = await store.device.register({
      owner_human_id: human.id,
      name: "J's PC",
      platform: "linux",
      public_key: ["pk-", "D".repeat(40)].join(""), // not-a-secret
      kind: "desktop",
    });
    const kill = new KillSwitch(new TokenIssuer({ now: () => clock.now() }));
    const scheduler = new Scheduler({ clock, start: async () => {} });
    commands = new CommandLoop({
      store,
      clock,
      ports: { chfPerUsd: async () => 0.8, ...sessionCommandPorts({ scheduler, kill, store }) },
    });
    await commands.start();
    calls = [];
  });
  afterEach(async () => {
    commands.stop();
    await store.close();
  });

  const fakeVoice = async (req: VoiceRelayRequest): Promise<VoiceRelayResult> => {
    calls.push(req);
    return {
      source: req.audio ? "audio" : "text",
      sessionId: "voice-1",
      turn: calls.length,
      said: req.transcript ?? "What is the status?",
      heard: STATUS_REPLY,
      pending: null,
      approved: null,
      error: null,
      audioChunks: 4,
      totalToFirstAudioMs: 640,
    };
  };

  const watcher = (voice: typeof fakeVoice | null) =>
    new RemoteCommandWatcher({
      store,
      clock,
      kill: new KillSwitch(new TokenIssuer({ now: () => clock.now() })),
      start: async () => ({ id: "x", result: { status: "started" } as never }),
      commands,
      chat: null,
      voice,
      conversationSessionId: async () => "conv",
      deviceId: pc.id,
      agentId: agent.id,
      humanId: human.id,
    });

  const enqueue = (params: JsonObject) =>
    store.remoteCommand.enqueue({ device_id: phone.id, target: "pc", command: "start", params });

  it("a recorded turn reaches the voice port as audio; the reply lands in the result and the audio leaves the row", async () => {
    const pcm = tonePcm(400);
    const row = await enqueue({
      v: 1,
      kind: "voice",
      projectId: "proj-1",
      clientId: "voice-turn-0001",
      audio: { pcm, sampleRate: 16_000, channels: 1, durationMs: 400 },
    });
    expect(await watcher(fakeVoice).drain()).toBe(1);
    expect(calls).toEqual([
      {
        deviceId: phone.id,
        projectId: "proj-1",
        audio: { pcm, sampleRate: 16_000, channels: 1 },
      },
    ]);
    const done = await store.remoteCommand.mustGet(row.id);
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({
      kind: "voice",
      source: "audio",
      said: "What is the status?",
      reply: STATUS_REPLY,
      clientId: "voice-turn-0001",
      issuedBy: phone.id,
    });
    // No audio stays in the shared store: only its format and length.
    expect(done.params).toMatchObject({
      kind: "voice",
      audio: { dropped: true, sampleRate: 16_000, channels: 1, bytes: 12_800, durationMs: 400 },
    });
    expect(JSON.stringify(done.params)).not.toContain(pcm.slice(0, 64));
  });

  it("a typed line (no recorder on the phone) is relayed as the transcript", async () => {
    const row = await enqueue({ v: 1, kind: "voice", transcript: "What is the status?" });
    expect(await watcher(fakeVoice).drain()).toBe(1);
    expect(calls[0]).toEqual({
      deviceId: phone.id,
      projectId: null,
      transcript: "What is the status?",
    });
    expect((await store.remoteCommand.mustGet(row.id)).result).toMatchObject({
      kind: "voice",
      source: "text",
      reply: STATUS_REPLY,
    });
  });

  it("refuses an envelope with both or neither, an oversized recording, and fails without voice on the PC", async () => {
    const both = await enqueue({
      v: 1,
      kind: "voice",
      transcript: "hi",
      audio: { pcm: tonePcm(20), sampleRate: 16_000, channels: 1 },
    });
    const neither = await enqueue({ v: 1, kind: "voice" });
    const tooLong = await enqueue({
      v: 1,
      kind: "voice",
      audio: { pcm: "A".repeat(VOICE_RELAY_MAX_PCM_BASE64 + 4), sampleRate: 16_000, channels: 1 },
    });
    expect(await watcher(fakeVoice).drain()).toBe(3);
    for (const id of [both.id, neither.id, tooLong.id]) {
      const r = await store.remoteCommand.mustGet(id);
      expect(r.status).toBe("failed");
      expect(String((r.result as { error: string }).error)).toMatch(/^malformed voice envelope/);
    }
    expect(calls).toHaveLength(0);
    expect(VoiceEnvelope.safeParse({ v: 1, kind: "voice", transcript: "ok" }).success).toBe(true);

    const row = await enqueue({ v: 1, kind: "voice", transcript: "hello" });
    expect(await watcher(null).drain()).toBe(1);
    const failed = await store.remoteCommand.mustGet(row.id);
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({ code: "unavailable" });
  });

  it("no recording stays in the shared row on any outcome: malformed, stale, a replay, a revoked device", async () => {
    const pcm = tonePcm(200);
    const leftovers = async (id: string) => {
      const r = await store.remoteCommand.mustGet(id);
      expect(JSON.stringify(r.params)).not.toContain(pcm.slice(0, 64));
      expect(JSON.stringify(r.params)).not.toContain("AAAAAAAAAAAAAAAA");
      return r;
    };
    // Malformed: over the byte bound.
    const tooLong = await enqueue({
      v: 1,
      kind: "voice",
      audio: { pcm: "A".repeat(VOICE_RELAY_MAX_PCM_BASE64 + 4), sampleRate: 16_000, channels: 1 },
    });
    // A replay of a turn already handled (same clientId).
    const turn = {
      v: 1,
      kind: "voice",
      clientId: "voice-turn-dup1",
      audio: { pcm, sampleRate: 16_000, channels: 1, durationMs: 200 },
    };
    const first = await enqueue(turn);
    const again = await enqueue(turn);
    expect(await watcher(fakeVoice).drain()).toBe(3);
    expect(calls).toHaveLength(1);
    expect((await leftovers(tooLong.id)).status).toBe("failed");
    expect((await leftovers(first.id)).status).toBe("done");
    const dup = await leftovers(again.id);
    expect(dup.status).toBe("failed");
    expect(dup.result).toMatchObject({ code: "duplicate" });
    expect(dup.params).toMatchObject({ audio: { dropped: true, bytes: 6_400, durationMs: 200 } });

    // Stale: the PC was offline; the turn is refused, never run, and its audio goes.
    const stale = await enqueue({
      v: 1,
      kind: "voice",
      clientId: "voice-turn-old1",
      audio: { pcm, sampleRate: 16_000, channels: 1 },
    });
    await clock.advance(VOICE_RELAY_MAX_AGE_MS + 1_000);
    expect(await watcher(fakeVoice).drain()).toBe(1);
    expect(calls).toHaveLength(1);
    const old = await leftovers(stale.id);
    expect(old.status).toBe("failed");
    expect(old.result).toMatchObject({ kind: "voice", status: "expired", code: "timeout" });

    // A revoked phone: refused by the authorisation, the audio dropped all the same.
    const fromRevoked = await enqueue({
      v: 1,
      kind: "voice",
      audio: { pcm, sampleRate: 16_000, channels: 1 },
    });
    await store.device.revoke(phone.id, (await store.device.mustGet(phone.id)).version);
    await watcher(fakeVoice).handle(await store.remoteCommand.mustGet(fromRevoked.id));
    expect((await leftovers(fromRevoked.id)).result).toMatchObject({
      error: expect.stringMatching(/revoked/),
    });
    expect(calls).toHaveLength(1);
  });

  it("bounds a recording by its duration, not only its bytes", () => {
    // 6 s at 8 kHz mono is under the byte bound but over 5 s.
    const slow = { pcm: tonePcm(6_000, 8_000), sampleRate: 8_000, channels: 1 };
    expect(VoiceEnvelope.safeParse({ v: 1, kind: "voice", audio: slow }).success).toBe(false);
    expect(() => toFrames(slow)).toThrow(/longer than 5 s/);
    // 4 s at 8 kHz mono and exactly 5 s at 16 kHz mono are fine.
    const ok = { pcm: tonePcm(4_000, 8_000), sampleRate: 8_000, channels: 1 };
    expect(VoiceEnvelope.safeParse({ v: 1, kind: "voice", audio: ok }).success).toBe(true);
    const five = { pcm: tonePcm(5_000), sampleRate: 16_000, channels: 1 };
    expect(VoiceEnvelope.safeParse({ v: 1, kind: "voice", audio: five }).success).toBe(true);
  });

  it("splits a recording into 20 ms frames on the capture timeline", () => {
    const frames = toFrames({ pcm: tonePcm(100), sampleRate: 16_000, channels: 1 });
    expect(frames).toHaveLength(5);
    expect(frames.map((f) => f.timestampMs)).toEqual([0, 20, 40, 60, 80]);
    expect(frames.every((f) => f.pcm.length === 320)).toBe(true);
  });
});

describe("VoiceRelay over the daemon's voice sessions", () => {
  let rt: RuntimeApp;
  let relay: VoiceRelay;
  let projectId = "";
  const clock = new SimulatedClock("2026-11-03T08:00:00Z");
  const scripts: FakeSttScript[] = [];
  const stt = new FakeStt({
    clock,
    scripts: (turn) => scripts[turn] ?? { final: "" },
    finalDelayMs: 300,
  });
  const tts = new FakeTts({ clock, firstChunkLatencyMs: 200, chunkMs: 100, chunks: 2 });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-voice-relay-"));
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
    relay = new VoiceRelay(rt.voice, { clock });
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
    await relay?.close();
    await rt?.close();
  });

  it("a recorded turn is transcribed by the PC's STT and answered by its agent", async () => {
    scripts[stt.sessions.length] = { final: "What is the status?" };
    const r = await drive(
      clock,
      relay.turn({
        deviceId: "phone-1",
        audio: { pcm: tonePcm(400), sampleRate: 16_000, channels: 1 },
      }),
    );
    expect(r).toMatchObject({
      source: "audio",
      said: "What is the status?",
      heard: STATUS_REPLY,
      pending: null,
      error: null,
    });
    expect(r.audioChunks).toBeGreaterThan(0);
    expect(relay.openSessions).toBe(1);
    // The turn is a voice.turn row on the conversation session, like a turn on the PC.
    const rows = (await rt.store.auditLog.list({ tool: "voice.session" } as never)).length;
    expect(rows).toBeGreaterThan(0);
  });

  it("a typed line reuses the phone's session; a spoken yes in the next turn answers the read-back", async () => {
    const first = await drive(
      clock,
      relay.turn({ deviceId: "phone-1", projectId, transcript: "What is the status?" }),
    );
    expect(first.source).toBe("text");
    expect(first.heard).toBe(STATUS_REPLY);
    const ask = await drive(
      clock,
      relay.turn({ deviceId: "phone-1", projectId, transcript: "Give it 20 francs tonight." }),
    );
    expect(ask.sessionId).toBe(first.sessionId);
    expect(ask.pending).toMatchObject({ decision: "needs_yes", commands: ["budget.set"] });
    expect(ask.heard).toBe(ask.pending?.readback);
    const yes = await drive(
      clock,
      relay.turn({ deviceId: "phone-1", projectId, transcript: "Yes." }),
    );
    expect(yes.sessionId).toBe(first.sessionId);
    expect(yes.pending).toBeNull();
    expect(yes.approved).toBe(true);
    expect(relay.openSessions).toBe(1);
    // Another phone gets its own session.
    const other = await drive(clock, relay.turn({ deviceId: "phone-2", transcript: "Note that." }));
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(relay.openSessions).toBe(2);
  });

  it("refuses a turn with both or neither input, and closes its sessions", async () => {
    await expect(relay.turn({ deviceId: "phone-1" })).rejects.toThrow(/audio or a transcript/);
    await expect(
      relay.turn({
        deviceId: "phone-1",
        transcript: "x",
        audio: { pcm: tonePcm(20), sampleRate: 16_000, channels: 1 },
      }),
    ).rejects.toThrow(/audio or a transcript/);
    await relay.close();
    expect(relay.openSessions).toBe(0);
  });
});
