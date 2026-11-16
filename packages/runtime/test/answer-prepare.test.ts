import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmitOutcome } from "../src/session/live-sessions.ts";
import { prepareWork, summarize } from "../src/session/prepared-work.ts";
import { answeredTaskIds } from "../src/session/resume-work.ts";
import { harness } from "./helpers.ts";

/**
 * C3-left-3 (run C step 3's leftover, from d1109-starts-engine; d1109-selftasks-run takes it):
 * an Inbox answer prepares the work it made runnable, for that work only. Every answer path
 * passed no task ids, so the running session's admit rule was offered every ready task of the
 * project and the Done line said "It joins the session that is running." when any one joined,
 * also when the answered task did not fit (design §5: a sentence promises only what the app
 * does).
 */
const stores: StateStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function world() {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  stores.push(store);
  const project = await store.project.insert({ name: "Quote page", goal: "A page" });
  const add = (title: string, over: Record<string, unknown> = {}) =>
    store.task.insert({
      project_id: project.id,
      title,
      outcome: `${title}.`,
      status: "ready",
      ...over,
    } as never);
  return { store, project, add, now: () => h.clock.nowIso() };
}

describe("C3-left-3: an answer prepares the work it made runnable, and its Done line speaks of it", () => {
  it("the answered task back at Ready is the work; a task closed as done offers the tasks that wait on it", async () => {
    const w = await world();
    const other = await w.add("Write the README");
    const retried = await w.add("Style the page");
    expect(await answeredTaskIds(w.store, retried)).toEqual([retried.id]);
    const closed = await w.add("Give the menu", { status: "done", specialist: "person" });
    const next = await w.add("Publish the menu", { depends_on: [closed.id] });
    expect(await answeredTaskIds(w.store, closed)).toEqual([next.id]);
    expect(await answeredTaskIds(w.store, closed)).not.toContain(other.id);
  });

  it("the running session is asked about those tasks only; one that does not fit is not said to join because another did", async () => {
    const w = await world();
    const fits = await w.add("Write the README");
    const answered = await w.add("Style the page");
    const asked: string[][] = [];
    const live = {
      forProject: () => ({
        admit: async (ids: readonly string[]) => {
          asked.push([...ids]);
          return new Map<string, AdmitOutcome>(
            ids.map((id) => [id, id === fits.id ? "joined" : "no_room"]),
          );
        },
      }),
    };
    const r = await prepareWork(
      { store: w.store, live: live as never, now: w.now },
      {
        agentId: "a1",
        projectId: w.project.id,
        taskIds: [answered.id],
        reason: "you asked to try it again",
        by: "person",
      },
    );
    expect(asked).toEqual([[answered.id]]);
    expect(r).toEqual({
      outcome: "no_room",
      line: "Ready: it joins this session if budget is left after its own tasks, else your next Start.",
    });
  });

  it("several tasks: 'joined' only when every one joined", () => {
    const m = (...o: AdmitOutcome[]) => new Map(o.map((x, i) => [`t${i}`, x]));
    expect(summarize(m("joined", "joined"))).toBe("joined");
    expect(summarize(m("joined", "no_room"))).toBe("no_room");
    expect(summarize(m("no_room"))).toBe("no_room");
    expect(summarize(m("stopping", "stopping"))).toBe("stopping");
  });
});
