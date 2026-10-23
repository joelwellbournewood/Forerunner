import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAEMON_ROUTES, PerformanceView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * `GET /performance` on the composed daemon (spec D.7, D.19): the view the Performance page
 * reads, served from the store. A chat turn through `POST /chat` and the seeded Run rows show up
 * per mode; the window, the project and the bearer token are honoured; a bad `days` is 400 and
 * an unknown project 404.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const START = "2026-10-20T08:00:00.000Z";

describe("GET /performance on the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock(START);
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const view = async (path: string): Promise<PerformanceView> => {
    const res = await req(path);
    expect(res.status).toBe(200);
    return PerformanceView.parse(await res.json());
  };
  const modeOf = (v: PerformanceView, mode: string) => v.modes.find((m) => m.mode === mode);

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-performance-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Hello from the fake agent." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
    const created = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Perf", goal: "Measure" }),
    });
    expect(created.status).toBe(201);
    projectId = String(((await created.json()) as { id: string }).id);
    await rt.store.project.update(projectId, (await rt.store.project.mustGet(projectId)).version, {
      settings: { speed_quality_offset: -1 },
    });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("is in the route table and needs the bearer token", async () => {
    expect(DAEMON_ROUTES.performance.startsWith("GET /performance")).toBe(true);
    expect((await req("/performance", {}, false)).status).toBe(401);
  });

  it("serves every mode from the store: a chat turn and the Run rows, per project, in the window", async () => {
    const empty = await view(`/performance?projectId=${projectId}`);
    expect(empty.modes).toHaveLength(8);
    expect(empty.modes.every((m) => m.samples === 0)).toBe(true);
    expect(empty).toMatchObject({ projectId, days: 7, effortOffset: -1 });
    // The slider (-1) reaches every mode a run reads it in (spec D.16): the critic's medium
    // one step down, planning's high to medium, the researcher's high to medium; chat and
    // voice start at low and stay there. Each is held at the registry's max_effort.
    expect(modeOf(empty, "critic_t1")).toMatchObject({
      baseEffort: "medium",
      effort: "low",
      maxEffort: "max",
    });
    expect(modeOf(empty, "planning")).toMatchObject({ effort: "medium", maxEffort: "max" });
    expect(modeOf(empty, "researcher")).toMatchObject({ effort: "medium", maxEffort: "high" });
    expect(modeOf(empty, "text_chat")).toMatchObject({ effort: "low", maxEffort: "medium" });
    expect(modeOf(empty, "routing")).toMatchObject({ offsetApplied: false, maxEffort: null });
    // A tier 3 review runs at max, one step down with the slider; the coder runs at low, and at
    // risk tier 2+ at high one step down.
    expect(modeOf(empty, "critic_t23")).toMatchObject({
      effort: "medium",
      riskEffort: "xhigh",
      riskTierFrom: 3,
    });
    expect(modeOf(empty, "coder")).toMatchObject({
      effort: "low",
      maxEffort: "high",
      riskEffort: "medium",
      riskTierFrom: 2,
    });

    // A chat turn through the conversation agent records its first token and total time.
    const chat = await req("/chat", {
      method: "POST",
      body: JSON.stringify({
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId,
        text: "hello",
      }),
    });
    expect(chat.status).toBe(200);
    // Run rows of a work session of the project: a coder run and a tier 1 review.
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1_000_000,
      step_cap: 10,
      status: "planned",
    });
    for (const [specialist, model, ttft, total] of [
      ["coder", "fake-sonnet", 800, 120_000],
      ["critic", "fake-sonnet", 600, 12_000],
      ["critic", "fake-sonnet", 700, 41_000],
    ] as const)
      await rt.store.run.insert({
        session_id: session.id,
        specialist,
        model,
        effort: "medium",
        ttft_ms: ttft,
        duration_ms: total,
        outcome: "completed",
      });
    // A run older than the window.
    await rt.store.run.insert({
      session_id: session.id,
      specialist: "researcher",
      model: "fake-sonnet",
      ttft_ms: 900,
      duration_ms: 400_000,
      outcome: "completed",
      created_at: new Date(clock.now() - 9 * 86_400_000).toISOString(),
    });

    const v = await view(`/performance?projectId=${projectId}`);
    expect(v.generatedAt).toBe(clock.nowIso());
    const text = modeOf(v, "text_chat");
    expect(text?.samples).toBe(1);
    expect(text?.ttftP50Ms).not.toBeNull();
    expect(text?.totalP50Ms).not.toBeNull();
    expect(text?.lastAt).toBe(clock.nowIso());
    expect(modeOf(v, "coder")).toMatchObject({ samples: 1, totalP90Ms: 120_000, met: null });
    // Tier 1 against 30 s: p90 of [12 s, 41 s] by nearest rank is 41 s, half within.
    expect(modeOf(v, "critic_t1")).toMatchObject({
      samples: 2,
      totalP50Ms: 12_000,
      totalP90Ms: 41_000,
      withinTargetShare: 0.5,
      met: false,
    });
    expect(modeOf(v, "researcher")?.samples).toBe(0);
    expect(v.recent.some((r) => r.source === "chat" && r.mode === "text_chat")).toBe(true);

    // ?days widens the window; all projects drop the offset.
    const wide = await view("/performance?days=10");
    expect(wide).toMatchObject({ projectId: null, days: 10, effortOffset: 0 });
    expect(modeOf(wide, "researcher")?.samples).toBe(1);
    expect((await view("/performance?days=365")).days).toBe(90);
  });

  it("shows the principal's D.4 effort settings as the base the slider shifts, read per request", async () => {
    const before = await rt.store.agent.mustGet(rt.agent.id);
    await rt.store.agent.update(rt.agent.id, before.version, {
      model_config: {
        modes: { planning: { effort: "low" } },
        specialists: { researcher: { effort: "xhigh" } },
      },
    });
    try {
      const v = await view(`/performance?projectId=${projectId}`);
      // Planning: the principal's low, one step down with the slider stays low.
      expect(modeOf(v, "planning")).toMatchObject({
        baseEffort: "low",
        effortSource: "agent",
        effort: "low",
      });
      // The researcher's xhigh one step down is high, at the specialist's max_effort.
      expect(modeOf(v, "researcher")).toMatchObject({
        baseEffort: "xhigh",
        effortSource: "agent",
        effort: "high",
        maxEffort: "high",
      });
      expect(modeOf(v, "text_chat")).toMatchObject({ effortSource: "table", baseEffort: "low" });
      // A malformed document applies no override, as the runs read it.
      const row = await rt.store.agent.mustGet(rt.agent.id);
      await rt.store.agent.update(rt.agent.id, row.version, {
        model_config: { modes: { planning: { effort: "fastest" } } },
      });
      const bad = await view(`/performance?projectId=${projectId}`);
      expect(modeOf(bad, "planning")).toMatchObject({ effortSource: "table", baseEffort: "high" });
    } finally {
      const row = await rt.store.agent.mustGet(rt.agent.id);
      await rt.store.agent.update(rt.agent.id, row.version, { model_config: {} });
    }
  });

  it("refuses a bad days with 400 and an unknown project with 404", async () => {
    // Decimal digits only: no hex, exponent, padding or fraction that Number() would accept.
    for (const bad of ["0", "-3", "1.5", "week", "0x10", "1e1", "%207", "7.0", "+7"]) {
      const res = await req(`/performance?days=${bad}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation", details: { param: "days" } });
    }
    expect((await view("/performance?days=007")).days).toBe(7);
    const missing = await req("/performance?projectId=proj_missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });
});
