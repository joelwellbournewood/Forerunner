import type { BillingSourceKind, PricingTable } from "@forerunner/billing";
import { BUILTIN_PRICING } from "@forerunner/billing";
import { type Clock, errorMessage, ForerunnerError, log, newId } from "@forerunner/platform";
import {
  type ContextPipeline,
  decideFastMode,
  type EffortLevel,
  FAST_MODE_AUDIT_TOOL,
  type FastModeDecision,
  fastModeAuditLine,
  fastModeOf,
  type LadderRung,
  type LoopAgentDriver,
  type Mode,
  type ModeDefault,
  type ModelTier,
  type ProviderRegistry,
  RUN_PERSIST_FAILED_AUDIT_TOOL,
  type RunEvent,
  type RunPricing,
  type RunResult,
  type SessionBudget,
  type SignedToken,
  type TokenIssuer,
  ToolRegistry,
  type ToolSpec,
  wholeMs,
} from "@forerunner/runtime";
import type {
  FindingRow,
  FindingStatus,
  JsonObject,
  JsonValue,
  RiskLevel,
  StateStore,
} from "@forerunner/state";
import { docDriftFor } from "./docs-drift.ts";
import { type RenderOptions, renderEvidence, subjectLabel } from "./evidence.ts";
import { fingerprintOf } from "./fingerprint.ts";
import { SIGNOFF_OPTIONS, signoffCard } from "./followup.ts";
import {
  type CriticModelPick,
  type CriticSettings,
  criticSettingsOf,
  pickCriticModel,
  stricterCeiling,
} from "./model.ts";
import { patternsFor } from "./patterns.ts";
import {
  applyVerdictRules,
  type EscalationGrounds,
  maxSeverity,
  type RuledVerdict,
} from "./rules.ts";
import {
  confidenceOf,
  parseReviewFromText,
  SUBMIT_REVIEW_DESCRIPTION,
  SUBMIT_REVIEW_TOOL,
  type SubmitReview,
  type SubmitReviewInput,
  SubmitReviewSchema,
  severityOf,
} from "./schema.ts";
import {
  fileSessionReviewRequest,
  loadSessionReviewData,
  reviewSession,
  type SessionChecks,
  type SessionReviewData,
  sessionChecks,
} from "./session-review.ts";
import {
  type CheckCommand,
  type CheckRunner,
  findingForFailedCheck,
  ranCheckLine,
  reviewTier0,
  runChecks,
} from "./tier0.ts";
import type {
  ReviewFinding,
  ReviewInput,
  ReviewOutcome,
  ReviewOutput,
  ReviewTier,
  RuleAdjustment,
  Verdict,
} from "./types.ts";

/**
 * The critic service (spec H, ADR 0028). One entry point, `review(input, ctx)`:
 *
 * - tier 0 runs the automated checks and no model (for a session subject: the deterministic
 *   session checks);
 * - tiers 1 to 3 pick the model from the spec table (capped by the project ceiling, read from
 *   the project row when the caller gives no settings), issue a capability token for the critic
 *   agent that allows exactly one tool (`submit_review`), and run the registry critic prompt
 *   over a clean context: system = the registry prompt, user = the rendered evidence and
 *   nothing else; tiers 2 and 3 first run the task's check commands (H.2 "tests run") and put
 *   the results in that evidence;
 * - the verdict comes back through the tool (or, as a fallback, as the JSON object the prompt
 *   describes), the code rules in rules.ts decide what it may be, failed required checks and
 *   unmet criteria become findings, doc drift is checked at tier 2+, and everything is
 *   persisted: a Run row for the critic call, the Review row, Finding rows with fingerprints,
 *   the sign-off request for tier 3 or a human verdict, the resolution of earlier findings, and
 *   lesson proposals for findings repeated across sessions.
 *
 * Every limit (budget, steps, wall clock, tools) is enforced by the runtime hooks the driver
 * calls; the critic adds nothing a prompt could loosen.
 */

/** Output tokens per critic call at every effort but `max` (`CriticDeps.maxTokensPerCall` overrides). */
export const REVIEW_TOKENS_PER_CALL = 8192;

/**
 * At effort `max` the first call's `max_tokens` grows from `REVIEW_TOKENS_PER_CALL` up to this
 * ceiling, as far as the room left for the review pays for it at the loop's full-cap price
 * (`RunRequest.maxTokensCeiling`: run, session below its 80% line, human and project caps,
 * clamped to the model's output limit), and the verdict ends the run (`ToolResult.endRun`): no closing
 * call is priced after it. The live D.15 run of 2026-10-25 ended both tier 3 reviews (Opus 5.5,
 * effort max) at 8192 with no verdict. ADR 0028, amendment of 2026-10-26.
 */
export const MAX_EFFORT_TOKENS_CEILING = 24_000;

/**
 * Run outcomes that only refuse further calls. After `submit_review` captured a verdict, the
 * call they refused was not needed, so the review is completed (the Run row keeps the run's
 * own outcome). A timeout, a kill or an error still name the review.
 */
const REFUSALS_AFTER_VERDICT: ReadonlySet<RunResult["outcome"]> = new Set([
  "budget_exceeded",
  "step_cap_exceeded",
  "max_turns",
]);

