import { describe, expect, it } from "vitest";
import {
  CommandExecutor,
  fixListMoved,
  namedTaskIds,
  taskListFingerprint,
} from "../src/index.ts";
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

/**
 * L4-selftasks-120 (rest): a move said in chat on a task whose card offers it answers that card,
 * unless the person's own note goes with it (a card's answer has no room for it). The note is the
 * person's only when they wrote it (L4f: their own command, never one the chat's model passed,
 * also after their yes), so a note the model wrote no longer keeps the move off the card.
 */
describe("l4-selftasks-carried, run L4: the redirect guards judge a note by who wrote it (L4-selftasks-120)", () => {
  async function failedWithCard(w: World) {
    const task = await w.store.task.insert({
      project_id: w.pharma.id,
      title: "Write the digest page",
      outcome: "digest.html",
      status: "failed",
    });
    const card = await w.store.humanRequest.insert({
      kind: "approval",
      why: '"Write the digest page" failed: the model did not answer.',
      options: ["Try again", "Mark done anyway", "Cancel task"],
      human_id: w.human.id,
      project_id: w.pharma.id,
      task_id: task.id,
      risk: "medium",
      blocking: true,
    });
    w.ports.cardWords = async (r) =>
      r.id === card.id
        ? {
            title: '"Write the digest page" failed',
            choices: [
              { label: "Try again", explain: "Starts a session that tries again." },
              { label: "Mark done anyway", explain: null },
              { label: "Cancel task", explain: null },
            ],
            outcome: null,
          }
        : null;
    return { task, card };
  }
  const MODEL_NOTE = "Put on hold by the person.";

  it("the chat model's note (as the agent, or on the person's line before their yes) answers the card; the person's own note moves the task with it", async () => {
    const w = await world();
    const { card } = await failedWithCard(w);
    const agent = { kind: "agent", id: w.agent.id } as const;
    for (const [name, params] of [
      ["task.transition", { task: "digest", to: "ready", note: MODEL_NOTE }],
      ["task.resume", { task: "digest", note: MODEL_NOTE }],
    ] as const) {
      for (const ctx of [
        w.ctx({ actor: agent, source: "chat" }),
        w.ctx({ source: "chat", onPersonsWords: true }),
      ]) {
        const asked = await w.executor.execute({ name, params, ctx });
        expect(asked.status, `${name} ${ctx.actor.kind}`).toBe("pending");
        expect(asked.card?.command, `${name} ${ctx.actor.kind}`).toBe("request.answer");
        expect((asked as { readback: string }).readback).toBe(
          'Try again ("Write the digest page" failed)? Starts a session that tries again.',
        );
        await w.executor.cancel((asked as { pendingId: string }).pendingId, w.ctx().actor);
      }
    }
    // The person's own note (their command: the parser's, the drawer's) keeps the move.
    const own = await w.executor.execute({
      name: "task.transition",
      params: { task: "digest", to: "ready", note: "Use the old layout." },
      ctx: w.ctx({ source: "chat" }),
    });
    expect(own.card?.command).toBe("task.transition");
    if (own.status === "pending") await w.executor.cancel(own.pendingId, w.ctx().actor);
    expect((await w.store.humanRequest.mustGet(card.id)).status).toBe("open");
    await w.store.close();
  });

  it("after a restart, the read-back a model's note made of the card's answer is armed again as that answer, and its yes answers the card", async () => {
    const w = await world();
    const { card } = await failedWithCard(w);
    const asked = await w.executor.execute({
      name: "task.transition",
      params: { task: "digest", to: "ready", note: MODEL_NOTE },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect(asked.card?.command).toBe("request.answer");
    const pendingId = (asked as { pendingId: string }).pendingId;
    // A new process on the same store: the executor arms the open cards again.
    const again = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
    const open = await w.store.humanRequest.list({ status: "open", kind: "approval" } as never, {
      limit: 50,
    });
    const armed = await again.restorePending(open, async (stored) => ({
      ...w.ctx(),
      actor: stored.actor,
      humanId: stored.humanId,
      agentId: stored.agentId,
      activeProjectId: stored.activeProjectId,
      source: stored.source,
      wordsUsed: stored.wordsUsed,
    }));
    expect(armed).toContain(pendingId);
    expect(again.getPending(pendingId)?.card.command).toBe("request.answer");
    expect(again.getPending(pendingId)?.readback).toBe(
      'Try again ("Write the digest page" failed)? Starts a session that tries again.',
    );
    const yes = await again.confirmByText(pendingId, "yes", w.ctx().actor);
    expect(yes.status).toBe("done");
    expect((await w.store.humanRequest.mustGet(card.id)).answer).toBe("Try again");
    await w.store.close();
  });
});

/**
 * L4f-left-3: an Undo read back in chat is confirmed with the same sentence before and after a
 * restart: "Undone: the monthly cap is back to CHF 150.00." (after a restart it read the change
 * log row's "Undone: Lowered the monthly cap from CHF 150.00 to CHF 100.00.").
 */
describe("l4-selftasks-carried, run L4: an Undo read back in chat says what is back, also after a restart (L4f-left-3)", () => {
  it("the same confirmation without a restart and after one", async () => {
    for (const restart of [false, true]) {
      const w = await world();
      const lowered = await w.executor.execute({
        name: "budget.set",
        params: { scope: "month", amountChf: 100 },
        ctx: w.ctx(),
        confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
      });
      if (lowered.status !== "done") throw new Error(JSON.stringify(lowered));
      const asked = await w.executor.undo(lowered.changeLogId, w.ctx({ source: "chat" }));
      if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
      let executor = w.executor;
      if (restart) {
        executor = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
        const open = await w.store.humanRequest.list(
          { status: "open", kind: "approval" } as never,
          { limit: 50 },
        );
        await executor.restorePending(open, async (stored) => ({
          ...w.ctx(),
          actor: stored.actor,
          humanId: stored.humanId,
          agentId: stored.agentId,
          activeProjectId: stored.activeProjectId,
          source: stored.source,
          wordsUsed: stored.wordsUsed,
        }));
      }
      const r = await executor.confirmFromDevice(asked.pendingId, {
        deviceId: w.desktop.id,
        biometric: false,
      });
      expect(r.status, `restart: ${restart}`).toBe("done");
      expect((r as { sentence: string }).sentence, `restart: ${restart}`).toBe(
        "Undone: the monthly cap is back to CHF 150.00.",
      );
      await w.store.close();
    }
  });
});
