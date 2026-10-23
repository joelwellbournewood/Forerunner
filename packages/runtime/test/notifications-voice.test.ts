import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  type Channel,
  NotificationEmitter,
  type NotificationRecord,
  Notifier,
  spokenAlert,
  VOICE_ALERTS_OFF,
  VOICE_NO_SHELL,
  VOICE_NOT_URGENT,
  VOICE_QUIET_HOURS,
  VOICE_SECRET_SHAPE,
  VoiceChannel,
} from "../src/notifications/index.ts";
import { collectingSink, FakeTts, VoiceProviderRegistry } from "../src/voice/pkg.ts";
import { SpeakSessions, VOICE_SPEAK_AUDIT_TOOL } from "../src/voice/speak.ts";
import { defaultChannels, note, type RecordedEvent } from "./notifications-helpers.ts";

/**
 * The voice notification channel (spec L.6 "TTS for alerts"; ADR 0063) over the notifier and
 * the daemon: an urgent notification is read aloud through the registry's TTS (the fake
 * provider on the simulated clock) on top of the toast when the human turned voice alerts on,
 * a desktop shell is attached and it is not quiet hours; otherwise the delivery row says why
 * and the other channels have already delivered. A credential shape is never spoken. Every
 * spoken alert leaves a `notify.voice` audit row and a `voice.speak` row.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
// Europe/Zurich is CEST (UTC+2) on these dates: 21:00Z = 23:00 local, 08:00Z = 10:00 local.
const DAY = "2026-10-20T08:00:00Z";
const NIGHT = "2026-10-20T21:00:00Z";
const QUIET = { start: "22:00", end: "07:00" };
const STEP_MS = 50;

async function pump(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Step the simulated clock until `p` settles (the TTS latency and retries run on it). */
async function drive<T>(clock: SimulatedClock, p: Promise<T>, limitMs = 30_000): Promise<T> {
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
    await pump(24);
    await clock.advance(STEP_MS);
    spent += STEP_MS;
  }
  return tracked;
}

interface VoiceWorld {
  clock: SimulatedClock;
  notifier: Notifier;
  tts: FakeTts;
  humanId: string;
  sessionId: string;
  shells: { count: number };
  events: RecordedEvent[];
  logs: LogRecord[];
  store: Awaited<ReturnType<typeof openStore>>;
  close(): Promise<void>;
}

async function voiceWorld(opts: {
  start?: string;
  prefs?: Record<string, unknown>;
  ttsAvailable?: boolean;
  shells?: number;
}): Promise<VoiceWorld> {
  const clock = new SimulatedClock(opts.start ?? DAY);
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({
    name: "J",
    email: "j@example.test",
    timezone: "Europe/Zurich",
    notify_prefs: { voice_alerts: true, ...(opts.prefs ?? {}) },
    default_autonomy: 2,
    monthly_cap_usd_micro: 150_000_000,
    locale: "en",
  });
  const agent = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  const session = await store.session.insert({ agent_id: agent.id });
  const tts = new FakeTts({
    clock,
    firstChunkLatencyMs: 200,
    chunkMs: 100,
    chunks: 2,
    available: opts.ttsAvailable !== false,
  });
  const speech = new SpeakSessions({
    registry: new VoiceProviderRegistry().registerTts(tts),
    store,
    clock,
    humanId: human.id,
    agentId: agent.id,
    sessionIdFor: async () => session.id,
    sink: () => collectingSink(),
  });
  const shells = { count: opts.shells ?? 1 };
  const voice = new VoiceChannel({
    clock,
    shellsConnected: () => shells.count,
    speak: async (req) => {
      const u = await speech.say({ text: req.text, subject: req.subject, source: "notification" });
      const r = await u.done;
      return {
        id: u.id,
        sentences: u.sentences.length,
        audioChunks: r.audioChunks,
        provider: r.provider,
        interrupted: r.state === "cancelled",
      };
    },
  });
  const { voice: _fake, ...fakes } = defaultChannels(clock);
  const events: RecordedEvent[] = [];
  const logs: LogRecord[] = [];
  const stopLogs = Logger.addSink((r) => logs.push(r));
  const channels: Channel[] = [...Object.values(fakes), voice];
  const notifier = new Notifier({
    clock,
    channels,
    humans: store.human,
    audit: store.auditLog,
    events: {
      async append(sessionId, type, payload) {
        events.push({ sessionId, type, payload });
      },
    },
    emitter: new NotificationEmitter(),
    retry: { attempts: 2, baseMs: 100, maxMs: 100 },
  });
  return {
    clock,
    notifier,
    tts,
    humanId: human.id,
    sessionId: session.id,
    shells,
    events,
    logs,
    store,
    async close() {
      stopLogs();
      await speech.close();
      await store.close();
    },
  };
}

