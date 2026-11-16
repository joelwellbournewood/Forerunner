import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CALIBRATION_WHAT,
  calibrationExplain,
  emptyRunFold,
  foldRunEvents,
  RUN_TEXT_MAX,
  runText,
  runViews,
  runWhat,
  startOfferOf,
  stopChoices,
} from "../src/daemon/run-indicator.ts";

/**
 * d1109-run-visible V-1 (D8, the owner, 2026-11-09: "it should at least be very clear to a user
 * when a run is ongoing. That should also be very visually clear no matter where the person
 * is."): one run state in the daemon's words, read by the header's bar, Home, the Overview, Talk,
 * the Sessions list, the tray and the window title. Each word function's exact sentence; at most
 * 80 characters (design §5 rule 1); no id, no USD.
 */
describe("the run indicator's words (V-1)", () => {
  const P = "Quote page";
  it("says what the session does now, the project first", () => {
    expect(runText({ projectName: P, state: "planning" })).toBe("Quote page · plans the session");
    expect(
      runText({
        projectName: P,
        state: "working",
        taskTitle: "Style the page",
        specialist: "coder",
      }),
    ).toBe('Quote page · the coder works on "Style the page"');
    expect(
      runText({
        projectName: P,
        state: "working",
        taskTitle: "Write the notes",
        specialist: "writer-marketing",
      }),
    ).toBe('Quote page · the writer works on "Write the notes"');
    expect(runText({ projectName: P, state: "reviewing", taskTitle: "Style the page" })).toBe(
      'Quote page · the critic checks "Style the page"',
    );
    expect(runText({ projectName: P, state: "between" })).toBe("Quote page · picks the next task");
    expect(runText({ projectName: P, state: "wrapping", taskTitle: "Style the page" })).toBe(
      'Quote page · wraps up "Style the page" at its budget',
    );
    expect(runText({ projectName: P, state: "stopping", taskTitle: "B" })).toBe(
      'Quote page · stops after "B"',
    );
    expect(runText({ projectName: P, state: "stopping" })).toBe(
      "Quote page · stops after this task",
    );
  });

  it("names a person start of another project that waits behind it", () => {
    expect(
      runText({
        projectName: P,
        state: "working",
        taskTitle: "A",
        specialist: "coder",
        nextProject: "Garden site",
      }),
    ).toBe('Quote page · the coder works on "A" · then Garden site');
  });

  it("says the critic's monthly check, and in its open form what it is for, on either credential", () => {
    expect(runText({ projectName: "Forerunner", state: "calibrating" })).toBe(
      "Forerunner · the critic's monthly check on known examples",
    );
    expect(CALIBRATION_WHAT).toBe("the critic's monthly check on known examples");
    expect(calibrationExplain({ budgetChfMicro: 8_000_000, onPlan: false })).toBe(
      "Once a month the critic reviews examples whose right answers are known, so you see whether it still catches mistakes; it spends at most CHF 8.00 a month of its own budget.",
    );
    expect(calibrationExplain({ budgetChfMicro: 8_000_000, onPlan: true })).toBe(
      "Once a month the critic reviews examples whose right answers are known, so you see whether it still catches mistakes; it runs on your Claude plan, within CHF 8.00 a month at API prices.",
    );
    for (const onPlan of [true, false]) {
      const s = calibrationExplain({ budgetChfMicro: 8_000_000, onPlan });
      expect(s).not.toMatch(/verdict|USD|\$/i);
    }
  });

  it("says when a person's waiting session goes on, in each form", () => {
    expect(
      runText({ projectName: P, state: "waiting", wait: { kind: "limit", at: "15:40" } }),
    ).toBe("Quote page · waiting until 15:40, then it goes on");
    expect(
      runText({ projectName: P, state: "waiting", wait: { kind: "quiet", at: "07:00" } }),
    ).toBe("Quote page · waiting until 07:00 (after your quiet hours), then it goes on");
    expect(
      runText({
        projectName: P,
        state: "waiting",
        wait: { kind: "refused", what: "a new API key" },
      }),
    ).toBe("Quote page · waiting for a new API key, then it goes on");
    expect(runText({ projectName: P, state: "waiting", wait: { kind: "other" } })).toBe(
      "Quote page · waiting for Claude, then it goes on",
    );
  });

  it("keeps every sentence within 80 characters, shortening the title at a word", () => {
    const long =
      "Write the long introduction section that explains the whole history of the quote page";
    const s = runText({
      projectName: P,
      state: "working",
      taskTitle: long,
      specialist: "writer",
      nextProject: "Garden site with a very long name indeed",
    });
    expect(s.length).toBeLessThanOrEqual(RUN_TEXT_MAX);
    expect(RUN_TEXT_MAX).toBe(80);
    expect(s).toMatch(/^Quote page · the writer works on "Write the long[^"]*…" · then Garden/);
    expect(s).not.toMatch(/ [a-z]+…" · then Garden site with a very long name indeed$/);
    const project = "A project whose name is far longer than anyone would ever want to read";
    const p = runText({ projectName: project, state: "between" });
    expect(p.length).toBeLessThanOrEqual(80);
    expect(p.endsWith(" · picks the next task")).toBe(true);
  });

  it("offers Stop after this task, Stop now and Stop all while work runs; a waiting session none", () => {
    for (const state of ["planning", "working", "reviewing", "between", "wrapping"] as const)
      expect(stopChoices(state)).toEqual(["after", "now", "all"]);
    expect(stopChoices("stopping")).toEqual(["now", "all"]);
    expect(stopChoices("calibrating")).toEqual(["now", "all"]);
    expect(stopChoices("waiting")).toEqual([]);
    expect(runWhat({ state: "between" })).toBe("picks the next task");
  });
});

describe("the run fold: what a session does now, from its log (V-1)", () => {
  const at = (seq: number, type: string, payload: Record<string, unknown> = {}) => ({
    seq,
    type,
    payload,
  });
  it("follows a session from planning to a task, its review and the next pick", () => {
    let f = foldRunEvents(emptyRunFold(), [at(1, "session.started", { trigger: "manual" })]);
    expect(f.phase).toBe("planning");
    f = foldRunEvents(f, [at(2, "session.planned"), at(3, "session.promised")]);
    expect(f.phase).toBe("between");
    f = foldRunEvents(f, [
      at(4, "task.started", { taskId: "t1", title: "A", specialist: "coder" }),
    ]);
    expect(f).toMatchObject({ phase: "working", taskTitle: "A", specialist: "coder", afterSeq: 4 });
    f = foldRunEvents(f, [
      at(5, "task.step", { taskId: "t1", text: "Told the coder to wrap up: it spent ..." }),
    ]);
    expect(f.phase).toBe("wrapping");
    f = foldRunEvents(f, [at(6, "task.finished", { taskId: "t1", title: "A", review: true })]);
    expect(f).toMatchObject({ phase: "reviewing", taskTitle: "A" });
    f = foldRunEvents(f, [at(7, "critic.review_started", { taskId: "t1" })]);
    expect(f).toMatchObject({ phase: "reviewing", taskTitle: "A" });
    f = foldRunEvents(f, [at(8, "critic.verdict", { taskId: "t1" })]);
    expect(f).toMatchObject({ phase: "between", taskTitle: null });
    f = foldRunEvents(f, [
      at(9, "task.started", { taskId: "t2", title: "B", specialist: "coder" }),
    ]);
    f = foldRunEvents(f, [at(10, "task.finished", { taskId: "t2", title: "B" })]);
    expect(f.phase).toBe("between");
    // A review-only run (the review waited for room): the critic checks it again.
    f = foldRunEvents(f, [at(11, "critic.review_resumed", { taskId: "t1" })]);
    expect(f).toMatchObject({ phase: "reviewing", taskTitle: "A" });
    // An event already folded changes nothing.
    expect(foldRunEvents(f, [at(3, "task.started", { taskId: "x", title: "X" })])).toEqual(f);
  });
});

/**
 * The views from the store: the sessions that run now (not the conversation, not a plan being
 * drafted), the critic's calibration, a person start waiting behind another project's session,
 * and a person's session waiting to go on after its credential wait. A kept person start and a
 * held hands-off start are said on their project, never here.
 */
describe("runViews (V-1)", () => {
  let store: StateStore;
  let agent = "";
  let critic = "";
  let quote = "";
  let garden = "";
  const clock = new SimulatedClock("2026-11-16T09:00:00Z");

  beforeEach(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    const human = (
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
    const agentOf = async (name: string, kind: "principal" | "critic") =>
      (
        await store.agent.insert({
          name,
          owner_human_id: human,
          model_config: {},
          memory_location: "local",
          status: "active",
          kind,
        } as never)
      ).id;
    agent = await agentOf("Alice", "principal");
    critic = await agentOf("Critic", "critic");
    const projectOf = async (name: string) =>
      (
        await store.project.insert({
          name,
          goal: name,
          repos: [],
          stage: "planning",
          status: "active",
          budget_usd_micro: 0,
          autonomy_level: 2,
          summary_cache: {},
          data_assets: [],
          settings: {},
        } as never)
      ).id;
    quote = await projectOf("Quote page");
    garden = await projectOf("Garden site");
  });
  afterEach(async () => {
    await store.close();
  });

  const session = async (over: Record<string, unknown>) => {
    const row = await store.session.insert({
      agent_id: agent,
      project_id: quote,
      trigger: "manual",
      plan: { items: [] },
      reason: "a test session",
      budget_cap_usd_micro: 5_000_000,
      step_cap: 200,
      spent_usd_micro: 0,
      steps: 0,
      status: "running",
      summary: "",
      handoff: {},
      runner: "pc",
      started_at: clock.nowIso(),
      author_agent: agent,
      ...over,
    } as never);
    return row;
  };
  const deps = (over: Partial<Parameters<typeof runViews>[0]> = {}) => ({
    store,
    criticAgentId: critic,
    folds: new Map(),
    pendingPersonStarts: () => [],
    waitingContinuations: async () => [],
    calibration: async () => ({ budgetChfMicro: 8_000_000, onPlan: false }),
    ...over,
  });

  it("is empty when nothing runs, and for the conversation and a plan being drafted", async () => {
    expect(await runViews(deps())).toEqual([]);
    await session({ summary: "conversation" });
    await session({ plan: { intake: { brief: "x" } } });
    expect(await runViews(deps())).toEqual([]);
  });

  it("reads a working session's task from its log, with Stop after this task, Stop now and Stop all", async () => {
    const s = await session({});
    await store.event.append(s.id, "session.started", {} as never, 0);
    await store.event.append(s.id, "session.planned", {} as never, 0);
    await store.event.append(
      s.id,
      "task.started",
      { taskId: "t1", title: "Style the page", specialist: "coder" } as never,
      0,
    );
    const [v, ...more] = await runViews(deps());
    expect(more).toEqual([]);
    expect(v).toEqual({
      key: s.id,
      sessionId: s.id,
      projectId: quote,
      projectName: "Quote page",
      state: "working",
      what: 'the coder works on "Style the page"',
      text: 'Quote page · the coder works on "Style the page"',
      since: s.started_at,
      stop: ["after", "now", "all"],
      cancel: false,
      nextProject: null,
      explain: null,
    });
    // Stop after this task: the row is paused until the task in flight ends.
    const row = await store.session.mustGet(s.id);
    await store.session.update(s.id, row.version, { status: "paused" } as never);
    const [p] = await runViews(deps());
    expect(p).toMatchObject({
      state: "stopping",
      text: 'Quote page · stops after "Style the page"',
      stop: ["now", "all"],
    });
  });

  it("adds a person start of another project waiting behind it", async () => {
    const s = await session({});
    await store.event.append(s.id, "session.started", {} as never, 0);
    const [v] = await runViews(
      deps({
        pendingPersonStarts: () => [
          { agentId: agent, projectId: garden },
          { agentId: agent, projectId: quote },
        ],
      }),
    );
    expect(v).toMatchObject({
      text: "Quote page · plans the session · then Garden site",
      nextProject: "Garden site",
    });
  });

  it("shows the critic's monthly check with Stop now and Stop all and what it is for", async () => {
    const s = await session({
      agent_id: critic,
      project_id: null,
      trigger: "schedule",
      plan: { items: [], summary: "critic calibration over 12 eval task(s)" },
    });
    const [v] = await runViews(
      deps({ calibration: async () => ({ budgetChfMicro: 8_000_000, onPlan: true }) }),
    );
    expect(v).toMatchObject({
      key: s.id,
      sessionId: s.id,
      projectId: null,
      projectName: "Forerunner",
      state: "calibrating",
      text: "Forerunner · the critic's monthly check on known examples",
      stop: ["now", "all"],
      cancel: false,
      explain:
        "Once a month the critic reviews examples whose right answers are known, so you see whether it still catches mistakes; it runs on your Claude plan, within CHF 8.00 a month at API prices.",
    });
  });

  it("shows a person's session waiting to go on, with Cancel and no Stop, only while none of its project runs", async () => {
    const waiting = async () => [
      {
        projectId: quote,
        sessionId: "s-earlier",
        since: "2026-11-16T08:30:00.000Z",
        wait: { kind: "limit" as const, at: "15:40" },
      },
    ];
    expect(await runViews(deps({ waitingContinuations: waiting }))).toEqual([
      {
        key: `wait:${quote}`,
        sessionId: "s-earlier",
        projectId: quote,
        projectName: "Quote page",
        state: "waiting",
        what: "waiting until 15:40, then it goes on",
        text: "Quote page · waiting until 15:40, then it goes on",
        since: "2026-11-16T08:30:00.000Z",
        stop: [],
        cancel: true,
        nextProject: null,
        explain: null,
      },
    ]);
    const s = await session({});
    await store.event.append(s.id, "session.started", {} as never, 0);
    const views = await runViews(deps({ waitingContinuations: waiting }));
    expect(views.map((v) => v.state)).toEqual(["planning"]);
  });

  it("names no id and no USD in any view", async () => {
    const s = await session({});
    await store.event.append(
      s.id,
      "task.started",
      { taskId: "t1", title: "A", specialist: "coder" } as never,
      0,
    );
    for (const v of await runViews(deps())) {
      expect(v.text).not.toContain(s.id);
      expect(v.text).not.toMatch(/USD|\$/);
    }
  });
});

/**
 * d1109-run-visible V-6: which answered cards' Done lines offer Start (the answer readied work
 * for the person's next Start); the Inbox hides it while a session of the project runs.
 */
describe("the Done line's Start (V-6)", () => {
  it("offers it after an answer readied work for the next Start, and only then", () => {
    for (const start of ["waits_start", "stopping", "failed"])
      expect(startOfferOf({ start }, "answered", "p1"), start).toBe(true);
    for (const start of ["joined", "no_room", "waits_continuation", "stopped_all", "started"])
      expect(startOfferOf({ start }, "answered", "p1"), start).toBe(false);
    for (const start of ["queued", "deferred", "nothing_to_run", undefined])
      expect(startOfferOf({ start }, "answered", "p1"), String(start)).toBe(false);
  });
  it("never for an open card, a card with no project, or a start the hands-off setting made", () => {
    expect(startOfferOf({ start: "waits_start" }, "open", "p1")).toBe(false);
    expect(startOfferOf({ start: "waits_start" }, "answered", null)).toBe(false);
    expect(startOfferOf({ start: "failed", start_by: "hands_off" }, "answered", "p1")).toBe(false);
    expect(startOfferOf(null, "answered", "p1")).toBe(false);
  });
});
