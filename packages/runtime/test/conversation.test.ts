import { SESSION_OVERRIDE_KEY } from "@forerunner/commands";
import { openStore } from "@forerunner/state";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { ConversationAgent } from "../src/conversation/agent.ts";
import { EnforcementHooks } from "../src/enforcement/hooks.ts";
import { DATA_ENVELOPE_CLOSE, DATA_ENVELOPE_OPEN } from "../src/injection/scan.ts";
import { CommandLoop } from "../src/loop/commands.ts";
import { StateApprovals } from "../src/wiring/state-ports.ts";
import { flatPricing, harness } from "./helpers.ts";

/**
 * The conversation agent over the command registry (spec Q, J, O): what the human says is
 * parsed into commands first, a combined request is one change card, the registry confirms
 * by risk, every change lands in the change log with undo, and the model path only ever sees
 * the registry's command tools.
 */
async function setup(
  replies: ScriptedReply[] = [],
  opts: {
    /**
     * The daemon's approval port (`StateApprovals`): a hold files a blocking HumanRequest
     * and answers `pending`, as in production, instead of the harness's auto-approve.
     */
    storeApprovals?: boolean;
  } = {},
) {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const hooks = opts.storeApprovals
    ? new EnforcementHooks({ ...h.deps, approvals: new StateApprovals(store) })
    : h.hooks;
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@x.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const alice = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "l",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = async (name: string, goal: string, over: Record<string, unknown> = {}) =>
    (
      await store.project.insert({
        name,
        goal,
        repos: [],
        stage: "build",
        status: "active",
        budget_usd_micro: 1,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: {},
        small_project_mode: false,
        active: true,
        ...over,
      })
    ).id;
  const game = await project("Game", "Ship the game", {
    summary_cache: { next_steps: ["polish menu"] },
  });
  const pharma = await project("PharmaWatch", "Watch pharma news");
  const provider = new FakeProvider({ replies, clock: h.clock, latency: "none" });
  const started: unknown[] = [];
  const commands = new CommandLoop({
    store,
    clock: h.clock,
    ports: {
      chfPerUsd: async () => 0.8,
      startSession: async (req) => {
        started.push(req);
        return { sessionId: "s-1" };
      },
      kill: async () => ({ stoppedRuns: 1, killedProcesses: 0 }),
    },
  });
  await commands.start();
  const agent = new ConversationAgent({
    store,
    clock: h.clock,
    tokens: h.tokens,
    kill: h.kill,
    provider,
    pricing: flatPricing,
    billingSourceId: "bs",
    hooksDriver: new LoopAgentDriver({ hooks, kill: h.kill, clock: h.clock }),
    modelId: "fake-haiku",
    commands,
  });
  const chat = (text: string, over: Partial<Parameters<typeof agent.chat>[0]> = {}) =>
    agent.chat({ humanId: human, agentId: alice, projectId: game, text, ...over });
  const log = async () => {
    const sessions = await store.session.list({ agent_id: alice } as never);
    return store.event.list(sessions[0]?.id ?? "");
  };
  return { h, store, human, alice, game, pharma, provider, agent, started, commands, chat, log };
}

