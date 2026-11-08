/**
 * Scenario 5, "Budget" (spec, Phase 8): "A session hits its cap mid-task and stops cleanly with
 * a handoff."
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock. Alice's session has a cap of
 * 0.15 USD and three planned tasks. The first is quick and accepted by the critic. The second
 * has no estimate, so its allowance is what is left of the session's work budget (the executor
 * caps every run at it, ADR 0112: the fifth kept for reviews stays for them); its specialist
 * hears the wrap-up at its line, ignores it and keeps calling a tool with long replies until the
 * enforcement hooks refuse the next model call (`SessionBudget.precheck` through
 * `EnforcementHooks.beforeModelCall`). The runner then stops the session and the task pauses at
 * the session's budget with one card, at the first stop (budget-resume, the owner's decision of
 * 2026-11-02: before, it went back to ready with no card, and C-36 filed one at the second
 * stop): '"Metrics exporter" paused at this session's budget of CHF 0.12' with Continue (CHF N
 * more) and Cancel task. The third task is never started, the handoff goes to Bob, the summary to
 * J. Asserted on the ledger, the run and session rows, the run events, the audit rows, the
 * messages and the git host; then J's Continue, as the card shows it, puts it back and a second
 * session with more budget completes both.
 *
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform); the final-build runs are recorded in gates.md.
 */
import { syncBudgetStopAnswers } from "@forerunner/runtime/session/budget-card";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coderRunaway, coderWrites, criticAccepts } from "../src/scenario-scripts.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";

const START = "2026-11-03T08:00:00Z"; // 09:00 Europe/Zurich
const CAP = 150_000; // 0.15 USD; flat pricing: one token is one micro-USD

