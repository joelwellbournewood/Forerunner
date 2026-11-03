import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { DeviceRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp, remoteCommandsEnabled } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ModelRequest, StreamEvent } from "../src/provider/types.ts";
import { REMOTE_AUDIT_TOOL } from "../src/remote/index.ts";
import { ScriptedProvider } from "./helpers.ts";
import { type RuntimeWatch, watchRuntime } from "./runtime-watch.ts";

/**
 * Remote control of the PC through the composed daemon (spec R.4, R.8; ADR 0041): the daemon
 * registers itself as a `desktop` device and heartbeats it on the configured interval, the
 * phone's kill reaches a running session within 2 s on the simulated clock, and the project's
 * escalation ceiling (`critic_ceiling`) caps the retry ladder of the composed executor. Fake
 * provider, `sqlite::memory:`, SimulatedClock, no network.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const ENDED = new Set(["completed", "stopped", "failed", "killed"]);

/** The fake provider with a switch that makes every model call wait on the clock (a long run). */
class HoldingProvider extends ScriptedProvider {
  hold = false;
  holdMs = 600_000;
  held = 0;
  constructor(
    replies: ConstructorParameters<typeof ScriptedProvider>[0],
    private readonly clk: SimulatedClock,
  ) {
    super(replies, clk);
  }
  override async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.hold) {
      this.held++;
      yield { type: "message_start", model: req.model };
      await this.clk.sleep(this.holdMs, req.signal);
    }
    yield* super.stream(req);
  }
}

