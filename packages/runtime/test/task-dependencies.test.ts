import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StartCheckView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import {
  cutPlanToBudget,
  SessionRunner,
  StaticPlanner,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { seedWorld } from "./context-helpers.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-040: "Nothing to plan: no task is ready" while ready tasks existed. Three causes, each
 * silent: a dependency that is cancelled, failed or a typo kept a task out of every plan for
 * good (nothing checked a dependency when it was entered, nothing let a person change it, and
 * the summary said no task was ready); and one large task emptied the whole plan, because the
 * cut stopped at the first item that did not fit the budget.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

describe("the plan is cut by skipping what does not fit (U-040)", () => {
  it("leaves out an item that does not fit and keeps the smaller ones after it", () => {
    const item = (id: string, usd: number) => ({
      taskId: id,
      title: id,
      specialist: "coder",
      estimateUsdMicro: usd * 1_000_000,
    });
    const plan = {
      items: [item("big", 5), item("small", 1), item("medium", 2), item("tiny", 0.5)],
      estimateUsdMicro: 8_500_000,
      summary: "4 ready task(s) in priority order",
    };
    const cut = cutPlanToBudget(plan, 3_000_000);
    expect(cut.items.map((i) => i.taskId)).toEqual(["small", "medium"]);
    expect(cut.estimateUsdMicro).toBe(3_000_000);
    expect(cut.leftOutForBudget?.map((i) => i.taskId)).toEqual(["big", "tiny"]);
    expect(cut.workBudgetUsdMicro).toBe(3_000_000);
    expect(cut.summary).toBe("4 ready task(s) in priority order (2 item(s) cut to fit the budget)");
    // A plan that fits is unchanged and says nothing was left out.
    const whole = cutPlanToBudget(plan, 10_000_000);
    expect(whole.items).toHaveLength(4);
    expect(whole.leftOutForBudget).toBeUndefined();
  });
});

describe("a session with tasks that cannot run says which and why (U-040)", () => {
  let store: StateStore;
  let clock: SimulatedClock;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  const ran: string[] = [];
  const executor: TaskExecutor = {
    async execute({ task }) {
      ran.push(task.title);
      return { outcome: "done", summary: "done", costUsdMicro: 0, checksPassed: true };
    },
  };
  const add = (title: string, over: Record<string, unknown> = {}) =>
    store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: 300_000,
      reason: "seed",
      ...over,
    });
  const start = () =>
    new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
    }).start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 2_000_000,
      grant,
    });

  beforeEach(async () => {
    clock = new SimulatedClock("2026-03-02T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    w = await seedWorld(store, {}, { session: false });
    ran.length = 0;
  });

  it("one task larger than the budget no longer empties the plan; the summary names it", async () => {
    await add("Rewrite the engine", { priority: 9, est_cost_usd_micro: 5_000_000 });
    await add("Fix the typo", { priority: 5 });
    await add("Update the README", { priority: 1 });
    const r = await start();
    expect(ran).toEqual(["Fix the typo", "Update the README"]);
    expect(r.completed).toHaveLength(2);
    expect(r.plan?.leftOutForBudget?.map((i) => i.title)).toEqual(["Rewrite the engine"]);
    expect(r.summary).not.toContain("Nothing to plan");
    expect(r.summary).toContain(
      'Left out for budget: "Rewrite the engine" (about $5.00); this session\'s work budget was $1.60.',
    );
    await store.close();
  });

  it("a task that waits on a cancelled task is named with what it waits on, not 'no task is ready'", async () => {
    const schema = await add("Design the schema", { status: "cancelled" });
    const failedOne = await add("Import the data", { status: "failed" });
    await add("Build the API", { depends_on: [schema.id] });
    await add("Write the report", { depends_on: [failedOne.id] });
    const r = await start();
    expect(ran).toEqual([]);
    expect(r.summary).not.toContain("no task is ready");
    expect(r.summary).toContain("Nothing to plan: no ready task can run in this session (below).");
    expect(r.summary).toContain(
      'Waiting on other tasks: "Build the API" waits on "Design the schema" (cancelled); "Write the report" waits on "Import the data" (failed).',
    );
    expect(r.summary).toContain(
      "change the waiting task's dependencies on the Tasks tab, or mark the failed one ready again",
    );
    await store.close();
  });
});

