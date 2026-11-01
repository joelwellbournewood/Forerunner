import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectStatusLine } from "../src/daemon/project-status.ts";
import { projectCard, projectSummary } from "../src/daemon/views.ts";

/**
 * The project's status sentence (design §2 "Project status"): one sentence replaces the stage,
 * health, status and autonomy badges on the header, the Overview and Home. Before, the header
 * read "planning · good · active · autonomy: Standard (level 2)" while a session worked, and
 * "Stage planning" with "Next steps: Nothing planned" once every task was done (walk
 * first-project, words-and-structure). First match wins; each rule is one case here.
 */
describe("project status sentence (design §2)", () => {
  let store: StateStore;
  let human = "";
  let agent = "";
  let project = "";

  beforeEach(async () => {
    const clock = new SimulatedClock("2026-11-01T09:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    human = (
      await store.human.insert({
        name: "Robin",
        email: "robin@example.test",
        timezone: "Europe/Zurich",
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: 150_000_000,
        locale: "en",
      })
    ).id;
    agent = (
      await store.agent.insert({
        name: "Alice",
        owner_human_id: human,
        model_config: {},
        memory_location: "local",
        status: "active",
        kind: "principal",
      })
    ).id;
    project = (
      await store.project.insert({
        name: "Quote page",
        goal: "A page that shows a random quote",
        repos: [],
        stage: "planning",
        status: "active",
        budget_usd_micro: 0,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: {},
        small_project_mode: true,
        active: true,
      })
    ).id;
  });
  afterEach(async () => {
    await store.close();
  });

  const task = async (
    title: string,
    status: TaskRow["status"],
    extra: { depends_on?: string[]; risk_tier?: number } = {},
  ) =>
    (
      await store.task.insert({
        project_id: project,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: extra.risk_tier ?? 1,
        status,
        budget_usd_micro: 1_000_000,
        depends_on: extra.depends_on ?? [],
        reason: status === "failed" ? "Claude did not answer (model call failed)" : "seed",
        author_agent: agent,
      })
    ).id;
  const card = (
    facts: Parameters<typeof projectCard>[4] = { sandboxReady: true, folder: () => "/work/quote" },
  ) => projectCard(store, project, 0.8, human, facts);

  it("1. a plan waiting for approval comes first: 'Waiting for you: approve the plan'", async () => {
    const c = await card({
      sandboxReady: true,
      plan: async () => ({ state: "pending", error: null }),
      folder: () => null,
    });
    expect(c.statusLine).toEqual({
      kind: "waiting",
      text: "Waiting for you: approve the plan",
      action: { kind: "link", label: "Open", to: "/inbox" },
    });
  });

  it("1. an open card names its task; two read 'Waiting for you: 2 questions'", async () => {
    const a = await task("Decide where the page is published", "needs_human");
    await task("Write the README", "ready");
    const ask = (taskId: string | null) =>
      store.humanRequest.insert({
        human_id: human,
        project_id: project,
        task_id: taskId,
        kind: "decision",
        why: "Where is it published?",
        steps: [],
        options: ["Locally"],
        blocking: true,
        risk: "low",
        change_card: null,
        author_agent: agent,
      });
    await ask(a);
    expect((await card()).statusLine?.text).toBe(
      'Waiting for you: "Decide where the page is published"',
    );
    await ask(null);
    expect((await card()).statusLine).toMatchObject({
      kind: "waiting",
      text: "Waiting for you: 2 questions",
      action: { label: "Answer", to: "/inbox" },
    });
  });

  it("2. while a session works: 'Working on \"X\" (n of m done)' with Open running session", async () => {
    await task("Create the page skeleton in index.html", "done");
    const running = await task("Show a random quote on every load", "in_progress");
    await task("Style the page", "ready");
    const s = await store.session.insert({
      agent_id: agent,
      project_id: project,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 200,
      spent_usd_micro: 0,
      steps: 0,
      status: "running",
      summary: "",
      handoff: {},
      runner: "pc",
      author_agent: agent,
    });
    await store.event.append(s.id, "task.started", {
      taskId: running,
      title: "Show a random quote on every load",
      specialist: "coder",
    });
    const c = await card();
    expect(c.statusLine).toEqual({
      kind: "working",
      text: 'Working on "Show a random quote on every load" (1 of 3 done)',
      action: { kind: "link", label: "Open running session", to: `/sessions/${s.id}` },
    });
    expect(c.working).toMatchObject({
      sessionId: s.id,
      agentName: "Alice",
      taskId: running,
      taskTitle: "Show a random quote on every load",
    });
    expect(c.progress).toEqual({ done: 1, total: 3 });
  });

  it("the session that drafts the plan is not 'working': the project reads Drafting the plan… (bench walk)", async () => {
    await store.session.insert({
      agent_id: agent,
      project_id: project,
      trigger: "manual",
      plan: { intake: { project_id: project, deadline: "2026-11-01T10:00:00Z" } },
      budget_cap_usd_micro: 1_000_000,
      step_cap: 4,
      spent_usd_micro: 0,
      steps: 0,
      status: "running",
      summary: "intake: Quote page",
      reason: "intake of Quote page",
      handoff: {},
      runner: "pc",
      author_agent: agent,
    });
    const c = await card({
      sandboxReady: null,
      plan: async () => ({ state: "drafting", error: null }),
    });
    expect(c.working).toBeNull();
    expect(c.statusLine).toEqual({ kind: "planning", text: "Drafting the plan…", action: null });
  });

  it("3. a failed task that others wait on: 'Stuck: \"X\" failed; 2 tasks wait on it'", async () => {
    const failed = await task("Style the page", "failed");
    await task("Check every file loads", "ready", { depends_on: [failed] });
    await task("Write the README", "ready", { depends_on: [failed] });
    expect((await card()).statusLine).toMatchObject({
      kind: "stuck",
      text: 'Stuck: "Style the page" failed; 2 tasks wait on it',
      action: { label: "Open Tasks" },
    });
  });

  it("3. a full-review task without Docker: 'Waiting for Docker: 1 task'", async () => {
    await task("Check every file loads", "ready", { risk_tier: 2 });
    expect((await card({ sandboxReady: false, folder: () => null })).statusLine).toMatchObject({
      kind: "docker",
      text: "Waiting for Docker: 1 task",
      action: { label: "Set up Docker", to: "/settings#sandbox" },
    });
  });

  it("4. tasks that can run: 'Ready to continue: 2 tasks ready' with Continue", async () => {
    const first = await task("Create index.html", "ready");
    await task("Write the README", "ready");
    await task("Style the page", "ready", { depends_on: [first] });
    expect((await card()).statusLine).toEqual({
      kind: "ready",
      text: "Ready to continue: 2 tasks ready",
      action: { kind: "start", label: "Continue", to: null },
    });
  });

  it("5. the plan being drafted, or failed in words", async () => {
    expect(
      (
        await card({
          sandboxReady: null,
          plan: async () => ({ state: "drafting", error: null }),
        })
      ).statusLine,
    ).toEqual({ kind: "planning", text: "Drafting the plan…", action: null });
    expect(
      (
        await card({
          sandboxReady: null,
          plan: async () => ({ state: "failed", error: "Claude is not connected." }),
        })
      ).statusLine?.text,
    ).toBe("Planning failed: Claude is not connected.");
  });

  it("6. every task done: 'Done: all 3 tasks. Your files: <path>' (cancelled ones not counted)", async () => {
    await task("Create index.html", "done");
    await task("Style the page", "done");
    await task("Write the README", "done");
    await task("An idea dropped", "cancelled");
    const c = await card();
    expect(c.statusLine).toMatchObject({
      kind: "done",
      text: "Done: all 3 tasks. Your files: /work/quote",
    });
    expect(c.progress).toEqual({ done: 3, total: 3 });
    expect(c.folder).toBe("/work/quote");
  });

  it("writes no raw states, ids or zero counts, within 80 characters but for the path", () => {
    const line = projectStatusLine({
      projectId: "p1",
      tasks: [{ id: "a", title: "x".repeat(200), status: "in_progress", depends_on: [] }],
      displays: new Map(),
      cards: [],
      plan: null,
      working: {
        sessionId: "s1",
        agentName: "Alice",
        taskId: "a",
        taskTitle: "x".repeat(200),
        since: null,
      },
      folder: null,
    });
    expect(line.text.length).toBeLessThanOrEqual(80);
    expect(line.text).not.toMatch(/in_progress|needs_human|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("the Overview's Next is computed when read: open tasks in run order with their status words", async () => {
    const first = await task("Create index.html", "ready");
    await task("Style the page", "ready", { depends_on: [first] });
    await task("Write the README", "ready", { depends_on: [first] });
    await task("Check every file loads", "draft");
    await task("Old work", "done");
    const s = await projectSummary(store, project, 0.8, { sandboxReady: true });
    expect(s.next).toEqual([
      '"Create index.html": Ready',
      '"Style the page": Waiting for "Create index.html"',
      '"Write the README": Waiting for "Create index.html"',
      "and 1 more",
    ]);
  });
});
