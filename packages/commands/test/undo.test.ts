import { describe, expect, it } from "vitest";
import {
  CommandExecutor,
  EMAIL_EXTENSION_KIND,
  type ExecuteResult,
  emailExtensionName,
} from "../src/index.ts";
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
function pending(r: ExecuteResult): Extract<ExecuteResult, { status: "pending" }> {
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

describe("undo asks for the confirmation of the value it restores (U-057)", () => {
  it("undoing a lowered monthly cap is a raise: it waits for this PC, and a chat yes is not enough", async () => {
    const w = await world();
    // CHF 150 (the default ceiling) lowered to CHF 100: medium, a tap confirms it.
    const lowered = done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "month", amountChf: 100 },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    const capAfterLowering = (await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro;
    expect(capAfterLowering).toBe(125_000_000);

    const p = pending(await w.executor.undo(lowered.changeLogId, w.ctx({ source: "ui" })));
    expect(p.decision).toBe("needs_device");
    expect(p.card.command).toBe("undo");
    expect(p.card.impact.risk).toBe("high");
    expect(p.card.oldValue).toBe("CHF 100");
    expect(p.card.newValue).toBe("CHF 150");
    expect(p.readback).toContain("Confirm in the app on a paired device");
    // The Inbox shows the undo as a high-risk approval with the device's options.
    const request = await w.store.humanRequest.mustGet(p.pendingId);
    expect(request).toMatchObject({ kind: "approval", risk: "high", status: "open" });
    expect(request.options).toEqual(["approve on device", "reject"]);
    // Nothing changed yet, and the row is still undoable.
    expect((await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro).toBe(125_000_000);
    expect((await w.store.changeLog.mustGet(lowered.changeLogId)).undo_state).toBe("undoable");

    // A typed yes is refused for a high-risk change; the card stays open.
    const chatYes = refused(
      await w.executor.confirmByText(p.pendingId, "yes", { kind: "human", id: w.human.id }),
    );
    expect(chatYes.reason).toMatch(/paired device/);
    expect((await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro).toBe(125_000_000);

    // This PC (the desktop device row) confirms; the cap is back and the row is undone.
    const r = done(
      await w.executor.confirmFromDevice(p.pendingId, { deviceId: w.desktop.id, biometric: false }),
    );
    expect(r.sentence).toBe("Undone: the monthly cap is back to CHF 150.");
    const human = await w.store.human.mustGet(w.human.id);
    expect(human.monthly_cap_usd_micro).toBe(0);
    expect((await w.store.changeLog.mustGet(lowered.changeLogId)).undo_state).toBe("undone");
    const undoRow = await w.store.changeLog.mustGet(r.changeLogId);
    expect(undoRow.source).toBe("ui");
    await w.store.close();
  });

  it("an undo that lowers a cap acts at once, as before", async () => {
    const w = await world();
    const raised = done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    const u = done(await w.executor.undo(raised.changeLogId, w.ctx()));
    expect(u.sentence).toBe("Undone: the session budget for PharmaWatch is back to CHF 5.");
    await w.store.close();
  });

  it("after a restart (no card in memory) the undo of a lowered cap still waits for the device", async () => {
    const w = await world();
    const lowered = done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "month", amountChf: 100 },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    const fresh = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
    const p = pending(await fresh.undo(lowered.changeLogId, w.ctx()));
    expect(p.decision).toBe("needs_device");
    expect(p.card.what).toBe("undo: Lowered the monthly cap from CHF 150 to CHF 100.");
    done(await fresh.confirmFromDevice(p.pendingId, { deviceId: w.phone.id, biometric: true }));
    expect((await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro).toBe(0);
    fresh.stop();
    await w.store.close();
  });

  it("undoing a switch of the email mode to a narrower one puts the wider mode back only on the device", async () => {
    const w = await world();
    await w.store.extension.insert({
      kind: EMAIL_EXTENSION_KIND,
      name: emailExtensionName(w.agent.id),
      enabled: true,
      permissions: ["email:full_discretion"],
      config: { settings: { mode: "full_discretion" }, commands: {} },
      author_agent: w.agent.id,
    });
    const narrowed = done(
      await w.executor.execute({
        name: "email.mode.set",
        params: { mode: "draft_only" },
        ctx: w.ctx(),
        confirmation: { kind: "device", deviceId: w.desktop.id, biometric: false },
      }),
    );
    const p = pending(await w.executor.undo(narrowed.changeLogId, w.ctx()));
    expect(p.decision).toBe("needs_device");
    const modeNow = async () => {
      const row = await w.store.extension.byName(
        EMAIL_EXTENSION_KIND,
        emailExtensionName(w.agent.id),
      );
      return (row?.config as { settings?: { mode?: string } } | undefined)?.settings?.mode;
    };
    expect(await modeNow()).toBe("draft_only");
    // "reject" in the Inbox is a no: nothing changes and the row can still be undone later.
    expect((await w.executor.cancel(p.pendingId, { kind: "human", id: w.human.id })).status).toBe(
      "cancelled",
    );
    expect(await modeNow()).toBe("draft_only");
    expect((await w.store.changeLog.mustGet(narrowed.changeLogId)).undo_state).toBe("undoable");
    await w.store.close();
  });

  it("undoing a widening of the email mode narrows it at once", async () => {
    const w = await world();
    const widened = done(
      await w.executor.execute({
        name: "email.mode.set",
        params: { mode: "allowlist" },
        ctx: w.ctx(),
        confirmation: { kind: "device", deviceId: w.desktop.id, biometric: false },
      }),
    );
    done(await w.executor.undo(widened.changeLogId, w.ctx()));
    await w.store.close();
  });

  it("undoing a lowered autonomy asks as raising it would", async () => {
    const w = await world();
    const lowered = done(
      await w.executor.execute({
        name: "autonomy.set",
        params: { level: 1 },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    const p = pending(await w.executor.undo(lowered.changeLogId, w.ctx()));
    expect(p.decision).toBe("needs_yes");
    done(await w.executor.confirm(p.pendingId, tap(w.human.id)));
    expect((await w.store.project.mustGet(w.pharma.id)).autonomy_level).toBe(2);
    await w.store.close();
  });

  it("undoing a change to the model watch puts the process sandbox back only on the device", async () => {
    const w = await world();
    await w.store.human.update(w.human.id, (await w.store.human.mustGet(w.human.id)).version, {
      notify_prefs: { model_watch: { run_evals: true, allow_process_sandbox: true } },
    });
    const off = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "model_watch", value: { run_evals: false, allow_process_sandbox: false } },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect(pending(await w.executor.undo(off.changeLogId, w.ctx())).decision).toBe("needs_device");
    await w.store.close();
  });
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
