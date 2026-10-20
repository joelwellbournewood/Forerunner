import { PENDING_TTL_MS } from "@forerunner/commands";
import { SimulatedClock } from "@forerunner/platform";
import {
  type AgentRow,
  type DeviceRow,
  type HumanRow,
  type JsonObject,
  openStore,
  type ProjectRow,
  type StateStore,
} from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatReply, ChatRequest } from "../src/conversation/agent.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { CommandLoop, sessionCommandPorts } from "../src/loop/commands.ts";
import {
  approvalOf,
  DEFAULT_DUPLICATE_WINDOW_MS,
  DEFAULT_TAP_MAX_AGE_MS,
  isFreshTap,
  REMOTE_AUDIT_TOOL,
  RemoteCommandWatcher,
  TAP_MAX_SKEW_MS,
  verbOf,
} from "../src/remote/index.ts";
import { Scheduler, type StartRequest } from "../src/session/triggers.ts";

/**
 * The PC's consumer of the phone's `target: "pc"` remote commands (spec R.4, R.8; ADR 0032
 * item 4, ADR 0041) over an in-memory store, the real command registry (`CommandLoop` with
 * the scheduler and kill-switch ports), a scripted chat and a SimulatedClock. Covers: the
 * store never hands another human's command to this PC and a row forced through is refused
 * and audited; a plan runs through the registry (low acts, the phone's tap answers a medium
 * card, a high-risk step files a change card the phone confirms on its device); a replayed
 * envelope (same device and clientId) is refused as a duplicate and acts once; a kill from
 * the phone stops a registered run within one poll; the plain verbs; chat.
 */
let store: StateStore;
let clock: SimulatedClock;
let human: HumanRow;
let agent: AgentRow;
let project: ProjectRow;
let phone: DeviceRow;
let pc: DeviceRow;
let kill: KillSwitch;
let scheduler: Scheduler;
let commands: CommandLoop;
let started: StartRequest[];
let chatCalls: ChatRequest[];

async function seed() {
  human = await store.human.insert({
    name: "J",
    email: "j@example.test",
    timezone: "Europe/Zurich",
    notify_prefs: {},
    default_autonomy: 2,
    monthly_cap_usd_micro: 0,
    locale: "en",
  });
  agent = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  project = await store.project.insert({
    name: "Sample",
    goal: "Ship the sample",
    autonomy_level: 2,
    active: true,
  });
  phone = await store.device.register({
    owner_human_id: human.id,
    name: "J's phone",
    platform: "android",
    public_key: ["pk-", "P".repeat(40)].join(""), // not-a-secret
    kind: "phone",
  });
  pc = await store.device.register({
    owner_human_id: human.id,
    name: "J's PC",
    platform: "linux",
    public_key: ["pk-", "D".repeat(40)].join(""), // not-a-secret
    kind: "desktop",
  });
}

beforeEach(async () => {
  clock = new SimulatedClock("2026-10-20T08:00:00Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  await seed();
  kill = new KillSwitch(new TokenIssuer({ now: () => clock.now() }));
  started = [];
  chatCalls = [];
  scheduler = new Scheduler({
    clock,
    start: async (req) => {
      started.push(req);
    },
  });
  commands = new CommandLoop({
    store,
    clock,
    ports: { chfPerUsd: async () => 0.8, ...sessionCommandPorts({ scheduler, kill }) },
  });
  await commands.start();
});
afterEach(async () => {
  commands.stop();
  await store.close();
});

const chat = async (req: ChatRequest): Promise<ChatReply> => {
  chatCalls.push(req);
  return {
    reply: `I read "${req.text}".`,
    actions: [],
    pendingConfirmation: null,
    question: null,
    ttftMs: 1,
    costUsdMicro: 12,
    transcriptId: "t1",
    activeProjectId: req.projectId ?? null,
  };
};

function watcher(
  over: { pollMs?: number; chat?: typeof chat | null; duplicateWindowMs?: number } = {},
) {
  return new RemoteCommandWatcher({
    store,
    clock,
    kill,
    start: (req) => scheduler.request(req),
    commands,
    chat: over.chat === undefined ? chat : over.chat,
    conversationSessionId: async () => conversationSession,
    deviceId: pc.id,
    agentId: agent.id,
    humanId: human.id,
    ...(over.pollMs ? { pollMs: over.pollMs } : {}),
    ...(over.duplicateWindowMs !== undefined ? { duplicateWindowMs: over.duplicateWindowMs } : {}),
  });
}

let conversationSession = "";
beforeEach(async () => {
  conversationSession = (
    await store.session.insert({
      agent_id: agent.id,
      project_id: null,
      trigger: "manual",
      status: "planned",
      summary: "conversation",
      runner: "pc",
    })
  ).id;
});

/** Every envelope gets its own outbox key, as the app's `newClientId` gives it (a replay reuses one). */
let clientIds = 0;
function plan(
  steps: { name: string; params: JsonObject }[],
  over: { confirmedAt?: string | null; clientId?: string } = {},
): JsonObject {
  const confirmedAt = over.confirmedAt === undefined ? clock.nowIso() : over.confirmedAt;
  return {
    v: 1,
    kind: "plan",
    plan: steps,
    wordsUsed: steps.map((s) => s.name).join(", "),
    card: { what: "test" },
    clientId: over.clientId ?? `c-${++clientIds}`,
    ...(confirmedAt ? { confirmedAt } : {}),
  };
}

const audits = () => store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });

