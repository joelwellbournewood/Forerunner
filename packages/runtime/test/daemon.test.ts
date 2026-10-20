import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const jsonList = async (r: Response): Promise<Json[]> => (await r.json()) as Json[];
const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);

describe("local daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-daemon-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider(
        [{ text: "Hello from the fake agent." }, { text: "Noted." }],
        clock,
      ),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  });
  afterAll(async () => {
    await rt.close();
  });

  it("serves health without auth and refuses everything else without the token", async () => {
    const h = await req("/health", {}, false);
    expect(h.status).toBe(200);
    expect(await json(h)).toMatchObject({
      ok: true,
      version: "0.1.0-test",
      vaultBackend: "memory",
      killActive: false,
    });
    expect((await req("/me", {}, false)).status).toBe(401);
    expect((await app.request("/me", { headers: { authorization: "Bearer wrong" } })).status).toBe(
      401,
    );
    const me = await req("/me");
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({
      name: "J",
      timezone: "Europe/Zurich",
      agent: { name: "Alice" },
      provider: "fake",
    });
  });

  it("creates projects and tasks, lists cards and transitions tasks with version checks", async () => {
    const created = await req("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Demo",
        goal: "Show the daemon",
        brief: "A longer brief",
        repos: ["o/demo"],
        budgetUsdMicro: 10_000_000,
      }),
    });
    expect(created.status).toBe(201);
    const card = await json(created);
    projectId = str(card.id);
    expect(card).toMatchObject({
      name: "Demo",
      health: "idle",
      budget: { usdMicro: 10_000_000, chfMicro: 8_000_000 },
    });
    expect(await jsonList(await req("/projects"))).toHaveLength(1);
    const tResp = await req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Write the readme",
        outcome: "README explains the demo",
        acceptanceCriteria: ["mentions the daemon"],
      }),
    });
    const t = await json(tResp);
    expect(t).toMatchObject({ status: "ready", riskTier: 1, version: 1 });
    expect(await jsonList(await req(`/projects/${projectId}/tasks?status=ready`))).toHaveLength(1);
    const stale = await req(`/tasks/${str(t.id)}/transition`, {
      method: "POST",
      body: JSON.stringify({ version: 99, to: "cancelled", reason: "stale" }),
    });
    expect(stale.status).toBe(409);
    const ok = await req(`/tasks/${str(t.id)}/transition`, {
      method: "POST",
      body: JSON.stringify({ version: num(t.version), to: "cancelled", reason: "not needed" }),
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).status).toBe("cancelled");
    const summary = await json(await req(`/projects/${projectId}/summary`));
    expect(str(summary.spoken)).toContain("Demo.");
    const bad = await req("/projects", { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(bad.status).toBe(409);
  });

  it("chats through the conversation agent and lists the inbox and settings", async () => {
    const reply = await json(
      await req("/chat", {
        method: "POST",
        body: JSON.stringify({
          humanId: rt.human.id,
          agentId: rt.agent.id,
          projectId,
          text: "hello",
        }),
      }),
    );
    expect(reply.reply).toBe("Hello from the fake agent.");
    const inbox = await json(await req("/inbox"));
    expect(inbox).toMatchObject({ blockingCount: 0 });
    const settings = await jsonList(await req("/settings"));
    expect(settings.find((s) => s.key === "human.monthly_cap")).toMatchObject({
      scope: "human",
      risk: "high",
    });
    expect(settings.find((s) => s.key === "project.budget")).toMatchObject({ scope: "project" });
  });

  it("starts a session through the scheduler and exposes it with its events; kill works", async () => {
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, budgetUsdMicro: 1_000_000 }),
    });
    expect(started.status).toBe(202);
    expect(await json(started)).toEqual({ result: "started" });
    await new Promise((r) => setTimeout(r, 200));
    const sessions = await jsonList(await req(`/sessions?agentId=${rt.agent.id}`));
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions[0] as Json;
    expect(["completed", "running", "stopped"]).toContain(str(s.status));
    const events = await jsonList(await req(`/sessions/${str(s.id)}/events`));
    expect(events[0]).toMatchObject({ type: "session.started", level: "info" });
    expect(str((events[0] as Json).text)).toContain("Session started");
    const detail = await json(await req(`/sessions/${str(s.id)}`));
    expect(detail).toMatchObject({ id: s.id, agentName: "Alice" });
    const kill = await json(
      await req("/kill", {
        method: "POST",
        body: JSON.stringify({ scope: "all", reason: "test" }),
      }),
    );
    expect(kill).toMatchObject({ scope: "all" });
    expect((await json(await req("/health", {}, false))).killActive).toBe(true);
    expect((await req("/kill/resume", { method: "POST" })).status).toBe(200);
    expect((await json(await req("/health", {}, false))).killActive).toBe(false);
    const costs = await json(await req(`/costs?projectId=${projectId}`));
    expect(num((costs.totals as Json).usdMicro)).toBeGreaterThanOrEqual(0);
  });

  it("streams events over SSE", async () => {
    const res = await req("/events", { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: inbox.changed");
    await reader.cancel();
  });
});
