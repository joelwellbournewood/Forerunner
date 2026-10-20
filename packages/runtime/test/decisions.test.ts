import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionLog } from "../src/wiring/state-ports.ts";

describe("decision log (spec J)", () => {
  let store: StateStore;
  let human: string;
  let project: string;
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
        monthly_cap_usd_micro: 1_000_000,
        locale: "en",
      })
    ).id;
    project = (
      await store.project.insert({
        name: "P",
        goal: "Goal of the project",
        repos: [],
        stage: "build",
        status: "active",
        budget_usd_micro: 1_000_000,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: {},
        small_project_mode: false,
        active: true,
      })
    ).id;
  });
  afterEach(() => store.close());

  const question = "Which database should the sample service use?";
  const ask = (log: DecisionLog, why = question) =>
    log.ask({
      human_id: human,
      project_id: project,
      kind: "decision",
      why,
      steps: [],
      options: ["Postgres", "SQLite"],
      blocking: true,
      risk: "low",
    });

  it("asks once, records the answer, and never asks the same question again until superseded", async () => {
    const log = new DecisionLog(store);
    const first = await ask(log);
    expect(first.request?.status).toBe("open");
    expect(first.decision).toBeNull();
    // Not answered yet: a second ask opens nothing new but has no decision either? It must not
    // open a duplicate while the first is open is the inbox's job; here the human answers first.
    const answered = await store.humanRequest.answer(
      (first.request as { id: string }).id,
      (first.request as { version: number }).version,
      "Postgres",
      human,
    );
    const decision = await log.recordAnswer(answered, human, "ops knows it");
    expect(decision).toMatchObject({ question, chosen: "Postgres", decided_by: human });
    const again = await ask(log, "which database should the sample service use");
    expect(again.request).toBeNull();
    expect(again.decision?.id).toBe(decision?.id);
    expect(await store.humanRequest.count({ project_id: project } as never)).toBe(1);

    // A different answer to the same question supersedes the old decision.
    const second = await store.humanRequest.insert({
      human_id: human,
      project_id: project,
      kind: "decision",
      why: question,
      steps: [],
      options: ["Postgres", "SQLite"],
      blocking: true,
      risk: "low",
    });
    const answered2 = await store.humanRequest.answer(second.id, second.version, "SQLite", human);
    const newer = await log.recordAnswer(answered2, human);
    expect(newer?.supersedes).toBe(decision?.id);
    expect((await store.decision.mustGet(decision?.id as string)).superseded_by).toBe(newer?.id);
    const current = await log.current(project);
    expect(current).toHaveLength(1);
    expect(current[0]?.chosen).toBe("SQLite");
    expect((await ask(log)).decision?.chosen).toBe("SQLite");
  });

  it("records nothing for approvals or unanswered requests", async () => {
    const log = new DecisionLog(store);
    const approval = await store.humanRequest.insert({
      human_id: human,
      project_id: project,
      kind: "approval",
      why: "Deploy to staging?",
      steps: [],
      options: ["yes", "no"],
      blocking: true,
      risk: "medium",
    });
    const answered = await store.humanRequest.answer(approval.id, approval.version, "yes", human);
    expect(await log.recordAnswer(answered, human)).toBeNull();
    const open = await ask(log);
    expect(await log.recordAnswer(open.request as never, human)).toBeNull();
    expect(await log.current(project)).toEqual([]);
  });
});
