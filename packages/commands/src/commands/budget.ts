import {
  chfMicro,
  chfToUsdMicro,
  DEFAULT_MONTHLY_CAP_CHF,
  DEFAULT_SESSION_CAP_CHF,
  usdToChfMicro,
} from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { HumanRow, JsonObject, ProjectRow } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import { describeUntil, isIsoInstant, windowAdjective } from "../time.ts";
import type { CommandContext, CommandDef, CommandOutcome, CommandScope, Risk } from "../types.ts";
import {
  asObject,
  authorOf,
  chf,
  patchHumanPrefs,
  patchProjectSettings,
  type ResolvedProject,
  resolveProject,
} from "./shared.ts";

/**
 * budget.set (spec I, Q): session, project and monthly caps in CHF, stored in USD micro-units
 * with the CHF figure beside it. A session budget "until 06:00" is a temporary override in
 * project.settings.session_budget_override that the executor reverts on time. Risk: raising a
 * budget within the monthly hard ceiling is medium; above it, or raising the ceiling itself,
 * is high. The ceiling is human.monthly_cap_usd_micro (the spec default CHF 150 when unset).
 */
export const SESSION_OVERRIDE_KEY = "session_budget_override";
export const SESSION_CAP_KEY = "session_cap_usd_micro";
export const SESSION_CAP_CHF_KEY = "session_cap_chf_micro";
export const PROJECT_BUDGET_CHF_KEY = "budget_chf_micro";
export const MONTHLY_CAP_CHF_KEY = "monthly_cap_chf_micro";

export interface SessionBudgetOverride {
  cap_usd_micro: number;
  cap_chf_micro: number;
  rate_chf_per_usd: number;
  expires_at: string;
}

export interface BudgetValue {
  usdMicro: number;
  chfMicro: number;
  origin: "override" | "project" | "human" | "default";
  expiresAt: string | null;
}

export async function rateOf(ctx: CommandContext): Promise<number> {
  return ctx.ports.chfPerUsd(ctx.clock.nowIso());
}

function overrideOf(project: ProjectRow): SessionBudgetOverride | null {
  const o = project.settings[SESSION_OVERRIDE_KEY];
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Partial<SessionBudgetOverride>;
  if (typeof r.cap_usd_micro !== "number" || typeof r.expires_at !== "string") return null;
  return {
    cap_usd_micro: r.cap_usd_micro,
    cap_chf_micro: typeof r.cap_chf_micro === "number" ? r.cap_chf_micro : 0,
    rate_chf_per_usd: typeof r.rate_chf_per_usd === "number" ? r.rate_chf_per_usd : 0,
    expires_at: r.expires_at,
  };
}

/** The session budget that applies now: an unexpired override, the project's cap, or the default. */
export async function sessionBudgetOf(
  project: ProjectRow,
  ctx: CommandContext,
): Promise<BudgetValue> {
  const rate = await rateOf(ctx);
  const override = overrideOf(project);
  if (override && Date.parse(override.expires_at) > ctx.clock.now()) {
    return {
      usdMicro: override.cap_usd_micro,
      chfMicro: override.cap_chf_micro || usdToChfMicro(override.cap_usd_micro, rate),
      origin: "override",
      expiresAt: override.expires_at,
    };
  }
  const capUsd = project.settings[SESSION_CAP_KEY];
  if (typeof capUsd === "number" && capUsd > 0) {
    const capChf = project.settings[SESSION_CAP_CHF_KEY];
    return {
      usdMicro: capUsd,
      chfMicro: typeof capChf === "number" ? capChf : usdToChfMicro(capUsd, rate),
      origin: "project",
      expiresAt: null,
    };
  }
  const chfDefault = chfMicro(DEFAULT_SESSION_CAP_CHF);
  return {
    usdMicro: chfToUsdMicro(chfDefault, rate),
    chfMicro: chfDefault,
    origin: "default",
    expiresAt: null,
  };
}

/** The monthly hard ceiling of a human. */
export async function monthlyCeilingOf(human: HumanRow, ctx: CommandContext): Promise<BudgetValue> {
  const rate = await rateOf(ctx);
  if (human.monthly_cap_usd_micro > 0) {
    const capChf = human.notify_prefs[MONTHLY_CAP_CHF_KEY];
    return {
      usdMicro: human.monthly_cap_usd_micro,
      chfMicro:
        typeof capChf === "number" ? capChf : usdToChfMicro(human.monthly_cap_usd_micro, rate),
      origin: "human",
      expiresAt: null,
    };
  }
  const chfDefault = chfMicro(DEFAULT_MONTHLY_CAP_CHF);
  return {
    usdMicro: chfToUsdMicro(chfDefault, rate),
    chfMicro: chfDefault,
    origin: "default",
    expiresAt: null,
  };
}

