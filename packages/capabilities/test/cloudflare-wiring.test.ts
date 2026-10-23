import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  composeRuntime,
  createDaemonApp,
  DAEMON_ROUTES,
  type RunContext,
  type RuntimeApp,
  SessionBudget,
  type ToolExecutionContext,
  type ToolSpec,
} from "@forerunner/runtime";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLOUDFLARE_TOOL_NAMES,
  type CloudflareToolName,
  HumanRequestCloudflareApprovals,
} from "../src/cloudflare/index.ts";
import {
  ACCOUNT,
  fullPolicies,
  settingsInput,
  TOKEN,
  WORKER_SCRIPT,
  ZONE_A,
  ZONE_A_NAME,
  ZONE_B,
  ZONE_B_NAME,
  ZONE_OTHER,
  ZONE_OTHER_NAME,
} from "./helpers/cloudflare-world.ts";
import { FakeCloudflare } from "./helpers/fake-cloudflare.ts";

/**
 * The Cloudflare capability inside the running system (ADR 0035, ADR 0038): `composeRuntime`
 * registers the four tools in the daemon's tool registry behind the daemon's own hooks (token
 * domains, action classes, autonomy with `human_request` approvals, the extension gate), the
 * catalog entry names the real tools and classes, and the panel routes are mounted behind the
 * bearer token. Fake Cloudflare API on 127.0.0.1, `sqlite::memory:`, memory vault with the
 * token by reference, SimulatedClock; no model provider is needed.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
/** A secret a Worker binding names by reference; the value is a fixture. */
const SIGNING_SECRET = "worker_signing_secret";
const SIGNING_VALUE = "fixture-signing-value-0001"; // not-a-secret
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

