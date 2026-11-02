import { type Clock, errorMessage, ForerunnerError, log, redact } from "@forerunner/platform";
import type { SessionBudget } from "../enforcement/budget.ts";
import type { EnforcementHooks, RunBilling, RunContext } from "../enforcement/hooks.ts";
import type { KillSwitch } from "../enforcement/killswitch.ts";
import type { SignedToken } from "../enforcement/token.ts";
import type { EffortLevel, Usage } from "../provider/types.ts";
import {
  isClaudeCodeUsageLimit,
  rejectedRateLimitOf,
  USAGE_LIMIT_CODE,
} from "../provider/usage-limit.ts";
import type { RunEvent, RunOutcome, RunPricing } from "./loop.ts";
import type { ToolRegistry, ToolSpec } from "./tools.ts";

/**
 * Claude Agent SDK driver. Used for specialists that need the Claude Code tool set inside a
 * sandboxed worktree and for subscription billing. The same EnforcementHooks run as
 * PreToolUse / PostToolUse hooks; maxBudgetUsd and maxTurns from the token are a second layer.
 *
 * The SDK module is imported lazily so unit tests never spawn the Claude Code subprocess.
 */
export interface SdkRunRequest {
  token: SignedToken;
  budget: SessionBudget;
  billingSourceId: string;
  /** How the run is billed (ADR 0044): "subscription" rows with the plan share on this path. */
  billing?: RunBilling;
  /**
   * Exactly one credential, chosen by the billing router: the subscription's token. An API key
   * is refused (`assertSubscriptionCredential`, U-078, ADR 0100): it always goes straight to
   * the API, where promotional API credits apply; through Claude Code they do not.
   */
  credential: { kind: "api_key" | "oauth_token"; value: string };
  model: string;
  effort?: EffortLevel;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  /** Claude Code built-in tools to allow (subset of token.allowedTools that start with "cc:"). */
  tools: ToolRegistry;
  pricing: RunPricing;
  timeoutMs: number;
  maxTurns?: number;
  phase?: "work" | "review";
  onEvent?: (ev: RunEvent) => void;
  baseURL?: string;
  /**
   * Extra subprocess environment from the session's context layer (`headroomSdkEnv`:
   * `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS`, ADR 0003). Applied after the
   * credential; never a credential itself.
   */
  env?: Record<string, string>;
  label?: string;
  /**
   * The caller's stop (the session runner's hold on the task, U-039): an abort ends the run
   * like the kill switch does (`killed`), and a signal already aborted ends it at once.
   */
  signal?: AbortSignal;
  /**
   * A task's run: the text it hears once, as PostToolUse's `additionalContext`, after its next
   * call would take it past its wrap-up line (`WRAP_UP_TEXT`, ADR 0111).
   */
  wrapUp?: string;
}

export interface SdkRunResult {
  runId: string;
  outcome: RunOutcome;
  finalText: string;
  usage: Usage;
  costUsdMicro: number;
  /** Cost as reported by the SDK (list price basis), for comparison with our ledger. */
  sdkCostUsd: number;
  numTurns: number;
  durationMs: number;
  ttftMs: number | null;
  sessionId: string | null;
  /**
   * `resetAt`: a `provider_usage_limit` with the reset time Claude Code reported (ADR 0100).
   * `level` and `source`: a budget stop's refusal (`details.level` and `details.source` of the
   * hooks' `budget_exceeded`; "run" for Claude Code's own `error_max_budget_usd`), so the
   * executor names the limit that stopped it (ADR 0111).
   */
  error?: { code: string; message: string; resetAt?: string; level?: string; source?: string };
  /** The run was told to wrap up (`SdkRunRequest.wrapUp`, ADR 0111). */
  wrapUpSent: boolean;
}

/** The wrap-up of one SDK run: due once the hooks said so, given by the next PostToolUse. */
interface WrapUpState {
  text?: string;
  due: boolean;
  sent: boolean;
}

export interface SdkDriverDeps {
  hooks: EnforcementHooks;
  kill: KillSwitch;
  clock: Clock;
  /** Test seam: replaces the SDK's query function. */
  queryImpl?: QueryLike;
}

// A structural subset of the SDK's query() so tests can inject a fake without the real module.
// The real one returns a `Query`, whose `close()` ends the Claude Code process at once.
export type QueryLike = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>> & { close?: () => void };

