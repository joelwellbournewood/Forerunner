import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type ProjectRow, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { projectCard } from "../src/daemon/views.ts";
import {
  applyProjectPlan,
  defaultRiskTier,
  MAX_PLAN_MILESTONES,
  MAX_PLAN_TASKS,
  milestoneMerge,
  PLAN_AUDIT_TOOL,
  type ProjectPlanInput,
  shapeProjectPlan,
} from "../src/session/project-plan.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const jsonList = async (r: Response): Promise<Json[]> => (await r.json()) as Json[];
const str = (v: unknown): string => String(v);

/** A two-phase plan with one dependency chain across the phases and one task outside them. */
const PLAN: ProjectPlanInput = {
  reason: "planned from the brief",
  milestones: [
    {
      name: "Phase 1: scaffold",
      successCriteria: ["Repo builds"],
      targetDate: "2026-11-01",
      tasks: [
        { key: "scaffold", title: "Scaffold the app", outcome: "pnpm dev runs" },
        {
          key: "ci",
          title: "Add CI",
          outcome: "CI runs the tests",
          dependsOn: ["scaffold"],
          riskTier: 2,
        },
      ],
    },
    {
      name: "Phase 2: launch",
      successCriteria: ["Site deployed", "Repo builds"],
      targetDate: "2026-12-01",
      tasks: [
        { key: "deploy", title: "Deploy the site", outcome: "Live URL answers", dependsOn: ["ci"] },
      ],
    },
  ],
  tasks: [{ key: "readme", title: "Write the README", outcome: "README explains setup" }],
};

async function worldWith(small: boolean): Promise<{ store: StateStore; project: ProjectRow }> {
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const project = await store.project.insert({
    name: small ? "Tiny" : "Atlas",
    goal: "Ship it",
    autonomy_level: 2,
    small_project_mode: small,
  });
  return { store, project };
}

async function validationError(p: Promise<unknown>): Promise<ForerunnerError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ForerunnerError);
    expect((err as ForerunnerError).code).toBe("validation");
    return err as ForerunnerError;
  }
  throw new Error("expected a validation error");
}

describe("small-project mode: the default tier of a new task (B.6)", () => {
  it("is 0 when the flag is on and 1 otherwise", () => {
    expect(defaultRiskTier({ small_project_mode: true })).toBe(0);
    expect(defaultRiskTier({ small_project_mode: false })).toBe(1);
  });
});

describe("small-project mode: what a later plan adds to the open milestone (B.6)", () => {
  it("adds the criteria the milestone lacks once each in plan order and a later target date; nothing when it has them", () => {
    const open = { success_criteria: ["Repo builds"], target_date: "2026-11-01" };
    expect(
      milestoneMerge(open, {
        successCriteria: ["Site deployed", "Repo builds", "Site deployed", "Analytics live"],
        targetDate: "2026-12-01",
      }),
    ).toEqual({ successCriteria: ["Site deployed", "Analytics live"], targetDate: "2026-12-01" });
    // An earlier date and criteria already on file add nothing.
    expect(
      milestoneMerge(open, { successCriteria: ["Repo builds"], targetDate: "2026-10-01" }),
    ).toBeNull();
    expect(milestoneMerge(open, { successCriteria: [], targetDate: null })).toBeNull();
    expect(milestoneMerge(open, { successCriteria: [], targetDate: "2026-11-01" })).toBeNull();
    // A milestone without a date takes the plan's.
    expect(
      milestoneMerge(
        { success_criteria: [], target_date: null },
        { successCriteria: [], targetDate: "2026-10-01" },
      ),
    ).toEqual({ successCriteria: [], targetDate: "2026-10-01" });
  });
});

