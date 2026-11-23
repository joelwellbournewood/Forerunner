import { describe, expect, it } from "vitest";
import { fixListMoved, namedTaskIds, taskListFingerprint } from "../src/index.ts";
import { type World, world } from "./helpers.ts";

/**
 * l4-selftasks-carried, run L4. L4f-left-2 (session lead decision 2026-11-23, after the owner's
 * 2026-11-17 answer that every chat read-back waits until it is answered, and run C decision 53:
 * a Yes after the list changed says so): the fingerprint of a 'fix the tasks' read-back covers
 * which tasks the list holds and the tasks its set names, not the status of the others.
 */

async function seed(w: World, title: string, extra: Record<string, unknown> = {}) {
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
    ...extra,
  } as never);
}

describe("l4-selftasks-carried, run L4: the fix set's fingerprint (L4f-left-2)", () => {
  it("a task the set does not name may finish or change its priority; a named task's status, title, outcome or dependencies, or a task added or removed, move the list", async () => {
    const w = await world();
    const style = await seed(w, "Style the page");
    const create = await seed(w, "Create the page");
    const print = await taskListFingerprint(w.store, w.pharma.id);
    const named = [style.id];
    expect(await fixListMoved(w.store, w.pharma.id, print, named)).toBe(false);
    // The session finishes the other task, and its priority moves: still the list it judged.
    await w.store.task.patch(create.id, { status: "done", priority: 1 } as never);
    expect(await fixListMoved(w.store, w.pharma.id, print, named)).toBe(false);
    // The named task's priority is no part of the fingerprint (its card's subjects compare it).
    await w.store.task.patch(style.id, { priority: 9 } as never);
    expect(await fixListMoved(w.store, w.pharma.id, print, named)).toBe(false);
    for (const patch of [
      { status: "done" },
      { title: "Style the home page" },
      { outcome: "The page has a grid" },
      { depends_on: [create.id] },
    ]) {
      const before = await w.store.task.mustGet(style.id);
      await w.store.task.patch(style.id, patch as never);
      expect(await fixListMoved(w.store, w.pharma.id, print, named), JSON.stringify(patch)).toBe(
        true,
      );
      await w.store.task.patch(style.id, {
        status: before.status,
        title: before.title,
        outcome: before.outcome,
        depends_on: before.depends_on,
      } as never);
      expect(await fixListMoved(w.store, w.pharma.id, print, named)).toBe(false);
    }
    // A task added to the list: the membership moved.
    await seed(w, "Write the README");
    expect(await fixListMoved(w.store, w.pharma.id, print, named)).toBe(true);
  });

  it("a card stored with the fingerprint before tasks were kept apart is judged on the whole list, as then", async () => {
    const w = await world();
    const create = await seed(w, "Create the page");
    await seed(w, "Style the page");
    // The old form: the count and one hash of every task's fields.
    const old = "2:0";
    expect(old.startsWith("v2|")).toBe(false);
    expect(await fixListMoved(w.store, w.pharma.id, old, [])).toBe(true);
    const now = await taskListFingerprint(w.store, w.pharma.id);
    expect(now.startsWith("v2|")).toBe(true);
    expect(now).toContain(`${create.id}=`);
  });

  it("the tasks a set names: each call's task and the tasks it waits for, comes before or is the same as, and the card's subjects", () => {
    expect(
      namedTaskIds(
        [
          { params: { task: "t1", parts: [{ title: "A" }] } },
          { params: { title: "Check", depends_on: ["t2"], before: ["t3"] } },
          { params: { task: "t4", to: "cancelled", duplicate_of: "t5" } },
          { params: { task: "t6", depends_on: [] } },
        ],
        {
          subjects: [{ kind: "task", id: "t7", title: "X", fields: {} }],
        } as never,
      ).sort(),
    ).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  });
});
