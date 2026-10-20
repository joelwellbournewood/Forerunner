/**
 * The Cloudflare tools behind the real enforcement hooks (ADR 0035, point 6). The run's domain
 * allowlist names only the API host the catalog entry declares; Worker route hosts and DNS
 * record names are not network destinations of the run, so they are not `domainFields` and
 * the hooks do not check them. The configured zones restrict them in code, in the deployer,
 * before any request leaves the machine. Path fields still go through the hooks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isForerunnerError, join } from "@forerunner/platform";
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
  type ToolResult,
  type ToolSpec,
} from "@forerunner/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOUDFLARE_TOOL_NAMES,
  type CloudflareToolName,
  cloudflareToolDeps,
  cloudflareTools,
} from "../src/cloudflare/index.ts";
import {
  AGENT,
  cloudflareWorld,
  HUMAN,
  RUN,
  SESSION,
  WORKER_SCRIPT,
  type World,
  ZONE_A,
  ZONE_A_NAME,
  ZONE_B,
  ZONE_B_NAME,
  ZONE_OTHER_NAME,
} from "./helpers/cloudflare-world.ts";

/** What packages/runtime/src/extensions/catalog.json declares for the `cloudflare` entry. */
const CATALOG_DOMAINS = ["api.cloudflare.com"];

let world: World | undefined;
const temps: string[] = [];

