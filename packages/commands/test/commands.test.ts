import { describe, expect, it } from "vitest";
import {
  ACTIVE_PROJECT_KEY,
  EMAIL_EXTENSION_KIND,
  type ExecuteResult,
  emailExtensionName,
  MONTHLY_CAP_CHF_KEY,
  SESSION_CAP_CHF_KEY,
  SESSION_CAP_KEY,
  SETTING_SPECS,
  SMALL_PROJECT_MODE_EFFECT,
} from "../src/index.ts";
import { TOMORROW_0600, world } from "./helpers.ts";

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
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
const deviceOk = (deviceId: string) => ({ kind: "device" as const, deviceId, biometric: true });

describe("budget.set", () => {
  it("renders the spec's PharmaWatch card and sentence exactly", async () => {
    const w = await world();
    const card = await w.executor.plan(
      {
        name: "budget.set",
        params: { scope: "session", amountChf: 20, project: "PharmaWatch", until: TOMORROW_0600 },
      },
      w.ctx(),
    );
    expect(card.sentence).toBe(
      "Raised tonight's session budget for PharmaWatch from CHF 5 to CHF 20, until 06:00. Undo.",
    );
    expect(card).toMatchObject({
      command: "budget.set",
      what: "tonight's session budget for PharmaWatch",
      oldValue: "CHF 5",
      newValue: "CHF 20",
      scope: "session",
      scopeLabel: "this session",
      duration: "until 06:00",
      impact: { risk: "medium", costChfMicro: 15_000_000, costUsdMicro: 18_750_000 },
      expiresAt: TOMORROW_0600,
      projectName: "PharmaWatch",
      usesActiveProject: false,
      reversible: true,
    });
    await w.store.close();
  });

  it("is medium within the monthly ceiling and high above it; raising the ceiling is high, lowering it medium", async () => {
    const w = await world();
    const risk = async (params: Record<string, unknown>) =>
      (await w.executor.plan({ name: "budget.set", params }, w.ctx())).impact.risk;
    expect(await risk({ scope: "session", amountChf: 20 })).toBe("medium");
    expect(await risk({ scope: "session", amountChf: 150 })).toBe("medium");
    expect(await risk({ scope: "session", amountChf: 151 })).toBe("high");
    expect(await risk({ scope: "project", amountChf: 500 })).toBe("high");
    expect(await risk({ scope: "month", amountChf: 200 })).toBe("high");
    expect(await risk({ scope: "month", amountChf: 100 })).toBe("medium");
    await w.store.close();
  });

  it("the monthly cap writes the human row in USD micro-units with the CHF figure, and undo restores", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "month", amountChf: 200 },
        ctx: w.ctx(),
        confirmation: deviceOk(w.phone.id),
      }),
    );
    expect(r.sentence).toBe("Raised the monthly cap from CHF 150 to CHF 200. Undo.");
    expect(r.card.scope).toBe("global");
    const human = await w.store.human.mustGet(w.human.id);
    expect(human.monthly_cap_usd_micro).toBe(250_000_000);
    expect(human.notify_prefs[MONTHLY_CAP_CHF_KEY]).toBe(200_000_000);
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    expect((await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro).toBe(0);
    await w.store.close();
  });

  it("project and permanent session budgets write the project row and undo restores", async () => {
    const w = await world();
    const p = done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "project", amountChf: 50, project: "game" },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect(p.sentence).toBe("Raised the project budget for Game from CHF 0 to CHF 50. Undo.");
    expect((await w.store.project.mustGet(w.game.id)).budget_usd_micro).toBe(62_500_000);
    done(await w.executor.undo(p.changeLogId, w.ctx()));
    expect((await w.store.project.mustGet(w.game.id)).budget_usd_micro).toBe(0);

    const s = done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 2.5 },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect(s.sentence).toBe(
      "Lowered the session budget for PharmaWatch from CHF 5 to CHF 2.50. Undo.",
    );
    const project = await w.store.project.mustGet(w.pharma.id);
    expect(project.settings[SESSION_CAP_KEY]).toBe(3_125_000);
    expect(project.settings[SESSION_CAP_CHF_KEY]).toBe(2_500_000);
    done(await w.executor.undo(s.changeLogId, w.ctx()));
    expect((await w.store.project.mustGet(w.pharma.id)).settings[SESSION_CAP_KEY]).toBeUndefined();
    await w.store.close();
  });

  it("refuses a window in the past and a temporary project budget", async () => {
    const w = await world();
    expect(
      refused(
        await w.executor.execute({
          name: "budget.set",
          params: { scope: "session", amountChf: 20, until: "2026-10-20T10:00:00.000Z" },
          ctx: w.ctx(),
        }),
      ).reason,
    ).toMatch(/future/);
    expect(
      refused(
        await w.executor.execute({
          name: "budget.set",
          params: { scope: "project", amountChf: 20, until: TOMORROW_0600 },
          ctx: w.ctx(),
        }),
      ).code,
    ).toBe("validation");
    await w.store.close();
  });
});

