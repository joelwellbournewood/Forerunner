import type { TaskRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  CommandExecutor,
  defaultRegistry,
  type ExecuteResult,
  toToolSpecs,
} from "../src/index.ts";
import { RATE, type World, world } from "./helpers.ts";

/**
 * d1109-selftasks-run, run C (ADR 0119; D7, the owner, 2026-11-09: "if I say set this up and I
 * approve a plan and then it adds a bunch of tasks, I want it to be able to fix its tasks. Like
 * as part of a run, it should be able to do things like that."; confirmed: "the agent changes
 * its own tasks, the autonomy level deciding when it asks first", "each change shown with one
 * Undo"). The commands the session's task check and chat's "fix the tasks" use, through the
 * executor with the bodies a session sends: a split, a step before a task, a duplicate dropped;
 * each with its change log row, its sentence and a state-based Undo that works after a restart
 * (a fresh executor on the same store, as undo.test.ts restarts).
 */

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}
function refusedReason(r: ExecuteResult): string {
  if (r.status !== "refused") throw new Error(`expected refused, got ${r.status}`);
  return r.reason;
}

const usdOfChf = (chf: number) => Math.round((chf / RATE) * 1_000_000);

/** A session of the project that runs now: its log receives the change lines. */
async function runningSession(w: World) {
  const s = await w.store.session.insert({
    agent_id: w.agent.id,
    project_id: w.pharma.id,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 3_000_000,
    step_cap: 200,
    spent_usd_micro: 0,
    steps: 0,
    started_at: w.clock.nowIso(),
    status: "planned",
    summary: "",
    handoff: {},
    runner: "pc",
  });
  return w.store.session.start(s.id, s.version);
}

/** The context the session's task check runs a change in: the agent, source 'session'. */
function sessionCtx(w: World, sessionId: string, over: Partial<CommandContext> = {}) {
  return w.ctx({
    actor: { kind: "agent", id: w.agent.id },
    source: "session",
    sessionId,
    activeProjectId: w.pharma.id,
    planFix: { level: 2 },
    ...over,
  });
}

async function seed(w: World, title: string, over: Partial<TaskRow> = {}) {
  return w.store.task.insert({
    project_id: w.pharma.id,
    title,
    outcome: `${title} is done`,
    acceptance_criteria: ["it works"],
    risk_tier: 1,
    status: "ready",
    priority: 5,
    reason: "planned",
    author_agent: w.agent.id,
    ...over,
  });
}

/** A restart: a fresh executor on the same store (nothing of the first one's memory). */
function restarted(w: World): CommandExecutor {
  const registry = defaultRegistry();
  return new CommandExecutor({ registry, store: w.store, clock: w.clock });
}

