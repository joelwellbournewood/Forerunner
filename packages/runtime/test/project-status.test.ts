import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PlanState, projectStatusLine } from "../src/daemon/project-status.ts";
import { projectCard, projectSummary } from "../src/daemon/views.ts";
import {
  INTAKE_NEEDS_A_MODEL,
  intakeFailureWords,
  readIntakeReply,
} from "../src/session/intake.ts";

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
    const first = await ask(a);
    expect((await card()).statusLine?.text).toBe(
      'Waiting for you: "Decide where the page is published"',
    );
    await ask(null);
    // Answer opens the oldest card, as Home's Needs you rows do (polish-words, later #55).
    expect((await card()).statusLine).toMatchObject({
      kind: "waiting",
      text: "Waiting for you: 2 questions",
      action: { label: "Answer", to: `/inbox#card-${first.id}` },
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

  it("4. ready work offers Continue only when a Start would start: Connect Claude without a key, nothing under Stop all (later #62, #49)", async () => {
    // Before: "Ready to continue: 1 task ready [Continue]" without a key, and Continue led to a
    // Start dialog whose Start was disabled.
    await task("Create index.html", "ready");
    expect((await card({ sandboxReady: null, hasModel: false })).statusLine).toEqual({
      kind: "ready",
      text: "Ready: 1 task. Claude is not connected.",
      action: { kind: "link", label: "Connect Claude", to: "/setup" },
    });
    // Stop all on: the header's stopped bar has Allow sessions again; the line offers nothing.
    expect((await card({ sandboxReady: null, hasModel: true, stopped: true })).statusLine).toEqual({
      kind: "ready",
      text: "Ready: 1 task. Sessions are stopped.",
      action: null,
    });
    expect((await card({ sandboxReady: null, hasModel: true, stopped: false })).statusLine).toEqual(
      {
        kind: "ready",
        text: "Ready to continue: 1 task ready",
        action: { kind: "start", label: "Continue", to: null },
      },
    );
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
    // The card reads the intake's own words through its facts, and whether Claude is connected.
    expect(
      (
        await card({
          sandboxReady: null,
          plan: async () => ({
            state: "failed",
            error: intakeFailureWords(new ForerunnerError("unavailable", INTAKE_NEEDS_A_MODEL)),
          }),
          hasModel: false,
        })
      ).statusLine,
    ).toEqual({
      kind: "planning_failed",
      text: "Planning failed: Claude is not connected",
      action: { kind: "link", label: "Connect Claude", to: "/setup" },
    });
  });

  /**
   * Review of fix/progress-navigation: Home read "Planning failed: Planning from the brief needs
   * a Claude key or subscription. Add one in the app: Settings → Accounts and keys → Open the
   * setup assistant, then retry." (about 170 characters, the error in full) with no button, and
   * "You rejected the plan. Nothing was written." with none either. Design §2 item 5, §3.3,
   * §5.1: a short sentence (80 characters at most) and the one button that unblocks it. Fed
   * with what the intake really records (`intakeFailureWords`), not a made-up error.
   */
  it("5. planning failed: a short reason and the one button that unblocks it; a rejected plan offers a new one", () => {
    const line = (planError: string | null, hasModel: boolean | null, plan: PlanState = "failed") =>
      projectStatusLine({
        projectId: "p1",
        tasks: [],
        displays: new Map(),
        cards: [],
        plan,
        planError,
        hasModel,
        working: null,
        folder: null,
      });
    const noKey = intakeFailureWords(new ForerunnerError("unavailable", INTAKE_NEEDS_A_MODEL));
    expect(noKey).toContain("needs a Claude key or subscription");
    // No Claude now: Try again cannot work (the retry route refuses), so the button connects it.
    expect(line(noKey, false)).toEqual({
      kind: "planning_failed",
      text: "Planning failed: Claude is not connected",
      action: { kind: "link", label: "Connect Claude", to: "/setup" },
    });
    // Connected since: what happened then, and Try again drafts the plan now.
    expect(line(noKey, true)).toEqual({
      kind: "planning_failed",
      text: "Planning failed: Claude was not connected",
      action: { kind: "retry", label: "Try again", to: null },
    });
    // Whatever went wrong while Claude is connected: a short reason and Try again.
    const provider = (providerCode: string) =>
      new ForerunnerError("provider_error", "the planning call ended error: model call failed", {
        details: { providerCode },
      });
    const refused = (reply: string): unknown => {
      try {
        readIntakeReply(reply);
      } catch (e) {
        if (e instanceof ForerunnerError) e.details.retried = true;
        return e;
      }
      throw new Error(`the intake read ${reply} as a plan`);
    };
    const cases: [unknown, string][] = [
      [provider("provider_error"), "Planning failed: Claude did not answer"],
      [provider("rate_limited"), "Planning failed: Claude was busy"],
      [provider("network"), "Planning failed: Claude could not be reached"],
      [new ForerunnerError("timeout", "planning timed out"), "Planning failed: it took too long"],
      // The intake asked twice before it gave up (fix/intake-live's words end with that).
      [
        new ForerunnerError("timeout", "planning timed out", { details: { retried: true } }),
        "Planning failed: it took too long",
      ],
      [
        new ForerunnerError("budget_exceeded", "over budget"),
        "Planning failed: it used up its budget",
      ],
      [new ForerunnerError("killed", "stopped"), "Planning failed: it was stopped"],
      // The reader's own errors for a reply that is no plan and a plan without its tasks, as
      // the intake throws them after its one retry (fix/intake-live words them).
      [
        refused("Here is the plan you asked for."),
        "Planning failed: Claude's answer was not a plan",
      ],
      [refused("{}"), "Planning failed: Claude's answer was not a plan"],
      [refused('{"plan":{}}'), "Planning failed: Claude's plan was incomplete"],
    ];
    for (const [error, text] of cases)
      expect(line(intakeFailureWords(error), true)).toEqual({
        kind: "planning_failed",
        text,
        action: { kind: "retry", label: "Try again", to: null },
      });
    // An error nobody worded: its first sentence, cut at a word to stay within 80 characters.
    const long = line(
      intakeFailureWords(
        new Error(
          `The repository host answered something nobody expected while the plan was being saved ${"and more ".repeat(20)}. Second sentence.`,
        ),
      ),
      null,
    );
    expect(long.text.length).toBeLessThanOrEqual(80);
    expect(long.text).toMatch(/^Planning failed: The repository host answered .*…$/);
    expect(long.text).not.toContain("Second sentence");
    expect(long.action).toEqual({ kind: "retry", label: "Try again", to: null });
    // No reason recorded at all.
    expect(line(null, true).text).toBe("Planning failed");
    // Design §3.3: "You rejected the plan. Nothing was written. [Draft a new plan]".
    expect(line(null, true, "rejected")).toEqual({
      kind: "planning_failed",
      text: "You rejected the plan. Nothing was written.",
      action: { kind: "retry", label: "Draft a new plan", to: null },
    });
    expect(line(null, false, "rejected").action).toEqual({
      kind: "link",
      label: "Connect Claude",
      to: "/setup",
    });
    for (const l of [line(noKey, false), line(noKey, true), line(null, true, "rejected")])
      expect(l.text.length).toBeLessThanOrEqual(80);
  });

  it("6. every task done: 'Done: all 3 tasks.' with Open your files; the path stays on the card (cancelled ones not counted)", async () => {
    await task("Create index.html", "done");
    await task("Style the page", "done");
    await task("Write the README", "done");
    await task("An idea dropped", "cancelled");
    const c = await card();
    // polish-words (later #53, #54): the path, with the project's id in it, is not in the
    // sentence; the Overview's Your files shows it (`folder`).
    expect(c.statusLine).toMatchObject({
      kind: "done",
      text: "Done: all 3 tasks.",
      action: { kind: "link", label: "Open your files" },
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
