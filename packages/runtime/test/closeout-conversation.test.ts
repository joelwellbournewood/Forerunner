import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { ConversationAgent } from "../src/conversation/agent.ts";
import { CommandLoop } from "../src/loop/commands.ts";
import { MODE_DEFAULTS, modelIdFor } from "../src/models/ladder.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { pausedSessionOf, sessionPausePorts } from "../src/wiring/session-ports.ts";
import { flatPricing, type Harness, harness } from "./helpers.ts";

/**
 * Requirements close-out for the conversation agent (spec O.2, O.6, O.8): the clauses the
 * existing `conversation.test.ts` exercises only in passing, asserted one by one against the
 * real `ConversationAgent` over the real command registry (`CommandLoop`) with the daemon's
 * own pause ports, the fake provider and the simulated clock on an in-memory store.
 *
 * - O.2: the model path runs on the `text_chat` rung at its effort over the cached layout
 *   (stable project summaries in the system prompt, the volatile facts in the turn), and the
 *   transcript lands on the principal agent's own session with the turn's cost.
 * - O.6: "answer human requests" (an open request answered through the registry's
 *   `request.answer` tool) and "pause sessions" (the registry's `session.pause` reaches the
 *   daemon's pause port: the row is paused and the message the runner reads at the next task
 *   boundary waits in the agent's inbox; "undo" resumes). Questions, notes, draft tasks,
 *   start and stop are `conversation.test.ts`.
 * - O.8: a question that needs real work is handed to the principal agent as a draft task
 *   from the chat, and once the task ran in a session the answer comes back through the
 *   inbox (the session's summary message to the human).
 */
interface World {
  h: Harness;
  store: StateStore;
  human: string;
  alice: string;
  game: string;
  provider: FakeProvider;
  agent: ConversationAgent;
  commands: CommandLoop;
  chat: (text: string) => ReturnType<ConversationAgent["chat"]>;
}

async function setup(replies: ScriptedReply[] = []): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
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
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const game = (
    await store.project.insert({
      name: "Game",
      goal: "Ship the game",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 5_000_000,
      autonomy_level: 2,
      summary_cache: { next_steps: ["polish menu"] },
      data_assets: [],
      settings: { members: [alice] },
      small_project_mode: false,
      active: true,
    })
  ).id;
  const provider = new FakeProvider({ replies, clock: h.clock, latency: "none" });
  const commands = new CommandLoop({
    store,
    clock: h.clock,
    ports: {
      chfPerUsd: async () => 0.8,
      startSession: async () => ({ sessionId: "s-1" }),
      kill: async () => ({ stoppedRuns: 1, killedProcesses: 0 }),
      // The daemon's own pause and resume ports (`compose.ts` wires the same function).
      ...sessionPausePorts({ store, kill: h.kill, agentId: alice, humanId: human }),
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
    hooksDriver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
    // No model override: the ladder's `text_chat` rung picks the model (spec O.2).
    commands,
  });
  const chat = (text: string) =>
    agent.chat({ humanId: human, agentId: alice, projectId: game, text });
  return { h, store, human, alice, game, provider, agent, commands, chat };
}

/** A running work session of the principal (not the conversation session). */
async function runningSession(w: World) {
  const row = await w.store.session.insert({
    agent_id: w.alice,
    project_id: w.game,
    trigger: "manual",
    runner: "pc",
  });
  return w.store.session.start(row.id, row.version);
}

function openRequest(w: World) {
  return w.store.humanRequest.insert({
    human_id: w.human,
    project_id: w.game,
    kind: "decision",
    why: "Pick a database",
    steps: [],
    options: ["postgres", "sqlite"],
    blocking: false,
    risk: "low",
  });
}

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

