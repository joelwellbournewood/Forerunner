import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadPricing } from "@forerunner/billing";
import {
  MemoryGitHost,
  MIRROR_APPROVE_OPTION,
  MIRROR_SETTINGS_KEY,
  mirrorSettingsOf,
} from "@forerunner/capabilities";
import { appDirs, ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolSpec } from "../src/agent/tools.ts";
import { buildProgram } from "../src/cli/main.ts";
import { HealthView, MirrorRunView, MirrorSyncPendingView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { RESTART_EXIT_CODE, readRestartRequest } from "../src/daemon/restart.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { fileTools } from "../src/daemon/tools.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import type { RunContext } from "../src/enforcement/hooks.ts";
import { EstimateAccuracyViewSchema } from "../src/estimates/view.ts";
import { bridgedToolName } from "../src/extensions/mcp.ts";
import { LoopEvalRunner } from "../src/models/eval-runner.ts";
import { MODEL_WATCH_REMINDER_SCHEDULE_ID } from "../src/models/watch.ts";
import { ProviderRegistry } from "../src/provider/registry.ts";
import { FakeSandbox } from "../src/sandbox/fake.ts";
import {
  LoopTaskExecutor,
  planItemFor,
  type RunSandboxPort,
  type SpecialistSpec,
} from "../src/session/executor.ts";
import { detectArtifactPlatform } from "../src/update/install.ts";
import { UpdatesView } from "../src/update/screen.ts";
import {
  FAKE_CATALOG_ID,
  FAKE_TOKEN_VALUE,
  fakeCatalogEntry,
  inMemoryConnectorFactory,
  startHttpFixture,
  testCatalog,
} from "./extensions-helpers.ts";
import { flatPricing, ScriptedProvider } from "./helpers.ts";
import { buildRelease, FakeReleaseServer, testKey } from "./update-helpers.ts";

/**
 * The whole product through one process: composeRuntime wires the modules other tasks built
 * (extensions, updates, model watch, estimates, mirror, sandbox) and the daemon and the CLI
 * expose them. Everything runs on the fake provider, an in-memory MCP server, a fake release
 * server and a price list fixture on 127.0.0.1, a MemoryGitHost and a SimulatedClock.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const BRIDGED_FETCH = bridgedToolName("fake", "fetch_page");

let artifactPlatform: string | null = null;
try {
  artifactPlatform = detectArtifactPlatform();
} catch {
  artifactPlatform = null;
}

describe("daemon wiring", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  let dirs: ReturnType<typeof appDirs>;
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const exits: number[] = [];
  const gitHost = new MemoryGitHost("alice");
  const releases = new FakeReleaseServer();
  let prices: Awaited<ReturnType<typeof startHttpFixture>>;
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    req(path, { method: "POST", body: JSON.stringify(body) });
  const openRequests = async () =>
    rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 100 });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-wiring-"));
    dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    // Prices for the fake models so the model watch can cost its eval runs (nothing is guessed).
    const fakePrice = (i: number, o: number) => ({
      input_per_mtok_usd: i,
      output_per_mtok_usd: o,
      cache_read_per_mtok_usd: i / 10,
      cache_write_per_mtok_usd: i * 1.25,
      as_of: "2026-10-01",
      source: "override",
    });
    writeFileSync(
      join(dirs.config, "pricing.json"),
      JSON.stringify({
        "fake-haiku": fakePrice(1, 5),
        "fake-sonnet": fakePrice(3, 15),
        "fake-opus": fakePrice(15, 75),
        "fake-fable": fakePrice(30, 150),
      }),
    );
    await releases.start();
    buildRelease(releases, {
      version: "1.1.0",
      notes: "## 1.1.0\n- wiring",
      files: { "app/VERSION": "1.1.0" },
    });
    prices = await startHttpFixture({
      "/prices.json": {
        as_of: "2026-10-19",
        source: "fixture",
        // claude-haiku-5-5 input doubles: a repricing the watch must put to the human.
        models: { "claude-haiku-5-5": { input_per_mtok_usd: 0.2, output_per_mtok_usd: 0.5 } },
      },
    });
    const key = testKey();
    const { factory } = inMemoryConnectorFactory();
    rt = await composeRuntime({
      env: {
        FORERUNNER_HOME: home,
        FORERUNNER_UPDATE_FEED: "github:owner/repo",
        FORERUNNER_UPDATE_API_BASE: releases.url,
        FORERUNNER_UPDATE_TRUSTED_KEYS: `${key.keyId}=${key.publicKey}`,
        FORERUNNER_PRICE_LIST_URL: prices.url("/prices.json"),
      },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({ fake_token: FAKE_TOKEN_VALUE }),
      provider: new ScriptedProvider([{ text: "Hello from the fake agent." }], clock),
      gitHost,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "1.0.0",
      connectors: factory,
      catalog: testCatalog([
        fakeCatalogEntry(),
        fakeCatalogEntry({ id: "fake-two", name: "fake-two", version: "1.2.0" }),
      ]),
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      exit: (code) => {
        exits.push(code);
      },
    });
    ({ app, token } = createDaemonApp(rt));
  });
  afterAll(async () => {
    await rt.close();
    await releases.stop();
    await prices.close();
  });

  it("health reports the sandbox kind and the extension counts", async () => {
    const h = HealthView.parse(await json(await app.request("/health")));
    expect(h.sandbox).toEqual({
      kind: "process",
      available: false,
      engine: "none",
      reason: "test: no engine",
    });
    expect(h.extensions).toEqual({ enabled: 0, pending: 0 });
  });

  it("extensions: catalog -> add (pending) -> answer in the inbox -> enabled -> bridged tool in the run registry -> toggle off refuses in code", async () => {
    const catalog = await json(await req("/extensions/catalog"));
    expect((catalog.entries as Json[]).map((e) => e.id)).toContain(FAKE_CATALOG_ID);

    const added = await post("/extensions", { catalogId: FAKE_CATALOG_ID });
    expect(added.status).toBe(202);
    const ext = await json(added);
    expect(ext.status).toBe("pending_approval");
    expect(rt.toolsForRun().names()).not.toContain(BRIDGED_FETCH);
    expect((await json(await app.request("/health"))).extensions).toEqual({
      enabled: 0,
      pending: 1,
    });

    // The grant is a blocking, high-risk human request; answering it in the inbox applies it.
    const request = (await openRequests()).find(
      (r) => (r.change_card as { extensionId?: string } | null)?.extensionId === ext.id,
    );
    if (!request) throw new Error("no approval request for the extension");
    expect(request).toMatchObject({ kind: "approval", blocking: true, risk: "high" });
    const answered = await post(`/requests/${request.id}/answer`, {
      version: request.version,
      answer: "approve",
    });
    expect(answered.status).toBe(200);
    const enabled = await json(await req(`/extensions/${str(ext.id)}`));
    expect(enabled).toMatchObject({ status: "enabled", enabled: true, connected: true });
    expect(rt.toolsForRun().names()).toContain(BRIDGED_FETCH);

    // The gate lets the approved tool through the daemon's hooks ...
    const tool = rt.toolsForRun().get(BRIDGED_FETCH) as ToolSpec;
    const ctx = (): RunContext => ({
      token: rt.tokens.issue({
        runId: `run-${clock.now()}`,
        sessionId: "sess-gate",
        agentId: rt.agent.id,
        ownerHumanId: rt.human.id,
        allowedTools: [BRIDGED_FETCH],
        allowedPaths: [],
        allowedDomains: ["example.com"],
        grantedSecrets: [],
        budgetUsdMicro: 1_000_000,
        depth: 0,
        maxDepth: 1,
        autonomy: 4,
        planApproved: true,
        expiresAt: new Date(clock.now() + 60_000).toISOString(),
      }),
      budget: new SessionBudget({
        sessionId: "sess-gate",
        budgetUsdMicro: 1_000_000,
        stepCap: 50,
        deadlineMs: clock.now() + 60_000,
        reserveShare: 0,
      }),
      signal: new AbortController().signal,
      runDeadlineMs: clock.now() + 60_000,
      phase: "work",
      model: "fake-haiku",
      provider: "fake",
      billingSourceId: rt.billingSourceId,
    });
    const decision = await rt.hooks.beforeToolCall(ctx(), tool, { url: "https://example.com/a" });
    expect(decision.allowed).toBe(true);

    // ... and refuses it in code once the human toggles the extension off.
    const off = await post(`/extensions/${str(ext.id)}/toggle`, { enabled: false });
    expect(off.status).toBe(200);
    expect(rt.toolsForRun().names()).not.toContain(BRIDGED_FETCH);
    await expect(
      rt.hooks.beforeToolCall(ctx(), tool, { url: "https://example.com/a" }),
    ).rejects.toMatchObject({ code: "tool_not_allowed" });
    const denied = await rt.store.auditLog.list({ tool: BRIDGED_FETCH, allowed: false } as never, {
      limit: 10,
    });
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });

  it("model watch on a fresh install runs no paid eval: lists and prices only, the planned evals put to the human", async () => {
    const spentBefore = (await rt.store.costLedger.sum({ humanId: rt.human.id })).usd_micro;
    // The fresh install's first run is the baseline (ADR 0089): no eval, no request.
    const first = await post("/model-watch/run", {});
    expect(first.status).toBe(200);
    const baseline = await json(first);
    expect(baseline.decision).toBe("nothing_to_decide");
    expect((baseline.report as Json).baseline_providers).toEqual(["fake"]);
    expect((baseline.report as Json).evals).toEqual([]);
    expect(
      (await openRequests()).filter((r) =>
        String((r.change_card as { key?: string } | null)?.key ?? "").startsWith("model_watch:"),
      ),
    ).toHaveLength(0);
    // The next run compares against it: still no eval without consent.
    const run = await post("/model-watch/run", {});
    expect(run.status).toBe(200);
    const body = await json(run);
    const report = body.report as Json;
    expect(report.evals).toEqual([]);
    expect(num(report.eval_cost_usd_micro)).toBe(0);
    expect((report.evals_deferred as Json).reason).toMatch(/consent/);
    const repriced = (report.diff as Json).repriced as Json[];
    expect(repriced.map((r) => r.model)).toContain("claude-haiku-5-5");
    expect(body.decision).toBe("pending");
    const request = (await openRequests()).find(
      (r) => (r.change_card as { key?: string } | null)?.key === `model_watch:${str(report.id)}`,
    );
    expect(request).toMatchObject({
      kind: "decision",
      options: ["adopt", "evaluate", "ignore", "remind"],
    });
    expect((await rt.store.costLedger.sum({ humanId: rt.human.id })).usd_micro).toBe(spentBefore);
    const audits = await rt.store.auditLog.list({ tool: "model_watch.eval" } as never, {
      limit: 500,
    });
    expect(audits).toHaveLength(0);
    // The report is closed by the human's answer elsewhere; ignore it here.
    const ignored = await post(`/model-watch/reports/${str(report.id)}/answer`, {
      decision: "ignore",
      by: rt.human.id,
    });
    expect(ignored.status).toBe(200);
  });

  it("model watch runs on the fake provider through the daemon when asked to evaluate: a report with evals, a repricing and a decision in the inbox; coder tasks are refused the process sandbox", async () => {
    const run = await post("/model-watch/run", { evals: true });
    expect(run.status).toBe(200);
    const body = await json(run);
    const report = body.report as Json;
    expect(body.decision).toBe("pending");
    expect(typeof body.requestId).toBe("string");
    expect(report.price_list).toMatchObject({ models: 1, error: null });
    expect(report.evals_deferred).toBeNull();
    const repriced = (report.diff as Json).repriced as Json[];
    expect(repriced.map((r) => r.model)).toContain("claude-haiku-5-5");
    const evals = report.evals as Json[];
    expect(evals.length).toBeGreaterThan(0);
    const ran = evals.filter((e) => e.skipped_reason === null && num(e.total) > 0);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.every((e) => e.specialist === "researcher")).toBe(true);
    // No container engine here, and the human has not allowed the process stand-in for evals.
    const coder = evals.filter((e) => e.specialist === "coder");
    expect(coder.length).toBeGreaterThan(0);
    for (const e of coder) expect(str(e.skipped_reason)).toMatch(/^not_supported: .*process/);
    expect(num(report.eval_cost_usd_micro)).toBeGreaterThan(0);
    const request = (await openRequests()).find(
      (r) => (r.change_card as { key?: string } | null)?.key === `model_watch:${str(report.id)}`,
    );
    expect(request).toMatchObject({ kind: "decision", options: ["adopt", "ignore", "remind"] });
    const latest = await json(await req("/model-watch/reports/latest"));
    expect((latest.report as Json).id).toBe(report.id);
    expect(latest.health).toMatchObject({ decision: "pending", request_id: body.requestId });
    const audits = await rt.store.auditLog.list({ tool: "model_watch.eval" } as never, {
      limit: 500,
    });
    expect(audits.length).toBe(ran.length);
  });

  it("model watch: Remind me on the Updates page takes the card out of the inbox, and the daemon's hourly job files it again when due (U-035)", async () => {
    const latest = await json(await req("/model-watch/reports/latest"));
    const reportId = str((latest.report as Json).id);
    const cards = async () =>
      ((await json(await req("/inbox"))).requests as Json[]).filter(
        (r) => (r.changeCard as { key?: string } | null)?.key === `model_watch:${reportId}`,
      );
    const [card] = await cards();
    expect(card?.options).toEqual(["adopt", "ignore", "remind"]);

    const answered = await post(`/model-watch/reports/${reportId}/answer`, {
      decision: "remind",
      by: rt.human.id,
    });
    expect(answered.status).toBe(200);
    expect(await cards()).toEqual([]);

    // A week on (the stored remind_at moved into the past), the scheduler's hourly job runs.
    const { release, health } = await rt.modelWatch.getReport(reportId);
    await rt.store.release.patch(release.id, {
      health: { ...health, remind_at: new Date(clock.now() - 60_000).toISOString() } as never,
    });
    const job = rt.scheduler.list().find((s) => s.id === MODEL_WATCH_REMINDER_SCHEDULE_ID);
    if (!job) throw new Error("no model watch reminder schedule");
    const fired = await rt.scheduler.requestStart({
      agentId: job.agentId,
      trigger: "schedule",
      reason: `every ${job.everyMinutes} min`,
    });
    expect(await rt.scheduler.runOutcome(fired.id)).toEqual({ ok: true });
    const again = await cards();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(card?.id);
    expect(again[0]?.options).toEqual(["adopt", "ignore", "remind"]);
    const now = await json(await req("/model-watch/reports/latest"));
    expect(now.health).toMatchObject({ decision: "pending", request_id: again[0]?.id });
  });

  it("the updates screen lists the app release from the fake feed, the connector update and the model watch entries", async () => {
    await rt.store.extension.insert({
      kind: "connector",
      name: "fake-two",
      ext_version: "1.0.0",
      enabled: false,
      status: "installed",
    });
    // Opening the screen reads local state only; the feed is asked on the human's button.
    const feedHits = () => releases.requests.filter((p) => p.endsWith("/releases")).length;
    const before = feedHits();
    const opened = UpdatesView.parse(await (await req("/updates")).json());
    expect(feedHits()).toBe(before);
    expect(opened.app.available).toBeNull();
    const res = await post("/updates/check", {});
    expect(res.status).toBe(200);
    expect(feedHits()).toBe(before + 1);
    const view = UpdatesView.parse(await res.json());
    expect(view.app).toMatchObject({ runningVersion: "1.0.0", state: "available" });
    expect(view.app.available?.version).toBe("1.1.0");
    expect(view.connectors).toEqual([
      expect.objectContaining({
        name: "fake-two",
        installedVersion: "1.0.0",
        availableVersion: "1.2.0",
      }),
    ]);
    expect(view.models.map((m) => m.kind)).toEqual(
      expect.arrayContaining(["price_change", "recommendation"]),
    );
    expect(view.models.find((m) => m.kind === "price_change")?.model).toBe("claude-haiku-5-5");
  });

  it("mirror: enabling it in the project settings schedules it; a sync asks the human once, then creates the board on the git host", async () => {
    const card = await json(
      await post("/projects", {
        name: "Mirrored",
        goal: "Show the mirror",
        repos: ["acme/sample"],
      }),
    );
    const project = await rt.store.project.mustGet(str(card.id));
    const updated = await req(`/projects/${project.id}/settings`, {
      method: "PUT",
      body: JSON.stringify({
        version: project.version,
        settings: { [MIRROR_SETTINGS_KEY]: { enabled: true, owner: "acme" } },
      }),
    });
    expect(updated.status).toBe(200);
    expect((await json(updated)).mirrorScheduled).toBe(true);
    expect(mirrorSettingsOf(await rt.store.project.mustGet(project.id))).toMatchObject({
      enabled: true,
      owner: "acme",
    });
    expect(rt.scheduler.list().map((s) => s.id)).toContain(`mirror:${project.id}`);

    await rt.store.task.insert({
      project_id: project.id,
      title: "Mirrored task",
      outcome: "x",
      acceptance_criteria: [],
      risk_tier: 0,
      status: "ready",
      priority: 1,
      depends_on: [],
      budget_usd_micro: 0,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    // The first manual sync answers 202 at once with the approval it filed: the request never
    // blocks until the human decides (the approval port waits up to a day).
    const first = await post(`/projects/${project.id}/mirror/sync`, {});
    expect(first.status).toBe(202);
    const pending = MirrorSyncPendingView.parse(await first.json());
    expect(pending.projectId).toBe(project.id);
    const approval = (await openRequests()).find((r) => r.id === pending.requestId);
    if (!approval) throw new Error("the mirror did not ask the human");
    expect(approval.options[0]).toBe(MIRROR_APPROVE_OPTION);
    expect(approval.project_id).toBe(project.id);
    expect(gitHost.projectCalls).toEqual([]);
    // A second click while the approval is open joins the run: same request, no duplicate.
    const second = await post(`/projects/${project.id}/mirror/sync`, {});
    expect(second.status).toBe(202);
    expect(MirrorSyncPendingView.parse(await second.json()).requestId).toBe(pending.requestId);
    expect((await openRequests()).filter((r) => r.project_id === project.id)).toHaveLength(1);

    // Answering in the inbox wakes the waiting run (no clock tick needed); it creates the
    // board on the git host in the background.
    const answered = await post(`/requests/${approval.id}/answer`, {
      version: approval.version,
      answer: MIRROR_APPROVE_OPTION,
    });
    expect(answered.status).toBe(200);
    for (let i = 0; i < 200 && !gitHost.projectCalls.some((c) => c.op === "upsertItem"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gitHost.projectCalls.map((c) => c.op)).toEqual(
      expect.arrayContaining(["ensureProject", "ensureFields", "upsertItem"]),
    );
    expect((await openRequests()).find((r) => r.id === approval.id)).toBeUndefined();
    for (
      let i = 0;
      i < 200 && !mirrorSettingsOf(await rt.store.project.mustGet(project.id))?.project_id;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(mirrorSettingsOf(await rt.store.project.mustGet(project.id))).toMatchObject({
      approved: true,
    });
    // From now on a sync needs no approval and answers 200 with the run.
    const done = await post(`/projects/${project.id}/mirror/sync`, {});
    expect(done.status).toBe(200);
    const result = MirrorRunView.parse(await done.json());
    expect(result).toMatchObject({ projectId: project.id, errors: 0, scanned: 1 });
    expect(result.githubProjectId).not.toBe("");

    // Disabling drops the schedule.
    const again = await rt.store.project.mustGet(project.id);
    await req(`/projects/${project.id}/settings`, {
      method: "PUT",
      body: JSON.stringify({
        version: again.version,
        settings: { [MIRROR_SETTINGS_KEY]: { enabled: false } },
      }),
    });
    expect(rt.scheduler.list().map((s) => s.id)).not.toContain(`mirror:${project.id}`);
  });

  it("estimates: a finished task feeds the accuracy view the Performance screen reads", async () => {
    const card = await json(await post("/projects", { name: "Est", goal: "Estimate learning" }));
    const task = await json(
      await post(`/projects/${str(card.id)}/tasks`, {
        title: "Write a note",
        outcome: "A note exists",
        acceptanceCriteria: ["note written"],
      }),
    );
    const started = await post("/sessions", {
      agentId: rt.agent.id,
      projectId: card.id,
      budgetUsdMicro: 2_000_000,
    });
    expect(started.status).toBe(202);
    for (let i = 0; i < 100; i++) {
      const t = await rt.store.task.mustGet(str(task.id));
      if (t.status !== "ready" && t.status !== "claimed" && t.status !== "in_progress") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const res = await req("/costs/estimates");
    expect(res.status).toBe(200);
    const view = EstimateAccuracyViewSchema.parse(await res.json());
    expect(view.overall.samples).toBeGreaterThanOrEqual(1);
    expect(view.recent[0]).toMatchObject({ task_id: task.id, specialist: "coder" });
    expect(view.rows.find((r) => r.specialist === "coder")?.samples).toBeGreaterThanOrEqual(1);
    // The planner now prices the next task of that kind with the learned ratio.
    expect(rt.estimates.estimate({ specialist: "coder", risk_tier: 1 }).basis).toBe("learned");
  });

  /** A task, its session, a run token and a budget for one executor call (worktree pinned). */
  const seedExecutorRun = async (name: string, worktree: string, riskTier: number) => {
    const project = await rt.store.project.insert({ name, goal: "g", repos: [] });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Run a command",
      outcome: "the command ran",
      acceptance_criteria: ["the command ran"],
      risk_tier: riskTier,
      status: "in_progress",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 500_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: project.id,
      trigger: "manual",
      plan: {},
      status: "running",
      started_at: clock.nowIso(),
      summary: "sandbox test",
      author_agent: rt.agent.id,
    });
    const token = rt.tokens.issue({
      runId: `run-${name}`,
      sessionId: session.id,
      agentId: rt.agent.id,
      ownerHumanId: rt.human.id,
      projectId: project.id,
      allowedTools: ["run_command", "read_file"],
      allowedPaths: [worktree],
      allowedDomains: ["example.com"],
      grantedSecrets: [],
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy: 4,
      planApproved: true,
      expiresAt: new Date(clock.now() + 60_000).toISOString(),
    });
    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 1_000_000,
      stepCap: 50,
      deadlineMs: clock.now() + 60_000,
      reserveShare: 0,
    });
    return { task, session, token, budget };
  };
  const commandSpec: SpecialistSpec = {
    name: "coder",
    prompt: "You run commands.",
    promptVersion: "test",
    defaultTier: "haiku",
    defaultEffort: "low",
    allowedTools: ["run_command"],
    allowedDomains: ["example.com"],
    maxBudgetUsdMicro: 1_000_000,
    maxTurns: 4,
    timeoutMs: 60_000,
  };
  const commandExecutor = (port: RunSandboxPort, worktree: string) =>
    new LoopTaskExecutor({
      store: rt.store,
      clock,
      tokens: rt.tokens,
      driver: rt.driver,
      provider: new ScriptedProvider(
        [
          { text: "", tools: [{ name: "run_command", input: { argv: ["echo", "hi"] } }] },
          { text: "done" },
        ],
        clock,
      ),
      pricing: flatPricing,
      tools: fileTools(),
      sandbox: port,
      billingSourceId: rt.billingSourceId,
      specialists: () => commandSpec,
      worktreeFor: async () => worktree,
    });

  it("the executor runs run_command inside the task's sandbox through the injected port and destroys it afterwards", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "fr-wiring-wt-"));
    const fake = new FakeSandbox({ worktree }).script("echo", { stdout: "hi\n" });
    const opened: string[] = [];
    const port: RunSandboxPort = {
      open: async (r) => {
        opened.push(r.allowedDomains.join(","));
        return { sandbox: fake, engine: "fake", warnings: ["sandbox: fake"] };
      },
    };
    const { task, session, token, budget } = await seedExecutorRun("Sandboxed", worktree, 1);
    const result = await commandExecutor(port, worktree).execute({
      task,
      session,
      token,
      budget,
      item: planItemFor(task, "coder"),
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("done");
    expect(fake.calls.map((c) => c.argv)).toEqual([["echo", "hi"]]);
    expect(fake.destroyed).toBe(true);
    expect(opened).toEqual(["example.com"]);
  });

  it("a refused sandbox lease (tier 2, no engine) closes the Run row as an error instead of leaving it running", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "fr-wiring-wt-"));
    const port: RunSandboxPort = {
      open: async () => {
        throw new ForerunnerError(
          "not_supported",
          "task at risk tier 2 needs a container sandbox and none is reachable",
        );
      },
    };
    const { task, session, token, budget } = await seedExecutorRun("Refused", worktree, 2);
    await expect(
      commandExecutor(port, worktree).execute({
        task,
        session,
        token,
        budget,
        item: planItemFor(task, "coder"),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "not_supported" });
    const runs = await rt.store.run.forTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "error", timed_out: false });
    expect(runs[0]?.duration_ms).not.toBeNull();
    const artifacts = (runs[0]?.artifacts ?? []) as { error: string }[];
    expect(artifacts[0]?.error).toContain("risk tier 2");
  });

  it("model watch evals: the model's run_command executes in the sandbox lease and never on the host; only the specialist's tools are offered", async () => {
    const outside = join(home, "outside-marker.txt");
    const escapeCall = {
      name: "run_command",
      input: {
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'escaped')",
          outside,
        ],
      },
    };
    const pricing = await loadPricing(join(dirs.config, "pricing.json"));
    const workRoot = join(home, "eval-work");
    const runEval = async (specialist: string, sandbox: RunSandboxPort | undefined) => {
      const provider = new ScriptedProvider(
        [{ text: "", tools: [escapeCall] }, { text: "done" }],
        clock,
      );
      const runner = new LoopEvalRunner({
        registry: rt.registry,
        driver: rt.driver,
        providers: new ProviderRegistry().register(provider),
        tokens: rt.tokens,
        clock,
        humanId: rt.human.id,
        agentId: rt.agent.id,
        billingSourceId: rt.billingSourceId,
        workRoot,
        tools: () => fileTools(),
        sandbox,
        maxTasks: 1,
      });
      const outcome = await runner.run({
        specialist,
        provider: "fake",
        model: "fake-haiku",
        effort: "low",
        pricing,
      });
      return { outcome, offered: provider.calls[0]?.tools?.map((t) => t.name) ?? [] };
    };
    const sandboxes: FakeSandbox[] = [];
    const leases: {
      worktree: string;
      domains: string[];
      task: Pick<TaskRow, "id" | "risk_tier">;
    }[] = [];
    const port: RunSandboxPort = {
      open: async (r) => {
        const s = new FakeSandbox({ worktree: r.worktree });
        sandboxes.push(s);
        leases.push({
          worktree: r.worktree,
          domains: [...r.allowedDomains],
          task: { id: r.task.id, risk_tier: r.task.risk_tier },
        });
        return { sandbox: s, engine: "fake", warnings: [] };
      },
    };

    // coder names cc:Bash: run_command is offered and the command goes to the lease over the
    // work directory (no egress), which is destroyed afterwards. The host file never appears.
    const coder = await runEval("coder", port);
    expect(coder.outcome.total).toBe(1);
    expect(coder.offered).toEqual(
      expect.arrayContaining(["read_file", "write_file", "list_dir", "run_command"]),
    );
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0]?.calls.map((c) => c.argv)).toEqual([escapeCall.input.argv]);
    expect(sandboxes[0]?.destroyed).toBe(true);
    expect(leases[0]).toMatchObject({ domains: [], task: { id: "eval:coder-001", risk_tier: 1 } });
    expect(leases[0]?.worktree.startsWith(workRoot)).toBe(true);
    expect(existsSync(outside)).toBe(false);

    // researcher has no cc:Bash: run_command is not offered, the call is refused in code.
    const researcher = await runEval("researcher", port);
    expect(researcher.offered).toEqual(
      expect.arrayContaining(["read_file", "list_dir", "write_file"]),
    );
    expect(researcher.offered).not.toContain("run_command");
    expect(sandboxes.flatMap((s) => s.calls)).toHaveLength(1);
    expect(existsSync(outside)).toBe(false);

    // Without a sandbox port the daemon's tools lose run_command: nothing runs on the host.
    const bare = await runEval("coder", undefined);
    expect(bare.offered).toEqual(expect.arrayContaining(["read_file", "write_file", "list_dir"]));
    expect(bare.offered).not.toContain("run_command");
    expect(sandboxes).toHaveLength(1);
    expect(existsSync(outside)).toBe(false);
  });

  it("model watch evals never run a coder task in the process stand-in unless the human allowed it; the lease is refused before any model call", async () => {
    const pricing = await loadPricing(join(dirs.config, "pricing.json"));
    const destroyed: boolean[] = [];
    const processPort: RunSandboxPort = {
      open: async (r) => {
        const s = new FakeSandbox({ worktree: r.worktree });
        const destroy = s.destroy.bind(s);
        s.destroy = async () => {
          destroyed.push(true);
          await destroy();
        };
        return {
          sandbox: s,
          engine: "process",
          warnings: ["sandbox: process (no container engine)"],
        };
      },
    };
    const runCoder = async (allow: boolean | undefined) => {
      const provider = new ScriptedProvider([{ text: "done" }], clock);
      const runner = new LoopEvalRunner({
        registry: rt.registry,
        driver: rt.driver,
        providers: new ProviderRegistry().register(provider),
        tokens: rt.tokens,
        clock,
        humanId: rt.human.id,
        agentId: rt.agent.id,
        billingSourceId: rt.billingSourceId,
        workRoot: join(home, "eval-work-process"),
        tools: () => fileTools(),
        sandbox: processPort,
        ...(allow === undefined ? {} : { allowProcessSandbox: () => allow }),
        maxTasks: 2,
      });
      const run = runner.run({
        specialist: "coder",
        provider: "fake",
        model: "fake-haiku",
        effort: "low",
        pricing,
      });
      return { run, provider };
    };
    for (const allow of [undefined, false]) {
      const { run, provider } = await runCoder(allow);
      await expect(run).rejects.toMatchObject({
        code: "not_supported",
        details: { reason: "process_sandbox_not_allowed" },
      });
      expect(provider.calls).toHaveLength(0);
    }
    expect(destroyed).toHaveLength(2);
    const allowed = await runCoder(true);
    const outcome = await allowed.run;
    expect(outcome.total).toBe(2);
    expect(allowed.provider.calls.length).toBeGreaterThan(0);
  });

  it("model watch evals count against the human's monthly cap: the spend lands in the human's month, and a month at 80% starts no eval task", async () => {
    const pricing = await loadPricing(join(dirs.config, "pricing.json"));
    const runner = (provider: ScriptedProvider) =>
      new LoopEvalRunner({
        registry: rt.registry,
        driver: rt.driver,
        providers: new ProviderRegistry().register(provider),
        tokens: rt.tokens,
        clock,
        humanId: rt.human.id,
        agentId: rt.agent.id,
        billingSourceId: rt.billingSourceId,
        workRoot: join(home, "eval-work-caps"),
        tools: () => fileTools(),
        caps: rt.caps,
        maxTasks: 2,
      });
    const input = {
      specialist: "researcher",
      provider: "fake",
      model: "fake-haiku",
      effort: "low" as const,
      pricing,
    };
    const human = await rt.store.human.mustGet(rt.human.id);
    const before = (await rt.store.costLedger.sum({ humanId: rt.human.id })).usd_micro;
    const first = new ScriptedProvider([{ text: "done" }], clock);
    const out = await runner(first).run(input);
    expect(out.costUsdMicro).toBeGreaterThan(0);
    const after = (await rt.store.costLedger.sum({ humanId: rt.human.id })).usd_micro;
    expect(after - before).toBe(out.costUsdMicro);

    // The month cap just below what is spent: the hooks' 80% line is crossed, nothing new starts.
    await rt.store.human.patch(human.id, { monthly_cap_usd_micro: Math.ceil(after / 0.85) });
    await clock.advance(61_000); // past the caps cache
    try {
      const second = new ScriptedProvider([{ text: "done" }], clock);
      await expect(runner(second).run(input)).rejects.toMatchObject({ code: "budget_exceeded" });
      expect(second.calls).toHaveLength(0);
    } finally {
      await rt.store.human.patch(human.id, {
        monthly_cap_usd_micro: human.monthly_cap_usd_micro,
      });
      await clock.advance(61_000);
    }
  });

  it("registers fr update, fr models and fr mirror on the program and runs a model watch report through it", async () => {
    const lines: string[] = [];
    const composeCalls: Record<string, unknown>[] = [];
    const program = buildProgram({
      env: { FORERUNNER_HOME: home },
      compose: async (o) => {
        composeCalls.push(o);
        return { ...rt, close: async () => undefined };
      },
      out: (l) => lines.push(l),
    });
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining([
        "setup",
        "status",
        "doctor",
        "kill",
        "daemon",
        "update",
        "models",
        "mirror",
      ]),
    );
    const sub = (name: string) =>
      program.commands.find((c) => c.name() === name)?.commands.map((c) => c.name()) ?? [];
    expect(sub("update")).toEqual(
      expect.arrayContaining(["check", "apply", "rollback", "status", "health"]),
    );
    expect(sub("models")).toEqual(["watch", "report"]);
    expect(sub("mirror")).toEqual(["sync", "enable", "disable"]);
    const help = program.helpInformation();
    for (const n of ["update", "models", "mirror"]) expect(help).toContain(n);
    program.exitOverride();
    await program.parseAsync(["node", "fr", "models", "report", "--list"]);
    expect(lines.some((l) => l.includes("recommendation(s)"))).toBe(true);
    // A CLI one-shot composes without the background services (no connector, no scheduler).
    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]).toMatchObject({ startServices: false });
  });

  it.skipIf(artifactPlatform === null)(
    "update and restart: apply stages the release and the daemon exits with the documented restart code after writing the request file (skipped when no release artefact exists for this platform/arch)",
    async () => {
      const res = await post("/updates/apply", {});
      expect(res.status).toBe(202);
      expect(await json(res)).toMatchObject({
        version: "1.1.0",
        previous: "1.0.0",
        state: "pending_health_check",
        restarting: true,
      });
      expect(exits).toEqual([RESTART_EXIT_CODE]);
      expect(readRestartRequest(dirs)).toMatchObject({
        reason: "update",
        targetVersion: "1.1.0",
        fromVersion: "1.0.0",
        exitCode: RESTART_EXIT_CODE,
      });
      const status = UpdatesView.parse(await json(await req("/updates/status")));
      expect(status.app.state).toBe("pending_health_check");
    },
  );
});