/**
 * How long a run that stopped for any reason but the kill switch waits for Claude Code to exit
 * after its abort (budget-stop, ADR 0111). The SDK ends its process on the abort (SIGTERM, and
 * SIGKILL five seconds later); a process still there after this is ended with `close()`, and the
 * run then waits at most `SDK_CLOSE_WAIT_MS` more. Stop now ends the wait at once.
 */
export const SDK_STOP_WAIT_MS = 15_000;
export const SDK_CLOSE_WAIT_MS = 5_000;

/**
 * Claude Code's own spending limit (`maxBudgetUsd`) sits this much above the run's cap, so
 * Forerunner's own stop, which refuses the call that would go over, comes first; Claude Code's
 * figure is a second layer that prices the calls its own way.
 */
export function claudeCodeBudgetUsd(runCapUsdMicro: number): number {
  return Math.max(0.01, Math.ceil(runCapUsdMicro * 1.1 + 10_000) / 1_000_000);
}

/** Claude Code tool names are prefixed in our allowlists so they never collide with Forerunner tools. */
export const CC_TOOL_PREFIX = "cc:";

/**
 * The SDK driver runs Claude Code, so it takes the subscription's token and nothing else
 * (U-078, ADR 0100): an `api_key` credential, or an Anthropic API key handed over as a token,
 * is refused before anything starts. An API key always goes straight to the Messages API
 * (the loop driver), where promotional API credits apply.
 */
export function assertSubscriptionCredential(credential: SdkRunRequest["credential"]): void {
  const looksLikeKey = /^sk-ant-(?!oat)/.test(credential.value.trim());
  if (credential.kind !== "oauth_token" || looksLikeKey) {
    throw new ForerunnerError(
      "provider_auth",
      "An API key never runs through Claude Code: it goes straight to the API, where promotional API credits apply. Only the Claude subscription's token runs here.",
      { details: { credentialKind: credential.kind } },
    );
  }
}

export class SdkAgentDriver {
  private readonly logger = log("agent-sdk");

  constructor(private readonly deps: SdkDriverDeps) {}

