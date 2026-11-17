import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunningView } from "../src/daemon/api-types.ts";
import {
  CALIBRATION_WHAT,
  calibrationExplain,
  emptyRunFold,
  foldRunEvents,
  RUN_TEXT_MAX,
  resultAfterWait,
  runFoldsOf,
  runningHealth,
  runText,
  runViews,
  runWhat,
  sessionRunText,
  startOfferOf,
  stopChoices,
} from "../src/daemon/run-indicator.ts";
import { dropKeptStart } from "../src/wiring/billing-pick.ts";

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

  // Review of d1109-run-visible (blocking 1): the Sessions list's working row read only the newest
  // 50 events of the fold's types, task.step among them (one per tool call), so a task past about
  // 49 steps lost its task.started and the row said 'plans the session' while the bar said the
  // coder works on it. The row folds the whole log, as the bar does, and says the same sentence.
  it("says in the Sessions list's working row what the bar says, however many steps the task took", async () => {
    const s = await session({});
    await store.event.append(s.id, "session.started", {} as never, 0);
    await store.event.append(s.id, "session.planned", {} as never, 0);
    await store.event.append(
      s.id,
      "task.started",
      { taskId: "t1", title: "Style the page", specialist: "coder" } as never,
      0,
    );
    const row = await store.session.mustGet(s.id);
    expect(await sessionRunText(store, row, critic)).toBe(
      'Quote page · the coder works on "Style the page"',
    );
    for (let i = 0; i < 60; i += 1)
      await store.event.append(
        s.id,
        "task.step",
        { taskId: "t1", text: `Ran step ${i}` } as never,
        0,
      );
    const working = 'Quote page · the coder works on "Style the page"';
    expect(await sessionRunText(store, row, critic)).toBe(working);
    expect((await runViews(deps()))[0]?.text).toBe(working);
    // The wrap-up line stays said after many more steps.
    await store.event.append(
      s.id,
      "task.step",
      { taskId: "t1", text: "Told the coder to wrap up: it spent CHF 0.40 of CHF 0.50." } as never,
      0,
    );
    for (let i = 0; i < 60; i += 1)
      await store.event.append(
        s.id,
        "task.step",
        { taskId: "t1", text: `Ran more ${i}` } as never,
        0,
      );
    const wrapping = 'Quote page · wraps up "Style the page" at its budget';
    expect(await sessionRunText(store, row, critic)).toBe(wrapping);
    expect((await runViews(deps()))[0]?.text).toBe(wrapping);
    // A row read with no fold kept (a fresh daemon, the list read first) folds the whole log too.
    runFoldsOf(store).clear();
    expect(await sessionRunText(store, row, critic)).toBe(wrapping);
  });

  // C3-left-8 (the review of d1109-run-visible, blocking 3): a stored result's "then your session
  // goes on" is read as it holds now, wherever it shows (the session page, the Overview, Read
  // aloud, the Inbox's Update line).
  const PROMISE = "Waits until 15:40 (your subscription's limit); then your session goes on.";
  const AFTER = "Waits until 15:40 (your subscription's limit); then it runs at your next Start.";
  const keepWait = async (kept: Record<string, unknown> | null, since: string) => {
    const human = (await store.agent.mustGet(agent)).owner_human_id;
    await store.billingSource.insert({
      human_id: human,
      kind: "subscription",
      label: "Max plan",
      credential_ref: "anthropic_subscription_token",
      limits: { waiting: [{ projectId: quote, agentId: agent, since, ...(kept ? { kept } : {}) }] },
      enabled: true,
      priority: 1,
    } as never);
  };

  it("keeps a result's 'then your session goes on' while it is kept and once it went on; else says it runs at the next Start", async () => {
    const ended = await session({ status: "stopped", ended_at: clock.nowIso() });
    const since = clock.nowIso();
    await keepWait({ by: "continuation", continues: ended.id, at: since }, since);
    expect(await resultAfterWait(store, quote, since, PROMISE)).toBe(PROMISE);
    // A line with no promise is never changed; nor one with no project.
    expect(await resultAfterWait(store, quote, since, "Done: 2 tasks.")).toBe("Done: 2 tasks.");
    expect(await resultAfterWait(store, null, since, PROMISE)).toBe(PROMISE);
    // Cancel (or Stop all): nothing is kept, nothing went on.
    expect(await dropKeptStart(store, quote)).toBe(true);
    expect(await resultAfterWait(store, quote, since, PROMISE)).toBe(AFTER);
    // A session the continuation started after it: it went on by itself, the words were true.
    clock.advance(60_000);
    await session({
      status: "completed",
      plan: { items: [], startedBy: { by: "continuation", continues: ended.id } },
    });
    expect(await resultAfterWait(store, quote, since, PROMISE)).toBe(PROMISE);
  });

  it("says it runs at the next Start once the person started a session instead, even while a later wait is kept", async () => {
    const ended = await session({ status: "stopped", ended_at: clock.nowIso() });
    const since = clock.nowIso();
    clock.advance(60_000);
    // The person's own Start after Cancel; it too stopped to wait, and its continuation is kept.
    const next = await session({
      status: "stopped",
      plan: { items: [], startedBy: { by: "person" } },
    });
    await keepWait({ by: "continuation", continues: next.id, at: clock.nowIso() }, since);
    expect(await resultAfterWait(store, quote, since, PROMISE)).toBe(AFTER);
    expect(ended.id).not.toBe(next.id);
  });
});

