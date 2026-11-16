import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import {
  CHAT_TASK_RULES,
  ConversationAgent,
  type ConversationDeps,
} from "../src/conversation/agent.ts";
import { FIX_TASKS_DESCRIPTION } from "../src/conversation/task-fix-tool.ts";
import { CommandLoop } from "../src/loop/commands.ts";
import {
  type TaskCheckDeps,
  taskCheckSystem,
  withTaskCheckLock,
} from "../src/session/task-check.ts";
import { flatPricing, harness } from "./helpers.ts";

/**
 * d1109-selftasks-chat (run C, ADR 0119): "fix the tasks" from chat. The owner (2026-11-09): "I
 * would also like that being talking to the agent would also allow the agent to have dynamic
 * control over its tasks", "the agent changes its own tasks, the autonomy level deciding when it
 * asks first", "each change shown with one Undo". Composed as chat-guard.test.ts composes the
 * chat (the real LoopAgentDriver and hooks, the real command loop, a scripted provider), with
 * the agent's task check wired as compose wires it. What the model is SENT, what the person
 * reads and what the store holds are asserted.
 */

const ROLE = "You are the project manager.";
const SPECIALISTS = [{ name: "coder", tools: ["cc:Read", "cc:Write", "cc:Edit"] }];

/** The check's reply: a split, a missing step before "Publish the page", a priority. */
const THREE = JSON.stringify({
  changes: [
    {
      kind: "split",
      task: "Style the page",
      parts: [
        { title: "Style the page: layout", acceptanceCriteria: ["the layout is a grid"] },
        { title: "Style the page: colours", acceptanceCriteria: ["the colours match the logo"] },
      ],
      order: "in_turn",
      why: "It is two jobs.",
    },
    {
      kind: "add",
      title: "Check the links",
      outcome: "Every link on the page works",
      acceptanceCriteria: ["no link is broken"],
      specialist: "coder",
      after: ["Create the page"],
      before: ["Publish the page"],
      why: "Nothing checks the links.",
    },
    { kind: "edit", task: "Publish the page", priority: "high", why: "It is the goal." },
  ],
  flagged: [],
  why: "Three changes.",
});
const NONE = JSON.stringify({ changes: [], flagged: [], why: "Nothing is wrong." });
const ASK_THREE =
  'Make these 3 changes to the tasks of Quote page? Split "Style the page" into "Style the page: layout" and "Style the page: colours"; add "Check the links" before "Publish the page"; reword "Publish the page".';

interface World {
  store: StateStore;
  human: string;
  alice: string;
  quote: string;
  provider: FakeProvider;
  commands: CommandLoop;
  agent: ConversationAgent;
  tasks: Record<string, TaskRow>;
  restart(): Promise<void>;
  chat(text: string, opts?: { projectId?: string | null }): ReturnType<ConversationAgent["chat"]>;
  /** The provider calls labelled as the task check. */
  checks(): FakeProvider["calls"];
  titles(): Promise<[string, string][]>;
}

