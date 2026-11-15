import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StartCheckView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { requestWords } from "../src/daemon/request-words.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { budgetPauseDetail } from "../src/daemon/task-words.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { closeByStart, fileBudgetStopCard } from "../src/session/budget-card.ts";
import {
  cutPlanToBudget,
  SessionRunner,
  StaticPlanner,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { startCheck } from "../src/session/start-check.ts";
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
    // d1109-oversize-pause (OP-0): a re-plan's room of 3.00 in a work budget of 6.00, so "big"
    // fits the work budget but not what is left (before, the room was the whole work budget,
    // and a task larger than that now runs in its turn: the cases further down).
    const cut = cutPlanToBudget(plan, 3_000_000, 6_000_000);
    expect(cut.items.map((i) => i.taskId)).toEqual(["small", "medium"]);
    expect(cut.estimateUsdMicro).toBe(3_000_000);
    expect(cut.leftOutForBudget?.map((i) => i.taskId)).toEqual(["big", "tiny"]);
    expect(cut.workBudgetUsdMicro).toBe(6_000_000);
    // W15-60: "items" as the number says (before: "item(s)").
    expect(cut.summary).toBe("4 ready task(s) in priority order (2 items cut to fit the budget)");
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

  it("one task larger than the budget no longer empties the plan: it runs in its turn (D4)", async () => {
    await add("Rewrite the engine", { priority: 9, est_cost_usd_micro: 5_000_000 });
    await add("Fix the typo", { priority: 5 });
    await add("Update the README", { priority: 1 });
    const r = await start();
    // d1109-oversize-start (the owner's D4 of 2026-11-09): before, "Rewrite the engine" was
    // left for next time in every session of this size. d1109-oversize-pause (OP-0, the owner's
    // answer 5): it runs in its turn, first by its priority; it spent nothing here, so the two
    // after it run with what it left.
    expect(ran).toEqual(["Rewrite the engine", "Fix the typo", "Update the README"]);
    expect(r.completed).toHaveLength(3);
    expect(r.plan?.leftOutForBudget).toBeUndefined();
    expect(r.plan?.oversized?.title).toBe("Rewrite the engine");
    expect(r.summary).not.toContain("Nothing to plan");
    expect(r.summary).not.toContain("Left for next time");
    expect(r.summary).not.toContain("$");
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
    // One blocker named briefly (design §4.5): what waits on what, and why it never runs.
    expect(r.summary.split("\n")[0]).toBe(
      'Nothing could run: "Build the API" waits on "Design the schema", which was cancelled.',
    );
    expect(r.summary).toContain("2 tasks wait on other tasks.");
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
    // d1109-oversize-pause (OP-0): the huge task runs first by its priority, with the whole work
    // budget; the small one comes after it (before: it ran first and the huge one was held).
    expect(view.runnable.map((t) => t.title)).toEqual([]);
    expect(view.overBudget.map((t) => [t.title, t.why])).toEqual([
      ["Huge task", "oversized"],
      ["After done", "after_large"],
    ]);
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

/**
 * d1109-oversize-start (OS-2; the owner's D4 of 2026-11-09: "it should get a warning, but it
 * should get done anyway"). Before, a task whose figure alone was more than the session's work
 * budget was left out of every plan: alone it emptied the session ("Nothing could run"), beside
 * other work it was "Left for next time" in every session of that size. Now the first such task
 * is held out of the queue and taken after the work that fits, with what is left of the work
 * budget (at least a fifth of it); a second one waits for the next session.
 */
describe("d1109-oversize-start, run C: a task larger than the work budget runs after the work that fits (OS-2)", () => {
  const usd = (n: number) => Math.round(n * 1_000_000);
  const item = (id: string, n: number) => ({
    taskId: id,
    title: id,
    specialist: "coder",
    estimateUsdMicro: usd(n),
  });
  const planOf = (...items: ReturnType<typeof item>[]) => ({
    items,
    estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
    summary: `${items.length} ready tasks in priority order`,
  });

  // d1109-oversize-pause (OP-0, the owner's answer 5): the larger task is in the plan at its
  // place with the room left; the items after it wait behind it ("after_large"). Before, it was
  // held apart until the work that fits was done, one a session ("one_large").
  it("cutPlanToBudget takes the first larger task at its place, the tasks after it behind it, and leaves out one there is no room for", () => {
    const a = cutPlanToBudget(planOf(item("A", 0.4), item("Big", 6), item("B", 0.3)), usd(4));
    expect(a.items.map((i) => [i.taskId, i.estimateUsdMicro])).toEqual([
      ["A", usd(0.4)],
      ["Big", usd(3.6)],
    ]);
    expect(a.oversized).toEqual({ ...item("Big", 6), roomUsdMicro: usd(3.6) });
    expect(a.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["B", "after_large"]]);
    expect(a.workBudgetUsdMicro).toBe(usd(4));
    const b = cutPlanToBudget(planOf(item("Big", 6), item("Big2", 9)), usd(4));
    expect(b.items.map((i) => i.taskId)).toEqual(["Big"]);
    expect(b.oversized?.taskId).toBe("Big");
    expect(b.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["Big2", "after_large"]]);
    // The tasks before it leave CHF 0.70 of 4.00, less than a fifth: no larger task starts.
    const c = cutPlanToBudget(planOf(item("A", 2), item("B", 1.3), item("Big", 6)), usd(4));
    expect(c.items.map((i) => i.taskId)).toEqual(["A", "B"]);
    expect(c.oversized).toBeUndefined();
    expect(c.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["Big", "no_room"]]);
    // A task that fits the work budget but not after the others keeps its old reason.
    const d = cutPlanToBudget(planOf(item("A", 3), item("B", 2), item("C", 0.5)), usd(4));
    expect(d.items.map((i) => i.taskId)).toEqual(["A", "C"]);
    expect(d.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["B", "after_others"]]);
    // At a re-plan the room is what is left, the larger test the whole work budget.
    const e = cutPlanToBudget(planOf(item("A", 1), item("Big", 6)), usd(1.5), usd(4));
    expect(e.items.map((i) => i.taskId)).toEqual(["A"]);
    expect(e.oversized).toBeUndefined();
    expect(e.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["Big", "no_room"]]);
  });

  let store: StateStore;
  let clock: SimulatedClock;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  const ran: string[] = [];
  /** Each run costs what its task's `cost` says (default USD 0.30), booked on the session. */
  const costs = new Map<string, number>();
  const executor: TaskExecutor = {
    async execute({ task, budget }) {
      ran.push(task.title);
      const cost = costs.get(task.title) ?? usd(0.3);
      budget.record(`run-${task.id}-${ran.length}`, cost);
      return { outcome: "done", summary: "done", costUsdMicro: cost, checksPassed: true };
    },
  };
  const add = (title: string, estimate: number, over: Record<string, unknown> = {}) =>
    store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: usd(estimate),
      reason: "seed",
      ...over,
    });
  const runner = () =>
    new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
    });
  /** A session of USD 2.00: its work budget is USD 1.60. */
  const start = (over: Record<string, unknown> = {}) =>
    runner().start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: usd(2),
      grant,
      ...over,
    });

  beforeEach(async () => {
    clock = new SimulatedClock("2026-11-09T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    w = await seedWorld(store, {}, { session: false });
    ran.length = 0;
    costs.clear();
  });

  it("a session whose only ready task is larger than its work budget runs it with the whole work budget", async () => {
    const shop = await add("Build the shop", 8);
    const r = await start();
    expect(ran).toEqual(["Build the shop"]);
    expect(r.stopReason).not.toBe("nothing_runnable");
    expect(r.summary).not.toContain("Nothing could run");
    // The plan row lists it with the room it was given: what the session review measures.
    expect(r.plan?.items).toEqual([
      {
        taskId: shop.id,
        title: "Build the shop",
        specialist: "coder",
        estimateUsdMicro: usd(1.6),
        // d1109-oversize-pause (OP-0): its whole figure, beside the room it got.
        wholeEstimateUsdMicro: usd(8),
      },
    ]);
    expect(r.plan?.oversized).toMatchObject({ estimateUsdMicro: usd(8), roomUsdMicro: usd(1.6) });
    const row = await store.session.mustGet(r.sessionId);
    expect((row.plan as { items: { taskId: string; estimateUsdMicro: number }[] }).items).toEqual([
      expect.objectContaining({ taskId: shop.id, estimateUsdMicro: usd(1.6) }),
    ]);
    expect(row.reason).toBe(
      'took "Build the shop", larger than this session\'s work budget, with what is left',
    );
    const events = await store.event.list(r.sessionId);
    const planned = events.find((e) => e.type === "session.planned");
    expect(planned?.payload).toMatchObject({
      items: 0,
      oversized: { taskId: shop.id, title: "Build the shop", estimateUsdMicro: usd(8) },
      workBudgetUsdMicro: usd(1.6),
    });
    const took = events.filter((e) => e.type === "session.took_larger");
    expect(took.map((e) => e.payload)).toEqual([
      {
        taskId: shop.id,
        title: "Build the shop",
        estimateUsdMicro: usd(8),
        roomUsdMicro: usd(1.6),
        workBudgetUsdMicro: usd(1.6),
      },
    ]);
    await store.close();
  });

  // d1109-oversize-pause (OP-0, the owner's answer 5: "no special ordering"): before, the tasks
  // that fit ran first whatever their priority, and a second larger task waited ("one_large").
  it("with tasks after it in the plan's order, the larger task runs first and they take what it leaves", async () => {
    await add("Build the shop", 8, { priority: 9 });
    await add("Write the intro", 0.3, { priority: 5 });
    await add("Write the about page", 0.3, { priority: 4 });
    // The larger task spends USD 1.00 of the work budget of USD 1.60.
    costs.set("Build the shop", usd(1));
    const r = await start();
    expect(ran).toEqual(["Build the shop", "Write the intro", "Write the about page"]);
    expect(r.plan?.items.map((i) => [i.title, i.estimateUsdMicro])).toEqual([
      ["Build the shop", usd(1.6)],
      ["Write the intro", usd(0.3)],
      ["Write the about page", usd(0.3)],
    ]);
    expect(r.plan?.leftOutForBudget).toBeUndefined();
    await store.close();
  });

  it("a task that becomes ready during the session runs after the larger one", async () => {
    const first = await add("Write the intro", 0.3);
    await add("Write the outro", 0.3, { depends_on: [first.id] });
    await add("Build the shop", 8, { priority: 1 });
    costs.set("Build the shop", usd(0.5));
    await start();
    expect(ran).toEqual(["Write the intro", "Build the shop", "Write the outro"]);
    await store.close();
  });

  it("a second larger task comes after the first: it runs if the first leaves a fifth, else it waits with why", async () => {
    await add("Build the shop", 8, { priority: 9 });
    await add("Big two", 9, { priority: 5 });
    costs.set("Build the shop", usd(1.5));
    const r = await start();
    // USD 1.50 of 1.60 spent: less than a fifth (0.32) is left, so "Big two" waits.
    expect(ran).toEqual(["Build the shop"]);
    expect(r.plan?.leftOutForBudget?.map((i) => [i.title, i.reason])).toEqual([
      ["Big two", "no_room"],
    ]);
    // OS-7: the result says why it waits, in its one sentence; never "Nothing could run".
    expect(r.summary).toMatch(
      /"Big two" needs about CHF [\d.]+, more than this session's work budget: the tasks before it leave too little to start it, so it waits for the next session\./,
    );
    expect(r.summary).not.toMatch(/one task that large|Nothing could run/);
    await store.close();
  });

  it("when the work that fits leaves less than a fifth of the work budget, the larger task waits (no_room)", async () => {
    await add("Write the intro", 0.7);
    await add("Write the about page", 0.7);
    await add("Build the shop", 8, { priority: 1 });
    costs.set("Write the intro", usd(0.7));
    costs.set("Write the about page", usd(0.7));
    const r = await start();
    // USD 1.40 of 1.60 spent: 0.20 is left, less than a fifth (0.32).
    expect(ran).toEqual(["Write the intro", "Write the about page"]);
    expect(r.plan?.leftOutForBudget?.map((i) => [i.title, i.reason])).toEqual([
      ["Build the shop", "no_room"],
    ]);
    expect(
      (await store.event.list(r.sessionId)).some((e) => e.type === "session.took_larger"),
    ).toBe(false);
    await store.close();
  });

  it("the Start check takes the same task at its place, with the room the tasks before it leave", async () => {
    const check = () => startCheck({ store }, w.project, usd(2));
    const big = await add("Build the shop", 8, { priority: 4 });
    let c = await check();
    expect(c.runnable).toEqual([]);
    expect(c.oversized).toEqual({
      taskId: big.id,
      title: "Build the shop",
      estimateUsdMicro: usd(8),
      roomUsdMicro: usd(1.6),
      after: false,
      before: [],
      comesAfter: [],
    });
    expect(c.overBudget.map((t) => [t.title, t.reason])).toEqual([["Build the shop", "oversized"]]);
    // A task before it in the plan's order, and one that follows that task once it is done:
    // d1109-oversize-pause (OP-0) runs the first before it and the second after it (before, both
    // ran before it and its room was what they left together).
    const intro = await add("Write the intro", 0.3, { priority: 5 });
    await add("Write the outro", 0.3, { depends_on: [intro.id] });
    c = await check();
    expect(c.runnable.map((t) => t.title)).toEqual(["Write the intro"]);
    expect(c.later.map((t) => t.title)).toEqual(["Write the outro"]);
    expect(c.oversized).toMatchObject({
      roomUsdMicro: usd(1.3),
      after: true,
      before: ["Write the intro"],
      comesAfter: ["Write the outro"],
    });
    // A second larger task comes after the first.
    await add("Big two", 9, { priority: 1 });
    c = await check();
    expect(c.overBudget.map((t) => [t.title, t.reason])).toEqual([
      ["Build the shop", "oversized"],
      ["Big two", "after_large"],
    ]);
    expect(c.oversized?.comesAfter).toEqual(["Big two", "Write the outro"]);
    // The tasks before it leave less than a fifth: it waits, and the cut goes on after it.
    await add("Write the menu", 1.2, { priority: 5 });
    c = await check();
    expect(c.oversized).toBeNull();
    expect(c.overBudget.map((t) => [t.title, t.reason])).toEqual([
      ["Build the shop", "no_room"],
      ["Big two", "no_room"],
    ]);
    await store.close();
  });

  it("at autonomy 1 the plan the person approves names the larger task, and the approved session runs it", async () => {
    const project = await store.project.mustGet(w.project);
    await store.project.update(project.id, project.version, { autonomy_level: 1 });
    const shop = await add("Build the shop", 8);
    const filed = await start();
    expect(filed.stopReason).toBe("plan_awaiting_approval");
    expect(ran).toEqual([]);
    const [req] = await store.humanRequest.list({ session_id: filed.sessionId } as never);
    expect(req?.steps).toEqual(["Build the shop (coder, about CHF 6.40)"]);
    const planId = (req?.change_card as { plan_id?: string } | null)?.plan_id;
    expect(planId).toBeTruthy();
    const approved = await start({ planApproved: planId });
    expect(ran).toEqual(["Build the shop"]);
    expect(approved.plan?.items.map((i) => i.taskId)).toEqual([shop.id]);
    await store.close();
  });
});

