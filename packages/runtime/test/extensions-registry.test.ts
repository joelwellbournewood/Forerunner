import { afterEach, describe, expect, it } from "vitest";
import { HumanRequestExtensionApprovals } from "../src/extensions/approvals.ts";
import { widens } from "../src/extensions/types.ts";
import {
  FAKE_CATALOG_ID,
  FAKE_TOKEN_VALUE,
  fakeCatalogEntry,
  type RegistryHarness,
  registryHarness,
  startHttpFixture,
} from "./extensions-helpers.ts";

const human = { humanId: "h-1" };

describe("ExtensionRegistry: install needs a human", () => {
  let h: RegistryHarness;
  afterEach(async () => {
    h.stopLogs();
    await h.registry.close();
    await h.store.close();
  });

  it("adds a connector from the catalog as pending_approval and asks through the port with the review", async () => {
    h = await registryHarness();
    const view = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    expect(view.status).toBe("pending_approval");
    expect(view.enabled).toBe(false);
    expect(view.kind).toBe("connector");
    expect(view.source).toBe(`catalog:${FAKE_CATALOG_ID}`);
    expect(view.permissions.tools).toEqual(["fake.fetch_page", "fake.post_comment"]);
    expect(view.permissions.secrets).toEqual(["fake_token"]);
    expect(view.permissions.scopes).toEqual(["comment on example.com pages"]);
    expect(view.review?.tools).toHaveLength(2);
    expect(view.connected).toBe(false);
    // discovery connected once and closed again; nothing callable yet
    expect(h.seen).toHaveLength(1);
    expect(h.registry.bridgedTools()).toEqual([]);
    const req = h.approvals.last();
    expect(req).toMatchObject({
      extensionId: view.id,
      name: "fake",
      kind: "connector",
      humanId: "h-1",
      previous: null,
    });
    expect(req?.review.summary).toContain("tool fake.post_comment: external_send (high risk)");
    expect(req?.why).toMatch(/granting a new capability/i);
    const row = await h.store.extension.mustGet(view.id);
    expect(row.status).toBe("pending_approval");
    expect(h.events.map((e) => e.type)).toEqual(["extension.requested"]);
    const audit = await h.store.auditLog.list({ tool: "extensions.add" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.human_id).toBe("h-1");
    expect(JSON.stringify([req, row, audit])).not.toContain(FAKE_TOKEN_VALUE);
  });

  it("stays pending until the human says yes, then enables, connects and bridges the tools", async () => {
    h = await registryHarness();
    const pending = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    let sync = await h.registry.syncApprovals(human);
    expect(sync).toEqual({ approved: [], denied: [] });
    expect((await h.registry.get(pending.id)).status).toBe("pending_approval");
    await expect(h.registry.toggle(pending.id, true, human)).rejects.toMatchObject({
      code: "approval_required",
    });
    h.approvals.answer(h.approvals.last()?.requestId ?? "", true);
    sync = await h.registry.syncApprovals(human);
    expect(sync.approved).toEqual([pending.id]);
    const view = await h.registry.get(pending.id);
    expect(view.status).toBe("enabled");
    expect(view.enabled).toBe(true);
    expect(view.connected).toBe(true);
    expect(h.registry.bridgedTools().map((t) => t.name)).toEqual([
      "fake.fetch_page",
      "fake.post_comment",
    ]);
    expect(await h.registry.lookupTool("fake.fetch_page")).toBe(pending.id);
    // the live connection received the resolved secret, the rows never did
    const live = h.seen[h.seen.length - 1]?.spec;
    if (live?.type === "stdio") expect(live.env.FAKE_TOKEN).toBe(FAKE_TOKEN_VALUE);
    const rows = await h.store.extension.list();
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN_VALUE);
    expect(h.events.map((e) => e.type)).toEqual([
      "extension.requested",
      "extension.approved",
      "extension.enabled",
    ]);
    const ops = (await h.store.auditLog.list()).map((a) => a.tool);
    expect(ops).toEqual(["extensions.add", "extensions.approve"]);
  });

  it("removes the row when the human says no", async () => {
    h = await registryHarness({ approval: "denied" });
    await expect(h.registry.addFromCatalog(FAKE_CATALOG_ID, human)).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(await h.store.extension.list()).toEqual([]);
    expect(h.events.map((e) => e.type)).toEqual(["extension.requested", "extension.denied"]);
    expect((await h.store.auditLog.list()).map((a) => a.tool)).toEqual([
      "extensions.add",
      "extensions.deny",
    ]);
  });

  it("installs a capability from the catalog with the declared scopes and refuses duplicates", async () => {
    h = await registryHarness({ approval: "approved" });
    const view = await h.registry.addFromCatalog("browser", human);
    expect(view.kind).toBe("capability");
    expect(view.status).toBe("enabled");
    expect(view.permissions.tools).toContain("browser.open");
    expect(view.permissions.scopes).toContain("screenshots are logged");
    expect(view.review?.summary).toContain("scope: screenshots are logged");
    await expect(h.registry.addFromCatalog("browser", human)).rejects.toMatchObject({
      code: "validation",
    });
    await expect(h.registry.addFromCatalog("no-such-entry", human)).rejects.toMatchObject({
      code: "not_found",
    });
    const list = await h.registry.list({ kind: "capability" });
    expect(list.map((e) => e.name)).toEqual(["browser"]);
    expect(await h.registry.list({ kind: "connector" })).toEqual([]);
  });
});

