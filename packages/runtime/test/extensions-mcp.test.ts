import { Logger, type LogRecord } from "@forerunner/platform";
import { MemoryVault, SecretResolver } from "@forerunner/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoSecrets } from "../src/enforcement/ports.ts";
import type { ConnectorTransport } from "../src/extensions/catalog.ts";
import {
  assignBridgedNames,
  bridgedToolName,
  buildReview,
  defaultTransportFactory,
  inferActionClass,
  inferFields,
  isBridgedTool,
  McpConnector,
  ownsToolName,
  StdioMcpTransport,
  secretRefsOf,
  toolPrefixOf,
  transportDomains,
  transportPaths,
  withoutSecretRefs,
  zodFromJsonSchema,
} from "../src/extensions/mcp.ts";
import {
  FAKE_STDIO_SERVER_SCRIPT,
  FAKE_TOKEN_VALUE,
  fakeCatalogEntry,
  inMemoryConnectorFactory,
} from "./extensions-helpers.ts";

describe("MCP action class inference (ADR 0016)", () => {
  // name, annotations, class, inferredFrom: the name decides; annotations only tighten
  const cases: [string, Record<string, boolean>, string, string][] = [
    ["anything", { readOnlyHint: true }, "read", "annotation:readOnlyHint"],
    ["fetch_page", { readOnlyHint: true }, "read", "name:fetch,annotation:readOnlyHint"],
    [
      "list_files",
      { destructiveHint: true },
      "destructive",
      "annotation:destructiveHint,name:list",
    ],
    ["frobnicate", { destructiveHint: true }, "destructive", "annotation:destructiveHint"],
    // a server cannot label a severe verb read-only: class kept, conflict recorded
    [
      "delete_repository",
      { readOnlyHint: true },
      "destructive",
      "conflict:readOnlyHint,name:delete",
    ],
    [
      "create_issue",
      { readOnlyHint: true },
      "routine_reversible",
      "conflict:readOnlyHint,name:create",
    ],
    ["pay_invoice", { readOnlyHint: true }, "financial", "conflict:readOnlyHint,name:pay"],
    [
      "deploy_site",
      { readOnlyHint: true, destructiveHint: false },
      "deploy_production",
      "conflict:readOnlyHint,name:deploy",
    ],
    // destructiveHint never lowers a class that is already more severe
    ["purchase_credits", { destructiveHint: true }, "financial", "name:purchase"],
    ["delete_issue", {}, "destructive", "name:delete"],
    ["sendEmail", {}, "external_send", "name:send"],
    ["create_issue", {}, "routine_reversible", "name:create"],
    ["get_issue", {}, "read", "name:get"],
    ["search", {}, "read", "name:search"],
    ["run_command", {}, "non_routine", "name:run"],
    ["deploy_site", {}, "deploy_production", "name:deploy"],
    ["merge_pull_request", {}, "merge_pr", "name:merge"],
    ["purchase_credits", {}, "financial", "name:purchase"],
    ["frobnicate", {}, "non_routine", "default"],
  ];
  for (const [name, annotations, expected, from] of cases) {
    it(`${name} ${JSON.stringify(annotations)} -> ${expected} (${from})`, () => {
      expect(inferActionClass({ name, annotations })).toEqual({
        actionClass: expected,
        inferredFrom: from,
      });
    });
  }

  it("flags a read-only claim that contradicts the name in the review summary", () => {
    const review = buildReview({
      extensionName: "srv",
      transport: null,
      tools: [
        {
          name: "delete_repository",
          description: "",
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
      ],
      resources: [],
    });
    expect(review.tools[0]).toMatchObject({
      actionClass: "destructive",
      risk: "high",
      inferredFrom: "conflict:readOnlyHint,name:delete",
    });
    expect(review.risk).toBe("high");
    expect(review.summary).toContain(
      "tool srv.delete_repository: the server calls it read-only but its name says delete; kept destructive",
    );
  });

  it("gives colliding server tool names distinct bridged names, deterministically", () => {
    const tools = [
      { name: "read_file", description: "", inputSchema: {}, annotations: {} },
      { name: "read file", description: "", inputSchema: {}, annotations: {} },
      { name: "read/file", description: "", inputSchema: {}, annotations: {} },
    ];
    const names = assignBridgedNames("coll", tools);
    expect([...names.entries()]).toEqual([
      ["read file", "coll.read_file"],
      ["read/file", "coll.read_file_2"],
      ["read_file", "coll.read_file_3"],
    ]);
    expect(assignBridgedNames("coll", [...tools].reverse())).toEqual(names);
    const review = buildReview({ extensionName: "coll", transport: null, tools, resources: [] });
    expect(review.tools.map((t) => t.bridgedName)).toEqual([
      "coll.read_file",
      "coll.read_file_2",
      "coll.read_file_3",
    ]);
    expect(new Set(review.permissions.tools).size).toBe(3);
    expect(review.summary).toContain(
      'tool coll.read_file_2: server tool "read/file" (name collision, renamed)',
    );
  });

  it("names belong to their extension: prefix helpers", () => {
    expect(toolPrefixOf("My Server")).toBe("My_Server.");
    expect(ownsToolName("fake", "fake.fetch_page")).toBe(true);
    expect(ownsToolName("fake", "fake.")).toBe(false);
    expect(ownsToolName("fake", "echo")).toBe(false);
    expect(ownsToolName("browser", "browser.open")).toBe(true);
    expect(ownsToolName("shadow", "browser.open")).toBe(false);
  });

  it("withoutSecretRefs drops every secret reference and resolves nothing", () => {
    const stdio = withoutSecretRefs({
      type: "stdio",
      command: "x",
      args: [],
      env: { TOKEN: "secret:fake_token", PLAIN: "1" },
    });
    expect(stdio).toEqual({ type: "stdio", command: "x", args: [], env: { PLAIN: "1" } });
    const http = withoutSecretRefs({
      type: "http",
      url: "https://mcp.example.net/x",
      headers: { authorization: "secret:api", accept: "application/json" },
    });
    expect(http).toEqual({
      type: "http",
      url: "https://mcp.example.net/x",
      headers: { accept: "application/json" },
    });
  });

  it("finds path and domain fields from the input schema", () => {
    expect(
      inferFields({
        type: "object",
        properties: {
          url: { type: "string" },
          file_path: { type: "string" },
          count: { type: "integer" },
          targetDir: {},
          links: { type: "array", items: { type: "string" } },
          size_path: { type: "number" },
        },
      }),
    ).toEqual({ pathFields: ["file_path", "targetDir"], domainFields: ["links", "url"] });
  });

  it("builds a loose zod schema that checks required keys and top-level types", () => {
    const s = zodFromJsonSchema({
      type: "object",
      properties: { url: { type: "string" }, n: { type: "integer" } },
      required: ["url"],
    });
    expect(s.safeParse({ url: "https://a.b", extra: 1 }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ url: "x", n: 1.5 }).success).toBe(false);
    expect(bridgedToolName("My Server", "get issue/2")).toBe("My_Server.get_issue_2");
  });

  it("lists secret references, hosts and absolute paths of a transport, never values", () => {
    const entry = fakeCatalogEntry();
    expect(secretRefsOf(entry.transport as never)).toEqual(["fake_token"]);
    expect(
      transportDomains({ type: "http", url: "https://mcp.example.net/x", headers: {} }),
    ).toEqual(["mcp.example.net"]);
    expect(
      transportPaths({ type: "stdio", command: "x", args: ["--root", process.cwd()], env: {} }),
    ).toEqual([process.cwd()]);
  });
});

