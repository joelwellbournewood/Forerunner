import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { closingReply, specialistReportTurn, specialistTurn, submitReview } from "@forerunner/e2e";
import { type EvalTask, loadEvalSet, runCheck, writeFiles } from "@forerunner/evals";
import { join, SimulatedClock } from "@forerunner/platform";
import { MODE_DEFAULTS, modelIdFor, type RunEvent } from "@forerunner/runtime";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine } from "../src/budget.ts";
import { DRY_RUN_PRICING, dryRunCredentials } from "../src/dry-run.ts";
import { estimateSpend, preflight } from "../src/estimate.ts";
import {
  composeLive,
  DEFAULT_REPO_FILES,
  type LiveHarness,
  removeTreeOrWarn,
  repositoryRegistryDir,
} from "../src/harness.ts";
import type { LiveCall } from "../src/metered.ts";
import { LIVE_CODER_OVERRIDES, LIVE_RESEARCHER_OVERRIDES } from "../src/registry.ts";
import { liveEnabled, reportDir, SKIP_REASON, usd, writeReport } from "../src/report.ts";

/**
 * D.13 on the live model (spec: "Research specialist: default Sonnet 5.5 or Opus 5.5, effort
 * high, time set by task budget and timeout"): one researcher task through the real runtime,
 * composed as the phase 1 half composes it (`composeLive`: the PR executor, the hooks, the
 * tier 1 critic, the fake git host), on the researcher's default tier and effort from the
 * registry. The task is `researcher-001` of the registry's researcher eval set (the set the
 * phase 3 full calibration reviews): one local fixture file seeded into the sample repository,
 * so the run needs no web access (the registry copy gives the researcher the three built-in
 * file tools, `LIVE_RESEARCHER_OVERRIDES`). Measured: the researcher run's wall time and first
 * token (its Run row), its model calls, tokens and USD, and the whole session around it (the
 * tier 1 review included). Asserted: the run completed on the registry default within the
 * task budget and the specialist's timeout, and left `answer.md` on its PR branch. The eval's
 * mechanical checks on that answer are recorded, not asserted (answer quality is the critic
 * calibration's gate, not D.13's).
 *
 * The dry run of the same code path (scripted provider, fake credentials, a temp ledger) runs
 * in every mode; the live case is `it.skipIf`'d without `FORERUNNER_LIVE=1`.
 */
const LIVE = liveEnabled();
const live = it.skipIf(!LIVE);
const TASK_ID = "researcher-001";
/** The session's hard cap: the task budget plus a tier 1 review and the session's other calls. */
const SESSION_CAP_USD_MICRO = 1_000_000;

function researcherTask(): EvalTask {
  const set = loadEvalSet(join(repositoryRegistryDir(), "evals", "researcher"));
  const task = set.find((t) => t.id === TASK_ID);
  if (!task) throw new Error(`${TASK_ID} not found in the researcher eval set`);
  return task;
}

export interface ResearcherEvidence {
  taskId: string;
  sessionId: string;
  sessionStatus: string;
  taskStatus: string;
  researcher: {
    runId: string;
    runs: number;
    model: string;
    effort: string;
    registryTier: string;
    registryEffort: string;
    outcome: string;
    timedOut: boolean;
    wallMs: number;
    ttftMs: number | null;
    modelCalls: number;
    callTtftMs: number[];
    /** The effort each of the run's own metered calls was sent with. */
    callEfforts: (string | null)[];
    /** The run's own metered calls that did not end ok (the tier 1 review's are not counted). */
    notOk: number;
    tokensIn: number;
    tokensOut: number;
    usd: number;
    taskBudgetUsd: number;
    timeoutMs: number;
  };
  session: {
    wallMs: number;
    calls: number;
    usd: number;
    tokensIn: number;
    tokensOut: number;
    capUsd: number;
    notOk: number;
  };
  review: { verdict: string | null; grade: number | null };
  answer: {
    present: boolean;
    chars: number;
    branch: string | null;
    checks: { label: string; status: string }[];
  };
}

