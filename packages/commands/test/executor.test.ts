import { isForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_PROJECT_KEY,
  CommandExecutor,
  type ExecuteResult,
  renderChangeCard,
  SESSION_OVERRIDE_KEY,
} from "../src/index.ts";
import { settle, TOMORROW_0600, world } from "./helpers.ts";

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

describe("CommandExecutor", () => {
  it("low risk acts at once, writes the change log and posts the sentence to the activity log and the chat", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "project.switch",
        params: { project: "supplement site" },
        ctx: w.ctx({ wordsUsed: "switch to the supplement site", source: "voice" }),
      }),
    );
    expect(r.sentence).toBe("Switched the active project to Supplement Site. Undo.");
    expect(r.undoToken).toBe(r.changeLogId);
    const row = await w.store.changeLog.mustGet(r.changeLogId);
    expect(row).toMatchObject({
      human_id: w.human.id,
      agent_id: w.agent.id,
      words_used: "switch to the supplement site",
      commands: [{ name: "project.switch", params: { project: "supplement site" } }],
      before: { active_project: w.pharma.id },
      after: { active_project: w.supplement.id },
      scope: "global",
      undo_state: "undoable",
      source: "voice",
      sentence: r.sentence,
      author_human: w.human.id,
    });
    const human = await w.store.human.mustGet(w.human.id);
    expect(human.notify_prefs[ACTIVE_PROJECT_KEY]).toBe(w.supplement.id);
    const events = await w.store.event.list(w.conversation.id);
    expect(events.map((e) => e.type)).toEqual(["change"]);
    expect(events[0]?.payload).toMatchObject({ sentence: r.sentence, changeLogId: r.changeLogId });
    const inbox = await w.store.message.inbox({ humanId: w.human.id });
    expect(inbox.map((m) => m.body)).toEqual([r.sentence]);
    expect(inbox[0]?.from_agent_id).toBe(w.agent.id);
    await w.store.close();
  });

  it("a command without a named project applies to the active one and the card says so", async () => {
    const w = await world();
    const card = await w.executor.plan(
      { name: "note.add", params: { text: "check the dosage table" } },
      w.ctx(),
    );
    expect(card.usesActiveProject).toBe(true);
    expect(card.projectName).toBe("PharmaWatch");
    expect(renderChangeCard(card)).toContain("(PharmaWatch, the active project)");
    await w.store.close();
  });

  it("medium risk shows the card, opens a request, and a typed yes runs it", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx({ wordsUsed: "give it 20 francs" }),
      }),
    );
    expect(p.decision).toBe("needs_yes");
    expect(p.readback).toContain("Say yes to confirm");
    expect(p.emailToken).toMatch(/^FR-/);
    const req = await w.store.humanRequest.mustGet(p.pendingId);
    expect(req).toMatchObject({
      kind: "approval",
      risk: "medium",
      status: "open",
      human_id: w.human.id,
    });
    expect(req.change_card).toMatchObject({
      command: "budget.set",
      newValue: "CHF 20",
      email_token: p.emailToken,
    });
    expect(w.executor.pending(w.human.id).map((x) => x.id)).toEqual([p.pendingId]);
    expect((await w.store.changeLog.list()).length).toBe(0);

    const r = done(
      await w.executor.confirmByText(p.pendingId, "yes", { kind: "human", id: w.human.id }),
    );
    expect(r.sentence).toBe(
      "Raised the session budget for PharmaWatch from CHF 5 to CHF 20. Undo.",
    );
    expect((await w.store.humanRequest.mustGet(p.pendingId)).status).toBe("answered");
    expect(w.executor.pending(w.human.id)).toEqual([]);
    const project = await w.store.project.mustGet(w.pharma.id);
    expect(project.settings.session_cap_usd_micro).toBe(25_000_000);
    expect(project.settings.session_cap_chf_micro).toBe(20_000_000);
    await w.store.close();
  });

  it("a no cancels and nothing changes; a reply that is neither is reported", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx(),
      }),
    );
    const neither = refused(
      await w.executor.confirmByText(p.pendingId, "maybe later", { kind: "human", id: w.human.id }),
    );
    expect(neither.reason).toMatch(/not a yes or a no/);
    const r = await w.executor.confirmByText(p.pendingId, "nein", {
      kind: "human",
      id: w.human.id,
    });
    expect(r.status).toBe("cancelled");
    expect((await w.store.humanRequest.mustGet(p.pendingId)).status).toBe("answered");
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings.session_cap_usd_micro,
    ).toBeUndefined();
    expect((await w.store.changeLog.list()).length).toBe(0);
    await w.store.close();
  });

  it("a pending confirmation expires after ten minutes", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx(),
      }),
    );
    await w.clock.advance(10 * 60 * 1000 + 1);
    await settle();
    expect((await w.store.humanRequest.mustGet(p.pendingId)).status).toBe("expired");
    const r = refused(
      await w.executor.confirm(p.pendingId, { kind: "yes", by: { kind: "human", id: w.human.id } }),
    );
    expect(r.code).toBe("not_found");
    await w.store.close();
  });

  it("an email reply with the token confirms a medium change", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx(),
      }),
    );
    expect(
      refused(await w.executor.confirmByToken("FR-nope", { kind: "human", id: w.human.id })).code,
    ).toBe("not_found");
    done(await w.executor.confirmByToken(p.emailToken, { kind: "human", id: w.human.id }));
    await w.store.close();
  });

  it("high risk needs a paired device: chat yes, email reply and a phone without biometric are refused", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "capability.grant",
        params: { extension: "browser", permissions: ["read_pages"] },
        ctx: w.ctx(),
      }),
    );
    expect(p.decision).toBe("needs_device");
    expect(p.readback).toContain("paired device");
    const human = { kind: "human", id: w.human.id } as const;
    const yes = refused(await w.executor.confirmByText(p.pendingId, "yes", human));
    expect(yes.reason).toMatch(/A chat or email yes alone is not enough/i);
    expect(yes.pendingId).toBe(p.pendingId);
    expect(refused(await w.executor.confirmByToken(p.emailToken, human)).reason).toMatch(
      /paired device/,
    );
    expect(
      refused(
        await w.executor.confirmFromDevice(p.pendingId, { deviceId: w.phone.id, biometric: false }),
      ).reason,
    ).toMatch(/biometric/);
    expect(await w.store.extension.byName("capability", "browser")).toBeUndefined();
    expect(w.executor.getPending(p.pendingId)).toBeDefined();

    const r = done(
      await w.executor.confirmFromDevice(p.pendingId, { deviceId: w.phone.id, biometric: true }),
    );
    expect(r.sentence).toBe("Granted browser the permission read_pages. Undo.");
    const ext = await w.store.extension.byName("capability", "browser");
    expect(ext?.permissions).toEqual(["read_pages"]);
    expect(ext?.enabled).toBe(true);
    const req = await w.store.humanRequest.mustGet(p.pendingId);
    expect(req.answer).toMatchObject({
      verdict: "confirmed",
      kind: "device",
      device_id: w.phone.id,
      biometric: true,
    });
    await w.store.close();
  });

  it("a paired desktop confirms high risk without biometric; a revoked device does not", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "email.mode.set",
        params: { mode: "allowlist" },
        ctx: w.ctx(),
      }),
    );
    await w.store.device.revoke(w.phone.id, w.phone.version);
    expect(
      refused(
        await w.executor.confirmFromDevice(p.pendingId, { deviceId: w.phone.id, biometric: true }),
      ).reason,
    ).toMatch(/revoked/);
    done(
      await w.executor.confirmFromDevice(p.pendingId, { deviceId: w.desktop.id, biometric: false }),
    );
    await w.store.close();
  });

  it("an agent changing its own limits needs a human yes even at low risk, and its own yes is refused", async () => {
    const w = await world();
    const agentCtx = w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "api" });
    const p = pending(
      await w.executor.execute({ name: "autonomy.set", params: { level: 2 }, ctx: agentCtx }),
    );
    expect(p.decision).toBe("needs_yes");
    expect(p.card.impact.risk).toBe("low");
    expect(
      refused(
        await w.executor.confirm(p.pendingId, {
          kind: "yes",
          by: { kind: "agent", id: w.agent.id },
        }),
      ).reason,
    ).toMatch(/only a human/);
    const r = done(
      await w.executor.confirm(p.pendingId, { kind: "tap", by: { kind: "human", id: w.human.id } }),
    );
    const row = await w.store.changeLog.mustGet(r.changeLogId);
    expect(row.agent_id).toBe(w.agent.id);
    expect(row.author_agent).toBe(w.agent.id);
    await w.store.close();
  });

  it("one-click undo restores the state, logs the undo and cannot run twice", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "project.switch",
        params: { project: w.supplement.id },
        ctx: w.ctx(),
      }),
    );
    const u = done(await w.executor.undo(r.changeLogId, w.ctx({ wordsUsed: "undo" })));
    expect(u.sentence).toBe("Undone: the active project is back to PharmaWatch.");
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.pharma.id,
    );
    const original = await w.store.changeLog.mustGet(r.changeLogId);
    expect(original.undo_state).toBe("undone");
    expect(original.undone_at).toBe(w.clock.nowIso());
    const undoRow = await w.store.changeLog.mustGet(u.changeLogId);
    expect(undoRow.commands).toEqual([{ name: "undo", params: { change_log_id: r.changeLogId } }]);
    expect(undoRow.undo_state).toBe("irreversible");
    expect(refused(await w.executor.undo(r.changeLogId, w.ctx())).reason).toMatch(
      /no longer be undone/,
    );
    expect(
      refused(
        await w.executor.undo(r.changeLogId, w.ctx({ actor: { kind: "agent", id: w.agent.id } })),
      ).reason,
    ).toMatch(/only a human/);
    await w.store.close();
  });

  it("undo works from the change log alone after a restart", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "project.switch",
        params: { project: w.game.id },
        ctx: w.ctx(),
      }),
    );
    const fresh = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
    done(await fresh.undo(r.changeLogId, w.ctx()));
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.pharma.id,
    );
    await w.store.close();
  });

  it("a temporary budget reverts at 06:00 on the clock and the revert is logged and posted", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20, until: TOMORROW_0600 },
        ctx: w.ctx({ wordsUsed: "give it 20 francs tonight" }),
      }),
    );
    const r = done(
      await w.executor.confirmByText(p.pendingId, "ja", { kind: "human", id: w.human.id }),
    );
    expect(r.sentence).toBe(
      "Raised tonight's session budget for PharmaWatch from CHF 5 to CHF 20, until 06:00. Undo.",
    );
    const row = await w.store.changeLog.mustGet(r.changeLogId);
    expect(row.expires_at).toBe(TOMORROW_0600);
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings[SESSION_OVERRIDE_KEY],
    ).toMatchObject({
      cap_usd_micro: 25_000_000,
      cap_chf_micro: 20_000_000,
      expires_at: TOMORROW_0600,
    });
    expect((await w.executor.undoable(w.human.id)).map((x) => x.id)).toEqual([r.changeLogId]);

    await w.clock.advance(9 * 60 * 60 * 1000);
    await settle();
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings[SESSION_OVERRIDE_KEY],
    ).toMatchObject({ cap_usd_micro: 25_000_000 });

    await w.clock.advance(60 * 60 * 1000);
    await settle();
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();
    expect((await w.store.changeLog.mustGet(r.changeLogId)).undo_state).toBe("expired");
    const rows = await w.store.changeLog.list();
    const revert = rows.find((x) => x.id !== r.changeLogId);
    expect(revert?.sentence).toBe(
      "Reverted tonight's session budget for PharmaWatch to CHF 5; the window until 06:00 ended.",
    );
    expect(revert?.undo_state).toBe("irreversible");
    expect(revert?.commands).toEqual([
      {
        name: "budget.set",
        params: { scope: "session", amountChf: 20, until: TOMORROW_0600 },
        revert_of: r.changeLogId,
      },
    ]);
    const inbox = await w.store.message.inbox({ humanId: w.human.id });
    expect(inbox.map((m) => m.body)).toContain(revert?.sentence);
    expect(await w.executor.undoable(w.human.id)).toEqual([]);
    await w.store.close();
  });

  it("undoing a temporary change before its window closes cancels the scheduled revert", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20, until: TOMORROW_0600 },
        ctx: w.ctx(),
      }),
    );
    const r = done(
      await w.executor.confirmByText(p.pendingId, "yes", { kind: "human", id: w.human.id }),
    );
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    await w.clock.advance(12 * 60 * 60 * 1000);
    await settle();
    const rows = await w.store.changeLog.list();
    expect(rows.map((x) => x.undo_state).sort()).toEqual(["irreversible", "undone"]);
    expect(rows.some((x) => x.sentence.startsWith("Reverted"))).toBe(false);
    await w.store.close();
  });

  it("after a restart, due windows are reverted and open ones re-armed from the change log", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20, until: TOMORROW_0600 },
        ctx: w.ctx(),
      }),
    );
    const r = done(
      await w.executor.confirmByText(p.pendingId, "yes", { kind: "human", id: w.human.id }),
    );
    w.executor.stop();
    await w.clock.advance(11 * 60 * 60 * 1000);
    await settle();
    expect((await w.store.changeLog.mustGet(r.changeLogId)).undo_state).toBe("undoable");
    const fresh = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
    const out = await fresh.resumeScheduled(() => w.ctx());
    expect(out).toEqual({ reverted: 1, scheduled: 0 });
    expect((await w.store.changeLog.mustGet(r.changeLogId)).undo_state).toBe("expired");
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();
    const revert = (await w.store.changeLog.list()).find((x) => x.id !== r.changeLogId);
    expect(revert?.sentence).toMatch(/^Reverted: Raised tonight's session budget/);
    await w.store.close();
  });

  it("compose runs several commands as one card, one confirmation and one change log entry", async () => {
    const w = await world();
    const p = pending(
      await w.executor.compose(
        [
          { name: "project.switch", params: { project: "supplement site" } },
          { name: "budget.set", params: { scope: "session", amountChf: 20, until: TOMORROW_0600 } },
        ],
        w.ctx({ wordsUsed: "Work on the supplement site now and give it 20 francs tonight" }),
      ),
    );
    expect(p.card.command).toBe("compose");
    expect(p.card.parts?.map((c) => c.command)).toEqual(["project.switch", "budget.set"]);
    expect(p.card.parts?.[1]?.projectName).toBe("Supplement Site");
    expect(p.card.impact.risk).toBe("medium");
    const r = done(
      await w.executor.confirmByText(p.pendingId, "yes", { kind: "human", id: w.human.id }),
    );
    expect(r.sentence).toBe(
      "Switched the active project to Supplement Site. Undo. Raised tonight's session budget for Supplement Site from CHF 5 to CHF 20, until 06:00. Undo.",
    );
    const rows = await w.store.changeLog.list();
    expect(rows.length).toBe(1);
    expect(rows[0]?.commands.map((c) => (c as { name: string }).name)).toEqual([
      "project.switch",
      "budget.set",
    ]);
    expect(Array.isArray(rows[0]?.before)).toBe(true);
    expect(rows[0]?.expires_at).toBe(TOMORROW_0600);
    expect(
      (await w.store.project.mustGet(w.supplement.id)).settings[SESSION_OVERRIDE_KEY],
    ).toMatchObject({ cap_chf_micro: 20_000_000 });
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();

    done(await w.executor.undo(r.changeLogId, w.ctx()));
    expect(
      (await w.store.project.mustGet(w.supplement.id)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.pharma.id,
    );
    await w.store.close();
  });

  it("compose rolls back the earlier steps when a later one fails", async () => {
    const w = await world();
    w.ports.failStart = new Error("scheduler down");
    const r = await w.executor.compose(
      [
        { name: "project.switch", params: { project: w.game.id } },
        { name: "session.start", params: { budgetChf: 1 } },
      ],
      w.ctx(),
    );
    expect(r.status).toBe("refused");
    expect((r as { reason: string }).reason).toMatch(/scheduler down/);
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.pharma.id,
    );
    expect((await w.store.changeLog.list()).length).toBe(0);
    await w.store.close();
  });

  it("changes on a shared project are posted to the other human", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "note.add",
        params: { text: "ship the level editor", project: "game" },
        ctx: w.ctx(),
      }),
    );
    const theirs = await w.store.message.inbox({ humanId: w.other.id });
    expect(theirs.map((m) => m.body)).toEqual([`Joel: ${r.sentence}`]);
    expect(theirs[0]?.project_id).toBe(w.game.id);
    await w.store.close();
  });

  it("the settings screen path: a card already confirmed by a tap runs in one call, high risk still needs the device", async () => {
    const w = await world();
    const by = { kind: "human", id: w.human.id } as const;
    done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx({ source: "ui" }),
        confirmation: { kind: "tap", by },
      }),
    );
    const high = refused(
      await w.executor.execute({
        name: "capability.grant",
        params: { extension: "browser", permissions: ["click"] },
        ctx: w.ctx({ source: "ui" }),
        confirmation: { kind: "yes", by },
      }),
    );
    expect(high.code).toBe("approval_required");
    done(
      await w.executor.execute({
        name: "capability.grant",
        params: { extension: "browser", permissions: ["click"] },
        ctx: w.ctx({ source: "ui" }),
        confirmation: { kind: "device", deviceId: w.desktop.id, biometric: false },
      }),
    );
    await w.store.close();
  });

  it("unknown commands and invalid parameters are refused before anything runs", async () => {
    const w = await world();
    expect(
      refused(await w.executor.execute({ name: "nope.cmd", params: {}, ctx: w.ctx() })).code,
    ).toBe("not_found");
    const bad = refused(
      await w.executor.execute({ name: "budget.set", params: { scope: "session" }, ctx: w.ctx() }),
    );
    expect(bad.code).toBe("validation");
    expect((await w.store.changeLog.list()).length).toBe(0);
    await w.store.close();
  });
});