const params = z
  .object({
    scope: z.enum(["session", "project", "month"]).default("session"),
    amountChf: z.number().positive().optional(),
    amountUsdMicro: z.number().int().positive().optional(),
    /** Project name or id (session and project scope); the active project when absent. */
    project: z.string().optional(),
    /** ISO instant until which a session budget applies; it reverts then. */
    until: z.string().optional(),
  })
  .refine((p) => p.amountChf !== undefined || p.amountUsdMicro !== undefined, {
    message: "an amount in CHF (amountChf) or USD micro-units (amountUsdMicro) is required",
  })
  .refine((p) => p.until === undefined || isIsoInstant(p.until), {
    message: "until must be an ISO-8601 instant",
    path: ["until"],
  })
  .refine((p) => p.until === undefined || p.scope === "session", {
    message: "only a session budget can be temporary",
    path: ["until"],
  });
export type BudgetSetParams = z.infer<typeof params>;

interface BudgetPlan {
  human: HumanRow;
  resolved: ResolvedProject | null;
  old: BudgetValue;
  next: { usdMicro: number; chfMicro: number; rate: number };
  ceiling: BudgetValue;
  what: string;
  scope: CommandScope;
  untilText: string | null;
  risk: Risk;
  sentence: string;
}

async function describe(p: BudgetSetParams, ctx: CommandContext): Promise<BudgetPlan> {
  const human = await ctx.store.human.mustGet(ctx.humanId);
  const rate = await rateOf(ctx);
  const nextChf =
    p.amountChf !== undefined
      ? chfMicro(p.amountChf)
      : usdToChfMicro(p.amountUsdMicro as number, rate);
  const nextUsd =
    p.amountChf !== undefined ? chfToUsdMicro(nextChf, rate) : (p.amountUsdMicro as number);
  const next = { usdMicro: nextUsd, chfMicro: nextChf, rate };
  const ceiling = await monthlyCeilingOf(human, ctx);
  if (p.until !== undefined && Date.parse(p.until) <= ctx.clock.now()) {
    throw new ForerunnerError("validation", "until must be in the future", {
      details: { until: p.until },
    });
  }
  let resolved: ResolvedProject | null = null;
  let old: BudgetValue;
  let what: string;
  let scope: CommandScope;
  let untilText: string | null = null;
  if (p.scope === "month") {
    old = ceiling;
    what = "the monthly cap";
    scope = "global";
  } else {
    resolved = await resolveProject(ctx, p.project);
    if (p.scope === "project") {
      const chfStored = resolved.project.settings[PROJECT_BUDGET_CHF_KEY];
      old = {
        usdMicro: resolved.project.budget_usd_micro,
        chfMicro:
          typeof chfStored === "number"
            ? chfStored
            : usdToChfMicro(resolved.project.budget_usd_micro, rate),
        origin: "project",
        expiresAt: null,
      };
      what = `the project budget for ${resolved.project.name}`;
      scope = "project";
    } else {
      old = await sessionBudgetOf(resolved.project, ctx);
      const adjective = p.until ? windowAdjective(p.until, ctx.clock.now(), ctx.timezone) : "the";
      what = `${adjective} session budget for ${resolved.project.name}`;
      scope = "session";
      if (p.until) untilText = describeUntil(p.until, ctx.clock.now(), ctx.timezone);
    }
  }
  const risk: Risk =
    p.scope === "month"
      ? next.usdMicro > old.usdMicro
        ? "high"
        : "medium"
      : next.usdMicro > ceiling.usdMicro
        ? "high"
        : "medium";
  const verb =
    next.chfMicro > old.chfMicro ? "Raised" : next.chfMicro < old.chfMicro ? "Lowered" : "Set";
  const sentence = `${verb} ${what} from ${chf(old.chfMicro)} to ${chf(next.chfMicro)}${
    untilText ? `, until ${untilText}` : ""
  }. Undo.`;
  return { human, resolved, old, next, ceiling, what, scope, untilText, risk, sentence };
}

