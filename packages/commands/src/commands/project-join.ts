import { ForerunnerError } from "@forerunner/platform";
import {
  createUndoJoined,
  JOIN_REFUSED_CHOOSE,
  JOINED_INTO_KEY,
  joinAsk,
  joinedFromOf,
  joinedIntoOf,
  joinSentence,
  joinUndoDependency,
  joinUndoDependsOnKept,
  joinUndoMerging,
  joinUndoneSentence,
  joinUndoRunning,
  TOGETHER_ONE_PROJECT,
  togetherJoinAsk,
  togetherJoinedSentence,
  togetherNameFor,
  togetherUndoneSentence,
  togetherUndoOwnWork,
  WAS_LINKED_KEY,
} from "@forerunner/runtime/daemon/join-words";
import {
  JOINED_FROM_KEY,
  TOGETHER_KEY,
  TOGETHER_UNREADABLE,
  TOOK_OVER_KEY,
} from "@forerunner/runtime/sources/repository-words";
import type { JsonObject, JsonValue, ProjectRow, StateStore } from "@forerunner/state";
import { z } from "zod";
import { buildCard } from "../change-card.ts";
import type { CommandContext, CommandDef, ProjectTogetherFacts } from "../types.ts";
import { asObject, authorOf, matchProjects } from "./shared.ts";

/** The settings key a removed project keeps its name under (`project.create`'s Undo, W15-36). */
const REMOVED_NAME_KEY = "removed_name";

/**
 * project.join: Make one project (d1109-onerepo-join, D1, ADR 0117 amended 2026-11-16). Two or
 * more projects on this computer that share a repository or folder (made before one repository
 * was one project) become one: the person chooses the one to keep, and the others' tasks (every
 * status, with their ids, dependencies, branches and pull requests), milestones (after the kept
 * project's), the cards about those tasks and their open cards, queued notes, merge records,
 * decisions and accepted source proposals move into it, in one store transaction; their data
 * assets add the kept project. What stays on a closed project, readable: its sessions, its
 * cost-ledger rows (the truth the caps are measured on, never rewritten), its changes, its chat
 * and its answered project cards. The closed project is archived with `joined_into` (never
 * renamed, never deleted), its links cleared and kept as `was_linked` for the Undo; the kept
 * project's `joined_from` gains its id, so the docs paths read its pull requests as the kept
 * one's (`projectIdsOf`). Nothing is written to GitHub. Risk medium: the dialog's press is the
 * yes, chat reads it back with Yes and No. Undo (Changes) moves every moved row back, and rows
 * made on the kept project since for a moved task (a card, a merge record), and reopens the
 * closed project with its link, also after a restart.
 */

/**
 * w8-together (OJ-11): `keep: {together: true}` joins the one closing project into the project
 * the repository names that is not on this computer (another Forerunner's), read from GitHub at
 * the press: the together project is made with the repository's id and name in the join's one
 * transaction.
 */
const togetherKeep = z.object({ together: z.literal(true) }).strict();

const params = z.object({
  /** The project to keep: its id or name, or `{together: true}` (Work together, OJ-11). */
  keep: z.union([z.string().min(1), togetherKeep]),
  /** The projects whose work moves into it: ids or names, at least one. */
  close: z.array(z.string().min(1)).min(1).max(10),
});
export type ProjectJoinParams = z.infer<typeof params>;
type PairParams = ProjectJoinParams & { keep: string };

const isTogetherForm = (p: ProjectJoinParams): boolean => typeof p.keep !== "string";

/** The definition the chat's model receives (OJ-08, OJ-11; asserted word for word). */
export const PROJECT_JOIN_DESCRIPTION =
  'Make one project of projects on this computer that work in the same repository or folder: keep is the project the person chose to keep, close the others. Their tasks, plan, cards and open pull requests move into the kept project; their sessions, changes and spending stay readable where they are, and no budget changes. Only when the person asks for it and names the project to keep; never choose it yourself. When the person asks to work together on a project whose repository is another Forerunner\'s project, keep is {"together": true} and close names that one project.';

/** At most this many rows of one table are moved in one statement (SQLite's parameter limit). */
const CHUNK = 400;