/**
 * `/health.running` (the desktop's tray and window title): a project's running session first,
 * then the critic's monthly check (marked `check`, so the title names it instead of
 * "Forerunner — Forerunner is working"), then a session that only waits.
 */
describe("runningHealth (V-7)", () => {
  const view = (over: Partial<RunningView>): RunningView => ({
    key: "k",
    sessionId: "s",
    projectId: "p",
    projectName: "Quote page",
    state: "working",
    what: 'the coder works on "A"',
    text: 'Quote page · the coder works on "A"',
    since: null,
    stop: ["after", "now", "all"],
    cancel: false,
    nextProject: null,
    explain: null,
    ...over,
  });
  const check = view({
    key: "c",
    projectId: null,
    projectName: "Forerunner",
    state: "calibrating",
    what: CALIBRATION_WHAT,
    text: `Forerunner · ${CALIBRATION_WHAT}`,
  });
  const waits = view({
    key: "w",
    state: "waiting",
    what: "waiting until 15:40, then it goes on",
    text: "Quote page · waiting until 15:40, then it goes on",
  });
  it("names a project's running session before the monthly check and a waiting session", () => {
    expect(runningHealth([check, waits, view({})])).toEqual({
      projectName: "Quote page",
      what: 'the coder works on "A"',
      text: 'Quote page · the coder works on "A"',
      waiting: false,
    });
  });
  it("marks the monthly check, before a session that only waits", () => {
    expect(runningHealth([waits, check])).toEqual({
      projectName: "Forerunner",
      what: CALIBRATION_WHAT,
      text: `Forerunner · ${CALIBRATION_WHAT}`,
      waiting: false,
      check: true,
    });
    expect(runningHealth([waits])).toMatchObject({ waiting: true });
    expect(runningHealth([waits])).not.toHaveProperty("check");
    expect(runningHealth([])).toBeNull();
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

/**
 * CS-7 (d1109-cred-screens, run C; D8, the owner: "it should at least be very clear to a user when
 * a run is ongoing", and 7a: "allow the task to be completed by the API, but in a transparent
 * way"): the indicator says when the running task is on the credential the person's choice puts
 * second (' on your API key'), when a task of the running session waits for the person's answer
 * on the one ask card (' · 1 task waits for your answer' with Answer), and a waiting session's
 * share and key-month stops in their own forms (never the generic 'waiting for Claude'), with
 * Change the allowance for the share and Answer while the ask card is open. Before, none of it.
 */
describe("d1109-cred-screens, run C: the indicator's credential words (CS-7)", () => {
  it("the fragment, the question and the month's stops, each within 80 characters", () => {
    expect(
      runText({
        projectName: "Quote page",
        state: "working",
        taskTitle: "Style the page",
        specialist: "coder",
        on: "api_key",
      }),
    ).toBe('Quote page · the coder works on "Style the page" on your API key');
    expect(
      runText({
        projectName: "Quote page",
        state: "working",
        taskTitle: "Style the page",
        specialist: "coder",
        on: "subscription",
      }),
    ).toBe('Quote page · the coder works on "Style the page" on your subscription');
    expect(
      runText({
        projectName: "Quote page",
        state: "working",
        taskTitle: "B",
        specialist: "coder",
        asking: 1,
      }),
    ).toBe('Quote page · the coder works on "B" · 1 task waits for your answer');
    expect(runText({ projectName: "Quote page", state: "between", asking: 2 })).toBe(
      "Quote page · picks the next task · 2 tasks wait for your answer",
    );
    expect(
      runText({
        projectName: "Quote page",
        state: "waiting",
        wait: { kind: "share", at: "Tue 1 Dec, 01:00" },
      }),
    ).toBe("Quote page · waiting until Tue 1 Dec, 01:00, then it goes on");
    expect(
      runText({
        projectName: "Quote page",
        state: "waiting",
        wait: { kind: "key_month", at: "Tue 1 Dec, 01:00" },
      }),
    ).toBe(
      "Quote page · waiting until Tue 1 Dec, 01:00 (your API key's monthly cap), then it goes on",
    );
    // A long title is shortened at a word so the sentence keeps within 80 characters.
    const long = runText({
      projectName: "Quote page",
      state: "working",
      taskTitle: "Style the page so every quote reads well on a phone and on a desktop screen",
      specialist: "coder",
      on: "api_key",
      asking: 1,
    });
    expect(long.length).toBeLessThanOrEqual(RUN_TEXT_MAX);
    // With the question too, the question keeps its place and the fragment goes first.
    expect(long).toMatch(
      /^Quote page · the coder works on "Style the page.*" · 1 task waits for your answer$/,
    );
    expect(long).not.toContain("on your API key");
  });

  it("the fold reads the switch of the running task and drops it at the next task or the back line", () => {
    const at = (seq: number, type: string, payload: Record<string, unknown> = {}) => ({
      seq,
      type,
      payload,
    });
    let f = foldRunEvents(emptyRunFold(), [
      at(1, "session.started"),
      at(2, "task.started", { taskId: "a", title: "Style the page", specialist: "coder" }),
      at(3, "billing.switch", { taskId: "a", to: "api_key", from: "subscription" }),
    ]);
    expect(f.on).toBe("api_key");
    f = foldRunEvents(f, [
      at(4, "task.finished", { taskId: "a" }),
      at(5, "task.started", { taskId: "b", title: "Write the copy", specialist: "writer" }),
    ]);
    expect(f.on).toBeNull();
    f = foldRunEvents(f, [at(6, "billing.switch", { taskId: "b", to: "api_key", repeat: true })]);
    expect(f.on).toBe("api_key");
    f = foldRunEvents(f, [at(7, "billing.back", { from: "api_key", to: "subscription" })]);
    expect(f.on).toBeNull();
    // Another task's switch line does not move the running task.
    f = foldRunEvents(f, [at(8, "billing.switch", { taskId: "a", to: "api_key" })]);
    expect(f.on).toBeNull();
  });

  describe("runViews", () => {
    let store: StateStore;
    let agent = "";
    let quote = "";
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
      agent = (
        await store.agent.insert({
          name: "Alice",
          owner_human_id: human,
          model_config: {},
          memory_location: "local",
          status: "active",
          kind: "principal",
        } as never)
      ).id;
      quote = (
        await store.project.insert({
          name: "Quote page",
          goal: "Quote page",
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
    });
    afterEach(async () => {
      await store.close();
    });
    const deps = (over: Partial<Parameters<typeof runViews>[0]> = {}) => ({
      store,
      criticAgentId: null,
      folds: new Map(),
      pendingPersonStarts: () => [],
      waitingContinuations: async () => [],
      calibration: async () => ({ budgetChfMicro: 8_000_000, onPlan: false }),
      ...over,
    });
    const running = async () => {
      const s = await store.session.insert({
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
      } as never);
      await store.event.append(s.id, "session.started", {} as never, 0);
      await store.event.append(
        s.id,
        "task.started",
        { taskId: "t1", title: "Style the page", specialist: "coder" } as never,
        0,
      );
      return s;
    };

    it("a running task on the API key says so; a task waiting on the ask card adds the question with Answer", async () => {
      const s = await running();
      await store.event.append(
        s.id,
        "billing.switch",
        { taskId: "t1", from: "subscription", to: "api_key", stopKey: "limit:x" } as never,
        0,
      );
      const [v] = await runViews(deps());
      expect(v?.text).toBe('Quote page · the coder works on "Style the page" on your API key');
      expect(v?.links).toBeUndefined();
      const asking = async (projectId: string) =>
        projectId === quote ? { count: 1, to: "/inbox#card-ask1" } : null;
      const [w] = await runViews(deps({ askWaiting: asking }));
      // Both would be 95 characters: the question keeps its place, the fragment goes.
      expect(w?.text).toBe(
        'Quote page · the coder works on "Style the page" · 1 task waits for your answer',
      );
      expect(w?.text.length).toBeLessThanOrEqual(RUN_TEXT_MAX);
      expect(w?.links).toEqual([{ label: "Answer", to: "/inbox#card-ask1" }]);
      expect(w?.stop).toEqual(["after", "now", "all"]);
    });

    it("a waiting session on the share reads its time with Change the allowance; on a key's monthly cap its own form; with the ask card open, Answer", async () => {
      const waiting =
        (wait: RunningWaitArg, extra: Record<string, unknown> = {}) =>
        async () => [
          {
            projectId: quote,
            sessionId: "s-earlier",
            since: "2026-11-16T08:30:00.000Z",
            wait,
            ...extra,
          },
        ];
      const [share] = await runViews(
        deps({ waitingContinuations: waiting({ kind: "share", at: "Tue 1 Dec, 01:00" }) }),
      );
      expect(share).toMatchObject({
        state: "waiting",
        text: "Quote page · waiting until Tue 1 Dec, 01:00, then it goes on",
        cancel: true,
        stop: [],
        links: [{ label: "Change the allowance", to: "/settings#plan-allowance" }],
      });
      const [month] = await runViews(
        deps({ waitingContinuations: waiting({ kind: "key_month", at: "Tue 1 Dec, 01:00" }) }),
      );
      expect(month?.text).toBe(
        "Quote page · waiting until Tue 1 Dec, 01:00 (your API key's monthly cap), then it goes on",
      );
      expect(month?.links).toBeUndefined();
      const [ask] = await runViews(
        deps({
          waitingContinuations: waiting(
            { kind: "limit", at: "15:40" },
            { answer: "/inbox#card-ask1" },
          ),
        }),
      );
      expect(ask).toMatchObject({
        text: "Quote page · waiting until 15:40, then it goes on",
        cancel: true,
        links: [{ label: "Answer", to: "/inbox#card-ask1" }],
      });
    });
  });
});

type RunningWaitArg = Parameters<typeof runText>[0]["wait"] & object;