export interface CriticPromptSource {
  /** The markdown role prompt (registry critic/critic.md body). */
  prompt: string;
  /** `<name>@<semver>+<sha8>`; every Run row stores it (spec D). */
  promptVersion: string;
  max_effort?: EffortLevel;
}

export interface CriticDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  driver: LoopAgentDriver;
  providers: ProviderRegistry;
  /** Provider the critic runs on; "anthropic" in production, "fake" in tests. */
  providerName: string;
  prompt: CriticPromptSource;
  pricing: (modelId: string) => RunPricing;
  billingSourceId: string;
  /** The critic AgentRow id: author of every row the critic writes and sender of its messages. */
  criticAgentId: string;
  ladder?: LadderRung[];
  modeDefaults?: Record<Mode, ModeDefault>;
  /** When given, evidence passes through it with bypass "off" so the records show no compression. */
  context?: ContextPipeline;
  checkRunner?: CheckRunner;
  render?: RenderOptions;
  /** Model calls allowed per review. Default 3: the review call, the tool result, a closing turn. */
  maxTurns?: number;
  maxTokensPerCall?: number;
  /**
   * Opus fast mode (spec D.20, ADR 0057): the billing facts the per-review decision needs
   * besides the project's `fast_mode` flag, read at every review: the kind of the source the
   * critic is billed to (`billingSourceId`; null for an API-style source the composition
   * does not name) and the price table in force (the variant needs its own row). Absent: an
   * API-style source and the built-in table, as for the executor without a billing port.
   */
  fastMode?: () => Promise<CriticFastModeFacts> | CriticFastModeFacts;
}

/** What the critic's fast-mode decision reads from the composition (ADR 0057). */
export interface CriticFastModeFacts {
  sourceKind: BillingSourceKind | null;
  pricing: PricingTable;
}

export interface ReviewContext {
  /** The session's token: the critic token copies its ids and never exceeds its budget or expiry. */
  sessionToken: SignedToken;
  budget: SessionBudget;
  /**
   * The project's settings object. Undefined: the service reads the project row named by the
   * token. Null: no settings (the ladder defaults apply).
   */
  projectSettings?: JsonObject | null;
  /** A ceiling for this review; the stricter of it and the project's `critic_ceiling` applies (D.3). */
  ceiling?: ModelTier;
  effortOffset?: -1 | 0 | 1;
  /** Cap for this review run; the session token's budget is the hard upper bound. */
  budgetUsdMicro?: number;
  /** Overrides the tier's default timeout (tier 1 keeps its 30 s target unless set). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** False skips every write (calibration). Default true. */
  persist?: boolean;
  /**
   * The task's check commands, run in `cwd` through the check runner at tiers 0, 2 and 3
   * before the review; their results join `evidence.checkResults`. Tier 1 is a light read
   * under 30 s and does not run commands: it records that in the evidence instead.
   */
  checks?: CheckCommand[];
  cwd?: string;
  /** Human to address a sign-off request to. Default: the session token's owner. */
  humanId?: string | null;
  onEvent?: (ev: RunEvent) => void;
}

const SYSTEM_SUFFIX =
  "\n\n## Returning the review\n\nCall the `submit_review` tool exactly once with the complete " +
  "review. Text outside the tool is kept only as a rationale.";

/**
 * Audit row written when the rules changed what the model returned (ADR 0042): the review,
 * the task, the tier and every adjustment (rule, from, to, reason); never the evidence.
 */
export const VERDICT_ADJUSTED_AUDIT_TOOL = "critic.verdict_adjusted";

const RISK_OF_SEVERITY: Record<string, RiskLevel> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
  info: "low",
};

export class CriticService {
  private readonly logger = log("critic");

  constructor(private readonly deps: CriticDeps) {}

  async review(input: ReviewInput, ctx: ReviewContext): Promise<ReviewOutput> {
    validateInput(input);
    const persist = ctx.persist !== false;
    if (input.tier === 0) {
      if (input.subject.kind === "session") {
        return reviewSession({
          store: this.deps.store,
          sessionId: input.subject.sessionId,
          criticAgentId: this.deps.criticAgentId,
          clock: this.deps.clock,
          tier: 0,
          persist,
          humanId: ctx.humanId ?? ctx.sessionToken.claims.ownerHumanId,
        });
      }
      const out = await reviewTier0({
        evidence: input.evidence,
        checks: ctx.checks,
        cwd: ctx.cwd,
        runner: this.deps.checkRunner,
        clock: this.deps.clock,
        signal: ctx.signal,
      });
      return persist ? this.persist(input, ctx, out, { openFindings: [], resolved: [] }) : out;
    }
    return this.modelReview(input, ctx, persist);
  }

  /**
   * The settings a review runs under: the context's `projectSettings` when given (null means
   * none), else the project row of the token's project; the context's own ceiling and offset
   * are folded in, and of two ceilings the stricter one wins (D.3). Read from the store so a
   * caller that forgets the settings cannot raise the critic above the project's ceiling.
   */
  async settingsFor(
    ctx: Pick<ReviewContext, "sessionToken" | "projectSettings" | "ceiling" | "effortOffset">,
  ): Promise<CriticSettings> {
    return mergeSettings({ ...ctx, projectSettings: await this.projectSettingsOf(ctx) });
  }

