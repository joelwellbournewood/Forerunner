import type { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import {
  CARD_EXPIRED_REPLY,
  ConversationAgent,
  cardAnsweredReply,
  YES_TO_WHAT_REPLY,
} from "../src/conversation/agent.ts";
import { readTranscript } from "../src/conversation/transcript.ts";
import { syncAnsweredCards } from "../src/loop/answered-cards.ts";
import { CommandLoop } from "../src/loop/commands.ts";
import { flatPricing, harness } from "./helpers.ts";

/**
 * The chat knows (design §3.9, core-experience.md; synthesis area "chat", U-084). The walks of
 * 2026-11-01 read the model-call log: every chat call held ONE user message (the facts and the
 * current line), so "what did I just ask?" and a "yes" reached the model with nothing before
 * them; the context had no task list, a 160-character cut of a stale summary and open cards cut
 * at 80 characters, so "what failed and why?" could not be answered; the Chat tab and Talk kept
 * separate lines while the daemon kept one transcript for every project, so "undo" in one
 * project cancelled a task in another. Scripted provider; what the model is SENT is asserted.
 */

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  quote: string;
  notes: string;
  provider: FakeProvider;
  commands: CommandLoop;
  agent: ConversationAgent;
  chat: (text: string, projectId?: string | null) => ReturnType<ConversationAgent["chat"]>;
  /** The messages of the i-th model call. */
  messages: (i: number) => { role: string; content: string }[];
  /** The turn's last user message: the facts, the blocks and the line. */
  last: (i: number) => string;
  /** A new agent on the same store: what a daemon restart leaves. */
  restart: (replies?: ScriptedReply[]) => ConversationAgent;
}

const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : "")).join("")
      : "";

