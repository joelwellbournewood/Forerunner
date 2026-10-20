import { SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../src/agent/tools.ts";
import { CommandLoop } from "../src/loop/commands.ts";
import type { CommandTurn } from "../src/loop/ports.ts";

/**
 * Security review of the command registry's model path (spec Q, ADR 0030 item 2): the
 * conversation agent calls command tools gated by the registry (`gate: "registry"`, the
 * hooks file no second request), so the registry's own actor rules are the only confirmation
 * policy for those calls. A test marked `it.fails` is a finding on the current code.
 */

async function world() {
  const clock = new SimulatedClock("2026-10-20T09:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({
    name: "J",
    email: "j@example.test",
    timezone: "Europe/Zurich",
    notify_prefs: {},
    default_autonomy: 2,
    monthly_cap_usd_micro: 150_000_000,
    locale: "en",
  });
  const alice = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  const project = await store.project.insert({
    name: "Sample",
    goal: "Ship the sample",
    autonomy_level: 2,
  });
  const chat = await store.session.insert({
    agent_id: alice.id,
    project_id: project.id,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 0,
    step_cap: 1,
    spent_usd_micro: 0,
    steps: 0,
    started_at: clock.nowIso(),
    status: "running",
    summary: "conversation",
    handoff: {},
    runner: "pc",
  });
  const loop = new CommandLoop({ store, clock, ports: { chfPerUsd: async () => 0.8 } });
  const turn: CommandTurn = {
    humanId: human.id,
    agentId: alice.id,
    activeProjectId: project.id,
    sessionId: chat.id,
    source: "text",
    wordsUsed: "the human typed something unrelated",
  };
  const toolCtx: ToolExecutionContext = {
    runId: "turn-1",
    sessionId: chat.id,
    agentId: alice.id,
    humanId: human.id,
    projectId: project.id,
    allowedPaths: [],
    signal: new AbortController().signal,
  };
  return { store, clock, human, alice, project, chat, loop, turn, toolCtx };
}

describe("command tools on the model path", () => {
  // security finding (medium): `CommandLoop.tools(turn)` builds every command context with
  // `actor: { kind: "human", id: turn.humanId }`, so a command the *model* decides to call is
  // executed and recorded as the human's own act: the change log row carries `author_human`
  // and no `author_agent`, and ADR 0030 item 2 ("an agent never raises its own limits without
  // a human", `limit` commands need a yes whatever the risk when the actor is an agent) can
  // never trigger on this path because the policy never sees an agent actor. The spec's
  // record convention ("every record carries an author agent and an author human") and the
  // audit question "who did what" are both wrong for these rows. Fix: `tools()` passes
  // `{ actor: { kind: "agent", id: turn.agentId } }` to `contextFor` (the human stays
  // `humanId`), so a model-initiated `budget_set`/`autonomy_set` always asks and the log
  // names the agent.
  it.fails("security finding: a command the model calls is recorded as the agent's act, not the human's", async () => {
    const w = await world();
    const results: unknown[] = [];
    const tools = w.loop.tools(w.turn, (r) => results.push(r));
    const noteAdd = tools.find((t) => t.name === "note_add");
    expect(noteAdd?.gate).toBe("registry");
    if (!noteAdd) return;
    const out = await noteAdd.execute({ text: "planted by the model", kind: "note" }, w.toolCtx);
    expect(out.isError).not.toBe(true);
    const rows = await w.store.changeLog.list({ human_id: w.human.id } as never, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.author_agent).toBe(w.alice.id);
    expect(rows[0]?.author_human).toBeNull();
  });

  it.fails("security finding: a limit change the model initiates needs a human's yes even when its risk would be low", async () => {
    const w = await world();
    const tools = w.loop.tools(w.turn, () => undefined);
    const autonomySet = tools.find((t) => t.name === "autonomy_set");
    if (!autonomySet) throw new Error("autonomy_set tool missing");
    // Level 2 to level 2: "low for no change" (ADR 0030 item 1), but a `limit` command by an
    // agent must still ask (item 2). Recorded as the human it acts at once.
    const out = await autonomySet.execute({ level: 2 }, w.toolCtx);
    expect(out.content).toMatch(/Needs confirmation|Refused/);
  });

  it("the model cannot pick the human, the project or the device the command runs as: they come from the turn", async () => {
    const w = await world();
    const other = await w.store.human.insert({
      name: "K",
      email: "k@example.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1,
      locale: "en",
    });
    const tools = w.loop.tools(w.turn, () => undefined);
    const noteAdd = tools.find((t) => t.name === "note_add");
    if (!noteAdd) throw new Error("note_add tool missing");
    // Extra keys in the model's input are not parameters: the schema is the command's own.
    const out = await noteAdd.execute(
      {
        text: "hello",
        kind: "note",
        humanId: other.id,
        deviceId: "phone-of-k",
        actor: { kind: "human", id: other.id },
      },
      { ...w.toolCtx, humanId: other.id },
    );
    expect(out.isError).not.toBe(true);
    const mine = await w.store.changeLog.list({ human_id: w.human.id } as never, { limit: 10 });
    const theirs = await w.store.changeLog.list({ human_id: other.id } as never, { limit: 10 });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
    expect(mine[0]?.project_id).toBe(w.project.id);
  });

  it("every command tool on the model path is gated by the registry and carries the command's static risk and class", async () => {
    const w = await world();
    const tools = w.loop.tools(w.turn, () => undefined);
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) {
      expect(t.gate, t.name).toBe("registry");
      expect(["low", "medium", "high"]).toContain(t.risk);
    }
    const high = [
      "capability_grant",
      "email_mode_set",
      "device_revoke",
      "autonomy_set",
      "budget_set",
    ];
    for (const name of high) {
      const t = tools.find((x) => x.name === name);
      expect(t?.risk, name).toBe("high");
      expect(["permission_change", "capability_grant"]).toContain(t?.actionClass);
    }
  });
});
