import { ForerunnerError } from "@forerunner/platform";
// The module path, not the package index: the index imports this package back (a cycle).
import { FAST_MODE_SETTING, fastModeEffect } from "@forerunner/runtime/models/fast-mode";
import type { HumanRow, JsonValue, ProjectRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, Risk } from "../types.ts";
import {
  asObject,
  authorOf,
  patchHumanPrefs,
  patchProjectSettings,
  resolveProject,
} from "./shared.ts";

/**
 * settings.set: the generic key/value command behind the settings screen. Every key is in
 * SETTING_SPECS with its scope, risk and schema, so a setting changed by voice or chat goes
 * through the same validation and confirmation as the UI. Unknown keys are refused.
 */
export interface SettingSpec {
  key: string;
  label: string;
  scope: "project" | "global";
  risk: Risk;
  schema: z.ZodType<JsonValue>;
  /** A column instead of the JSON bag, when the row has one. */
  column?: keyof ProjectRow | keyof HumanRow;
  description: string;
  /**
   * What the new value changes in practice, for the card's new value and the change log
   * sentence ("Set X from a to b: <effect>. Undo."), when the key's name alone does not say.
   */
  effect?: (value: JsonValue) => string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What flipping small-project mode (spec B.6) changes; existing tasks keep their tier. */
export const SMALL_PROJECT_MODE_EFFECT = {
  on: "new tasks default to critic tier 0 and the next plan is written as one milestone with a flat task list; existing tasks keep their tier",
  off: "new tasks default to critic tier 1 and the next plan may have several milestones; existing tasks keep their tier",
} as const;

export const SETTING_SPECS: Record<string, SettingSpec> = {
  speed_quality_offset: {
    key: "speed_quality_offset",
    label: "the speed-versus-quality slider",
    scope: "project",
    risk: "low",
    schema: z.number().int().min(-2).max(2),
    description: "Shifts model effort per project: -2 fastest, +2 best quality.",
  },
  critic_ceiling: {
    key: "critic_ceiling",
    label: "the critic model ceiling",
    scope: "project",
    risk: "medium",
    schema: z.string().min(1),
    description: "Highest model rung the critic may use for the project.",
  },
  session_reserve_share: {
    key: "session_reserve_share",
    label: "the review reserve share",
    scope: "project",
    risk: "medium",
    schema: z.number().min(0.15).max(0.25),
    description: "Share of each session budget kept for review and fixes.",
  },
  small_project_mode: {
    key: "small_project_mode",
    label: "small project mode",
    scope: "project",
    risk: "low",
    schema: z.boolean(),
    column: "small_project_mode",
    description: "One milestone, flat task list, critic tier 0 by default.",
    effect: (value) =>
      value === true ? SMALL_PROJECT_MODE_EFFECT.on : SMALL_PROJECT_MODE_EFFECT.off,
  },
  [FAST_MODE_SETTING]: {
    key: FAST_MODE_SETTING,
    label: "Opus fast mode",
    scope: "project",
    // It raises what every Opus call of the project costs: a yes before it changes.
    risk: "medium",
    schema: z.boolean(),
    description:
      "Opus fast mode for urgent work (research preview, API only, priced separately): Opus runs of the project on an API key ask for the fast variant.",
    // Spec D.20, ADR 0057: the effect and the surcharge both ways, from the price table.
    effect: (value) => fastModeEffect(value === true),
  },
  shared_with: {
    key: "shared_with",
    label: "who the project is shared with",
    scope: "project",
    risk: "high",
    schema: z.array(z.string()),
    description: "Human ids that see the project's data and change sentences.",
  },
  quiet_hours: {
    key: "quiet_hours",
    label: "quiet hours",
    scope: "global",
    risk: "low",
    schema: z.object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) }),
    description:
      "No notifications and no non-manual session starts between start and end (local time).",
  },
  notify_channel: {
    key: "notify_channel",
    label: "the notification channel",
    scope: "global",
    risk: "low",
    schema: z.enum(["desktop", "email", "telegram", "signal", "push"]),
    description: "Where notifications go.",
  },
  default_autonomy: {
    key: "default_autonomy",
    label: "the default autonomy for new projects",
    scope: "global",
    risk: "medium",
    schema: z.number().int().min(0).max(4),
    column: "default_autonomy",
    description: "Autonomy level new projects start with.",
  },
  language: {
    key: "language",
    label: "the language",
    scope: "global",
    risk: "low",
    schema: z.enum(["en", "de"]),
    column: "locale",
    description: "UI and voice language.",
  },
};

/** Own keys only: "constructor" or "__proto__" are unknown settings, not prototype lookups. */
export function settingSpec(key: string): SettingSpec {
  const spec = Object.hasOwn(SETTING_SPECS, key) ? SETTING_SPECS[key] : undefined;
  if (!spec) {
    throw new ForerunnerError("validation", `unknown setting ${key}`, {
      details: { key, known: Object.keys(SETTING_SPECS) },
    });
  }
  return spec;
}

