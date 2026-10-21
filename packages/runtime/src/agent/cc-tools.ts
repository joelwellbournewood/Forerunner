import { z } from "zod";
import type { ActionClass } from "../enforcement/autonomy.ts";
import { CLAUDE_CODE_PREFIX, KNOWN_CLAUDE_CODE_TOOLS } from "../registry/types.ts";
import { ToolRegistry, type ToolSpec } from "./tools.ts";

/**
 * The Claude Code built-in tools as the enforcement hooks see them on the Agent SDK path
 * (ADR 0044). The SDK executes these tools itself inside its subprocess; the specs exist so
 * the hooks can apply the same rules as on the loop driver before each call: the token's
 * allowlist (`cc:<Tool>` names), path containment for the file tools, the domain allowlist
 * for the web tools, the autonomy decision by action class. `execute` is never called: a
 * spec reached through it is a programming error, not a tool run.
 */
interface CcToolShape {
  description: string;
  actionClass: ActionClass;
  risk: ToolSpec["risk"];
  pathFields?: string[];
  domainFields?: string[];
  /** Glob fields: a pattern that leaves the search root (`..`, an absolute prefix) is refused. */
  globFields?: string[];
}

const SHAPES: Record<string, CcToolShape> = {
  Read: { description: "Read a file", actionClass: "read", risk: "low", pathFields: ["file_path"] },
  NotebookRead: {
    description: "Read a notebook",
    actionClass: "read",
    risk: "low",
    pathFields: ["notebook_path"],
  },
  Edit: {
    description: "Edit a file in the worktree",
    actionClass: "routine_reversible",
    risk: "low",
    pathFields: ["file_path"],
  },
  MultiEdit: {
    description: "Edit a file in the worktree (several edits)",
    actionClass: "routine_reversible",
    risk: "low",
    pathFields: ["file_path"],
  },
  Write: {
    description: "Write a file in the worktree",
    actionClass: "routine_reversible",
    risk: "low",
    pathFields: ["file_path"],
  },
  NotebookEdit: {
    description: "Edit a notebook in the worktree",
    actionClass: "routine_reversible",
    risk: "low",
    pathFields: ["notebook_path"],
  },
  Glob: {
    description: "Find files by pattern",
    actionClass: "read",
    risk: "low",
    pathFields: ["path"],
    globFields: ["pattern"],
  },
  Grep: {
    description: "Search file contents",
    actionClass: "read",
    risk: "low",
    pathFields: ["path"],
    // `pattern` is the regular expression; `glob` narrows the files and is the one that walks.
    globFields: ["glob"],
  },
  LS: { description: "List a directory", actionClass: "read", risk: "low", pathFields: ["path"] },
  Bash: {
    description: "Run a shell command where the Claude Code subprocess runs",
    actionClass: "routine_reversible",
    risk: "medium",
  },
  WebFetch: {
    description: "Fetch a web page",
    actionClass: "read",
    risk: "low",
    domainFields: ["url"],
  },
  WebSearch: { description: "Search the web", actionClass: "read", risk: "low" },
  Task: { description: "Delegate to a Claude Code subagent", actionClass: "read", risk: "low" },
  TodoWrite: {
    description: "Keep the subprocess's own task list",
    actionClass: "read",
    risk: "low",
  },
};

/**
 * Every Claude Code tool name with the prefix (`cc:Read`, ...). A session grant lists them so a
 * run token derived for the SDK path may carry the registry's names (a derived token only
 * narrows its parent); the loop driver never offers them because no registry holds them.
 */
export function claudeCodeToolNames(): string[] {
  return KNOWN_CLAUDE_CODE_TOOLS.map((t) => `${CLAUDE_CODE_PREFIX}${t}`);
}

/**
 * A glob that walks out of the directory it is resolved against: a `..` segment anywhere
 * (also inside a brace list) or an absolute prefix (`/`, `\\`, `C:`, `~`). The SDK resolves
 * `Glob.pattern` and `Grep.glob` against `path` or, when unset, the run directory, so the
 * containment check on `path` alone would let a pattern starting `../../` walk out of the
 * worktree (every key file two levels up, say).
 */
export function globEscapes(pattern: string): boolean {
  return (
    /(^|[\\/{,])\.\.([\\/},]|$)/.test(pattern) || /(^|[{,])(~|[\\/]|[A-Za-z]:[\\/])/.test(pattern)
  );
}

/** The spec for one Claude Code tool name (without the prefix), for the hooks only. */
export function claudeCodeToolSpec(tool: string): ToolSpec {
  const shape = Object.hasOwn(SHAPES, tool) ? SHAPES[tool] : undefined;
  const name = `${CLAUDE_CODE_PREFIX}${tool}`;
  const globFields = shape?.globFields ?? [];
  return {
    name,
    description: shape?.description ?? `Claude Code tool ${tool}`,
    // The SDK validates the input itself; the hooks only need the path, URL and glob fields.
    schema: z
      .looseObject({
        file_path: z.string().optional(),
        notebook_path: z.string().optional(),
        path: z.string().optional(),
        url: z.string().optional(),
      })
      .superRefine((v, ctx) => {
        for (const field of globFields) {
          const value = (v as Record<string, unknown>)[field];
          if (typeof value === "string" && globEscapes(value)) {
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: "a pattern may not leave the search directory (no .., no absolute prefix)",
            });
          }
        }
      }),
    actionClass: shape?.actionClass ?? "non_routine",
    risk: shape?.risk ?? "medium",
    ...(shape?.pathFields ? { pathFields: shape.pathFields } : {}),
    ...(shape?.domainFields ? { domainFields: shape.domainFields } : {}),
    async execute() {
      throw new Error(`${name} runs inside the Claude Code subprocess, never in the runtime`);
    },
  };
}

/**
 * A run's tool registry for the SDK path: the base registry (the Forerunner tools the token
 * may carry as MCP tools) plus a spec for every known Claude Code tool that is not there yet.
 */
export function withClaudeCodeTools(base: ToolRegistry): ToolRegistry {
  const out = new ToolRegistry();
  for (const name of base.names()) {
    const t = base.get(name);
    if (t) out.register(t);
  }
  for (const tool of KNOWN_CLAUDE_CODE_TOOLS) {
    const name = `${CLAUDE_CODE_PREFIX}${tool}`;
    if (!out.get(name)) out.register(claudeCodeToolSpec(tool));
  }
  return out;
}