describe("small-project mode: shaping a plan (B.6)", () => {
  it("flag on: one milestone named after the project, every task under it in plan order, tier 0 unless the task names one", async () => {
    const { store, project } = await worldWith(true);
    const shaped = shapeProjectPlan(PLAN, project);
    expect(shaped.smallProject).toBe(true);
    expect(shaped.milestones).toHaveLength(1);
    expect(shaped.unassigned).toEqual([]);
    const [only] = shaped.milestones;
    expect(only?.name).toBe("Tiny");
    expect(only?.successCriteria).toEqual(["Repo builds", "Site deployed"]);
    expect(only?.targetDate).toBe("2026-12-01");
    expect(only?.orderIndex).toBe(0);
    expect(only?.tasks.map((t) => [t.key, t.riskTier])).toEqual([
      ["scaffold", 0],
      ["ci", 2],
      ["deploy", 0],
      ["readme", 0],
    ]);
    await store.close();
  });

  it("flag on with a single planned milestone keeps its name, criteria and date", async () => {
    const { store, project } = await worldWith(true);
    const one: ProjectPlanInput = {
      milestones: [PLAN.milestones?.[0] as NonNullable<ProjectPlanInput["milestones"]>[number]],
    };
    const shaped = shapeProjectPlan(one, project);
    expect(shaped.milestones.map((m) => [m.name, m.successCriteria, m.targetDate])).toEqual([
      ["Phase 1: scaffold", ["Repo builds"], "2026-11-01"],
    ]);
    const bare = shapeProjectPlan({ tasks: PLAN.tasks }, project);
    expect(bare.milestones.map((m) => [m.name, m.successCriteria, m.targetDate])).toEqual([
      ["Tiny", [], null],
    ]);
    expect(bare.milestones[0]?.tasks.map((t) => t.key)).toEqual(["readme"]);
    await store.close();
  });

  it("flag off: a milestone per planned phase, tasks under theirs, the rest unassigned, tier 1 unless the task names one", async () => {
    const { store, project } = await worldWith(false);
    const shaped = shapeProjectPlan(PLAN, project);
    expect(shaped.smallProject).toBe(false);
    expect(shaped.milestones.map((m) => [m.name, m.orderIndex, m.tasks.map((t) => t.key)])).toEqual(
      [
        ["Phase 1: scaffold", 0, ["scaffold", "ci"]],
        ["Phase 2: launch", 1, ["deploy"]],
      ],
    );
    expect(shaped.unassigned.map((t) => [t.key, t.riskTier])).toEqual([["readme", 1]]);
    expect(shaped.milestones.flatMap((m) => m.tasks.map((t) => t.riskTier))).toEqual([1, 2, 1]);
    await store.close();
  });
});

