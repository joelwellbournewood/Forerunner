import { fastModeVariantId } from "@forerunner/billing";
import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import { z } from "zod";
import { ContextPipeline, DEFAULT_CONTEXT_SETTINGS } from "../context/pipeline.ts";
import type { SessionBudget } from "../enforcement/budget.ts";
import type { EnforcementHooks, RunBilling, RunContext } from "../enforcement/hooks.ts";
import type { KillSwitch } from "../enforcement/killswitch.ts";
import type { SignedToken } from "../enforcement/token.ts";
import type { InjectionReport } from "../injection/scan.ts";
import type {
  ChatMessage,
  ContentBlock,
  EffortLevel,
  ModelProvider,
  ToolResultBlock,
  Usage,
} from "../provider/types.ts";
import { collectStream, providerCapabilities } from "../provider/types.ts";
import type { ToolRegistry, ToolSpec } from "./tools.ts";

/**
 * In-process agent loop over a ModelProvider. Used with the fake provider in tests and with
 * the Anthropic Messages adapter in production for specialists that do not need the full Claude
 * Code tool set. Every model call and tool call passes through EnforcementHooks.
 */
/** `max_tokens` per call when the run names none (the effort table's coding row, ADR 0072). */
export const DEFAULT_MAX_TOKENS_PER_CALL = 4096;

export interface RunPricing {
  estimate(inputTokens: number, maxOutputTokens: number): number;
  cost(usage: Usage): number;
}

export interface RunRequest {
  token: SignedToken;
  budget: SessionBudget;
  provider: ModelProvider;
  model: string;
  billingSourceId: string;
  /** How the run is billed (ADR 0044); absent: an API-style source. */
  billing?: RunBilling;
  system: string;
  messages: ChatMessage[];
  tools: ToolRegistry;
  pricing: RunPricing;
  timeoutMs: number;
  /** `max_tokens` of every call (spec D.4: the agent's or specialist's setting). Default 4096. */
  maxTokensPerCall?: number;
  /**
   * When set above `maxTokensPerCall`, each call's `max_tokens` is the largest value between
   * the two whose priced estimate (`pricing.estimate`) fits the room the hooks report
   * (`EnforcementHooks.callRoomUsdMicro`): the run cap less the run's spend; the session's
   * budget left and, while the session still takes new work, what stays below its 80%
   * no-new-work line (and, for work, its review reserve); and the outer caps' room
   * (`CapsPort.roomUsdMicro`: below their 80% lines, or their stop lines once past) when the
   * caps port reads one. So a cap above the floor never is refused, flips the session to
   * no-new-work, or raises an 80% warning the floor alone would not have. When even
   * `maxTokensPerCall` does not fit, the call asks for it and the hooks decide as they always
   * would. The ceiling is first clamped to the model's `max_tokens` limit when the provider
   * reports one within `MODEL_LIMIT_WAIT_MS` (`ModelProvider.maxOutputTokens`), so the ceiling
   * never raises a cap past that limit; a `maxTokensPerCall` above the limit is still sent as
   * asked. It must be a positive whole number. Used by the critic at effort max (ADR 0028,
   * amendments of 2026-10-26).
   */
  maxTokensCeiling?: number;
  effort?: EffortLevel;
  /**
   * Fast mode (spec D.20 and D.4; ADRs 0057 and 0072): every call of the run asks the provider
   * for `speed: "fast"` on `model`, and the run's records (the hooks' ledger rows, `run_start`)
   * name the variant `<model>-fast`. `pricing` must then be the variant's; the executor sets
   * both after `decideFastMode` applied it. The loop still drops the parameter for a provider
   * whose `fastMode` is not true.
   */
  speed?: "fast";
  /**
   * Sampling temperature (spec D.4): sent only when the provider's capabilities say
   * `acceptsTemperature`; dropped for every other provider (the Anthropic adapter is one).
   */
  temperature?: number;
  phase?: "work" | "review";
  /** Hard cap on model calls in this run (defence in depth under the session step cap). */
  maxTurns?: number;
  cwd?: string;
  maxToolResultChars?: number;
  onEvent?: (ev: RunEvent) => void;
  approvals?: Set<string>;
  label?: string;
  /** The human's own channel: survives scoped and global stops. */
  protected?: boolean;
  /**
   * The caller's stop (the model watch's evals when the daemon shuts down, ADR 0089): an abort
   * ends the run like the kill switch does (`killed`), and a signal already aborted makes no
   * model call at all.
   */
  signal?: AbortSignal;
  /**
   * Session-scoped context pipeline (ADR 0003): tool results are compressed in the live zone
   * before they join the transcript, by a compressor this run begins on it (cross-turn
   * references never leave the run). Default: a run-private pipeline with the default settings.
   */
  context?: ContextPipeline;
  /** "off" bypasses every transform (critic, evals, model watch): results stay byte-identical. */
  compression?: "default" | "off";
  /** Whether the session routed this run's calls through the Headroom proxy (recorded on the Run). */
  headroomUsed?: boolean;
}