async function setup(replies: ScriptedReply[] = []): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const human = (
    await store.human.insert({
      name: "Robin",
      email: "robin@example.test",
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
  const project = async (name: string, goal: string) =>
    (
      await store.project.insert({
        name,
        goal,
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
      })
    ).id;
  const quote = await project("Quote Page", "A page that shows a random quote");
  const notes = await project("Notes CLI", "A command line notes tool");
  const provider = new FakeProvider({ replies, clock: h.clock, latency: "none" });
  const commands = new CommandLoop({
    store,
    clock: h.clock,
    ports: {
      chfPerUsd: async () => 0.8,
      startSession: async () => ({ startId: "start-1" }),
      kill: async () => ({ stoppedRuns: 0, killedProcesses: 0 }),
    },
  });
  await commands.start();
  const make = (p: FakeProvider) =>
    new ConversationAgent({
      store,
      clock: h.clock,
      tokens: h.tokens,
      kill: h.kill,
      provider: p,
      pricing: flatPricing,
      billingSourceId: "bs",
      hooksDriver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      modelId: "fake-haiku",
      commands,
    });
  const w: World = {
    store,
    clock: h.clock,
    human,
    alice,
    quote,
    notes,
    provider,
    commands,
    agent: make(provider),
    chat: (line, projectId = quote) =>
      w.agent.chat({
        humanId: human,
        agentId: alice,
        ...(projectId ? { projectId, projectTab: true } : {}),
        text: line,
        source: "text",
      }),
    messages: (i) =>
      (w.provider.calls[i]?.request.messages ?? []).map((m) => ({
        role: m.role,
        content: text(m.content),
      })),
    last: (i) => text(w.provider.calls[i]?.request.messages.at(-1)?.content),
    restart: (more = []) => {
      w.provider = new FakeProvider({ replies: more, clock: h.clock, latency: "none" });
      w.agent = make(w.provider);
      return w.agent;
    },
  };
  return w;
}

async function task(
  w: World,
  title: string,
  over: Partial<Parameters<StateStore["task"]["insert"]>[0]> = {},
) {
  return w.store.task.insert({
    project_id: w.quote,
    milestone_id: null,
    title,
    outcome: `${title}.`,
    acceptance_criteria: [],
    risk_tier: 1,
    status: "ready",
    priority: 50,
    depends_on: [],
    budget_usd_micro: 0,
    specialist: null,
    reason: "",
    ...over,
  });
}

describe("the chat remembers the conversation (design §3.9)", () => {
  it("the second turn carries the first: 'what did I just ask?' is sent with the earlier question and answer", async () => {
    const w = await setup([
      textReply("Two tasks are done; one is waiting.", { ttftMs: 0 }),
      textReply("You asked what is going on.", { ttftMs: 0 }),
    ]);
    await w.chat("what is going on?");
    await w.chat("what did I just ask?");
    const second = w.messages(1);
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[0]?.content).toBe("what is going on?");
    expect(second[1]?.content).toBe("Two tasks are done; one is waiting.");
    // The line and the facts are the turn's own last message, after the history.
    expect(second[2]?.content).toContain("# Now");
    // The line first, then the facts (the leftovers of wave 7: the line is the cached start).
    expect(second[2]?.content.startsWith("what did I just ask?")).toBe(true);
    await w.store.close();
  });

  it("each project has its own conversation: a line in Notes CLI is never in Quote Page's history", async () => {
    const w = await setup([
      textReply("Quote answer.", { ttftMs: 0 }),
      textReply("Notes answer.", { ttftMs: 0 }),
      textReply("Quote again.", { ttftMs: 0 }),
    ]);
    await w.chat("how is the quote page?", w.quote);
    await w.chat("how are the notes?", w.notes);
    await w.chat("and now?", w.quote);
    expect(
      w
        .messages(1)
        .map((m) => m.content)
        .join("\n"),
    ).not.toContain("quote page");
    const third = w.messages(2).map((m) => m.content);
    expect(third).toContain("how is the quote page?");
    expect(third.join("\n")).not.toContain("how are the notes?");
    await w.store.close();
  });

  it("the conversation survives a restart: a new agent on the same store sends the earlier turns", async () => {
    const w = await setup([textReply("The page is half done.", { ttftMs: 0 })]);
    await w.chat("how far is the page?");
    w.restart([textReply("You asked how far the page is.", { ttftMs: 0 })]);
    await w.chat("what did I ask before the restart?");
    expect(w.messages(0).map((m) => m.content)).toEqual([
      "how far is the page?",
      "The page is half done.",
      expect.stringContaining("what did I ask before the restart?"),
    ]);
    // The daemon's view of the conversation reads the same turns (GET /projects/:id/conversation).
    const sessionId = await w.agent.conversationSessionId(w.alice, null);
    const turns = await readTranscript(w.store, sessionId, w.quote);
    expect(turns.map((t) => [t.human.text, t.reply?.text])).toEqual([
      ["how far is the page?", "The page is half done."],
      ["what did I ask before the restart?", "You asked how far the page is."],
    ]);
    expect(await readTranscript(w.store, sessionId, w.notes)).toEqual([]);
    await w.store.close();
  });

  it("'undo' in Quote Page never touches Notes CLI, and 'make this a task' takes the line before it here", async () => {
    const w = await setup([
      textReply("Put the author in a span under the quote.", { ttftMs: 0 }),
      textReply("The notes are fine.", { ttftMs: 0 }),
    ]);
    await w.chat("add a task: write the FAQ", w.quote);
    await w.chat("how do I show the author?", w.quote);
    // Talk on Notes CLI in between: its lines and changes are another conversation's.
    await w.chat("how are the notes?", w.notes);
    await w.chat("add a task: write the changelog", w.notes);
    const made = await w.chat("make this a task", w.quote);
    // The line before it is the task's outcome; its title is the line without the full stop.
    expect(made.reply).toContain('"Put the author in a span under the quote"');
    // Undo in Quote Page: its own last change (the task just made), not the Notes CLI one.
    const undone = await w.chat("undo", w.quote);
    expect(undone.reply).toContain("Put the author in a span under the quote");
    const notesTasks = await w.store.task.forProject(w.notes);
    expect(notesTasks.map((t) => [t.title, t.status])).toEqual([["Write the changelog", "ready"]]);
    // A second undo takes the one before it in this conversation: the FAQ task.
    const again = await w.chat("undo", w.quote);
    expect(again.reply).toContain("Write the FAQ");
    expect((await w.store.task.forProject(w.notes))[0]?.status).toBe("ready");
    await w.store.close();
  });
});

describe("the chat sees the project (design §3.9: tasks, the last session, open cards in full)", () => {
  it("'what failed and why?' is sent with every task by name, its status in words and the failure's reason", async () => {
    const w = await setup([textReply("Style failed.", { ttftMs: 0 })]);
    const skeleton = await task(w, "Create the page skeleton", { status: "done" });
    const style = await task(w, "Style the page in styles.css", {
      status: "failed",
      depends_on: [skeleton.id],
      reason: "the designer said the work needs something it does not have here",
      attempt: 4,
    } as never);
    await task(w, "Check that the files work together", { depends_on: [style.id] });
    await w.chat("what failed and why?");
    const sent = w.last(0);
    expect(sent).toContain("# Tasks of Quote Page");
    expect(sent).toContain('- "Create the page skeleton": Done');
    expect(sent).toMatch(
      /- "Style the page in styles\.css": Failed: the designer said the work needs/,
    );
    expect(sent).toContain(
      '- "Check that the files work together": Stuck: "Style the page in styles.css" failed',
    );
    await w.store.close();
  });

  it("a task the critic sent back says what the critic still asks for", async () => {
    const w = await setup([textReply("ok", { ttftMs: 0 })]);
    const style = await task(w, "Style the page", {
      status: "needs_human",
      reason:
        "retry ladder exhausted after 4 failed attempt(s) at opus (ceiling opus): human decides",
      attempt: 4,
    } as never);
    const review = await w.store.review.insert({
      task_id: style.id,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 30,
      confidence: 0.9,
      verdict: "revise",
      evidence: [],
      summary: "The page has no styles.",
      author_agent: w.alice,
    });
    await w.store.finding.insert({
      review_id: review.id,
      task_id: style.id,
      severity: "high",
      description: "styles.css is empty",
      required_action: "Write the styles for the quote and its author in styles.css",
      status: "open",
      fingerprint: "fp-style",
      author_agent: w.alice,
    });
    await w.chat("why is style stuck?");
    const sent = w.last(0);
    expect(sent).toContain(
      '- "Style the page": Paused; reason: tried 4 times; critic: The critic sent it back for changes; still asked for: Write the styles for the quote and its author in styles.css',
    );
    // No ladder words reach the model (design §5).
    expect(sent).not.toMatch(/ladder|ceiling|human decides/);
    await w.store.close();
  });

  it("the last session is sent by name from its outcome, not a 160-character cut of its summary", async () => {
    const w = await setup([textReply("ok", { ttftMs: 0 })]);
    const p = await w.store.project.mustGet(w.quote);
    await w.store.project.update(w.quote, p.version, {
      summary_cache: {
        last_session: {
          id: "s1",
          ended_at: "2026-11-01T12:00:00.000Z",
          summary:
            '"Style the page" failed 4 times and needs your decision. 2 tasks done; 1 waits on it. CHF 0.06.',
          stop_reason: "nothing_runnable",
          outcome: {
            done: [{ id: "a", title: "Create the page skeleton" }],
            failed: [{ id: "b", title: "Style the page", reason: "the model call failed" }],
            needsYou: [],
            leftOver: [],
            waiting: [],
            waitingForDocker: [],
            stopReason: "nothing_runnable",
            spentChfMicro: 60_000,
          },
        },
        next_steps: ["Check that the files work together"],
      },
    });
    await w.chat("what happened last time?");
    const sent = w.last(0);
    expect(sent).toContain("# Last session (ended 2026-11-01T12:00:00.000Z)");
    expect(sent).toContain('Failed: "Style the page": the model call failed');
    expect(sent).toContain('Done: "Create the page skeleton"');
    expect(sent).toContain('Next: "Check that the files work together"');
    // Phase E: how it ended in words, or nothing when it ran out of work; never the raw reason
    // ("Ended because: nothing runnable", "plan awaiting approval").
    expect(sent).not.toContain("Ended because");
    expect(sent).not.toContain("nothing runnable");
    // No ids reach the model's context: projects are named, never "[id <uuid>]".
    const system = String(w.provider.calls[0]?.request.system);
    expect(`${system}\n${sent}`).not.toMatch(/\[id [0-9a-f-]{36}\]/);
    expect(`${system}\n${sent}`).not.toContain(w.quote);
    // The system prompt no longer carries a cut of it (nor stage and autonomy).
    expect(String(w.provider.calls[0]?.request.system)).not.toContain("Last session:");
    expect(String(w.provider.calls[0]?.request.system)).not.toMatch(/Stage build, autonomy/);
    await w.store.close();
  });

  it("an open card is sent in full: its project, its task, the whole question and its options", async () => {
    const w = await setup([textReply("ok", { ttftMs: 0 })]);
    const style = await task(w, "Style the page", { status: "needs_human" });
    const why =
      '"Style the page" failed 4 times and needs your decision. The designer said: "The work needs something I do not have here." "Check every file loads" waits on it.';
    await w.store.humanRequest.insert({
      human_id: w.human,
      project_id: w.quote,
      task_id: style.id,
      kind: "decision",
      why,
      steps: [],
      options: ["Try again", "Mark done anyway", "Cancel task"],
      blocking: true,
      risk: "medium",
    } as never);
    await w.chat("what needs me?");
    const sent = w.last(0);
    expect(sent).toContain('[Quote Page, "Style the page"]');
    expect(sent).toContain('"Check every file loads" waits on it.');
    expect(sent).toContain("Options: Try again / Mark done anyway / Cancel task.");
    await w.store.close();
  });

  it("the read-only tools are offered and answer: task_get gives a task's runs and status, tasks_list the whole list", async () => {
    const w = await setup([
      toolReply("task_get", { task: "Style" }, "Looking it up.", { ttftMs: 0 }),
      textReply("It failed.", { ttftMs: 0 }),
    ]);
    await task(w, "Style the page", { status: "failed", reason: "the model call failed" });
    await w.chat("why did style fail?");
    const names = (w.provider.calls[0]?.request.tools ?? []).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["tasks_list", "task_get", "session_last", "files_list"]),
    );
    const result = JSON.stringify(w.provider.calls[1]?.request.messages.at(-1)?.content);
    expect(result).toContain(
      'Task \\"Style the page\\" of Quote Page: Failed: the model call failed',
    );
    // Reading changes nothing: no change log row.
    expect(await w.store.changeLog.list({})).toEqual([]);
    await w.store.close();
  });

  it("a card is 'already mentioned' only when a reply named it", async () => {
    const w = await setup([
      textReply("Here is the weather.", { ttftMs: 0 }),
      textReply('Also, "Style the page" needs your decision in the Inbox.', { ttftMs: 0 }),
      textReply("ok", { ttftMs: 0 }),
    ]);
    const style = await task(w, "Style the page", { status: "needs_human" });
    await w.store.humanRequest.insert({
      human_id: w.human,
      project_id: w.quote,
      task_id: style.id,
      kind: "decision",
      why: '"Style the page" failed 4 times and needs your decision.',
      steps: [],
      options: ["Try again", "Cancel task"],
      blocking: false,
      risk: "medium",
    } as never);
    await w.chat("how is the weather?");
    await w.chat("anything else?");
    // The first reply did not name it: the second turn still lists it as not yet mentioned.
    expect(w.last(1)).toContain("not yet mentioned in this conversation");
    await w.chat("thanks");
    // The second reply named it: the third turn carries a count.
    expect(w.last(2)).toContain("already mentioned in this conversation");
    expect(w.last(2)).not.toContain("Try again / Cancel task");
    await w.store.close();
  });
});

