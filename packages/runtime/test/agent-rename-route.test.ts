import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { HUMAN_ENV } from "../src/daemon/identity.ts";
import { AGENT_RENAME_AUDIT_TOOL, createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Settings -> Your agent (U-025): `POST /agents/:id/rename` renames the signed-in human's
 * principal agent. The agent was created as "Alice" on the first start and nothing could rename
 * it. The route refuses another human's agent (403) and a bad or taken name (409, cause
 * validation), writes the versioned update with one audit row, and the new name shows on `/me`,
 * `/agents` and in the store after a restart, which still picks the same agent when
 * `FORERUNNER_AGENT_NAME` holds the old name.
 */

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("POST /agents/:id/rename (U-025)", () => {
  const clock = new SimulatedClock("2026-10-31T08:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-agent-rename-"));
  const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
  const vault = new MemoryVault();
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token = "";
  let humanId = "";
  let agentId = "";
  let criticId = "";
  let otherPrincipalId = "";
  let peerAgentId = "";

  const compose = (env: Record<string, string>) =>
    composeRuntime({
      env: { FORERUNNER_HOME: home, ...env },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl,
      vault,
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  const rename = (id: string, body: unknown) =>
    req(`/agents/${id}/rename`, { method: "POST", body: JSON.stringify(body) });
  const renameAudits = () => rt.store.auditLog.list({ tool: AGENT_RENAME_AUDIT_TOOL });

  beforeAll(async () => {
    // The first start creates the human and the agent with the name from the environment.
    rt = await compose({ FORERUNNER_AGENT_NAME: "Alice" });
    ({ app, token } = createDaemonApp(rt));
    humanId = rt.human.id;
    agentId = rt.agent.id;
    criticId = rt.criticAgent.id;
    expect(rt.agent.name).toBe("Alice");
    // A second principal of the same human, created later, and another human with an agent.
    await clock.advance(60_000);
    otherPrincipalId = (
      await rt.store.agent.insert({
        name: "Zed",
        owner_human_id: humanId,
        kind: "principal",
        status: "active",
      })
    ).id;
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
    // Composing the whole runtime on a cold Windows runner has exceeded the default hook timeout.
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("renames the principal: the answer, /me, /agents, the stored row, one audit row and agent.changed", async () => {
    const changed: Json[] = [];
    const onAgent = (e: Json) => changed.push(e);
    rt.events.on("agent", onAgent);
    try {
      // Another human's agent may share the name: only the human's own agents are compared.
      expect((await rename(agentId, { name: "Bob" })).status).toBe(200);
      const res = await rename(agentId, { name: "  Robin  " });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: agentId,
        name: "Robin",
        ownerHumanId: humanId,
        kind: "principal",
        status: "active",
      });
    } finally {
      rt.events.off("agent", onAgent);
    }
    expect(changed).toEqual([
      { id: agentId, name: "Bob" },
      { id: agentId, name: "Robin" },
    ]);
    // The process's own record (`/me`, commit authors, notifications) follows at once.
    expect(rt.agent).toEqual({ id: agentId, name: "Robin" });
    const me = (await (await req("/me")).json()) as Json;
    expect(me.agent).toEqual({ id: agentId, name: "Robin" });
    const agents = (await (await req("/agents")).json()) as Json[];
    expect(agents.find((a) => a.id === agentId)?.name).toBe("Robin");
    const row = await rt.store.agent.mustGet(agentId);
    expect(row).toMatchObject({ name: "Robin", version: 3, author_human: humanId });
    const audits = await renameAudits();
    expect(audits.map((a) => a.input_summary)).toEqual(['"Alice" -> "Bob"', '"Bob" -> "Robin"']);
    expect(audits.every((a) => a.agent_id === agentId && a.human_id === humanId)).toBe(true);
    // The same name again changes nothing: no write, no audit row.
    const same = await rename(agentId, { name: "Robin" });
    expect(same.status).toBe(200);
    expect(((await same.json()) as Json).name).toBe("Robin");
    expect((await rt.store.agent.mustGet(agentId)).version).toBe(3);
    expect(await renameAudits()).toHaveLength(2);
  });

  it("refuses another human's agent with 403 before reading the body, and an unknown one with 404", async () => {
    const before = await renameAudits();
    const refused = await rename(peerAgentId, { name: "Eve" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "forbidden", message: "not your agent" });
    expect((await rename(peerAgentId, {})).status).toBe(403);
    expect((await rt.store.agent.mustGet(peerAgentId)).name).toBe("Bob");
    expect((await rename("agent_nobody", { name: "Eve" })).status).toBe(404);
    expect(await renameAudits()).toHaveLength(before.length);
  });

  it("refuses an empty, long, multi-line or taken name and the critic, with 409 cause validation", async () => {
    const refusals: [string, unknown][] = [
      ["empty", { name: "" }],
      ["blank", { name: "   " }],
      ["missing", {}],
      ["not a string", { name: 42 }],
      ["61 characters", { name: "x".repeat(61) }],
      ["a line break", { name: "Ro\nbin" }],
      ["a tab", { name: "Ro\tbin" }],
      ["an escape", { name: "Ro\u001bbin" }],
      ["a bidi override", { name: "Ro\u202Ebin" }],
      ["another principal's name, other case", { name: "zED" }],
      ["the critic's name", { name: "critic" }],
    ];
    for (const [why, body] of refusals) {
      const res = await rename(agentId, body);
      expect(res.status, why).toBe(409);
      const err = (await res.json()) as { code: string; details: Json };
      expect(err.code, why).toBe("conflict");
      expect(err.details.cause, why).toBe("validation");
    }
    const critic = await rename(criticId, { name: "Judge" });
    expect(critic.status).toBe(409);
    expect(((await critic.json()) as Json).message).toContain("only your principal agent");
    expect((await rt.store.agent.mustGet(criticId)).name).toBe("Critic");
    expect((await rt.store.agent.mustGet(otherPrincipalId)).name).toBe("Zed");
    expect((await rt.store.agent.mustGet(agentId)).name).toBe("Robin");
    // Sixty characters is the limit, not over it.
    const sixty = "y".repeat(60);
    expect((await rename(agentId, { name: sixty })).status).toBe(200);
    expect((await rename(agentId, { name: "Robin" })).status).toBe(200);
  });

  it("keeps the name across a restart, which picks the same agent under the old FORERUNNER_AGENT_NAME", async () => {
    const agentsBefore = await rt.store.agent.count();
    await rt.close();
    // The environment still names the agent "Alice", as it did when the agent was created; the
    // store now has two humans, so the start names its human.
    rt = await compose({ FORERUNNER_AGENT_NAME: "Alice", [HUMAN_ENV]: humanId });
    ({ app, token } = createDaemonApp(rt));
    expect(rt.agent).toEqual({ id: agentId, name: "Robin" });
    expect(await rt.store.agent.count()).toBe(agentsBefore);
    const me = (await (await req("/me")).json()) as Json;
    expect(me.agent).toEqual({ id: agentId, name: "Robin" });
    const agents = (await (await req("/agents")).json()) as Json[];
    expect(agents.filter((a) => a.ownerHumanId === humanId).map((a) => a.name)).toEqual([
      "Robin",
      "Critic",
      "Zed",
    ]);
  });
});