async function setup(
  opts: {
    level?: number;
    replies?: ScriptedReply[];
    agentDeps?: Partial<ConversationDeps>;
    check?: boolean;
  } = {},
): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const human = (
    await store.human.insert({
      name: "Robin",
      email: "robin@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 0,
      locale: "en",
    })
  ).id;
  const alice = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const quote = (
    await store.project.insert({
      name: "Quote page",
      goal: "A page that shows a random quote",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 0,
      autonomy_level: opts.level ?? 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  const task = (title: string, over: Record<string, unknown> = {}) =>
    store.task.insert({
      project_id: quote,
      milestone_id: null,
      title,
      outcome: `${title}.`,
      acceptance_criteria: [],
      risk_tier: 1,
      status: "ready",
      priority: 50,
      depends_on: [],
      budget_usd_micro: 0,
      specialist: "coder",
      reason: "From the plan",
      // The plan's tasks are the agent's own (the fence asks first for the person's).
      author_agent: alice,
      ...over,
    } as never);
  const create = await task("Create the page", { status: "done" });
  const style = await task("Style the page", {
    acceptance_criteria: ["the layout is a grid", "the colours match the logo"],
    depends_on: [create.id],
  });
  const publish = await task("Publish the page", { depends_on: [style.id] });
  const provider = new FakeProvider({
    replies: opts.replies ?? [],
    clock: h.clock,
    latency: "none",
  });
  const driver = new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock });
  const check: TaskCheckDeps = {
    store,
    clock: h.clock,
    tokens: h.tokens,
    driver,
    provider: () => provider,
    model: () => "fake-sonnet",
    pricing: () => flatPricing,
    billingSourceId: "bs",
    rolePrompt: ROLE,
    specialists: () => SPECIALISTS,
  };
  const build = async () => {
    const commands = new CommandLoop({
      store,
      clock: h.clock,
      ports: { chfPerUsd: async () => 0.8 },
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
      hooksDriver: driver,
      modelId: "fake-haiku",
      commands,
      chfPerUsd: () => 0.8,
      ...(opts.check === false ? {} : { taskCheck: check }),
      ...opts.agentDeps,
    });
    return { commands, agent };
  };
  const built = await build();
  const w: World = {
    store,
    human,
    alice,
    quote,
    provider,
    commands: built.commands,
    agent: built.agent,
    tasks: { create, style, publish },
    restart: async () => {
      w.commands.stop();
      const next = await build();
      w.commands = next.commands;
      w.agent = next.agent;
    },
    chat: (text, o = {}) =>
      w.agent.chat({
        humanId: human,
        agentId: alice,
        ...(o.projectId === null ? {} : { projectId: o.projectId ?? quote, projectTab: true }),
        text,
        source: "text",
      }),
    checks: () => provider.calls.filter((c) => c.request.origin?.label?.startsWith("task-check")),
    titles: async () =>
      (await store.task.forProject(quote, {}, { limit: 100 }))
        .map((t) => [t.title, t.status] as [string, string])
        .sort((a, b) => a[0].localeCompare(b[0])),
  };
  return w;
}

const messageOf = (c: FakeProvider["calls"][number] | undefined): string => {
  const m = c?.request.messages[0]?.content;
  return typeof m === "string"
    ? m
    : Array.isArray(m)
      ? m.map((b) => ("text" in b ? String(b.text) : "")).join("")
      : "";
};

