import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
import type { AgentKind, ReviewRepo } from "@forerunner/state";
import { defaultEmbedder, type Embedder } from "./embedding.ts";
import { LessonFiles } from "./files.ts";
import { type RememberInput, type RememberResult, remember } from "./record.ts";
import { type RecallResult, recall, renderLessons } from "./retrieval.ts";
import { ScopedLessonStore } from "./scoped-store.ts";
import {
  estimateTokens,
  type LessonStore,
  type MemoryContext,
  type MemoryScope,
  type TokenCounter,
} from "./types.ts";

export interface CreateMemoryOptions {
  /** The state store: every scope in solo mode, critic and shared next to a `privateStore`. */
  store: { lesson: LessonStore; review?: ReviewRepo; clock?: Clock };
  /**
   * The local private index (ADR 0002, ADR 0083). When given, `agent_private` rows are written
   * to and read from it only; `store` never sees the scope. The runtime opens it beside a
   * shared (Postgres) state; a `sqlite:` state in solo mode needs none.
   */
  privateStore?: { lesson: LessonStore };
  /** Memory root (`<data>/memory`); default from `appDirs()`. */
  root?: string;
  files?: LessonFiles;
  embedder?: Embedder;
  clock?: Clock;
}

export function createMemory(opts: CreateMemoryOptions): MemoryContext {
  const ctx: MemoryContext = {
    repo: opts.privateStore
      ? new ScopedLessonStore({ private: opts.privateStore.lesson, shared: opts.store.lesson })
      : opts.store.lesson,
    files: opts.files ?? new LessonFiles(opts.root),
    embedder: opts.embedder ?? defaultEmbedder(),
    clock: opts.clock ?? opts.store.clock ?? systemClock,
  };
  if (opts.store.review) ctx.reviews = opts.store.review;
  return ctx;
}

/** What a principal may read, issued by code from the agent's kind (ADR 0002 "Scope grant"). */
export interface ScopeGrant {
  agentId: string;
  scopes: MemoryScope[];
  ownerAgentId?: string;
}

export function grantFor(kind: AgentKind, agentId: string): ScopeGrant {
  switch (kind) {
    case "principal":
    case "conversation":
      return { agentId, scopes: ["agent_private", "shared"], ownerAgentId: agentId };
    case "critic":
      return { agentId, scopes: ["critic", "shared"] };
    case "specialist":
      // Specialists get only what the principal relays in the task brief.
      return { agentId, scopes: [] };
  }
}

export interface RecallForSessionInput {
  grant: ScopeGrant;
  projectId?: string | null;
  /** The state brief or task text the session starts from. */
  brief: string;
  tags?: string[];
  maxTokens?: number;
  countTokens?: TokenCounter;
}

export interface SessionMemory {
  /** Rendered block (instructions first, then lessons as data); empty when nothing applies. */
  block: string;
  /** The agent's own instructions.md, when the grant covers the private scope. */
  instructions: string;
  result: RecallResult;
  tokens: number;
}

export interface SessionLesson {
  text: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  pinned?: boolean;
}

export interface RememberFromSessionInput {
  agentId: string;
  sessionId: string;
  projectId?: string | null;
  /** Default agent_private (owned by agentId). The critic passes `critic`. */
  scope?: MemoryScope;
  lessons: SessionLesson[];
  authorHuman?: string | null;
}

export interface RememberFromSessionResult {
  recorded: RememberResult[];
  rejected: { text: string; error: string }[];
}

/** Thin facade for the session runner. The scope rule lives in `recall`, not here. */
export class MemoryService {
  constructor(readonly ctx: MemoryContext) {}

  async recallForSession(input: RecallForSessionInput): Promise<SessionMemory> {
    const countTokens = input.countTokens ?? estimateTokens;
    const maxTokens = input.maxTokens ?? 1500;
    let instructions = "";
    let budget = maxTokens;
    if (input.grant.scopes.includes("agent_private") && input.grant.ownerAgentId) {
      instructions = (await this.ctx.files.readInstructions(input.grant.ownerAgentId)).trim();
      if (instructions) {
        // Charged with the blank line that separates it from the lessons block.
        const cost = countTokens(`# Standing notes\n${instructions}\n\n`);
        if (cost > budget) {
          throw new ForerunnerError(
            "budget_exceeded",
            "instructions.md alone exceeds the memory budget",
            {
              details: { cost, maxTokens },
            },
          );
        }
        budget -= cost;
      }
    }
    const empty: RecallResult = {
      lessons: [],
      tokensUsed: 0,
      maxTokens: budget,
      candidates: 0,
      dropped: 0,
      consolidationHints: [],
      denied: [],
      excluded: [],
      touchFailures: [],
    };
    const result =
      input.grant.scopes.length === 0 || budget <= 0
        ? empty
        : await recall(this.ctx, {
            scopes: input.grant.scopes,
            agentId: input.grant.agentId,
            ...(input.grant.ownerAgentId ? { ownerAgentId: input.grant.ownerAgentId } : {}),
            projectId: input.projectId ?? null,
            query: input.brief,
            tags: input.tags ?? [],
            maxTokens: budget,
            countTokens,
          });
    const parts: string[] = [];
    if (instructions) parts.push(`# Standing notes\n${instructions}`);
    const rendered = renderLessons(result);
    if (rendered) parts.push(rendered);
    const block = parts.join("\n\n");
    return { block, instructions, result, tokens: block ? countTokens(block) : 0 };
  }

  async rememberFromSession(input: RememberFromSessionInput): Promise<RememberFromSessionResult> {
    const scope = input.scope ?? "agent_private";
    const out: RememberFromSessionResult = { recorded: [], rejected: [] };
    for (const l of input.lessons) {
      const req: RememberInput = {
        scope,
        text: l.text,
        tags: l.tags ?? [],
        source: l.source ?? `session:${input.sessionId}`,
        confidence: l.confidence ?? 0.5,
        projectId: input.projectId ?? null,
        pinned: l.pinned ?? false,
        // The acting agent is the author and, for private memory, the only possible owner.
        agentId: input.agentId,
        authorAgent: input.agentId,
        authorHuman: input.authorHuman ?? null,
        ...(scope === "agent_private" ? { ownerAgentId: input.agentId } : {}),
      };
      try {
        out.recorded.push(await remember(this.ctx, req));
      } catch (e) {
        out.rejected.push({ text: l.text, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (out.recorded.length) {
      await this.ctx.files.writeCatalog(scope, scope === "agent_private" ? input.agentId : null);
    }
    return out;
  }
}