/** Per-run context-layer measurement, recorded on the Run row (ADR 0003 section 3). */
export interface RunContextStats {
  /** Tool-result tokens as produced (estimated, counterfactual) and as sent. */
  tokensBefore: number;
  tokensAfter: number;
  saved: number;
  /** Distinct transform names applied in this run, first-use order. */
  transforms: string[];
  headroomUsed: boolean;
}

export type RunOutcome =
  | "completed"
  | "timeout"
  | "budget_exceeded"
  | "step_cap_exceeded"
  | "killed"
  | "needs_human"
  | "max_turns"
  | "error";

export type RunEvent =
  | { type: "run_start"; runId: string; model: string }
  | { type: "model_call_start"; turn: number; estimateUsdMicro: number }
  | { type: "text_delta"; text: string }
  | {
      type: "model_call_end";
      turn: number;
      usage: Usage;
      costUsdMicro: number;
      ttftMs: number;
      stopReason: string;
    }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      chars: number;
      isError: boolean;
      durationMs: number;
    }
  | { type: "tool_denied"; id: string; name: string; code: string; reason: string }
  | { type: "injection_flagged"; tool: string; report: InjectionReport }
  /** ADR 0003: the numbers of one compressed tool result; never its content. */
  | {
      type: "context_compressed";
      tool: string;
      tokensBefore: number;
      tokensAfter: number;
      transforms: string[];
    }
  | { type: "warning"; message: string }
  | { type: "run_end"; outcome: RunOutcome; costUsdMicro: number; steps: number };

export interface RunResult {
  runId: string;
  outcome: RunOutcome;
  finalText: string;
  messages: ChatMessage[];
  usage: Usage;
  costUsdMicro: number;
  modelCalls: number;
  toolCalls: number;
  ttftMs: number[];
  durationMs: number;
  error?: { code: string; message: string };
  pending?: string;
  injectionReports: InjectionReport[];
  /** True when the loop stopped because the session says finish current, no new work. */
  finishCurrent: boolean;
  context: RunContextStats;
}

export interface LoopDriverDeps {
  hooks: EnforcementHooks;
  kill: KillSwitch;
  clock: Clock;
}

const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/**
 * A millisecond measurement as the run table stores it: a whole, non-negative integer. The
 * `ttft_ms` and `duration_ms` columns are INTEGER and the store rejects a fractional value;
 * `performance.now()` differences are fractional, so every measurement is rounded where it is
 * produced (this driver) and again where it is written (the executor, the critic). Null for
 * anything that is not a finite number (no call was made).
 */
export function wholeMs(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms));
}

export class LoopAgentDriver {
  private readonly logger = log("agent-loop");

  constructor(private readonly deps: LoopDriverDeps) {}

