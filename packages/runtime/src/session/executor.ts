import { mkdirSync } from "node:fs";
import { type BillingSource, BUILTIN_PRICING, type PricingTable } from "@forerunner/billing";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  newId,
  redact,
} from "@forerunner/platform";
import type { JsonObject, JsonValue, StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";
import { withClaudeCodeTools } from "../agent/cc-tools.ts";
import {
  type LoopAgentDriver,
  type RunContextStats,
  type RunEvent,
  type RunOutcome,
  type RunPricing,
  wholeMs,
} from "../agent/loop.ts";
import type { SdkAgentDriver, SdkRunRequest } from "../agent/sdk.ts";
import { ToolRegistry, type ToolSpec } from "../agent/tools.ts";
import { type DelegationBrief, renderBrief, validateBrief } from "../brief.ts";
import { headroomHeaders, isProxyable } from "../context/headroom.ts";
import type { ContextManager } from "../context/manager.ts";
import type { RunBilling } from "../enforcement/hooks.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import {
  DEFAULT_TASK_MEMORY_TOKEN_BUDGET,
  ESCALATE_AFTER_ATTEMPTS,
  type MemoryPort,
  memoryBudgetOf,
  TASK_MEMORY_BUDGET_SETTING,
  tierForAttempt,
} from "../loop/ports.ts";
import {
  decideFastMode,
  FAST_MODE_AUDIT_TOOL,
  type FastModeDecision,
  fastModeAuditLine,
  fastModeOf,
} from "../models/fast-mode.ts";
import {
  capEffort,
  effortForTask,
  MODE_DEFAULTS,
  type Mode,
  type ModeDefault,
  modelIdFor,
  specialistMode,
  speedQualityOffsetOf,
  startingTier,
} from "../models/ladder.ts";
import {
  explicitSpeedMode,
  parseAgentModelConfig,
  resolveRunSettings,
  specialistOverride,
  speedPreferenceNote,
} from "../models/run-settings.ts";
import type { EffectiveModelConfig } from "../models/settings.ts";
import {
  type EffortLevel,
  type ModelProvider,
  type ModelTier,
  providerCapabilities,
  type SpeedMode,
  type Usage,
} from "../provider/types.ts";
import { RUN_COMMAND_TOOL, type SpecialistDriver, TOOL_UNMAPPED_AUDIT } from "../registry/tools.ts";
import { CLAUDE_CODE_PREFIX } from "../registry/types.ts";
import type { Sandbox } from "../sandbox/types.ts";
import { pricingFor as tablePricingFor } from "../wiring/billing-ports.ts";
import {
  BILLING_PICK_AUDIT_TOOL,
  planShareAfter,
  type TaskBillingPick,
  type TaskBillingPort,
} from "./billing.ts";
import { screenLessons } from "./lessons.ts";
import { renderHeardLines } from "./live-chat.ts";
import {
  lessonsFromReport,
  type PlanItem,
  type TaskExecutionResult,
  type TaskExecutor,
} from "./runner.ts";

/**
 * Runs one task through a specialist: validates the delegation brief, picks the billing
 * source for the task (ADR 0044), derives a narrower capability token (depth + 1, the
 * specialist's tools/domains, the task's budget), runs the specialist through the driver the
 * pick names (the in-process loop driver on an API-style source, the Agent SDK driver with the
 * OAuth token on a subscription), records the Run row and returns the outcome. The specialist
 * definition comes from the registry; this executor only needs the fields below.
 */
export interface SpecialistSpec {
  name: string;
  /** Role prompt (system). */
  prompt: string;
  promptVersion: string;
  defaultTier: ModelTier;
  defaultEffort: EffortLevel;
  /**
   * The registry entry's `max_effort`: no run of this specialist goes above it, whatever the
   * mode default, the tier-2+ coder rule, the project's speed-versus-quality slider (spec D.16)
   * or the agent's override (spec D.4, ADR 0072) ask. Unset means no cap.
   */
  maxEffort?: EffortLevel;
  allowedTools: string[];
  allowedDomains: string[];
  maxBudgetUsdMicro: number;
  maxTurns: number;
  timeoutMs: number;
  /** `max_tokens` from the registry file (spec D.4); absent: the effort table's row. */
  maxTokens?: number;
  /** `speed_mode` from the registry file (spec D.4); absent: the effort table's row. */
  speedMode?: SpeedMode;
  /** `temperature` from the registry file; sent only to a provider that accepts one. */
  temperature?: number;
}

