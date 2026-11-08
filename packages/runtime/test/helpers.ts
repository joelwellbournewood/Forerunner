import { type Clock, SimulatedClock } from "@forerunner/platform";
import { z } from "zod";
import type { RunPricing } from "../src/agent/loop.ts";
import { ToolRegistry, type ToolSpec } from "../src/agent/tools.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { EnforcementHooks, type HookDeps } from "../src/enforcement/hooks.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import {
  AllowAllCaps,
  AutoApprove,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
} from "../src/enforcement/ports.ts";
import { type CapabilityClaims, type SignedToken, TokenIssuer } from "../src/enforcement/token.ts";
import type {
  ModelProvider,
  ModelRef,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  Usage,
} from "../src/provider/types.ts";
import { collectStream } from "../src/provider/types.ts";

/** Minimal scripted provider used until testenv's FakeProvider lands; emits a stream per reply. */
export interface ScriptReply {
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
  usage?: Partial<Usage>;
  ttftMs?: number;
  /** Time to the end of the content; the remainder after `ttftMs` is slept before message_end. */
  totalMs?: number;
  error?: string;
  /** Events yielded after the text, as a provider sends them (a server tool's blocks, 'web-search'). */
  events?: StreamEvent[];
}

export class ScriptedProvider implements ModelProvider {
  readonly name = "fake";
  readonly calls: ModelRequest[] = [];
  private i = 0;
  constructor(
    private readonly replies: ScriptReply[],
    private readonly clock: Clock,
  ) {}
  async listModels(): Promise<ModelRef[]> {
    return [{ provider: "fake", id: "fake-haiku", tier: "haiku" }];
  }
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...req, messages: structuredClone(req.messages) });
    const r = this.replies[Math.min(this.i, this.replies.length - 1)] ?? { text: "" };
    this.i++;
    yield { type: "message_start", model: req.model };
    if (r.ttftMs) await this.clock.sleep(r.ttftMs, req.signal);
    if (r.error) {
      yield { type: "error", code: r.error, message: r.error, retryable: false };
      return;
    }
    if (r.text) {
      for (const chunk of r.text.match(/.{1,12}/gs) ?? []) {
        if (req.signal?.aborted) {
          yield { type: "error", code: "aborted", message: "aborted", retryable: false };
          return;
        }
        yield { type: "text_delta", text: chunk };
      }
    }
    for (const ev of r.events ?? []) yield ev;
    let n = 0;
    for (const t of r.tools ?? []) {
      const id = `tu_${this.i}_${n++}`;
      yield { type: "tool_use_start", id, name: t.name };
      yield { type: "tool_use_delta", id, partial_json: JSON.stringify(t.input) };
      yield { type: "tool_use_end", id, input: t.input };
    }
    if (r.totalMs !== undefined && r.totalMs > (r.ttftMs ?? 0)) {
      await this.clock.sleep(r.totalMs - (r.ttftMs ?? 0), req.signal);
    }
    yield {
      type: "message_end",
      stop_reason: r.tools?.length ? "tool_use" : "end_turn",
      usage: {
        input_tokens: r.usage?.input_tokens ?? this.countTokens(JSON.stringify(req.messages)),
        output_tokens:
          r.usage?.output_tokens ?? this.countTokens(r.text ?? "") + (r.tools?.length ?? 0) * 20,
        cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: r.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = this.clock.monotonic();
    return collectStream(
      this.stream(req),
      () => t0,
      () => this.clock.monotonic(),
    );
  }
}

export const flatPricing: RunPricing = {
  // 1 USD per 1M tokens in and out: 1 token = 1 micro-USD. Easy arithmetic in tests.
  estimate: (inTok, maxOut) => inTok + maxOut,
  cost: (u) => u.input_tokens + u.output_tokens,
};

export interface Harness {
  clock: SimulatedClock;
  tokens: TokenIssuer;
  kill: KillSwitch;
  hooks: EnforcementHooks;
  audit: MemoryAudit;
  ledger: MemoryLedger;
  approvals: AutoApprove;
  deps: HookDeps;
}

export function harness(overrides: Partial<HookDeps> = {}): Harness {
  const clock = new SimulatedClock("2026-03-02T09:00:00Z");
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens);
  const audit = new MemoryAudit();
  const ledger = new MemoryLedger();
  const approvals = new AutoApprove("approved");
  const deps: HookDeps = {
    tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill,
    clock,
    ledger,
    audit,
    approvals,
    ...overrides,
  };
  return { clock, tokens, kill, hooks: new EnforcementHooks(deps), audit, ledger, approvals, deps };
}

export function issue(h: Harness, over: Partial<CapabilityClaims> = {}): SignedToken {
  return h.tokens.issue({
    runId: over.runId ?? "run-1",
    sessionId: over.sessionId ?? "sess-1",
    agentId: over.agentId ?? "alice",
    ownerHumanId: over.ownerHumanId ?? "j",
    projectId: over.projectId ?? "proj-1",
    taskId: over.taskId,
    allowedTools: over.allowedTools ?? ["echo", "read_file", "fetch"],
    allowedPaths: over.allowedPaths ?? [],
    allowedDomains: over.allowedDomains ?? [],
    grantedSecrets: over.grantedSecrets ?? [],
    budgetUsdMicro: over.budgetUsdMicro ?? 1_000_000,
    depth: over.depth ?? 0,
    maxDepth: over.maxDepth ?? 2,
    autonomy: over.autonomy ?? 2,
    planApproved: over.planApproved ?? false,
    expiresAt: over.expiresAt ?? new Date(h.clock.now() + 3_600_000).toISOString(),
  });
}