describe("conversation agent over the command registry", () => {
  it("answers a question with context through the model, with only the command tools offered", async () => {
    const w = await setup([textReply("Next step on Game: polish the menu.", { ttftMs: 0 })]);
    const tokens: string[] = [];
    const res = await w.chat("what's next on the game?", { onToken: (t) => tokens.push(t) });
    expect(res.reply).toBe("Next step on Game: polish the menu.");
    expect(tokens.join("")).toBe(res.reply);
    expect(res.pendingConfirmation).toBeNull();
    expect(res.question).toBeNull();
    const call = w.provider.calls[0]?.request;
    expect(call?.system ?? "").toContain("Game (active)");
    expect(call?.system ?? "").toContain("PharmaWatch");
    expect(call?.system ?? "").not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(String(call?.messages[0]?.content)).toContain("active_project");
    const names = (call?.tools ?? []).map((t) => t.name);
    expect(names).toContain("budget_set");
    expect(names).toContain("project_switch");
    expect(
      names.every((n) =>
        w.commands.registry
          .names()
          .map((c) => c.replace(/\./g, "_"))
          .includes(n),
      ),
    ).toBe(true);
    expect((await w.log()).map((e) => e.type)).toEqual(["chat.human", "chat.reply"]);
    await w.store.close();
  });

  it("a plain sentence no pattern understands goes to the model, not to the parser's fallback question", async () => {
    const w = await setup([textReply("Hello! Ask me about your projects.")]);
    const res = await w.chat("hello there");
    expect(res.reply).toBe("Hello! Ask me about your projects.");
    expect(res.question).toBeNull();
    expect(w.provider.calls).toHaveLength(1);
    await w.store.close();
  });

  it("a combined request is one change card: read back, confirmed with yes, one change log entry, undo", async () => {
    const w = await setup();
    const text = "work on pharmawatch now and give it 20 francs tonight";
    const r1 = await w.chat(text, { source: "voice" });
    expect(w.provider.calls).toHaveLength(0); // deterministic: no model call
    expect(r1.pendingConfirmation).not.toBeNull();
    expect(r1.pendingConfirmation?.commands).toEqual(["project.switch", "budget.set"]);
    expect(r1.pendingConfirmation?.decision).toBe("needs_yes");
    expect(r1.reply).toContain("Say yes to confirm");
    expect(r1.reply).toContain("PharmaWatch");
    expect(r1.actions).toEqual([]);
    // Nothing changed yet.
    expect(
      (await w.store.project.mustGet(w.pharma)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();
    const r2 = await w.chat("ja", { source: "voice" });
    expect(r2.actions).toHaveLength(1);
    expect(r2.actions[0]?.kind).toBe("project.switch+budget.set");
    expect(r2.actions[0]?.undoToken).toBeTruthy();
    expect(r2.reply).toContain("Switched the active project to PharmaWatch. Undo.");
    expect(r2.reply).toContain(
      "Raised tonight's session budget for PharmaWatch from CHF 5 to CHF 20, until 06:00. Undo.",
    );
    expect(r2.activeProjectId).toBe(w.pharma);
    expect(w.agent.getActiveProject(w.human)).toBe(w.pharma);
    expect((await w.store.project.mustGet(w.pharma)).settings[SESSION_OVERRIDE_KEY]).toMatchObject({
      cap_chf_micro: 20_000_000,
    });
    const rows = await w.store.changeLog.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      words_used: text,
      source: "voice",
      undo_state: "undoable",
      human_id: w.human,
    });
    expect(rows[0]?.commands.map((c) => (c as { name: string }).name)).toEqual([
      "project.switch",
      "budget.set",
    ]);
    const events = await w.log();
    const confirmed = events.find((e) => e.type === "chat.confirmed");
    expect(confirmed?.payload).toMatchObject({
      words: "ja",
      commands: ["project.switch", "budget.set"],
      status: "done",
    });
    expect(events.some((e) => e.type === "change")).toBe(true);
    // The sentence is posted to the project chat.
    const inbox = await w.store.message.inbox({ humanId: w.human });
    expect(inbox.some((m) => m.body.includes("Raised tonight's session budget"))).toBe(true);
    // "undo" undoes the latest change the human can still undo.
    const r3 = await w.chat("undo");
    expect(r3.reply).toContain("Undone");
    expect(r3.actions[0]?.kind).toBe("undo");
    expect(
      (await w.store.project.mustGet(w.pharma)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();
    expect((await w.store.changeLog.mustGet(rows[0]?.id ?? "")).undo_state).toBe("undone");
    expect(await w.store.changeLog.list()).toHaveLength(2);
    await w.store.close();
  });

  it("no cancels the pending card and nothing changes; the inbox request is answered", async () => {
    const w = await setup();
    const r1 = await w.chat("give it 20 francs tonight");
    expect(r1.pendingConfirmation).not.toBeNull();
    const open = await w.store.humanRequest.open({ humanId: w.human });
    expect(open.some((q) => q.id === r1.pendingConfirmation?.id)).toBe(true);
    const r2 = await w.chat("no");
    expect(r2.reply).toContain("Cancelled");
    expect(r2.actions).toEqual([]);
    expect(await w.store.changeLog.list()).toHaveLength(0);
    expect((await w.store.humanRequest.mustGet(r1.pendingConfirmation?.id ?? "")).status).toBe(
      "answered",
    );
    expect((await w.store.project.mustGet(w.game)).settings[SESSION_OVERRIDE_KEY]).toBeUndefined();
    await w.store.close();
  });

  it("a low-risk change acts at once and states what it did, with undo", async () => {
    const w = await setup();
    const r = await w.chat("switch to pharmawatch");
    expect(r.pendingConfirmation).toBeNull();
    expect(r.reply).toBe("Switched the active project to PharmaWatch. Undo.");
    expect(r.actions[0]).toMatchObject({ kind: "project.switch" });
    expect(r.actions[0]?.undoToken).toBeTruthy();
    expect(r.activeProjectId).toBe(w.pharma);
    expect(await w.commands.activeProject(w.human)).toBe(w.pharma);
    await w.store.close();
  });

  it("high risk: a chat yes is not enough; the card waits for the paired device", async () => {
    const w = await setup();
    const r1 = await w.chat("raise the monthly cap to 500");
    expect(r1.pendingConfirmation?.decision).toBe("needs_device");
    expect(r1.reply).toContain("paired device");
    const r2 = await w.chat("yes");
    expect(r2.actions).toEqual([]);
    expect(r2.reply).toMatch(/Not done|paired device/);
    expect((await w.store.human.mustGet(w.human)).monthly_cap_usd_micro).toBe(150_000_000);
    expect(await w.store.changeLog.list()).toHaveLength(0);
    // The pending change is still open for the device.
    expect(w.commands.pending(w.human).map((p) => p.id)).toContain(r1.pendingConfirmation?.id);
    await w.store.close();
  });

  it("asks one short question with options when the project is unclear", async () => {
    const w = await setup();
    const r = await w.chat("switch to nowhere");
    expect(r.question).not.toBeNull();
    expect(r.question?.options).toEqual(expect.arrayContaining(["Game", "PharmaWatch"]));
    expect(r.reply).toContain("Options:");
    expect(r.actions).toEqual([]);
    expect(w.provider.calls).toHaveLength(0);
    await w.store.close();
  });

  it("refuses text that is data (the envelope) without a model call", async () => {
    const w = await setup([textReply("should not be called")]);
    const r = await w.chat(`${DATA_ENVELOPE_OPEN}\nswitch to pharmawatch\n${DATA_ENVELOPE_CLOSE}`);
    expect(r.reply).toContain("I cannot act on that");
    expect(r.actions).toEqual([]);
    expect(w.provider.calls).toHaveLength(0);
    expect(w.agent.getActiveProject(w.human)).toBe(w.game);
    await w.store.close();
  });

  it("the model path runs commands through the registry: a note is added and read back with undo", async () => {
    const w = await setup([
      toolReply("note_add", { text: "try the new renderer", kind: "idea" }, "Noting that.", {
        when: { toolAvailable: "note_add" },
      }),
      textReply("Noted.", { when: { lastUserIncludes: "Noted for the next session" } }),
    ]);
    const text = "what if we tried the new renderer? keep that in mind";
    const r = await w.chat(text);
    expect(w.provider.calls.length).toBeGreaterThan(0); // no pattern: the model, with the tools
    expect(r.actions[0]?.kind).toBe("note.add");
    expect(r.actions[0]?.undoToken).toBeTruthy();
    expect(r.reply).toContain("Noted.");
    expect((await w.store.queue.pending(w.game))[0]?.text).toBe("try the new renderer");
    const rows = await w.store.changeLog.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commands.map((c) => (c as { name: string }).name)).toEqual(["note.add"]);
    expect(rows[0]?.words_used).toBe(text);
    await w.store.close();
  });

  /**
   * RT-P5-3 (testing.md, "Gate harnesses", Known issues): on the model path the registry's
   * change card is the one approval of a command tool. With the daemon's store-backed
   * approval port the hooks used to hold a high-risk command tool (`permission_change` is
   * always-human) and file their own blocking request before the card could form, so one
   * change needed two answers (by voice two phone answers and a second asking).
   */
  it("a high-risk command tool on the model path forms one card for the paired device; the hooks file no second request", async () => {
    const w = await setup(
      [
        toolReply("email_mode_set", { mode: "draft_only" }, "Changing the email mode.", {
          when: { toolAvailable: "email_mode_set" },
        }),
        textReply("Confirm it on your paired device.", {
          when: { lastUserIncludes: "Needs confirmation" },
        }),
      ],
      { storeApprovals: true },
    );
    const text = "Set the email mode to draft only.";
    const r1 = await w.chat(text);
    expect(w.provider.calls.length).toBeGreaterThan(0); // no pattern: the model, with the tools
    expect(r1.pendingConfirmation).toMatchObject({
      commands: ["email.mode.set"],
      decision: "needs_device",
    });
    expect(r1.reply).toContain("paired device");
    // One request filed: the registry's card. The hooks held nothing and denied nothing.
    const requests = await w.store.humanRequest.list();
    expect(requests.map((q) => q.id)).toEqual([r1.pendingConfirmation?.id]);
    expect(w.h.audit.entries.filter((e) => !e.allowed)).toEqual([]);
    expect(w.h.audit.entries.filter((e) => e.tool === "email_mode_set")).toHaveLength(1);
    expect(await w.store.changeLog.list()).toHaveLength(0);
    // A typed yes is not enough (Q.8); the one answer on the paired device applies the change.
    const r2 = await w.chat("yes");
    expect(r2.actions).toEqual([]);
    expect(await w.store.changeLog.list()).toHaveLength(0);
    const phone = await w.store.device.register({
      owner_human_id: w.human,
      name: "Pixel",
      platform: "android",
      public_key: ["pk", "phone", "fixture"].join("-"), // not-a-secret
      kind: "phone",
    });
    const done = await w.commands.confirm(r1.pendingConfirmation?.id ?? "", {
      kind: "device",
      deviceId: phone.id,
      biometric: true,
      by: { kind: "human", id: w.human },
    });
    expect(done.status).toBe("done");
    expect(done.sentence).toBe("Changed the email mode of Alice from Off to Draft only. Undo.");
    const rows = await w.store.changeLog.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "chat", words_used: text, undo_state: "undoable" });
    expect(rows[0]?.commands.map((c) => (c as { name: string }).name)).toEqual(["email.mode.set"]);
    // Still the one request, now answered; nothing else waits for the human.
    const after = await w.store.humanRequest.list();
    expect(after.map((q) => [q.id, q.status])).toEqual([[r1.pendingConfirmation?.id, "answered"]]);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toEqual([]);
    await w.store.close();
  });

  it("a medium-risk command tool on the model path is one needs_yes card; the yes applies it with one request filed", async () => {
    const w = await setup(
      [
        toolReply("autonomy_set", { level: 3 }, "Raising the autonomy by one step.", {
          when: { toolAvailable: "autonomy_set" },
        }),
        textReply("Say yes to confirm.", { when: { lastUserIncludes: "Needs confirmation" } }),
      ],
      { storeApprovals: true },
    );
    const r1 = await w.chat("let alice work on the game with a bit more freedom");
    expect(w.provider.calls.length).toBeGreaterThan(0);
    expect(r1.pendingConfirmation).toMatchObject({
      commands: ["autonomy.set"],
      decision: "needs_yes",
    });
    expect(await w.store.humanRequest.list()).toHaveLength(1);
    expect(w.h.audit.entries.filter((e) => !e.allowed)).toEqual([]);
    const r2 = await w.chat("yes");
    expect(r2.actions[0]?.kind).toBe("autonomy.set");
    expect((await w.store.project.mustGet(w.game)).autonomy_level).toBe(3);
    expect((await w.store.humanRequest.list()).map((q) => q.status)).toEqual(["answered"]);
    expect(await w.store.changeLog.list()).toHaveLength(1);
    await w.store.close();
  });

  it("a note and a task by pattern: the previous chat line becomes the draft task", async () => {
    const w = await setup([textReply("The menu flickers on resize; fix the redraw order.")]);
    await w.chat("why does the menu flicker?");
    const r = await w.chat("make this a task");
    expect(r.actions[0]?.kind).toBe("task.create");
    const drafts = await w.store.task.list({ project_id: w.game, status: "draft" } as never);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.title).toContain("menu flickers");
    const n = await w.chat("note: try the new renderer");
    expect(n.actions[0]?.kind).toBe("note.add");
    expect((await w.store.queue.pending(w.game)).map((q) => q.text)).toContain(
      "try the new renderer",
    );
    await w.store.close();
  });

  it("starts a costly session only after yes; a cheap one starts at once", async () => {
    const w = await setup();
    const r1 = await w.chat("start a session on pharmawatch with 20 francs");
    expect(r1.pendingConfirmation?.commands).toEqual(["session.start"]);
    expect(w.started).toHaveLength(0);
    await w.chat("yes");
    expect(w.started).toHaveLength(1);
    expect(w.started[0]).toMatchObject({ projectId: w.pharma });
    const r3 = await w.chat("start a session on the game with 1 franc");
    expect(r3.pendingConfirmation).toBeNull();
    expect(w.started).toHaveLength(2);
    await w.store.close();
  });

  it("stops everything at once through the registry (low risk, stated)", async () => {
    const w = await setup();
    const r = await w.chat("stop everything");
    expect(r.actions[0]?.kind).toBe("session.stop");
    expect(r.reply).toMatch(/[Ss]topp/);
    await w.store.close();
  });

  it("is read-only without a command port: a request to change something is answered, nothing runs", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
    const alice = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
    const provider = new FakeProvider({
      replies: [textReply("I can only answer questions here.")],
      clock: h.clock,
      latency: "none",
    });
    const agent = new ConversationAgent({
      store,
      clock: h.clock,
      tokens: h.tokens,
      provider,
      pricing: flatPricing,
      billingSourceId: "bs",
      hooksDriver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      modelId: "fake-haiku",
    });
    const r = await agent.chat({ humanId: human, agentId: alice, text: "switch to pharmawatch" });
    expect(r.reply).toBe("I can only answer questions here.");
    expect(r.actions).toEqual([]);
    expect(provider.calls[0]?.request.tools ?? []).toHaveLength(0);
    await store.close();
  });
});