const params = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  project: z.string().optional(),
});
export type SettingsSetParams = z.infer<typeof params>;

function show(v: unknown): string {
  if (v === undefined || v === null) return "unset";
  return typeof v === "string" ? v : JSON.stringify(v);
}

interface Target {
  spec: SettingSpec;
  value: JsonValue;
  project: ProjectRow | null;
  usedActive: boolean;
  human: HumanRow;
  current: JsonValue | null;
  what: string;
}

async function target(p: SettingsSetParams, ctx: CommandContext): Promise<Target> {
  const spec = settingSpec(p.key);
  const parsed = spec.schema.safeParse(p.value);
  if (!parsed.success) {
    throw new ForerunnerError(
      "validation",
      `${p.key}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      {
        details: { key: p.key },
      },
    );
  }
  const human = await ctx.store.human.mustGet(ctx.humanId);
  if (spec.scope === "project") {
    const { project, usedActive } = await resolveProject(ctx, p.project);
    const current = spec.column
      ? ((project[spec.column as keyof ProjectRow] as JsonValue | undefined) ?? null)
      : (project.settings[spec.key] ?? null);
    return {
      spec,
      value: parsed.data,
      project,
      usedActive,
      human,
      current,
      what: `${spec.label} for ${project.name}`,
    };
  }
  const current = spec.column
    ? ((human[spec.column as keyof HumanRow] as JsonValue | undefined) ?? null)
    : (human.notify_prefs[spec.key] ?? null);
  return {
    spec,
    value: parsed.data,
    project: null,
    usedActive: false,
    human,
    current,
    what: spec.label,
  };
}

function sentenceOf(t: Target): string {
  const effect = t.spec.effect?.(t.value);
  return `Set ${t.what} from ${show(t.current)} to ${show(t.value)}${effect ? `: ${effect}` : ""}. Undo.`;
}

/** The card's new value, with what it changes when the key defines an effect. */
function newValueOf(t: Target): string {
  const effect = t.spec.effect?.(t.value);
  return effect ? `${show(t.value)} (${effect})` : show(t.value);
}

async function write(
  ctx: CommandContext,
  spec: SettingSpec,
  projectId: string | null,
  value: JsonValue | null,
) {
  const author = authorOf(ctx);
  if (spec.scope === "project") {
    const id = projectId as string;
    if (spec.column) {
      const project = await ctx.store.project.mustGet(id);
      await ctx.store.project.update(id, project.version, {
        [spec.column]: value,
        ...author,
      } as never);
    } else {
      await patchProjectSettings(ctx.store, id, { [spec.key]: value }, author);
    }
    return;
  }
  if (spec.column) {
    await patchHumanPrefs(ctx.store, ctx.humanId, {}, { [spec.column]: value, ...author } as never);
  } else {
    await patchHumanPrefs(ctx.store, ctx.humanId, { [spec.key]: value }, author);
  }
}

export const settingsSet: CommandDef<SettingsSetParams> = {
  name: "settings.set",
  description: `Change a setting by key. Keys: ${Object.keys(SETTING_SPECS).join(", ")}.`,
  params,
  risk: (p) => settingSpec(p.key).risk,
  maxRisk: "high",
  scope: (p) =>
    Object.hasOwn(SETTING_SPECS, p.key) && SETTING_SPECS[p.key]?.scope === "global"
      ? "global"
      : "project",
  reversible: true,
  undoStrategy: "restore the previous value from the change log",
  async plan(p, ctx) {
    const t = await target(p, ctx);
    return buildCard({
      command: "settings.set",
      what: t.what,
      oldValue: show(t.current),
      newValue: newValueOf(t),
      scope: t.spec.scope === "global" ? "global" : "project",
      risk: t.spec.risk,
      sentence: sentenceOf(t),
      reversible: true,
      projectId: t.project?.id ?? null,
      projectName: t.project?.name ?? null,
      usesActiveProject: t.usedActive,
    });
  },
  async run(p, ctx) {
    const t = await target(p, ctx);
    await write(ctx, t.spec, t.project?.id ?? null, t.value);
    return {
      before: { key: t.spec.key, project_id: t.project?.id ?? null, value: t.current },
      after: { key: t.spec.key, project_id: t.project?.id ?? null, value: t.value },
      sentence: sentenceOf(t),
      projectId: t.project?.id ?? null,
    };
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    if (typeof b.key !== "string") return;
    const spec = settingSpec(b.key);
    await write(ctx, spec, typeof b.project_id === "string" ? b.project_id : null, b.value ?? null);
  },
};
