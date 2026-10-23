import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAEMON_ROUTES,
  ProjectSummary,
  SpeakEventView,
  SpeakView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  collectingSink,
  FakeTts,
  splitSentences,
  VoiceProviderRegistry,
} from "../src/voice/pkg.ts";
import {
  DEFAULT_AWAIT_LISTENER_MS,
  SpeakSessions,
  VOICE_SPEAK_AUDIT_TOOL,
} from "../src/voice/speak.ts";

/**
 * The speak routes (spec A.6 "readable aloud", L.6 "TTS for summaries"; ADR 0063): the project
 * summary and a session summary read aloud sentence by sentence through the registry's TTS
 * (the fake provider, every delay on the simulated clock), streamed to the shell as the voice
 * loop's replies are (`audio` frames over SSE), with the text echoed, cancellable, one voice at
 * a time, one `voice.speak` row and audit row per utterance and no audio stored; refused for
 * another human's project or session; the `summary.speak` command on the same path; and a
 * composition without a TTS provider answering the reason. No model credential is needed.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const jsonList = async (r: Response): Promise<Json[]> => (await r.json()) as Json[];
const STEP_MS = 50;

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Step the simulated clock until `p` settles (TTS latency and playback run on it). */
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

describe("speak routes on the composed daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  let otherProjectId = "";
  let sessionId = "";
  let otherSessionId = "";
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
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
  const post = (path: string, body: unknown = {}) =>
    req(path, { method: "POST", body: JSON.stringify(body) });
  const events = async (id: string, afterSeq = 0) =>
    (await jsonList(await req(`/speak/${id}/events?afterSeq=${afterSeq}`))).map((e) =>
      SpeakEventView.parse(e),
    );
  const untilEnded = (id: string) =>
    drive(
      clock,
      (async () => {
        for (;;) {
          const v = SpeakView.parse(await json(await req(`/speak/${id}`)));
          if (v.state !== "speaking") return v;
          await settle(4);
        }
      })(),
    );

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-speak-routes-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    // No model provider on purpose: reading a summary aloud needs no model credential.
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: { tts },
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
      summary_cache: {
        last_session: {
          id: "s-old",
          ended_at: "2026-11-02T22:00:00.000Z",
          summary: "Indexed the docs and opened a PR.",
          stop_reason: "completed",
        },
        next_steps: ["Review PR 12", "Plan the deploy"],
        open_questions: 1,
      },
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
      author_human: rt.human.id,
    });
    projectId = p.id;
    // Another human's project and session on the same (shared) store.
    const other = await rt.store.human.insert({
      name: "Mara",
      email: "mara@example.test",
      timezone: "Europe/Zurich",
    });
    const otherAgent = await rt.store.agent.insert({
      name: "Bob",
      owner_human_id: other.id,
      kind: "principal",
      memory_location: "",
    });
    const op = await rt.store.project.insert({
      name: "Mara's project",
      goal: "Hers",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 0,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [otherAgent.id] },
      small_project_mode: false,
      active: true,
      author_human: other.id,
    });
    otherProjectId = op.id;
    const s = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: p.id,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1_000_000,
      step_cap: 100,
      spent_usd_micro: 0,
      steps: 3,
      started_at: clock.nowIso(),
      status: "completed",
      summary: "Three tasks done. One pull request is open. Nothing needs you.",
      handoff: {},
      runner: "pc",
    });
    sessionId = s.id;
    const os = await rt.store.session.insert({
      agent_id: otherAgent.id,
      project_id: op.id,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 0,
      step_cap: 100,
      spent_usd_micro: 0,
      steps: 0,
      started_at: clock.nowIso(),
      status: "completed",
      summary: "Hers.",
      handoff: {},
      runner: "pc",
    });
    otherSessionId = os.id;
  });
  afterAll(async () => {
    await rt?.close();
  });

  it("reads the project summary aloud: sentences in order through TTS, the text echoed, the frames and the rows", async () => {
    for (const key of ["speakProject", "speakSession", "speak", "cancelSpeak", "speakEvents"])
      expect(DAEMON_ROUTES).toHaveProperty(key);
    const summary = ProjectSummary.parse(await json(await req(`/projects/${projectId}/summary`)));
    const callsBefore = tts.calls.length;
    const started = await post(`/projects/${projectId}/speak`, {});
    expect(started.status).toBe(201);
    const view = SpeakView.parse(await json(started));
    expect(view).toMatchObject({
      subject: { kind: "project", id: projectId, name: "PharmaWatch" },
      state: "speaking",
      text: summary.spoken,
      heard: "",
      audioChunks: 0,
      audioStored: false,
      provider: { name: "fake-tts", kind: "fake" },
    });
    expect(view.sentences).toEqual(splitSentences(summary.spoken));
    expect(view.sentences.length).toBeGreaterThanOrEqual(6);
    const ended = await untilEnded(view.id);
    expect(ended).toMatchObject({
      state: "done",
      heard: view.sentences.join(" "),
      unspokenText: null,
      audioChunks: view.sentences.length * 2,
      error: null,
    });
    expect(ended.endedAt).not.toBeNull();
    // Nobody attached to the stream: playback held for the grace period, then went to the sink.
    expect(ended.firstAudioMs).toBe(DEFAULT_AWAIT_LISTENER_MS);
    // Every sentence synthesised in order, each one finished (none aborted).
    const calls = tts.calls.slice(callsBefore);
    expect(calls.map((c) => c.text)).toEqual(view.sentences);
    expect(calls.every((c) => c.finished && !c.aborted)).toBe(true);
    // The kept frames: the sentences up front, first audio, the end, the record; audio is live only.
    const seen = await events(view.id);
    const types = seen.map((e) => e.type);
    expect(types.filter((t) => t === "sentence")).toHaveLength(view.sentences.length);
    for (const t of ["speaking_start", "speaking_end", "speak.done"]) expect(types).toContain(t);
    expect(types).not.toContain("audio");
    const doneFrame = seen.find((e) => e.type === "speak.done");
    expect((doneFrame?.data as { record: Json } | undefined)?.record).toMatchObject({
      state: "done",
      heard: ended.heard,
    });
    expect(await events(view.id, seen.at(-1)?.seq ?? 0)).toEqual([]);
    expect((await req(`/speak/${view.id}/events?afterSeq=abc`)).status).toBe(409);
    // One voice.speak row on the conversation session (the text as heard, never audio) and one
    // audit row with the counts and the provider, never the text.
    const rows = (await rt.store.event.list(ended.conversationSessionId))
      .filter((e) => e.type === "voice.speak")
      .map((e) => e.payload as Json);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: view.id,
      subject: { kind: "project", id: projectId },
      source: "ui",
      state: "done",
      heard: ended.heard,
      sentences: view.sentences.length,
      audioChunks: ended.audioChunks,
      audioStored: false,
      interrupted: false,
      provider: "fake-tts",
    });
    const audits = await rt.store.auditLog.list({ tool: VOICE_SPEAK_AUDIT_TOOL } as never);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.allowed).toBe(true);
    expect(JSON.parse(audits[0]?.input_summary ?? "{}")).toMatchObject({
      id: view.id,
      subject: { kind: "project" },
      sentences: view.sentences.length,
      provider: "fake-tts",
    });
    expect(audits[0]?.input_summary).not.toContain("PharmaWatch.");
    expect(audits[0]?.result_summary).toContain("done");
  });

  it("streams the frames over SSE with the loop's audio shape, announces the start on /events, and a cancel is immediate", async () => {
    const bus = await app.request(`/events?token=${token}`, {
      headers: { accept: "text/event-stream" },
    });
    const busReader = bus.body?.getReader();
    if (!busReader) throw new Error("no bus body");
    let busText = new TextDecoder().decode((await busReader.read()).value);
    const started = SpeakView.parse(await json(await post(`/sessions/${sessionId}/speak`, {})));
    expect(started.subject).toEqual({ kind: "session", id: sessionId, projectId });
    expect(started.sentences).toEqual([
      "Three tasks done.",
      "One pull request is open.",
      "Nothing needs you.",
    ]);
    while (!busText.includes("event: speak.started")) {
      busText += new TextDecoder().decode((await busReader.read()).value);
    }
    expect(busText).toContain(`"id":"${started.id}"`);
    expect(busText).toContain('"kind":"session"');
    await busReader.cancel();

    const ac = new AbortController();
    const res = await app.request(`/speak/${started.id}/events?token=${token}&afterSeq=0`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let text = "";
    // The first sentence plays (first audio at 200 ms, two 100 ms chunks); cancel during the second.
    const read = (async () => {
      while (!text.includes('"sentenceIndex":1')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    })();
    await drive(clock, read, 2_000);
    expect(text).toContain("event: speak.event");
    expect(text).toContain('"type":"sentence"');
    expect(text).toContain('"type":"speaking_start"');
    expect(text).toContain('"type":"audio"');
    expect(text).toContain('"pcm":"');
    expect(text).toContain('"sampleRate":16000');
    const cancelled = SpeakView.parse(await json(await post(`/speak/${started.id}/cancel`, {})));
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.endedAt).not.toBeNull();
    ac.abort();
    const after = await untilEnded(started.id);
    expect(after.state).toBe("cancelled");
    expect(after.heard).toBe("Three tasks done. One pull request is open.");
    expect(after.unspokenText).toBe("Nothing needs you.");
    expect(after.audioChunks).toBeLessThan(6);
    // The provider's calls in flight (the sentence playing and the one synthesised ahead of
    // it) were aborted; nothing after the cancel finished.
    const mine = tts.calls.filter((c) => started.sentences.includes(c.text));
    expect(mine.some((c) => c.aborted)).toBe(true);
    expect(mine.filter((c) => c.text === "Nothing needs you.").every((c) => !c.finished)).toBe(
      true,
    );
    const row = (await rt.store.event.list(after.conversationSessionId))
      .filter((e) => e.type === "voice.speak")
      .map((e) => e.payload as Json)
      .find((r) => r.id === started.id);
    expect(row).toMatchObject({
      state: "cancelled",
      interrupted: true,
      heard: after.heard,
      unspokenText: "Nothing needs you.",
      subject: { kind: "session", id: sessionId },
    });
    // A second cancel is a no-op; the finished utterance still answers GET and an events read.
    expect(SpeakView.parse(await json(await post(`/speak/${started.id}/cancel`, {}))).state).toBe(
      "cancelled",
    );
    expect((await events(started.id)).some((e) => e.type === "speak.done")).toBe(true);
  });

  it("playback waits for the player's stream: a late subscriber still gets the first words", async () => {
    const started = SpeakView.parse(await json(await post(`/sessions/${sessionId}/speak`, {})));
    // The TTS has the first chunk after 200 ms; the player attaches at 400 ms (a slow round
    // trip). Without the hold the first frames would already be gone (audio is live only).
    for (let t = 0; t < 400; t += STEP_MS) {
      await settle(24);
      await clock.advance(STEP_MS);
    }
    await settle(24);
    expect(tts.calls.some((c) => c.text === "Three tasks done." && c.firstChunkAtMs !== null)).toBe(
      true,
    );
    expect(SpeakView.parse(await json(await req(`/speak/${started.id}`))).audioChunks).toBe(0);
    const ac = new AbortController();
    const res = await app.request(`/speak/${started.id}/events?token=${token}&afterSeq=0`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let text = "";
    const read = (async () => {
      while (!text.includes('"type":"audio"')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    })();
    await drive(clock, read, 2_000);
    const firstAudio = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; data: Json })
      .find((f) => f.type === "audio");
    expect(firstAudio?.data).toMatchObject({ sentenceIndex: 0, timestampMs: 0 });
    ac.abort();
    const ended = await untilEnded(started.id);
    expect(ended.state).toBe("done");
    expect(ended.firstAudioMs).toBeGreaterThanOrEqual(400);
    expect(ended.firstAudioMs).toBeLessThan(DEFAULT_AWAIT_LISTENER_MS);
  });

  it("one voice: a new utterance cancels the one in flight", async () => {
    const first = SpeakView.parse(await json(await post(`/projects/${projectId}/speak`, {})));
    await drive(clock, settle(4), 300);
    const second = SpeakView.parse(await json(await post(`/sessions/${sessionId}/speak`, {})));
    expect(second.id).not.toBe(first.id);
    const firstEnded = await untilEnded(first.id);
    expect(firstEnded.state).toBe("cancelled");
    const secondEnded = await untilEnded(second.id);
    expect(secondEnded.state).toBe("done");
    expect(secondEnded.heard).toBe(
      "Three tasks done. One pull request is open. Nothing needs you.",
    );
  });

  it("refuses another human's project or session, a session without a summary, and unknown ids", async () => {
    const theirs = await post(`/projects/${otherProjectId}/speak`, {});
    expect(theirs.status).toBe(403);
    expect(await json(theirs)).toMatchObject({ code: "forbidden", message: "not your project" });
    const theirSession = await post(`/sessions/${otherSessionId}/speak`, {});
    expect(theirSession.status).toBe(403);
    expect(await json(theirSession)).toMatchObject({ code: "forbidden" });
    const empty = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 0,
      step_cap: 100,
      spent_usd_micro: 0,
      steps: 0,
      started_at: clock.nowIso(),
      status: "running",
      summary: "",
      handoff: {},
      runner: "pc",
    });
    const noSummary = await post(`/sessions/${empty.id}/speak`, {});
    expect(noSummary.status).toBe(409);
    expect(await json(noSummary)).toMatchObject({
      code: "conflict",
      details: { cause: "validation" },
    });
    expect((await post("/projects/nope/speak", {})).status).toBe(404);
    expect((await post("/sessions/nope/speak", {})).status).toBe(404);
    expect((await req("/speak/nope")).status).toBe(404);
    expect((await post("/speak/nope/cancel", {})).status).toBe(404);
    // Nothing was synthesised for any of them.
    expect(tts.calls.some((c) => c.text.startsWith("Mara"))).toBe(false);
    expect(tts.calls.some((c) => c.text === "Hers.")).toBe(false);
  });

  it("the summary.speak command reads the summary through the same speaker, by text and when parsed", async () => {
    const parsed = await json(
      await post("/commands/parse", { text: "read me the summary of PharmaWatch" }),
    );
    expect(parsed).toMatchObject({
      matched: "pattern",
      commands: [{ name: "summary.speak", params: { project: projectId } }],
    });
    const summary = ProjectSummary.parse(await json(await req(`/projects/${projectId}/summary`)));
    // No app window plays speech: nothing would be heard, so the summary is the reply.
    const unheard = await json(
      await post("/commands/execute", {
        commands: [{ name: "summary.speak", params: { project: projectId } }],
      }),
    );
    expect(unheard.sentence).toBe(
      `Voice is unavailable (no app window open to play speech). Summary of PharmaWatch: ${summary.spoken}`,
    );
    expect(rt.speech.current).toBeNull();
    // The UI's window attaches as a speech player; the command now reads aloud.
    const playerRes = await app.request(`/events?token=${token}&speech=play`, {
      headers: { accept: "text/event-stream" },
    });
    const player = playerRes.body?.getReader();
    if (!player) throw new Error("no player body");
    await player.read();
    expect(rt.speechPlayers.count()).toBe(1);
    const callsBefore = tts.calls.length;
    const r = await json(
      await post("/commands/execute", {
        commands: [{ name: "summary.speak", params: { project: projectId } }],
        wordsUsed: "read me the summary of PharmaWatch",
      }),
    );
    expect(r.status).toBe("done");
    expect(r.sentence).toBe(`Reading the summary of PharmaWatch aloud. ${summary.spoken}`);
    const current = rt.speech.current;
    if (!current) throw new Error("nothing speaking");
    expect(current.subject).toEqual({ kind: "project", id: projectId, name: "PharmaWatch" });
    expect(current.source).toBe("chat");
    const ended = await untilEnded(current.id);
    expect(ended.state).toBe("done");
    expect(tts.calls.slice(callsBefore).map((c) => c.text)).toEqual(current.sentences);
    const change = (await rt.store.changeLog.list()).find(
      (c) =>
        c.commands.some((x) => (x as { name: string }).name === "summary.speak") &&
        (c.after as { speak_id?: string | null } | null)?.speak_id === current.id,
    );
    expect(change).toMatchObject({ source: "chat", undo_state: "irreversible" });
    expect(change?.after).toMatchObject({ spoken: true, via: "speaker", speak_id: current.id });
    // Another human's project is refused by the command as by the route.
    const theirs = await json(
      await post("/commands/execute", {
        commands: [{ name: "summary.speak", params: { project: otherProjectId } }],
      }),
    );
    expect(theirs.status).not.toBe("done");
    expect(JSON.stringify(theirs)).toContain("is not yours");
    expect(tts.calls.some((c) => c.text.startsWith("Mara"))).toBe(false);
    await player.cancel();
  });

  it("finished utterances are dropped beyond the kept count and after the retention window", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const v = SpeakView.parse(await json(await post(`/sessions/${sessionId}/speak`, {})));
      ids.push(v.id);
      await untilEnded(v.id);
    }
    expect((await req(`/speak/${ids[0]}`)).status).toBe(404);
    expect((await req(`/speak/${ids[9]}`)).status).toBe(200);
    await clock.advance(11 * 60_000);
    expect((await req(`/speak/${ids[9]}`)).status).toBe(404);
  });
});