const spent = (calls: readonly LiveCall[]) => ({
  calls: calls.length,
  usd: Math.round(calls.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6,
  tokensIn: calls.reduce((s, c) => s + c.tokensIn + c.cacheRead + c.cacheWrite, 0),
  tokensOut: calls.reduce((s, c) => s + c.tokensOut, 0),
});

const outcomeOf = (task: EvalTask): string =>
  `${task.brief.goal} Sources: ${(task.brief.contextLinks ?? []).join(", ")}. ` +
  `Constraints: ${(task.brief.constraints ?? []).join("; ")}.`;

/** The repository the researcher works in: the sample library plus the task's fixture files. */
const repoFilesFor = (task: EvalTask): Record<string, string> => ({
  "README.md": DEFAULT_REPO_FILES["README.md"] as string,
  ...task.setup.files,
});

/** One researcher session on the task; everything measured, nothing asserted. */
async function researcherSession(h: LiveHarness, task: EvalTask): Promise<ResearcherEvidence> {
  const project = await h.addProject({
    name: "Live research",
    goal: "Answer questions from the documents in the repository, with a source for every claim",
    budgetUsdMicro: SESSION_CAP_USD_MICRO,
  });
  const budget = task.brief.budgetUsdMicro;
  const row = await h.addTask(project, {
    title: task.title,
    outcome: outcomeOf(task),
    acceptanceCriteria: task.brief.acceptanceCriteria,
    budgetUsdMicro: budget,
    estimateUsdMicro: budget,
    riskTier: task.brief.riskTier,
    specialist: "researcher",
  });
  // The executor's run events for this task, grouped by run (a run_start opens a group).
  // The metered calls of the first run are the ones settled between its run_start and its
  // run_end: the executor runs one task at a time, and the tier 1 review comes after run_end.
  const byRun = new Map<string, RunEvent[]>();
  const callWindow = new Map<string, { from: number; to: number | null }>();
  let current: string | null = null;
  const onRun = (e: { taskId?: string; ev?: RunEvent }) => {
    if (e.taskId !== row.id || !e.ev) return;
    if (e.ev.type === "run_start") {
      current = e.ev.runId;
      byRun.set(current, []);
      callWindow.set(current, { from: h.provider.calls.length, to: null });
    }
    if (current) byRun.get(current)?.push(e.ev);
    if (e.ev.type === "run_end" && current) {
      const w = callWindow.get(current);
      if (w) w.to = h.provider.calls.length;
    }
  };
  h.app.events.on("run", onRun);
  const mark = h.provider.calls.length;
  const t0 = performance.now();
  let res: Awaited<ReturnType<LiveHarness["startSession"]>>;
  try {
    res = await h.startSession({ projectId: project, budgetCapUsdMicro: SESSION_CAP_USD_MICRO });
  } finally {
    h.app.events.off("run", onRun);
  }
  const sessionWallMs = Math.round(performance.now() - t0);
  const calls = h.provider.calls.slice(mark);
  const runs = (await h.app.store.run.forSession(res.sessionId)).filter(
    (r) => r.specialist === "researcher",
  );
  const first = runs[0];
  if (!first) throw new Error("the session started no researcher run");
  const ends = (byRun.get(first.id) ?? []).filter(
    (e): e is Extract<RunEvent, { type: "model_call_end" }> => e.type === "model_call_end",
  );
  const window = callWindow.get(first.id);
  const own = window && window.to !== null ? h.provider.calls.slice(window.from, window.to) : [];
  const def = h.app.registry.specialists.get("researcher");
  const after = await h.app.store.task.mustGet(row.id);
  const review = res.reviews.find((r) => r.taskId === row.id) ?? null;

  // The answer the run left on its PR branch, and the eval's mechanical checks over it.
  const prs = await h.app.gitHost.listPullRequests(
    { owner: h.repo.owner, name: h.repo.name },
    { state: "all" },
  );
  const branch = prs.find((p) => p.head.ref.startsWith("fr/"))?.head.ref ?? null;
  const file = branch
    ? await h.app.gitHost.getFile({ owner: h.repo.owner, name: h.repo.name }, "answer.md", branch)
    : null;
  const checks: { label: string; status: string }[] = [];
  if (file) {
    const dir = mkdtempSync(join(tmpdir(), "fr-live-research-"));
    try {
      writeFiles(dir, { ...task.setup.files, "answer.md": file.content });
      for (const c of task.checks) {
        if (c.kind === "rubric" || c.kind === "command_exit0") continue;
        const r = await runCheck(c, { outputDir: dir, finalText: "" });
        checks.push({ label: r.label, status: r.status });
      }
    } finally {
      removeTreeOrWarn(dir);
    }
  }
  const s = spent(calls);
  return {
    taskId: task.id,
    sessionId: res.sessionId,
    sessionStatus: res.status,
    taskStatus: after.status,
    researcher: {
      runId: first.id,
      runs: runs.length,
      model: first.model,
      effort: first.effort,
      registryTier: def?.default_tier ?? "unknown",
      registryEffort: def?.default_effort ?? "unknown",
      outcome: first.outcome,
      timedOut: first.timed_out,
      wallMs: first.duration_ms ?? 0,
      ttftMs: first.ttft_ms,
      modelCalls: ends.length,
      callTtftMs: ends.map((e) => Math.round(e.ttftMs)),
      callEfforts: own.map((c) => c.effort),
      notOk: own.filter((c) => c.status !== "ok").length,
      tokensIn: first.tokens_in + first.cache_read_tokens + first.cache_write_tokens,
      tokensOut: first.tokens_out,
      usd: first.cost_usd_micro / 1e6,
      taskBudgetUsd: budget / 1e6,
      timeoutMs: (def?.timeout_minutes ?? 0) * 60_000,
    },
    session: {
      wallMs: sessionWallMs,
      calls: s.calls,
      usd: s.usd,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      capUsd: SESSION_CAP_USD_MICRO / 1e6,
      notOk: calls.filter((c) => c.status !== "ok").length,
    },
    review: { verdict: review?.verdict ?? null, grade: review?.grade ?? null },
    answer: { present: !!file, chars: file?.content.length ?? 0, branch, checks },
  };
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

/** The line for gates.md's D.13 row. */
export function researcherSummaryLine(e: ResearcherEvidence, run: string): string {
  const r = e.researcher;
  const passed = e.answer.checks.filter((c) => c.status === "pass").length;
  return (
    `D.13 researcher (${r.model}, effort ${r.effort}; ${e.taskId}): run ${(r.wallMs / 1000).toFixed(1)} s, ` +
    `first token ${r.ttftMs === null ? "n/a" : `${r.ttftMs} ms`}, ${r.modelCalls} model calls, ` +
    `${r.tokensIn} in, ${r.tokensOut} out tokens, ${usd(r.usd)} ` +
    `(task budget ${usd(r.taskBudgetUsd)}, timeout ${minutes(r.timeoutMs)} min, ${r.outcome}); ` +
    `session with the tier 1 review ${(e.session.wallMs / 1000).toFixed(1)} s, ${usd(e.session.usd)}, ` +
    `review ${e.review.verdict ?? "none"} ${e.review.grade ?? ""}`.trimEnd() +
    `; answer.md ${e.answer.present ? `${e.answer.chars} chars, mechanical checks ${passed}/${e.answer.checks.length}` : "missing"}; run ${run}`
  );
}

/** What D.13 and the harness's caps say must hold; the same for the dry run and the live run. */
function assertResearcher(h: LiveHarness, e: ResearcherEvidence): void {
  const r = e.researcher;
  const ladder = h.app.modelConfig().ladder;
  // The registry default (spec D.13: Sonnet 5.5 or Opus 5.5, effort high), as the run used it.
  expect(["sonnet", "opus"]).toContain(r.registryTier);
  expect(r.registryTier).toBe(MODE_DEFAULTS.researcher.tier);
  expect(r.registryEffort).toBe(MODE_DEFAULTS.researcher.effort);
  expect(r.model).toBe(modelIdFor(r.registryTier as "sonnet" | "opus", h.provider.name, ladder));
  expect(r.effort).toBe(r.registryEffort);
  // ... and as sent: every one of the run's own requests went out at that effort.
  expect(r.callEfforts).toHaveLength(r.modelCalls);
  expect(r.callEfforts.every((x) => x === r.registryEffort)).toBe(true);
  // Completed inside the time and the money the task was given.
  expect(e.sessionStatus).toBe("completed");
  expect(r.outcome).toBe("completed");
  expect(r.timedOut).toBe(false);
  expect(r.timeoutMs).toBe(LIVE_RESEARCHER_OVERRIDES.timeoutMinutes * 60_000);
  expect(r.wallMs).toBeLessThanOrEqual(r.timeoutMs);
  expect(r.modelCalls).toBeGreaterThanOrEqual(1);
  expect(r.usd).toBeGreaterThan(0);
  expect(r.usd).toBeLessThanOrEqual(r.taskBudgetUsd);
  expect(e.session.usd).toBeLessThanOrEqual(e.session.capUsd);
  // The researcher's own calls all ended ok; the session's totals (the tier 1 review included)
  // are reported, not asserted call by call, so a review hiccup does not fail D.13.
  expect(r.notOk).toBe(0);
  expect(h.budget.refusals).toEqual([]);
  expect(h.budget.snapshot().runUsd).toBeLessThanOrEqual(h.budget.config.runCapUsd);
  // A result: the answer file on the run's PR branch.
  expect(e.answer.branch).not.toBeNull();
  expect(e.answer.present).toBe(true);
  expect(e.answer.chars).toBeGreaterThan(0);
}

const SPECIALISTS = { coder: LIVE_CODER_OVERRIDES, researcher: LIVE_RESEARCHER_OVERRIDES };

describe("D.13 researcher, dry run (scripted provider, no network)", () => {
  let h: LiveHarness;
  let ledgerDir = "";
  const task = researcherTask();
  const clock = new SimulatedClock("2026-10-25T09:00:00Z");

  beforeAll(async () => {
    ledgerDir = mkdtempSync(join(tmpdir(), "fr-live-dry-research-"));
    const answer = task.expected_files?.["answer.md"] ?? "";
    h = await composeLive({
      env: { FORERUNNER_LIVE_RUN: "dry-run-research" },
      clock,
      inner: new FakeProvider({
        mode: "script",
        clock,
        latency: "none",
        onNoMatch: "throw",
        replies: [
          toolReply("write_file", { path: "answer.md", content: answer }, "Writing the answer.", {
            when: specialistTurn,
            times: Number.POSITIVE_INFINITY,
            usage: { input_tokens: 2500, output_tokens: 400 },
          }),
          textReply("Summary: answer.md written from docs/status-q2.md. Criteria: met.", {
            when: specialistReportTurn,
            times: Number.POSITIVE_INFINITY,
            usage: { input_tokens: 2900, output_tokens: 60 },
          }),
          submitReview({}, { times: Number.POSITIVE_INFINITY }),
          closingReply(),
        ],
      }),
      credentials: dryRunCredentials(),
      ledgerPath: join(ledgerDir, "spend.json"),
      config: { capUsd: 100, runCapUsd: 15, warnShare: 0.8 },
      pricing: DRY_RUN_PRICING,
      onWarn: () => undefined,
      specialists: SPECIALISTS,
      repoFiles: repoFilesFor(task),
    });
  });
  afterAll(async () => {
    await h?.close();
    if (ledgerDir) removeTreeOrWarn(ledgerDir);
  });

  it("the preflight refuses a file whose ceiling exceeds what is left, and passes one that fits", () => {
    const fits = estimateSpend("researcher", [], SESSION_CAP_USD_MICRO / 1e6, DRY_RUN_PRICING);
    expect(preflight(h.budget, fits).line).toContain("ceiling USD 1.0000");
    const over = estimateSpend("researcher", [], 15.5, DRY_RUN_PRICING);
    expect(() => preflight(h.budget, over)).toThrow(/refused to start/);
    expect(h.budget.refusals).toEqual([]);
  });

  it("one researcher session on the registry default, measured and asserted like the live run", async () => {
    const e = await researcherSession(h, task);
    console.log(researcherSummaryLine(e, h.run));
    assertResearcher(h, e);
    expect(e.researcher.model).toBe("fake-sonnet");
    expect(e.researcher.effort).toBe("high");
    // The run's own calls only: the tier 1 review's calls are in the session, not in the run.
    expect(e.researcher.callEfforts).toEqual(["high", "high"]);
    expect(e.session.calls).toBeGreaterThan(e.researcher.callEfforts.length);
    expect(e.answer.checks.every((c) => c.status === "pass")).toBe(true);
  });
});

describe(`D.13 researcher, live${LIVE ? "" : ` (${SKIP_REASON})`}`, () => {
  let h: LiveHarness;
  let dir = "";
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    if (!LIVE) return;
    dir = reportDir();
    const task = researcherTask();
    h = await composeLive({ specialists: SPECIALISTS, repoFiles: repoFilesFor(task) });
    const sonnet = modelIdFor(MODE_DEFAULTS.researcher.tier, "anthropic");
    const t1 = modelIdFor(MODE_DEFAULTS.critic_t1.tier, "anthropic");
    const pm = modelIdFor(MODE_DEFAULTS.planning.tier, "anthropic");
    // Expected: the session's planning call (Sonnet at high; this build's code planner may make
    // none, the estimate counts one), a handful of researcher turns on a one-file question and a
    // two-call tier 1 review; the ceiling is the session cap the hooks enforce on all of it.
    const estimate = estimateSpend(
      "live-6-researcher",
      [
        { label: "PM planning", model: pm, calls: 1, inputTokens: 4_000, outputTokens: 2_000 },
        { label: "researcher", model: sonnet, calls: 6, inputTokens: 6_000, outputTokens: 2_000 },
        { label: "tier 1 review", model: t1, calls: 2, inputTokens: 7_000, outputTokens: 1_500 },
      ],
      SESSION_CAP_USD_MICRO / 1e6,
    );
    evidence.estimate = estimate;
    try {
      const pf = preflight(h.budget, estimate);
      console.log(`live run ${h.run}; reports in ${dir}; ${pf.line}`);
    } catch (e) {
      console.log(`live run ${h.run}: ${(e as Error).message}`);
      throw e;
    }
    console.log(budgetLine(h.budget));
  });
  afterAll(async () => {
    if (!h) return;
    const file = writeReport(dir, "researcher-live", {
      run: h.run,
      date: h.app.clock.nowIso(),
      ...evidence,
      budget: h.budget.snapshot(),
      totals: h.provider.totals(),
      calls: h.provider.calls,
    });
    console.log(`researcher live report: ${file}\n${budgetLine(h.budget)}`);
    await h.close();
  });

  live(
    `one ${TASK_ID} session on the researcher's registry default, within the task budget and timeout`,
    async () => {
      const e = await researcherSession(h, researcherTask());
      evidence.researcher = e;
      const line = researcherSummaryLine(e, h.run);
      evidence.summaryLine = line;
      console.log(JSON.stringify(e, null, 2));
      console.log(line);
      assertResearcher(h, e);
      expect(e.researcher.model).toBe(modelIdFor(MODE_DEFAULTS.researcher.tier, "anthropic"));
      expect(e.researcher.ttftMs).not.toBeNull();
    },
  );
});
