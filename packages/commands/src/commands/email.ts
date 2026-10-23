import { ForerunnerError } from "@forerunner/platform";
import type { AgentRow, ExtensionRow, JsonObject } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef } from "../types.ts";
import { asObject, authorOf } from "./shared.ts";

/**
 * email.mode.set (spec S.15-S.20, Q high risk): the per-agent email mode. The configuration
 * row is the one the capabilities package reads (extension kind "capability", name
 * "email:<agentId>", config.settings.mode); this command patches the mode, and under ADR 0081
 * a change to `off` also turns email commands off (they need a sending mode other than off),
 * through the daemon's settings store when `ports.emailMode` is wired.
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

/** Email commands are switched on in the row (whatever the mode). */
function commandsOnIn(row: ExtensionRow | undefined): boolean {
  return asObject((row?.config as JsonObject | undefined)?.commands ?? null).enabled === true;
}

/** The audit tool the capability's settings store records settings changes under. */
const EMAIL_SETTINGS_TOOL = "email.settings";

/**
 * Sets the mode under ADR 0081: email commands cannot be on at mode `off`, so a change to off
 * turns them off in the same write. Production goes through the daemon's settings store
 * (`ports.emailMode`), which writes the `commands_switched_off` audit row and tells the owner;
 * without that port the row is written here under the same rule and with the same audit row.
 */
async function applyMode(
  ctx: CommandContext,
  agent: AgentRow,
  mode: EmailMode,
  restoreCommands = false,
): Promise<{ commandsSwitchedOff: boolean }> {
  const author = authorOf(ctx);
  if (ctx.ports.emailMode) {
    return ctx.ports.emailMode({
      agentId: agent.id,
      mode,
      authorHuman: author.author_human,
      restoreCommands: restoreCommands && mode !== "off",
    });
  }
  const row = await ctx.store.extension.byName(EMAIL_EXTENSION_KIND, emailExtensionName(agent.id));
  if (!row) {
    await ctx.store.extension.insert({
      kind: EMAIL_EXTENSION_KIND,
      name: emailExtensionName(agent.id),
      enabled: mode !== "off",
      permissions: [`email:${mode}`],
      config: { settings: { mode }, commands: {} },
      ...author,
    });
    return { commandsSwitchedOff: false };
  }
  const modeBefore = modeOf(row);
  const config = { ...(row.config as JsonObject) };
  config.settings = { ...asObject(config.settings ?? null), mode };
  const wanted = commandsOnIn(row) || (restoreCommands && mode !== "off");
  const commandsSwitchedOff = mode === "off" && wanted;
  const commandsOn = wanted && !commandsSwitchedOff;
  config.commands = { ...asObject(config.commands ?? null), enabled: commandsOn };
  const others = (Array.isArray(row.permissions) ? row.permissions : []).filter(
    (x): x is string => typeof x === "string" && !x.startsWith("email:") && x !== "email-commands",
  );
  await ctx.store.extension.update(row.id, row.version, {
    config,
    permissions: [`email:${mode}`, ...(commandsOn ? ["email-commands"] : []), ...others],
    enabled: mode !== "off" || commandsOn,
    ...author,
  });
  if (commandsSwitchedOff) {
    const at = ctx.clock.nowIso();
    await ctx.store.auditLog.append({
      tool: EMAIL_SETTINGS_TOOL,
      allowed: true,
      agent_id: agent.id,
      human_id: author.author_human,
      input_summary: JSON.stringify({
        action: "commands_switched_off",
        reason: "mode_off",
        modeBefore,
        modeAfter: "off",
      }),
      result_summary: JSON.stringify({ status: "commands_off", reason: "mode_off" }),
      cost_usd_micro: 0,
      occurred_at: at,
      author_human: author.author_human,
    });
  }
  return { commandsSwitchedOff };
}

function sentenceOf(
  agent: AgentRow,
  from: EmailMode,
  to: EmailMode,
  commandsSwitchedOff = false,
): string {
  const also = commandsSwitchedOff
    ? "; email commands are turned off with it, because at Off the agent could not answer them"
    : "";
  return `Changed the email mode of ${agent.name} from ${EMAIL_MODE_LABELS[from]} to ${EMAIL_MODE_LABELS[to]}${also}. Undo.`;
}

export const emailModeSet: CommandDef<EmailModeSetParams> = {
  name: "email.mode.set",
  description:
    "Set an agent's email mode: off, read_only, draft_only, allowlist or full_discretion (full discretion lets the agent email strangers; off also turns email commands off).",
  params,
  risk: "high",
  scope: "global",
  reversible: true,
  undoStrategy: "restore the previous mode (and email commands, when the change turned them off)",
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
      sentence: sentenceOf(agent, current, p.mode, p.mode === "off" && commandsOnIn(row)),
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
    const { commandsSwitchedOff } = await applyMode(ctx, agent, p.mode);
    return {
      before: { agent_id: agent.id, mode: current, commands_enabled: commandsOnIn(row) },
      after: {
        agent_id: agent.id,
        mode: p.mode,
        commands_switched_off: commandsSwitchedOff,
      },
      sentence: sentenceOf(agent, current, p.mode, commandsSwitchedOff),
    };
  },
  async undo(_p, before, after, ctx) {
    const b = asObject(before);
    if (typeof b.agent_id !== "string" || typeof b.mode !== "string") return;
    const agent = await ctx.store.agent.mustGet(b.agent_id);
    // A change to off that turned email commands off is undone with them (ADR 0081).
    const restore = asObject(after).commands_switched_off === true && b.mode !== "off";
    await applyMode(ctx, agent, b.mode as EmailMode, restore);
  },
};