/**
 * d1109-oversize-pause (OP-0; the owner's answer 5 of 2026-11-09: "As i said, it should work on
 * tasks even when it cannot complete them, and be able to wrap up and continue next time. Again,
 * I thought we talked about this."): no special ordering. A task larger than the work budget runs
 * in its turn (priority, then the plan's order) with what is left of the work budget; the tasks
 * after it are the session's own and take only what it leaves, else they wait for the next
 * session. Before (d1109-oversize-start), it was held out of the queue until the work that fits
 * was done and a re-plan added nothing, one a session.
 */
describe("d1109-oversize-pause, run C: the larger task in its turn (OP-0)", () => {
  const usd = (n: number) => Math.round(n * 1_000_000);
  const item = (id: string, n: number) => ({
    taskId: id,
    title: id,
    specialist: "coder",
    estimateUsdMicro: usd(n),
  });
  const planOf = (...items: ReturnType<typeof item>[]) => ({
    items,
    estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
    summary: `${items.length} ready tasks in priority order`,
  });

  it("cutPlanToBudget: the acceptance's four plans", () => {
    const a = cutPlanToBudget(planOf(item("A", 0.4), item("Big", 6), item("B", 0.3)), usd(4));
    expect(a.items.map((i) => [i.taskId, i.estimateUsdMicro])).toEqual([
      ["A", usd(0.4)],
      ["Big", usd(3.6)],
    ]);
    expect(a.leftOutForBudget?.map((i) => [i.taskId, i.reason, i.after])).toEqual([
      ["B", "after_large", "Big"],
    ]);
    const b = cutPlanToBudget(planOf(item("Big", 6), item("A", 0.4)), usd(4));
    expect(b.items.map((i) => [i.taskId, i.estimateUsdMicro])).toEqual([["Big", usd(4)]]);
    expect(b.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["A", "after_large"]]);
    const c = cutPlanToBudget(planOf(item("Big", 6), item("Big2", 9)), usd(4));
    expect(c.items.map((i) => i.taskId)).toEqual(["Big"]);
    expect(c.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["Big2", "after_large"]]);
    const d = cutPlanToBudget(planOf(item("A", 3.5), item("Big", 6), item("B", 0.3)), usd(4));
    expect(d.items.map((i) => i.taskId)).toEqual(["A", "B"]);
    expect(d.oversized).toBeUndefined();
    expect(d.leftOutForBudget?.map((i) => [i.taskId, i.reason])).toEqual([["Big", "no_room"]]);
    // 'one_large' appears nowhere.
    expect(JSON.stringify([a, b, c, d])).not.toContain("one_large");
  });

  let store: StateStore;
  let clock: SimulatedClock;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  const ran: string[] = [];
  /** What each task's run does: done at a cost (default USD 0.30), failed, or paused. */
  const runs = new Map<string, { outcome: "done" | "failed" | "paused"; cost: number }>();
  const executor: TaskExecutor = {
    async execute({ task, budget }) {
      ran.push(task.title);
      const r = runs.get(task.title) ?? { outcome: "done" as const, cost: usd(0.3) };
      budget.record(`run-${task.id}-${ran.length}`, r.cost);
      if (r.outcome === "paused")
        return {
          outcome: "paused",
          summary: "paused at the session's budget",
          costUsdMicro: r.cost,
          checksPassed: false,
          budgetStop: {
            capUsdMicro: usd(1.6),
            spentUsdMicro: r.cost,
            source: "session",
            specialist: "coder",
            stoppedBy: "wrap_up",
          },
          handoff: {
            stopped: "Built the cart.",
            leftToDo: ["Build checkout"],
            stoppedBy: "wrap_up",
          },
        };
      if (r.outcome === "failed")
        return {
          outcome: "failed",
          summary: "it broke",
          costUsdMicro: r.cost,
          checksPassed: false,
        };
      return { outcome: "done", summary: "done", costUsdMicro: r.cost, checksPassed: true };
    },
  };
  const add = (title: string, estimate: number, over: Record<string, unknown> = {}) =>
    store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: usd(estimate),
      reason: "seed",
      ...over,
    });
  /** A session of USD 2.00: its work budget is USD 1.60. */
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
      budgetCapUsdMicro: usd(2),
      grant,
    });

  beforeEach(async () => {
    clock = new SimulatedClock("2026-11-10T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    w = await seedWorld(store, {}, { session: false });
    ran.length = 0;
    runs.clear();
  });

  it("A, then the larger task until the session's budget is used; B waits for the next session, as the result says", async () => {
    await add("A", 0.4, { priority: 9 });
    await add("Build the shop", 8, { priority: 5 });
    await add("B", 0.3, { priority: 1 });
    runs.set("A", { outcome: "done", cost: usd(0.4) });
    runs.set("Build the shop", { outcome: "paused", cost: usd(1.15) });
    const r = await start();
    expect(ran).toEqual(["A", "Build the shop"]);
    expect(r.plan?.leftOutForBudget?.map((i) => [i.title, i.reason, i.after])).toEqual([
      ["B", "after_large", "Build the shop"],
    ]);
    expect(r.summary).toContain(
      '"B" waits for your next session: "Build the shop" used the rest of this one.',
    );
    expect(r.summary).not.toMatch(
      /after the other tasks|after the work that fits|one task that large/,
    );
    // The take is in the log once, at its turn after A.
    const events = await store.event.list(r.sessionId);
    const took = events.filter((e) => e.type === "session.took_larger");
    expect(took.map((e) => (e.payload as { roomUsdMicro: number }).roomUsdMicro)).toEqual([
      usd(1.2),
    ]);
    await store.close();
  });

  it("with the larger task at the highest priority it runs first, and the others wait for what it leaves", async () => {
    await add("A", 0.4, { priority: 5 });
    await add("Build the shop", 8, { priority: 9 });
    await add("B", 0.3, { priority: 1 });
    runs.set("Build the shop", { outcome: "paused", cost: usd(1.5) });
    const r = await start();
    expect(ran).toEqual(["Build the shop"]);
    expect(r.plan?.leftOutForBudget?.map((i) => i.title)).toEqual(["A", "B"]);
    expect(r.summary).toContain(
      '"A" and 1 more wait for your next session: "Build the shop" used the rest of this one.',
    );
    await store.close();
  });

  it("when the larger task fails at once, the re-plan takes the tasks after it in the same session", async () => {
    await add("Build the shop", 8, { priority: 9 });
    await add("B", 0.3, { priority: 5 });
    runs.set("Build the shop", { outcome: "failed", cost: usd(0.05) });
    const r = await start();
    expect(ran).toEqual(["Build the shop", "B"]);
    expect(r.plan?.leftOutForBudget).toBeUndefined();
    expect(r.summary).not.toContain("waits for your next session");
    await store.close();
  });

  it("at autonomy 1 the plan the person approves lists the larger task at its place and the tasks after it", async () => {
    const project = await store.project.mustGet(w.project);
    await store.project.update(project.id, project.version, { autonomy_level: 1 });
    await add("Build the shop", 8, { priority: 9 });
    await add("B", 0.3, { priority: 5 });
    const filed = await start();
    expect(filed.stopReason).toBe("plan_awaiting_approval");
    const [req] = await store.humanRequest.list({ session_id: filed.sessionId } as never);
    expect(req?.steps).toEqual([
      "Build the shop (coder, about CHF 6.40)",
      "B (coder, about CHF 0.24)",
    ]);
    await store.close();
  });
});