describe("d1109-selftasks-chat, run C: 'fix the tasks' with the autonomy rule (SC-1, SC-3)", () => {
  it("at Standard the parser runs one check with the person's words (no chat call before it), makes each change at once with its own Undo, as the agent, with no Inbox line", async () => {
    const w = await setup({ replies: [textReply(THREE)] });
    const r = await w.chat("fix the tasks");
    expect(r.reply).toBe("I changed 3 tasks of Quote page.");
    // One model call, the check's: no chat-model call before the planning call.
    expect(w.provider.calls).toHaveLength(1);
    expect(w.checks()).toHaveLength(1);
    const call = w.checks()[0];
    expect(call?.request.system).toBe(taskCheckSystem(ROLE, ["coder"], { fromChat: true }));
    // The person's message, verbatim, in its own envelope (never text a model wrote).
    expect(messageOf(call)).toContain(
      'The person asked, in their words:\n<<<UNTRUSTED_CONTENT source=unknown origin="the person\'s message"\nfix the tasks\nUNTRUSTED_CONTENT>>>',
    );
    // Three action rows, each with its Undo; the footer says what the check cost, in CHF.
    expect(r.actions.map((a) => [a.summary, !!a.undoToken])).toEqual([
      ['Split "Style the page" into "Style the page: layout" and "Style the page: colours".', true],
      ['Added "Check the links" before "Publish the page".', true],
      [expect.stringMatching(/^Changed "Publish the page"/), true],
    ]);
    expect(r.footer).toBe("Checking the tasks cost less than CHF 0.01.");
    expect(r.reply).not.toMatch(/[0-9a-f]{8}-|01[0-9a-z]{20}|ready|needs_human/);
    // Three Changes rows: source chat, the person's words, the agent's (never "by you").
    const rows = await w.store.changeLog.list({ project_id: w.quote } as never, { limit: 20 });
    expect(rows.map((x) => [x.source, x.words_used, x.author_agent, x.author_human])).toEqual([
      ["chat", "fix the tasks", w.alice, null],
      ["chat", "fix the tasks", w.alice, null],
      ["chat", "fix the tasks", w.alice, null],
    ]);
    // No Inbox line: chat's reply tells it.
    expect(await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).toEqual([]);
    expect(await w.titles()).toEqual([
      ["Check the links", "ready"],
      ["Create the page", "done"],
      ["Publish the page", "ready"],
      ["Style the page: colours", "ready"],
      ["Style the page: layout", "ready"],
    ]);
    // The split and the step say the agent made them, on the row (SC-12).
    const tasks = await w.store.task.forProject(w.quote, {}, { limit: 100 });
    expect(tasks.find((t) => t.title === "Style the page: colours")?.reason).toBe(
      'Split from "Style the page" by the agent',
    );
    // One Undo takes back only its own change: the priority goes back, the split stays.
    const edit = r.actions[2];
    const undone = await w.commands.undo(edit?.undoToken ?? "", {
      humanId: w.human,
      agentId: w.alice,
      activeProjectId: w.quote,
      sessionId: "s",
      source: "text",
      wordsUsed: "undo",
    });
    expect(undone.status).toBe("done");
    expect((await w.store.task.mustGet(w.tasks.publish?.id ?? "")).priority).toBe(
      w.tasks.publish?.priority,
    );
    expect(await w.titles()).toContainEqual(["Style the page: layout", "ready"]);
  });

  it("'räum die Aufgaben auf' and 'tidy up the task list' run the same check; 'fix the login task' is not it", async () => {
    const w = await setup({ replies: [textReply(NONE, { times: 3 })] });
    expect((await w.chat("räum die Aufgaben auf")).reply).toBe(
      "The tasks of Quote page look right; nothing changed.",
    );
    expect((await w.chat("tidy up the task list")).reply).toBe(
      "The tasks of Quote page look right; nothing changed.",
    );
    expect(w.checks()).toHaveLength(2);
    await w.chat("fix the login task");
    expect(w.checks()).toHaveLength(2);
  });

  it("at Assisted the set is ONE read-back with Yes and No; Yes makes it as one row with one Undo; one card in the Inbox", async () => {
    const w = await setup({ level: 1, replies: [textReply(THREE)] });
    const r = await w.chat("fix the tasks");
    expect(r.reply).toBe(ASK_THREE);
    expect(r.pendingConfirmation?.readback).toBe(ASK_THREE);
    expect(await w.titles()).toContainEqual(["Style the page", "ready"]);
    const open = await w.store.humanRequest.open({ humanId: w.human });
    expect(open).toHaveLength(1);
    const yes = await w.chat("yes");
    expect(yes.actions).toHaveLength(1);
    expect(yes.actions[0]?.undoToken).toBeTruthy();
    const rows = await w.store.changeLog.list({ project_id: w.quote } as never, { limit: 20 });
    expect(rows.map((x) => [x.source, x.author_agent])).toEqual([["chat", w.alice]]);
    expect(await w.titles()).toContainEqual(["Check the links", "ready"]);
    expect(w.checks()).toHaveLength(1);
  });

  it("at Assisted No changes nothing", async () => {
    const w = await setup({ level: 1, replies: [textReply(THREE)] });
    await w.chat("fix the tasks");
    const before = await w.titles();
    await w.chat("no");
    expect(await w.titles()).toEqual(before);
    expect(await w.store.changeLog.list({ project_id: w.quote } as never, { limit: 5 })).toEqual(
      [],
    );
  });

  it("a Yes after a restart makes the read-back set with no second task check", async () => {
    const w = await setup({ level: 1, replies: [textReply(THREE)] });
    await w.chat("fix the tasks");
    await w.restart();
    const yes = await w.chat("yes");
    expect(yes.actions).toHaveLength(1);
    expect(await w.titles()).toContainEqual(["Style the page: colours", "ready"]);
    expect(w.checks()).toHaveLength(1);
    // Still the agent's change after the restart: no Inbox line for the person's own yes.
    expect(await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).toEqual([]);
  });

  it("at Standard, after a lookup returned records, the same request is read back (recordsRead); the check gets the person's line, never the model's words", async () => {
    const w = await setup({
      replies: [
        toolReply("task_get", { task: "Style the page" }, "Looking it up."),
        toolReply("fix_tasks", {}, "Checking."),
        textReply(THREE),
        textReply("I asked you about the changes."),
      ],
    });
    const r = await w.chat("look at Style the page, then tidy the tasks up as you see fit");
    expect(r.pendingConfirmation?.readback).toBe(ASK_THREE);
    expect(await w.titles()).toContainEqual(["Style the page", "ready"]);
    expect(messageOf(w.checks()[0])).toContain(
      "\nlook at Style the page, then tidy the tasks up as you see fit\n",
    );
    // SC-2: the chat model's tools carry fix_tasks with its definition (project only) and
    // task_split; its system part carries CHAT_TASK_RULES.
    const first = w.provider.calls[0]?.request;
    const fix = first?.tools?.find((t) => t.name === "fix_tasks");
    expect(fix?.description).toBe(FIX_TASKS_DESCRIPTION);
    expect(Object.keys((fix?.input_schema as { properties?: object })?.properties ?? {})).toEqual([
      "project",
    ]);
    expect(first?.tools?.some((t) => t.name === "task_split")).toBe(true);
    expect(first?.system).toContain(CHAT_TASK_RULES);
    // The tool result the model read is words, never an id.
    const results = JSON.stringify(w.provider.calls[3]?.request.messages ?? []);
    expect(results).toContain("Make these 3 changes to the tasks of Quote page?");
    expect(results).not.toMatch(/"pendingId"|01[0-9A-Z]{20}/);
  });
});

