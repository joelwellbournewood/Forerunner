import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SIGNOFF_OPTIONS, signoffCard } from "@forerunner/critic";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { TaskRow } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  composeRuntime,
  DEFAULT_APPROVALS_POLL_MS,
  type RuntimeApp,
} from "../src/daemon/compose.ts";
import { SIGNOFF_AUDIT_TOOL } from "../src/session/findings.ts";

/**
 * The daemon's approvals poll (compose.ts; phase 5 follow-up RT-P5-1): an answer given on
 * the phone or in the web approvals lands in the shared state through the state service and
 * reaches no route of this daemon, so `syncApprovals()` runs on the clock every
 * `approvalsPollMs` wherever answers can arrive from another device (shared state, services
 * running: the remote commands' condition). A daemon on a local store, whose only answer
 * path is its own route, has no poll. Here the "phone's answer" is written to the store
 * directly, as the state service's answer route does.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const POLL_MS = 2_000;

async function compose(clock: SimulatedClock, remote: boolean): Promise<RuntimeApp> {
  const home = mkdtempSync(join(tmpdir(), "fr-approvals-poll-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  return composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs,
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider: new FakeProvider({ replies: [textReply("Noted.")], clock, latency: "none" }),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    approvalsPollMs: POLL_MS,
    ...(remote
      ? { remote: { enabled: true, pollMs: 500, heartbeatMs: 60_000, deviceName: "J's PC" } }
      : {}),
  });
}

/** A tier 3 task waiting on its sign-off, filed as the critic loop files it. */
async function signoffWaiting(rt: RuntimeApp): Promise<{ task: TaskRow; requestId: string }> {
  const project = await rt.store.project.insert({
    name: "Sample",
    goal: "Ship the sample",
    autonomy_level: 2,
    settings: { members: [rt.agent.id] },
  });
  const task = await rt.store.task.insert({
    project_id: project.id,
    title: "Payment webhook",
    outcome: "the webhook is verified",
    acceptance_criteria: ["verified"],
    risk_tier: 3,
    status: "needs_human",
    budget_usd_micro: 1_000_000,
    reason: "critic: human sign-off required",
    owner_agent_id: rt.agent.id,
  });
  const review = await rt.store.review.insert({
    task_id: task.id,
    critic_model: "fake-opus",
    tier: 3,
    grade: 97,
    confidence: 0.95,
    verdict: "human",
    evidence: [],
    summary: "Flawless.",
    author_agent: rt.criticAgent.id,
  });
  const request = await rt.store.humanRequest.insert({
    human_id: rt.human.id,
    project_id: project.id,
    task_id: task.id,
    kind: "approval",
    why: "Critic sign-off needed (tier 3, grade 97): Flawless.",
    steps: [],
    options: [...SIGNOFF_OPTIONS],
    blocking: true,
    risk: "medium",
    change_card: signoffCard({
      taskId: task.id,
      reviewId: review.id,
      runId: null,
      findingIds: [],
      reason: "verdict",
    }),
    author_agent: rt.criticAgent.id,
  });
  return { task, requestId: request.id };
}

describe("the daemon's approvals poll", () => {
  const clock = new SimulatedClock("2026-10-20T18:00:00Z");
  let shared: RuntimeApp;
  let local: RuntimeApp;

  beforeAll(async () => {
    shared = await compose(clock, true);
    local = await compose(clock, false);
  }, 120_000);
  afterAll(async () => {
    await shared?.close();
    await local?.close();
  });

  it("applies a sign-off answered on another device within the poll, once", async () => {
    const { task, requestId } = await signoffWaiting(shared);
    const row = await shared.store.humanRequest.mustGet(requestId);
    await shared.store.humanRequest.answer(row.id, row.version, "accept", shared.human.id);
    // Before the poll fires nothing has applied it.
    expect((await shared.store.task.mustGet(task.id)).status).toBe("needs_human");
    await clock.advance(POLL_MS);
    expect((await shared.store.task.mustGet(task.id)).status).toBe("done");
    const audit = (await shared.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL);
    expect(audit).toHaveLength(1);
    // The next polls find nothing to apply.
    await clock.advance(3 * POLL_MS);
    expect(
      (await shared.store.auditLog.list()).filter((r) => r.tool === SIGNOFF_AUDIT_TOOL),
    ).toHaveLength(1);
    expect((await shared.syncApprovals()).signoffs).toEqual({
      accepted: 0,
      revised: 0,
      cancelled: 0,
      skipped: 0,
    });
  });

  it("a daemon on a local store has no poll: its own answer route applies at once, nothing else can answer", async () => {
    const { task, requestId } = await signoffWaiting(local);
    const row = await local.store.humanRequest.mustGet(requestId);
    await local.store.humanRequest.answer(row.id, row.version, "accept", local.human.id);
    await clock.advance(3 * POLL_MS);
    expect((await local.store.task.mustGet(task.id)).status).toBe("needs_human");
    expect((await local.syncApprovals()).signoffs).toMatchObject({ accepted: 1 });
    expect((await local.store.task.mustGet(task.id)).status).toBe("done");
  });

  it("the default poll is a few seconds", () => {
    expect(DEFAULT_APPROVALS_POLL_MS).toBe(5_000);
  });
});
