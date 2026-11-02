import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  fileSessionBudgetCard,
  raisedSessionBudgetUsdMicro,
  SESSION_BUDGET_STOP_OPTIONS,
} from "../src/session/budget-card.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * C-36 (the session lead's default, ADR 0105): a task a session's own budget stopped went back
 * to Ready with no card, so a task that alone always needs more than a session's budget was run
 * again by every session until the person noticed, each run bounded only by the session's budget
 * and the monthly cap. Now the first such stop releases it as before, and the second files one
 * Inbox card: '"Long report" needs more than a session's budget' with Raise session budget,
 * Raise its budget and Cancel task; the task waits for the answer. The card survives a restart
 * without a second copy, and each option does what its line says.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
/**
 * USD 2.50 (CHF 2.00) per session: room for the task's estimate (about CHF 1.20), while the
 * stand-in's first call of a run spends far more.
 */
const SESSION_BUDGET = 2_500_000;

function provider(clock: SimulatedClock) {
  return new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
      // The first two runs spend past the session's budget on their first call; the hooks stop
      // each before the second.
      toolReply("list_dir", { path: "." }, "Looking at the folder first.", {
        when: { lastUserIncludes: "Long report" },
        times: 2,
        usage: { input_tokens: 5_000_000, output_tokens: 200_000 },
      }),
      textReply("Wrote report.md with the whole report.", {
        when: { lastUserIncludes: "Long report" },
        times: Number.POSITIVE_INFINITY,
      }),
    ],
  });
}

async function compose(home: string, clock: SimulatedClock, fake: FakeProvider) {
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs,
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault(),
    provider: fake,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  const { app, token } = createDaemonApp(rt);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  return { rt, req };
}

/** Polls in real time (at least 10 s); the error says what was seen last. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: () => Promise<string>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${await what()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a task that needs more than a session's budget asks the person after the second stop (C-36)", () => {
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-session-budget-"));
  const fake = provider(clock);
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";
  let taskId = "";

  const inbox = async () => (await (await req("/inbox")).json()) as { requests: Json[] };
  const openCards = async () =>
    (await inbox()).requests.filter((r) => r.taskId === taskId && r.status === "open");
  const taskView = async () =>
    ((await (await req(`/projects/${projectId}/tasks`)).json()) as Json[]).find(
      (t) => t.id === taskId,
    ) as Json;
  /** A session as the Start dialog starts it, with its budget; resolves with it ended. */
  const session = async (): Promise<Json> => {
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId: rt.agent.id,
        projectId,
        trigger: "manual",
        budgetUsdMicro: SESSION_BUDGET,
      }),
    });
    expect(started.status).toBe(202);
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    return waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
          ? s
          : undefined;
      },
      async () => `the session to end (task ${String((await taskView()).status)})`,
    );
  };

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
    projectId = (
      (await (
        await req("/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Annual report", goal: "The club's annual report" }),
        })
      ).json()) as Json
    ).id as string;
    // A task whose own budget is far above a session's: only the session's budget stops it.
    const created = await req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Long report",
        outcome: "report.md holds the whole annual report.",
        acceptanceCriteria: ["report.md exists"],
        priority: "high",
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 50_000_000,
        specialist: "coder",
        riskTier: 1,
      }),
    });
    expect(created.status).toBe(201);
    taskId = ((await created.json()) as Json).id as string;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("the first stop releases it for the next session, with no card", async () => {
    const ended = await session();
    expect(String(ended.summary)).toContain('"Long report"');
    // It ran, and the session's budget stopped it (not the task's own: CHF 40 is far off).
    expect(
      (await rt.store.run.forTask(taskId))
        .filter((r) => r.specialist !== "critic")
        .map((r) => r.outcome),
    ).toEqual(["budget_exceeded"]);
    expect(await openCards()).toEqual([]);
    const t = await rt.store.task.mustGet(taskId);
    expect(t.status).toBe("ready");
    expect(t.attempt).toBe(0);
  }, 60_000);

  it("the second stop files one card with three options in words; the task waits for it", async () => {
    const ended = await session();
    const cards = await openCards();
    expect(cards).toHaveLength(1);
    const card = cards[0] as Json;
    expect(card.title).toBe('"Long report" needs more than a session\'s budget');
    expect(String(card.body)).toMatch(
      /^Two sessions of CHF 2\.00 stopped while it ran; it spent CHF \d+\.\d\d so far\.$/,
    );
    expect(card.choices).toEqual([
      expect.objectContaining({
        label: "Raise session budget",
        explain:
          "Sets this project's budget per session to CHF 4.00 and starts a session that tries again.",
        tone: "primary",
      }),
      expect.objectContaining({
        label: "Raise its budget",
        explain: "Starts one session of CHF 4.00 for it now; later sessions keep CHF 2.00.",
      }),
      expect.objectContaining({ label: "Cancel task", tone: "danger" }),
    ]);
    // The session's result points at the card; the Tasks tab agrees, in CHF.
    expect(String(ended.summary)).toContain('"Long report" needs your decision (Inbox).');
    const view = await taskView();
    expect(view.status).toBe("needs_human");
    expect(view.display).toMatchObject({
      key: "answer",
      label: "Needs your decision: a session's budget is too small",
      blocker: { kind: "card", requestId: card.id, cardKind: "budget" },
    });
    for (const text of [card.title, card.body, JSON.stringify(card.choices), view.reason])
      expect(String(text)).not.toMatch(/\$|USD/);
  }, 60_000);

  it("the card survives a restart with no second copy, and no session runs the task meanwhile", async () => {
    await rt.close();
    ({ rt, req } = await compose(home, clock, fake));
    await rt.syncApprovals();
    expect(await openCards()).toHaveLength(1);
    expect((await rt.store.task.mustGet(taskId)).status).toBe("needs_human");
  }, 120_000);

  it("Raise its budget starts one session of the amount it named, which finishes the task", async () => {
    const card = (await openCards())[0] as Json;
    const choice = (card.choices as Json[]).find((c) => c.label === "Raise its budget") as Json;
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: choice.label }),
    });
    expect(answered.status).toBe(200);
    const done = await waitFor(
      async () => {
        const t = await rt.store.task.mustGet(taskId);
        return t.status === "done" ? t : undefined;
      },
      async () => {
        const t = await rt.store.task.mustGet(taskId);
        return `the task to be done (${t.status}: ${t.reason})`;
      },
    );
    expect(done.status).toBe("done");
    // The one session had the amount the button named; the project's budget per session is as
    // it was.
    const sessions = await rt.store.session.list({ project_id: projectId } as never, {
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 1,
    });
    expect(sessions[0]?.budget_cap_usd_micro).toBe(raisedSessionBudgetUsdMicro(SESSION_BUDGET));
    const project = await rt.store.project.mustGet(projectId);
    expect(project.settings.session_cap_usd_micro).toBeUndefined();
    const after = (await inbox()).requests.find((r) => r.id === card.id) as Json | undefined;
    expect(String(after?.outcome)).toMatch(/^Gave "Long report" one session of CHF 4\.00/);
  }, 60_000);
});

