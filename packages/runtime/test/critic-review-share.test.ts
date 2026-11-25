import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { InboxView, TaskView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { BUDGET_STOP_KEY } from "../src/session/budget-card.ts";
import { CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import { updateSourceLimits } from "../src/wiring/billing-pick.ts";
import {
  credWorld,
  providerReply,
  type Req,
  type SdkCall,
  type SdkMessage,
  seedProject,
  setPolicy,
  until,
} from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * w8-l4-leftovers, wave 8 (L4i-left-59; L4a-left-7 and L4c-left-12, carried twice): the
 * subscription's share Forerunner may use, met by the critic's review of a task, is a stop of
 * that credential under the person's policy, as it is for a run (L4-creds-1, the owner's D5:
 * "Running out includes a usage limit, a plan-share cap and a monthly cap ... Whatever the
 * policy says is what happens"). Before, the hooks' plan level refused the review's next call
 * and the session paused the task as at a budget: a budget card ("Done; its review waits for
 * room in your Claude subscription's share") that waited until the 1st whatever the person
 * chose. Composed as `fr daemon` composes it: the task's run on the subscription is cheap; the
 * review's first call (it reads before it judges) takes a tiny allowance past its share, and
 * the hooks refuse the review's next call.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const ev = (event: Record<string, unknown>): SdkMessage => ({ type: "stream_event", event });

/** The review's first call: it asks to read a file (no verdict yet) and costs USD 0.014 a scale. */
async function* readsFirst(scale = 1): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-review-read" };
  yield ev({
    type: "message_start",
    message: {
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 2_000 * scale, output_tokens: 0 },
    },
  });
  yield ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tu_cc_read", name: "mcp__forerunner__read_file" },
  });
  yield ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "notes/pond.md" }) },
  });
  yield ev({ type: "content_block_stop", index: 0 });
  yield ev({
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 1_000 * scale },
  });
  yield ev({ type: "message_stop" });
  yield { type: "result", subtype: "success", is_error: false, result: "" };
}

/** USD 0.01 a month: the review's first call above passes Forerunner's share of it. */
const TINY_ALLOWANCE_USD_MICRO = 10_000;

async function world(policy: string, prefix: string, scale = 1) {
  const clock = new SimulatedClock("2026-11-17T09:00:00Z");
  const w = credWorld({ clock, prefix });
  homes.push(w.home);
  let reviewCalls = 0;
  w.setProviderScript((call: SdkCall) => {
    if (!call.review) return providerReply(call);
    reviewCalls++;
    return reviewCalls === 1 ? readsFirst(scale) : providerReply(call);
  });
  const composed = await w.compose();
  await setPolicy(composed.rt, policy);
  const sub = (
    await composed.rt.store.billingSource.list({ human_id: composed.rt.human.id }, { limit: 10 })
  ).find((s) => s.kind === "subscription");
  await updateSourceLimits(composed.rt.store, sub?.id ?? "", (l) => ({
    ...l,
    planUsdMicro: TINY_ALLOWANCE_USD_MICRO,
  }));
  return { w, clock, sub, reviewCalls: () => reviewCalls, ...composed };
}

const cards = async (rt: RuntimeApp, key: string) =>
  (await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })).filter(
    (r) => (r.change_card as { key?: unknown } | null)?.key === key,
  );

