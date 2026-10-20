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

/** Projects whose name matches a spoken name: exact, then containing, then by word overlap. */
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
  const contains = projects.filter((p) => {
    const pn = normaliseProjectName(p.name);
    return pn.includes(n) || n.includes(pn);
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

export function asObject(v: JsonValue | null | undefined): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function quote(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}