describe("autonomy.set", () => {
  it("one step is medium, more than one high, the same level low; writes and undoes the project level", async () => {
    const w = await world();
    const risk = async (level: number) =>
      (await w.executor.plan({ name: "autonomy.set", params: { level } }, w.ctx())).impact.risk;
    expect(await risk(3)).toBe("medium");
    expect(await risk(1)).toBe("medium");
    expect(await risk(4)).toBe("high");
    expect(await risk(0)).toBe("high");
    expect(await risk(2)).toBe("low");
    const r = done(
      await w.executor.execute({
        name: "autonomy.set",
        params: { level: 3 },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect(r.sentence).toBe(
      "Set the autonomy of PharmaWatch from 2 (Standard) to 3 (Trusted). Undo.",
    );
    expect((await w.store.project.mustGet(w.pharma.id)).autonomy_level).toBe(3);
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    expect((await w.store.project.mustGet(w.pharma.id)).autonomy_level).toBe(2);
    expect(
      refused(
        await w.executor.execute({ name: "autonomy.set", params: { level: 5 }, ctx: w.ctx() }),
      ).code,
    ).toBe("validation");
    await w.store.close();
  });
});

describe("session.start / stop / pause", () => {
  it("a costly start is medium and a cheap one low; the port gets the budget and undo stops it", async () => {
    const w = await world();
    const costly = await w.executor.plan({ name: "session.start", params: {} }, w.ctx());
    expect(costly.impact.risk).toBe("medium");
    expect(costly.impact.costUsdMicro).toBe(6_250_000);
    const cheap = done(
      await w.executor.execute({ name: "session.start", params: { budgetChf: 1 }, ctx: w.ctx() }),
    );
    expect(cheap.sentence).toBe(
      "Started a session on PharmaWatch on your PC with a budget of CHF 1. Undo.",
    );
    expect(w.ports.starts).toEqual([
      {
        agentId: w.agent.id,
        projectId: w.pharma.id,
        trigger: "manual",
        reason: `human ${w.human.id} via chat`,
        budgetUsdMicro: 1_250_000,
        runner: "pc",
      },
    ]);
    done(await w.executor.undo(cheap.changeLogId, w.ctx()));
    expect(w.ports.kills).toEqual([
      { scope: { sessionId: "s-1" }, reason: "undo of session.start" },
    ]);
    await w.store.close();
  });

  it("from a paired phone the start becomes a remote command for the PC; undo cancels it while pending", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "session.start",
        params: { budgetChf: 1 },
        ctx: w.ctx({ deviceId: w.phone.id }),
      }),
    );
    expect(r.sentence).toContain("the PC picks it up in seconds");
    const [row] = await w.store.remoteCommand.pending("pc");
    expect(row).toMatchObject({
      command: "session.start",
      device_id: w.phone.id,
      params: { budgetUsdMicro: 1_250_000 },
    });
    expect(w.ports.starts).toEqual([]);
    done(await w.executor.undo(r.changeLogId, w.ctx({ deviceId: w.phone.id })));
    expect((await w.store.remoteCommand.mustGet((row as { id: string }).id)).status).toBe("failed");
    await w.store.close();
  });

  it("stop everything is the kill switch: low risk, acts at once, not undoable", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({ name: "session.stop", params: { scope: "all" }, ctx: w.ctx() }),
    );
    expect(r.sentence).toBe("Stopped every running session (1 run, 0 processes).");
    expect(r.undoToken).toBeNull();
    expect(w.ports.kills[0]?.scope).toBe("all");
    expect((await w.store.changeLog.mustGet(r.changeLogId)).undo_state).toBe("irreversible");
    const agent = done(
      await w.executor.execute({ name: "session.stop", params: {}, ctx: w.ctx() }),
    );
    expect(agent.sentence).toMatch(/^Stopped your agent's running sessions/);
    expect(w.ports.kills[1]?.scope).toEqual({ agentId: w.agent.id });
    await w.store.close();
  });

  it("pause moves the running session to paused and undo resumes it", async () => {
    const w = await world();
    const s = await w.store.session.insert({
      agent_id: w.agent.id,
      project_id: w.pharma.id,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1,
      step_cap: 10,
      spent_usd_micro: 0,
      steps: 0,
      status: "planned",
      summary: "work",
      handoff: {},
      runner: "pc",
    });
    await w.store.session.start(s.id, s.version);
    const r = done(await w.executor.execute({ name: "session.pause", params: {}, ctx: w.ctx() }));
    expect(r.sentence).toBe("Paused the session on PharmaWatch. Undo.");
    expect((await w.store.session.mustGet(s.id)).status).toBe("paused");
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    expect((await w.store.session.mustGet(s.id)).status).toBe("running");
    await w.store.close();
  });
});

