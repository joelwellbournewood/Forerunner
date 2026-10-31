import { mkdirSync } from "node:fs";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  redact,
  systemClock,
} from "@forerunner/platform";
import { z } from "zod";
import { loadSdkQuery, type QueryLike, scrubEnv } from "../agent/sdk.ts";
import { anthropicThinkingOff } from "./anthropic.ts";
import {
  type ChatMessage,
  type ContentBlock,
  collectStream,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type ProviderDeclaredCapabilities,
  type StopReason,
  type StreamEvent,
  type ToolDefinition,
  type Usage,
} from "./types.ts";

/**
 * The model provider of an install whose only Claude credential is a subscription token from
 * `claude setup-token` (U-048, ADR 0098). Anthropic documents that token for Claude Code only:
 * it goes into the unmodified Claude Code binary as `CLAUDE_CODE_OAUTH_TOKEN`, and "OAuth
 * authentication ... is designed to support ordinary use of Claude Code and other native
 * Anthropic applications" (code.claude.com/docs/en/legal-and-compliance, read 2026-10-31).
 * So Forerunner never sends it to the Messages API itself: every call of chat, intake, the
 * critic and the model watch runs as one turn of Claude Code through the Agent SDK, the binary
 * the SDK ships, with the token in its environment. The binary authenticates as it does for
 * any subscriber (a bearer token with its own beta header; Forerunner sets neither).
 *
 * One call is one `query()`: the request's system prompt as the custom system prompt, no
 * Claude Code tool (`tools: []`), the request's tools offered through an in-process MCP server
 * that runs nothing (`allowedTools: []` with `dontAsk`: Claude Code may not call them), and the
 * stream read up to the end of the first model response. A `tool_use` there is handed to the
 * caller's loop exactly as the Messages adapter hands it over (the `mcp__forerunner__` prefix
 * removed), and the loop runs the tool under its own hooks; the next call carries the result.
 * Claude Code takes only user turns as input, so a request with earlier turns (a tool's result
 * after the model's call) is sent as one user turn that quotes the conversation so far.
 *
 * The token is read at every call (`token()`), so a token replaced in the app is used by the
 * next call without a restart (U-049). It is never logged and never part of an error.
 */
export interface ClaudeCodeProviderOptions {
  /** The subscription token, read per call; null when the vault holds none. */
  token: () => Promise<string | null>;
  /** The working directory Claude Code runs in: an empty folder of Forerunner's own. */
  cwd: string;
  /** Sent as `ANTHROPIC_BASE_URL` when set (config.json's `anthropicApiBase` off its default). */
  baseURL?: string;
  /** Test seam: replaces the SDK's `query` (never spawns Claude Code). */
  query?: QueryLike;
  /** Test seam: replaces the SDK's `createSdkMcpServer` + `tool` for the request's tools. */
  mcpServer?: McpServerFactory;
  /** Identifies the app in Claude Code's User-Agent (`CLAUDE_AGENT_SDK_CLIENT_APP`). */
  clientApp?: string;
  clock?: Clock;
}

/** Builds the in-process MCP server that offers the request's tools to the model. */
export type McpServerFactory = (name: string, tools: ToolDefinition[]) => Promise<unknown>;

/** The MCP server name the request's tools are offered under; Claude Code prefixes their names. */
export const CLAUDE_CODE_TOOL_SERVER = "forerunner";
const TOOL_PREFIX = `mcp__${CLAUDE_CODE_TOOL_SERVER}__`;

/** The default Anthropic API base: not passed on, so Claude Code uses its own default. */
const DEFAULT_API_BASE = "https://api.anthropic.com";

export class ClaudeCodeProvider implements ModelProvider {
  /** Anthropic's models, priced and laddered as the Messages adapter's are. */
  readonly name = "anthropic";
  /** How the calls are made, for the logs and `fr doctor`. */
  readonly via = "claude-code" as const;
  /** Fast mode is API only (spec D.20): never on a subscription. */
  readonly fastMode = false;
  readonly capabilities: ProviderDeclaredCapabilities = { acceptsTemperature: false };