/**
 * d1109-oversize-pause (OP-0, "continue next time"; the owner's answer 5: "be able to wrap up and
 * continue next time", and D4: "continues from there in the next run"). Before, a task paused at
 * the session's budget waited on its card until the person pressed Continue; a plain Start left it
 * out. Now the next start takes it in its turn from its kept work and closes its card; a pause at
 * the task's own budget, one that got no further and one at an outer limit are not taken.
 */
describe("d1109-oversize-pause, run C: the next Start continues a session-budget pause (OP-0)", () => {
  const usd = (n: number) => Math.round(n * 1_000_000);
  let store: StateStore;
  let clock: SimulatedClock;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  const ran: string[] = [];
  const executor: TaskExecutor = {
    async execute({ task, budget }) {
      ran.push(task.title);
      budget.record(`run-${task.id}-${ran.length}`, usd(0.1));
      return { outcome: "done", summary: "done", costUsdMicro: usd(0.1), checksPassed: true };
    },
  };
  /** A task paused at a limit, with the card its run filed. */
  const paused = async (
    title: string,
    source: "session" | "task_budget" | "project" | "specialist_limit",
    over: { noProgress?: boolean; priority?: number } = {},
  ) => {
    const task = await store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "needs_human",
      priority: over.priority ?? 5,
      est_cost_usd_micro: usd(0.4),
      reason: "paused",
    });
    const { request } = await fileBudgetStopCard({
      store,
      task,
      session: null,
      humanId: w.human,
      agentId: w.agent,
      runId: null,
      stop: {
        capUsdMicro: usd(1),
        spentUsdMicro: usd(0.3),
        source,
        specialist: "coder",
        stoppedBy: "wrap_up",
      },
      handoff: { stopped: "Half of it.", leftToDo: ["The rest"], stoppedBy: "wrap_up" },
      now: clock.nowIso(),
      chfPerUsd: 0.8,
    });
    if (over.noProgress)
      await store.humanRequest.patch(request.id, {
        change_card: { ...(request.change_card as object), no_progress: true },
      });
    return { task, card: request };
  };
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
      budgetCapUsdMicro: usd(2),
      grant,
    });

  beforeEach(async () => {
    clock = new SimulatedClock("2026-11-10T13:05:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    w = await seedWorld(store, {}, { session: false });
    ran.length = 0;
  });

  it("a plain Start takes the session-budget pause in its turn, closes its card in one step and grows no budget; the others wait on their cards", async () => {
    const shop = await paused("Build the shop", "session", { priority: 9 });
    const own = await paused("Own budget", "task_budget");
    const stuck = await paused("No progress", "session", { noProgress: true });
    const outer = await paused("Project limit", "project");
    const limit = await paused("Coder limit", "specialist_limit", { priority: 1 });
    // Before the start: the card's Continue and the task row say the next Start takes it.
    const before = requestWords(shop.card, { taskTitle: "Build the shop" });
    expect(before.choices[0]?.explain).toBe(
      "Starts a session now with CHF 0.80; without it, your next Start takes it in its turn.",
    );
    expect(budgetPauseDetail("session")).toBe(
      "Your next Start goes on with it, or Continue in the Inbox.",
    );
    expect(budgetPauseDetail("specialist_limit")).toBe(
      "Your next Start goes on with it, or Continue in the Inbox.",
    );
    // The Start check counts the two it takes, at what is left of their estimates.
    const check = await startCheck({ store }, w.project, usd(2));
    expect(check.runnable.map((t) => t.title)).toEqual(["Build the shop", "Coder limit"]);
    const r = await start();
    expect(ran).toEqual(["Build the shop", "Coder limit"]);
    for (const t of [shop, limit]) {
      const card = await store.humanRequest.mustGet(t.card.id);
      expect(card.status).toBe("withdrawn");
      expect(card.change_card).toMatchObject({
        outcome: "went_on_at_start",
        started_session_id: r.sessionId,
      });
      // No budget grew: the task's own stays as it was.
      expect((await store.task.mustGet(t.task.id)).budget_usd_micro).toBe(t.task.budget_usd_micro);
    }
    const done = requestWords(await store.humanRequest.mustGet(shop.card.id), {
      taskTitle: "Build the shop",
    });
    expect(done.outcome).toMatch(/^Your session of \d\d:\d\d went on with it\.$/);
    for (const t of [own, stuck, outer]) {
      expect((await store.humanRequest.mustGet(t.card.id)).status).toBe("open");
      expect((await store.task.mustGet(t.task.id)).status).toBe("needs_human");
    }
    await store.close();
  });

  it("a card answered before the claim is left as it is: the task moved on", async () => {
    const shop = await paused("Build the shop", "session");
    // The person cancels it before the session claims it.
    const t = await store.task.mustGet(shop.task.id);
    await store.task.transition(t.id, t.version, "cancelled", "you cancelled it", {
      humanId: w.human,
    });
    expect(
      await closeByStart({
        store,
        task: shop.task,
        session: { id: "s1" },
        agentId: w.agent,
        startTime: "14:05",
        now: clock.nowIso(),
      }),
    ).toBe(false);
    expect((await store.humanRequest.mustGet(shop.card.id)).status).toBe("open");
    await store.close();
  });
});