function port(ctx: CommandContext) {
  const join = ctx.ports.projectJoin;
  if (!join)
    throw new ForerunnerError(
      "unavailable",
      "making one project needs the daemon's repository index; this install has none wired",
    );
  return join;
}

/** A project named by id or by name (any status: a closed one is named in the refusal). */
async function projectNamed(store: StateStore, named: string): Promise<ProjectRow> {
  const direct = await store.project.get(named.trim());
  if (direct) return direct;
  const all = await store.project.list({}, { limit: 2000 });
  const hits = matchProjects(
    all.filter((p) => p.status !== "archived"),
    named,
  );
  if (hits.length === 1) return hits[0] as ProjectRow;
  throw new ForerunnerError(
    hits.length ? "validation" : "not_found",
    hits.length ? `several projects match "${named}"` : `no project named "${named}"`,
    { details: { named } },
  );
}

interface Resolved {
  keep: ProjectRow;
  close: ProjectRow[];
}

async function resolve(p: PairParams, ctx: CommandContext): Promise<Resolved> {
  const keep = await projectNamed(ctx.store, p.keep);
  const close: ProjectRow[] = [];
  for (const named of p.close) {
    const row = await projectNamed(ctx.store, named);
    if (!close.some((c) => c.id === row.id)) close.push(row);
  }
  if (close.some((c) => c.id === keep.id) || !close.length)
    throw new ForerunnerError("validation", JOIN_REFUSED_CHOOSE);
  return { keep, close };
}

/** Refused in words while anything holds the join (the port's `refusal`, join-preview.ts). */
async function assertJoinable(r: Resolved, ctx: CommandContext): Promise<void> {
  const reason = await port(ctx).refusal(
    r.keep.id,
    r.close.map((c) => c.id),
  );
  if (reason)
    throw new ForerunnerError("validation", reason, { details: { cause: "join_refused" } });
}

// --- Work together for a project already here (w8-together, OJ-11) ---------------------------

function togetherPort(ctx: CommandContext) {
  const together = port(ctx).together;
  if (!together)
    throw new ForerunnerError(
      "unavailable",
      "working together needs the daemon's repository reads; this install has none wired",
    );
  return together;
}

/** The one project the together form closes (any status: a closed one is named in its refusal). */
async function togetherProject(p: ProjectJoinParams, ctx: CommandContext): Promise<ProjectRow> {
  const rows: ProjectRow[] = [];
  for (const named of p.close) {
    const row = await projectNamed(ctx.store, named);
    if (!rows.some((r) => r.id === row.id)) rows.push(row);
  }
  if (rows.length !== 1 || !rows[0])
    throw new ForerunnerError("validation", TOGETHER_ONE_PROJECT, {
      details: { cause: "join_refused" },
    });
  return rows[0];
}

/**
 * Refused in words while the project cannot join now; then the repository's project, read from
 * GitHub now (`ProjectTogetherPort.facts` throws its refusal in words), and the name it takes.
 */
async function togetherFactsFor(
  site: ProjectRow,
  ctx: CommandContext,
): Promise<{ facts: ProjectTogetherFacts; name: string }> {
  const together = togetherPort(ctx);
  const reason = await together.refusal(site.id);
  if (reason)
    throw new ForerunnerError("validation", reason, { details: { cause: "join_refused" } });
  const facts = await together.facts(site.id);
  return { facts, name: await togetherNameFor(ctx.store, facts.name, site, facts.revive) };
}

/** Settings that name a project's own link history; never carried into the together project. */
const NOT_CARRIED = new Set([
  TOGETHER_KEY,
  TOOK_OVER_KEY,
  JOINED_FROM_KEY,
  JOINED_INTO_KEY,
  WAS_LINKED_KEY,
  REMOVED_NAME_KEY,
]);

/**
 * The closing project's settings the together project takes ("Site" becomes "Kite club"): who
 * merges, the budgets, research reads, the status issue's switch, members; never its link's
 * history (took_over, joined_*, together).
 */
function carriedSettings(p: ProjectRow): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(settingsOf(p))) if (!NOT_CARRIED.has(k)) out[k] = v;
  return out;
}

/** A together row removed here, as it was before the join brought it back (for the Undo). */
interface RevivedBefore {
  id: string;
  name: string;
  status: string;
  active: boolean;
  repos: string[];
  settings: JsonObject;
}