describe("ExtensionRegistry: toggle, remove, permissions", () => {
  let h: RegistryHarness;
  afterEach(async () => {
    h.stopLogs();
    await h.registry.close();
    await h.store.close();
  });

  function issueToken(tools: string[], runId = "run-1") {
    return h.tokens.issue({
      runId,
      sessionId: "sess-1",
      agentId: "alice",
      ownerHumanId: "h-1",
      allowedTools: tools,
      allowedPaths: [],
      allowedDomains: ["example.com"],
      grantedSecrets: [],
      budgetUsdMicro: 1000,
      depth: 0,
      maxDepth: 1,
      autonomy: 2,
      planApproved: false,
      expiresAt: new Date(h.clock.now() + 3_600_000).toISOString(),
    });
  }

  it("disabling revokes every token that lists its tools and closes the connection; re-enabling needs no approval", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    expect(ext.status).toBe("enabled");
    const withTool = issueToken(["echo", "fake.fetch_page"], "run-a");
    const without = issueToken(["echo"], "run-b");
    const asked = h.approvals.requests.length;
    const off = await h.registry.toggle(ext.id, false, human);
    expect(off.status).toBe("disabled");
    expect(off.connected).toBe(false);
    expect(h.tokens.isRevoked(withTool.claims.id)).toBe(true);
    expect(h.tokens.isRevoked(without.claims.id)).toBe(false);
    expect(() => h.tokens.verify(withTool, h.clock.now())).toThrow(/revoked/);
    expect(h.registry.bridgedTools()).toEqual([]);
    const disabled = h.events.find((e) => e.type === "extension.disabled");
    expect(disabled?.detail.revokedTokens).toEqual([withTool.claims.id]);
    const on = await h.registry.toggle(ext.id, true, human);
    expect(on.status).toBe("enabled");
    expect(on.connected).toBe(true);
    expect(h.approvals.requests.length).toBe(asked);
    expect(h.registry.bridgedTools()).toHaveLength(2);
    expect((await h.store.auditLog.list()).map((a) => a.tool)).toEqual([
      "extensions.add",
      "extensions.approve",
      "extensions.disable",
      "extensions.enable",
    ]);
  });

  it("removing closes the connection, deletes the row and revokes live tokens", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const token = issueToken(["fake.post_comment"]);
    expect(h.registry.isConnected(ext.id)).toBe(true);
    await h.registry.remove(ext.id, human);
    expect(h.registry.isConnected(ext.id)).toBe(false);
    expect(await h.store.extension.get(ext.id)).toBeUndefined();
    expect(h.tokens.isRevoked(token.claims.id)).toBe(true);
    expect(await h.registry.lookupTool("fake.post_comment")).toBeUndefined();
    await expect(h.registry.get(ext.id)).rejects.toMatchObject({ code: "not_found" });
    expect(h.events[h.events.length - 1]?.type).toBe("extension.removed");
    expect((await h.store.auditLog.list({ tool: "extensions.remove" }))[0]?.human_id).toBe("h-1");
  });

  it("narrowing permissions applies at once and revokes tokens that list a removed tool", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const postToken = issueToken(["fake.post_comment"], "run-p");
    const fetchToken = issueToken(["fake.fetch_page"], "run-f");
    const asked = h.approvals.requests.length;
    const view = await h.registry.updatePermissions(ext.id, { tools: ["fake.fetch_page"] }, human);
    expect(view.status).toBe("enabled");
    expect(view.permissions.tools).toEqual(["fake.fetch_page"]);
    expect(h.approvals.requests.length).toBe(asked);
    expect(h.tokens.isRevoked(postToken.claims.id)).toBe(true);
    expect(h.tokens.isRevoked(fetchToken.claims.id)).toBe(false);
    expect(h.registry.bridgedTools().map((t) => t.name)).toEqual(["fake.fetch_page"]);
    expect(await h.registry.lookupTool("fake.post_comment")).toBeUndefined();
    expect(h.events[h.events.length - 1]?.type).toBe("extension.permissions_updated");
  });

  it("widening permissions is a new grant: pending until yes, previous grant kept on no", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    const token = issueToken(["fake.fetch_page"]);
    h.approvals.setMode("pending");
    const pending = await h.registry.updatePermissions(
      ext.id,
      {
        domains: ["example.com", "api.example.org"],
        scopes: ["comment on example.com pages", "read api.example.org"],
      },
      human,
    );
    expect(pending.status).toBe("pending_approval");
    expect(pending.permissions.domains).toEqual(["example.com"]);
    expect(pending.pendingPermissions?.domains).toEqual(["api.example.org", "example.com"]);
    expect(pending.review?.summary).toContain("adds domains:api.example.org");
    expect(h.tokens.isRevoked(token.claims.id)).toBe(true);
    expect(pending.connected).toBe(false);
    const req = h.approvals.last();
    expect(req?.previous?.domains).toEqual(["example.com"]);
    expect(req?.permissions.domains).toEqual(["api.example.org", "example.com"]);
    await expect(
      h.registry.updatePermissions(ext.id, { domains: [] }, human),
    ).rejects.toMatchObject({
      code: "approval_required",
    });
    // no: the old grant stays, the extension is left disabled
    await h.registry.deny(ext.id, human);
    const after = await h.registry.get(ext.id);
    expect(after.status).toBe("disabled");
    expect(after.permissions.domains).toEqual(["example.com"]);
    expect(after.pendingPermissions).toBeNull();
    // yes on a second try
    h.approvals.setMode("approved");
    const widened = await h.registry.updatePermissions(
      ext.id,
      { domains: ["example.com", "api.example.org"] },
      human,
    );
    expect(widened.status).toBe("enabled");
    expect(widened.permissions.domains).toEqual(["api.example.org", "example.com"]);
    expect(widened.connected).toBe(true);
  });

  it("widens() lists only what is new", () => {
    const base = {
      tools: ["a"],
      actionClasses: ["read" as const],
      domains: [],
      paths: [],
      secrets: [],
      scopes: [],
    };
    expect(widens(base, base)).toEqual([]);
    expect(widens(base, { ...base, tools: [] })).toEqual([]);
    expect(widens(base, { ...base, tools: ["a", "b"], secrets: ["s"] })).toEqual([
      "tools:b",
      "secrets:s",
    ]);
  });

  it("records cost against the extension and shows it in CHF", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    await h.registry.recordCost(ext.id, 1_500_000);
    await h.registry.recordCost(ext.id, 500_000);
    await h.registry.recordCost(ext.id, -5);
    const view = await h.registry.get(ext.id);
    expect(view.cost).toEqual({ usdMicro: 2_000_000, chfMicro: 1_600_000 });
  });

  it("marks a connector that fails to connect as error, without an approval", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    await h.vault.delete("fake_token");
    const off = await h.registry.toggle(ext.id, false, human);
    expect(off.status).toBe("disabled");
    const on = await h.registry.toggle(ext.id, true, human);
    expect(on.status).toBe("error");
    expect(on.enabled).toBe(false);
    expect(on.error).toMatch(/not in the vault/);
    expect(h.events[h.events.length - 1]?.type).toBe("extension.error");
    await h.vault.set("fake_token", FAKE_TOKEN_VALUE);
    const again = await h.registry.toggle(ext.id, true, human);
    expect(again.status).toBe("enabled");
  });

  it("start() reconnects enabled connectors after a restart", async () => {
    h = await registryHarness({ approval: "approved" });
    const ext = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
    await h.registry.close();
    expect(h.registry.isConnected(ext.id)).toBe(false);
    await h.registry.start();
    expect(h.registry.isConnected(ext.id)).toBe(true);
    expect(h.registry.bridgedTools()).toHaveLength(2);
  });
});

