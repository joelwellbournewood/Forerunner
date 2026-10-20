import { type ModelTier, modelIdFor, type SessionResult } from "@forerunner/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine } from "../src/budget.ts";
import { composeLive, type LiveHarness } from "../src/harness.ts";
import { type LiveCall, MeteredProvider } from "../src/metered.ts";
import { liveEnabled, reportDir, SKIP_REASON, usd, writeReport } from "../src/report.ts";

/**
 * Phase 1 gate, the live half on the API key (spec, Build order: "The same session runs once
 * on a subscription and once on an API key with correct usage recorded"; the subscription half
 * waits for a `claude setup-token`, see BLOCKERS.md). The real runtime on the real provider:
 * one session plans and completes three small tasks through pull requests on the fake git
 * host, Sonnet for the work and the tier 1 critic, Haiku for text chat, every call under the
 * task, session, run and live caps; the kill switch stops a live run within 2 seconds. Cost
 * and durations are recorded in the report and in the spend ledger. The session case proves
 * the usage half (every task worked through a PR, every cap held, the store's cost ledger
 * equal to the spend ledger on the `api_key` source); the gate case after it asserts the
 * completion half on its own (`completed + inReview === 3`), so a critic that sends clean
 * work back fails that case and that case only, with the verdicts in the message.
 */
const LIVE = liveEnabled();
const live = it.skipIf(!LIVE);

interface TaskEvidence {
  title: string;
  outcome: string;
  verdict: string | null;
  grade: number | null;
  runs: {
    specialist: string;
    model: string;
    costUsd: number;
    durationMs: number;
    outcome: string;
  }[];
  /** The coder runs' cost from the Run rows: what the task cap bounds. */
  coderUsd: number;
  /** Everything the task cost in the store's cost ledger (coder and critic), by specialist. */
  ledger: { usd: number; entries: number; tokensIn: number; tokensOut: number };
  cost: Record<string, { usd: number; entries: number; tokensIn: number; tokensOut: number }>;
  pr: string | null;
}

