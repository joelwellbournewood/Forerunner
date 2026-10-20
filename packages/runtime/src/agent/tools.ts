import type { z } from "zod";
import type { ActionClass } from "../enforcement/autonomy.ts";
import type { ContentSource } from "../injection/scan.ts";
import type { ToolDefinition } from "../provider/types.ts";

/**
 * A tool as the runtime sees it: typed input, an action class for autonomy decisions, which
 * input fields are paths or URLs (checked against the token), and whether its output is
 * untrusted (wrapped as data and scanned for injection).
 */
export interface ToolExecutionContext {
  runId: string;
  sessionId: string;
  agentId: string;
  humanId: string;
  projectId?: string;
  taskId?: string;
  /** Roots the token allows; tools must stay inside. */
  allowedPaths: readonly string[];
  signal: AbortSignal;
  /** Working directory for this run (the task worktree), if any. */
  cwd?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Set when the content came from outside (web, mail, files by others). */
  untrusted?: { source: ContentSource; origin?: string };
  costUsdMicro?: number;
  artifacts?: Record<string, unknown>;
}

export interface ToolSpec<I = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  actionClass: ActionClass;
  /** Risk shown on approval cards. */
  risk: "low" | "medium" | "high";
  /** Dotted input field names that hold filesystem paths; each must be inside allowedPaths. */
  pathFields?: string[];
  /** Dotted input field names that hold URLs or hostnames; each must match allowedDomains. */
  domainFields?: string[];
  /** Per-call wall-clock limit. */
  timeoutMs?: number;
  execute(input: I, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register<I>(spec: ToolSpec<I>): this {
    if (this.tools.has(spec.name)) throw new Error(`tool already registered: ${spec.name}`);
    this.tools.set(spec.name, spec as ToolSpec);
    return this;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Provider-facing definitions for the subset a token allows. */
  definitions(
    allowed: readonly string[],
    toJsonSchema: (schema: z.ZodType) => Record<string, unknown>,
  ): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const name of allowed) {
      const t = this.tools.get(name);
      if (!t) continue;
      defs.push({ name: t.name, description: t.description, input_schema: toJsonSchema(t.schema) });
    }
    return defs;
  }
}

export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
