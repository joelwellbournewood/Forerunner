import type { PlanCommand } from "../api/state-client.ts";
import { describeUntil } from "./time.ts";

/**
 * The change card on the phone (spec Q.4, R.5): one card for a plan of several commands,
 * built before anything is sent, with the shape `packages/commands` uses (`ChangeCard`): what
 * changes, old value to new value, scope, how long, risk and cost impact, how to undo. The
 * phone fills the old values it knows (the active project, a project budget) and names the
 * rest "current"; the PC's executor re-plans against the real state before acting, so the
 * card here is the human's preview, not the source of truth. Risk mirrors ADR 0030: switch
 * low, budgets medium (the monthly cap and anything above a known ceiling high), a costly
 * session medium, stop low.
 */
export type Risk = "low" | "medium" | "high";
export type CardScope = "session" | "project" | "global";

export interface MobileChangeCard {
  command: string;
  what: string;
  oldValue: string;
  newValue: string;
  scope: CardScope;
  scopeLabel: string;
  duration: string;
  impact: { risk: Risk; costChfMicro?: number };
  undoHint: string;
  sentence: string;
  projectId: string | null;
  projectName: string | null;
  usesActiveProject: boolean;
  expiresAt: string | null;
  reversible: boolean;
  parts?: MobileChangeCard[];
}

export interface CardContext {
  timezone: string;
  now: number;
  activeProjectId: string | null;
  projects: { id: string; name: string; budgetChfMicro: number }[];
  /**
   * The human's monthly hard cap in CHF micro-units, when the phone knows it (`/me`);
   * null when unknown: the card then says "the current cap" and treats a monthly change as
   * a raise (high risk) rather than guessing a number.
   */
  monthlyCeilingChfMicro: number | null;
  /** CHF per USD as the service's money pairs imply it; `DEFAULT_CHF_PER_USD` when unknown. */
  chfPerUsd?: number | null;
  /** Starting a session above this is "costly" (medium). Default CHF 2.50. */
  costlySessionChfMicro?: number;
}

/** Used only for a USD amount when no project card carried a USD/CHF pair to derive the rate from. */
export const DEFAULT_CHF_PER_USD = 0.8;

/** The rate the service applied, from any money pair with both sides; null when none has. */
export function chfPerUsdFrom(
  money: readonly { usdMicro: number; chfMicro: number }[],
): number | null {
  const pair = money.find((m) => m.usdMicro > 0 && m.chfMicro > 0);
  return pair ? pair.chfMicro / pair.usdMicro : null;
}

const SCOPE_LABELS: Record<CardScope, string> = {
  session: "this session",
  project: "this project",
  global: "everything",
};
export const UNDO_HINT = "Tap Undo in the change log.";
export const NO_UNDO_HINT = "This cannot be undone.";
const MICRO = 1_000_000;
const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const SCOPE_ORDER: Record<CardScope, number> = { session: 0, project: 1, global: 2 };

/** "CHF 5", "CHF 12.50". */
export function chfShort(micro: number): string {
  const units = Math.round(micro / 10_000) / 100;
  const text = units.toFixed(2).replace(/\.00$/, "");
  return `CHF ${text}`;
}

export function chfToMicro(chf: number): number {
  return Math.round(chf * MICRO);
}

export function maxRisk(risks: readonly Risk[]): Risk {
  let out: Risk = "low";
  for (const r of risks) if (RISK_ORDER[r] > RISK_ORDER[out]) out = r;
  return out;
}

function projectOf(ctx: CardContext, ref: unknown): CardContext["projects"][number] | null {
  if (typeof ref !== "string" || !ref) return null;
  return (
    ctx.projects.find((p) => p.id === ref) ??
    ctx.projects.find((p) => p.name.toLowerCase() === ref.toLowerCase()) ??
    null
  );
}

function resolveProject(
  ctx: CardContext,
  ref: unknown,
  active: string | null,
): { project: CardContext["projects"][number] | null; usedActive: boolean } {
  const named = projectOf(ctx, ref);
  if (named) return { project: named, usedActive: false };
  const current = active ? projectOf(ctx, active) : null;
  return { project: current, usedActive: true };
}

