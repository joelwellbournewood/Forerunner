import { ForerunnerError } from "@forerunner/platform";
// Deep imports (browser-safe, no runtime index): the runtime package imports this package, so
// reading the schemas through `@forerunner/runtime` would meet a half-initialised module.
import {
  AGENT_SETTING_MODES,
  AgentModelConfigSchema,
  type AgentSettingMode,
  RUN_SETTING_FIELDS,
  type RunSettingField,
  RunSettingsOverrideSchema,
} from "@forerunner/runtime/models/run-settings";
import type { EffortLevel } from "@forerunner/runtime/provider/types";
import { EFFORT_VALUES, NAME_RE } from "@forerunner/runtime/registry/types";
import type { AgentRow, JsonObject, JsonValue } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, Risk } from "../types.ts";
import { asObject, authorOf } from "./shared.ts";

/**
 * model.settings.set (spec D.4, ADR 0072): one setting of one agent's own mode or of one
 * specialist the agent delegates to: model rung, effort, max tokens, speed mode, timeout or
 * temperature. It writes the agent row's `model_config` (`modes.<mode>.<field>` or
 * `specialists.<name>.<field>`); `value: null` removes the override so the registry file or the
 * effort table applies again. The settings screen, chat and voice all run this command, so
 * every change has a card, a change log row and an undo.
 */

/** Plain words for each field, for the card and the change log sentence. */
export const MODEL_SETTING_LABELS: Record<RunSettingField, string> = {
  tier: "the model",
  effort: "the effort",
  max_tokens: "the max tokens per call",
  speed_mode: "the speed mode",
  timeout_minutes: "the timeout in minutes",
  temperature: "the temperature",
};

const MODE_LABELS: Record<AgentSettingMode, string> = {
  planning: "planning",
  text_chat: "chat",
};

const params = z
  .object({
    /** Agent id; default the asking human's principal agent. */
    agent: z.string().min(1).optional(),
    /** One of the agent's own modes ... */
    mode: z.enum(AGENT_SETTING_MODES).optional(),
    /** ... or one specialist by registry name. */
    specialist: z.string().regex(NAME_RE, "specialist names are registry names").optional(),
    field: z.enum(RUN_SETTING_FIELDS),
    /** The new value; null goes back to the default. */
    value: z.unknown(),
  })
  .refine((p) => (p.mode === undefined) !== (p.specialist === undefined), {
    message: "name either an agent mode or a specialist",
  });
export type ModelSettingsSetParams = z.infer<typeof params>;

/** Raising cost or speed asks for a yes; the rest is reversible bookkeeping. */
function riskOf(p: ModelSettingsSetParams): Risk {
  if (p.value === null || p.value === undefined) return "low";
  if (p.field === "tier" || p.field === "effort") return "medium";
  if (p.field === "speed_mode" && p.value === "fast") return "medium";
  return "low";
}

interface Target {
  agent: AgentRow;
  path: ["modes", AgentSettingMode] | ["specialists", string];
  field: RunSettingField;
  value: JsonValue | null;
  current: JsonValue | null;
  what: string;
}

function show(v: JsonValue | null): string {
  if (v === null || v === undefined) return "the default";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function subtree(config: JsonObject, path: Target["path"]): JsonObject {
  const group = config[path[0]];
  if (!group || typeof group !== "object" || Array.isArray(group)) return {};
  const entry = (group as JsonObject)[path[1]];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as JsonObject) : {};
}

