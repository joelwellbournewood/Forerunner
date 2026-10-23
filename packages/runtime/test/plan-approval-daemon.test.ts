import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { HumanRequestRow, SessionRow } from "@forerunner/state";
import { FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { approvedPlanIdOf, PLAN_APPROVAL_AUDIT_TOOL } from "../src/session/plan-approval.ts";

/**
 * J.7 on the desktop daemon (ADR 0053): a project at autonomy 1 starts a session that files
 * its plan and ends `stopped`; the answer "approve" through `POST /requests/:id/answer` (the
 * inbox) hands the plan to the scheduler as a `message` start bound to it, the follow-up
 * session runs the task, and a second `syncApprovals` starts nothing. An answer given on
 * another device lands in the store and reaches no route, so where answers can come from
 * elsewhere the approvals poll applies it within `approvalsPollMs`. A rejected plan starts
 * nothing and the task stays ready.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const POLL_MS = 2_000;
/** Enough for the estimate model's price of one tier-0 task after the review reserve. */
const CAP = 6_000_000;
type Json = Record<string, unknown>;

async function compose(clock: SimulatedClock, remote: boolean): Promise<RuntimeApp> {
  const home = mkdtempSync(join(tmpdir(), "fr-plan-approval-"));
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
    approvalsPollMs: POLL_MS,
    ...(remote
      ? { remote: { enabled: true, pollMs: 500, heartbeatMs: 60_000, deviceName: "J's PC" } }
      : {}),
  });
}

async function assistedProject(rt: RuntimeApp, name: string): Promise<string> {
  const project = await rt.store.project.insert({
    name,
    goal: `Ship ${name} under assisted autonomy`,
    autonomy_level: 1,
    settings: { members: [rt.agent.id] },
  });
  return project.id;
}

