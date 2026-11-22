import { describe, expect, it } from "vitest";
import { CommandExecutor, defaultRegistry, IntentParser } from "../src/index.ts";
import { START, TZ, world } from "./helpers.ts";

/**
 * l4-chat-depth (run L4), in the commands: a dependency change says when the task runs
 * (L4-chat-207, ADR 0118 point 3), with the prepared line the runtime's ports give.
 */

const task = (w: Awaited<ReturnType<typeof world>>, title: string, over = {}) =>
  w.store.task.insert({
    project_id: w.game.id,
    title,
    outcome: `${title}.`,
    acceptance_criteria: [],
    risk_tier: 0,
    status: "ready",
    priority: 50,
    reason: "",
    ...over,
  });

describe("l4-chat-depth, run L4: a dependency change says when the task runs (L4-chat-207)", () => {
  it("removing the last undone dependency prepares the task: with a session running it joins, and the line says so", async () => {
    const w = await world();
    const prepared: { taskIds: string[] }[] = [];
    w.ports.prepareWork = async (req) => {
      prepared.push({ taskIds: req.taskIds });
      return "It joins the session that is running.";
    };
    w.ports.previewWork = async () =>
      "Ready: it joins this session if budget is left after its own tasks, else your next Start.";
    const readme = await task(w, "Write the README");
    const faq = await task(w, "Write the FAQ", { depends_on: [readme.id] });
    const r = await w.executor.execute({
      name: "task.dependencies",
      params: { task: faq.id, depends_on: [] },
      ctx: w.ctx({ source: "ui", activeProjectId: w.game.id }),
    });
    expect(r.status).toBe("done");
    expect(r.status === "done" ? r.sentence : "").toBe(
      '"Write the FAQ" waits for no other task now. It joins the session that is running.',
    );
    expect(prepared).toEqual([{ taskIds: [faq.id] }]);
  });

  it("a task that still waits says after what and when, read-only: in this session if budget is left, else the next Start; nothing is prepared", async () => {
    const w = await world();
    const prepared: unknown[] = [];
    w.ports.prepareWork = async (req) => {
      prepared.push(req);
      return "It joins the session that is running.";
    };
    w.ports.previewWork = async () =>
      "Ready: it joins this session if budget is left after its own tasks, else your next Start.";
    const readme = await task(w, "Write the README");
    const faq = await task(w, "Write the FAQ");
    const r = await w.executor.execute({
      name: "task.dependencies",
      params: { task: faq.id, add: [readme.id] },
      ctx: w.ctx({ source: "ui", activeProjectId: w.game.id }),
    });
    expect(r.status === "done" ? r.sentence : "").toBe(
      '"Write the FAQ" now waits for "Write the README". It runs after it is done, in this session if budget is left, else your next Start.',
    );
    expect(prepared).toEqual([]);
  });

  it("a paused task's dependency change says nothing about when it runs", async () => {
    const w = await world();
    w.ports.previewWork = async () => "Ready: it runs at your next Start.";
    const readme = await task(w, "Write the README");
    const faq = await task(w, "Write the FAQ", { status: "needs_human", reason: "Paused by you" });
    const r = await w.executor.execute({
      name: "task.dependencies",
      params: { task: faq.id, add: [readme.id] },
      ctx: w.ctx({ source: "ui", activeProjectId: w.game.id }),
    });
    expect(r.status === "done" ? r.sentence : "").toBe(
      '"Write the FAQ" now waits for "Write the README".',
    );
  });

  it("'let the FAQ run on its own' and 'make X wait for nothing' are a dependency change that empties the list", async () => {
    const p = new IntentParser(defaultRegistry());
    for (const line of [
      "let the FAQ run on its own",
      "let the FAQ task run by itself",
      "make the FAQ wait for nothing",
      "the FAQ should not wait for anything",
    ]) {
      const parsed = await p.parse(line, {
        source: "chat",
        timezone: TZ,
        now: Date.parse(START),
        activeProjectId: "p-game",
        projects: [{ id: "p-game", name: "Game" }],
      });
      expect(parsed.commands, line).toEqual([
        { name: "task.dependencies", params: { task: expect.any(String), depends_on: [] } },
      ]);
    }
  });
});

/** Close "Game" into "PharmaWatch" as Make one project does (archived, joined_into). */
async function closeGameIntoPharma(w: Awaited<ReturnType<typeof world>>) {
  const game = await w.store.project.mustGet(w.game.id);
  await w.store.project.update(game.id, game.version, {
    status: "archived",
    settings: {
      ...(game.settings as Record<string, unknown>),
      joined_into: { project: w.pharma.id, name: "PharmaWatch", at: w.clock.nowIso() },
    },
  });
}

describe("l4-chat-depth, run L4: a closed project takes no new work, a yes after the join included (L4-chat-204)", () => {
  it("a change read back in chat before the join and answered yes after it is refused in words, and changes nothing", async () => {
    const w = await world();
    const readme = await task(w, "Write the README");
    const faq = await task(w, "Write the FAQ");
    const asked = await w.executor.execute({
      name: "task.dependencies",
      params: { task: faq.id, add: [readme.id] },
      ctx: w.ctx({ source: "chat", activeProjectId: w.game.id }),
    });
    expect(asked.status).toBe("pending");
    const pendingId = asked.status === "pending" ? asked.pendingId : "";
    await closeGameIntoPharma(w);
    const yes = await w.executor.confirmByText(pendingId, "yes", {
      kind: "human",
      id: w.human.id,
    });
    expect(yes.status).toBe("refused");
    expect(yes.status === "refused" ? yes.reason : "").toBe(
      '"Game" joined "PharmaWatch", so its work runs there.',
    );
    expect((await w.store.task.mustGet(faq.id)).depends_on).toEqual([]);
  });

  it("after a restart the card is armed again and its yes is refused with the joined sentence; nothing changes", async () => {
    const w = await world();
    const readme = await task(w, "Write the README");
    const faq = await task(w, "Write the FAQ");
    const asked = await w.executor.execute({
      name: "task.dependencies",
      params: { task: faq.id, add: [readme.id] },
      ctx: w.ctx({ source: "chat", activeProjectId: w.game.id }),
    });
    const pendingId = asked.status === "pending" ? asked.pendingId : "";
    await closeGameIntoPharma(w);
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
    const yes = await again.confirmByText(pendingId, "yes", { kind: "human", id: w.human.id });
    expect(yes.status).toBe("refused");
    expect(yes.status === "refused" ? yes.reason : "").toBe(
      '"Game" joined "PharmaWatch", so its work runs there.',
    );
    expect((await w.store.task.mustGet(faq.id)).depends_on).toEqual([]);
    expect((await w.store.humanRequest.mustGet(pendingId)).status).toBe("answered");
  });
});