  constructor(private readonly opts: ClaudeCodeProviderOptions) {}

  /** Claude Code lists no models for a subscription token; the ladder names them. */
  async listModels(): Promise<ModelRef[]> {
    return [];
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const aborted = (): StreamEvent => ({
      type: "error",
      code: "aborted",
      message: "aborted",
      retryable: false,
    });
    if (req.signal?.aborted) {
      yield aborted();
      return;
    }
    const token = await this.opts.token().catch(() => null);
    if (!token) {
      yield {
        type: "error",
        code: "provider_auth",
        message:
          "No Claude subscription token is saved. Add it in Settings → Accounts and keys (the setup assistant).",
        retryable: false,
      };
      return;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let iterator: AsyncIterator<Record<string, unknown>> | undefined;
    const mapper = new RawEventMapper((name) =>
      name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name,
    );
    try {
      const options = await this.optionsFor(req, token, controller);
      const query = this.opts.query ?? (await loadSdkQuery());
      iterator = query({ prompt: promptFor(req.messages), options })[Symbol.asyncIterator]();
      let failure: StreamEvent | null = null;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const msg = next.value;
        if (msg.type === "stream_event") {
          for (const ev of mapper.map(msg.event as RawEvent)) yield ev;
          // The first model response is the call: Claude Code is not let to go on (it would
          // answer the model's tool call itself, which it may not do here).
          if (mapper.stopped) break;
          continue;
        }
        if (msg.type === "assistant" && typeof msg.error === "string") {
          failure = errorFromSdk(msg.error, textOf(msg));
          continue;
        }
        if (msg.type === "result" && msg.is_error === true && !mapper.stopped) {
          failure ??= {
            type: "error",
            code: "provider_error",
            message: `Claude Code ended the call: ${String(msg.subtype ?? "error")}${
              typeof msg.result === "string" && msg.result ? `: ${msg.result}` : ""
            }`,
            retryable: false,
          };
        }
      }
      if (req.signal?.aborted && !mapper.stopped) {
        yield aborted();
        return;
      }
      if (!mapper.stopped) {
        yield failure ?? {
          type: "error",
          code: "provider_error",
          message: "Claude Code ended without a model response",
          retryable: true,
        };
        return;
      }
      yield { type: "message_end", stop_reason: mapper.stopReason, usage: mapper.usage };
    } catch (e) {
      yield req.signal?.aborted
        ? aborted()
        : {
            type: "error",
            code: e instanceof ForerunnerError ? e.code : "provider_error",
            // What Claude Code said may quote its environment: the token is cut out (U-053).
            message: redact(
              `Claude Code could not answer: ${errorMessage(e).split(token).join("[REDACTED]")}`,
            ),
            retryable: false,
          };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      // Stops the subprocess once the response is read (or the call failed); not awaited.
      controller.abort();
      void Promise.resolve()
        .then(() => iterator?.return?.(undefined))
        .catch(() => undefined);
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const clock = this.opts.clock ?? systemClock;
    const t0 = clock.monotonic();
    return collectStream(
      this.stream(req),
      () => t0,
      () => clock.monotonic(),
    );
  }

  /** The `query()` options for one call; exported shape asserted by the tests. */
  private async optionsFor(
    req: ModelRequest,
    token: string,
    controller: AbortController,
  ): Promise<Record<string, unknown>> {
    mkdirSync(this.opts.cwd, { recursive: true });
    const env: Record<string, string | undefined> = {
      ...scrubEnv(process.env),
      CLAUDE_CODE_OAUTH_TOKEN: token,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.max_tokens),
      CLAUDE_AGENT_SDK_CLIENT_APP: this.opts.clientApp ?? "forerunner",
      ...(this.opts.baseURL && this.opts.baseURL.replace(/\/$/, "") !== DEFAULT_API_BASE
        ? { ANTHROPIC_BASE_URL: this.opts.baseURL }
        : {}),
    };
    const off = req.thinking === "off" ? anthropicThinkingOff(req.model, req.effort) : undefined;
    const tools = req.tools ?? [];
    const server = tools.length
      ? await (this.opts.mcpServer ?? sdkMcpServer)(CLAUDE_CODE_TOOL_SERVER, tools)
      : undefined;
    return {
      abortController: controller,
      cwd: this.opts.cwd,
      additionalDirectories: [],
      model: req.model,
      ...(req.effort ? { effort: req.effort } : {}),
      ...(off?.type === "disabled" ? { thinking: { type: "disabled" } } : {}),
      systemPrompt: { type: "custom", prompt: req.system ?? "" },
      // No Claude Code tool at all, and none of the offered ones may run inside Claude Code.
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      mcpServers: server ? { [CLAUDE_CODE_TOOL_SERVER]: server } : {},
      strictMcpConfig: true,
      maxTurns: 1,
      env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
    };
  }
}

