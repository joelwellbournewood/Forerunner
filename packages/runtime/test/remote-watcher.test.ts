import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ACTIVE_PROJECT_KEY,
  CommandExecutor,
  type CommandPorts,
  defaultRegistry,
  type KillScope,
  SESSION_OVERRIDE_KEY,
  type SessionStartPortRequest,
} from "@forerunner/commands";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  type AgentRow,
  type DeviceRow,
  type HumanRow,
  type JsonObject,
  openStore,
  type ProjectRow,
  type RemoteCommandRow,
  type StateStore,
} from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import {
  HttpRemoteCommandQueue,
  REMOTE_AUDIT_TOOL,
  type RemoteCommand,
  RemoteCommandWatcher,
  readAnswer,
} from "../src/daemon/remote-watcher.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import type { StartRequest } from "../src/session/triggers.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * The PC daemon's consumer for the phone's remote commands (spec R.4, ADR 0032), against a
 * fake state service that serves the three remote-command routes over the same store the
 * daemon uses. Scenario 9 ("switch to the game, give it 15 francs until tomorrow and start a
 * session on my PC") arrives as one plan envelope and ends with a started session and a `done`
 * command; an `undoOf` plan stops it; chat is answered by the conversation agent; the bare
 * verbs are the session controls; every limit is decided by the registry on the real state,
 * never by the phone's card; another human's device is refused.
 */
const START = "2026-10-20T18:00:00.000Z"; // 20:00 Europe/Zurich
const TOMORROW_0600 = "2026-10-21T04:00:00.000Z";
const TZ = "Europe/Zurich";
const RATE = 0.8;
const ADMIN_TOKEN = ["remote", "watcher", "admin", "token", "fixture"].join("-"); // not-a-secret
const SCENARIO_WORDS =
  "switch to the game, give it 15 francs until tomorrow and start a session on my PC";

interface FakePorts extends CommandPorts {
  starts: SessionStartPortRequest[];
  kills: { scope: KillScope | "all"; reason: string }[];
}

/** The state service's remote-command routes over a store, as an in-process `fetch`. */
function fakeStateService(store: StateStore, adminToken: string) {
  const app = new Hono();
  const calls: string[] = [];
  let failNext: number | null = null;
  const view = (r: RemoteCommandRow) => ({
    id: r.id,
    deviceId: r.device_id,
    target: r.target,
    targetDeviceId: r.target_device_id,
    command: r.command,
    params: r.params,
    status: r.status,
    pickedUpAt: r.picked_up_at,
    result: r.result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  });
  app.use("*", async (c, next) => {
    calls.push(`${c.req.method} ${new URL(c.req.url).pathname}`);
    if (c.req.header("authorization") !== `Bearer ${adminToken}`) {
      return c.json({ code: "unauthorized", message: "bad token" }, 401);
    }
    if (failNext) {
      const status = failNext;
      failNext = null;
      return c.json({ code: "internal", message: "injected failure" }, status as 500);
    }
    await next();
  });
  app.get("/remote/commands/pending", async (c) => {
    const target = c.req.query("target");
    if (target !== "pc" && target !== "cloud") {
      return c.json({ code: "validation", message: "target must be pc or cloud" }, 400);
    }
    const deviceId = c.req.query("deviceId") || undefined;
    const row = await store.remoteCommand.pickUp(target, deviceId ? { deviceId } : {});
    if (!row) return c.body(null, 204);
    return c.json(view(row));
  });
  app.post("/remote/commands/:id/complete", async (c) => {
    const body = (await c.req.json()) as { result?: unknown };
    const row = await store.remoteCommand.complete(
      c.req.param("id"),
      (body.result ?? null) as never,
    );
    return c.json(view(row));
  });
  app.post("/remote/commands/:id/fail", async (c) => {
    const body = (await c.req.json()) as { result?: unknown };
    const row = await store.remoteCommand.fail(c.req.param("id"), (body.result ?? null) as never);
    return c.json(view(row));
  });
  const fetchImpl: typeof fetch = async (input, init) =>
    app.request(String(input), init as RequestInit | undefined);
  return {
    app,
    fetchImpl,
    calls,
    failOnce: (status: number) => {
      failNext = status;
    },
  };
}

interface World {
  store: StateStore;
  clock: SimulatedClock;
  executor: CommandExecutor;
  kill: KillSwitch;
  ports: FakePorts;
  human: HumanRow;
  other: HumanRow;
  agent: AgentRow;
  pharma: ProjectRow;
  game: ProjectRow;
  phone: DeviceRow;
  desktop: DeviceRow;
  revoked: DeviceRow;
  otherPhone: DeviceRow;
  service: ReturnType<typeof fakeStateService>;
  watcher: RemoteCommandWatcher;
  started: (StartRequest & { budgetUsdMicro?: number })[];
  chats: { text: string; projectId?: string; source?: string }[];
  activeProjects: (string | null)[];
  killsSeen: string[];
  handled: { cmd: RemoteCommand; ok: boolean; result: JsonObject }[];
  enqueue(
    command: string,
    params: Record<string, unknown>,
    device?: DeviceRow,
    targetDeviceId?: string,
  ): Promise<RemoteCommandRow>;
  row(id: string): Promise<RemoteCommandRow>;
}

async function world(opts: { conversation?: boolean } = {}): Promise<World> {
  const clock = new SimulatedClock(START);
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({ name: "J", email: "j@example.test", timezone: TZ });
  const other = await store.human.insert({
    name: "Mara",
    email: "mara@example.test",
    timezone: TZ,
  });
  const agent = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    kind: "principal",
    memory_location: "",
  });
  const pharma = await store.project.insert({ name: "PharmaWatch", autonomy_level: 2 });
  const game = await store.project.insert({ name: "Game", autonomy_level: 2 });
  const h = await store.human.mustGet(human.id);
  await store.human.update(h.id, h.version, {
    notify_prefs: { ...h.notify_prefs, [ACTIVE_PROJECT_KEY]: pharma.id },
  });
  const device = (owner: string, name: string, kind: "phone" | "desktop") =>
    store.device.register({
      owner_human_id: owner,
      name,
      platform: kind === "phone" ? "android" : "linux",
      public_key: ["pk", name.replace(/\s+/g, "-"), "fixture"].join("-"), // not-a-secret
      kind,
    });
  const phone = await device(human.id, "Pixel 8", "phone");
  const desktop = await device(human.id, "Workstation", "desktop");
  const revokedRow = await device(human.id, "old phone", "phone");
  const revoked = await store.device.revoke(revokedRow.id, revokedRow.version);
  const otherPhone = await device(other.id, "Mara's phone", "phone");

  const registry = defaultRegistry();
  await registry.persist(store);
  const executor = new CommandExecutor({ registry, store, clock });
  const kill = new KillSwitch(new TokenIssuer({ now: () => clock.now() }));
  const ports: FakePorts = {
    starts: [],
    kills: [],
    chfPerUsd: async () => RATE,
    startSession: async (req) => {
      ports.starts.push(req);
      return { sessionId: `s-${ports.starts.length}`, result: "started" };
    },
    kill: async (scope, reason) => {
      ports.kills.push({ scope, reason });
      const report = await kill.stop(scope, reason);
      if (scope !== "all") kill.resume();
      return report;
    },
  };
  const service = fakeStateService(store, ADMIN_TOKEN);
  const started: World["started"] = [];
  const chats: World["chats"] = [];
  const activeProjects: (string | null)[] = [];
  const killsSeen: string[] = [];
  const handled: World["handled"] = [];
  const watcher = new RemoteCommandWatcher({
    queue: new HttpRemoteCommandQueue({
      baseUrl: "http://state.test/",
      adminToken: ADMIN_TOKEN,
      fetchImpl: service.fetchImpl,
    }),
    store,
    clock,
    humanId: human.id,
    agentId: agent.id,
    commands: executor,
    ports,
    conversation:
      opts.conversation === false
        ? null
        : {
            chat: async (req) => {
              chats.push({ text: req.text, projectId: req.projectId, source: req.source });
              return {
                reply: `Echo: ${req.text}`,
                actions: [],
                pendingConfirmation: null,
                ttftMs: 12,
                costUsdMicro: 0,
                transcriptId: `t-${chats.length}`,
                activeProjectId: req.projectId ?? null,
              };
            },
          },
    kill,
    start: async (req) => {
      started.push(req);
      return { result: "started", sessionId: "s-remote" };
    },
    onKill: (_scope, reason) => killsSeen.push(reason),
    onActiveProject: (_h, projectId) => activeProjects.push(projectId),
    pollMs: 500,
    onHandled: (cmd, ok, result) => handled.push({ cmd, ok, result }),
  });
  return {
    store,
    clock,
    executor,
    kill,
    ports,
    human,
    other,
    agent,
    pharma,
    game,
    phone,
    desktop,
    revoked,
    otherPhone,
    service,
    watcher,
    started,
    chats,
    activeProjects,
    killsSeen,
    handled,
    enqueue: (command, params, dev = phone, targetDeviceId) =>
      store.remoteCommand.enqueue({
        device_id: dev.id,
        target: "pc",
        command,
        params: params as never,
        ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
      }),
    row: (id) => store.remoteCommand.mustGet(id),
  };
}