describe("d1109-selftasks-run, run C: the agent's own changes through the executor (ST-5)", () => {
  it("a change with source 'session' is one Changes row with Undo, a 'change' line in its session and no Inbox message; its Undo works after a restart", async () => {
    const w = await world();
    const s = await runningSession(w);
    const task = await seed(w, "Write README");
    const r = done(
      await w.executor.execute({
        name: "task.update",
        params: { task: task.id, title: "Write the README" },
        ctx: sessionCtx(w, s.id),
      }),
    );
    const row = await w.store.changeLog.mustGet(r.changeLogId);
    expect(row).toMatchObject({
      source: "session",
      undo_state: "undoable",
      author_agent: w.agent.id,
    });
    expect(r.undoToken).toBe(r.changeLogId);
    expect((await w.executor.undoable(w.human.id, w.pharma.id)).map((x) => x.id)).toContain(row.id);
    const lines = (await w.store.event.list(s.id)).filter((e) => e.type === "change");
    expect(lines.map((e) => e.payload)).toEqual([
      expect.objectContaining({ changeLogId: r.changeLogId, sentence: r.sentence }),
    ]);
    // Design §3.8: one Update per session, never one Inbox line per change.
    expect(await w.store.message.inbox({ humanId: w.human.id })).toEqual([]);
    const fresh = restarted(w);
    const u = done(await fresh.undo(r.changeLogId, w.ctx({ source: "ui" })));
    expect(u.sentence).toBe('Undone: "Write README" is as it was.');
    expect((await w.store.task.mustGet(task.id)).title).toBe("Write README");
    await w.store.close();
  });

  it("a planFix context at Standard acts at once from chat (no read-back, no Inbox line); at Assisted it is read back", async () => {
    const w = await world();
    const task = await seed(w, "Write README");
    const chatAgent = (level: 0 | 1 | 2 | 3 | 4) =>
      w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat", planFix: { level } });
    const r = done(
      await w.executor.execute({
        name: "task.update",
        params: { task: task.id, title: "Write the README" },
        ctx: chatAgent(2),
      }),
    );
    expect(r.sentence).toBe('Changed "Write README": the title to "Write the README".');
    expect(await w.store.message.inbox({ humanId: w.human.id })).toEqual([]);
    for (const level of [0, 1] as const) {
      const p = await w.executor.execute({
        name: "task.update",
        params: { task: task.id, priority: "high" },
        ctx: chatAgent(level),
      });
      expect(p.status).toBe("pending");
    }
    await w.store.close();
  });

  it("a turn that read a record reads the agent's fix back whatever the level (recordsRead wins over planFix)", async () => {
    const w = await world();
    const task = await seed(w, "Write README");
    const p = await w.executor.execute({
      name: "task.update",
      params: { task: task.id, title: "Write the README" },
      ctx: w.ctx({
        actor: { kind: "agent", id: w.agent.id },
        source: "chat",
        planFix: { level: 4 },
        recordsRead: true,
      }),
    });
    expect(p.status).toBe("pending");
    await w.store.close();
  });

  it("planFix named in a call's params changes nothing: the change is read back as before (only the runtime sets it)", async () => {
    const w = await world();
    const task = await seed(w, "Write README");
    const p = await w.executor.execute({
      name: "task.update",
      params: { task: task.id, title: "Write the README", planFix: { level: 4 } },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect(p.status).toBe("pending");
    // The registry's schema drops a field it does not know: nothing of it is stored.
    expect(JSON.stringify(await w.store.humanRequest.list())).not.toContain("planFix");
    await w.store.close();
  });

  it("task.split is no tool of the chat's model (d1109-selftasks-chat adds chat's own)", () => {
    const specs = toToolSpecs(defaultRegistry(), {
      execute: async () => ({ status: "done", sentence: "ok" }),
      ctxFor: () => {
        throw new Error("unused");
      },
    });
    expect(specs.map((s) => s.name)).not.toContain("task_split");
    expect(specs.map((s) => s.name)).toContain("task_create");
  });
});

describe("d1109-selftasks-run, run C: task.split (ST-2)", () => {
  /** "Style the page" (a, b, c; own budget CHF 1.00, CHF 0.20 spent), "Publish" waits for it. */
  async function splitWorld() {
    const w = await world();
    const s = await runningSession(w);
    const style = await seed(w, "Style the page", {
      acceptance_criteria: ["a", "b", "c"],
      budget_usd_micro: usdOfChf(1),
      actual_cost_usd_micro: usdOfChf(0.2),
      est_cost_usd_micro: 600_000,
      branch: "fr/style-the-page",
      specialist: "coder",
    });
    const publish = await seed(w, "Publish", { depends_on: [style.id] });
    return { w, s, style, publish };
  }
  const splitParams = (task: string) => ({
    task,
    parts: [
      { title: "Style the layout", acceptance_criteria: ["a", "b"] },
      { title: "Style the colours", acceptance_criteria: ["c"] },
    ],
    order: "in_turn" as const,
  });

  it("keeps the task as its first part, adds the rest waiting for it, makes the tasks after it wait for both and shares its budget", async () => {
    const { w, s, style, publish } = await splitWorld();
    const r = done(
      await w.executor.execute({
        name: "task.split",
        params: splitParams("Style the page"),
        ctx: sessionCtx(w, s.id),
      }),
    );
    expect(r.sentence).toBe(
      'Split "Style the page" into "Style the layout" and "Style the colours".',
    );
    const first = await w.store.task.mustGet(style.id);
    expect(first).toMatchObject({
      title: "Style the layout",
      acceptance_criteria: ["a", "b"],
      branch: "fr/style-the-page",
      status: "ready",
    });
    const tasks = await w.store.task.forProject(w.pharma.id);
    const colours = tasks.find((t) => t.title === "Style the colours") as TaskRow;
    expect(colours).toMatchObject({
      acceptance_criteria: ["c"],
      depends_on: [style.id],
      status: "ready",
      specialist: "coder",
      risk_tier: 1,
    });
    expect((await w.store.task.mustGet(publish.id)).depends_on.sort()).toEqual(
      [style.id, colours.id].sort(),
    );
    // The budget is shared, never raised: what the parts have left adds up to what the task had
    // left (CHF 0.80), and their budgets to its CHF 1.00.
    const left = (t: TaskRow) => t.budget_usd_micro - t.actual_cost_usd_micro;
    expect(left(first) + left(colours)).toBe(usdOfChf(0.8));
    expect(first.budget_usd_micro + colours.budget_usd_micro).toBe(usdOfChf(1));
    expect(first.est_cost_usd_micro + colours.est_cost_usd_micro).toBe(600_000);
    await w.store.close();
  });

  it("is refused in words for a running, in-review, failed, done or cancelled task, for parts that leave out a criterion, and for one part", async () => {
    const { w, s } = await splitWorld();
    for (const status of ["in_progress", "in_review", "failed", "done", "cancelled"] as const) {
      const t = await seed(w, `Task ${status}`, { status, acceptance_criteria: ["a", "b", "c"] });
      const reason = refusedReason(
        await w.executor.execute({
          name: "task.split",
          params: splitParams(t.id),
          ctx: sessionCtx(w, s.id),
        }),
      );
      expect(reason).toMatch(new RegExp(`^"Task ${status}" is .+, so it is not split\\.$`));
    }
    expect(
      refusedReason(
        await w.executor.execute({
          name: "task.split",
          params: {
            task: "Style the page",
            parts: [
              { title: "Style the layout", acceptance_criteria: ["a", "b"] },
              { title: "Style the colours", acceptance_criteria: [] },
            ],
          },
          ctx: sessionCtx(w, s.id),
        }),
      ),
    ).toBe('The parts leave out a criterion of "Style the page": "c". Nothing was split.');
    expect(
      refusedReason(
        await w.executor.execute({
          name: "task.split",
          params: {
            task: "Style the page",
            parts: [{ title: "Style the layout", acceptance_criteria: ["a", "b", "c"] }],
          },
          ctx: sessionCtx(w, s.id),
        }),
      ),
    ).toMatch(/two to four parts/);
    await w.store.close();
  });

  it("Undo, also after a restart, puts back the title, outcome, criteria, budget and what the next task waited for, and cancels the new part", async () => {
    const { w, s, style, publish } = await splitWorld();
    const r = done(
      await w.executor.execute({
        name: "task.split",
        params: splitParams("Style the page"),
        ctx: sessionCtx(w, s.id),
      }),
    );
    const colours = (await w.store.task.forProject(w.pharma.id)).find(
      (t) => t.title === "Style the colours",
    ) as TaskRow;
    const u = done(await restarted(w).undo(r.changeLogId, w.ctx({ source: "ui" })));
    expect(u.sentence).toBe('Undone: "Style the page" is one task again.');
    expect(await w.store.task.mustGet(style.id)).toMatchObject({
      title: "Style the page",
      outcome: "Style the page is done",
      acceptance_criteria: ["a", "b", "c"],
      budget_usd_micro: usdOfChf(1),
      est_cost_usd_micro: 600_000,
    });
    expect((await w.store.task.mustGet(publish.id)).depends_on).toEqual([style.id]);
    expect((await w.store.task.mustGet(colours.id)).status).toBe("cancelled");
    await w.store.close();
  });

  it("once the new part ran, the Undo says why it cannot", async () => {
    const { w, s } = await splitWorld();
    const r = done(
      await w.executor.execute({
        name: "task.split",
        params: splitParams("Style the page"),
        ctx: sessionCtx(w, s.id),
      }),
    );
    const colours = (await w.store.task.forProject(w.pharma.id)).find(
      (t) => t.title === "Style the colours",
    ) as TaskRow;
    await w.store.task.transition(colours.id, colours.version, "claimed", "session", {
      agentId: w.agent.id,
    });
    const fresh = restarted(w);
    const row = await w.store.changeLog.mustGet(r.changeLogId);
    expect(await fresh.undoBlockedReason(row, w.ctx({ source: "ui" }))).toBe(
      '"Style the colours" has run since, so the split cannot be undone',
    );
    await w.store.close();
  });
});

describe("d1109-selftasks-run, run C: a step before a task and a dropped duplicate (ST-3)", () => {
  it("task.create with before adds a step before a task; its Undo cancels it and leaves the task waiting for what it waited for before", async () => {
    const w = await world();
    const s = await runningSession(w);
    const page = await seed(w, "Create the page");
    const publish = await seed(w, "Publish", { depends_on: [page.id] });
    const r = done(
      await w.executor.execute({
        name: "task.create",
        params: {
          title: "Check the links",
          outcome: "Every link on the page opens",
          acceptance_criteria: ["no link answers 404"],
          depends_on: ["Create the page"],
          before: ["Publish"],
          specialist: "coder",
        },
        ctx: sessionCtx(w, s.id),
      }),
    );
    expect(r.sentence).toBe('Added "Check the links" before "Publish".');
    const check = (await w.store.task.forProject(w.pharma.id)).find(
      (t) => t.title === "Check the links",
    ) as TaskRow;
    expect(check.depends_on).toEqual([page.id]);
    expect((await w.store.task.mustGet(publish.id)).depends_on.sort()).toEqual(
      [page.id, check.id].sort(),
    );
    const u = done(await restarted(w).undo(r.changeLogId, w.ctx({ source: "ui" })));
    expect(u.sentence).toBe(
      'Undone: cancelled "Check the links"; "Publish" waits for what it waited for before.',
    );
    expect((await w.store.task.mustGet(check.id)).status).toBe("cancelled");
    expect((await w.store.task.mustGet(publish.id)).depends_on).toEqual([page.id]);
    await w.store.close();
  });

  it("a step that would close a cycle is refused and nothing is written", async () => {
    const w = await world();
    const s = await runningSession(w);
    await seed(w, "Publish");
    const before = (await w.store.task.forProject(w.pharma.id)).length;
    const reason = refusedReason(
      await w.executor.execute({
        name: "task.create",
        params: { title: "Check the links", depends_on: ["Publish"], before: ["Publish"] },
        ctx: sessionCtx(w, s.id),
      }),
    );
    expect(reason).toBe(
      '"Check the links" cannot both wait for "Publish" and come before it. Nothing was added.',
    );
    expect((await w.store.task.forProject(w.pharma.id)).length).toBe(before);
    await w.store.close();
  });

  it("task.transition to cancelled with duplicate_of on a task that never ran is low risk and names the task it is the same as; its Undo, after a restart too, reopens it", async () => {
    const w = await world();
    const s = await runningSession(w);
    await seed(w, "Add the README");
    const dup = await seed(w, "Write README", { status: "draft" });
    const r = done(
      await w.executor.execute({
        name: "task.transition",
        params: { task: "Write README", to: "cancelled", duplicate_of: "Add the README" },
        ctx: sessionCtx(w, s.id),
      }),
    );
    expect(r.card.impact.risk).toBe("low");
    expect(r.sentence).toBe('Dropped "Write README": same as "Add the README".');
    expect((await w.store.task.mustGet(dup.id)).status).toBe("cancelled");
    const u = done(await restarted(w).undo(r.changeLogId, w.ctx({ source: "ui" })));
    expect(u.status).toBe("done");
    expect((await w.store.task.mustGet(dup.id)).status).toBe("draft");
    await w.store.close();
  });

  it("a duplicate drop is refused in words when the task ran, or the named task is cancelled or of another project", async () => {
    const w = await world();
    const s = await runningSession(w);
    await seed(w, "Add the README");
    const gone = await seed(w, "Old README", { status: "cancelled" });
    const elsewhere = await w.store.task.insert({
      project_id: w.supplement.id,
      title: "Supplement README",
      outcome: "x",
      acceptance_criteria: [],
      status: "ready",
      reason: "seed",
    });
    const ran = await seed(w, "Write README", { attempt: 1 });
    const drop = (task: string, of: string) =>
      w.executor.execute({
        name: "task.transition",
        params: { task, to: "cancelled", duplicate_of: of },
        ctx: sessionCtx(w, s.id),
      });
    expect(refusedReason(await drop(ran.id, "Add the README"))).toBe(
      '"Write README" has run, so it is not dropped as a duplicate.',
    );
    const fresh = await seed(w, "Write the README");
    expect(refusedReason(await drop(fresh.id, gone.id))).toBe(
      '"Old README" is cancelled, so "Write the README" is not dropped as the same.',
    );
    expect(refusedReason(await drop(fresh.id, "Supplement README"))).toBe(
      'no task matches "Supplement README" in PharmaWatch',
    );
    expect(refusedReason(await drop(fresh.id, elsewhere.id))).toBe(
      '"Supplement README" is not a task of PharmaWatch, so "Write the README" is not dropped as the same.',
    );
    expect((await w.store.task.mustGet(fresh.id)).status).toBe("ready");
    await w.store.close();
  });
});

/**
 * d1116-budget-all, run C (BA-11): the owner's "yes it should count critics reviews, and fixes."
 * A split shares what is left of the task's budget after its work and its reviews: no new
 * mechanism, the task's figure holds both (BA-1).
 */
describe("d1116-budget-all, run C: task.split after a review", () => {
  it("a task of budget 1_000_000 whose figure is 200_000 (work 150_000 and its review 50_000) splits into parts whose shares add up to 800_000; the kept part's budget is its figure plus its share", async () => {
    const w = await world();
    const s = await runningSession(w);
    const style = await seed(w, "Style the page", {
      acceptance_criteria: ["a", "b", "c"],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 600_000,
      specialist: "coder",
    });
    // Its first run and the critic's review, booked to it as BA-1 books them.
    for (const [specialist, usd] of [
      ["coder", 150_000],
      ["critic", 50_000],
    ] as const) {
      await w.store.costLedger.record({
        human_id: w.human.id,
        project_id: w.pharma.id,
        session_id: s.id,
        task_id: style.id,
        kind: "api",
        usd_micro: usd,
        chf_micro: Math.round(usd * RATE),
        rate_chf_per_usd: RATE,
        model: "fake-sonnet",
        specialist,
      });
      await w.store.task.addCost(style.id, usd);
    }
    expect((await w.store.task.mustGet(style.id)).actual_cost_usd_micro).toBe(200_000);
    done(
      await w.executor.execute({
        name: "task.split",
        params: {
          task: "Style the page",
          parts: [
            { title: "Style the layout", acceptance_criteria: ["a", "b"] },
            { title: "Style the colours", acceptance_criteria: ["c"] },
          ],
          order: "in_turn",
        },
        ctx: sessionCtx(w, s.id),
      }),
    );
    const first = await w.store.task.mustGet(style.id);
    const colours = (await w.store.task.forProject(w.pharma.id)).find(
      (t) => t.title === "Style the colours",
    ) as TaskRow;
    // The figure stays on the kept part, never reset; the shares are what is left after it.
    expect(first.actual_cost_usd_micro).toBe(200_000);
    expect(colours.actual_cost_usd_micro).toBe(0);
    const firstShare = first.budget_usd_micro - first.actual_cost_usd_micro;
    expect(firstShare + colours.budget_usd_micro).toBe(800_000);
    expect(first.budget_usd_micro).toBe(200_000 + firstShare);
    await w.store.close();
  });
});