async function target(p: ModelSettingsSetParams, ctx: CommandContext): Promise<Target> {
  const agentId = p.agent ?? ctx.agentId;
  if (!agentId) throw new ForerunnerError("validation", "no agent to change; name one");
  const agent = await ctx.store.agent.get(agentId);
  // Only the human's own agents: a peer's agent is never changed from this install.
  if (!agent || agent.owner_human_id !== ctx.humanId) {
    throw new ForerunnerError("not_found", `no agent ${agentId} of yours`, {
      details: { agent: agentId },
    });
  }
  if (agent.kind !== "principal") {
    throw new ForerunnerError(
      "validation",
      `${agent.name} is a ${agent.kind} agent; its model follows its own rules (the critic's review tiers)`,
      { details: { agent: agent.id, kind: agent.kind } },
    );
  }
  const ports = ctx.ports.modelSettings;
  if (p.specialist !== undefined && ports && !ports.specialists().includes(p.specialist)) {
    throw new ForerunnerError("not_found", `no runnable specialist ${p.specialist}`, {
      details: { specialist: p.specialist, known: [...ports.specialists()] },
    });
  }
  let value: JsonValue | null = null;
  if (p.value !== null && p.value !== undefined) {
    const parsed = RunSettingsOverrideSchema.shape[p.field].safeParse(p.value);
    if (!parsed.success || parsed.data === undefined) {
      throw new ForerunnerError(
        "validation",
        `${p.field}: ${parsed.success ? "a value is required" : parsed.error.issues.map((i) => i.message).join("; ")}`,
        { details: { field: p.field } },
      );
    }
    value = parsed.data as JsonValue;
  }
  // A specialist's effort never above its file's `max_effort` (the executor caps a run there):
  // a value that could never run is refused, not stored.
  if (p.field === "effort" && value !== null && p.specialist !== undefined) {
    const max = ports?.maxEffort?.(p.specialist);
    if (max && EFFORT_VALUES.indexOf(value as EffortLevel) > EFFORT_VALUES.indexOf(max)) {
      throw new ForerunnerError(
        "validation",
        `effort: the ${p.specialist} specialist runs at most at ${max} (its max_effort)`,
        { details: { field: p.field, maxEffort: max } },
      );
    }
  }
  // Temperature only where the provider in use accepts one (spec D.4): never stored for a
  // provider that would drop it, so the screen never shows a value that does nothing.
  if (p.field === "temperature" && value !== null && !ports?.capabilities().acceptsTemperature) {
    throw new ForerunnerError(
      "validation",
      "the provider in use does not accept a temperature; nothing to set",
      { details: { field: p.field } },
    );
  }
  const path: Target["path"] =
    p.mode !== undefined ? ["modes", p.mode] : ["specialists", p.specialist as string];
  const current = subtree(agent.model_config, path)[p.field] ?? null;
  const subject =
    path[0] === "modes"
      ? `${agent.name}'s ${MODE_LABELS[path[1]]}`
      : `the ${path[1]} specialist for ${agent.name}`;
  return {
    agent,
    path,
    field: p.field,
    value,
    current,
    what: `${MODEL_SETTING_LABELS[p.field]} of ${subject}`,
  };
}

function sentenceOf(t: Target): string {
  return `Set ${t.what} from ${show(t.current)} to ${show(t.value)}. Undo.`;
}

/** The agent's `model_config` with one field set (or removed), validated before it is written. */
async function write(
  ctx: CommandContext,
  agentId: string,
  path: Target["path"],
  field: RunSettingField,
  value: JsonValue | null,
): Promise<void> {
  const agent = await ctx.store.agent.mustGet(agentId);
  const config: JsonObject = { ...agent.model_config };
  const groupRaw = config[path[0]];
  const group: JsonObject =
    groupRaw && typeof groupRaw === "object" && !Array.isArray(groupRaw)
      ? { ...(groupRaw as JsonObject) }
      : {};
  const entry: JsonObject = { ...subtree(config, path) };
  if (value === null) delete entry[field];
  else entry[field] = value;
  if (Object.keys(entry).length) group[path[1]] = entry;
  else delete group[path[1]];
  if (Object.keys(group).length) config[path[0]] = group;
  else delete config[path[0]];
  const checked = AgentModelConfigSchema.safeParse(config);
  if (!checked.success) {
    throw new ForerunnerError(
      "validation",
      `the agent's model settings would not be valid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  await ctx.store.agent.update(agentId, agent.version, {
    model_config: config,
    ...authorOf(ctx),
  } as never);
}

export const modelSettingsSet: CommandDef<ModelSettingsSetParams> = {
  name: "model.settings.set",
  description:
    "Change one model setting of your agent's planning or chat, or of one specialist it delegates to: tier, effort, max_tokens, speed_mode, timeout_minutes or temperature (only where the provider accepts one); value null returns to the default.",
  params,
  risk: (p) => riskOf(p),
  maxRisk: "medium",
  scope: "global",
  reversible: true,
  undoStrategy: "restore the previous value of the agent's model_config field",
  async plan(p, ctx) {
    const t = await target(p, ctx);
    return buildCard({
      command: "model.settings.set",
      what: t.what,
      oldValue: show(t.current),
      newValue: show(t.value),
      scope: "global",
      risk: riskOf(p),
      sentence: sentenceOf(t),
      reversible: true,
    });
  },
  async run(p, ctx) {
    const t = await target(p, ctx);
    await write(ctx, t.agent.id, t.path, t.field, t.value);
    const where = { agent_id: t.agent.id, group: t.path[0], name: t.path[1], field: t.field };
    return {
      before: { ...where, value: t.current },
      after: { ...where, value: t.value },
      sentence: sentenceOf(t),
      projectId: null,
    };
  },
  // U-057: the value the undo puts back asks as setting it would (a tier or an effort, or
  // fast speed, a yes); clearing an override acts at once.
  async undoRisk(p, before) {
    const value = asObject(before).value;
    return riskOf({ ...p, value: (value ?? null) as ModelSettingsSetParams["value"] });
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    if (
      typeof b.agent_id !== "string" ||
      (b.group !== "modes" && b.group !== "specialists") ||
      typeof b.name !== "string" ||
      typeof b.field !== "string" ||
      !(RUN_SETTING_FIELDS as readonly string[]).includes(b.field)
    )
      return;
    await write(
      ctx,
      b.agent_id,
      [b.group, b.name] as Target["path"],
      b.field as RunSettingField,
      (b.value ?? null) as JsonValue | null,
    );
  },
};
