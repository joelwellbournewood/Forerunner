import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { fileBudgetStopCard } from "../src/session/budget-card.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * budget-resume (the owner's decision of 2026-11-02, ADR 0112 amended; supersedes C-36): a task
 * the session's own budget stops pauses at the first stop with one card, like every other pause:
 * '"Long report" paused at this session's budget of CHF 2.00' with Continue (CHF 2.00 more),
 * which starts the next session of that amount at once, and Cancel task. Before (C-36, the
 * session lead's default): the first stop released it with no card and the second filed a card
 * with Raise session budget, Raise its budget and Cancel task. The card survives a restart
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
      // The first run spends past the session's budget on its first call; the hooks stop it
      // before the second.
      toolReply("list_dir", { path: "." }, "Looking at the folder first.", {
        when: { lastUserIncludes: "Long report" },
        times: 1,
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

describe("a task the session's budget stops pauses at the first stop with one card (budget-resume)", () => {
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

  it("the first stop pauses it with one card that names this session's budget and offers Continue (CHF 2.00 more)", async () => {
    const ended = await session();
    // It ran, and the session's budget stopped it (not the task's own: CHF 40 is far off).
    expect(
      (await rt.store.run.forTask(taskId))
        .filter((r) => r.specialist !== "critic")
        .map((r) => r.outcome),
    ).toEqual(["budget_exceeded"]);
    // Before (C-36): the first stop filed nothing and released it, the second filed a card with
    // three options. Now one card at the first stop.
    const cards = await openCards();
    expect(cards).toHaveLength(1);
    const card = cards[0] as Json;
    expect(card.title).toBe('"Long report" paused at this session\'s budget of CHF 2.00');
    // A hard stop wrote no note: the card says the work so far is kept.
    expect(card.body).toBe(
      "It stopped before it could say where it stood; its work so far is kept.",
    );
    expect(card.choices).toEqual([
      expect.objectContaining({
        label: "Continue (CHF 2.00 more)",
        explain: "Starts a session of CHF 2.00 now; it goes on from where it stopped.",
        tone: "primary",
      }),
      expect.objectContaining({
        label: "Cancel task",
        explain: "Drops it; its work is set aside until you reopen it.",
        tone: "danger",
      }),
    ]);
    // The session's result names the pause, not "needs your decision"; the Tasks tab agrees.
    expect(String(ended.summary)).toContain(
      '"Long report" paused at this session\'s budget of CHF 2.00: continue or cancel it in the Inbox.',
    );
    expect(String(ended.summary)).not.toContain("needs your decision");
    // The session's urgent notification says to continue it from its card (the runner's
    // `paused`, through the daemon's session end): never a larger session budget.
    const stop = await waitFor(
      async () =>
        (
          (await (await req("/notifications/recent?limit=200")).json()) as {
            notifications: Json[];
          }
        ).notifications.find((n) => n.kind === "budget_stop" && n.sessionId === ended.id),
      async () => "the session's budget_stop notification",
    );
    expect(String(stop.body)).toContain("Continue it from its card in the Inbox.");
    expect(String(stop.body)).not.toContain("larger budget");
    const view = await taskView();
    expect(view.status).toBe("needs_human");
    expect(view.attempt).toBe(0);
    expect(view.display).toMatchObject({
      key: "answer",
      label: "Paused at the session's budget",
      detail: "Continue or cancel in the Inbox.",
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

  it("Continue starts a session of the amount it named at once; its brief starts from where the last run stopped; the task finishes and no new card is filed", async () => {
    const card = (await openCards())[0] as Json;
    const before = fake.calls.length;
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: "Continue (CHF 2.00 more)" }),
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
    // The session had the amount the button named; the task's own budget is as it was.
    const sessions = await rt.store.session.list({ project_id: projectId } as never, {
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 1,
    });
    expect(sessions[0]?.budget_cap_usd_micro).toBe(SESSION_BUDGET);
    expect(done.budget_usd_micro).toBe(50_000_000);
    // The run that continued it was told where the last one stopped, first.
    const brief = fake.calls
      .slice(before)
      .map((c) => JSON.stringify(c.request.messages))
      .find((m) => m.includes("Long report") && m.includes("Where the last run stopped"));
    expect(brief, "a brief that starts from where the last run stopped").toBeDefined();
    expect(brief).toContain("It left no note: it stopped at its budget before it could write one.");
    expect(brief).not.toContain("It failed:");
    const after = (await inbox()).requests.find((r) => r.id === card.id) as Json | undefined;
    expect(String(after?.outcome)).toBe('Gave "Long report" CHF 2.00 more: a session started.');
    expect(await openCards()).toEqual([]);
  }, 60_000);
});

describe("Cancel task on a paused task's card (budget-resume)", () => {
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-session-budget-cancel-"));
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

  it("Cancel task names the task that will be stuck, cancels it and says what became of its work", async () => {
    const task = await rt.store.task.insert({
      project_id: projectId,
      title: "Long appendix",
      outcome: "appendix.md is written",
      status: "needs_human",
      budget_usd_micro: 50_000_000,
      reason: '"Long appendix" paused at this session\'s budget of CHF 2.00.',
    });
    await rt.store.task.insert({
      project_id: projectId,
      title: "Index of the appendix",
      outcome: "index.md is written",
      status: "ready",
      depends_on: [task.id],
    });
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: projectId,
      trigger: "manual",
      status: "completed",
      runner: "pc",
      budget_cap_usd_micro: SESSION_BUDGET,
    });
    const { request } = await fileBudgetStopCard({
      store: rt.store,
      task,
      session,
      humanId: rt.human.id,
      agentId: rt.agent.id,
      runId: null,
      stop: {
        capUsdMicro: SESSION_BUDGET,
        spentUsdMicro: 1_000_000,
        source: "session",
        specialist: "coder",
        stoppedBy: "wrap_up",
      },
      handoff: {
        stopped: "appendix.md has its first two parts.",
        leftToDo: ["write part 3", "check the appendix"],
        stoppedBy: "wrap_up",
      },
      now: clock.nowIso(),
      chfPerUsd: 0.8,
    });
    expect(request.options).toEqual(["Continue (CHF 2.00 more)", "Cancel task"]);
    const card = ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.find(
      (r) => r.id === request.id,
    ) as Json;
    // What it did and left, in its own words; Cancel names what will be stuck.
    expect(card.body).toBe(
      'Done: appendix.md has its first two parts; left: write part 3, check the appendix. "Index of the appendix" waits on it.',
    );
    const cancel = (card.choices as Json[]).find((c) => c.label === "Cancel task") as Json;
    expect(cancel.explain).toBe(
      'Drops it; its work is set aside until you reopen it; "Index of the appendix" will be stuck.',
    );
    expect(cancel.confirm).toBe(
      'Cancel "Long appendix"? "Index of the appendix" waits on it and will be stuck.',
    );
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: cancel.label }),
    });
    expect(answered.status).toBe(200);
    expect((await rt.store.task.mustGet(task.id)).status).toBe("cancelled");
    const after = ((await (await req("/inbox")).json()) as { requests: Json[] }).requests.find(
      (r) => r.id === request.id,
    ) as Json;
    // Nothing of it was in the folder (no run wrote there): it is only cancelled.
    expect(after.outcome).toBe('"Long appendix" was cancelled.');
  }, 60_000);
});