const urgent = (humanId: string, over: Record<string, unknown> = {}) =>
  note(humanId, {
    kind: "budget_stop",
    title: "Alice stopped: budget cap reached (USD 2.00 spent)",
    body: "Three tasks done. One pull request is open.",
    dedupeKey: `budget:${Math.random()}`,
    ...over,
  });

describe("voice notification channel", () => {
  let w: VoiceWorld | null = null;
  afterEach(async () => {
    await w?.close();
    w = null;
  });

  it("spokenAlert reads the title as a sentence, then the body, cut to the limit", () => {
    expect(spokenAlert({ title: "Budget cap reached!", body: "Three done." })).toBe(
      "Budget cap reached. Three done.",
    );
    expect(spokenAlert({ title: "Kill switch", body: "" })).toBe("Kill switch.");
    expect(spokenAlert({ title: "T", body: "x".repeat(700) }, 100)).toHaveLength(100);
  });

  it("an urgent notification is spoken on top of the toast: sentences through TTS, both rows", async () => {
    w = await voiceWorld({});
    const n = urgent(w.humanId, { sessionId: w.sessionId });
    const r = await drive(w.clock, w.notifier.notify(n));
    expect(r.outcome).toBe("delivered");
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      "desktop:delivered",
      "voice:delivered",
    ]);
    expect(r.deliveries[1]?.reason).toBe("spoken: 3 sentence(s), 6 chunk(s) via fake-tts");
    expect(w.tts.calls.map((c) => c.text)).toEqual([
      "Alice stopped: budget cap reached (USD 2.00 spent).",
      "Three tasks done.",
      "One pull request is open.",
    ]);
    expect(w.tts.calls.every((c) => c.finished)).toBe(true);
    const humanId = w.humanId;
    const audits = (await w.store.auditLog.list({ tool: "notify.voice" } as never)).filter(
      (a) => a.human_id === humanId,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.allowed).toBe(true);
    expect(audits[0]?.result_summary).toContain("delivered after 1 attempt(s): spoken");
    const spoken = await w.store.auditLog.list({ tool: VOICE_SPEAK_AUDIT_TOOL } as never);
    expect(spoken).toHaveLength(1);
    expect(JSON.parse(spoken[0]?.input_summary ?? "{}")).toMatchObject({
      subject: { kind: "notification", id: r.id, notificationKind: "budget_stop" },
      source: "notification",
      sentences: 3,
    });
    // The session event carries both deliveries.
    const ev = w.events.find((e) => e.type === "notification")?.payload as Json;
    expect((ev.deliveries as Json[]).map((d) => d.channel)).toEqual(["desktop", "voice"]);
  });

  it("quiet hours: the toast still delivers at once, the voice is skipped with the reason", async () => {
    w = await voiceWorld({ start: NIGHT, prefs: { quiet_hours: QUIET } });
    const r = await drive(w.clock, w.notifier.notify(urgent(w.humanId)));
    expect(r.outcome).toBe("delivered");
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}:${d.reason}`)).toEqual([
      "desktop:delivered:desktop",
      `voice:skipped:${VOICE_QUIET_HOURS}`,
    ]);
    expect(w.tts.calls).toEqual([]);
  });

  it("voice alerts off: no voice row at all, and the settings view says why", async () => {
    w = await voiceWorld({ prefs: { voice_alerts: false } });
    const r = await drive(w.clock, w.notifier.notify(urgent(w.humanId)));
    expect(r.deliveries.map((d) => d.channel)).toEqual(["desktop"]);
    expect(w.tts.calls).toEqual([]);
    const view = await w.notifier.getPrefs(w.humanId);
    expect(view.prefs.voice_alerts).toBe(false);
    expect(view.channels.find((c) => c.name === "voice")).toEqual({
      name: "voice",
      available: true,
      configured: false,
      reason: VOICE_ALERTS_OFF,
    });
    await w.notifier.setPrefs(w.humanId, { voice_alerts: true });
    expect(
      (await w.notifier.getPrefs(w.humanId)).channels.find((c) => c.name === "voice")?.configured,
    ).toBe(true);
  });

  it("nobody at the desktop: skipped; a normal notification is never spoken, listed or not", async () => {
    w = await voiceWorld({
      shells: 0,
      prefs: { channels: { session_ended: ["voice", "desktop"] } },
    });
    const r = await drive(w.clock, w.notifier.notify(urgent(w.humanId)));
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}:${d.reason}`)).toEqual([
      "desktop:delivered:desktop",
      `voice:skipped:${VOICE_NO_SHELL}`,
    ]);
    w.shells.count = 1;
    const normal = await drive(w.clock, w.notifier.notify(note(w.humanId)));
    expect(normal.deliveries.map((d) => d.channel)).toEqual(["desktop"]);
    expect(w.tts.calls).toEqual([]);
    expect(
      new VoiceChannel({
        clock: w.clock,
        shellsConnected: () => 1,
        speak: async () => {
          throw new Error("not called");
        },
      }).accepts(note(w.humanId), {
        human: { id: w.humanId, name: "J", email: "", timezone: "Europe/Zurich" },
        prefs: { ...(await w.notifier.getPrefs(w.humanId)).prefs, timezone: "Europe/Zurich" },
      }),
    ).toBe(VOICE_NOT_URGENT);
  });

  it("an explicit list naming only voice: the announcer still speaks and that is the delivery", async () => {
    w = await voiceWorld({ prefs: { channels: { budget_stop: ["voice"] } } });
    const r = await drive(w.clock, w.notifier.notify(urgent(w.humanId)));
    expect(r.outcome).toBe("delivered");
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual(["voice:delivered"]);
    expect(w.tts.calls.length).toBeGreaterThan(0);
  });

  it("never speaks a secret: a credential shape in the text is refused, not spoken, not logged", async () => {
    w = await voiceWorld({});
    // not-a-secret
    const token = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");
    const r = await drive(
      w.clock,
      w.notifier.notify(urgent(w.humanId, { body: `The run leaked token=${token} to the log.` })),
    );
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      "desktop:delivered",
      "voice:unavailable",
    ]);
    expect(r.deliveries[1]?.reason).toBe(VOICE_SECRET_SHAPE);
    expect(r.deliveries[1]?.attempts).toBe(1);
    expect(w.tts.calls).toEqual([]);
    const audits = await w.store.auditLog.list({ tool: "notify.voice" } as never);
    expect(audits.at(-1)?.allowed).toBe(false);
    for (const a of audits) {
      expect(a.input_summary).not.toContain(token);
      expect(a.result_summary).not.toContain(token);
    }
    expect(w.logs.some((l) => JSON.stringify(l).includes(token))).toBe(false);
  });

  it("no usable TTS provider: unavailable, not retried; the toast delivered anyway", async () => {
    w = await voiceWorld({ ttsAvailable: false });
    const r = await drive(w.clock, w.notifier.notify(urgent(w.humanId)));
    expect(r.outcome).toBe("delivered");
    expect(r.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      "desktop:delivered",
      "voice:unavailable",
    ]);
    expect(r.deliveries[1]?.reason).toContain("no TTS provider available");
    expect(r.deliveries[1]?.attempts).toBe(1);
  });

  it("a test send speaks the test when voice alerts are on", async () => {
    w = await voiceWorld({});
    const out = await drive(w.clock, w.notifier.sendTest(w.humanId));
    expect(out.find((d) => d.channel === "voice")).toMatchObject({ status: "delivered" });
    expect(w.tts.calls.map((c) => c.text)).toEqual([
      "Test notification from Forerunner.",
      "This is a test of the voice channel.",
      "If you can read this, the channel works.",
    ]);
  });
});