describe("scenario 5: budget", () => {
  let w: ScenarioWorld;
  beforeAll(async () => {
    w = await scenarioWorld({ start: START });
  });
  afterAll(async () => {
    await w?.close();
  });

  it("a session hits its cap mid-task: the hooks stop it, the ledger shows the cap, the handoff exists, the task is resumable", async () => {
    const T1 = "Config loader";
    const T2 = "Metrics exporter";
    const T3 = "Docs page";
    let runaway = true;
    w.provider.pushReplies(
      ...coderWrites(T1, { "src/config.ts": "export const load = () => ({ port: 8080 });\n" }),
      coderRunaway(T2, () => runaway),
      ...coderWrites(T2, { "src/metrics.ts": "export const metrics = () => 'up 1\\n';\n" }),
      ...coderWrites(T3, { "docs/metrics.md": "# Metrics\n\nExposed at /metrics.\n" }),
      ...criticAccepts(),
    );
    const t1 = await w.addTask({
      title: T1,
      outcome: "src/config.ts loads the config",
      priority: 90,
      estimateUsdMicro: 10_000,
    });
    const t2 = await w.addTask({
      title: T2,
      outcome: "src/metrics.ts exports the metrics text",
      priority: 80,
      estimateUsdMicro: 0,
      budgetUsdMicro: 2_000_000,
    });
    const t3 = await w.addTask({
      title: T3,
      outcome: "docs/metrics.md documents the endpoint",
      priority: 70,
      estimateUsdMicro: 10_000,
    });
    // No estimate for the exporter: its allowance is whatever the session has left.
    w.setEstimate(t2.id, 0);

    const first = await w.runSession(w.alice, { budgetCapUsdMicro: CAP });

    // --- Clause: the session hit its cap mid-task ----------------------------------------------
    expect(first.plan?.items.map((i) => i.taskId)).toEqual([t1.id, t2.id, t3.id]);
    expect(first.completed).toEqual([t1.id]);
    // The exporter paused at the session's budget and waits on its card; the docs page is left
    // for the next session.
    expect(first.needsHuman).toEqual([t2.id]);
    expect(first.skipped).toEqual([t3.id]);
    expect(first.stopReason).toBe("budget_exceeded");
    expect(first.status).toBe("stopped");
    const session = await w.store.session.mustGet(first.sessionId);
    expect(session.status).toBe("stopped");
    expect(session.budget_cap_usd_micro).toBe(CAP);
    expect(session.ended_at).toBeTruthy();
    // The ledger shows the cap: every call is in it, the total is under the cap, and the refused
    // call would have gone over it (its estimate is at least the last allowed one's plus the
    // tokens that call added to the conversation). That inequality is a proxy: the loop keeps
    // the hook's refusal only as the run outcome (`ForerunnerError` `budget_exceeded` becomes
    // `run_end` and the run row's outcome); the refused call's estimate is not persisted.
    const ledger = (await w.store.costLedger.sum({ sessionId: first.sessionId })).usd_micro;
    expect(ledger).toBeGreaterThan(0);
    expect(ledger).toBeLessThanOrEqual(CAP);
    expect(session.spent_usd_micro).toBe(ledger);
    // ADR 0112: the run is capped at the session's work budget, so the review's fifth is left
    // (before, the run spent past 80% of the cap, into the share kept for reviews).
    expect(ledger).toBeLessThanOrEqual(CAP * 0.8);
    expect(ledger).toBeGreaterThan(CAP * 0.6);
    const runs = await w.store.run.forSession(first.sessionId);
    const runaways = runs.filter((r) => r.task_id === t2.id);
    expect(runaways).toHaveLength(1);
    const run = runaways[0];
    if (!run) throw new Error("no run for the exporter");
    expect(run.outcome).toBe("budget_exceeded");
    expect(run.cost_usd_micro).toBe((await w.store.costLedger.sum({ runId: run.id })).usd_micro);
    expect(run.cost_usd_micro).toBeLessThanOrEqual(CAP);
    const t2Events = w.runEvents.filter((e) => e.taskId === t2.id).map((e) => e.event);
    const starts = t2Events.filter((e) => e.type === "model_call_start");
    const ends = t2Events.filter((e) => e.type === "model_call_end");
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(ends).toHaveLength(starts.length);
    const lastStart = starts[starts.length - 1];
    const lastEnd = ends[ends.length - 1];
    if (lastStart?.type !== "model_call_start" || lastEnd?.type !== "model_call_end")
      throw new Error("run events out of shape");
    // The refused call would have gone over the run's cap, the session's work budget (ADR 0112;
    // before, over the whole cap).
    expect(ledger + lastStart.estimateUsdMicro + lastEnd.usage.output_tokens).toBeGreaterThan(
      CAP * 0.8,
    );
    // It heard the wrap-up at its line and ignored it (ADR 0112; before, only an 80% warning
    // event that the model never saw).
    expect(t2Events.filter((e) => e.type === "wrap_up_sent")).toHaveLength(1);
    const runEnd = t2Events.find((e) => e.type === "run_end");
    expect(runEnd).toMatchObject({ outcome: "budget_exceeded", costUsdMicro: run.cost_usd_micro });
    // Mid-task: the specialist had made tool calls, every one audited and allowed; the hooks
    // refused the next model call, which is not a tool denial.
    const audit = await w.auditRows({ runId: run.id });
    expect(audit.length).toBe(starts.length);
    expect(audit.every((r) => r.allowed && r.tool === "read_file")).toBe(true);
    expect(
      (await w.auditRows({ sessionId: first.sessionId })).filter((r) => !r.allowed),
    ).toHaveLength(0);
    const events = await w.eventsOf(first.sessionId);
    expect(
      events.find(
        (e) => e.type === "task.finished" && (e.payload as { taskId: string }).taskId === t2.id,
      )?.payload,
    ).toMatchObject({ outcome: "paused", costUsdMicro: run.cost_usd_micro });
    expect(events.find((e) => e.type === "session.ended")?.payload).toMatchObject({
      status: "stopped",
      stopReason: "budget_exceeded",
      completed: 1,
      skipped: 1,
      spentUsdMicro: ledger,
    });
    expect(
      events.some(
        (e) => e.type === "task.started" && (e.payload as { taskId: string }).taskId === t3.id,
      ),
    ).toBe(false);

    // --- Clause: stops cleanly with a handoff --------------------------------------------------
    expect(session.handoff).toMatchObject({
      stop_reason: "budget_exceeded",
      done: [t1.id],
      blocked: [t2.id],
      next: [t3.id],
      spent_usd_micro: ledger,
    });
    const handoff = (await w.inbox(w.bob)).find((m) => m.type === "handoff");
    expect(handoff).toMatchObject({
      from_agent_id: w.alice.agent.id,
      to_agent_id: w.bob.agent.id,
      project_id: w.project.id,
      requires_ack: true,
    });
    expect(handoff?.body).toBe(session.summary);
    // The result (design §5): the pause first, by the limit its card names, then what was done,
    // how it ended and what is left.
    expect(session.summary.split("\n")).toEqual([
      '"Metrics exporter" paused at this session\'s budget of CHF 0.12: continue or cancel it in the Inbox.',
      'Did 1 task: "Config loader".',
      expect.stringMatching(
        /^The session's budget is used\. "Docs page" is ready to continue\. CHF \d+\.\d{2}\.$/,
      ),
    ]);
    // One card, at the first stop.
    const cards = await w.store.humanRequest.list({ task_id: t2.id, status: "open" } as never, {
      limit: 5,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.options).toEqual([
      expect.stringMatching(/^Continue \(CHF \d+\.\d{2} more\)$/),
      "Cancel task",
    ]);
    // J's Inbox gets one line for the session, naming the project (design §3.8); the decision
    // that waits is its card's to say (§5.10).
    const summary = (await w.inbox(w.j)).find((m) => m.type === "info");
    const projectName = (await w.store.project.mustGet(w.project.id)).name;
    expect(summary?.body).toBe(`${projectName}: did 1 task: "Config loader".`);
    expect(await w.store.task.claimedBy(w.alice.agent.id)).toEqual([]);
    expect(await w.store.session.active(w.alice.agent.id)).toEqual([]);
    const prs = await w.pullRequests({ state: "all" });
    expect(prs.map((p) => p.title)).toEqual([T1]);
    expect((await w.store.task.mustGet(t1.id)).status).toBe("done");

    // --- Clause: the task is in a resumable state ----------------------------------------------
    // Paused on its card, its attempt count unchanged (the session's budget, not the work,
    // stopped it); J's Continue, as the card shows it, puts it back to ready.
    const paused = await w.store.task.mustGet(t2.id);
    expect(paused.status).toBe("needs_human");
    expect(paused.reason).toBe('"Metrics exporter" paused at this session\'s budget of CHF 0.12.');
    const card = cards[0];
    if (!card) throw new Error("no card for the exporter");
    await w.store.humanRequest.answer(card.id, card.version, card.options[0] ?? "", w.j.id);
    const applied = await syncBudgetStopAnswers({
      store: w.store,
      clock: w.clock,
      humanId: w.j.id,
      agentId: w.alice.agent.id,
    });
    expect(applied.continued).toBe(1);
    const stopped = await w.store.task.mustGet(t2.id);
    expect(stopped.status).toBe("ready");
    expect(stopped.reason).toMatch(
      /^you gave it CHF \d+\.\d{2} more in the Inbox: it continues from where it stopped$/,
    );
    expect(stopped.claimed_by).toBeNull();
    expect(stopped.claim_expires).toBeNull();
    expect(stopped.attempt).toBe(0);
    expect(stopped.actual_cost_usd_micro).toBe(run.cost_usd_micro);
    expect((await w.store.task.mustGet(t3.id)).status).toBe("ready");

    // The next session, with more budget, continues it; the same task completes.
    runaway = false;
    await w.clock.advance(60 * 60_000);
    const second = await w.runSession(w.alice, { budgetCapUsdMicro: 2_000_000 });
    expect(second.status).toBe("completed");
    expect(second.completed).toEqual([t2.id, t3.id]);
    const resumed = await w.store.task.mustGet(t2.id);
    expect(resumed.status).toBe("done");
    expect(resumed.pr_url).toBeTruthy();
    const coderRuns = (await w.store.run.forTask(t2.id)).filter((r) => r.specialist === "coder");
    expect(coderRuns.map((r) => r.outcome).sort()).toEqual(["budget_exceeded", "completed"].sort());
    expect(coderRuns.map((r) => r.session_id).sort()).toEqual(
      [first.sessionId, second.sessionId].sort(),
    );
    expect((await w.pullRequests({ state: "open" })).map((p) => p.title).sort()).toEqual(
      [T1, T2, T3].sort(),
    );
    const secondLedger = (await w.store.costLedger.sum({ sessionId: second.sessionId })).usd_micro;
    expect(secondLedger).toBeLessThanOrEqual(2_000_000);
    expect((await w.store.costLedger.sum({ projectId: w.project.id })).usd_micro).toBe(
      ledger + secondLedger,
    );
  }, 90_000);
});
