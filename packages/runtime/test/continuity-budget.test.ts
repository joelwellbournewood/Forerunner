import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { raisedBudgetUsdMicro } from "../src/session/budget-card.ts";
import { closingReply, submitReply } from "./loop-helpers.ts";

/**
 * Live walk 2 part 3 (B2, 2026-11-01): a task over its own budget ("Contact page", CHF 0.01)
 * stopped "after spending $0.00" and became needs_human with no card. The session's result
 * said '"Contact page" needs your decision (Inbox).' while the Inbox said "Nothing needs you";
 * the Tasks tab said "Paused"; the drawer spoke USD on a CHF screen and told the person to edit
 * the budget, press Resume and Start again.
 *
 * Now the stop files one Inbox card: '"Contact page" stopped at its budget of CHF 0.01.' with
 * Raise the budget (which raises it and starts a session that tries again) and Cancel task;
 * the result, the Tasks tab and the Inbox agree; every amount is in CHF; the card survives a
 * restart without a second copy.
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
    expect(card.title).toBe('"Contact page" stopped at its budget of CHF 0.01');
    expect(card.choices).toEqual([
      expect.objectContaining({
        label: "Raise the budget",
        explain: expect.stringMatching(
          /^Sets its budget to CHF \d+\.\d\d and starts a session that tries again\.$/,
        ),
        tone: "primary",
      }),
      expect.objectContaining({ label: "Cancel task", tone: "danger" }),
    ]);
    // The session's result points at a card that is there.
    expect(String(ended.summary)).toContain('"Contact page" needs your decision (Inbox).');
    // The Tasks tab says the same as the Inbox, with the card to open. ADR 0112: a stop at a
    // budget is a pause (before: "Needs your decision: its budget is used").
    const view = await taskView();
    expect(view.status).toBe("needs_human");
    expect(view.display).toMatchObject({
      key: "answer",
      label: "Paused at its budget",
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

  it("Raise the budget raises it and starts a session that finishes the task", async () => {
    const card = (await openCards())[0] as Json;
    const choice = (card.choices as Json[])[0] as Json;
    const before = await rt.store.task.mustGet(taskId);
    const answered = await req(`/requests/${String(card.id)}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: card.version, answer: choice.label }),
    });
    expect(answered.status).toBe(200);
    const raised = await rt.store.task.mustGet(taskId);
    expect(raised.budget_usd_micro).toBeGreaterThan(before.budget_usd_micro);
    // The amount the button promised is the one set.
    const promised = /CHF (\d+\.\d\d)/.exec(String(choice.explain))?.[1];
    expect(promised).toBeDefined();
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
    expect(String(after?.outcome)).toMatch(/^Raised the budget of "Contact page" to CHF \d+\.\d\d/);
  }, 60_000);
});

describe("the budget Raise the budget sets", () => {
  it("leaves the next run as much room as the stop had: the whole budget, or twice the specialist's limit", () => {
    // A budget of USD 0.50 spent: USD 0.50 more.
    expect(
      raisedBudgetUsdMicro(
        { est_cost_usd_micro: 0 },
        { capUsdMicro: 500_000, spentUsdMicro: 500_000, source: "task_budget" },
      ),
    ).toBe(1_000_000);
    // No budget of its own, stopped at the coder's USD 3.00 per run: the budget counts every
    // run, so it is what was spent plus twice that limit (USD 3.00 more would stop it again).
    expect(
      raisedBudgetUsdMicro(
        { est_cost_usd_micro: 400_000 },
        { capUsdMicro: 3_000_000, spentUsdMicro: 3_000_000, source: "specialist_limit" },
      ),
    ).toBe(9_000_000);
    // A tiny budget: at least USD 0.50 of room, or the estimate when it is larger, in steps of
    // USD 0.05.
    expect(
      raisedBudgetUsdMicro(
        { est_cost_usd_micro: 0 },
        { capUsdMicro: 12_500, spentUsdMicro: 12_500, source: "task_budget" },
      ),
    ).toBe(550_000);
    expect(
      raisedBudgetUsdMicro(
        { est_cost_usd_micro: 1_230_000 },
        { capUsdMicro: 12_500, spentUsdMicro: 12_500, source: "task_budget" },
      ),
    ).toBe(1_250_000);
  });
});
