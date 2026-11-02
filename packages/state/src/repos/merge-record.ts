import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { MergeRecordRow, MergeRecordState, NewMergeRecord } from "../types.ts";
import { assertTransition, MERGE_RECORD_TRANSITIONS } from "../workflow.ts";
import { Repository } from "./base.ts";

/**
 * The merge of a task's reviewed pull request (ADR 0111). One row per task, written when the
 * critic accepts the task (`pin`), before anything else happens to the branch: from then on
 * every merge of that pull request is pinned to `reviewed_head_sha`, never to whatever the
 * worktree or the host holds later. The row says where the merge is (`state`, its graph in
 * `MERGE_RECORD_TRANSITIONS`) and, whenever it waits for the person, why (`sentence`).
 * `agent_id` is the install's agent that owns it: on a shared store only that agent's daemon
 * retries it.
 */
export class MergeRecordRepo extends Repository<MergeRecordRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.merge_record as EntityDef, clock);
  }

  async forTask(taskId: string): Promise<MergeRecordRow | undefined> {
    const [row] = await this.list({ task_id: taskId }, { limit: 1 });
    return row;
  }

  /**
   * Pin the reviewed commit at an accept. A task accepted again (after a rework) moves its
   * record to the new reviewed commit and queues it; a merged one stays as it is.
   */
  async pin(
    input: NewMergeRecord & Pick<Partial<MergeRecordRow>, "reviewed_base_sha" | "own_change_id">,
  ): Promise<MergeRecordRow> {
    const current = await this.forTask(input.task_id);
    if (!current) return this.insert({ ...input, state: "queued" });
    if (current.state === "merged") return current;
    if (current.state !== "queued")
      assertTransition(MERGE_RECORD_TRANSITIONS, "merge_record", current.state, "queued");
    return this.patch(current.id, {
      agent_id: input.agent_id,
      project_id: input.project_id ?? current.project_id,
      pr_number: input.pr_number,
      pr_url: input.pr_url,
      reviewed_head_sha: input.reviewed_head_sha,
      reviewed_base_sha: input.reviewed_base_sha ?? null,
      own_change_id: input.own_change_id ?? null,
      state: "queued",
      approval: "none",
      approved_by: null,
      sentence: "",
      last_outcome: null,
      author_agent: input.author_agent ?? input.agent_id,
    });
  }

  /** Move the record (the graph decides which moves are legal) and write what goes with it. */
  async move(
    id: string,
    to: MergeRecordState,
    patch: Partial<Omit<MergeRecordRow, "state">> = {},
  ): Promise<MergeRecordRow> {
    const current = await this.mustGet(id);
    if (current.state !== to)
      assertTransition(MERGE_RECORD_TRANSITIONS, "merge_record", current.state, to);
    return this.patch(id, { ...patch, state: to });
  }

  /**
   * Take the record for one attempt: `merging`, one more attempt, only if nobody moved it
   * since it was read (`expectedVersion`). Null when another process took it first, so two
   * daemons on one shared store never merge the same pull request twice.
   */
  async claim(row: MergeRecordRow): Promise<MergeRecordRow | null> {
    if (row.state !== "merging")
      assertTransition(MERGE_RECORD_TRANSITIONS, "merge_record", row.state, "merging");
    try {
      return await this.update(row.id, row.version, {
        state: "merging",
        attempts: row.attempts + 1,
      });
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "version_conflict") return null;
      throw e;
    }
  }

  /** The records of `agentId` in these states, oldest first. */
  forAgent(agentId: string, states: readonly MergeRecordState[]): Promise<MergeRecordRow[]> {
    return this.list(
      { agent_id: agentId, state: [...states] },
      { orderBy: "created_at asc", limit: 500 },
    );
  }
}