function amountChfMicro(params: Record<string, unknown>, ctx: CardContext): number | null {
  if (typeof params.amountChf === "number") return chfToMicro(params.amountChf);
  if (typeof params.amountUsdMicro === "number") {
    return Math.round(params.amountUsdMicro * (ctx.chfPerUsd ?? DEFAULT_CHF_PER_USD));
  }
  return null;
}

/** The card of one command; `active` is the project earlier steps of the plan switched to. */
export function cardFor(
  command: PlanCommand,
  ctx: CardContext,
  active: string | null,
): MobileChangeCard {
  const p = command.params;
  const base = {
    projectId: null as string | null,
    projectName: null as string | null,
    usesActiveProject: false,
    expiresAt: null as string | null,
  };
  switch (command.name) {
    case "project.switch": {
      const current = active ? projectOf(ctx, active) : null;
      const target = p.back === true ? null : projectOf(ctx, p.project);
      const newName =
        target?.name ?? (p.back === true ? "the previous project" : String(p.project));
      return {
        ...base,
        command: command.name,
        what: "the active project",
        oldValue: current?.name ?? "none",
        newValue: newName,
        scope: "global",
        scopeLabel: SCOPE_LABELS.global,
        duration: "until reverted",
        impact: { risk: "low" },
        undoHint: UNDO_HINT,
        sentence: `Switched the active project to ${newName}. Undo.`,
        projectId: target?.id ?? null,
        projectName: target?.name ?? null,
        reversible: true,
      };
    }
    case "budget.set": {
      const scope = (p.scope as string | undefined) ?? "session";
      const next = amountChfMicro(p, ctx);
      const nextText = next === null ? "?" : chfShort(next);
      if (scope === "month") {
        const old = ctx.monthlyCeilingChfMicro;
        const oldText = old === null ? "the current cap" : chfShort(old);
        // Unknown ceiling: a monthly change counts as a raise (high) until the PC's card says otherwise.
        const raise = next !== null && (old === null || next > old);
        return {
          ...base,
          command: command.name,
          what: "the monthly cap",
          oldValue: oldText,
          newValue: nextText,
          scope: "global",
          scopeLabel: SCOPE_LABELS.global,
          duration: "permanent",
          impact: {
            risk: raise ? "high" : "medium",
            ...(old !== null && next !== null ? { costChfMicro: next - old } : {}),
          },
          undoHint: UNDO_HINT,
          sentence: `${raise ? "Raised" : "Set"} the monthly cap from ${oldText} to ${nextText}. Undo.`,
          reversible: true,
        };
      }
      const { project, usedActive } = resolveProject(ctx, p.project, active);
      const name = project?.name ?? "the active project";
      const until = typeof p.until === "string" ? p.until : null;
      const untilText = until ? describeUntil(until, ctx.now, ctx.timezone) : null;
      const isProject = scope === "project";
      const oldChf = isProject && project ? project.budgetChfMicro : null;
      const oldText = oldChf === null ? "the current budget" : chfShort(oldChf);
      const what = isProject
        ? `the project budget for ${name}`
        : `${until ? "tonight's" : "the"} session budget for ${name}`;
      const ceiling = ctx.monthlyCeilingChfMicro;
      const risk: Risk = next !== null && ceiling !== null && next > ceiling ? "high" : "medium";
      const verb = oldChf !== null && next !== null && next < oldChf ? "Lowered" : "Raised";
      return {
        ...base,
        command: command.name,
        what,
        oldValue: oldText,
        newValue: nextText,
        scope: isProject ? "project" : "session",
        scopeLabel: SCOPE_LABELS[isProject ? "project" : "session"],
        duration: until ? `until ${untilText}` : "until reverted",
        impact: {
          risk,
          ...(oldChf !== null && next !== null ? { costChfMicro: next - oldChf } : {}),
        },
        undoHint: UNDO_HINT,
        sentence: `${verb} ${what} from ${oldText} to ${nextText}${untilText ? `, until ${untilText}` : ""}. Undo.`,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        usesActiveProject: usedActive,
        expiresAt: until,
        reversible: true,
      };
    }
    case "session.start": {
      const { project, usedActive } = resolveProject(ctx, p.project, active);
      const name = project?.name ?? "the active project";
      const where = p.runner === "cloud" ? "on the cloud runner" : "on your PC";
      const budget = typeof p.budgetChf === "number" ? chfToMicro(p.budgetChf) : null;
      const costly = budget !== null && budget > (ctx.costlySessionChfMicro ?? 2_500_000);
      return {
        ...base,
        command: command.name,
        what: `a session on ${name} ${where}`,
        oldValue: "no session",
        newValue: budget === null ? "running" : `running with a budget of ${chfShort(budget)}`,
        scope: "session",
        scopeLabel: SCOPE_LABELS.session,
        duration: "until reverted",
        impact: {
          risk: costly ? "medium" : "low",
          ...(budget !== null ? { costChfMicro: budget } : {}),
        },
        undoHint: UNDO_HINT,
        sentence: `Started a session on ${name} ${where}; the PC picks it up in seconds. Undo.`,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        usesActiveProject: usedActive,
        reversible: true,
      };
    }
    case "session.stop": {
      const what =
        p.scope === "all"
          ? "every running session"
          : p.scope === "session"
            ? `the session ${String(p.session ?? "")}`.trim()
            : "your agent's running sessions";
      return {
        ...base,
        command: command.name,
        what,
        oldValue: "running",
        newValue: "stopped",
        scope: p.scope === "all" ? "global" : "session",
        scopeLabel: SCOPE_LABELS[p.scope === "all" ? "global" : "session"],
        duration: "permanent",
        impact: { risk: "low" },
        undoHint: NO_UNDO_HINT,
        sentence: `Stopped ${what}.`,
        reversible: false,
      };
    }
    case "session.pause":
      return {
        ...base,
        command: command.name,
        what: "the running session",
        oldValue: "running",
        newValue: "paused",
        scope: "session",
        scopeLabel: SCOPE_LABELS.session,
        duration: "until resumed",
        impact: { risk: "low" },
        undoHint: UNDO_HINT,
        sentence: "Paused the running session. Undo.",
        reversible: true,
      };
    case "note.add": {
      const { project, usedActive } = resolveProject(ctx, p.project, active);
      return {
        ...base,
        command: command.name,
        what: `a ${String(p.kind ?? "note")} for ${project?.name ?? "the active project"}`,
        oldValue: "none",
        newValue: String(p.text ?? "").slice(0, 80),
        scope: "project",
        scopeLabel: SCOPE_LABELS.project,
        duration: "until reverted",
        impact: { risk: "low" },
        undoHint: UNDO_HINT,
        sentence: `Added a ${String(p.kind ?? "note")} to the next-session queue. Undo.`,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        usesActiveProject: usedActive,
        reversible: true,
      };
    }
    default:
      return {
        ...base,
        command: command.name,
        what: command.name,
        oldValue: "current",
        newValue: JSON.stringify(p).slice(0, 80),
        scope: "project",
        scopeLabel: SCOPE_LABELS.project,
        duration: "until reverted",
        impact: { risk: "medium" },
        undoHint: UNDO_HINT,
        sentence: `Ran ${command.name}. Undo.`,
        reversible: true,
      };
  }
}

