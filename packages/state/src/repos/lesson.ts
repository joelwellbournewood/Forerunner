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

  /**
   * Private memory never leaves its owner's PC (spec "Source of truth rules", ADR 0002): the
   * Postgres adapter is the shared state in paired and hybrid mode, so it refuses every write
   * that would put an `agent_private` row there, before any statement runs. The runtime keeps
   * private rows in a local SQLite index and routes by scope (`@forerunner/memory`,
   * `ScopedLessonStore`); in solo mode the one local SQLite holds every scope.
   */
  private assertScopeAllowed(scope: unknown, operation: string): void {
    if (scope === "agent_private" && this.db.dialect === "postgres") {
      throw new ForerunnerError(
        "MEMORY_SCOPE_VIOLATION",
        `lesson ${operation}: agent_private rows never enter the shared store`,
        { details: { scope, dialect: this.db.dialect, operation } },
      );
    }
  }

  override async insert(input: Record<string, unknown>): Promise<LessonRow> {
    this.assertScopeAllowed(input.scope, "insert");
    if (input.scope === "agent_private" && !input.owner_agent_id) {
      throw new ForerunnerError("validation", "agent_private lessons need owner_agent_id");
    }
    return super.insert(input);
  }

  /** Every update and patch passes here; a row can never be turned private in a shared store. */
  override async updateWhere(
    patch: Partial<LessonRow>,
    whereSql: string,
    whereParams: unknown[],
    extra: { set: string[]; params: unknown[] } = { set: [], params: [] },
  ): Promise<LessonRow[]> {
    this.assertScopeAllowed(patch.scope, "update");
    return super.updateWhere(patch, whereSql, whereParams, extra);
  }

  add(input: NewLesson): Promise<LessonRow> {
    return this.insert(input);
  }

  /**
   * Set the envelope columns the generic writes manage themselves. The file is canonical for a
   * lesson (ADR 0002): mirroring one into the index must reproduce its version and timestamps.
   */
  async overwriteEnvelope(
    id: string,
    envelope: { version: number; updated_at: string; created_at: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE ${this.qt} SET "version" = ?, "updated_at" = ?, "created_at" = ? WHERE "id" = ?`,
      [envelope.version, envelope.updated_at, envelope.created_at, id],
    );
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
