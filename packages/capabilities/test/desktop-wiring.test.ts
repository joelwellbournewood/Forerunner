import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  composeRuntime,
  createDaemonApp,
  DAEMON_ROUTES,
  DESKTOP_INDICATOR_EVENT,
  DesktopIndicatorEventData,
  type DesktopIndicatorPayload,
  DesktopStatusView,
  type RunContext,
  type RuntimeApp,
  SessionBudget,
  type ToolExecutionContext,
  type ToolSpec,
} from "@forerunner/runtime";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeDesktopAdapter } from "../src/desktop/adapters/fake.ts";
import { MemoryAllowlistStore } from "../src/desktop/allowlist.ts";
import { isDesktopDenial } from "../src/desktop/gate.ts";
import { DESKTOP_TOOL_NAMES, type DesktopToolName } from "../src/desktop/tools.ts";
import { DESKTOP_CAPABILITY_NAME, type WindowInfo } from "../src/desktop/types.ts";

/**
 * Desktop control inside the running system (ADR 0021, ADR 0039): `composeRuntime` registers
 * the six `desktop_*` tools in the daemon's tool registry behind the daemon's own hooks and
 * the extension gate, the catalog entry names the real tools, the binding reads the extension
 * row, the project's autonomy and the human's allowlist, the routes are mounted behind the
 * bearer token, and the indicator is a frame on the runtime bus. Fake adapter, memory
 * allowlist, `sqlite::memory:`, memory vault, SimulatedClock; no provider, no desktop.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);

const code: WindowInfo = {
  id: "0x1",
  title: "main.ts - Code",
  exe: "code",
  windowClass: "code.Code",
};
const firefox: WindowInfo = {
  id: "0x2",
  title: "Bank login - Mozilla Firefox",
  exe: "firefox",
  windowClass: "Navigator.firefox",
};

describe("desktop control wired into the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let trustedProject = "";
  let standardProject = "";
  let extensionId = "";
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const adapter = new FakeDesktopAdapter({ windows: [code, firefox], active: code });
  const allowlist = new MemoryAllowlistStore();
  const indicator: DesktopIndicatorPayload[] = [];
  let SESSION = "";
  let runCounter = 0;
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const post = (path: string, body: unknown = {}) =>
    req(path, { method: "POST", body: JSON.stringify(body) });
  const put = (path: string, body: unknown) =>
    req(path, { method: "PUT", body: JSON.stringify(body) });
  const tool = (name: DesktopToolName): ToolSpec => {
    const t = rt.toolsForRun().get(name);
    if (!t) throw new Error(`tool ${name} is not registered`);
    return t;
  };
  /** A run of the daemon's own token issuer on a project, holding the six desktop tools. */
  const runContext = (
    projectId: string,
    autonomy: 0 | 1 | 2 | 3 | 4,
  ): { run: RunContext; ctx: ToolExecutionContext } => {
    const runId = `run-desktop-${++runCounter}`;
    const run: RunContext = {
      token: rt.tokens.issue({
        runId,
        sessionId: SESSION,
        agentId: rt.agent.id,
        ownerHumanId: rt.human.id,
        projectId,
        allowedTools: [...DESKTOP_TOOL_NAMES],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
        budgetUsdMicro: 1_000_000,
        depth: 0,
        maxDepth: 2,
        autonomy,
        planApproved: true,
        expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
      }),
      budget: new SessionBudget({
        sessionId: SESSION,
        budgetUsdMicro: 1_000_000,
        stepCap: 100,
        deadlineMs: clock.now() + 3_600_000,
        reserveShare: 0.2,
      }),
      signal: new AbortController().signal,
      runDeadlineMs: clock.now() + 3_600_000,
      phase: "work",
      model: "fake",
      provider: "fake",
      billingSourceId: rt.billingSourceId,
      approvals: new Set(),
    };
    const ctx: ToolExecutionContext = {
      runId,
      sessionId: SESSION,
      agentId: rt.agent.id,
      humanId: rt.human.id,
      projectId,
      allowedPaths: [],
      signal: run.signal,
    };
    return { run, ctx };
  };
  /** Through the hooks, then the tool: the daemon's path for a model's tool call. */
  const call = async (
    name: DesktopToolName,
    input: unknown,
    projectId: string,
    autonomy: 3 | 2,
  ) => {
    const { run, ctx } = runContext(projectId, autonomy);
    const t = tool(name);
    // The extension gate throws (a disabled extension); the autonomy table answers with a decision.
    const gated = await rt.hooks.beforeToolCall(run, t, input).then(
      (decision) => ({ decision, error: null as unknown }),
      (error: unknown) => ({ decision: null, error }),
    );
    const runId = ctx.runId;
    if (!gated.decision) return { runId, decision: null, result: null, error: gated.error };
    const decision = gated.decision;
    if (!decision.allowed) return { runId, decision, result: null, error: null };
    const outcome = await t.execute(decision.input, ctx).then(
      (result) => ({ result, error: null as unknown }),
      (error: unknown) => ({ result: null, error }),
    );
    return { runId, decision, ...outcome };
  };
  /** The complete SSE frames of an `/events` stream read so far (a cut-off tail waits). */
  const framesOf = (text: string) => {
    const parts = text.split("\n\n");
    return (text.endsWith("\n\n") ? parts : parts.slice(0, -1)).map((f) => f.split("\n"));
  };
  /** Read the stream until a frame of the event carries a payload the predicate accepts. */
  const nextFrame = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    event: string,
    accept: (payload: DesktopIndicatorPayload) => boolean,
  ): Promise<DesktopIndicatorPayload> => {
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 20; i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      for (const lines of framesOf(text)) {
        if (!lines.includes(`event: ${event}`)) continue;
        const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
        if (!data) continue;
        const payload = JSON.parse(data) as DesktopIndicatorPayload;
        if (accept(payload)) return payload;
      }
    }
    throw new Error(`no ${event} frame in:\n${text}`);
  };
  const deniedRows = (toolName: string) =>
    rt.store.auditLog.list({ tool: toolName, allowed: false } as never, { limit: 50 });
  const openRequests = () => rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-desktop-wiring-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
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
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      desktop: {
        adapter,
        allowlist,
        detect: async () => ({
          platform: "linux",
          displayServer: "x11",
          adapter,
          found: { xdotool: "/usr/bin/xdotool" },
          missing: [],
          notes: ["test detection"],
        }),
      },
    });
    rt.events.on(DESKTOP_INDICATOR_EVENT, (p: DesktopIndicatorPayload) => indicator.push(p));
    ({ app, token } = createDaemonApp(rt));
    trustedProject = str(
      (
        await json(
          await post("/projects", { name: "Trusted", goal: "autonomy 3", autonomyLevel: 3 }),
        )
      ).id,
    );
    standardProject = str(
      (
        await json(
          await post("/projects", { name: "Standard", goal: "autonomy 2", autonomyLevel: 2 }),
        )
      ).id,
    );
    // The session the runs belong to (approval requests reference it).
    SESSION = (
      await rt.store.session.insert({
        agent_id: rt.agent.id,
        project_id: null,
        trigger: "manual",
        plan: {},
        status: "running",
        started_at: clock.nowIso(),
        summary: "desktop wiring test",
        author_agent: rt.agent.id,
      })
    ).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("registers the six tools as built-in tools of the daemon and the catalog entry names exactly them", async () => {
    for (const name of DESKTOP_TOOL_NAMES) {
      expect(rt.tools.get(name)?.risk).toBe("high");
      expect(rt.toolsForRun().get(name)).toBeDefined();
    }
    const catalog = await json(await req("/extensions/catalog"));
    const entry = (catalog.entries as Json[]).find((e) => e.id === DESKTOP_CAPABILITY_NAME);
    const permissions = entry?.permissions as Json;
    expect([...(permissions.tools as string[])].sort()).toEqual([...DESKTOP_TOOL_NAMES].sort());
    expect(permissions.actionClasses).toEqual(["read", "non_routine"]);
    expect(entry?.requiresAutonomy).toBe(3);
    for (const key of [
      "desktopStatus",
      "desktopAllowlist",
      "setDesktopAllowlist",
      "desktopRevoke",
      "desktopResume",
    ] as const) {
      expect(DAEMON_ROUTES[key]).toMatch(/\/desktop\//);
    }
  });

  it("serves the status and the signed-in human's allowlist; another human's list answers 403", async () => {
    const status = await json(await req("/desktop/status"));
    expect(status).toMatchObject({
      capability: DESKTOP_CAPABILITY_NAME,
      adapter: "fake",
      revoked: false,
      detection: { platform: "linux", available: true, notes: ["test detection"] },
    });
    expect((await req("/desktop/status", {}, false)).status).toBe(401);
    expect((await put("/desktop/allowlist/someone-else", { entries: ["code"] })).status).toBe(403);
    const set = await put(`/desktop/allowlist/${rt.human.id}`, { entries: ["code"] });
    expect(set.status).toBe(200);
    expect(await json(set)).toMatchObject({ humanId: rt.human.id, entries: [{ app: "code" }] });
    expect(await json(await req(`/desktop/allowlist/${rt.human.id}`))).toMatchObject({
      entries: [{ app: "code" }],
    });
    const audits = await rt.store.auditLog.list({ tool: "desktop_allowlist" } as never, {
      limit: 10,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ allowed: true, human_id: rt.human.id });
  });

  it("is off by default: with the capability not installed the gate refuses in code and audits it, and the adapter is never touched", async () => {
    const { decision, error } = await call("desktop_focus", { app: "code" }, trustedProject, 3);
    expect(decision?.allowed).toBe(true);
    expect(isDesktopDenial(error, "disabled")).toBe(true);
    expect(adapter.calls).toEqual([]);
    const denied = await deniedRows("desktop_focus");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ agent_id: rt.agent.id, human_id: rt.human.id });
    expect(str(denied[0]?.denied_reason)).toMatch(/tool_not_allowed/);
  });

  it("a human installs and enables the capability from the catalog through the inbox", async () => {
    const added = await post("/extensions", { catalogId: DESKTOP_CAPABILITY_NAME });
    expect(added.status).toBe(202);
    const ext = await json(added);
    extensionId = str(ext.id);
    expect(ext.status).toBe("pending_approval");
    const request = (await openRequests()).find(
      (r) => (r.change_card as { extensionId?: string } | null)?.extensionId === extensionId,
    );
    if (!request) throw new Error("no approval request for the capability");
    expect(request).toMatchObject({ kind: "approval", blocking: true, risk: "high" });
    const answered = await post(`/requests/${request.id}/answer`, {
      version: request.version,
      answer: "approve",
    });
    expect(answered.status).toBe(200);
    expect(await json(await req(`/extensions/${extensionId}`))).toMatchObject({
      status: "enabled",
      enabled: true,
    });
  });

  it("an application outside the allowlist is refused by the gate, audited, and put to the human; nothing is focused", async () => {
    const { error } = await call("desktop_focus", { app: "firefox" }, trustedProject, 3);
    expect(isDesktopDenial(error, "app_not_allowed")).toBe(true);
    expect(adapter.calls.filter((c) => c.method === "focus")).toEqual([]);
    const denied = await deniedRows("desktop_focus");
    expect(denied).toHaveLength(2);
    expect(str(denied[1]?.denied_reason)).toMatch(/firefox/);
    // The one in-session widening a human may grant: a blocking request names the application.
    const ask = (await openRequests()).find(
      (r) =>
        (r.change_card as { key?: string } | null)?.key?.startsWith("desktop_allow_app:firefox") ??
        false,
    );
    expect(ask).toMatchObject({ kind: "approval", blocking: true, risk: "high" });
    expect(ask?.steps.join("\n")).toContain("firefox");
  });

  it("an allowlisted application runs through the fake adapter behind the hooks, audited, with the indicator on the bus", async () => {
    indicator.length = 0;
    const focused = await call("desktop_focus", { app: "code" }, trustedProject, 3);
    expect(focused.error).toBeNull();
    expect(focused.result?.content).toMatch(/^Focused code \(code\.Code\)/);
    const typed = await call("desktop_type", { text: "hello" }, trustedProject, 3);
    expect(typed.error).toBeNull();
    expect(typed.result?.content).toBe("Typed 5 characters.");
    expect(adapter.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(["listWindows", "focus", "activeWindow", "typeText"]),
    );
    const allowed = await rt.store.auditLog.list({ tool: "desktop_type", allowed: true } as never, {
      limit: 10,
    });
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ agent_id: rt.agent.id, human_id: rt.human.id });
    // The typed text never lands in the audit row, only its length.
    expect(str(allowed[0]?.input_summary)).not.toContain("hello");
    expect(indicator[0]).toMatchObject({ on: true, app: "code", agentId: rt.agent.id });
  });

  it("a shell on /events gets the indicator as the SSE event `desktop.indicator`: on with the app at the first action, off when the run ends", async () => {
    // The previous run's teardown: the indicator is off before the shell attaches.
    await rt.desktop.controller.endRun(`run-desktop-${runCounter}`);
    expect(indicator.at(-1)).toEqual({ on: false });
    const res = await req("/events", { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    try {
      const focused = await call("desktop_focus", { app: "code" }, trustedProject, 3);
      expect(focused.error).toBeNull();
      const on = await nextFrame(reader, DESKTOP_INDICATOR_EVENT, (p) => p.on);
      expect(on).toMatchObject({
        on: true,
        app: "code",
        agentId: rt.agent.id,
        humanId: rt.human.id,
        sessionId: SESSION,
        runId: focused.runId,
      });
      expect(on.at).toBe(clock.nowIso());
      // A shell that (re)connects re-reads the same state from the status view (ADR 0067).
      const during = DesktopStatusView.parse(await json(await req("/desktop/status")));
      expect(during.desktopControl).toEqual({
        active: true,
        app: "code",
        sessionId: SESSION,
        agentId: rt.agent.id,
        since: on.at,
      });
      expect(DesktopIndicatorEventData.parse(on)).toMatchObject({ on: true, app: "code" });
      // The run's teardown (the executor's `run_end` in the daemon) turns the indicator off.
      await rt.desktop.controller.endRun(focused.runId);
      const off = await nextFrame(reader, DESKTOP_INDICATOR_EVENT, (p) => !p.on);
      expect(off).toEqual({ on: false });
      expect(indicator.at(-1)).toEqual({ on: false });
      const after = DesktopStatusView.parse(await json(await req("/desktop/status")));
      expect(after.desktopControl).toEqual({
        active: false,
        app: null,
        sessionId: null,
        agentId: null,
        since: null,
      });
    } finally {
      await reader.cancel();
    }
  });

  it("autonomy 2 never opens the desktop, even with the capability enabled and the app allowlisted", async () => {
    const before = adapter.calls.length;
    const { decision } = await call("desktop_click", { x: 1, y: 1 }, standardProject, 2);
    // The hooks ask the human for a non-routine action at level 2 ...
    expect(decision?.allowed).toBe(false);
    // ... and the gate refuses on the project's level whoever calls the tool directly.
    const { ctx } = runContext(standardProject, 2);
    const e = await tool("desktop_click")
      .execute({ x: 1, y: 1 }, ctx)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(isDesktopDenial(e, "autonomy")).toBe(true);
    expect(adapter.calls.length).toBe(before);
  });

  it("toggling the capability off in the panel revokes live: the gate refuses until it is enabled again", async () => {
    const off = await post(`/extensions/${extensionId}/toggle`, { enabled: false });
    expect(off.status).toBe(200);
    expect(await json(await req("/desktop/status"))).toMatchObject({ revoked: true });
    const { error } = await call("desktop_focus", { app: "code" }, trustedProject, 3);
    expect(error).not.toBeNull();
    expect(indicator.at(-1)).toMatchObject({ on: false });
    const on = await post(`/extensions/${extensionId}/toggle`, { enabled: true });
    expect(on.status).toBe(200);
    expect(await json(await req("/desktop/status"))).toMatchObject({ revoked: false });
    const again = await call("desktop_list_windows", {}, trustedProject, 3);
    expect(again.error).toBeNull();
    expect(again.result?.content).toContain("0x1 | code | code.Code");
    expect(again.result?.content).not.toContain("firefox");
    expect(again.result?.content).toContain("1 window(s) of other applications hidden");
  });

  it("revoke from the panel is open to any caller; resume needs the signed-in human", async () => {
    const revoked = await post("/desktop/revoke", { reason: "panel" });
    expect(revoked.status).toBe(200);
    expect(await json(revoked)).toMatchObject({ reason: "panel", status: { revoked: true } });
    const resumed = await post("/desktop/resume");
    expect(resumed.status).toBe(200);
    expect(await json(resumed)).toMatchObject({ revoked: false });
    const audits = await rt.store.auditLog.list({ tool: "desktop_resume" } as never, { limit: 5 });
    expect(audits[0]).toMatchObject({ human_id: rt.human.id });
  });
});
