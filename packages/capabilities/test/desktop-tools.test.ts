import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import {
  AllowAllCaps,
  AutoApprove,
  EnforcementHooks,
  KillSwitch,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
  type RunContext,
  SessionBudget,
  TokenIssuer,
  type ToolExecutionContext,
  ToolRegistry,
} from "@forerunner/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDesktopAdapter } from "../src/desktop/adapters/fake.ts";
import { DesktopController } from "../src/desktop/controller.ts";
import { isDesktopDenial } from "../src/desktop/gate.ts";
import { RecordingIndicator } from "../src/desktop/indicator.ts";
import { DESKTOP_TOOL_NAMES, desktopTools, registerDesktopTools } from "../src/desktop/tools.ts";
import type { DesktopRunBinding, WindowInfo } from "../src/desktop/types.ts";

const code: WindowInfo = {
  id: "0x1",
  title: "main.ts - Code",
  exe: "code",
  windowClass: "code.Code",
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(binding: Partial<DesktopRunBinding> = {}) {
  const clock = new SimulatedClock();
  const audit = new MemoryAudit();
  const adapter = new FakeDesktopAdapter({ windows: [code], active: code });
  const dir = mkdtempSync(join(tmpdir(), "fr-desktop-tools-"));
  dirs.push(dir);
  const controller = new DesktopController({
    adapter,
    binding: async () => ({ enabled: true, autonomy: 3, allowlist: ["code"], ...binding }),
    indicator: new RecordingIndicator(),
    audit,
    clock,
    screenshotDir: () => join(dir, "shots"),
  });
  const tools = Object.fromEntries(desktopTools(controller).map((t) => [t.name, t]));
  return { controller, adapter, audit, tools, clock };
}

const ctx = (): ToolExecutionContext => ({
  runId: "r1",
  sessionId: "s1",
  agentId: "alice",
  humanId: "h1",
  allowedPaths: [],
  signal: new AbortController().signal,
});

describe("desktop tools", () => {
  it("registers the six tools, every one risk high with the gate in beforeCall", () => {
    const { controller, tools } = world();
    const registry = registerDesktopTools(new ToolRegistry(), controller);
    expect(registry.names()).toEqual([...DESKTOP_TOOL_NAMES].sort());
    for (const name of DESKTOP_TOOL_NAMES) {
      const t = tools[name];
      expect(t?.risk, name).toBe("high");
      expect(typeof t?.beforeCall, name).toBe("function");
      expect(t?.description, name).toMatch(/autonomy 3\+/);
    }
    expect(tools.desktop_list_windows?.actionClass).toBe("read");
    for (const name of [
      "desktop_focus",
      "desktop_type",
      "desktop_key",
      "desktop_click",
      "desktop_screenshot",
    ] as const) {
      expect(tools[name]?.actionClass, name).toBe("non_routine");
    }
  });

  it("validates inputs strictly", () => {
    const { tools } = world();
    expect(tools.desktop_list_windows?.schema.safeParse({ extra: 1 }).success).toBe(false);
    expect(tools.desktop_focus?.schema.safeParse({ app: "" }).success).toBe(false);
    expect(tools.desktop_focus?.schema.safeParse({ app: "code; rm" }).success).toBe(false);
    expect(tools.desktop_focus?.schema.safeParse({ app: "Code.exe" }).success).toBe(true);
    expect(tools.desktop_type?.schema.safeParse({ text: "" }).success).toBe(false);
    expect(tools.desktop_key?.schema.safeParse({ key: "x".repeat(65) }).success).toBe(false);
    expect(tools.desktop_click?.schema.safeParse({ x: -1, y: 0 }).success).toBe(false);
    expect(tools.desktop_click?.schema.safeParse({ x: 1, y: 2, button: "back" }).success).toBe(
      false,
    );
    expect(tools.desktop_click?.schema.safeParse({ x: 1, y: 2, button: "middle" }).success).toBe(
      true,
    );
    expect(tools.desktop_screenshot?.schema.safeParse({ includeInContext: "yes" }).success).toBe(
      false,
    );
  });

  it("beforeCall runs the gate: at autonomy 2 the adapter is never touched and the denial is audited", async () => {
    const { tools, adapter, audit } = world({ autonomy: 2 });
    const t = tools.desktop_type;
    if (!t) throw new Error("missing tool");
    const e = await t.beforeCall({ text: "hi" }, ctx()).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isForerunnerError(e, "autonomy_insufficient")).toBe(true);
    expect(isDesktopDenial(e, "autonomy")).toBe(true);
    expect(adapter.calls).toEqual([]);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        tool: "desktop_type",
        allowed: false,
        deniedReason: expect.stringContaining("autonomy_insufficient"),
      }),
    ]);
    const ok = world({ autonomy: 3 });
    await expect(ok.tools.desktop_type?.beforeCall({ text: "hi" }, ctx())).resolves.toBeUndefined();
    expect(ok.adapter.calls.map((c) => c.method)).toEqual(["activeWindow"]);
  });

  it("execute goes through the gate as well: a disabled capability refuses before the action", async () => {
    const { tools, adapter } = world({ enabled: false });
    for (const [name, input] of [
      ["desktop_list_windows", {}],
      ["desktop_focus", { app: "code" }],
      ["desktop_type", { text: "x" }],
      ["desktop_key", { key: "Return" }],
      ["desktop_click", { x: 1, y: 1 }],
      ["desktop_screenshot", {}],
    ] as const) {
      const t = tools[name];
      if (!t) throw new Error(`missing ${name}`);
      const e = await t.execute(input, ctx()).then(
        () => null,
        (err: unknown) => err,
      );
      expect(isDesktopDenial(e, "disabled"), name).toBe(true);
    }
    expect(adapter.calls).toEqual([]);
  });

  it("executes the six tools against the fake adapter and returns data, not images, by default", async () => {
    const { tools, adapter } = world();
    const run = async (name: (typeof DESKTOP_TOOL_NAMES)[number], input: unknown) => {
      const t = tools[name];
      if (!t) throw new Error(`missing ${name}`);
      return t.execute(input, ctx());
    };
    const list = await run("desktop_list_windows", {});
    expect(list.content).toContain("0x1 | code | code.Code | main.ts - Code");
    expect(list.untrusted).toEqual({ source: "tool_output", origin: "desktop" });
    expect((await run("desktop_focus", { app: "code" })).content).toMatch(/Focused code/);
    expect((await run("desktop_type", { text: "hello" })).content).toBe("Typed 5 characters.");
    expect((await run("desktop_key", { key: "ctrl+s" })).content).toBe("Pressed ctrl+s.");
    expect((await run("desktop_click", { x: 3, y: 4 })).content).toBe("left click at 3,4.");
    const shot = await run("desktop_screenshot", { includeInContext: true });
    expect(shot.content).toMatch(/saved to .*\.png/);
    expect(shot.content).toMatch(/not attached/);
    expect(shot.artifacts?.image).toBeUndefined();
    expect(adapter.calls.filter((c) => c.method === "screenshot")).toHaveLength(1);
  });
});