describe("voice alerts wired into the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock("2026-03-05T08:00:00Z"); // 09:00 in Europe/Zurich
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
  const nextRecord = (kind: string) =>
    new Promise<NotificationRecord>((resolve) => {
      const off = rt.notifier.emitter.on("record", (r) => {
        if (r.notification.kind !== kind || r.outcome === "held") return;
        off();
        resolve(r);
      });
    });
  const insertRequest = (blocking: boolean, why: string) =>
    rt.store.humanRequest.insert({
      human_id: rt.human.id,
      project_id: null,
      task_id: null,
      session_id: null,
      kind: "approval",
      why,
      steps: [],
      options: [],
      blocking,
      risk: "low",
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-notify-voice-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: {
        humanName: "J",
        email: "j@example.test",
        timezone: "Europe/Zurich",
        agentName: "Alice",
      },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      notifications: { platform: "linux", osNotifier: false },
      voice: { tts },
    });
    ({ app, token } = createDaemonApp(rt));
  });
  afterAll(async () => {
    await rt?.close();
  });

  it("the prefs route lists the channel; on, with a shell attached, a blocking request is spoken", async () => {
    const before = await json(await req("/notifications/prefs"));
    expect((before.prefs as Json).voice_alerts).toBe(false);
    expect((before.channels as Json[]).find((c) => c.name === "voice")).toEqual({
      name: "voice",
      available: true,
      configured: false,
      reason: VOICE_ALERTS_OFF,
    });
    const after = await json(
      await req("/notifications/prefs", {
        method: "PUT",
        body: JSON.stringify({ voice_alerts: true }),
      }),
    );
    expect((after.prefs as Json).voice_alerts).toBe(true);
    expect((after.channels as Json[]).find((c) => c.name === "voice")).toMatchObject({
      configured: true,
      reason: null,
    });
    // A shell on /events (token in the header, nothing declared): someone is at the desktop.
    const res = await req("/events", { headers: { accept: "text/event-stream" } });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    await reader.read();
    expect(rt.shells.count()).toBe(1);
    const pending = nextRecord("request_blocking");
    await insertRequest(true, "Deploy to production needs your approval.");
    const record = await drive(clock, pending);
    expect(record.deliveries.map((d) => `${d.channel}:${d.status}:${d.reason}`)).toEqual([
      "desktop:delivered:shell",
      "voice:delivered:spoken: 2 sentence(s), 4 chunk(s) via fake-tts",
    ]);
    expect(tts.calls.map((c) => c.text)).toEqual([
      `${record.notification.title.replace(/[.!?]+$/, "")}.`,
      "Deploy to production needs your approval.",
    ]);
    // A non-blocking request is normal: the toast only, nothing spoken.
    const normal = nextRecord("request_opened");
    await insertRequest(false, "Information is needed.");
    const plain = await drive(clock, normal);
    expect(plain.deliveries.map((d) => d.channel)).toEqual(["desktop"]);
    expect(tts.calls).toHaveLength(2);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    // With the shell gone the next urgent one is skipped as "no desktop shell attached".
    const again = nextRecord("request_blocking");
    await insertRequest(true, "Another approval.");
    const skipped = await drive(clock, again);
    expect(skipped.deliveries.find((d) => d.channel === "voice")).toMatchObject({
      status: "skipped",
      reason: VOICE_NO_SHELL,
    });
    expect(tts.calls).toHaveLength(2);
  });
});
