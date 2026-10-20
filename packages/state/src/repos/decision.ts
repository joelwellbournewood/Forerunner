import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { DecisionRow, NewDecision } from "../types.ts";
import { Repository } from "./base.ts";

/** Case- and whitespace-insensitive key for a question; trailing punctuation is dropped. */
export function normaliseQuestion(question: string): string {
  return question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?!.:;]+$/u, "");
}

export class DecisionRepo extends Repository<DecisionRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.decision as EntityDef, clock);
  }

  override insert(input: Record<string, unknown>): Promise<DecisionRow> {
    const question = typeof input.question === "string" ? input.question : "";
    return super.insert({ ...input, question_normalised: normaliseQuestion(question) });
  }

  record(input: NewDecision): Promise<DecisionRow> {
    return this.insert(input);
  }

  /** The current (not superseded) answer to a question in a project, if any. */
  async findAnswered(projectId: string, question: string): Promise<DecisionRow | undefined> {
    const [row] = await this.rows(
      `SELECT * FROM ${this.qt}
        WHERE "project_id" = ? AND "question_normalised" = ? AND "superseded_by" IS NULL
        ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
      [projectId, normaliseQuestion(question)],
    );
    return row;
  }

  /** Record a new decision that replaces an older one. */
  supersede(oldId: string, input: NewDecision): Promise<DecisionRow> {
    return this.db.transaction(async () => {
      const old = await this.mustGet(oldId);
      const next = await this.insert({
        ...input,
        project_id: input.project_id ?? old.project_id,
        supersedes: oldId,
      });
      await this.patch(oldId, { superseded_by: next.id });
      return next;
    });
  }

  current(projectId: string): Promise<DecisionRow[]> {
    return this.list({ project_id: projectId, superseded_by: null });
  }
}
