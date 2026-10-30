import type { EventEmitter } from "node:events";
import { ForerunnerError } from "@forerunner/platform";
import type { ProjectRow, QueueItemRow, StateStore } from "@forerunner/state";
import { Hono } from "hono";
import { EnqueueBody, QUEUE_ITEM_STATUSES, type QueueItemView } from "./api-types.ts";
import { ownsProject, type Who } from "./ownership.ts";

/**
 * The next-session queue (spec J.2; U-004 in docs/status/UPDATE-LOG.md): the project page's
 * "Next session" panel lists, adds and dismisses the daemon's human's items. The runner briefs
 * and consumes the queued ones at the next session start (`store.queue.pending`), the chat's
 * `note` command and an approved intake add to the same rows, and another human's items on a
 * shared project are neither listed nor dismissed here.
 */
export interface QueueRoutesDeps {
  store: Pick<StateStore, "project" | "queue">;
  /** The daemon's human and agent. */
  who: () => Who;
  /** The runtime bus: a change re-reads the project's panels. */
  events: Pick<EventEmitter, "emit">;
}

/** How many items `GET /projects/:id/queue` returns, newest first. */
export const QUEUE_LIST_LIMIT = 200;

export function queueItemView(q: QueueItemRow): QueueItemView {
  return {
    id: q.id,
    projectId: q.project_id,
    humanId: q.human_id,
    kind: q.kind,
    text: q.text,
    priority: q.priority,
    status: q.status,
    consumedBySession: q.consumed_by_session,
    createdAt: q.created_at,
    version: q.version,
  };
}

const forbidden = (message: string) => ({ code: "forbidden", message }) as const;

export function createQueueRoutes(deps: QueueRoutesDeps): Hono {
  const app = new Hono();

  const projectOf = async (id: string): Promise<ProjectRow> => deps.store.project.mustGet(id);

  app.get("/projects/:id/queue", async (c) => {
    const project = await projectOf(c.req.param("id"));
    if (!ownsProject(project, deps.who())) return c.json(forbidden("not your project"), 403);
    const status = c.req.query("status");
    if (status && !(QUEUE_ITEM_STATUSES as readonly string[]).includes(status)) {
      throw new ForerunnerError(
        "validation",
        `status must be one of ${QUEUE_ITEM_STATUSES.join(", ")}`,
        {
          details: { reason: "bad_query" },
        },
      );
    }
    const rows = await deps.store.queue.list(
      {
        project_id: project.id,
        human_id: deps.who().humanId,
        ...(status ? { status } : {}),
      } as never,
      {
        limit: QUEUE_LIST_LIMIT,
        orderBy: [{ column: "created_at", direction: "desc" }, { column: "id" }],
      },
    );
    return c.json(rows.map(queueItemView) satisfies QueueItemView[]);
  });

  app.post("/projects/:id/queue", async (c) => {
    const project = await projectOf(c.req.param("id"));
    if (!ownsProject(project, deps.who())) return c.json(forbidden("not your project"), 403);
    const parsed = EnqueueBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new ForerunnerError(
        "validation",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
    const { humanId } = deps.who();
    const row = await deps.store.queue.enqueue({
      project_id: project.id,
      human_id: humanId,
      kind: parsed.data.kind,
      text: parsed.data.text,
      priority: parsed.data.priority,
      status: "queued",
      author_human: humanId,
    });
    deps.events.emit("project", { id: project.id });
    return c.json(queueItemView(row), 201);
  });

  app.post("/queue/:id/dismiss", async (c) => {
    const item = await deps.store.queue.mustGet(c.req.param("id"));
    if (item.human_id !== deps.who().humanId) return c.json(forbidden("not your note"), 403);
    if (item.status !== "queued") {
      throw new ForerunnerError("validation", `the item is ${item.status}, not queued`);
    }
    const row = await deps.store.queue.dismiss(item.id, item.version);
    deps.events.emit("project", { id: item.project_id });
    return c.json(queueItemView(row));
  });

  return app;
}