async function readyTask(rt: RuntimeApp, projectId: string, title: string) {
  return rt.store.task.insert({
    project_id: projectId,
    title,
    outcome: `${title} is done`,
    acceptance_criteria: ["it works"],
    risk_tier: 0,
    status: "ready",
    budget_usd_micro: 1_000_000,
    reason: "seed",
    owner_agent_id: rt.agent.id,
  });
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

async function sessionsOf(rt: RuntimeApp, projectId: string): Promise<SessionRow[]> {
  return rt.store.session.list({ project_id: projectId }, { orderBy: "created_at" });
}

/** The session that filed the plan (ended `stopped`, `plan_awaiting_approval`) and its request. */
async function planFiled(
  rt: RuntimeApp,
  projectId: string,
): Promise<{ session: SessionRow; request: HumanRequestRow }> {
  const session = await waitFor(async () =>
    (await sessionsOf(rt, projectId)).find(
      (s) =>
        s.status === "stopped" &&
        (s.handoff as { stop_reason?: string }).stop_reason === "plan_awaiting_approval",
    ),
  );
  const request = await waitFor(async () =>
    (await rt.store.humanRequest.open({ humanId: rt.human.id })).find(
      (r) => r.session_id === session.id,
    ),
  );
  return { session, request };
}

function card(r: HumanRequestRow): Json {
  return (r.change_card ?? {}) as Json;
}

describe("plan approval on the desktop daemon", () => {
  const clock = new SimulatedClock("2026-10-23T09:00:00Z");
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
    rt = await compose(clock, false);
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the inbox's approve starts the plan it was filed for, once; the filing session never blocks it", async () => {
    const projectId = await assistedProject(rt, "Approve");
    const task = await readyTask(rt, projectId, "Write the readme");
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, budgetUsdMicro: CAP }),
    });
    expect(started.status).toBe(202);
    const { session: filed, request } = await planFiled(rt, projectId);
    expect(request).toMatchObject({ kind: "approval", blocking: true, project_id: projectId });
    expect(card(request).key).toBe(`plan:${filed.id}`);
    const planId = approvedPlanIdOf(request);
    expect(planId).toMatch(new RegExp(`^plan:${filed.id}#[0-9a-f]{64}$`));
    expect((await rt.store.task.mustGet(task.id)).status).toBe("ready");
    expect(await rt.store.session.active(rt.agent.id)).toEqual([]);

    const answered = await req(`/requests/${request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "approve" }),
    });
    expect(answered.status).toBe(200);
    // The route's `syncApprovals` handed the plan to the scheduler before answering.
    expect(card(await rt.store.humanRequest.mustGet(request.id))).toMatchObject({
      outcome: "started",
      plan_id: planId,
    });
    const follow = await waitFor(async () =>
      (await sessionsOf(rt, projectId)).find(
        (s) => s.trigger === "message" && s.status === "completed",
      ),
    );
    expect(follow.id).not.toBe(filed.id);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("done");
    const events = await rt.store.event.list(follow.id);
    expect(events.find((e) => e.type === "session.plan_approved")?.payload).toMatchObject({
      planId,
      approvedSessionId: filed.id,
    });
    const audit = (await rt.store.auditLog.list()).filter(
      (r) => r.tool === PLAN_APPROVAL_AUDIT_TOOL,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ session_id: filed.id, allowed: true });
    // Idempotent: another sync (a later answer, a restart) starts no second session.
    expect((await rt.syncApprovals()).plans).toEqual({ started: 0, rejected: 0, skipped: 0 });
    expect(await sessionsOf(rt, projectId)).toHaveLength(2);
    expect(await rt.store.humanRequest.open({ humanId: rt.human.id })).toEqual([]);
    // The session view of the follow-up names the approved plan in plain words.
    const view = (await (await req(`/sessions/${follow.id}/events`)).json()) as Json[];
    expect(
      view.some((e) => String(e.text).startsWith("Running the plan you approved (1 item(s)")),
    ).toBe(true);
  });

  it("'approve' through the command registry (POST /commands/execute, then the yes) starts the plan at once on a local store", async () => {
    const projectId = await assistedProject(rt, "Palette");
    const task = await readyTask(rt, projectId, "Write the readme");
    expect(
      (
        await req("/sessions", {
          method: "POST",
          body: JSON.stringify({ agentId: rt.agent.id, projectId, budgetUsdMicro: CAP }),
        })
      ).status,
    ).toBe(202);
    const { session: filed, request } = await planFiled(rt, projectId);
    const executed = (await (
      await req("/commands/execute", {
        method: "POST",
        body: JSON.stringify({
          commands: [
            { name: "request.answer", params: { request: request.id, answer: "approve" } },
          ],
          wordsUsed: "palette: approve the plan",
        }),
      })
    ).json()) as Json;
    // The plan request is medium risk: the change card asks for a yes first.
    expect(executed.status).toBe("pending");
    const confirmed = (await (
      await req(`/commands/${String(executed.pendingId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ answer: "yes" }),
      })
    ).json()) as Json;
    expect(confirmed.status).toBe("done");
    // No poll runs on this store (no remote control): the command's own sync started it.
    expect(card(await rt.store.humanRequest.mustGet(request.id))).toMatchObject({
      outcome: "started",
    });
    const follow = await waitFor(async () =>
      (await sessionsOf(rt, projectId)).find(
        (s) => s.trigger === "message" && s.status === "completed",
      ),
    );
    expect(follow.id).not.toBe(filed.id);
    // The follow-up planned under the cap of the session the human approved the plan of.
    expect(follow.budget_cap_usd_micro).toBe(CAP);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("done");
    await waitFor(async () => (rt.scheduler.isActive(rt.agent.id) ? undefined : true));
  });

  it("'approve' said in chat or voice (the conversation agent's command path) starts the plan", async () => {
    const projectId = await assistedProject(rt, "Voice");
    const task = await readyTask(rt, projectId, "Add a changelog");
    expect(
      (
        await req("/sessions", {
          method: "POST",
          body: JSON.stringify({ agentId: rt.agent.id, projectId, budgetUsdMicro: CAP }),
        })
      ).status,
    ).toBe(202);
    const { request } = await planFiled(rt, projectId);
    if (!rt.conversation) throw new Error("no conversation agent");
    const turn = {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      activeProjectId: projectId,
      sessionId: await rt.conversation.conversationSessionId(rt.agent.id, null),
      source: "voice" as const,
      wordsUsed: "approve the plan",
    };
    const asked = await rt.commands.execute(
      { name: "request.answer", params: { request: request.id, answer: "approve" } },
      turn,
    );
    expect(asked.status).toBe("pending");
    const done = await rt.commands.confirmByText(String(asked.pendingId), "yes", turn);
    expect(done.status).toBe("done");
    expect(card(await rt.store.humanRequest.mustGet(request.id))).toMatchObject({
      outcome: "started",
    });
    await waitFor(async () =>
      (await rt.store.task.mustGet(task.id)).status === "done" ? true : undefined,
    );
    // The follow-up has ended before the next case starts one (the simulated clock never
    // ticks the scheduler, so a start queued behind it would wait forever).
    await waitFor(async () => (rt.scheduler.isActive(rt.agent.id) ? undefined : true));
  });

  it("a rejected plan starts nothing and the task stays ready", async () => {
    const projectId = await assistedProject(rt, "Reject");
    const task = await readyTask(rt, projectId, "Add a changelog");
    expect(
      (
        await req("/sessions", {
          method: "POST",
          body: JSON.stringify({ agentId: rt.agent.id, projectId, budgetUsdMicro: CAP }),
        })
      ).status,
    ).toBe(202);
    const { request } = await planFiled(rt, projectId);
    const answered = await req(`/requests/${request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "reject" }),
    });
    expect(answered.status).toBe(200);
    expect(card(await rt.store.humanRequest.mustGet(request.id))).toMatchObject({
      outcome: "rejected",
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await sessionsOf(rt, projectId)).toHaveLength(1);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("ready");
    expect((await rt.syncApprovals()).plans).toEqual({ started: 0, rejected: 0, skipped: 0 });
  });
});

describe("plan approval from another device: the approvals poll", () => {
  const clock = new SimulatedClock("2026-10-23T10:00:00Z");
  let rt: RuntimeApp;

  beforeAll(async () => {
    rt = await compose(clock, true);
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("an approve written to the shared state starts the plan within the poll, once", async () => {
    const projectId = await assistedProject(rt, "Phone");
    const task = await readyTask(rt, projectId, "Write the readme");
    expect(
      await rt.scheduler.request({
        agentId: rt.agent.id,
        projectId,
        trigger: "manual",
        reason: "test",
        budgetUsdMicro: CAP,
      } as never),
    ).toBe("started");
    const { session: filed, request } = await planFiled(rt, projectId);
    // The phone's answer: the state service writes the row; no daemon route is involved.
    await rt.store.humanRequest.answer(request.id, request.version, "approve", rt.human.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(card(await rt.store.humanRequest.mustGet(request.id)).applied_at).toBeUndefined();
    await clock.advance(POLL_MS);
    expect(card(await rt.store.humanRequest.mustGet(request.id))).toMatchObject({
      outcome: "started",
    });
    const follow = await waitFor(async () =>
      (await sessionsOf(rt, projectId)).find(
        (s) => s.trigger === "message" && s.status === "completed",
      ),
    );
    expect(follow.id).not.toBe(filed.id);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("done");
    await clock.advance(3 * POLL_MS);
    await new Promise((r) => setTimeout(r, 100));
    expect(await sessionsOf(rt, projectId)).toHaveLength(2);
    expect(
      (await rt.store.auditLog.list()).filter((r) => r.tool === PLAN_APPROVAL_AUDIT_TOOL),
    ).toHaveLength(1);
  });
});