  /** The project's settings object a review runs under (see `settingsFor`). */
  private async projectSettingsOf(
    ctx: Pick<ReviewContext, "sessionToken" | "projectSettings">,
  ): Promise<JsonObject | null> {
    if (ctx.projectSettings !== undefined) return ctx.projectSettings;
    const projectId = ctx.sessionToken.claims.projectId;
    return projectId ? ((await this.deps.store.project.get(projectId))?.settings ?? null) : null;
  }

  /**
   * Opus fast mode for this review (spec D.20, ADR 0057): the project's flag on an Opus pick
   * goes fast on an API-style source and a provider that offers it; the same rules as a
   * specialist run (`decideFastMode`), on the loop driver the critic always uses.
   */
  private async fastModeFor(
    pick: CriticModelPick,
    projectSettings: JsonObject | null,
    provider: { name: string; fastMode?: boolean },
  ): Promise<{ decision: FastModeDecision; sourceKind: BillingSourceKind | null }> {
    const enabled = fastModeOf(projectSettings);
    if (!enabled || pick.tier !== "opus") return { decision: { kind: "off" }, sourceKind: null };
    const facts = (await this.deps.fastMode?.()) ?? {
      sourceKind: null,
      pricing: BUILTIN_PRICING,
    };
    const decision = decideFastMode({
      enabled,
      tier: pick.tier,
      model: pick.model,
      driver: "loop",
      sourceKind: facts.sourceKind,
      provider,
      pricing: facts.pricing,
    });
    return { decision, sourceKind: facts.sourceKind };
  }

  /**
   * The model that would review at this tier for this context (for plans and the UI), from the
   * settings in the context alone; `settingsFor` adds the project row.
   */
  modelFor(
    tier: Exclude<ReviewTier, 0>,
    ctx: Pick<ReviewContext, "projectSettings" | "ceiling" | "effortOffset" | "timeoutMs">,
  ): CriticModelPick {
    return this.pickFor(tier, mergeSettings(ctx), ctx.timeoutMs);
  }

  private pickFor(
    tier: Exclude<ReviewTier, 0>,
    settings: CriticSettings,
    timeoutMs?: number,
  ): CriticModelPick {
    return pickCriticModel(tier, {
      provider: this.deps.providerName,
      ceiling: settings.ceiling,
      effortOffset: settings.effortOffset,
      maxEffort: this.deps.prompt.max_effort,
      ladder: this.deps.ladder,
      modeDefaults: this.deps.modeDefaults,
      timeoutMs,
    });
  }

