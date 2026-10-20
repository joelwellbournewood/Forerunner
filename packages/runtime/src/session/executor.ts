import { type Clock, errorMessage, ForerunnerError, log, newId } from "@forerunner/platform";
import type { JsonObject, StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";
import { type LoopAgentDriver, type RunEvent, type RunPricing, wholeMs } from "../agent/loop.ts";
import { ToolRegistry, type ToolSpec } from "../agent/tools.ts";
import { type DelegationBrief, renderBrief, validateBrief } from "../brief.ts";
import { headroomHeaders, isProxyable } from "../context/headroom.ts";
import type { ContextManager } from "../context/manager.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import {
  DEFAULT_TASK_MEMORY_TOKEN_BUDGET,
  ESCALATE_AFTER_ATTEMPTS,
  type MemoryPort,
  memoryBudgetOf,
  TASK_MEMORY_BUDGET_SETTING,
  tierForAttempt,
} from "../loop/ports.ts";
import { effortForTask, modelIdFor, startingTier } from "../models/ladder.ts";
import type { EffectiveModelConfig } from "../models/settings.ts";
import type { EffortLevel, ModelProvider, ModelTier } from "../provider/types.ts";
import { RUN_COMMAND_TOOL } from "../registry/tools.ts";
import type { Sandbox } from "../sandbox/types.ts";
import { screenLessons } from "./lessons.ts";
import {
  lessonsFromReport,
  type PlanItem,
  type TaskExecutionResult,
  type TaskExecutor,
} from "./runner.ts";

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

/** Name of the command tool the sandbox port replaces (declared in daemon/tools.ts); re-exported for the executor's callers. */
export { RUN_COMMAND_TOOL };

/**
 * Audit row `tool` for a Run row the store refused: the run id, the stage and the store's
 * message go in the row; the prompt, the brief and the transcript never do. Written by the
 * executor (coder runs) and the critic (review runs).
 */
export const RUN_PERSIST_FAILED_AUDIT_TOOL = "run.persist_failed";

/** The ids an audit row for a Run row failure carries. */
interface RunIds {
  runId: string;
  sessionId: string;
  agentId: string;
  humanId: string;
}

export interface RunSandboxLease {
  sandbox: Sandbox;
  /** Which sandbox the run got: docker, podman, process (stand-in) or fake (tests). */
  engine: string;
  /** Lines for the session log (the process-sandbox warning, image fallback notes). */
  warnings: string[];
}

/**
 * Where a task's commands run (spec Security "Sandboxing", ADR 0007). The daemon implements
 * it with `createSandbox` (a container when an engine is reachable, else the process
 * stand-in); tests hand in a FakeSandbox. The executor opens one lease per run, pins the
 * `run_command` tool to it and destroys it afterwards.
 */
