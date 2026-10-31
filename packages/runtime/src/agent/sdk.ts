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
  /** `resetAt`: a `provider_usage_limit` with the reset time Claude Code reported (ADR 0100). */
  error?: { code: string; message: string; resetAt?: string };
}

export interface SdkDriverDeps {
  hooks: EnforcementHooks;
  kill: KillSwitch;
  clock: Clock;
  /** Test seam: replaces the SDK's query function. */
  queryImpl?: QueryLike;
}

// A structural subset of the SDK's query() so tests can inject a fake without the real module.
export type QueryLike = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

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
    const unregister = this.deps.kill.register({
      agentId: claims.agentId,
      sessionId: claims.sessionId,
      // A person's move of the task stops this run (`KillSwitch.stopTask`, U-039).
      ...(claims.taskId ? { taskId: claims.taskId } : {}),
      controller,
      label: req.label ?? `sdk run ${claims.runId}`,
    });
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
    let usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
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

    try {
      // Pre-flight: the first model call is accounted like any other; the SDK then reports usage
      // per assistant message, which we account turn by turn.
      await this.deps.hooks.beforeModelCall(
        ctx,
        req.pricing.estimate(ctx.budget.limits.stepCap, 4096),
      );
      emit({ type: "run_start", runId: claims.runId, model: req.model });

      const query = this.deps.queryImpl ?? (await loadSdkQuery());
      // The subscription's token only (refused above otherwise); the session's extra variables
      // (the Headroom proxy) never carry another way to authenticate.
      const env: Record<string, string | undefined> = {
        ...scrubEnv(process.env),
        CLAUDE_CODE_OAUTH_TOKEN: req.credential.value,
        ...(req.baseURL ? { ANTHROPIC_BASE_URL: req.baseURL } : {}),
        ...withoutClaudeCodeAuth(req.env ?? {}),
      };
      const hooks = this.sdkHooks(ctx, req.tools, emit);
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
        maxBudgetUsd: Math.max(0.01, claims.budgetUsdMicro / 1_000_000),
        env,
        hooks,
        includePartialMessages: true,
        persistSession: false,
        settingSources: [],
        allowDangerouslySkipPermissions: false,
      };
      let lastCum: { in: number; out: number; cr: number; cw: number; usd: number } = {
        in: 0,
        out: 0,
        cr: 0,
        cw: 0,
        usd: 0,
      };
      // The kill switch and the timeout abort the controller; the SDK then tears its
      // subprocess down, which can take longer than the 2 s the kill switch promises. The run
      // ends the moment the abort fires: the iterator is left to finish in the background.
      const iterator = query({ prompt: req.prompt, options })[Symbol.asyncIterator]();
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => {
          const reason = controller.signal.reason;
          reject(reason instanceof Error ? reason : new ForerunnerError("killed", "run killed"));
        };
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      aborted.catch(() => undefined);
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done) break;
          const msg = next.value;
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
            numTurns++;
            const m = msg.message as
              | { content?: { type: string; text?: string }[]; usage?: Record<string, number> }
              | undefined;
            const text = (m?.content ?? [])
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("");
            if (text) finalText = text;
            const u = m?.usage;
            if (u) {
              const turnUsage: Usage = {
                input_tokens: u.input_tokens ?? 0,
                output_tokens: u.output_tokens ?? 0,
                cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
                cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
              };
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
                stopReason: "turn",
              });
              // Enforce before the SDK makes its next call.
              await this.deps.hooks.beforeModelCall(
                ctx,
                req.pricing.estimate(turnUsage.input_tokens, 4096),
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
            if (msg.is_error) {
              outcome = "error";
              error = {
                code: "provider_error",
                message: String(msg.result ?? msg.subtype ?? "sdk error"),
              };
            }
            if (typeof msg.result === "string" && msg.result) finalText = msg.result;
            lastCum = {
              in: usage.input_tokens,
              out: usage.output_tokens,
              cr: usage.cache_read_input_tokens,
              cw: usage.cache_creation_input_tokens,
              usd: sdkCostUsd,
            };
          }
        }
      } finally {
        if (controller.signal.aborted) {
          // Not awaited: the subprocess teardown must not delay the killed outcome.
          void Promise.resolve()
            .then(() => iterator.return?.(undefined))
            .catch(() => undefined);
        }
      }
      void lastCum;
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
      error = { code, message: errorMessage(e) };
      if (outcome === "error")
        this.logger.error("sdk run failed", { runId: claims.runId, error: error.message });
    } finally {
      cancelTimeout();
      outer?.removeEventListener("abort", onOuterAbort);
      unregister();
    }
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
    };
  }

  /** Map our hooks onto the SDK's PreToolUse / PostToolUse. */
  private sdkHooks(ctx: RunContext, tools: ToolRegistry, emit: (ev: RunEvent) => void) {
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
      const r = await this.deps.hooks.afterToolCall(ctx, spec, modelInput, {
        content: raw,
        untrusted,
      });
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
      return untrusted || isMcpTool(toolName)
        ? { hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: r.content } }
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
    if (DENIED_ENV_PREFIX.test(k) || DENIED_ENV_NAME.test(k) || CLAUDE_CODE_AUTH_ENV.test(k))
      continue;
    if (typeof v === "string" && USERINFO_URL.test(v)) {
      if (PROXY_NAME.test(k)) out[k] = v.replace(USERINFO_URL, "$1");
      continue;
    }
    if (typeof v === "string" && redact(v) !== v) continue;
    out[k] = v;
  }
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