describe("speak without a TTS provider", () => {
  it("answers 503 with the reason, and the command puts the text in its sentence", async () => {
    const clock = new SimulatedClock("2026-11-03T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-speak-none-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: { tts: new FakeTts({ clock, available: false }) },
    });
    try {
      const { app, token } = createDaemonApp(rt);
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const p = await rt.store.project.insert({
        name: "Gamma",
        goal: "Ship the thing",
        repos: [],
        stage: "planning",
        status: "active",
        budget_usd_micro: 0,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: {},
        small_project_mode: false,
        active: true,
      });
      // A speech player is attached, so the reason is the provider's.
      const playerRes = await app.request(`/events?token=${token}&speech=play`, {
        headers: { accept: "text/event-stream" },
      });
      const player = playerRes.body?.getReader();
      if (!player) throw new Error("no player body");
      await player.read();
      const res = await post(`/projects/${p.id}/speak`, {});
      expect(res.status).toBe(503);
      expect(await json(res)).toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("no TTS provider available"),
      });
      const r = await json(
        await post("/commands/execute", {
          commands: [{ name: "summary.speak", params: { project: p.id } }],
        }),
      );
      expect(r.status).toBe("done");
      expect(String(r.sentence)).toMatch(
        /^Voice is unavailable \(.*no TTS provider available.*\)\. Summary of Gamma: Gamma\. Goal: Ship the thing\./,
      );
      await player.cancel();
    } finally {
      await rt.close();
    }
  });
});

