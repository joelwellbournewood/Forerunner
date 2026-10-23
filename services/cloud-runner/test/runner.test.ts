import { existsSync, readFileSync } from "node:fs";
import { MemoryGitHost } from "@forerunner/capabilities";
import { EmailSettingsStore, TestMailbox } from "@forerunner/capabilities/email/index";
import { join, SimulatedClock } from "@forerunner/platform";
import { planIdOf, planKeyOf } from "@forerunner/runtime";
import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider, generateDkimKeyPair, LocalMailServer, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { type CloudRunner, startCloudRunner } from "../src/runner.ts";
import {
  addReadyTask,
  advanceUntil,
  OWNER_EMAIL,
  type Seed,
  seedWorld,
  tempHome,
  testConfig,
  waitFor,
} from "./helpers.ts";

/**
 * The composed runner on a file-backed SQLite store (two connections share it, as the runner's
 * identity store and the runtime's store share Postgres in production): health route and
 * readiness file, the PC-wins rule applied to a schedule, a scheduled session completing on
 * the fake provider with runner "cloud" and the runner's billing source, and an email task
 * acknowledged and run end to end. The Postgres variant with the overnight run and the kill
 * from the shared state is `runner.integration.test.ts`.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const DOMAIN = "example.test";
const AGENT_ADDRESS = `alice@${DOMAIN}`;
const MARKER = "[FR-test]";
const OWNER_PASSWORD = ["owner", "pass", "1"].join("-"); // not-a-secret
const AGENT_PASSWORD = ["agent", "pass", "2"].join("-"); // not-a-secret

interface World {
  home: string;
  clock: SimulatedClock;
  store: StateStore;
  seed: Seed;
  provider: FakeProvider;
  server: LocalMailServer;
  runner: CloudRunner;
  stop(): Promise<void>;
}

async function world(
  opts: { env?: NodeJS.ProcessEnv; start?: string; schedules?: unknown[] } = {},
): Promise<World> {
  const home = tempHome();
  const clock = new SimulatedClock(opts.start ?? "2026-03-02T22:00:00Z");
  const stateUrl = `sqlite:${join(home, "shared.sqlite")}`;
  const store = await openStore({ url: stateUrl, clock });
  const seed = await seedWorld(store, {
    projectSettings: {
      schedules: opts.schedules ?? [{ kind: "every", everyMinutes: 120 }],
    },
  });
  await store.billingSource.insert({
    human_id: seed.human.id,
    kind: "api_key",
    label: "Console key",
    credential_ref: "anthropic_api_key",
    limits: {},
    enabled: true,
    priority: 2,
  });
  const keys = generateDkimKeyPair(1024);
  const server = await LocalMailServer.start({
    domains: [DOMAIN],
    dkim: { selector: "fr1", ...keys },
    clock,
  });
  server.createMailbox(OWNER_EMAIL, OWNER_PASSWORD);
  server.createMailbox(AGENT_ADDRESS, AGENT_PASSWORD);
  await new EmailSettingsStore(store.extension, clock).update(seed.agent.id, {
    settings: {
      mode: "full_discretion",
      mailbox: { address: AGENT_ADDRESS, imap: null, smtp: null },
    },
    commands: { enabled: true, registeredHumanAddress: OWNER_EMAIL, marker: MARKER },
  });
  const vault = new MemoryVault();
  await vault.set("anthropic_api_key", ["api", "key", "value"].join("-")); // not-a-secret
  const provider = new FakeProvider({ clock, latency: "none", replies: [], onNoMatch: "echo" });
  const { env, config } = testConfig(home, stateUrl, {
    FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS: server.authservId,
    ...(opts.env ?? {}),
  });
  const runner = await startCloudRunner({
    config,
    env,
    clock,
    vault,
    provider,
    gitHost: new MemoryGitHost("alice"),
    registryDir: REGISTRY,
    sandboxDetection: { engine: "none", reason: "test", checkedAt: clock.nowIso() },
    mailboxFactory: async () => new TestMailbox({ server, address: AGENT_ADDRESS, clock }),
  });
  return {
    home,
    clock,
    store,
    seed,
    provider,
    server,
    runner,
    async stop() {
      await runner.stop();
      await server.stop();
      await store.close();
    },
  };
}

let w: World | undefined;
afterEach(async () => {
  await w?.stop();
  w = undefined;
});

describe("cloud runner", () => {
  it("starts headless: health route on the loopback, readiness file, device row, billing source, schedules", async () => {
    w = await world();
    const health = (await (await fetch(`${w.runner.health.url}/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health).toMatchObject({
      ok: true,
      runnerId: "runner-test",
      version: "0.1.0-test",
      human: { name: "J" },
      agent: { name: "Alice" },
      billing: { kind: "api_key" },
      provider: "fake",
      pcOnline: { pcOnline: false },
      activeSessions: 0,
      killActive: false,
      schedules: 1,
      email: { state: "watching", address: AGENT_ADDRESS },
      ready: true,
    });
    expect(JSON.stringify(health)).not.toContain("api-key-value");
    expect((await fetch(`${w.runner.health.url}/ready`)).status).toBe(200);
    expect((await fetch(`${w.runner.health.url}/nope`)).status).toBe(404);
    const readyFile = w.runner.config.health.readyFile;
    expect(existsSync(readyFile)).toBe(true);
    expect(JSON.parse(readFileSync(readyFile, "utf8"))).toMatchObject({
      runnerId: "runner-test",
      healthUrl: w.runner.health.url,
    });
    const device = await w.store.device.mustGet(w.runner.device.id);
    expect(device).toMatchObject({
      kind: "runner",
      name: "runner-test",
      owner_human_id: w.seed.human.id,
    });
    expect(device.last_seen).toBe(w.clock.nowIso());
    expect(w.runner.scheduler.list().map((s) => s.id)).toEqual([`project:${w.seed.project.id}:0`]);
    const url = w.runner.health.url;
    await w.runner.stop();
    expect(existsSync(readyFile)).toBe(false);
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it("leaves a schedule to an online PC and runs it itself once the PC is gone", async () => {
    w = await world();
    const desktop = await w.store.device.register({
      owner_human_id: w.seed.human.id,
      name: "J's PC",
      platform: "linux",
      public_key: "pk-desktop",
      kind: "desktop",
    });
    await w.store.device.seen(desktop.id);
    // The PC daemon heartbeats its device row every minute while it is on.
    let beating = true;
    const beat = () => {
      if (!beating) return;
      void w?.store.device.seen(desktop.id);
      w?.clock.setTimeout(beat, 60_000);
    };
    w.clock.setTimeout(beat, 60_000);
    await addReadyTask(w.store, w.seed.project.id, "Write the readme");
    // "every 120 minutes" is due at the first tick; the PC is on, so the runner stands back.
    await w.clock.advance(60_000);
    await waitFor(async () => ((await w?.runner.status())?.schedulesSkipped ?? 0) > 0 || undefined);
    expect((await w.runner.status()).sessionsStarted).toBe(0);
    expect(await w.store.session.list({ agent_id: w.seed.agent.id })).toHaveLength(0);

    // Two hours later the PC is off (no heartbeat for over an hour): the runner takes over.
    beating = false;
    await w.clock.advance(2 * 60 * 60_000 + 60_000);
    const session = await waitFor(async () => {
      const rows = await w?.store.session.list({ agent_id: w.seed.agent.id });
      return rows?.find((s) => s.status === "completed");
    });
    expect(session).toMatchObject({
      runner: "cloud",
      device_id: w.runner.device.id,
      trigger: "schedule",
      project_id: w.seed.project.id,
    });
    expect((await w.store.task.list({ project_id: w.seed.project.id }))[0]?.status).toBe("done");
    // The runner's executor takes the composed runtime's specialists (ADR 0043): the coder was
    // offered the loop driver's built-ins for its `cc:` names, never the names as written.
    const coder = w.runner.rt.specialists("coder");
    expect(coder?.allowedTools).toEqual(["read_file", "write_file", "run_command", "list_dir"]);
    const coderCalls = w.provider.calls.filter((c) => c.request.system === coder?.prompt);
    expect(coderCalls.length).toBeGreaterThan(0);
    for (const c of coderCalls) {
      expect(c.request.tools?.map((t) => t.name).sort()).toEqual([
        "list_dir",
        "read_file",
        "run_command",
        "write_file",
      ]);
    }
    const ledger = await w.store.costLedger.list({ session_id: session.id });
    expect(ledger.length).toBeGreaterThan(0);
    for (const e of ledger) {
      expect(e.billing_source_id).toBe(w.runner.billing.sourceId);
      expect(e.human_id).toBe(w.seed.human.id);
    }
  });

  it("startSession reports deferred, not started, when the PC rule skipped the firing", async () => {
    w = await world({ schedules: [] });
    const desktop = await w.store.device.register({
      owner_human_id: w.seed.human.id,
      name: "J's PC",
      platform: "linux",
      public_key: "pk-desktop",
      kind: "desktop",
    });
    await w.store.device.seen(desktop.id);
    await addReadyTask(w.store, w.seed.project.id, "Write the readme");
    expect(await w.runner.startSession({ projectId: w.seed.project.id })).toBe("deferred");
    const status = await w.runner.status();
    expect(status).toMatchObject({ sessionsStarted: 0, schedulesSkipped: 1 });
    expect(await w.store.session.list({ agent_id: w.seed.agent.id })).toHaveLength(0);
    // Forced (what a remote start does) it runs regardless of the PC.
    expect(await w.runner.startSession({ projectId: w.seed.project.id, force: true })).toBe(
      "started",
    );
    const session = await waitFor(async () => {
      const rows = await w?.store.session.list({ agent_id: w.seed.agent.id });
      return rows?.find((s) => s.status === "completed");
    });
    expect(session).toMatchObject({ runner: "cloud", trigger: "manual" });
  });

  it("a third retry on the runner stays under the project's critic_ceiling (spec D.3)", async () => {
    // The runner composes its own executor (no `projectCeiling` reader): the executor reads
    // the project's ceiling itself, so a task the PC left at attempt 3 never climbs to opus
    // here when the project is capped at sonnet.
    w = await world({ schedules: [] });
    await w.store.project.patch(w.seed.project.id, { settings: { critic_ceiling: "sonnet" } });
    const task = await addReadyTask(w.store, w.seed.project.id, "Third retry", { attempt: 3 });
    expect(await w.runner.startSession({ projectId: w.seed.project.id, force: true })).toBe(
      "started",
    );
    await waitFor(async () => {
      const rows = await w?.store.session.list({ agent_id: w.seed.agent.id });
      return rows?.find((s) => s.status === "completed");
    });
    const runs = (await w.store.run.forTask(task.id)).filter((r) => r.specialist === "coder");
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.map((r) => r.model)).toEqual(runs.map(() => "fake-sonnet"));
  });

  it("a peer's handoff in the inbox starts a message-triggered cloud session while no PC is online", async () => {
    w = await world({ schedules: [], env: { FORERUNNER_RUNNER_INBOX_POLL_MS: "30000" } });
    expect(w.runner.scheduler.list()).toHaveLength(0);
    const peer = await w.store.agent.insert({
      name: "Bob",
      owner_human_id: w.seed.human.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    await addReadyTask(w.store, w.seed.project.id, "Write the readme");
    await w.clock.advance(1_000);
    const handoff = await w.store.message.send({
      from_agent_id: peer.id,
      to_agent_id: w.seed.agent.id,
      project_id: w.seed.project.id,
      type: "handoff",
      body: "The API half is in; the readme is yours.",
      requires_ack: false,
    });
    await w.clock.advance(30_000);
    const session = await waitFor(async () => {
      const rows = await w?.store.session.list({ agent_id: w.seed.agent.id });
      return rows?.find((s) => s.status === "completed");
    });
    expect(session).toMatchObject({
      runner: "cloud",
      trigger: "message",
      project_id: w.seed.project.id,
      device_id: w.runner.device.id,
    });
    expect((await w.store.message.mustGet(handoff.id)).read_at).not.toBeNull();
    expect((await w.store.task.list({ project_id: w.seed.project.id }))[0]?.status).toBe("done");
    const status = await w.runner.status();
    expect(status.inbox).toMatchObject({ triggered: 1, deferred: 0, lastReason: "1 new message" });
    expect(status.sessionsStarted).toBe(1);
    // Nothing new: no second session for the same handoff.
    await w.clock.advance(60_000);
    expect(await w.store.session.list({ agent_id: w.seed.agent.id })).toHaveLength(1);
  });

  // Review of 2026-10-23 (w5-review-findings): the inbox trigger shares the daemon's plan mark,
  // so a start it records as `started` consumes the answer for both producers. When the
  // runner's session then fails in the background (here `claim_conflict`: a session of the
  // agent left `running` by a runner that died), the card must say so and the human must be
  // warned, as on the PC daemon; otherwise the approval is spent and nothing ever runs.
  it("an approved plan whose cloud session fails in the background is marked start_failed and the human is warned", async () => {
    w = await world({ schedules: [], env: { FORERUNNER_RUNNER_INBOX_POLL_MS: "30000" } });
    const world_ = w;
    const task = await addReadyTask(w.store, w.seed.project.id, "Write the readme");
    const stale = await w.store.session.insert({
      agent_id: w.seed.agent.id,
      project_id: w.seed.project.id,
      trigger: "schedule",
      runner: "cloud",
    });
    await w.store.session.start(stale.id, stale.version);
    const filing = await w.store.session.insert({
      agent_id: w.seed.agent.id,
      project_id: w.seed.project.id,
      trigger: "schedule",
      runner: "cloud",
    });
    await w.clock.advance(1_000);
    const planId = planIdOf(filing.id, [{ taskId: task.id }]);
    const plan = await w.store.humanRequest.insert({
      human_id: w.seed.human.id,
      project_id: w.seed.project.id,
      session_id: filing.id,
      kind: "approval",
      why: "The plan for this session",
      steps: ["Write the readme"],
      options: ["approve", "reject"],
      blocking: true,
      risk: "medium",
      change_card: { key: planKeyOf(filing.id), plan_id: planId, plan: {} },
      author_agent: w.seed.agent.id,
    });
    await w.store.humanRequest.answer(plan.id, plan.version, "approve", w.seed.human.id);
    await w.clock.advance(30_000);
    const marked = await waitFor(async () => {
      const row = await world_.store.humanRequest.mustGet(plan.id);
      return (row.change_card as { outcome?: string }).outcome === "start_failed" ? row : undefined;
    });
    expect(marked.change_card).toMatchObject({
      plan_id: planId,
      outcome: "start_failed",
      error: expect.stringContaining("already has an active session"),
    });
    const warnings = (
      await w.store.message.inbox({ humanId: w.seed.human.id }, { limit: 50 })
    ).filter((m) => m.type === "warning" && m.body.includes(plan.id));
    expect(warnings).toHaveLength(1);
    expect((await w.store.task.mustGet(task.id)).status).toBe("ready");
  });

  it("an emailed task is acknowledged within a minute and runs as a capped cloud session with a completion mail", async () => {
    w = await world();
    w.provider.pushReplies(
      textReply(
        JSON.stringify({
          kind: "task",
          project: "Sample",
          title: "Fix CI",
          summary: "Fix the failing CI build",
          answer: null,
        }),
        { when: { lastUserIncludes: "Please fix CI" } },
      ),
    );
    const sentAt = w.clock.now();
    const sent = await w.server.sendFrom(OWNER_EMAIL, {
      to: AGENT_ADDRESS,
      subject: `${MARKER} Fix CI`,
      text: "Please fix CI before the morning.",
    });
    const ownerBox = w.server.mailbox(OWNER_EMAIL);
    await advanceUntil(w.clock, () => (ownerBox?.messages.length ?? 0) > 0, 60_000);
    expect(w.clock.now() - sentAt).toBeLessThan(60_000);
    const ack = ownerBox?.messages[0];
    expect(ack?.parsed.text).toContain("Understood: Fix the failing CI build");
    expect(ack?.parsed.text).toMatch(/Session log: forerunner:\/\/sessions\//);

    const session = await waitFor(async () => {
      const rows = await w?.store.session.list({ agent_id: w.seed.agent.id, trigger: "email" });
      return rows?.find((s) => s.status === "completed");
    });
    expect(session).toMatchObject({ runner: "cloud", budget_cap_usd_micro: 6_250_000 });
    const events = await w.store.event.list(session.id);
    const started = events.find((e) => e.type === "session.started");
    expect(started?.payload).toMatchObject({ autonomy: 2, budgetCapUsdMicro: 6_250_000 });
    const tasks = await w.store.task.list({ project_id: w.seed.project.id });
    expect(tasks).toHaveLength(1);
    // The handler files email tasks at risk tier 1: the critic closes them, not the runner.
    expect(tasks[0]).toMatchObject({ title: "Fix CI", status: "in_review" });

    const completion = await waitFor(() =>
      ownerBox?.messages.find((m) => (m.parsed.text ?? "").startsWith("Done:")),
    );
    expect(completion.parsed.inReplyTo).toBe(sent.messageId);
    const audit = await w.store.auditLog.list({ agentId: w.seed.agent.id, tool: "email.command" });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.result_summary ?? "{}")).toMatchObject({
      outcome: "task",
      sessionId: session.id,
    });
  });
});
