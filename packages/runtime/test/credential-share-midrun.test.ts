import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { InboxView, TaskView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { BUDGET_STOP_KEY } from "../src/session/budget-card.ts";
import { CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import { updateSourceLimits } from "../src/wiring/billing-pick.ts";
import {
  credWorld,
  type Req,
  type SdkMessage,
  seedProject,
  setPolicy,
  until,
} from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-1 (CE-6; session lead decision 48; the owner's D5: "Running out
 * includes a usage limit, a plan-share cap and a monthly cap ... Whatever the policy says is
 * what happens"): the subscription's share Forerunner may use, reached in the middle of a run,
 * is a stop of that credential under the person's policy, like its usage limit. Before, the
 * hooks' plan level made it a budget pause: a budget card that waits until the 1st, whatever
 * the person chose, and a raised allowance did not end it. Composed as `fr daemon` composes it
 * (no injected provider): the scripted Claude Code books a call that takes the month past the
 * share; the hooks refuse the next call.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

/** A run on the subscription whose first call takes a tiny allowance past its share. */
async function* overTheShare(): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-share" };
  yield {
    type: "assistant",
    message: {
      id: "m-share-1",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "Writing the notes." }],
      usage: {
        input_tokens: 2_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
  yield {
    type: "assistant",
    message: {
      id: "m-share-2",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "Still writing." }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  yield { type: "result", subtype: "success", is_error: false, result: "Still writing." };
}

/** USD 0.01 a month: the first call above passes Forerunner's share of it. */
const TINY_ALLOWANCE_USD_MICRO = 10_000;

async function world(policy: string, prefix: string) {
  const clock = new SimulatedClock("2026-11-17T09:00:00Z");
  const w = credWorld({ clock, prefix });
  homes.push(w.home);
  w.setRunScript(() => overTheShare());
  const composed = await w.compose();
  await setPolicy(composed.rt, policy);
  const sub = (
    await composed.rt.store.billingSource.list({ human_id: composed.rt.human.id }, { limit: 10 })
  ).find((s) => s.kind === "subscription");
  await updateSourceLimits(composed.rt.store, sub?.id ?? "", (l) => ({
    ...l,
    planUsdMicro: TINY_ALLOWANCE_USD_MICRO,
  }));
  return { w, clock, sub, ...composed };
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

describe("l4-cred-engine, run L4: the subscription's share reached mid-run is a stop under the policy", () => {
  it("under 'then the API key' the work goes on on the key from its kept work; no budget card", async () => {
    const { w, rt, req } = await world("subscription_then_key", "fr-share-next-");
    const { project, tasks } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    await startByDialog(req, rt, project.id);
    await settleSessions(rt);
    await until("the task to finish on the key", async () => {
      const t = await rt.store.task.mustGet(tasks[0]?.id ?? "");
      return t.status === "done" ? null : t.status;
    });
    expect(await cards(rt, BUDGET_STOP_KEY)).toEqual([]);
    expect(await cards(rt, CREDENTIAL_ASK_KEY)).toEqual([]);
    expect(w.keyCalls().length).toBeGreaterThan(0);
    // The run the share stopped reads as a credential stop, never a budget pause.
    const runs = await rt.store.run.forTask(tasks[0]?.id ?? "");
    const stopped = runs.find((r) => r.outcome === "usage_limit");
    expect(stopped, runs.map((r) => r.outcome).join(",")).toBeDefined();
    expect(runs.map((r) => r.outcome)).not.toContain("budget_exceeded");
    expect(runs.map((r) => r.outcome)).not.toContain("paused");
    // The run on the key is told where the stopped one left off (CE-5's brief), as the model
    // receives it.
    const briefs = w.keyModel.calls
      .map((c) => {
        const first = c.messages[0]?.content;
        return typeof first === "string" ? first : JSON.stringify(first ?? "");
      })
      .filter((t) => t.includes("Where the last run stopped"));
    expect(briefs.length, "the key's run got the stopped run's section").toBeGreaterThan(0);
    expect(briefs[0]).toContain(
      "The last run of this task stopped when its Claude credential reached the share of the subscription Forerunner may use",
    );
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("under 'ask me first' one ask card for the share, in the person's zone; nothing reaches the key while it is open", async () => {
    const { w, rt, req } = await world("subscription_then_ask", "fr-share-ask-");
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
    expect(shown?.choices?.[1]?.explain).toBe(
      "Nothing moves until Tue 1 Dec, 01:00, or until you raise the allowance; then your session goes on.",
    );
    expect(
      inbox.requests.filter((r) => r.status === "open" && /budget/i.test(r.title ?? "")),
    ).toEqual([]);
    const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(rows.map((r) => r.display?.label)).toEqual(["Waits for your answer: use your API key?"]);
    expect((await rt.store.task.mustGet(tasks[0]?.id ?? "")).status).toBe("ready");
    expect(w.keyCalls(), "nothing reaches the key while the card is open").toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("under 'then wait' the person's session waits for the month's start and goes on by itself once; a raised allowance ends the stop; both survive a restart", async () => {
    const {
      w,
      clock,
      rt: first,
      req: req1,
    } = await world("subscription_then_wait", "fr-share-wait-");
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
    const runsBefore = w.sdkCalls.filter((c) => !c.provider).length;

    // A restart: the wait stands, nothing moves before the month's start.
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await w.compose());
    await rt.billing.waits.wake();
    await settleSessions(rt);
    expect(w.sdkCalls.filter((c) => !c.provider).length).toBe(runsBefore);
    expect(await rt.continuations.waiting(project.id)).toMatch(/Tue 1 Dec/);

    // A while later the person raises the allowance in Settings: the stop ends, and the session
    // goes on.
    w.setRunScript(null);
    await clock.advance(10 * 60_000);
    const raised = await req<{ changeLine?: string | null }>("/settings/plan-allowance", {
      chfMonthly: 160,
    });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body.changeLine).toMatch(
      /^Your subscription's allowance is raised: your session of \d\d:\d\d goes on now\.$/,
    );
    await until("the session that waited to go on and finish the task", async () => {
      const t = await rt.store.task.mustGet(tasks[0]?.id ?? "");
      return t.status === "done" ? null : t.status;
    });
    await settleSessions(rt);
    const sessions = await rt.store.session.list({ project_id: project.id } as never, {
      limit: 10,
    });
    expect(sessions).toHaveLength(2);
    // Composed again at the month's start: nothing goes on a second time.
    await rt.close();
    await clock.set(Date.parse("2026-12-01T00:05:00Z"));
    ({ rt, req } = await w.compose());
    await rt.billing.waits.wake();
    await settleSessions(rt);
    expect(
      await rt.store.session.list({ project_id: project.id } as never, { limit: 10 }),
    ).toHaveLength(2);
    expect(w.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 120_000);

  it("under 'then wait' the session goes on by itself once at the month's start (UTC)", async () => {
    const { w, clock, rt: first, req } = await world("subscription_then_wait", "fr-share-month-");
    let rt = first;
    const { project, tasks } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    await startByDialog(req, rt, project.id);
    await settleSessions(rt);
    expect(await rt.continuations.waiting(project.id)).toMatch(/Tue 1 Dec/);
    w.setRunScript(null);
    await settleSessions(rt);
    await rt.close();
    await clock.set(Date.parse("2026-12-01T00:01:00Z"));
    ({ rt } = await w.compose());
    await rt.billing.waits.wake();
    await until("the waiting session to go on at the month's start", async () => {
      const t = await rt.store.task.mustGet(tasks[0]?.id ?? "");
      return t.status === "done" ? null : t.status;
    });
    await settleSessions(rt);
    await rt.billing.waits.wake();
    await settleSessions(rt);
    expect(
      await rt.store.session.list({ project_id: project.id } as never, { limit: 10 }),
    ).toHaveLength(2);
    expect(w.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 120_000);
});