async function freedName(store: StateStore, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} (removed)` : `${name} (removed ${n})`;
    if (!(await store.project.byName(candidate))) return candidate;
  }
}

/** What one closed project's join moved, by table, so the Undo moves exactly that back. */
interface Moved {
  tasks: string[];
  milestones: { id: string; from: number }[];
  cards: string[];
  notes: string[];
  merges: string[];
  decisions: string[];
  candidates: string[];
  /** Data assets that gained the kept project (the ones that already listed it are not here). */
  assets: string[];
  /** l4-selftasks-109: the closed project's task-list notes, now the kept project's. */
  taskListNotes?: JsonValue[];
  /** l4-selftasks-109: suggestion cards closed so the kept project has one open. */
  proposals?: string[];
}

/**
 * The runtime's keys (`session/task-list-notes.ts` TASK_LIST_NOTES_KEY, `daemon/task-proposal-words.ts`
 * TASK_PROPOSAL_KEY), spelled here so this command imports no session module.
 */
const TASK_LIST_NOTES_KEY = "task_list_notes";
const TASK_PROPOSAL_KEY = "task_proposal";

function notesIn(p: ProjectRow): JsonValue[] {
  const cache = asObject((p.summary_cache ?? null) as JsonValue);
  const notes = cache[TASK_LIST_NOTES_KEY];
  return Array.isArray(notes) ? notes : [];
}

function cacheOf(p: ProjectRow): JsonObject {
  return { ...asObject((p.summary_cache ?? null) as JsonValue) };
}

/** What a closed project was before the join, for its Undo. */
interface ClosedBefore {
  id: string;
  name: string;
  status: string;
  active: boolean;
  repos: string[];
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Moves rows of `table` with these ids from one project to another (one statement per chunk). */
async function moveRows(
  repo: {
    updateWhere(p: Record<string, unknown>, where: string, params: unknown[]): Promise<unknown[]>;
  },
  ids: readonly string[],
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  for (const part of chunks(ids))
    await repo.updateWhere(
      { project_id: to, ...extra },
      `"project_id" = ? AND "id" IN (${marks(part.length)})`,
      [from, ...part],
    );
}

/**
 * The moves of one closed project into the kept one, inside the transaction `tx`: every task, its
 * milestones after the kept project's, the cards about its tasks and its open cards, its queued
 * notes, merge records, decisions and accepted source proposals; its data assets add the kept
 * project. Sessions, ledger rows, changes, messages, lessons and answered project cards stay.
 */
async function moveWork(
  tx: StateStore,
  from: ProjectRow,
  to: ProjectRow,
  author: { author_human: string | null; author_agent: string | null },
): Promise<Moved> {
  const tasks = (await tx.task.list({ project_id: from.id } as never, { limit: 100_000 })).map(
    (t) => t.id,
  );
  const taskSet = new Set(tasks);
  await moveRows(tx.task as never, tasks, from.id, to.id);
  // Milestones after the kept project's, in their own order.
  const keptMilestones = await tx.milestone.forProject(to.id, { limit: 10_000 });
  const offset = keptMilestones.reduce((max, m) => Math.max(max, m.order_index), -1) + 1;
  const milestones = await tx.milestone.forProject(from.id, { limit: 10_000 });
  for (const m of milestones)
    await tx.milestone.updateWhere(
      {
        project_id: to.id,
        order_index: offset + m.order_index,
        reason: `Moved into "${to.name}" when "${from.name}" joined it.`,
        ...author,
      },
      `"id" = ?`,
      [m.id],
    );
  const cards = (await tx.humanRequest.list({ project_id: from.id } as never, { limit: 100_000 }))
    .filter((r) => (r.task_id && taskSet.has(r.task_id)) || r.status === "open")
    .map((r) => r.id);
  await moveRows(tx.humanRequest as never, cards, from.id, to.id);
  const notes = (
    await tx.queue.list({ project_id: from.id, status: "queued" } as never, { limit: 100_000 })
  ).map((q) => q.id);
  await moveRows(tx.queue as never, notes, from.id, to.id);
  const merges = (
    await tx.mergeRecord.list({ project_id: from.id } as never, { limit: 100_000 })
  ).map((m) => m.id);
  await moveRows(tx.mergeRecord as never, merges, from.id, to.id);
  const decisions = (
    await tx.decision.list({ project_id: from.id } as never, { limit: 100_000 })
  ).map((d) => d.id);
  await moveRows(tx.decision as never, decisions, from.id, to.id);
  const candidates = (
    await tx.sourceCandidate.list({ project_id: from.id, status: "accepted" } as never, {
      limit: 100_000,
    })
  ).map((c) => c.id);
  await moveRows(tx.sourceCandidate as never, candidates, from.id, to.id);
  const assets: string[] = [];
  for (const a of await tx.dataAsset.forProject(from.id)) {
    if (a.project_ids.includes(to.id)) continue;
    await tx.dataAsset.update(a.id, a.version, { project_ids: [...a.project_ids, to.id] });
    assets.push(a.id);
  }
  // l4-selftasks-109 (C4L-14): the notes a session kept for the closed project's task check go
  // with its tasks (before, they stayed on the closed project and were never checked), after the
  // kept project's own.
  const fromRow = await tx.project.mustGet(from.id);
  const taskListNotes = notesIn(fromRow);
  if (taskListNotes.length) {
    const keepRow = await tx.project.mustGet(to.id);
    await tx.project.update(keepRow.id, keepRow.version, {
      summary_cache: {
        ...cacheOf(keepRow),
        [TASK_LIST_NOTES_KEY]: [...notesIn(keepRow), ...taskListNotes],
      },
    });
    const rest = cacheOf(fromRow);
    delete rest[TASK_LIST_NOTES_KEY];
    await tx.project.update(fromRow.id, fromRow.version, { summary_cache: rest });
  }
  // One open suggestion of the agent per project (ADR 0119 point 7): the newest stays open, an
  // older one is closed as replaced; Undo opens it again.
  const proposals: string[] = [];
  const open = (
    await tx.humanRequest.list({ project_id: to.id, status: "open" } as never, { limit: 1_000 })
  )
    .filter((r) => (r.change_card as { key?: unknown } | null)?.key === TASK_PROPOSAL_KEY)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  for (const old of open.slice(1)) {
    const marked = await tx.humanRequest.patch(old.id, {
      change_card: { ...asObject(old.change_card as JsonValue), replaced: true },
    });
    await tx.humanRequest.withdraw(marked.id, marked.version);
    proposals.push(old.id);
  }
  return {
    tasks,
    milestones: milestones.map((m) => ({ id: m.id, from: m.order_index })),
    cards,
    notes,
    merges,
    decisions,
    candidates,
    assets,
    ...(taskListNotes.length ? { taskListNotes } : {}),
    ...(proposals.length ? { proposals } : {}),
  };
}

function settingsOf(p: ProjectRow): JsonObject {
  return p.settings && typeof p.settings === "object" && !Array.isArray(p.settings)
    ? { ...p.settings }
    : {};
}

function movedOf(v: JsonValue | undefined): Moved {
  const o = asObject(v ?? null);
  const ids = (x: JsonValue | undefined) =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  const milestones = Array.isArray(o.milestones)
    ? o.milestones.flatMap((m) => {
        const r = asObject(m);
        return typeof r.id === "string" && typeof r.from === "number"
          ? [{ id: r.id, from: r.from }]
          : [];
      })
    : [];
  return {
    tasks: ids(o.tasks),
    milestones,
    cards: ids(o.cards),
    notes: ids(o.notes),
    merges: ids(o.merges),
    decisions: ids(o.decisions),
    candidates: ids(o.candidates),
    assets: ids(o.assets),
    taskListNotes: Array.isArray(o.taskListNotes) ? o.taskListNotes : [],
    proposals: ids(o.proposals),
  };
}

function closedOf(v: JsonValue | undefined): ClosedBefore[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = asObject(x);
    return typeof o.id === "string"
      ? [
          {
            id: o.id,
            name: typeof o.name === "string" ? o.name : "",
            status: typeof o.status === "string" ? o.status : "active",
            active: o.active !== false,
            repos: Array.isArray(o.repos)
              ? o.repos.filter((s): s is string => typeof s === "string")
              : [],
          },
        ]
      : [];
  });
}

/** A session of the project that works now (never the chat's own row or a planning call). */
async function workingSession(store: StateStore, projectId: string): Promise<boolean> {
  const rows = await store.session.list({
    project_id: projectId,
    status: ["running", "paused", "planned"],
  } as never);
  return rows.some((s) => {
    if (s.summary === "conversation") return false;
    const plan = s.plan as { intake?: unknown } | null;
    return !(plan && typeof plan === "object" && !Array.isArray(plan) && plan.intake);
  });
}

export const projectJoin: CommandDef<ProjectJoinParams> = {
  name: "project.join",
  description: PROJECT_JOIN_DESCRIPTION,
  params,
  risk: "medium",
  maxRisk: "medium",
  askFromChat: true,
  scope: "project",
  reversible: true,
  undoStrategy:
    "move every moved row back to its project and reopen it with its link, while no session runs on the kept project and nothing of it waits for the moved work",
  async plan(p, ctx) {
    if (isTogetherForm(p)) {
      // OJ-11: GitHub is read now (a read costs no model money); nothing is written before the
      // yes, and the run reads it again.
      const site = await togetherProject(p, ctx);
      const { facts, name } = await togetherFactsFor(site, ctx);
      return buildCard({
        command: "project.join",
        what: "the project this repository is",
        oldValue: `"${site.name}"`,
        newValue: `"${name}"`,
        scope: "project",
        risk: "medium",
        sentence: togetherJoinedSentence(site.name, name, null),
        reversible: true,
        projectId: site.id,
        projectName: site.name,
        ask: togetherJoinAsk(site.name, name),
        // The name is the repository's text: data for chat (ADR 0114).
        ...(facts.name ? { untrusted: facts.untrusted } : {}),
      });
    }
    const r = await resolve(p as PairParams, ctx);
    await assertJoinable(r, ctx);
    const names = r.close.map((c) => c.name);
    return buildCard({
      command: "project.join",
      what: "the projects on one repository",
      oldValue: [r.keep.name, ...names].map((n) => `"${n}"`).join(", "),
      newValue: `"${r.keep.name}"`,
      scope: "project",
      risk: "medium",
      sentence: joinSentence(r.keep.name, names),
      reversible: true,
      projectId: r.keep.id,
      projectName: r.keep.name,
      ask: joinAsk(r.keep.name, names),
    });
  },
  async run(p, ctx) {
    if (isTogetherForm(p)) return runTogether(p, ctx);
    const r = await resolve(p as PairParams, ctx);
    // Checked again at the run (a read-back's yes may come later), then everything in one
    // transaction: a failure moves nothing.
    await assertJoinable(r, ctx);
    const author = authorOf(ctx);
    const at = ctx.clock.nowIso();
    const moved: Record<string, Moved> = {};
    const closed: ClosedBefore[] = [];
    await ctx.store.transaction(async (tx) => {
      for (const from of r.close) {
        moved[from.id] = await moveWork(tx, from, r.keep, author);
        const row = await tx.project.mustGet(from.id);
        closed.push({
          id: row.id,
          name: row.name,
          status: row.status,
          active: row.active,
          repos: row.repos,
        });
        await tx.project.update(row.id, row.version, {
          status: "archived",
          active: false,
          repos: [],
          settings: {
            ...settingsOf(row),
            [JOINED_INTO_KEY]: { project: r.keep.id, name: r.keep.name, at },
            [WAS_LINKED_KEY]: row.repos,
          },
          ...author,
        });
      }
      const keep = await tx.project.mustGet(r.keep.id);
      const from = joinedFromOf(keep);
      await tx.project.update(keep.id, keep.version, {
        settings: {
          ...settingsOf(keep),
          [JOINED_FROM_KEY]: [
            ...from,
            ...r.close.map((c) => c.id).filter((id) => !from.includes(id)),
          ],
        },
        ...author,
      });
    });
    const names = r.close.map((c) => c.name);
    return {
      before: { closed: closed as unknown as JsonValue },
      after: {
        keep: { id: r.keep.id, name: r.keep.name },
        closed: closed.map((c) => c.id),
        moved: moved as unknown as JsonValue,
        at,
      },
      sentence: joinSentence(r.keep.name, names),
      projectId: r.keep.id,
    };
  },
  /**
   * OJ-04: never while a session runs on the kept project, while a moved task's merge is under
   * way, or while a task of the kept project that was not moved waits for a moved one (or a moved
   * one for it): Undo never leaves a dependency across two projects.
   */
  async undoBlocked(_p, before, after, ctx) {
    const a = asObject(after);
    const keepId =
      typeof asObject(a.keep ?? null).id === "string"
        ? (asObject(a.keep ?? null).id as string)
        : null;
    if (!keepId) return null;
    const keep = await ctx.store.project.get(keepId);
    if (!keep) return null;
    if (await workingSession(ctx.store, keep.id)) return joinUndoRunning(keep.name);
    const moved = asObject(a.moved ?? null);
    const closed = closedOf(asObject(before).closed);
    const tasks = await ctx.store.task.list({ project_id: keep.id } as never, { limit: 100_000 });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // OJ-11: the together project goes with the Undo; work made in it since would go with it.
    if (a.together === true) {
      const movedIds = new Set(closed.flatMap((c) => movedOf(moved[c.id]).tasks));
      const own = tasks.find((t) => !movedIds.has(t.id));
      if (own) return togetherUndoOwnWork(keep.name, own.title);
    }
    for (const c of closed) {
      const ids = new Set(movedOf(moved[c.id]).tasks);
      for (const id of ids) {
        const record = await ctx.store.mergeRecord.forTask(id);
        if (record?.state === "merging") return joinUndoMerging(c.name);
      }
      for (const t of tasks) {
        if (ids.has(t.id)) {
          const kept = t.depends_on.find((d) => byId.has(d) && !ids.has(d));
          if (kept) return joinUndoDependsOnKept(t.title, c.name, byId.get(kept)?.title ?? "");
          continue;
        }
        const on = t.depends_on.find((d) => ids.has(d));
        if (on) return joinUndoDependency(t.title, byId.get(on)?.title ?? "", c.name);
      }
    }
    return null;
  },
  async undo(_p, before, after, ctx) {
    const a = asObject(after);
    const keepId = asObject(a.keep ?? null).id;
    if (typeof keepId !== "string") return;
    const moved = asObject(a.moved ?? null);
    const closed = closedOf(asObject(before).closed);
    const author = authorOf(ctx);
    await ctx.store.transaction(async (tx) => {
      for (const c of closed) {
        const m = movedOf(moved[c.id]);
        const taskSet = new Set(m.tasks);
        await moveRows(tx.task as never, m.tasks, keepId, c.id);
        for (const ms of m.milestones)
          await tx.milestone.updateWhere(
            {
              project_id: c.id,
              order_index: ms.from,
              reason: `Moved back to "${c.name}": Make one project was undone.`,
              ...author,
            },
            `"id" = ? AND "project_id" = ?`,
            [ms.id, keepId],
          );
        // The moved cards and merge records, and the ones made on the kept project since for a
        // moved task (a card about it, the merge of its pull request).
        const cards = new Set(m.cards);
        const merges = new Set(m.merges);
        if (taskSet.size) {
          for (const r of await tx.humanRequest.list({ project_id: keepId } as never, {
            limit: 100_000,
          }))
            if (r.task_id && taskSet.has(r.task_id)) cards.add(r.id);
          for (const r of await tx.mergeRecord.list({ project_id: keepId } as never, {
            limit: 100_000,
          }))
            if (taskSet.has(r.task_id)) merges.add(r.id);
        }
        await moveRows(tx.humanRequest as never, [...cards], keepId, c.id);
        await moveRows(tx.mergeRecord as never, [...merges], keepId, c.id);
        await moveRows(tx.queue as never, m.notes, keepId, c.id);
        await moveRows(tx.decision as never, m.decisions, keepId, c.id);
        await moveRows(tx.sourceCandidate as never, m.candidates, keepId, c.id);
        for (const id of m.assets) {
          const asset = await tx.dataAsset.get(id);
          if (!asset) continue;
          await tx.dataAsset.update(asset.id, asset.version, {
            project_ids: asset.project_ids.filter((x) => x !== keepId),
          });
        }
        // l4-selftasks-109: the suggestions the join closed open again, and the notes go back.
        for (const id of m.proposals ?? []) {
          const card = await tx.humanRequest.get(id);
          if (card?.status !== "withdrawn") continue;
          const { replaced: _replaced, ...rest } = asObject(card.change_card as JsonValue);
          const reopened = await tx.humanRequest.reopenWithdrawn(card.id, card.version);
          await tx.humanRequest.patch(reopened.id, { change_card: rest });
        }
        if (m.taskListNotes?.length) {
          const moving = new Set(m.taskListNotes.map((n) => JSON.stringify(n)));
          const keepRow = await tx.project.get(keepId);
          if (keepRow)
            await tx.project.update(keepRow.id, keepRow.version, {
              summary_cache: {
                ...cacheOf(keepRow),
                [TASK_LIST_NOTES_KEY]: notesIn(keepRow).filter(
                  (n) => !moving.has(JSON.stringify(n)),
                ),
              },
            });
          const back = await tx.project.get(c.id);
          if (back)
            await tx.project.update(back.id, back.version, {
              summary_cache: {
                ...cacheOf(back),
                [TASK_LIST_NOTES_KEY]: [...notesIn(back), ...m.taskListNotes],
              },
            });
        }
        const row = await tx.project.get(c.id);
        if (row) {
          const settings = settingsOf(row);
          const repos = Array.isArray(settings[WAS_LINKED_KEY])
            ? (settings[WAS_LINKED_KEY] as JsonValue[]).filter(
                (s): s is string => typeof s === "string",
              )
            : c.repos;
          delete settings[JOINED_INTO_KEY];
          delete settings[WAS_LINKED_KEY];
          await tx.project.update(row.id, row.version, {
            status: c.status === "archived" ? "active" : (c.status as ProjectRow["status"]),
            // As it was before the join (a project left off comes back off).
            active: c.active,
            repos,
            settings,
            ...author,
          });
        }
      }
      const keep = await tx.project.get(keepId);
      if (keep) {
        const ids = new Set(closed.map((c) => c.id));
        const left = joinedFromOf(keep).filter((id) => !ids.has(id));
        const settings = settingsOf(keep);
        if (left.length) settings[JOINED_FROM_KEY] = left;
        else delete settings[JOINED_FROM_KEY];
        const together = asObject(asObject(before).together ?? null);
        if (a.together === true && together.revived && typeof together.revived === "object") {
          // A together row removed here that the join brought back is removed again, as it was.
          const was = asObject(together.revived as JsonValue);
          await tx.project.update(keep.id, keep.version, {
            status: (typeof was.status === "string"
              ? was.status
              : "archived") as ProjectRow["status"],
            active: was.active === true,
            name: typeof was.name === "string" ? was.name : keep.name,
            repos: Array.isArray(was.repos)
              ? was.repos.filter((s): s is string => typeof s === "string")
              : keep.repos,
            settings: asObject((was.settings ?? null) as JsonValue),
            ...author,
          });
        } else if (a.together === true) {
          // OJ-11: the together project the join made goes as a removed one: its name is freed,
          // it never frees the repository (ADR 0117), and Work together brings the same row back.
          await tx.project.update(keep.id, keep.version, {
            status: "archived",
            active: false,
            name: await freedName(tx, keep.name),
            settings: { ...settings, [REMOVED_NAME_KEY]: keep.name },
            ...author,
          });
        } else await tx.project.update(keep.id, keep.version, { settings, ...author });
      }
    });
  },
  undoSentence(_p, before, after) {
    const names = closedOf(asObject(before).closed).map((c) => c.name);
    const a = asObject(after ?? null);
    if (a.together === true && names[0])
      return togetherUndoneSentence(
        names[0],
        typeof a.oldStatusPr === "number" ? a.oldStatusPr : null,
      );
    return joinUndoneSentence(names);
  },
};

/**
 * OJ-11 (W8-join-1, -2): Work together for a project already here, in one store transaction
 * after the one GitHub write. GitHub is read again first (refused in words when it does not
 * answer: nothing moves); then the project's own old status pull request is closed, if an
 * earlier version of this install opened one (the join's only write on GitHub: nothing of the
 * other Forerunner is touched); then the together project is made with the repository's id and
 * name (or the removed together row comes back) with the closing project's settings, the
 * closing project's work moves into it as Make one project moves it, and the closing project is
 * closed into it. Undo (also after a restart) moves the work back and removes the together
 * project again; the closed pull request stays closed.
 */
async function runTogether(p: ProjectJoinParams, ctx: CommandContext) {
  const together = togetherPort(ctx);
  const site = await togetherProject(p, ctx);
  const { facts } = await togetherFactsFor(site, ctx);
  let oldStatusPr: number | null;
  try {
    oldStatusPr = await together.closeOldStatus(site);
  } catch {
    throw new ForerunnerError("validation", TOGETHER_UNREADABLE, {
      details: { cause: "github_unreadable" },
    });
  }
  const author = authorOf(ctx);
  const at = ctx.clock.nowIso();
  const moved: Record<string, Moved> = {};
  const closed: ClosedBefore[] = [];
  let revived: RevivedBefore | null = null;
  let made: ProjectRow | null = null;
  await ctx.store.transaction(async (tx) => {
    const from = await tx.project.mustGet(site.id);
    const name = await togetherNameFor(tx, facts.name, from, facts.revive);
    const settings: JsonObject = {
      ...carriedSettings(from),
      [TOGETHER_KEY]: {
        name: facts.name ?? name,
        at,
        activeOn: facts.activeOn,
        login: facts.login,
      },
      [JOINED_FROM_KEY]: [from.id],
    };
    if (facts.revive) {
      const row = await tx.project.mustGet(facts.revive.id);
      revived = {
        id: row.id,
        name: row.name,
        status: row.status,
        active: row.active,
        repos: row.repos,
        settings: settingsOf(row),
      };
      made = await tx.project.update(row.id, row.version, {
        status: "active",
        active: true,
        name,
        goal: from.goal,
        repos: from.repos,
        settings,
        ...author,
      });
    } else {
      made = await tx.project.insert({
        id: facts.id,
        name,
        goal: from.goal,
        repos: from.repos,
        stage: from.stage,
        status: "active",
        budget_usd_micro: from.budget_usd_micro,
        autonomy_level: from.autonomy_level,
        summary_cache: {},
        data_assets: [],
        settings,
        small_project_mode: from.small_project_mode,
        active: true,
        author_human: ctx.humanId,
      });
    }
    moved[from.id] = await moveWork(tx, from, made, author);
    const row = await tx.project.mustGet(from.id);
    closed.push({
      id: row.id,
      name: row.name,
      status: row.status,
      active: row.active,
      repos: row.repos,
    });
    await tx.project.update(row.id, row.version, {
      status: "archived",
      active: false,
      repos: [],
      settings: {
        ...settingsOf(row),
        [JOINED_INTO_KEY]: { project: made.id, name: made.name, at },
        [WAS_LINKED_KEY]: row.repos,
      },
      ...author,
    });
  });
  const kept = made as ProjectRow | null;
  if (!kept) throw new ForerunnerError("internal", "the together project was not made");
  return {
    before: {
      closed: closed as unknown as JsonValue,
      together: { revived: revived as unknown as JsonValue },
    },
    after: {
      keep: { id: kept.id, name: kept.name },
      closed: closed.map((c) => c.id),
      moved: moved as unknown as JsonValue,
      at,
      together: true,
      oldStatusPr,
    },
    sentence: togetherJoinedSentence(site.name, kept.name, oldStatusPr),
    projectId: kept.id,
    ...(facts.name ? { untrusted: facts.untrusted } : {}),
  };
}

/**
 * OJ-06: why the kept project's creation cannot be undone while it includes another project's
 * work (`project.create`'s undoBlocked asks it, beside the running-session reason); null when it
 * includes none.
 */
export async function joinedCreateUndoBlocked(
  store: StateStore,
  project: ProjectRow,
): Promise<string | null> {
  const names: string[] = [];
  for (const id of joinedFromOf(project)) {
    const row = await store.project.get(id);
    if (row && joinedIntoOf(row)?.project === project.id) names.push(row.name);
  }
  return names.length ? createUndoJoined(names) : null;
}