  async run(req: RunRequest): Promise<RunResult> {
    const { clock } = this.deps;
    if (
      req.maxTokensCeiling !== undefined &&
      !(Number.isSafeInteger(req.maxTokensCeiling) && req.maxTokensCeiling > 0)
    ) {
      throw new ForerunnerError(
        "validation",
        `maxTokensCeiling must be a positive whole number, got ${String(req.maxTokensCeiling)}`,
      );
    }
    const claims = req.token.claims;
    const startedMono = clock.monotonic();
    const controller = new AbortController();
    const unregister = this.deps.kill.register({
      agentId: claims.agentId,
      sessionId: claims.sessionId,
      controller,
      label: req.label ?? `run ${claims.runId}`,
      protected: req.protected,
    });
    const runDeadlineMs = clock.now() + req.timeoutMs;
    const cancelTimeout = clock.setTimeout(
      () => controller.abort(new ForerunnerError("timeout", "run timeout")),
      req.timeoutMs,
    );
    const outer = req.signal;
    const onOuterAbort = () =>
      controller.abort(new ForerunnerError("killed", "run stopped by its caller"));
    if (outer?.aborted) onOuterAbort();
    else outer?.addEventListener("abort", onOuterAbort, { once: true });

    // The model the run's records name: the fast-mode variant when the run asks for it.
    const recordedModel = req.speed === "fast" ? fastModeVariantId(req.model) : req.model;
    const ctx: RunContext = {
      token: req.token,
      budget: req.budget,
      signal: controller.signal,
      runDeadlineMs,
      phase: req.phase ?? "work",
      model: recordedModel,
      provider: req.provider.name,
      billingSourceId: req.billingSourceId,
      ...(req.billing ? { billing: req.billing } : {}),
      approvals: req.approvals ?? new Set(),
      cwd: req.cwd,
    };

    const messages: ChatMessage[] = [...req.messages];
    const usage: Usage = { ...EMPTY_USAGE };
    let cost = 0;
    let modelCalls = 0;
    let toolCalls = 0;
    const ttfts: number[] = [];
    const reports: InjectionReport[] = [];
    let finalText = "";
    let outcome: RunOutcome = "completed";
    let error: RunResult["error"];
    let pending: string | undefined;
    let finishCurrent = false;
    const emit = (ev: RunEvent) => req.onEvent?.(ev);
    const toolDefs = req.tools.definitions(
      claims.allowedTools,
      (s) => z.toJSONSchema(s) as Record<string, unknown>,
    );
    const maxTurns = req.maxTurns ?? 100;
    const pipeline =
      req.context ??
      new ContextPipeline(DEFAULT_CONTEXT_SETTINGS, (t) => req.provider.countTokens(t));
    const contextMark = pipeline.mark();
    const bypass = req.compression ?? "default";
    const maxToolResultChars = req.maxToolResultChars ?? 60_000;
    // One compressor per run: a cross-turn reference can only name a result in this transcript.
    const compressor = pipeline.beginRun({ maxChars: maxToolResultChars });
    // What the provider accepts (ADR 0072): a temperature or a speed it does not take is never
    // sent, whatever the run asked for.
    const caps = providerCapabilities(req.provider);
    const sendSpeed = req.speed === "fast" && caps.fastMode;
    const sendTemperature = req.temperature !== undefined && caps.acceptsTemperature;

    // The run's output-cap ceiling, clamped to the model's limit on the first turn.
    let ceiling: number | undefined;

    emit({ type: "run_start", runId: claims.runId, model: recordedModel });
    try {
      for (let turn = 1; ; turn++) {
        if (turn > maxTurns) {
          outcome = "max_turns";
          break;
        }
        // Stopped between calls (the caller's signal, the kill switch, the timeout): no new call.
        if (controller.signal.aborted) throw controller.signal.reason;
        const inputTokens = req.provider.countTokens(
          req.system + JSON.stringify(messages) + JSON.stringify(toolDefs),
        );
        const floor = req.maxTokensPerCall ?? DEFAULT_MAX_TOKENS_PER_CALL;
        if (turn === 1 && req.maxTokensCeiling !== undefined) {
          ceiling = await clampToModelLimit(
            req.provider,
            req.model,
            req.maxTokensCeiling,
            controller.signal,
            clock,
          );
        }
        const maxOut =
          ceiling !== undefined && ceiling > floor
            ? fitMaxTokens(
                (n) => req.pricing.estimate(inputTokens, n),
                floor,
                ceiling,
                await this.deps.hooks.callRoomUsdMicro(ctx),
              )
            : floor;
        const estimate = req.pricing.estimate(inputTokens, maxOut);
        const pre = await this.deps.hooks.beforeModelCall(ctx, estimate);
        if (pre.decision === "finish_current" && !finishCurrent) {
          finishCurrent = true;
          emit({
            type: "warning",
            message: "budget at 80% or reserve reached: finish the current task, start nothing new",
          });
        }
        emit({ type: "model_call_start", turn, estimateUsdMicro: estimate });
        modelCalls++;
        const callStart = clock.monotonic();
        const response = await collectStream(
          this.tapText(
            req.provider.stream({
              model: req.model,
              system: req.system,
              messages,
              tools: toolDefs,
              max_tokens: maxOut,
              effort: req.effort,
              ...(sendSpeed ? { speed: "fast" as const } : {}),
              ...(sendTemperature ? { temperature: req.temperature } : {}),
              cache: { system: true, tools: true },
              compression: bypass,
              origin: {
                label: req.label ?? `run ${claims.runId}`,
                sessionId: claims.sessionId,
                runId: claims.runId,
              },
              signal: controller.signal,
            }),
            emit,
          ),
          () => callStart,
          () => clock.monotonic(),
        );
        if (response.stop_reason === "error") {
          if (controller.signal.aborted) {
            // A call cut off by the kill switch or the timeout was billed for what the provider
            // reported before the stop (the input side on message_start): it stays in the run's
            // usage and cost, as it did when the adapter ended a killed stream as complete.
            addUsage(usage, response.usage);
            cost += req.pricing.cost(response.usage);
            throw controller.signal.reason;
          }
          throw new ForerunnerError("provider_error", "model call failed", { retryable: true });
        }
        const callCost = req.pricing.cost(response.usage);
        addUsage(usage, response.usage);
        cost += callCost;
        // Whole milliseconds from here on: the Run row's timing columns are integers.
        const ttftMs = wholeMs(response.time_to_first_token_ms) ?? 0;
        ttfts.push(ttftMs);
        await this.deps.hooks.afterModelCall(ctx, response.usage, callCost);
        emit({
          type: "model_call_end",
          turn,
          usage: response.usage,
          costUsdMicro: callCost,
          ttftMs,
          stopReason: response.stop_reason,
        });

        messages.push({ role: "assistant", content: response.content });
        const text = response.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) finalText = text;

        const toolUses = response.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
        );
        if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
          if (response.stop_reason === "max_tokens") {
            emit({ type: "warning", message: "model hit max_tokens; output may be truncated" });
          }
          break;
        }