  private async modelReview(
    input: ReviewInput,
    ctx: ReviewContext,
    persist: boolean,
  ): Promise<ReviewOutput> {
    const { clock, store } = this.deps;
    const tier = input.tier as Exclude<ReviewTier, 0>;
    const t0 = clock.monotonic();
    const projectSettings = await this.projectSettingsOf(ctx);
    const pick = this.pickFor(tier, mergeSettings({ ...ctx, projectSettings }), ctx.timeoutMs);
    if (ctx.timeoutMs !== undefined) pick.timeoutMs = ctx.timeoutMs;
    const provider = this.deps.providers.get(this.deps.providerName);
    // Fast mode (spec D.20, ADR 0057): the run's records and price name the variant.
    const { decision: fast, sourceKind } = await this.fastModeFor(pick, projectSettings, provider);
    const runModel = fast.kind === "applied" ? fast.variant : pick.model;
    const parent = this.deps.tokens.verify(ctx.sessionToken, clock.now());
    const runId = newId(clock.now());
    const taskId = input.subject.kind === "task" ? input.subject.taskId : undefined;

    // Earlier open findings on the task: shown to the critic, resolved by its verdict.
    const openFindings: FindingRow[] = persist && taskId ? await store.finding.openFor(taskId) : [];
    // Session subject: the deterministic checks (plan, cost, honesty) join the model's findings,
    // and the facts they checked (plan, summary, spend) are what the model reads.
    const sessionData =
      input.subject.kind === "session"
        ? await loadSessionReviewData(store, input.subject.sessionId)
        : null;
    const sessionCode: SessionChecks | null = sessionData ? sessionChecks(sessionData) : null;
    let effective = sessionData ? withSessionEvidence(input, sessionData) : input;

    // Tiers 2 and 3 run the task's checks (H.2 "full review with tests run") before the model
    // reads: the results join the evidence, so a failed check is a finding and the model sees
    // the output. Tier 1 is a light read under its 30 s target and only notes the commands.
    const preEvidence: string[] = [];
    const checks = ctx.checks ?? [];
    if (checks.length > 0 && tier >= 2) {
      const ran = await runChecks(checks, {
        cwd: ctx.cwd,
        runner: this.deps.checkRunner,
        signal: ctx.signal,
      });
      effective = {
        ...effective,
        evidence: {
          ...effective.evidence,
          checkResults: [...(effective.evidence.checkResults ?? []), ...ran],
        },
      };
      preEvidence.push(...ran.map(ranCheckLine));
    } else if (checks.length > 0) {
      preEvidence.push(
        `checks: ${checks.length} command(s) not run at tier 1 (light read); pass checkResults or review at tier 2`,
      );
      // The critic is told which commands were not run and that this is the tier's design,
      // so it grades the diff by reading instead of escalating for "missing" check results.
      effective = {
        ...effective,
        evidence: {
          ...effective.evidence,
          checksNotRun: [
            ...(effective.evidence.checksNotRun ?? []),
            ...checks.map((c) => `${c.name}: ${c.argv.join(" ")}`),
          ],
        },
      };
    }

    const rendered = renderEvidence(
      effective,
      { openFindings },
      { ...this.deps.render, pipeline: this.deps.render?.pipeline ?? this.deps.context },
    );
    // The critic's own token: the session's ids and budget, one tool, nothing else (H.1).
    const token = this.deps.tokens.issue({
      runId,
      sessionId: parent.sessionId,
      agentId: this.deps.criticAgentId,
      ownerHumanId: parent.ownerHumanId,
      projectId: parent.projectId,
      taskId: taskId ?? parent.taskId,
      allowedTools: [SUBMIT_REVIEW_TOOL],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: Math.min(ctx.budgetUsdMicro ?? parent.budgetUsdMicro, parent.budgetUsdMicro),
      depth: Math.min(parent.depth + 1, parent.maxDepth),
      maxDepth: parent.maxDepth,
      autonomy: parent.autonomy,
      planApproved: parent.planApproved,
      expiresAt: new Date(
        Math.min(new Date(parent.expiresAt).getTime(), clock.now() + pick.timeoutMs),
      ).toISOString(),
    });

    let captured: SubmitReview | null = null;
    // Effort max (tier 3 on Opus, or tier 2 raised by the slider): the verdict ends the run and
    // the first call's cap is sized from the review's budget. Every other effort is unchanged.
    const maxEffort = pick.effort === "max";
    const tools = new ToolRegistry().register(
      submitReviewTool(
        (r) => {
          if (!captured) captured = r;
        },
        { endRun: maxEffort },
      ),
    );
    const label = subjectLabel(input.subject);
    if (fast.kind !== "off") {
      if (persist)
        await this.auditFastMode(fast, { runId, taskId, tier, pick, parent, sourceKind });
      if (fast.kind === "ignored")
        ctx.onEvent?.({
          type: "warning",
          message: `fast mode is on for this project but this review stays at the standard speed: ${fast.reason}`,
        });
    }

    let result: RunResult;
    try {
      result = await this.deps.driver.run({
        token,
        budget: ctx.budget,
        provider,
        model: pick.model,
        billingSourceId: this.deps.billingSourceId,
        system: `${this.deps.prompt.prompt}${SYSTEM_SUFFIX}`,
        messages: [{ role: "user", content: rendered.text }],
        tools,
        pricing: this.deps.pricing(runModel),
        ...(fast.kind === "applied" ? { speed: "fast" as const } : {}),
        timeoutMs: pick.timeoutMs,
        maxTurns: this.deps.maxTurns ?? 3,
        maxTokensPerCall: this.deps.maxTokensPerCall ?? REVIEW_TOKENS_PER_CALL,
        ...(maxEffort ? { maxTokensCeiling: MAX_EFFORT_TOKENS_CEILING } : {}),
        effort: pick.effort,
        phase: "review",
        label: `critic tier ${tier} on ${label}`,
        onEvent: ctx.onEvent,
        // ADR 0003: every critic call bypasses the context layer's compression, on the session
        // pipeline when one is wired so its records show the bypass.
        context: this.deps.context,
        compression: "off",
      });
    } catch (e) {
      // The driver reports limits as outcomes; anything that still throws is an internal error.
      this.logger.error("critic run threw", { error: errorMessage(e), runId });
      result = failedRun(runId, errorMessage(e));
    }

    const verdictCaptured = (captured as SubmitReview | null) !== null;
    const submitted: SubmitReview | null = captured ?? parseReviewFromText(result.finalText);
    // A limit that refused a call after the verdict was captured refused a call the review did
    // not need: the review completed with that verdict.
    const refusedAfterVerdict = verdictCaptured && REFUSALS_AFTER_VERDICT.has(result.outcome);
    const outcome: ReviewOutcome =
      result.outcome === "completed" || refusedAfterVerdict
        ? submitted
          ? "completed"
          : "no_verdict"
        : runOutcomeOf(result.outcome);

    const built = this.buildVerdict(effective, submitted, outcome, result, sessionCode, {
      unavailable: rendered.unavailable,
      limits: effective.evidence.limits ?? [],
      outcome,
    });
    const output: ReviewOutput = {
      ...built,
      model: runModel,
      tier,
      durationMs: Math.max(0, Math.round(clock.monotonic() - t0)),
      costUsdMicro: result.costUsdMicro,
      outcome,
      patterns: [],
      lessonProposals: [],
      promptVersion: this.deps.prompt.promptVersion,
      runId,
    };
    output.evidence.push(
      ...preEvidence,
      `prompt:${this.deps.prompt.promptVersion}`,
      `run:${runId}`,
    );
    if (refusedAfterVerdict) {
      output.evidence.push(
        `run: ${result.outcome} after the verdict was recorded (a call after submit_review was refused)`,
      );
    }
    if (rendered.compression.length) {
      output.evidence.push(
        `context: ${rendered.compression.length} evidence block(s) sent uncompressed (bypass)`,
      );
    }
    if (tier === 1 && output.durationMs > pick.targetMs) {
      output.evidence.push(`timing: ${output.durationMs} ms, over the ${pick.targetMs} ms target`);
    }
    if (!persist) return output;

    // A Run row for the critic call (spec D: every run stores model, settings, prompt version).
    try {
      await store.run.insert({
        id: runId,
        task_id: taskId ?? null,
        session_id: parent.sessionId,
        specialist: "critic",
        model: runModel,
        provider: provider.name,
        effort: pick.effort,
        prompt_version: this.deps.prompt.promptVersion,
        billing_source_id: this.deps.billingSourceId,
        tokens_in: result.usage.input_tokens,
        tokens_out: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_input_tokens,
        cache_write_tokens: result.usage.cache_creation_input_tokens,
        cost_usd_micro: result.costUsdMicro,
        // Integers only: the timing columns are INTEGER and the store rejects a fraction.
        ttft_ms: wholeMs(result.ttftMs[0]),
        duration_ms: wholeMs(result.durationMs),
        outcome: result.outcome,
        depth: token.claims.depth,
        timed_out: result.outcome === "timeout",
        tokens_before_compression: rendered.compression.reduce((s, r) => s + r.tokensBefore, 0),
        tokens_after_compression: rendered.compression.reduce((s, r) => s + r.tokensAfter, 0),
        author_agent: this.deps.criticAgentId,
      });
    } catch (e) {
      // The review is not lost because its Run row was refused (the first live run lost every
      // critic Run row to a fractional `ttft_ms`, silently): the Review and Finding rows are
      // still written below, and the failure is logged and audited with the run id and the
      // store's message. The prompt and the evidence never enter either.
      const error = errorMessage(e);
      this.logger.error("critic run row not persisted", { runId, error });
      try {
        await store.auditLog.append({
          session_id: parent.sessionId,
          run_id: runId,
          agent_id: this.deps.criticAgentId,
          human_id: parent.ownerHumanId,
          tool: RUN_PERSIST_FAILED_AUDIT_TOOL,
          input_summary: JSON.stringify({ runId, specialist: "critic", tier }),
          result_summary: error,
          allowed: false,
          denied_reason: error,
          cost_usd_micro: 0,
          occurred_at: clock.nowIso(),
        });
      } catch (auditError) {
        this.logger.error("critic run persist failure not audited", {
          runId,
          error: errorMessage(auditError),
        });
      }
    }
    return this.persist(input, ctx, output, {
      openFindings,
      resolved: submitted?.resolved ?? [],
    });
  }

