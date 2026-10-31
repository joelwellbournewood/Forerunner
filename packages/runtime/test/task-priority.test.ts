import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  PRIORITY_VALUES,
  priorityLevel,
  readPriority,
  storedPriority,
  TaskPrioritySchema,
} from "../src/priority.ts";
import { renderStateBrief } from "../src/session/brief.ts";
import { runStartupChecklist } from "../src/session/checklist.ts";
import { ProjectPlanBody } from "../src/session/project-plan.ts";
import { seedWorld } from "./context-helpers.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-041, the owner's decision: the New task dialog said "Priority (1 high)" while the planner ran
 * the higher number first. Priority is now Low, Medium or High wherever a person or a model sets
 * or sees it; the column stays a number (higher runs first), so old rows keep their order and
 * read as their level, and an old number from a model is taken as its level.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

describe("the priority levels and the stored numbers (U-041)", () => {
  it("an old number reads as its level: high numbers are High, as they ran first", () => {
    const levels = Array.from({ length: 11 }, (_, n) => priorityLevel(n));
    expect(levels).toEqual([
      "low",
      "low",
      "low",
      "low",
      "medium",
      "medium",
      "medium",
      "high",
      "high",
      "high",
      "high",
    ]);
  });

  it("a level is stored at the end of its band, so a new High never waits behind an old one", () => {
    expect(PRIORITY_VALUES).toEqual({ low: 1, medium: 5, high: 10 });
    for (const n of [0, 1, 2, 3]) expect(PRIORITY_VALUES.low).toBeLessThanOrEqual(n || 1);
    for (const n of [7, 8, 9, 10]) expect(PRIORITY_VALUES.high).toBeGreaterThanOrEqual(n);
    // Each level's number reads back as that level.
    for (const level of ["low", "medium", "high"] as const)
      expect(priorityLevel(PRIORITY_VALUES[level])).toBe(level);
  });

  it("a priority as given: words in any case, an old number, a number in a string; else null", () => {
    expect(readPriority("High")).toBe("high");
    expect(readPriority(" low ")).toBe("low");
    expect(readPriority("normal")).toBe("medium");
    expect(readPriority(8)).toBe("high");
    expect(readPriority("3")).toBe("low");
    expect(readPriority("urgent")).toBeNull();
    expect(readPriority(null)).toBeNull();
    expect(storedPriority("high")).toBe(10);
    expect(storedPriority(6)).toBe(5);
    expect(storedPriority(undefined)).toBe(5);
  });

  it("a model is shown the three words only, and an old number in its reply is not refused", () => {
    const schema = z.object({ priority: TaskPrioritySchema.default("medium") });
    expect(z.toJSONSchema(schema).properties).toEqual({
      priority: { default: "medium", type: "string", enum: ["low", "medium", "high"] },
    });
    expect(schema.parse({ priority: 9 }).priority).toBe("high");
    expect(schema.parse({}).priority).toBe("medium");
    expect(schema.safeParse({ priority: "urgent" }).success).toBe(false);
    // The plan writer's schema (the intake's and `POST /projects/:id/plan`'s) takes both.
    const plan = ProjectPlanBody.parse({
      reason: "r",
      milestones: [],
      tasks: [
        { title: "New words", outcome: "done well", priority: "High" },
        { title: "Old number", outcome: "done well", priority: 2 },
      ],
    });
    expect(plan.tasks.map((t) => t.priority)).toEqual(["high", "low"]);
  });

  it("the brief shows the principal the level of each ready task, never the number", async () => {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const w = await seedWorld(store, {}, { session: false });
    for (const [title, priority] of [
      ["Fix the login", 8],
      ["Tidy the README", 2],
    ] as const)
      await store.task.insert({
        project_id: w.project,
        title,
        outcome: "x",
        status: "ready",
        priority,
      });
    const text = renderStateBrief(
      await runStartupChecklist({
        store,
        clock,
        agentId: w.agent,
        projectId: w.project,
        appVersion: "0.1.0",
        sessionCapUsdMicro: 5_000_000,
      }),
    );
    const lineOf = (title: string) => text.split("\n").find((l) => l.includes(title)) ?? "";
    expect(lineOf("Fix the login")).toMatch(/^- ready: high priority: Fix the login/);
    expect(lineOf("Tidy the README")).toMatch(/^- ready: low priority: Tidy the README/);
    expect(text).not.toMatch(/\bp[0-9]+ /);
    await store.close();
  });
});

describe("priority at the daemon's routes and in the plan order (U-041)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u041-"));
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
    projectId = (await rt.store.project.insert({ name: "Order", goal: "High first" })).id;
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

  it("New task's High is stored to run first, answered as the word; old rows read as their level and keep their order", async () => {
    // Rows from before the change: numbers, the higher ran first.
    for (const [title, priority] of [
      ["Old urgent", 9],
      ["Old normal", 6],
      ["Old later", 2],
    ] as const)
      await rt.store.task.insert({
        project_id: projectId,
        title,
        outcome: "x",
        status: "ready",
        priority,
        est_cost_usd_micro: 100_000,
      });
    // What the New task dialog sends now.
    const create = async (title: string, priority: string) => {
      const res = await call("POST", `/projects/${projectId}/tasks`, {
        title,
        outcome: `${title} is done`,
        acceptanceCriteria: [],
        priority,
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 0,
      });
      expect(res.status).toBe(201);
      return TaskView.parse(await res.json());
    };
    expect((await create("New urgent", "high")).priority).toBe("high");
    expect((await create("New normal", "medium")).priority).toBe("medium");
    const rows = await rt.store.task.forProject(projectId);
    expect(rows.find((t) => t.title === "New urgent")?.priority).toBe(10);
    expect(rows.find((t) => t.title === "New normal")?.priority).toBe(5);

    // The Tasks tab's list: words, highest first; an old 9 is High, an old 6 Medium.
    const listed = (await (await call("GET", `/projects/${projectId}/tasks`)).json()) as unknown[];
    const views = listed.map((v) => TaskView.parse(v));
    expect(views.map((v) => [v.title, v.priority])).toEqual([
      ["New urgent", "high"],
      ["Old urgent", "high"],
      ["Old normal", "medium"],
      ["New normal", "medium"],
      ["Old later", "low"],
    ]);
    // The planner runs them in that order (the start check prices and cuts as a session does).
    const check = await rt.startCheck(projectId, 50_000_000);
    expect(check.runnable.map((t) => t.title)).toEqual([
      "New urgent",
      "Old urgent",
      "Old normal",
      "New normal",
      "Old later",
    ]);
  });

  it("an old client's number is still taken, as its level", async () => {
    const res = await call("POST", `/projects/${projectId}/tasks`, {
      title: "From an old client",
      outcome: "still works",
      priority: 8,
    });
    expect(res.status).toBe(201);
    expect(TaskView.parse(await res.json()).priority).toBe("high");
  });
});
