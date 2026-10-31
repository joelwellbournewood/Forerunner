import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * Undo as the person meets it (U-057, U-061): an undo that puts a higher limit back asks for
 * the confirmation that raise needs, and an undo that cannot work says so in words, never
 * "Undone" over nothing.
 */

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}
function _pending(r: ExecuteResult): Extract<ExecuteResult, { status: "pending" }> {
  if (r.status !== "pending")
    throw new Error(`expected pending, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}
function refused(r: ExecuteResult): Extract<ExecuteResult, { status: "refused" }> {
  if (r.status !== "refused") throw new Error(`expected refused, got ${r.status}`);
  return r;
}
const tap = (humanId: string) => ({
  kind: "tap" as const,
  by: { kind: "human" as const, id: humanId },
});

describe("undo says when it cannot work (U-061)", () => {
  it("undoing a created task that is done since refuses in words and changes nothing", async () => {
    const w = await world();
    const created = done(
      await w.executor.execute({
        name: "task.create",
        params: { title: "Write the release notes", status: "ready" },
        ctx: w.ctx(),
      }),
    );
    const row = await w.store.changeLog.mustGet(created.changeLogId);
    const taskId = (row.after as { task_id: string }).task_id;
    // The work went on: the task was reviewed and closed.
    for (const to of ["claimed", "in_progress", "in_review", "done"] as const) {
      const t = await w.store.task.mustGet(taskId);
      await w.store.task.transition(t.id, t.version, to, "work", { agentId: w.agent.id });
    }
    expect(await w.executor.undoBlockedReason(row, w.ctx())).toBe(
      'the task "Write the release notes" is done; a done task cannot be cancelled, so its creation cannot be undone',
    );
    const r = refused(await w.executor.undo(created.changeLogId, w.ctx()));
    expect(r.reason).toBe(
      'the task "Write the release notes" is done; a done task cannot be cancelled, so its creation cannot be undone',
    );
    expect((await w.store.task.mustGet(taskId)).status).toBe("done");
    expect((await w.store.changeLog.mustGet(created.changeLogId)).undo_state).toBe("undoable");
    // No "Undone" row was written.
    expect((await w.store.changeLog.list()).map((c) => c.sentence)).not.toContain(
      expect.stringMatching(/^Undone/),
    );
    await w.store.close();
  });

  it("an undone task creation says what it did, not the old task count", async () => {
    const w = await world();
    const created = done(
      await w.executor.execute({
        name: "task.create",
        params: { title: "Draft the FAQ" },
        ctx: w.ctx(),
      }),
    );
    const u = done(await w.executor.undo(created.changeLogId, w.ctx()));
    expect(u.sentence).toBe('Undone: cancelled the task "Draft the FAQ" you created.');
    await w.store.close();
  });

  it("a cancelled task is reopened by its undo; a task moved on since is not moved back", async () => {
    const w = await world();
    const task = await w.store.task.insert({
      project_id: w.pharma.id,
      title: "Check the dosage table",
      status: "ready",
    });
    const cancel = done(
      await w.executor.execute({
        name: "task.transition",
        params: { task: task.id, to: "cancelled", reason: "not needed" },
        ctx: w.ctx({ source: "ui" }),
        confirmation: tap(w.human.id),
      }),
    );
    expect(cancel.sentence).toBe(
      'Moved the task "Check the dosage table" from ready to cancelled. Undo.',
    );
    expect(cancel.undoToken).toBe(cancel.changeLogId);
    const u = done(await w.executor.undo(cancel.changeLogId, w.ctx()));
    expect(u.sentence).toBe(
      'Undone: reopened the task "Check the dosage table"; it is ready again.',
    );
    expect((await w.store.task.mustGet(task.id)).status).toBe("ready");

    const failed = done(
      await w.executor.execute({
        name: "task.transition",
        params: { task: task.id, to: "needs_human" },
        ctx: w.ctx(),
      }),
    );
    const t = await w.store.task.mustGet(task.id);
    await w.store.task.transition(t.id, t.version, "ready", "answered", { humanId: w.human.id });
    const row = await w.store.changeLog.mustGet(failed.changeLogId);
    expect(await w.executor.undoBlockedReason(row, w.ctx())).toBe(
      'the task "Check the dosage table" moved on to ready since; undo would not put it back where it was',
    );
    expect(refused(await w.executor.undo(failed.changeLogId, w.ctx())).reason).toMatch(
      /moved on to ready since/,
    );
    await w.store.close();
  });

  it("a task cancelled while a session held it reopens as ready, unclaimed", async () => {
    const w = await world();
    const task = await w.store.task.insert({
      project_id: w.pharma.id,
      title: "Port the parser",
      status: "ready",
    });
    const claimed = await w.store.task.claim(task.id, w.agent.id, 60_000);
    expect(claimed.ok).toBe(true);
    const cancel = done(
      await w.executor.execute({
        name: "task.transition",
        params: { task: task.id, to: "cancelled" },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    const u = done(await w.executor.undo(cancel.changeLogId, w.ctx()));
    expect(u.sentence).toBe(
      'Undone: reopened the task "Port the parser" as ready (it was claimed; a session picks it up again).',
    );
    const after = await w.store.task.mustGet(task.id);
    expect(after).toMatchObject({ status: "ready", claimed_by: null });
    await w.store.close();
  });

  it("a note a session already read cannot be taken back", async () => {
    const w = await world();
    const note = done(
      await w.executor.execute({
        name: "note.add",
        params: { text: "use the staging database" },
        ctx: w.ctx(),
      }),
    );
    const itemId = (
      (await w.store.changeLog.mustGet(note.changeLogId)).after as {
        queue_item_id: string;
      }
    ).queue_item_id;
    const item = await w.store.queue.mustGet(itemId);
    await w.store.queue.update(item.id, item.version, { status: "consumed" });
    expect(refused(await w.executor.undo(note.changeLogId, w.ctx())).reason).toBe(
      "a session already read the note; it cannot be taken back",
    );
    await w.store.close();
  });
});