/**
 * The request's tools as an in-process MCP server. Each handler only says the tool did not run
 * here: Claude Code is never allowed to call one (`allowedTools: []`, `dontAsk`), and the call
 * ends at the model's response anyway.
 */
async function sdkMcpServer(name: string, tools: ToolDefinition[]): Promise<unknown> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
    createSdkMcpServer(o: { name: string; tools: unknown[]; alwaysLoad?: boolean }): unknown;
    tool(
      n: string,
      d: string,
      shape: Record<string, z.ZodType>,
      h: (args: unknown) => Promise<{ content: { type: "text"; text: string }[] }>,
    ): unknown;
  };
  return sdk.createSdkMcpServer({
    name,
    alwaysLoad: true,
    tools: tools.map((t) =>
      sdk.tool(t.name, t.description, shapeOf(t.input_schema), async () => ({
        content: [{ type: "text", text: "Not run here: Forerunner runs this tool." }],
      })),
    ),
  });
}

/** A tool's JSON Schema as the zod shape the SDK's `tool()` takes; an odd schema takes any object. */
export function shapeOf(schema: Record<string, unknown>): Record<string, z.ZodType> {
  try {
    const parsed = z.fromJSONSchema(schema as never);
    if (parsed instanceof z.ZodObject) return parsed.shape as Record<string, z.ZodType>;
  } catch {
    // fall through
  }
  return {};
}

/**
 * The request's messages as the one user turn Claude Code takes. A single user message is sent
 * as it is; earlier turns are quoted, the model's tool calls and their results included, and
 * the last message is the one to answer.
 */
export function promptFor(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === "user") return textBlocks(messages[0]);
  const lines: string[] = [
    "The conversation so far, quoted (your earlier replies are marked assistant; tool calls and their results are shown as they happened):",
    "<conversation>",
  ];
  for (const m of messages) {
    if (typeof m.content === "string") {
      lines.push(`[${m.role}] ${m.content}`);
      continue;
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === "text") lines.push(`[${m.role}] ${b.text}`);
      else if (b.type === "tool_use")
        lines.push(`[assistant called the tool ${b.name} with ${JSON.stringify(b.input)}]`);
      else if (b.type === "tool_result")
        lines.push(`[tool result${b.is_error ? ", an error" : ""}] ${b.content}`);
    }
  }
  lines.push("</conversation>");
  lines.push(
    "Continue as the assistant from the end of the conversation: answer its last message, using the tools when the task needs them.",
  );
  return lines.join("\n");
}