export function budget(
  sessionId = "sess-1",
  cap = 5_000_000,
  clock?: Clock,
  stepCap = 200,
): SessionBudget {
  return new SessionBudget({
    sessionId,
    budgetUsdMicro: cap,
    stepCap,
    deadlineMs: (clock?.now() ?? Date.now()) + 3_600_000,
    reserveShare: 0.2,
  });
}

export const echoTool: ToolSpec<{ text: string }> = {
  name: "echo",
  description: "echo text",
  schema: z.object({ text: z.string() }),
  actionClass: "read",
  risk: "low",
  async execute(input) {
    return { content: `echo:${input.text}` };
  },
};

export const readFileTool: ToolSpec<{ path: string }> = {
  name: "read_file",
  description: "read a file",
  schema: z.object({ path: z.string() }),
  actionClass: "read",
  risk: "low",
  pathFields: ["path"],
  async execute(input) {
    return { content: `contents of ${input.path}` };
  },
};

export const fetchTool: ToolSpec<{ url: string }> = {
  name: "fetch",
  description: "fetch a url",
  schema: z.object({ url: z.string() }),
  actionClass: "read",
  risk: "low",
  domainFields: ["url"],
  async execute(input) {
    return {
      content: `page at ${input.url}`,
      untrusted: { source: "web_page", origin: input.url },
    };
  },
};

export const writeTool: ToolSpec<{ path: string; text: string }> = {
  name: "write_file",
  description: "write a file in the worktree",
  schema: z.object({ path: z.string(), text: z.string() }),
  actionClass: "routine_reversible",
  risk: "low",
  pathFields: ["path"],
  async execute(input) {
    return { content: `wrote ${input.path}` };
  },
};

export const deleteRepoTool: ToolSpec<{ repo: string }> = {
  name: "delete_repo",
  description: "delete a repository",
  schema: z.object({ repo: z.string() }),
  actionClass: "destructive",
  risk: "high",
  async execute(input) {
    return { content: `deleted ${input.repo}` };
  },
};

export const secretTool: ToolSpec<{ token: string }> = {
  name: "use_secret",
  description: "uses a secret",
  schema: z.object({ token: z.string() }),
  actionClass: "read",
  risk: "low",
  async execute(input) {
    return { content: `used:${input.token}` };
  },
};

export function registry(): ToolRegistry {
  return new ToolRegistry()
    .register(echoTool)
    .register(readFileTool)
    .register(fetchTool)
    .register(writeTool)
    .register(deleteRepoTool)
    .register(secretTool);
}

/**
 * Polls `cond` on real timers (never the simulated clock) until it holds, for a run that must
 * have reached the provider before the test advances the clock. Throws after about 2 s.
 */
export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The critic's tool name (`@forerunner/critic`'s SUBMIT_REVIEW_TOOL), kept here to avoid a cycle. */
const SUBMIT_REVIEW = "submit_review";

/**
 * A provider that accepts every critic review and hands every other call to `inner` (ADR 0104:
 * the critic reviews every task, tier 0 included). For composed-runtime tests whose subject is
 * not the review: their tasks are done after an accept, as a person's would be, and `inner`
 * sees only the calls it was written for.
 */
export class AcceptingCriticProvider implements ModelProvider {
  readonly name: string;
  readonly reviews: ModelRequest[] = [];
  constructor(private readonly inner: ModelProvider) {
    this.name = inner.name;
  }
  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }
  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }
  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    if (!(req.tools ?? []).some((t) => t.name === SUBMIT_REVIEW)) {
      yield* this.inner.stream(req);
      return;
    }
    this.reviews.push(req);
    const last = req.messages.at(-1)?.content;
    const answered =
      Array.isArray(last) && last.some((b) => (b as { type?: string }).type === "tool_result");
    yield { type: "message_start", model: req.model };
    if (answered) {
      yield { type: "text_delta", text: "Recorded." };
    } else {
      const input = {
        grade: 90,
        confidence: "high",
        verdict: "accept",
        summary: "The work matches the brief.",
        findings: [],
        criteria: [],
        checks_run: [],
      };
      yield { type: "tool_use_start", id: `tu_review_${this.reviews.length}`, name: SUBMIT_REVIEW };
      yield {
        type: "tool_use_delta",
        id: `tu_review_${this.reviews.length}`,
        partial_json: JSON.stringify(input),
      };
      yield { type: "tool_use_end", id: `tu_review_${this.reviews.length}`, input };
    }
    yield {
      type: "message_end",
      stop_reason: answered ? "end_turn" : "tool_use",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    let t = 0;
    return collectStream(
      this.stream(req),
      () => t,
      () => ++t,
    );
  }
}