describe("d1109-selftasks-chat, run C: what stops a check (SC-1, SC-4)", () => {
  it("without Claude: 'Fixing the tasks needs Claude.' and nothing changes", async () => {
    const w = await setup({ check: false });
    expect((await w.chat("fix the tasks")).reply).toBe("Fixing the tasks needs Claude.");
    expect(w.provider.calls).toHaveLength(0);
  });

  it("a check that would pass the project's budget makes no call", async () => {
    const w = await setup({
      replies: [textReply(THREE)],
      agentDeps: { chatRoom: async () => ({ usdMicro: 10, level: "project" }) },
    });
    expect((await w.chat("fix the tasks")).reply).toBe(
      "Fixing the tasks would pass this project's budget; nothing changed.",
    );
    expect(w.provider.calls).toHaveLength(0);
  });

  it("a second 'fix the tasks' while one runs starts no second check", async () => {
    const w = await setup({ replies: [textReply(THREE)] });
    let release = () => {};
    const held = withTaskCheckLock(w.quote, () => new Promise<void>((r) => (release = r)));
    try {
      expect((await w.chat("fix the tasks")).reply).toBe(
        "The agent is checking the tasks of Quote page now; ask again in a moment.",
      );
      expect(w.provider.calls).toHaveLength(0);
    } finally {
      release();
      await held;
    }
  });

  it("SC-11: in Talk with no project on screen it asks which project, then runs on the one named", async () => {
    const w = await setup({ replies: [textReply(NONE)] });
    await w.store.project.insert({
      name: "Bakery site",
      goal: "A site",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 0,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    });
    const asked = await w.chat("fix the tasks", { projectId: null });
    expect(asked.reply).toBe("Which project: Quote page or Bakery site?");
    expect(w.provider.calls).toHaveLength(0);
    const answered = await w.chat("Quote page", { projectId: null });
    expect(answered.reply).toBe("The tasks of Quote page look right; nothing changed.");
    expect(messageOf(w.checks()[0])).toContain("\nfix the tasks\n");
  });
});

describe("d1109-selftasks-chat, run C: several changes the person names are one read-back (SC-5)", () => {
  it("task_update and task_dependencies in one turn: one question naming both, one card, Yes makes both as one row with one Undo", async () => {
    const w = await setup({
      replies: [
        toolReply("task_update", { task: "Publish the page", priority: "high" }, "Raising it."),
        toolReply("task_dependencies", { task: "Publish the page", depends_on: [] }, "Unlinking."),
        textReply("Both are waiting for your yes."),
      ],
    });
    const r = await w.chat("Publish the page is urgent and should not wait on anything.");
    const readback = r.pendingConfirmation?.readback ?? "";
    expect(readback).toMatch(/^Change .+ and .+\?$/);
    expect(readback.split("?")).toHaveLength(2);
    // One open card for the turn: the separate ones never stay in the Inbox.
    const open = await w.store.humanRequest.open({ humanId: w.human });
    expect(open).toHaveLength(1);
    const yes = await w.chat("yes");
    expect(yes.actions).toHaveLength(1);
    expect(yes.actions[0]?.undoToken).toBeTruthy();
    const publish = await w.store.task.mustGet(w.tasks.publish?.id ?? "");
    expect(publish.depends_on).toEqual([]);
    expect(publish.priority).not.toBe(w.tasks.publish?.priority);
  });
});
