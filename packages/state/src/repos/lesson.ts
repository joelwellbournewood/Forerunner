import { type Clock, ForerunnerError } from "@forerunner/platform";
import { jsonArrayContains, jsonArrayContainsParam } from "../db/dialect.ts";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { LessonRow, LessonScope, LessonStatus, NewLesson } from "../types.ts";
import { Repository } from "./base.ts";

export interface LessonSearch {
  scope: LessonScope;
  /** Required for agent_private; private lessons of other agents are never returned. */
  ownerAgentId?: string;
  projectId?: string | null;
  /** All tags must be present. */
  tags?: string[];
  /** Case-insensitive substring of the lesson text. */
  text?: string;
  status?: LessonStatus;
  includeSuperseded?: boolean;
  limit?: number;
}

export class LessonRepo extends Repository<LessonRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.lesson as EntityDef, clock);
  }

  override async insert(input: Record<string, unknown>): Promise<LessonRow> {
    if (input.scope === "agent_private" && !input.owner_agent_id) {
      throw new ForerunnerError("validation", "agent_private lessons need owner_agent_id");
    }
    return super.insert(input);
  }

  add(input: NewLesson): Promise<LessonRow> {
    return this.insert(input);
  }

  /**
   * Search within one scope. Private lessons are always filtered by owner, so an agent
   * cannot read another agent's private memory through this API.
   */
  async search(q: LessonSearch): Promise<LessonRow[]> {
    const parts = ['"scope" = ?'];
    const params: unknown[] = [q.scope];
    if (q.scope === "agent_private") {
      if (!q.ownerAgentId) {
        throw new ForerunnerError(
          "validation",
          "ownerAgentId is required to search agent_private lessons",
        );
      }
      parts.push('"owner_agent_id" = ?');
      params.push(q.ownerAgentId);
    } else if (q.ownerAgentId !== undefined) {
      parts.push('"owner_agent_id" = ?');
      params.push(q.ownerAgentId);
    }
    if (q.projectId === null) parts.push('"project_id" IS NULL');
    else if (q.projectId !== undefined) {
      parts.push('"project_id" = ?');
      params.push(q.projectId);
    }
    parts.push('"status" = ?');
    params.push(q.status ?? "active");
    if (!q.includeSuperseded) parts.push('"superseded_by" IS NULL');
    for (const tag of q.tags ?? []) {
      parts.push(jsonArrayContains('"tags"', this.db.dialect));
      params.push(jsonArrayContainsParam(tag, this.db.dialect));
    }
    if (q.text) {
      parts.push('LOWER("text") LIKE ?');
      params.push(`%${q.text.toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    }
    const escapeClause = q.text ? " ESCAPE '\\'" : "";
    const limit = Math.max(0, Math.floor(q.limit ?? 50));
    params.push(limit);
    return this.rows(
      `SELECT * FROM ${this.qt} WHERE ${parts.join(" AND ")}${escapeClause}
        ORDER BY "pinned" DESC, "confidence" DESC, "hit_count" DESC, "created_at" DESC, "id" LIMIT ?`,
      params,
    );
  }

  /** Record a retrieval: hit_count + 1 and last_used = now. */
  async touch(id: string, now: string = this.clock.nowIso()): Promise<LessonRow> {
    const [row] = await this.updateWhere({ last_used: now }, '"id" = ?', [id], {
      set: ['"hit_count" = "hit_count" + 1'],
      params: [],
    });
    if (!row) throw new ForerunnerError("not_found", `lesson ${id} not found`, { details: { id } });
    return row;
  }

  retire(id: string, expectedVersion: number): Promise<LessonRow> {
    return this.update(id, expectedVersion, { status: "retired" });
  }

  /** Replace a lesson with a newer one; the old one is retired and points at the new one. */
  supersede(oldId: string, input: Partial<NewLesson> & { text: string }): Promise<LessonRow> {
    return this.db.transaction(async () => {
      const old = await this.mustGet(oldId);
      const next = await this.insert({
        owner_agent_id: old.owner_agent_id,
        project_id: old.project_id,
        tags: old.tags,
        ...input,
        scope: input.scope ?? old.scope,
      });
      await this.patch(oldId, { superseded_by: next.id, status: "retired" });
      return next;
    });
  }

  setPinned(id: string, expectedVersion: number, pinned: boolean): Promise<LessonRow> {
    return this.update(id, expectedVersion, { pinned });
  }
}
