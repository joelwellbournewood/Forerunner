import { applySharedGrantAnswer } from "@forerunner/runtime/secrets/shared-grants";
import { assertAnswerAccepted } from "@forerunner/runtime/wiring/request-answers";
import { DecisionLog } from "@forerunner/runtime/wiring/state-ports";
import type { HumanRequestRow, MessageRow } from "@forerunner/state";
import { MESSAGE_TYPES } from "@forerunner/state";
import { z } from "zod";
import { type Principal, requireScope, requireSigned, resolveHumanId } from "../auth/principal.ts";
import { ApiError, forbidden, notFound } from "../errors.ts";
import {
  type App,
  agentName,
  announce,
  intParam,
  parseBody,
  principal,
  type RouteContext,
} from "../http.ts";
import { humanRequestView, messageView } from "../views.ts";

const SendMessageBody = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().optional(),
  toHumanId: z.string().optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  type: z.enum(MESSAGE_TYPES).default("info"),
  body: z.string().min(1).max(20_000),
  requiresAck: z.boolean().default(false),
  replyTo: z.string().optional(),
});

const ReceiptBody = z.object({ state: z.enum(["delivered", "read", "acted"]) });
const AnswerBody = z.object({ version: z.number().int(), answer: z.unknown() });

/** The human a message concerns: its human addressee, else the owner of its agent addressee. */
export async function messageHuman(ctx: RouteContext, m: MessageRow): Promise<string | null> {
  if (m.to_human_id) return m.to_human_id;
  if (m.to_agent_id) {
    const agent = await ctx.store.agent.get(m.to_agent_id);
    return agent?.owner_human_id ?? null;
  }
  return null;
}

/** A device may read messages addressed to its human or to its human's agents, and those its human's agents sent. */
async function assertCanSee(ctx: RouteContext, p: Principal, m: MessageRow): Promise<void> {
  if (p.kind === "admin") return;
  const human = await messageHuman(ctx, m);
  if (human !== p.humanId) {
    const from = await ctx.store.agent.get(m.from_agent_id);
    if (from?.owner_human_id !== p.humanId) throw forbidden("not your message");
  }
}

/**
 * Receipts come from the addressee only (spec F.2: delivered, read, acted on are the
 * receiver's facts). The sender's device may read its message but never acknowledge it, or
 * a `requires_ack` handoff could be self-acknowledged and vanish from the other inbox.
 */
async function assertAddressee(ctx: RouteContext, p: Principal, m: MessageRow): Promise<void> {
  if (p.kind === "admin") return;
  const human = await messageHuman(ctx, m);
  if (human !== p.humanId) throw forbidden("only the addressee acknowledges a message");
}

/** A device acts only on requests addressed to its human; unaddressed ones are the runtime's. */
function assertRequestOwner(p: Principal, r: HumanRequestRow): void {
  if (p.kind === "device" && r.human_id !== p.humanId) throw forbidden("not your request");
}

export async function sendMessageAs(
  ctx: RouteContext,
  p: Principal,
  input: z.infer<typeof SendMessageBody>,
): Promise<MessageRow> {
  const from = await ctx.store.agent.get(input.fromAgentId);
  if (!from) throw notFound("agent", input.fromAgentId);
  if (p.kind === "device" && from.owner_human_id !== p.humanId) {
    throw forbidden("a device sends only as its human's agents", { agentId: input.fromAgentId });
  }
  if (!input.toAgentId && !input.toHumanId) {
    throw new ApiError(400, "validation", "toAgentId or toHumanId is required");
  }
  const row = await ctx.store.message.send({
    from_agent_id: input.fromAgentId,
    to_agent_id: input.toAgentId ?? null,
    to_human_id: input.toHumanId ?? null,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    type: input.type,
    body: input.body,
    requires_ack: input.requiresAck,
    reply_to: input.replyTo ?? null,
    author_agent: input.fromAgentId,
    author_human: p.humanId,
  });
  announce(ctx, "message.changed", "message", row, {
    humanId: await messageHuman(ctx, row),
    projectId: row.project_id,
    payload: { toAgentId: row.to_agent_id, toHumanId: row.to_human_id, type: row.type },
  });
  return row;
}

