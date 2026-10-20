import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStateBrief } from "../src/session/brief.ts";
import { runStartupChecklist } from "../src/session/checklist.ts";

/**
 * The checklist's view of the next-session queue (spec J.2): the project's queued items by
 * priority, each with the id and version the runner consumes it at; consumed and dismissed
 * items are not in the brief.
 */
interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  agent: string;
  project: string;
  session: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-03-02T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (await store.human.insert({ name: "J", email: "j@example.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "Sample" })).id;
  const session = (await store.session.insert({ agent_id: agent, project_id: project })).id;
  return { store, clock, human, agent, project, session };
}

describe("startup checklist: next-session queue", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("lists queued items by priority with id and version; consumed and dismissed items are out", async () => {
    const enqueue = (text: string, priority: number) =>
      w.store.queue.enqueue({
        project_id: w.project,
        human_id: w.human,
        kind: "note",
        text,
        priority,
      });
    const low = await enqueue("low priority note", 1);
    const high = await enqueue("high priority note", 9);
    const consumed = await enqueue("already consumed", 8);
    await w.store.queue.consume(consumed.id, consumed.version, w.session);
    const dismissed = await enqueue("dismissed by the human", 7);
    await w.store.queue.dismiss(dismissed.id, dismissed.version);
    const edited = await enqueue("edited once", 5);
    await w.store.queue.patch(edited.id, { text: "edited once (v2)" });

    const brief = await runStartupChecklist({
      store: w.store,
      clock: w.clock,
      agentId: w.agent,
      projectId: w.project,
      appVersion: "0.1.0",
      sessionCapUsdMicro: 5_000_000,
    });
    expect(brief.queue.count).toBe(3);
    expect(brief.queue.items).toEqual([
      { id: high.id, version: 1, kind: "note", text: "high priority note", priority: 9 },
      { id: edited.id, version: 2, kind: "note", text: "edited once (v2)", priority: 5 },
      { id: low.id, version: 1, kind: "note", text: "low priority note", priority: 1 },
    ]);
    const text = renderStateBrief(brief);
    expect(text).toContain("## Next-session queue (3)");
    expect(text).toContain("p9 note: high priority note");
    expect(text).not.toContain("already consumed");
    expect(text).not.toContain("dismissed by the human");
    // Ids and versions are for the runner, not the model.
    expect(text).not.toContain(high.id);
  });

  it("lists and counts only the items the agent's own human queued; a co-worker's stay out of the brief (ADR 0044)", async () => {
    const other = (await w.store.human.insert({ name: "M", email: "m@example.test" })).id;
    const mine = await w.store.queue.enqueue({
      project_id: w.project,
      human_id: w.human,
      kind: "note",
      text: "keep the health endpoint tiny",
      priority: 2,
    });
    const theirs = await w.store.queue.enqueue({
      project_id: w.project,
      human_id: other,
      kind: "correction",
      text: "rotate the staging key",
      priority: 9,
    });
    const brief = await runStartupChecklist({
      store: w.store,
      clock: w.clock,
      agentId: w.agent,
      projectId: w.project,
      appVersion: "0.1.0",
      sessionCapUsdMicro: 5_000_000,
    });
    expect(brief.human.id).toBe(w.human);
    expect(brief.queue.count).toBe(1);
    expect(brief.queue.items.map((i) => i.id)).toEqual([mine.id]);
    const text = renderStateBrief(brief);
    expect(text).toContain("## Next-session queue (1)");
    expect(text).toContain(mine.text);
    expect(text).not.toContain(theirs.text);
    // The co-worker's item is untouched and still waits for their own agent.
    expect(await w.store.queue.mustGet(theirs.id)).toMatchObject({ status: "queued", version: 1 });
    expect(await w.store.queue.pending(w.project, { humanId: other })).toHaveLength(1);
  });

  it("without a project the queue is empty", async () => {
    const brief = await runStartupChecklist({
      store: w.store,
      clock: w.clock,
      agentId: w.agent,
      appVersion: "0.1.0",
      sessionCapUsdMicro: 5_000_000,
    });
    expect(brief.queue).toEqual({ items: [], count: 0 });
  });
});
