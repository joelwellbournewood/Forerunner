import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type QueueItemRow, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import type { MemoryPort } from "../src/loop/ports.ts";
import {
  type Planner,
  QUEUE_CONSUMED_AUDIT_TOOL,
  SessionRunner,
  type SessionRunnerDeps,
  StaticPlanner,
  type TaskExecutor,
} from "../src/session/runner.ts";

/**
 * The next-session queue through the runner (spec J.2): the notes a session's brief carries
 * are consumed by that session, exactly those, once, with an audit row; what the human
 * leaves after the brief was built waits for the next session. Without the consume step the
 * same notes would be fed into every later session.
 */
interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  project: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-03-02T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (
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
  const alice = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
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
      settings: { members: [alice] },
      small_project_mode: false,
      active: true,
    })
  ).id;
  return { store, clock, human, alice, project };
}

/** These sessions plan no tasks; the executor must never be reached. */
const neverRuns: TaskExecutor = {
  async execute() {
    throw new Error("no task should run in a queue test");
  },
};

function runner(w: World, over: Partial<SessionRunnerDeps> = {}): SessionRunner {
  return new SessionRunner({
    store: w.store,
    clock: w.clock,
    tokens: new TokenIssuer({ now: () => w.clock.now() }),
    kill: new KillSwitch(),
    planner: new StaticPlanner(),
    executor: neverRuns,
    ...over,
  });
}

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

function leave(
  w: World,
  text: string,
  priority: number,
  kind: QueueItemRow["kind"] = "note",
): Promise<QueueItemRow> {
  return w.store.queue.enqueue({
    project_id: w.project,
    human_id: w.human,
    kind,
    text,
    priority,
  });
}

interface Captured {
  type: string;
  payload: Record<string, unknown>;
}