export interface RunSandboxPort {
  open(req: {
    /** The task, or for a model watch eval a synthetic one (`eval:<id>`, no project, the brief's tier). */
    task: Pick<TaskRow, "id" | "project_id" | "risk_tier">;
    worktree: string;
    /** The run token's domain allowlist: the sandbox's egress allowlist. */
    allowedDomains: readonly string[];
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<RunSandboxLease>;
}

export interface LoopTaskExecutorDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  driver: LoopAgentDriver;
  provider: ModelProvider;
  pricing: RunPricing;
  tools: ToolRegistry;
  /**
   * Tools for one run, built at run start (bridged extension tools are merged here so a
   * revocation takes effect at the next run). Default: `tools`.
   */
  toolsFor?: () => ToolRegistry;
  /** Sandbox for the task's commands when a worktree exists. Absent: commands run on the host. */
  sandbox?: RunSandboxPort;
  /**
   * Context layer per session (ADR 0003): the session's pipeline and whether its calls go
   * through the Headroom proxy. Absent: a run-private native pipeline, no proxy.
   */
  context?: ContextManager;
  billingSourceId: string;
  specialists: (name: string) => SpecialistSpec | undefined;
  /** Static model ceiling (spec D); `projectCeiling` takes precedence when it answers. */
  ceiling?: ModelTier;
  /**
   * The ceiling of the task's project from its settings (`critic_ceiling`, spec D.3), read at
   * every run so `tierForAttempt` escalates under the project's cap, not the default one.
   * Undefined for a project without the setting falls back to `ceiling`.
   */
  projectCeiling?: (settings: JsonObject | null | undefined) => ModelTier | undefined;
  effortOffset?: -1 | 0 | 1;
  /**
   * The ladder and effort table in force, read at every run start (spec D, ADR 0039): the
   * built-ins with `<config>/models.json` applied, replaced when the model watch adopts a
   * change. Absent: the built-in tables.
   */
  modelConfig?: () => EffectiveModelConfig;
  /** Worktree root for the task, if the executor should pin file access. */
  worktreeFor?: (task: TaskRow) => Promise<string | undefined>;
  onEvent?: (taskId: string, ev: RunEvent) => void;
  /**
   * Memory (spec G): lessons relevant to the task join the specialist's brief as data, under
   * the project's `task_memory_token_budget` (default 400 tokens). The principal's grant is
   * used: specialists have no memory of their own.
   */
  memory?: Pick<MemoryPort, "recall">;
  taskMemoryTokenBudget?: number;
}

/** The constraint lines a brief carries for a retry (spec D.2): the rung and the open findings. */
export function retryConstraints(
  attempt: number,
  openFindings: readonly { severity: string; description: string; required_action: string }[],
): string[] {
  const lines: string[] = [];
  if (attempt >= 1) {
    const rung =
      attempt === 1
        ? "retry 1 of the ladder: the brief was improved with the critic's findings below"
        : attempt === 2
          ? "retry 2 of the ladder: keep the scope small; split the task or hand it to another specialist if it does not fit"
          : attempt >= ESCALATE_AFTER_ATTEMPTS
            ? `retry ${attempt} of the ladder: this run is escalated one model rung under the project ceiling; after this the human decides`
            : `retry ${attempt} of the ladder`;
    lines.push(`Attempt ${attempt + 1} (${rung}).`);
  }
  if (openFindings.length) {
    lines.push("Critic findings to resolve (each must be addressed with evidence):");
    for (const f of openFindings.slice(0, 20))
      lines.push(`- [${f.severity}] ${f.description} -> ${f.required_action}`);
  }
  return lines;
}

export class LoopTaskExecutor implements TaskExecutor {
  private readonly logger = log("executor");

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