const scenarioPlan = (over: Record<string, unknown> = {}) => ({
  v: 1,
  kind: "plan",
  plan: [
    { name: "project.switch", params: { project: "the game" } },
    { name: "budget.set", params: { scope: "session", amountChf: 15, until: TOMORROW_0600 } },
    { name: "session.start", params: {} },
  ],
  wordsUsed: SCENARIO_WORDS,
  // The phone's card claims low risk; the daemon must not read it.
  card: { impact: { risk: "low" }, sentence: "whatever the phone showed" },
  clientId: "phone-client-1",
  confirmedAt: START,
  source: "voice",
  ...over,
});

describe("remote command watcher: scenario 9 from the phone", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    w.watcher.stop();
    await w.store.close();
  });

  it("runs the plan through the registry, starts the session on the game and completes the command", async () => {
    const cmd = await w.enqueue("start", scenarioPlan());
    expect(await w.watcher.drain()).toBe(1);

    const row = await w.row(cmd.id);
    expect(row.status).toBe("done");
    const result = row.result as JsonObject;
    expect(result).toMatchObject({
      executed: ["project.switch", "budget.set", "session.start"],
      undoOf: null,
      sessionId: "s-1",
      status: "done",
    });
    expect(typeof result.changeLogId).toBe("string");
    expect(typeof result.durationMs).toBe("number");
    expect(String(result.sentence)).toContain("Switched the active project to Game.");
    expect(String(result.sentence)).toContain(
      "Raised tonight's session budget for Game from CHF 5 to CHF 15, until 06:00.",
    );
    expect(String(result.sentence)).toContain("Started a session on Game on your PC");

    // The session started here, on the PC, on the phone's behalf: no second remote command.
    expect(w.ports.starts).toEqual([
      expect.objectContaining({
        agentId: w.agent.id,
        projectId: w.game.id,
        budgetUsdMicro: 18_750_000,
        trigger: "remote",
        deviceId: w.phone.id,
        runner: "pc",
      }),
    ]);
    expect(await w.store.remoteCommand.pending("pc")).toEqual([]);

    // The state changed as the registry says, and the change log holds the words used.
    const human = await w.store.human.mustGet(w.human.id);
    expect(human.notify_prefs[ACTIVE_PROJECT_KEY]).toBe(w.game.id);
    expect(w.activeProjects).toEqual([w.game.id]);
    const game = await w.store.project.mustGet(w.game.id);
    expect(game.settings[SESSION_OVERRIDE_KEY]).toMatchObject({
      cap_chf_micro: 15_000_000,
      cap_usd_micro: 18_750_000,
      expires_at: TOMORROW_0600,
    });
    const logs = await w.store.changeLog.list();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: result.changeLogId,
      human_id: w.human.id,
      words_used: SCENARIO_WORDS,
      source: "voice",
      undo_state: "undoable",
    });
    expect(logs[0]?.commands.map((c) => (c as { name: string }).name)).toEqual([
      "project.switch",
      "budget.set",
      "session.start",
    ]);

    // Audited, and reported through the service's routes.
    const audit = await w.store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ allowed: true, human_id: w.human.id, agent_id: w.agent.id });
    expect(w.service.calls).toEqual([
      "GET /remote/commands/pending",
      `POST /remote/commands/${cmd.id}/complete`,
      "GET /remote/commands/pending",
    ]);
    expect(w.watcher.stats).toMatchObject({ handled: 1, failed: 0, waiting: 0 });
  });

  it("an undoOf plan undoes the logged change: the session is stopped, the budget and the project are back", async () => {
    const first = await w.enqueue("start", scenarioPlan());
    await w.watcher.drain();
    const changeLogId = String(((await w.row(first.id)).result as JsonObject).changeLogId);

    const undo = await w.enqueue("stop", {
      v: 1,
      kind: "plan",
      plan: [{ name: "session.stop", params: {} }],
      wordsUsed: "undo",
      clientId: "phone-client-1",
      confirmedAt: START,
      undoOf: changeLogId,
    });
    expect(await w.watcher.drain()).toBe(1);
    const row = await w.row(undo.id);
    expect(row.status).toBe("done");
    expect(row.result).toMatchObject({ executed: ["undo"], undoOf: changeLogId });
    expect((row.result as JsonObject).changeLogId).not.toBe(changeLogId);

    expect(w.ports.kills).toEqual([
      { scope: { sessionId: "s-1" }, reason: "undo of session.start" },
    ]);
    expect((await w.store.changeLog.mustGet(changeLogId)).undo_state).toBe("undone");
    const human = await w.store.human.mustGet(w.human.id);
    expect(human.notify_prefs[ACTIVE_PROJECT_KEY]).toBe(w.pharma.id);
    const game = await w.store.project.mustGet(w.game.id);
    expect(game.settings[SESSION_OVERRIDE_KEY]).toBeUndefined();
    expect(w.activeProjects).toEqual([w.game.id, w.pharma.id]);

    // A second undo of the same row is refused, and the phone sees why.
    const again = await w.enqueue("stop", {
      v: 1,
      kind: "plan",
      plan: [],
      wordsUsed: "undo",
      undoOf: changeLogId,
    });
    await w.watcher.drain();
    const refused = await w.row(again.id);
    expect(refused.status).toBe("failed");
    expect(String((refused.result as JsonObject).error)).toMatch(/can no longer be undone/);
  });

  it("the phone's card is never trusted: a high-risk plan files a device confirmation and waits", async () => {
    const cmd = await w.enqueue(
      "start",
      scenarioPlan({
        plan: [{ name: "budget.set", params: { scope: "month", amountChf: 500 } }],
        wordsUsed: "raise the monthly cap to 500",
        card: { impact: { risk: "low" } },
      }),
    );
    expect(await w.watcher.drain()).toBe(1);
    expect((await w.row(cmd.id)).status).toBe("picked_up");
    expect(w.watcher.stats).toMatchObject({ handled: 0, waiting: 1 });
    const open = await w.store.humanRequest.open({ humanId: w.human.id });
    expect(open).toHaveLength(1);
    const request = open[0] as NonNullable<(typeof open)[number]>;
    expect(request).toMatchObject({ kind: "approval", risk: "high" });
    expect(request.options).toEqual(["approve on device", "reject"]);
    expect(request.change_card).toMatchObject({ decision: "needs_device" });
    expect(w.watcher.pendingConfirmations()).toEqual([
      expect.objectContaining({ commandId: cmd.id, requestId: request.id }),
    ]);
    expect((await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro).toBe(0);

    // Nothing settles while the request is open.
    await w.watcher.checkWaiting();
    expect((await w.row(cmd.id)).status).toBe("picked_up");

    // The phone answers with biometric; the service records the device on the request.
    await w.store.humanRequest.answer(
      request.id,
      request.version,
      {
        choice: "approve on device",
        kind: "device",
        by: w.human.id,
        device_id: w.phone.id,
        biometric: true,
      },
      w.human.id,
    );
    await w.watcher.checkWaiting();
    const done = await w.row(cmd.id);
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({
      executed: ["budget.set"],
      confirmedBy: w.phone.id,
      status: "done",
    });
    expect((await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro).toBe(625_000_000);
    expect(w.watcher.stats).toMatchObject({ handled: 1, waiting: 0 });
    expect(w.executor.getPending(request.id)).toBeUndefined();
  });

  it("a device answer without biometric, a rejection, or an expiry fails the command and nothing changes", async () => {
    const highRisk = () =>
      scenarioPlan({
        plan: [{ name: "budget.set", params: { scope: "month", amountChf: 500 } }],
        wordsUsed: "raise the monthly cap to 500",
      });
    const openRequest = async () => {
      const open = await w.store.humanRequest.open({ humanId: w.human.id });
      return open[0] as NonNullable<(typeof open)[number]>;
    };

    // Phone without the biometric flag: the policy refuses, the entry is closed, ask again.
    const noBio = await w.enqueue("start", highRisk());
    await w.watcher.drain();
    let request = await openRequest();
    await w.store.humanRequest.answer(
      request.id,
      request.version,
      {
        choice: "approve on device",
        kind: "device",
        by: w.human.id,
        device_id: w.phone.id,
        biometric: false,
      },
      w.human.id,
    );
    await w.watcher.checkWaiting();
    let row = await w.row(noBio.id);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ code: "approval_required" });
    expect(String((row.result as JsonObject).error)).toMatch(/biometric/);
    expect(w.executor.getPending(request.id)).toBeUndefined();

    // Rejected on the device.
    const rejected = await w.enqueue("start", highRisk());
    await w.watcher.drain();
    request = await openRequest();
    await w.store.humanRequest.answer(
      request.id,
      request.version,
      { choice: "reject", kind: "device", by: w.human.id, device_id: w.phone.id, biometric: true },
      w.human.id,
    );
    await w.watcher.checkWaiting();
    row = await w.row(rejected.id);
    expect(row.status).toBe("failed");
    expect(String((row.result as JsonObject).error)).toMatch(/declined/);

    // Nobody answers: the executor expires the request after ten minutes on the clock.
    const expired = await w.enqueue("start", highRisk());
    await w.watcher.drain();
    request = await openRequest();
    await w.clock.advance(10 * 60_000 + 1);
    await w.watcher.checkWaiting();
    row = await w.row(expired.id);
    expect(row.status).toBe("failed");
    expect(String((row.result as JsonObject).error)).toMatch(/expired/);
    expect((await w.store.humanRequest.mustGet(request.id)).status).toBe("expired");

    expect((await w.store.human.mustGet(w.human.id)).monthly_cap_usd_micro).toBe(0);
    expect(w.watcher.stats).toMatchObject({ handled: 3, failed: 3, waiting: 0 });
    const audit = await w.store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit.every((a) => a.allowed === false)).toBe(true);
  });

  it("a medium-risk plan without the phone's confirmation waits for a yes from the inbox", async () => {
    const cmd = await w.enqueue(
      "start",
      scenarioPlan({
        plan: [{ name: "budget.set", params: { scope: "session", amountChf: 20 } }],
        wordsUsed: "give it 20 francs",
        confirmedAt: undefined,
      }),
    );
    await w.watcher.drain();
    expect((await w.row(cmd.id)).status).toBe("picked_up");
    const open = await w.store.humanRequest.open({ humanId: w.human.id });
    const request = open[0] as NonNullable<(typeof open)[number]>;
    expect(request.change_card).toMatchObject({ decision: "needs_yes" });
    // The daemon's own answer route (the desktop app) stores the raw yes.
    await w.store.humanRequest.answer(request.id, request.version, "yes", w.human.id);
    await w.watcher.wake();
    const row = await w.row(cmd.id);
    expect(row.status).toBe("done");
    expect(row.result).toMatchObject({ executed: ["budget.set"], confirmedBy: "inbox" });
    expect((await w.store.project.mustGet(w.pharma.id)).settings.session_cap_usd_micro).toBe(
      25_000_000,
    );
  });

  it("refuses a plan that fails the registry: unknown command, invalid parameters, unknown project, pause", async () => {
    const unknown = await w.enqueue(
      "start",
      scenarioPlan({ plan: [{ name: "disk.format", params: {} }] }),
    );
    const invalid = await w.enqueue(
      "start",
      scenarioPlan({ plan: [{ name: "budget.set", params: { scope: "session", amountChf: -3 } }] }),
    );
    const noProject = await w.enqueue(
      "start",
      scenarioPlan({ plan: [{ name: "project.switch", params: { project: "Moonbase" } }] }),
    );
    const pause = await w.enqueue(
      "pause",
      scenarioPlan({ plan: [{ name: "session.pause", params: {} }] }),
    );
    const malformed = await w.enqueue("start", { v: 1, kind: "plan", plan: "nope" });
    const futureVersion = await w.enqueue("start", { v: 2, kind: "plan", plan: [] });
    const empty = await w.enqueue("start", scenarioPlan({ plan: [] }));
    expect(await w.watcher.drain()).toBe(7);
    for (const [cmd, pattern] of [
      [unknown, /disk\.format/],
      [invalid, /budget\.set: invalid parameters/],
      [noProject, /Moonbase/],
      [pause, /pause is not supported/],
      [malformed, /malformed remote envelope/],
      [futureVersion, /malformed remote envelope/],
      [empty, /plan is empty/],
    ] as const) {
      const row = await w.row(cmd.id);
      expect(row.status).toBe("failed");
      expect(String((row.result as JsonObject).error)).toMatch(pattern);
    }
    expect(await w.store.changeLog.list()).toEqual([]);
    expect(w.ports.starts).toEqual([]);
    expect(w.started).toEqual([]);
    expect((await w.store.human.mustGet(w.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
      w.pharma.id,
    );
  });
});