  async run(req: SdkRunRequest): Promise<SdkRunResult> {
    assertSubscriptionCredential(req.credential);
    const { clock } = this.deps;
    const claims = req.token.claims;
    const controller = new AbortController();
    const registration = {
      agentId: claims.agentId,
      sessionId: claims.sessionId,
      // A person's move of the task stops this run (`KillSwitch.stopTask`, U-039).
      ...(claims.taskId ? { taskId: claims.taskId } : {}),
      label: req.label ?? `sdk run ${claims.runId}`,
    };
    let unregister = this.deps.kill.register({ ...registration, controller });
    const started = clock.monotonic();
    const cancelTimeout = clock.setTimeout(
      () => controller.abort(new ForerunnerError("timeout", "run timeout")),
      req.timeoutMs,
    );
    const outer = req.signal;
    const onOuterAbort = () =>
      controller.abort(new ForerunnerError("killed", "run stopped by its caller"));
    if (outer?.aborted) onOuterAbort();
    else outer?.addEventListener("abort", onOuterAbort, { once: true });
    const ctx: RunContext = {
      token: req.token,
      budget: req.budget,
      signal: controller.signal,
      runDeadlineMs: clock.now() + req.timeoutMs,
      phase: req.phase ?? "work",
      model: req.model,
      provider: "anthropic-sdk",
      billingSourceId: req.billingSourceId,
      ...(req.billing ? { billing: req.billing } : {}),
      approvals: new Set(),
      cwd: req.cwd,
    };
    const emit = (ev: RunEvent) => req.onEvent?.(ev);
    const ccTools = claims.allowedTools
      .filter((t) => t.startsWith(CC_TOOL_PREFIX))
      .map((t) => t.slice(CC_TOOL_PREFIX.length));
    const mcpTools = claims.allowedTools.filter((t) => !t.startsWith(CC_TOOL_PREFIX));

    let outcome: RunOutcome = "completed";
    let finalText = "";
    let usage: Usage = { ...ZERO_USAGE };
    let cost = 0;
    let sdkCostUsd = 0;
    let numTurns = 0;
    let ttftMs: number | null = null;
    let sessionId: string | null = null;
    let error: SdkRunResult["error"];
    // Claude Code's report that the subscription's limit rejects calls, and a failed turn's
    // error kind (ADR 0100); read together once the stream ends.
    let rejected: { resetAt?: string } | null = null;
    let sdkError: { kind: string; text: string } | null = null;
    // Usage is counted once per API message (budget-stop, ADR 0111): the messages of parallel
    // tool calls share one id and one usage, and a streamed message's output count is a
    // placeholder, which the result's totals correct.
    const counted = new Set<string>();
    // The wrap-up (ADR 0111): due when the hooks answer `wrap_up`, given once by PostToolUse.
    const wrap: WrapUpState = {
      ...(req.wrapUp ? { text: req.wrapUp } : {}),
      due: false,
      sent: false,
    };
    const decided = (d: Awaited<ReturnType<EnforcementHooks["beforeModelCall"]>>) => {
      if (d.line) emit({ type: "budget_line", ...d.line });
      if (d.decision === "wrap_up" && wrap.text && !wrap.sent) wrap.due = true;
    };

    /** Book one share of usage: the ledger row and the session's spend (the hooks). */
    const book = async (turnUsage: Usage, stopReason: string): Promise<Usage> => {
      const turnCost = req.pricing.cost(turnUsage);
      usage = addUsage(usage, turnUsage);
      cost += turnCost;
      await this.deps.hooks.afterModelCall(ctx, turnUsage, turnCost);
      emit({
        type: "model_call_end",
        turn: numTurns,
        usage: turnUsage,
        costUsdMicro: turnCost,
        ttftMs: ttftMs ?? 0,
        stopReason,
      });
      return turnUsage;
    };
    /**
     * One message from Claude Code. `enforce`: a new model call follows, so the hooks decide
     * whether it may start (they throw at a cap); while the run stops it only books what came.
     */
    const handle = async (msg: Record<string, unknown>, enforce: boolean): Promise<void> => {
      const type = msg.type as string;
      if (type === "system" && msg.subtype === "init")
        sessionId = (msg.session_id as string) ?? null;
      if (type === "stream_event") {
        const ev = msg.event as
          | { type?: string; delta?: { type?: string; text?: string } }
          | undefined;
        if (
          ev?.type === "content_block_delta" &&
          ev.delta?.type === "text_delta" &&
          ev.delta.text
        ) {
          if (ttftMs === null) ttftMs = Math.round(clock.monotonic() - started);
          emit({ type: "text_delta", text: ev.delta.text });
        }
      }
      if (type === "assistant") {
        const m = msg.message as
          | {
              id?: string;
              content?: { type: string; text?: string }[];
              usage?: Record<string, number>;
            }
          | undefined;
        const text = (m?.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (text) finalText = text;
        const u = m?.usage;
        const id = typeof m?.id === "string" && m.id ? m.id : null;
        if (u && !(id && counted.has(id))) {
          if (id) counted.add(id);
          numTurns++;
          const turnUsage = await book(usageOf(u), "turn");
          // Enforce before the SDK makes its next call.
          if (enforce)
            decided(
              await this.deps.hooks.beforeModelCall(
                ctx,
                req.pricing.estimate(turnUsage.input_tokens, 4096),
              ),
            );
        }
      }
      rejected = rejectedRateLimitOf(msg) ?? rejected;
      if (type === "assistant" && typeof msg.error === "string") {
        const m = msg.message as { content?: { type: string; text?: string }[] } | undefined;
        sdkError = {
          kind: msg.error,
          text: (m?.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join(""),
        };
      }
      if (type === "result") {
        sdkCostUsd = (msg.total_cost_usd as number) ?? 0;
        // The totals Claude Code reports for the whole query: what the messages did not count
        // (the real output, a subagent's calls) is booked now as one more share.
        const total = resultTotals(msg);
        const rest = total ? usageLeft(total, usage) : null;
        if (rest) await book(rest, "result");
        if (msg.subtype === "error_max_budget_usd") {
          // Claude Code's own spending limit (`maxBudgetUsd`, set above the run's cap): a stop
          // at the run's budget, never a passing error the runner would try again at once.
          outcome = "budget_exceeded";
          error = {
            code: "budget_exceeded",
            message: "Claude Code reached its spending limit for this run",
            level: "run",
          };
        } else if (msg.is_error) {
          outcome = "error";
          error = {
            code: "provider_error",
            message: String(msg.result ?? msg.subtype ?? "sdk error"),
          };
        }
        if (typeof msg.result === "string" && msg.result) finalText = msg.result;
      }
    };

    let query: ReturnType<QueryLike> | undefined;
    let iterator: AsyncIterator<Record<string, unknown>> | undefined;
    // The read in flight: kept when the abort won the race, so no message is lost.
    let pending: Promise<IteratorResult<Record<string, unknown>>> | null = null;
    let exited = false;
    try {
      // Pre-flight: the first model call is accounted like any other; the SDK then reports usage
      // per assistant message, which we account turn by turn.
      const preflight = await this.deps.hooks.beforeModelCall(
        ctx,
        req.pricing.estimate(ctx.budget.limits.stepCap, 4096),
      );
      emit({ type: "run_start", runId: claims.runId, model: req.model });
      decided(preflight);

      const queryFn = this.deps.queryImpl ?? (await loadSdkQuery());
      // The subscription's token only (refused above otherwise); the session's extra variables
      // (the Headroom proxy) never carry another way to authenticate.
      const env: Record<string, string | undefined> = {
        ...scrubEnv(process.env),
        CLAUDE_CODE_OAUTH_TOKEN: req.credential.value,
        ...(req.baseURL ? { ANTHROPIC_BASE_URL: req.baseURL } : {}),
        ...withoutClaudeCodeAuth(req.env ?? {}),
      };
      const hooks = this.sdkHooks(ctx, req.tools, emit, wrap);
      const options: Record<string, unknown> = {
        abortController: controller,
        cwd: req.cwd,
        additionalDirectories: [],
        model: req.model,
        effort: req.effort,
        systemPrompt: { type: "custom", prompt: req.systemPrompt },
        allowedTools: [...ccTools, ...mcpTools.map((t) => `mcp__forerunner__${t}`)],
        permissionMode: "dontAsk",
        maxTurns: req.maxTurns ?? 60,
        maxBudgetUsd: claudeCodeBudgetUsd(claims.budgetUsdMicro),
        env,
        hooks,
        includePartialMessages: true,
        persistSession: false,
        settingSources: [],
        allowDangerouslySkipPermissions: false,
      };
      // The kill switch, the timeout and every stop abort the controller; the SDK then tears
      // its subprocess down. A stop of the kill switch ends the run at once (its 2 s promise);
      // every other stop waits below until the process has exited.
      query = queryFn({ prompt: req.prompt, options });
      iterator = query[Symbol.asyncIterator]();
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => {
          const reason = controller.signal.reason;
          reject(reason instanceof Error ? reason : new ForerunnerError("killed", "run killed"));
        };
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      aborted.catch(() => undefined);
      for (;;) {
        pending ??= iterator.next();
        const next = await Promise.race([pending, aborted]);
        pending = null;
        if (next.done) {
          exited = true;
          break;
        }
        await handle(next.value, true);
      }
      // The subscription's usage limit stopped the run (ADR 0100): a stable code with the
      // reset time Claude Code reported, so the executor rests the source and gives the task
      // back without counting an attempt.
      const failedTurn = sdkError as { kind: string; text: string } | null;
      if (
        failedTurn &&
        isClaudeCodeUsageLimit(failedTurn.kind, failedTurn.text, rejected !== null)
      ) {
        const limit = rejected as { resetAt?: string } | null;
        outcome = "error";
        error = {
          code: USAGE_LIMIT_CODE,
          message: `The Claude subscription's usage limit is reached${failedTurn.text ? `: ${failedTurn.text}` : ""}`,
          ...(limit?.resetAt ? { resetAt: limit.resetAt } : {}),
        };
      }
    } catch (e) {
      const code = e instanceof ForerunnerError ? e.code : "internal";
      outcome =
        code === "budget_exceeded"
          ? "budget_exceeded"
          : code === "step_cap_exceeded"
            ? "step_cap_exceeded"
            : code === "timeout"
              ? "timeout"
              : code === "killed" || controller.signal.aborted
                ? "killed"
                : "error";
      const details = e instanceof ForerunnerError ? e.details : {};
      error = {
        code,
        message: errorMessage(e),
        ...(typeof details.level === "string" ? { level: details.level } : {}),
        ...(typeof details.source === "string" ? { source: details.source } : {}),
      };
      if (outcome === "error")
        this.logger.error("sdk run failed", { runId: claims.runId, error: error.message });
    } finally {
      cancelTimeout();
      outer?.removeEventListener("abort", onOuterAbort);
    }
    if (iterator && !exited) {
      // The run stopped while Claude Code still ran: the abort ends it, and every hook refuses
      // from the abort on (the run's signal), so it can start no tool.
      if (!controller.signal.aborted)
        controller.abort(
          new ForerunnerError(
            outcome === "budget_exceeded" ? "budget_exceeded" : "killed",
            error?.message ?? "run stopped",
          ),
        );
      if (outcome === "killed") {
        // The kill switch, a person's move of the task or the caller: the run ends at once and
        // the subprocess winds down in the background (the kill switch's 2 s promise).
        const it = iterator;
        void Promise.resolve()
          .then(() => it.return?.(undefined))
          .catch(() => undefined);
      } else {
        // Every other stop (a budget, the time limit, an error): the run returns only once
        // Claude Code has exited, so nothing it does is left uncounted or out of reach. Stop now
        // reaches it meanwhile and ends it at once.
        unregister();
        unregister = await this.awaitExit(iterator, pending, query, registration, (m) =>
          handle(m, false),
        );
      }
    }
    // The run is over: a hook call that still arrives for it is refused.
    this.deps.hooks.endRun(ctx);
    unregister();
    emit({ type: "run_end", outcome, costUsdMicro: cost, steps: numTurns });
    return {
      runId: claims.runId,
      outcome,
      finalText,
      usage,
      costUsdMicro: cost,
      sdkCostUsd,
      numTurns,
      durationMs: Math.round(clock.monotonic() - started),
      ttftMs,
      sessionId,
      error,
      wrapUpSent: wrap.sent,
    };
  }

  /**
   * Wait for Claude Code to exit after a stop (budget-stop, ADR 0111): what it still sends is
   * read and its usage booked (`late`), for at most `SDK_STOP_WAIT_MS`; then `close()` ends the
   * process and the run waits at most `SDK_CLOSE_WAIT_MS` more. Meanwhile the run is registered
   * with the kill switch again, so Stop now (or a person's move of the task) ends the wait at
   * once with `close()`. Returns the registration's unregister.
   */
  private async awaitExit(
    iterator: AsyncIterator<Record<string, unknown>>,
    pending: Promise<IteratorResult<Record<string, unknown>>> | null,
    query: { close?: () => void } | undefined,
    registration: { agentId: string; sessionId: string; taskId?: string; label: string },
    late: (msg: Record<string, unknown>) => Promise<void>,
  ): Promise<() => void> {
    const { clock, kill } = this.deps;
    const force = new AbortController();
    const unregister = kill.register({
      ...registration,
      controller: force,
      label: `${registration.label} (stopping)`,
    });
    const drained = (async () => {
      let next = pending;
      for (;;) {
        const r = await (next ?? iterator.next());
        next = null;
        if (r.done) return;
        // Booking may fail once the run's token is revoked (Stop all); the run stops anyway.
        await late(r.value).catch(() => undefined);
      }
    })().catch(() => undefined);
    const wait = (ms: number) =>
      new Promise<"waited">((resolve) => {
        const cancel = clock.setTimeout(() => resolve("waited"), ms);
        void drained.then(cancel);
      });
    const forced = new Promise<"forced">((resolve) => {
      if (force.signal.aborted) resolve("forced");
      else force.signal.addEventListener("abort", () => resolve("forced"), { once: true });
    });
    const first = await Promise.race([
      drained.then(() => "exited" as const),
      wait(SDK_STOP_WAIT_MS),
      forced,
    ]);
    if (first !== "exited") {
      this.logger.warn("claude code did not exit after the stop; ending it", {
        label: registration.label,
        why: first,
      });
      try {
        query?.close?.();
      } catch {
        // Already closed.
      }
      void Promise.resolve()
        .then(() => iterator.return?.(undefined))
        .catch(() => undefined);
      await Promise.race([drained, wait(SDK_CLOSE_WAIT_MS)]);
    }
    return unregister;
  }

  /** Map our hooks onto the SDK's PreToolUse / PostToolUse. */
  private sdkHooks(
    ctx: RunContext,
    tools: ToolRegistry,
    emit: (ev: RunEvent) => void,
    wrap: WrapUpState = { due: false, sent: false },
  ) {
    // PostToolUse reports the input the tool ran with, which is the `updatedInput` PreToolUse
    // returned: the resolved secret values. The audit row must carry the model's input (the
    // `secret:<name>` references), so it is kept per tool_use_id between the two hooks.
    const rawInputs = new Map<string, unknown>();
    const remember = (id: string, raw: unknown) => {
      if (!id) return;
      if (rawInputs.size >= RAW_INPUTS_MAX) {
        const oldest = rawInputs.keys().next().value;
        if (oldest !== undefined) rawInputs.delete(oldest);
      }
      rawInputs.set(id, raw);
    };
    const pre = async (input: Record<string, unknown>) => {
      const toolName = String(input.tool_name ?? "");
      const spec = resolveSpec(tools, toolName);
      try {
        const d = await this.deps.hooks.beforeToolCall(ctx, spec, input.tool_input);
        if (!d.allowed) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: d.reason,
            },
          };
        }
        remember(String(input.tool_use_id ?? ""), input.tool_input);
        emit({
          type: "tool_call",
          id: String(input.tool_use_id ?? ""),
          name: toolName,
          input: input.tool_input,
        });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: d.input,
          },
        };
      } catch (e) {
        const code = e instanceof ForerunnerError ? e.code : "internal";
        emit({
          type: "tool_denied",
          id: String(input.tool_use_id ?? ""),
          name: toolName,
          code,
          reason: errorMessage(e),
        });
        if (["budget_exceeded", "step_cap_exceeded", "timeout", "killed"].includes(code)) {
          return { continue: false, stopReason: `${code}: ${errorMessage(e)}` };
        }
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${code}: ${errorMessage(e)}`,
          },
        };
      }
    };
    const post = async (input: Record<string, unknown>) => {
      const toolName = String(input.tool_name ?? "");
      const spec = resolveSpec(tools, toolName);
      const useId = String(input.tool_use_id ?? "");
      const modelInput = rawInputs.has(useId) ? rawInputs.get(useId) : input.tool_input;
      rawInputs.delete(useId);
      const raw =
        typeof input.tool_response === "string"
          ? input.tool_response
          : JSON.stringify(input.tool_response ?? "");
      const toolInput = input.tool_input as { url?: string; file_path?: string; path?: string };
      // What came from outside the run is data (spec S.2): a page or search result, and a
      // repository file the subprocess read (the loop driver's read_file marks the same).
      const untrusted = isExternalCcTool(toolName)
        ? ({ source: "web_page", origin: String(toolInput?.url ?? toolName) } as const)
        : isRepoReadCcTool(toolName)
          ? ({
              source: "repo_file",
              origin: String(toolInput?.file_path ?? toolInput?.path ?? toolName),
            } as const)
          : undefined;
      let r: Awaited<ReturnType<EnforcementHooks["afterToolCall"]>>;
      try {
        r = await this.deps.hooks.afterToolCall(ctx, spec, modelInput, {
          content: raw,
          untrusted,
        });
      } catch (e) {
        // The run's token is ended (the run stopped): nothing of this result reaches the model
        // and Claude Code is told to stop (budget-stop, ADR 0111).
        return { continue: false, stopReason: `run stopped: ${errorMessage(e)}` };
      }
      if (r.report?.suspicious)
        emit({ type: "injection_flagged", tool: toolName, report: r.report });
      emit({
        type: "tool_result",
        id: String(input.tool_use_id ?? ""),
        name: toolName,
        chars: r.content.length,
        isError: false,
        durationMs: 0,
      });
      // The subprocess sees what the loop driver would feed back: the redacted content, with
      // the data envelope where the source is untrusted. The SDK applies the replacement to
      // MCP tool outputs; for the web tools it is handed over as before. A built-in file tool's
      // output cannot be rewritten from a hook: its read is scanned and flagged, not changed.
      // The wrap-up (ADR 0111) goes with the first result after the hooks said so, once, as
      // context beside the result, never inside it.
      const wrapUp = wrap.due && wrap.text && !wrap.sent ? wrap.text : undefined;
      if (wrapUp) {
        wrap.due = false;
        wrap.sent = true;
        emit({
          type: "wrap_up_sent",
          spentUsdMicro: ctx.budget.spentByRunId(ctx.token.claims.runId),
          capUsdMicro: ctx.token.claims.budgetUsdMicro,
        });
      }
      const replaced = untrusted || isMcpTool(toolName) ? { updatedMCPToolOutput: r.content } : {};
      return wrapUp || "updatedMCPToolOutput" in replaced
        ? {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              ...replaced,
              ...(wrapUp ? { additionalContext: wrapUp } : {}),
            },
          }
        : {};
    };
    return {
      PreToolUse: [{ hooks: [pre] }],
      PostToolUse: [{ hooks: [post] }],
    };
  }
}

function resolveSpec(tools: ToolRegistry, sdkToolName: string): ToolSpec {
  // Forerunner MCP tools arrive as mcp__forerunner__<name>; Claude Code built-ins as plain names.
  const mcp = sdkToolName.match(/^mcp__forerunner__(.+)$/);
  const name = mcp?.[1] ?? `${CC_TOOL_PREFIX}${sdkToolName}`;
  const spec = tools.get(name);
  if (spec) return spec;
  return {
    name,
    description: "unregistered tool",
    schema: {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
    } as unknown as ToolSpec["schema"],
    actionClass: "non_routine",
    risk: "medium",
    async execute() {
      throw new ForerunnerError("tool_not_allowed", `tool ${name} is not registered`);
    },
  };
}

/** How many allowed calls' inputs are kept for PostToolUse at most (one per tool_use_id). */
const RAW_INPUTS_MAX = 1_000;

function isExternalCcTool(name: string): boolean {
  return /^(WebFetch|WebSearch)$/.test(name);
}

function isRepoReadCcTool(name: string): boolean {
  return /^(Read|NotebookRead|Grep)$/.test(name);
}

function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** A whole, non-negative token count, or 0. */
const tokens = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

/** An API message's usage (snake case) as the ledger counts it. */
function usageOf(u: Record<string, number>): Usage {
  return {
    input_tokens: tokens(u.input_tokens),
    output_tokens: tokens(u.output_tokens),
    cache_read_input_tokens: tokens(u.cache_read_input_tokens),
    cache_creation_input_tokens: tokens(u.cache_creation_input_tokens),
  };
}

/**
 * The whole query's usage as Claude Code's result reports it (budget-stop, ADR 0111): the sum of
 * `modelUsage` over its models, "the correct field for token/cost accounting" (it covers
 * subagents and internal calls), else the result's `usage` (the main loop only). Null when the
 * result carries neither.
 */
function resultTotals(msg: Record<string, unknown>): Usage | null {
  const per = msg.modelUsage;
  if (per && typeof per === "object" && !Array.isArray(per)) {
    const models = Object.values(per as Record<string, Record<string, unknown>>);
    if (models.length)
      return models.reduce<Usage>(
        (sum, m) =>
          addUsage(sum, {
            input_tokens: tokens(m?.inputTokens),
            output_tokens: tokens(m?.outputTokens),
            cache_read_input_tokens: tokens(m?.cacheReadInputTokens),
            cache_creation_input_tokens: tokens(m?.cacheCreationInputTokens),
          }),
        { ...ZERO_USAGE },
      );
  }
  const u = msg.usage;
  if (u && typeof u === "object" && !Array.isArray(u)) return usageOf(u as Record<string, number>);
  return null;
}

/** What `total` holds beyond `counted`, per field (never negative); null when nothing. */
function usageLeft(total: Usage, counted: Usage): Usage | null {
  const rest: Usage = {
    input_tokens: Math.max(0, total.input_tokens - counted.input_tokens),
    output_tokens: Math.max(0, total.output_tokens - counted.output_tokens),
    cache_read_input_tokens: Math.max(
      0,
      total.cache_read_input_tokens - counted.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: Math.max(
      0,
      total.cache_creation_input_tokens - counted.cache_creation_input_tokens,
    ),
  };
  return Object.values(rest).some((n) => n > 0) ? rest : null;
}

/** Variables of the providers and stores the daemon itself talks to: never the subprocess's. */
const DENIED_ENV_PREFIX =
  /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|GITHUB_TOKEN|GH_TOKEN|AWS_|CLOUDFLARE_|DEEPGRAM|CARTESIA|ELEVEN|OPENAI_|FORERUNNER_VAULT)/i;
/**
 * Names under which credentials travel: anywhere in the name for the unambiguous words, as
 * a whole segment (`_PASS`, `SIGNING_KEY`, `BASIC_AUTH`, `SENTRY_DSN`) for the short ones,
 * so `PATHEXT` or `XAUTHORITY` stay and `SSH_AUTH_SOCK` (the user's agent) goes.
 */
const DENIED_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY|COOKIE)|(^|_)(PASS|KEY|KEYS|AUTH|DSN)(_|$)/i;
/** `scheme://user:password@host`: a connection string or a proxy with its credentials. */
const USERINFO_URL = /^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*:[^/\s@]*@/i;
const PROXY_NAME = /(^|_)PROXY$/i;

/**
 * The environment handed to the Claude Code subprocess (and the process sandbox's base): a
 * denylist on names plus a look at values, because credentials also travel under other names.
 * A variable goes when its name is a credential's, when its value carries `user:password@` in
 * a URL (a database or state URL; a proxy keeps its URL with the user-info cut out, the
 * subprocess still has to reach the API through it) or when the platform's credential shapes
 * find a token in it (`sk-ant-…`, `ghp_…`, a private key). With `FORERUNNER_SDK_HOST_COMMANDS=1`
 * the model can run `env`, so what is left here is what it may read.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    // Git's config from the environment is a numbered set, taken whole below.
    if (GIT_CONFIG_ENV.test(k)) continue;
    if (DENIED_ENV_PREFIX.test(k) || DENIED_ENV_NAME.test(k) || CLAUDE_CODE_AUTH_ENV.test(k))
      continue;
    if (typeof v === "string" && USERINFO_URL.test(v)) {
      if (PROXY_NAME.test(k)) out[k] = v.replace(USERINFO_URL, "$1");
      continue;
    }
    if (typeof v === "string" && redact(v) !== v) continue;
    out[k] = v;
  }
  Object.assign(out, scrubGitConfigEnv(env));
  return out;
}

/** `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>` (git 2.31+). */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
/** Git config keys that carry or fetch a credential: an extra header, a password, a helper. */
const GIT_CREDENTIAL_KEY =
  /(extraheader|password|token|credential\.helper|credential\..*\.helper)/i;
/**
 * A URL with a user part anywhere in a git config key or value (`https://<token>@github.com/`,
 * `https://user:pass@host/`): git's config cannot tell a user name from a token there, so the
 * entry goes whatever the user part is (`ssh://git@host/` too; the sandbox has no SSH agent).
 */
const GIT_URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;

/** A git config key or value that holds a credential. */
function gitConfigHoldsCredential(text: string): boolean {
  return (
    /authorization:/i.test(text) ||
    GIT_URL_USERINFO.test(text) ||
    USERINFO_URL.test(text) ||
    redact(text) !== text
  );
}

/**
 * Git's config entries from the environment, without the ones that carry a credential, numbered
 * again so the count matches the keys. Git reads `GIT_CONFIG_COUNT` and then every key and value
 * up to it, and stops every command with "missing config key GIT_CONFIG_KEY_0" when one is
 * absent: the name rule above dropped the keys (they hold `_KEY_`) and kept the count, so on a
 * machine whose environment configures git this way no git command a specialist ran worked
 * (live, 2026-11-02). An entry goes when its key names a way to carry or fetch a credential (an
 * `http.*.extraheader`, a `credential.helper`), or when its key or its value holds one (a URL
 * with a user part, an `Authorization:` header, a token the platform's shapes find); the rest
 * stay.
 */
export function scrubGitConfigEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  if (!Number.isFinite(count) || count <= 0) return {};
  const kept: [string, string][] = [];
  for (let i = 0; i < count; i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    const value = env[`GIT_CONFIG_VALUE_${i}`] ?? "";
    // Git refuses a set with a hole in it: nothing of it is passed on.
    if (!key) return {};
    // The key counts as much as the value: `url.<https://TOKEN@host/>.insteadOf` holds the
    // token in the key (review, 2026-11-02: it reached the specialist's environment).
    if (GIT_CREDENTIAL_KEY.test(key) || gitConfigHoldsCredential(key)) continue;
    if (gitConfigHoldsCredential(value)) continue;
    kept.push([key, value]);
  }
  if (!kept.length) return {};
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(kept.length) };
  kept.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return out;
}