  /**
   * The fast-mode decision as an audit row on the review's run (ADR 0057), as the executor
   * writes one for a specialist run: applied, or ignored with the reason ("API only" for a
   * subscription or plan credits). A failed append is logged, never fatal to the review.
   */
  private async auditFastMode(
    fast: Exclude<FastModeDecision, { kind: "off" }>,
    at: {
      runId: string;
      taskId: string | undefined;
      tier: ReviewTier;
      pick: CriticModelPick;
      parent: { sessionId: string; ownerHumanId: string; projectId?: string };
      sourceKind: BillingSourceKind | null;
    },
  ): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        session_id: at.parent.sessionId,
        run_id: at.runId,
        agent_id: this.deps.criticAgentId,
        human_id: at.parent.ownerHumanId,
        tool: FAST_MODE_AUDIT_TOOL,
        input_summary: JSON.stringify({
          specialist: "critic",
          taskId: at.taskId ?? null,
          projectId: at.parent.projectId ?? null,
          runId: at.runId,
          reviewTier: at.tier,
          tier: at.pick.tier,
          model: fast.model,
          ...(fast.kind === "applied" ? { variant: fast.variant } : {}),
          sourceId: this.deps.billingSourceId,
          kind: at.sourceKind,
          driver: "loop",
        }),
        result_summary: fastModeAuditLine(fast),
        allowed: true,
        denied_reason: null,
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
      });
    } catch (e) {
      this.logger.error("critic fast-mode decision not audited", {
        runId: at.runId,
        error: errorMessage(e),
      });
    }
  }

  /** Turn what the model returned into findings and a ruled verdict; conservative when it returned nothing. */
  private buildVerdict(
    input: ReviewInput,
    submitted: SubmitReview | null,
    outcome: ReviewOutcome,
    result: RunResult,
    sessionCode: SessionChecks | null,
    grounds: EscalationGrounds,
  ): Pick<
    ReviewOutput,
    "grade" | "confidence" | "verdict" | "findings" | "evidence" | "summary" | "adjustments"
  > {
    const e = input.evidence;
    const findings: ReviewFinding[] = [];
    const evidence: string[] = [];
    const seen = new Set<string>();
    const add = (f: Omit<ReviewFinding, "fingerprint">) => {
      const fp = fingerprintOf(f.description);
      if (fp && seen.has(fp)) return;
      seen.add(fp);
      findings.push({ ...f, fingerprint: fp });
    };

    let grade = 0;
    let confidence = 0;
    let verdict: Verdict = "escalate";
    let summary: string;
    if (!submitted) {
      const why =
        outcome === "no_verdict"
          ? "the critic returned no structured verdict"
          : `the critic run ended with ${outcome}${result.error ? `: ${result.error.message}` : ""}`;
      summary = `No review: ${why}.`;
      add({
        severity: "high",
        description: `Critic review did not complete (${outcome})`,
        requiredAction: "Re-run the review; escalate if it fails again",
      });
    } else {
      grade = submitted.grade;
      confidence = confidenceOf(submitted.confidence);
      verdict = submitted.verdict;
      summary = submitted.summary;
      for (const f of submitted.findings) {
        add({
          severity: severityOf(f.severity),
          description: f.what,
          requiredAction: f.required_action ?? `Fix: ${f.what}`,
          where: f.where ?? f.how_to_see,
        });
      }
      for (const c of submitted.criteria) {
        evidence.push(
          `[${c.met ? "met" : "unmet"}] ${c.text}${c.evidence ? ` — ${c.evidence}` : ""}`,
        );
        if (!c.met && !findings.some((f) => f.description.includes(c.text))) {
          add({
            severity: "high",
            description: `Acceptance criterion not met: ${c.text}`,
            requiredAction: `Meet the criterion and show the evidence: ${c.text}`,
            where: c.evidence,
          });
        }
      }
      evidence.push(...submitted.evidence, ...submitted.checks_run.map((c) => `ran: ${c}`));
      if (submitted.doc_drift && !/^\s*none\s*\.?\s*$/i.test(submitted.doc_drift)) {
        add({
          severity: "medium",
          description: `Doc drift: ${submitted.doc_drift}`,
          requiredAction: "Bring the maintainer doc back in line with the change",
        });
      }
    }

    // A failed required check blocks accept at every tier (B.4), whatever the model said.
    for (const r of e.checkResults ?? []) {
      if (!r.passed) add(findingForFailedCheck(r));
    }

    if (input.tier >= 2) {
      const mods = e.moduleFilesTouched ?? e.changedFiles ?? [];
      const docs = e.docsTouched ?? (e.changedFiles ?? []).filter((f) => f.startsWith("docs/"));
      const drift = docDriftFor(mods, docs, e.docsWaiver);
      for (const m of drift.waived ? [] : drift.missing) {
        add({
          severity: "medium",
          description: `Doc drift: ${m.module} changed without its maintainer doc (${m.docs.join(" or ")})`,
          requiredAction: `Update ${m.docs.length === 1 ? m.docs[0] : `one of ${m.docs.join(", ")}`} in the same change, or write "docs: none needed: <reason>" in the PR body`,
          where: m.files.join(", "),
        });
      }
      evidence.push(
        drift.waived
          ? "docs: waived by the PR body"
          : `docs: ${drift.missing.length === 0 ? "no drift" : `${drift.missing.length} module(s) without their doc`}`,
      );
    }

    if (sessionCode) {
      for (const f of sessionCode.findings) add(f);
      evidence.push(...sessionCode.evidence);
      // The deterministic checks bound the grade; a model cannot grade a dishonest summary up.
      grade = Math.min(grade, sessionCode.grade);
      if (sessionCode.verdict === "human") verdict = "human";
    }

    const ruled = applyVerdictRules(
      { grade, confidence, verdict, findings, escalation: submitted?.escalation ?? null, grounds },
      input.tier,
    );
    if (ruled.escalation) {
      evidence.push(
        ruled.escalation.qualifies
          ? `escalate: ${ruled.escalation.ground}`
          : `escalate not qualified: ${ruled.escalation.why}`,
      );
    }
    // A revise or escalate that names no finding would leave the retry nothing to act on, so
    // the summary becomes one. Only when the model asked for changes or a rule found the work
    // short (grade below the accept line): a clean result that a rule sends on anyway (tier 3
    // sign-off, low confidence) has nothing wrong with it, and an invented finding would block
    // the close after the human accepts (B.4).
    if (findings.length === 0 && needsFallbackFinding(ruled)) {
      add({
        severity: "medium",
        description: summary || "The critic asked for changes without naming a finding",
        requiredAction: "Address the critic's summary and resubmit",
      });
    }
    return {
      grade: ruled.grade,
      confidence: ruled.confidence,
      verdict: ruled.verdict,
      findings,
      evidence,
      summary,
      adjustments: ruled.adjustments,
    };
  }

  /** Review row, finding rows, resolutions, sign-off request, patterns and lesson proposals. */
  private async persist(
    input: ReviewInput,
    ctx: ReviewContext,
    out: ReviewOutput,
    extra: { openFindings: FindingRow[]; resolved: string[] },
  ): Promise<ReviewOutput> {
    const { store, clock } = this.deps;
    const claims = ctx.sessionToken.claims;
    const taskId = input.subject.kind === "task" ? input.subject.taskId : null;
    const sessionId = input.subject.kind === "session" ? input.subject.sessionId : claims.sessionId;
    const review = await store.review.insert({
      task_id: taskId,
      session_id: sessionId,
      critic_model: out.model,
      tier: out.tier,
      grade: out.grade,
      confidence: out.confidence,
      verdict: out.verdict,
      evidence: out.evidence as JsonValue[],
      summary: out.summary,
      author_agent: this.deps.criticAgentId,
    });
    // What the code changed about the model's answer is an outward action of its own (ADR
    // 0042): one audit row per review that carries every adjustment, never the evidence.
    if (out.adjustments.length > 0) {
      try {
        await store.auditLog.append({
          session_id: claims.sessionId,
          run_id: out.runId ?? null,
          agent_id: this.deps.criticAgentId,
          human_id: claims.ownerHumanId,
          tool: VERDICT_ADJUSTED_AUDIT_TOOL,
          input_summary: JSON.stringify({
            reviewId: review.id,
            taskId,
            tier: out.tier,
            adjustments: out.adjustments,
          }),
          result_summary: `verdict ${out.verdict} (model said ${out.adjustments[0]?.from ?? out.verdict})`,
          allowed: true,
          denied_reason: null,
          cost_usd_micro: 0,
          occurred_at: clock.nowIso(),
        });
      } catch (e) {
        this.logger.warn("could not audit the verdict adjustment", {
          reviewId: review.id,
          error: errorMessage(e),
        });
      }
    }
    // An accepting review's findings are notes the critic chose not to require action on
    // (the rules keep anything medium or above from accepting); they are stored as wontfix so
    // they never block close yet still count for patterns. Everything else is open until resolved.
    const status: FindingStatus = out.verdict === "accept" ? "wontfix" : "open";
    const findingIds: string[] = [];
    for (const f of out.findings) {
      const row = await store.finding.insert({
        review_id: review.id,
        task_id: taskId,
        severity: f.severity,
        description: f.description,
        required_action: f.requiredAction,
        status,
        fingerprint: f.fingerprint,
        author_agent: this.deps.criticAgentId,
      });
      findingIds.push(row.id);
    }
    // Earlier findings: an accept resolves them all (the critic saw them and accepted the
    // rework); otherwise only the ones the critic listed as resolved.
    const resolvedIds: string[] = [];
    const toResolve =
      out.verdict === "accept"
        ? extra.openFindings
        : extra.openFindings.filter((f) => extra.resolved.includes(f.id));
    for (const f of toResolve) {
      await store.finding.resolve(f.id, f.version, input.evidence.runId ?? null);
      resolvedIds.push(f.id);
    }

    // A lesson subject has nothing to sign off, so no blocking request is filed (spec G.6);
    // the runtime retires the proposal on a human verdict as on any other completed
    // non-accepting one and tells the human why (ADR 0059).
    let humanRequestId: string | undefined;
    // A session subject has no task to sign off: its request is the session review's own,
    // whose options each do something (U-033; it had the task sign-off's options and no card).
    const reviewedSession =
      out.verdict === "human" && input.subject.kind === "session"
        ? await store.session.get(input.subject.sessionId)
        : undefined;
    if (reviewedSession) {
      const req = await fileSessionReviewRequest(store, {
        session: reviewedSession,
        humanId: ctx.humanId ?? claims.ownerHumanId,
        criticAgentId: this.deps.criticAgentId,
        reviewId: review.id,
        grade: out.grade,
        summary: out.summary,
        findings: out.findings,
        findingIds,
      });
      humanRequestId = req.id;
    } else if (out.verdict === "human" && input.subject.kind !== "lesson") {
      const worst = maxSeverity(out.findings);
      const req = await store.humanRequest.insert({
        human_id: ctx.humanId === undefined ? claims.ownerHumanId : ctx.humanId,
        project_id: claims.projectId ?? null,
        task_id: taskId,
        session_id: sessionId,
        kind: "approval",
        why: `Critic sign-off needed (tier ${out.tier}, grade ${out.grade}, confidence ${out.confidence.toFixed(2)}): ${out.summary}`.slice(
          0,
          4000,
        ),
        steps: out.findings.map((f) => `[${f.severity}] ${f.description}: ${f.requiredAction}`),
        options: [...SIGNOFF_OPTIONS],
        blocking: true,
        risk: worst ? RISK_OF_SEVERITY[worst] : "medium",
        // The card the runtime's sign-off sync applies the answer through (a task subject).
        change_card: taskId
          ? signoffCard({
              taskId,
              reviewId: review.id,
              runId: input.evidence.runId ?? null,
              findingIds,
              reason: "verdict",
            })
          : null,
        author_agent: this.deps.criticAgentId,
      });
      humanRequestId = req.id;
    }

    // Patterns: fingerprints seen in at least two sessions become lesson proposals (H.5).
    const { patterns, lessonProposals } = await patternsFor(store, out.findings);

    // The event lives with the subject: the reviewed session for a session review (as the
    // tier 0 path does), the token's session for a task review.
    try {
      await store.event.append(
        sessionId,
        "critic.review",
        {
          reviewId: review.id,
          subject: input.subject,
          tier: out.tier,
          grade: out.grade,
          confidence: out.confidence,
          verdict: out.verdict,
          findings: out.findings.length,
          adjustments: out.adjustments.map((a) => ({ rule: a.rule, from: a.from, to: a.to })),
          model: out.model,
          costUsdMicro: out.costUsdMicro,
          durationMs: out.durationMs,
          at: clock.nowIso(),
        } as JsonValue,
        out.costUsdMicro,
      );
    } catch (e) {
      this.logger.warn("could not append the review event", { error: errorMessage(e) });
    }

    return {
      ...out,
      reviewId: review.id,
      findingIds,
      resolvedFindingIds: resolvedIds,
      humanRequestId,
      patterns,
      lessonProposals,
    };
  }
}