describe("conversation agent close-out (spec O.2, O.6, O.8)", () => {
  it("O.2: answers on the text_chat rung at its effort over the cached layout; the transcript and cost land on the principal's own session", async () => {
    const w = await setup([textReply("One session is running on Game.", { ttftMs: 0 })]);
    // Volatile facts the small context carries: an unread message, an open request, a session.
    await w.store.message.send({
      from_agent_id: w.alice,
      to_human_id: w.human,
      project_id: w.game,
      type: "info",
      body: "Morning summary",
      requires_ack: false,
      author_agent: w.alice,
    });
    const request = await openRequest(w);
    await runningSession(w);

    const text = "is anything running?";
    const res = await w.chat(text);
    expect(res.reply).toBe("One session is running on Game.");
    expect(w.provider.calls).toHaveLength(1);
    const call = w.provider.calls[0]?.request;
    // The fast model at low effort: the ladder's text_chat rung for this provider.
    expect(call?.model).toBe(modelIdFor(MODE_DEFAULTS.text_chat.tier, "fake"));
    expect(call?.model).toBe("fake-haiku");
    expect(call?.effort).toBe(MODE_DEFAULTS.text_chat.effort);
    expect(call?.effort).toBe("low");
    // The cached layout: the stable project summaries in the system prompt (no timestamps,
    // so the prefix is cacheable), the volatile facts in the turn itself.
    expect(call?.system ?? "").toContain("# Projects");
    expect(call?.system ?? "").toContain("Game (active): Ship the game");
    expect(call?.system ?? "").toContain("Next: polish menu");
    expect(call?.system ?? "").not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const turn = String(call?.messages[0]?.content);
    expect(turn).toContain("# Now");
    expect(turn).toContain(`- active_project: ${w.game}`);
    expect(turn).toContain("- unread_messages: 1");
    expect(turn).toContain(`- open_requests: ${request.id.slice(0, 8)}: Pick a database`);
    expect(turn).toContain("- running_sessions: 1");
    expect(turn.endsWith(text)).toBe(true);
    // The same logs as the principal: the transcript is a session of Alice's, with the cost.
    const sessions = await w.store.session.list(
      { agent_id: w.alice, trigger: "manual", summary: "conversation" } as never,
      { limit: 5 },
    );
    expect(sessions).toHaveLength(1);
    const events = await w.store.event.list(sessions[0]?.id ?? "");
    expect(events.map((e) => e.type)).toEqual(["chat.human", "chat.reply"]);
    expect(events[0]?.payload).toMatchObject({ text, source: "text" });
    const reply = events[1]?.payload as { text: string; costUsdMicro: number };
    expect(reply.text).toBe(res.reply);
    expect(reply.costUsdMicro).toBe(res.costUsdMicro);
    expect(reply.costUsdMicro).toBeGreaterThan(0);
    const first = events[0]?.payload as { transcriptId: string } | undefined;
    expect(res.transcriptId).toBe(first?.transcriptId);
    await w.store.close();
  });

  it("O.6: the registry offers every ability the clause names to the conversation", async () => {
    const w = await setup();
    const names = w.commands.registry.names();
    for (const name of [
      "note.add",
      "task.create",
      "request.answer",
      "session.start",
      "session.pause",
      "session.stop",
    ])
      expect(names).toContain(name);
    await w.store.close();
  });

  it("O.6: answers an open human request through the chat (request.answer on the registry)", async () => {
    const w = await setup();
    const row = await openRequest(w);
    w.provider.pushReplies(
      toolReply("request_answer", { request: row.id, answer: "postgres" }, "Answering it.", {
        when: { toolAvailable: "request_answer" },
      }),
      textReply("Answered with postgres.", { when: { lastUserIncludes: "Answered" } }),
    );
    const text = "answer the database question with postgres";
    const res = await w.chat(text);
    expect(w.provider.calls.length).toBeGreaterThan(0); // no pattern: the model, with the tools
    expect(res.actions[0]?.kind).toBe("request.answer");
    expect(res.reply).toContain("Answered");
    const answered = await w.store.humanRequest.mustGet(row.id);
    expect(answered.status).toBe("answered");
    expect(answered.answer).toBe("postgres");
    expect(answered.answered_by).toBe(w.human);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toHaveLength(0);
    const log = await w.store.changeLog.list();
    expect(log).toHaveLength(1);
    expect(log[0]?.commands.map((c) => (c as { name: string }).name)).toEqual(["request.answer"]);
    expect(log[0]?.words_used).toBe(text);
    await w.store.close();
  });

  it("O.6: 'pause the session' pauses the running session through the daemon's port; the runner's message waits at the task boundary; undo resumes", async () => {
    const w = await setup([textReply("should not be called")]);
    const s = await runningSession(w);
    // The session runs in this process: registered with the kill switch like a real run.
    const controller = new AbortController();
    w.h.kill.register({ agentId: w.alice, sessionId: s.id, controller, label: "run" });

    const r = await w.chat("pause the session");
    expect(w.provider.calls).toHaveLength(0); // deterministic: no model call
    expect(r.pendingConfirmation).toBeNull(); // low risk: acts at once
    expect(r.actions[0]).toMatchObject({ kind: "session.pause" });
    expect(r.actions[0]?.undoToken).toBeTruthy();
    expect(r.reply).toBe("Paused the session on Game. Undo.");
    expect((await w.store.session.mustGet(s.id)).status).toBe("paused");
    // Graceful: the task in flight was not aborted; the runner ends at the next boundary.
    expect(controller.signal.aborted).toBe(false);
    const unread = await w.store.message.inbox({ agentId: w.alice }, { unreadOnly: true });
    const pause = unread.filter((m) => pausedSessionOf(m.body) === s.id);
    expect(pause).toHaveLength(1);
    expect(pause[0]).toMatchObject({ from_agent_id: w.alice, to_agent_id: w.alice });
    // The runner's own stop-word test matches the body it will read between tasks.
    expect(/^\s*(stop|halt|pause)\b/i.test(pause[0]?.body ?? "")).toBe(true);

    const u = await w.chat("undo");
    expect(u.actions[0]?.kind).toBe("undo");
    expect((await w.store.session.mustGet(s.id)).status).toBe("running");
    const stillUnread = await w.store.message.inbox({ agentId: w.alice }, { unreadOnly: true });
    expect(stillUnread.filter((m) => pausedSessionOf(m.body) === s.id)).toHaveLength(0);
    await w.store.close();
  });

  it("O.8: real work is handed to the principal as a draft task from the chat, and the answer comes back through the inbox once a session ran it", async () => {
    const question = "which renderer should we use? compare the three options";
    const w = await setup([
      toolReply(
        "task_create",
        {
          title: "Compare the three renderers",
          outcome: "A short comparison with a recommendation",
          status: "draft",
          risk_tier: 0,
        },
        "That needs real work.",
        { when: { toolAvailable: "task_create" } },
      ),
      textReply(
        "That needs real work: I handed it to your agent as a draft task; you will hear back in the inbox.",
        { when: { lastUserIncludes: "Created the draft task" } },
      ),
    ]);
    const res = await w.chat(question);
    expect(res.actions[0]?.kind).toBe("task.create");
    expect(res.actions[0]?.undoToken).toBeTruthy();
    // It says so: the reply names the hand-over, after the registry confirmed the draft task.
    expect(res.reply).toContain("handed it to your agent as a draft task");
    expect(res.actions[0]?.summary).toContain("Created the draft task");
    const drafts = await w.store.task.list({ project_id: w.game, status: "draft" } as never);
    expect(drafts).toHaveLength(1);
    const task = drafts[0];
    if (!task) throw new Error("no draft task");
    expect(task.title).toBe("Compare the three renderers");
    const log = await w.store.changeLog.list();
    expect(log[0]?.commands.map((c) => (c as { name: string }).name)).toEqual(["task.create"]);
    expect(log[0]?.words_used).toBe(question);
    // Only the spelled-out change reached the human's inbox so far (spec Q.10), no answer:
    // the answer is the session's job.
    const inbox = async () =>
      (await w.store.message.inbox({ humanId: w.human })).filter(
        (m) => m.to_human_id === w.human && m.from_agent_id === w.alice,
      );
    const sessionSummaries = async () => (await inbox()).filter((m) => /^Session /.test(m.body));
    expect((await inbox()).map((m) => m.body)).toEqual([
      'Created the draft task "Compare the three renderers" in Game. Undo.',
    ]);
    expect(await sessionSummaries()).toHaveLength(0);

    // The human (or the PM) makes the draft ready; the principal's next session runs it.
    await w.store.task.transition(task.id, task.version, "ready", "approved from the chat");
    const executor: TaskExecutor = {
      async execute({ task: t, budget }) {
        budget.record(`run-${t.id}`, 300_000);
        return {
          outcome: "done",
          summary: "Use renderer B: fastest on both platforms.",
          costUsdMicro: 300_000,
          checksPassed: true,
        };
      },
    };
    const runner = new SessionRunner({
      store: w.store,
      clock: w.h.clock,
      tokens: w.h.tokens,
      kill: w.h.kill,
      planner: new StaticPlanner(),
      executor,
    });
    const result = await runner.start({
      agentId: w.alice,
      projectId: w.game,
      trigger: "manual",
      budgetCapUsdMicro: 2_000_000,
      grant,
    });
    expect(result.status).toBe("completed");
    expect(result.completed).toEqual([task.id]);
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    // The answer comes back through the inbox: the session's summary to the human.
    const answers = await sessionSummaries();
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ project_id: w.game, type: "info" });
    expect(answers[0]?.body).toContain("Session completed.");
    expect(answers[0]?.body).toContain("Done: 1.");
    // The next chat turn sees it among the unread messages in its small context.
    const unread = await w.store.message.inbox({ humanId: w.human }, { unreadOnly: true });
    expect(unread.map((m) => m.id)).toContain(answers[0]?.id);
    w.provider.pushReplies(textReply("Your agent recommends renderer B."));
    await w.chat("any news on the renderer?");
    expect(String(w.provider.calls.at(-1)?.request.messages[0]?.content)).toContain(
      `- unread_messages: ${unread.length}`,
    );
    await w.store.close();
  });
});