describe("small-project mode: writing a plan (B.6)", () => {
  it("flag on: exactly one milestone row, a flat task list under it, dependencies resolved to ids", async () => {
    const { store, project } = await worldWith(true);
    const applied = await applyProjectPlan(store, project, PLAN, { humanId: "h1" });
    const milestones = await store.milestone.forProject(project.id);
    expect(milestones).toHaveLength(1);
    expect(applied.milestones.map((m) => m.id)).toEqual([milestones[0]?.id]);
    expect(applied.reusedMilestone).toBeNull();
    const tasks = await store.task.forProject(project.id);
    expect(tasks).toHaveLength(4);
    expect(new Set(tasks.map((t) => t.milestone_id))).toEqual(new Set([milestones[0]?.id]));
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    expect(byTitle.get("Add CI")?.depends_on).toEqual([byTitle.get("Scaffold the app")?.id]);
    expect(byTitle.get("Deploy the site")?.depends_on).toEqual([byTitle.get("Add CI")?.id]);
    expect(tasks.map((t) => t.risk_tier).sort()).toEqual([0, 0, 0, 2]);
    expect(tasks.every((t) => t.reason === "planned from the brief")).toBe(true);
    expect(tasks.every((t) => t.author_human === "h1")).toBe(true);
    expect(applied.tasks.map((t) => t.title)).toEqual([
      "Scaffold the app",
      "Add CI",
      "Deploy the site",
      "Write the README",
    ]);
    await store.close();
  });

  it("flag on: a later plan joins the open milestone, which keeps its name and takes the plan's new criteria and later date; the join is reported and audited", async () => {
    const { store, project } = await worldWith(true);
    const first = await applyProjectPlan(store, project, PLAN, { agentId: "a1" });
    const opened = first.milestones[0];
    const second = await applyProjectPlan(
      store,
      project,
      {
        reason: "analytics added after the review",
        milestones: [
          {
            name: "Phase 3",
            successCriteria: ["Site deployed", "Analytics live"],
            targetDate: "2027-01-15",
            tasks: [{ title: "Add analytics", outcome: "Pageviews" }],
          },
        ],
      },
      { agentId: "a1" },
    );
    expect(second.milestones).toEqual([]);
    expect(second.merged).toEqual({
      successCriteria: ["Analytics live"],
      targetDate: "2027-01-15",
    });
    expect(second.reusedMilestone).toMatchObject({
      id: opened?.id,
      name: "Tiny",
      success_criteria: ["Repo builds", "Site deployed", "Analytics live"],
      target_date: "2027-01-15",
      version: (opened?.version ?? 0) + 1,
      author_agent: "a1",
    });
    const rows = await store.milestone.forProject(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(second.reusedMilestone);
    expect(second.tasks[0]?.milestone_id).toBe(opened?.id);
    expect(second.tasks[0]?.author_agent).toBe("a1");
    // Milestone rows carry no reason yet (B.5): the join and the plan's reason go to the audit log.
    const audit = await store.auditLog.list({ tool: PLAN_AUDIT_TOOL });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ allowed: true, agent_id: "a1", human_id: null });
    expect(audit[0]?.input_summary).toMatch(/Tiny/);
    expect(audit[0]?.input_summary).toMatch(/Analytics live/);
    expect(audit[0]?.input_summary).toMatch(/2027-01-15/);
    expect(audit[0]?.result_summary).toMatch(/analytics added after the review/);

    // Nothing new: criteria already on file and an earlier date leave the milestone untouched.
    const third = await applyProjectPlan(
      store,
      project,
      {
        milestones: [
          {
            name: "Phase 4",
            successCriteria: ["Repo builds"],
            targetDate: "2026-06-01",
            tasks: [{ title: "Tidy up", outcome: "Clean tree" }],
          },
        ],
        tasks: [{ title: "Write the changelog", outcome: "Changelog explains it" }],
      },
      { humanId: "h1" },
    );
    expect(third.merged).toBeNull();
    expect(third.reusedMilestone).toEqual(second.reusedMilestone);
    expect(await store.milestone.forProject(project.id)).toEqual([second.reusedMilestone]);
    expect(await store.auditLog.list({ tool: PLAN_AUDIT_TOOL })).toHaveLength(1);
    expect(await store.task.forProject(project.id)).toHaveLength(7);
    await store.close();
  });

  it("flag on: with only closed milestones on file the one milestone is created after them, at a free order_index, and later plans join it", async () => {
    const { store, project } = await worldWith(true);
    // Milestones from before the mode was switched on, both closed: the mode's one milestone
    // follows them the way a phase does outside the mode, never at an order_index taken.
    await store.milestone.insert({
      project_id: project.id,
      name: "Kickoff",
      order_index: 0,
      status: "done",
    });
    await store.milestone.insert({
      project_id: project.id,
      name: "Old plan",
      order_index: 1,
      status: "cancelled",
    });
    const applied = await applyProjectPlan(store, project, PLAN, { humanId: "h1" });
    expect(applied.reusedMilestone).toBeNull();
    expect(applied.milestones.map((m) => [m.name, m.order_index, m.status])).toEqual([
      ["Tiny", 2, "planned"],
    ]);
    const rows = await store.milestone.forProject(project.id);
    expect(rows.map((m) => [m.name, m.order_index])).toEqual([
      ["Kickoff", 0],
      ["Old plan", 1],
      ["Tiny", 2],
    ]);
    expect(new Set(rows.map((m) => m.order_index)).size).toBe(rows.length);
    const only = applied.milestones[0]?.id;
    // The project card names the open milestone, never the cancelled one before it.
    const card = await projectCard(store, project.id, 1, "h1");
    expect(card.nextMilestone?.id).toBe(only);
    expect(card.nextMilestone?.name).toBe("Tiny");
    const tasks = await store.task.forProject(project.id);
    expect(tasks).toHaveLength(4);
    expect(new Set(tasks.map((t) => t.milestone_id))).toEqual(new Set([only]));
    // The closed milestones are never joined: a later plan goes to the open one.
    const again = await applyProjectPlan(
      store,
      project,
      { tasks: [{ title: "Write the FAQ", outcome: "FAQ answers it" }] },
      { humanId: "h1" },
    );
    expect(again.milestones).toEqual([]);
    expect(again.reusedMilestone?.id).toBe(only);
    expect(again.tasks[0]?.milestone_id).toBe(only);
    expect(await store.milestone.forProject(project.id)).toHaveLength(3);
    await store.close();
  });

  it("flag off: one milestone per phase after the existing ones, the loose task without a milestone", async () => {
    const { store, project } = await worldWith(false);
    await store.milestone.insert({ project_id: project.id, name: "Kickoff", order_index: 0 });
    const applied = await applyProjectPlan(store, project, PLAN, { humanId: "h1" });
    const milestones = await store.milestone.forProject(project.id);
    expect(milestones.map((m) => [m.name, m.order_index])).toEqual([
      ["Kickoff", 0],
      ["Phase 1: scaffold", 1],
      ["Phase 2: launch", 2],
    ]);
    expect(applied.milestones.map((m) => m.name)).toEqual(["Phase 1: scaffold", "Phase 2: launch"]);
    expect(applied.milestones[1]?.target_date).toBe("2026-12-01");
    expect(applied.milestones[1]?.success_criteria).toEqual(["Site deployed", "Repo builds"]);
    const tasks = await store.task.forProject(project.id);
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    expect(byTitle.get("Scaffold the app")?.milestone_id).toBe(applied.milestones[0]?.id);
    expect(byTitle.get("Deploy the site")?.milestone_id).toBe(applied.milestones[1]?.id);
    expect(byTitle.get("Write the README")?.milestone_id).toBeNull();
    expect(byTitle.get("Write the README")?.risk_tier).toBe(1);
    expect(byTitle.get("Add CI")?.risk_tier).toBe(2);
    await store.close();
  });

  it("writes dependencies before dependants whatever the plan order, and may depend on an existing task of the project", async () => {
    const { store, project } = await worldWith(false);
    const existing = await store.task.insert({
      project_id: project.id,
      title: "Choose the stack",
      status: "done",
    });
    const applied = await applyProjectPlan(
      store,
      project,
      {
        tasks: [
          {
            key: "b",
            title: "Second in the plan",
            outcome: "done b",
            dependsOn: ["a", existing.id],
          },
          { key: "a", title: "First in the plan", outcome: "done a" },
        ],
      },
      { humanId: "h1" },
    );
    expect(applied.tasks.map((t) => t.title)).toEqual(["First in the plan", "Second in the plan"]);
    expect(applied.tasks[1]?.depends_on).toEqual([applied.tasks[0]?.id, existing.id]);
    const [first, second] = applied.tasks;
    expect(first && second && first.created_at <= second.created_at).toBe(true);
    await store.close();
  });

  it("refuses an unknown dependency, a cycle, a task of another project and an empty plan, writing nothing", async () => {
    const { store, project } = await worldWith(true);
    const other = await store.project.insert({ name: "Other" });
    const foreign = await store.task.insert({ project_id: other.id, title: "Foreign task" });
    const task = (key: string, dependsOn: string[] = []) => ({
      key,
      title: `Task ${key}`,
      outcome: `done ${key}`,
      dependsOn,
    });
    const unknown = await validationError(
      applyProjectPlan(store, project, { tasks: [task("a", ["nope"])] }, {}),
    );
    expect(unknown.message).toMatch(/nope/);
    const cycle = await validationError(
      applyProjectPlan(store, project, { tasks: [task("a", ["b"]), task("b", ["a"])] }, {}),
    );
    expect(cycle.message).toMatch(/cycle/);
    const elsewhere = await validationError(
      applyProjectPlan(store, project, { tasks: [task("a", [foreign.id])] }, {}),
    );
    expect(elsewhere.message).toMatch(/another project|unknown/);
    await validationError(applyProjectPlan(store, project, { milestones: [], tasks: [] }, {}));
    await validationError(
      applyProjectPlan(store, project, { tasks: [task("dup"), task("dup")] }, {}),
    );
    expect(await store.task.forProject(project.id)).toHaveLength(0);
    expect(await store.milestone.forProject(project.id)).toHaveLength(0);
    await store.close();
  });

  it("caps the plan size in code", async () => {
    const { store, project } = await worldWith(false);
    const tasks = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => ({
      title: `Task number ${i}`,
      outcome: "one more",
    }));
    const err = await validationError(applyProjectPlan(store, project, { tasks }, {}));
    expect(err.message).toMatch(new RegExp(String(MAX_PLAN_TASKS)));
    expect(await store.task.forProject(project.id)).toHaveLength(0);
    const milestones = Array.from({ length: MAX_PLAN_MILESTONES + 1 }, (_, i) => ({
      name: `Phase ${i}`,
      tasks: [{ title: `Task of phase ${i}`, outcome: "one more" }],
    }));
    const over = await validationError(applyProjectPlan(store, project, { milestones }, {}));
    expect(over.message).toMatch(new RegExp(String(MAX_PLAN_MILESTONES)));
    expect(await store.milestone.forProject(project.id)).toHaveLength(0);
    expect(await store.task.forProject(project.id)).toHaveLength(0);
    await store.close();
  });
});

