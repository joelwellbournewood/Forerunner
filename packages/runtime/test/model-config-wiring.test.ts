import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { DEFAULT_LADDER, MODE_DEFAULTS, modelIdFor } from "../src/models/ladder.ts";
import { builtinModelConfig, parseModelSettings } from "../src/models/settings.ts";
import { type EvalRunnerPort, recordModelWatchBaseline } from "../src/models/watch.ts";
import type { ModelRef } from "../src/provider/types.ts";
import { MODEL_SETTINGS_READ_TOOL } from "../src/wiring/model-config.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * The adopted model settings inside the running system (spec D, ADR 0039): `composeRuntime`
 * reads `<config>/models.json` into the tables in force, the executor and the conversation
 * agent pick their rung and effort from them, and a human's "adopt" of a model watch report
 * swaps the tables without a restart, so the next session runs the adopted rung at the adopted
 * effort. Fake provider, fake eval runner, `sqlite::memory:`, SimulatedClock; no network.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);

/** The fake provider plus a model list: the ladder's fake rungs and one new, cheaper sonnet. */
class ListingProvider extends ScriptedProvider {
  constructor(
    replies: ConstructorParameters<typeof ScriptedProvider>[0],
    clock: SimulatedClock,
    private readonly listed: ModelRef[],
  ) {
    super(replies, clock);
  }
  override async listModels(): Promise<ModelRef[]> {
    return this.listed.map((m) => ({ ...m }));
  }
}

const fakePrice = (i: number, o: number) => ({
  input_per_mtok_usd: i,
  output_per_mtok_usd: o,
  cache_read_per_mtok_usd: i / 10,
  cache_write_per_mtok_usd: i * 1.25,
  as_of: "2026-10-01",
  source: "override",
});

/**
 * Evals without a model call: every set passes; the new sonnet costs half the rung model and
 * the lower effort 30 % less, so the watch proposes both the switch and the lower effort.
 */
const fakeEvals: EvalRunnerPort = {
  async run(input) {
    const base = input.model === "fake-sonnet-6" ? 500 : 1000;
    const cost = input.effort === "low" ? Math.round(base * 0.7) : base;
    return {
      total: 4,
      passed: 4,
      failed: 0,
      needsModel: 0,
      passRate: 1,
      costUsdMicro: cost,
      durationMs: 1,
    };
  },
};

const ENDED = new Set(["completed", "stopped", "failed", "killed"]);

/** Wait until more than `before` work sessions of the project exist and every one has ended. */
async function sessionsEnded(rt: RuntimeApp, projectId: string, before: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const rows = (
      await rt.store.session.list({ project_id: projectId } as never, { limit: 50 })
    ).filter((s) => s.summary !== "conversation");
    if (rows.length > before && rows.every((s) => ENDED.has(s.status))) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`a session of project ${projectId} is still running`);
}

/** Work sessions of the project so far (the conversation session never counts). */
async function workSessions(rt: RuntimeApp, projectId: string): Promise<number> {
  const rows = await rt.store.session.list({ project_id: projectId } as never, { limit: 50 });
  return rows.filter((s) => s.summary !== "conversation").length;
}