describe("ownership", () => {
  it("another human's command is never handed to this PC; forced through, it is refused and audited", async () => {
    const humanB = await store.human.insert({ name: "B", email: "b@example.test" });
    await store.agent.insert({ name: "Bobby", owner_human_id: humanB.id });
    const phoneB = await store.device.register({
      owner_human_id: humanB.id,
      name: "B's phone",
      platform: "android",
      public_key: ["pk-", "B".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
    const controller = new AbortController();
    kill.register({ agentId: agent.id, sessionId: "s1", controller, label: "A's run" });
    const killB = await store.remoteCommand.enqueue({
      device_id: phoneB.id,
      target: "pc",
      command: "kill",
    });
    const w = watcher();
    // First line: the store's owner filter leaves B's row pending for B's own PC.
    expect(await w.drain()).toBe(0);
    expect((await store.remoteCommand.mustGet(killB.id)).status).toBe("pending");
    expect(controller.signal.aborted).toBe(false);
    expect(await audits()).toHaveLength(0);
    // Second line: a row that reached this PC anyway is refused without acting, with an audit row.
    const forced = await store.remoteCommand.pickUpById(killB.id);
    expect(forced).toBeDefined();
    const result = await w.handle(forced as never);
    expect(result).toMatchObject({ error: "forbidden: device of another human" });
    expect(controller.signal.aborted).toBe(false);
    expect(kill.isFrozen({ agentId: agent.id })).toBe(false);
    const row = await store.remoteCommand.mustGet(killB.id);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ error: "forbidden: device of another human" });
    const audit = await audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      allowed: false,
      denied_reason: "forbidden: device of another human",
      human_id: human.id,
      agent_id: agent.id,
    });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toMatchObject({
      commandId: killB.id,
      command: "kill",
      deviceId: phoneB.id,
    });
  });

  it("a revoked device of the owner is picked up and refused visibly; an unknown device too", async () => {
    const old = await store.device.register({
      owner_human_id: human.id,
      name: "old phone",
      platform: "android",
      public_key: ["pk-", "O".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
    await store.device.revoke(old.id, old.version);
    const row = await store.remoteCommand.enqueue({
      device_id: old.id,
      target: "pc",
      command: "start",
      params: { projectId: project.id },
    });
    const w = watcher();
    expect(await w.drain()).toBe(1);
    expect(await store.remoteCommand.mustGet(row.id)).toMatchObject({
      status: "failed",
      result: { error: "forbidden: revoked device" },
    });
    expect(started).toHaveLength(0);
    const audit = await audits();
    expect(audit[0]).toMatchObject({ allowed: false, denied_reason: "forbidden: revoked device" });
  });
});

describe("plans through the command registry", () => {
  it("a low-risk plan acts at once and reports the change log; the active project follows a switch", async () => {
    const other = await store.project.insert({ name: "Other", goal: "x", autonomy_level: 2 });
    const row = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "project.switch", params: { project: other.id } }]),
    });
    const w = watcher();
    expect(await w.drain()).toBe(1);
    const done = await store.remoteCommand.mustGet(row.id);
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({
      kind: "plan",
      status: "done",
      executed: ["project.switch"],
      clientId: row.params.clientId,
      undoOf: null,
    });
    expect(typeof (done.result as { changeLogId?: unknown }).changeLogId).toBe("string");
    expect(await commands.activeProject(human.id)).toBe(other.id);
    const audit = await audits();
    expect(audit[0]).toMatchObject({ allowed: true });
    // The audit names the commands, never their parameters.
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toMatchObject({
      kind: "plan",
      commands: ["project.switch"],
    });
    expect(audit[0]?.input_summary).not.toContain(other.id);
  });

  it("the tap the phone recorded answers a medium-risk card; without it the card waits for a yes", async () => {
    const w = watcher();
    const tapped = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 3, project: project.id } }]),
    });
    expect(await w.drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(tapped.id)).result).toMatchObject({
      status: "done",
      executed: ["autonomy.set"],
    });
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(3);

    const untapped = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 2, project: project.id } }], {
        confirmedAt: null,
      }),
    });
    expect(await w.drain()).toBe(1);
    const pending = await store.remoteCommand.mustGet(untapped.id);
    expect(pending.status).toBe("done");
    expect(pending.result).toMatchObject({ status: "pending", decision: "needs_yes" });
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(3);
    const pendingId = (pending.result as { pendingId: string }).pendingId;
    const request = await store.humanRequest.mustGet(pendingId);
    expect(request).toMatchObject({ status: "open", kind: "approval", risk: "medium" });
    // The phone answers "yes" in the inbox (through the state service): the next drain applies it.
    await store.humanRequest.answer(request.id, request.version, "yes", human.id);
    await w.drain();
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(2);
    expect(commands.pending(human.id)).toHaveLength(0);
  });

  it("a tap the outbox replayed from long ago does not confirm a medium-risk card; the card waits for a yes", async () => {
    const w = watcher();
    const stale = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 3, project: project.id } }], {
        confirmedAt: "2019-01-01T00:00:00Z",
      }),
    });
    expect(await w.drain()).toBe(1);
    const row = await store.remoteCommand.mustGet(stale.id);
    expect(row.status).toBe("done");
    expect(row.result).toMatchObject({ status: "pending", decision: "needs_yes", executed: [] });
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(2);
    expect(commands.pending(human.id)).toHaveLength(1);
    // A tap just inside the window still counts; the clock, not the phone, decides.
    const recent = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 3, project: project.id } }], {
        confirmedAt: new Date(clock.now() - DEFAULT_TAP_MAX_AGE_MS + 1_000).toISOString(),
      }),
    });
    expect(await w.drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(recent.id)).result).toMatchObject({
      status: "done",
      executed: ["autonomy.set"],
    });
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(3);
  });

  it("a high-risk step files a change card the phone confirms on its device; a rejection cancels", async () => {
    const w = watcher();
    const row = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 4, project: project.id } }]),
    });
    expect(await w.drain()).toBe(1);
    const done = await store.remoteCommand.mustGet(row.id);
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({
      status: "pending",
      decision: "needs_device",
      executed: [],
    });
    // Nothing changed; the card is a human request with the change card and high risk.
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(2);
    const pendingId = (done.result as { pendingId: string }).pendingId;
    const request = await store.humanRequest.mustGet(pendingId);
    expect(request).toMatchObject({
      status: "open",
      kind: "approval",
      risk: "high",
      human_id: human.id,
      options: ["approve on device", "reject"],
    });
    expect(request.change_card).toMatchObject({ decision: "needs_device" });
    expect(commands.pending(human.id).map((p) => p.id)).toEqual([pendingId]);
    // The phone's biometric answer reaches the store through the state service's confirm:high
    // path; the daemon applies it to the pending card as its own desktop row (no biometric of
    // its own: the service checked the phone's) and the change runs.
    await store.humanRequest.answer(request.id, request.version, "approve on device", human.id);
    const confirm = vi.spyOn(commands, "confirm");
    expect(await w.syncAnswered()).toEqual({ applied: 1, cancelled: 0, refused: 0 });
    expect(confirm).toHaveBeenCalledWith(
      pendingId,
      expect.objectContaining({ kind: "device", deviceId: pc.id, biometric: false }),
    );
    confirm.mockRestore();
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(4);
    expect(commands.pending(human.id)).toHaveLength(0);
    const log = await commands.changeLog({ humanId: human.id });
    expect(
      log.some((r) => r.commands.some((c) => (c as { name: string }).name === "autonomy.set")),
    ).toBe(true);

    // A second high-risk card, rejected on the phone, is cancelled and changes nothing.
    const again = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 0, project: project.id } }]),
    });
    expect(await w.drain()).toBe(1);
    const id2 = ((await store.remoteCommand.mustGet(again.id)).result as { pendingId: string })
      .pendingId;
    const r2 = await store.humanRequest.mustGet(id2);
    await store.humanRequest.answer(r2.id, r2.version, "reject", human.id);
    expect(await w.syncAnswered()).toEqual({ applied: 0, cancelled: 1, refused: 0 });
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(4);
    expect(commands.pending(human.id)).toHaveLength(0);
    // Another human's answer never confirms this human's card.
    const stranger = await store.human.insert({ name: "S", email: "s@example.test" });
    const third = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 1, project: project.id } }]),
    });
    await w.drain();
    const id3 = ((await store.remoteCommand.mustGet(third.id)).result as { pendingId: string })
      .pendingId;
    const r3 = await store.humanRequest.mustGet(id3);
    await store.humanRequest.answer(r3.id, r3.version, "approve on device", stranger.id);
    expect(await w.syncAnswered()).toEqual({ applied: 0, cancelled: 0, refused: 0 });
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(4);
  });

  it("an approval the executor refuses is not applied: warned, audited, the dead card dropped, never retried", async () => {
    const w = watcher();
    const row = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "autonomy.set", params: { level: 4, project: project.id } }]),
    });
    expect(await w.drain()).toBe(1);
    const pendingId = ((await store.remoteCommand.mustGet(row.id)).result as { pendingId: string })
      .pendingId;
    const request = await store.humanRequest.mustGet(pendingId);
    await store.humanRequest.answer(request.id, request.version, "approve on device", human.id);
    // This daemon's own desktop row was revoked meanwhile: the policy refuses its confirmation.
    await store.device.revoke(pc.id, pc.version);
    expect(await w.syncAnswered()).toEqual({ applied: 0, cancelled: 0, refused: 1 });
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(2);
    expect(commands.pending(human.id)).toHaveLength(0);
    expect(w.stats.refusedCards).toBe(1);
    const denied = (await audits()).filter((a) => !a.allowed);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.denied_reason).toMatch(/revoked/);
    expect(JSON.parse(denied[0]?.input_summary ?? "{}")).toMatchObject({
      pendingId,
      kind: "card",
      decision: "needs_device",
      commands: ["autonomy.set"],
    });
    // Nothing repeats: the next drains find no card and write no second row.
    expect(await w.syncAnswered()).toEqual({ applied: 0, cancelled: 0, refused: 0 });
    expect(await w.drain()).toBe(0);
    expect((await audits()).filter((a) => !a.allowed)).toHaveLength(1);
    expect((await store.project.mustGet(project.id)).autonomy_level).toBe(2);
  });

  it("a refused plan ends failed with the reason; a malformed envelope is a validation failure", async () => {
    const w = watcher();
    const refused = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: plan([{ name: "project.switch", params: { project: "no-such-project" } }]),
    });
    const malformed = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: { v: 1, kind: "plan", plan: "not a list" },
    });
    expect(await w.drain()).toBe(2);
    const r = await store.remoteCommand.mustGet(refused.id);
    expect(r.status).toBe("failed");
    expect(r.result).toMatchObject({ status: "refused" });
    expect(String((r.result as { error: string }).error)).toMatch(/no-such-project|project/i);
    const m = await store.remoteCommand.mustGet(malformed.id);
    expect(m.status).toBe("failed");
    expect(m.result).toMatchObject({ code: "validation" });
    expect(String((m.result as { error: string }).error)).toMatch(/malformed plan envelope/);
    const audit = await audits();
    expect(audit.every((a) => a.allowed === false)).toBe(true);
  });
});

