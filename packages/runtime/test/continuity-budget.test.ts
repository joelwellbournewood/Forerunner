import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { continueUsdMicro } from "../src/session/budget-card.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * Live walk 2 part 3 (B2, 2026-11-01): a task over its own budget ("Contact page", CHF 0.01)
 * stopped "after spending $0.00" and became needs_human with no card. The session's result
 * said '"Contact page" needs your decision (Inbox).' while the Inbox said "Nothing needs you";
 * the Tasks tab said "Paused"; the drawer spoke USD on a CHF screen and told the person to edit
 * the budget, press Resume and Start again.
 *
 * Now the stop files one Inbox card: '"Contact page" paused at its budget of CHF 0.01.' with
 * Continue (CHF N more), which gives it that much more and starts the session that continues
 * it (budget-resume; before, Raise the budget set a budget and a session "tried again"), and
 * Cancel task; the result, the Tasks tab and the Inbox agree; every amount is in CHF; the card
 * survives a restart without a second copy.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

function provider(clock: SimulatedClock) {
  return new FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "echo",
    replies: [
      submitReply({}, { times: Number.POSITIVE_INFINITY }),
      closingReply(),
      // The first run spends far past the task's budget on its first call; the hooks stop it
      // before the second.
      toolReply("list_dir", { path: "." }, "Looking at the folder first.", {
        when: { lastUserIncludes: "Contact page" },
        times: 1,
        usage: { input_tokens: 2_000_000, output_tokens: 200_000 },
      }),
      textReply("Wrote contact.html with the club's address.", {
        when: { lastUserIncludes: "Contact page" },
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

describe("a task stopped at its budget asks the person once, in CHF (live walk 2, B2)", () => {
  const clock = new SimulatedClock("2026-11-01T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-continuity-budget-"));
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

  beforeAll(async () => {
    ({ rt, req } = await compose(home, clock, fake));
    projectId = (
      (await (
        await req("/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Garden club", goal: "A site for the club" }),
        })
      ).json()) as Json
    ).id as string;
    // What New task sends with a budget of CHF 0.01 (USD 0.0125 at the test's rate of 0.8).
    const created = await req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Contact page",
        outcome: "contact.html says how to reach the club.",
        acceptanceCriteria: ["contact.html exists"],
        priority: "high",
        status: "ready",
        dependsOn: [],
        budgetUsdMicro: 12_500,
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

  it("the stop files one card; the result, the Tasks tab and the Inbox agree, in CHF", async () => {
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, trigger: "manual" }),
    });
    expect(started.status).toBe(202);
    const sessionId = (((await started.json()) as Json).session as Json).id as string;
    const ended = await waitFor(
      async () => {
        const s = (await (await req(`/sessions/${sessionId}`)).json()) as Json;
        return ["completed", "stopped", "failed", "killed"].includes(String(s.status))
          ? s
          : undefined;
      },
      async () => `the session to end (task ${String((await taskView()).status)})`,
    );
    const cards = await openCards();
    expect(cards).toHaveLength(1);
    const card = cards[0] as Json;
    // budget-resume: a pause names its limit and offers Continue with the amount it adds.
    expect(card.title).toBe('"Contact page" paused at its budget of CHF 0.01');
    expect(card.choices).toEqual([
      expect.objectContaining({
        label: expect.stringMatching(/^Continue \(CHF \d+\.\d\d more\)$/),
        explain: expect.stringMatching(
          /^Adds CHF \d+\.\d\d to its budget and starts a session that goes on from where it stopped\.$/,
        ),
        tone: "primary",
      }),
      expect.objectContaining({ label: "Cancel task", tone: "danger" }),
    ]);
    // The session's result points at a card that is there, as a pause.
    expect(String(ended.summary)).toContain(
      '"Contact page" paused at its budget of CHF 0.01: continue or cancel it in the Inbox.',
    );
    // The Tasks tab says the same as the Inbox, with the card to open. ADR 0112: a stop at a
    // budget is a pause (before: "Needs your decision: its budget is used").
    const view = await taskView();
    expect(view.status).toBe("needs_human");
    expect(view.display).toMatchObject({
      key: "answer",
      label: "Paused at its budget",
      detail: "Continue or cancel in the Inbox.",
      blocker: { kind: "card", requestId: card.id, cardKind: "budget" },
    });
    // CHF everywhere a person reads it: no dollar amounts.
    for (const text of [card.title, card.body, view.reason, JSON.stringify(view.display)])
      expect(String(text)).not.toMatch(/\$|USD/);
    expect(String(view.reason)).toContain("CHF 0.01");
  }, 60_000);

  it("the card survives a restart with no second copy", async () => {
    await rt.close();
    ({ rt, req } = await compose(home, clock, fake));
    await rt.syncApprovals();
    expect(await openCards()).toHaveLength(1);
    expect((await rt.store.task.mustGet(taskId)).status).toBe("needs_human");
  }, 120_000);

  it("Continue gives it the amount it named more and starts a session that finishes the task", async () => {
    const card = (await openCards())[0] as Json;
    const choice = (card.choices as Json[])[0] as Json;
    const before = await rt.store.task.mustGet(taskId);
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: choice.label }),
    });
    expect(answered.status).toBe(200);
    const raised = await rt.store.task.mustGet(taskId);
    // The amount the button named is added to what the budget covered (its budget, or what it
    // spent when that is more).
    const more = continueUsdMicro(before, {
      capUsdMicro: before.budget_usd_micro,
      source: "task_budget",
    });
    expect(raised.budget_usd_micro).toBe(
      Math.max(before.budget_usd_micro, before.actual_cost_usd_micro) + more,
    );
    expect(choice.label).toBe(`Continue (CHF ${((more * 0.8) / 1e6).toFixed(2)} more)`);
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
    expect(await openCards()).toEqual([]);
    const after = (await inbox()).requests.find((r) => r.id === card.id) as Json | undefined;
    expect(String(after?.outcome)).toMatch(/^Gave "Contact page" CHF \d+\.\d\d more: /);
  }, 60_000);

  // Review of 'cost' (ADR 0112, ADR 0019): a task whose run stopped at its budget is no sample of
  // what its work costs, even once the budget is raised and the task finishes (what it spent is
  // a lower bound). The fold after a restart left it out, but the live learner took the run that
  // finished as a sample, so Performance > Estimates and every estimate of the kind changed when
  // the daemon restarted. A task that ran in one go is a sample both ways.
  it("the raised task is no sample of what its work costs, live or after a restart; a plain task is, both ways (cost)", async () => {
    const idle = async () =>
      waitFor(
        async () => ((await rt.store.session.active(rt.agent.id)).length === 0 ? true : undefined),
        async () =>
          `no session to be running (${(await rt.store.session.active(rt.agent.id)).map((s) => s.status).join(", ")})`,
      );
    await idle();
    // A task that runs in one go, on the same project.
    const created = await req(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "Opening hours",
        outcome: "hours.html lists the opening hours.",
        acceptanceCriteria: ["hours.html exists"],
        priority: "high",
        status: "ready",
        dependsOn: [],
        specialist: "coder",
        riskTier: 1,
      }),
    });
    expect(created.status).toBe(201);
    const plainId = ((await created.json()) as Json).id as string;
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId, trigger: "manual" }),
    });
    expect(started.status, await started.clone().text()).toBe(202);
    await waitFor(
      async () => ((await rt.store.task.mustGet(plainId)).status === "done" ? true : undefined),
      async () => `"Opening hours" to be done (${(await rt.store.task.mustGet(plainId)).status})`,
    );
    await idle();
    const runs = (await rt.store.run.forTask(taskId)).filter((r) => r.specialist !== "critic");
    expect(runs.map((r) => r.outcome)).toContain("budget_exceeded");
    const view = async () => {
      const res = await req("/costs/estimates");
      expect(res.status).toBe(200);
      const { generated_at: _at, ...rest } = (await res.json()) as Json;
      return rest as { recent: Json[]; rows: Json[] } & Json;
    };
    const live = await view();
    expect(live.recent.map((s) => s.task_id)).toEqual([plainId]);
    expect(live.rows.map((r) => [r.specialist, r.samples])).toEqual([["coder", 1]]);
    await rt.close();
    ({ rt, req } = await compose(home, clock, fake));
    expect(await view()).toEqual(live);
  }, 120_000);
});