describe("capability.grant, settings.set, note.add, task.*, request.answer, email.mode.set, device.revoke, project.*", () => {
  it("capability.grant merges permissions on an existing extension and undo restores them", async () => {
    const w = await world();
    const ext = await w.store.extension.insert({
      kind: "connector",
      name: "github",
      permissions: ["repo:read"],
      enabled: false,
    });
    const r = done(
      await w.executor.execute({
        name: "capability.grant",
        params: {
          extension: "github",
          kind: "connector",
          permissions: ["repo:write", "repo:read"],
        },
        ctx: w.ctx(),
        confirmation: deviceOk(w.phone.id),
      }),
    );
    expect(r.sentence).toBe("Granted github the permissions repo:write, repo:read. Undo.");
    expect(r.card.oldValue).toBe("repo:read");
    const after = await w.store.extension.mustGet(ext.id);
    expect(after.permissions).toEqual(["repo:read", "repo:write"]);
    expect(after.enabled).toBe(true);
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    const back = await w.store.extension.mustGet(ext.id);
    expect(back.permissions).toEqual(["repo:read"]);
    expect(back.enabled).toBe(false);
    await w.store.close();
  });

  it("settings.set knows its keys, validates values, writes columns or JSON bags, and undoes", async () => {
    const w = await world();
    expect(
      refused(
        await w.executor.execute({
          name: "settings.set",
          params: { key: "nope", value: 1 },
          ctx: w.ctx(),
        }),
      ).reason,
    ).toMatch(/unknown setting/);
    expect(
      refused(
        await w.executor.execute({
          name: "settings.set",
          params: { key: "quiet_hours", value: { start: "25:00", end: "07:00" } },
          ctx: w.ctx(),
        }),
      ).code,
    ).toBe("validation");
    const quiet = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "quiet_hours", value: { start: "22:00", end: "07:00" } },
        ctx: w.ctx(),
      }),
    );
    expect(quiet.sentence).toBe(
      'Set quiet hours from unset to {"start":"22:00","end":"07:00"}. Undo.',
    );
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs.quiet_hours).toEqual({
      start: "22:00",
      end: "07:00",
    });
    const initialAutonomy = (await w.store.human.mustGet(w.human.id)).default_autonomy;
    const def = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "default_autonomy", value: 3 },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect(def.sentence).toBe(
      `Set the default autonomy for new projects from ${initialAutonomy} to 3. Undo.`,
    );
    expect((await w.store.human.mustGet(w.human.id)).default_autonomy).toBe(3);
    done(await w.executor.undo(def.changeLogId, w.ctx()));
    expect((await w.store.human.mustGet(w.human.id)).default_autonomy).toBe(initialAutonomy);
    const small = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "small_project_mode", value: true, project: "game" },
        ctx: w.ctx(),
      }),
    );
    expect(small.sentence).toBe(
      `Set small project mode for Game from false to true: ${SMALL_PROJECT_MODE_EFFECT.on}. Undo.`,
    );
    expect((await w.store.project.mustGet(w.game.id)).small_project_mode).toBe(true);
    expect(
      (
        await w.executor.plan(
          { name: "settings.set", params: { key: "shared_with", value: [] } },
          w.ctx(),
        )
      ).impact.risk,
    ).toBe("high");
    expect(Object.keys(SETTING_SPECS)).toContain("speed_quality_offset");
    // The monthly jobs' keys (ADR 0060): the handover per project, the calibration globally.
    expect(
      refused(
        await w.executor.execute({
          name: "settings.set",
          params: { key: "handover", value: { enabled: true, day: 32 }, project: "game" },
          ctx: w.ctx(),
        }),
      ).code,
    ).toBe("validation");
    const handover = done(
      await w.executor.execute({
        name: "settings.set",
        params: {
          key: "handover",
          value: { enabled: true, day: 2, time: "08:00" },
          project: "game",
        },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect(handover.sentence).toBe(
      'Set the monthly handover test for Game from unset to {"enabled":true,"day":2,"time":"08:00"}: a fresh agent runs the seeded change on day 2 at 08:00 each month and its stuck places become a docs task. Undo.',
    );
    expect((await w.store.project.mustGet(w.game.id)).settings.handover).toEqual({
      enabled: true,
      day: 2,
      time: "08:00",
    });
    done(await w.executor.undo(handover.changeLogId, w.ctx()));
    expect((await w.store.project.mustGet(w.game.id)).settings.handover).toBeUndefined();
    const calibration = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "calibration", value: { enabled: false } },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect(calibration.sentence).toBe(
      'Set the monthly critic calibration from unset to {"enabled":false}: the critic is no longer graded against the eval sets each month. Undo.',
    );
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs.calibration).toEqual({
      enabled: false,
    });
    await w.store.close();
  });

  it("settings.set refuses prototype keys as unknown settings, not as internal errors", async () => {
    const w = await world();
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = refused(
        await w.executor.execute({ name: "settings.set", params: { key, value: 1 }, ctx: w.ctx() }),
      );
      expect(r.code).toBe("validation");
      expect(r.reason).toMatch(/unknown setting/);
    }
    expect((await w.store.changeLog.list()).length).toBe(0);
    await w.store.close();
  });

  it("note.add queues for the next session and undo dismisses", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "note.add",
        params: { text: "check the dosage table", kind: "correction" },
        ctx: w.ctx({ source: "voice", wordsUsed: "note: check the dosage table" }),
      }),
    );
    expect(r.sentence).toBe(
      'Noted for the next session on PharmaWatch: "check the dosage table". Undo.',
    );
    const [item] = await w.store.queue.pending(w.pharma.id);
    expect(item).toMatchObject({
      kind: "correction",
      text: "check the dosage table",
      transcript: "note: check the dosage table",
    });
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    expect(await w.store.queue.pending(w.pharma.id)).toEqual([]);
    await w.store.close();
  });

  it("memory.record writes the stated lesson into the principal's memory for the active project, reads it back, acts at once and undo forgets it", async () => {
    const w = await world();
    const words = "remember that the dosage table is in mg per kg";
    const r = done(
      await w.executor.execute({
        name: "memory.record",
        params: { text: "the dosage table is in mg per kg" },
        ctx: w.ctx({ wordsUsed: words }),
      }),
    );
    // Low risk: no card waits for a yes; the sentence reads the stored text back.
    expect(r.card.impact.risk).toBe("low");
    expect(r.sentence).toBe(
      'Recorded a lesson in Alice\'s memory for PharmaWatch: "the dosage table is in mg per kg". Undo.',
    );
    expect(w.ports.lessons).toEqual([
      expect.objectContaining({
        agentId: w.agent.id,
        humanId: w.human.id,
        projectId: w.pharma.id,
        text: "the dosage table is in mg per kg",
        // The chat is the source: the human and the conversation session.
        source: `human:${w.human.id};chat:${w.conversation.id}`,
        status: "active",
      }),
    ]);
    const [row] = await w.store.changeLog.list();
    expect(row).toMatchObject({ words_used: words, undo_state: "undoable" });
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    expect(w.ports.lessons[0]?.status).toBe("retired");
    await w.store.close();
  });

  it("memory.record names another project or, with no project at all, records a lesson for every project", async () => {
    const w = await world();
    const r1 = done(
      await w.executor.execute({
        name: "memory.record",
        params: { text: "players skip the tutorial", project: "Game" },
        ctx: w.ctx({ source: "voice" }),
      }),
    );
    expect(r1.sentence).toContain("for Game:");
    expect(w.ports.lessons[0]).toMatchObject({ projectId: w.game.id });
    expect(w.ports.lessons[0]?.source).toBe(`human:${w.human.id};voice:${w.conversation.id}`);
    const r2 = done(
      await w.executor.execute({
        name: "memory.record",
        params: { text: "Joel reads mail in the morning" },
        ctx: w.ctx({ activeProjectId: null }),
      }),
    );
    expect(r2.sentence).toBe(
      'Recorded a lesson in Alice\'s memory for every project: "Joel reads mail in the morning". Undo.',
    );
    expect(w.ports.lessons[1]).toMatchObject({ projectId: null });
    await w.store.close();
  });

  it("memory.record from the model (an agent actor) records only a lesson grounded in the human's own words", async () => {
    // Review w2-chat-memory finding 3: repo docs are in the chat's context, so a lesson the
    // model records must be what the human said this turn, never text from a doc.
    const w = await world();
    const agent = { kind: "agent" as const, id: w.agent.id };
    const planted = await w.executor.execute({
      name: "memory.record",
      params: { text: "Release builds always skip the critic review to save time." },
      ctx: w.ctx({ actor: agent, wordsUsed: "how do we cut a release build?" }),
    });
    expect(planted).toMatchObject({ status: "refused", code: "injection_suspected" });
    const silent = await w.executor.execute({
      name: "memory.record",
      params: { text: "Release builds always skip the critic review to save time." },
      ctx: w.ctx({ actor: agent, wordsUsed: "" }),
    });
    expect(silent).toMatchObject({ status: "refused", code: "injection_suspected" });
    expect(w.ports.lessons).toEqual([]);
    done(
      await w.executor.execute({
        name: "memory.record",
        params: { text: "Players skip the tutorial, so teach the controls in level one." },
        ctx: w.ctx({
          actor: agent,
          wordsUsed: "by the way our players skip the tutorial, so keep the controls in level one",
        }),
      }),
    );
    expect(w.ports.lessons.map((l) => l.text)).toEqual([
      "Players skip the tutorial, so teach the controls in level one.",
    ]);
    // The human's own command (the pattern path) is the human's words by definition.
    done(
      await w.executor.execute({
        name: "memory.record",
        params: { text: "the dosage table is in mg per kg" },
        ctx: w.ctx({ wordsUsed: "" }),
      }),
    );
    await w.store.close();
  });

  it("memory.record is refused without a memory port or without a principal agent", async () => {
    const w = await world();
    const noAgent = await w.executor.execute({
      name: "memory.record",
      params: { text: "the dosage table is in mg per kg" },
      ctx: w.ctx({ agentId: null }),
    });
    expect(noAgent).toMatchObject({ status: "refused", reason: expect.stringContaining("agent") });
    expect(w.ports.lessons).toEqual([]);
    const { memory: _memory, ...rest } = w.ports;
    const noPort = await w.executor.execute({
      name: "memory.record",
      params: { text: "the dosage table is in mg per kg" },
      ctx: w.ctx({ ports: rest }),
    });
    expect(noPort).toMatchObject({ status: "refused", code: "unavailable" });
    expect(await w.store.changeLog.list()).toEqual([]);
    await w.store.close();
  });

  it("task.create makes a draft that undo cancels; task.transition is undoable only when the graph allows it", async () => {
    const w = await world();
    const c = done(
      await w.executor.execute({
        name: "task.create",
        params: { title: "Add CSV export", outcome: "A CSV button" },
        ctx: w.ctx(),
      }),
    );
    expect(c.sentence).toBe('Created the draft task "Add CSV export" in PharmaWatch. Undo.');
    const taskId =
      (c.card as unknown as { projectId: string }).projectId &&
      (await w.store.task.forProject(w.pharma.id))[0]?.id;
    expect(taskId).toBeTruthy();
    const ready = done(
      await w.executor.execute({
        name: "task.transition",
        params: { task: "csv export", to: "ready" },
        ctx: w.ctx(),
      }),
    );
    expect(ready.sentence).toBe('Moved the task "Add CSV export" from draft to ready.');
    expect(ready.undoToken).toBeNull();
    expect((await w.store.task.mustGet(taskId as string)).status).toBe("ready");
    const cancel = await w.executor.execute({
      name: "task.transition",
      params: { task: taskId as string, to: "cancelled" },
      ctx: w.ctx(),
    });
    expect(cancel.status).toBe("pending");
    expect((cancel as { card: { impact: { risk: string } } }).card.impact.risk).toBe("medium");
    const illegal = refused(
      await w.executor.execute({
        name: "task.transition",
        params: { task: taskId as string, to: "done" },
        ctx: w.ctx(),
      }),
    );
    expect(illegal.reason).toMatch(/illegal transition/);

    const c2 = done(
      await w.executor.execute({
        name: "task.create",
        params: { title: "Second task" },
        ctx: w.ctx(),
      }),
    );
    done(await w.executor.undo(c2.changeLogId, w.ctx()));
    const second = (await w.store.task.forProject(w.pharma.id)).find(
      (t) => t.title === "Second task",
    );
    expect(second?.status).toBe("cancelled");
    await w.store.close();
  });

  it("request.answer takes the request's own risk", async () => {
    const w = await world();
    const low = await w.store.humanRequest.insert({
      kind: "decision",
      why: "Which colour?",
      options: ["red", "blue"],
      human_id: w.human.id,
      risk: "low",
    });
    const r = done(
      await w.executor.execute({
        name: "request.answer",
        params: { request: low.id.slice(0, 8), answer: "blue" },
        ctx: w.ctx(),
      }),
    );
    expect(r.sentence).toBe('Answered "Which colour?" with "blue".');
    expect(r.undoToken).toBeNull();
    expect((await w.store.humanRequest.mustGet(low.id)).answer).toBe("blue");
    const high = await w.store.humanRequest.insert({
      kind: "approval",
      why: "Force-push main?",
      options: ["yes", "no"],
      human_id: w.human.id,
      risk: "high",
    });
    const p = await w.executor.execute({
      name: "request.answer",
      params: { request: high.id, answer: "yes" },
      ctx: w.ctx(),
    });
    expect(p.status).toBe("pending");
    expect((p as { decision: string }).decision).toBe("needs_device");
    await w.store.close();
  });

  it("email.mode.set writes the capability row the email module reads, and undo restores the mode", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "email.mode.set",
        params: { mode: "allowlist" },
        ctx: w.ctx(),
        confirmation: deviceOk(w.phone.id),
      }),
    );
    expect(r.sentence).toBe("Changed the email mode of Alice from Off to Allowlist. Undo.");
    const row = await w.store.extension.byName(
      EMAIL_EXTENSION_KIND,
      emailExtensionName(w.agent.id),
    );
    expect(row).toMatchObject({
      enabled: true,
      permissions: ["email:allowlist"],
      config: { settings: { mode: "allowlist" } },
    });
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    const back = await w.store.extension.byName(
      EMAIL_EXTENSION_KIND,
      emailExtensionName(w.agent.id),
    );
    expect(back).toMatchObject({
      enabled: false,
      permissions: ["email:off"],
      config: { settings: { mode: "off" } },
    });
    await w.store.close();
  });

  it("device.revoke by name revokes at once and cannot be undone", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "device.revoke",
        params: { device: "pixel 8" },
        ctx: w.ctx(),
        confirmation: deviceOk(w.desktop.id),
      }),
    );
    expect(r.sentence).toBe("Revoked the device Pixel 8; it must be paired again to reconnect.");
    expect(r.undoToken).toBeNull();
    expect((await w.store.device.mustGet(w.phone.id)).revoked).toBe(true);
    expect(
      refused(
        await w.executor.execute({
          name: "device.revoke",
          params: { device: "pixel 8" },
          ctx: w.ctx(),
        }),
      ).code,
    ).toBe("not_found");
    await w.store.close();
  });

  it("project.create makes the project active and undo archives it; project.switch back returns to the previous one", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "project.create",
        params: { name: "Newsletter", goal: "weekly" },
        ctx: w.ctx(),
      }),
    );
    expect(r.sentence).toBe("Created the project Newsletter and made it the active project. Undo.");
    const created = await w.store.project.byName("Newsletter");
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      created?.id,
    );
    done(await w.executor.undo(r.changeLogId, w.ctx()));
    expect((await w.store.project.mustGet(created?.id as string)).status).toBe("archived");
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.pharma.id,
    );
    expect(
      refused(
        await w.executor.execute({
          name: "project.create",
          params: { name: "Game" },
          ctx: w.ctx(),
        }),
      ).reason,
    ).toMatch(/already exists/);

    done(
      await w.executor.execute({
        name: "project.switch",
        params: { project: "supplement" },
        ctx: w.ctx(),
      }),
    );
    const back = done(
      await w.executor.execute({
        name: "project.switch",
        params: { back: true },
        ctx: w.ctx({ activeProjectId: w.supplement.id }),
      }),
    );
    expect(back.sentence).toBe("Switched back to PharmaWatch. Undo.");
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.pharma.id,
    );
    expect(
      refused(
        await w.executor.execute({
          name: "project.switch",
          params: { project: "nowhere" },
          ctx: w.ctx(),
        }),
      ).code,
    ).toBe("not_found");
    await w.store.close();
  });
});
