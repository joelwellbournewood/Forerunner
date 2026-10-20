import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import {
  AllowAllCaps,
  AutoApprove,
  EnforcementHooks,
  KillSwitch,
  MemoryAudit,
  MemoryLedger,
  type RunContext,
  SessionBudget,
  TokenIssuer,
  type ToolExecutionContext,
  ToolRegistry,
} from "@forerunner/runtime";
import { MemoryVault, SecretResolver } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { FakeBrowserApprovals } from "../src/browser/guards.ts";
import {
  BROWSER_TOOL_NAMES,
  BrowserSessionManager,
  browserTools,
  registerBrowserTools,
} from "../src/browser/tools.ts";

function manager(opts: { autonomy?: 0 | 1 | 2 | 3 | 4 } = {}) {
  const audit = new MemoryAudit();
  const m = new BrowserSessionManager({
    binding: () => ({ allowedDomains: ["allowed.test"], autonomy: opts.autonomy ?? 2 }),
    approvals: new FakeBrowserApprovals("approved"),
    audit,
    clock: new SimulatedClock(),
    launch: { executablePath: "/nonexistent/chromium-for-tests" },
  });
  return { m, audit };
}

describe("browser tools (no browser)", () => {
  it("registers the eight tools with the right classes and risk", () => {
    const { m } = manager();
    const registry = registerBrowserTools(new ToolRegistry(), m);
    expect(registry.names()).toEqual([...BROWSER_TOOL_NAMES].sort());
    const by = Object.fromEntries(browserTools(m).map((t) => [t.name, t]));
    expect(by.browser_navigate).toMatchObject({
      actionClass: "read",
      risk: "low",
      domainFields: ["url"],
    });
    expect(by.browser_read).toMatchObject({ actionClass: "read", risk: "low" });
    expect(by.browser_click).toMatchObject({ actionClass: "routine_reversible", risk: "medium" });
    expect(by.browser_type).toMatchObject({ actionClass: "routine_reversible", risk: "medium" });
    expect(by.browser_fill_secret).toMatchObject({ actionClass: "credential", risk: "high" });
    expect(by.browser_screenshot).toMatchObject({ actionClass: "read", risk: "low" });
    expect(by.browser_download).toMatchObject({
      actionClass: "read",
      risk: "medium",
      domainFields: ["url"],
    });
    expect(by.browser_close).toMatchObject({ actionClass: "read", risk: "low" });
  });

  it("validates inputs: http(s) URLs only, one of url or selector for downloads", () => {
    const { m } = manager();
    const by = Object.fromEntries(browserTools(m).map((t) => [t.name, t]));
    expect(by.browser_navigate?.schema.safeParse({ url: "file:///etc/passwd" }).success).toBe(
      false,
    );
    expect(by.browser_navigate?.schema.safeParse({ url: "https://allowed.test/" }).success).toBe(
      true,
    );
    expect(by.browser_download?.schema.safeParse({}).success).toBe(false);
    expect(
      by.browser_download?.schema.safeParse({ url: "https://a.test/f", selector: "#x" }).success,
    ).toBe(false);
    expect(by.browser_download?.schema.safeParse({ selector: "#x" }).success).toBe(true);
    expect(by.browser_close?.schema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("read, click, type and screenshot refuse to run before a navigation", async () => {
    const { m } = manager();
    const by = Object.fromEntries(browserTools(m).map((t) => [t.name, t]));
    const ctx: ToolExecutionContext = {
      runId: "r1",
      sessionId: "s1",
      agentId: "alice",
      humanId: "h1",
      allowedPaths: [],
      signal: new AbortController().signal,
    };
    for (const name of ["browser_read", "browser_click", "browser_type", "browser_screenshot"]) {
      await expect(by[name]?.execute({ selector: "#x", text: "a" }, ctx)).rejects.toSatisfy((e) =>
        isForerunnerError(e, "validation"),
      );
    }
    expect((await by.browser_close?.execute({}, ctx))?.content).toContain("No browser session");
    expect(m.openSessions).toBe(0);
  });

  it("surfaces an unavailable browser as a ForerunnerError without touching the profile twice", async () => {
    const { m } = manager();
    const by = Object.fromEntries(browserTools(m).map((t) => [t.name, t]));
    const ctx: ToolExecutionContext = {
      runId: "r1",
      sessionId: "s1",
      agentId: "alice",
      humanId: "h1",
      allowedPaths: [],
      signal: new AbortController().signal,
    };
    const err = await by.browser_navigate
      ?.execute({ url: "https://allowed.test/" }, ctx)
      .catch((e) => e);
    expect(isForerunnerError(err, "unavailable")).toBe(true);
    expect(m.openSessions).toBe(0);
    expect((await m.revoke("all")).sessions).toBe(0);
  });
});

describe("browser tools behind the enforcement hooks", () => {
  function world(allowedDomains: string[], grantedSecrets: string[] = []) {
    const clock = new SimulatedClock();
    const tokens = new TokenIssuer({ now: () => clock.now() });
    const audit = new MemoryAudit();
    const vault = new MemoryVault({ shop_login: "correct-horse-battery" }); // not-a-secret
    const secrets = new SecretResolver(vault);
    const approvals = new AutoApprove("approved");
    const hooks = new EnforcementHooks({
      tokens,
      caps: new AllowAllCaps(),
      secrets,
      kill: new KillSwitch(tokens),
      clock,
      ledger: new MemoryLedger(),
      audit,
      approvals,
    });
    const token = tokens.issue({
      runId: "r1",
      sessionId: "s1",
      agentId: "alice",
      ownerHumanId: "h1",
      allowedTools: [...BROWSER_TOOL_NAMES],
      allowedPaths: [],
      allowedDomains,
      grantedSecrets,
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: 2,
      planApproved: true,
      expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
    });
    const ctx: RunContext = {
      token,
      budget: new SessionBudget({
        sessionId: "s1",
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
      billingSourceId: "b1",
      approvals: new Set(),
    };
    const { m } = manager();
    const tools = Object.fromEntries(browserTools(m).map((t) => [t.name, t]));
    return { hooks, ctx, tools, audit, approvals, m };
  }

  it("denies navigation outside the token domains before any browser exists", async () => {
    const w = world(["allowed.test"]);
    const navigate = w.tools.browser_navigate;
    if (!navigate) throw new Error("missing tool");
    await expect(
      w.hooks.beforeToolCall(w.ctx, navigate, { url: "https://evil.test/" }),
    ).rejects.toSatisfy((e) => isForerunnerError(e, "domain_not_allowed"));
    expect(w.audit.entries.at(-1)).toMatchObject({ tool: "browser_navigate", allowed: false });
    expect(w.m.openSessions).toBe(0);
    const ok = await w.hooks.beforeToolCall(w.ctx, navigate, { url: "https://allowed.test/x" });
    expect(ok.allowed).toBe(true);
  });

  it("resolves a granted secret reference for browser_fill_secret and asks the human first", async () => {
    const w = world(["allowed.test"], ["shop_login"]);
    const fill = w.tools.browser_fill_secret;
    if (!fill) throw new Error("missing tool");
    const decision = await w.hooks.beforeToolCall(w.ctx, fill, {
      selector: "#password",
      secret: "secret:shop_login",
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("denied");
    expect((decision.input as { secret: string }).secret).toBe("correct-horse-battery");
    expect(w.approvals.requests).toHaveLength(1);
    expect(w.approvals.requests[0]).toMatchObject({
      tool: "browser_fill_secret",
      actionClass: "credential",
    });
    expect(JSON.stringify(w.approvals.requests[0]?.input)).toContain("secret:shop_login");
    expect(JSON.stringify(w.approvals.requests[0]?.input)).not.toContain("correct-horse-battery");
  });

  it("refuses a secret the token does not grant", async () => {
    const w = world(["allowed.test"]);
    const fill = w.tools.browser_fill_secret;
    if (!fill) throw new Error("missing tool");
    await expect(
      w.hooks.beforeToolCall(w.ctx, fill, { selector: "#password", secret: "secret:shop_login" }),
    ).rejects.toSatisfy((e) => isForerunnerError(e, "secret_not_granted"));
  });
});
