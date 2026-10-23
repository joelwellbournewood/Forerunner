import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  type EffortOffset,
  effortForTask,
  MODE_DEFAULTS,
  type Mode,
  modeEffort,
  speedQualityOffsetOf,
} from "../src/models/ladder.ts";
import type { EffortLevel } from "../src/provider/types.ts";
import { FakeStt, FakeTts } from "../src/voice/pkg.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * The speed-versus-quality slider in the running system (spec D.16): every mode's effort for a
 * project is the default from the tables in force shifted one step by the project's
 * `speed_quality_offset`, read from the project row when the work starts. The slider is moved
 * the way the Settings screen moves it (`POST /commands/execute`, `settings.set`, source
 * `ui`), and the next chat turn, voice turn, planning (intake) session and work session run at
 * the shifted effort, with no restart in between. Fake model provider, fake STT and TTS,
 * `sqlite::memory:`, SimulatedClock; no network.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);
const OFFSETS: readonly EffortOffset[] = [0, 1, -1];

/** The spec's effort table shifted by each slider position, as the brief states it. */
const EXPECTED: Record<
  "text_chat" | "voice_chat" | "planning" | "coder" | "critic_t1",
  Record<EffortOffset, EffortLevel>
> = {
  // Chat and voice start at the bottom of the scale: speed cannot go lower than low.
  text_chat: { [-1]: "low", 0: "low", 1: "medium" },
  voice_chat: { [-1]: "low", 0: "low", 1: "medium" },
  planning: { [-1]: "medium", 0: "high", 1: "xhigh" },
  coder: { [-1]: "low", 0: "medium", 1: "high" },
  critic_t1: { [-1]: "low", 0: "medium", 1: "high" },
};

/** Let every pending microtask and I/O callback run (the store's queries, the provider). */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Step the simulated clock until `p` settles (the voice loop's STT and TTS delays run on it). */
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
    await clock.advance(50);
    spent += 50;
  }
  return tracked;
}

/** A daemon app with the bearer token applied to every request. */
function client(rt: RuntimeApp) {
  const { app, token } = createDaemonApp(rt);
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
  /** Moves the slider the way the Settings screen does: one `settings.set`, source `ui`. */
  const slide = async (projectId: string, value: EffortOffset) => {
    const r = await json(
      await post("/commands/execute", {
        commands: [
          {
            name: "settings.set",
            params: { key: "speed_quality_offset", value, project: projectId },
          },
        ],
        wordsUsed: `Settings: project.speed_quality_offset to ${value}`,
        source: "ui",
        projectId,
      }),
    );
    expect(r.status).toBe("done");
    expect((await rt.store.project.mustGet(projectId)).settings.speed_quality_offset).toBe(value);
    return r;
  };
  return { req, post, slide };
}

describe("the slider's arithmetic (ladder.ts)", () => {
  it("reads the slider from a project's settings; anything but -1, 0 or +1 is balanced", () => {
    expect(speedQualityOffsetOf({ speed_quality_offset: -1 })).toBe(-1);
    expect(speedQualityOffsetOf({ speed_quality_offset: 1 })).toBe(1);
    expect(speedQualityOffsetOf({ speed_quality_offset: 0 })).toBe(0);
    for (const junk of [{}, { speed_quality_offset: 2 }, { speed_quality_offset: "1" }, null, 3])
      expect(speedQualityOffsetOf(junk)).toBe(0);
  });

  it("shifts every mode's default effort by one step, clamped to the scale", () => {
    for (const mode of Object.keys(MODE_DEFAULTS) as Mode[]) {
      expect(modeEffort(mode, 0)).toBe(MODE_DEFAULTS[mode].effort);
    }
    for (const mode of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[])
      for (const offset of OFFSETS) expect(modeEffort(mode, offset)).toBe(EXPECTED[mode][offset]);
    // The table in force wins over the built-in one (an adopted lower effort, ADR 0039).
    const adopted = { ...MODE_DEFAULTS, planning: { ...MODE_DEFAULTS.planning, effort: "medium" } };
    expect(modeEffort("planning", 1, adopted as typeof MODE_DEFAULTS)).toBe("high");
    // Coding at tier 2+ starts at high, then takes the slider.
    expect(effortForTask("coder", 2, 1)).toBe("xhigh");
    expect(effortForTask("coder", 2, -1)).toBe("medium");
  });
});

