import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { mirrorAgentId } from "@forerunner/capabilities";
import { appDirs, isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { MIGRATIONS, openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthView, PeerFeedView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { MEMORY_CONSOLIDATION_AGENT_ID } from "../src/loop/memory.ts";
import { buildPeerFeed } from "../src/session/peers.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { SchemaSync, SYNC_GATE_AUTHOR, SYNC_PAUSED_KEY } from "../src/update/sync.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Spec M, last bullet: "both apps must be on a compatible version before sync resumes". The
 * shared store's `schema_migrations` is the peer side; `MIGRATIONS.length` is this install's.
 * A store opened here is at the code's version, so an install "behind" is a SchemaSync whose
 * `localSchemaVersion` is lower, and a peer "ahead" is a migration row the peer wrote.
 */
const CODE = MIGRATIONS.length;
const REGISTRY = join(process.cwd(), "evals", "registry");
const grant = { allowedTools: [], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  project: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-10-20T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
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
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [alice] },
      small_project_mode: false,
      active: true,
    })
  ).id;
  return { store, clock, human, alice, project };
}

const idleExecutor: TaskExecutor = {
  async execute({ task }) {
    return { outcome: "failed", summary: `${task.title}: not run`, costUsdMicro: 0 };
  },
};

function runner(w: World, schemaSync: SchemaSync): SessionRunner {
  return new SessionRunner({
    store: w.store,
    clock: w.clock,
    tokens: new TokenIssuer({ now: () => w.clock.now() }),
    kill: new KillSwitch(),
    planner: new StaticPlanner(),
    executor: idleExecutor,
    schemaSync,
  });
}

const feedOf = (w: World, schemaSync: SchemaSync) =>
  buildPeerFeed({
    store: w.store,
    clock: w.clock,
    agentId: w.alice,
    projectId: w.project,
    peerIds: [],
    schemaSync,
  });

const startOf = (w: World, schemaSync: SchemaSync) =>
  runner(w, schemaSync).start({
    agentId: w.alice,
    projectId: w.project,
    trigger: "manual",
    budgetCapUsdMicro: 1_000_000,
    grant,
  });

