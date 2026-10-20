import { ForerunnerError } from "@forerunner/platform";
import type { ActionClass, ToolExecutionContext, ToolResult, ToolSpec } from "@forerunner/runtime";
import type { CommandRow, JsonObject, StateStore } from "@forerunner/state";
import { z } from "zod";
import { renderChangeCard } from "./change-card.ts";
import type { CommandContext, CommandDef, Risk } from "./types.ts";

/**
 * One command registry (spec Q.1). Commands are registered once at startup, validated by
 * their zod schema on every call, persisted into the `command` table (idempotent) and turned
 * into runtime ToolSpecs so the conversation agent calls the same commands as the buttons.
 */
const NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export class CommandRegistry {
  private readonly defs = new Map<string, CommandDef<unknown>>();

  register<P>(def: CommandDef<P>): this {
    if (!NAME_RE.test(def.name)) {
      throw new ForerunnerError(
        "validation",
        `command name must be dotted lower case: ${def.name}`,
        {
          details: { name: def.name },
        },
      );
    }
    if (this.defs.has(def.name)) {
      throw new ForerunnerError("validation", `command already registered: ${def.name}`, {
        details: { name: def.name },
      });
    }
    this.defs.set(def.name, def as CommandDef<unknown>);
    return this;
  }

  get(name: string): CommandDef<unknown> | undefined {
    return this.defs.get(name);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  mustGet(name: string): CommandDef<unknown> {
    const def = this.defs.get(name);
    if (!def) {
      throw new ForerunnerError("not_found", `unknown command ${name}`, {
        details: { name, known: this.names() },
      });
    }
    return def;
  }

  list(): CommandDef<unknown>[] {
    return [...this.defs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return [...this.defs.keys()].sort();
  }

  /** Parse and validate parameters; throws ForerunnerError("validation") with the issues. */
  validate(name: string, params: unknown): unknown {
    const def = this.mustGet(name);
    const parsed = def.params.safeParse(params ?? {});
    if (!parsed.success) {
      throw new ForerunnerError("validation", `${name}: invalid parameters`, {
        details: {
          name,
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    return parsed.data;
  }

  /** JSON schema of a command's parameters (for the command table and tool definitions). */
  schemaJson(name: string): JsonObject {
    const def = this.mustGet(name);
    return z.toJSONSchema(def.params) as JsonObject;
  }

  /**
   * Insert or update every command in the `command` table. Safe to run at every start: the
   * repository upserts by name and nothing else reads the rows for behaviour.
   */
  async persist(store: StateStore): Promise<CommandRow[]> {
    const rows: CommandRow[] = [];
    for (const def of this.list()) {
      rows.push(
        await store.command.register({
          name: def.name,
          parameters_schema: this.schemaJson(def.name),
          risk: staticRisk(def),
          undo_strategy: def.reversible ? def.undoStrategy : `irreversible: ${def.undoStrategy}`,
          description: def.description,
        }),
      );
    }
    return rows;
  }
}

/** The risk shown for a command before its parameters are known. */
export function staticRisk(def: CommandDef<unknown>): Risk {
  return typeof def.risk === "function" ? (def.maxRisk ?? "high") : def.risk;
}

export function actionClassFor(def: CommandDef<unknown>): ActionClass {
  if (def.actionClass) return def.actionClass;
  switch (staticRisk(def)) {
    case "low":
      return "routine_reversible";
    case "medium":
      return "non_routine";
    default:
      return "permission_change";
  }
}

/** Tool names may not contain dots: "budget.set" -> "budget_set". */
export function toolNameFor(command: string): string {
  return command.replace(/\./g, "_");
}

export interface ToolBinding {
  /** Runs a command (the executor's execute). */
  execute(call: { name: string; params: unknown; ctx: CommandContext }): Promise<ToolOutcome>;
  /** Builds the command context for a tool call of the conversation agent. */
  ctxFor(tool: ToolExecutionContext, command: string): CommandContext | Promise<CommandContext>;
}

/** The subset of an ExecuteResult a tool needs to answer the model. */
export interface ToolOutcome {
  status: "done" | "partial" | "pending" | "refused" | "cancelled";
  sentence?: string;
  reason?: string;
  card?: { sentence: string } & Parameters<typeof renderChangeCard>[0];
  pendingId?: string;
}

/**
 * One ToolSpec per command for the conversation agent: the command's schema, an action class
 * by risk, and an execute that goes through the executor (validation, card, confirmation,
 * change log). A pending confirmation is reported back as text for the agent to read out.
 */
export function toToolSpecs(registry: CommandRegistry, binding: ToolBinding): ToolSpec[] {
  return registry.list().map((def) => {
    const spec: ToolSpec<unknown> = {
      name: toolNameFor(def.name),
      description: def.description,
      schema: def.params,
      actionClass: actionClassFor(def),
      risk: staticRisk(def),
      async execute(input: unknown, tool: ToolExecutionContext): Promise<ToolResult> {
        const ctx = await binding.ctxFor(tool, def.name);
        const out = await binding.execute({ name: def.name, params: input, ctx });
        switch (out.status) {
          case "done":
          case "partial":
            return { content: out.sentence ?? "done" };
          case "pending":
            return {
              content: `Needs confirmation (${out.pendingId ?? "pending"}). ${
                out.card ? renderChangeCard(out.card, { voice: true }) : ""
              }`.trim(),
            };
          case "cancelled":
            return { content: "Cancelled; nothing was changed." };
          default:
            return { content: `Refused: ${out.reason ?? "not allowed"}`, isError: true };
        }
      },
    };
    return spec as ToolSpec;
  });
}
