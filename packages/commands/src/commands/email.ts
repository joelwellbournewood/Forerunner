import { ForerunnerError } from "@forerunner/platform";
import type { AgentRow, ExtensionRow, JsonObject } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { asObject, authorOf } from "./shared.ts";

/**
 * email.mode.set (spec S.15-S.20, Q high risk): the per-agent email mode. The configuration
 * row is the one the capabilities package reads (extension kind "capability", name
 * "email:<agentId>", config.settings.mode); this command patches the mode only.
 */
export const EMAIL_MODES = [
  "off",
  "read_only",
  "draft_only",
  "allowlist",
  "full_discretion",
] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
export const EMAIL_MODE_LABELS: Record<EmailMode, string> = {
  off: "Off",
  read_only: "Read only",
  draft_only: "Draft only",
  allowlist: "Allowlist",
  full_discretion: "Full discretion",
};
export const EMAIL_EXTENSION_KIND = "capability" as const;
export function emailExtensionName(agentId: string): string {
  return `email:${agentId}`;
}

const params = z.object({
  mode: z.enum(EMAIL_MODES),
  /** Agent id or name; the human's principal agent when absent. */
  agent: z.string().optional(),
});
export type EmailModeSetParams = z.infer<typeof params>;

async function agentOf(p: EmailModeSetParams, ctx: CommandContext): Promise<AgentRow> {
  if (p.agent) {
    const direct = await ctx.store.agent.get(p.agent);
    if (direct) return direct;
    const named = await ctx.store.agent.byName(ctx.humanId, p.agent);
    if (named) return named;
    throw new ForerunnerError("not_found", `no agent ${p.agent}`);
  }
  if (!ctx.agentId) throw new ForerunnerError("validation", "no principal agent for this human");
  return ctx.store.agent.mustGet(ctx.agentId);
}

function modeOf(row: ExtensionRow | undefined): EmailMode {
  const settings = asObject((row?.config as JsonObject | undefined)?.settings ?? null);
  const mode = settings.mode;
  return typeof mode === "string" && (EMAIL_MODES as readonly string[]).includes(mode)
    ? (mode as EmailMode)
    : "off";
}

async function applyMode(ctx: CommandContext, agent: AgentRow, mode: EmailMode): Promise<void> {
  const row = await ctx.store.extension.byName(EMAIL_EXTENSION_KIND, emailExtensionName(agent.id));
  const author = authorOf(ctx);
  if (!row) {
    await ctx.store.extension.insert({
      kind: EMAIL_EXTENSION_KIND,
      name: emailExtensionName(agent.id),
      enabled: mode !== "off",
      permissions: [`email:${mode}`],
      config: { settings: { mode }, commands: {} },
      ...author,
    });
    return;
  }
  const config = { ...(row.config as JsonObject) };
  const settings = { ...asObject(config.settings ?? null), mode };
  config.settings = settings;
  const commands = asObject(config.commands ?? null);
  const others = (Array.isArray(row.permissions) ? row.permissions : []).filter(
    (x): x is string => typeof x === "string" && !x.startsWith("email:"),
  );
  await ctx.store.extension.update(row.id, row.version, {
    config,
    permissions: [`email:${mode}`, ...others],
    enabled: mode !== "off" || commands.enabled === true,
    ...author,
  });
}

function sentenceOf(agent: AgentRow, from: EmailMode, to: EmailMode): string {
  return `Changed the email mode of ${agent.name} from ${EMAIL_MODE_LABELS[from]} to ${EMAIL_MODE_LABELS[to]}. Undo.`;
}

export const emailModeSet: CommandDef<EmailModeSetParams> = {
  name: "email.mode.set",
  description:
    "Set an agent's email mode: off, read_only, draft_only, allowlist or full_discretion (full discretion lets the agent email strangers).",
  params,
  risk: "high",
  scope: "global",
  reversible: true,
  undoStrategy: "restore the previous mode",
  actionClass: "permission_change",
  limit: true,
  async plan(p, ctx) {
    const agent = await agentOf(p, ctx);
    const row = await ctx.store.extension.byName(
      EMAIL_EXTENSION_KIND,
      emailExtensionName(agent.id),
    );
    const current = modeOf(row);
    return buildCard({
      command: "email.mode.set",
      what: `the email mode of ${agent.name}`,
      oldValue: EMAIL_MODE_LABELS[current],
      newValue: EMAIL_MODE_LABELS[p.mode],
      scope: "global",
      risk: "high",
      sentence: sentenceOf(agent, current, p.mode),
      reversible: true,
    });
  },
  async run(p, ctx) {
    const agent = await agentOf(p, ctx);
    const row = await ctx.store.extension.byName(
      EMAIL_EXTENSION_KIND,
      emailExtensionName(agent.id),
    );
    const current = modeOf(row);
    await applyMode(ctx, agent, p.mode);
    return {
      before: { agent_id: agent.id, mode: current },
      after: { agent_id: agent.id, mode: p.mode },
      sentence: sentenceOf(agent, current, p.mode),
    };
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.agent_id !== "string" || typeof b.mode !== "string") return;
    const agent = await ctx.store.agent.mustGet(b.agent_id);
    await applyMode(ctx, agent, b.mode as EmailMode);
  },
};
