import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
const HOUR = 60 * 60 * 1000;

/**
 * U-063: Quit (`POST /shutdown`) and the kill switch run the claim freeze, which released the
 * claims of every agent in the store (`store.agent.list(undefined)`). On a shared store that is
 * other people's work too: their tasks went back to ready while their own install still ran
 * them. Only the signed-in human's agents are this install's to release; another human's claims
 * stay, whatever the scope sent.
 */
describe("Quit and the kill switch release only your own agents' claims (U-063)", () => {
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-shutdown-claims-"));
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token = "";
  let shutdowns = 0;
  let projectId = "";
  let peerAgentId = "";
  let mine = "";
  let theirs = "";

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  const task = async (title: string) =>
    (
      await rt.store.task.insert({
        project_id: projectId,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 1,
        status: "ready",
        priority: 5,
        budget_usd_micro: 1_000_000,
      })
    ).id;
  const holder = async (id: string) => (await rt.store.task.mustGet(id)).claimed_by;

  beforeAll(async () => {
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    ({ app, token } = createDaemonApp(rt, { onShutdown: () => shutdowns++ }));
    // A second person on the same store, with an agent of their own working a shared project.
    const m = await rt.store.human.insert({
      name: "M",
      email: "m@example.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 100_000_000,
      locale: "en",
    });
    peerAgentId = (
      await rt.store.agent.insert({
        name: "Bob",
        owner_human_id: m.id,
        kind: "principal",
        status: "active",
      })
    ).id;
    projectId = (
      await rt.store.project.insert({
        name: "Shared",
        goal: "Ship together",
        stage: "build",
        status: "active",
        budget_usd_micro: 50_000_000,
        autonomy_level: 2,
      })
    ).id;
    mine = await task("mine");
    theirs = await task("theirs");
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });
  beforeEach(async () => {
    rt.kill.resume();
    for (const [id, agent] of [
      [mine, rt.agent.id],
      [theirs, peerAgentId],
    ] as const) {
      if ((await holder(id)) !== agent) await rt.store.task.claim(id, agent, HOUR);
    }
    expect(await holder(mine)).toBe(rt.agent.id);
    expect(await holder(theirs)).toBe(peerAgentId);
  });

  it("Quit (POST /shutdown) releases your agent's claim and keeps the other person's", async () => {
    const res = await post("/shutdown", {});
    expect(res.status).toBe(202);
    expect(await holder(mine)).toBeNull();
    expect((await rt.store.task.mustGet(mine)).status).toBe("ready");
    expect(await holder(theirs)).toBe(peerAgentId);
    expect((await rt.store.task.mustGet(theirs)).status).toBe("claimed");
  });

  it("the kill switch (Stop all) does the same", async () => {
    const res = await post("/kill", { scope: "all", reason: "test" });
    expect(res.status).toBe(200);
    expect(await holder(mine)).toBeNull();
    expect(await holder(theirs)).toBe(peerAgentId);
  });

  it("a kill scoped to another person's agent releases nothing of theirs", async () => {
    const res = await post("/kill", { scope: { agentId: peerAgentId }, reason: "test" });
    expect(res.status).toBe(200);
    expect(await holder(theirs)).toBe(peerAgentId);
    expect(await holder(mine)).toBe(rt.agent.id);
  });

  it("a kill scoped to your agent releases its claim", async () => {
    const res = await post("/kill", { scope: { agentId: rt.agent.id }, reason: "test" });
    expect(res.status).toBe(200);
    expect(await holder(mine)).toBeNull();
    expect(await holder(theirs)).toBe(peerAgentId);
  });
});