describe("cloudflare wired into the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  let worktree = "";
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const fake = new FakeCloudflare({
    token: TOKEN,
    tokenId: "tok1",
    accountId: ACCOUNT,
    zones: [
      { id: ZONE_A, name: ZONE_A_NAME, accountId: ACCOUNT },
      { id: ZONE_B, name: ZONE_B_NAME, accountId: ACCOUNT },
      { id: ZONE_OTHER, name: ZONE_OTHER_NAME, accountId: ACCOUNT },
    ],
    policies: fullPolicies(),
    pagesProjects: { "my-site": "main" },
  });
  const SESSION = "sess-cloudflare";
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
  const tool = (name: CloudflareToolName): ToolSpec => {
    const t = rt.tools.get(name);
    if (!t) throw new Error(`tool ${name} is not registered`);
    return t;
  };
  /** A run of the daemon's own token issuer with only the catalog's API host allowed. */
  const runContext = (
    autonomy: 0 | 1 | 2 | 3 | 4,
    grantedSecrets: string[] = [],
  ): { run: RunContext; ctx: ToolExecutionContext } => {
    const runId = `run-cf-${++runCounter}`;
    const run: RunContext = {
      token: rt.tokens.issue({
        runId,
        sessionId: SESSION,
        agentId: rt.agent.id,
        ownerHumanId: rt.human.id,
        projectId,
        allowedTools: [...CLOUDFLARE_TOOL_NAMES],
        allowedPaths: [worktree],
        allowedDomains: ["api.cloudflare.com"],
        grantedSecrets,
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
      cwd: worktree,
    };
    const ctx: ToolExecutionContext = {
      runId,
      sessionId: SESSION,
      agentId: rt.agent.id,
      humanId: rt.human.id,
      projectId,
      allowedPaths: [worktree],
      signal: run.signal,
      cwd: worktree,
    };
    return { run, ctx };
  };
  const workerDeploy = (env: "staging" | "production") => ({
    env,
    target: { kind: "worker", name: "hello", scriptPath: join("dist", "worker.js") },
    hosts: [`app.${ZONE_A_NAME}`],
  });

  beforeAll(async () => {
    const baseUrl = await fake.start();
    const home = mkdtempSync(join(tmpdir(), "fr-cf-wiring-"));
    worktree = join(home, "worktree");
    mkdirSync(join(worktree, "dist"), { recursive: true });
    writeFileSync(join(worktree, "dist", "worker.js"), WORKER_SCRIPT);
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ cloudflare_api_token: TOKEN, [SIGNING_SECRET]: SIGNING_VALUE }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      notifications: { osNotifier: false },
    });
    ({ app, token } = createDaemonApp(rt));
    const project = await rt.store.project.insert({
      name: "Deploy me",
      autonomy_level: 2,
      settings: { cloudflare: settingsInput({ base_url: baseUrl }) as never },
    });
    projectId = project.id;
    await rt.store.session.insert({ id: SESSION, agent_id: rt.agent.id, project_id: projectId });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    await fake.stop();
    if (worktree) rmSync(join(worktree, ".."), { recursive: true, force: true });
  });

  it("registers the four tools in the daemon's registry and the catalog entry names them with their real classes", () => {
    for (const name of CLOUDFLARE_TOOL_NAMES) {
      expect(rt.tools.names()).toContain(name);
      expect(rt.toolsForRun().names()).toContain(name);
    }
    const entry = rt.extensions.catalog.mustGet("cloudflare");
    expect(entry.permissions.tools).toEqual([...CLOUDFLARE_TOOL_NAMES]);
    const classes = [...new Set(CLOUDFLARE_TOOL_NAMES.map((n) => tool(n).actionClass))].sort();
    expect([...entry.permissions.actionClasses].sort()).toEqual(classes);
    expect(entry.permissions.domains).toEqual(["api.cloudflare.com"]);
    expect(entry.permissions.secrets).toEqual(["cloudflare_api_token"]);
    expect(DAEMON_ROUTES.cloudflareSettings).toContain("/cloudflare/projects/:projectId/settings");
    expect(DAEMON_ROUTES.cloudflareToken).toContain("/cloudflare/projects/:projectId/token");
  });

  it("a production deploy at autonomy 2 is refused by the daemon's hooks before any request, filed as a blocking approval and audited", async () => {
    const { run } = runContext(2);
    const before = fake.requests.length;
    const decision = await rt.hooks.beforeToolCall(
      run,
      tool("cloudflare_deploy"),
      workerDeploy("production"),
    );
    expect(decision).toMatchObject({ allowed: false, pending: true });
    expect(fake.requests.length).toBe(before);
    const rows = await rt.store.auditLog.list(
      { tool: "cloudflare_deploy", allowed: false } as never,
      { limit: 10 },
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({
      denied_reason: "approval_required: pending",
      human_id: rt.human.id,
      agent_id: rt.agent.id,
    });
    const open = await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 });
    const request = open.find(
      (r) => (r.change_card as { tool?: string } | null)?.tool === "cloudflare_deploy",
    );
    if (!request) throw new Error("no approval request for the deploy");
    expect(request).toMatchObject({ kind: "approval", blocking: true, risk: "high" });
    expect((request.change_card as { actionClass?: string }).actionClass).toBe("deploy_staging");
    // The human is woken: a blocking request is an urgent notification (ADR 0017).
    const woken = rt.notifier
      .recent({ humanId: rt.human.id })
      .find((n) => n.notification.dedupeKey === `request:${request.id}`);
    expect(woken).toMatchObject({ urgency: "urgent" });
  });

  it("at autonomy 3 the hooks let the staging class through and the deployer refuses production in code, with nothing written", async () => {
    const { run, ctx } = runContext(3);
    const deploy = tool("cloudflare_deploy");
    const decision = await rt.hooks.beforeToolCall(run, deploy, workerDeploy("production"));
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const writesBefore = fake.writes().length;
    const result = await deploy.execute(decision.input, ctx);
    await rt.hooks.afterToolCall(run, deploy, decision.input, result);
    expect(result.isError).toBeFalsy();
    expect(result.artifacts).toMatchObject({ pending: true, operation: "deploy_worker" });
    expect(result.content).toContain("deploy_production");
    expect(fake.writes().length).toBe(writesBefore);
    const rows = await rt.store.auditLog.list({ tool: "cloudflare.deploy_worker" } as never, {
      limit: 10,
    });
    expect(rows.some((r) => !r.allowed && r.denied_reason?.includes("approval_required"))).toBe(
      true,
    );
  });

  it("a plan at autonomy 2 passes the hooks and runs against the fake API without a write", async () => {
    const { run, ctx } = runContext(2);
    const plan = tool("cloudflare_plan");
    const input = { action: "deploy", ...workerDeploy("staging") };
    const decision = await rt.hooks.beforeToolCall(run, plan, input);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const writesBefore = fake.writes().length;
    const result = await plan.execute(decision.input, ctx);
    await rt.hooks.afterToolCall(run, plan, decision.input, result);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Plan: deploy_worker (staging)");
    expect(result.content).toContain("Nothing was changed");
    expect(result.content).toContain("hello-staging");
    // Level 2 would need an approval even for staging; the plan says so and asks nobody.
    expect(result.artifacts).toMatchObject({
      actionClass: "deploy_staging",
      decision: "approval_required",
    });
    expect(fake.writes().length).toBe(writesBefore);
    expect(fake.requests.length).toBeGreaterThan(0);
    const rows = await rt.store.auditLog.list({ tool: "cloudflare_plan" } as never, { limit: 10 });
    expect(rows.some((r) => r.allowed)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  // Review of 2026-10-23: the hooks key their row on the parsed input (a `secret:` reference
  // as written) while the tool sees the input with the secret resolved; the Cloudflare port
  // hashed that resolved input, found no hook row and asked the human a second time. The
  // hooks hand their key to the tool (`ctx.approvalKey`), which passes it on as `key`.
  it("a deploy whose input carries a secret: reference reuses the hooks' answer: the human is asked once", async () => {
    const { run, ctx } = runContext(2, [SIGNING_SECRET]);
    const deploy = tool("cloudflare_deploy");
    const input = {
      env: "staging",
      target: {
        kind: "worker",
        name: "signed",
        scriptPath: join("dist", "worker.js"),
        bindings: [{ type: "secret_text", name: "SIGNING", text: `secret:${SIGNING_SECRET}` }],
      },
      hosts: [`app.${ZONE_A_NAME}`],
    };
    const signedRows = async () =>
      (await rt.store.humanRequest.list({ session_id: SESSION, kind: "approval" } as never)).filter(
        (r) => JSON.stringify(r.change_card ?? {}).includes('"signed"'),
      );
    const first = await rt.hooks.beforeToolCall(run, deploy, input);
    expect(first).toMatchObject({ allowed: false, pending: true });
    const [filed] = await signedRows();
    if (!filed) throw new Error("the hooks filed no approval for the deploy");
    await rt.store.humanRequest.answer(filed.id, filed.version, "yes", rt.human.id);

    const second = await rt.hooks.beforeToolCall(run, deploy, input);
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;
    expect(JSON.stringify(second.input)).toContain(SIGNING_VALUE);
    expect(second.approvalKey).toBe((filed.change_card as { key?: string }).key);
    const approvals = new HumanRequestCloudflareApprovals(rt.store.humanRequest, clock);
    const answer = await approvals.ask({
      sessionId: SESSION,
      runId: ctx.runId,
      agentId: rt.agent.id,
      humanId: rt.human.id,
      projectId,
      tool: "cloudflare_deploy",
      input: second.input,
      key: second.approvalKey,
      actionClass: "deploy_staging",
      risk: "medium",
      why: "autonomy level 2 requires a human's approval to deploy",
      operation: "deploy_worker",
      scope: `account:${ACCOUNT}`,
      env: "staging",
      oneShot: false,
    });
    expect(answer).toBe("approved");

    // The same through the tool, as the agent loop runs it: the key rides in the context.
    const result = await deploy.execute(second.input, { ...ctx, approvalKey: second.approvalKey });
    await rt.hooks.afterToolCall(run, deploy, second.input, result);
    expect(result.artifacts?.pending).toBeFalsy();
    const rows = await signedRows();
    expect(rows.map((r) => r.id)).toEqual([filed.id]);
  });

  it("serves the panel routes behind the bearer token: settings by reference, the token's real scopes, 404 for an unknown project", async () => {
    expect((await req(`/cloudflare/projects/${projectId}/settings`, {}, false)).status).toBe(401);
    const settings = await req(`/cloudflare/projects/${projectId}/settings`);
    expect(settings.status).toBe(200);
    const body = await json(settings);
    expect((body.settings as Json).secret_ref).toBe("secret:cloudflare_api_token");
    expect(body.scope).toEqual({ accountId: ACCOUNT, zoneIds: [ZONE_A, ZONE_B] });
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    const verify = await req(`/cloudflare/projects/${projectId}/token`);
    expect(verify.status).toBe(200);
    const v = await json(verify);
    expect((v.verification as Json).status).toBe("active");
    expect(((v.verification as Json).scopes as string[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(v)).not.toContain(TOKEN);

    expect((await req("/cloudflare/projects/nope/settings")).status).toBe(404);
  });

  it("once the cloudflare extension is installed from the catalog, its gate refuses the tools while the grant is pending and allows them after the inbox answer", async () => {
    const added = await req("/extensions", {
      method: "POST",
      body: JSON.stringify({ catalogId: "cloudflare" }),
    });
    expect(added.status).toBe(202);
    const ext = await json(added);
    expect(ext.status).toBe("pending_approval");
    const { run } = runContext(2);
    const plan = tool("cloudflare_plan");
    const input = { action: "deploy", ...workerDeploy("staging") };
    await expect(rt.hooks.beforeToolCall(run, plan, input)).rejects.toMatchObject({
      code: "approval_required",
    });
    const request = (
      await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })
    ).find((r) => (r.change_card as { extensionId?: string } | null)?.extensionId === ext.id);
    if (!request) throw new Error("no approval request for the extension");
    const answered = await req(`/requests/${request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "approve" }),
    });
    expect(answered.status).toBe(200);
    expect(await json(await req(`/extensions/${String(ext.id)}`))).toMatchObject({
      status: "enabled",
      enabled: true,
    });
    const decision = await rt.hooks.beforeToolCall(runContext(2).run, plan, input);
    expect(decision.allowed).toBe(true);
  });
});