/** Name of the command tool the sandbox port replaces (declared in daemon/tools.ts); re-exported for the executor's callers. */
export { RUN_COMMAND_TOOL };

/**
 * Audit row `tool` for a Run row the store refused: the run id, the stage and the store's
 * message go in the row; the prompt, the brief and the transcript never do. Written by the
 * executor (coder runs) and the critic (review runs).
 */
export const RUN_PERSIST_FAILED_AUDIT_TOOL = "run.persist_failed";

/** The `provider` column of a Run that went through the Agent SDK driver. */
export const SDK_RUN_PROVIDER = "anthropic-sdk";

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

/**
 * The Agent SDK path of the executor (ADR 0044): the driver, how a picked source's credential
 * is read (from the vault by reference, at run time, never held), where a run without a
 * worktree works, and how a model id on this path is priced. Absent: a subscription pick is
 * refused as `unavailable` rather than run on the wrong credential.
 */
export interface SdkExecutorDeps {
  driver: SdkAgentDriver;
  credential: (source: BillingSource) => Promise<SdkRunRequest["credential"]>;
  /** Root for the working directory of a run with no worktree (`<workRoot>/<runId>`). */
  workRoot: string;
  /** Pricing for the Anthropic model id the run uses (the table in force). */
  pricing: (modelId: string) => RunPricing;
  /** The provider name the ladder resolves model ids for; default "anthropic". */
  providerName?: string;
  /**
   * Whether `cc:Bash` may run where the Claude Code subprocess runs (the host, with the run's
   * working directory): no sandbox lease covers that subprocess, so the default withholds the
   * tool (an audit row says so) and only an explicit opt-in grants it, with a warning on the run.
   */
  hostCommands?: boolean;
}

export interface LoopTaskExecutorDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  driver: LoopAgentDriver;
  provider: ModelProvider;
  /** Pricing of a loop run when `pricingFor` is absent (one table row for every rung). */
  pricing: RunPricing;
  /**
   * Pricing of a loop run by the model id its records name (the rung's id, or the fast-mode
   * variant, ADR 0057): the rung follows the ladder, the escalation and the agent's `tier`
   * override (spec D.4, ADR 0072), so the daemon prices every run at its own model from the
   * table in force and the budget hooks' estimate and the recorded cost follow it. Absent:
   * `pricing` for a standard run, the `pricingTable` row for a fast-mode run.
   */
  pricingFor?: (modelId: string) => RunPricing;
  /**
   * The price table in force (built-ins plus `<config>/pricing.json`), read per run: fast mode
   * applies only to an Opus id whose variant has a row (ADR 0057). Default: the built-ins.
   */
  pricingTable?: () => PricingTable;
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
  /** The source every run is billed to when no `billing` port picks one per task. */
  billingSourceId: string;
  /**
   * Per-task billing (ADR 0044): the human's sources through the router. With it every task
   * picks its source before the Run row is written, the pick is the row's `billing_source_id`
   * and a `billing.pick` audit row, and a subscription pick runs on `sdk`.
   */
  billing?: TaskBillingPort;
  /** The Agent SDK path; see `SdkExecutorDeps`. */
  sdk?: SdkExecutorDeps;
  /**
   * The specialist as the executor sees it. The second argument asks for the entry's tools
   * in the form of a driver other than the composition's default ("sdk": the registry's
   * `cc:` names as written; "loop": the built-in equivalents); omitted, the default applies.
   */
  specialists: (name: string, driver?: SpecialistDriver) => SpecialistSpec | undefined;
  /** Static model ceiling (spec D); `projectCeiling` takes precedence when it answers. */
  ceiling?: ModelTier;
  /**
   * The ceiling of the task's project from its settings (`critic_ceiling`, spec D.3), read at
   * every run so `tierForAttempt` escalates under the project's cap, not the default one.
   * Undefined for a project without the setting falls back to `ceiling`.
   */
  projectCeiling?: (settings: JsonObject | null | undefined) => ModelTier | undefined;
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