async function start(w: World, r: SessionRunner, events: Captured[] = []) {
  const res = await r.start({
    agentId: w.alice,
    projectId: w.project,
    trigger: "manual",
    budgetCapUsdMicro: 5_000_000,
    grant,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  await w.clock.advance(60_000);
  return res;
}

async function consumedAudit(w: World, sessionId: string) {
  return w.store.auditLog.list({ sessionId, tool: QUEUE_CONSUMED_AUDIT_TOOL });
}

/**
 * A store whose next inbox read fails once (the checklist's), so the session fails before
 * its brief exists; the session end's own inbox read works again.
 */
function storeWithInboxFailingOnce(w: World): StateStore {
  let failed = false;
  const message = new Proxy(w.store.message, {
    get(target, prop, receiver) {
      if (prop === "inbox" && !failed)
        return async () => {
          failed = true;
          throw new ForerunnerError("internal", "state store unavailable");
        };
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...w.store, message };
}

describe("session runner: next-session queue", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("briefs and consumes only its own human's notes; a co-worker's note on the same project stays queued", async () => {
    const mine = await leave(w, "check the CSV export", 3);
    const other = (
      await w.store.human.insert({
        name: "M",
        email: "m@example.test",
        timezone: "Europe/Zurich",
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: 150_000_000,
        locale: "en",
      })
    ).id;
    const theirs = await w.store.queue.enqueue({
      project_id: w.project,
      human_id: other,
      kind: "note",
      text: "rotate the staging key",
      priority: 9,
    });
    const briefs: string[] = [];
    const planner: Planner = {
      async plan(ctx) {
        briefs.push(ctx.briefText);
        return new StaticPlanner().plan(ctx);
      },
    };
    const first = await start(w, runner(w, { planner }));
    expect(first.status).toBe("completed");
    expect(first.brief.queue.count).toBe(1);
    expect(first.brief.queue.items.map((i) => i.id)).toEqual([mine.id]);
    expect(briefs[0]).toContain(mine.text);
    expect(briefs[0]).not.toContain(theirs.text);
    expect(await w.store.queue.mustGet(mine.id)).toMatchObject({
      status: "consumed",
      consumed_by_session: first.sessionId,
    });
    expect(await w.store.queue.mustGet(theirs.id)).toMatchObject({
      status: "queued",
      consumed_by_session: null,
    });
    expect(await w.store.queue.pending(w.project, { humanId: other })).toHaveLength(1);
  });

  it("consumes exactly the items its brief listed; a note left during the session waits for the next one", async () => {
    const fix = await leave(w, "fix the flaky clock test first", 9, "correction");
    const idea = await leave(w, "try the new renderer on the sample page", 5, "idea");
    const task = await leave(w, "write the changelog for 0.2", 1, "task");
    const briefs: string[] = [];
    let late: QueueItemRow | undefined;
    const planner: Planner = {
      async plan(ctx) {
        briefs.push(ctx.briefText);
        // The human leaves a note while the first session plans: after its brief was built.
        if (!late) late = await leave(w, "rename the billing module", 7);
        return new StaticPlanner().plan(ctx);
      },
    };
    const r = runner(w, { planner });

    const events: Captured[] = [];
    const first = await start(w, r, events);
    expect(first.status).toBe("completed");
    expect(first.brief.queue.count).toBe(3);
    expect(first.brief.queue.items.map((i) => i.id)).toEqual([fix.id, idea.id, task.id]);
    expect(first.brief.queue.items[0]).toMatchObject({
      id: fix.id,
      version: 1,
      kind: "correction",
    });
    for (const text of [fix.text, idea.text, task.text]) expect(briefs[0]).toContain(text);
    expect(briefs[0]).not.toContain("rename the billing module");

    // Exactly those three are consumed by this session; the late one stays queued.
    for (const q of [fix, idea, task]) {
      const row = await w.store.queue.mustGet(q.id);
      expect(row).toMatchObject({ status: "consumed", consumed_by_session: first.sessionId });
      expect(row.version).toBe(2);
    }
    if (!late) throw new Error("the planner did not leave the late note");
    expect(await w.store.queue.mustGet(late.id)).toMatchObject({
      status: "queued",
      consumed_by_session: null,
    });

    // One audit row per batch: ids and the session, never the text.
    const audit = await consumedAudit(w, first.sessionId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ agent_id: w.alice, human_id: w.human, allowed: true });
    expect(JSON.parse(audit[0]?.input_summary ?? "")).toEqual({
      sessionId: first.sessionId,
      items: [fix.id, idea.id, task.id],
    });
    expect(JSON.parse(audit[0]?.result_summary ?? "")).toEqual({
      consumed: [fix.id, idea.id, task.id],
      skipped: [],
    });
    for (const text of [fix.text, idea.text, task.text]) {
      expect(audit[0]?.input_summary).not.toContain(text);
      expect(audit[0]?.result_summary).not.toContain(text);
    }

    // The event, after the brief and before the plan, live and in the session log.
    const types = events.map((e) => e.type);
    expect(types.indexOf("queue.consumed")).toBeGreaterThan(types.indexOf("session.brief"));
    expect(types.indexOf("queue.consumed")).toBeLessThan(types.indexOf("session.planned"));
    expect(events.find((e) => e.type === "queue.consumed")?.payload).toMatchObject({
      ids: [fix.id, idea.id, task.id],
      count: 3,
      skipped: [],
    });
    const log = await w.store.event.list(first.sessionId);
    expect(log.find((e) => e.type === "queue.consumed")?.payload).toMatchObject({ count: 3 });

    // The second session sees only the late note, and consumes it.
    const second = await start(w, r);
    expect(second.status).toBe("completed");
    expect(second.brief.queue.count).toBe(1);
    expect(second.brief.queue.items.map((i) => i.id)).toEqual([late.id]);
    expect(briefs[1]).toContain("rename the billing module");
    for (const text of [fix.text, idea.text, task.text]) expect(briefs[1]).not.toContain(text);
    expect(await w.store.queue.mustGet(late.id)).toMatchObject({
      status: "consumed",
      consumed_by_session: second.sessionId,
    });
    for (const q of [fix, idea, task]) {
      const row = await w.store.queue.mustGet(q.id);
      expect(row.consumed_by_session).toBe(first.sessionId);
      expect(row.version).toBe(2);
    }
    expect(JSON.parse((await consumedAudit(w, second.sessionId))[0]?.input_summary ?? "")).toEqual({
      sessionId: second.sessionId,
      items: [late.id],
    });
  });

  it("never consumes a dismissed item, and leaves an item that moved while the checklist ran", async () => {
    const kept = await leave(w, "keep the sample service green", 5);
    const gone = await leave(w, "dismissed before the session", 9);
    await w.store.queue.dismiss(gone.id, gone.version);
    const dismissedDuring = await leave(w, "dismissed while the checklist ran", 8);
    const editedDuring = await leave(w, "edited while the checklist ran", 7);
    // The memory port runs after the checklist read the queue and before the consume step:
    // the human acts in the UI in that window.
    const memory: MemoryPort = {
      async recall() {
        await w.store.queue.dismiss(dismissedDuring.id, dismissedDuring.version);
        await w.store.queue.patch(editedDuring.id, { text: "edited while the checklist ran (v2)" });
        return { block: "", tokens: 0, lessonIds: [], denied: [], warnings: [] };
      },
      async record() {
        return { recorded: 0, merged: 0, rejected: [] };
      },
    };

    const events: Captured[] = [];
    const res = await start(w, runner(w, { memory }), events);
    expect(res.status).toBe("completed");
    expect(res.brief.queue.items.map((i) => i.id)).toEqual([
      dismissedDuring.id,
      editedDuring.id,
      kept.id,
    ]);

    expect(await w.store.queue.mustGet(kept.id)).toMatchObject({
      status: "consumed",
      consumed_by_session: res.sessionId,
    });
    expect(await w.store.queue.mustGet(gone.id)).toMatchObject({
      status: "dismissed",
      consumed_by_session: null,
    });
    expect(await w.store.queue.mustGet(dismissedDuring.id)).toMatchObject({
      status: "dismissed",
      consumed_by_session: null,
    });
    expect(await w.store.queue.mustGet(editedDuring.id)).toMatchObject({
      status: "queued",
      consumed_by_session: null,
      text: "edited while the checklist ran (v2)",
      version: 2,
    });

    const audit = await consumedAudit(w, res.sessionId);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.result_summary ?? "")).toEqual({
      consumed: [kept.id],
      skipped: [
        { id: dismissedDuring.id, reason: "validation" },
        { id: editedDuring.id, reason: "version_conflict" },
      ],
    });
    const consumed = events.find((e) => e.type === "queue.consumed");
    expect(consumed?.payload).toMatchObject({ ids: [kept.id], count: 1 });
    expect(consumed?.payload.warning).toContain("2 queue item(s)");

    // The edited note is fed once more, with its new text, to the next session.
    const next = await start(w, runner(w), []);
    expect(next.brief.queue.items.map((i) => i.text)).toEqual([
      "edited while the checklist ran (v2)",
    ]);
    expect(await w.store.queue.mustGet(editedDuring.id)).toMatchObject({
      status: "consumed",
      consumed_by_session: next.sessionId,
    });
  });

  it("a session that fails before its brief is written consumes nothing", async () => {
    const note = await leave(w, "still waiting", 5);
    const events: Captured[] = [];
    const res = await start(w, runner(w, { store: storeWithInboxFailingOnce(w) }), events);
    expect(res.status).toBe("failed");
    expect(events.map((e) => e.type)).toContain("session.error");
    expect(events.map((e) => e.type)).not.toContain("session.brief");
    expect(events.map((e) => e.type)).not.toContain("queue.consumed");
    expect(await w.store.queue.mustGet(note.id)).toMatchObject({
      status: "queued",
      consumed_by_session: null,
      version: 1,
    });
    expect(await consumedAudit(w, res.sessionId)).toEqual([]);

    // The next session, on a working store, gets the note.
    const next = await start(w, runner(w), []);
    expect(next.brief.queue.items.map((i) => i.id)).toEqual([note.id]);
    expect((await w.store.queue.mustGet(note.id)).consumed_by_session).toBe(next.sessionId);
  });

  it("a session without queue items writes no queue audit row and no event", async () => {
    const events: Captured[] = [];
    const res = await start(w, runner(w), events);
    expect(res.status).toBe("completed");
    expect(res.brief.queue.items).toEqual([]);
    expect(events.map((e) => e.type)).not.toContain("queue.consumed");
    expect(await consumedAudit(w, res.sessionId)).toEqual([]);
  });
});