        const results: ToolResultBlock[] = [];
        let paused = false;
        let endRun = false;
        for (const call of toolUses) {
          toolCalls++;
          emit({ type: "tool_call", id: call.id, name: call.name, input: call.input });
          const spec = req.tools.get(call.name);
          const t0 = clock.monotonic();
          if (!spec) {
            const denied = `tool "${call.name}" does not exist`;
            emit({
              type: "tool_denied",
              id: call.id,
              name: call.name,
              code: "tool_not_allowed",
              reason: denied,
            });
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: denied,
              is_error: true,
            });
            continue;
          }
          let decision: Awaited<ReturnType<EnforcementHooks["beforeToolCall"]>>;
          try {
            decision = await this.deps.hooks.beforeToolCall(ctx, spec, call.input);
          } catch (e) {
            if (e instanceof ForerunnerError && isFatal(e.code)) throw e;
            const code = e instanceof ForerunnerError ? e.code : "internal";
            const reason = errorMessage(e);
            emit({ type: "tool_denied", id: call.id, name: call.name, code, reason });
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: `DENIED (${code}): ${reason}`,
              is_error: true,
            });
            continue;
          }
          if (!decision.allowed) {
            paused = true;
            pending = decision.reason;
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: `PENDING: ${decision.reason}`,
              is_error: true,
            });
            continue;
          }
          const execResult = await this.executeTool(spec, decision.input, {
            runId: claims.runId,
            sessionId: claims.sessionId,
            agentId: claims.agentId,
            humanId: claims.ownerHumanId,
            projectId: claims.projectId,
            taskId: claims.taskId,
            allowedPaths: claims.allowedPaths,
            signal: controller.signal,
            cwd: req.cwd,
            approvalKey: decision.approvalKey,
            approvalInput: decision.approvalInput,
          });
          if (execResult.endRun && !execResult.isError) endRun = true;
          const post = await this.deps.hooks.afterToolCall(ctx, spec, call.input, execResult);
          if (post.report?.suspicious) {
            reports.push(post.report);
            emit({ type: "injection_flagged", tool: call.name, report: post.report });
          }
          // Live-zone compression (ADR 0003): lossless first, lossy last, measured, never fatal.
          let produced = post.content;
          try {
            const c = compressor.compressToolResult(post.content, call.name, bypass);
            produced = c.text;
            if (c.record.tokensAfter < c.record.tokensBefore) {
              emit({
                type: "context_compressed",
                tool: call.name,
                tokensBefore: c.record.tokensBefore,
                tokensAfter: c.record.tokensAfter,
                transforms: c.record.transforms,
              });
            }
          } catch (e) {
            emit({ type: "warning", message: `context compression skipped: ${errorMessage(e)}` });
          }
          const limit = maxToolResultChars;
          const content =
            produced.length > limit
              ? `${produced.slice(0, limit)}\n…[truncated ${produced.length - limit} chars]`
              : produced;
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content,
            is_error: execResult.isError,
          });
          emit({
            type: "tool_result",
            id: call.id,
            name: call.name,
            chars: content.length,
            isError: !!execResult.isError,
            durationMs: wholeMs(clock.monotonic() - t0) ?? 0,
          });
        }
        messages.push({ role: "user", content: results });
        if (paused) {
          outcome = "needs_human";
          break;
        }
        // A tool said the run's work is done (`ToolResult.endRun`): no further call is made.
        if (endRun) break;
      }
    } catch (e) {
      const code = e instanceof ForerunnerError ? e.code : "internal";
      outcome = outcomeFor(code, controller.signal);
      error = { code, message: errorMessage(e) };
      if (outcome === "error")
        this.logger.error("run failed", { runId: claims.runId, error: error.message });
    } finally {
      cancelTimeout();
      outer?.removeEventListener("abort", onOuterAbort);
      unregister();
    }
    emit({ type: "run_end", outcome, costUsdMicro: cost, steps: modelCalls + toolCalls });
    const measured = pipeline.savings(contextMark);
    return {
      context: {
        tokensBefore: measured.tokensBefore,
        tokensAfter: measured.tokensAfter,
        saved: measured.saved,
        transforms: measured.transforms,
        headroomUsed: req.headroomUsed ?? false,
      },
      runId: claims.runId,
      outcome,
      finalText,
      messages,
      usage,
      costUsdMicro: cost,
      modelCalls,
      toolCalls,
      ttftMs: ttfts,
      durationMs: wholeMs(clock.monotonic() - startedMono) ?? 0,
      error,
      pending,
      injectionReports: reports,
      finishCurrent,
    };
  }

  private async *tapText(
    stream: AsyncIterable<import("../provider/types.ts").StreamEvent>,
    emit: (ev: RunEvent) => void,
  ) {
    for await (const ev of stream) {
      if (ev.type === "text_delta") emit({ type: "text_delta", text: ev.text });
      yield ev;
    }
  }

  private async executeTool(
    spec: ToolSpec,
    input: unknown,
    ctx: import("./tools.ts").ToolExecutionContext,
  ) {
    const timeoutMs = spec.timeoutMs ?? 5 * 60 * 1000;
    const ac = new AbortController();
    const onAbort = () => ac.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const cancel = this.deps.clock.setTimeout(
      () => ac.abort(new ForerunnerError("timeout", `tool ${spec.name} timed out`)),
      timeoutMs,
    );
    try {
      const result = await Promise.race([
        spec.execute(input, { ...ctx, signal: ac.signal }),
        new Promise<never>((_, reject) =>
          ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true }),
        ),
      ]);
      return result;
    } catch (e) {
      if (ctx.signal.aborted)
        throw ctx.signal.reason instanceof Error
          ? ctx.signal.reason
          : new ForerunnerError("killed", "run aborted");
      return { content: `ERROR: ${errorMessage(e)}`, isError: true };
    } finally {
      cancel();
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}