export async function applyReceipt(
  ctx: RouteContext,
  p: Principal,
  messageId: string,
  state: "delivered" | "read" | "acted",
): Promise<MessageRow> {
  const current = await ctx.store.message.get(messageId);
  if (!current) throw notFound("message", messageId);
  await assertAddressee(ctx, p, current);
  const row =
    state === "delivered"
      ? await ctx.store.message.markDelivered(messageId)
      : state === "read"
        ? await ctx.store.message.markRead(messageId)
        : await ctx.store.message.markActed(messageId);
  if (row.version !== current.version) {
    announce(ctx, "message.changed", "message", row, {
      humanId: await messageHuman(ctx, row),
      projectId: row.project_id,
      payload: { receipt: state, toAgentId: row.to_agent_id, toHumanId: row.to_human_id },
    });
  }
  return row;
}

/**
 * The decision row has no device column, so the rationale carries where the answer came from
 * and which request it answered; who and when are the row's `decided_by` and `created_at`.
 */
export function decisionRationale(p: Principal, request: HumanRequestRow): string {
  const from =
    p.kind === "device"
      ? `device ${p.deviceId} (${p.device.kind})`
      : `the runtime${p.installId ? ` (install ${p.installId})` : ""}`;
  return `request ${request.id} answered from ${from} through the state service`;
}

export async function answerRequestAs(
  ctx: RouteContext,
  p: Principal,
  id: string,
  version: number,
  answer: unknown,
): Promise<HumanRequestRow> {
  const current = await ctx.store.humanRequest.get(id);
  if (!current) throw notFound("request", id);
  assertRequestOwner(p, current);
  // U-034: the same check as the daemon's answer route. An answer a structured card cannot act
  // on is a 400 `validation` listing the options, and the request stays open; this covers the
  // phone's Inbox, its offline queue (`/sync/outbox`) and the approvals page.
  if (current.status === "open") assertAnswerAccepted(current, answer);
  // Spec R.7 / Q.8: high-risk confirmations need the device signature plus biometric.
  const cardRisk =
    current.change_card && typeof current.change_card.risk === "string"
      ? current.change_card.risk
      : null;
  if (current.risk === "high" || cardRisk === "high") requireScope(p, "confirm:high");
  const by = p.kind === "device" ? p.humanId : (current.human_id ?? "runtime");
  // Spec J: every human decision is logged with who, what, when and from which device. This
  // is the entry the daemon's answer route writes (`DecisionLog.recordAnswer`: a `decision`
  // row per project, superseding an older answer to the same question); only an answered
  // request of kind `decision` with a project makes one. The answer and the entry are one
  // transaction: a failed decision write leaves the request open at its version, so the
  // client's retry is not a 409 on an answered row that has no decision.
  // A shared-secret approval card (spec S.13, ADR 0065) moves its grant in the same write:
  // the last required yes activates it, a no cancels it and withdraws the other cards.
  const { row, decision, grant } = await ctx.store.transaction(async (tx) => {
    const answered = await tx.humanRequest.answer(id, version, answer as never, by);
    const entry = await new DecisionLog(tx).recordAnswer(
      answered,
      by,
      decisionRationale(p, answered),
    );
    const moved = await applySharedGrantAnswer(tx, answered, by, {
      clock: ctx.clock,
      installId: p.kind === "admin" ? p.installId : p.deviceId,
    });
    return { row: answered, decision: entry, grant: moved };
  });
  announce(ctx, "human_request.changed", "human_request", row, {
    humanId: row.human_id,
    projectId: row.project_id,
    payload: { status: row.status, blocking: row.blocking },
  });
  if (grant && grant.status === "cancelled") {
    for (const other of grant.request_ids.filter((r) => r !== row.id)) {
      const withdrawn = await ctx.store.humanRequest.get(other);
      if (!withdrawn) continue;
      announce(ctx, "human_request.changed", "human_request", withdrawn, {
        humanId: withdrawn.human_id,
        projectId: withdrawn.project_id,
        payload: { status: withdrawn.status, blocking: withdrawn.blocking, grantId: grant.id },
      });
    }
  }
  if (decision) {
    announce(ctx, "decision.changed", "decision", decision, {
      humanId: row.human_id,
      projectId: decision.project_id,
      payload: { requestId: row.id },
    });
  }
  return row;
}

