import { SimulatedClock } from "@forerunner/platform";
import { type AgentRow, type HumanRow, openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { CommandLoop, sessionCommandPorts } from "../src/loop/commands.ts";
import { Scheduler } from "../src/session/triggers.ts";
import {
  pausedSessionOf,
  pauseMessageBody,
  sessionPausePorts,
} from "../src/wiring/session-ports.ts";

/**
 * The daemon's `pauseSession` / `resumeSession` ports (spec R.4; ADR 0030, ADR 0041) over an
 * in-memory store and the kill switch's registry: a pause marks the row `paused` and, for a
 * session registered in this process, sends the agent the message the runner reads between
 * tasks; a session running elsewhere gets the status only; the undo withdraws the message
 * while unread and puts the row back to `running`; a closed session stays closed. The
 * registry's `session.pause` reaches the port (the composed runtime proves the runner then
 * ends at the task boundary: `remote-wiring.test.ts`).
 */
let store: StateStore;
let clock: SimulatedClock;
let human: HumanRow;
let agent: AgentRow;
let kill: KillSwitch;

beforeEach(async () => {
  clock = new SimulatedClock("2026-10-20T08:00:00Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  human = await store.human.insert({ name: "J", email: "j@example.test" });
  agent = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
  kill = new KillSwitch(new TokenIssuer({ now: () => clock.now() }));
});
afterEach(async () => {
  await store.close();
});

async function runningSession(projectId: string | null = null) {
  const row = await store.session.insert({
    agent_id: agent.id,
    project_id: projectId,
    trigger: "manual",
    runner: "pc",
  });
  return store.session.start(row.id, row.version);
}

const ports = () => sessionPausePorts({ store, kill, agentId: agent.id, humanId: human.id });
const pauseMessages = async () =>
  (await store.message.inbox({ agentId: agent.id }, { limit: 50 })).filter(
    (m) => pausedSessionOf(m.body) !== null,
  );

describe("pauseMessageBody", () => {
  it("names the session, flattens the reason and round-trips through pausedSessionOf", () => {
    const body = pauseMessageBody("s-1", "lunch\n  break ");
    expect(body).toBe("pause: lunch break (session s-1)");
    expect(pausedSessionOf(body)).toBe("s-1");
    expect(pausedSessionOf(pauseMessageBody("s-2", "   "))).toBe("s-2");
    expect(pauseMessageBody("s-2", "   ")).toMatch(/^pause: paused by command/);
    expect(pausedSessionOf("pause everything")).toBeNull();
    expect(pausedSessionOf("handoff: done")).toBeNull();
    // The runner's own stop-word test (`^\s*(stop|halt|pause)\b`) matches the body.
    expect(/^\s*(stop|halt|pause)\b/i.test(body)).toBe(true);
  });
});

describe("pauseSession", () => {
  it("a session registered in this process: the row reads paused and the agent gets the pause message", async () => {
    const project = await store.project.insert({ name: "P", goal: "g", autonomy_level: 2 });
    const s = await runningSession(project.id);
    const controller = new AbortController();
    kill.register({ agentId: agent.id, sessionId: s.id, controller, label: "run" });
    await ports().pauseSession?.(s.id, "lunch");
    expect((await store.session.mustGet(s.id)).status).toBe("paused");
    // Graceful: nothing was aborted; the task in flight finishes on its own.
    expect(controller.signal.aborted).toBe(false);
    const msgs = await pauseMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from_agent_id: agent.id,
      to_agent_id: agent.id,
      project_id: project.id,
      type: "request",
      requires_ack: false,
      read_at: null,
      author_human: human.id,
      body: `pause: lunch (session ${s.id})`,
    });
  });

  it("a session running elsewhere gets the status only; a row that is not running keeps its status", async () => {
    const s = await runningSession();
    await ports().pauseSession?.(s.id, "lunch");
    expect((await store.session.mustGet(s.id)).status).toBe("paused");
    expect(await pauseMessages()).toHaveLength(0);
    // Already paused: a second pause is a no-op, not a transition error.
    await ports().pauseSession?.(s.id, "again");
    expect((await store.session.mustGet(s.id)).status).toBe("paused");
    const planned = await store.session.insert({ agent_id: agent.id, trigger: "manual" });
    await ports().pauseSession?.(planned.id, "early");
    expect((await store.session.mustGet(planned.id)).status).toBe("planned");
  });
});

describe("resumeSession (the undo)", () => {
  it("withdraws the unread pause message of that session and puts the row back to running", async () => {
    const a = await runningSession();
    const b = await runningSession();
    kill.register({ agentId: agent.id, sessionId: a.id, label: "a" });
    kill.register({ agentId: agent.id, sessionId: b.id, label: "b" });
    const p = ports();
    await p.pauseSession?.(a.id, "one");
    await p.pauseSession?.(b.id, "two");
    expect(await pauseMessages()).toHaveLength(2);
    await p.resumeSession?.(a.id, "undo of session.pause");
    expect((await store.session.mustGet(a.id)).status).toBe("running");
    expect((await store.session.mustGet(b.id)).status).toBe("paused");
    const msgs = await pauseMessages();
    expect(msgs.find((m) => pausedSessionOf(m.body) === a.id)?.read_at).not.toBeNull();
    expect(msgs.find((m) => pausedSessionOf(m.body) === b.id)?.read_at).toBeNull();
  });

  it("a session the runner already closed stays closed", async () => {
    const s = await runningSession();
    kill.register({ agentId: agent.id, sessionId: s.id, label: "run" });
    const p = ports();
    await p.pauseSession?.(s.id, "lunch");
    // The runner read the message at the task boundary and closed the session with its handoff.
    const [m] = await pauseMessages();
    await store.message.markRead((m as { id: string }).id);
    const paused = await store.session.mustGet(s.id);
    await store.session.setStatus(paused.id, paused.version, "stopped");
    await p.resumeSession?.(s.id, "undo of session.pause");
    expect((await store.session.mustGet(s.id)).status).toBe("stopped");
  });
});

describe("through the command registry", () => {
  it("session.pause reaches the port and its undo the resume port", async () => {
    const scheduler = new Scheduler({ clock, start: async () => undefined });
    const commands = new CommandLoop({
      store,
      clock,
      ports: {
        chfPerUsd: async () => 0.8,
        ...sessionCommandPorts({ scheduler, kill }),
        ...ports(),
      },
    });
    await commands.start();
    const project = await store.project.insert({ name: "P", goal: "g", autonomy_level: 2 });
    const s = await runningSession(project.id);
    kill.register({ agentId: agent.id, sessionId: s.id, label: "run" });
    const conversation = await store.session.insert({
      agent_id: agent.id,
      trigger: "manual",
      summary: "conversation",
    });
    const turn = {
      humanId: human.id,
      agentId: agent.id,
      activeProjectId: project.id,
      sessionId: conversation.id,
      source: "text" as const,
      wordsUsed: "pause",
    };
    const r = await commands.compose([{ name: "session.pause", params: {} }], turn);
    expect(r.status).toBe("done");
    expect((await store.session.mustGet(s.id)).status).toBe("paused");
    expect(await pauseMessages()).toHaveLength(1);
    const undo = await commands.undo(r.changeLogId ?? null, turn);
    expect(undo.status).toBe("done");
    expect((await store.session.mustGet(s.id)).status).toBe("running");
    expect((await pauseMessages())[0]?.read_at).not.toBeNull();
    commands.stop();
  });
});