/** How long the loop waits for the provider's model limit before it goes on without a clamp. */
export const MODEL_LIMIT_WAIT_MS = 5_000;

/**
 * A run's ceiling no higher than the provider's `max_tokens` limit for the model, when the
 * provider reports one (`ModelProvider.maxOutputTokens`). A failed or absent read, or one that
 * takes longer than `MODEL_LIMIT_WAIT_MS`, leaves the ceiling as it is. The read is handed the
 * run's signal and raced against it: a run stopped or timed out while it waits ends at once.
 */
async function clampToModelLimit(
  provider: ModelProvider,
  model: string,
  ceiling: number,
  signal: AbortSignal,
  clock: Clock,
): Promise<number> {
  if (!provider.maxOutputTokens) return ceiling;
  if (signal.aborted) throw signal.reason;
  let cancelWait = () => {};
  let onAbort = () => {};
  const read = Promise.resolve()
    .then(() => provider.maxOutputTokens?.(model, { signal }))
    .catch(() => undefined);
  const waited = new Promise<undefined>((resolve) => {
    cancelWait = clock.setTimeout(() => resolve(undefined), MODEL_LIMIT_WAIT_MS);
  });
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let limit: number | undefined;
  try {
    limit = await Promise.race([read, waited, aborted]);
  } finally {
    cancelWait();
    signal.removeEventListener("abort", onAbort);
  }
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0
    ? Math.min(ceiling, limit)
    : ceiling;
}