/**
 * The variables that make Claude Code authenticate or bill some other way than with the token
 * Forerunner hands it (U-078, ADR 0100), read off the binary Agent SDK 0.3.304 ships: an API
 * key (`ANTHROPIC_API_KEY`, which Claude Code prefers over the subscription, or one passed by
 * file descriptor), a bearer token (`ANTHROPIC_AUTH_TOKEN`, a gateway token, a hosted session's
 * token), another OAuth token or refresh token, and a switch to another provider's billing
 * (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`, ...). The name rules
 * above catch most of them already; this list makes the rule explicit and tested.
 */
const CLAUDE_CODE_AUTH_ENV =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_FOUNDRY_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_REFRESH_TOKEN|CLAUDE_CODE_SESSION_ACCESS_TOKEN|CLAUDE_CODE_GATEWAY_TOKEN|CLAUDE_CODE_HOST_AUTH_ENV_VAR|CLAUDE_CODE_USE_[A-Z_]+|CLAUDE_CODE_[A-Z_]*FILE_DESCRIPTOR|CLAUDE_CODE_API_KEY_HELPER_TTL_MS)$/i;

/** Extra subprocess variables (the session's proxy settings) with every way to authenticate taken out. */
export function withoutClaudeCodeAuth(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !CLAUDE_CODE_AUTH_ENV.test(k)));
}

/** The SDK's `query`, imported on first use so a unit test never loads Claude Code. */
export async function loadSdkQuery(): Promise<QueryLike> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: QueryLike };
  return mod.query;
}
