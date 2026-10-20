import { type Clock, errorMessage, ForerunnerError, newId } from "@forerunner/platform";
import type { StateStore, TaskRow } from "@forerunner/state";
import type { LoopAgentDriver, RunEvent, RunPricing } from "../agent/loop.ts";
import type { ToolRegistry } from "../agent/tools.ts";
import { type DelegationBrief, renderBrief, validateBrief } from "../brief.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import { effortForTask, modelIdFor, startingTier } from "../models/ladder.ts";
import type { EffortLevel, ModelProvider, ModelTier } from "../provider/types.ts";
import type { PlanItem, TaskExecutionResult, TaskExecutor } from "./runner.ts";

/**
 * Runs one task through a specialist: validates the delegation brief, derives a narrower
 * capability token (depth + 1, the specialist's tools/domains, the task's budget), runs the
 * specialist through the in-process loop driver, records the Run row and returns the outcome.
 * The specialist definition comes from the registry; this executor only needs the fields below.
 */
export interface SpecialistSpec {
  name: string;
  /** Role prompt (system). */
  prompt: string;
  promptVersion: string;
  defaultTier: ModelTier;
  defaultEffort: EffortLevel;
  allowedTools: string[];
  allowedDomains: string[];
  maxBudgetUsdMicro: number;
  maxTurns: number;
  timeoutMs: number;
}

export interface LoopTaskExecutorDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  driver: LoopAgentDriver;
  provider: ModelProvider;
  pricing: RunPricing;
  tools: ToolRegistry;
  billingSourceId: string;
  specialists: (name: string) => SpecialistSpec | undefined;
  /** Model ceiling for the project (spec D). */
  ceiling?: ModelTier;
  effortOffset?: -1 | 0 | 1;
  /** Worktree root for the task, if the executor should pin file access. */
  worktreeFor?: (task: TaskRow) => Promise<string | undefined>;
  onEvent?: (taskId: string, ev: RunEvent) => void;
}

export class LoopTaskExecutor implements TaskExecutor {
  constructor(private readonly deps: LoopTaskExecutorDeps) {}

  async execute(ctx: Parameters<TaskExecutor["execute"]>[0]): Promise<TaskExecutionResult> {
    const { store, clock } = this.deps;
    const { task, session, token, budget, item } = ctx;
    const spec = this.deps.specialists(item.specialist);
    if (!spec)
      throw new ForerunnerError(
        "not_found",
        `specialist ${item.specialist} is not in the registry`,
      );

    const brief: DelegationBrief = validateBrief({
      goal: `${task.title}: ${task.outcome}`,
      contextLinks: [
        `task:${task.id}`,
        ...(task.pr_url ? [task.pr_url] : []),
        ...(task.branch ? [`branch:${task.branch}`] : []),
      ],
      constraints: [
        "Stay inside the worktree and the allowed tools.",
        "Report evidence (commands and output), not claims.",
      ],
      acceptanceCriteria: task.acceptance_criteria.length
        ? task.acceptance_criteria
        : ["The outcome described in the goal is achieved and verified."],
      budgetUsdMicro: Math.max(
        1,
        Math.min(
          item.estimateUsdMicro || task.budget_usd_micro || spec.maxBudgetUsdMicro,
          spec.maxBudgetUsdMicro,
          token.claims.budgetUsdMicro,
          budget.remainingUsdMicro(),
        ),
      ),
      riskTier: task.risk_tier as 0 | 1 | 2 | 3,
      specialist: spec.name,
      timeoutMs: spec.timeoutMs,
      taskId: task.id,
      projectId: task.project_id,
    });

    const worktree = await this.deps.worktreeFor?.(task);
    const runId = newId(clock.now());
    const child = this.deps.tokens.derive(token, {
      runId,
      taskId: task.id,
      allowedTools: spec.allowedTools,
      allowedDomains: spec.allowedDomains,
      allowedPaths: worktree ? [worktree] : [],
      budgetUsdMicro: brief.budgetUsdMicro,
      expiresAt: new Date(clock.now() + spec.timeoutMs).toISOString(),
    });
    const tier = startingTier(spec.defaultTier, brief.riskTier, this.deps.ceiling);
    const model = modelIdFor(tier, this.deps.provider.name);
    const effort = effortForTask(
      spec.name === "coder" ? "coder" : spec.name === "researcher" ? "researcher" : "coder",
      brief.riskTier,
      this.deps.effortOffset ?? 0,
    );
    const run = await store.run.insert({
      id: runId,
      task_id: task.id,
      session_id: session.id,
      specialist: spec.name,
      model,
      provider: this.deps.provider.name,
      effort,
      prompt_version: spec.promptVersion,
      billing_source_id: this.deps.billingSourceId,
      tokens_in: 0,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd_micro: 0,
      cost_chf_micro: 0,
      ttft_ms: null,
      duration_ms: null,
      outcome: "running",
      artifacts: [],
      depth: child.claims.depth,
      parent_run_id: null,
      timed_out: false,
      tokens_before_compression: 0,
      tokens_after_compression: 0,
      author_agent: session.agent_id,
    });
    await store.task.patch(task.id, { attempt: task.attempt + 1, specialist: spec.name });

    const result = await this.deps.driver.run({
      token: child,
      budget,
      provider: this.deps.provider,
      model,
      billingSourceId: this.deps.billingSourceId,
      system: spec.prompt,
      messages: [{ role: "user", content: renderBrief(brief) }],
      tools: this.deps.tools,
      pricing: this.deps.pricing,
      timeoutMs: spec.timeoutMs,
      maxTurns: spec.maxTurns,
      effort,
      cwd: worktree,
      label: `${spec.name} on ${task.title}`,
      onEvent: (ev) => this.deps.onEvent?.(task.id, ev),
    });

    const outcome: TaskExecutionResult["outcome"] =
      result.outcome === "completed"
        ? "done"
        : result.outcome === "needs_human"
          ? "needs_human"
          : result.outcome === "budget_exceeded"
            ? "budget_exceeded"
            : result.outcome === "timeout"
              ? "timeout"
              : result.outcome === "killed"
                ? "killed"
                : "failed";
    try {
      await store.run.patch(run.id, {
        tokens_in: result.usage.input_tokens,
        tokens_out: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_input_tokens,
        cache_write_tokens: result.usage.cache_creation_input_tokens,
        cost_usd_micro: result.costUsdMicro,
        ttft_ms: result.ttftMs[0] ?? null,
        duration_ms: result.durationMs,
        outcome: result.outcome,
        timed_out: result.outcome === "timeout",
        artifacts: result.injectionReports.length
          ? [{ injectionReports: result.injectionReports.length }]
          : [],
      });
    } catch (e) {
      // never lose the result because bookkeeping failed
      void errorMessage(e);
    }
    return {
      outcome,
      summary: result.finalText.slice(0, 2000) || result.error?.message || result.outcome,
      costUsdMicro: result.costUsdMicro,
      // Checks are the critic's job from tier 1 up; tier 0 closes when the specialist finished cleanly.
      checksPassed: result.outcome === "completed",
    };
  }
}

export function planItemFor(task: TaskRow, specialist = "coder"): PlanItem {
  return {
    taskId: task.id,
    title: task.title,
    specialist: task.specialist ?? specialist,
    estimateUsdMicro: task.est_cost_usd_micro || task.budget_usd_micro,
  };
}