describe("kill, stop, pause, start", () => {
  it("a kill from the phone stops every registered run within one poll and freezes new work", async () => {
    const controller = new AbortController();
    kill.register({ agentId: agent.id, sessionId: "s1", controller, label: "pc session" });
    const w = watcher({ pollMs: 500 });
    w.start();
    // The phone's "stop everything": verb kill, one session.stop step with scope all.
    const row = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "kill",
      params: plan([{ name: "session.stop", params: { scope: "all" } }]),
    });
    const t0 = Date.now();
    const simulated0 = clock.now();
    await clock.advance(500);
    for (let i = 0; i < 100 && !controller.signal.aborted; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(clock.now() - simulated0).toBe(500);
    expect(controller.signal.aborted).toBe(true);
    expect(kill.isFrozen({ agentId: agent.id })).toBe(true);
    const done = await store.remoteCommand.mustGet(row.id);
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({ kind: "plan", status: "done", executed: ["session.stop"] });
    expect(w.stats).toMatchObject({ handled: 1, running: true, pollMs: 500 });
    w.stop();
    expect(w.stats.running).toBe(false);
  });

  it("a plain kill, stop and start (the approvals web's shape) go through the kill switch and the scheduler", async () => {
    const controller = new AbortController();
    kill.register({ agentId: agent.id, sessionId: "s2", controller, label: "run" });
    const w = watcher();
    const stop = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "stop",
    });
    expect(await w.drain()).toBe(1);
    expect(controller.signal.aborted).toBe(true);
    expect(kill.isFrozen({ agentId: agent.id })).toBe(false);
    expect((await store.remoteCommand.mustGet(stop.id)).result).toMatchObject({
      kind: "stop",
      stoppedRuns: 1,
      frozen: false,
    });

    const c2 = new AbortController();
    kill.register({ agentId: agent.id, sessionId: "s3", controller: c2, label: "run" });
    const killRow = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "kill",
      params: { reason: "stop everything" },
    });
    expect(await w.drain()).toBe(1);
    expect(c2.signal.aborted).toBe(true);
    expect(kill.isFrozen({ agentId: agent.id })).toBe(true);
    expect((await store.remoteCommand.mustGet(killRow.id)).result).toMatchObject({
      kind: "kill",
      stoppedRuns: 1,
      frozen: true,
    });
    expect(w.stats.lastKill?.stoppedRuns).toBe(1);

    const start = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: { projectId: project.id, budgetUsdMicro: 2_000_000 },
    });
    expect(await w.drain()).toBe(1);
    expect(kill.isFrozen({ agentId: agent.id })).toBe(false);
    expect(started).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        projectId: project.id,
        trigger: "remote",
        budgetUsdMicro: 2_000_000,
      }),
    ]);
    expect((await store.remoteCommand.mustGet(start.id)).result).toMatchObject({
      kind: "start",
      result: "started",
    });
  });

  it("a start or a stop naming another agent is refused; the registry's own session.* rows are handled", async () => {
    const other = await store.agent.insert({ name: "Other", owner_human_id: human.id });
    const w = watcher();
    const startOther = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "session.start",
      params: { agentId: other.id, projectId: project.id, trigger: "remote" },
    });
    const stopOther = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "session.stop",
      params: { scope: "agent", agentId: other.id },
    });
    const startMine = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "session.start",
      params: { agentId: agent.id, projectId: project.id, budgetUsdMicro: 500_000 },
    });
    expect(await w.drain()).toBe(3);
    for (const id of [startOther.id, stopOther.id]) {
      const row = await store.remoteCommand.mustGet(id);
      expect(row.status).toBe("failed");
      expect(String((row.result as { error: string }).error)).toMatch(
        /forbidden: agent .* is not this PC's agent/,
      );
    }
    expect((await store.remoteCommand.mustGet(startMine.id)).status).toBe("done");
    expect(started).toHaveLength(1);
    expect(verbOf("session.pause")).toBe("pause");
    expect(verbOf("dance")).toBeNull();
  });

  it("pause goes through the registry: the running session is paused and the change logged", async () => {
    const session = await store.session.insert({
      agent_id: agent.id,
      project_id: project.id,
      trigger: "manual",
      runner: "pc",
    });
    await store.session.start(session.id, session.version);
    const w = watcher();
    const row = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "pause",
      params: plan([{ name: "session.pause", params: {} }]),
    });
    const plain = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "pause",
    });
    expect(await w.drain()).toBe(2);
    expect((await store.remoteCommand.mustGet(row.id)).result).toMatchObject({
      status: "done",
      executed: ["session.pause"],
    });
    expect((await store.session.mustGet(session.id)).status).toBe("paused");
    // Nothing left to pause: the plain verb fails with the registry's reason.
    const p = await store.remoteCommand.mustGet(plain.id);
    expect(p.status).toBe("failed");
    expect(String((p.result as { error: string }).error)).toMatch(/no running session/);
  });
});