describe("ExtensionRegistry: add from URL", () => {
  let h: RegistryHarness;
  afterEach(async () => {
    h.stopLogs();
    await h.registry.close();
    await h.store.close();
  });

  it("installs a manifest served over http and records the URL as the source", async () => {
    const manifest = fakeCatalogEntry({ id: "from-url", name: "from-url" });
    const http = await startHttpFixture({
      "/ext.json": manifest,
      "/many.json": { version: 1, entries: [manifest, fakeCatalogEntry()] },
    });
    try {
      h = await registryHarness({ approval: "approved" });
      const view = await h.registry.addFromUrl(http.url("/ext.json"), human);
      expect(view.name).toBe("from-url");
      expect(view.source).toBe(http.url("/ext.json"));
      expect(view.status).toBe("enabled");
      expect(view.permissions.tools).toEqual(["from-url.fetch_page", "from-url.post_comment"]);
      await expect(h.registry.addFromUrl(http.url("/many.json"), human)).rejects.toMatchObject({
        code: "validation",
      });
      await expect(h.registry.addFromUrl("ftp://x/y", human)).rejects.toMatchObject({
        code: "validation",
      });
    } finally {
      await http.close();
    }
  });

  it("treats a URL without a manifest as a streamable-HTTP MCP server and reviews it live", async () => {
    const http = await startHttpFixture({});
    try {
      h = await registryHarness({ approval: "pending" });
      // the default transport factory (real HTTP) is used for this one
      const { ExtensionRegistry } = await import("../src/extensions/registry.ts");
      const { DefaultMcpConnectorFactory } = await import("../src/extensions/mcp.ts");
      const registry = new ExtensionRegistry({
        extensions: h.store.extension,
        audit: h.store.auditLog,
        clock: h.clock,
        catalog: h.registry.catalog,
        approvals: h.approvals,
        connectors: new DefaultMcpConnectorFactory({ connectTimeoutMs: 5000, callTimeoutMs: 5000 }),
        secrets: h.secrets,
        tokens: h.tokens,
        events: (e) => h.events.push(e),
      });
      const url = http.url("/mcp");
      const view = await registry.addFromUrl(url, human);
      expect(view.status).toBe("pending_approval");
      expect(view.kind).toBe("connector");
      expect(view.name).toBe("host-127-0-0-1");
      expect(view.source).toBe(url);
      expect(view.permissions.domains).toEqual(["127.0.0.1"]);
      expect(view.permissions.tools).toEqual([
        "host-127-0-0-1.fetch_page",
        "host-127-0-0-1.post_comment",
      ]);
      expect(view.review?.resources[0]?.uri).toBe("fake://readme");
      expect(http.hits[0]).toBe("GET /mcp");
      h.approvals.answer(h.approvals.last()?.requestId ?? "", true);
      await registry.syncApprovals(human);
      const live = await registry.get(view.id);
      expect(live.status).toBe("enabled");
      const tool = registry.bridgedTool("host-127-0-0-1.fetch_page");
      const result = await tool?.execute(
        { url: "https://example.com/p" },
        {
          runId: "r",
          sessionId: "s",
          agentId: "a",
          humanId: "h",
          allowedPaths: [],
          signal: new AbortController().signal,
        },
      );
      expect(result?.content).toContain("page at https://example.com/p");
      await registry.close();
    } finally {
      await http.close();
    }
  });
});