/** Inbox per human (and per agent for the runtime), receipts and human requests (spec F.1, F.2, J). */
export function registerInboxRoutes(app: App, ctx: RouteContext): void {
  app.get("/inbox", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const unreadOnly = c.req.query("unreadOnly") === "1";
    const limit = intParam(c.req.query("limit"), 100);
    const agentId = c.req.query("agentId");
    let messages: MessageRow[];
    let requests: HumanRequestRow[];
    if (agentId) {
      const agent = await ctx.store.agent.get(agentId);
      if (!agent) throw notFound("agent", agentId);
      if (p.kind === "device" && agent.owner_human_id !== p.humanId)
        throw forbidden("not your agent");
      messages = await ctx.store.message.inbox({ agentId }, { unreadOnly, limit });
      requests = [];
    } else {
      const humanId = resolveHumanId(p, c.req.query("humanId"));
      if (!humanId) throw new ApiError(400, "validation", "humanId or agentId is required");
      messages = await ctx.store.message.inbox({ humanId }, { unreadOnly, limit });
      requests = await ctx.store.humanRequest.open({ humanId }, { limit });
    }
    const views = [];
    for (const m of messages)
      views.push(messageView(m, await agentName(ctx.store, m.from_agent_id)));
    const reqViews = [];
    for (const r of requests) {
      const project = r.project_id ? await ctx.store.project.get(r.project_id) : undefined;
      reqViews.push(humanRequestView(r, project?.name ?? null));
    }
    return c.json({
      messages: views,
      requests: reqViews,
      blockingCount: requests.filter((r) => r.blocking).length,
    });
  });

  app.get("/messages/:id", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const m = await ctx.store.message.get(c.req.param("id"));
    if (!m) throw notFound("message", c.req.param("id"));
    await assertCanSee(ctx, p, m);
    return c.json(messageView(m, await agentName(ctx.store, m.from_agent_id)));
  });

  app.post("/messages", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:inbox");
    const body = await parseBody(c, SendMessageBody);
    const row = await sendMessageAs(ctx, p, body);
    return c.json(messageView(row, await agentName(ctx.store, row.from_agent_id)), 201);
  });

  app.post("/messages/:id/receipt", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:inbox");
    const body = await parseBody(c, ReceiptBody);
    const row = await applyReceipt(ctx, p, c.req.param("id"), body.state);
    return c.json(messageView(row, await agentName(ctx.store, row.from_agent_id)));
  });

  app.get("/requests", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const humanId = resolveHumanId(p, c.req.query("humanId"));
    const projectId = c.req.query("projectId");
    const rows = await ctx.store.humanRequest.open(
      { ...(humanId ? { humanId } : {}), ...(projectId ? { projectId } : {}) },
      { limit: intParam(c.req.query("limit"), 100) },
    );
    const views = [];
    for (const r of rows) {
      const project = r.project_id ? await ctx.store.project.get(r.project_id) : undefined;
      views.push(humanRequestView(r, project?.name ?? null));
    }
    return c.json({ requests: views, blockingCount: rows.filter((r) => r.blocking).length });
  });

  app.get("/requests/:id", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const r = await ctx.store.humanRequest.get(c.req.param("id"));
    if (!r) throw notFound("request", c.req.param("id"));
    assertRequestOwner(p, r);
    const project = r.project_id ? await ctx.store.project.get(r.project_id) : undefined;
    return c.json(humanRequestView(r, project?.name ?? null));
  });

  app.post("/requests/:id/answer", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:approvals");
    const body = await parseBody(c, AnswerBody);
    const row = await answerRequestAs(ctx, p, c.req.param("id"), body.version, body.answer);
    const project = row.project_id ? await ctx.store.project.get(row.project_id) : undefined;
    return c.json(humanRequestView(row, project?.name ?? null));
  });
}
