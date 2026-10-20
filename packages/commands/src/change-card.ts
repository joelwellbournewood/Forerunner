import { formatAmount } from "@forerunner/billing";
import type { CommandScope, Risk } from "./types.ts";

/**
 * The change card (spec Q): what changes, old value -> new value, scope, how long, cost or
 * risk impact, how to undo. Built by a command's plan() before anything happens, shown in
 * the UI, read out in voice mode, stored on the HumanRequest while a confirmation is open,
 * and kept with the change log entry.
 */
export type ChangeDuration = "until reverted" | "permanent" | `until ${string}`;

export interface ChangeImpact {
  /** Signed delta in potential spend, when the change is about money. */
  costUsdMicro?: number;
  costChfMicro?: number;
  risk: Risk;
}

export interface ChangeCard {
  /** "budget.set", or "compose" for a plan of several commands. */
  command: string;
  /** What changes, e.g. "tonight's session budget for PharmaWatch". */
  what: string;
  oldValue: string;
  newValue: string;
  scope: CommandScope;
  /** "this session" | "this project" | "everything". */
  scopeLabel: string;
  duration: ChangeDuration;
  impact: ChangeImpact;
  /** How to undo, e.g. "Say undo or tap Undo in the change log." */
  undoHint: string;
  /** The plain sentence posted once the change is made. */
  sentence: string;
  projectId: string | null;
  projectName: string | null;
  /** No project was named, so the command applies to the active one; the card says so. */
  usesActiveProject: boolean;
  /** ISO instant when a temporary change reverts, or null. */
  expiresAt: string | null;
  reversible: boolean;
  /** The cards of a composed plan, when command is "compose". */
  parts?: ChangeCard[];
}

export const SCOPE_LABELS: Record<CommandScope, string> = {
  session: "this session",
  project: "this project",
  global: "everything",
};

export const UNDO_HINT = "Say undo or tap Undo in the change log.";
export const NO_UNDO_HINT = "This cannot be undone.";

/** "CHF 5", "CHF 12.50": the billing formatter without a trailing ".00". */
export function formatChfShort(chfMicro: number): string {
  const amount = formatAmount(chfMicro, { decimals: 2 });
  return `CHF ${amount.endsWith(".00") ? amount.slice(0, -3) : amount}`;
}

export interface CardInput {
  command: string;
  what: string;
  oldValue: string;
  newValue: string;
  scope: CommandScope;
  risk: Risk;
  sentence: string;
  reversible: boolean;
  projectId?: string | null;
  projectName?: string | null;
  usesActiveProject?: boolean;
  expiresAt?: string | null;
  /** The rendered end of the window, e.g. "06:00"; required with expiresAt. */
  untilText?: string;
  costUsdMicro?: number;
  costChfMicro?: number;
}

export function buildCard(input: CardInput): ChangeCard {
  const duration: ChangeDuration = input.expiresAt
    ? `until ${input.untilText ?? input.expiresAt}`
    : input.reversible
      ? "until reverted"
      : "permanent";
  const impact: ChangeImpact = { risk: input.risk };
  if (input.costUsdMicro !== undefined) impact.costUsdMicro = input.costUsdMicro;
  if (input.costChfMicro !== undefined) impact.costChfMicro = input.costChfMicro;
  return {
    command: input.command,
    what: input.what,
    oldValue: input.oldValue,
    newValue: input.newValue,
    scope: input.scope,
    scopeLabel: SCOPE_LABELS[input.scope],
    duration,
    impact,
    undoHint: input.reversible ? UNDO_HINT : NO_UNDO_HINT,
    sentence: input.sentence,
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    usesActiveProject: input.usesActiveProject ?? false,
    expiresAt: input.expiresAt ?? null,
    reversible: input.reversible,
  };
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(risks: readonly Risk[]): Risk {
  let out: Risk = "low";
  for (const r of risks) if (RISK_ORDER[r] > RISK_ORDER[out]) out = r;
  return out;
}

const SCOPE_ORDER: Record<CommandScope, number> = { session: 0, project: 1, global: 2 };

/** One card for a plan of several commands (spec Q "bespoke requests"). */
export function mergeCards(parts: readonly ChangeCard[]): ChangeCard {
  if (parts.length === 0) throw new Error("mergeCards needs at least one card");
  if (parts.length === 1) return parts[0] as ChangeCard;
  const risk = maxRisk(parts.map((p) => p.impact.risk));
  const scope = parts.reduce<CommandScope>(
    (acc, p) => (SCOPE_ORDER[p.scope] > SCOPE_ORDER[acc] ? p.scope : acc),
    "session",
  );
  const reversible = parts.every((p) => p.reversible);
  const expiring = parts
    .map((p) => p.expiresAt)
    .filter((x): x is string => typeof x === "string")
    .sort();
  const firstExpiry = expiring[0] ?? null;
  const first = parts.find((p) => p.expiresAt === firstExpiry);
  const costUsd = parts.reduce((n, p) => n + (p.impact.costUsdMicro ?? 0), 0);
  const costChf = parts.reduce((n, p) => n + (p.impact.costChfMicro ?? 0), 0);
  const projectIds = new Set(parts.map((p) => p.projectId).filter((x): x is string => !!x));
  const projectNames = [
    ...new Set(parts.map((p) => p.projectName).filter((x): x is string => !!x)),
  ];
  const impact: ChangeImpact = { risk };
  if (parts.some((p) => p.impact.costUsdMicro !== undefined)) impact.costUsdMicro = costUsd;
  if (parts.some((p) => p.impact.costChfMicro !== undefined)) impact.costChfMicro = costChf;
  return {
    command: "compose",
    what: parts.map((p) => p.what).join("; "),
    oldValue: parts.map((p) => p.oldValue).join("; "),
    newValue: parts.map((p) => p.newValue).join("; "),
    scope,
    scopeLabel: SCOPE_LABELS[scope],
    duration: first
      ? (first.duration as ChangeDuration)
      : reversible
        ? "until reverted"
        : "permanent",
    impact,
    undoHint: reversible ? UNDO_HINT : NO_UNDO_HINT,
    sentence: parts.map((p) => p.sentence).join(" "),
    projectId: projectIds.size === 1 ? ([...projectIds][0] ?? null) : null,
    projectName:
      projectNames.length === 1 ? (projectNames[0] ?? null) : projectNames.join(", ") || null,
    usesActiveProject: parts.some((p) => p.usesActiveProject),
    expiresAt: first?.expiresAt ?? null,
    reversible,
    parts: [...parts],
  };
}

export interface RenderOptions {
  /** Voice mode: one flowing paragraph instead of lines. */
  voice?: boolean;
}

/**
 * Plain text of a card, before the change: what, old -> new, scope, how long, impact, undo.
 * The same text is spoken in voice mode.
 */
export function renderChangeCard(card: ChangeCard, opts: RenderOptions = {}): string {
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
      ? ` Spend impact: ${card.impact.costChfMicro >= 0 ? "+" : "-"}${formatChfShort(Math.abs(card.impact.costChfMicro))}.`
      : "";
  lines.push(`Risk: ${card.impact.risk}.${cost}`);
  lines.push(`Undo: ${card.undoHint}`);
  return opts.voice ? lines.join(" ") : lines.join("\n");
}

/** A card as stored on a HumanRequest or in an event payload. */
export function cardToJson(card: ChangeCard): Record<string, unknown> {
  return JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
}