/**
 * The largest output cap in [floor, ceiling] whose estimate fits `room` (micro-USD), or the
 * floor when nothing fits (the precheck then refuses the call). `estimate` must not decrease
 * as the cap grows, which a price per output token guarantees.
 */
export function fitMaxTokens(
  estimate: (maxOut: number) => number,
  floor: number,
  ceiling: number,
  room: number,
): number {
  if (estimate(ceiling) <= room) return ceiling;
  if (estimate(floor) > room) return floor;
  let lo = floor;
  let hi = ceiling;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimate(mid) <= room) lo = mid;
    else hi = mid;
  }
  return lo;
}

function addUsage(total: Usage, u: Usage): void {
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  total.cache_read_input_tokens += u.cache_read_input_tokens;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens;
}

function isFatal(code: string): boolean {
  return ["budget_exceeded", "step_cap_exceeded", "timeout", "killed"].includes(code);
}

function outcomeFor(code: string, signal: AbortSignal): RunOutcome {
  if (code === "budget_exceeded") return "budget_exceeded";
  if (code === "step_cap_exceeded") return "step_cap_exceeded";
  if (code === "timeout") return "timeout";
  if (code === "killed") return "killed";
  if (signal.aborted) {
    const r = signal.reason;
    if (r instanceof ForerunnerError && r.code === "timeout") return "timeout";
    return "killed";
  }
  return "error";
}
