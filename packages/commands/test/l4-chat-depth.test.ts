import { describe, expect, it } from "vitest";
import { defaultRegistry, IntentParser } from "../src/index.ts";
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
