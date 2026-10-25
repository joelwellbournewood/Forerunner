import { readFileSync } from "node:fs";
import { Logger, type LogRecord } from "@forerunner/platform";
import {
  BILLING_PICK_AUDIT_TOOL,
  type ModelTier,
  modelIdFor,
  SDK_RUN_PROVIDER,
  SECRET_NAMES,
  type SessionResult,
  TOOL_UNMAPPED_AUDIT,
} from "@forerunner/runtime";
import type { AuditLogRow } from "@forerunner/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine } from "../src/budget.ts";
import { describeCredentials, loadBuildEnv, redactCredentials } from "../src/env.ts";
import {
  composeLive,
  type LiveHarness,
  SUBSCRIPTION_RUN_AUDIT_TOOL,
  sdkCostUsdOf,
} from "../src/harness.ts";
import { microFromUsd, type SpendRow, subscriptionRows } from "../src/ledger.ts";
import type { LiveCall } from "../src/metered.ts";
import { LIVE_SDK_CODER_OVERRIDES } from "../src/registry.ts";
import {
  comparePhase1,
  liveEnabled,
  readPhase1Evidence,
  reportDir,
  SKIP_REASON,
  usd,
  writeReport,
} from "../src/report.ts";
import {
  PHASE1_KILL_TASK,
  PHASE1_SESSION_CAP_USD_MICRO,
  PHASE1_TASK_CAP_USD_MICRO,
  PHASE1_TASKS,
} from "../src/tasks.ts";

/**
 * Phase 1 gate, the live half on the subscription (spec, Build order: "The same session runs
 * once on a subscription and once on an API key with correct usage recorded"; ADR 0044). The
 * real runtime composed exactly as the API-key half, with BOTH credentials in the vault: the
 * router picks the subscription for the human's own agent on the personal runner, so every
 * coder task runs through the Agent SDK driver (a real Claude Code subprocess with the
 * `claude setup-token` value in its environment, by reference from the vault), the critic
 * stays on the Messages provider and the API key, and the same three tasks are seeded. What
 * is asserted: every coder Run row cites the subscription source and the SDK provider; the
 * store's rows for those runs are kind "subscription" with the plan share; the hooks applied
 * (`cc:Bash` withheld and audited, every tool call through PreToolUse/PostToolUse, paths inside
 * the worktree); the kill switch stops an SDK run within 2 s; the spend ledger's API-key rows
 * are untouched and the subscription runs land as USD 0 rows with the note; the tasks end as
 * they did on the API key (compared with that half's evidence file when it is there). The
 * token never appears in a log, a report, the ledger, the audit log or a Run row.
 */
const LIVE = liveEnabled();
const CREDENTIALS = LIVE ? loadBuildEnv() : null;
const HAS_TOKEN = !!CREDENTIALS?.subscriptionToken;
const SKIP = !LIVE
  ? SKIP_REASON
  : !HAS_TOKEN
    ? "skipped: no FORERUNNER_SUBSCRIPTION_TOKEN in the environment or .env.build (the subscription half needs a `claude setup-token` value)"
    : null;
const live = it.skipIf(SKIP !== null);
const OAT_PREFIX = ["sk-", "ant-", "oat"].join(""); // not-a-secret

interface TaskEvidence {
  title: string;
  outcome: string;
  verdict: string | null;
  grade: number | null;
  runs: {
    specialist: string;
    model: string;
    provider: string;
    billingKind: string;
    costUsd: number;
    sdkCostUsd: number | null;
    durationMs: number;
    outcome: string;
    sdkSessionId: string | null;
  }[];
  /** The coder runs' API-equivalent cost from the Run rows: what the task cap bounds. */
  coderUsd: number;
  /** The coder runs' SDK-reported list-price figure. */
  coderSdkUsd: number;
  ledger: {
    subscription: {
      entries: number;
      tokensIn: number;
      tokensOut: number;
      planShare: number | null;
    };
    api: { entries: number; usd: number };
  };
  pr: string | null;
}

