import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { HumanRequestView, TaskView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { requestView } from "../src/daemon/views.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import type { CredentialWait } from "../src/session/credential-wait.ts";
import { waitedForCredential } from "../src/session/grant-readmit.ts";
import { LiveSessions } from "../src/session/live-sessions.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";
import { seedWorld } from "./context-helpers.ts";
import { credWorld, setPolicy } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

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

/**
 * fixup-l4-cred-screens (the review's blocking #1; L4-creds-15, C5L-6): the same rule through
 * the composed daemon, at the person's boundary. Composed with no injected provider (cred-world:
 * the router over the Messages API stand-in and a scripted Claude Code), so the yes is the
 * person's answer to the ask card in the Inbox and compose's own onGrant hands the running
 * session what it lets in. A task only the API key can do (it needs the person's answers) keeps
 * the session running on the key while the code task waits for the subscription; a third task,
 * larger than the session's work budget, becomes ready meanwhile. After "Use API key" only the
 * code task that waited runs on the key; the large task never waited and does not fit, so it
 * waits for the person's next Start. Before (onGrant readmitted every ready task), the session
 * took the large task as its own and ran it on the key with the room left, which the card's
 * figure never counted.
 */
describe("fixup-l4-cred-screens, run L4: the Inbox's yes lets in only the work that waited (L4-creds-15, C5L-6)", () => {
  const homes: string[] = [];
  const RESET = Date.parse("2026-10-31T14:00:00Z");
  const askCards = async (rt: RuntimeApp) =>
    (await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })).filter(
      (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY,
    );
  afterAll(() => removeHomes(homes));

  it("a running session at the stop: the yes in the Inbox runs the task that waited on the key, and a ready task that did not wait and does not fit stays for the next Start", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-grant-readmit-" });
    homes.push(world.home);
    world.limitSubscription(RESET);
    const { rt, req } = await world.compose();
    // The first task run on the API key is held until the person has answered, so the yes
    // reaches a session that still runs.
    let reached: () => void = () => {};
    const atKey = new Promise<void>((r) => {
      reached = r;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = world.keyModel.stream.bind(world.keyModel);
    let held = false;
    world.keyModel.stream = (request) => {
      if (held) return inner(request);
      held = true;
      return (async function* () {
        reached();
        await gate;
        yield* inner(request);
      })();
    };
    let running: Promise<unknown> = Promise.resolve();
    try {
      await setPolicy(rt, "subscription_then_ask");
      const project = await rt.store.project.insert({
        name: "Quote page",
        goal: "A quote page",
        autonomy_level: 2,
      });
      const add = (title: string, outcome: string, priority: number, estimate: number) =>
        rt.store.task.insert({
          project_id: project.id,
          title,
          outcome,
          acceptance_criteria: ["it is done"],
          risk_tier: 0,
          status: "ready",
          priority,
          est_cost_usd_micro: estimate,
          reason: "seed",
        });
      // Its first choice, the subscription, is at its limit: it waits for the person's answer.
      const waits = await add("Style the page", "The page is styled", 9, 100_000);
      // Only the API key can ask the person while it works: it runs on the key meanwhile.
      const onKey = await add("Choose the colours", "The palette needs your decision", 8, 100_000);
      // The person's Start with a budget of USD 1.00: USD 0.80 for the work, a fifth kept for
      // the reviews.
      running = rt.runner.start({
        agentId: rt.agent.id,
        projectId: project.id,
        trigger: "manual",
        by: "person",
        budgetCapUsdMicro: 1_000_000,
        grant: {
          allowedTools: [...rt.toolsForRun().names(), ...claudeCodeToolNames()],
          allowedPaths: [],
          allowedDomains: [],
          grantedSecrets: [],
        },
      });
      await Promise.race([
        atKey,
        new Promise((_, no) =>
          setTimeout(() => no(new Error("no task run reached the API key within 20 s")), 20_000),
        ),
      ]);
      // While the key works: one ask card for the stop, and a task larger than the session's
      // work budget (priced at about USD 3, against the USD 0.80 the Start left for the work)
      // becomes ready. It never waited.
      const large = await add("Build the shop", "The shop is built", 1, 10_000_000);
      const [row] = await askCards(rt);
      expect(row, "no ask card while the session runs").toBeDefined();
      if (!row) throw new Error("no ask card");
      const option = requestView(row, null).options[0];
      expect(option).toBe("Use API key");
      const answered = await req<HumanRequestView>(`/requests/${row.id}/answer`, {
        answer: option,
        version: row.version,
      });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).toBe(
        "Your API key does the work until 15:00; your session goes on now.",
      );
      release();
      await running;
      await settleSessions(rt);
      // The task that waited ran on the key in the same session, after the yes.
      const key = (
        await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })
      ).find((s) => s.kind === "api_key");
      for (const t of [waits, onKey]) {
        expect((await rt.store.task.mustGet(t.id)).status, t.title).toBe("done");
        const runs = await rt.store.run.forTask(t.id);
        expect(runs.at(-1)?.billing_source_id, t.title).toBe(key?.id);
      }
      // The large task did not wait for the stop and does not fit: the yes did not let it in.
      expect((await rt.store.task.mustGet(large.id)).status).toBe("ready");
      expect(await rt.store.run.forTask(large.id)).toHaveLength(0);
      const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
      expect(rows.find((r) => r.id === large.id)?.display?.label).toBe("Ready");
    } finally {
      release();
      await running.catch(() => undefined);
      await settleSessions(rt);
      await rt.close();
    }
  }, 120_000);
});