describe("desktop tools behind the enforcement hooks", () => {
  function hooksWorld(autonomy: 0 | 1 | 2 | 3 | 4) {
    const w = world({ autonomy });
    const tokens = new TokenIssuer({ now: () => w.clock.now() });
    const approvals = new AutoApprove("approved");
    const hooks = new EnforcementHooks({
      tokens,
      caps: new AllowAllCaps(),
      secrets: new NoSecrets(),
      kill: new KillSwitch(tokens),
      clock: w.clock,
      ledger: new MemoryLedger(),
      audit: w.audit,
      approvals,
    });
    const token = tokens.issue({
      runId: "r1",
      sessionId: "s1",
      agentId: "alice",
      ownerHumanId: "h1",
      allowedTools: [...DESKTOP_TOOL_NAMES],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy,
      planApproved: true,
      expiresAt: new Date(w.clock.now() + 3_600_000).toISOString(),
    });
    const rc: RunContext = {
      token,
      budget: new SessionBudget({
        sessionId: "s1",
        budgetUsdMicro: 1_000_000,
        stepCap: 100,
        deadlineMs: w.clock.now() + 3_600_000,
        reserveShare: 0.2,
      }),
      signal: new AbortController().signal,
      runDeadlineMs: w.clock.now() + 3_600_000,
      phase: "work",
      model: "fake",
      provider: "fake",
      billingSourceId: "b1",
      approvals: new Set(),
    };
    return { ...w, hooks, rc, approvals };
  }

  it("at autonomy 3 the hooks allow desktop_type and the tool runs", async () => {
    const w = hooksWorld(3);
    const t = w.tools.desktop_type;
    if (!t) throw new Error("missing tool");
    const decision = await w.hooks.beforeToolCall(w.rc, t, { text: "hi" });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const r = await t.execute(decision.input, { ...ctx(), signal: w.rc.signal });
    expect(r.content).toBe("Typed 2 characters.");
    expect(w.approvals.requests).toHaveLength(0);
  });

  it("at autonomy 2 a human's approval of the tool call does not open the desktop: the gate still refuses", async () => {
    const w = hooksWorld(2);
    const t = w.tools.desktop_click;
    if (!t) throw new Error("missing tool");
    const decision = await w.hooks.beforeToolCall(w.rc, t, { x: 1, y: 1 });
    expect(decision.allowed).toBe(true);
    expect(w.approvals.requests).toHaveLength(1);
    const e = await t.execute({ x: 1, y: 1 }, { ...ctx(), signal: w.rc.signal }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isDesktopDenial(e, "autonomy")).toBe(true);
    expect(w.adapter.calls).toEqual([]);
  });
});