describe("remote command watcher: chat, verbs and authorization", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    w.watcher.stop();
    await w.store.close();
  });

  it("answers a chat envelope and the bare chat verb through the conversation agent", async () => {
    const env = await w.enqueue("start", {
      v: 1,
      kind: "chat",
      text: "what's next on the game?",
      projectId: w.game.id,
      clientId: "c-2",
    });
    const bare = await w.enqueue("chat", { text: "and on pharma?", projectId: w.pharma.id });
    expect(await w.watcher.drain()).toBe(2);
    expect((await w.row(env.id)).result).toMatchObject({
      reply: "Echo: what's next on the game?",
      transcriptId: "t-1",
      activeProjectId: w.game.id,
      clientId: "c-2",
    });
    expect((await w.row(bare.id)).result).toMatchObject({ reply: "Echo: and on pharma?" });
    expect(w.chats).toEqual([
      { text: "what's next on the game?", projectId: w.game.id, source: "phone" },
      { text: "and on pharma?", projectId: w.pharma.id, source: "phone" },
    ]);
  });

  it("chat fails plainly when no model credential is configured", async () => {
    const quiet = await world({ conversation: false });
    try {
      const cmd = await quiet.enqueue("chat", { text: "hello" });
      await quiet.watcher.drain();
      const row = await quiet.row(cmd.id);
      expect(row.status).toBe("failed");
      expect(row.result).toMatchObject({ code: "provider_auth" });
    } finally {
      await quiet.store.close();
    }
  });

  it("kill stops the registered runs within one poll and freezes; stop lifts the freeze; start asks the scheduler; pause is refused", async () => {
    const controller = new AbortController();
    w.kill.register({ agentId: w.agent.id, sessionId: "s9", controller, label: "pc session" });
    w.watcher.start();
    const killed = await w.enqueue("kill", { scope: "all", reason: "stop everything" });
    await w.clock.advance(500);
    expect(controller.signal.aborted).toBe(true);
    expect(w.kill.isFrozen({ agentId: w.agent.id })).toBe(true);
    expect((await w.row(killed.id)).result).toMatchObject({ stoppedRuns: 1, killActive: true });
    expect(w.killsSeen).toEqual(["remote kill from device " + w.phone.id + ": stop everything"]);
    expect(w.watcher.stats.lastKill?.durationMs).toBeLessThan(2_000);
    w.watcher.stop();

    const controller2 = new AbortController();
    w.kill.resume();
    w.kill.register({
      agentId: w.agent.id,
      sessionId: "s10",
      controller: controller2,
      label: "run",
    });
    const stopped = await w.enqueue("stop", {});
    await w.watcher.drain();
    expect(controller2.signal.aborted).toBe(true);
    expect(w.kill.isFrozen({ agentId: w.agent.id })).toBe(false);
    expect((await w.row(stopped.id)).result).toMatchObject({ stoppedRuns: 1 });

    // The row ADR 0030 item 7 enqueues for a phone's session.stop is understood too.
    const viaRegistry = await w.enqueue("session.stop", {
      scope: "agent",
      session: null,
      agentId: w.agent.id,
      reason: "from the registry",
    });
    await w.watcher.drain();
    expect((await w.row(viaRegistry.id)).status).toBe("done");

    await w.kill.stop("all");
    const start = await w.enqueue("start", { projectId: w.game.id, budgetUsdMicro: 2_000_000 });
    await w.watcher.drain();
    expect(w.kill.isFrozen({ agentId: w.agent.id })).toBe(false);
    expect(w.started).toEqual([
      expect.objectContaining({
        agentId: w.agent.id,
        projectId: w.game.id,
        trigger: "remote",
        budgetUsdMicro: 2_000_000,
      }),
    ]);
    expect((await w.row(start.id)).result).toMatchObject({
      result: "started",
      sessionId: "s-remote",
    });

    const pause = await w.enqueue("pause", {});
    const other = await w.enqueue("format-disk", {});
    await w.watcher.drain();
    expect((await w.row(pause.id)).status).toBe("failed");
    expect(String(((await w.row(pause.id)).result as JsonObject).error)).toMatch(/not supported/);
    expect((await w.row(other.id)).status).toBe("failed");
    expect(String(((await w.row(other.id)).result as JsonObject).error)).toMatch(
      /unknown remote command/,
    );
  });

  it("refuses another human's device, a revoked device, a command addressed to another PC and a start of another agent", async () => {
    const controller = new AbortController();
    w.kill.register({ agentId: w.agent.id, sessionId: "s11", controller, label: "run" });
    const otherAgent = await w.store.agent.insert({
      name: "Bobby",
      owner_human_id: w.other.id,
      kind: "principal",
      memory_location: "",
    });
    const theirs = await w.enqueue("kill", { scope: "all" }, w.otherPhone);
    const theirPlan = await w.enqueue("start", scenarioPlan(), w.otherPhone);
    const revoked = await w.enqueue("kill", { scope: "all" }, w.revoked);
    const addressed = await w.enqueue("kill", { scope: "all" }, w.phone, w.desktop.id);
    const otherAgentStart = await w.enqueue("start", { agentId: otherAgent.id });
    expect(await w.watcher.drain()).toBe(5);

    expect(controller.signal.aborted).toBe(false);
    expect(w.ports.starts).toEqual([]);
    expect(w.started).toEqual([]);
    expect(await w.store.changeLog.list()).toEqual([]);
    for (const [cmd, pattern] of [
      [theirs, /forbidden: device of another human/],
      [theirPlan, /forbidden: device of another human/],
      [revoked, /forbidden: revoked device/],
      [addressed, /forbidden: addressed to device/],
      [otherAgentStart, /forbidden: agent .* is not this PC's agent/],
    ] as const) {
      const row = await w.row(cmd.id);
      expect(row.status).toBe("failed");
      expect(String((row.result as JsonObject).error)).toMatch(pattern);
    }
    const audit = await w.store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit).toHaveLength(5);
    for (const a of audit) {
      expect(a.allowed).toBe(false);
      expect(a.denied_reason).toMatch(/^forbidden: /);
      expect(a.human_id).toBe(w.human.id);
    }
    // The cloud runner's queue is never touched.
    await w.store.remoteCommand.enqueue({
      device_id: w.phone.id,
      target: "cloud",
      command: "kill",
      params: {},
    });
    expect(await w.watcher.drain()).toBe(0);
    expect(await w.store.remoteCommand.pending("cloud")).toHaveLength(1);
  });

  it("a failing state service is logged and retried at the next poll; a bad admin token is reported", async () => {
    const cmd = await w.enqueue("kill", { scope: "all" });
    w.service.failOnce(500);
    await expect(w.watcher.drain()).rejects.toThrow(/state service answered 500/);
    await w.watcher.tick(); // the tick swallows the poll failure
    expect((await w.row(cmd.id)).status).toBe("done");

    const wrong = new HttpRemoteCommandQueue({
      baseUrl: "http://state.test",
      adminToken: "not-the-token",
      fetchImpl: w.service.fetchImpl,
    });
    await expect(wrong.pickUp({})).rejects.toThrow(/401/);
  });

  it("reads the answers a device, the daemon's route or the executor itself record", () => {
    expect(readAnswer("yes")).toEqual({ verdict: "approved", biometric: false });
    expect(readAnswer("approve on device")).toEqual({ verdict: "approved", biometric: false });
    expect(readAnswer("reject")).toEqual({ verdict: "declined", biometric: false });
    expect(readAnswer("maybe")).toEqual({ verdict: "unknown", biometric: false });
    expect(readAnswer(null)).toEqual({ verdict: "unknown", biometric: false });
    expect(
      readAnswer({ choice: "approve", kind: "device", by: "h", device_id: "d1", biometric: true }),
    ).toEqual({ verdict: "approved", biometric: true, deviceId: "d1" });
    expect(readAnswer({ verdict: "confirmed", kind: "tap", by: "h" })).toEqual({
      verdict: "approved",
      biometric: false,
    });
    expect(readAnswer({ verdict: "declined", kind: "no", by: "h" })).toEqual({
      verdict: "declined",
      biometric: false,
    });
    expect(readAnswer({ choice: true, deviceId: "d2" })).toEqual({
      verdict: "approved",
      biometric: false,
      deviceId: "d2",
    });
  });
});

