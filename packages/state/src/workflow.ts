import { ForerunnerError } from "@forerunner/platform";
import type {
  HumanRequestStatus,
  QueueStatus,
  ReleaseStatus,
  RemoteCommandStatus,
  SessionStatus,
  TaskStatus,
} from "./types.ts";

/**
 * Status graphs. Each maps a status to the statuses it may move to. Repositories enforce
 * them with assertTransition(); the generated data-model doc renders them.
 */
export type Graph<S extends string> = Readonly<Record<S, readonly S[]>>;

/** Active task states: a claim can exist and side exits apply. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "ready",
  "claimed",
  "in_progress",
  "in_review",
];

/**
 * draft -> ready -> claimed -> in_progress -> in_review -> done.
 * Side exits needs_human / failed / cancelled from any active state; needs_human -> ready
 * and failed -> ready retry; in_review -> in_progress is the critic's "revise" verdict;
 * claimed -> ready is a released claim.
 */
export const TASK_TRANSITIONS: Graph<TaskStatus> = {
  draft: ["ready", "cancelled"],
  ready: ["claimed", "needs_human", "failed", "cancelled"],
  claimed: ["in_progress", "ready", "needs_human", "failed", "cancelled"],
  in_progress: ["in_review", "needs_human", "failed", "cancelled"],
  in_review: ["done", "in_progress", "needs_human", "failed", "cancelled"],
  needs_human: ["ready", "cancelled"],
  failed: ["ready", "cancelled"],
  done: [],
  cancelled: [],
};

export const SESSION_TRANSITIONS: Graph<SessionStatus> = {
  planned: ["running", "stopped", "killed"],
  running: ["paused", "stopped", "completed", "failed", "killed"],
  paused: ["running", "stopped", "killed"],
  stopped: [],
  completed: [],
  failed: [],
  killed: [],
};

export const HUMAN_REQUEST_TRANSITIONS: Graph<HumanRequestStatus> = {
  open: ["answered", "expired", "withdrawn"],
  answered: [],
  expired: [],
  withdrawn: [],
};

export const REMOTE_COMMAND_TRANSITIONS: Graph<RemoteCommandStatus> = {
  pending: ["picked_up", "failed"],
  picked_up: ["done", "failed"],
  done: [],
  failed: [],
};

export const QUEUE_ITEM_TRANSITIONS: Graph<QueueStatus> = {
  queued: ["consumed", "dismissed"],
  consumed: [],
  dismissed: [],
};

export const RELEASE_TRANSITIONS: Graph<ReleaseStatus> = {
  draft: ["published", "failed"],
  published: ["installed", "rolled_back", "failed"],
  installed: ["rolled_back"],
  rolled_back: [],
  failed: [],
};

/** Every graph, keyed by "<table>.<column>", for the generated doc. */
export const STATUS_GRAPHS: Readonly<Record<string, Graph<string>>> = {
  "task.status": TASK_TRANSITIONS,
  "session.status": SESSION_TRANSITIONS,
  "human_request.status": HUMAN_REQUEST_TRANSITIONS,
  "remote_command.status": REMOTE_COMMAND_TRANSITIONS,
  "queue_item.status": QUEUE_ITEM_TRANSITIONS,
  "release.status": RELEASE_TRANSITIONS,
};

export function canTransition<S extends string>(graph: Graph<S>, from: S, to: S): boolean {
  return (graph[from] ?? []).includes(to);
}

/** Throws ForerunnerError("validation") with details {entity, from, to} when the move is illegal. */
export function assertTransition<S extends string>(
  graph: Graph<S>,
  entity: string,
  from: S,
  to: S,
): void {
  if (!canTransition(graph, from, to)) {
    throw new ForerunnerError("validation", `${entity}: illegal transition ${from} -> ${to}`, {
      details: { entity, from, to, allowed: [...(graph[from] ?? [])] },
    });
  }
}
