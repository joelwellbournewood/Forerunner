import { CLAUDE_CODE_PREFIX } from "./types.ts";

/**
 * Name of the command tool (declared in `daemon/tools.ts`, replaced per run by the sandboxed
 * runner in `session/executor.ts`). It lives in this leaf module so the registry's mapping
 * and the session layer share one constant without the registry depending on the session.
 */
export const RUN_COMMAND_TOOL = "run_command";

/**
 * The audit row kind for a registry tool a run will not offer (ADR 0043 item 5, ADR 0044):
 * written by the composition for the loop driver's mapping and by the executor when the SDK
 * path withholds `cc:Bash`. Declared here so neither the session layer nor the composition
 * root depends on the other for it.
 */
export const TOOL_UNMAPPED_AUDIT = "registry.tool_unmapped";

/**
 * How a registry entry's `allowed_tools` reach a run (ADR 0043). The registry names Claude
 * Code tools (`cc:Read`, `cc:Bash`, ...) because the Agent SDK driver (ADR 0004) offers that
 * tool set as is. The in-process loop driver offers Forerunner's own tools (`read_file`,
 * `write_file`, `list_dir`, `run_command`, the bridged extension tools), so each driver maps
 * the names its own way: the SDK passes `cc:` names through, the loop grants the equivalents
 * below and nothing else. A name the loop cannot honour is dropped and reported, never
 * silently and never widened: `cc:Read` yields `read_file` only, `cc:Bash` yields
 * `run_command` only, and only where the caller sandboxes commands.
 */
export type SpecialistDriver = "loop" | "sdk";

/**
 * The loop driver's built-in tool each Claude Code tool a registry entry may name stands for.
 * Read-only tools map to read-only tools; every editing tool maps to `write_file`; the
 * search tools map to `list_dir` (the model reads what it finds); `Bash` maps to the sandboxed
 * command runner. `WebFetch`, `WebSearch`, `Task`, `TodoWrite` have no equivalent here. Only
 * the table's own entries count (`Object.hasOwn`): `cc:constructor` or `cc:__proto__` is an
 * unknown name, never a lookup through Object's prototype.
 */
export const CLAUDE_CODE_TOOL_EQUIVALENTS: Readonly<Record<string, string>> = Object.freeze({
  Read: "read_file",
  NotebookRead: "read_file",
  Write: "write_file",
  Edit: "write_file",
  MultiEdit: "write_file",
  NotebookEdit: "write_file",
  Glob: "list_dir",
  Grep: "list_dir",
  LS: "list_dir",
  Bash: RUN_COMMAND_TOOL,
});

/** The loop driver's built-in for one Claude Code tool name (without the prefix), if any. */
function equivalentOf(ccTool: string): string | undefined {
  return Object.hasOwn(CLAUDE_CODE_TOOL_EQUIVALENTS, ccTool)
    ? CLAUDE_CODE_TOOL_EQUIVALENTS[ccTool]
    : undefined;
}

export type DroppedToolReason = "unmapped" | "unavailable" | "commands_not_allowed";

/** One `allowed_tools` entry the loop driver will not offer, with the reason in words. */
export interface DroppedTool {
  /** The name as the registry wrote it (`cc:WebFetch`, `cc:Foo`, a bridged tool name). */
  tool: string;
  reason: DroppedToolReason;
  message: string;
}

export interface LoopToolMapping {
  /** Tool names to put in the run token and to offer the loop driver, in registry order. */
  tools: string[];
  dropped: DroppedTool[];
}

export interface LoopToolOptions {
  /** The loop driver's tool names at this moment (`ToolRegistry.names()`: built-ins plus bridged extension tools). */
  available: readonly string[];
  /**
   * Whether this entry may get `run_command` (through `cc:Bash` or by name): true when the
   * entry requires a sandbox or the executor runs every command inside one (ADR 0007). Default
   * true; the eval runner passes whether it holds a sandbox port.
   */
  commands?: boolean;
}

/**
 * The tool names a registry entry's `allowed_tools` grant on the loop driver: `cc:` names map
 * to their equivalents, Forerunner names pass through, and every name that is unknown, not
 * registered right now, or a command runner the caller refuses is in `dropped` with its
 * reason. Order follows the registry entry; duplicates collapse. Nothing is ever added that the
 * entry did not name: `cc:Read` cannot yield `write_file`, `cc:Bash` only `run_command`.
 */
export function loopToolsFor(
  allowedTools: readonly string[],
  opts: LoopToolOptions,
): LoopToolMapping {
  const commands = opts.commands ?? true;
  const tools: string[] = [];
  const dropped: DroppedTool[] = [];
  for (const name of allowedTools) {
    let mapped: string;
    if (name.startsWith(CLAUDE_CODE_PREFIX)) {
      const equivalent = equivalentOf(name.slice(CLAUDE_CODE_PREFIX.length));
      if (equivalent === undefined) {
        dropped.push({
          tool: name,
          reason: "unmapped",
          message: `${name} has no equivalent on the loop driver; it is offered on the Agent SDK driver only`,
        });
        continue;
      }
      mapped = equivalent;
    } else {
      mapped = name;
    }
    if (mapped === RUN_COMMAND_TOOL && !commands) {
      dropped.push({
        tool: name,
        reason: "commands_not_allowed",
        message: `${name} would grant ${RUN_COMMAND_TOOL}, which is offered only to an entry that requires a sandbox or where the executor sandboxes every command`,
      });
      continue;
    }
    if (!opts.available.includes(mapped)) {
      dropped.push({
        tool: name,
        reason: "unavailable",
        message:
          mapped === name
            ? `${name} is not registered in this runtime`
            : `${name} maps to ${mapped}, which is not registered in this runtime`,
      });
      continue;
    }
    if (!tools.includes(mapped)) tools.push(mapped);
  }
  return { tools, dropped };
}
