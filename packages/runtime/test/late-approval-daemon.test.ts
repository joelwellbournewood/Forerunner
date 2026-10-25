import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { HumanRequestRow, SessionRow, TaskRow } from "@forerunner/state";
import { FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { approvalKeyFor } from "../src/enforcement/hooks.ts";
import { LATE_APPROVAL_AUDIT_TOOL } from "../src/session/late-approval.ts";

/**
 * ADR 0088 on the desktop daemon: a hooks approval a session filed for its task, answered
 * through `POST /requests/:id/answer` after that session ended, is acted on by the route's
 * `syncApprovals`: the task goes back to `ready`, one `message` session is started for the
 * project and the card records it; a second sync starts nothing. A refused late answer starts
 * nothing, is marked and the task records the refusal. (The follow-up's call consuming the
 * answer is `late-approval.test.ts` and `approvals-durable.test.ts`; the fake provider here
 * finishes the task without re-making the call.)
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const INPUT = { repo: "org/old-repo" };

async function compose(clock: SimulatedClock): Promise<RuntimeApp> {
  const home = mkdtempSync(join(tmpdir(), "fr-late-approval-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  return composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs,
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider: new FakeProvider({ replies: [], onNoMatch: "echo", clock, latency: "none" }),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
}

async function project(rt: RuntimeApp, name: string): Promise<string> {
  const row = await rt.store.project.insert({
    name,
    goal: `Retire ${name}`,
    autonomy_level: 2,
    settings: { members: [rt.agent.id] },
  });
  return row.id;
}

/** A task paused on an always-human call by a session that has ended, and that call's request. */
async function pausedTask(
  rt: RuntimeApp,
  projectId: string,
  clock: SimulatedClock,
): Promise<{ task: TaskRow; session: SessionRow; request: HumanRequestRow }> {
  const task = await rt.store.task.insert({
    project_id: projectId,
    title: "Delete the old repo",
    outcome: "The old repository is gone",
    acceptance_criteria: ["it is gone"],
    risk_tier: 0,
    status: "needs_human",
    budget_usd_micro: 1_000_000,
    reason: "waiting for approval of delete_repo",
    owner_agent_id: rt.agent.id,
    author_agent: rt.agent.id,
  });
  const planned = await rt.store.session.insert({
    agent_id: rt.agent.id,
    project_id: projectId,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 1_000_000,
    step_cap: 10,
    spent_usd_micro: 0,
    steps: 0,
    status: "planned",
    summary: "",
    handoff: {},
    runner: "pc",
  });
  const running = await rt.store.session.start(planned.id, planned.version);
  const request = await rt.store.humanRequest.insert({
    human_id: rt.human.id,
    project_id: projectId,
    task_id: task.id,
    session_id: running.id,
    kind: "approval",
    why: "autonomy level 2 requires approval for destructive",
    steps: ["Tool: delete_repo", "Action class: destructive"],
    options: ["yes", "no"],
    blocking: true,
    risk: "high",
    change_card: {
      key: approvalKeyFor("delete_repo", INPUT),
      tool: "delete_repo",
      actionClass: "destructive",
      input: INPUT,
      estimateUsdMicro: null,
    },
    author_agent: rt.agent.id,
  });
  const session = await rt.store.session.setStatus(running.id, running.version, "completed", {
    summary: "1 task needs you",
  });
  await clock.advance(60_000);
  return { task, session, request };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function card(r: HumanRequestRow): Json {
  return (r.change_card ?? {}) as Json;
}

describe("a hooks approval answered after its session ended, on the desktop daemon", () => {
  const clock = new SimulatedClock("2026-10-25T09:00:00Z");
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
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
    rt = await compose(clock);
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the inbox's yes puts the task back to ready and starts one message session for it; a second sync starts nothing", async () => {
    const projectId = await project(rt, "Approve");
    const { task, session, request } = await pausedTask(rt, projectId, clock);
    expect(await rt.store.session.active(rt.agent.id)).toEqual([]);
    const answered = await req(`/requests/${request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "yes" }),
    });
    expect(answered.status).toBe(200);
    // The route's `syncApprovals` acted before answering: the task is ready, the start made.
    expect(card(await rt.store.humanRequest.mustGet(request.id))).toMatchObject({
      outcome: "started",
      tool: "delete_repo",
    });
    expect(typeof card(await rt.store.humanRequest.mustGet(request.id)).applied_at).toBe("string");
    const follow = await waitFor(async () =>
      (await rt.store.session.list({ project_id: projectId }, { orderBy: "created_at" })).find(
        (s) => s.trigger === "message" && s.status === "completed",
      ),
    );
    expect(follow.id).not.toBe(session.id);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("done");
    const audit = (await rt.store.auditLog.list()).filter(
      (r) => r.tool === LATE_APPROVAL_AUDIT_TOOL,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ session_id: session.id, allowed: true });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toMatchObject({
      requestId: request.id,
      taskId: task.id,
      tool: "delete_repo",
      answer: "yes",
    });
    // Idempotent: another sync (a later answer, a restart) starts no second session.
    expect((await rt.syncApprovals()).late).toEqual({ started: 0, refused: 0, skipped: 0 });
    expect(await rt.store.session.list({ project_id: projectId })).toHaveLength(2);
    await waitFor(async () => (rt.scheduler.isActive(rt.agent.id) ? undefined : true));
  });

  it("a refused late answer starts nothing, is consumed and the task records the refusal", async () => {
    const projectId = await project(rt, "Refuse");
    const { task, request } = await pausedTask(rt, projectId, clock);
    const answered = await req(`/requests/${request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "no" }),
    });
    expect(answered.status).toBe(200);
    expect(card(await rt.store.humanRequest.mustGet(request.id))).toMatchObject({
      outcome: "refused",
    });
    const refused = await rt.store.task.mustGet(task.id);
    expect(refused.status).toBe("needs_human");
    expect(refused.reason).toBe(`human refused delete_repo (request ${request.id})`);
    await new Promise((r) => setTimeout(r, 200));
    expect(await rt.store.session.list({ project_id: projectId })).toHaveLength(1);
    expect((await rt.syncApprovals()).late).toEqual({ started: 0, refused: 0, skipped: 0 });
  });
});