describe("McpConnector", () => {
  let logs: LogRecord[];
  let stop: () => void;
  beforeEach(() => {
    logs = [];
    stop = Logger.addSink((r) => logs.push(r));
  });
  afterEach(() => stop());

  async function connect(opts: { secrets?: SecretResolver } = {}) {
    const calls: { name: string; args: unknown }[] = [];
    const { factory, seen } = inMemoryConnectorFactory({
      onCall: (n, a) => calls.push({ name: n, args: a }),
    });
    const entry = fakeCatalogEntry();
    const secrets =
      opts.secrets ?? new SecretResolver(new MemoryVault({ fake_token: FAKE_TOKEN_VALUE }));
    const c = await factory.connect({
      extensionId: "ext-1",
      name: entry.name,
      transport: entry.transport as never,
      secrets,
      grantedSecrets: new Set(["fake_token"]),
    });
    return { c, seen, calls, entry, secrets };
  }

  it("lists two tools and one resource from the in-process server", async () => {
    const { c } = await connect();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fetch_page", "post_comment"]);
    expect(tools.find((t) => t.name === "fetch_page")?.annotations.readOnlyHint).toBe(true);
    const resources = await c.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0]?.uri).toBe("fake://readme");
    await c.close();
  });

  it("builds a permission review with inferred classes, risk, fields, domains, secrets and scopes", async () => {
    const { c, entry } = await connect();
    const review = await c.review(entry.permissions);
    const fetchPage = review.tools.find((t) => t.name === "fetch_page");
    const post = review.tools.find((t) => t.name === "post_comment");
    expect(fetchPage).toMatchObject({
      bridgedName: "fake.fetch_page",
      actionClass: "read",
      risk: "low",
      domainFields: ["url"],
      inferredFrom: "name:fetch,annotation:readOnlyHint",
    });
    expect(post).toMatchObject({
      bridgedName: "fake.post_comment",
      actionClass: "external_send",
      risk: "high",
      domainFields: ["url"],
      inferredFrom: "name:post",
    });
    expect(review.permissions.tools).toEqual(["fake.fetch_page", "fake.post_comment"]);
    expect(review.permissions.actionClasses).toEqual(["external_send", "read"]);
    expect(review.permissions.domains).toEqual(["example.com"]);
    expect(review.permissions.secrets).toEqual(["fake_token"]);
    expect(review.permissions.scopes).toEqual(["comment on example.com pages"]);
    expect(review.resources[0]?.uri).toBe("fake://readme");
    expect(review.risk).toBe("high");
    expect(review.summary).toContain("tool fake.post_comment: external_send (high risk)");
    expect(review.summary).toContain("uses secret:fake_token (value never shown)");
    expect(review.summary.some((l) => l.startsWith("runs fake-mcp-server"))).toBe(true);
    expect(JSON.stringify(review)).not.toContain(FAKE_TOKEN_VALUE);
    await c.close();
  });

  it("bridges tools into ToolSpecs with the extension id, untrusted output and the review's fields", async () => {
    const { c, calls } = await connect();
    const review = await c.review();
    const specs = c.bridgeTools(review);
    expect(specs.map((s) => s.name)).toEqual(["fake.fetch_page", "fake.post_comment"]);
    const fetchPage = specs[0];
    if (!fetchPage) throw new Error("missing spec");
    expect(isBridgedTool(fetchPage)).toBe(true);
    expect(fetchPage.extensionId).toBe("ext-1");
    expect(fetchPage.mcpTool).toBe("fetch_page");
    expect(fetchPage.domainFields).toEqual(["url"]);
    expect(fetchPage.actionClass).toBe("read");
    expect(fetchPage.schema.safeParse({}).success).toBe(false);
    const ctx = {
      runId: "r",
      sessionId: "s",
      agentId: "a",
      humanId: "h",
      allowedPaths: [],
      signal: new AbortController().signal,
    };
    const result = await fetchPage.execute({ url: "https://example.com/x" }, ctx);
    expect(result.content).toContain("page at https://example.com/x");
    expect(result.untrusted).toEqual({ source: "tool_output", origin: "mcp:fake" });
    expect(calls).toEqual([{ name: "fetch_page", args: { url: "https://example.com/x" } }]);
    // only the tools the grant lists are bridged, and only in the granted classes
    expect(c.bridgeTools(review, ["fake.post_comment"]).map((s) => s.name)).toEqual([
      "fake.post_comment",
    ]);
    expect(c.bridgeTools(review, undefined, ["read"]).map((s) => s.name)).toEqual([
      "fake.fetch_page",
    ]);
    expect(c.bridgeTools(review, ["fake.post_comment"], ["read"])).toEqual([]);
    await c.close();
  });

  it("resolves secret references only at spawn time and keeps the value out of every log line", async () => {
    const { c, seen } = await connect();
    expect(seen).toHaveLength(1);
    const spec = seen[0]?.spec;
    expect(spec?.type).toBe("stdio");
    if (spec?.type === "stdio") expect(spec.env.FAKE_TOKEN).toBe(FAKE_TOKEN_VALUE);
    expect(seen[0]?.meta).toEqual({ extensionId: "ext-1", name: "fake" });
    await c.close();
    const text = logs.map((l) => `${l.msg} ${JSON.stringify(l.data ?? {})}`).join("\n");
    expect(text).toContain("connected");
    expect(text).not.toContain(FAKE_TOKEN_VALUE);
  });

  it("refuses to resolve a secret that was not granted", async () => {
    const { factory } = inMemoryConnectorFactory();
    const entry = fakeCatalogEntry();
    await expect(
      factory.connect({
        extensionId: "ext-2",
        name: "fake",
        transport: entry.transport as never,
        secrets: new SecretResolver(new MemoryVault({ fake_token: FAKE_TOKEN_VALUE })),
        grantedSecrets: new Set(),
      }),
    ).rejects.toMatchObject({ code: "secret_not_granted" });
  });

  it("refuses every call once closed", async () => {
    const { c } = await connect({ secrets: new NoSecrets() as never });
    const review = await c.review();
    const spec = c.bridgeTools(review)[0];
    await c.close();
    expect(c.closed).toBe(true);
    await expect(c.listTools()).rejects.toMatchObject({ code: "tool_not_allowed" });
    await expect(
      spec?.execute(
        { url: "https://example.com" },
        {
          runId: "r",
          sessionId: "s",
          agentId: "a",
          humanId: "h",
          allowedPaths: [],
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "tool_not_allowed" });
  });

  it("builds a review for a capability without a server from its declared permissions", () => {
    const review = buildReview({
      extensionName: "browser",
      transport: null,
      tools: [],
      resources: [],
      declared: {
        tools: ["browser.open"],
        actionClasses: ["read"],
        domains: [],
        paths: [],
        secrets: [],
        scopes: ["browse allowlisted sites"],
      },
    });
    expect(review.permissions.tools).toEqual(["browser.open"]);
    expect(review.risk).toBe("low");
    expect(review.summary).toEqual(["scope: browse allowlisted sites"]);
  });

  it("McpConnector.connect reports a server that never answers as unavailable", async () => {
    await expect(
      McpConnector.connect({
        extensionId: "x",
        name: "dead",
        transport: { type: "http", url: "http://127.0.0.1:9/mcp", headers: {} },
        secrets: new NoSecrets(),
        grantedSecrets: new Set(),
        connectTimeoutMs: 2000,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("StdioMcpTransport (platform shell, argv arrays)", () => {
  const stdioSpec = (env: Record<string, string>): ConnectorTransport => ({
    type: "stdio",
    command: process.execPath,
    args: ["-e", FAKE_STDIO_SERVER_SCRIPT],
    env,
  });

  it("spawns the server through the platform shell, exposes its child process and lists its tools", async () => {
    const c = await McpConnector.connect({
      extensionId: "ext-stdio",
      name: "stdio",
      transport: stdioSpec({ FAKE_TOKEN: "secret:fake_token" }),
      secrets: new SecretResolver(new MemoryVault({ fake_token: FAKE_TOKEN_VALUE })),
      grantedSecrets: new Set(["fake_token"]),
      connectTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
    });
    try {
      expect(c.child?.pid).toBeGreaterThan(0);
      const tools = await c.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping_env"]);
      const result = await c.callTool("ping_env", {});
      expect(result.content).toBe("FAKE_TOKEN:set");
      expect(result.untrusted).toEqual({ source: "tool_output", origin: "mcp:stdio" });
    } finally {
      const child = c.child;
      await c.close();
      // the server ignores SIGTERM and never exits on its own: close() kills the tree
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
      expect(c.closed).toBe(true);
    }
  }, 20_000);

  it("a secret-free discovery spec never carries the value and the server sees it unset", async () => {
    const transport = (await defaultTransportFactory(
      withoutSecretRefs(stdioSpec({ FAKE_TOKEN: "secret:fake_token" })),
      { extensionId: "e", name: "n" },
    )) as StdioMcpTransport;
    expect(transport).toBeInstanceOf(StdioMcpTransport);
    const c = await McpConnector.connect({
      extensionId: "ext-stdio-2",
      name: "stdio",
      transport: withoutSecretRefs(stdioSpec({ FAKE_TOKEN: "secret:fake_token" })),
      secrets: new NoSecrets(),
      grantedSecrets: new Set(),
      connectTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
    });
    try {
      expect((await c.callTool("ping_env", {})).content).toBe("FAKE_TOKEN:unset");
    } finally {
      await c.close();
    }
  }, 20_000);

  it("refuses to start a command that does not exist with a redacted, retryable error", async () => {
    await expect(
      McpConnector.connect({
        extensionId: "x",
        name: "missing",
        transport: {
          type: "stdio",
          command: "forerunner-no-such-command-xyz",
          args: [],
          env: {},
        },
        secrets: new NoSecrets(),
        grantedSecrets: new Set(),
        connectTimeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });
});