describe(`phase 1 gate, live half on the subscription${SKIP ? ` (${SKIP})` : ""}`, () => {
  let h: LiveHarness;
  let dir = "";
  const evidence: Record<string, unknown> = {};
  const logs: LogRecord[] = [];
  let offLogs: () => void = () => undefined;
  let ledgerBefore: SpendRow[] = [];
  // The budget's `runUsd` covers the whole vitest run (every live file shares one run id and
  // one per-run cap), so this file's own spend is measured from where the run stood when the
  // file started; 0 when the file runs alone.
  let runMicroAtStart = 0;
  let session: { result: SessionResult; tasks: TaskEvidence[] } | null = null;
  const callsSince = (mark: number): LiveCall[] => h.provider.calls.slice(mark);
  const spent = (calls: LiveCall[]) => ({
    calls: calls.length,
    usd: Math.round(calls.reduce((s, c) => s + c.usd, 0) * 1e6) / 1e6,
    tokensIn: calls.reduce((s, c) => s + c.tokensIn + c.cacheRead + c.cacheWrite, 0),
    tokensOut: calls.reduce((s, c) => s + c.tokensOut, 0),
  });
  const sources = async () => {
    const all = await h.app.billing.sources();
    const sub = all.find((s) => s.kind === "subscription");
    const key = all.find((s) => s.kind === "api_key");
    if (!sub || !key) throw new Error("both billing sources must exist");
    return { all, sub, key };
  };
  const report = () => ({
    run: h.run,
    date: h.app.clock.nowIso(),
    credentials: describeCredentials(h.credentials),
    coderTools: LIVE_SDK_CODER_OVERRIDES.tools,
    ...evidence,
    budget: h.budget.snapshot(),
    totals: h.provider.totals(),
    calls: h.provider.calls,
    subscriptionRows: subscriptionRows(h.ledger.forRun(h.run)),
  });

  beforeAll(async () => {
    if (SKIP) return;
    dir = reportDir();
    offLogs = Logger.addSink((r) => logs.push(r));
    h = await composeLive({ subscription: true });
    ledgerBefore = h.ledger.rows();
    runMicroAtStart = microFromUsd(h.budget.snapshot().runUsd);
    // The hosting session's variables (names only) removed before the SDK subprocess runs.
    evidence.hostEnvScrubbed = h.hostEnvScrubbed;
    console.log(
      `live run ${h.run} (${describeCredentials(h.credentials)}); reports in ${dir}; ${budgetLine(h.budget)}`,
    );
  });
  afterAll(async () => {
    offLogs();
    if (!h) return;
    // Belt and braces: the case below asserts the token is nowhere; the report is redacted
    // on its way to disk regardless.
    const text = redactCredentials(JSON.stringify(report(), null, 2), h.credentials);
    const file = writeReport(dir, "phase1-subscription-live", JSON.parse(text));
    console.log(`phase 1 subscription live report: ${file}\n${budgetLine(h.budget)}`);
    await h.close();
  });

  live(
    "both sources exist, the loop paths bill the key, and the router picks the subscription for this agent on the personal runner (no model call)",
    async () => {
      const { all, sub, key } = await sources();
      expect(all.map((s) => s.kind).sort()).toEqual(["api_key", "subscription"]);
      expect(sub.credentialRef).toBe(SECRET_NAMES.anthropicOauth);
      expect(sub.limits.planShareCap).toBe(0.95);
      expect(sub.limits.planUsdMicro).toBe(h.app.billing.planAllowance.usdMicro);
      expect(h.app.billingSourceId).toBe(key.id);
      expect(await h.app.vault.has(SECRET_NAMES.anthropicOauth)).toBe(true);
      expect(h.app.billing.hostCommands).toBe(false);
      expect(h.app.registry.specialists.get("coder")?.allowed_tools).toEqual(
        LIVE_SDK_CODER_OVERRIDES.tools,
      );
      expect(h.grant().allowedTools).toEqual(expect.arrayContaining(["cc:Read", "cc:Write"]));
      const pick = await h.app.billing.pick.pick({
        agentId: h.app.agent.id,
        agentOwnerHumanId: h.app.human.id,
        runner: "pc",
        modelTier: "sonnet",
        purpose: "session",
      });
      evidence.pick = {
        kind: pick.source.kind,
        driver: pick.driver,
        reason: pick.reason,
        plan: pick.plan,
        planAllowance: h.app.billing.planAllowance,
      };
      expect(pick.source.id).toBe(sub.id);
      expect(pick.driver).toBe("sdk");
      const models = await h.provider.listModels();
      const ids = models.map((m) => m.id);
      for (const tier of ["haiku", "sonnet"] as ModelTier[]) {
        const id = modelIdFor(tier, "anthropic", h.app.modelConfig().ladder);
        expect(ids, `${tier} rung ${id} listed by the provider`).toContain(id);
      }
    },
  );

  live(
    "the same session on the subscription: three tasks through the SDK driver, Run rows on the subscription source, subscription ledger rows with plan usage, the key's ledger untouched, the hooks applied",
    async () => {
      const sessionCap = PHASE1_SESSION_CAP_USD_MICRO;
      const taskCap = PHASE1_TASK_CAP_USD_MICRO;
      const { sub, key } = await sources();
      const project = await h.addProject({
        name: "Live sample (subscription)",
        goal: "A tiny TypeScript library grown by small, reviewed changes",
        budgetUsdMicro: 5_000_000,
      });
      const tasks = [];
      for (const [i, s] of PHASE1_TASKS.entries()) {
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
      const runEvents: { at: number; taskId: string; type: string }[] = [];
      const onRun = (e: { taskId?: string; ev?: { type?: string } }) => {
        runEvents.push({
          at: performance.now() - t0,
          taskId: String(e.taskId ?? ""),
          type: String(e.ev?.type ?? ""),
        });
      };
      h.app.events.on("run", onRun);
      const mark = h.provider.calls.length;
      const t0 = performance.now();
      let res: SessionResult;
      try {
        res = await h.startSession({
          projectId: project,
          budgetCapUsdMicro: sessionCap,
          onEvent: (type, payload) => events.push({ at: performance.now() - t0, type, payload }),
        });
      } finally {
        h.app.events.off("run", onRun);
      }
      const durationMs = Math.round(performance.now() - t0);
      const calls = callsSince(mark);
      // The SDK runs never passed the metered gate (the subprocess calls the provider itself):
      // settle them into the spend ledger now, as USD 0 rows with the SDK's figure in the note.
      const settled = await h.settleSubscriptionRuns(res.sessionId);
      const prs = await h.app.gitHost.listPullRequests(
        { owner: h.repo.owner, name: h.repo.name },
        { state: "all" },
      );
      const runs = await h.app.store.run.forSession(res.sessionId);
      const audit = await h.app.store.auditLog.list(undefined, { limit: 10_000 });
      const sessionAudit = audit.filter((a) => a.session_id === res.sessionId);
      const reviews = res.reviews;
      const perTask: TaskEvidence[] = [];
      for (const t of tasks) {
        const after = await h.app.store.task.mustGet(t.id);
        const review = reviews.find((r) => r.taskId === t.id) ?? null;
        const taskRuns = runs.filter((r) => r.task_id === t.id);
        const subSum = await h.app.store.costLedger.sum({ taskId: t.id, kind: "subscription" });
        const apiSum = await h.app.store.costLedger.sum({ taskId: t.id, kind: "api" });
        const coderRuns = taskRuns.filter((r) => r.specialist === "coder");
        perTask.push({
          title: t.title,
          outcome: after.status,
          verdict: review?.verdict ?? null,
          grade: review?.grade ?? null,
          runs: taskRuns.map((r) => ({
            specialist: r.specialist,
            model: r.model,
            provider: r.provider,
            billingKind: r.billing_source_id === sub.id ? "subscription" : "api_key",
            costUsd: r.cost_usd_micro / 1e6,
            sdkCostUsd: sdkCostUsdOf(r),
            durationMs: r.duration_ms ?? 0,
            outcome: r.outcome,
            sdkSessionId: sdkSessionIdOf(r),
          })),
          coderUsd: coderRuns.reduce((sum, r) => sum + r.cost_usd_micro, 0) / 1e6,
          coderSdkUsd: coderRuns.reduce((sum, r) => sum + (sdkCostUsdOf(r) ?? 0), 0),
          ledger: {
            subscription: {
              entries: subSum.entries,
              tokensIn: subSum.tokens_in + subSum.cache_read_tokens + subSum.cache_write_tokens,
              tokensOut: subSum.tokens_out,
              planShare: subSum.plan_usage_share,
            },
            api: { entries: apiSum.entries, usd: apiSum.usd_micro / 1e6 },
          },
          pr: after.pr_url,
        });
      }
      const planned = events.find((e) => e.type === "session.planned");
      const starts = events.filter((e) => e.type === "task.started");
      const taskWall = starts.map((e, i) => ({
        taskId: String(e.payload.taskId),
        title: String(e.payload.title),
        wallMs: Math.round((starts[i + 1]?.at ?? durationMs) - e.at),
      }));
      const subSum = await h.app.store.costLedger.sum({
        sessionId: res.sessionId,
        kind: "subscription",
      });
      const keySum = await h.app.store.costLedger.sum({ billingSourceId: key.id });
      const keySubRows = await h.app.store.costLedger.sum({
        billingSourceId: key.id,
        kind: "subscription",
      });
      const sessionApi = await h.app.store.costLedger.sum({
        sessionId: res.sessionId,
        kind: "api",
      });
      const coderRuns = runs.filter((r) => r.specialist === "coder");
      const picks = sessionAudit.filter((a) => a.tool === BILLING_PICK_AUDIT_TOOL);
      const withheld = sessionAudit.filter((a) => a.tool === TOOL_UNMAPPED_AUDIT);
      const ccRows = sessionAudit.filter((a) => a.tool.startsWith("cc:"));
      const ccDenied = ccRows.filter((a) => !a.allowed);
      const outsidePaths = ccRows
        .filter((a) => a.allowed)
        .map((a) => pathOf(a))
        .filter((p): p is string => p !== null && !p.startsWith(h.app.dirs.worktrees));
      // The API-key half's evidence file of this run, when it is there: the same tasks must
      // end the same way (completed or in review) on the subscription. A file from another
      // run is listed and flagged, never compared as if it were this run's.
      const comparison = comparePhase1(readPhase1Evidence(dir), h.run, perTask, dir);
      if (comparison.stale) console.warn(`phase 1 comparison not made: ${comparison.reason}`);
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
        spentUsdMicro: res.spentUsdMicro,
        sessionCapUsd: sessionCap / 1e6,
        taskCapUsd: taskCap / 1e6,
        pullRequests: prs.map((p) => ({ number: p.number, head: p.head.ref, title: p.title })),
        subscriptionUsage: {
          runs: coderRuns.length,
          tokensIn: subSum.tokens_in + subSum.cache_read_tokens + subSum.cache_write_tokens,
          tokensOut: subSum.tokens_out,
          hooksEstimateUsd: subSum.usd_micro / 1e6,
          sdkEstimateUsd: coderRuns.reduce((s, r) => s + (sdkCostUsdOf(r) ?? 0), 0),
          planShareAfter: subSum.plan_usage_share,
          planAllowanceUsd: h.app.billing.planAllowance.usdMonthly,
          ledgerEntries: subSum.entries,
        },
        apiKeyUsage: {
          storeLedger: { entries: sessionApi.entries, usd: sessionApi.usd_micro / 1e6 },
          spendLedger: spent(calls),
        },
        keySourceLedger: { entries: keySum.entries, subscriptionRows: keySubRows.entries },
        settledSpendRows: settled,
        runs: runs.map((r) => ({
          specialist: r.specialist,
          model: r.model,
          provider: r.provider,
          billingKind: r.billing_source_id === sub.id ? "subscription" : "api_key",
          outcome: r.outcome,
          costUsd: r.cost_usd_micro / 1e6,
          sdkCostUsd: sdkCostUsdOf(r),
          durationMs: r.duration_ms,
          ttftMs: r.ttft_ms,
        })),
        tasks: perTask,
        taskWall,
        hooks: {
          picks: picks.map((a) => ({ input: a.input_summary, reason: a.result_summary })),
          withheld: withheld.map((a) => `${a.input_summary}: ${a.denied_reason}`),
          ccToolCalls: ccRows.length,
          ccAllowed: ccRows.length - ccDenied.length,
          ccDenied: ccDenied.map((a) => `${a.tool}: ${a.denied_reason}`),
          outsidePaths,
          runEvents: countBy(runEvents.map((e) => e.type)),
        },
        auditDenied: sessionAudit
          .filter((a) => !a.allowed)
          .map((a) => `${a.tool}: ${a.denied_reason}`),
        comparison,
        summary: res.summary,
      };
      console.log(JSON.stringify(evidence.session, null, 2));
      session = { result: res, tasks: perTask };

      // The session ran to its end; every task was worked and opened a PR; nothing failed.
      expect(res.status).toBe("completed");
      expect(res.failed).toEqual([]);
      expect(res.needsHuman).toEqual([]);
      expect(
        res.completed.length + res.inReview.length + res.retried.length,
        "every task was worked",
      ).toBe(3);
      expect(prs.filter((p) => p.head.ref.startsWith("fr/"))).toHaveLength(3);
      expect(runs.filter((r) => r.outcome === "budget_exceeded")).toEqual([]);

      // Every task ran through the SDK driver on the subscription: the Run rows cite the
      // subscription source and the SDK provider, carry the SDK session id, Sonnet.
      expect(coderRuns).toHaveLength(3);
      for (const r of coderRuns) {
        expect(r.provider, `${r.id}: SDK provider`).toBe(SDK_RUN_PROVIDER);
        expect(r.billing_source_id, `${r.id}: subscription source`).toBe(sub.id);
        expect(r.model).toBe(modelIdFor("sonnet", "anthropic"));
        expect(r.outcome, `${r.id}: the coder run completed`).toBe("completed");
        expect(sdkSessionIdOf(r), `${r.id}: SDK session id recorded`).not.toBeNull();
        expect(r.tokens_in + r.tokens_out, `${r.id}: usage recorded`).toBeGreaterThan(0);
        expect(r.cost_usd_micro, `${r.id}: API-equivalent estimate recorded`).toBeGreaterThan(0);
        expect(r.cost_usd_micro, `${r.id}: coder spend under the task cap`).toBeLessThanOrEqual(
          taskCap,
        );
        // The ledger rows of the run: kind "subscription", on the subscription source, with
        // the plan share, and the same tokens as the Run row.
        const rows = await h.app.store.costLedger.list({ run_id: r.id }, { limit: 1000 });
        expect(rows.length, `${r.id}: ledger rows`).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.kind).toBe("subscription");
          expect(row.billing_source_id).toBe(sub.id);
          expect(row.plan_usage_share).not.toBeNull();
          expect(row.plan_usage_share ?? 0).toBeGreaterThan(0);
          expect(row.plan_usage_share ?? 2).toBeLessThanOrEqual(1);
        }
        expect(rows.reduce((s, row) => s + row.usd_micro, 0)).toBe(r.cost_usd_micro);
        expect(
          rows.reduce(
            (s, row) => s + row.tokens_in + row.cache_read_tokens + row.cache_write_tokens,
            0,
          ),
        ).toBe(r.tokens_in + r.cache_read_tokens + r.cache_write_tokens);
      }
      // The critic stayed on the Messages provider and the API key.
      for (const r of runs.filter((r) => r.specialist !== "coder")) {
        expect(r.provider).not.toBe(SDK_RUN_PROVIDER);
        expect(r.billing_source_id).toBe(key.id);
      }
      // The pick is audited per coder run; cc:Bash withheld per coder run; the tool calls of
      // the subprocess went through the hooks (PreToolUse allowed/denied, PostToolUse audited)
      // and touched nothing outside the worktrees root.
      expect(picks.length).toBeGreaterThanOrEqual(3);
      for (const p of picks.filter((p) => coderRuns.some((r) => r.id === p.run_id))) {
        expect(JSON.parse(p.input_summary)).toMatchObject({ kind: "subscription", driver: "sdk" });
      }
      expect(withheld.filter((a) => a.input_summary === "coder: cc:Bash")).toHaveLength(3);
      expect(withheld.every((a) => !a.allowed)).toBe(true);
      expect(ccRows.length, "tool calls of the subprocess reached the hooks").toBeGreaterThan(0);
      expect(outsidePaths).toEqual([]);
      expect(
        ccDenied.filter((a) => !/^(path_not_allowed|tool_not_allowed)/.test(a.denied_reason ?? "")),
      ).toEqual([]);

      // Correct usage recorded: the session's subscription rows carry the coder runs' tokens
      // and the plan share moved; the API key's ledger holds only "api" rows (the critic's),
      // none of the subscription run.
      expect(subSum.entries).toBeGreaterThan(0);
      expect(subSum.tokens_in + subSum.cache_read_tokens + subSum.cache_write_tokens).toBe(
        coderRuns.reduce((s, r) => s + r.tokens_in + r.cache_read_tokens + r.cache_write_tokens, 0),
      );
      expect(subSum.tokens_out).toBe(coderRuns.reduce((s, r) => s + r.tokens_out, 0));
      expect(subSum.plan_usage_share ?? 0).toBeGreaterThan(0);
      expect(keySubRows.entries).toBe(0);
      expect(keySum.entries).toBe((await h.app.store.costLedger.sum({ kind: "api" })).entries);
      // The critic's calls on the key went through the metered gate and the spend ledger as in
      // the API-key half; every cap held; nothing was refused.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((c) => c.status !== "ok")).toEqual([]);
      expect(h.budget.refusals).toEqual([]);
      expect(
        sessionApi.tokens_in + sessionApi.cache_read_tokens + sessionApi.cache_write_tokens,
      ).toBe(spent(calls).tokensIn);
      expect(sessionApi.tokens_out).toBe(spent(calls).tokensOut);
      expect(res.spentUsdMicro).toBeLessThanOrEqual(sessionCap);
      expect(h.budget.snapshot().runUsd).toBeLessThanOrEqual(h.budget.config.runCapUsd);

      // The spend ledger: the rows that were there before this session (the API-key half's
      // among them) are unchanged; the subscription runs landed as USD 0 rows with the note;
      // the budget's totals are the metered calls alone (plan usage has no USD price).
      const rowsNow = h.ledger.rows();
      expect(rowsNow.slice(0, ledgerBefore.length)).toEqual(ledgerBefore);
      expect(settled).toHaveLength(3);
      for (const row of settled) {
        expect(row.usd).toBe(0);
        expect(row.kind).toBe("subscription");
        expect(row.run).toBe(h.run);
        expect(row.note).toMatch(/^subscription: plan usage, est\. USD \d+\.\d{4}$/);
      }
      const subAudit = sessionAudit.filter((a) => a.tool === SUBSCRIPTION_RUN_AUDIT_TOOL);
      expect(subAudit).toHaveLength(3);
      // this file's metered calls are exactly what the run's budget grew by while it ran
      expect(microFromUsd(h.budget.snapshot().runUsd) - runMicroAtStart).toBe(
        microFromUsd(spent(callsSince(0)).usd),
      );

      // The comparison with the API-key half of this run, when its evidence is there: every
      // task ended the same way on both billing sources.
      if (comparison.made) {
        for (const c of comparison.tasks) {
          expect(c.same, `${c.title}: same outcome on both billing sources`).toBe(true);
        }
      }
    },
  );

  live(
    "the gate: the session completed all three tasks on the subscription (done or in review; none sent back by the critic)",
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
      expect(
        result.completed.length + result.inReview.length,
        `tasks completed or in review (${verdicts})`,
      ).toBe(3);
      expect(result.retried, `tasks sent back by the critic (${verdicts})`).toEqual([]);
    },
  );

  live(
    "the kill switch stops a subscription session (a live SDK subprocess) within 2 seconds and releases claims",
    async () => {
      const { sub } = await sources();
      const project = await h.addProject({
        name: "Live kill (subscription)",
        goal: "A long generation the kill switch interrupts",
        budgetUsdMicro: 2_000_000,
      });
      const task = await h.addTask(project, {
        ...PHASE1_KILL_TASK,
        budgetUsdMicro: PHASE1_TASK_CAP_USD_MICRO,
        estimateUsdMicro: PHASE1_TASK_CAP_USD_MICRO,
      });
      const mark = h.provider.calls.length;
      const seen: string[] = [];
      // The SDK run is under way once its subprocess streams text or asks for a tool: wait for
      // that (or 90 s), so the stop lands on a live subprocess, not on the runtime's set-up.
      const underWay = new Promise<void>((resolve) => {
        const listener = (e: { ev?: { type?: string } }) => {
          const type = e.ev?.type ?? "";
          seen.push(type);
          if (type === "text_delta" || type === "tool_call" || type === "model_call_end") {
            h.app.events.off("run", listener);
            resolve();
          }
        };
        h.app.events.on("run", listener);
      });
      const sessionPromise = h.startSession({ projectId: project, budgetCapUsdMicro: 2_000_000 });
      await Promise.race([underWay, new Promise((r) => setTimeout(r, 90_000))]);
      const stopAt = h.app.clock.nowIso();
      const t0 = performance.now();
      const report = await h.app.kill.stop("all", "live kill switch gate (subscription)");
      const res = await sessionPromise;
      const elapsedMs = Math.round(performance.now() - t0);
      h.app.kill.resume();
      const after = await h.app.store.task.mustGet(task.id);
      const runs = await h.app.store.run.forSession(res.sessionId);
      const settled = await h.settleSubscriptionRuns(res.sessionId);
      const calls = callsSince(mark);
      evidence.kill = {
        elapsedMs,
        report,
        sessionStatus: res.status,
        stopReason: res.stopReason,
        taskStatus: after.status,
        claimedBy: after.claimed_by,
        runEventsBeforeStop: seen,
        runs: runs.map((r) => ({
          specialist: r.specialist,
          provider: r.provider,
          outcome: r.outcome,
          tokensIn: r.tokens_in,
          tokensOut: r.tokens_out,
          costUsd: r.cost_usd_micro / 1e6,
          sdkCostUsd: sdkCostUsdOf(r),
          durationMs: r.duration_ms,
        })),
        settledSpendRows: settled,
        meteredCallsAfterStop: calls.filter((c) => c.at > stopAt).length,
      };
      console.log(JSON.stringify(evidence.kill, null, 2));
      expect(elapsedMs).toBeLessThan(2_000);
      expect(report.stoppedRuns).toBeGreaterThanOrEqual(1);
      expect(res.status).toBe("killed");
      expect(after.claimed_by).toBeNull();
      const sdkRuns = runs.filter((r) => r.provider === SDK_RUN_PROVIDER);
      expect(sdkRuns.length).toBeGreaterThanOrEqual(1);
      expect(sdkRuns.every((r) => r.billing_source_id === sub.id)).toBe(true);
      expect(sdkRuns.some((r) => r.outcome === "killed")).toBe(true);
      // The killed run is in the spend ledger as plan usage with its outcome in the note; no
      // metered call started after the stop; nothing is left in flight.
      expect(settled.length).toBe(sdkRuns.length);
      expect(settled.every((r) => r.usd === 0 && r.kind === "subscription")).toBe(true);
      expect(settled.some((r) => r.note?.includes("killed"))).toBe(true);
      expect(calls.filter((c) => c.at > stopAt)).toEqual([]);
      expect(h.budget.snapshot().inFlightUsd).toBe(0);
      console.log(
        `phase 1 subscription live: ${usd(h.budget.snapshot().runUsd)} on the key this run so far`,
      );
    },
  );

  live(
    "the subscription token is in the vault and nowhere else: not in the ledger, the logs, the audit log, the Run rows or the evidence",
    async () => {
      const token = h.credentials.subscriptionToken ?? "";
      expect(token.length).toBeGreaterThan(0);
      expect(await h.app.vault.get(SECRET_NAMES.anthropicOauth)).toBe(token);
      const blobs: Record<string, string> = {
        ledger: readFileSync(h.ledger.path, "utf8"),
        logs: JSON.stringify(logs),
        audit: JSON.stringify(await h.app.store.auditLog.list(undefined, { limit: 10_000 })),
        runs: JSON.stringify(await h.app.store.run.list({}, { limit: 10_000 })),
        costLedger: JSON.stringify(await h.app.store.costLedger.list({}, { limit: 10_000 })),
        sources: JSON.stringify(await h.app.billing.sources()),
        calls: JSON.stringify(h.provider.calls),
        evidence: JSON.stringify(evidence),
        credentials: describeCredentials(h.credentials),
      };
      for (const [name, blob] of Object.entries(blobs)) {
        expect(blob.includes(token), `${name} holds the token`).toBe(false);
        expect(blob.includes(OAT_PREFIX), `${name} holds a token prefix`).toBe(false);
        expect(blob.includes(h.credentials.apiKey), `${name} holds the key`).toBe(false);
      }
      evidence.secrets = { checked: Object.keys(blobs), logRecords: logs.length };
    },
  );
});

function sdkSessionIdOf(run: { artifacts: unknown[] }): string | null {
  for (const a of run.artifacts) {
    if (a && typeof a === "object" && (a as { driver?: unknown }).driver === "sdk") {
      const id = (a as { sdk_session_id?: unknown }).sdk_session_id;
      return typeof id === "string" ? id : null;
    }
  }
  return null;
}

/** The `file_path` (or `path`) of a hooks audit row's input summary, when it carries one. */
function pathOf(row: AuditLogRow): string | null {
  const m = /"(?:file_path|notebook_path|path)":"((?:[^"\\]|\\.)*)"/.exec(row.input_summary);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
