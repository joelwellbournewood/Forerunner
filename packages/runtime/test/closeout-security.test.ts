import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Requirements close-out for the rules that apply everywhere (spec "Security, permissions and
 * email" -> "Rules that apply everywhere"), asserted through the composed runtime and the
 * daemon's routes on an in-memory store with the fake provider and the simulated clock:
 *
 * - S.5: each grant shows its scopes in the Extensions panel. The catalog's declared scopes are
 *   in the review the human approves and in the row `GET /extensions` serves to the panel.
 * - S.8: the kill switch for one agent stops that agent's runs, revokes its run tokens, freezes
 *   new runs in its scope and releases its task claims; the other agent's run, token and claim
 *   are untouched; `scope: "all"` releases every agent's claims; resume lifts the freeze.
 */

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const jsonList = async (r: Response): Promise<Json[]> => (await r.json()) as Json[];

describe("close-out: security rules through the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
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
    const home = mkdtempSync(join(tmpdir(), "fr-closeout-security-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
    // Composing the whole runtime on a cold Windows runner has exceeded the default hook timeout.
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("S.5: a grant's scopes are in the review the human approves and in the row the Extensions panel reads", async () => {
    const catalog = await json(await req("/extensions/catalog"));
    const entry = (catalog.entries as Json[]).find((e) => e.id === "browser");
    if (!entry) throw new Error("no browser entry in the built-in catalog");
    const declared = (entry.permissions as Json).scopes as string[];
    expect(declared.length).toBeGreaterThan(0);

    const added = await req("/extensions", {
      method: "POST",
      body: JSON.stringify({ catalogId: "browser" }),
    });
    expect(added.status).toBe(202);
    const pending = await json(added);
    expect(pending.status).toBe("pending_approval");
    // Nothing is granted yet; the review names every scope the human is asked to approve.
    expect(((pending.review as Json).permissions as Json).scopes).toEqual(declared);
    const request = (
      await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })
    ).find((r) => (r.change_card as { extensionId?: string } | null)?.extensionId === pending.id);
    if (!request) throw new Error("no approval request for the capability");
    // The inbox card lists every declared scope as a step the human reads before saying yes.
    for (const scope of declared) {
      expect(request.steps.some((s) => s.includes(scope))).toBe(true);
    }
    const answered = await req(`/requests/${request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "approve" }),
    });
    expect(answered.status).toBe(200);

    // The panel's list carries the granted scopes, which are the declared ones, nothing wider.
    const listed = await jsonList(await req("/extensions"));
    const row = listed.find((e) => e.id === pending.id);
    if (!row) throw new Error("installed capability missing from GET /extensions");
    expect(row.status).toBe("enabled");
    expect((row.permissions as Json).scopes).toEqual(declared);
    expect(
      ((await json(await req(`/extensions/${String(pending.id)}`))).permissions as Json).scopes,
    ).toEqual(declared);
  });

  it("S.8: killing one agent stops its runs, revokes its tokens, freezes its scope and releases its claims; the other agent keeps everything", async () => {
    const bob = await rt.store.agent.insert({ name: "Bob", owner_human_id: rt.human.id });
    const project = await rt.store.project.insert({
      name: "Closeout",
      goal: "prove the kill switch",
      autonomy_level: 2,
    });
    const task = (title: string) =>
      rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 0,
        status: "ready",
        priority: 5,
        depends_on: [],
        budget_usd_micro: 1_000_000,
        est_cost_usd_micro: 400_000,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "closeout",
      });
    const aliceTask = await task("alice's task");
    const bobTask = await task("bob's task");
    expect((await rt.store.task.claim(aliceTask.id, rt.agent.id, 60_000, clock.now())).ok).toBe(
      true,
    );
    expect((await rt.store.task.claim(bobTask.id, bob.id, 60_000, clock.now())).ok).toBe(true);

    const issue = (agentId: string, runId: string) =>
      rt.tokens.issue({
        runId,
        sessionId: `sess-${runId}`,
        agentId,
        ownerHumanId: rt.human.id,
        projectId: project.id,
        allowedTools: ["echo"],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
        budgetUsdMicro: 1_000_000,
        depth: 0,
        maxDepth: 2,
        autonomy: 2,
        planApproved: false,
        expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
      });
    const aliceToken = issue(rt.agent.id, "run-alice");
    const bobToken = issue(bob.id, "run-bob");
    const aliceRun = new AbortController();
    const bobRun = new AbortController();
    const offAlice = rt.kill.register({
      agentId: rt.agent.id,
      sessionId: "sess-run-alice",
      controller: aliceRun,
      label: "alice run",
    });
    const offBob = rt.kill.register({
      agentId: bob.id,
      sessionId: "sess-run-bob",
      controller: bobRun,
      label: "bob run",
    });

    const report = await json(
      await req("/kill", {
        method: "POST",
        body: JSON.stringify({ scope: { agentId: rt.agent.id }, reason: "close-out S.8" }),
      }),
    );
    expect(report).toMatchObject({
      stoppedRuns: 1,
      killActive: true,
      scope: { agentId: rt.agent.id },
    });
    expect(Number(report.revokedTokens)).toBeGreaterThanOrEqual(1);
    expect(Number(report.durationMs)).toBeLessThan(2000);
    // Runs: Alice's aborted, Bob's running.
    expect(aliceRun.signal.aborted).toBe(true);
    expect(bobRun.signal.aborted).toBe(false);
    // Tokens: Alice's revoked, Bob's valid.
    expect(rt.tokens.isRevoked(aliceToken.claims.id)).toBe(true);
    expect(rt.tokens.isRevoked(bobToken.claims.id)).toBe(false);
    // Claims: Alice's released back to ready, Bob's held.
    const aliceAfter = await rt.store.task.mustGet(aliceTask.id);
    expect(aliceAfter.claimed_by).toBeNull();
    expect(aliceAfter.status).toBe("ready");
    const bobAfter = await rt.store.task.mustGet(bobTask.id);
    expect(bobAfter.claimed_by).toBe(bob.id);
    expect(bobAfter.status).toBe("claimed");
    // Frozen: nothing new starts in Alice's scope; Bob's scope is open.
    const late = new AbortController();
    const offLate = rt.kill.register({
      agentId: rt.agent.id,
      sessionId: "sess-late",
      controller: late,
      label: "late alice run",
    });
    expect(late.signal.aborted).toBe(true);
    const bobLate = new AbortController();
    const offBobLate = rt.kill.register({
      agentId: bob.id,
      sessionId: "sess-bob-late",
      controller: bobLate,
      label: "late bob run",
    });
    expect(bobLate.signal.aborted).toBe(false);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(true);
    expect(rt.kill.isFrozen({ agentId: bob.id })).toBe(false);

    // Resume lifts the freeze; the revoked token stays revoked.
    expect((await req("/kill/resume", { method: "POST" })).status).toBe(200);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
    expect(rt.tokens.isRevoked(aliceToken.claims.id)).toBe(true);

    // Everyone: both claims released, both runs stopped.
    expect((await rt.store.task.claim(aliceTask.id, rt.agent.id, 60_000, clock.now())).ok).toBe(
      true,
    );
    const everyone = await json(
      await req("/kill", { method: "POST", body: JSON.stringify({ scope: "all" }) }),
    );
    expect(everyone).toMatchObject({ scope: "all", killActive: true });
    expect(bobRun.signal.aborted).toBe(true);
    expect(bobLate.signal.aborted).toBe(true);
    expect(rt.tokens.isRevoked(bobToken.claims.id)).toBe(true);
    expect((await rt.store.task.mustGet(aliceTask.id)).claimed_by).toBeNull();
    expect((await rt.store.task.mustGet(bobTask.id)).claimed_by).toBeNull();
    expect((await rt.store.task.mustGet(bobTask.id)).status).toBe("ready");
    expect((await req("/kill/resume", { method: "POST" })).status).toBe(200);
    for (const off of [offAlice, offBob, offLate, offBobLate]) off();
  });
});
