import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectCard } from "../src/daemon/views.ts";

/**
 * The project card's state (U-071): "blocked" was shown whenever a task needed the human or any
 * request was open, although nothing waited in the Inbox. Now "blocked" means an open blocking
 * request or a needs-human task with its card, and "needs you" names the task of an open card
 * only (design §3.8), so it agrees with "Waiting on you"; a task left without a card wants
 * attention.
 */
describe("project card state (U-071)", () => {
  let store: StateStore;
  let human = "";
  let agent = "";
  let project = "";

  beforeEach(async () => {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    human = (
      await store.human.insert({
        name: "J",
        email: "j@example.test",
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
        name: "Sample",
        goal: "Ship a sample service",
        repos: [],
        stage: "build",
        status: "active",
        budget_usd_micro: 50_000_000,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: {},
        small_project_mode: false,
        active: true,
      })
    ).id;
  });
  afterEach(async () => {
    await store.close();
  });

  const task = async (title: string, status: "ready" | "needs_human") =>
    (
      await store.task.insert({
        project_id: project,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 1,
        status,
        budget_usd_micro: 1_000_000,
        reason: "seed",
        author_agent: agent,
      })
    ).id;
  const request = (blocking: boolean, taskId: string | null = null) =>
    store.humanRequest.insert({
      human_id: human,
      project_id: project,
      task_id: taskId,
      kind: "decision",
      why: "Pick the hosting",
      steps: [],
      options: ["Fly", "Render"],
      blocking,
      risk: "low",
      change_card: null,
      author_agent: agent,
    });
  const card = () => projectCard(store, project, 0.8, human);

  it("a task an agent left needing you without an Inbox card wants attention; only a card is 'needs you' (design §3.8)", async () => {
    await task("Write the README", "ready");
    await task("Confirm the stack", "needs_human");
    const c = await card();
    expect(c.health).toBe("attention");
    // Nothing in the Inbox: not "needs you", so it never stands beside "Waiting on you 0".
    expect(c.needsYou).toBeNull();
    expect(c.waitingOnYou).toBe(0);
  });

  it("is blocked while the needs-you task has its card open, and the card names it", async () => {
    const id = await task("Confirm the stack", "needs_human");
    await request(false, id);
    const c = await card();
    expect(c.health).toBe("blocked");
    expect(c.needsYou).toEqual({ taskId: id, title: "Confirm the stack" });
    expect(c.waitingOnYou).toBe(1);
  });

  it("is blocked by an open blocking request, and only noted for a non-blocking one", async () => {
    await task("Write the README", "ready");
    const quiet = await request(false);
    expect((await card()).health).toBe("attention");
    await store.humanRequest.answer(quiet.id, quiet.version, "Fly", human);
    expect((await card()).health).toBe("good");
    await request(true);
    expect((await card()).health).toBe("blocked");
  });
});
