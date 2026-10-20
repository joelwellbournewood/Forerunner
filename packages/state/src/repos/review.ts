import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { FindingRow, ReviewRow } from "../types.ts";
import { type ListOptions, Repository } from "./base.ts";

export class ReviewRepo extends Repository<ReviewRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.review as EntityDef, clock);
  }

  forTask(taskId: string, opts: ListOptions = {}): Promise<ReviewRow[]> {
    return this.list({ task_id: taskId }, { orderBy: "created_at desc", ...opts });
  }

  forSession(sessionId: string, opts: ListOptions = {}): Promise<ReviewRow[]> {
    return this.list({ session_id: sessionId }, { orderBy: "created_at desc", ...opts });
  }

  async latestForTask(taskId: string): Promise<ReviewRow | undefined> {
    const [row] = await this.forTask(taskId, { limit: 1 });
    return row;
  }
}

export interface PatternStats {
  fingerprint: string;
  /** Findings with this fingerprint. */
  total: number;
  /** Distinct sessions (through the review) they appeared in. */
  sessions: number;
  /** Distinct tasks they appeared on. */
  tasks: number;
}

export class FindingRepo extends Repository<FindingRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.finding as EntityDef, clock);
  }

  /** Open findings of a task; non-empty blocks close. */
  openFor(taskId: string): Promise<FindingRow[]> {
    return this.list({ task_id: taskId, status: "open" });
  }

  forReview(reviewId: string): Promise<FindingRow[]> {
    return this.list({ review_id: reviewId });
  }

  resolve(id: string, expectedVersion: number, runId: string | null): Promise<FindingRow> {
    return this.update(id, expectedVersion, { status: "resolved", resolved_by_run: runId });
  }

  wontfix(id: string, expectedVersion: number): Promise<FindingRow> {
    return this.update(id, expectedVersion, { status: "wontfix" });
  }

  /** How often a fingerprint repeated, across sessions and tasks. */
  async patterns(fingerprint: string): Promise<PatternStats> {
    const [row] = await this.db.query<{ total: unknown; sessions: unknown; tasks: unknown }>(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT r."session_id") AS sessions,
              COUNT(DISTINCT f."task_id") AS tasks
         FROM "finding" f JOIN "review" r ON r."id" = f."review_id"
        WHERE f."fingerprint" = ?`,
      [fingerprint],
    );
    return {
      fingerprint,
      total: Number(row?.total ?? 0),
      sessions: Number(row?.sessions ?? 0),
      tasks: Number(row?.tasks ?? 0),
    };
  }

  /** Fingerprints seen in at least `minSessions` distinct sessions. */
  async repeated(minSessions = 2): Promise<PatternStats[]> {
    const rows = await this.db.query<{
      fingerprint: string;
      total: unknown;
      sessions: unknown;
      tasks: unknown;
    }>(
      `SELECT f."fingerprint" AS fingerprint, COUNT(*) AS total,
              COUNT(DISTINCT r."session_id") AS sessions, COUNT(DISTINCT f."task_id") AS tasks
         FROM "finding" f JOIN "review" r ON r."id" = f."review_id"
        WHERE f."fingerprint" <> ''
        GROUP BY f."fingerprint"
       HAVING COUNT(DISTINCT r."session_id") >= ?
        ORDER BY COUNT(*) DESC, f."fingerprint"`,
      [minSessions],
    );
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      total: Number(r.total),
      sessions: Number(r.sessions),
      tasks: Number(r.tasks),
    }));
  }
}
