import type { Clock } from "@forerunner/platform";
import { ForerunnerError } from "@forerunner/platform";
import type { LessonRow } from "@forerunner/state";
import { cosine } from "./embedding.ts";
import { exportRow } from "./files.ts";
import { polarityConflict } from "./polarity.ts";
import { parseSource } from "./record.ts";
import type { MemoryContext, MemoryScope } from "./types.ts";

/**
 * Weekly consolidation (spec G, ADR 0002): merge duplicates, flag contradictions, retire
 * unused lessons. The report is what the human reviews; nothing changes unless `apply: true`.
 * The caller (runtime scheduler) files the HumanRequest with `proposals` and calls again with
 * `apply: true` once approved.
 */

export interface ConsolidationOptions {
  scope: MemoryScope;
  /** Required for agent_private: a private plan runs for one owner only. */
  ownerAgentId?: string;
  clock?: Clock;
  /** Write the changes. Default false: report only. */
  apply?: boolean;
  /** Duplicate when cosine >= this. Default 0.9. */
  duplicateThreshold?: number;
  /** Contradiction candidates need cosine >= this (no upper bound). Default 0.6. */
  contradictionMin?: number;
  /** Retire lessons never used and created more than this many days ago. Default 60. */
  unusedAfterDays?: number;
  /** Retire lessons whose last use is more than this many days ago. Default 90. */
  staleAfterDays?: number;
}

export interface MergeProposal {
  keptId: string;
  retiredIds: string[];
  cosine: number;
  /**
   * The project the kept lesson has after the merge: null (global) as soon as any member of
   * the group is global, so a merge never narrows what other projects can see.
   */
  projectId: string | null;
}

export interface ContradictionProposal {
  a: string;
  b: string;
  reason: string;
  cosine: number;
}

export interface ConsolidationReport {
  scope: MemoryScope;
  ownerAgentId: string | null;
  ranAt: string;
  applied: boolean;
  merged: MergeProposal[];
  contradictions: ContradictionProposal[];
  retired: string[];
  /** Human-readable lines, one per change, for the approval request. */
  proposals: string[];
}

export const DEFAULT_CONSOLIDATION = Object.freeze({
  duplicateThreshold: 0.9,
  contradictionMin: 0.6,
  unusedAfterDays: 60,
  staleAfterDays: 90,
  intervalDays: 7,
});

/** True when the weekly job is due: never run, or `intervalDays` or more since the last run. */
export function consolidationDue(
  lastRunIso: string | null | undefined,
  now: number | string | Date,
  intervalDays: number = DEFAULT_CONSOLIDATION.intervalDays,
): boolean {
  if (!lastRunIso) return true;
  const last = Date.parse(lastRunIso);
  if (!Number.isFinite(last)) return true;
  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  return nowMs - last >= intervalDays * 86_400_000;
}

function sameProjectOrGlobal(a: LessonRow, b: LessonRow): boolean {
  return a.project_id === null || b.project_id === null || a.project_id === b.project_id;
}

/**
 * A project-level copy accepted from a promotion offer (spec G.6) names its global origin in
 * `source` (`promotion:<origin id>`). The two carry the same text by design and are never a
 * duplicate pair: merging them would keep the pinned copy and make it global, pinning the
 * lesson for every project the human never accepted it for.
 */
function acceptedCopyOf(a: LessonRow, b: LessonRow): boolean {
  return parseSource(a.source).promotion === b.id || parseSource(b.source).promotion === a.id;
}

function shareTag(a: LessonRow, b: LessonRow): boolean {
  const set = new Set(a.tags);
  return b.tags.some((t) => set.has(t));
}

function preview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 70 ? `${one.slice(0, 67)}...` : one;
}

/** Keep the most used, then the most confident, then the oldest; a pinned lesson always wins. */
function keepOrder(a: LessonRow, b: LessonRow): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    b.hit_count - a.hit_count ||
    b.confidence - a.confidence ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id)
  );
}