    // Retry ladder (spec D.2): the open findings of the task become constraints of the brief
    // (rung 1, "improve the brief"), the rung is named, and the model rung is derived from the
    // attempt count below (rung 3, "escalate under the ceiling").
    const openFindings = await store.finding.openFor(task.id);
    const project = task.project_id ? await store.project.get(task.project_id) : undefined;
    // Memory (spec G): lessons for this task, as data, under the task budget.
    let lessonsBlock = "";
    const taskMemoryBudget = memoryBudgetOf(
      project?.settings,
      TASK_MEMORY_BUDGET_SETTING,
      this.deps.taskMemoryTokenBudget ?? DEFAULT_TASK_MEMORY_TOKEN_BUDGET,
    );
    if (this.deps.memory) {
      try {
        const recalled = await this.deps.memory.recall({
          agentId: session.agent_id,
          kind: "principal",
          projectId: task.project_id,
          query: `${task.title}\n${task.outcome}\n${task.acceptance_criteria.join("\n")}`,
          tags: [spec.name],
          maxTokens: taskMemoryBudget,
        });
        if (recalled.tokens <= taskMemoryBudget) lessonsBlock = recalled.block;
        else
          this.deps.onEvent?.(task.id, {
            type: "warning",
            message: `lessons block of ${recalled.tokens} tokens over the task budget of ${taskMemoryBudget}; dropped`,
          });
      } catch (e) {
        this.deps.onEvent?.(task.id, {
          type: "warning",
          message: `memory recall failed: ${errorMessage(e)}`,
        });
      }
    }
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
        "End the report with one line per lesson worth keeping, as 'Lesson: ...'.",
        ...retryConstraints(task.attempt, openFindings),
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
    // The ceiling is the project's (`critic_ceiling` in its settings, spec D.3) when the
    // composition passes `projectCeiling`; the static `ceiling` is the fallback, then the
    // ladder's default. A project capped at sonnet therefore never escalates a retry to opus.
    const ceiling = this.deps.projectCeiling?.(project?.settings) ?? this.deps.ceiling;
    const tier = tierForAttempt(
      startingTier(spec.defaultTier, brief.riskTier, ceiling),
      task.attempt,
      ceiling,
    );
    // The rung and the effort come from the tables in force (built-ins plus the adopted
    // models.json), so an adoption by the model watch changes the next run, not the next start.
    const modelConfig = this.deps.modelConfig?.();
    const model = modelIdFor(tier, this.deps.provider.name, modelConfig?.ladder);
    const effort = effortForTask(
      spec.name === "coder" ? "coder" : spec.name === "researcher" ? "researcher" : "coder",
      brief.riskTier,
      this.deps.effortOffset ?? 0,
      modelConfig?.modeDefaults,
    );
    // Context layer: the session's pipeline, and the proxy only when the session selected it and
    // the provider can route through it (the fake provider cannot, so headroom_used stays false).
    const sessionContext = await this.deps.context?.forSession(session.id, task.project_id);
    const proxyUrl = sessionContext?.selection.headroom?.url;
    const provider =
      sessionContext?.selection.headroomUsed && proxyUrl && isProxyable(this.deps.provider)
        ? this.deps.provider.viaProxy(proxyUrl, headroomHeaders(task.project_id))
        : this.deps.provider;
    const headroomUsed = provider !== this.deps.provider;
    const startedMono = clock.monotonic();
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
      context_transforms: [],
      headroom_used: headroomUsed,
      author_agent: session.agent_id,
    });
    const runIds: RunIds = {
      runId: run.id,
      sessionId: session.id,
      agentId: session.agent_id,
      humanId: token.claims.ownerHumanId,
    };
    // The attempt count is the state workflow's (failed -> ready, spec D.2); a run does not
    // count itself, or the ladder would advance twice per failure.
    await store.task.patch(task.id, { specialist: spec.name });

    // Tools for this run; with a worktree and a sandbox port, commands run inside the sandbox
    // with only the worktree mounted and the token's domains as the egress allowlist. A lease
    // the port refuses (a tier 2+ task with no engine) or a driver that throws still ends the
    // Run row: it is closed as "error" before the error reaches the runner, so run history,
    // the cost view and the estimate feedback never see a run that never ended.
    let lease: RunSandboxLease | null = null;
    let result: Awaited<ReturnType<LoopAgentDriver["run"]>>;
    try {
      let tools = this.deps.toolsFor?.() ?? this.deps.tools;
      if (worktree && this.deps.sandbox) {
        lease = await this.deps.sandbox.open({
          task,
          worktree,
          allowedDomains: child.claims.allowedDomains,
          timeoutMs: spec.timeoutMs,
          signal: ctx.signal,
        });
        for (const w of lease.warnings)
          this.deps.onEvent?.(task.id, { type: "warning", message: w });
        tools = withSandboxedCommands(tools, lease.sandbox);
      }
      result = await this.deps.driver.run({
        token: child,
        budget,
        provider,
        context: sessionContext?.pipeline,
        headroomUsed,
        model,
        billingSourceId: this.deps.billingSourceId,
        system: spec.prompt,
        messages: [
          {
            role: "user",
            content: lessonsBlock ? `${renderBrief(brief)}\n\n${lessonsBlock}` : renderBrief(brief),
          },
        ],
        tools,
        pricing: this.deps.pricing,
        timeoutMs: spec.timeoutMs,
        maxTurns: spec.maxTurns,
        effort,
        cwd: worktree,
        label: `${spec.name} on ${task.title}`,
        onEvent: (ev) => this.deps.onEvent?.(task.id, ev),
      });
    } catch (e) {
      await this.endRunWithError(runIds, e, startedMono);
      throw e;
    } finally {
      if (lease) {
        await lease.sandbox.destroy().catch((e: unknown) => {
          this.logger.warn("sandbox destroy failed", { taskId: task.id, error: errorMessage(e) });
        });
      }
    }

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
        // Integers only: the timing columns are INTEGER and the store rejects a fraction.
        ttft_ms: wholeMs(result.ttftMs[0]),
        duration_ms: wholeMs(result.durationMs),
        outcome: result.outcome,
        timed_out: result.outcome === "timeout",
        tokens_before_compression: result.context.tokensBefore,
        tokens_after_compression: result.context.tokensAfter,
        context_transforms: result.context.transforms,
        headroom_used: result.context.headroomUsed,
        artifacts: result.injectionReports.length
          ? [{ injectionReports: result.injectionReports.length }]
          : [],
      });
    } catch (e) {
      // The result is never lost because bookkeeping failed, and the failure is on record.
      await this.runPersistFailed(runIds, "end", e);
    }
    return {
      outcome,
      summary: result.finalText.slice(0, 2000) || result.error?.message || result.outcome,
      costUsdMicro: result.costUsdMicro,
      // Checks are the critic's job from tier 1 up; tier 0 closes when the specialist finished cleanly.
      checksPassed: result.outcome === "completed",
      runId: run.id,
      ...(worktree ? { worktree } : {}),
      finalReport: result.finalText,
      lessons: this.screenedLessons(task.id, result.finalText, spec.name),
    };
  }

  /**
   * The `Lesson: ...` lines of the report, minus the ones that read like instructions: the
   * report is model output over untrusted content, so a planted line is dropped here (the
   * runner and the memory port screen again) and reported as a warning on the task.
   */
  private screenedLessons(taskId: string, finalText: string, specialist: string) {
    const screened = screenLessons(lessonsFromReport(finalText, [specialist]), "agent_output");
    for (const r of screened.rejected) {
      this.deps.onEvent?.(taskId, {
        type: "warning",
        message: `lesson proposal ignored as instruction-like (${r.rules.join(", ")}): "${r.text.slice(0, 200)}"`,
      });
    }
    return screened.kept;
  }

  /** Close a Run row whose run threw before the driver returned (outcome "error", duration, why). */
  private async endRunWithError(ids: RunIds, e: unknown, startedMono: number): Promise<void> {
    try {
      await this.deps.store.run.patch(ids.runId, {
        outcome: "error",
        duration_ms: wholeMs(this.deps.clock.monotonic() - startedMono),
        artifacts: [{ error: errorMessage(e) }],
      });
    } catch (patchError) {
      await this.runPersistFailed(ids, "error", patchError);
    }
  }

  /**
   * A Run row the store refused. The first live run (ADR 0040) wrote a fractional `ttft_ms`,
   * the store rejected it and the error was swallowed, so every coder run stayed `running`
   * with cost 0 and nothing said so. The session keeps its result either way; the failure is
   * logged through the runtime logger and appended as an audit row (`run.persist_failed`)
   * carrying the run id, the stage and the store's message, so a run history that disagrees
   * with the cost ledger can be traced. The prompt and the brief never enter either.
   */
  private async runPersistFailed(ids: RunIds, stage: "end" | "error", e: unknown): Promise<void> {
    const error = errorMessage(e);
    this.logger.error("run row not persisted", { runId: ids.runId, stage, error });
    try {
      await this.deps.store.auditLog.append({
        session_id: ids.sessionId,
        run_id: ids.runId,
        agent_id: ids.agentId,
        human_id: ids.humanId,
        tool: RUN_PERSIST_FAILED_AUDIT_TOOL,
        input_summary: JSON.stringify({ runId: ids.runId, stage }),
        result_summary: error,
        allowed: false,
        denied_reason: error,
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
      });
    } catch (auditError) {
      this.logger.error("run persist failure not audited", {
        runId: ids.runId,
        error: errorMessage(auditError),
      });
    }
  }
}

