import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import type { CredentialWait } from "../src/session/credential-wait.ts";
import { waitedForCredential } from "../src/session/grant-readmit.ts";
import { LiveSessions } from "../src/session/live-sessions.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { seedWorld } from "./context-helpers.ts";

/**
 * l4-cred-screens, run L4 (L4-creds-15, C5L-6; ADR 0120 amended 2026-11-22; the owner's option C
 * of 2026-11-09, "the session keeps its promise and spare budget isn't wasted"): the yes on "Use
 * your API key until 15:40?" takes back into the running session only the work that waited for
 * that stop. The runner with a scripted executor, the composition's own readmit
 * (`waitedForCredential`, which compose's onGrant hands the session): a task that met the stop
 * runs again in the same session, and a ready task the session left out because it did not fit
 * stays out and waits for the next Start. Before, the yes readmitted every ready task, so the key
 * ran work the card's figure never counted.
 */
const usd = (n: number) => Math.round(n * 1_000_000);
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };
const WAIT: CredentialWait = {
  reason: "limit",
  sourceId: "sub-1",
  kind: "subscription",
  until: "2026-11-10T09:40:00Z",
};

describe("l4-cred-screens, run L4: the yes lets in only the work that waited (L4-creds-15, C5L-6)", () => {
  let store: StateStore;
  let clock: SimulatedClock;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  let live: LiveSessions;
  const ran: string[] = [];
  const during = new Map<string, () => Promise<void>>();
  const stopped = new Set<string>();
  const executor: TaskExecutor = {
    async execute({ task, budget, session }) {
      ran.push(task.title);
      // The first run of a task the stop holds meets the subscription's limit (no cost).
      if (stopped.has(task.title)) {
        stopped.delete(task.title);
        return {
          outcome: "usage_limit",
          summary: `Your Claude subscription reached its usage limit; "${task.title}" waits.`,
          costUsdMicro: 0,
          checksPassed: false,
          changedFiles: [],
          credentialWait: WAIT,
        };
      }
      const cost = usd(0.1);
      const run = await store.run.insert({
        task_id: task.id,
        session_id: session.id,
        specialist: "coder",
        model: "fake-sonnet",
        provider: "fake",
        effort: "medium",
        cost_usd_micro: cost,
        duration_ms: 1000,
        outcome: "completed",
      });
      budget.record(run.id, cost);
      await during.get(task.title)?.();
      return {
        outcome: "done",
        summary: "done",
        costUsdMicro: cost,
        checksPassed: true,
        runId: run.id,
        changedFiles: ["a.txt"],
      };
    },
  };
  const add = (title: string, estimate: number, priority: number) =>
    store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "ready",
      priority,
      est_cost_usd_micro: usd(estimate),
      reason: "seed",
    });

  beforeEach(async () => {
    clock = new SimulatedClock("2026-11-10T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    w = await seedWorld(store, {}, { session: false });
    live = new LiveSessions();
    ran.length = 0;
    during.clear();
    stopped.clear();
  });
  afterEach(async () => {
    await store.close();
  });

  it("a task that met the stop runs again on the yes; a ready task left out for the budget does not join", async () => {
    // Work budget USD 1.00 (a fifth of 1.25 kept for reviews): the waiting task and the second
    // fit (0.4 + 0.4); the third (0.9) does not fit after them, nor in the room their runs leave
    // (1.00 less 0.2 spent), and is left out.
    await add("Waits for the subscription", 0.4, 9);
    await add("Runs meanwhile", 0.4, 8);
    const third = await add("Did not fit", 0.9, 7);
    stopped.add("Waits for the subscription");
    let readmitted: string[] = [];
    during.set("Runs meanwhile", async () => {
      // The person's yes arrives while the session still runs: the composition's readmit.
      const handle = live.forProject(w.project);
      expect(handle).toBeDefined();
      readmitted = await waitedForCredential(store, w.project);
      handle?.readmit(readmitted);
    });
    await new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
      live,
    }).start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      by: "person",
      budgetCapUsdMicro: usd(1.25),
      grant,
    });
    const waited = (await store.task.forProject(w.project, {}, { limit: 10 })).find(
      (t) => t.title === "Waits for the subscription",
    ) as TaskRow;
    expect(readmitted).toEqual([waited.id]);
    expect(ran).toEqual([
      "Waits for the subscription",
      "Runs meanwhile",
      "Waits for the subscription",
    ]);
    // The task that did not fit stays ready for the person's next Start.
    expect((await store.task.mustGet(third.id)).status).toBe("ready");
    expect((await store.task.mustGet(waited.id)).status).toBe("done");
  });
});