afterEach(async () => {
  await world?.stop();
  world = undefined;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-cf-hooks-"));
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** The real hooks with a token that allows only the catalog's API host. */
function hooksWorld(w: World, opts: { autonomy: 0 | 1 | 2 | 3 | 4; cwd: string }) {
  const tokens = new TokenIssuer({ now: () => w.clock.now() });
  const audit = new MemoryAudit();
  const hooks = new EnforcementHooks({
    tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill: new KillSwitch(tokens),
    clock: w.clock,
    ledger: new MemoryLedger(),
    audit,
    approvals: new AutoApprove("approved"),
  });
  const token = tokens.issue({
    runId: RUN,
    sessionId: SESSION,
    agentId: AGENT,
    ownerHumanId: HUMAN,
    projectId: w.project.id,
    allowedTools: [...CLOUDFLARE_TOOL_NAMES],
    allowedPaths: [opts.cwd],
    allowedDomains: CATALOG_DOMAINS,
    grantedSecrets: ["cloudflare_api_token"],
    budgetUsdMicro: 1_000_000,
    depth: 0,
    maxDepth: 2,
    autonomy: opts.autonomy,
    planApproved: true,
    expiresAt: new Date(w.clock.now() + 3_600_000).toISOString(),
  });
  const run: RunContext = {
    token,
    budget: new SessionBudget({
      sessionId: SESSION,
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
    cwd: opts.cwd,
  };
  const deps = cloudflareToolDeps({
    projects: w.store.project,
    vault: w.vault,
    approvals: w.approvals,
    audit: w.store.auditLog,
    clock: w.clock,
  });
  const tools = new Map<string, ToolSpec>(cloudflareTools(deps).map((t) => [t.name, t]));
  const toolCtx: ToolExecutionContext = { ...w.ctx, cwd: opts.cwd, allowedPaths: [opts.cwd] };
  /** beforeToolCall, execute, afterToolCall: the loop's order. */
  const call = async (name: CloudflareToolName, input: unknown): Promise<ToolResult> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const decision = await hooks.beforeToolCall(run, tool, input);
    if (!decision.allowed) throw new Error(`unexpected pending decision for ${name}`);
    const result = await tool.execute(decision.input, toolCtx);
    await hooks.afterToolCall(run, tool, decision.input, result);
    return result;
  };
  return { hooks, run, token, tools, audit, call };
}

describe("cloudflare tools behind the enforcement hooks", () => {
  it("a Worker route deploy passes the hooks with only the API host in the run's domain allowlist", async () => {
    world = await cloudflareWorld({ autonomy: 3 });
    const wt = worktree({ "dist/worker.js": WORKER_SCRIPT });
    const h = hooksWorld(world, { autonomy: 3, cwd: wt });
    expect(h.token.claims.allowedDomains).toEqual(CATALOG_DOMAINS);
    const r = await h.call("cloudflare_deploy", {
      env: "staging",
      target: { kind: "worker", name: "hello", scriptPath: join("dist", "worker.js") },
      hosts: [`app.${ZONE_A_NAME}`, `www.${ZONE_B_NAME}`],
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/deployed Worker hello-staging to staging/);
    expect(world.fake.routes.get(ZONE_A)?.map((x) => x.pattern)).toEqual([`app.${ZONE_A_NAME}/*`]);
    expect(world.fake.routes.get(ZONE_B)?.map((x) => x.pattern)).toEqual([`www.${ZONE_B_NAME}/*`]);
    expect(h.audit.entries.map((e) => [e.tool, e.allowed])).toEqual([["cloudflare_deploy", true]]);
  });

  it("a DNS upsert of a record with an underscore label passes the hooks; the zone comes from the configured list", async () => {
    world = await cloudflareWorld({ autonomy: 4 });
    const wt = worktree({ "site/index.html": "<h1>hi</h1>" });
    const h = hooksWorld(world, { autonomy: 4, cwd: wt });
    const r = await h.call("cloudflare_dns_upsert", {
      type: "TXT",
      name: `_acme-challenge.${ZONE_A_NAME}`,
      content: "proof",
    });
    expect(r.isError).toBeFalsy();
    expect(world.fake.dns.get(ZONE_A)).toEqual([
      expect.objectContaining({ type: "TXT", name: `_acme-challenge.${ZONE_A_NAME}` }),
    ]);
    const plan = await h.call("cloudflare_plan", {
      action: "deploy",
      env: "staging",
      target: { kind: "pages", project: "my-site", directory: "site" },
      hosts: [`site.${ZONE_B_NAME}`],
    });
    expect(plan.isError).toBeFalsy();
    expect(plan.content).toContain("dry run");
  });

  it("a host outside the configured zones passes the hooks and is refused in code before any request", async () => {
    world = await cloudflareWorld({ autonomy: 4 });
    const wt = worktree({ "worker.js": WORKER_SCRIPT });
    const h = hooksWorld(world, { autonomy: 4, cwd: wt });
    const deploy = await h.call("cloudflare_deploy", {
      env: "staging",
      target: { kind: "worker", name: "hello", scriptPath: "worker.js" },
      hosts: [`www.${ZONE_OTHER_NAME}`],
    });
    expect(deploy.isError).toBe(true);
    expect(deploy.content).toMatch(/refused \(domain_not_allowed\)/);
    const dns = await h.call("cloudflare_dns_upsert", {
      type: "A",
      name: `www.${ZONE_OTHER_NAME}`,
      content: "192.0.2.1",
    });
    expect(dns.isError).toBe(true);
    expect(dns.content).toMatch(/refused \(domain_not_allowed\)/);
    expect(world.fake.writes()).toEqual([]);
    const rows = await world.store.auditLog.list({ sessionId: SESSION });
    expect(rows.map((x) => [x.tool, x.allowed])).toEqual([
      ["cloudflare_deploy", false],
      ["cloudflare_dns_upsert", false],
    ]);
  });

  it("the hooks still refuse a script path outside the run's roots before the tool runs", async () => {
    world = await cloudflareWorld({ autonomy: 4 });
    const wt = worktree({ "worker.js": WORKER_SCRIPT });
    const outside = worktree({ "evil.js": "export default {}" });
    const h = hooksWorld(world, { autonomy: 4, cwd: wt });
    await expect(
      h.call("cloudflare_deploy", {
        env: "staging",
        target: { kind: "worker", name: "hello", scriptPath: join(outside, "evil.js") },
      }),
    ).rejects.toSatisfy((e) => isForerunnerError(e, "path_not_allowed"));
    expect(h.audit.entries.at(-1)).toMatchObject({ tool: "cloudflare_deploy", allowed: false });
    expect(world.fake.requests).toEqual([]);
  });
});
