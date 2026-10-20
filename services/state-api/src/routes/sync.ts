import { type JsonValue, REMOTE_TARGETS, TASK_STATUSES } from "@forerunner/state";
import { z } from "zod";
import { type Principal, requireScope, requireSigned } from "../auth/principal.ts";
import { ApiError, toApiError } from "../errors.ts";
import { type App, announce, parseBody, principal, type RouteContext } from "../http.ts";
import {
  idempotencyKeyOf,
  OUTBOX_ACTION_KINDS,
  OUTBOX_BATCH_MAX,
  type OutboxAction,
  type OutboxResult,
} from "../outbox.ts";
import { answerRequestAs, applyReceipt, sendMessageAs } from "./inbox.ts";
import {
  commandFingerprint,
  enqueueRemoteCommand,
  REMOTE_COMMANDS,
  remoteEnqueueResult,
} from "./remote.ts";

export { idempotencyKeyOf };

const ActionSchema = z.object({
  clientId: z.string().min(8).max(128),
  kind: z.enum(OUTBOX_ACTION_KINDS),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const BatchBody = z.object({ actions: z.array(ActionSchema).min(1).max(OUTBOX_BATCH_MAX) });

const payloads = {
  "message.send": z.object({
    fromAgentId: z.string().min(1),
    toAgentId: z.string().optional(),
    toHumanId: z.string().optional(),
    projectId: z.string().optional(),
    taskId: z.string().optional(),
    type: z.enum(["info", "question", "request", "warning", "decision", "handoff"]).default("info"),
    body: z.string().min(1).max(20_000),
    requiresAck: z.boolean().default(false),
    replyTo: z.string().optional(),
  }),
  "message.receipt": z.object({
    id: z.string().min(1),
    state: z.enum(["delivered", "read", "acted"]),
  }),
  "request.answer": z.object({
    id: z.string().min(1),
    version: z.number().int(),
    answer: z.unknown(),
  }),
  "queue.enqueue": z.object({
    projectId: z.string().min(1),
    kind: z.enum(["note", "task", "idea", "correction", "voice_note"]).default("note"),
    text: z.string().min(1).max(10_000),
    priority: z.number().int().min(-10).max(10).default(0),
  }),
  "remote.enqueue": z.object({
    target: z.enum(REMOTE_TARGETS),
    targetDeviceId: z.string().optional(),
    command: z.enum(REMOTE_COMMANDS),
    params: z.record(z.string(), z.unknown()).default({}),
    deviceId: z.string().optional(),
  }),
  "task.transition": z.object({
    id: z.string().min(1),
    version: z.number().int(),
    to: z.enum(TASK_STATUSES),
    reason: z.string().min(1).max(2000),
  }),
  "decision.record": z.object({
    projectId: z.string().min(1),
    question: z.string().min(1).max(2000),
    options: z.array(z.unknown()).default([]),
    chosen: z.string().min(1).max(2000),
    rationale: z.string().max(4000).default(""),
  }),
} as const;

function parsePayload<K extends keyof typeof payloads>(
  kind: K,
  raw: unknown,
): z.infer<(typeof payloads)[K]> {
  const result = payloads[kind].safeParse(raw);
  if (!result.success) {
    throw new ApiError(400, "validation", `invalid payload for ${kind}`, {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data as z.infer<(typeof payloads)[K]>;
}

/** Apply one queued action with the same checks as the direct route. */
export async function applyOutboxAction(
  ctx: RouteContext,
  p: Principal,
  action: OutboxAction,
): Promise<unknown> {
  switch (action.kind) {
    case "message.send": {
      requireScope(p, "write:inbox");
      const row = await sendMessageAs(ctx, p, parsePayload("message.send", action.payload));
      return { id: row.id, version: row.version };
    }
    case "message.receipt": {
      requireScope(p, "write:inbox");
      const body = parsePayload("message.receipt", action.payload);
      const row = await applyReceipt(ctx, p, body.id, body.state);
      return { id: row.id, version: row.version };
    }
    case "request.answer": {
      requireScope(p, "write:approvals");
      const body = parsePayload("request.answer", action.payload);
      const row = await answerRequestAs(ctx, p, body.id, body.version, body.answer);
      return { id: row.id, version: row.version };
    }
    case "queue.enqueue": {
      requireScope(p, "write:queue");
      const body = parsePayload("queue.enqueue", action.payload);
      if (p.kind !== "device")
        throw new ApiError(400, "validation", "queue.enqueue is a device action");
      const row = await ctx.store.queue.enqueue({
        project_id: body.projectId,
        human_id: p.humanId,
        kind: body.kind,
        text: body.text,
        priority: body.priority,
        author_human: p.humanId,
      });
      announce(ctx, "queue_item.changed", "queue_item", row, {
        humanId: p.humanId,
        projectId: body.projectId,
        payload: { status: row.status },
      });
      return { id: row.id, version: row.version };
    }
    case "remote.enqueue": {
      requireScope(p, "write:remote");
      const body = parsePayload("remote.enqueue", action.payload);
      const row = await enqueueRemoteCommand(ctx, p, body);
      // The same record `POST /remote/commands` keeps: a later direct POST under this
      // clientId reads the row back (same body) or is refused (different body).
      return remoteEnqueueResult(row, commandFingerprint(body));
    }
    case "task.transition": {
      requireScope(p, "write:approvals");
      const body = parsePayload("task.transition", action.payload);
      const row = await ctx.store.task.transition(body.id, body.version, body.to, body.reason, {
        humanId: p.humanId,
      });
      announce(ctx, "task.changed", "task", row, {
        projectId: row.project_id,
        payload: { status: row.status, claimedBy: row.claimed_by },
      });
      return { id: row.id, version: row.version, status: row.status };
    }
    case "decision.record": {
      requireScope(p, "write:approvals");
      const body = parsePayload("decision.record", action.payload);
      const row = await ctx.store.decision.record({
        project_id: body.projectId,
        question: body.question,
        options: body.options as JsonValue[],
        chosen: body.chosen,
        decided_by: p.humanId ?? "runtime",
        rationale: body.rationale,
        author_human: p.humanId,
      });
      announce(ctx, "decision.changed", "decision", row, { projectId: body.projectId });
      return { id: row.id, version: row.version };
    }
  }
}

/**
 * POST /sync/outbox: the service side of the offline queue. Actions are applied in order;
 * a 4xx outcome is reported per action (the client drops it), a repeated clientId is
 * acknowledged without being applied again.
 */
export function registerSyncRoutes(app: App, ctx: RouteContext): void {
  app.post("/sync/outbox", async (c) => {
    const p = principal(c);
    requireSigned(p);
    const body = await parseBody(c, BatchBody);
    const deviceKey = idempotencyKeyOf(p);
    const results: OutboxResult[] = [];
    for (const action of body.actions) {
      // The key is reserved before the action runs: a second batch carrying the same
      // clientId while this one is in flight waits for this result instead of applying again.
      const { result, fresh } = await ctx.idempotency.run(deviceKey, action.clientId, async () => {
        try {
          const applied = await applyOutboxAction(ctx, p, action);
          return { clientId: action.clientId, status: "applied", result: applied };
        } catch (e) {
          const err = toApiError(e);
          if (err.status >= 500) throw err;
          return {
            clientId: action.clientId,
            status: "rejected",
            code: err.code,
            message: err.message,
          };
        }
      });
      results.push(
        fresh || result.status === "rejected" ? result : { ...result, status: "duplicate" },
      );
    }
    return c.json({ results });
  });
}
