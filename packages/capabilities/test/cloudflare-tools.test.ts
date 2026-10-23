import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, Logger, type LogRecord } from "@forerunner/platform";
import { type ToolExecutionContext, ToolRegistry } from "@forerunner/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOUDFLARE_TOOL_NAMES,
  type CloudflareApprovalRequest,
  cloudflareApprovalKey,
  cloudflareRoutes,
  cloudflareToolDeps,
  cloudflareTools,
  FakeCloudflareApprovals,
  HumanRequestCloudflareApprovals,
  registerCloudflareTools,
} from "../src/cloudflare/index.ts";
import {
  ACCOUNT,
  AGENT,
  cloudflareWorld,
  HUMAN,
  settle,
  TOKEN,
  WORKER_SCRIPT,
  type World,
  ZONE_A,
  ZONE_A_NAME,
  ZONE_B,
} from "./helpers/cloudflare-world.ts";

let world: World | undefined;
const temps: string[] = [];

afterEach(async () => {
  await world?.stop();
  world = undefined;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-cf-wt-"));
  temps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function toolsOf(w: World, approvals = w.approvals) {
  const deps = cloudflareToolDeps({
    projects: w.store.project,
    vault: w.vault,
    approvals,
    audit: w.store.auditLog,
    clock: w.clock,
  });
  const list = cloudflareTools(deps);
  const get = (name: string) => {
    const t = list.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  return { list, get };
}

function ctxIn(w: World, cwd: string): ToolExecutionContext {
  return { ...w.ctx, cwd, allowedPaths: [cwd] };
}

describe("cloudflare ToolSpecs", () => {
  it("exposes four tools with the classes, risk, path and domain fields the hooks expect", async () => {
    world = await cloudflareWorld();
    const { list } = toolsOf(world);
    expect(list.map((t) => t.name)).toEqual([...CLOUDFLARE_TOOL_NAMES]);
    expect(
      list.map((t) => [t.name, t.actionClass, t.risk, t.pathFields ?? [], t.domainFields ?? []]),
    ).toEqual([
      ["cloudflare_plan", "read", "low", ["target.scriptPath", "target.directory"], []],
      [
        "cloudflare_deploy",
        "deploy_staging",
        "high",
        ["target.scriptPath", "target.directory"],
        [],
      ],
      ["cloudflare_dns_upsert", "deploy_production", "high", [], []],
      ["cloudflare_verify_token", "read", "low", [], []],
    ]);
    const registry = registerCloudflareTools(new ToolRegistry(), {
      deployerFor: async () => world?.deployer as never,
      autonomyFor: async () => ({ level: 3 }),
      clock: world.clock,
    });
    expect(registry.names()).toEqual([...CLOUDFLARE_TOOL_NAMES].sort());
    const deploy = list[1];
    expect(deploy?.schema.safeParse({ env: "live", target: { kind: "worker" } }).success).toBe(
      false,
    );
  });

  it("cloudflare_verify_token reports the scopes, never the token, and writes audit rows with the scope", async () => {
    world = await cloudflareWorld();
    const { get } = toolsOf(world);
    const r = await get("cloudflare_verify_token").execute({}, world.ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(
      `Configured scope: account:${ACCOUNT} zone:${ZONE_A} zone:${ZONE_B}`,
    );
    expect(r.content).toContain("Workers Scripts Write on account");
    expect(r.content).not.toContain(TOKEN);
    const rows = await world.store.auditLog.list({});
    expect(rows.map((x) => x.tool)).toEqual(["cloudflare.verify_token", "cloudflare_verify_token"]);
    expect(rows[1]?.input_summary).toContain(`zone:${ZONE_A}`);
    expect(rows[1]?.allowed).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("cloudflare_deploy reads the script from the worktree and deploys to staging at autonomy 3", async () => {
    world = await cloudflareWorld({ autonomy: 3 });
    const { get } = toolsOf(world);
    const wt = worktree({ "dist/worker.js": WORKER_SCRIPT });
    const r = await get("cloudflare_deploy").execute(
      {
        env: "staging",
        target: { kind: "worker", name: "hello", scriptPath: join("dist", "worker.js") },
        hosts: [`app.${ZONE_A_NAME}`],
      },
      ctxIn(world, wt),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/deployed Worker hello-staging to staging/);
    expect(r.artifacts).toMatchObject({
      script: "hello-staging",
      scope: `account:${ACCOUNT} zone:${ZONE_A}`,
    });
    const rows = await world.store.auditLog.list({ tool: "cloudflare_deploy" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input_summary).toContain(`zone:${ZONE_A}`);
  });

  it("cloudflare_deploy production at autonomy 3 waits for the human and logs a denied row", async () => {
    world = await cloudflareWorld({ autonomy: 3 });
    const { get } = toolsOf(world, new FakeCloudflareApprovals("pending"));
    const wt = worktree({ "worker.js": WORKER_SCRIPT });
    const r = await get("cloudflare_deploy").execute(
      { env: "production", target: { kind: "worker", name: "hello", scriptPath: "worker.js" } },
      ctxIn(world, wt),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/waiting for the human's approval \(deploy_production/);
    expect(r.artifacts?.pending).toBe(true);
    expect(world.fake.writes()).toEqual([]);
    const rows = await world.store.auditLog.list({ tool: "cloudflare_deploy" });
    expect(rows[0]).toMatchObject({ allowed: false, denied_reason: "approval_required: pending" });
  });

  it("a script path outside the worktree is refused in code and audited", async () => {
    world = await cloudflareWorld({ autonomy: 4 });
    const { get } = toolsOf(world);
    const wt = worktree({ "worker.js": WORKER_SCRIPT });
    const outside = worktree({ "evil.js": "export default {}" });
    const r = await get("cloudflare_deploy").execute(
      {
        env: "staging",
        target: { kind: "worker", name: "hello", scriptPath: join(outside, "evil.js") },
      },
      ctxIn(world, wt),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/refused \(path_not_allowed\)/);
    expect(world.fake.requests).toEqual([]);
    const rows = await world.store.auditLog.list({ tool: "cloudflare_deploy" });
    expect(rows[0]?.allowed).toBe(false);
  });

  it("cloudflare_dns_upsert and cloudflare_plan work through the project's settings", async () => {
    world = await cloudflareWorld({ autonomy: 4 });
    const { get } = toolsOf(world);
    const dns = await get("cloudflare_dns_upsert").execute(
      { type: "TXT", name: `_acme-challenge.${ZONE_A_NAME}`, content: "proof" },
      world.ctx,
    );
    expect(dns.isError).toBeFalsy();
    expect(dns.content).toMatch(/^create TXT _acme-challenge\./);
    expect(world.fake.dns.get(ZONE_A)?.[0]).toMatchObject({ type: "TXT", content: "proof" });
    const plan = await get("cloudflare_plan").execute(
      {
        action: "dns_upsert",
        type: "TXT",
        name: `_acme-challenge.${ZONE_A_NAME}`,
        content: "proof2",
      },
      world.ctx,
    );
    expect(plan.content).toContain("- update dns_record TXT");
    expect(plan.content).toContain("dry run");
    const rows = await world.store.auditLog.list({});
    expect(rows.map((x) => x.tool)).toEqual([
      "cloudflare.dns_upsert",
      "cloudflare_dns_upsert",
      "cloudflare_plan",
    ]);
    expect(rows[1]?.input_summary).toContain(`zone:${ZONE_A}`);
  });

  it("refuses when the project has no Cloudflare settings", async () => {
    world = await cloudflareWorld();
    const bare = await world.store.project.insert({ name: "no cf" });
    const { get } = toolsOf(world);
    const r = await get("cloudflare_verify_token").execute(
      {},
      { ...world.ctx, projectId: bare.id },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/tool_not_allowed/);
    expect(world.fake.requests).toEqual([]);
  });

  it("no token value reaches the logs during a failing deploy", async () => {
    world = await cloudflareWorld({ autonomy: 4 });
    const records: LogRecord[] = [];
    const stop = Logger.addSink((r) => records.push(r));
    try {
      const { get } = toolsOf(world);
      const wt = worktree({ "worker.js": WORKER_SCRIPT });
      world.fake.failNext({ status: 500, echoAuth: true, times: 3 });
      const r = await settle(
        world.clock,
        get("cloudflare_deploy").execute(
          { env: "staging", target: { kind: "worker", name: "hello", scriptPath: "worker.js" } },
          ctxIn(world, wt),
        ),
      );
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain(TOKEN);
      expect(JSON.stringify(records)).not.toContain(TOKEN);
      const rows = await world.store.auditLog.list({});
      expect(JSON.stringify(rows)).not.toContain(TOKEN);
    } finally {
      stop();
    }
  });
});

describe("HumanRequestCloudflareApprovals", () => {
  const base = (over: Partial<CloudflareApprovalRequest> = {}): CloudflareApprovalRequest => ({
    sessionId: "session-1",
    runId: "run-1",
    agentId: AGENT,
    humanId: HUMAN,
    tool: "cloudflare_deploy",
    actionClass: "deploy_production",
    risk: "high",
    why: "deploy hello to production",
    input: { env: "production", target: { kind: "worker", name: "hello", scriptPath: "w.js" } },
    operation: "deploy_worker",
    scope: `account:${ACCOUNT} zone:${ZONE_A}`,
    env: "production",
    oneShot: false,
    ...over,
  });

  it("files a blocking human request, then answers per key; a yes is reused for the same call only", async () => {
    world = await cloudflareWorld();
    const port = new HumanRequestCloudflareApprovals(world.store.humanRequest, world.clock);
    expect(await port.ask(base())).toBe("pending");
    expect(await port.ask(base())).toBe("pending");
    const open = await world.store.humanRequest.open({ humanId: HUMAN });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "approval", blocking: true, risk: "high" });
    expect(open[0]?.steps).toContain("Environment: production");
    expect((open[0]?.change_card as { key?: string } | null)?.key).toBe(
      cloudflareApprovalKey(base()),
    );
    await world.store.humanRequest.answer(open[0]?.id ?? "", open[0]?.version ?? 0, "yes", HUMAN);
    expect(await port.ask(base())).toBe("approved");
    expect(await port.ask(base())).toBe("approved");
    // A changed script asks again.
    expect(await port.ask(base({ input: { env: "production", target: { name: "hello2" } } }))).toBe(
      "pending",
    );
    expect(await world.store.humanRequest.open({ humanId: HUMAN })).toHaveLength(1);
  });

  it("a money yes is spent by one action", async () => {
    world = await cloudflareWorld();
    const port = new HumanRequestCloudflareApprovals(world.store.humanRequest, world.clock);
    const money = base({ actionClass: "financial", oneShot: true });
    expect(await port.ask(money)).toBe("pending");
    const [row] = await world.store.humanRequest.open({ humanId: HUMAN });
    expect(row?.steps).toContain("This answer is used for one action only.");
    await world.store.humanRequest.answer(row?.id ?? "", row?.version ?? 0, "yes", HUMAN);
    expect(await port.ask(money)).toBe("approved");
    expect(await port.ask(money)).toBe("pending");
    expect(await world.store.humanRequest.open({ humanId: HUMAN })).toHaveLength(1);
  });

  it("a no is a denial, and the runtime hooks' answer for the same call and class is reused", async () => {
    world = await cloudflareWorld();
    const port = new HumanRequestCloudflareApprovals(world.store.humanRequest, world.clock);
    expect(await port.ask(base())).toBe("pending");
    const [row] = await world.store.humanRequest.open({ humanId: HUMAN });
    await world.store.humanRequest.answer(row?.id ?? "", row?.version ?? 0, "no", HUMAN);
    expect(await port.ask(base())).toBe("denied");

    // The hooks' StateApprovals row for a staging deploy at level 2, answered yes.
    const staging = base({
      actionClass: "deploy_staging",
      env: "staging",
      input: { env: "staging", target: { kind: "worker", name: "hello", scriptPath: "w.js" } },
    });
    const { approvalKey } = await import("@forerunner/runtime");
    const hookRow = await world.store.humanRequest.insert({
      human_id: HUMAN,
      session_id: "session-1",
      kind: "approval",
      why: "autonomy level 2 requires approval for deploy_staging",
      options: ["yes", "no"],
      blocking: true,
      change_card: {
        key: approvalKey({ tool: staging.tool, input: staging.input }),
        tool: staging.tool,
        actionClass: "deploy_staging",
        input: staging.input as never,
      },
      author_agent: AGENT,
    });
    await world.store.humanRequest.answer(hookRow.id, hookRow.version, "yes", HUMAN);
    expect(await port.ask(staging)).toBe("approved");
    // The same call needing a stronger class is not covered by that answer.
    expect(await port.ask({ ...staging, actionClass: "deploy_production" })).toBe("pending");

    // The hooks key their row on the raw input and store a copy cut at 2000 characters for
    // the card, so a deploy whose input carries a long string (a script body) still finds
    // the hooks' answer, and a different long input does not.
    const long = (tail: string) => ({
      env: "staging",
      target: { kind: "worker", name: "hello", script: `${"x".repeat(2_400)}${tail}` },
    });
    const longStaging = base({ actionClass: "deploy_staging", env: "staging", input: long("1") });
    const longRow = await world.store.humanRequest.insert({
      human_id: HUMAN,
      session_id: "session-1",
      kind: "approval",
      why: "autonomy level 2 requires approval for deploy_staging",
      options: ["yes", "no"],
      blocking: true,
      change_card: {
        key: approvalKey({ tool: longStaging.tool, input: long("1") }),
        tool: longStaging.tool,
        actionClass: "deploy_staging",
        input: { env: "staging", target: { kind: "worker", name: "hello", script: "…" } },
      },
      author_agent: AGENT,
    });
    await world.store.humanRequest.answer(longRow.id, longRow.version, "yes", HUMAN);
    expect(await port.ask(longStaging)).toBe("approved");
    expect(await port.ask({ ...longStaging, input: long("2") })).toBe("pending");
  });
});

describe("cloudflare routes", () => {
  it("serve the settings (secret by reference) and the token verification for the panel", async () => {
    world = await cloudflareWorld();
    const routes = cloudflareRoutes({
      projects: world.store.project,
      vault: world.vault,
      clock: world.clock,
    });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /cloudflare/projects/:projectId/settings",
      "GET /cloudflare/projects/:projectId/token",
    ]);
    const call = async (path: string, projectId: string) => {
      const route = routes.find((r) => r.path === path);
      if (!route) throw new Error(path);
      const res = await route.handler({
        req: { param: (n) => (n === "projectId" ? projectId : undefined) },
        json: (body, status) =>
          new Response(JSON.stringify(body), {
            status: status ?? 200,
            headers: { "content-type": "application/json" },
          }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const settings = await call("/cloudflare/projects/:projectId/settings", world.project.id);
    expect(settings.status).toBe(200);
    expect(JSON.stringify(settings.body)).toContain("secret:cloudflare_api_token");
    expect(JSON.stringify(settings.body)).not.toContain(TOKEN);
    const token = await call("/cloudflare/projects/:projectId/token", world.project.id);
    expect(token.status).toBe(200);
    expect((token.body.verification as { status: string }).status).toBe("active");
    expect(JSON.stringify(token.body)).not.toContain(TOKEN);
    const missing = await call("/cloudflare/projects/:projectId/token", "nope");
    expect(missing.status).toBe(404);
  });
});
