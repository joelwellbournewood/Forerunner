import { describe, expect, it } from "vitest";
import {
  ACTIVE_PROJECT_KEY,
  type ExecuteResult,
  IntentParser,
  SESSION_OVERRIDE_KEY,
} from "../src/index.ts";
import { START, TOMORROW_0600, TZ, world } from "./helpers.ts";

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

describe("spec R: from the Android app a simulated user switches project, raises a budget and starts a session on his PC", () => {
  it("one sentence -> three commands -> one change card -> one tap on the phone -> one change log entry", async () => {
    const w = await world();
    const text =
      "switch to the game, give it 15 francs until tomorrow and start a session on my PC";
    const parsed = await new IntentParser(w.registry).parse(text, {
      source: "chat",
      timezone: TZ,
      now: Date.parse(START),
      activeProjectId: w.pharma.id,
      projects: [w.pharma, w.supplement, w.game].map((p) => ({ id: p.id, name: p.name })),
    });
    expect(parsed.commands.map((c) => c.name)).toEqual([
      "project.switch",
      "budget.set",
      "session.start",
    ]);

    const phoneCtx = w.ctx({ deviceId: w.phone.id, wordsUsed: text, source: "chat" });
    const p = await w.executor.compose(parsed.commands, phoneCtx);
    if (p.status !== "pending") throw new Error(`expected pending, got ${p.status}`);
    expect(p.decision).toBe("needs_yes");
    expect(p.card.parts?.length).toBe(3);
    expect(p.card.impact.risk).toBe("medium");
    expect(p.card.parts?.[2]?.what).toBe("a session on Game on your PC");

    const r = done(
      await w.executor.confirm(p.pendingId, { kind: "tap", by: { kind: "human", id: w.human.id } }),
    );
    expect(r.sentence).toBe(
      "Switched the active project to Game. Undo. Raised tonight's session budget for Game from CHF 5 to CHF 15, until 06:00. Undo. Started a session on Game on your PC with a budget of CHF 15; the PC picks it up in seconds. Undo.",
    );
    const rows = await w.store.changeLog.list();
    expect(rows.length).toBe(1);
    expect(rows[0]?.words_used).toBe(text);
    expect(rows[0]?.commands.map((c) => (c as { name: string }).name)).toEqual([
      "project.switch",
      "budget.set",
      "session.start",
    ]);
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.game.id,
    );
    expect((await w.store.project.mustGet(w.game.id)).settings[SESSION_OVERRIDE_KEY]).toMatchObject(
      {
        cap_chf_micro: 15_000_000,
        expires_at: TOMORROW_0600,
      },
    );
    const remote = await w.store.remoteCommand.pending("pc");
    expect(remote.length).toBe(1);
    expect(remote[0]).toMatchObject({
      device_id: w.phone.id,
      command: "session.start",
      params: { agentId: w.agent.id, projectId: w.game.id, budgetUsdMicro: 18_750_000 },
    });
    expect(w.ports.starts).toEqual([]);
    // The other human on the shared project sees it.
    const theirs = await w.store.message.inbox({ humanId: w.other.id });
    expect(theirs.map((m) => m.body)).toEqual([`Joel: ${r.sentence}`]);
    await w.store.close();
  });
});

describe("phase 5 gate: every settings change can be made by voice, chat or the UI and produces the same change log entry", () => {
  it("budget.set by ui, chat and voice logs the same commands, before, after and sentence", async () => {
    const w = await world();
    const by = { kind: "human", id: w.human.id } as const;
    const params = { scope: "session", amountChf: 20 };
    const ui = done(
      await w.executor.execute({
        name: "budget.set",
        params,
        ctx: w.ctx({ source: "ui" }),
        confirmation: { kind: "tap", by },
      }),
    );
    done(await w.executor.undo(ui.changeLogId, w.ctx({ source: "ui" })));
    const chatPending = await w.executor.execute({
      name: "budget.set",
      params,
      ctx: w.ctx({ source: "chat", wordsUsed: "give it 20 francs" }),
    });
    if (chatPending.status !== "pending") throw new Error("expected pending");
    const chat = done(await w.executor.confirmByText(chatPending.pendingId, "yes", by));
    done(await w.executor.undo(chat.changeLogId, w.ctx({ source: "chat" })));
    const voicePending = await w.executor.execute({
      name: "budget.set",
      params,
      ctx: w.ctx({ source: "voice", wordsUsed: "gib ihm zwanzig Franken" }),
    });
    if (voicePending.status !== "pending") throw new Error("expected pending");
    const voice = done(await w.executor.confirmByText(voicePending.pendingId, "ja", by));
    done(await w.executor.undo(voice.changeLogId, w.ctx({ source: "voice" })));

    const rows = await Promise.all(
      [ui, chat, voice].map((r) => w.store.changeLog.mustGet(r.changeLogId)),
    );
    const shape = (r: (typeof rows)[number]) => ({
      commands: r.commands,
      before: r.before,
      after: r.after,
      scope: r.scope,
      project_id: r.project_id,
      sentence: r.sentence,
      undo_state: r.undo_state,
    });
    expect(shape(rows[1] as (typeof rows)[number])).toEqual(
      shape(rows[0] as (typeof rows)[number]),
    );
    expect(shape(rows[2] as (typeof rows)[number])).toEqual(
      shape(rows[0] as (typeof rows)[number]),
    );
    expect(rows.map((r) => r.source)).toEqual(["ui", "chat", "voice"]);
    expect(rows.map((r) => r.words_used)).toEqual([
      "",
      "give it 20 francs",
      "gib ihm zwanzig Franken",
    ]);
    await w.store.close();
  });

  it("limits still hold: an agent cannot raise its own session budget above the ceiling without a device confirmation", async () => {
    const w = await world();
    const agentCtx = w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "api" });
    const within = await w.executor.execute({
      name: "budget.set",
      params: { scope: "session", amountChf: 20 },
      ctx: agentCtx,
    });
    expect(within.status).toBe("pending");
    expect((within as { decision: string }).decision).toBe("needs_yes");
    const above = await w.executor.execute({
      name: "budget.set",
      params: { scope: "session", amountChf: 500 },
      ctx: agentCtx,
    });
    expect((above as { decision: string }).decision).toBe("needs_device");
    expect(
      (await w.store.project.mustGet(w.pharma.id)).settings.session_cap_usd_micro,
    ).toBeUndefined();
    await w.store.close();
  });
});