async function refused(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

const sessionsOf = (w: World) =>
  w.store.session.list({ agent_id: w.alice } as never, { limit: 100 });
const auditOf = (w: World, tool: string) => w.store.auditLog.list({ humanId: w.human, tool });
const gateRequests = (w: World) =>
  w.store.humanRequest.list({ author_agent: SYNC_GATE_AUTHOR } as never, { limit: 100 });

describe("schema sync gate on the shared state", () => {
  it("sync refused while schema versions differ: audited once, one non-blocking inbox item", async () => {
    const w = await world();
    // This install's code ships one migration fewer than the shared store carries.
    const behind = new SchemaSync({
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      localSchemaVersion: CODE - 1,
    });
    const compat = await behind.refresh("startup");
    expect(compat.compatible).toBe(false);
    expect(compat.action).toBe("update_local");
    expect(behind.paused).toBe(true);
    expect(behind.status()).toMatchObject({ paused: true, local: CODE - 1, peer: CODE });

    // The peer feed and a session are both refused; no session row is ever written.
    const feed = await refused(feedOf(w, behind));
    expect(isForerunnerError(feed, "unavailable")).toBe(true);
    expect((feed as { details: { action: string } }).details.action).toBe("update_local");
    expect(isForerunnerError(await refused(startOf(w, behind)), "unavailable")).toBe(true);
    expect(await sessionsOf(w)).toHaveLength(0);

    // Audited: the pause once, each refused call site once.
    const paused = await auditOf(w, "sync.paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ allowed: false, denied_reason: compat.reason });
    expect(JSON.parse(paused[0]?.input_summary ?? "{}")).toMatchObject({
      source: "startup",
      local: CODE - 1,
      peer: CODE,
      action: "update_local",
    });
    const refusals = await auditOf(w, "sync.refused");
    expect(
      refusals.map((r) => (JSON.parse(r.input_summary) as { what: string }).what).sort(),
    ).toEqual(["peer_feed", "session.start"]);
    expect(refusals.every((r) => !r.allowed)).toBe(true);

    // Surfaced once, non-blocking, naming what to do.
    const open = await w.store.humanRequest.open({ humanId: w.human });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "info",
      blocking: false,
      author_agent: SYNC_GATE_AUTHOR,
      change_card: { key: SYNC_PAUSED_KEY, action: "update_local", local: CODE - 1, peer: CODE },
    });
    expect(open[0]?.why).toContain("update this install");
    expect(open[0]?.steps[0]).toContain("Update this install");

    // Not every tick: more checks and more refusals add no item and no pause row.
    await behind.refresh("tick");
    await behind.refresh("peer_feed");
    await refused(feedOf(w, behind));
    await refused(startOf(w, behind));
    expect(await w.store.humanRequest.open({ humanId: w.human })).toHaveLength(1);
    expect(await auditOf(w, "sync.paused")).toHaveLength(1);
    expect(await auditOf(w, "sync.refused")).toHaveLength(2);
    expect(behind.status().refused).toBe(4);

    // A restart of the same, still behind, install reuses the open item.
    const restarted = new SchemaSync({
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      localSchemaVersion: CODE - 1,
    });
    expect((await restarted.refresh("startup")).compatible).toBe(false);
    expect(await gateRequests(w)).toHaveLength(1);
    await w.store.close();
  });

  it("allowed again after the update: the item is withdrawn, the feed and a session go through", async () => {
    const w = await world();
    const behind = new SchemaSync({
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      localSchemaVersion: CODE - 1,
    });
    await behind.refresh("startup");
    expect(isForerunnerError(await refused(feedOf(w, behind)), "unavailable")).toBe(true);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toHaveLength(1);

    // The install updated and restarted: its code now ships the store's version.
    const updated = new SchemaSync({ store: w.store, clock: w.clock, humanId: w.human });
    expect(updated.localSchemaVersion).toBe(CODE);
    const compat = await updated.refresh("startup");
    expect(compat).toMatchObject({ compatible: true, reason: "ok", action: "none" });
    expect(updated.paused).toBe(false);
    expect(await w.store.humanRequest.open({ humanId: w.human })).toHaveLength(0);
    expect((await gateRequests(w)).map((r) => r.status)).toEqual(["withdrawn"]);

    const feed = await feedOf(w, updated);
    expect(feed.schemaVersion).toBe(CODE);
    const result = await startOf(w, updated);
    expect(result.status).toBe("completed");
    expect(await sessionsOf(w)).toHaveLength(1);
    expect(await auditOf(w, "sync.refused")).toHaveLength(1);
    await w.store.close();
  });

  it("a peer's migration is learned from the peer feed; a peer rollback resumes sync in place", async () => {
    const w = await world();
    const current = new SchemaSync({ store: w.store, clock: w.clock, humanId: w.human });
    expect((await current.refresh("startup")).compatible).toBe(true);
    expect((await feedOf(w, current)).schemaVersion).toBe(CODE);

    // A peer on newer code migrated the shared store.
    await w.store.db.query(
      'INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (?, ?, ?)',
      [CODE + 1, "peer-migration", w.clock.nowIso()],
    );
    expect(isForerunnerError(await refused(feedOf(w, current)), "unavailable")).toBe(true);
    expect(current.status()).toMatchObject({
      paused: true,
      local: CODE,
      peer: CODE + 1,
      action: "update_local",
    });
    expect(current.gate.events.map((e) => e.type)).toEqual(["sync_paused"]);
    expect(JSON.parse((await auditOf(w, "sync.paused"))[0]?.input_summary ?? "{}").source).toBe(
      "peer_feed",
    );
    expect(await w.store.humanRequest.open({ humanId: w.human })).toHaveLength(1);
    expect(isForerunnerError(await refused(startOf(w, current)), "unavailable")).toBe(true);

    // The peer rolled back across its migration (ADR 0015): the store is back at this version.
    await w.store.db.query('DELETE FROM "schema_migrations" WHERE "version" = ?', [CODE + 1]);
    expect((await feedOf(w, current)).schemaVersion).toBe(CODE);
    expect(current.paused).toBe(false);
    expect(current.gate.events.map((e) => e.type)).toEqual(["sync_paused", "sync_resumed"]);
    const resumed = await auditOf(w, "sync.resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ allowed: true, denied_reason: null });
    expect(await w.store.humanRequest.open({ humanId: w.human })).toHaveLength(0);
    expect((await startOf(w, current)).status).toBe("completed");

    // Listeners never block the gate, and this install updating past the peer is its problem.
    const seen: string[] = [];
    current.on((e) => seen.push(e.type));
    const ahead = new SchemaSync({
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      localSchemaVersion: CODE + 1,
    });
    expect((await ahead.refresh("update")).action).toBe("update_peer");
    expect((await w.store.humanRequest.open({ humanId: w.human }))[0]?.steps[0]).toContain(
      "Update the other install",
    );
    expect(seen).toEqual([]);
    await w.store.close();
  });

  it("versions outside the running release's window pause with the right side to update", async () => {
    const w = await world();
    const tooOld = new SchemaSync({
      store: w.store,
      clock: w.clock,
      humanId: w.human,
      localSchemaVersion: CODE,
      minSchema: CODE + 1,
    });
    expect(await tooOld.refresh("startup")).toMatchObject({
      compatible: false,
      reason: "local_below_min",
      action: "update_local",
    });
    await w.store.close();
  });
});

describe("schema sync gate through the composed runtime", { timeout: 120_000 }, () => {
  let home: string;
  let dirs: ReturnType<typeof appDirs>;
  let stateUrl: string;
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const compose = (schemaSync?: { localSchemaVersion?: number }) =>
    composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl,
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      schemaSync,
    });
  const projectOf = (rt: RuntimeApp) =>
    rt.store.project.insert({
      name: "Shared",
      goal: "two installs, one store",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      // Mirrored, so `refreshMirrorSchedules` registers the scheduler's own mirror run.
      settings: { github_mirror: { enabled: true, owner: "shared-org" } },
      small_project_mode: false,
      active: true,
    });
  /** The scheduler fires `start` without awaiting it: wait until the agent is released. */
  const settled = async (rt: RuntimeApp, agentId: string) => {
    for (let i = 0; i < 500 && rt.scheduler.isActive(agentId); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(rt.scheduler.isActive(agentId)).toBe(false);
    return rt.scheduler.log.filter((l) => l.req.agentId === agentId);
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "fr-sync-gate-"));
    dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    // A file store: the "update" below is a second compose over the same database.
    stateUrl = `sqlite:${join(dirs.data, "state.sqlite")}`;
  });
  afterAll(() => undefined);

  it("refuses sessions, approvals, the mirror and the peers route while paused, serves them after the update", async () => {
    // The install behind the shared store (its code ships one migration fewer).
    let rt = await compose({ localSchemaVersion: CODE - 1 });
    const project = (await projectOf(rt)).id;
    try {
      expect(rt.schemaSync.paused).toBe(true);
      let { app, token } = createDaemonApp(rt);
      const auth = { headers: { authorization: `Bearer ${token}` } };
      const health = HealthView.parse(await (await app.request("/health", auth)).json());
      expect(health.sync).toMatchObject({
        paused: true,
        local: CODE - 1,
        peer: CODE,
        action: "update_local",
      });

      const peers = await app.request(`/projects/${project}/peers`, auth);
      expect(peers.status).toBe(503);
      expect(((await peers.json()) as { code: string }).code).toBe("unavailable");
      expect(isForerunnerError(await refused(rt.syncApprovals()), "unavailable")).toBe(true);
      expect(isForerunnerError(await refused(rt.mirrorSync(project)), "unavailable")).toBe(true);

      // The scheduler's start is refused before a session row exists.
      expect(
        await rt.scheduler.request({
          agentId: rt.agent.id,
          projectId: project,
          trigger: "manual",
          reason: "test",
        }),
      ).toBe("started");
      for (let i = 0; i < 100 && !rt.scheduler.log.some((l) => l.result === "error"); i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(rt.scheduler.log.at(-1)).toMatchObject({ result: "error" });
      expect(rt.scheduler.log.at(-1)?.detail).toContain("sync paused");
      expect(await rt.store.session.list({ agent_id: rt.agent.id } as never)).toHaveLength(0);

      // A scheduled mirror run (the scheduler's `start` routes it to the mirror, not to a
      // session) is refused the same way: no run, no session row for it.
      expect(await rt.refreshMirrorSchedules()).toContain(project);
      await rt.scheduler.tick();
      const mirrorRuns = await settled(rt, mirrorAgentId(project));
      expect(mirrorRuns.map((l) => l.result)).toEqual(["started", "error"]);
      expect(mirrorRuns.at(-1)?.detail).toContain("sync paused");
      expect(await rt.store.session.list({ agent_id: rt.agent.id } as never)).toHaveLength(0);

      // The memory consolidation is a local job the same scheduler starts (the tick above fired
      // its weekly schedule too): it is not held.
      await rt.scheduler.request({
        agentId: MEMORY_CONSOLIDATION_AGENT_ID,
        trigger: "schedule",
        reason: "test",
      });
      const consolidations = await settled(rt, MEMORY_CONSOLIDATION_AGENT_ID);
      expect(consolidations.length).toBeGreaterThan(0);
      expect(consolidations.map((l) => l.result)).toEqual(consolidations.map(() => "started"));

      // One inbox item for the human, the refusals audited once per call site.
      const open = await rt.store.humanRequest.open({ humanId: rt.human.id });
      expect(open.filter((r) => r.author_agent === SYNC_GATE_AUTHOR)).toHaveLength(1);
      const refusals = await rt.store.auditLog.list({ humanId: rt.human.id, tool: "sync.refused" });
      expect(
        refusals.map((r) => (JSON.parse(r.input_summary) as { what: string }).what).sort(),
      ).toEqual(["approvals.sync", "mirror.sync", "peer_feed", "session.start"]);
      await rt.close();

      // The update: the restarted process ships the store's version.
      rt = await compose();
      expect(rt.schemaSync.paused).toBe(false);
      expect(rt.schemaSync.localSchemaVersion).toBe(CODE);
      ({ app, token } = createDaemonApp(rt));
      const after = HealthView.parse(
        await (
          await app.request("/health", { headers: { authorization: `Bearer ${token}` } })
        ).json(),
      );
      expect(after.sync).toMatchObject({ paused: false, local: CODE, peer: CODE, action: "none" });
      const served = await app.request(`/projects/${project}/peers`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(served.status).toBe(200);
      expect(PeerFeedView.parse(await served.json()).schemaVersion).toBe(CODE);
      await expect(rt.syncApprovals()).resolves.toBeDefined();
      expect(
        (await rt.store.humanRequest.open({ humanId: rt.human.id })).filter(
          (r) => r.author_agent === SYNC_GATE_AUTHOR,
        ),
      ).toHaveLength(0);
      // The scheduled mirror run reaches the mirror again (it then fails on the empty vault,
      // which is the mirror's own refusal, not the gate's).
      expect(rt.scheduler.list().map((s) => s.id)).toContain(`mirror:${project}`);
      await rt.scheduler.tick();
      const resumedRuns = await settled(rt, mirrorAgentId(project));
      expect(resumedRuns.map((l) => l.result)).toEqual(["started", "error"]);
      expect(resumedRuns.at(-1)?.detail).not.toContain("sync paused");
    } finally {
      await rt.close();
    }
  });
});