/** What either driver came back with, in the shape the Run row and the result need. */
interface DriverOutcome {
  outcome: RunOutcome;
  finalText: string;
  usage: Usage;
  costUsdMicro: number;
  ttftMs: number | null;
  durationMs: number;
  error?: { code: string; message: string };
  /** The loop driver's context-layer numbers; the SDK path measures none. */
  context: RunContextStats | null;
  injectionReports: number;
  artifacts: JsonValue[];
}

/** The billing decision of one task as the run uses it. */
interface RunBillingChoice {
  sourceId: string;
  driver: SpecialistDriver;
  pick: TaskBillingPick | null;
  /** What the hooks get: the ledger kind and, on a subscription, the live plan share. */
  billing: RunBilling | undefined;
}

export class LoopTaskExecutor implements TaskExecutor {
  private readonly logger = log("executor");

  constructor(private readonly deps: LoopTaskExecutorDeps) {}

  async execute(ctx: Parameters<TaskExecutor["execute"]>[0]): Promise<TaskExecutionResult> {
    const { store, clock } = this.deps;
    const { task, session, token, budget, item } = ctx;
    const defaultSpec = this.deps.specialists(item.specialist);
    if (!defaultSpec)
      throw new ForerunnerError(
        "not_found",
        `specialist ${item.specialist} is not in the registry`,
      );

    // Retry ladder (spec D.2): the open findings of the task become constraints of the brief
    // (rung 1, "improve the brief"), the rung is named, and the model rung is derived from the
    // attempt count below (rung 3, "escalate under the ceiling").
    const openFindings = await store.finding.openFor(task.id);
    const project = task.project_id ? await store.project.get(task.project_id) : undefined;
    // Settings per agent and specialist (spec D.4, ADR 0072): the effort table row of the
    // specialist's mode, then its registry file, then the agent's `model_config` override.
    const modelConfig = this.deps.modelConfig?.();
    const mode = specialistMode(defaultSpec.name);
    const capabilities = providerCapabilities(this.deps.provider);
    const agentConfig = parseAgentModelConfig(
      (await store.agent.get(session.agent_id))?.model_config,
    );
    if (agentConfig.error)
      this.deps.onEvent?.(task.id, {
        type: "warning",
        message: `the agent's model settings are malformed and were ignored (${agentConfig.error}); the registry and effort-table defaults apply`,
      });
    const settings = resolveRunSettings({
      mode,
      modeDefaults: modelConfig?.modeDefaults,
      specialist: {
        tier: defaultSpec.defaultTier,
        timeoutMs: defaultSpec.timeoutMs,
        ...(defaultSpec.maxTokens !== undefined ? { maxTokens: defaultSpec.maxTokens } : {}),
        ...(defaultSpec.speedMode !== undefined ? { speedMode: defaultSpec.speedMode } : {}),
        ...(defaultSpec.temperature !== undefined ? { temperature: defaultSpec.temperature } : {}),
      },
      override: specialistOverride(agentConfig.config, defaultSpec.name),
      capabilities,
    });
    const timeoutMs = settings.timeoutMs;
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
          tags: [defaultSpec.name],
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
          item.estimateUsdMicro || task.budget_usd_micro || defaultSpec.maxBudgetUsdMicro,
          defaultSpec.maxBudgetUsdMicro,
          token.claims.budgetUsdMicro,
          budget.remainingUsdMicro(),
        ),
      ),
      riskTier: task.risk_tier as 0 | 1 | 2 | 3,
      specialist: defaultSpec.name,
      timeoutMs,
      taskId: task.id,
      projectId: task.project_id,
    });

    // The ceiling is the project's (`critic_ceiling` in its settings, spec D.3) when the
    // composition passes `projectCeiling`; the static `ceiling` is the fallback, then the
    // ladder's default. A project capped at sonnet therefore never escalates a retry to opus.
    const ceiling = this.deps.projectCeiling?.(project?.settings) ?? this.deps.ceiling;
    const tier = tierForAttempt(
      startingTier(settings.tier, brief.riskTier, ceiling),
      task.attempt,
      ceiling,
    );
    const worktree = await this.deps.worktreeFor?.(task);
    const runId = newId(clock.now());

    // Billing (ADR 0044): the source for this task, then the driver that goes with it. The
    // specialist's tools are re-read in that driver's form (the registry's `cc:` names as
    // written for the SDK, the built-in equivalents for the loop).
    const choice = await this.pickBilling(ctx, tier, runId);
    const spec =
      choice.driver === "sdk"
        ? (this.deps.specialists(item.specialist, "sdk") ?? defaultSpec)
        : defaultSpec;
    // A run with no worktree on the SDK path still needs a working directory: its own,
    // under the executor's work root, and that is the only path the token allows.
    const sdkCwd =
      choice.driver === "sdk" ? (worktree ?? join(this.sdkDeps().workRoot, runId)) : undefined;
    const allowedTools =
      choice.driver === "sdk"
        ? await this.sdkAllowedTools(
            spec,
            session.id,
            runId,
            session.agent_id,
            token.claims.ownerHumanId,
          )
        : spec.allowedTools;
    const child = this.deps.tokens.derive(token, {
      runId,
      taskId: task.id,
      allowedTools,
      allowedDomains: spec.allowedDomains,
      allowedPaths: worktree ? [worktree] : sdkCwd ? [sdkCwd] : [],
      budgetUsdMicro: brief.budgetUsdMicro,
      expiresAt: new Date(clock.now() + timeoutMs).toISOString(),
    });
    // The rung and the effort come from the tables in force (built-ins plus the adopted
    // models.json), so an adoption by the model watch changes the next run, not the next start.
    // The effort is shifted by the project's speed-versus-quality slider (spec D.16), read from
    // the project row this run loaded, so a slider change applies to the next run, and held at
    // the specialist's `max_effort` from the registry (neither the tier rule nor the slider
    // raises it past that, as the critic's own cap does). An agent's effort override (spec D.4)
    // replaces the table's base effort; the risk rules and the slider still apply.
    const model =
      choice.driver === "sdk"
        ? modelIdFor(tier, this.sdkDeps().providerName ?? "anthropic", modelConfig?.ladder)
        : modelIdFor(tier, this.deps.provider.name, modelConfig?.ladder);
    // Fast mode (spec D.20, ADR 0057) composed with the speed mode (spec D.4, ADR 0072): the
    // project's flag routes an Opus rung on an API-style source to the variant, unless the
    // specialist's file or the agent's override sets the speed mode `standard`; the Run row,
    // the ledger and the estimate name and price it. `decideFastMode` is the one decision.
    const fastEnabled = fastModeOf(project?.settings);
    const speedPreference = explicitSpeedMode(settings);
    const fast = decideFastMode({
      enabled: fastEnabled,
      tier,
      model,
      driver: choice.driver,
      sourceKind: choice.pick?.source.kind ?? null,
      provider: this.deps.provider,
      pricing: this.deps.pricingTable?.() ?? BUILTIN_PRICING,
      ...(speedPreference ? { speedMode: speedPreference } : {}),
    });
    const runModel = fast.kind === "applied" ? fast.variant : model;
    // A `fast` preference the project's flag does not grant runs standard and says why.
    const preferenceNote = speedPreferenceNote({
      speedMode: speedPreference,
      projectAllows: fastEnabled,
      tier,
    });
    if (preferenceNote)
      this.deps.onEvent?.(task.id, {
        type: "warning",
        message: `${spec.name} asks for fast mode but this run stays at the standard speed: ${preferenceNote}`,
      });
    const asked = effortForTask(
      mode,
      brief.riskTier,
      speedQualityOffsetOf(project?.settings),
      settings.sources.effort === "agent"
        ? withModeEffort(modelConfig?.modeDefaults, mode, settings.effort)
        : modelConfig?.modeDefaults,
    );
    // The specialist's `max_effort` caps whatever the rules, the slider and the override asked for.
    const effort = capEffort(asked, spec.maxEffort ?? defaultSpec.maxEffort);
    if (effort !== asked)
      this.deps.onEvent?.(task.id, {
        type: "warning",
        message: `${spec.name} runs at effort ${effort}, its max_effort, not ${asked}`,
      });
    // Context layer: the session's pipeline, and the proxy only when the session selected it and
    // the provider can route through it (the fake provider cannot, so headroom_used stays false).
    // On the SDK path the proxy reaches the subprocess as its environment (`sdkEnv`, ADR 0003).
    const sessionContext = await this.deps.context?.forSession(session.id, task.project_id);
    const proxyUrl = sessionContext?.selection.headroom?.url;
    const provider =
      sessionContext?.selection.headroomUsed && proxyUrl && isProxyable(this.deps.provider)
        ? this.deps.provider.viaProxy(proxyUrl, headroomHeaders(task.project_id))
        : this.deps.provider;
    const headroomUsed =
      choice.driver === "sdk" ? !!sessionContext?.sdkEnv : provider !== this.deps.provider;
    const startedMono = clock.monotonic();
    const run = await store.run.insert({
      id: runId,
      task_id: task.id,
      session_id: session.id,
      specialist: spec.name,
      model: runModel,
      provider: choice.driver === "sdk" ? SDK_RUN_PROVIDER : this.deps.provider.name,
      effort,
      prompt_version: spec.promptVersion,
      billing_source_id: choice.sourceId,
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
    if (choice.pick) await this.auditPick(choice.pick, runIds, task.id, tier);
    if (fast.kind !== "off") {
      await this.auditFastMode(fast, runIds, task, tier, choice);
      if (fast.kind === "ignored")
        this.deps.onEvent?.(task.id, {
          type: "warning",
          message: `fast mode is on for this project but this run stays at the standard speed: ${fast.reason}`,
        });
    }
    // The attempt count is the state workflow's (failed -> ready, spec D.2); a run does not
    // count itself, or the ladder would advance twice per failure.
    await store.task.patch(task.id, { specialist: spec.name });

    // What the human said during the session (spec O.9): quoted data after the brief and the
    // lessons, never a field of the brief; an instruction-shaped line is named in the session
    // log by its id and rules, never by its words.
    const heard = renderHeardLines(ctx.heard ?? []);
    for (const f of heard.flagged)
      this.deps.onEvent?.(task.id, {
        type: "warning",
        message: `a line the human said during the session (message ${f.id}) contained instruction-like passages (${f.rules.join(", ")}); passed to the specialist as data`,
      });
    const userText = [renderBrief(brief), lessonsBlock, heard.block].filter((t) => t).join("\n\n");
    const label = `${spec.name} on ${task.title}`;
    const onEvent = (ev: RunEvent) => this.deps.onEvent?.(task.id, ev);
    // Tools for this run; with a worktree and a sandbox port, commands run inside the sandbox
    // with only the worktree mounted and the token's domains as the egress allowlist. A lease
    // the port refuses (a tier 2+ task with no engine) or a driver that throws still ends the
    // Run row: it is closed as "error" before the error reaches the runner, so run history,
    // the cost view and the estimate feedback never see a run that never ended.
    let lease: RunSandboxLease | null = null;
    let result: DriverOutcome;
    try {
      if (choice.driver === "sdk") {
        const sdk = this.sdkDeps();
        const cwd = sdkCwd as string;
        if (!worktree) mkdirSync(cwd, { recursive: true });
        if (sdk.hostCommands && allowedTools.includes(`${CLAUDE_CODE_PREFIX}Bash`)) {
          onEvent({
            type: "warning",
            message:
              "cc:Bash runs on the host where the Claude Code subprocess runs (hostCommands is on); no sandbox lease covers it",
          });
        }
        // The credential is read by reference from the vault now and handed to the driver's
        // subprocess environment; it lives in no field of this executor or the Run.
        const credential = await sdk.credential(choice.pick?.source as BillingSource);
        const r = await sdk.driver.run({
          token: child,
          budget,
          billingSourceId: choice.sourceId,
          ...(choice.billing ? { billing: choice.billing } : {}),
          credential,
          model,
          effort,
          systemPrompt: spec.prompt,
          prompt: userText,
          cwd,
          tools: withClaudeCodeTools(this.deps.toolsFor?.() ?? this.deps.tools),
          pricing: sdk.pricing(model),
          timeoutMs,
          maxTurns: spec.maxTurns,
          ...(sessionContext?.sdkEnv ? { env: sessionContext.sdkEnv } : {}),
          label,
          onEvent,
        });
        result = {
          outcome: r.outcome,
          finalText: r.finalText,
          usage: r.usage,
          costUsdMicro: r.costUsdMicro,
          ttftMs: r.ttftMs,
          durationMs: r.durationMs,
          ...(r.error ? { error: r.error } : {}),
          context: null,
          injectionReports: 0,
          artifacts: [
            {
              driver: "sdk",
              sdk_session_id: r.sessionId,
              // The SDK's own list-price figure, kept beside the ledger's per-call estimate.
              sdk_cost_usd_micro: Math.round(r.sdkCostUsd * 1_000_000),
            },
          ],
        };
      } else {
        let tools = this.deps.toolsFor?.() ?? this.deps.tools;
        if (worktree && this.deps.sandbox) {
          lease = await this.deps.sandbox.open({
            task,
            worktree,
            allowedDomains: child.claims.allowedDomains,
            timeoutMs,
            signal: ctx.signal,
          });
          for (const w of lease.warnings) onEvent({ type: "warning", message: w });
          tools = withSandboxedCommands(tools, lease.sandbox);
        }
        const r = await this.deps.driver.run({
          token: child,
          budget,
          provider,
          context: sessionContext?.pipeline,
          headroomUsed,
          model,
          billingSourceId: choice.sourceId,
          ...(choice.billing ? { billing: choice.billing } : {}),
          system: spec.prompt,
          messages: [{ role: "user", content: userText }],
          tools,
          pricing: this.loopPricing(runModel, fast),
          timeoutMs,
          maxTurns: spec.maxTurns,
          maxTokensPerCall: settings.maxTokens,
          effort,
          ...(fast.kind === "applied" ? { speed: "fast" as const } : {}),
          ...(settings.temperature !== null ? { temperature: settings.temperature } : {}),
          cwd: worktree,
          label,
          onEvent,
        });
        result = {
          outcome: r.outcome,
          finalText: r.finalText,
          usage: r.usage,
          costUsdMicro: r.costUsdMicro,
          ttftMs: r.ttftMs[0] ?? null,
          durationMs: r.durationMs,
          ...(r.error ? { error: r.error } : {}),
          context: r.context,
          injectionReports: r.injectionReports.length,
          artifacts: [
            ...(r.injectionReports.length ? [{ injectionReports: r.injectionReports.length }] : []),
            // A fast-mode run says so on its Run row (ADR 0072): it was priced at the fast row.
            ...(fast.kind === "applied" ? [{ speed: "fast" }] : []),
          ],
        };
      }
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
        ttft_ms: wholeMs(result.ttftMs),
        duration_ms: wholeMs(result.durationMs),
        outcome: result.outcome,
        timed_out: result.outcome === "timeout",
        tokens_before_compression: result.context?.tokensBefore ?? 0,
        tokens_after_compression: result.context?.tokensAfter ?? 0,
        context_transforms: result.context?.transforms ?? [],
        headroom_used: result.context?.headroomUsed ?? headroomUsed,
        artifacts: result.artifacts,
      });
    } catch (e) {
      // The result is never lost because bookkeeping failed, and the failure is on record.
      await this.runPersistFailed(runIds, "end", e);
    }
    // A driver's error message, and a successful run's final text, may quote what the
    // subprocess or the provider said (its own environment included); the store has no
    // redaction layer, so both are redacted here before they become the task's summary, the
    // report the critic reads and the lesson candidates (ADR 0044 item 9).
    const finalText = redact(result.finalText);
    return {
      outcome,
      summary:
        finalText.slice(0, 2000) ||
        (result.error ? redact(result.error.message) : "") ||
        result.outcome,
      costUsdMicro: result.costUsdMicro,
      // Checks are the critic's job from tier 1 up; tier 0 closes when the specialist finished cleanly.
      checksPassed: result.outcome === "completed",
      runId: run.id,
      ...(worktree ? { worktree } : {}),
      finalReport: finalText,
      lessons: this.screenedLessons(task.id, finalText, spec.name),
    };
  }

  /** The SDK deps, or a clear error when a subscription pick has no SDK path to run on. */
  private sdkDeps(): SdkExecutorDeps {
    if (!this.deps.sdk) {
      throw new ForerunnerError(
        "unavailable",
        "the task was routed to a subscription source but this executor has no Agent SDK driver",
      );
    }
    return this.deps.sdk;
  }

  /**
   * The billing source of this task (ADR 0044). Without a billing port every run is billed
   * to `billingSourceId` on the loop driver, as before. With one, the port picks among the
   * human's sources for the session's runner and the agent's owner (the agent row, else the
   * token's owner claim); a subscription pick runs on the SDK driver and carries the ledger
   * kind and the live plan share for the hooks.
   */
  private async pickBilling(
    ctx: Parameters<TaskExecutor["execute"]>[0],
    tier: ModelTier,
    runId: string,
  ): Promise<RunBillingChoice> {
    if (!this.deps.billing) {
      return {
        sourceId: this.deps.billingSourceId,
        driver: "loop",
        pick: null,
        billing: undefined,
      };
    }
    const { session, token, budget } = ctx;
    const agent = await this.deps.store.agent.get(session.agent_id);
    const pick = await this.deps.billing.pick({
      agentId: session.agent_id,
      agentOwnerHumanId: agent?.owner_human_id ?? token.claims.ownerHumanId,
      runner: session.runner === "cloud" ? "cloud" : "pc",
      modelTier: tier,
      purpose: "session",
    });
    if (pick.driver === "sdk") this.sdkDeps();
    const plan = pick.plan;
    const billing: RunBilling =
      pick.source.kind === "subscription" && plan
        ? {
            kind: "subscription",
            planShareCap: plan.cap,
            // The share as this run's spend moves it: the month's rows before the run plus
            // what the session budget has booked on this run so far.
            planUsageShare: () => planShareAfter(plan, budget.spentByRunId(runId)),
          }
        : { kind: pick.source.kind === "plan_credits" ? "plan_credits" : "api" };
    return { sourceId: pick.source.id, driver: pick.driver, pick, billing };
  }

  /**
   * The loop run's pricing by the model its records name: `pricingFor` when the composition
   * passes it; else the flat `pricing` for a standard run and the variant's table row for a
   * fast-mode run (a fast run is never priced at the standard rate).
   */
  private loopPricing(runModel: string, fast: FastModeDecision): RunPricing {
    if (this.deps.pricingFor) return this.deps.pricingFor(runModel);
    if (fast.kind === "applied")
      return tablePricingFor(runModel, this.deps.pricingTable?.() ?? BUILTIN_PRICING);
    return this.deps.pricing;
  }

  /**
   * The fast-mode decision as an audit row on the run (ADR 0057): applied, or ignored with the
   * reason ("API only" for a subscription or plan credits). Written only when the project's
   * flag met an Opus rung; a flag that changes nothing writes nothing.
   */
  private async auditFastMode(
    fast: Exclude<FastModeDecision, { kind: "off" }>,
    ids: RunIds,
    task: TaskRow,
    tier: ModelTier,
    choice: RunBillingChoice,
  ): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        session_id: ids.sessionId,
        run_id: ids.runId,
        agent_id: ids.agentId,
        human_id: ids.humanId,
        tool: FAST_MODE_AUDIT_TOOL,
        input_summary: JSON.stringify({
          taskId: task.id,
          projectId: task.project_id,
          runId: ids.runId,
          tier,
          model: fast.model,
          ...(fast.kind === "applied" ? { variant: fast.variant } : {}),
          sourceId: choice.sourceId,
          kind: choice.pick?.source.kind ?? null,
          driver: choice.driver,
        }),
        result_summary: fastModeAuditLine(fast),
        allowed: true,
        denied_reason: null,
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
      });
    } catch (e) {
      this.logger.error("fast-mode decision not audited", {
        runId: ids.runId,
        error: errorMessage(e),
      });
    }
  }

  /** The pick as an audit row on the run: the source, the driver and the router's reason. */
  private async auditPick(
    pick: TaskBillingPick,
    ids: RunIds,
    taskId: string,
    tier: ModelTier,
  ): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        session_id: ids.sessionId,
        run_id: ids.runId,
        agent_id: ids.agentId,
        human_id: pick.source.humanId,
        tool: BILLING_PICK_AUDIT_TOOL,
        input_summary: JSON.stringify({
          taskId,
          runId: ids.runId,
          agentId: ids.agentId,
          tier,
          sourceId: pick.source.id,
          kind: pick.source.kind,
          driver: pick.driver,
          ...(pick.plan?.share !== null && pick.plan ? { planUsageShare: pick.plan.share } : {}),
        }),
        result_summary: pick.reason,
        allowed: true,
        denied_reason: null,
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
      });
    } catch (e) {
      this.logger.error("billing pick not audited", { runId: ids.runId, error: errorMessage(e) });
    }
  }

  /**
   * The SDK run's allowlist: the registry's `cc:` names as written, minus `cc:Bash` unless the
   * composition opted into host commands (no sandbox lease covers the subprocess, ADR 0043
   * item 4). A withheld name is an audit row (`registry.tool_unmapped`), never silent.
   */
  private async sdkAllowedTools(
    spec: SpecialistSpec,
    sessionId: string,
    runId: string,
    agentId: string,
    humanId: string,
  ): Promise<string[]> {
    const bash = `${CLAUDE_CODE_PREFIX}Bash`;
    if (this.sdkDeps().hostCommands || !spec.allowedTools.includes(bash)) return spec.allowedTools;
    try {
      await this.deps.store.auditLog.append({
        session_id: sessionId,
        run_id: runId,
        agent_id: agentId,
        human_id: humanId,
        tool: TOOL_UNMAPPED_AUDIT,
        input_summary: `${spec.name}: ${bash}`,
        result_summary: "dropped (commands_not_allowed)",
        allowed: false,
        denied_reason:
          "tool_not_allowed: cc:Bash would run on the host where the Claude Code subprocess runs; no sandbox lease covers it (set sdk.hostCommands to allow it)",
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
      });
    } catch (e) {
      this.logger.warn("could not record the withheld tool", { runId, error: errorMessage(e) });
    }
    return spec.allowedTools.filter((t) => t !== bash);
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

  /**
   * Close a Run row whose run threw before the driver returned (outcome "error", duration,
   * why). The message is redacted first: it may carry what a lease, the vault or a driver
   * said, and the Run row is stored as it is.
   */
  private async endRunWithError(ids: RunIds, e: unknown, startedMono: number): Promise<void> {
    try {
      await this.deps.store.run.patch(ids.runId, {
        outcome: "error",
        duration_ms: wholeMs(this.deps.clock.monotonic() - startedMono),
        artifacts: [{ error: redact(errorMessage(e)) }],
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

/** The effort table with one mode's base effort replaced (an agent's override, ADR 0072). */
function withModeEffort(
  defaults: Record<Mode, ModeDefault> | undefined,
  mode: Mode,
  effort: EffortLevel,
): Record<Mode, ModeDefault> {
  const table = defaults ?? MODE_DEFAULTS;
  return { ...table, [mode]: { ...table[mode], effort } };
}