describe("the speaker's provider preference", () => {
  it("is read at every utterance: a changed preference picks the other TTS for the next read", async () => {
    const clock = new SimulatedClock("2026-11-03T09:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    try {
      const human = await store.human.insert({ name: "J", email: "j@example.test" });
      const agent = await store.agent.insert({
        name: "Alice",
        owner_human_id: human.id,
        kind: "principal",
        memory_location: "",
      });
      const session = await store.session.insert({ agent_id: agent.id });
      const a = new FakeTts({ clock, chunks: 1, name: "tts-a" });
      const b = new FakeTts({ clock, chunks: 1, name: "tts-b" });
      let preferred = "tts-a";
      const speech = new SpeakSessions({
        registry: new VoiceProviderRegistry().registerTts(a).registerTts(b),
        // The base's preference shape (spec O.4): here as the environment override would give it.
        preferences: async () => ({
          stt: null,
          tts: { name: preferred, source: "env", extensionId: null, extension: null },
          skipped: [],
        }),
        store,
        clock,
        humanId: human.id,
        agentId: agent.id,
        sessionIdFor: async () => session.id,
        sink: () => collectingSink(),
        awaitListenerMs: 0,
      });
      const subject = { kind: "notification", id: "n", notificationKind: "budget_stop" } as const;
      const first = await speech.say({ text: "One.", subject, source: "notification" });
      expect(first.provider.name).toBe("tts-a");
      await drive(clock, first.done);
      preferred = "tts-b";
      const second = await speech.say({ text: "Two.", subject, source: "notification" });
      expect(second.provider.name).toBe("tts-b");
      await drive(clock, second.done);
      expect(a.calls.map((c) => c.text)).toEqual(["One."]);
      expect(b.calls.map((c) => c.text)).toEqual(["Two."]);
    } finally {
      await store.close();
    }
  });
});