/**
 * The critic's one tool. With `endRun` the recorded verdict ends the run (`ToolResult.endRun`),
 * so no closing call follows; without it the model gets one more call to stop, as before.
 */
export function submitReviewTool(
  onSubmit: (review: SubmitReview) => void,
  opts: { endRun?: boolean } = {},
): ToolSpec<SubmitReview> {
  return {
    name: SUBMIT_REVIEW_TOOL,
    description: SUBMIT_REVIEW_DESCRIPTION,
    schema: SubmitReviewSchema as unknown as ToolSpec<SubmitReview>["schema"],
    actionClass: "read",
    risk: "low",
    async execute(input: SubmitReview | SubmitReviewInput) {
      onSubmit(SubmitReviewSchema.parse(input));
      return {
        content: "Review recorded. You may stop now.",
        ...(opts.endRun ? { endRun: true } : {}),
      };
    },
  };
}

/** The context's settings object and its own ceiling and offset, folded into one (stricter ceiling wins). */
function mergeSettings(
  ctx: Pick<ReviewContext, "projectSettings" | "ceiling" | "effortOffset">,
): CriticSettings {
  const project = criticSettingsOf(ctx.projectSettings);
  const out: CriticSettings = {};
  const ceiling = stricterCeiling(ctx.ceiling, project.ceiling);
  if (ceiling !== undefined) out.ceiling = ceiling;
  const effortOffset = ctx.effortOffset ?? project.effortOffset;
  if (effortOffset !== undefined) out.effortOffset = effortOffset;
  return out;
}