describe("chat", () => {
  it("a chat envelope is one conversation turn on the PC; without a model it fails visibly", async () => {
    const w = watcher();
    const row = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: {
        v: 1,
        kind: "chat",
        text: "how is the sample?",
        projectId: project.id,
        clientId: "q1",
      },
    });
    expect(await w.drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(row.id)).result).toMatchObject({
      kind: "chat",
      reply: 'I read "how is the sample?".',
      costUsdMicro: 12,
      clientId: "q1",
      activeProjectId: project.id,
    });
    // The turn runs as the PC (its own device), never as the phone, so a session command in
    // the reply runs here instead of becoming another remote command.
    expect(chatCalls[0]).toMatchObject({
      humanId: human.id,
      agentId: agent.id,
      projectId: project.id,
      source: "phone",
      deviceId: pc.id,
    });

    const noModel = watcher({ chat: null });
    const row2 = await store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: { v: 1, kind: "chat", text: "hello" },
    });
    expect(await noModel.drain()).toBe(1);
    const failed = await store.remoteCommand.mustGet(row2.id);
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({ code: "provider_auth" });
  });
});

describe("replayed envelopes", () => {
  const enqueue = (params: JsonObject) =>
    store.remoteCommand.enqueue({ device_id: phone.id, target: "pc", command: "start", params });

  it("two rows with the same clientId: one executed, the other failed as a duplicate and audited; one change log entry", async () => {
    const other = await store.project.insert({ name: "Other", goal: "x", autonomy_level: 2 });
    // The phone's outbox replayed the envelope after a lost answer: same device, same clientId.
    const envelope = plan([{ name: "project.switch", params: { project: other.id } }], {
      clientId: "replayed-1",
    });
    const first = await enqueue(envelope);
    const second = await enqueue(envelope);
    const w = watcher();
    expect(await w.drain()).toBe(2);
    expect(await store.remoteCommand.mustGet(first.id)).toMatchObject({
      status: "done",
      result: { status: "done", executed: ["project.switch"], clientId: "replayed-1" },
    });
    const dup = await store.remoteCommand.mustGet(second.id);
    expect(dup.status).toBe("failed");
    expect(dup.result).toMatchObject({
      kind: "plan",
      status: "duplicate",
      code: "duplicate",
      duplicateOf: first.id,
      clientId: "replayed-1",
    });
    expect(String((dup.result as { error: string }).error)).toMatch(
      /^duplicate: envelope replayed-1 from device .* was already handled as command /,
    );
    expect(w.stats.duplicates).toBe(1);
    expect(await commands.changeLog({ humanId: human.id })).toHaveLength(1);
    expect(await commands.activeProject(human.id)).toBe(other.id);
    const audit = await audits();
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ allowed: true });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toMatchObject({
      commandId: first.id,
      deviceId: phone.id,
      clientId: "replayed-1",
      commands: ["project.switch"],
    });
    expect(audit[1]).toMatchObject({
      allowed: false,
      denied_reason: expect.stringMatching(/^duplicate: envelope replayed-1/),
    });
    expect(JSON.parse(audit[1]?.input_summary ?? "{}")).toMatchObject({
      commandId: second.id,
      deviceId: phone.id,
      clientId: "replayed-1",
    });
    expect(JSON.parse(audit[1]?.result_summary ?? "{}")).toMatchObject({ duplicateOf: first.id });

    // A third copy reaches another daemon of this install (a restart, a restored backup, a
    // second state service): the audit rows are its memory, and it refuses too.
    const third = await enqueue(envelope);
    const restarted = watcher();
    expect(await restarted.drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(third.id)).result).toMatchObject({
      status: "duplicate",
      duplicateOf: first.id,
    });
    expect(restarted.stats.duplicates).toBe(1);
    expect(await commands.changeLog({ humanId: human.id })).toHaveLength(1);

    // The same plan under a new clientId is a new tap and runs.
    const fresh = await enqueue(
      plan([{ name: "project.switch", params: { project: project.id } }], { clientId: "tap-2" }),
    );
    expect(await restarted.drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(fresh.id)).result).toMatchObject({
      status: "done",
      executed: ["project.switch"],
    });
    expect(await commands.changeLog({ humanId: human.id })).toHaveLength(2);
  });

  it("the audit rows are read back a month by default; a replay older than the window is not recognised by a new process", async () => {
    expect(DEFAULT_DUPLICATE_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const envelope = plan([{ name: "project.switch", params: { project: project.id } }], {
      clientId: "old-1",
    });
    await enqueue(envelope);
    expect(await watcher().drain()).toBe(1);
    await clock.advance(2 * 60 * 60 * 1000);
    // A new process with a one-hour window no longer sees the first handling: the low-risk
    // plan runs again (the window is the limit of this line of defence).
    const short = await enqueue(envelope);
    expect(await watcher({ duplicateWindowMs: 60 * 60 * 1000 }).drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(short.id)).result).toMatchObject({
      status: "done",
      executed: ["project.switch"],
    });
    // The default window does.
    const long = await enqueue(envelope);
    expect(await watcher().drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(long.id)).result).toMatchObject({
      status: "duplicate",
    });
  });

  it("a replayed chat envelope is one model turn", async () => {
    const env: JsonObject = { v: 1, kind: "chat", text: "status?", clientId: "chat-1" };
    const first = await enqueue(env);
    const second = await enqueue(env);
    expect(await watcher().drain()).toBe(2);
    expect(chatCalls).toHaveLength(1);
    expect((await store.remoteCommand.mustGet(first.id)).status).toBe("done");
    expect(await store.remoteCommand.mustGet(second.id)).toMatchObject({
      status: "failed",
      result: { kind: "chat", status: "duplicate", duplicateOf: first.id, clientId: "chat-1" },
    });
  });
});

