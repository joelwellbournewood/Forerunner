import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { RESTART_EXIT_CODE } from "../src/daemon/restart.ts";
import { createDaemonApp, startDaemon } from "../src/daemon/server.ts";
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
    // Composing the whole runtime on a cold Windows runner has exceeded the default 10 s hook timeout.
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
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
    // Spec O.9 (review of w3-o9-chat-to-inbox, finding 3): the conversation is the signed-in
    // human's. A body naming another human is refused on both chat routes before anything is
    // parsed, posted to an inbox or answered, as `/inbox` refuses; the transcript has no row.
    const other = await rt.store.human.insert({ name: "K", email: "k@example.test" });
    const foreign = JSON.stringify({ humanId: other.id, agentId: rt.agent.id, text: "stop" });
    const refused = await req("/chat", { method: "POST", body: foreign });
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({
      code: "forbidden",
      message: "not your conversation",
    });
    expect((await req("/chat/stream", { method: "POST", body: foreign })).status).toBe(403);
    const convo = await rt.conversation?.conversationSessionId(rt.agent.id, projectId);
    const said = (await rt.store.event.list(convo ?? ""))
      .filter((e) => e.type === "chat.human")
      .map((e) => (e.payload as { text: string }).text);
    expect(said).toEqual(["hello"]);
    const inbox = await json(await req("/inbox"));
    expect(inbox).toMatchObject({ blockingCount: 0 });
    const settings = await jsonList(await req("/settings"));
    expect(settings.find((s) => s.key === "human.monthly_cap")).toMatchObject({
      scope: "human",
      risk: "high",
    });
    expect(settings.find((s) => s.key === "project.budget")).toMatchObject({ scope: "project" });
    // Opus fast mode (D.20, ADR 0057): per project, off by default, the surcharge both ways.
    const fast = settings.find((s) => s.key === "project.fast_mode" && s.scopeId === projectId);
    expect(fast).toMatchObject({ scope: "project", value: false, risk: "medium" });
    expect(str(fast?.description)).toContain("API only");
    expect(str(fast?.description)).toContain("On: Opus runs of this project on an API key");
    expect(str(fast?.description)).toContain("USD 24 / 120");
    expect(str(fast?.description)).toContain("Off: Opus runs of this project go back");
    await rt.store.project.update(projectId, (await rt.store.project.mustGet(projectId)).version, {
      settings: { ...(await rt.store.project.mustGet(projectId)).settings, fast_mode: true },
    });
    const after = await jsonList(await req("/settings"));
    expect(after.find((s) => s.key === "project.fast_mode" && s.scopeId === projectId)?.value).toBe(
      true,
    );
    await rt.store.project.update(projectId, (await rt.store.project.mustGet(projectId)).version, {
      settings: { ...(await rt.store.project.mustGet(projectId)).settings, fast_mode: false },
    });
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

  it("follows the UI conventions (ADR 0025): CORS for local origins, ?token only on the SSE routes, JSON chat frames, conflict code, killActive", async () => {
    // CORS preflight from the dev server origin is answered with the allowed headers; a foreign
    // origin gets no allow-origin header.
    const pre = await app.request("/projects", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );
    const foreign = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const tauri = await app.request("/health", { headers: { origin: "tauri://localhost" } });
    expect(tauri.headers.get("access-control-allow-origin")).toBe("tauri://localhost");

    // The token in the query string opens the EventSource routes and nothing else.
    expect((await app.request(`/me?token=${token}`)).status).toBe(401);
    const ac = new AbortController();
    const ev = await app.request(`/events?token=${token}`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(ev.status).toBe(200);
    expect(ev.headers.get("content-type")).toContain("text/event-stream");
    ac.abort();

    // Chat stream frames: token frames carry {text}, the last frame is the full reply.
    const res = await req("/chat/stream", {
      method: "POST",
      body: JSON.stringify({ text: "hello", humanId: rt.human.id, agentId: rt.agent.id }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter((f) => f.includes("event:"))
      .map((f) => {
        const event = /event: (\S+)/.exec(f)?.[1] ?? "";
        const data = f
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        return { event, data: JSON.parse(data) as Record<string, unknown> };
      });
    expect(frames.at(-1)?.event).toBe("reply");
    expect(typeof frames.at(-1)?.data.reply).toBe("string");
    for (const f of frames.slice(0, -1)) {
      expect(f.event).toBe("token");
      expect(typeof f.data.text).toBe("string");
    }

    // A stale version is a 409 with code "conflict"; the runtime's code stays in the details.
    const created = await json(
      await req("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Conv", goal: "Conventions project for the test" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const task = await json(
      await req(`/projects/${str(created.id)}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: "A task",
          outcome: "done",
          acceptanceCriteria: ["x"],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const stale = await req(`/tasks/${str(task.id)}/transition`, {
      method: "POST",
      body: JSON.stringify({ version: 999, to: "cancelled", reason: "stale" }),
      headers: { "content-type": "application/json" },
    });
    expect(stale.status).toBe(409);
    const body = await json(stale);
    expect(body.code).toBe("conflict");
    expect((body.details as { cause: string }).cause).toBe("version_conflict");

    // Kill and resume report the switch state.
    const killed = await json(
      await req("/kill", {
        method: "POST",
        body: JSON.stringify({ scope: "all", reason: "test" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(killed.killActive).toBe(true);
    const resumed = await json(await req("/kill/resume", { method: "POST" }));
    expect(resumed.killActive).toBe(false);
  });

  it("records answered decisions and lists the project's decision log", async () => {
    const card = await json(
      await req("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Decide", goal: "A project with a decision to make" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const request = await rt.store.humanRequest.insert({
      human_id: rt.human.id,
      project_id: str(card.id),
      kind: "decision",
      why: "Which cloud region?",
      steps: [],
      options: ["eu-central", "us-east"],
      blocking: false,
      risk: "low",
    });
    const answered = await req(`/requests/${request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "eu-central" }),
      headers: { "content-type": "application/json" },
    });
    expect(answered.status).toBe(200);
    const decisions = await jsonList(await req(`/projects/${str(card.id)}/decisions`));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ question: "Which cloud region?", chosen: "eu-central" });
  });

  it("exposes the peer feed of a project", async () => {
    const card = await json(
      await req("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Peers", goal: "A project with a second agent" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const bob = await rt.store.agent.insert({
      name: "Bob",
      owner_human_id: rt.human.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    await rt.store.project.patch(str(card.id), {
      settings: { members: [rt.agent.id, bob.id] } as never,
    });
    const task = await rt.store.task.insert({
      project_id: str(card.id),
      title: "Bob's task",
      outcome: "x",
      acceptance_criteria: [],
      risk_tier: 0,
      status: "ready",
      priority: 1,
      depends_on: [],
      budget_usd_micro: 0,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    await rt.store.task.claim(task.id, bob.id, 60_000, rt.clock.now(), { reason: "t" });
    const feed = await json(await req(`/projects/${str(card.id)}/peers`));
    const peers = feed.peers as { agentName: string; activeClaims: { taskId: string }[] }[];
    expect(peers).toHaveLength(1);
    expect(peers[0]?.agentName).toBe("Bob");
    expect(peers[0]?.activeClaims.map((c) => c.taskId)).toEqual([task.id]);
  });

  it("streams events over SSE, including a restart request", async () => {
    const res = await req("/events", { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: inbox.changed");
    // "Update and restart" is announced to the attached UI before the daemon goes down.
    rt.events.emit("restart", {
      schema: 1,
      reason: "update",
      targetVersion: "0.2.0",
      fromVersion: "0.1.0-test",
      requestedAt: clock.nowIso(),
      pid: process.pid,
      exitCode: RESTART_EXIT_CODE,
    });
    const next = new TextDecoder().decode((await reader.read()).value);
    expect(next).toContain("event: restart.requested");
    expect(next).toContain('"targetVersion":"0.2.0"');
    await reader.cancel();
  });

  it("stop() returns while a shell holds /events open (the restart contract needs a bounded stop)", async () => {
    const daemon = await startDaemon(rt, {});
    const res = await fetch(`${daemon.url}/events?token=${daemon.token}`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: inbox.changed");
    const stopped = await Promise.race([
      daemon.stop().then(() => "stopped"),
      new Promise<string>((r) => setTimeout(() => r("hung"), 2_000)),
    ]);
    expect(stopped).toBe("stopped");
    // The stream was ended from the server side, not left to the client.
    const rest = await reader.read().catch(() => ({ done: true as const, value: undefined }));
    expect(rest.done).toBe(true);
  });
});
