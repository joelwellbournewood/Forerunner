import { ForerunnerError } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import type { RunContext } from "../src/enforcement/hooks.ts";
import {
  AllowAllCaps,
  AutoApprove,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
} from "../src/enforcement/ports.ts";
import { ExtensionGate, GatedEnforcementHooks, gateTool } from "../src/extensions/gate.ts";
import { FAKE_CATALOG_ID, type RegistryHarness, registryHarness } from "./extensions-helpers.ts";
import { budget, echoTool } from "./helpers.ts";

const human = { humanId: "h-1" };

describe("extension gate in the enforcement hooks", () => {
  let h: RegistryHarness;
  afterEach(async () => {
    h.stopLogs();
    await h.registry.close();
    await h.store.close();
  });

  function makeHooks() {
    const gate = new ExtensionGate({
      registry: h.registry,
      clock: h.clock,
      audit: h.store.auditLog,
    });
    const audit = new MemoryAudit();
    const hooks = new GatedEnforcementHooks(
      {
        tokens: h.tokens,
        caps: new AllowAllCaps(),
        secrets: new NoSecrets(),
        kill: h.kill,
        clock: h.clock,
        ledger: new MemoryLedger(),
        audit,
        approvals: new AutoApprove("approved"),
      },
      gate,
    );
    return { gate, hooks, audit };
  }

  function run(tools: string[], runId = "run-1") {
    const controller = new AbortController();
    const token = h.tokens.issue({
      runId,
      sessionId: "sess-1",
      agentId: "alice",
      ownerHumanId: "h-1",
      allowedTools: tools,
      allowedPaths: [],
      allowedDomains: ["example.com", "*.example.com"],
      grantedSecrets: [],
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 1,
      autonomy: 3,
      planApproved: true,
      expiresAt: new Date(h.clock.now() + 3_600_000).toISOString(),
    });
    const unregister = h.kill.register({
      agentId: "alice",
      sessionId: "sess-1",
      controller,
      label: runId,
    });
    const ctx: RunContext = {
      token,
      budget: budget("sess-1", 5_000_000, h.clock),
      signal: controller.signal,
      runDeadlineMs: h.clock.now() + 60_000,
      phase: "work",
      model: "fake-haiku",
      provider: "fake",
      billingSourceId: "bs-1",
      approvals: new Set(),
    };
    return { ctx, token, controller, unregister };
  }

  it("lets an approved extension's tool through the hooks and wraps its output as untrusted", async () => {
    h = await registryHarness({ approval: "approved" });
    await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const { hooks } = makeHooks();
    const tool = h.registry.bridgedTool("fake.fetch_page");
    if (!tool) throw new Error("tool not bridged");
    const { ctx } = run(["fake.fetch_page"]);
    const decision = await hooks.beforeToolCall(ctx, tool, { url: "https://example.com/a" });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const result = await tool.execute(decision.input as Record<string, unknown>, {
      runId: "run-1",
      sessionId: "sess-1",
      agentId: "alice",
      humanId: "h-1",
      allowedPaths: [],
      signal: ctx.signal,
    });
    const post = await hooks.afterToolCall(ctx, tool, decision.input, result);
    expect(post.content).toContain("<<<UNTRUSTED_CONTENT source=tool_output");
    expect(post.report?.suspicious).toBe(true);
    expect(h.calls).toEqual([{ name: "fetch_page", args: { url: "https://example.com/a" } }]);
  });

  it("refuses a tool while its extension is pending approval even though the token lists it", async () => {
    h = await registryHarness({ approval: "pending" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const { hooks } = makeHooks();
    const review = ext.review;
    if (!review) throw new Error("no review");
    // a tool spec with the extension id, as a run would hold it
    const spec = {
      ...echoTool,
      name: "fake.fetch_page",
      extensionId: ext.id,
      extensionName: "fake",
      mcpTool: "fetch_page",
    };
    const { ctx } = run(["fake.fetch_page"]);
    await expect(hooks.beforeToolCall(ctx, spec, { text: "x" })).rejects.toMatchObject({
      code: "approval_required",
    });
    const denied = await h.store.auditLog.list({ allowed: false });
    expect(denied).toHaveLength(1);
    expect(denied[0]?.denied_reason).toMatch(/waiting for approval/);
    expect(denied[0]?.token_id).toBe(ctx.token.claims.id);
  });

  it("disabling an extension refuses its tools in code and revokes a running run's token live", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const { hooks } = makeHooks();
    const tool = h.registry.bridgedTool("fake.post_comment");
    if (!tool) throw new Error("tool not bridged");
    const running = run(["fake.post_comment", "echo"]);
    expect(h.kill.activeCount({ sessionId: "sess-1" })).toBe(1);
    const first = await hooks.beforeToolCall(running.ctx, tool, {
      url: "https://example.com",
      body: "hi",
    });
    expect(first.allowed).toBe(true);

    await h.registry.toggle(ext.id, false, human);

    // the token the running run holds is revoked at once: every hook refuses it
    expect(h.tokens.isRevoked(running.token.claims.id)).toBe(true);
    await expect(hooks.beforeToolCall(running.ctx, echoTool, { text: "x" })).rejects.toMatchObject({
      code: "killed",
    });
    await expect(hooks.beforeModelCall(running.ctx, 1)).rejects.toMatchObject({ code: "killed" });
    // a fresh run with a fresh token is refused in code for this tool, not for others
    const fresh = run(["fake.post_comment", "echo"], "run-2");
    await expect(
      hooks.beforeToolCall(fresh.ctx, tool, { url: "https://example.com", body: "hi" }),
    ).rejects.toMatchObject({
      code: "tool_not_allowed",
    });
    const ok = await hooks.beforeToolCall(fresh.ctx, echoTool, { text: "x" });
    expect(ok.allowed).toBe(true);
    // the bridged tool itself is dead: its connection was closed
    await expect(
      tool.execute(
        { url: "https://example.com", body: "x" },
        {
          runId: "run-2",
          sessionId: "sess-1",
          agentId: "alice",
          humanId: "h-1",
          allowedPaths: [],
          signal: fresh.ctx.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "tool_not_allowed" });
    expect(h.calls.filter((c) => c.name === "post_comment")).toHaveLength(0);
    running.unregister();
    fresh.unregister();
  });

  it("refuses a tool whose extension was removed", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const { hooks } = makeHooks();
    const tool = h.registry.bridgedTool("fake.fetch_page");
    if (!tool) throw new Error("tool not bridged");
    await h.registry.remove(ext.id, human);
    const { ctx } = run(["fake.fetch_page"], "run-3");
    await expect(
      hooks.beforeToolCall(ctx, tool, { url: "https://example.com" }),
    ).rejects.toMatchObject({
      code: "tool_not_allowed",
      details: { extensionId: ext.id },
    });
  });

  it("enforces the extension's own domain and path ceilings and ignores tools of no extension", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const { gate, hooks } = makeHooks();
    const tool = h.registry.bridgedTool("fake.fetch_page");
    if (!tool) throw new Error("tool not bridged");
    const { ctx } = run(["fake.fetch_page", "echo"]);
    // the token allows *.example.com, the extension grant only example.com
    await expect(
      hooks.beforeToolCall(ctx, tool, { url: "https://api.example.com/x" }),
    ).rejects.toMatchObject({
      code: "domain_not_allowed",
      details: { extensionId: ext.id },
    });
    expect((await hooks.beforeToolCall(ctx, tool, { url: "https://example.com/x" })).allowed).toBe(
      true,
    );
    await expect(
      gate.check({ ...tool, pathFields: ["path"] }, { input: { path: "/somewhere/else" } }),
    ).resolves.toBeUndefined();
    await h.registry.updatePermissions(ext.id, { paths: [] }, human);
    await expect(gate.check(echoTool, { input: { text: "x" } })).resolves.toBeUndefined();
    // capability tools are gated through the tool index of the rows
    await h.registry.addFromCatalog("browser", human);
    const browserOpen = { ...echoTool, name: "browser.open" };
    await expect(gate.check(browserOpen)).resolves.toBeUndefined();
    const browser = (await h.registry.list({ kind: "capability" }))[0];
    await h.registry.toggle(browser?.id ?? "", false, human);
    await expect(gate.check(browserOpen)).rejects.toMatchObject({ code: "tool_not_allowed" });
  });

  it("gateTool() refuses execute() of a disabled extension without any hooks", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const { gate } = makeHooks();
    const tool = h.registry.bridgedTool("fake.fetch_page");
    if (!tool) throw new Error("tool not bridged");
    const gated = gateTool(tool, gate);
    const ctx = {
      runId: "r",
      sessionId: "s",
      agentId: "a",
      humanId: "h",
      allowedPaths: [],
      signal: new AbortController().signal,
    };
    expect((await gated.execute({ url: "https://example.com" }, ctx)).content).toContain("page at");
    await h.registry.toggle(ext.id, false, human);
    await expect(gated.execute({ url: "https://example.com" }, ctx)).rejects.toBeInstanceOf(
      ForerunnerError,
    );
  });
});