describe("remote control of the PC through the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let provider: HoldingProvider;
  let phone: DeviceRow;
  /**
   * The cases' work, watched (runtime-watch.ts): a wait goes on while the runtime moves and stops
   * what runs (Stop now) before it gives up with what it saw; `settle` before the runtime closes.
   */
  let watch: RuntimeWatch;
  /** The last case closes the daemon itself; then there is nothing left to settle. */
  let closed = false;
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-remote-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    provider = new HoldingProvider([{ text: "Done. Nothing to report." }], clock);
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      remote: { enabled: true, pollMs: 500, heartbeatMs: 60_000, deviceName: "J's PC" },
    });
    ({ app, token } = createDaemonApp(rt));
    watch = watchRuntime(rt, { request: req });
    phone = await rt.store.device.register({
      owner_human_id: rt.human.id,
      name: "J's phone",
      platform: "android",
      public_key: ["pk-", "P".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
  }, 120_000);
  afterAll(async () => {
    if (!closed) await watch?.settle();
    await rt?.close();
  });

  /** A project with a task on its third retry; returns the ids once the session ended. */
  async function retryRun(name: string, settings: Record<string, unknown>) {
    const project = await rt.store.project.insert({
      name,
      goal: `${name} is done`,
      autonomy_level: 2,
      settings,
    });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: `${name} task`,
      outcome: "the note is written",
      acceptance_criteria: ["the note is written"],
      risk_tier: 1,
      status: "ready",
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 300_000,
      attempt: 3,
      reason: "third retry",
    });
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId: rt.agent.id,
        projectId: project.id,
        budgetUsdMicro: 2_000_000,
      }),
    });
    expect(started.status).toBe(202);
    const rows = async () =>
      (await rt.store.session.list({ project_id: project.id } as never, { limit: 10 })).filter(
        (s) => s.summary !== "conversation",
      );
    await watch.until(
      `the ${name} session to end`,
      async () => {
        const all = await rows();
        return all.length > 0 && all.every((s) => ENDED.has(s.status));
      },
      { seen: async () => (await rows()).map((s) => `${s.id} ${s.status}`).join(", ") || "none" },
    );
    return { project, task };
  }

  it("registers the daemon as a desktop device of the human and heartbeats it on the interval", async () => {
    expect(rt.remote.enabled).toBe(true);
    const device = rt.remote.device;
    expect(device).toMatchObject({ kind: "desktop", owner_human_id: rt.human.id, name: "J's PC" });
    expect(rt.remote.presence?.stats.running).toBe(true);
    expect(rt.remote.watcher?.stats).toMatchObject({ running: true, pollMs: 500 });
    const id = (device as DeviceRow).id;
    await watch.until(
      "the first heartbeat",
      async () => (await rt.store.device.mustGet(id)).last_seen !== null,
      { seen: async () => (await rt.store.device.mustGet(id)).last_seen ?? "never seen" },
    );
    expect((await rt.store.device.mustGet(id)).last_seen).toBe("2026-10-20T08:00:00.000Z");
    await clock.advance(60_000);
    expect((await rt.store.device.mustGet(id)).last_seen).toBe("2026-10-20T08:01:00.000Z");
    await clock.advance(60_000);
    expect((await rt.store.device.mustGet(id)).last_seen).toBe("2026-10-20T08:02:00.000Z");
  });

  it("remoteCommandsEnabled: on for a shared state, off for a local sqlite one, overridable, never without services", () => {
    const pg = "postgres://user:pw@db.example.test/forerunner"; // not-a-secret
    expect(remoteCommandsEnabled({}, pg, true)).toBe(true);
    expect(remoteCommandsEnabled({}, "sqlite:/home/j/state.sqlite", true)).toBe(false);
    expect(remoteCommandsEnabled({}, "sqlite::memory:", true)).toBe(false);
    expect(
      remoteCommandsEnabled({ FORERUNNER_REMOTE_COMMANDS: "1" }, "sqlite::memory:", true),
    ).toBe(true);
    expect(remoteCommandsEnabled({ FORERUNNER_REMOTE_COMMANDS: "0" }, pg, true)).toBe(false);
    expect(remoteCommandsEnabled({}, "sqlite::memory:", true, true)).toBe(true);
    expect(remoteCommandsEnabled({}, pg, true, false)).toBe(false);
    expect(remoteCommandsEnabled({ FORERUNNER_REMOTE_COMMANDS: "1" }, pg, false, true)).toBe(false);
  });

  it("a project ceiling of sonnet never escalates the third retry to opus; the default ceiling does", async () => {
    const capped = await retryRun("Capped", { critic_ceiling: "sonnet" });
    const cappedRuns = (await rt.store.run.forTask(capped.task.id)).filter(
      (r) => r.specialist === "coder",
    );
    expect(cappedRuns.length).toBeGreaterThanOrEqual(1);
    expect(cappedRuns.map((r) => r.model)).toEqual(cappedRuns.map(() => "fake-sonnet"));

    // The first rung: the coder's default (sonnet) comes down to haiku and the retry stays there.
    const floor = await retryRun("Floor", { critic_ceiling: "haiku" });
    const floorRuns = (await rt.store.run.forTask(floor.task.id)).filter(
      (r) => r.specialist === "coder",
    );
    expect(floorRuns.length).toBeGreaterThanOrEqual(1);
    expect(floorRuns.map((r) => r.model)).toEqual(floorRuns.map(() => "fake-haiku"));

    const free = await retryRun("Free", {});
    const freeRuns = (await rt.store.run.forTask(free.task.id)).filter(
      (r) => r.specialist === "coder",
    );
    expect(freeRuns.length).toBeGreaterThanOrEqual(1);
    expect(freeRuns[0]?.model).toBe("fake-opus");
  }, 120_000);

  it("a kill from the phone stops the running session within 2 s", async () => {
    const project = await rt.store.project.insert({
      name: "Long",
      goal: "runs for a while",
      autonomy_level: 2,
    });
    await rt.store.task.insert({
      project_id: project.id,
      title: "Long task",
      outcome: "never, it is killed",
      acceptance_criteria: ["the session is killed before this is met"],
      risk_tier: 1,
      status: "ready",
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 300_000,
      reason: "seed",
    });
    provider.hold = true;
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId: project.id }),
    });
    expect(started.status).toBe(202);
    // The coder's model call is waiting on the clock: a run is registered with the kill switch.
    const sessions = () =>
      rt.store.session
        .list({ project_id: project.id } as never, { limit: 10 })
        .then((rows) => rows.filter((s) => s.summary !== "conversation"));
    const sessionSeen = async () =>
      (await sessions()).map((s) => `${s.id} ${s.status}`).join(", ") || "no session";
    await watch.until(
      "a run registered with the kill switch",
      () => rt.kill.activeCount({ agentId: rt.agent.id }) > 0,
      { seen: sessionSeen },
    );
    expect((await sessions())[0]?.status).toBe("running");

    // The phone's "stop everything" (ADR 0032 item 4): verb kill, one session.stop step.
    const row = await rt.store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "kill",
      params: {
        v: 1,
        kind: "plan",
        plan: [{ name: "session.stop", params: { scope: "all" } }],
        wordsUsed: "stop everything",
        card: { what: "every running session" },
        clientId: "c-kill",
        confirmedAt: clock.nowIso(),
      },
    });
    const t0 = Date.now();
    const simulated0 = clock.now();
    await clock.advance(500);
    await watch.until(
      "the phone's kill to stop the session",
      async () => (await sessions())[0]?.status === "killed",
      { seen: sessionSeen },
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(clock.now() - simulated0).toBe(500);
    expect(rt.kill.activeCount({ agentId: rt.agent.id })).toBe(0);
    await watch.until(
      "the kill command to be done",
      async () => (await rt.store.remoteCommand.mustGet(row.id)).status === "done",
      { seen: async () => (await rt.store.remoteCommand.mustGet(row.id)).status },
    );
    const done = await rt.store.remoteCommand.mustGet(row.id);
    expect(done.result).toMatchObject({
      kind: "plan",
      status: "done",
      executed: ["session.stop"],
      clientId: "c-kill",
    });
    const audit = await rt.store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ allowed: true, human_id: rt.human.id, agent_id: rt.agent.id });
    expect(rt.remote.watcher?.stats.handled).toBe(1);
    provider.hold = false;
    rt.kill.resume();
  }, 120_000);

  it("a pause from the phone ends the running session at the next task boundary: the task in flight finishes, the next never starts", async () => {
    const project = await rt.store.project.insert({
      name: "Paced",
      goal: "two tasks, one pause",
      autonomy_level: 2,
    });
    const task = (title: string) =>
      rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: [`${title} is done`],
        risk_tier: 1,
        status: "ready",
        budget_usd_micro: 1_000_000,
        est_cost_usd_micro: 300_000,
        reason: "seed",
      });
    const first = await task("First task");
    const second = await task("Second task");
    provider.hold = true;
    provider.holdMs = 2_000;
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId: rt.agent.id,
        projectId: project.id,
        budgetUsdMicro: 2_000_000,
      }),
    });
    expect(started.status).toBe(202);
    const sessions = () =>
      rt.store.session
        .list({ project_id: project.id } as never, { limit: 10 })
        .then((rows) => rows.filter((s) => s.summary !== "conversation"));
    // The first task is in flight: its run row exists and the coder's model call waits on the clock.
    const firstSeen = async () =>
      `${(await rt.store.run.forTask(first.id)).length} run(s) of the first task, ${
        provider.held
      } held model call(s); sessions ${
        (await sessions()).map((s) => `${s.id} ${s.status}`).join(", ") || "none"
      }`;
    await watch.until(
      "the first task's run",
      async () => (await rt.store.run.forTask(first.id)).length > 0,
      { seen: firstSeen },
    );
    await watch.until(
      "the first task's model call to wait on the clock",
      () => provider.held >= 1,
      {
        seen: firstSeen,
      },
    );
    const session = (await sessions())[0];
    expect(session?.status).toBe("running");
    const sessionId = (session as { id: string }).id;

    // The phone's plain "pause" (ADR 0032 item 4).
    const row = await rt.store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command: "pause",
      params: { reason: "lunch" },
    });
    await clock.advance(500);
    await watch.until(
      "the pause command to be done",
      async () => (await rt.store.remoteCommand.mustGet(row.id)).status === "done",
      { seen: async () => (await rt.store.remoteCommand.mustGet(row.id)).status },
    );
    expect((await rt.store.remoteCommand.mustGet(row.id)).result).toMatchObject({
      kind: "pause",
      status: "done",
      commands: ["session.pause"],
    });
    // Paused at once: the row says so, the run is still alive (nothing was aborted) and the
    // runner's inbox holds the pause it reads before the next task.
    expect((await rt.store.session.mustGet(sessionId)).status).toBe("paused");
    expect(rt.kill.activeCount({ sessionId })).toBeGreaterThan(0);
    const inbox = await rt.store.message.inbox({ agentId: rt.agent.id }, { unreadOnly: true });
    expect(inbox.map((m) => m.body)).toContainEqual(`pause: lunch (session ${sessionId})`);

    // The task in flight finishes; the runner reads the pause at the boundary and closes the
    // session with its handoff instead of starting the second task.
    provider.hold = false;
    await clock.advance(2_000);
    await watch.sessionOver(sessionId);
    const ended = await rt.store.session.mustGet(sessionId);
    expect(ended.status).toBe("stopped");
    expect(ended.handoff).toMatchObject({ stop_reason: "stopped_by_message" });
    expect((ended.handoff as { next: string[] }).next).toContain(second.id);
    expect((await rt.store.run.forTask(first.id)).length).toBeGreaterThanOrEqual(1);
    expect(await rt.store.run.forTask(second.id)).toHaveLength(0);
    expect(rt.kill.activeCount({ sessionId })).toBe(0);
    const read = await rt.store.message.inbox({ agentId: rt.agent.id }, { unreadOnly: true });
    expect(read.map((m) => m.body)).not.toContainEqual(`pause: lunch (session ${sessionId})`);
    // The change is in the log with its undo; the audit row names the command.
    const log = await rt.commands.changeLog({ humanId: rt.human.id });
    expect(
      log.some((r) => r.commands.some((c) => (c as { name: string }).name === "session.pause")),
    ).toBe(true);
    const audit = await rt.store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit.some((a) => a.allowed && a.input_summary.includes('"command":"pause"'))).toBe(
      true,
    );
    provider.holdMs = 600_000;
  }, 120_000);

  it("the watcher and the heartbeat stop with the daemon", async () => {
    const beats = rt.remote.presence?.stats.beats ?? 0;
    const handled = rt.remote.watcher?.stats.handled ?? 0;
    await watch.settle();
    closed = true;
    await rt.close();
    expect(rt.remote.watcher?.stats.running).toBe(false);
    expect(rt.remote.presence?.stats.running).toBe(false);
    // The timers were cancelled: nothing beats or polls after close.
    await clock.advance(120_000);
    expect(rt.remote.presence?.stats.beats).toBe(beats);
    expect(rt.remote.watcher?.stats.handled).toBe(handled);
  });
});