function textBlocks(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  return (m.content as ContentBlock[])
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

function textOf(msg: Record<string, unknown>): string {
  const content = (msg.message as { content?: { type: string; text?: string }[] } | undefined)
    ?.content;
  return (content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** Claude Code's error kinds (`SDKAssistantMessageError`) as the loop's provider error codes. */
function errorFromSdk(kind: string, text: string): StreamEvent {
  const detail = text ? `: ${text}` : "";
  switch (kind) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
      return {
        type: "error",
        code: "provider_auth",
        message: `Claude refused the subscription token (${kind})${detail}. Run claude setup-token again and paste the new token in Settings → Accounts and keys.`,
        retryable: false,
      };
    case "rate_limit":
      return {
        type: "error",
        code: "provider_rate_limit",
        message: `Claude subscription usage limit reached${detail}`,
        retryable: true,
      };
    case "overloaded":
    case "server_error":
      return {
        type: "error",
        code: "provider_error",
        message: `Claude is unavailable (${kind})${detail}`,
        retryable: true,
      };
    default:
      return {
        type: "error",
        code: "provider_error",
        message: `Claude Code reported ${kind}${detail}`,
        retryable: false,
      };
  }
}

/** A raw Messages API stream event, as Claude Code passes it on (`stream_event.event`). */
type RawEvent = {
  type: string;
  index?: number;
  message?: { model?: string; usage?: Partial<Usage> };
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: Partial<Usage> & { output_tokens?: number };
};

/** Maps raw stream events to the loop's events, as the Messages adapter does. */
class RawEventMapper {
  readonly usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  stopReason: StopReason = "end_turn";
  stopped = false;
  private readonly open = new Map<number, { id: string; name: string; json: string }>();

  constructor(private readonly rename: (name: string) => string) {}

  map(ev: RawEvent | undefined): StreamEvent[] {
    if (!ev) return [];
    const out: StreamEvent[] = [];
    switch (ev.type) {
      case "message_start": {
        const u = ev.message?.usage ?? {};
        this.usage.input_tokens = u.input_tokens ?? 0;
        this.usage.cache_read_input_tokens = u.cache_read_input_tokens ?? 0;
        this.usage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0;
        out.push({
          type: "message_start",
          model: ev.message?.model ?? "",
          usage: { ...this.usage },
        });
        break;
      }
      case "content_block_start":
        if (ev.content_block?.type === "tool_use" && ev.index !== undefined) {
          const id = ev.content_block.id ?? `tool_${ev.index}`;
          const name = this.rename(ev.content_block.name ?? "");
          this.open.set(ev.index, { id, name, json: "" });
          out.push({ type: "tool_use_start", id, name });
        }
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta" && ev.delta.text)
          out.push({ type: "text_delta", text: ev.delta.text });
        else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking)
          out.push({ type: "thinking_delta", text: ev.delta.thinking });
        else if (ev.delta?.type === "input_json_delta" && ev.index !== undefined) {
          const t = this.open.get(ev.index);
          if (t) {
            t.json += ev.delta.partial_json ?? "";
            out.push({
              type: "tool_use_delta",
              id: t.id,
              partial_json: ev.delta.partial_json ?? "",
            });
          }
        }
        break;
      case "content_block_stop": {
        const t = ev.index !== undefined ? this.open.get(ev.index) : undefined;
        if (t && ev.index !== undefined) {
          this.open.delete(ev.index);
          let input: Record<string, unknown> = {};
          try {
            input = t.json ? (JSON.parse(t.json) as Record<string, unknown>) : {};
          } catch {
            input = { _unparsed: t.json };
          }
          out.push({ type: "tool_use_end", id: t.id, input });
        }
        break;
      }
      case "message_delta":
        this.stopReason = stopOf(ev.delta?.stop_reason);
        if (ev.usage?.output_tokens != null) this.usage.output_tokens = ev.usage.output_tokens;
        if (ev.usage?.input_tokens != null) this.usage.input_tokens = ev.usage.input_tokens;
        if (ev.usage?.cache_read_input_tokens != null)
          this.usage.cache_read_input_tokens = ev.usage.cache_read_input_tokens;
        if (ev.usage?.cache_creation_input_tokens != null)
          this.usage.cache_creation_input_tokens = ev.usage.cache_creation_input_tokens;
        break;
      case "message_stop":
        this.stopped = true;
        break;
    }
    return out;
  }
}

function stopOf(s: string | null | undefined): StopReason {
  switch (s) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