/**
 * Whether a verdict with no finding needs one synthesised from the summary: a revise the model
 * chose, or one the grade rule made (the work fell short). Not a verdict a rule produced from a
 * clean accept (low confidence), not an escalate that stands on its ground (a high finding is
 * already a finding; low confidence, missing evidence or a limit say nothing is wrong with the
 * work, and an invented open finding would block the close after the human accepts, B.4), and
 * never a human sign-off.
 */
export function needsFallbackFinding(
  ruled: Pick<RuledVerdict, "verdict" | "adjustments" | "escalation">,
): boolean {
  if (ruled.verdict !== "revise" && ruled.verdict !== "escalate") return false;
  if (ruled.escalation?.qualifies) return false;
  return !ruled.adjustments.some((a) => a.rule === "low_confidence");
}

function validateInput(input: ReviewInput): void {
  if (![0, 1, 2, 3].includes(input.tier)) {
    throw new ForerunnerError(
      "validation",
      `review tier must be 0, 1, 2 or 3; got ${String(input.tier)}`,
    );
  }
  const subject = input.subject as { kind?: unknown } | undefined;
  const subjectId =
    subject?.kind === "task"
      ? (subject as { taskId?: unknown }).taskId
      : subject?.kind === "session"
        ? (subject as { sessionId?: unknown }).sessionId
        : subject?.kind === "lesson"
          ? (subject as { lessonId?: unknown }).lessonId
          : undefined;
  if (typeof subjectId !== "string" || subjectId.length === 0) {
    throw new ForerunnerError(
      "validation",
      "review subject must be a task, a session or a lesson with its id",
    );
  }
  if (!Array.isArray(input.evidence?.acceptanceCriteria)) {
    throw new ForerunnerError("validation", "evidence.acceptanceCriteria must be an array");
  }
}