describe("the session-budget card's other options (C-36)", () => {
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-session-budget-options-"));
  let rt: RuntimeApp;
  let req: Awaited<ReturnType<typeof compose>>["req"];
  let projectId = "";

  beforeAll(async () => {
    ({ rt, req } = await compose(
      home,
      clock,
      new FakeProvider({ clock, latency: "none", onNoMatch: "echo", replies: [] }),
    ));
    projectId = (await rt.store.project.insert({ name: "Options", goal: "g", repos: [] })).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /** A task waiting on the card, as the runner leaves it after the second stop. */
  const carded = async (title: string) => {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} is written`,
      status: "needs_human",
      budget_usd_micro: 50_000_000,
      reason: `"${title}" needs more than a session's budget.`,
    });
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      status: "completed",
      runner: "pc",
      budget_cap_usd_micro: SESSION_BUDGET,
    });
    const { request } = await fileSessionBudgetCard({
      store: rt.store,
      task,
      session,
      humanId: rt.human.id,
      agentId: rt.agent.id,
      runIds: [],
      projectCapUsdMicro: SESSION_BUDGET,
      chfPerUsd: 0.8,
    });
    expect(request.options).toEqual([...SESSION_BUDGET_STOP_OPTIONS]);
    const shown = ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.find(
      (r) => r.id === request.id,
    ) as Json;
    return { task, card: shown };
  };

  const click = async (card: Json, label: string) => {
    const choice = (card.choices as Json[]).find((c) => c.label === label) as Json;
    expect(choice, `the card offers ${label}`).toBeDefined();
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: choice.label }),
    });
    expect(answered.status).toBe(200);
  };

  it("Raise session budget sets the project's budget per session to the amount it named", async () => {
    const { task, card } = await carded("Long chapter");
    await click(card, "Raise session budget");
    const project = await rt.store.project.mustGet(projectId);
    expect(project.settings.session_cap_usd_micro).toBe(
      raisedSessionBudgetUsdMicro(SESSION_BUDGET),
    );
    // CHF 4.00 at the card's rate, for the Settings and budget words.
    expect(project.settings.session_cap_chf_micro).toBe(4_000_000);
    const t = await rt.store.task.mustGet(task.id);
    expect(["ready", "claimed", "in_progress", "in_review", "done", "failed"]).toContain(t.status);
    expect(t.budget_usd_micro).toBe(50_000_000);
    // The session it started ends before the next case (nothing left running).
    await waitFor(
      async () => {
        const running = await rt.store.session.list(
          { project_id: projectId, status: "running" } as never,
          { limit: 5 },
        );
        return running.length === 0 ? true : undefined;
      },
      async () =>
        `the started session to end (task ${(await rt.store.task.mustGet(task.id)).status})`,
    );
    const started = await rt.store.session.list({ project_id: projectId } as never, {
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 1,
    });
    expect(started[0]?.budget_cap_usd_micro).toBe(raisedSessionBudgetUsdMicro(SESSION_BUDGET));
  }, 60_000);

  it("Cancel task cancels it", async () => {
    const { task, card } = await carded("Long appendix");
    await click(card, "Cancel task");
    expect((await rt.store.task.mustGet(task.id)).status).toBe("cancelled");
  }, 60_000);
});