describe("remote command watcher through the composed daemon", () => {
  const REGISTRY = join(process.cwd(), "evals", "registry");
  const clock = new SimulatedClock("2026-10-20T18:00:00Z");
  let rt: RuntimeApp;
  let service: ReturnType<typeof fakeStateService>;
  let phone: DeviceRow;
  let game: ProjectRow;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-remote-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    // The fake service serves the daemon's own store; it exists only after compose, so the
    // fetch the daemon gets resolves it lazily.
    let current: ReturnType<typeof fakeStateService> | null = null;
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Working on it." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: TZ, agentName: "Alice" },
      appVersion: "0.1.0-test",
      stateApi: { url: "http://state.test", adminToken: ADMIN_TOKEN },
      remotePollMs: 250,
      startServices: false,
      fetchImpl: (input, init) => {
        if (!current) throw new Error("fake state service not ready");
        return current.fetchImpl(input, init);
      },
    });
    service = fakeStateService(rt.store, ADMIN_TOKEN);
    current = service;
    phone = await rt.store.device.register({
      owner_human_id: rt.human.id,
      name: "Pixel 8",
      platform: "android",
      public_key: ["pk", "phone", "composed"].join("-"), // not-a-secret
      kind: "phone",
    });
    await rt.store.project.insert({ name: "PharmaWatch", autonomy_level: 2 });
    game = await rt.store.project.insert({ name: "Game", autonomy_level: 2 });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("is on when a state service is configured and reports in /health", async () => {
    expect(rt.remote).not.toBeNull();
    const { app, token } = createDaemonApp(rt);
    const health = (await (
      await app.request("/health", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { remoteCommands: unknown };
    expect(health.remoteCommands).toEqual({ enabled: true, handled: 0, waiting: 0 });
  });

  it("the scenario-9 envelope starts a real session on the game with the phone as its device, and undo stops it", async () => {
    const remote = rt.remote as RemoteCommandWatcher;
    const cmd = await rt.store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "start",
      params: scenarioPlan() as never,
    });
    expect(await remote.drain()).toBe(1);
    const row = await rt.store.remoteCommand.mustGet(cmd.id);
    expect(row.status).toBe("done");
    const result = row.result as JsonObject;
    expect(result).toMatchObject({
      executed: ["project.switch", "budget.set", "session.start"],
      undoOf: null,
    });
    expect(typeof result.sessionId).toBe("string");
    const session = await rt.store.session.mustGet(String(result.sessionId));
    expect(session).toMatchObject({
      agent_id: rt.agent.id,
      project_id: game.id,
      trigger: "remote",
      device_id: phone.id,
      runner: "pc",
      budget_cap_usd_micro: 18_750_000,
    });
    expect(["running", "completed"]).toContain(session.status);
    expect(rt.conversation?.getActiveProject(rt.human.id)).toBe(game.id);

    const undo = await rt.store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "stop",
      params: {
        v: 1,
        kind: "plan",
        plan: [],
        wordsUsed: "undo",
        undoOf: String(result.changeLogId),
      } as never,
    });
    await remote.drain();
    const undone = await rt.store.remoteCommand.mustGet(undo.id);
    expect(undone.status).toBe("done");
    expect(undone.result).toMatchObject({ executed: ["undo"], undoOf: result.changeLogId });
    expect((await rt.store.changeLog.mustGet(String(result.changeLogId))).undo_state).toBe(
      "undone",
    );
    const after = await rt.store.session.mustGet(session.id);
    expect(["killed", "stopped", "completed"]).toContain(after.status);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
  });
});
