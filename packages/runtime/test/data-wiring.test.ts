import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { appDirs, isInside, join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost, locateHttpBackend } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolExecutionContext, ToolSpec } from "../src/agent/tools.ts";
import { DAEMON_ROUTES } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { DATA_ROUTES } from "../src/data/routes.ts";
import { DATA_TOOL_NAMES, type DataToolName } from "../src/data/tools.ts";
import { DataAssetList, ImportResultView } from "../src/data/types.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import type { RunContext } from "../src/enforcement/hooks.ts";
import { csvText, makeZip, writeFixture } from "./data-helpers.ts";

/**
 * Files and data inside the running system (spec L.1, A.3, K.2; ADR 0039): `composeRuntime`
 * builds the registry under the install's data dir and registers the four data tools behind
 * the daemon's hooks; the daemon mounts the Data tab routes the UI and the CLI target. An
 * import through the route lands in the registry and the project's listing; a hostile archive
 * is refused whole; a path outside the run's allowed roots is a capability grant the human
 * decides, never a silent read. `sqlite::memory:`, memory vault, SimulatedClock; no provider.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
// Resolved at module load so skipIf() can see it when the suite is collected.
const gitHttpBackend = await locateHttpBackend();
const noGitHttp = () =>
  gitHttpBackend ? false : "git http-backend not found next to git --exec-path";
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);

describe("data assets wired into the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  let src: string;
  let worktree: string;
  let projectId = "";
  let sessionId = "";
  let importedCsv = "";
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
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
  const tool = (name: DataToolName): ToolSpec => {
    const t = rt.toolsForRun().get(name);
    if (!t) throw new Error(`tool ${name} is not registered`);
    return t;
  };
  /** A run of the daemon's own token issuer: the data tools, the worktree as the only root. */
  const runContext = (): { run: RunContext; ctx: ToolExecutionContext } => {
    const runId = `run-data-${++runCounter}`;
    const run: RunContext = {
      token: rt.tokens.issue({
        runId,
        sessionId,
        agentId: rt.agent.id,
        ownerHumanId: rt.human.id,
        projectId,
        allowedTools: [...DATA_TOOL_NAMES],
        allowedPaths: [worktree],
        allowedDomains: [],
        grantedSecrets: [],
        budgetUsdMicro: 1_000_000,
        depth: 0,
        maxDepth: 2,
        autonomy: 3,
        planApproved: true,
        expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
      }),
      budget: new SessionBudget({
        sessionId,
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
      sessionId,
      agentId: rt.agent.id,
      humanId: rt.human.id,
      projectId,
      allowedPaths: [worktree],
      signal: run.signal,
      cwd: worktree,
    };
    return { run, ctx };
  };
  /** Through the hooks, then the tool, then the hooks again: the daemon's path for a tool call. */
  const call = async (name: DataToolName, input: unknown) => {
    const { run, ctx } = runContext();
    const t = tool(name);
    // A schema or allowlist violation throws from the hooks; the autonomy table answers with a decision.
    const gated = await rt.hooks.beforeToolCall(run, t, input).then(
      (decision) => ({ decision, error: null as unknown }),
      (error: unknown) => ({ decision: null, error }),
    );
    if (!gated.decision) return { decision: null, content: null, error: gated.error };
    const decision = gated.decision;
    if (!decision.allowed) return { decision, content: null, error: null };
    const outcome = await t.execute(decision.input, ctx).then(
      async (result) => ({
        content: (await rt.hooks.afterToolCall(run, t, decision.input, result)).content,
        error: null as unknown,
      }),
      (error: unknown) => ({ content: null, error }),
    );
    return { decision, ...outcome };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-data-wiring-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    src = join(home, "src");
    worktree = join(home, "worktree");
    mkdirSync(src, { recursive: true });
    mkdirSync(worktree, { recursive: true });
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
    });
    ({ app, token } = createDaemonApp(rt));
    projectId = str((await json(await post("/projects", { name: "Data", goal: "Use data" }))).id);
    sessionId = (
      await rt.store.session.insert({
        agent_id: rt.agent.id,
        project_id: projectId,
        trigger: "manual",
        plan: {},
        status: "running",
        started_at: clock.nowIso(),
        summary: "data wiring test",
        author_agent: rt.agent.id,
      })
    ).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("registers the four data tools as built-in tools and lists the Data tab routes", () => {
    for (const name of DATA_TOOL_NAMES) expect(rt.toolsForRun().get(name)).toBeDefined();
    expect(rt.data.assets.projectsRoot).toContain(home);
    for (const route of DATA_ROUTES) {
      expect(Object.values(DAEMON_ROUTES).some((r) => r.startsWith(route))).toBe(true);
    }
  });

  it("an import through the daemon route lands in the registry and shows in the project's data listing", async () => {
    const folder = join(src, "dataset");
    writeFixture(join(folder, "items.csv"), csvText(12));
    writeFixture(join(folder, "notes", "readme.txt"), "plain notes\n");
    const imported = await post(`/projects/${projectId}/data/import`, {
      source: "folder",
      locator: folder,
    });
    expect(imported.status).toBe(200);
    const result = ImportResultView.parse(await imported.json());
    expect(result.imported.map((f) => f.rel).sort()).toEqual(["items.csv", "notes/readme.txt"]);
    expect(result.imported.every((f) => f.assetId)).toBe(true);

    const listed = await req(`/projects/${projectId}/data`);
    expect(listed.status).toBe(200);
    const views = DataAssetList.parse(await listed.json());
    expect(views.map((v) => v.name).sort()).toEqual(["items.csv", "readme.txt"]);
    const csv = views.find((v) => v.name === "items.csv");
    if (!csv) throw new Error("csv not listed");
    importedCsv = csv.id;
    expect(csv).toMatchObject({ format: "csv", storage: "linked", projectIds: [projectId] });
    expect(csv.metadata?.rowCount).toBe(12);
    const project = await rt.store.project.mustGet(projectId);
    expect(project.data_assets).toEqual(expect.arrayContaining(views.map((v) => v.id)));
    const audits = await rt.store.auditLog.list({ tool: "data.import" } as never, { limit: 10 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ allowed: true, human_id: rt.human.id });

    const described = await req(`/data/${importedCsv}`);
    expect(described.status).toBe(200);
    expect(await json(described)).toMatchObject({ id: importedCsv, name: "items.csv" });
    const sample = await json(await req(`/data/${importedCsv}/sample?rows=2`));
    expect(sample).toMatchObject({ kind: "rows", truncated: true });
    expect((sample.rows as unknown[]).length).toBe(2);
    expect((await req(`/data/${importedCsv}`, {}, false)).status).toBe(401);
  });

  it("the data tools behind the hooks see the import: listing, sampling under the cap, output wrapped as data", async () => {
    const listed = await call("data_list", {});
    expect(listed.error).toBeNull();
    expect(listed.content).toContain(importedCsv);
    expect(listed.content).toMatch(/file\/csv\s+items\.csv/);
    const sampled = await call("data_sample", { assetId: importedCsv, rows: 3 });
    expect(sampled.error).toBeNull();
    expect(sampled.content).toContain('"name":"item 1"');
    expect(sampled.content).not.toContain('"name":"item 4"');
    // Capped by the schema in code: more than the cap is refused by the hooks before the tool runs.
    const over = await call("data_sample", { assetId: importedCsv, bytes: 10_000_000 });
    expect(over.decision).toBeNull();
    expect(over.error).toMatchObject({ code: "validation" });
    const denied = await rt.store.auditLog.list({ tool: "data_sample", allowed: false } as never, {
      limit: 10,
    });
    expect(denied).toHaveLength(1);
  });

  it.skipIf(noGitHttp())(
    "a github import through the daemon route clones under the install's data dir onto the migration branch with the daemon's own token reference",
    { timeout: 120_000 },
    async () => {
      const hostRoot = mkdtempSync(join(tmpdir(), "fr-data-wiring-gh-"));
      const host = await FakeGitHost.start({ rootDir: hostRoot, clock });
      try {
        host.createUser({ login: "alice" });
        host.createOrg({ login: "acme", members: ["alice"] });
        const issued = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] });
        await host.createRepo({
          owner: "acme",
          name: "legacy",
          private: true,
          initialFiles: { "README.md": "# legacy\n", "lib/old.js": "module.exports = 1;\n" },
        });
        // The install's own token from setup; the request names no reference.
        await rt.vault.set("github_token", issued.token);
        const r = await post(`/projects/${projectId}/data/import`, {
          source: "github",
          locator: host.cloneUrl("acme/legacy"),
        });
        expect(r.status).toBe(200);
        const result = ImportResultView.parse(await r.json());
        expect(result.source).toBe("github");
        const dest = result.destination as string;
        expect(isInside(join(home, "data", "projects"), dest)).toBe(true);
        expect(existsSync(join(dest, "lib", "old.js"))).toBe(true);
        expect(result.repository).toMatchObject({
          slug: "acme/legacy",
          branch: "forerunner/migration-2026-10-20",
          defaultBranch: "main",
          reused: false,
        });
        expect(readFileSync(join(dest, ".git", "config"), "utf8")).not.toContain(issued.token);
        const views = DataAssetList.parse(await json(await req(`/projects/${projectId}/data`)));
        const repo = views.find((v) => v.name === "acme/legacy");
        expect(repo).toMatchObject({ kind: "folder", storage: "linked", locator: dest });
        expect((await rt.store.project.mustGet(projectId)).repos).toContain("acme/legacy");
        const audits = await rt.store.auditLog.list({ tool: "data.import" } as never, {
          limit: 10,
        });
        expect(JSON.stringify({ result, views, audits })).not.toContain(issued.token);
        expect(audits.some((a) => /github acme\/legacy/.test(a.input_summary))).toBe(true);
        // A reference the vault does not hold is a client error, and nothing is cloned.
        const missing = await post(`/projects/${projectId}/data/import`, {
          source: "github",
          locator: host.cloneUrl("acme/legacy"),
          tokenRef: "secret:nope",
        });
        expect(missing.status).toBe(404);
      } finally {
        await rt.vault.delete("github_token");
        await host.stop();
        await rm(hostRoot, { recursive: true, force: true });
      }
    },
  );

  it("a hostile archive is refused whole by the route and nothing is registered", async () => {
    const zip = makeZip(join(src, "hostile.zip"), [
      { name: "ok.txt", data: "fine" },
      { name: "../escape.txt", data: "outside the data dir" },
    ]);
    const before = (await rt.store.dataAsset.list({} as never, { limit: 100 })).length;
    const r = await post(`/projects/${projectId}/data/import`, { source: "zip", path: zip });
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({ code: "validation" });
    expect((await rt.store.dataAsset.list({} as never, { limit: 100 })).length).toBe(before);
    expect(existsSync(join(home, "escape.txt"))).toBe(false);
    expect(existsSync(join(rt.data.assets.projectsRoot, "escape.txt"))).toBe(false);
  });

  it("a file outside the run's allowed roots is a capability grant: refused until the human answers, audited, nothing registered", async () => {
    const outside = writeFixture(join(src, "private", "salaries.csv"), csvText(3));
    const { error } = await call("data_register", { source: outside });
    expect(error).toMatchObject({ code: "approval_required" });
    const grant = (await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 20 })).find(
      (r) => (r.change_card as { tool?: string } | null)?.tool === "data_register",
    );
    expect(grant).toMatchObject({ kind: "approval", blocking: true, project_id: projectId });
    expect(grant?.steps.join("\n")).toContain("capability_grant");
    const listed = await rt.data.assets.list(projectId);
    expect(listed.some((v) => v.locator === outside)).toBe(false);

    // Inside the run's root it is free, and the row is audited.
    const inside = writeFixture(join(worktree, "fixtures", "small.csv"), csvText(2));
    const ok = await call("data_register", { source: inside });
    expect(ok.error).toBeNull();
    expect(ok.content).toMatch(/^registered /);
    expect((await rt.data.assets.list(projectId)).some((v) => v.locator === inside)).toBe(true);
    const audits = await rt.store.auditLog.list({ tool: "data.register" } as never, { limit: 10 });
    expect(audits.some((a) => a.agent_id === rt.agent.id && a.allowed)).toBe(true);
  });

  it("removal goes through the route as the daemon's human, never through a tool", async () => {
    expect(rt.toolsForRun().get("data_remove")).toBeUndefined();
    const r = await req(`/data/${importedCsv}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ ok: true, id: importedCsv, deletedFromDisk: false });
    expect((await rt.data.assets.list(projectId)).some((v) => v.id === importedCsv)).toBe(false);
  });
});