describe("how much Continue adds (budget-resume)", () => {
  it("the same amount again: the budget, the specialist's limit per run or the session's budget, at least the estimate, in steps of USD 0.01", () => {
    // A budget of USD 0.50: USD 0.50 more.
    expect(
      continueUsdMicro({ est_cost_usd_micro: 0 }, { capUsdMicro: 500_000, source: "task_budget" }),
    ).toBe(500_000);
    // No budget of its own, paused at the coder's USD 3.00 per run: USD 3.00 more (its next run
    // continues from its work in progress, so the same room goes further).
    expect(
      continueUsdMicro(
        { est_cost_usd_micro: 400_000 },
        { capUsdMicro: 3_000_000, source: "specialist_limit" },
      ),
    ).toBe(3_000_000);
    // A session's budget of USD 2.50: a session of USD 2.50.
    expect(
      continueUsdMicro({ est_cost_usd_micro: 0 }, { capUsdMicro: 2_500_000, source: "session" }),
    ).toBe(2_500_000);
    // A tiny budget: at least the estimate, rounded up to a step of USD 0.01.
    expect(
      continueUsdMicro(
        { est_cost_usd_micro: 1_234_000 },
        { capUsdMicro: 12_500, source: "task_budget" },
      ),
    ).toBe(1_240_000);
    expect(
      continueUsdMicro({ est_cost_usd_micro: 0 }, { capUsdMicro: 12_500, source: "task_budget" }),
    ).toBe(20_000);
  });
});
