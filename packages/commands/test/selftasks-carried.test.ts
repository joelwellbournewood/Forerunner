import { describe, expect, it, vi } from "vitest";
import {
  type ClosedConfirmation,
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

/**
 * L4-other-1 D-6 (ADR 0109's amendment: decision 1 covers New task, Edit and chat): chat's
 * read-back of a task for the reviewer says what New task and Edit say.
 */
describe("l4-selftasks-carried, run L4: chat's read-back of a reviewer task says it writes no file (L4-other-1 D-6)", () => {
  const NAMED =
    "The reviewer writes no file, so review.md is not written: its findings are its report, which you read in the task's drawer.";
  const PLAIN =
    "The reviewer writes no file: its findings are its report, which you read in the task's drawer.";

  async function reviewerWorld() {
    const w = await world();
    w.ports.modelSettings = {
      specialists: () => ["coder", "reviewer"],
      capabilities: () => ({ acceptsTemperature: false }) as never,
      writesNoFile: (name) => name === "reviewer",
    };
    return w;
  }

  it("task.create for the reviewer: the read-back and the sentence carry the line, naming review.md; a coder task carries none", async () => {
    const w = await reviewerWorld();
    const ctx = w.ctx({ source: "chat", activeProjectId: w.pharma.id });
    const card = async (specialist: string, outcome: string) =>
      (
        await w.executor.execute({
          name: "task.create",
          params: {
            title: "Review the plan",
            outcome,
            acceptance_criteria: [],
            specialist,
          },
          ctx: { ...ctx, recordsRead: true } as never,
        })
      ).card;
    const reviewer = await card(
      "reviewer",
      "review.md lists the gaps and risks found in notes/plan.md",
    );
    expect(reviewer?.ask).toBe(`Add "Review the plan" to PharmaWatch? ${NAMED}`);
    expect(reviewer?.sentence).toBe(
      `Added "Review the plan" to PharmaWatch, for the reviewer. ${NAMED}`,
    );
    const plain = await card("reviewer", "The gaps found in notes/plan.md are listed");
    expect(plain?.ask).toBe(`Add "Review the plan" to PharmaWatch? ${PLAIN}`);
    // fixup-l4-selftasks-carried (the review's blocking item): a technology's dotted name is no
    // file the words ask for (before: "so Node.js is not written").
    const tech = await card("reviewer", "Write a review of the Node.js setup");
    expect(tech?.ask).toBe(`Add "Review the plan" to PharmaWatch? ${PLAIN}`);
    expect(tech?.sentence).toBe(
      `Added "Review the plan" to PharmaWatch, for the reviewer. ${PLAIN}`,
    );
    const coder = await card("coder", "review.md lists the gaps");
    expect(coder?.ask).toBe('Add "Review the plan" to PharmaWatch?');
    await w.store.close();
  });

  it("task.update that gives a task to the reviewer reads back the line; one that changes only its priority does not", async () => {
    const w = await reviewerWorld();
    await w.store.task.insert({
      project_id: w.pharma.id,
      title: "Review the plan",
      outcome: "review.md lists the gaps and risks found in notes/plan.md",
      status: "ready",
      specialist: "coder",
    } as never);
    const ctx = w.ctx({ source: "chat", activeProjectId: w.pharma.id });
    const ask = async (params: Record<string, unknown>) =>
      (
        await w.executor.execute({
          name: "task.update",
          params: { task: "Review the plan", ...params },
          ctx,
        })
      ).card?.ask;
    expect(await ask({ specialist: "reviewer" })).toBe(
      `Change "Review the plan": who does it to reviewer? ${NAMED}`,
    );
    expect(await ask({ priority: "high" })).toBe('Change "Review the plan": priority to High?');
    await w.store.close();
  });

  // The bench walk after this area's fix (walk2): at Assisted chat made a reviewer task at once
  // ("Added ... for the reviewer. It runs at your next Start.") with no line, because the done
  // sentence is the command's run sentence, not the card's.
  it("a reviewer task made at once (no read-back) says the line in its done sentence too", async () => {
    const w = await reviewerWorld();
    const r = await w.executor.execute({
      name: "task.create",
      params: {
        title: "Review the plan",
        outcome: "review.md lists the gaps and risks found in notes/plan.md",
        acceptance_criteria: [],
        specialist: "reviewer",
      },
      ctx: w.ctx({ source: "chat", activeProjectId: w.pharma.id }),
      confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
    });
    expect(r.status).toBe("done");
    expect((r as { sentence: string }).sentence).toContain(
      `Added "Review the plan" to PharmaWatch, for the reviewer. ${NAMED}`,
    );
    // An edit made at once that gives a coder task to the reviewer says it too.
    await w.store.task.insert({
      project_id: w.pharma.id,
      title: "Check the README",
      outcome: "gaps.md lists what the README leaves out",
      status: "ready",
      specialist: "coder",
    } as never);
    const edited = await w.executor.execute({
      name: "task.update",
      params: { task: "Check the README", specialist: "reviewer" },
      ctx: w.ctx({ source: "chat", activeProjectId: w.pharma.id }),
      confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
    });
    expect(edited.status).toBe("done");
    expect((edited as { sentence: string }).sentence).toBe(
      'Changed "Check the README": who does it to reviewer. The reviewer writes no file, so gaps.md is not written: its findings are its report, which you read in the task\'s drawer.',
    );
    await w.store.close();
  });
});

/**
 * L4f-left-5 (L4-selftasks-117's details without their own test): a chat read-back of a
 * setting, a budget or the autonomy is compared at the Yes with the value in force then (the
 * card's oldValue); one changed elsewhere since says so in one line and nothing is applied,
 * also after a restart (the card armed again from the store).
 */
describe("l4-selftasks-carried, run L4: a value read back in chat that moved since says so, also after a restart (L4f-left-5)", () => {
  async function rearm(w: World) {
    const again = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
    const open = await w.store.humanRequest.list({ status: "open", kind: "approval" } as never, {
      limit: 50,
    });
    await again.restorePending(open, async (stored) => ({
      ...w.ctx(),
      actor: stored.actor,
      humanId: stored.humanId,
      agentId: stored.agentId,
      activeProjectId: stored.activeProjectId,
      source: stored.source,
      wordsUsed: stored.wordsUsed,
    }));
    return again;
  }

  const CASES: Array<{
    label: string;
    asked: { name: string; params: Record<string, unknown> };
    elsewhere: { name: string; params: Record<string, unknown> };
    line: RegExp;
  }> = [
    {
      label: "the monthly cap",
      asked: { name: "budget.set", params: { scope: "month", amountChf: 100 } },
      elsewhere: { name: "budget.set", params: { scope: "month", amountChf: 120 } },
      line: /^The monthly cap is CHF 120\.00 now, not CHF 150\.00 as I read it back\. Nothing was changed; ask again if you still want it\.$/,
    },
    {
      label: "the email mode",
      asked: { name: "email.mode.set", params: { mode: "allowlist" } },
      elsewhere: { name: "email.mode.set", params: { mode: "read_only" } },
      line: /^The email mode of Alice is Read only now, not Off as I read it back\. Nothing was changed; ask again if you still want it\.$/,
    },
  ];

  for (const c of CASES)
    for (const restart of [false, true])
      it(`${c.label}${restart ? ", after a restart" : ""}`, async () => {
        const w = await world();
        const asked = await w.executor.execute({
          ...c.asked,
          ctx: w.ctx({ source: "chat" }),
        });
        if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
        const shownOld = asked.card?.oldValue;
        // Settings changes the same value with a tap before the person answers the chat card.
        const moved = await w.executor.execute({
          ...c.elsewhere,
          ctx: w.ctx({ source: "ui" }),
          confirmation: { kind: "device", deviceId: w.phone.id, biometric: true },
        });
        expect(moved.status, JSON.stringify(moved)).toBe("done");
        const executor = restart ? await rearm(w) : w.executor;
        expect(executor.getPending(asked.pendingId)).toBeDefined();
        const yes = await executor.confirmFromDevice(asked.pendingId, {
          deviceId: w.phone.id,
          biometric: true,
        });
        expect(yes.status).toBe("refused");
        expect((yes as { reason: string }).reason).toMatch(c.line);
        expect((yes as { details?: { reason?: string } }).details?.reason).toBe("changed_since");
        // Nothing was applied: the value is the one Settings set.
        const again = await w.executor.plan(c.asked, w.ctx({ source: "chat" }));
        expect(again.oldValue).not.toBe(shownOld);
        await w.store.close();
      });

  it("a value as it was read back is applied at the Yes, also after a restart", async () => {
    for (const restart of [false, true]) {
      const w = await world();
      const asked = await w.executor.execute({
        name: "budget.set",
        params: { scope: "month", amountChf: 100 },
        ctx: w.ctx({ source: "chat" }),
      });
      if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
      const executor = restart ? await rearm(w) : w.executor;
      const yes = await executor.confirmFromDevice(asked.pendingId, {
        deviceId: w.desktop.id,
        biometric: false,
      });
      expect(yes.status, `restart: ${restart}`).toBe("done");
      await w.store.close();
    }
  });
});

/**
 * fixup-l4-selftasks-carried (the review's non-blocking items): every close is told once, also
 * when the change after a yes fails to be recorded (before, `confirm` told nothing when
 * `perform` threw, so the header kept "Waiting for you" until a reload), and a lapse tells its
 * Update before it tells the close, so the screens read the Inbox once with the Update in it.
 */
describe("fixup-l4-selftasks-carried, run L4: a close is told once whatever happens after it (L4f-left-1)", () => {
  it("a yes whose change cannot be recorded still tells the close", async () => {
    const w = await world();
    const closed: ClosedConfirmation[] = [];
    const executor = new CommandExecutor({
      registry: w.registry,
      store: w.store,
      clock: w.clock,
      onClosed: (c) => {
        closed.push(c);
      },
    });
    const task = await seed(w, "Write the FAQ");
    const asked = await executor.execute({
      name: "task.transition",
      params: { task: task.id, to: "cancelled" },
      ctx: w.ctx({ source: "chat" }),
    });
    if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
    vi.spyOn(w.store.changeLog, "record").mockRejectedValueOnce(new Error("disk full"));
    await expect(executor.confirmByText(asked.pendingId, "yes", w.ctx().actor)).rejects.toThrow(
      "disk full",
    );
    expect(closed).toEqual([
      expect.objectContaining({ id: asked.pendingId, projectId: w.pharma.id, how: "yes" }),
    ]);
    expect(executor.getPending(asked.pendingId)).toBeUndefined();
    await w.store.close();
  });

  it("a lapse tells its Update first, then the close, once each", async () => {
    const w = await world();
    const told: string[] = [];
    const executor = new CommandExecutor({
      registry: w.registry,
      store: w.store,
      clock: w.clock,
      onExpired: (c) => {
        told.push(`expired ${c.id}`);
      },
      onClosed: (c) => {
        told.push(`closed ${c.id} ${c.how}`);
      },
    });
    const asked = await executor.execute({
      name: "budget.set",
      params: { scope: "month", amountChf: 400 },
      ctx: w.ctx({ source: "ui" }),
    });
    if (asked.status !== "pending") throw new Error(JSON.stringify(asked));
    await w.clock.advance(11 * 60_000);
    await vi.waitFor(() => expect(told).toHaveLength(2), { timeout: 10_000 });
    expect(told).toEqual([`expired ${asked.pendingId}`, `closed ${asked.pendingId} expired`]);
    await w.store.close();
  });
});