export async function consolidate(
  ctx: MemoryContext,
  opts: ConsolidationOptions,
): Promise<ConsolidationReport> {
  const clock = opts.clock ?? ctx.clock;
  const cfg = { ...DEFAULT_CONSOLIDATION, ...opts };
  if (opts.scope === "agent_private" && !opts.ownerAgentId) {
    throw new ForerunnerError("validation", "private consolidation needs ownerAgentId");
  }
  const ownerAgentId = opts.scope === "agent_private" ? (opts.ownerAgentId as string) : null;
  const report: ConsolidationReport = {
    scope: opts.scope,
    ownerAgentId,
    ranAt: clock.nowIso(),
    applied: false,
    merged: [],
    contradictions: [],
    retired: [],
    proposals: [],
  };
  const all = await ctx.repo.list(
    ownerAgentId
      ? { scope: opts.scope, owner_agent_id: ownerAgentId, status: "active" }
      : { scope: opts.scope, status: "active" },
  );
  const rows = all.filter((r) => r.superseded_by === null).sort((a, b) => a.id.localeCompare(b.id));
  const vectors = new Map<string, ArrayLike<number>>();
  for (const r of rows) {
    vectors.set(
      r.id,
      r.embedding && r.embedding.length === ctx.embedder.dims
        ? r.embedding
        : ctx.embedder.embed(r.text),
    );
  }
  const sim = (a: LessonRow, b: LessonRow) =>
    cosine(vectors.get(a.id) as ArrayLike<number>, vectors.get(b.id) as ArrayLike<number>);

  // 1. Duplicates: union-find over pairs above the threshold. A pair on opposite sides of a
  //    polarity word is never a duplicate, whatever its cosine; step 2 flags it instead.
  const parent = new Map<string, string>(rows.map((r) => [r.id, r.id]));
  const find = (id: string): string => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur) as string;
    parent.set(id, cur);
    return cur;
  };
  const pairSim = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i] as LessonRow;
      const b = rows[j] as LessonRow;
      if (!sameProjectOrGlobal(a, b) || acceptedCopyOf(a, b)) continue;
      const s = sim(a, b);
      pairSim.set(`${a.id}|${b.id}`, s);
      if (s >= cfg.duplicateThreshold && !polarityConflict(a.text, b.text)) {
        parent.set(find(a.id), find(b.id));
      }
    }
  }
  const groups = new Map<string, LessonRow[]>();
  for (const r of rows) {
    const root = find(r.id);
    const g = groups.get(root) ?? [];
    g.push(r);
    groups.set(root, g);
  }
  // A third lesson can link an accepted copy and its origin through the union; the copy is
  // then left out of that group (its own singleton) and the rest merges as usual.
  for (const [root, g] of [...groups]) {
    const ids = new Set(g.map((r) => r.id));
    const copies = g.filter((r) => {
      const origin = parseSource(r.source).promotion;
      return origin !== undefined && origin !== r.id && ids.has(origin);
    });
    if (copies.length === 0) continue;
    const copyIds = new Set(copies.map((c) => c.id));
    groups.set(
      root,
      g.filter((r) => !copyIds.has(r.id)),
    );
    for (const c of copies) groups.set(c.id, [c]);
  }
  const mergedAway = new Set<string>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(keepOrder);
    const kept = ordered[0] as LessonRow;
    const losers = ordered.slice(1);
    let minSim = 1;
    for (const l of losers) {
      mergedAway.add(l.id);
      const key = kept.id < l.id ? `${kept.id}|${l.id}` : `${l.id}|${kept.id}`;
      minSim = Math.min(minSim, pairSim.get(key) ?? sim(kept, l));
    }
    const projectId = group.some((r) => r.project_id === null) ? null : kept.project_id;
    const becomesGlobal = projectId === null && kept.project_id !== null;
    report.merged.push({
      keptId: kept.id,
      retiredIds: losers.map((l) => l.id),
      cosine: Math.round(minSim * 1000) / 1000,
      projectId,
    });
    report.proposals.push(
      `merge: keep ${kept.id} "${preview(kept.text)}" (hits ${kept.hit_count}, confidence ${kept.confidence}${becomesGlobal ? ", becomes global" : ""}); retire ${losers
        .map((l) => `${l.id} "${preview(l.text)}"`)
        .join(", ")} (cosine >= ${cfg.duplicateThreshold})`,
    );
  }

  // 2. Contradictions: same tags, opposite polarity, similar enough to be about one thing.
  //    No upper bound: "always X" and "never X" are near-identical strings and still contradict.
  const survivors = rows.filter((r) => !mergedAway.has(r.id));
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const a = survivors[i] as LessonRow;
      const b = survivors[j] as LessonRow;
      if (!sameProjectOrGlobal(a, b) || !shareTag(a, b)) continue;
      const s = pairSim.get(`${a.id}|${b.id}`) ?? sim(a, b);
      if (s < cfg.contradictionMin) continue;
      const label = polarityConflict(a.text, b.text);
      if (!label) continue;
      const reason = `${label}: "${preview(a.text)}" vs "${preview(b.text)}"`;
      report.contradictions.push({ a: a.id, b: b.id, reason, cosine: Math.round(s * 1000) / 1000 });
      report.proposals.push(
        `contradiction (flag only, not resolved): ${a.id} vs ${b.id}: ${reason}`,
      );
    }
  }

  // 3. Unused: never used and old, or not used for a long time. Pinned lessons stay.
  const nowMs = clock.now();
  const ageDays = (iso: string) => (nowMs - Date.parse(iso)) / 86_400_000;
  for (const r of survivors) {
    if (r.pinned) continue;
    const neverUsed = r.hit_count === 0 && ageDays(r.created_at) > cfg.unusedAfterDays;
    const stale = r.last_used !== null && ageDays(r.last_used) > cfg.staleAfterDays;
    if (!neverUsed && !stale) continue;
    report.retired.push(r.id);
    report.proposals.push(
      neverUsed
        ? `retire: ${r.id} "${preview(r.text)}" never used, created ${r.created_at.slice(0, 10)}`
        : `retire: ${r.id} "${preview(r.text)}" last used ${(r.last_used as string).slice(0, 10)}`,
    );
  }

  if (!opts.apply) return report;

  // 4. Apply: row first, then the file mirror; every change bumps version through the repo.
  for (const m of report.merged) {
    for (const id of m.retiredIds) {
      const row = await ctx.repo.patch(id, { superseded_by: m.keptId, status: "retired" });
      await exportRow(ctx.files, row);
    }
    const kept = byId.get(m.keptId) as LessonRow;
    if (kept.project_id !== m.projectId) {
      const widened = await ctx.repo.patch(m.keptId, { project_id: m.projectId });
      byId.set(m.keptId, widened);
      await exportRow(ctx.files, widened);
    }
  }
  const flagsFor = new Map<string, Set<string>>();
  for (const c of report.contradictions) {
    (flagsFor.get(c.a) ?? flagsFor.set(c.a, new Set()).get(c.a))?.add(`contradiction:${c.b}`);
    (flagsFor.get(c.b) ?? flagsFor.set(c.b, new Set()).get(c.b))?.add(`contradiction:${c.a}`);
  }
  for (const [id, flags] of flagsFor) {
    const row = byId.get(id) as LessonRow;
    const path = ctx.files.pathFor(row.scope, row.owner_agent_id, row.id);
    const existing = (await ctx.files.exists(path)) ? (await ctx.files.read(path)).flags : [];
    await exportRow(ctx.files, row, [...new Set([...existing, ...flags])].sort());
  }
  for (const id of report.retired) {
    const row = await ctx.repo.patch(id, { status: "retired" });
    await exportRow(ctx.files, row);
  }
  await ctx.files.writeCatalog(opts.scope, ownerAgentId);
  report.applied = true;
  return report;
}
