import { ForerunnerError } from "@forerunner/platform";
import type { LessonRow } from "@forerunner/state";
import { citedLessonIds, exportRow } from "./files.ts";
import { formatSource, parseSource, remember } from "./record.ts";
import type { MemoryContext } from "./types.ts";

/**
 * Cross-project promotion (spec G, ADR 0002): a lesson tagged `general` is proposed into the
 * shared scope with `project: *`; after a critic review accepts it, the proposal becomes active.
 * Promotion is an explicit, visible copy: the origin stays where it is (a project-level shared
 * origin is marked superseded by the promoted copy).
 */

export const GENERAL_TAG = "general";

export interface ProposeOptions {
  /** The proposing agent; a private lesson may only be proposed by its owner. */
  agentId?: string;
  /** A private lesson needs the owner human's approval of the exact text first. */
  humanApproval?: { humanId: string };
}

/** Lesson ids cited in `text` that are not shared-scope lessons; promotion refuses them. */
export async function foreignReferences(ctx: MemoryContext, text: string): Promise<string[]> {
  const foreign: string[] = [];
  for (const id of citedLessonIds(text)) {
    const row = await ctx.repo.get(id);
    if (row?.scope !== "shared") foreign.push(id);
  }
  return foreign;
}

/** Existing open proposal for an origin, if any (idempotent proposing). */
export async function proposalFor(
  ctx: MemoryContext,
  originId: string,
): Promise<LessonRow | undefined> {
  const proposed = await ctx.repo.list({ scope: "shared", status: "proposed" });
  return proposed.find((r) => parseSource(r.source).promotion === originId);
}

export async function proposePromotion(
  ctx: MemoryContext,
  lessonId: string,
  opts: ProposeOptions = {},
): Promise<LessonRow> {
  const origin = await ctx.repo.mustGet(lessonId);
  if (origin.status !== "active" || origin.superseded_by !== null) {
    throw new ForerunnerError("validation", "only an active, current lesson can be promoted", {
      details: { id: lessonId, status: origin.status },
    });
  }
  if (origin.scope === "shared" && origin.project_id === null) {
    throw new ForerunnerError("validation", "lesson is already shared across projects", {
      details: { id: lessonId },
    });
  }
  if (!origin.tags.includes(GENERAL_TAG)) {
    throw new ForerunnerError("validation", `only lessons tagged "${GENERAL_TAG}" are promoted`, {
      details: { id: lessonId, tags: origin.tags },
    });
  }
  if (origin.scope === "agent_private") {
    if (!opts.agentId || opts.agentId !== origin.owner_agent_id) {
      throw new ForerunnerError(
        "autonomy_insufficient",
        "a private lesson is proposed only by its owning agent",
        { details: { id: lessonId } },
      );
    }
    if (!opts.humanApproval?.humanId) {
      throw new ForerunnerError(
        "approval_required",
        "the owner human must approve the exact text before a private lesson leaves the machine",
        { details: { id: lessonId } },
      );
    }
  }
  const foreign = await foreignReferences(ctx, origin.text);
  if (foreign.length) {
    throw new ForerunnerError("validation", "lesson cites ids outside the shared scope", {
      details: { id: lessonId, foreign },
    });
  }
  const existing = await proposalFor(ctx, origin.id);
  if (existing) return existing;
  const { lesson } = await remember(
    ctx,
    {
      scope: "shared",
      text: origin.text,
      tags: origin.tags,
      source: formatSource({ promotion: origin.id }),
      confidence: origin.confidence,
      projectId: null,
      status: "proposed",
      authorAgent: opts.agentId ?? origin.author_agent,
      authorHuman: opts.humanApproval?.humanId ?? origin.author_human,
    },
    { noDedup: true },
  );
  return lesson;
}

export interface PromoteApproval {
  /** The critic review that accepted the proposal (tier 1). */
  reviewId: string;
}