describe("dependencies at the daemon's routes (U-040)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u040-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
    projectId = (await rt.store.project.insert({ name: "Deps", goal: "Tasks that can run" })).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** What the New task dialog sends. */
  const create = (title: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) =>
    call("POST", `/projects/${projectId}/tasks`, {
      title,
      outcome: `${title} is done`,
      acceptanceCriteria: [],
      priority: 5,
      status: "ready",
      dependsOn,
      budgetUsdMicro: 0,
      ...extra,
    });
  type Json = Record<string, unknown>;

  it("a new task naming a dependency that is no task of the project is refused with the name; nothing is written", async () => {
    const before = (await rt.store.task.forProject(projectId)).length;
    const res = await create("Ship it", ["tsk_typo"]);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Json;
    expect(body.message).toBe(
      'Depends on: "tsk_typo" is not a task of this project. Pick the tasks it waits on from the project\'s list.',
    );
    expect(body.details).toMatchObject({ cause: "validation", reason: "unknown_dependency" });
    expect(await rt.store.task.forProject(projectId)).toHaveLength(before);
  });

  it("a new task naming a cancelled task is refused: it would never run", async () => {
    const gone = await rt.store.task.insert({
      project_id: projectId,
      title: "Old approach",
      outcome: "x",
      status: "cancelled",
    });
    const res = await create("Follow up", [gone.id]);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).message).toBe(
      'Depends on: "Old approach" is cancelled and will never be done, so a task waiting on it would never run.',
    );
  });

  it("dependencies are changed after creation; the task itself and a cycle are refused", async () => {
    const a = (await (await create("Write the parser")).json()) as Json;
    const b = (await (await create("Write the tests", [String(a.id)])).json()) as Json;
    expect(b.dependsOn).toEqual([a.id]);
    // Remove the dependency: the screen sends every dependency the task keeps (none).
    const freed = await call("POST", `/tasks/${b.id}/dependencies`, {
      version: b.version,
      dependsOn: [],
      reason: "Dependencies changed in the app",
    });
    expect(freed.status).toBe(200);
    const freedBody = (await freed.json()) as Json;
    expect(freedBody).toMatchObject({ dependsOn: [], reason: "Dependencies changed in the app" });
    const row = await rt.store.task.mustGet(String(b.id));
    expect(row.author_human).toBe(rt.human.id);
    // Put it back, then try the other way round: a cycle.
    const again = (await (
      await call("POST", `/tasks/${b.id}/dependencies`, {
        version: freedBody.version,
        dependsOn: [a.id],
        reason: "it needs the parser",
      })
    ).json()) as Json;
    expect(again.dependsOn).toEqual([a.id]);
    const cycle = await call("POST", `/tasks/${a.id}/dependencies`, {
      version: a.version,
      dependsOn: [b.id],
      reason: "loop",
    });
    expect(cycle.status).toBe(409);
    expect(((await cycle.json()) as Json).message).toBe(
      'Depends on: "Write the tests" already waits on "Write the parser" (directly or through other tasks), so "Write the parser" cannot wait on it: neither would ever run.',
    );
    const self = await call("POST", `/tasks/${a.id}/dependencies`, {
      version: a.version,
      dependsOn: [a.id],
      reason: "self",
    });
    expect(self.status).toBe(409);
    expect(((await self.json()) as Json).message).toBe("A task cannot depend on itself.");
    expect((await rt.store.task.mustGet(String(a.id))).depends_on).toEqual([]);
  });

  it("the start check names what would run, what is left out for budget and what waits", async () => {
    const p = (await rt.store.project.insert({ name: "Check", goal: "See before starting" })).id;
    const done = await rt.store.task.insert({
      project_id: p,
      title: "Done one",
      outcome: "x",
      status: "done",
    });
    const failed = await rt.store.task.insert({
      project_id: p,
      title: "Broken import",
      outcome: "x",
      status: "failed",
    });
    await rt.store.task.insert({
      project_id: p,
      title: "Huge task",
      outcome: "x",
      status: "ready",
      priority: 9,
      est_cost_usd_micro: 50_000_000,
    });
    await rt.store.task.insert({
      project_id: p,
      title: "After done",
      outcome: "x",
      status: "ready",
      depends_on: [done.id],
      est_cost_usd_micro: 100_000,
    });
    await rt.store.task.insert({
      project_id: p,
      title: "Report",
      outcome: "x",
      status: "ready",
      depends_on: [failed.id],
    });
    const res = await call("GET", `/projects/${p}/start-check?budgetUsdMicro=5000000`);
    expect(res.status).toBe(200);
    const view = StartCheckView.parse(await res.json());
    expect(view.ready).toBe(3);
    expect(view.sessionBudget.usdMicro).toBe(5_000_000);
    expect(view.workBudget.usdMicro).toBe(4_000_000);
    expect(view.runnable.map((t) => t.title)).toEqual(["After done"]);
    expect(view.overBudget.map((t) => t.title)).toEqual(["Huge task"]);
    expect(view.waiting).toEqual([
      {
        taskId: expect.any(String),
        title: "Report",
        waitsOn: [{ taskId: failed.id, title: "Broken import", status: "failed" }],
      },
    ]);
    expect((await call("GET", "/projects/nope/start-check")).status).toBe(404);
  });
});