describe("HumanRequestExtensionApprovals", () => {
  it("creates a blocking high-risk approval request with the review as options and reads the answer", async () => {
    const h = await registryHarness();
    try {
      await h.store.human.insert({ id: "h-1", name: "Joel", email: "joel@example.test" });
      const port = new HumanRequestExtensionApprovals(h.store.humanRequest);
      const pending = await h.registry.addFromCatalog(FAKE_CATALOG_ID, human);
      const req = h.approvals.last();
      if (!req) throw new Error("no request");
      const { requestId, ...grant } = req;
      const answer = await port.ask(grant);
      expect(answer.outcome).toBe("pending");
      const row = await h.store.humanRequest.mustGet(answer.requestId ?? "");
      expect(row).toMatchObject({
        kind: "approval",
        risk: "high",
        blocking: true,
        human_id: "h-1",
      });
      expect(row.steps).toContain("tool fake.post_comment: external_send (high risk)");
      expect((row.options[0] as { choice: string }).choice).toBe("approve");
      expect((row.change_card as { extensionId: string }).extensionId).toBe(pending.id);
      expect(JSON.stringify(row)).not.toContain(FAKE_TOKEN_VALUE);
      expect(await port.status(row.id)).toBe("pending");
      await h.store.humanRequest.answer(row.id, row.version, "yes", "h-1");
      expect(await port.status(row.id)).toBe("approved");
      const no = await port.ask(grant);
      const noRow = await h.store.humanRequest.mustGet(no.requestId ?? "");
      await h.store.humanRequest.answer(noRow.id, noRow.version, "no", "h-1");
      expect(await port.status(noRow.id)).toBe("denied");
      expect(await port.status("missing")).toBe("denied");
      expect(requestId).toBeTruthy();
    } finally {
      h.stopLogs();
      await h.registry.close();
      await h.store.close();
    }
  });
});