/** ONE card for a plan (spec Q.9): parts in order, the highest risk and widest scope win. */
export function buildPlanCard(plan: readonly PlanCommand[], ctx: CardContext): MobileChangeCard {
  if (plan.length === 0) throw new Error("a plan needs at least one command");
  let active = ctx.activeProjectId;
  const parts: MobileChangeCard[] = [];
  for (const command of plan) {
    const card = cardFor(command, ctx, active);
    parts.push(card);
    if (command.name === "project.switch" && card.projectId) active = card.projectId;
  }
  if (parts.length === 1) return parts[0] as MobileChangeCard;
  const risk = maxRisk(parts.map((p) => p.impact.risk));
  const scope = parts.reduce<CardScope>(
    (acc, p) => (SCOPE_ORDER[p.scope] > SCOPE_ORDER[acc] ? p.scope : acc),
    "session",
  );
  const reversible = parts.every((p) => p.reversible);
  const expiring = parts
    .map((p) => p.expiresAt)
    .filter((x): x is string => typeof x === "string")
    .sort();
  const first = parts.find((p) => p.expiresAt === (expiring[0] ?? null) && p.expiresAt);
  const cost = parts.reduce((n, p) => n + (p.impact.costChfMicro ?? 0), 0);
  const names = [...new Set(parts.map((p) => p.projectName).filter((x): x is string => !!x))];
  const ids = new Set(parts.map((p) => p.projectId).filter((x): x is string => !!x));
  return {
    command: "compose",
    what: parts.map((p) => p.what).join("; "),
    oldValue: parts.map((p) => p.oldValue).join("; "),
    newValue: parts.map((p) => p.newValue).join("; "),
    scope,
    scopeLabel: SCOPE_LABELS[scope],
    duration: first ? first.duration : reversible ? "until reverted" : "permanent",
    impact: {
      risk,
      ...(parts.some((p) => p.impact.costChfMicro !== undefined) ? { costChfMicro: cost } : {}),
    },
    undoHint: reversible ? UNDO_HINT : NO_UNDO_HINT,
    sentence: parts.map((p) => p.sentence).join(" "),
    projectId: ids.size === 1 ? ([...ids][0] ?? null) : null,
    projectName: names.length === 1 ? (names[0] ?? null) : names.join(", ") || null,
    usesActiveProject: parts.some((p) => p.usesActiveProject),
    expiresAt: first?.expiresAt ?? null,
    reversible,
    parts,
  };
}