describe("isFreshTap", () => {
  it("counts a tap within the card's life and a little clock skew, nothing else", () => {
    expect(DEFAULT_TAP_MAX_AGE_MS).toBe(PENDING_TTL_MS);
    const now = Date.parse("2026-10-20T08:00:00Z");
    expect(isFreshTap(new Date(now).toISOString(), now)).toBe(true);
    expect(isFreshTap(new Date(now - DEFAULT_TAP_MAX_AGE_MS).toISOString(), now)).toBe(true);
    expect(isFreshTap(new Date(now - DEFAULT_TAP_MAX_AGE_MS - 1).toISOString(), now)).toBe(false);
    expect(isFreshTap(new Date(now + TAP_MAX_SKEW_MS).toISOString(), now)).toBe(true);
    expect(isFreshTap(new Date(now + TAP_MAX_SKEW_MS + 1).toISOString(), now)).toBe(false);
    expect(isFreshTap("2019-01-01T00:00:00Z", now)).toBe(false);
    expect(isFreshTap("not a date", now)).toBe(false);
    expect(isFreshTap(undefined, now)).toBe(false);
    expect(isFreshTap(new Date(now - 30_000).toISOString(), now, 10_000)).toBe(false);
  });
});

describe("approvalOf", () => {
  it("reads the inbox's answer shapes", () => {
    const options = ["approve on device", "reject"];
    expect(approvalOf("approve on device", options)).toBe(true);
    expect(approvalOf("Approve on device", options)).toBe(true);
    expect(approvalOf("yes", ["yes", "no"])).toBe(true);
    expect(approvalOf("ja", ["yes", "no"])).toBe(true);
    expect(approvalOf("reject", options)).toBe(false);
    expect(approvalOf("no", ["yes", "no"])).toBe(false);
    expect(approvalOf(true, options)).toBe(true);
    expect(approvalOf({ choice: "approve on device" }, options)).toBe(true);
    expect(approvalOf({ approved: false }, options)).toBe(false);
    expect(approvalOf(null, options)).toBe(false);
    expect(approvalOf([], options)).toBe(false);
  });
});