/**
 * The run's tool registry with `run_command` executing inside the sandbox (argv array, no
 * shell, the sandbox's own timeout and output caps). Every other tool is kept as is.
 */
export function withSandboxedCommands(base: ToolRegistry, sandbox: Sandbox): ToolRegistry {
  const out = new ToolRegistry();
  for (const name of base.names()) {
    const t = base.get(name);
    if (t && name !== RUN_COMMAND_TOOL) out.register(t);
  }
  const original = base.get(RUN_COMMAND_TOOL);
  const runCommand: ToolSpec<{ argv: string[]; timeoutSec?: number }> = {
    name: RUN_COMMAND_TOOL,
    description:
      original?.description ??
      'Run a command (argv array, no shell) inside the task sandbox, e.g. ["pnpm","test"].',
    schema: z.object({
      argv: z.array(z.string().min(1)).min(1),
      timeoutSec: z.number().int().min(1).max(1800).optional(),
    }),
    actionClass: original?.actionClass ?? "routine_reversible",
    risk: original?.risk ?? "medium",
    timeoutMs: original?.timeoutMs ?? 30 * 60 * 1000,
    async execute(input, ctx) {
      const r = await sandbox.run(input.argv, {
        timeoutMs: (input.timeoutSec ?? 600) * 1000,
        signal: ctx.signal,
        maxOutputBytes: 512 * 1024,
      });
      const content = `exit ${r.code}${r.timedOut ? " (timeout)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      return {
        content,
        isError: r.code !== 0,
        untrusted: { source: "tool_output", origin: `${sandbox.kind}:${input.argv[0]}` },
      };
    },
  };
  out.register(runCommand);
  return out;
}

export function planItemFor(task: TaskRow, specialist = "coder"): PlanItem {
  return {
    taskId: task.id,
    title: task.title,
    specialist: task.specialist ?? specialist,
    estimateUsdMicro: task.est_cost_usd_micro || task.budget_usd_micro,
  };
}