describe("a Yes/No card stays until it is answered (design §3.9)", () => {
  it("a question typed in between does not drop the card; the yes after it still answers it", async () => {
    const w = await setup([textReply("About CHF 5.", { ttftMs: 0 })]);
    const card = await w.chat("start a session with 30 francs");
    expect(card.pendingConfirmation).not.toBeNull();
    const between = await w.chat("how much will it cost?");
    expect(between.reply).toBe("About CHF 5.");
    const yes = await w.chat("yes");
    expect(yes.reply).toMatch(/Started a session on Quote Page/);
    await w.store.close();
  });

  it("'yes' with nothing waiting asks 'Yes to what?' and never reaches the model", async () => {
    const w = await setup();
    const r = await w.chat("yes");
    expect(r.reply).toBe(YES_TO_WHAT_REPLY);
    expect(w.provider.calls).toHaveLength(0);
    await w.store.close();
  });

  it("'yes' after the card was answered elsewhere (Talk, the phone, Changes) says you answered it and what you said", async () => {
    const w = await setup();
    const card = await w.chat("start a session with 30 francs");
    const id = card.pendingConfirmation?.id ?? "";
    await w.commands.cancel(id, { kind: "human", id: w.human });
    const r = await w.chat("yes");
    expect(r.reply).toBe(cardAnsweredReply("elsewhere", "no"));
    expect(r.reply).toBe(
      "You already answered the change I asked about: you said no. Nothing else is waiting for your yes.",
    );
    expect(w.provider.calls).toHaveLength(0);
    await w.store.close();
  });

  // Review of fix/chat (2026-11-01): after a card was answered in this same chat, "yes" said
  // "it expired or was answered in the Inbox", which was untrue; any read-back in the last 12
  // turns made it so, whatever became of the card.
  for (const answer of ["yes", "no"] as const) {
    it(`'yes' after the card was answered here with '${answer}' asks 'Yes to what?'`, async () => {
      const w = await setup();
      const card = await w.chat("start a session with 30 francs");
      expect(card.pendingConfirmation).not.toBeNull();
      const answered = await w.chat(answer);
      expect(answered.reply).toBe(
        answer === "yes"
          ? "Started a session on Quote Page (up to CHF 30)."
          : "Cancelled; nothing was changed.",
      );
      const again = await w.chat("yes");
      expect(again.reply).toBe(YES_TO_WHAT_REPLY);
      expect(again.actions).toEqual([]);
      expect(w.provider.calls).toHaveLength(0);
      // A restart of the chat reads the same from the conversation.
      w.restart();
      expect((await w.chat("yes")).reply).toBe(YES_TO_WHAT_REPLY);
      await w.store.close();
    });
  }

  it("'yes' after the card was answered in the Inbox says so, with the option you chose there", async () => {
    const w = await setup();
    const card = await w.chat("start a session with 30 francs");
    const id = card.pendingConfirmation?.id ?? "";
    // The Inbox answers the request with one of the options it shows; the daemon's sync then
    // takes the card out of the registry (`syncAnsweredCards`, as after POST /requests/:id/answer).
    const row = await w.store.humanRequest.mustGet(id);
    expect(row.options).toEqual(["yes", "no"]);
    await w.store.humanRequest.answer(id, row.version, row.options[1] as string, w.human);
    await syncAnsweredCards({
      store: w.store,
      commands: w.commands,
      humanId: w.human,
      deviceId: null,
    });
    expect(w.commands.pendingCard(id)).toBeNull();
    const r = await w.chat("yes");
    expect(r.reply).toBe(
      "You already answered the change I asked about in the Inbox: you said no. Nothing else is waiting for your yes.",
    );
    expect(r.actions).toEqual([]);
    expect(w.provider.calls).toHaveLength(0);
    await w.store.close();
  });

  it("'yes' after the card expired says it expired and nothing was changed", async () => {
    const w = await setup();
    const card = await w.chat("start a session with 30 francs");
    const id = card.pendingConfirmation?.id ?? "";
    await w.clock.advance(11 * 60 * 1000);
    expect(w.commands.pendingCard(id)).toBeNull();
    expect((await w.store.humanRequest.mustGet(id)).status).toBe("expired");
    const r = await w.chat("yes");
    expect(r.reply).toBe(CARD_EXPIRED_REPLY);
    expect(r.reply).toBe(
      "The change I asked about expired before your yes, so nothing was changed. Ask again if you still want it.",
    );
    expect(w.provider.calls).toHaveLength(0);
    await w.store.close();
  });

  it("a card read back more than 12 turns ago still waits after a restart, as the conversation shows it, and 'yes' runs it", async () => {
    // Before, the chat looked for its card in the last 12 turns only, while the conversation
    // (GET /projects/:id/conversation) shows the last 100: after a restart the card was shown
    // with Yes and No, and "yes" answered "Yes to what?".
    const lines = Array.from({ length: 13 }, (_, i) => `question ${i + 1}?`);
    const w = await setup(lines.map((_, i) => textReply(`Answer ${i + 1}.`, { ttftMs: 0 })));
    const asked = await w.chat("start a session with 30 francs");
    const id = asked.pendingConfirmation?.id ?? "";
    for (const line of lines) await w.chat(line);
    expect(w.provider.calls).toHaveLength(13);
    expect(w.commands.pendingCard(id)).not.toBeNull();
    w.restart();
    const r = await w.chat("yes");
    expect(r.reply).toBe("Started a session on Quote Page (up to CHF 30).");
    await w.store.close();
  });

  it("after a restart of the chat the card is found again from the conversation and answered by 'yes'", async () => {
    const w = await setup();
    await w.chat("start a session with 30 francs");
    // The conversation agent restarts (its memory of the card is gone); the registry's card stands.
    w.restart();
    const r = await w.chat("yes");
    expect(r.reply).toMatch(/Started a session on Quote Page/);
    await w.store.close();
  });
});