describe(`phase 1 gate, live half on the API key${LIVE ? "" : ` (${SKIP_REASON})`}`, () => {
  let h: LiveHarness;
  let dir = "";
  const evidence: Record<string, unknown> = {};
  const callsSince = (mark: number): LiveCall[] => h.provider.calls.slice(mark);
  /** The session case's result, for the gate case that follows it. */
  let session: { result: SessionResult; tasks: TaskEvidence[] } | null = null;
  const spent = (calls: LiveCall[]) => ({
    calls: calls.length,
    usd: Math.round(calls.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6,
    tokensIn: calls.reduce((s, c) => s + c.tokensIn + c.cacheRead + c.cacheWrite, 0),
    tokensOut: calls.reduce((s, c) => s + c.tokensOut, 0),
  });

  beforeAll(async () => {
    if (!LIVE) return;
    dir = reportDir();
    h = await composeLive();
    console.log(`live run ${h.run}; reports in ${dir}; ${budgetLine(h.budget)}`);
  });
  afterAll(async () => {
    if (!h) return;
    const file = writeReport(dir, "phase1-live", {
      run: h.run,
      date: h.app.clock.nowIso(),
      ...evidence,
      budget: h.budget.snapshot(),
      totals: h.provider.totals(),
      calls: h.provider.calls,
    });
    console.log(`phase 1 live report: ${file}\n${budgetLine(h.budget)}`);
    await h.close();
  });

  live("the ladder's haiku and sonnet ids exist on the provider (free call)", async () => {
    const models = await h.provider.listModels();
    const ids = models.map((m) => m.id);
    evidence.models = ids;
    for (const tier of ["haiku", "sonnet"] as ModelTier[]) {
      const id = modelIdFor(tier, "anthropic", h.app.modelConfig().ladder);
      expect(ids, `${tier} rung ${id} listed by the provider`).toContain(id);
    }
  });

  live(
    "one session works three tasks via pull requests, Sonnet coder and critic, under every cap, with correct usage on the api_key source",
    async () => {
      const sessionCap = 3_000_000;
      const taskCap = 400_000;
      const project = await h.addProject({
        name: "Live sample",
        goal: "A tiny TypeScript library grown by small, reviewed changes",
        budgetUsdMicro: 5_000_000,
      });
      const specs = [
        {
          title: "Add a greet function",
          outcome:
            "src/greet.ts exports greet(name: string): string that returns the text Hello, <name>! and test/greet.test.ts covers it with node:test",
          acceptanceCriteria: [
            "src/greet.ts exports greet(name: string): string",
            'greet("Ada") returns "Hello, Ada!"',
            "test/greet.test.ts exists, imports greet from ../src/greet.ts and asserts the example with node:assert/strict and node:test",
          ],
        },
        {
          title: "Add a clamp function",
          outcome:
            "src/clamp.ts exports clamp(n: number, min: number, max: number): number that limits n to [min, max] and throws a RangeError when min > max, with test/clamp.test.ts",
          acceptanceCriteria: [
            "src/clamp.ts exports clamp(n: number, min: number, max: number): number",
            "clamp returns min when n < min, max when n > max, and n otherwise",
            "clamp throws RangeError when min > max",
            "test/clamp.test.ts exists and covers the three cases with node:test and node:assert/strict",
          ],
        },
        {
          title: "Start a changelog",
          outcome:
            "CHANGELOG.md exists with an Unreleased heading and one bullet that names the add function as the first feature",
          acceptanceCriteria: [
            "CHANGELOG.md exists at the repository root",
            "CHANGELOG.md has a heading that contains the word Unreleased",
            "under that heading one bullet names the add function",
          ],
        },
      ];
      const tasks = [];
      for (const [i, s] of specs.entries()) {
        tasks.push(
          await h.addTask(project, {
            ...s,
            budgetUsdMicro: taskCap,
            estimateUsdMicro: taskCap,
            priority: 10 - i,
          }),
        );
      }
      const events: { at: number; type: string; payload: Record<string, unknown> }[] = [];
      const mark = h.provider.calls.length;
      const t0 = performance.now();
      const res = await h.startSession({
        projectId: project,
        budgetCapUsdMicro: sessionCap,
        onEvent: (type, payload) => events.push({ at: performance.now() - t0, type, payload }),
      });
      const durationMs = Math.round(performance.now() - t0);
      const calls = callsSince(mark);
      const prs = await h.app.gitHost.listPullRequests(
        { owner: h.repo.owner, name: h.repo.name },
        { state: "all" },
      );
      const runs = await h.app.store.run.forSession(res.sessionId);
      const reviews = res.reviews;
      const perTask: TaskEvidence[] = [];
      for (const t of tasks) {
        const after = await h.app.store.task.mustGet(t.id);
        const review = reviews.find((r) => r.taskId === t.id) ?? null;
        const taskRuns = runs.filter((r) => r.task_id === t.id);
        const taskLedger = await h.app.store.costLedger.sum({ taskId: t.id });
        perTask.push({
          title: t.title,
          outcome: after.status,
          verdict: review?.verdict ?? null,
          grade: review?.grade ?? null,
          runs: taskRuns.map((r) => ({
            specialist: r.specialist,
            model: r.model,
            costUsd: r.cost_usd_micro / 1e6,
            durationMs: r.duration_ms ?? 0,
            outcome: r.outcome,
          })),
          coderUsd:
            taskRuns
              .filter((r) => r.specialist === "coder")
              .reduce((sum, r) => sum + r.cost_usd_micro, 0) / 1e6,
          ledger: {
            usd: taskLedger.usd_micro / 1e6,
            entries: taskLedger.entries,
            tokensIn:
              taskLedger.tokens_in + taskLedger.cache_read_tokens + taskLedger.cache_write_tokens,
            tokensOut: taskLedger.tokens_out,
          },
          // What the task cost by who spent it, as the store's cost ledger attributes it
          // (evidence only: the hooks' entries carry no specialist in this build).
          cost: Object.fromEntries(
            (await h.app.store.costLedger.breakdown("specialist", { taskId: t.id })).map((b) => [
              b.key ?? "unknown",
              {
                usd: b.usd_micro / 1e6,
                entries: b.entries,
                tokensIn: b.tokens_in,
                tokensOut: b.tokens_out,
              },
            ]),
          ),
          pr: after.pr_url,
        });
      }
      const planned = events.find((e) => e.type === "session.planned");
      // Wall time per task: from its task.started to the next task.started or the session's
      // end (the critic review included); the Run rows carry their own duration once written.
      const starts = events.filter((e) => e.type === "task.started");
      const taskWall = starts.map((e, i) => ({
        taskId: String(e.payload.taskId),
        title: String(e.payload.title),
        wallMs: Math.round((starts[i + 1]?.at ?? durationMs) - e.at),
      }));
      const audit = await h.app.store.auditLog.list(undefined, { limit: 10_000 });
      const ledgerSum = await h.app.store.costLedger.sum({ sessionId: res.sessionId });
      evidence.session = {
        sessionId: res.sessionId,
        status: res.status,
        stopReason: res.stopReason,
        durationMs,
        planningMs: planned ? Math.round(planned.at) : null,
        completed: res.completed.length,
        inReview: res.inReview.length,
        retried: res.retried.length,
        failed: res.failed.length,
        needsHuman: res.needsHuman.length,
        spentUsd: res.spentUsdMicro / 1e6,
        sessionCapUsd: sessionCap / 1e6,
        taskCapUsd: taskCap / 1e6,
        pullRequests: prs.map((p) => ({ number: p.number, head: p.head.ref, title: p.title })),
        storeLedger: {
          entries: ledgerSum.entries,
          usd: ledgerSum.usd_micro / 1e6,
          tokensIn:
            ledgerSum.tokens_in + ledgerSum.cache_read_tokens + ledgerSum.cache_write_tokens,
          tokensOut: ledgerSum.tokens_out,
        },
        spendLedger: spent(calls),
        runs: runs.map((r) => ({
          specialist: r.specialist,
          model: r.model,
          outcome: r.outcome,
          costUsd: r.cost_usd_micro / 1e6,
          durationMs: r.duration_ms,
          ttftMs: r.ttft_ms,
        })),
        tasks: perTask,
        taskWall,
        auditDenied: audit.filter((a) => !a.allowed).map((a) => `${a.tool}: ${a.denied_reason}`),
        summary: res.summary,
      };
      console.log(JSON.stringify(evidence.session, null, 2));
      session = { result: res, tasks: perTask };

      // The usage half: the session ran to its end, every task was worked (done, in review or
      // sent back by the critic) and opened a PR, nothing failed, nothing was refused by a cap,
      // and every total stayed under its cap. Whether the tasks *completed* is the gate case
      // below, asserted on its own.
      expect(res.status).toBe("completed");
      expect(res.failed).toEqual([]);
      expect(res.needsHuman).toEqual([]);
      expect(
        res.completed.length + res.inReview.length + res.retried.length,
        "every task was worked",
      ).toBe(3);
      expect(prs.filter((p) => p.head.ref.startsWith("fr/"))).toHaveLength(3);
      expect(runs.filter((r) => r.outcome === "budget_exceeded")).toEqual([]);
      expect(runs.filter((r) => r.specialist === "coder")).toHaveLength(3);
      expect(runs.every((r) => r.model === modelIdFor("sonnet", "anthropic"))).toBe(true);
      // Every task's coder spend under the task cap, from the Run rows the executor writes at
      // the end of each run; every task's calls in the cost ledger the hooks write.
      for (const t of perTask) {
        const coderRuns = t.runs.filter((r) => r.specialist === "coder");
        expect(coderRuns, `${t.title}: one coder run`).toHaveLength(1);
        expect(coderRuns[0]?.outcome, `${t.title}: the coder run completed`).toBe("completed");
        expect(t.coderUsd, `${t.title}: the coder run recorded its cost`).toBeGreaterThan(0);
        expect(t.coderUsd, `${t.title}: coder spend under the task cap`).toBeLessThanOrEqual(
          taskCap / 1e6,
        );
        expect(t.ledger.entries, `${t.title}: calls in the cost ledger`).toBeGreaterThan(0);
        expect(t.ledger.usd, `${t.title}: ledger covers the runs`).toBeGreaterThanOrEqual(
          t.runs.reduce((sum, r) => sum + r.costUsd, 0) - 1e-6,
        );
      }
      expect(ledgerSum.usd_micro).toBeLessThanOrEqual(sessionCap);
      expect(res.spentUsdMicro).toBeLessThanOrEqual(sessionCap);
      expect(h.budget.refusals).toEqual([]);
      expect(calls.filter((c) => c.status !== "ok")).toEqual([]);
      expect(audit.filter((a) => !a.allowed && a.tool === "live.model_call")).toEqual([]);
      expect(h.budget.snapshot().runUsd).toBeLessThanOrEqual(h.budget.config.runCapUsd);
      // Correct usage recorded: the store's cost ledger (what the product bills to the api_key
      // source) carries the same tokens the provider reported to the spend ledger.
      expect(ledgerSum.tokens_in + ledgerSum.cache_read_tokens + ledgerSum.cache_write_tokens).toBe(
        spent(calls).tokensIn,
      );
      expect(ledgerSum.tokens_out).toBe(spent(calls).tokensOut);
      const sources = await h.app.store.billingSource.enabledFor(h.app.human.id);
      expect(sources.map((s) => s.kind)).toEqual(["api_key"]);
      expect(runs.every((r) => r.billing_source_id === sources[0]?.id)).toBe(true);
    },
  );

  live(
    "the gate: the session completed all three tasks (done or in review; none sent back by the critic)",
    () => {
      expect(session, "the session case ran first").not.toBeNull();
      if (!session) return;
      const { result, tasks } = session;
      const verdicts = tasks
        .map((t) => `${t.title}: ${t.outcome}, ${t.verdict ?? "no review"} ${t.grade ?? ""}`.trim())
        .join("; ");
      evidence.gate = {
        completed: result.completed.length,
        inReview: result.inReview.length,
        retried: result.retried.length,
        verdicts,
      };
      // Spec, phase 1: "plans and completes ... via PRs". A task the critic sent back
      // (`retried`) is not completed: the known tier 1 escalate-at-confidence-0.5 defect
      // (gates.md, phase 3 row) fails this case and no other.
      expect(
        result.completed.length + result.inReview.length,
        `tasks completed or in review (${verdicts})`,
      ).toBe(3);
      expect(result.retried, `tasks sent back by the critic (${verdicts})`).toEqual([]);
    },
  );

  live("text chat on Haiku answers with a measured first token", async () => {
    const projects = await h.app.store.project.list({}, { limit: 1 });
    const mark = h.provider.calls.length;
    const conversation = h.app.conversation;
    expect(conversation).not.toBeNull();
    if (!conversation) return;
    const reply = await conversation.chat({
      humanId: h.app.human.id,
      agentId: h.app.agent.id,
      ...(projects[0] ? { projectId: projects[0].id } : {}),
      text: "In one sentence: how many tasks are in review on this project?",
    });
    const calls = callsSince(mark);
    evidence.chat = {
      reply: reply.reply,
      ttftMs: reply.ttftMs,
      costUsd: reply.costUsdMicro / 1e6,
      models: [...new Set(calls.map((c) => c.model))],
      calls: spent(calls),
      callTtftMs: calls.map((c) => c.ttftMs),
    };
    console.log(JSON.stringify(evidence.chat, null, 2));
    expect(reply.reply.trim().length).toBeGreaterThan(0);
    expect(reply.ttftMs).not.toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c.model.startsWith(modelIdFor("haiku", "anthropic")))).toBe(true);
    expect(calls.filter((c) => c.status !== "ok")).toEqual([]);
  });

  live("the kill switch stops a live session within 2 seconds and releases claims", async () => {
    const project = await h.addProject({
      name: "Live kill",
      goal: "A long generation the kill switch interrupts",
      budgetUsdMicro: 2_000_000,
    });
    const task = await h.addTask(project, {
      title: "Add a word list",
      outcome:
        "src/words.ts exports WORDS, an array of 300 distinct lowercase English words, and isWord(w: string): boolean",
      acceptanceCriteria: [
        "src/words.ts exports WORDS: readonly string[] with 300 distinct lowercase words",
        "src/words.ts exports isWord(w: string): boolean",
      ],
      budgetUsdMicro: 400_000,
      estimateUsdMicro: 400_000,
    });
    const mark = h.provider.calls.length;
    const started = new Promise<void>((resolve) => {
      const listener = (e: { ev?: { type?: string } }) => {
        if (e.ev?.type === "model_call_start") {
          h.app.events.off("run", listener);
          resolve();
        }
      };
      h.app.events.on("run", listener);
    });
    const sessionPromise = h.startSession({ projectId: project, budgetCapUsdMicro: 2_000_000 });
    await Promise.race([started, new Promise((r) => setTimeout(r, 60_000))]);
    // Let the request reach the provider before the stop; whether it is still streaming when
    // the stop lands depends on the model, so what is in flight is read at that moment.
    await new Promise((r) => setTimeout(r, 500));
    const inFlightAtStop = h.budget.snapshot().inFlightUsd > 0;
    const settledBeforeStop = callsSince(mark).length;
    const stopAt = h.app.clock.nowIso();
    const t0 = performance.now();
    const report = await h.app.kill.stop("all", "live kill switch gate");
    const res = await sessionPromise;
    const elapsedMs = Math.round(performance.now() - t0);
    h.app.kill.resume();
    const after = await h.app.store.task.mustGet(task.id);
    const calls = callsSince(mark);
    evidence.kill = {
      elapsedMs,
      report,
      sessionStatus: res.status,
      stopReason: res.stopReason,
      taskStatus: after.status,
      claimedBy: after.claimed_by,
      inFlightAtStop,
      settledBeforeStop,
      calls: calls.map((c) => ({
        at: c.at,
        status: c.status,
        usd: c.usd,
        durationMs: c.durationMs,
        note: c.reason,
      })),
    };
    console.log(JSON.stringify(evidence.kill, null, 2));
    expect(elapsedMs).toBeLessThan(2_000);
    expect(report.stoppedRuns).toBeGreaterThanOrEqual(1);
    expect(res.status).toBe("killed");
    expect(after.claimed_by).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // A call in flight at the stop is aborted and settled; no call starts after the stop.
    if (inFlightAtStop) expect(calls.some((c) => c.status === "aborted")).toBe(true);
    expect(calls.filter((c) => c.at > stopAt)).toEqual([]);
    expect(calls.filter((c) => c.status !== "ok" && c.status !== "aborted")).toEqual([]);
    expect(h.provider).toBeInstanceOf(MeteredProvider);
    expect(h.budget.snapshot().inFlightUsd).toBe(0);
    expect(h.budget.snapshot().runUsd).toBeLessThanOrEqual(h.budget.config.runCapUsd);
    console.log(`phase 1 live: ${usd(h.budget.snapshot().runUsd)} this run so far`);
  });
});