export async function promote(
  ctx: MemoryContext,
  proposedId: string,
  approvedBy: PromoteApproval,
): Promise<LessonRow> {
  if (!approvedBy?.reviewId) {
    throw new ForerunnerError("approval_required", "promotion needs an accepting critic review");
  }
  const proposed = await ctx.repo.mustGet(proposedId);
  if (proposed.scope !== "shared" || proposed.status !== "proposed") {
    throw new ForerunnerError("validation", "not a pending promotion", {
      details: { id: proposedId, scope: proposed.scope, status: proposed.status },
    });
  }
  const source = parseSource(proposed.source);
  if (!source.promotion) {
    throw new ForerunnerError("validation", "proposal does not name its origin", {
      details: { id: proposedId, source: proposed.source },
    });
  }
  if (ctx.reviews) {
    const review = await ctx.reviews.mustGet(approvedBy.reviewId);
    if (review.verdict !== "accept") {
      throw new ForerunnerError("approval_required", "the review did not accept the promotion", {
        details: { reviewId: approvedBy.reviewId, verdict: review.verdict },
      });
    }
  }
  const foreign = await foreignReferences(ctx, proposed.text);
  if (foreign.length) {
    throw new ForerunnerError("validation", "lesson cites ids outside the shared scope", {
      details: { id: proposedId, foreign },
    });
  }
  const promoted = await ctx.repo.update(proposed.id, proposed.version, {
    status: "active",
    project_id: null,
    source: formatSource({ ...source, approved_by: approvedBy.reviewId }),
  });
  await exportRow(ctx.files, promoted);
  const origin = await ctx.repo.get(source.promotion);
  if (
    origin &&
    origin.scope === "shared" &&
    origin.status === "active" &&
    origin.superseded_by === null
  ) {
    const retired = await ctx.repo.patch(origin.id, {
      superseded_by: promoted.id,
      status: "retired",
    });
    await exportRow(ctx.files, retired);
  }
  await ctx.files.writeCatalog("shared");
  return promoted;
}

/** Reject a proposal: it is retired, the origin is untouched. */
export async function rejectPromotion(ctx: MemoryContext, proposedId: string): Promise<LessonRow> {
  const proposed = await ctx.repo.mustGet(proposedId);
  if (proposed.scope !== "shared" || proposed.status !== "proposed") {
    throw new ForerunnerError("validation", "not a pending promotion", {
      details: { id: proposedId },
    });
  }
  const row = await ctx.repo.update(proposed.id, proposed.version, { status: "retired" });
  await exportRow(ctx.files, row);
  return row;
}

export function pendingPromotions(ctx: MemoryContext): Promise<LessonRow[]> {
  return ctx.repo.list({ scope: "shared", status: "proposed" });
}

export interface ProjectOffer {
  projectId: string;
  sharedTags: string[];
}

export interface ProjectTags {
  id: string;
  tags: string[];
}

/**
 * Projects a promoted lesson is worth offering to: those whose tags overlap with the lesson's,
 * excluding the project it came from. Without an explicit list, a project's tags are derived
 * from the critic and shared lessons recorded about it. `general` alone does not count.
 */
export async function offerToProjects(
  ctx: MemoryContext,
  lessonId: string,
  projects?: ProjectTags[],
): Promise<ProjectOffer[]> {
  const lesson = await ctx.repo.mustGet(lessonId);
  const originId = parseSource(lesson.source).promotion;
  const origin = originId ? await ctx.repo.get(originId) : undefined;
  const exclude = new Set([lesson.project_id, origin?.project_id].filter((p): p is string => !!p));
  const lessonTags = new Set(lesson.tags.filter((t) => t !== GENERAL_TAG));
  let candidates: ProjectTags[];
  if (projects) candidates = projects;
  else {
    const byProject = new Map<string, Set<string>>();
    for (const scope of ["critic", "shared"] as const) {
      for (const r of await ctx.repo.list({ scope, status: "active" })) {
        if (!r.project_id) continue;
        const set = byProject.get(r.project_id) ?? new Set<string>();
        for (const t of r.tags) set.add(t);
        byProject.set(r.project_id, set);
      }
    }
    candidates = [...byProject].map(([id, tags]) => ({ id, tags: [...tags] }));
  }
  const out: ProjectOffer[] = [];
  for (const p of candidates) {
    if (exclude.has(p.id)) continue;
    const sharedTags = [...new Set(p.tags)].filter((t) => lessonTags.has(t)).sort();
    if (sharedTags.length) out.push({ projectId: p.id, sharedTags });
  }
  return out.sort(
    (a, b) => b.sharedTags.length - a.sharedTags.length || a.projectId.localeCompare(b.projectId),
  );
}
