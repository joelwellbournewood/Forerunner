import { ForerunnerError, normalizeNewlines } from "@forerunner/platform";
import { type LessonRow, type LessonStatus, monotonicId } from "@forerunner/state";
import { z } from "zod";
import { cosine } from "./embedding.ts";
import {
  citedLessonIds,
  exportRow,
  lintLesson,
  mirrorRow,
  TAG_PATTERN,
  TEXT_MAX,
  TEXT_MIN,
} from "./files.ts";
import { polarityConflict } from "./polarity.ts";
import type { LessonDoc, MemoryContext, MemoryScope } from "./types.ts";

/** Two lessons at least this similar are the same lesson; `remember` merges instead of inserting. */
export const NEAR_DUPLICATE = 0.92;

/**
 * `source` grammar: `kind:id` pairs separated by `;`. Kinds: session, review, human, promotion,
 * consolidation, approved_by (a review id, set by `promote`). Empty means unknown origin.
 */
export const SOURCE_PATTERN = /^(?:[a-z_]+:[^\s;]+(?:;[a-z_]+:[^\s;]+)*)?$/;

export function parseSource(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source) return out;
  for (const part of source.split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function formatSource(parts: Record<string, string>): string {
  return Object.entries(parts)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

const rememberSchema = z.object({
  scope: z.enum(["agent_private", "critic", "shared"]),
  text: z
    .string()
    .transform((s) => normalizeNewlines(s).trim())
    .pipe(z.string().min(TEXT_MIN).max(TEXT_MAX)),
  tags: z
    .array(z.string().regex(TAG_PATTERN, "tags are lowercase kebab-case"))
    .max(16)
    .default([])
    .transform((t) => [...new Set(t)].sort()),
  source: z.string().regex(SOURCE_PATTERN, "source is kind:id[;kind:id]").default(""),
  confidence: z.number().min(0).max(1).default(0.5),
  projectId: z.string().min(1).nullable().optional(),
  ownerAgentId: z.string().min(1).optional(),
  /**
   * The acting agent. When given, a private lesson may only be written into this agent's own
   * memory (`ownerAgentId` must equal it). `MemoryService` always passes it; a direct caller
   * that leaves it out is trusted to pass the right owner.
   */
  agentId: z.string().min(1).optional(),
  authorAgent: z.string().min(1).nullable().optional(),
  authorHuman: z.string().min(1).nullable().optional(),
  pinned: z.boolean().default(false),
  status: z.enum(["active", "proposed"]).default("active"),
});

export type RememberInput = z.input<typeof rememberSchema>;

export interface RememberResult {
  lesson: LessonRow;
  filePath: string;
  /** `inserted`, or `merged` when a near-duplicate was superseded by this text. */
  action: "inserted" | "merged";
  supersededId?: string;
  similarity?: number;
}

export interface RememberOptions {
  /** Skip the near-duplicate merge (promotion copies use this). Default false. */
  noDedup?: boolean;
  nearDuplicate?: number;
}

/**
 * Private lesson ids cited in `text`. A critic or shared lesson may never name one (ADR 0002:
 * shared content never references private content); only ids that resolve to a private row on
 * this machine can be known, so those are the ones refused.
 */
export async function privateReferences(ctx: MemoryContext, text: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of citedLessonIds(text)) {
    const row = await ctx.repo.get(id);
    if (row?.scope === "agent_private") out.push(id);
  }
  return out;
}

/**
 * Validate, dedup against near-duplicates in the same scope, write file then row (the file
 * is canonical; a crash in between is healed by `reconcile`).
 */
export async function remember(
  ctx: MemoryContext,
  input: RememberInput,
  opts: RememberOptions = {},
): Promise<RememberResult> {
  const parsed = rememberSchema.safeParse(input);
  if (!parsed.success) {
    throw new ForerunnerError("validation", `invalid lesson: ${parsed.error.issues[0]?.message}`, {
      details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
    });
  }
  const v = parsed.data;
  if (v.scope === "agent_private" && !v.ownerAgentId) {
    throw new ForerunnerError("validation", "agent_private lessons need ownerAgentId");
  }
  if (v.scope !== "agent_private" && v.ownerAgentId) {
    throw new ForerunnerError("validation", `${v.scope} lessons cannot have an owner agent`);
  }
  if (v.scope === "agent_private" && v.agentId && v.agentId !== v.ownerAgentId) {
    throw new ForerunnerError(
      "autonomy_insufficient",
      `agent ${v.agentId} may not write into the private memory of ${v.ownerAgentId}`,
      { details: { agentId: v.agentId, ownerAgentId: v.ownerAgentId } },
    );
  }
  const ownerAgentId = v.scope === "agent_private" ? (v.ownerAgentId as string) : null;
  const projectId = v.projectId ?? null;
  const now = ctx.clock.nowIso();
  const draft: LessonDoc = {
    id: monotonicId(ctx.clock.now()),
    scope: v.scope as MemoryScope,
    owner_agent_id: ownerAgentId,
    project_id: projectId,
    text: v.text,
    source: v.source,
    tags: v.tags,
    confidence: v.confidence,
    last_used: null,
    hit_count: 0,
    superseded_by: null,
    pinned: v.pinned,
    status: v.status as LessonStatus,
    created_at: now,
    updated_at: now,
    author_agent: v.authorAgent ?? null,
    author_human: v.authorHuman ?? null,
    version: 1,
    flags: [],
  };
  const problems = lintLesson(draft);
  if (problems.length) {
    throw new ForerunnerError("validation", `lesson fails lint: ${problems.join("; ")}`, {
      details: { problems },
    });
  }
  if (draft.scope !== "agent_private") {
    const leaked = await privateReferences(ctx, draft.text);
    if (leaked.length) {
      throw new ForerunnerError(
        "validation",
        `a ${draft.scope} lesson must not cite a private lesson id (${leaked.join(", ")})`,
        { details: { scope: draft.scope, privateIds: leaked } },
      );
    }
  }

  const vector = ctx.embedder.embed(draft.text);
  if (!opts.noDedup) {
    const threshold = opts.nearDuplicate ?? NEAR_DUPLICATE;
    const existing = await ctx.repo.list(
      draft.scope === "agent_private"
        ? { scope: draft.scope, owner_agent_id: ownerAgentId, status: "active" }
        : { scope: draft.scope, status: "active" },
    );
    let best: { row: LessonRow; sim: number } | null = null;
    for (const row of existing) {
      if (row.superseded_by !== null) continue;
      if (row.project_id !== null && projectId !== null && row.project_id !== projectId) continue;
      // An opposite ("never X" over "always X") is a contradiction for the human, not a rewrite.
      if (polarityConflict(draft.text, row.text)) continue;
      const rv =
        row.embedding && row.embedding.length === ctx.embedder.dims
          ? row.embedding
          : ctx.embedder.embed(row.text);
      const sim = cosine(vector, rv);
      if (sim >= threshold && (!best || sim > best.sim)) best = { row, sim };
    }
    if (best) {
      const old = best.row;
      const next = await ctx.repo.supersede(old.id, {
        text: draft.text,
        tags: [...new Set([...old.tags, ...draft.tags])].sort(),
        confidence: Math.max(old.confidence, draft.confidence),
        source: draft.source || old.source,
        // A merge never narrows visibility: global on either side stays global; otherwise the
        // candidate filter above guarantees both sides name the same project.
        project_id: old.project_id === null || projectId === null ? null : old.project_id,
        hit_count: old.hit_count,
        last_used: old.last_used,
        pinned: old.pinned || draft.pinned,
        status: old.status === "proposed" ? draft.status : old.status,
        embedding: Array.from(vector, (x) => Math.round(x * 1e6) / 1e6),
        author_agent: draft.author_agent ?? old.author_agent,
        author_human: draft.author_human ?? old.author_human,
      });
      const filePath = await exportRow(ctx.files, next, []);
      const withPath = await ctx.repo.patch(next.id, { file_path: filePath });
      await exportRow(ctx.files, withPath, []);
      const retired = await ctx.repo.mustGet(old.id);
      await exportRow(ctx.files, retired);
      return {
        lesson: withPath,
        filePath,
        action: "merged",
        supersededId: old.id,
        similarity: best.sim,
      };
    }
  }

  const filePath = await ctx.files.write(draft);
  const row = await mirrorRow(ctx.repo, draft, filePath, ctx.embedder);
  return { lesson: row, filePath, action: "inserted" };
}