/** A session review reads what the code checked unless the caller supplied its own view. */
function withSessionEvidence(input: ReviewInput, data: SessionReviewData): ReviewInput {
  const e = input.evidence;
  return {
    ...input,
    evidence: {
      ...e,
      sessionPlan: e.sessionPlan ?? data.session.plan,
      sessionSummary: e.sessionSummary ?? data.session.summary,
      sessionCostUsdMicro:
        e.sessionCostUsdMicro ?? data.ledgerUsdMicro ?? data.session.spent_usd_micro,
      sessionEstimateUsdMicro: e.sessionEstimateUsdMicro ?? data.planEstimateUsdMicro,
    },
  };
}

function runOutcomeOf(outcome: RunResult["outcome"]): ReviewOutcome {
  switch (outcome) {
    case "timeout":
    case "budget_exceeded":
    case "step_cap_exceeded":
    case "killed":
      return outcome;
    default:
      return "error";
  }
}

function failedRun(runId: string, message: string): RunResult {
  return {
    runId,
    outcome: "error",
    finalText: "",
    messages: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    costUsdMicro: 0,
    modelCalls: 0,
    toolCalls: 0,
    ttftMs: [],
    durationMs: 0,
    error: { code: "internal", message },
    injectionReports: [],
    finishCurrent: false,
    context: { tokensBefore: 0, tokensAfter: 0, saved: 0, transforms: [], headroomUsed: false },
  };
}

export type { RuleAdjustment };