describe("chat, voice and planning read the project's slider per turn and per session", () => {
  let rt: RuntimeApp;
  let api: ReturnType<typeof client>;
  let projectId = "";
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  const provider = new ScriptedProvider([{ text: "Noted." }], clock);
  const stt = new FakeStt({ clock, scripts: () => ({ final: "" }), finalDelayMs: 300 });
  const tts = new FakeTts({ clock, firstChunkLatencyMs: 200, chunkMs: 100, chunks: 2 });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-effort-offset-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      voice: { stt, tts },
    });
    api = client(rt);
    const p = await rt.store.project.insert({
      name: "Slider",
      goal: "Move the slider",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: 2,
      summary_cache: { brief: "A small site for ten users." },
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
    projectId = p.id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /** The efforts of the model calls `act` made. */
  const effortsOf = async (act: () => Promise<unknown>): Promise<(string | undefined)[]> => {
    const before = provider.calls.length;
    await act();
    const calls = provider.calls.slice(before);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    return calls.map((c) => c.effort);
  };

  it("a typed chat turn runs at text_chat's effort shifted by the slider, from the next turn", async () => {
    for (const offset of OFFSETS) {
      await api.slide(projectId, offset);
      const efforts = await effortsOf(async () => {
        const r = await api.post("/chat", {
          humanId: rt.human.id,
          agentId: rt.agent.id,
          projectId,
          text: "What is the plan?",
        });
        expect(r.status).toBe(200);
      });
      expect(efforts.every((e) => e === EXPECTED.text_chat[offset])).toBe(true);
    }
  });

  it("a voice turn runs at voice_chat's effort shifted by the slider, from the next turn", async () => {
    const started = await api.post("/voice/sessions", { projectId, language: "en" });
    expect(started.status).toBe(201);
    const sessionId = str((await json(started)).id);
    for (const offset of OFFSETS) {
      await api.slide(projectId, offset);
      const efforts = await effortsOf(async () => {
        const r = await drive(
          clock,
          api.post(`/voice/sessions/${sessionId}/text`, { text: "What is the status?" }),
        );
        expect(r.status).toBe(200);
      });
      expect(efforts.every((e) => e === EXPECTED.voice_chat[offset])).toBe(true);
    }
    expect((await api.post(`/voice/sessions/${sessionId}/stop`, {})).status).toBeLessThan(300);
  });

  it("a planning (intake) session runs at planning's effort shifted by the slider, from the next session", async () => {
    for (const offset of OFFSETS) {
      await api.slide(projectId, offset);
      // The fake answers with no proposal, so the intake files nothing and the next one calls
      // the model again; the call itself is what this checks.
      const efforts = await effortsOf(async () => {
        const r = await api.post(`/projects/${projectId}/intake`, {});
        expect(r.status).not.toBe(202);
      });
      expect(efforts).toEqual([EXPECTED.planning[offset]]);
    }
  });
});

const ENDED = new Set(["completed", "stopped", "failed", "killed"]);

describe("work sessions read the project's slider per run", () => {
  let rt: RuntimeApp;
  let api: ReturnType<typeof client>;
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  const provider = new ScriptedProvider([{ text: "Done. Nothing to report." }], clock);

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-effort-offset-runs-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    api = client(rt);
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /** Work sessions of the project (the conversation session never counts). */
  const workSessions = async (projectId: string) =>
    (await rt.store.session.list({ project_id: projectId } as never, { limit: 50 })).filter(
      (s) => s.summary !== "conversation",
    );

  /**
   * One new task in the project, then one session; the Run rows of that session. A task the
   * critic sent back in an earlier session runs again in this one: its retry is a run of the
   * same project after the slider moved, so it takes the new position too.
   */
  const runSession = async (projectId: string, title: string) => {
    const task = await json(
      await api.post(`/projects/${projectId}/tasks`, {
        title,
        outcome: `${title} is done`,
        acceptanceCriteria: ["the note is written"],
      }),
    );
    expect((await rt.store.task.mustGet(str(task.id))).risk_tier).toBe(1);
    const before = new Set((await workSessions(projectId)).map((s) => s.id));
    const started = await api.post("/sessions", {
      agentId: rt.agent.id,
      projectId,
      budgetUsdMicro: 2_000_000,
    });
    expect(started.status).toBe(202);
    let session: { id: string; status: string } | undefined;
    for (let i = 0; i < 500; i++) {
      session = (await workSessions(projectId)).find((s) => !before.has(s.id));
      if (session && ENDED.has(session.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!session) throw new Error("no session started");
    expect(ENDED.has(session.status)).toBe(true);
    const runs = await rt.store.run.forSession(session.id);
    const coder = runs.filter((r) => r.specialist === "coder");
    const critic = runs.filter((r) => r.specialist === "critic");
    expect(coder.length).toBeGreaterThanOrEqual(1);
    expect(critic.length).toBeGreaterThanOrEqual(1);
    return { coder, critic };
  };

  it("the coder and the tier-1 critic run at their defaults shifted by the slider, from the next run, without a restart", async () => {
    const card = await json(await api.post("/projects", { name: "Runs", goal: "Run tasks" }));
    const projectId = str(card.id);
    for (const offset of OFFSETS) {
      await api.slide(projectId, offset);
      const { coder, critic } = await runSession(projectId, `Write note ${offset}`);
      for (const run of coder) expect(run.effort).toBe(EXPECTED.coder[offset]);
      for (const run of critic) expect(run.effort).toBe(EXPECTED.critic_t1[offset]);
    }
  }, 120_000);

  it("the Settings rows carry the slider per project as the modes read it", async () => {
    const card = await json(await api.post("/projects", { name: "Rows", goal: "Show the slider" }));
    const projectId = str(card.id);
    const row = async () =>
      ((await (await api.req("/settings")).json()) as Json[]).find(
        (s) => s.key === "project.speed_quality_offset" && s.scopeId === projectId,
      );
    expect(await row()).toMatchObject({ scope: "project", value: 0, risk: "low" });
    await api.slide(projectId, 1);
    expect(await row()).toMatchObject({ value: 1 });
    await api.slide(projectId, -1);
    expect(await row()).toMatchObject({ value: -1 });
  });
});
