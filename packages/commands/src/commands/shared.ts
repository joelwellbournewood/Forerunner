import { formatAmount } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { HumanRow, JsonObject, JsonValue, ProjectRow, StateStore } from "@forerunner/state";
import { formatChfShort } from "../change-card.ts";
import type { CommandContext } from "../types.ts";

/** Helpers the commands share: project resolution, JSON settings, CHF display. */

export interface ResolvedProject {
  project: ProjectRow;
  /** No project was named; the active one was used. */
  usedActive: boolean;
}

const ARTICLES = /^(?:the|a|an|der|die|das|den|dem|das|project|projekt)\s+/i;

export function normaliseProjectName(name: string): string {
  return name
    .trim()
    .replace(/^["'„“”‚‘’]+|["'„“”‚‘’]+$/g, "")
    .replace(ARTICLES, "")
    .replace(/\s+(?:project|projekt)$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Words that point at a project instead of naming one (l4-chat-answers, L4-chat-104): never a
 * project's name, whatever name holds them ("it" in "Site", "da" in "Daten").
 */
const POINTERS = new Set([
  "it",
  "that",
  "this",
  "there",
  "here",
  "one",
  "that one",
  "this one",
  "same",
  "other",
  "es",
  "das",
  "dies",
  "dieses",
  "dort",
  "da",
  "hier",
]);

/**
 * Whether `part` is in `whole` from the start of a word: whole words ("notes" in "notes cli"),
 * or the start of a word for three letters or more ("pharma" in "pharmawatch"); never inside a
 * word ("it" in "site").
 */
function hasWords(whole: string, part: string): boolean {
  const at = whole.indexOf(part);
  if (at < 0 || !part) return false;
  const edge = (ch: string | undefined) => !ch || !/[\p{L}\p{N}]/u.test(ch);
  for (let i = at; i >= 0; i = whole.indexOf(part, i + 1))
    if (edge(whole[i - 1]) && (part.length >= 3 || edge(whole[i + part.length]))) return true;
  return false;
}

/**
 * Projects whose name matches a spoken name: exact, then containing (as whole words), then by
 * word overlap. A pointer word ("it", "that", "there", "dort") matches no project.
 */
export function matchProjects<T extends { id: string; name: string }>(
  projects: readonly T[],
  needle: string,
): T[] {
  const n = normaliseProjectName(needle);
  if (!n) return [];
  const byId = projects.filter((p) => p.id === needle.trim());
  if (byId.length) return byId;
  const exact = projects.filter((p) => normaliseProjectName(p.name) === n);
  if (exact.length) return exact;
  if (POINTERS.has(n)) return [];
  const contains = projects.filter((p) => {
    const pn = normaliseProjectName(p.name);
    return hasWords(pn, n) || hasWords(n, pn);
  });
  if (contains.length) return contains;
  const words = n.split(/[^a-z0-9äöüß]+/i).filter((w) => w.length >= 3);
  return projects.filter((p) => {
    const pw = normaliseProjectName(p.name).split(/[^a-z0-9äöüß]+/i);
    return words.some((w) => pw.includes(w));
  });
}

/** The project a command applies to: the named one, else the active one. */
export async function resolveProject(
  ctx: CommandContext,
  named: string | undefined,
): Promise<ResolvedProject> {
  const { store } = ctx;
  if (named?.trim()) {
    const direct = await store.project.get(named.trim());
    if (direct) return { project: direct, usedActive: false };
    const all = await store.project.list({ status: ["active", "paused"] });
    const matches = matchProjects(all, named);
    if (matches.length === 1) return { project: matches[0] as ProjectRow, usedActive: false };
    if (matches.length > 1) {
      throw new ForerunnerError("validation", `several projects match "${named}"`, {
        details: { candidates: matches.map((m) => m.name) },
      });
    }
    throw new ForerunnerError("not_found", `no project named "${named}"`, {
      details: { named, known: all.map((p) => p.name) },
    });
  }
  if (!ctx.activeProjectId) {
    throw new ForerunnerError("validation", "no active project; say which project", {
      details: { hint: "project.switch" },
    });
  }
  const active = await store.project.get(ctx.activeProjectId);
  if (!active) {
    throw new ForerunnerError("not_found", "the active project no longer exists", {
      details: { projectId: ctx.activeProjectId },
    });
  }
  return { project: active, usedActive: true };
}

/** project.settings with one key replaced (null deletes it). */
export async function patchProjectSettings(
  store: StateStore,
  projectId: string,
  patch: Record<string, JsonValue | undefined>,
  author: { author_human?: string | null; author_agent?: string | null } = {},
): Promise<ProjectRow> {
  const current = await store.project.mustGet(projectId);
  const settings: JsonObject = { ...current.settings };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete settings[k];
    else settings[k] = v;
  }
  return store.project.update(projectId, current.version, { settings, ...author });
}

/** human.notify_prefs with keys replaced (null deletes). */
export async function patchHumanPrefs(
  store: StateStore,
  humanId: string,
  patch: Record<string, JsonValue | undefined>,
  extra: Partial<HumanRow> = {},
): Promise<HumanRow> {
  const current = await store.human.mustGet(humanId);
  const prefs: JsonObject = { ...current.notify_prefs };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete prefs[k];
    else prefs[k] = v;
  }
  return store.human.update(humanId, current.version, { notify_prefs: prefs, ...extra });
}

export function authorOf(ctx: CommandContext): {
  author_human: string | null;
  author_agent: string | null;
} {
  return {
    author_human: ctx.actor.kind === "human" ? ctx.actor.id : null,
    author_agent: ctx.actor.kind === "agent" ? ctx.actor.id : null,
  };
}

export function chf(chfMicro: number): string {
  return formatChfShort(chfMicro);
}

/**
 * An amount with its two decimals, "CHF 3.00", "CHF 12.50" (design §5 rule 7): budget.set's
 * sentences, read-backs and values (W15-44: they read "from CHF 3 to CHF 12"), and a session
 * start's read-back, sentence and value, "(up to CHF 5.00)" (l4-chat-depth, L4-chat-210: before,
 * it kept `chf` from the design's old example "(up to CHF 5)", against its rule 7).
 */
export function chfExact(chfMicro: number): string {
  return `CHF ${formatAmount(chfMicro, { decimals: 2 })}`;
}

export function asObject(v: JsonValue | null | undefined): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function quote(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}