describe("model settings wired into the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  let dirs: ReturnType<typeof appDirs>;
  let provider: ListingProvider;
  let projectId = "";
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
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
  /**
   * One task in the project, run by one session; returns the Run rows the session produced
   * for it (the critic may send the task back within the session, which is a second run):
   * the specialist's runs and the critic's review runs, which sit on the task too.
   */
  const runTask = async (title: string) => {
    // A project of its own, so a task the critic sent back earlier never shares the plan.
    const card = await json(await post("/projects", { name: title, goal: `${title} is done` }));
    const project = str(card.id);
    const task = await json(
      await post(`/projects/${project}/tasks`, {
        title,
        outcome: `${title} is done`,
        acceptanceCriteria: ["the note is written"],
      }),
    );
    const before = await workSessions(rt, project);
    const started = await post("/sessions", {
      agentId: rt.agent.id,
      projectId: project,
      budgetUsdMicro: 2_000_000,
    });
    expect(started.status).toBe(202);
    await sessionsEnded(rt, project, before);
    const all = await rt.store.run.forTask(str(task.id));
    const coder = all.filter((r) => r.specialist === "coder");
    const critic = all.filter((r) => r.specialist === "critic");
    expect(coder.length).toBeGreaterThanOrEqual(1);
    expect(critic.length).toBeGreaterThanOrEqual(1);
    return { coder, critic };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-model-config-"));
    dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    // Prices for every fake model, the new one included, so nothing is guessed.
    writeFileSync(
      join(dirs.config, "pricing.json"),
      JSON.stringify({
        "fake-haiku": fakePrice(1, 5),
        "fake-haiku-2": fakePrice(0.5, 2.5),
        "fake-sonnet": fakePrice(3, 15),
        "fake-sonnet-6": fakePrice(1.5, 7.5),
        "fake-opus": fakePrice(15, 75),
        "fake-fable": fakePrice(30, 150),
      }),
    );
    // A human adopted a haiku replacement earlier (the chat rung): the file is read at compose.
    writeFileSync(
      join(dirs.config, "models.json"),
      JSON.stringify({
        version: 1,
        updated_at: "2026-10-10T00:00:00.000Z",
        ladder: { haiku: { fake: "fake-haiku-2" } },
        efforts: {},
        history: [{ at: "2026-10-10T00:00:00.000Z", report_id: "r0", by: "h", changes: ["x"] }],
      }),
    );
    provider = new ListingProvider([{ text: "Done. Nothing to report." }], clock, [
      ...DEFAULT_LADDER.map((r) => ({
        provider: "fake",
        id: r.models.fake as string,
        tier: r.tier,
      })),
      { provider: "fake", id: "fake-sonnet-6", tier: "sonnet" },
    ]);
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
      evalRunner: fakeEvals,
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    ({ app, token } = createDaemonApp(rt));
    const card = await json(await post("/projects", { name: "Models", goal: "Adopt a model" }));
    projectId = str(card.id);
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("applies models.json at compose: the chat turn runs on the adopted haiku rung", async () => {
    const cfg = rt.modelConfig();
    expect(modelIdFor("haiku", "fake", cfg.ladder)).toBe("fake-haiku-2");
    expect(modelIdFor("sonnet", "fake", cfg.ladder)).toBe("fake-sonnet");
    expect(cfg.modeDefaults.coder.effort).toBe(MODE_DEFAULTS.coder.effort);
    const audits = await rt.store.auditLog.list({ tool: MODEL_SETTINGS_READ_TOOL } as never, {
      limit: 10,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ allowed: true, human_id: rt.human.id });

    const before = provider.calls.length;
    const reply = await post("/chat", {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      projectId,
      text: "What is the plan?",
    });
    expect(reply.status).toBe(200);
    const chatCalls = provider.calls.slice(before);
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
    expect(chatCalls.every((c) => c.model === "fake-haiku-2")).toBe(true);
  });

  it("a session before the adopt runs the coder and the tier-1 critic on the built-in sonnet rung", async () => {
    const { coder, critic } = await runTask("Write a note");
    for (const run of coder)
      expect(run).toMatchObject({ specialist: "coder", model: "fake-sonnet", effort: "medium" });
    // The critic reviews the task at tier 1: the sonnet rung at medium effort (spec D).
    for (const run of critic)
      expect(run).toMatchObject({ specialist: "critic", model: "fake-sonnet", effort: "medium" });
    expect(rt.critic.service.modelFor(1, { projectSettings: null }).model).toBe("fake-sonnet");
  }, 60_000);

  it("the model watch proposes the cheaper sonnet and the lower effort; the human adopts; the next session uses both without a restart", async () => {
    // An install whose first run already recorded the ladder rungs as the baseline (ADR 0089),
    // so the cheaper sonnet is news to this run.
    await recordModelWatchBaseline(rt.store, {
      provider: "fake",
      models: DEFAULT_LADDER.flatMap((r) =>
        r.models.fake ? [{ provider: "fake", id: r.models.fake, tier: r.tier }] : [],
      ),
    });
    // The human's explicit "run evaluations" (ADR 0089): without it the run makes no paid eval.
    const result = await rt.modelWatch.run({ evals: true });
    const kinds = result.report.recommendations.map((r) => r.kind);
    expect(kinds).toContain("switch_model");
    expect(kinds).toContain("lower_effort");
    const sw = result.report.recommendations.find((r) => r.kind === "switch_model");
    expect(sw).toMatchObject({ rung: "sonnet", provider: "fake", to: "fake-sonnet-6" });
    const lower = result.report.recommendations.find(
      (r) => r.kind === "lower_effort" && r.mode === "coder",
    );
    expect(lower).toMatchObject({ from: "medium", to: "low" });
    expect(result.decision).toBe("pending");

    // Nothing changed yet: the tables in force are the ones read at compose.
    expect(modelIdFor("sonnet", "fake", rt.modelConfig().ladder)).toBe("fake-sonnet");

    // The human's answer in the inbox is applied by syncApprovals (as POST /requests/:id/answer does).
    const open = await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 });
    const request = open.find(
      (r) => (r.change_card as { key?: string } | null)?.key === `model_watch:${result.report.id}`,
    );
    if (!request) throw new Error("no model watch request in the inbox");
    const answered = await post(`/requests/${request.id}/answer`, {
      version: request.version,
      answer: "adopt",
    });
    expect(answered.status).toBe(200);
    const latest = await json(await req("/model-watch/reports/latest"));
    expect(latest.health).toMatchObject({ decision: "adopted", by: rt.human.id });

    // The tables in force changed in place ...
    const cfg = rt.modelConfig();
    expect(modelIdFor("sonnet", "fake", cfg.ladder)).toBe("fake-sonnet-6");
    expect(cfg.modeDefaults.coder.effort).toBe("low");
    expect(modelIdFor("haiku", "fake", cfg.ladder)).toBe("fake-haiku-2");
    // ... the file on disk says the same (a restart reads it back) ...
    const onDisk = parseModelSettings(readFileSync(join(dirs.config, "models.json"), "utf8"));
    expect(onDisk.ladder.sonnet).toEqual({ fake: "fake-sonnet-6" });
    expect(onDisk.efforts.coder).toBe("low");
    // ... and the adoption was handed to the runtime (audited) ...
    const reload = await rt.store.auditLog.list({ tool: "model_watch.reload" } as never, {
      limit: 10,
    });
    expect(reload).toHaveLength(1);
    expect(reload[0]).toMatchObject({ allowed: true });

    // ... so the next session picks the adopted rung and effort, with no restart ...
    const { coder, critic } = await runTask("Write another note");
    for (const run of coder)
      expect(run).toMatchObject({ specialist: "coder", model: "fake-sonnet-6", effort: "low" });
    expect(provider.calls.some((c) => c.model === "fake-sonnet-6" && c.effort === "low")).toBe(
      true,
    );
    // ... and the critic reviews on the adopted sonnet rung too: the tier-1 review of the new
    // task ran on it, and the pick for the next review reads the tables in force (the critic's
    // effort stays medium: the adoption lowered the coder's effort, not the critic's).
    for (const run of critic)
      expect(run).toMatchObject({ specialist: "critic", model: "fake-sonnet-6", effort: "medium" });
    const pick = rt.critic.service.modelFor(1, { projectSettings: null });
    expect(pick).toMatchObject({ tier: "sonnet", model: "fake-sonnet-6", effort: "medium" });
    // The opus rung was not adopted: tier-2 reviews keep the built-in id.
    expect(rt.critic.service.modelFor(2, { projectSettings: null }).model).toBe("fake-opus");
  }, 60_000);

  it("a malformed models.json is ignored with an audit row and the built-in tables are used; its content never reaches the log", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "fr-model-config-bad-"));
    const dirs2 = appDirs({ env: { FORERUNNER_HOME: home2 } });
    mkdirSync(dirs2.config, { recursive: true });
    const marker = ["MALFORMED", "MARKER", "7f3a"].join("-"); // not-a-secret
    writeFileSync(
      join(dirs2.config, "models.json"),
      JSON.stringify({ version: 2, ladder: { sonnet: { fake: marker } } }),
    );
    const logs: LogRecord[] = [];
    const stopLogs = Logger.addSink((r) => logs.push(r));
    const rt2 = await composeRuntime({
      env: { FORERUNNER_HOME: home2 },
      dirs: dirs2,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "UTC", agentName: "Alice" },
      startServices: false,
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    try {
      expect(rt2.modelConfig()).toEqual(builtinModelConfig());
      const audits = await rt2.store.auditLog.list({ tool: MODEL_SETTINGS_READ_TOOL } as never, {
        limit: 10,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        allowed: false,
        human_id: rt2.human.id,
        result_summary: "built-in ladder and effort table in use",
      });
      expect(str(audits[0]?.denied_reason)).toMatch(/^validation: /);
      expect(str(audits[0]?.input_summary)).toContain("models.json");
      const everything = `${JSON.stringify(audits)}\n${JSON.stringify(logs)}`;
      expect(everything).not.toContain(marker);
      expect(logs.some((l) => /model settings ignored/.test(l.msg))).toBe(true);
    } finally {
      stopLogs();
      await rt2.close();
    }
  }, 60_000);
});