describe("CommandExecutor: the confirmation and undo belong to the human the change is for", () => {
  it("another human's yes, tap or email reply does not confirm a pending change", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx(),
      }),
    );
    const mara = { kind: "human", id: w.other.id } as const;
    const yes = refused(await w.executor.confirm(p.pendingId, { kind: "yes", by: mara }));
    expect(yes.code).toBe("approval_required");
    expect(yes.reason).toMatch(/the human the change is for/);
    expect(refused(await w.executor.confirm(p.pendingId, { kind: "tap", by: mara })).code).toBe(
      "approval_required",
    );
    expect(refused(await w.executor.confirmByToken(p.emailToken, mara)).code).toBe(
      "approval_required",
    );
    expect(
      refused(
        await w.executor.confirmFromDevice(
          p.pendingId,
          { deviceId: w.desktop.id, biometric: false },
          mara,
        ),
      ).code,
    ).toBe("approval_required");
    expect(w.executor.getPending(p.pendingId)).toBeDefined();
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings.session_cap_usd_micro,
    ).toBeUndefined();
    expect((await w.store.changeLog.list()).length).toBe(0);
    done(
      await w.executor.confirm(p.pendingId, { kind: "yes", by: { kind: "human", id: w.human.id } }),
    );
    await w.store.close();
  });

  it("another human cannot undo or revert a change", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "project.switch",
        params: { project: w.supplement.id },
        ctx: w.ctx(),
      }),
    );
    const maraCtx = w.ctx({ actor: { kind: "human", id: w.other.id }, humanId: w.other.id });
    const u = refused(await w.executor.undo(r.changeLogId, maraCtx));
    expect(u.code).toBe("approval_required");
    expect(u.reason).toMatch(/another human/);
    await expect(w.executor.revert(r.changeLogId, maraCtx)).rejects.toSatisfy((e) =>
      isForerunnerError(e, "approval_required"),
    );
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.supplement.id,
    );
    expect((await w.store.changeLog.mustGet(r.changeLogId)).undo_state).toBe("undoable");
    expect((await w.store.changeLog.list()).length).toBe(1);
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    await w.store.close();
  });

  it("a double tap on the phone runs a high-risk change once", async () => {
    const w = await world();
    const p = pending(
      await w.executor.execute({
        name: "capability.grant",
        params: { extension: "browser", permissions: ["read_pages"] },
        ctx: w.ctx(),
      }),
    );
    const tap = () =>
      w.executor.confirmFromDevice(p.pendingId, { deviceId: w.phone.id, biometric: true });
    const results = await Promise.all([tap(), tap()]);
    expect(results.map((x) => x.status).sort()).toEqual(["done", "refused"]);
    const second = results.find((x) => x.status === "refused") as Extract<
      ExecuteResult,
      { status: "refused" }
    >;
    expect(second.reason).toMatch(/already being answered|no pending confirmation/);
    expect((await w.store.changeLog.list()).length).toBe(1);
    expect((await w.store.extension.byName("capability", "browser"))?.permissions).toEqual([
      "read_pages",
    ]);
    await w.store.close();
  });

  it("the settings-screen path never accepts an email answer: there is no token before the card", async () => {
    const w = await world();
    const by = { kind: "human", id: w.human.id } as const;
    for (const token of ["", "FR-abcdef"]) {
      const r = refused(
        await w.executor.execute({
          name: "budget.set",
          params: { scope: "session", amountChf: 20 },
          ctx: w.ctx({ source: "ui" }),
          confirmation: { kind: "email", token, by },
        }),
      );
      expect(r.code).toBe("approval_required");
      expect(r.reason).toMatch(/email reply/);
    }
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings.session_cap_usd_micro,
    ).toBeUndefined();
    expect((await w.store.changeLog.list()).length).toBe(0);
    await w.store.close();
  });

  it("a yes on a pending change is re-checked against the current state; a risen risk is refused", async () => {
    const w = await world();
    const by = { kind: "human", id: w.human.id } as const;
    const p = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx(),
      }),
    );
    expect(p.decision).toBe("needs_yes");
    // Meanwhile the monthly ceiling drops below CHF 20 (lowering it is medium: a tap suffices).
    done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "month", amountChf: 10 },
        ctx: w.ctx({ source: "ui" }),
        confirmation: { kind: "tap", by },
      }),
    );
    const r = refused(await w.executor.confirm(p.pendingId, { kind: "yes", by }));
    expect(r.code).toBe("approval_required");
    expect(r.reason).toMatch(/now needs confirmation in the app on a paired device/);
    expect(w.executor.getPending(p.pendingId)).toBeUndefined();
    expect((await w.store.humanRequest.mustGet(p.pendingId)).status).toBe("answered");
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings.session_cap_usd_micro,
    ).toBeUndefined();
    expect((await w.store.changeLog.list()).map((x) => x.commands.length)).toEqual([1]);
    // Asking again gives a card at the new risk.
    const again = pending(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 20 },
        ctx: w.ctx(),
      }),
    );
    expect(again.decision).toBe("needs_device");
    await w.store.close();
  });
});