describe("one voice under concurrent requests", () => {
  it("two overlapping say() calls: the later one cancels the earlier, never both to the end", async () => {
    const clock = new SimulatedClock("2026-11-03T09:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    try {
      const human = await store.human.insert({
        name: "J",
        email: "j@example.test",
        timezone: "Europe/Zurich",
      });
      const agent = await store.agent.insert({
        name: "Alice",
        owner_human_id: human.id,
        kind: "principal",
        memory_location: "",
      });
      const session = await store.session.insert({ agent_id: agent.id });
      const tts = new FakeTts({ clock, chunks: 1 });
      const speech = new SpeakSessions({
        registry: new VoiceProviderRegistry().registerTts(tts),
        store,
        clock,
        humanId: human.id,
        agentId: agent.id,
        sessionIdFor: async () => session.id,
        sink: () => collectingSink(),
        awaitListenerMs: 0,
      });
      const subject = { kind: "notification", id: "n", notificationKind: "budget_stop" } as const;
      // Both start before either has picked its provider or found its session row.
      const [first, second] = await Promise.all([
        speech.say({ text: "First alert. It has two sentences.", subject, source: "notification" }),
        speech.say({ text: "Second alert.", subject, source: "notification" }),
      ]);
      const [a, b] = await drive(clock, Promise.all([first.done, second.done]));
      expect(a.state).toBe("cancelled");
      expect(b.state).toBe("done");
      expect(speech.current).toBeNull();
    } finally {
      await store.close();
    }
  });
});