describe("small-project mode: the daemon (B.6)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const createProject = async (name: string, small: boolean): Promise<string> => {
    const created = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name, goal: `Goal of ${name}` }),
    });
    expect(created.status).toBe(201);
    const id = str((await json(created)).id);
    if (small) {
      const row = await rt.store.project.mustGet(id);
      await rt.store.project.update(id, row.version, { small_project_mode: true });
    }
    return id;
  };
  const createTask = (projectId: string, body: Json) =>
    req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Write the readme", outcome: "README explains it", ...body }),
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-small-project-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Hello." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the project card carries the flag and the default tier", async () => {
    const small = await createProject("Tiny", true);
    const normal = await createProject("Atlas", false);
    expect(await json(await req(`/projects/${small}`))).toMatchObject({
      smallProjectMode: true,
      defaultRiskTier: 0,
    });
    expect(await json(await req(`/projects/${normal}`))).toMatchObject({
      smallProjectMode: false,
      defaultRiskTier: 1,
    });
    const cards = await jsonList(await req("/projects"));
    expect(cards.find((c) => c.id === small)?.smallProjectMode).toBe(true);
  });

  it("a task created without a tier gets the project's default; a tier the task names stands", async () => {
    const small = await createProject("Tiny tasks", true);
    const normal = await createProject("Atlas tasks", false);
    expect(await json(await createTask(small, {}))).toMatchObject({ riskTier: 0, status: "ready" });
    expect(await json(await createTask(small, { riskTier: 2 }))).toMatchObject({ riskTier: 2 });
    expect(await json(await createTask(normal, {}))).toMatchObject({ riskTier: 1 });
    expect(await json(await createTask(normal, { riskTier: 0 }))).toMatchObject({ riskTier: 0 });
    // ADR 0025: the daemon reports a validation failure as 409 "conflict" with the cause.
    expect((await createTask(small, { riskTier: 4 })).status).toBe(409);
  });

  it("POST /projects/:id/plan writes one milestone and a flat list for a small project, phases otherwise", async () => {
    const small = await createProject("Tiny plan", true);
    const normal = await createProject("Atlas plan", false);
    const planned = await req(`/projects/${small}/plan`, {
      method: "POST",
      body: JSON.stringify(PLAN),
    });
    expect(planned.status).toBe(201);
    const view = await json(planned);
    expect(view.milestones).toHaveLength(1);
    expect((view.milestones as Json[])[0]).toMatchObject({
      projectId: small,
      name: "Tiny plan",
      successCriteria: ["Repo builds", "Site deployed"],
      targetDate: "2026-12-01",
      status: "planned",
      orderIndex: 0,
    });
    expect(view.reusedMilestone).toBeNull();
    expect(view.merged).toBeNull();
    const tasks = view.tasks as Json[];
    expect(tasks.map((t) => [t.title, t.riskTier])).toEqual([
      ["Scaffold the app", 0],
      ["Add CI", 2],
      ["Deploy the site", 0],
      ["Write the README", 0],
    ]);
    const only = (view.milestones as Json[])[0]?.id;
    expect(tasks.every((t) => t.milestoneId === only)).toBe(true);
    expect(await jsonList(await req(`/projects/${small}/tasks`))).toHaveLength(4);
    expect(await json(await req(`/projects/${small}`))).toMatchObject({
      nextMilestone: { id: only, name: "Tiny plan", targetDate: "2026-12-01" },
    });

    // A later plan joins the one milestone: no new row, the plan's new criterion merged in,
    // the date kept (the plan names none), and the response says what the join added.
    const again = await json(
      await req(`/projects/${small}/plan`, {
        method: "POST",
        body: JSON.stringify({
          milestones: [
            {
              name: "Phase 3",
              successCriteria: ["Site deployed", "Analytics live"],
              tasks: [{ title: "Add analytics", outcome: "Pageviews" }],
            },
          ],
        }),
      }),
    );
    expect(again.milestones).toEqual([]);
    expect(again.reusedMilestone).toMatchObject({
      id: only,
      name: "Tiny plan",
      successCriteria: ["Repo builds", "Site deployed", "Analytics live"],
      targetDate: "2026-12-01",
      version: 2,
    });
    expect(again.merged).toEqual({ successCriteria: ["Analytics live"], targetDate: null });
    expect((again.tasks as Json[]).map((t) => [t.title, t.milestoneId])).toEqual([
      ["Add analytics", only],
    ]);
    const loose = await json(
      await req(`/projects/${small}/plan`, {
        method: "POST",
        body: JSON.stringify({ tasks: [{ title: "Write the FAQ", outcome: "FAQ answers it" }] }),
      }),
    );
    expect(loose.milestones).toEqual([]);
    expect((loose.reusedMilestone as Json).id).toBe(only);
    expect(loose.merged).toBeNull();
    expect(await jsonList(await req(`/projects/${small}/tasks`))).toHaveLength(6);

    const phased = await json(
      await req(`/projects/${normal}/plan`, { method: "POST", body: JSON.stringify(PLAN) }),
    );
    expect((phased.milestones as Json[]).map((m) => [m.name, m.orderIndex])).toEqual([
      ["Phase 1: scaffold", 0],
      ["Phase 2: launch", 1],
    ]);
    expect((phased.tasks as Json[]).map((t) => t.riskTier)).toEqual([1, 2, 1, 1]);
    expect((phased.tasks as Json[]).at(-1)?.milestoneId).toBeNull();
  });

  it("POST /projects/:id/plan refuses a bad plan as 409 conflict (ADR 0025) and writes nothing", async () => {
    const small = await createProject("Tiny refused", true);
    const bad = await req(`/projects/${small}/plan`, {
      method: "POST",
      body: JSON.stringify({
        tasks: [{ title: "Dangling", outcome: "depends on nothing real", dependsOn: ["nope"] }],
      }),
    });
    expect(bad.status).toBe(409);
    expect(await json(bad)).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/nope/),
      details: { cause: "validation" },
    });
    const tooMany = await req(`/projects/${small}/plan`, {
      method: "POST",
      body: JSON.stringify({
        tasks: Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => ({
          title: `Task number ${i}`,
          outcome: "one more",
        })),
      }),
    });
    expect(tooMany.status).toBe(409);
    expect(await json(tooMany)).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(new RegExp(String(MAX_PLAN_TASKS))),
    });
    expect(await jsonList(await req(`/projects/${small}/tasks`))).toHaveLength(0);
    expect((await req("/projects/nope/plan", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
