import type { ReviewRow, TaskRow } from "@forerunner/state";
import { z } from "zod";
import { type Principal, requireScope, requireSigned } from "../auth/principal.ts";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { type App, announce, intParam, parseBody, principal, type RouteContext } from "../http.ts";
import { reviewView } from "../views.ts";
import { answerRequestAs, sendMessageAs } from "./inbox.ts";

const CommentBody = z.object({
  body: z.string().min(1).max(20_000),
  /** Agent the human speaks through; defaults to the human's first principal agent. */
  fromAgentId: z.string().optional(),
});

const VerdictBody = CommentBody.partial({ body: true }).extend({
  /** Version of the open approval request, when the client has it (409 on mismatch). */
  requestVersion: z.number().int().optional(),
});

async function senderAgent(
  ctx: RouteContext,
  p: Principal,
  requested: string | undefined,
): Promise<string> {
  if (requested) {
    const agent = await ctx.store.agent.get(requested);
    if (!agent) throw notFound("agent", requested);
    if (p.kind === "device" && agent.owner_human_id !== p.humanId)
      throw forbidden("not your agent");
    return agent.id;
  }
  if (p.kind !== "device") throw new ApiError(400, "validation", "fromAgentId is required");
  const [principalAgent] = await ctx.store.agent.principals(p.humanId);
  if (!principalAgent) throw new ApiError(400, "validation", "no principal agent for this human");
  return principalAgent.id;
}

/** Who should hear about a review verdict: the task's owner, else its claimant, else the review's session agent. */
async function recipient(ctx: RouteContext, review: ReviewRow, task: TaskRow | undefined) {
  if (task?.owner_agent_id) return { toAgentId: task.owner_agent_id };
  if (task?.claimed_by) return { toAgentId: task.claimed_by };
  if (review.session_id) {
    const session = await ctx.store.session.get(review.session_id);
    if (session) return { toAgentId: session.agent_id };
  }
  return undefined;
}

async function loadReview(ctx: RouteContext, id: string) {
  const review = await ctx.store.review.get(id);
  if (!review) throw notFound("review", id);
  const task = review.task_id ? await ctx.store.task.get(review.task_id) : undefined;
  const findings = await ctx.store.finding.forReview(review.id);
  return { review, task, findings };
}

/**
 * Critic reviews and findings for PR review on the phone (spec R.5). A comment becomes a
 * message to the responsible agent; approve / reject also answers the task's open approval
 * request (kind "approval") so the waiting session continues.
 */
export function registerReviewRoutes(app: App, ctx: RouteContext): void {
  app.get("/reviews", async (c) => {
    requireScope(principal(c), "read");
    const taskId = c.req.query("taskId");
    const projectId = c.req.query("projectId");
    const limit = intParam(c.req.query("limit"), 50);
    let rows: ReviewRow[];
    if (taskId) rows = await ctx.store.review.forTask(taskId, { limit });
    else if (projectId) {
      rows = await ctx.store.review.rows(
        `SELECT r.* FROM "review" r JOIN "task" t ON t."id" = r."task_id"
          WHERE t."project_id" = ? ORDER BY r."created_at" DESC, r."id" DESC LIMIT ?`,
        [projectId, limit],
      );
    } else rows = await ctx.store.review.list(undefined, { orderBy: "created_at desc", limit });
    const views = [];
    for (const r of rows) {
      const task = r.task_id ? await ctx.store.task.get(r.task_id) : undefined;
      views.push(reviewView(r, task, await ctx.store.finding.forReview(r.id)));
    }
    return c.json({ reviews: views });
  });

  app.get("/reviews/:id", async (c) => {
    requireScope(principal(c), "read");
    const { review, task, findings } = await loadReview(ctx, c.req.param("id"));
    return c.json(reviewView(review, task, findings));
  });

  app.post("/reviews/:id/comment", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:approvals");
    const body = await parseBody(c, CommentBody);
    const { review, task } = await loadReview(ctx, c.req.param("id"));
    const to = await recipient(ctx, review, task);
    const fromAgentId = await senderAgent(ctx, p, body.fromAgentId);
    const message = await sendMessageAs(ctx, p, {
      fromAgentId,
      ...(to ?? { toHumanId: p.humanId ?? undefined }),
      projectId: task?.project_id,
      taskId: task?.id,
      type: "info",
      body: `Review comment on ${task ? `"${task.title}"` : review.id}:\n\n${body.body}`,
      requiresAck: false,
    });
    return c.json({ messageId: message.id }, 201);
  });

  for (const verdict of ["approve", "reject"] as const) {
    app.post(`/reviews/:id/${verdict}`, async (c) => {
      const p = principal(c);
      requireSigned(p);
      requireScope(p, "write:approvals");
      const body = await parseBody(c, VerdictBody);
      const { review, task } = await loadReview(ctx, c.req.param("id"));
      const to = await recipient(ctx, review, task);
      const fromAgentId = await senderAgent(ctx, p, body.fromAgentId);
      const comment = body.body ? `\n\n${body.body}` : "";
      const message = await sendMessageAs(ctx, p, {
        fromAgentId,
        ...(to ?? { toHumanId: p.humanId ?? undefined }),
        projectId: task?.project_id,
        taskId: task?.id,
        type: "decision",
        body: `${verdict === "approve" ? "Approved" : "Rejected"} review ${review.id}${task ? ` of "${task.title}"` : ""} (grade ${review.grade}, verdict ${review.verdict}).${comment}`,
        requiresAck: true,
      });
      // Answer the open approval request on the task, when there is one.
      let answeredRequestId: string | null = null;
      if (task) {
        const open = await ctx.store.humanRequest.open({ projectId: task.project_id });
        const request = open.find((r) => r.task_id === task.id && r.kind === "approval");
        if (request) {
          const answered = await answerRequestAs(
            ctx,
            p,
            request.id,
            body.requestVersion ?? request.version,
            {
              decision: verdict,
              comment: body.body ?? "",
              reviewId: review.id,
            },
          );
          answeredRequestId = answered.id;
        }
      }
      announce(ctx, "review.changed", "review", review, {
        projectId: task?.project_id ?? null,
        payload: { verdictFromHuman: verdict },
      });
      return c.json({ messageId: message.id, answeredRequestId });
    });
  }
}