async function startByDialog(req: Req, rt: RuntimeApp, projectId: string) {
  const res = await req<{ result?: string }>("/sessions", {
    agentId: rt.agent.id,
    projectId,
    trigger: "manual",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body;
}

describe("w8-l4-leftovers, wave 8: a critic review that meets the subscription's share is a credential stop under the policy (L4i-left-59)", () => {
  it("under 'then the API key' the review goes on on the key: the task is done, no budget card, its review's cost on the task", async () => {
    const { w, rt, req } = await world("subscription_then_key", "fr-review-share-next-");
    const { project, tasks } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    await startByDialog(req, rt, project.id);
    await settleSessions(rt);
    await until("the task to be done once its review went on on the key", async () => {
      const t = await rt.store.task.mustGet(tasks[0]?.id ?? "");
      return t.status === "done" ? null : `${t.status}: ${t.reason}`;
    });
    expect(await cards(rt, BUDGET_STOP_KEY)).toEqual([]);
    expect(await cards(rt, CREDENTIAL_ASK_KEY)).toEqual([]);
    expect(w.keyCalls().length, "the review went on on the key").toBeGreaterThan(0);
    // What it cost: the review's call on the subscription (USD 0.021 at API prices) and its
    // calls on the key are on the task's figure and the session's spend; no run of the work
    // again (one run, on the subscription).
    const task = await rt.store.task.mustGet(tasks[0]?.id ?? "");
    const runs = await rt.store.run.forTask(task.id);
    const refused = runs.find((r) => r.outcome === "budget_exceeded");
    // The work ran on the subscription, as the refused review did; the review went on elsewhere.
    const onKey = runs.find(
      (r) => r.outcome === "completed" && r.billing_source_id !== refused?.billing_source_id,
    );
    expect(refused?.cost_usd_micro ?? 0, "the refused review's call").toBeGreaterThan(0);
    expect(onKey, "a review run on another credential").toBeDefined();
    const total = runs.reduce((n, r) => n + r.cost_usd_micro, 0);
    expect(task.actual_cost_usd_micro).toBe(total);
    const [session] = await rt.store.session.list({ project_id: project.id } as never, {
      limit: 5,
    });
    expect(session?.spent_usd_micro ?? 0).toBeGreaterThanOrEqual(total);
    expect(w.sdkCalls.filter((c) => !c.provider)).toHaveLength(1);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("under 'ask me first' one ask card for the share; nothing reaches the key and the work is not run again while it is open; a restart keeps the hold and the same card", async () => {
    const {
      w,
      rt: first,
      req: req1,
    } = await world("subscription_then_ask", "fr-review-share-ask-");
    let rt = first;
    let req = req1;
    const { project, tasks } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    await startByDialog(req, rt, project.id);
    await settleSessions(rt);
    expect(await cards(rt, BUDGET_STOP_KEY)).toEqual([]);
    const asks = await cards(rt, CREDENTIAL_ASK_KEY);
    expect(asks).toHaveLength(1);
    const inbox = (await req<InboxView>("/inbox")).body;
    const shown = inbox.requests.find((r) => r.id === asks[0]?.id);
    expect(shown?.title).toBe("Use your API key until Tue 1 Dec?");
    expect(shown?.choices?.map((c) => c.label)).toEqual(["Use API key", "Wait"]);
    expect(
      inbox.requests.filter((r) => r.status === "open" && /budget|room in/i.test(r.title ?? "")),
    ).toEqual([]);
    const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(rows.map((r) => r.display?.label)).toEqual(["Waits for your answer: use your API key?"]);
    expect((await rt.store.task.mustGet(tasks[0]?.id ?? "")).status).toBe("ready");
    expect(w.keyCalls(), "nothing reaches the key while the card is open").toHaveLength(0);
    const workRuns = w.sdkCalls.filter((c) => !c.provider).length;
    expect(workRuns).toBe(1);

    // Composed again while the review is held: the same one card, the same hold, nothing moves.
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await w.compose());
    await rt.billing.waits.wake();
    await settleSessions(rt);
    expect((await cards(rt, CREDENTIAL_ASK_KEY)).map((c) => c.id)).toEqual(asks.map((c) => c.id));
    expect(await cards(rt, BUDGET_STOP_KEY)).toEqual([]);
    const after = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(after.map((r) => r.display?.label)).toEqual([
      "Waits for your answer: use your API key?",
    ]);
    expect(w.keyCalls()).toHaveLength(0);
    expect(w.sdkCalls.filter((c) => !c.provider)).toHaveLength(workRuns);
    await settleSessions(rt);
    await rt.close();
  }, 120_000);

  it("under 'then wait' the review waits for the month's start (UTC); nothing moves, after a restart too", async () => {
    const {
      w,
      rt: first,
      req: req1,
    } = await world("subscription_then_wait", "fr-review-share-wait-");
    let rt = first;
    let req = req1;
    const { project, tasks } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    await startByDialog(req, rt, project.id);
    await settleSessions(rt);
    expect(await cards(rt, BUDGET_STOP_KEY)).toEqual([]);
    expect(await cards(rt, CREDENTIAL_ASK_KEY)).toEqual([]);
    expect((await rt.store.task.mustGet(tasks[0]?.id ?? "")).status).toBe("ready");
    const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(rows.map((r) => r.display?.label)).toEqual([
      "Waits until Tue 1 Dec (your subscription's share)",
    ]);
    expect(await rt.continuations.waiting(project.id)).toMatch(/Tue 1 Dec/);
    expect(w.keyCalls(), "under 'then wait' nothing reaches the key").toHaveLength(0);
    const callsBefore = w.sdkCalls.length;

    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await w.compose());
    await rt.billing.waits.wake();
    await settleSessions(rt);
    expect(w.sdkCalls.length, "nothing moves before the month's start").toBe(callsBefore);
    expect(await rt.continuations.waiting(project.id)).toMatch(/Tue 1 Dec/);
    const after = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(after.map((r) => r.display?.label)).toEqual([
      "Waits until Tue 1 Dec (your subscription's share)",
    ]);
    expect(await cards(rt, BUDGET_STOP_KEY)).toEqual([]);
    await settleSessions(rt);
    await rt.close();
  }, 120_000);

  it("the task's own budget stops the review first (its review counts on it): a budget pause at the task's budget, not the share", async () => {
    // The review's first call costs five times as much (USD 0.07): with a budget of its own of
    // USD 0.10 the run fits and the review starts, and what that call leaves of the budget is
    // too little for the review to go on on the key: the task's budget binds (the owner's answer
    // of 2026-11-16: "yes it should count critics reviews, and fixes."), never the share.
    const { w, rt, req } = await world("subscription_then_key", "fr-review-share-task-", 6);
    const { project, tasks } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"], {
      estimateUsdMicro: 1_000,
      budgetUsdMicro: 100_000,
    });
    await startByDialog(req, rt, project.id);
    await settleSessions(rt);
    const budgetCards = await cards(rt, BUDGET_STOP_KEY);
    expect(budgetCards).toHaveLength(1);
    expect(await cards(rt, CREDENTIAL_ASK_KEY)).toEqual([]);
    const task = await rt.store.task.mustGet(tasks[0]?.id ?? "");
    expect(task.status).toBe("needs_human");
    expect(task.reason).toMatch(
      /^"Write notes\/pond\.md" is done; its review waits for room in its budget/,
    );
    expect(w.keyCalls(), "the key is not asked for a task its own budget holds").toHaveLength(0);
    // Its review's call is on its figure, within its budget.
    expect(task.actual_cost_usd_micro).toBeGreaterThanOrEqual(70_000);
    expect(task.actual_cost_usd_micro).toBeLessThanOrEqual(100_000);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});
