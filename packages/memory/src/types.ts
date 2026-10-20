import type { Clock } from "@forerunner/platform";
import type {
  LessonRepo,
  LessonRow,
  LessonScope,
  LessonStatus,
  ReviewRepo,
} from "@forerunner/state";
import type { Embedder } from "./embedding.ts";
import type { LessonFiles } from "./files.ts";

export type MemoryScope = LessonScope;

/** Fixed render and walk order (ADR 0002): private, critic, shared. */
export const SCOPE_ORDER: readonly MemoryScope[] = ["agent_private", "critic", "shared"];

/** Current lesson file format; bump it when a frontmatter key changes (see migrations.md). */
export const LESSON_FORMAT = 1;

/**
 * One lesson as it exists in its Markdown file. Mirrors the `lesson` row (minus `embedding`
 * and `file_path`, which are index data) plus `flags`, which only the file carries.
 */
export interface LessonDoc {
  id: string;
  scope: MemoryScope;
  owner_agent_id: string | null;
  project_id: string | null;
  text: string;
  source: string;
  tags: string[];
  confidence: number;
  last_used: string | null;
  hit_count: number;
  superseded_by: string | null;
  pinned: boolean;
  status: LessonStatus;
  created_at: string;
  updated_at: string;
  author_agent: string | null;
  author_human: string | null;
  version: number;
  /** `contradiction:<lesson id>` markers set by consolidation; never auto-resolved. */
  flags: string[];
}

/** Everything the memory functions need; built once per runtime by `createMemory`. */
export interface MemoryContext {
  repo: LessonRepo;
  files: LessonFiles;
  embedder: Embedder;
  clock: Clock;
  /** When present, `promote` verifies the approving review exists and accepted. */
  reviews?: ReviewRepo;
}

export type TokenCounter = (text: string) => number;

/** Default budgeting estimate, the same one every provider uses before a call. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function rowToDoc(row: LessonRow, flags: string[] = []): LessonDoc {
  return {
    id: row.id,
    scope: row.scope,
    owner_agent_id: row.owner_agent_id,
    project_id: row.project_id,
    text: row.text,
    source: row.source,
    tags: [...row.tags],
    confidence: row.confidence,
    last_used: row.last_used,
    hit_count: row.hit_count,
    superseded_by: row.superseded_by,
    pinned: row.pinned,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author_agent: row.author_agent,
    author_human: row.author_human,
    version: row.version,
    flags: [...flags],
  };
}