export const budgetSet: CommandDef<BudgetSetParams> = {
  name: "budget.set",
  description:
    "Set a session, project or monthly budget in CHF. A session budget can be temporary (until a time); it reverts on its own.",
  params,
  risk: async (p, ctx) => (await describe(p, ctx)).risk,
  maxRisk: "high",
  scope: (p) => (p.scope === "month" ? "global" : p.scope === "project" ? "project" : "session"),
  reversible: true,
  undoStrategy: "restore the previous cap (and override) stored in the change log",
  actionClass: "permission_change",
  limit: true,
  async plan(p, ctx) {
    const d = await describe(p, ctx);
    return buildCard({
      command: "budget.set",
      what: d.what,
      oldValue: chf(d.old.chfMicro),
      newValue: chf(d.next.chfMicro),
      scope: d.scope,
      risk: d.risk,
      sentence: d.sentence,
      reversible: true,
      projectId: d.resolved?.project.id ?? null,
      projectName: d.resolved?.project.name ?? null,
      usesActiveProject: d.resolved?.usedActive ?? false,
      expiresAt: p.until ?? null,
      untilText: d.untilText ?? undefined,
      costUsdMicro: d.next.usdMicro - d.old.usdMicro,
      costChfMicro: d.next.chfMicro - d.old.chfMicro,
    });
  },
  async run(p, ctx): Promise<CommandOutcome> {
    const d = await describe(p, ctx);
    const author = authorOf(ctx);
    if (p.scope === "month") {
      const prevChf = d.human.notify_prefs[MONTHLY_CAP_CHF_KEY];
      await patchHumanPrefs(
        ctx.store,
        ctx.humanId,
        { [MONTHLY_CAP_CHF_KEY]: d.next.chfMicro },
        { monthly_cap_usd_micro: d.next.usdMicro, ...author },
      );
      return {
        before: {
          scope: "month",
          monthly_cap_usd_micro: d.human.monthly_cap_usd_micro,
          monthly_cap_chf_micro: typeof prevChf === "number" ? prevChf : null,
        },
        after: {
          scope: "month",
          monthly_cap_usd_micro: d.next.usdMicro,
          monthly_cap_chf_micro: d.next.chfMicro,
        },
        sentence: d.sentence,
        projectId: null,
      };
    }
    const project = (d.resolved as ResolvedProject).project;
    if (p.scope === "project") {
      const prevChf = project.settings[PROJECT_BUDGET_CHF_KEY];
      const settings: JsonObject = {
        ...project.settings,
        [PROJECT_BUDGET_CHF_KEY]: d.next.chfMicro,
      };
      await ctx.store.project.update(project.id, project.version, {
        budget_usd_micro: d.next.usdMicro,
        settings,
        ...author,
      });
      return {
        before: {
          scope: "project",
          project_id: project.id,
          budget_usd_micro: project.budget_usd_micro,
          budget_chf_micro: typeof prevChf === "number" ? prevChf : null,
        },
        after: {
          scope: "project",
          project_id: project.id,
          budget_usd_micro: d.next.usdMicro,
          budget_chf_micro: d.next.chfMicro,
        },
        sentence: d.sentence,
        projectId: project.id,
      };
    }
    if (p.until) {
      const previous = overrideOf(project);
      const override: SessionBudgetOverride = {
        cap_usd_micro: d.next.usdMicro,
        cap_chf_micro: d.next.chfMicro,
        rate_chf_per_usd: d.next.rate,
        expires_at: p.until,
      };
      await patchProjectSettings(
        ctx.store,
        project.id,
        { [SESSION_OVERRIDE_KEY]: override as never },
        author,
      );
      return {
        before: {
          scope: "session",
          project_id: project.id,
          [SESSION_OVERRIDE_KEY]: previous as never,
        },
        after: {
          scope: "session",
          project_id: project.id,
          [SESSION_OVERRIDE_KEY]: override as never,
        },
        sentence: d.sentence,
        expiresAt: p.until,
        projectId: project.id,
      };
    }
    const prevUsd = project.settings[SESSION_CAP_KEY];
    const prevChf = project.settings[SESSION_CAP_CHF_KEY];
    await patchProjectSettings(
      ctx.store,
      project.id,
      { [SESSION_CAP_KEY]: d.next.usdMicro, [SESSION_CAP_CHF_KEY]: d.next.chfMicro },
      author,
    );
    return {
      before: {
        scope: "session",
        project_id: project.id,
        [SESSION_CAP_KEY]: typeof prevUsd === "number" ? prevUsd : null,
        [SESSION_CAP_CHF_KEY]: typeof prevChf === "number" ? prevChf : null,
      },
      after: {
        scope: "session",
        project_id: project.id,
        [SESSION_CAP_KEY]: d.next.usdMicro,
        [SESSION_CAP_CHF_KEY]: d.next.chfMicro,
      },
      sentence: d.sentence,
      projectId: project.id,
    };
  },
  // U-057: putting the old cap back is a raise when the change lowered it. A raise asks as
  // the forward change would (the monthly ceiling, or a cap above it: the paired device; a
  // cap within it: a yes); an undo that lowers acts at once.
  async undoRisk(_p, before, _after, ctx): Promise<Risk> {
    const b = asObject(before);
    const human = await ctx.store.human.mustGet(ctx.humanId);
    const ceiling = await monthlyCeilingOf(human, ctx);
    if (b.scope === "month") {
      const restored = await monthlyCeilingOf(
        {
          ...human,
          monthly_cap_usd_micro:
            typeof b.monthly_cap_usd_micro === "number" ? b.monthly_cap_usd_micro : 0,
          notify_prefs: {
            ...human.notify_prefs,
            [MONTHLY_CAP_CHF_KEY]:
              typeof b.monthly_cap_chf_micro === "number" ? b.monthly_cap_chf_micro : null,
          },
        },
        ctx,
      );
      return restored.usdMicro > ceiling.usdMicro ? "high" : "low";
    }
    const projectId = typeof b.project_id === "string" ? b.project_id : null;
    const project = projectId ? await ctx.store.project.get(projectId) : undefined;
    if (!project) return "low";
    const raise = (restored: number, current: number): Risk =>
      restored <= current ? "low" : restored > ceiling.usdMicro ? "high" : "medium";
    if (b.scope === "project") {
      const restored = typeof b.budget_usd_micro === "number" ? b.budget_usd_micro : 0;
      return raise(restored, project.budget_usd_micro);
    }
    const current = await sessionBudgetOf(project, ctx);
    const settings: JsonObject = { ...project.settings };
    for (const key of [SESSION_OVERRIDE_KEY, SESSION_CAP_KEY, SESSION_CAP_CHF_KEY]) {
      if (!(key in b)) continue;
      const v = b[key];
      if (v === null || v === undefined) delete settings[key];
      else settings[key] = v;
    }
    const restored = await sessionBudgetOf({ ...project, settings }, ctx);
    return raise(restored.usdMicro, current.usdMicro);
  },
  async undo(_p, before, _after, ctx) {
    const b = asObject(before);
    const author = authorOf(ctx);
    if (b.scope === "month") {
      await patchHumanPrefs(
        ctx.store,
        ctx.humanId,
        {
          [MONTHLY_CAP_CHF_KEY]:
            typeof b.monthly_cap_chf_micro === "number" ? b.monthly_cap_chf_micro : null,
        },
        {
          monthly_cap_usd_micro:
            typeof b.monthly_cap_usd_micro === "number" ? b.monthly_cap_usd_micro : 0,
          ...author,
        },
      );
      return;
    }
    const projectId = typeof b.project_id === "string" ? b.project_id : null;
    if (!projectId) return;
    if (b.scope === "project") {
      const project = await ctx.store.project.mustGet(projectId);
      const settings: JsonObject = { ...project.settings };
      if (typeof b.budget_chf_micro === "number")
        settings[PROJECT_BUDGET_CHF_KEY] = b.budget_chf_micro;
      else delete settings[PROJECT_BUDGET_CHF_KEY];
      await ctx.store.project.update(project.id, project.version, {
        budget_usd_micro: typeof b.budget_usd_micro === "number" ? b.budget_usd_micro : 0,
        settings,
        ...author,
      });
      return;
    }
    if (SESSION_OVERRIDE_KEY in b) {
      await patchProjectSettings(
        ctx.store,
        projectId,
        { [SESSION_OVERRIDE_KEY]: b[SESSION_OVERRIDE_KEY] },
        author,
      );
      return;
    }
    await patchProjectSettings(
      ctx.store,
      projectId,
      { [SESSION_CAP_KEY]: b[SESSION_CAP_KEY], [SESSION_CAP_CHF_KEY]: b[SESSION_CAP_CHF_KEY] },
      author,
    );
  },
};