/**
 * The inverse plan (spec Q.11 "one-click undo"): run in reverse order. A started session is
 * stopped, a temporary or permanent budget goes back to its previous value when the phone
 * knows it (else the PC restores it from its change log via `restore: true`), a switch goes
 * back. Irreversible steps (stop) have no inverse; the plan is then not undoable.
 */
export function inversePlan(
  plan: readonly PlanCommand[],
  card: MobileChangeCard,
  ctx: CardContext,
): PlanCommand[] | null {
  const parts = card.parts ?? [card];
  const out: PlanCommand[] = [];
  for (let i = plan.length - 1; i >= 0; i--) {
    const command = plan[i] as PlanCommand;
    const part = parts[i];
    switch (command.name) {
      case "project.switch":
        out.push({ name: "project.switch", params: { back: true } });
        break;
      case "budget.set": {
        const p = command.params;
        const previous = part ? projectOf(ctx, part.projectId) : null;
        const params: Record<string, unknown> = { scope: p.scope ?? "session", restore: true };
        if (p.project !== undefined) params.project = p.project;
        if (p.scope === "project" && previous) params.amountChf = previous.budgetChfMicro / MICRO;
        if (p.scope === "month" && ctx.monthlyCeilingChfMicro !== null) {
          params.amountChf = ctx.monthlyCeilingChfMicro / MICRO;
        }
        out.push({ name: "budget.set", params });
        break;
      }
      case "session.start": {
        const params: Record<string, unknown> = { scope: "agent", reason: "undo of session.start" };
        if (command.params.project !== undefined) params.project = command.params.project;
        out.push({ name: "session.stop", params });
        break;
      }
      case "session.pause":
        out.push({ name: "session.resume", params: {} });
        break;
      case "note.add":
        out.push({ name: "note.remove", params: { text: command.params.text ?? "" } });
        break;
      default:
        return null;
    }
  }
  return out;
}

/** Plain text of a card: what, old to new, scope, how long, risk, undo (also for read-aloud). */
export function renderCard(card: MobileChangeCard): string {
  const lines: string[] = [];
  if (card.parts && card.parts.length > 1) {
    lines.push(`Plan of ${card.parts.length} changes:`);
    card.parts.forEach((p, i) => {
      lines.push(
        `${i + 1}. ${p.what}: ${p.oldValue} to ${p.newValue}${p.expiresAt ? `, ${p.duration}` : ""}.`,
      );
    });
  } else {
    lines.push(`Change: ${card.what}.`);
    lines.push(`From ${card.oldValue} to ${card.newValue}.`);
  }
  const scope =
    card.usesActiveProject && card.projectName
      ? `Scope: ${card.scopeLabel} (${card.projectName}, the active project).`
      : card.projectName
        ? `Scope: ${card.scopeLabel} (${card.projectName}).`
        : `Scope: ${card.scopeLabel}.`;
  lines.push(scope);
  lines.push(`How long: ${card.duration}.`);
  const cost =
    card.impact.costChfMicro !== undefined
      ? ` Spend impact: ${card.impact.costChfMicro >= 0 ? "+" : "-"}${chfShort(Math.abs(card.impact.costChfMicro))}.`
      : "";
  lines.push(`Risk: ${card.impact.risk}.${cost}`);
  lines.push(`Undo: ${card.undoHint}`);
  return lines.join("\n");
}
